# 背景、事实基线与架构

[返回设计规格索引](../design.md) · 原规格 §1–5

---

## 1. 背景与目标

DeepSeek Harness（以下简称 dsh，npm 包 `@deepseek-ai/dsh`）的 Web 界面通过
`dsh web` 命令启动，默认监听 `http://127.0.0.1:3080`。目前的使用路径是：

```
打开终端 → 运行 dsh web → 手工打开浏览器 → 访问 Web UI
```

本项目希望反转该流程：

```
浏览器扩展一键启动 dsh → 自动打开 Web UI → 一键停止 / 重启
```

**核心目标**

1. 在浏览器内完成 dsh web 服务的 start / stop / restart / status 全生命周期管理。
2. 无需用户打开终端；无需常驻守护进程（dsh 停止时系统不残留任何本项目的进程）。
3. 状态可视化（图标徽标 + popup 面板），启动成功后一键打开 Web UI。
4. 不修改 dsh 本体即可工作；进程内的优雅停机与健康状态通过**可选 dsh 插件**获得（M2，见 §7）。

**非目标（v1 不做）**

- 多实例并行管理（同一时间只管理一个 web 实例）。
- 通过扩展调用 dsh 的 `/api` 业务接口（受 Origin 信任围栏限制，见 §12.2）。
- 远程（非本机）管理。

---

## 2. 现状核验（事实基线）

以下结论基于本机实际安装的 `@deepseek-ai/dsh@0.1.2-rc.1` 逐条核验（F1-F14 原始核验基于 `0.1.0-rc.6`，2026-08-28 按 rc.2 复核，**2026-09-04 本机已升级 rc.1 并全量复核**；上游 `0.1.2` 系列差异见 §2.1），作为设计依据：

> **2026-08-14 在线复核（外部网络已恢复）**：npm `dist-tags.latest` = `0.1.0-rc.6`（无更高版本/正式版）；GitHub 仓库**无 releases**；GitHub 根 `LICENSE` 逐字核对为 MIT License, Copyright (c) 2026 DeepSeek（与本机 npm 包一致）。官方 `docs/` 文档体系存在且持续更新：`capability-seams.md` 将 `ctx.web` 列为官方 seam（provider 生态：`web-search-exa`、`web-search-perplexity`、`web-search-deepseek`、`web-fetch-http`），`ctx.webServer` 列为 core；`web-styling.md` 规范 `--dsw-*` 令牌；`appExit` 的书面文档仅存在于 `dsh-cmdline` 包 README（顶级 docs 未收录）——与 §7.3 的耦合风险结论一致。**本事实基线成立，无需更新。**
> ⚠️ **2026-08-23 基线漂移警示（已于 2026-08-28 处理）**：本机 dsh 已升级至 `0.1.1-rc.2`（M9 真实实例 e2e 即基于该版本，§8.10 已注明）。2026-08-28 已对本项目全部 dsh 接缝按 `0.1.1-rc.2` 复核，并前瞻核验上游未发布的 `0.1.2-alpha.1`——结论见 **§2.1 上游破坏性变更台账**。
>
> **2026-09-04 基线更新（本机已升级 `0.1.2-rc.1`）**：上游 `v0.1.2-rc.1` 已发布 npm 并成为 `latest`（`npm view dist-tags`：`{latest: 0.1.2-rc.1, next: 0.1.2-rc.1, alpha: 0.1.2-alpha.5}`）；本机全局升级 rc.1，真实 profile 插件同步更新为 M13 版（备份 `index.js.bak-pre-m13`）。全部 B/R 结论已按 rc.1 复核（§2.1.1），真机回归通过（`smoke-real.js` 全链路 + `e2e-m9-manager.js` 7/7 + 隔离 `e2e-rc1-isolated.js` 9/9，见 AGENTS.md 顶部 M13 记录）。
>
> **2026-08-26 M12 补充核验（事件契约，按本机 0.1.1-rc.2 源码）**：`session/event`（dsh-session `Session.append()` 同步发布钩子，**构造种子/回放事件不发射**）、`session/created`/`session/disposed`、`agent/status`（dsh-agent 的 `agentEvents` 融合发射 `{status, agent}`，dsh-agent-loop `setPhase` 状态转变时触发）；app 级（untagged）订阅者接收**全部**作用域会话事件（dsh-scope `scopeTarget` 向上流动语义）；`dsh-host-webserver` 支持 SSE 所需一切（`register` 精确路由 + dispose `closeAllConnections()` 强制断流）；官方 SSE 先例 `dsh-client-hmr` `GET /plugins/events`（L114-150）。**官方 `/api/events.host` 浏览器通道经实测为 WebSocket-only**（非 Upgrade GET → `426 upgrade required`，dsh-client-connection L538-544；host 帧仅 running bool，waiting 需 mux 帧=含消息内容，违反 §12.2）——M12 自建 SSE 推送端点（§8.10），不复用官方事件通道。

