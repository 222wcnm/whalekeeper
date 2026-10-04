# 原生宿主与就绪协议

[返回设计规格索引](../design.md) · 原规格 §6

---

## 6. 原生宿主设计（native-host/host.js）

### 6.1 运行形态

- 纯 Node 脚本，零第三方依赖，Node ≥ 18（复用本机 Node，即 `process.execPath`）。
- 由 Chrome 按注册表注册的宿主 manifest 拉起，与浏览器通过 stdio 通信。
- 消息帧：**4 字节小端序无符号长度前缀 + UTF-8 JSON 载荷**；宿主→浏览器单消息上限 1MB（Chrome 平台约束，本项目远小于此）。

### 6.2 请求/响应协议

请求（浏览器 → 宿主）：

```json
{
  "id": "c1f4-…",            // 扩展生成的请求号，原样回显
  "action": "status",        // ping | status | start | stop | restart | adopt | logs
  "payload": {
    "profile": "web",        // start/restart 用
    "launchMode": "global",  // start/restart 用：global=全局 CLI (dsh) | npx=NPX 免安装 | source=本地源码路径；缺省 global
    "customPath": "",        // start/restart 用：仅 launchMode 为 source 时必填（本地仓库目录或 bin.js 路径）
    "port": 3080,            // start/restart 用；缺省 3080；0 = 动态端口（M4，OS 分配，从日志回填实际端口）；adopt 用（与 pid 一起取自 status 的 external 结果）
    "host": "127.0.0.1",     // start/restart 用；缺省 127.0.0.1（不允许 0.0.0.0）
    "extraArgs": [],         // 透传给 dsh 的额外参数白名单：见 §12.1
    "pid": 12345,            // adopt 用（取自 status 的 external 结果）
    "tailLines": 500,        // logs 用：返回的最后 N 行（1-2000，默认 500，仅尾部块生效）
    "maxBytes": 262144,      // logs 用：单块最大字节数（1KB-1MB，默认 256KB）
    "beforeByte": 1048576    // logs 用：返回结束于该偏移的前一段（「加载更早」分页；缺省为尾部块）
  }
}
```

响应（宿主 → 浏览器）：

```json
{
  "id": "c1f4-…",
  "ok": true,
  "result": {
    "state": "running",           // stopped|starting|running|stopping|external
    "source": "managed",          // managed=本扩展启动；external=外部启动；stopped 时为 null
    "pid": 12345,                 // running/starting/stopping/external 时存在
    "port": 3080,                 // managed 动态端口未回填时（--port 0 占位期）为 null
    "url": "http://127.0.0.1:3080",
    "launchUrl": "http://127.0.0.1:3080/?token=...",  // M13：managed 且日志解析到完整启动 URL 时返回（含 token，仅扩展 SW 用于打开标签；external/adopted/未解析为 null，§12.3）
    "requestedPort": 0,           // 仅 --port 0 且 port 未知时出现（0 = 端口自动分配中）
    "version": "0.1.0-rc.6",      // dsh --version，status 时返回；external 为 "unknown"
    "startedAt": 1739420000000,   // external 为 null（启动时刻未知）
    "externalCount": 2,           // 仅 external 且外部实例 >1 时出现
    "lifecycle": true,            // GET /_lifecycle/health 可达（仅 running 时探测，1.5s 超时失败静默 false）
    "health": {                   // lifecycle:true 时附带；否则 null（§7.3；不作存活判定依据）
      "ok": true, "pid": 12345, "uptimeMs": 182000, "port": 3080, "nodeVersion": "v22.16.0"
    },
    "stopMethod": null,           // 仅 stop 响应：'graceful'=优雅停止 / 'force'=taskkill；其余动作恒 null
    "logFile": "C:\\Users\\…\\AppData\\Local\\dsh-manager\\logs\\dsh-web.log"
  },
  "error": null
}
```

失败响应：`"ok": false`，`error` 携带稳定错误码：

**logs 响应**（M3 日志查看，§6.3 logs）：

