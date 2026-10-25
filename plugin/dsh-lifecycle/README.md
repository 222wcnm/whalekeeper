# dsh-lifecycle

给 DeepSeek Harness（dsh）web 面提供进程内生命周期能力的可选插件：一个回环围栏保护的
**优雅停机端点**、一个 **健康端点** 与一个 **只读会话摘要端点**。它解决的是进程外组件
（浏览器扩展 + Native 宿主）做不到的事 —— 进入 dsh 自身的 dispose 生命周期，从而在
Windows 上也能优雅停止（否则只能 `taskkill` 硬杀）。

## 功能

0.4.2 面向 dsh **0.2.1-rc.2** 修复资源所有权和 SSE 一致性：所有资源显式由
Cordis effect 托管，失败回滚、卸载关闭流与计时器、可安全重挂；新连接先向已有连接
补发变化再发送快照，子会话清理先更新索引再广播。新版仍优先等待 launcher 的
`appReady.onReady()`，旧版保留 Loader 回退。版本范围不变且无需豁免。
Windows原样隔离验收已通过：插件87条单测（含真实Cordis4.0.5卸载/重挂），三轮
DSH0.2.1-rc.2固定/动态生命周期与真实浏览器恢复均通过，结论及边界见兼容台账§2.1.3。
不沿用旧版通过声明；本次未自动安装到日常profile。

0.4.0 起，Whalekeeper 启动的实例会主动报告就绪状态与实际端口。插件先等待 dsh
成功启动，再写入宿主指定的 `ready/dsh-web.json`；每 2 秒更新，正常卸载时删除。
文件仅含启动标识、PID、端口、时间和版本，不含消息或认证 token。手工启动未提供
宿主环境变量时不创建文件；旧宿主照常使用 HTTP 端点。协议见[宿主设计](../../docs/design/02-native-host.md) §6.9。

升级须复制**完整插件目录**（包括新增的 `readiness.js` 和 `package.json`），再重启
所管理的 dsh 实例；只替换 `index.js` 会缺少依赖文件。宿主无需重新注册。

| 方法 | 路径 | 响应 | 语义 |
|------|------|------|------|
| `POST` | `/_lifecycle/shutdown` | `202 {"ok":true}`（重复请求 `409`） | 先刷出响应，再 `appExit(0)`：触发 dsh 官方 fiber dispose；宿主等待端口和 PID 退出，排空超时复核 PID 后强制清理 |
| `GET`  | `/_lifecycle/health`    | `200` JSON | 健康/富状态（下见示例） |
| `GET`  | `/_manager/sessions`    | `200 {"ok":true,"items":[...]}` | **只读会话摘要**（M9）：live 会话的元数据行——`sessionId/title?/state/updatedAt/blank/cwd?`；**不读消息体/事件内容/凭据** |
| `GET`  | `/_manager/events`      | `200 text/event-stream` | **SSE 会话推送**（M12，零依赖）：连接即 `snapshot`（与 sessions 完全同构，同 `buildItems` 单一派生面）；之后仅语义变化推 `upsert`/`removed` 增量（15s 心跳 `: ping` + `retry: 3000`；重连=重拿快照，无 Last-Event-ID 回放）。驱动源 = Cordis 事件总线（`session/event`/`session/created`/`session/disposed`/`agent/status`，app 级订阅接收全部会话事件——官方 apiproxy 同款模式），**事件内容绝不进入推送面，只出摘要** |

health 响应：

```json
{
  "ok": true,
  "pid": 12345,
  "uptimeMs": 182000,
  "port": 3080,
  "nodeVersion": "v22.16.0"
}
```

sessions 响应（`items` 为 live 会话数组，排序同 `sessions.list()` 创建序）：

```json
{
  "ok": true,
  "items": [
    {
      "sessionId": "session-8c1f...",
      "title": "帮我查一下最近的提交",
      "state": "working",
      "updatedAt": 1787422800000,
      "blank": false,
      "cwd": "D:\\work\\repo"
    },
    { "sessionId": "session-9a2e...", "state": "idle", "updatedAt": 1787422801000, "blank": true }
  ]
}
```

- `state` 语义（design §8.10）：`waiting`（等待审批/问答——`approval/asked`↔`decided` 或
  `tool/call`(ask_user_question)↔`tool/result` 事件对未闭合）> `working`（agent running）>
  `completed`（存在 `turn/end`）> `idle`（其余）。