| # | 事实 | 核验来源 | 对设计的影响 |
|---|------|----------|--------------|
| F1 | CLI 入口为 `dsh`（npm 全局 bin，Windows 下有 `dsh` / `dsh.cmd` / `dsh.ps1` 三个 shim），位于 `%APPDATA%\npm` | `package.json` 的 `bin` 字段 | 宿主需正确解析启动命令（见 §6.4） |
| F2 | CLI 仅有 profile 引导（`dsh web` = `dsh --profile web`）、`dsh plugin`、`--dump-config` 三类调用，**没有 start/stop/status 等生命周期子命令** | `lib/bin.js` 源码 | 生命周期必须由本项目实现，产品缺口真实存在 |
| F3 | `dsh web` 支持 `--host <host>`、`--port <port>`（0 = 系统分配）、`--trusted-host <authority...>`；**拒绝 `--host 0.0.0.0`**（安全考虑） | `dsh-web-app/lib/startup.js` | v1 固定端口、固定 `127.0.0.1`，最稳 |
| F4 | 默认端口 **3080**，默认主机 `127.0.0.1`（webserver 行的 fallback：`ctx.webStartup.port ?? 3080`） | `dsh-web-app/cordis.patch.yml` | 扩展默认配置值取 3080 |
| F5 | 启动成功后打印 `dsh web: http://127.0.0.1:<port>`（dsh ≥ 0.1.2 起该行携带启动令牌 query：`.../?token=...`，见 §2.1.1 B1） | `dsh-web-app/lib/index.js` | 日志解析可拿到实际端口（为 `--port 0` 预留）；现有正则 `dsh\s*web:\s*https?:\/\/(?:127\.0\.0\.1\|localhost\|\[::1\]):(\d{1,5})` 只捕获端口、不越过 `/?token=`，**0.1.2 下仍正确**（已核对）。**M13 起**：同一轮扫描捕获完整 `dsh web: <url>` 行（含 token query）写入 run 记录 `launchUrl`——0.1.2 起裸 URL 打开会 401，扩展「打开 Web UI」须携带 token。**落地边界（M13 决策，§12.3）**：`launchUrl` 仅存本机 run 记录（与 dsh 日志同信任域——token 本就被 dsh 打印进日志文件）、仅经 native 通道返回扩展 SW 用于打开标签；**不写入 storage.local、不显示在 UI 文本、不外传**（扩展侧行为约束见 §8.2）。 |
| F6 | profile 目录：`$DSH_HOME/profiles/<name>/cordis.yml`（本机 `DSH_HOME=C:\Users\<user>\.dsh`）；用户覆盖层是 `cordis.patch.yml` | 本机文件系统 | 宿主必须透传 `DSH_HOME` 环境变量 |
| F7 | 进程退出：`profile-boot` 注册了 SIGINT（exit 130）/ SIGTERM（exit 0）→ 先 dispose 整棵 fiber 树再退出 | `lib/profile-boot-*.js` | POSIX 可优雅停；**Windows 无法从外部触发这两个处理器**（Node 的 `process.kill(pid,'SIGTERM')` 在 Windows 上是 TerminateProcess 硬杀） |
| F8 | 会话持久化：session checkpoint 策略在「模型请求前、工具副作用前」落盘（JSONL 增量写） | `dsh-session-checkpoint-policy` | 硬杀进程最多丢失最后几秒状态，可接受 |
| F9 | `/api/*` 走 RPC 网关，受 trusted-host 围栏保护：Host 头必须为回环/信任域名，且**存在 Origin 头时其 host 必须等于 Host 的 host** | `dsh-client-connection/lib/index.js` | 扩展页面 fetch 会带 `Origin: chrome-extension://<id>`，**必然被围栏拒绝**；健康探测改用 `GET /`（静态 fallback，无围栏） |
| F10 | 设置/凭据类 RPC 额外限定回环同源 | 同上（loopback-gated 列表） | 本项目不应尝试绕过；遵守 dsh 的安全模型 |
| F11 | `dsh --version` 输出包版本（commander `-V`） | `lib/bin.js` | 宿主可做最低版本检查 |
| F12 | 优雅退出出口：`dsh-cmdline` 的 `provideCmdline` 提供 **`appExit` 服务**（= launcher 的 `shutdown` → `fiber.dispose()` → exit）；`webServer` 服务提供 `register({kind:'exact', path, handler})` 路由注册契约 | `dsh-cmdline/lib/index.js`、`dsh-host-webserver/lib/index.js` | 生命周期插件可走官方 dispose 路径（§7）；插件路由不经过 `/api` 围栏，需自管安全 |
| F13 | dsh 是 MIT 协议开源项目（github.com/deepseek-ai/deepseek-harness，根 LICENSE 已逐字核对），插件体系为 Cordis；官方 `docs/` 有 architecture/capability-seams/api-gateway 等文档 | 官方 README / npm / GitHub | 生命周期插件可行（M2）；上游反馈走 GitHub Discussions 与插件生态（**官方暂不接受外部 PR**，2026-08-13 公告） |
| F14 | Web 客户端主题：内置 `light`/`dark` 两主题 + `system` 偏好（默认 system）；偏好持久化于 settings namespace `ui-theme.preference`（**host 用户设置文档，非浏览器 localStorage**）；实际渲染以 `body[data-ds-dark-theme]` 属性标记（浅色无属性）；全部 `--dsw-*` 令牌（static/alias/specific）**浅/深两套**由主题插件经内联 CSS 注入 | `dsh-client-ui-theme/lib/client.js`（打包源码，2026-08 核验） | 扩展深色模式可复刻同一令牌体系与渲染标记（§8.7）；主题偏好不能从浏览器侧直接读取（F9/F10 围栏），扩展走 DOM 镜像 |

---

## 2.1 上游破坏性变更台账（dsh 版本跟踪）

**用途**：dsh 是预发布期项目，官方明示**重命名不留兼容别名**（旧名直接失效）。本节是本项目对上游变更的**单一跟踪点**：每次上游版本跳变，按本表逐行复核，受影响项进入路线图；无影响项亦如实登记，避免下次重复调查。