```json
{
  "id": "c1f4-…",
  "ok": true,
  "result": {
    "exists": true,                // 日志文件是否存在；false 时其余字段恒为 0/空
    "path": "C:\\Users\\…\\AppData\\Local\\dsh-manager\\logs\\dsh-web.log",
    "sizeBytes": 1048576,          // 文件当前字节数
    "fromByte": 786432,            // 本块在文件中的起始字节偏移（含行边界对齐）
    "toByte": 1048576,             // 本块结束字节偏移；尾部块恒 === sizeBytes
    "hasMore": true,               // 是否还有更早内容（fromByte > 0）
    "tailLines": 500,              // 本块包含的完整行数
    "tail": "…最近日志文本…"       // 日志内容（只含完整行；跨块的不完整首/尾行被丢弃）
  },
  "error": null
}
```

块间契约：相邻块**严格衔接**（前块 `toByte` === 后块 `fromByte`），扩展按 `beforeByte = 首块 fromByte` 逐块向前翻页直至 `hasMore:false`；字节偏移按 UTF-8 精确计算。

| 错误码 | 含义 | 扩展侧提示 |
|--------|------|-----------|
| `DSH_NOT_FOUND` | 未找到 dsh 安装（npm 全局路径解析失败） | 「未检测到 dsh，请先 `npm i -g @deepseek-ai/dsh`」 |
| `PORT_BUSY` | 目标端口被非 dsh 进程占用 | 「端口 3080 已被其他程序占用」 |
| `ALREADY_RUNNING` | start 时已在运行 | 视为成功（幂等） |
| `ALREADY_STOPPED` | stop 时已停止 | 视为成功（幂等） |
| `START_TIMEOUT` | 30s 内端口未就绪 | 附日志尾部 20 行 |
| `STOP_FAILED` | taskkill 失败（无权限/进程已变） | 附 system 错误信息 |
| `EXTERNAL_UNMANAGED` | 检测到外部运行的 dsh web（非本扩展启动），拒绝停止/重启；adopt 目标不存在时亦返回 | 「检测到外部运行的 dsh web，请先接管或在其原终端停止」 |
| `BUSY` | 锁被另一宿主持有 | 「操作进行中，请稍候」 |
| `BAD_REQUEST` | action 非法 / 参数校验失败 | 开发期诊断 |
| `INTERNAL` | 宿主自身异常 | 附 stack（仅开发模式） |

### 6.3 动作实现规范

**status**

M13 二期优先规则：有效就绪文件（§6.9）直接返回 running 与文件内 health，starting
返回 starting；无有效文件时执行下面的 HTTP 回退。只读 status 对新鲜、身份匹配的就绪
文件跳过 Windows 进程命令查询；停止、重启等管理动作仍执行 PID 复用校验。

1. 读 `run\dsh-web.json`；不存在 → 执行外部实例发现（§6.6）：发现则返回 `external`（附 `source:"external"`、真实 pid/port/url 与 `externalCount`），否则 `stopped`（顺带清理孤儿 pid 文件）。
2. `process.kill(pid, 0)` 判定存活；已死 → 清理记录 → 同第 1 步执行外部实例发现。
3. 加固检查（可选开关）：用 `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"` 校验命令行包含 `dsh`，防止 PID 复用误判/误杀；校验不过 → 清理记录 → 同第 1 步。
4. HTTP 探活：`GET http://127.0.0.1:<port>/`，超时 1.5s。200 → `running`；失败但 PID 存活 → `starting`（进程在加载依赖，dsh 冷启动可达数秒）。**认证兼容（§2.1.1 B1）**：dsh ≥ 0.1.2 的 `GET /` 对无凭据请求返回 **401**，故判定须把 401 一并视为就绪（401 恰证明 dsh 认证中间件已挂载），或改探公开静态资产 `/manifest.webmanifest`；探测请求**不得**发送 `Accept-Encoding`（§2.1.1 B2）。**M13**：status result 附带 `launchUrl`（读 run 记录；external/adopted/未捕获为 null，§6.2）。
5. 附带 `dsh --version`（缓存到 run 记录，避免每次 status 都跑子进程）。
6. running 时探测 `GET http://127.0.0.1:<port>/_lifecycle/health`（1.5s 超时，失败静默）：可达则附带 `health` 富状态且 `lifecycle:true`；不可达则 `health:null`、`lifecycle:false`（富状态**不可作为存活判定的唯一依据**，§4.2.6）。

> 外部实例发现只在**无有效 run 记录**时执行：有 run 记录时 managed 实例优先，不做发现扫描（省去每 2s 轮询的进程枚举开销）。

**start**