- `title` 从会话事件流中的 `session/title` 事件 fold（该事件由官方 dsh-session-title 服务
  append，内容已归一化）；无标题事件时该字段省略，由消费方降级（DSH Manager popup 显示
  `会话 #<id 前 8>`）——**不依赖 sessionTitle 服务本身**，无该服务的部署同样可用。
- 只读幂等、无副作用；live 会话之外的冷会话（历史持久化会话）不在 v1 范围内。

## 端点用法（curl 示例）

```bash
# 健康检查
curl http://127.0.0.1:3080/_lifecycle/health
# → {"ok":true,"pid":12345,"uptimeMs":182000,"port":3080,"nodeVersion":"v22.16.0"}

# 优雅停机（返回 202 后 dsh 开始 dispose；重复 POST 返回 409 Conflict）
curl -i -X POST http://127.0.0.1:3080/_lifecycle/shutdown
# → HTTP/1.1 202 Accepted
#   {"ok":true}

# 只读会话摘要（M9）
curl http://127.0.0.1:3080/_manager/sessions
# → {"ok":true,"items":[...]}

# SSE 会话推送（M12）：连接即快照，之后仅语义变化推增量
curl -N http://127.0.0.1:3080/_manager/events
# → retry: 3000
# → id: 1 / event: snapshot / data: {"ok":true,"items":[...]}
# → （15s 心跳 : ping；状态切换时 event: upsert / event: removed）
```

## 安装（实测语法，勿臆测）

本插件基于本机安装的 `@deepseek-ai/dsh@0.1.0-rc.6` 源码逐条核验（**2026-08-26 注记：本机事实基线已漂移至 `0.1.1-rc.2`，M9/M12 所用事件契约（`session/event`·`session/created`·`session/disposed`·`agent/status`）与 webServer 行为已按 0.1.1-rc.2 源码复核，未发现破坏性差异**）。核心事实：

- `dsh plugin --profile <name> <args...>` 是 **pnpm 转发器**：先初始化 profile，再在 profile
  目录里执行 `pnpm <args...>`，随后调用 `reconcilePlugins` 把装了「`dsh.bundle.patch`」声明的
  依赖加入 `dsh.profile.bundles` 层栈。
- **只有当包的 `package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`
  且随包附带该 `cordis.patch.yml`（内含 `- insert: [{id, name}]` 挂载行）时，包才会真正挂载为
  插件层。** 否则它只作为普通依赖安装，并打印
  `dsh: warning: <pkg> declares no dsh.bundle — installed as a plain dependency, not a profile layer`，
  插件不生效。本包已在 `package.json` 声明 `dsh.bundle` 并附带 `cordis.patch.yml`。
- 相对路径 spec（`./`、`../xxx`、`file:`/`link:` 形式）会以**你执行 `dsh` 的目录**为锚点解析
  （`anchorPathSpec` 用 `resolve(cwd, path)`），不会被 profile 目录吞掉。

### ⚠️ Windows 跨盘符陷阱（2026-08-14 实测）

**当插件仓库与 profile 目录不在同一盘符时（本机：仓库在 `D:\`、profile 在 `C:\`），
`dsh plugin add` 会失败**——pnpm v10 把 `D:\...` 当相对路径段处理：`link:` 装出坏 junction
（target 变成 `...\profiles\web\D:\...`，dsh 读不到 package.json，reconcile 报
`declares no dsh.bundle`），`file:` 与 `file:///` 形式直接
`ENOENT: scandir '...\web\D:\...'`。这是 pnpm 侧缺陷，与插件无关。**同盘符**（例如仓库也放
C 盘）时 `dsh plugin --profile web add ./plugin/dsh-lifecycle` 可直接用（仓库根执行）。

### 方式 A（本机验证通过）：复制到 `.dsh\plugins` + 相对路径 link

> **注意：`.dsh\plugins` 是本项目自选的本地目录，不是 dsh 官方插件目录约定。**
> dsh 官方只认 `dsh.profile.bundles` + `dsh.bundle.patch` 双锚点解析；`link:` 的落点目录可
> 任意自选（只要相对路径能指到包所在位置）。这里选 `.dsh\plugins` 仅为方便统一管理。