**核验方法**：`git diff <旧 tag>..<新 tag>` 逐一比对本项目实际用到的接缝（不做全仓审计）。本项目对 dsh 的耦合面很窄，只有两处：

| 耦合面 | 位置 | 依赖内容 |
|---|---|---|
| **插件侧（host 内）** | `plugin/dsh-lifecycle/index.js` | Cordis 服务与事件：`webServer`（`register`/`registerFallback`/`port`）、`appExit`、`ctx.sessions`、`ctx.agents`、`workspaceRegistry.archivedSessionIds`、会话事件类型契约 |
| **宿主侧（进程外）** | `native-host/host.js` | CLI argv 形态（`dsh web` / `--profile` / `--host` / `--port`）、启动日志 URL 行（F5）、回环 HTTP 探测语义 |

扩展侧（`extension/`）对 dsh 的唯一耦合是 webui 的 `data-state` DOM 属性（§8.9 事实基线），不走 dsh 的任何 API。

---

### 2.1.1 `0.1.1-rc.2` → `0.1.2-rc.1`（2026-09-03 GitHub release；**2026-09-04 晚 npm 已发 `latest`/`next` = rc.1**）

**发布状态（2026-09-04 两次复核）**：npm `dist-tags` 初查 = `{latest: 0.1.1-rc.2, next: 0.1.1-rc.2, alpha: 0.1.2-alpha.5}`；**当晚复查（`npm view dist-tags`）→ `{latest: 0.1.2-rc.1, next: 0.1.2-rc.1, alpha: 0.1.2-alpha.5}`**——`v0.1.2-rc.1` 已正式发布到 npm 并成为 `latest`。alpha.1 核验（2026-08-28）→ **rc.1 源码复核（2026-09-04，本地 `D:\deepseek-harness` checkout `dsh-v0.1.2-rc.1`）**：本节全部 B/R 结论已按 rc.1 复验，**新增 B5（`Session.events` 移除，插件硬破坏）**。**本机已升级 `0.1.2-rc.1`（2026-09-04）**，真机回归已跑通（smoke-real 全链路 + e2e-m9-manager 7/7 + 隔离 e2e-rc1-isolated 9/9，见 AGENTS.md 顶部 M13 记录）；本节台账已按 rc.1 全量验证。

#### 🔴 B1 — `dsh web` 引入浏览器启动令牌认证（**唯一硬破坏**）

- **上游依据**：新增 `packages/client/connection/src/browser-auth.ts`（rc.2 无此文件）；Agent Note `2026-08-24-browser-token-authentication`；新增真实 CLI 测试 `apps/cli/tests/web-auth.e2e.ts`。
- **变更语义**：`frontend-static` 的 fallback 由无条件 `serveStatic(...)` 改为先过 `() => ctx.connection.authorizeIndex(req, res)` 闸门。`GET /` 无有效凭据 → **401**，body 为 `dsh web authentication required; reopen the URL printed by dsh web.`。每进程生成一次性启动令牌，只经 `GET /?token=<token>` 兑换为签名 cookie（authority 绑定、`HttpOnly`、`SameSite=Strict`，默认 30 天）后重定向到干净的 `/`。启动 URL 行因此变为 `dsh web: http://127.0.0.1:<port>/?token=...`。
- **rc.1 复核（2026-09-04）**：`browser-auth.ts` `authorizeIndex` 对**所有 index 请求生效、无回环豁免**（不检查 `remoteAddress`，回环 127.0.0.1 同样 401）；`frontend-static` 的 `serveStatic` 仅对 index（`/` 与 `distIndex`）调用 `authorizeIndex`，其余静态资产（含 `/manifest.webmanifest`）**保持公开**——修复方案在 rc.1 下依然成立。
- **本项目受损点**：

  | 函数 | 现判定条件 | 0.1.2 下结果 |
  |---|---|---|
  | `httpProbe`（host.js:340） | `code >= 200 && code < 400` | 401 落在范围外 → **恒 false** |
  | `httpDshProbe`（host.js:827） | 响应体前 8KB 含 `DeepSeek Harness` | 401 body 无指纹 → **恒 false** |

- **故障表现**：`start` 实际成功但轮询 30s 后误报 `START_TIMEOUT`（§6.3 start 第 7 步）；`status` 存活判定恒失败，状态永久停在 `starting`（§6.3 status 第 4 步）；`discoverExternalDsh` 指纹闸门恒不通过 → 外部实例发现与 `adopt` 全部失效（§6.6 第 5 步）。**`stop` 不受影响**——`waitStopped`/`portConnectable` 走 TCP 层，不看 HTTP 状态码。
- **修复方案（已实测验证，向后兼容 rc.2）**：Agent Note 明确「非 index 静态资产保持公开」。`apps/web/public/manifest.webmanifest` 在 rc.2 与 alpha.1 中**内容一致**且含 `"name": "DeepSeek Harness"`。本机 3080（rc.2）实测：`GET /manifest.webmanifest` → `200 application/manifest+json`，267 字节，含指纹。故：
  1. `httpDshProbe` 指纹端点 `/` → `/manifest.webmanifest`（判定逻辑不变；body 仅 267 字节，8KB 早退分支天然不触发）；
  2. `httpProbe` 将 **401 亦视为就绪**（401 证明 dsh 认证中间件已挂载，是比 200 更强的「这是 dsh 且已起来」信号），或同样改探 `/manifest.webmanifest`。
  **rc.1 复核（2026-09-04）**：`apps/web/public/manifest.webmanifest` 内容不变（仍含 `"name": "DeepSeek Harness"`）；启动 URL 行 `dsh web: http://127.0.0.1:<port>/?token=...` 不变（`packages/bundle/web-app/src/index.ts` L280 实证）。