1. status → `running` 则返回 `ALREADY_RUNNING`。
2. 抢锁（§4.2.5）。
3. 探测端口占用：TCP connect 到 `127.0.0.1:port`，能连上且不是我们的 run 记录 → `PORT_BUSY`（顺带做 dsh 指纹探测：若占用者就是 dsh web，错误消息明确提示「该端口已有一个外部运行的 dsh web」，引导用户在原终端停止或更换端口）。**M4：`port 0`（动态端口）跳过占用探测**——端口由 OS 分配，不存在占用。
4. 解析 dsh 启动器（见 §6.4），校验版本 ≥ 最低支持版本。
5. spawn（POSIX 直接 spawn；Windows 隐藏控制台载体，见下方 bullet）：
   ```
   node.exe <npm-global>\node_modules\@deepseek-ai\dsh\lib\bin.js
        --profile web --host 127.0.0.1 --port 3080 [extraArgs...]
   POSIX options: { detached: true, stdio: ['ignore', logFd, logFd], env: { ...process.env } }
   Windows（M5.5）：wscript.exe + launch-hidden.vbs（BASE_DIR 下运行时自生成），命令经
             环境变量 DSH_MANAGER_LAUNCH_CMD 传递，VBS 以 `cmd /d /c call` 执行并
             `1>> 日志 2>&1` 重定向；wscript 2s 内非 0 退出即载体失败（INTERNAL）
   ```
   - 日志文件先 `mkdir -p`：POSIX 用追加打开的 fd（`fs.open(..., 'a')`），宿主退出后 fd 随宿主关闭，不影响 dsh 后续写入；Windows 由 cmd 重定向追加（语义一致）。
   - **不用 pipe**：pipe 会在宿主退出后产生 EPIPE 风险；日志文件同时是 M3「查看日志」与「解析实际端口」的数据源（F5）。
   - **隐藏控制台载体（M5.5，2026-08-15 实现）**：Windows 下 `detached:true` 由 libuv 无条件加 `DETACHED_PROCESS`（子进程既不继承也不新建控制台），且受限令牌下 `CREATE_NO_WINDOW` 不可用（`STATUS_DLL_INIT_FAILED`，`@deepseek-ai/dsh-sandbox-windows-acl` README 记载）——直接 spawn 的 dsh 必然无控制台，其每次执行命令都会新建一闪而过的终端窗口。M5.5 改为**隐藏控制台载体**启动：宿主先写 `launch-hidden.vbs`（`BASE_DIR` 下，运行时自生成），再 `wscript.exe` 执行 `WScript.Shell.Run(cmd, 0, False)`——`windowStyle=0`（SW_HIDE）使 dsh 获得一个**存在但从不显示**的控制台：其命令子进程继承该控制台（不再闪窗），桌面也无常驻窗口。**必须显式 `cmd /d /c call` 执行**：`WshShell.Run` 对引号开头（exe 路径）的命令直接 CreateProcess，`1>> 日志 2>&1` 会被当成普通参数丢失（实测发现，2026-08-15）；`call` 同时避开 cmd /c 的剥引号规则；`%` 按 cmd 规则转义为 `%%`。载体进程（wscript→cmd）即刻退出，dsh 独立存活。**实测核验（EnumWindows 窗口枚举）**：载体下 dsh 控制台窗口存在但不可见（IsWindowVisible=false），其子进程零新窗口（对比直接 spawn 时子进程弹可见新终端，2026-08-15）。POSIX 无控制台概念，维持直接 spawn。若 dsh 上游修复受限令牌限制（沙箱可直接 `CREATE_NO_WINDOW`），可移除载体回归直接 spawn。