```powershell
# 1) 把插件复制到 profile 同级插件目录
Copy-Item -Recurse -Force <repo-root>\plugin\dsh-lifecycle `
  C:\Users\<user>\.dsh\plugins\dsh-lifecycle

# 2) 在 profile 目录内以相对路径 link 安装（cwd 必须是 profile 目录）
Set-Location C:\Users\<user>\.dsh\profiles\web
pnpm add link:..\..\plugins\dsh-lifecycle

# 3) 重新 reconcile：把已安装的 bundle 依赖刷进 dsh.profile.bundles
#    （若 pnpm add 后已自动 reconcile，此步可省略）
dsh plugin --profile web install
```

验证：profile 的 `package.json` 中 `dependencies` 含 `dsh-lifecycle`（link 形式）且
`dsh.profile.bundles` 含 `dsh-lifecycle`。重启 `dsh web` 后生效。
以后升级插件：更新 `C:\Users\<user>\.dsh\plugins\dsh-lifecycle` 文件后重启 dsh 即可（link 实时生效）。

### 方式 B：`cordis.patch.yml` 手动挂载（不装 pnpm）

在 profile 目录（`%DSH_HOME%\profiles\web\cordis.patch.yml`）里插入本插件行，并把本包
放到 Node 可解析的位置：

```yaml
# %DSH_HOME%\profiles\web\cordis.patch.yml
- insert:
    - id: dsh-lifecycle
      name: 'dsh-lifecycle'   # 或本包 checkout 的绝对路径
```

> **rc.1 loader 装配要求（2026-09-04 真实 rc.1 实测，`native-host/test/e2e-rc1-isolated.js` 实证）**：
> dsh ≥ 0.1.2（ESM loader）下，`name` 写裸路径（`D:/...`）报
> `ERR_UNSUPPORTED_ESM_URL_SCHEME`（Windows 绝对路径必须是 `file://` URL），写目录
> 报 `ERR_UNSUPPORTED_DIR_IMPORT`——**必须指向 `file://` URL 且为具体入口文件**：
>
> ```yaml
> - insert:
>     - id: dsh-lifecycle
>       name: 'file:///D:/Browser_extension/dsh-manager/plugin/dsh-lifecycle/index.js'
> ```
>
> （路径按实际 checkout 位置替换；`pathToFileURL` 可生成标准形式。）0.1.1-rc.2 及更早
> 版本无此要求（CJS 装载器接受裸路径），但按上述写法兼容两端。

## 安全围栏

插件路由**不经过** `/api` 网关的 trusted-host 围栏，由本插件自行校验（以下任一不满足即 403，
方法不符即 405）：

1. `req.socket.remoteAddress` 必须为回环：`127.0.0.1` / `::1` / `::ffff:127.0.0.1`；
2. `Host` 头必须匹配 `/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/`；
3. `sec-fetch-site` 头**存在且为 `cross-site`** 时直接拒绝（与官方 `/api` 围栏
   `isTrustedApiRequest` 对齐）；
4. `Origin` 头**存在时**，其 host 必须与 `Host` 的 host 相等（异源拒绝；无 `Origin` 放行）。

由此：浏览器扩展页面直接 `fetch`（带 `chrome-extension://` Origin）会被拒；而「扩展 → 宿主 →
HTTP」链路（宿主请求不带 Origin）天然合规。`shutdown` 仅 `POST`，`health` 与 `sessions` 仅 `GET`。

## 与浏览器扩展的关系（DSH Manager）

- **双层正交、双向可选**：装了插件 → 宿主 stop 先 `POST /_lifecycle/shutdown` 优雅停（3s 内
  端口关闭后继续等 PID 退出，10s 未排空时复核身份并 taskkill 回退）；没装插件 →
  宿主自动降级 `taskkill /T /F`，状态用端口探活，功能不受影响。
- 插件不自己 respawn：进程内拿不到启动参数，重启编排权在宿主（持有 run 记录的 `cmdline`）。

## 开发 / 测试

```powershell
node --check index.js
node --test test/
```

零运行时依赖（只依赖 dsh 注入的 `webServer` / `appExit` 服务）；`package.json` 以
`peerDependencies: { "@deepseek-ai/dsh": ">=0.1.0-rc.6 <0.3.0-0" }` 声明与 dsh 的兼容范围。
dsh 0.2.x 会使用 `includePrerelease: true` 强制校验此范围；无需设置版本豁免。