- **禁忌**：探测请求**不得**添加 `Accept-Encoding` 头（原因见 B2）。
- **状态**：M13 一期已完成认证兼容；M13 二期已完成就绪文件协议（§6.9）。

#### 🟡 B2 — webserver 默认启用 gzip 压缩

- **上游依据**：`packages/host/webserver` 新增可选 config `compression: 'none'|'gzip'`（默认 `'none'`）、`compressionLevel`、`compressionThresholdBytes`，新增依赖 `compression@^1.8.1` + `negotiator@^1.0.0`；`packages/bundle/web-app/cordis.patch.yml` 的 webserver 行**显式设为 `compression: gzip, compressionLevel: 1, compressionThresholdBytes: 1024`**——即 `dsh web` 默认开启。
- **本项目影响：无（有条件）**。Node `http.get` 默认不发 `Accept-Encoding`，`negotiator` 在该头缺失时选 `identity` → 响应不压缩，宿主全部探测函数的 body 解析路径不变。SSE 侧 compression 中间件跳过 `text/event-stream`，且上游中间件另跳过无 `res.socket` 的响应，`/_manager/events`（§8.10.1）保持不缓冲。
- **约束（写入本节以防未来回归）**：宿主与面板的任何 dsh HTTP 探测**一律不显式发送 `Accept-Encoding`**；确有需要时必须同步实现 gzip 解码，否则 `getHealth`/`getManagerSessions` 的 `JSON.parse` 会拿到二进制。

#### 🟢 B3 — 插件侧接缝全部存活（逐项核验通过）

对 `plugin/dsh-lifecycle/index.js` 用到的每个 seam 比对 alpha.1 源码，**全部存在且形状兼容，插件零改动**：

| 接缝 | alpha.1 状态 |
|---|---|
| `webServer.register({kind:'exact'\|'prefix'})` / `registerFallback` / `port` | 不变（仅新增可选 compression config，见 B2） |
| `appExit`（`ctx.provide('appExit', host.exit)`，`packages/boot/cmdline`） | 不变 |
| `ctx.sessions`：`get(id)` / `list()` / `session.header.{cwd,origin,createdAt}` | 不变（**`session.events` 数组属性 rc.1 已移除，改 `snapshotEvents()`，见 B5**） |
| 事件 `session/created` / `session/disposed` / `session/event` | 不变 |
| `ctx.agents`：`get(id).status`（`'idle'\|'running'`）/ `list()`、事件 `agent/status` | 不变（`Agent.status` 移入 `declare module` 合并，运行时同形） |
| `workspaceRegistry.archivedSessionIds` | 不变（host 侧保留，另供新 `workspace-controller` 消费） |
| `approval/asked` = `{id,toolName,callId?,reason?}` / `approval/decided` = `{id,outcome}` | 不变（声明位置从被删的 apiproxy 类型链移到 `packages/interaction/user-approval`） |
| `tool/call.data.callId` ↔ `tool/result.data.message.source.callId`（`ToolMessageSource`） | 不变 |
| `subagent/start` / `subagent/end`（runId 配对）/ `subagent/descriptor` | 不变 |
| `session/title` / `turn/start` / `turn/end` | 不变 |

#### 🟢 B4 — 上游大改但与本项目无关（登记备查，避免重复调查）

| 上游变更 | 为何不影响本项目 |
|---|---|
| **PTC 重命名**（`tools.mode: 'code'`→`'ptc'`、preset 目录 `presets/code`→`presets/ptc`、`CodeDispatch*`→`PtcDispatch*`、prompt 规则 `tools:code-only`→`tools:ptc-only`） | 属 agent preset / 工具呈现层；本项目不编排 preset、不读 dispatch 日志。注：`run_code`、`dsh-code-runtime*` 及**持久日志词汇** `tool/code-dispatch*` 刻意未改名（推迟至 v0→v1） |
| **删除 `packages/client/runtime` 聚合包**（hook 拆分为 `ui-session`/`ui-conversation`/`ui-chat`/`ui-trajectory`） | 本项目无 React、无 `dsh.client.*` 声明、不 import 任何 client 包（面板是 content script + Shadow DOM，§8.6 决策） |
| **删除 `packages/host/apiproxy`**（含 settings/credentials/directory-picker RPC 移除） | 本项目从不调用 `/api`（F9/F10：扩展 Origin 必被围栏拒绝，早已设计为不依赖） |
| **SQLite 持久化 schema 18**（无 17→18 迁移） | JSONL 仍是发行默认；本项目不读会话存储，只读 host 内存态 |
| **`SessionEvent.ignorable` 字段删除**、`CallId`→`ToolCallId` 类型重命名 | 插件不读 `ignorable`；`ToolCallId` 是 TS 类型别名，JS 插件无感 |
| **`todo/write` 从 `SessionEventMap` 移除**（`TodoItem` 类型删除） | 插件的 `RELEVANT_EVENT_TYPES` 不含该类型（M8 徽标的"完成待办"语义来自 webui DOM 扫描，非该事件） |
| **`known-event-types.ts` 新增 3 项**（`model/selection`、`subagent/model-selection-policy`、`session-log-deepseek/delivery-accepted`） | 插件按 type 白名单取用、未知类型忽略，新增项不触发任何分支。**但见 R1 降级警示** |
| **`dsh` 单一启动器**（所有 app 经 `dsh` + named profile，无转发兼容 bin） | `dsh web` 别名保留，且宿主本就以 `--profile web` 显式形式 spawn（§6.3 start 第 5 步），argv 契约不变 |
| **webui `StateDot` 组件** | `data-state` = `'done'\|'warning'\|'ongoing'\|'error'` 契约完全不变（alpha.1 仅删了一段注释）；`ongoing` 仍渲染 `<svg data-state="ongoing">` 8 格点阵 → §8.9 检测层零改动 |