6. 写 run 记录（先写 `.tmp` 再 `rename`，内容含 pid、port、profile、startedAt、version、cmdline；M4 新增 `requestedPort` 与 `logStartBytes`（spawn 时刻日志字节偏移）；**M13 新增 `launchUrl`**——完整启动 URL 行 `dsh web: <url>`（含 token query，§6.2/F5）：固定端口在就绪轮询内（第 7 步）从日志捕获，`--port 0` 在第 9 步回填端口时一并捕获；未捕获为 null，不阻塞启动）。**M5.5 时序**：记录在「端口就绪 + PID 已知」后才写——Windows 载体不回传 PID，端口就绪后经端口表反查（`findPidByPort`，带 200ms 短重试）；启动期间（端口就绪前）无记录，status 显示 stopped（快速连点由第 2 步的锁兜底，见第 7 步）。失败路径（`START_TIMEOUT` / 动态端口未报告）**尽力回写**：POSIX 直接用 spawn 已知的 pid；Windows 端口已知时经端口表反查、未知时经进程表匹配 bin+`--port 0`（尽力而为）；匹配失败仅记日志——实例可能仍在运行，刷新 popup 后可按 external「接管」停止。
7. 释放锁（**M5.5：锁保持到 run 记录写入完成之后**——启动窗口内并发 start 被锁挡下，`--port 0`（无占用探测）亦被覆盖，防双开；轮询在锁内进行）；轮询端口（500ms 间隔，最长 30s）。就绪 → `running`；超时 → 返回 `START_TIMEOUT` + 日志尾部（此时**不杀进程**，交由用户查看日志后决定；进程可能仍在后台最终就绪）。
8. `unref()` child 句柄，宿主随时可安全退出。
9. **M4 动态端口（`--port 0`）**：第 7 步之前先轮询日志（仅解析 `logStartBytes` 之后的追加内容，排除历史实例干扰）匹配 `dsh web: http://127.0.0.1:<port>` URL 行（真实 dsh 绑定后打印实际端口；port 0 占位行跳过），发现后**回填 run 记录实际端口**再按常规探活；30s 未发现 → `START_TIMEOUT`。status 遇 port 0 占位记录同样尝试回填（自愈），回填前对外报 `port:null` + `requestedPort:0`、状态 `starting`。**M13**：同一轮日志扫描同时捕获完整 `dsh web: <url>` 行（含 token query）写入 run 记录 `launchUrl`（固定端口实例同样捕获，见第 6/7 步）。

**stop**

1. status → `stopped` 则返回 `ALREADY_STOPPED`；status → `external` 则返回 `EXTERNAL_UNMANAGED`（外部实例不属于本扩展管理范围，绝不 taskkill）。
2. 抢锁。
3. 优雅路径（dsh-lifecycle 插件存在时）：先探测 `/_lifecycle/health`（1.5s）判定插件可用；可用则 `POST http://127.0.0.1:<port>/_lifecycle/shutdown`（2s 连接超时）→ 轮询端口关闭 ≤ 3s；关闭则记为 `stopMethod:'graceful'` 并跳过第 4 步。插件不可达则直接走第 4 步（不浪费一次 POST；SPA fallback 对未匹配路径也返回 200，不能以状态码判定插件存在）。
4. 强制路径（插件缺失或优雅路径超时）：Windows 为 `taskkill /PID <pid> /T /F`；**M4 POSIX 为 SIGTERM（进程组，detached 起组）→ 3s 内未退出 SIGKILL 兜底**；均记为 `stopMethod:'force'`（语义不变：优雅仅指 lifecycle 插件路径）。PID 取自 run 记录；先做 PID 复用校验，失败则拒杀并报 `STOP_FAILED`。
5. 等待端口关闭且 PID 退出 ≤ 10s；PID 仍活着则复核身份并强制终止，标记 `stopMethod:'force'`，再等 ≤ 3s；仍未完全退出 → `STOP_FAILED`。
6. 删除 run 记录与 pid 文件，释放锁。stop 响应的 result 附带 `stopMethod`（graceful/force）。

**restart**

- v1：stop（等待 `stopped`）→ start，宿主内部顺序执行，一次应答。
- status → `external` 时返回 `EXTERNAL_UNMANAGED`（外部实例不可由扩展直接重启，先接管，§6.7）。
- **重启参数 = 请求 payload 显式字段优先，run 记录回退（2026-08-24 修订）**：payload 显式给出的 `host`/`port`/`profile`/`extraArgs` 以 payload 为准（§6.2 声明这些字段为 start/restart 用；popup 保存设置后点重启即携带新端口——原实现完全忽略 payload，导致「改端口后重启仍起旧端口」的非预期行为；非接管 `extraArgs` 仍走 §12.1 白名单）。payload 未给出对应字段时回退 run 记录（页面内面板等空 payload 场景、旧客户端行为不变）。——重启编排权在宿主（插件不需要、也不应该知道自己的 profile/启动参数，见 §7.5）。
- 接管实例（`adopted:true`）的重启：`extraArgs` 恒以接管时解析的 argv 重放（黑名单过滤，不走 §12.1 白名单，参数源自本机进程表，见 §6.7）；生命周期参数（host/port/profile）默认记录值（`--port 0` 归一化为接管时的实际端口），payload 显式给出时以 payload 为准（且必须先通过 start 同款白名单校验）。
- **M4**：`--port 0` 启动的记录（`requestedPort===0`）按动态端口语义重放——重新以 `--port 0` 拉起并再次从日志回填实际端口（OS 重新分配）；payload 显式给出端口时以 payload 为准（用户意图优先于血统）；接管实例不受影响（仍按接管时实际端口重放）。

**adopt**（外部实例接管，§6.7）

1. payload `{pid, port}` 必须是正整数（取自 status 的 external 结果）；非法 → `BAD_REQUEST`。
2. 重新执行外部实例发现，在结果中按 **pid + port 双重精确匹配** 目标（防止 PID 复用/接错实例）；不匹配或进程已死 → `EXTERNAL_UNMANAGED`。
3. 抢锁；锁内复查目标 PID 存活与端口指纹，仍为 dsh → 解析其命令行（profile / host / 其余 argv），`binPath` 用 `resolveDshBin()` 解析（§6.4，测试可被 DSH_BIN_STUB 替换）。
4. 回写 run 记录：`{pid, port(实际端口), host, profile, startedAt(接管时刻), version(dsh --version), binPath, extraArgs(原 argv 剩余项), adopted:true, cmdline}`。
5. 返回 `running`（`source:"managed"`）。此后 stop/restart 走标准 managed 路径；restart 重放时新记录**延续 `adopted` 血统标记**（后续 restart 持续按接管 argv 重放，参数始终源自接管时的本机进程表）。

**ping** = 返回宿主版本与 dsh 路径解析结果（诊断用）。

**logs**（M3 日志查看，只读、无锁）

1. payload 校验：`tailLines` 1-2000 整数（默认 500）、`maxBytes` 1KB-1MB 整数（默认 256KB）、`beforeByte` 非负整数（可选）；非法 → `BAD_REQUEST`。
2. `stat` 日志文件：不存在 → `exists:false`；存在且为 0 字节 → `exists:true` + 空 `tail`。
3. 定位区间 `[start, end)`：`beforeByte` 缺省或 ≥ 文件大小时为**尾部块**（`end=size`，`start=size-maxBytes`）；否则为**中间块**（`end=beforeByte`，`start=end-maxBytes`）。
4. 按字节精确读取 `[start, end)`（`fs.openSync` + 循环 `readSync`，不整读大文件）。
5. 行边界对齐：`start>0` 时丢弃段首至第一个 `\n` 的不完整行；中间块在 `end<size` 时丢弃段尾最后一个不完整行（该行的前半部分在更新的块里）——保证每块只含完整行、块间严格衔接（前块 `toByte` === 后块 `fromByte`）。
6. 尾部块再按 `tailLines` 截断最早的若干行（按字节精确回算 `fromByte`）；`hasMore = fromByte > 0`。
7. 返回 `{exists, path, sizeBytes, fromByte, toByte, hasMore, tailLines, tail}`（响应恒 < 1MB，扩展 1MB 出站帧上限内）。
8. 安全：只读本机日志文件，不接受任意路径（路径固定为 `LOGS_DIR\dsh-web.log`）；`tail` 由扩展侧 `textContent` 渲染，不进入 HTML。

### 6.4 dsh 启动器解析（launchMode 多模式支持）

根据请求中传入的 `launchMode`（缺省 `global`）解析执行规范：

1. **`global` 全局安装模式（默认）**：
   - 按序探测：`DSH_BIN_STUB`（测试）→ `DSH_MANAGER_NPM_PREFIX` → `%APPDATA%\npm` → `npm prefix -g` → 平台定位（Windows `where dsh` / POSIX `command -v dsh`）。
   - 以 `process.execPath` (Node) 运行对应 `lib/bin.js`。若均找不到，报 `DSH_NOT_FOUND`，引导用户执行 `npm i -g @deepseek-ai/dsh` 或切换为 NPX 免安装模式。
2. **`npx` 免安装快速启动模式**：
   - 官方最新推文推荐模式：使用系统 `npx`（Windows 下优先探测 `npx.cmd`，POSIX `npx`）。
   - 命令行：`npx -y @deepseek-ai/dsh --profile <profile> [extraArgs...] --host 127.0.0.1 --port <port>`（必须显式携带 `-y` 防止首次无缓存时触发交互确认挂死）。profile 只选择一次；`extraArgs` 中的 launcher `--patch` 必须在 Web 参数前（§2.1.2）。global / source 同样遵守此顺序。