#### 🔴 B5 — `Session.events` 数组属性移除，改为按需读取 API（**插件硬破坏**）

- **上游依据**：`packages/core/session/src/index.ts` 的 `Session` 类（rc.1）只暴露 `eventAt(seq)` / `snapshotEvents(fromSeq, toSeqExclusive)` / `ownEvents()` 方法，**无 `.events` 数组属性**（tool-cordis api-catalog 类型声明同步确认）；官方 release notes：「Replace `Session.events` with on-demand read APIs: `seq`, `eventAt()`, and `snapshotEvents()`」（alpha.4 起，rc.1 确认）。
- **本项目受损点**：`plugin/dsh-lifecycle/index.js` 两处读 `session.events` / `child.events` —— `summarizeSession()`（L154 `const events = session.events ?? []`）与 `buildChildLabelMap()`（L195 `child.events`）。rc.1 下取到 `undefined` → 事件扫描恒空 → 会话状态恒 `idle`、无 title、子代理不可见（静默降级，不抛错但功能失效）。
- **修复方案**：两处改调 `session.snapshotEvents()`（返回只读数组，元素形状与旧 `.events` 同构：`{type,data,seq,time}`，`foldTitle` / `hasPendingInteraction` / `activeChildIds` 逻辑不变）；测试桩 `makeSession` 同步改为提供 `snapshotEvents()` 方法。
- **状态**：随 M13 一期修复（2026-09-04 实施；**真实 rc.1 真机验证同日：`native-host/test/e2e-rc1-isolated.js` 9/9 PASS**——插件在真实 rc.1 上 `/_manager/sessions` 200，B5 适配生效）。

#### ⚠️ R1 — 会话日志读取 fail-closed（**单向升级警示，非本项目缺陷**）

上游 `2026-08-25-fail-closed-session-event-vocabulary`：未知事件类型不再被忽略，而是**拒绝读取整个日志**。因 0.1.2 会写入 B4 表中的 3 个新事件类型，**一旦用 0.1.2 跑过会话，再降级回 0.1.1-rc.2 将无法读取这些日志**。这与本项目无关，但影响用户的升级决策——`restart` 不会重装 dsh，故本项目不会自动触发；写在此处供发布说明引用。

#### ⚠️ R2 — 插件 peerDependencies 范围语义已不精确

`plugin/dsh-lifecycle/package.json` 声明 `">=0.1.0-rc.6 <0.2.0"`。标准 semver 下预发布版不落入普通范围，实测：

| 版本 | `satisfies` | `satisfies` + `includePrerelease` |
|---|---|---|
| `0.1.0-rc.6` | ✅ | ✅ |
| `0.1.1-rc.2` | ❌ | ✅ |
| `0.1.2-alpha.1` | ❌ | ✅ |
| `0.1.2` | ✅ | ✅ |

即该范围对**当前正在运行的 rc.2 就已「不满足」**，只因 dsh 未强制校验 peerDeps 而无实际后果。欲真正涵盖预发布版应写 `">=0.1.0-rc.6 <0.2.0-0"`。低优先级，**随 M13 一并修正（2026-09-04 已改）**。

---

### 2.1.2 `0.1.x` → `0.2.0-rc.2` / `0.2.1-alpha.1`（2026-10-04）

npm 实测 `latest` / `next` = `0.2.0-rc.2`，`alpha` = `0.2.1-alpha.1`；本机全局与
源码 checkout 均为 `0.2.0-rc.2`。默认最新版作为真实隔离验收基线，alpha 按官方
`dsh-v0.2.1-alpha.1` tag 对照相关接缝，不把源码核对当成运行验收。

| 接缝 | 变化与兼容措施 |
|---|---|
| 插件版本检查 | 新版 app-boot 会强制校验 dsh peerDependencies（`includePrerelease: true`）；旧 `<0.2.0-0` 会拒绝加载。插件范围改为 `>=0.1.0-rc.6 <0.3.0-0`，保留 0.1.x 并覆盖已核对的 0.2.x；不使用版本豁免。历史 R2 中预发布版的标准 semver 结论不代表新版 dsh 的校验行为。 |
| CLI profile | 新版只允许选择一次 profile；NPX 原来的 `web --profile web` 已真实复现参数错误。统一使用 `--profile <profile>`。 |
| CLI patch | launcher 在第一个 app 参数处停止解析；`--patch` 必须位于 `--host` / `--port` 之前。global / NPX / source 同步调整，接管的原始 argv 重放不变。 |
| 正式启动就绪 | 新版 cmdline 提供 `appReady.onReady()`，仅在启动成功后调用。就绪文件优先订阅该信号；旧版缺少服务时继续异步等待 Loader，dispose 取消订阅。 |
| 退出与重启 | 新版 launcher 的 dispose 最长有 5 秒退出宽限；端口可能先关闭。Windows 真实 restart 已出现启动超时，延迟退出测试确认旧宿主会在 PID 仍存活时返回 stopped。停止须等 PID 与端口都退出，10 秒未排空则复核 PID 后强制终止，避免旧日志句柄阻止下一次启动。 |
| 会话与事件 | `snapshotEvents()`、`sessions.get/list`、`agents.get(id).status`、`workspaceRegistry.archivedSessionIds`、session / agent / subagent 事件形状保留；app 层未标记作用域的监听者仍接收全部会话事件。 |
| HTTP 与界面 | `webServer.register/port`、`appExit`、启动令牌 URL、公开 manifest、`data-state` 与深色主题属性保留。alpha 移除 invariant 导出，本插件没有此依赖；新增 `publicUrl` 不改变默认回环入口，远程代理入口不在 Whalekeeper 当前范围。 |