3. **`source` 本地源码 / 脚本路径模式**：
   - 针对开发者本地 `git clone` 场景：解析 `customPath`，若为文件直接使用；若为目录，自动探测其下的 `lib/bin.js`、`bin.js`、`packages/cli/lib/bin.js` 等入口。
   - 校验文件存在后以 `process.execPath` 直接执行，启动本地最新源码。源码仓库须先按上游 README 执行 `pnpm install`、`pnpm run build`；只有入口文件存在不足以证明其 workspace 依赖和 `lib/` 产物齐全。
   - **本地 clone 专属覆盖（2026-09-23 用户选择）**：宿主在自身 `run/` 下生成固定的 `source-no-ssh.patch.yml`（仅 `mcp-ssh: disabled: true`），以 launcher 参数 `--patch <绝对路径>` 放在 `--host/--port` 前。仅 source 模式应用；不修改 `$DSH_HOME/profiles/web/cordis.patch.yml`，全局与 NPX 模式照常加载 SSH MCP。原因：当前真实 profile 的 `mcp-ssh` 经 `npx` 启动会使 0.1.6-alpha.1 clone 的 Web 就绪等待延长到约 82 秒，超过宿主 30 秒上限；一次性覆盖实测约 19 秒就绪。

### 6.5 状态文件布局

```
%LOCALAPPDATA%\dsh-manager\
├─ run\dsh-web.json        # 唯一权威 run 记录（JSON，原子写）
├─ run\dsh-web.pid         # 冗余纯文本 pid（供外部工具/调试读取）
├─ run\host.lock           # 跨宿主互斥锁（'wx' 原子创建）
└─ logs\dsh-web.log        # dsh stdout+stderr 追加日志
```

run 记录示例：

```json
{
  "pid": 12345,
  "port": 3080,
  "host": "127.0.0.1",
  "profile": "web",
  "startedAt": 1739420000000,
  "version": "0.1.0-rc.6",
  "binPath": "C:\\Users\\<user>\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js",
  "extraArgs": [],
  "adopted": false,
  "cmdline": "node.exe C:\\Users\\<user>\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js --profile web --port 3080"
}
```

> `adopted:true` 表示实例由外部接管而来或继承接管血统（§6.7）：restart 按其原 argv 重放；`startedAt` 为接管时刻（真实启动时刻未知）。

---

## 6.6 外部实例发现（检测现有 dsh 服务的运行端口）

**目标**：用户在终端手工运行了 `dsh web`（无 run 记录，端口未知，可能 `--port 0`）时，status 能**检测到它并报告真实端口与 URL**，popup 以 `external` 状态展示并允许一键打开 Web UI。此能力同时收编 §16 风险表「端口通但无 run 记录」与 M4「端口发现」中与外部实例相关的部分。

**触发时机**：仅当 `computeStatus` 无有效 run 记录时执行（managed 实例优先，避免每 2s 轮询都做进程枚举）。

**算法（按序，任一命令失败静默降级，绝不报错）**