验收覆盖：新版真实 CLI 解析与版本检查、隔离 profile 的固定/动态端口、启动令牌认证、
就绪文件、健康与会话摘要、真实 SSE 状态推送、重启与优雅退出；宿主冒烟回归旧版行为。

---

### 2.1.3 `0.2.1-rc.2` 兼容性修复（2026-10-19 验收通过）

本机全局 CLI 与 Desktop 运行时均已核验为 `0.2.1-rc.2`。默认 HTTP 回环入口的
Service/Event、认证、公开 manifest 和主题属性仍兼容；旧 `0.2.0-rc.2` 验收不能
直接作为新版本运行结论。此次修复包含既有缺陷，不把它们全部归因于 rc.2。

- 启动：global / NPX / source 从 spawn 起共享 150 秒预算（动态端口发现不另起计时），
  URL 捕获最多额外 5 秒；SW start/restart/stop 上限分别 210/240/60 秒。
- 停止：有效、身份匹配的 readiness 可确认插件；否则健康探测有界重试一次。
  shutdown 后统一等 PID 和端口退出 10 秒，超时复核 PID 再强制；退出后仅清理本次租约。
- 插件：全部资源用 `ctx.effect` 显式托管、幂等逆序清理及失败回滚；修复多客户端
  snapshot 覆盖广播基线、子会话 dispose 顺序造成的 SSE 陈旧摘要。
- 扩展：会话行恢复只读；URL 精确比较有效端口；已有未认证页用经过校验的启动
  URL 另开认证页，不覆盖原标签或草稿。认证查询只返回状态和端口，不传 token。
- SSE：收到有效 snapshot 才进入 live，error 立即回退，5 秒无 snapshot 则重建，
  15 秒退避且后台可重试；旧代回调无效。无可靠摘要时不从全页 StateDot 猜测计数，
  失联不生成完成提醒。

正式通过标准：生产源码单测/冒烟/浏览器基线零回归，真实 rc.2 连续三轮固定/动态
端口启动、重启、优雅停止，至少一轮完整浏览器与真实 SSE 恢复；停止后 PID/监听/
run/ready 全清。此前放宽等待、改 HTTP 的诊断副本不算正式通过。

**验收通过（Windows / Node v24.19.0 / Chrome 155.0.8059.80）**：工作区扩展 0.3.2、
配套插件 0.4.2。正式单测 **178/178，0 SKIP**（插件87/宿主29/扩展62，含真实
Cordis 4.0.5），33 场景 smoke **428 PASS / 0 FAIL / 1 POSIX SKIP**；精确 npm
CLI 0.2.1-rc.2 三轮原样隔离 E2E **196/196**，其中一轮完整浏览器 **121/121**。
三轮共12个独立launch：固定/动态各 start→restart→stop，全部严格 graceful，
无紧急force、无 PID/端口/run/ready/lock 残留。动作实测 start 4.99–8.00s、restart
6.78–10.04s、stop 1.68–2.06s；共享150s边界另由 fake clock/stdio正式回归覆盖。
真实浏览器撤销 live 122ms、hidden重连13.74s，waiting回退与completed恢复的
HTTP/SSE/storage一致、无假完成。测试不调用模型，不修改日常profile/注册/当前实例。

证据：`.e2e-current/run-mvec4ykk-17c724ee/report.json`、各轮 `report.json`、首轮
`ui.log` 与 `ui/real-sse-recovery.json`；`verified-summary.json` 校验生产 host SHA-256
与三轮相同（产物gitignored）。macOS/Firefox、TLS/IPv6/远程入口未新增运行覆盖。

**2026-10-26 发布复审**：178 项单测、开发目录 smoke428、发布副本 smoke422
（4 项预期跳过）、重新执行的三轮 E2E196 与 Chrome156 浏览器121全部通过。
工具进程访问 AppData 的额外耗时经独立终端与同字节 D 盘副本对照定位，正式验收选用
该隔离副本而未改生产源码或150s预算。证据根 `.e2e-current/run-mvo3y5wp-91931053/`，
过程与适用边界见 `native-host/test/VERIFICATION.md`。

---

## 3. 方案选型

### 3.1 为什么必须用 Native Messaging

浏览器扩展运行在受限沙箱中，**没有任何 API 可以启动本地进程**。要执行
`dsh web` 这条命令，只有三种合法途径：

| 方案 | 原理 | 优点 | 缺点 | 结论 |
|------|------|------|------|------|
| **A. Native Messaging 宿主** | 扩展通过 `chrome.runtime.connectNative()` 与注册在本机的宿主进程通信，宿主代为执行命令 | 无常驻进程；dsh 停止时系统零残留；安装即用；跨浏览器标准 | 需要安装器写注册表；宿主开发量略大 | ✅ **采用** |
| B. 常驻本地 supervisor 守护进程 + HTTP | 扩展 fetch 本地 HTTP 服务，由守护进程管理 dsh | 扩展侧代码最简单 | 必须常驻一个进程（自启动/计划任务），恰好违背「不运行命令」的初衷；扩展与守护进程是两个要维护的组件 | 否决 |
| C. 修改 dsh 上游，内置 lifecycle 子命令 | 给 dsh 提 `dsh server start/stop` PR | 最正统 | 依赖上游节奏；且「start」仍需一个前台终端或后台驻留，不能单独解决浏览器一键启动 | 作为长期贡献项，不作为本项目依赖 |

### 3.2 关键技术选型

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 扩展构建方式 | 纯手写 JS（无打包器） | MVP 仅 3 个文件，免构建链；后续若复杂化可迁 WXT（工作目录 `chrome-mcp-server-0.0.6` 即为 WXT 产物参考） |
| 宿主语言 | Node.js（与 dsh 同生态） | 复用本机已装的 Node；无需额外运行时 |
| 宿主生命周期 | **无状态短命进程**（一次连接一个请求/响应） | MV3 service worker 会被回收，长连接必然断；无状态 + pidfile 才是可靠状态源（见 §4.2） |
| 状态存储 | 本机文件（`%LOCALAPPDATA%\dsh-manager\run\`）+ 端口探测 | 不依赖任何驻留进程 |
| dsh 启动方式 | `node.exe + <npm-global>/node_modules/@deepseek-ai/dsh/lib/bin.js`；**Windows 经隐藏控制台载体**（wscript + `Run(cmd,0,False)`，§6.3 第 5 步），POSIX 直接 spawn + 日志文件重定向 | 避免 `.cmd` shim 的 shell 包装与转义问题；stdout/stderr 写入日志文件；隐藏控制台让 dsh 的子进程继承（命令执行不再闪窗）且桌面无常驻窗口（§6.3 第 5 步） |
| 停止方式（v1） | `taskkill /PID <pid> /T /F` | Windows 无法从外部触发 SIGINT 处理器（F7）；数据安全由 F8 兜底 |
| 停止方式（M2，插件存在时） | `dsh-lifecycle` 插件：`POST /_lifecycle/shutdown` → 官方 dispose（F12），失败回退 taskkill | 优雅停机唯一可行路径（§7） |

### 3.3 为什么还要 dsh 插件：双层架构（评审新增）

评审问题：「这个能做成 dsh 插件吗？」答案是**部分能、而且应该**——但要先看清两种运行时各自的能力边界：

| 能力 | dsh 插件（进程内） | 浏览器扩展 + 宿主（进程外） |
|------|--------------------|------------------------------|
| **冷启动**（dsh 未运行时启动它） | ❌ 进程不存在，插件无从运行 | ✅ **唯一可行方案** |
| 优雅停止（官方 dispose 后退出） | ✅ 注入 `appExit`（F12 已核验） | ⚠️ Windows 只能 taskkill 硬杀 |
| 健康/富状态（会话数、作业、token 等） | ✅ 直接读宿主 Cordis 服务 | ⚠️ 仅端口探活 + 读状态文件 |
| 停止后的状态可见性 | ❌ 进程已死 | ✅ 文件 + 端口探测 |
| 浏览器入口 UI（popup、图标徽标） | ❌ | ✅ |
| 重启编排 | ⚠️ 能做但不该做（插件不知道自己的 profile/启动参数，见 §7.5） | ✅ 宿主持有 run 记录 cmdline，天然可重放 |

结论：

1. **「启动」在物理上不可能做成插件**——插件运行在 dsh 进程内部，dsh 没启动时插件不存在。同理，Web UI 的 client 插件（页面内 UI）也救不了：页面 JS 同样无法起本机进程，而且页面本身随进程一起消失。
2. **「优雅停止、健康状态、进程内管理面」非常适合做成插件**——这正是扩展在进程外做不到的部分（F7/F12）。
3. 因此本项目定为**双层正交架构**：浏览器扩展 + 宿主负责「进程不存在时的启动与入口 UI」，`dsh-lifecycle` 插件负责「进程活着时的优雅与状态」，两者相互独立、各自可用（没装插件扩展照常工作，没装扩展插件可被 curl 使用）。
4. 未来增强（v3+）：dsh Web UI 的 client 插件可在页面内加「停止/重启」管理面板，与浏览器扩展互补（页面内操作走 `/_lifecycle/*`）。

---

## 4. 总体架构

```
┌─────────────────────────── 浏览器 (Chrome/Edge) ───────────────────────────┐
│                                                                            │
│  Popup UI (popup.html/js/css)                                              │
│    ├─ 状态徽标/按钮 → chrome.runtime.sendMessage({type:"native", ...})     │
│    ├─ 健康探测 → fetch("http://127.0.0.1:3080/", {timeout})  ← 仅探活      │
│    └─ 打开 Web UI → chrome.tabs.create({url})                              │
│                                                                            │
│  Background Service Worker (background.js)                                 │
│    ├─ 接收 popup 消息，串行化（避免并发 native 连接）                       │
│    ├─ chrome.runtime.connectNative("com.dsh.manager")                      │
│    └─ chrome.alarms 周期刷新图标徽标                                       │
│                                                                            │
└──────────────┬─────────────────────────────────────────────────────────────┘
               │ stdio（4 字节长度前缀 + JSON，小端序）
               ▼
┌─────────────────────────── 本机 (Windows) ────────────────────────────────┐
│                                                                            │
│  Native Messaging Host (native-host/host.js, Node, 短命)                   │
│    ├─ 校验 action 白名单 → 执行一个操作 → 应答 → 随 stdin 关闭退出          │
│    ├─ start:  spawn detached dsh web（日志重定向）→ 写 run 记录 → 轮询端口 │
│    ├─ stop:   (M2 先 POST /_lifecycle/shutdown) → taskkill /T /F → 清理    │
│    └─ status: 读 run 记录 + PID 存活 + HTTP 200 探活；无记录时外部实例发现  │
│                                                                            │
│  状态文件 %LOCALAPPDATA%\dsh-manager\                                       │
│    ├─ run\dsh-web.json        # {pid, port, profile, startedAt, cmdline}   │
│    └─ logs\dsh-web.log        # dsh stdout+stderr（日志查看 + 端口解析）    │
│                                                                            │
│  dsh web 进程（detached，独立于宿主存活）                                    │
│    ├─ 监听 http://127.0.0.1:3080                                           │
│    └─ [可选] dsh-lifecycle 插件：/_lifecycle/shutdown · /_lifecycle/health │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 组件清单

| 组件 | 位置 | 责任 |
|------|------|------|
| 浏览器扩展 | `extension/` | UI、状态展示、发起 native 请求、探活、打开 UI |
| Native 宿主 | `native-host/host.js` | 命令执行、进程管理、状态判定 |
| 安装器 | `native-host/install.ps1`（Windows）/ `install.sh`（Linux/macOS，M4） | 生成宿主 manifest（自动计算扩展 ID）、注册 Native Messaging 宿主（注册表 / 用户级清单文件）、生成宿主配置 |
| 卸载器 | `native-host/uninstall.ps1` / `uninstall.sh` | 停掉 dsh、清理注册表（或浏览器清单）与状态文件 |
| **dsh 生命周期插件** | `plugin/dsh-lifecycle/` | 进程内优雅停机端点 `POST /_lifecycle/shutdown` + 健康端点 `GET /_lifecycle/health`（M2；可选安装，宿主自动降级，§7） |

### 4.2 关键设计原则

1. **宿主不驻留**：Chrome 每次 `connectNative` 拉起一个新宿主进程，处理完一个请求立即应答；stdin EOF（service worker 回收或主动断开）即退出。
2. **dsh 进程必须独立存活**：spawn 时 `detached: true`，宿主退出不影响 dsh。
3. **状态判定每次重新推导**：不信任任何内存缓存，依据 = `run\dsh-web.json`（pidfile 记录）→ PID 存活 → `GET /` 返回 200，三者综合；无有效 run 记录时额外执行外部实例发现（§6.6），检测非本扩展启动的 dsh web 及其端口。
4. **所有变更操作幂等**：start 时已 running 则返回 `ALREADY_RUNNING`；stop 时已 stopped 则返回 `ALREADY_STOPPED`；支持安全重试。
5. **并发防护**：宿主启动时以 `fs.open(lock, 'wx')` 原子抢锁，抢不到重试 3 次（间隔 300ms），再失败返回 `BUSY`。
6. **插件可选、宿主自足**：宿主全部功能不依赖 dsh-lifecycle；插件缺失时 stop 自动降级 taskkill、status 以端口探活为准（health 只作富状态补充，不作存活判定的唯一依据）。

---

## 5. 状态模型

```
                    start ack                端口 200 + PID 存活
   ┌──────────┐ ────────────────▶ ┌────────┐ ─────────────────▶ ┌─────────┐
   │ stopped  │                   │starting│                     │ running │
   └──────────┘ ◀──────────────── └────────┘                     └─────────┘
        ▲          stop ack/timeout           端口关闭             │
        │   ┌────────┐ ◀──────────────────────────────────────────┘
        └───│stopping│                    stop ack / taskkill
            └────────┘

    无 run 记录 + 发现外部 dsh（§6.6）
   ┌──────────┐ ─────────────────▶ ┌──────────┐
   │ stopped  │                    │ external │（展示 + 打开 UI + 接管 §6.7）
   └──────────┘                    └────┬─────┘
                                        │ adopt（§6.7）
                                        ▼
                                   ┌─────────┐
                                   │ running │（source=managed）
                                   └─────────┘
```

| 状态 | 判定条件（宿主 status 动作） | 典型去向 |
|------|------------------------------|----------|
| `stopped` | 无 run 记录且未发现外部实例；或 PID 不存在/已死，端口无应答（清残留） | start |
| `starting` | run 记录存在、PID 存活，但尚未就绪 | 轮询至 `running`（本轮共享 150s 截止，超时保留已核验进程） |
| `running` | run 记录存在、PID 存活、`GET /` 200 | stop / restart |
| `stopping` | stop 已发出、端口尚未关闭 | 轮询至 `stopped`（10s 超时→强制 taskkill） |
| `external` | 无 run 记录，但发现外部启动的 dsh web 进程（命令行含 dsh bin.js）且端口指纹探测通过（§6.6） | 展示 + 打开 UI + **接管**（adopt → running/managed，§6.7）；直接 stop/restart 返回 `EXTERNAL_UNMANAGED` |
| `error` | 启动超时 / 端口被占 / dsh 未安装 / 宿主执行异常 | 展示原因与日志尾部 |

Popup 对 `starting` / `stopping` 的处理：收到 ack 后进入轮询（每 1s 调 status），直到终态或超时；popup 关闭时轮询自然停止，下次打开重新 status 即可（无状态设计使这一点免费获得）。

---