1. **枚举候选进程**：`powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"`（超时 10s；失败→跳过发现）。测试钩子 `DSH_MANAGER_FAKE_PROCESSES`（JSON 数组 `[{pid,cmdline}]`）可注入假进程表（生产环境不存在该变量）。
2. **过滤 dsh 入口**：CommandLine 匹配 `@deepseek-ai\dsh\lib\bin.js`，且属于 web 实例（含 `--profile web` / 位置参数 `web` / `--port` 任一）；进程须 PID 存活。已知局限：非 npm 布局（源码 checkout 直跑）不识别，v1 可接受。
3. **解析端口**：从 CommandLine 解析 `--port <n>` 或 `--port=<n>`；`--port 0` 或缺省 → 走第 4 步。
4. **动态端口回退**：`netstat -ano -p TCP` 解析该 PID 的全部 `LISTENING` 端点（IPv4 `addr:port` 与 IPv6 `[addr]:port` 两种行格式），回环（`127.0.0.1`/`::1`/`::ffff:127.0.0.1`）与通配（`0.0.0.0`/`::`）绑定的端口作为候选。测试钩子 `DSH_MANAGER_FAKE_LISTENERS`（`[{pid,addr,port}]`）。
5. **dsh 指纹探测（误报闸门）**：对候选端口 `GET http://127.0.0.1:<port>/manifest.webmanifest`（1.5s 超时），响应体须包含 `DeepSeek Harness`。指纹不匹配的端口（其他 node 服务、PID 复用残留）一律不报告。**指纹端点选型（§2.1.1 B1）**：原用 `GET /` 读 `dist/index.html` 的 `<title>`——dsh ≥ 0.1.2 起 `/` 受启动令牌认证保护，无凭据返回 401 且 body 无指纹，闸门会恒不通过；`manifest.webmanifest` 属上游明示「保持公开」的非 index 静态资产，其 `"name": "DeepSeek Harness"` 在 0.1.1-rc.2 与 0.1.2-alpha.1 中一致，且仅 267 字节（8KB 早退分支不触发），rc.2 与 0.1.2 双向兼容。
6. **报告**：第一个匹配实例作为 `external` 状态返回（pid/port/url，`startedAt:null`、`version:"unknown"`）；多个匹配时附 `externalCount`。已知局限：仅探测回环绑定，LAN 地址绑定的外部实例不在 v1 范围。

**管理边界（安全）**

- 发现动作只执行本机**只读**命令与回环 GET 探测：不写 run 记录、不 spawn、不 taskkill。
- `stop`/`restart` 对外部实例一律 `EXTERNAL_UNMANAGED`（popup 按钮亦禁用）——外部实例可能由用户终端前台运行，杀掉会破坏其终端语义；需要管理时走**显式接管**（§6.7 adopt），由用户主动授权。
- `start` 端口冲突时做指纹探测，若占用者是 dsh 则给出针对性提示（§6.3 start 第 3 步）。

---

## 6.7 外部实例接管（adopt）

**目标**：用户在 popup 对 `external` 实例点「接管」后，该实例纳入扩展管理——获得 stop / restart 能力（§6.3 adopt / restart）。

**语义与边界**

1. **显式授权**：接管是唯一的从 external 进入 managed 的路径；未经接管，任何动作都不触碰外部进程。
2. **双重匹配防误接管**：adopt 的 `{pid, port}` 必须同时命中发现结果（§6.6）；PID 复用或端口漂移导致不匹配 → `EXTERNAL_UNMANAGED`，绝不硬写记录。
3. **记录来源**：run 记录的 profile/host/extraArgs 从该进程的**真实命令行**解析（本机进程表，用户自己的进程），`binPath` 由宿主标准解析链（§6.4）现场解析；`--port 0` 归一化为接管时的实际端口。
4. **重启重放**：接管实例的 restart 用其原始 argv（去掉 profile/host/port 后以记录值归一化重放），保留用户其余参数（如 `--patch`、`--resume`、`--trusted-host`）；**该路径不走 §12.1 extraArgs 白名单**——因为参数来自本机进程表而非扩展消息。扩展输入路径（start/restart 的 payload）仍严格白名单，两条输入通道边界清晰。
5. **已知局限**：接管后环境变量为宿主当前环境（外部进程的 env 不可读）；`startedAt` 记为接管时刻；多外部实例时逐个接管（接管一个后 managed 优先，其余外部实例需在停止该实例后再次 status 发现）。

---

## 6.8 平台抽象层（M4）

宿主对平台差异的收敛点（其余逻辑平台无关）：

| 能力 | Windows | Linux | macOS |
|------|---------|-------|-------|
| 状态根目录 | `%LOCALAPPDATA%\dsh-manager` | `$XDG_CONFIG_HOME/dsh-manager` 或 `~/.config/dsh-manager` | `~/Library/Application Support/dsh-manager` |
| 强制终止 | `taskkill /PID <pid> /T /F` | `kill(-pid, SIGTERM)`（进程组）→ 3s → SIGKILL | 同 Linux（`kill(-pid, …)`） |
| 进程枚举 | powershell `Get-CimInstance Win32_Process` | **/proc 扫描（零外部依赖）**：`/proc/*/cmdline` + `comm` 过滤 node | `ps -eo pid=,args=` |
| 端口表 | `netstat -ano -p TCP` | **/proc/net/tcp(+tcp6)**（LISTEN 行 inode → `/proc/*/fd` 反查 pid，零外部依赖） | `lsof -nP -iTCP -sTCP:LISTEN` |
| PID 命令行校验 | `tasklist /FI` | `/proc/<pid>/cmdline` | `ps -p <pid> -o args=` |

实现要点：`IS_WIN`/`IS_MAC` 分支集中在上述五个函数内；`--port 0` 日志发现、锁、run 记录、HTTP 探测、优雅停链全部平台无关；测试钩子（`DSH_MANAGER_FAKE_PROCESSES` 等）优先于平台实现（假数据注入时两者都不走）。

**验证状态**（2026-08-14）：Windows 路径 M1 起生产实测；**Linux 路径经 Kali WSL（WSL2）实测通过**——smoke 场景 26（POSIX 专属）不注入任何 fake 钩子，真实 /proc 枚举 + /proc/net/tcp 端口表 + /proc PID 校验 + 指纹探测发现/接管/停止外部实例全链路通过，且 Linux 全量冒烟不再围栏（`BASE_ENV` 围栏仅 Windows 使用）；macOS 三个分支已实现但**未实测**（无 macOS 设备，`ps`/`lsof`/`~/Library` 分支待验证）。

---

## 6.9 插件就绪文件（M13 二期，2026-09-21）

**0.2.x 退出补充（2026-10-04）**：shutdown 的端口关闭表示 dispose 已开始；stop
还需等记录中的 PID 退出后才能清记录和重启。10 秒内未退出时复核 PID 身份并强制
终止，`stopMethod` 据实际路径返回 graceful / force。这样 Windows 的旧日志句柄
不会阻止新载体打开日志文件；见 §2.1.2 与 `native-host/test/stop.test.js`。

宿主每次 start/restart 生成随机 128-bit `launchId` 与 `launchStartedAt`，经子进程环境
`DSH_MANAGER_READY_FILE`、`DSH_MANAGER_LAUNCH_ID`、`DSH_MANAGER_LAUNCH_STARTED_AT`
传递。路径固定为宿主 `BASE_DIR/ready/dsh-web.json`，独立于宿主拥有的 run 记录；扩展
请求不能指定路径。手工启动未提供这些变量时，插件不写文件。

文件 v1：`{schemaVersion:1, launchId, launchStartedAt, mountId, pid, host:'127.0.0.1', port,
state:'starting'|'ready', startedAt, updatedAt, pluginVersion, nodeVersion}`。`startedAt`
是插件估算的进程启动时间，`launchStartedAt` 原样回传宿主启动时间。插件先发布 starting，
优先订阅 `ctx.get('appReady').onReady()`，仅在 launcher 确认成功启动后发布 ready；
旧版无该服务时异步等待 `ctx.get('loader')?.await()`（不可阻塞 apply）。dispose
取消未触发的就绪订阅，失败启动不得发布 ready；port 必须是
`webServer.port` 的实际非零端口。相邻临时文件 + rename 原子替换，每 2 秒续期，计时器
unref；清理器仅删除自身 mount 写出的文件，dispose 后不得再次发布。写失败不影响 dsh。

宿主只接受 ≤8 KiB、结构合法、启动标识与启动时间匹配、PID 存活、
固定端口匹配（动态端口可回填）、updatedAt 在过去 10 秒内（未来容差 2 秒）的记录。
只读 status 在这些条件成立时跳过耗时的进程命令查询；start/stop/restart 等管理路径
继续执行既有进程校验，且在已验证同一 PID 后不重复查询。
run 记录保存 launchId/launchStartedAt 供后续独立 native 调用复核，不保存任意就绪路径。
ready 优先于 HTTP；starting 不被 HTTP 成功覆盖。缺失、过期、损坏或不匹配时走原 HTTP
回退，**文件消失不等于 stopped**（插件热卸载、写失败、旧插件均可能无文件）。PID 死亡
仍优先清理 run 记录，文件绝不赋予外部进程管理权。无文件/旧 run 记录行为兼容。

start 在启动前监听 ready 目录，用文件变化唤醒等待，同时保留 500ms 定时检查应对丢事件；
有效信号直接提供 PID/动态端口，省去 HTTP 与 Windows 端口表反查。启动 URL 仍按 §12.3
从日志捕获，文件不含认证 token。status 有新鲜 ready 时直接构造 health，不发 HTTP；
stop 先判断端口关闭，再等待 PID 退出（见本节 0.2.x 补充）。扩展请求/响应格式不变（§6.2）。
