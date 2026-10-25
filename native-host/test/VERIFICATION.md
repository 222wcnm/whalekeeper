# DSH Manager — 测试与验收报告（VERIFICATION）

## 发布前复审与启动耗时定位（2026-10-26）

扩展 0.3.2、配套插件 0.4.2 完成增量审查与重新验收：单测 **178/178 PASS、0 SKIP**；
Windows 开发目录 smoke **428 PASS / 0 FAIL / 1 POSIX SKIP**；发布副本独立 smoke
**422 PASS / 0 FAIL / 4 SKIP**（3 项本地安装副产物和 1 项 POSIX 检查按全新克隆预期跳过）。
本轮重新执行三轮真实隔离生命周期 **196/196 PASS**，首轮含 Chrome **156.0.8078.48
浏览器 121/121 PASS**。12 次独立启动全部严格 graceful 退出，清理无 force、errors 或
warnings，PID/监听/run/PID文件/ready/lock 均无残留。start 9.98–22.00s、restart
13.35–23.50s、stop 2.22–2.63s；真实断流 5ms 撤销 live、隐藏页 13.79s 重连，
HTTP/镜像一致且 `falseDone=false`。

正式证据根 `.e2e-current/run-mvo3y5wp-91931053/`，含各轮报告、首轮 `ui.log`、
`ui/real-sse-recovery.json` 与严格核对后的 `verified-summary.json`。本轮所选 CLI 是
全局 DSH 0.2.1-rc.2 及全部依赖的 D 盘隔离副本；复制 63,660 个文件无失败，CLI、
app-boot、Cordis 的关键源码 SHA-256 与原安装一致。生产 host 和扩展源码原样执行，
未改正式 150s 预算、HTTP 行为、权限或版本范围，也未修改日常全局安装、profile 或注册。
下文 2026-10-19 的三轮 196 项为历史验收，与本轮重新执行的 196 项分别保留。

### 先前超时的定位证据

初次完整运行在动态重启处通过 54 项后触发 150s `START_TIMEOUT`，之前的三个启动也
耗时 131–141s；清理阶段才观察到同一启动的 ready 信号。该失败保留于
`.e2e-current/run-mvo19xzs-f18617ae/`，未计作通过，测试实例已完整清理。
后续同机器、同 Node v24.19.0、同模块文件的只读对照如下：

| 调用 | 工具启动的进程 | 用户独立 PowerShell |
|---|---:|---:|
| 原 AppData 安装目录 `statSync` | 1.173ms | 0.0126ms |
| 原 AppData 安装目录 `realpathSync` | 14.982ms | 0.0867ms |
| D 盘相同模块副本 `realpathSync` | 0.0788ms | 0.0833ms |

证据支持将慢点定位为**本次工具执行链路访问 AppData 时的额外文件访问开销**，而非
新插件代码的启停回归；具体底层拦截组件未证实，不据此修改 ACL、杀软或系统配置。
内存紧张和换页较高是伴随因素，关闭一台模拟器后可用内存约 1.5GB，但目录差异仍存在。
关键原始对照保留在开发目录 ignored 的 `.review-fs-tool-control.json` 与
`.review-fs-user-terminal.json`。同字节 D 盘副本先完成单轮 **65/65** 路径对照，随后
完成上述正式三轮及浏览器验收；未用诊断预加载器或放宽超时替代正式通过。

本轮另修复两类验收竞态：认证失败日志用例的测试专用预算从 1.8s 调整为 10s；UI
验收有界等待扩展页面/托管面板实际就绪，合成帧只发给已注入且属于本扩展的隔离上下文。
首轮固定等待误报 6 项的尝试保留于 `.e2e-current/run-mvo0xoy5-96be4c8b/`；诊断预加载
和未完成副本的尝试均不计正式通过。macOS/Firefox 未新增运行覆盖。

## 当前增量：DSH 0.2.1-rc.2（2026-10-19 验收通过）

本轮使用工作区生产源码、Node v24.19.0 与精确 npm CLI 0.2.1-rc.2。
已复验插件 87 条 + 扩展 62 条（58 UI/状态 + 4 后台）+ 宿主 29 条，共
**178/178 PASS，0 SKIP**；真实 Cordis 4.0.5 挂载/卸载/重挂测试与超过 15 秒的
Native stdio 请求实际执行。首轮生产源码隔离 E2E **65/65 PASS**（固定/动态均含
重启与严格 graceful stop，无残留、无紧急 force）。含 UI 单轮 **66/66 PASS**，
Chrome 155 浏览器 **121/121 PASS**；最终连续三轮生产源码隔离 E2E **196/196 PASS**
（第一轮66、后两轮各65，其中第一轮另运行浏览器121条）。12个独立launch、固定/动态
各三次start/restart/stop全部严格graceful；每轮cleanup无force/errors/warnings，
PID/端口/run/PID文件/ready/lock均清。三轮start4.99–8.00s、restart6.78–10.04s、
stop1.68–2.06s，完整report验证生产host SHA-256未变。
完整 Windows smoke **428 PASS / 0 FAIL / 1 POSIX SKIP**（33 场景），包含新共享
截止、health 重试、迟关端口、force 清理与外来租约保护；未修改日常注册。
最初含 UI 尝试因隔离 HOME 缺 Local 目录使 Chrome 不能确认非默认 profile 而中断；
建立本 case `USERPROFILE/AppData/Local` 后单变量重试通过，另缩短目录避免 Windows
嵌套文件路径过长。未放宽 Chrome 默认目录安全检查，失败尝试未计通过、DSH 清理完整。
单轮真实浏览器恢复实测：断流撤销 live 173ms，hidden 重连 13934ms，HTTP/镜像一致且
`falseDone=false`。证据：`.e2e-current/run-mvec1d3f-5847a6cf/r1-f3b11f34/ui.log` 及其
`ui/real-sse-recovery.json`（隔离产物，不入库）。
最终证据根：`.e2e-current/run-mvec4ykk-17c724ee/`，总表 `report.json`、核验
`verified-summary.json`、各轮 `report.json`、首轮 `ui.log` / `ui/real-sse-recovery.json`。
最终真实断流撤销live122ms、hidden重连13737ms，7条真实恢复断言全通过，HTTP与
镜像一致、`falseDone=false`。独立只读生产diff审查无阻断；所有正式产物保留本机ignored。
日常GUI64847仍由原PID31888监听，测试未访问/重启它，未改日常profile或宿主注册。
macOS/Firefox、TLS/IPv6/远程入口无新增运行结论；Windows无lease的超时PID仍需用户
显式接管，历史tasklist node镜像校验边界未扩大重构。

诊断副本不计通过。下文是 M1 历史报告，30s/3s 等历史
时序及测试计数不代表当前行为，现行契约见设计 §2.1.3/§6.3。

---

- 日期：2026-08-13
- 角色：测试与验收工程师（静态交叉核对 + 冒烟测试 + 语法终检）
- 权威规格：`docs/design.md`（v0.2 全文逐条对照）
- 测试环境：Windows 沙箱（workspace-write 模式），Node v22.16.0，`%APPDATA%\npm` 存在真实 `@deepseek-ai/dsh`
- 沙箱限制（影响测试方式，均已在实现侧优雅处理）：
  - 子进程管道捕获输出 → EPERM（故测试全部走 host.js 文件模式 `--req/--res` + `spawnSync stdio:'inherit'`；host.js 内部所有管道探测均有 try/catch / r.error 兜底，`dsh --version` 因此返回 `unknown`，非缺陷）
  - `taskkill` 终止任何进程 → `ERROR: Access denied`（独立诊断确认，见 §4；影响 stop 强制路径的沙箱内验证）

---

## 1. 静态交叉核对结论表

| # | 规格章节 | 核对项 | 实现位置 | 结论 | 备注 |
|---|----------|--------|----------|------|------|
| 1 | §6.2 | 请求字段 `{id, action, payload{profile,port,host,extraArgs}}`；action 集合 ping\|status\|start\|stop\|restart | host.js `ACTIONS` / `handleRequest` | ✅ PASS | 与规格逐字段一致 |
| 2 | §6.2 | 成功响应 `{id, ok:true, result{state,pid,port,url,version,startedAt,health,logFile}, error:null}` | host.js `buildResult` | ✅ PASS | 字段齐全 |
| 3 | §6.2 | 失败响应 `{ok:false, error{code,message,logTail?}}`；错误码集合 DSH_NOT_FOUND/PORT_BUSY/ALREADY_RUNNING/ALREADY_STOPPED/START_TIMEOUT/STOP_FAILED/BUSY/BAD_REQUEST/INTERNAL | host.js `AppError` / `NEEDS_LOG_TAIL` | ✅ PASS | START_TIMEOUT/STOP_FAILED/INTERNAL 强制附 logTail（20 行） |
| 4 | §6.2 | 幂等错误 | host.js actionStart/actionStop | ✅ PASS | ALREADY_RUNNING/ALREADY_STOPPED 额外携带 `result`（设计失败格式为 result:null，但 §6.2 表将其「视为成功」，属有益扩展，扩展侧按 resp.result 消费） |
| 5 | §6.1 | stdio 帧：4 字节小端长度前缀 + UTF-8 JSON；入站 >1MB 断开；15s 无消息看门狗 | host.js `readFrame`/`writeFrame`/`armWatchdog` | ✅ PASS（静态） | 冒烟经文件模式验证同一 `handleRequest`；帧路径需真实浏览器覆盖（见 §5 风险 2） |
| 6 | §6.1/任务 | 文件传输模式 `--req <in.json> --res <out.json>`（单请求或数组） | host.js `fileMode` | ✅ PASS | 冒烟 14 场景全程使用 |
| 7 | §6.3 status | 无记录→stopped+清理孤儿 pid 文件；PID 死→清记录→stopped；PID 命令行校验（可关）；GET / 探活→running/starting；版本缓存于 run 记录；health=null（M2） | host.js `computeStatus` | ✅ PASS | 探活取 2xx/3xx（规格写 200，更宽无碍）；场景 2/5/12 |
| 8 | §6.3 start | running→ALREADY_RUNNING；抢锁；端口占用→PORT_BUSY；launcher 解析；spawn detached+日志 fd（无控制台，原 windowsHide 字段已移除，§6.3 第 5 步）；原子写 run 记录（.tmp+rename）；释放锁后轮询 500ms×30s；超时 START_TIMEOUT+logTail 且不杀进程；unref | host.js `actionStart` | ✅ PASS | 场景 3/4/9/11/13 |
| 9 | §6.3 stop | stopped→ALREADY_STOPPED；抢锁；M2 优雅 POST `/_lifecycle/shutdown`→轮询端口关闭；失败回退 taskkill /PID /T /F；轮询 10s；清 run 记录与 pid 文件 | host.js `stopCore` | ✅ PASS（优雅路径实测；强制路径沙箱受限） | 优雅路径轮询 3s（规格 §6.3 写 ≤10s，轻微时序偏差）；taskkill 在沙箱被禁，真实进程强制终止需沙箱外验证 |
| 10 | §6.3 restart | stop（等待 stopped）→ start，以 run 记录字段重放 | host.js `actionRestart` | ✅ PASS | 场景 6：pid 31140→51756 |
| 11 | §6.3 ping | 返回宿主版本与 dsh 路径解析结果 | host.js `actionPing` | ✅ PASS | 场景 1 |
| 12 | §6.4 | 启动器解析：npm prefix -g → where dsh（无 shell 主路径） | host.js `resolveDshBin` | ✅ PASS | 实现为超集：DSH_BIN_STUB → DSH_MANAGER_NPM_PREFIX → %APPDATA%\npm → npm prefix -g → where dsh；真实 dsh 集成实测 DSH_MANAGER_NPM_PREFIX 路径成功 |
| 13 | §6.5/§4.2 | 状态文件布局：`run\dsh-web.json`（权威）/`run\dsh-web.pid`/`run\host.lock`/`logs\dsh-web.log`；run 记录含 pid/port/host/profile/startedAt/version/cmdline | host.js 路径常量 / `writeRunRecord` | ✅ PASS | 记录额外含 binPath/extraArgs（超集）；原子写 `.tmp`+`rename` |
| 14 | §4.2.5 | 锁：`fs.open('wx')` 原子创建，重试 3 次间隔 300ms，再失败 BUSY | host.js `acquireLock` | ✅ PASS | 场景 11 实测 BUSY→删锁→成功 |
| 15 | §8.1 | manifest：MV3、name/version、`key`、permissions[storage,nativeMessaging,alarms]、host_permissions 仅回环、action default_popup/default_title、background SW、icons 16/48/128 | extension/manifest.json | ✅ PASS | 逐字段与 §8.1 一致 |
| 16 | §8.2 | popup：打开即 status + 每 2s 轮询；native 请求全部经 SW 中转；starting 就绪按 autoOpen 自动开 UI；错误码中文文案 + 复制日志；设置面板 port/profile/host(固定 127.0.0.1 不可改)/autoOpen/badge 存 chrome.storage.local；按钮随状态启用/禁用 | extension/popup.js / popup.html | ✅ PASS（静态） | 差异：dsh-lifecycle 提示为常驻静态行（§8.2.6 设计为一次性、可关闭） |
| 17 | §8.3 | SW：native 调用串行化（模块级 promise 队列）；connectNative 失败→HOST_NOT_INSTALLED；alarms(30s)→fetch 探活→setBadgeText/Title；sendMessage 异步应答（return true） | extension/background.js | ✅ PASS（静态 + 修复） | **修复了 Native Messaging 双帧编解码缺陷**（见 §3） |
| 18 | §8.4/§10 | 宿主 manifest 字段 name/path/type/allowed_origins/allowed_extensions；注册表 HKCU Chrome+Edge 路径；host.cmd 生成；.reg 导出 | install.ps1 / uninstall.ps1 | ✅ PASS（静态核对；未在沙箱内实跑——会写真实注册表与 %LOCALAPPDATA%，超出工作区） | 差异：§10.1 要求 `node -v`/`dsh --version` 检查，实现仅做存在性检查（脚本注释说明原因，版本校验由宿主 ping 负责） |
| 19 | §10.2 | 固定扩展 ID：key→sha256(DER) 前 16 字节→a-p 32 字符 | keygen.js / compute-id.js | ✅ PASS | **node 独立计算 = `dahcfklamlpgkngijomlnoclclfodkjm`**，与 EXTENSION_ID.txt、extension-key.json、native-host/.extension-id.json 全部一致（见 §2 静态项） |
| 20 | §11 | 模板占位符：host.cmd.template `__NODE_EXE__`/`__HOST_JS__`；com.dsh.manager.json.template `__HOST_CMD_PATH__`/`__EXTENSION_ID__` | 模板 + install.ps1 内联生成 | ✅ PASS | 安装器生成内容与模板占位符语义等价 |
| 21 | §12.1 | 安全：action 白名单；extraArgs 白名单（仅 `--patch <绝对路径>`）；host 仅 127.0.0.1；taskkill 参数仅数字 PID；入站帧 1MB 上限 | host.js | ✅ PASS | 场景 10 实测 `--host 0.0.0.0`（extraArgs 与 payload.host）均 BAD_REQUEST |
| 22 | §14.1 | 冒烟测试（伪 dsh + 状态文件副作用断言） | native-host/test/smoke.js + fake-dsh.js | ✅ PASS | 14 场景 38 断言全过（见 §2） |
| 23 | §9 时序 | start 返回语义 | host.js `actionStart` | ⚠️ 规格内部矛盾（非实现缺陷） | §6.3 规定 start 轮询 30s 返回 running；§8.3.2/§9.1 规定 start 只返回「已 spawn」ack 由 popup 轮询。实现遵循 §6.3，SW 30s 兜底超时恰好覆盖；popup 对两种返回值均兼容（场景 3 接受 starting\|running） |

**静态核对总评：23 项核对，21 项 PASS，1 项为规格内部矛盾（实现自洽），1 项（stop 强制路径）受沙箱限制未实测（见 §4/§5）。未发现规格级偏差需要修改 design.md 的问题。**

---

## 2. 冒烟测试结果（真实运行，文件模式）

命令：`node native-host/test/smoke.js`（DSH_MANAGER_BASE_DIR=项目根\.smoke，DSH_BIN_STUB=fake-dsh.js，DSH_MANAGER_PID_CHECK=0；以上钩子均需 `DSH_MANAGER_TEST_MODE=1` 门控才生效）

| 场景 | 端口 | 断言要点 | 结果 |
|------|------|----------|------|
| 1 ping | 31901 | ok、hostVersion=0.1.0、dshBin=stub | ✅ PASS |
| 2 status 空目录 | 31902 | stopped | ✅ PASS |
| 3 start | 31903 | starting\|running；run 记录存在且 pid/port 正确（pid 31140） | ✅ PASS |
| 4 再 start | 31903 | ALREADY_RUNNING（幂等） | ✅ PASS |
| 5 status | 31903 | running 且 pid/port 与记录一致 | ✅ PASS |
| 6 restart | 31903 | running；pid 变化（31140→51756） | ✅ PASS |
| 7 stop | 31903 | stopped；run 记录清除；端口关闭；fake-dsh 进程退出 | ✅ PASS |
| 8 再 stop | 31903 | ALREADY_STOPPED | ✅ PASS |
| 9 端口占用（smoke 自监听） | 31909 | PORT_BUSY | ✅ PASS |
| 10 非法 action + extraArgs 含 --host 0.0.0.0 + payload.host=0.0.0.0 | 31910 | BAD_REQUEST ×3 | ✅ PASS |
| 11 锁竞争（手工 host.lock） | 31911 | BUSY → 删除锁重试 start 成功 → stop 清理 | ✅ PASS |
| 12 残留清理（手写 run 记录 pid=999999） | 31912 | status→stopped 且记录被清 | ✅ PASS |
| 13 START_TIMEOUT（DSH_FAKE_EXIT_IMMEDIATELY=1 变体） | 31913 | START_TIMEOUT 且 error.logTail 存在非空 | ✅ PASS |
| 14 优雅停路径 | 31914 | 正常 start 后 stop → 日志含 SHUTDOWN-RECEIVED（走 POST /_lifecycle/shutdown，非 taskkill） | ✅ PASS |

**合计：PASS 38 / FAIL 0 / TOTAL 38。** 每场景结束强制清理（残留进程 taskkill 兜底 + 删除 .smoke 与临时请求/响应文件），测试后 `.smoke` 目录已删除，无残留 fake-dsh 进程。

另含静态断言 9 项（ID 一致性 5 项 + JSON 可解析 4 项，见下），亦全部 PASS。

---

## 3. 修复记录（小 bug 直接修复）

### 3.1 [Critical] extension/background.js —— Native Messaging 双帧编解码缺陷（已修复）

- **问题**：SW 用 `encodeFrame()` 把请求手动编码为「4 字节长度前缀 + JSON」的 ArrayBuffer 再 `port.postMessage()`，并用 `createFrameDecoder()` 期望从 `onMessage` 收到原始字节块逐帧解析。但 Chrome Native Messaging **平台自身完成全部帧封装**（design §6.1 的帧格式由 Chrome 与宿主两侧实现）：扩展只需 `postMessage` 普通 JSON 对象，`onMessage` 收到的是解析后的对象。
  - 发送侧：ArrayBuffer 经 Chrome 的 JSON 序列化会变成 `{}`，宿主实际收到空对象 → BAD_REQUEST，生产环境 start/stop/status 全部失效。
  - 接收侧：`onMessage` 收到的是对象而非字节块，解码器 `chunk.length` 为 undefined，解析必然失败。
- **修复**：`runNativeCall` 改为直接 `port.postMessage({id, action, payload})`、`port.onMessage` 按 `obj.id` 匹配收对象；删除 `encodeFrame`/`createFrameDecoder`/`MAX_FRAME_BYTES`；更新文件头注释。
- **验证**：`node --check` 通过；帧路径无法在沙箱内起浏览器实测，已列入 manual-e2e.md 验证清单（§5 风险 2）。

---

## 4. 真实 dsh 集成结论（best-effort）

- 前置核验：`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js` 存在 ✅（真实 dsh 已安装）。
- 安全约束：DSH_HOME 重定向到工作区内 `.smoke-real\dsh-home`（隔离），**全程未触碰真实 `C:\Users\<user>\.dsh`**；失败即 SKIPPED，不重试、不绕过。
- 执行：`node native-host/test/smoke-real.js`（DSH_MANAGER_NPM_PREFIX=%APPDATA%\npm，端口 31997）：

| 步骤 | 结果 | 证据 |
|------|------|------|
| start | ✅ PASS | `{"state":"running","pid":50000,"port":31997,...}` —— 真实 dsh 通过宿主成功启动并监听 |
| status | ✅ PASS | `running`，pid/port 正确 |
| stop | ❌ FAIL | `STOP_FAILED: taskkill 执行失败: 退出码 1`（logTail 已附） |

- **失败原因（独立诊断确认）**：本沙箱对**任意**进程执行 `taskkill /PID /T /F` 均返回 `ERROR: Access denied`（exit 1）——对一个由诊断脚本自建的普通 powershell 进程同样如此。故 stop 的 taskkill 强制路径在沙箱内**不可执行**，属环境限制，**非宿主缺陷**。
- **结论：SKIPPED**（按任务约定，失败记录 SKIPPED + 原因，绝不反复重试或绕过）。start/status 为真实 dsh 集成通过的有效证据；优雅 POST 对无 dsh-lifecycle 插件的真实 dsh 无效（SPA fallback 一律 200），必须依赖 taskkill，故 stop 只能留待沙箱外人工验证（manual-e2e.md）。
- **清理**：真实 dsh 进程已退出、端口 31997 已关闭、无残留 node 进程、`.smoke-real` 已删除。

---

## 5. 遗留风险与建议

| # | 风险 | 等级 | 说明 / 建议 |
|---|------|------|-------------|
| 1 | taskkill 强制停止路径未在真实进程上实测 | 中 | 沙箱禁 taskkill；优雅路径（POST shutdown）已实测通过（场景 7/14）。需沙箱外人工 e2e：真实 dsh start → stop → 确认进程树消失、端口关闭 |
| 2 | background.js 帧修复未经真实浏览器验证 | 高（上线前必测） | 沙箱内无浏览器。manual-e2e.md 步骤 4-6 覆盖：加载扩展后 start/stop/restart 全流程 + HOST_NOT_INSTALLED 分支 |
| 3 | `dsh --version` 在本沙箱管道 EPERM → 所有 version='unknown' | 低 | 版本缓存与最低版本校验逻辑未用真实版本数据验证；沙箱外 status 应能返回真实版本（如 0.1.0-rc.6） |
| 4 | install.ps1 / uninstall.ps1 未实跑 | 中 | 会写真实注册表与 %LOCALAPPDATA%（超出工作区权限），仅静态核对。沙箱外必须按 manual-e2e.md 步骤 1/10 验证注册表项与 manifest 内容 |
| 5 | 设计内部矛盾：start 返回语义（§6.3 轮询 30s vs §8.3.2/§9.1 立即返回 starting） | 低 | 实现遵循 §6.3 且对两种消费方式兼容；建议在 design.md 评审时统一表述（不属实现偏差，未改 design） |
| 6 | 轻微时序偏差：stop 优雅轮询 3s（规格 §6.3 ≤10s） | 低 | 更保守、无功能影响；如需严格对齐可改 `waitPortClosed(..., 3000, ...)` 为 10000 |
| 7 | popup 的 dsh-lifecycle 提示常驻（§8.2.6 设计为一次性可关闭） | 低 | 待 M2 阶段按设置项实现 |
| 8 | 幂等错误附带 `result` 字段（规格失败格式 result:null） | 低 | 有益扩展；扩展侧已按 resp.result 消费，无需改动 |
| 9 | 外部实例发现的生产路径未实测（powershell/netstat 管道在沙箱 EPERM） | 中（上线前必测） | 发现算法经测试钩子全覆盖（§6 场景 15-18）；真实命令链路按 manual-e2e.md 步骤 9 沙箱外验证 |

---

## 6. M1.1 外部实例检测核验（2026-08-13 追加）

规格依据：`docs/design.md` §6.6（外部实例发现）+ §5 `external` 状态 + §6.2 `source`/`EXTERNAL_UNMANAGED`。

### 6.1 静态交叉核对

| # | 核对项 | 实现位置 | 结论 | 备注 |
|---|--------|----------|------|------|
| 1 | status result 新增 `source`（managed/external/null）与 external 时 `externalCount` | host.js `buildResult` | ✅ PASS | 与 §6.2 示例逐字段一致 |
| 2 | 新错误码 `EXTERNAL_UNMANAGED`：stop/restart 遇 external 返回，附当前 external 状态 result | host.js `actionStop`/`actionRestart` | ✅ PASS | 不误杀外部实例 |
| 3 | 发现算法：进程枚举（powershell Get-CimInstance）→ bin.js+web 过滤 → `--port` 解析（`--port=` 兼容）→ `--port 0` 走 netstat 端口表 → `GET /` 8KB 指纹 `DeepSeek Harness` | host.js `discoverExternalDsh`/`classifyDshCmdline`/`listTcpListeners`/`httpDshProbe` | ✅ PASS | 命令失败静默降级（spawnCapture 兜底），指纹与 dsh-web-frontend dist/index.html `<title>` 实测一致 |
| 4 | 触发时机：仅无有效 run 记录时执行；managed 记录存在时不做扫描 | host.js `computeStatus` | ✅ PASS | 场景 18 验证 managed 优先 |
| 5 | start 端口冲突做指纹探测，占用者为 dsh 时给出针对性 PORT_BUSY 文案 | host.js `actionStart` | ✅ PASS | 场景 15d 验证 |
| 6 | 安全：发现只读（无写记录/无 taskkill）；测试钩子仅环境变量存在时生效 | host.js + design §12.1 | ✅ PASS | `DSH_MANAGER_FAKE_PROCESSES`/`DSH_MANAGER_FAKE_LISTENERS` 生产不存在 |
| 7 | popup external 状态：蓝点、仅「打开 Web UI」可用、明细行 PID/实例数、URL 行展示 | extension/popup.js/popup.css | ✅ PASS（静态） | 与 §8.2.7 一致 |

### 6.2 冒烟测试（场景 15-18，全部注入钩子，真实 HTTP 探测）

| 场景 | 断言要点 | 结果 |
|------|----------|------|
| 15 外部实例检测 | external + pid/port/url/source 正确、startedAt=null；stop/restart→EXTERNAL_UNMANAGED；start 同端口→PORT_BUSY 提示外部 dsh；双实例→externalCount=2；实例退出→stopped | ✅ PASS（10 断言） |
| 16 `--port 0` | 位置参数 web + 端口表按 PID 解析（含不同 pid 干扰项过滤）→ external 31916 | ✅ PASS（2 断言） |
| 17 负例 | 指纹不匹配 / 非 dsh 命令行 / 死 pid 候选 → 一律 stopped 不误报 | ✅ PASS（4 断言） |
| 18 managed 优先 | run 记录存在时注入外部假数据不生效，source=managed | ✅ PASS（3 断言） |

**合计：全量冒烟 PASS 57 / FAIL 0 / TOTAL 57（M1 的 38 项断言全部保持通过，无回归）。**

### 6.3 沙箱限制与遗留

- 沙箱内 powershell/netstat 子进程管道捕获 EPERM（与 §1 记录一致）：真实命令链路降级为「无外部实例」，冒烟经 `DSH_MANAGER_FAKE_PROCESSES`/`DSH_MANAGER_FAKE_LISTENERS` 注入覆盖全部解析/判定逻辑；**真实枚举路径需按 manual-e2e.md 步骤 9 在沙箱外验证**（本机当前即有外部 dsh web 监听 127.0.0.1:8080，可直接用于验证）。
- 已知局限（规格 §6.6 已声明）：仅识别 npm 布局（`node_modules\@deepseek-ai\dsh\lib\bin.js`）与回环绑定；LAN 地址绑定、源码 checkout 直跑的实例不在 v1 范围。

---

## 7. M1.2 外部实例接管 + Web UI 同款视觉核验（2026-08-13 追加）

规格依据：`docs/design.md` §6.7（外部实例接管）+ §6.3 adopt/restart + §8.2 视觉规范。

### 7.1 静态交叉核对

| # | 核对项 | 实现位置 | 结论 | 备注 |
|---|--------|----------|------|------|
| 1 | action 集合新增 `adopt`；payload `{pid, port}` 正整数校验 → BAD_REQUEST | host.js `ACTIONS`/`actionAdopt` | ✅ PASS | §6.2 协议表同步 |
| 2 | adopt 流程：发现结果 pid+port 双重匹配 → 锁内复查（存活+指纹）→ `parseAdoptInfo` 解析命令行（`--profile`/`--profile=`/位置 `web`、`--host` 回环归一、lifecycle 参数剔除、其余 argv 保留）→ 回写 run 记录 `adopted:true` | host.js `actionAdopt`/`parseAdoptInfo`/`splitCmdlineTokens` | ✅ PASS | `binPath` 由 `resolveDshBin()` 现场解析（测试可被 DSH_BIN_STUB 替换） |
| 3 | 接管血统 restart：`adopted:true` 记录走 `startDshCore(v, true)` 原 argv 重放（跳过 §12.1 白名单），新记录延续 `adopted` 标记；非接管记录仍走白名单路径 | host.js `actionRestart`/`startDshCore` | ✅ PASS | 两条输入通道边界清晰（§12.1） |
| 4 | `startDshCore` 重构：actionStart 与 restart 共用（锁/复查/PORT_BUSY/launcher/spawn/记录/轮询），行为与 M1 一致 | host.js | ✅ PASS | 场景 1-14 全部保持通过，无回归 |
| 5 | popup 视觉对齐 Web UI：`--dsw-*` 令牌（浅色主题、字体栈、label/border/interactive/state 色值）、分层圆点组件（10% 光晕+内实心+忙碌脉冲+error 红）、黑底主按钮（12px 圆角/500 字重）/红字描边/描边/链接按钮、12px 面板圆角；**鲸鱼 logo 与设置齿轮图标从 Web UI 存档原样内联（SVG 同源）** | extension/popup.css/popup.html | ✅ PASS（CDP 实测） | 令牌值/图标取自仓库内 `5f6ed241-….htm` 存档；`tools/visual-audit/` 用 headless Chrome+CDP 实测 14 项指标全部与 Web UI 存档组件一致（见 tools/visual-audit/README.md） |
| 6 | popup external 状态：接管按钮显示/隐藏、payload 取 status 的 pid/port、成功后刷新；非 adopt 动作的 `expected` 轮询语义保持 | extension/popup.js | ✅ PASS（静态） | `node --check` 通过 |

### 7.2 冒烟测试（场景 19）

| 断言要点 | 结果 |
|----------|------|
| status → external；adopt 错误 pid → EXTERNAL_UNMANAGED（双重匹配防接错） | ✅ PASS |
| adopt 正确 pid+port → running/managed（同一进程）；run 记录 adopted/profile/extraArgs（`--resume abc` 保留）正确 | ✅ PASS |
| 再 adopt → ALREADY_RUNNING（幂等） | ✅ PASS |
| restart 接管实例 → pid 变化、端口不变、adopted 血统延续；**二次 restart 仍按原 argv 重放（`--resume` 不被白名单拒绝）** | ✅ PASS |
| stop → stopped、记录清除；无外部实例时 adopt → EXTERNAL_UNMANAGED | ✅ PASS |

**合计：全量冒烟 PASS 70 / FAIL 0 / TOTAL 70（M1/M1.1 的 57 项断言全部保持通过，无回归）。**

### 7.3 沙箱限制与遗留

- 接管链路依赖 §6.6 发现结果，真实 powershell/netstat 枚举路径仍受沙箱 EPERM 限制，与 §6.3 同：接管/重启重放的完整生产链路按 manual-e2e.md 步骤 9 沙箱外验证（对 127.0.0.1:8080 的外部实例点「接管」后停止/重启）。
- popup 新视觉为静态核对（沙箱内无浏览器）；像素级效果需加载扩展后人工确认（manual-e2e.md 步骤 2-4）。

## 8. M1.3 鲸鱼图标 + 点击反馈/动效核验（2026-08-14 追加）

规格依据：`docs/design.md` §8.2.9/§8.2.10（点击反馈/动效与图标）+ §8.3.6（按动作区分兜底超时）。

### 8.1 静态交叉核对

| # | 核对项 | 实现位置 | 结论 | 备注 |
|---|--------|----------|------|------|
| 1 | 扩展图标 16/48/128 为鲸鱼图形（路径与 popup 内联 brand-logo 同源、`#0F1115` 透明底），文件尺寸精确 | extension/icons/*.png；tools/icons/whale.svg + _gen-icons.js | ✅ PASS（渲染实测） | headless Chrome 4x 超采样 + 盒式降采样生成；vision 工具逐张核验（鲸鱼完整、居中留白、16px 可辨）；PNG 头校验 16×16/48×48/128×128 |
| 2 | 点击反馈：`doAction` 乐观更新（全部生命周期按钮禁用 + 命中按钮 spinner/「…中」文案 + 不定进度条 + 阶段文案 + 已耗时每秒刷新）；ack 后 toast 确认（启动完成/已停止/重启完成/接管成功/失败原因）；`ALREADY_RUNNING`/`ALREADY_STOPPED` 幂等同样确认；restart 两阶段（停止旧进程 → 新进程启动中）；操作在途（ack 前）暂停轮询防 SW 队列堆积 | extension/popup.js | ✅ PASS（静态 + 渲染） | `node --check` 通过；vision_html_screenshot 渲染 busy-restart/busy-stop/toast 三态快照核验（进度面板、禁用按钮、绿色完成 toast 均正确） |
| 3 | 动效：按钮 `:active` 缩放（.96/.9）、spinner 旋转、不定进度条、面板/URL 行淡入、圆点颜色过渡、`:focus-visible` 焦点环、`prefers-reduced-motion: reduce` 全部关闭 | extension/popup.css | ✅ PASS（静态 + 渲染） | 同上；stopped/error 两态回归快照无重叠/回归 |
| 4 | SW 兜底超时按 action 区分：restart 120s / start 60s / stop·adopt 45s / 其余 30s；超时错误信息附实际秒数 | extension/background.js | ✅ PASS（静态） | `node --check` 通过；修复长 restart 被 30s 兜底误判 NATIVE_ERROR |
| 5 | manifest `icons` 引用不变，替换为鲸鱼图标文件 | extension/manifest.json | ✅ PASS | 16/48/128 文件存在、尺寸精确 |

### 8.2 沙箱限制与遗留

- 沙箱内 headless Chrome CDP 被拦截（mojo 命名管道拒绝访问），图标生成器 `_gen-icons.js` 需沙箱外或提权运行（本次为一次提权运行完成）；`--selftest` 纯 Node 自检在沙箱内通过。
- 按压/转圈/toast 的实际交互节奏需加载扩展后人工确认（manual-e2e.md 步骤 2-4）；真机验证建议：点击「重启」应看到按钮禁用+转圈+「正在重启：停止旧进程」进度，随后阶段切换与绿色完成 toast。

## 9. M2 核验 — dsh-lifecycle 插件 + 宿主优雅停机 + 点击反馈举一反三（2026-08-14 追加）

规格依据：`docs/design.md` §6.2/§6.3（M2 协议与动作）、§7（插件规格）、§8.2.6/§8.2.9（popup M2 UI 与点击反馈）；分工与契约见 `docs/m2-plan.md`（T1 popup / T2 插件 / T3 宿主，三方文件边界互斥，主代理统一集成）。

### 9.1 静态交叉核对

| # | 核对项 | 实现位置 | 结论 | 备注 |
|---|--------|----------|------|------|
| 1 | 协议契约：status result 增 `lifecycle`(boolean) + `health`(对象\|null)；stop result 增 `stopMethod`('graceful'\|'force')；其余动作结构不变 | host.js `buildResult`/`actionStatus`/`actionStop`；design §6.2 | ✅ PASS | 全部旧断言零回归 |
| 2 | `getHealth`：GET `/_lifecycle/health`，仅 200 + JSON 可解析 + ok:true 才返回对象，任何失败静默 null（含 >8KB 截断） | host.js `getHealth` | ✅ PASS | 与 httpDshProbe 同风格 |
| 3 | stopCore health-gate：端口在听 → 先探 health；可用才 POST shutdown + 3s 端口关闭（graceful）；不可用/超时 → taskkill（force）；starting（端口未开）直接 force；返回 {status, method} | host.js `stopCore` | ✅ PASS（冒烟 21/22） | PID 复用防护与锁逻辑未动 |
| 4 | 插件包：ESM/Cordis `export const name/inject/apply`；两条 exact 路由；回环 remoteAddress + Host 回环 + Origin 缺失/同源围栏（403），方法不符 405；shutdown 202 刷出后 setImmediate appExit(0)；disposer 统一释放 | plugin/dsh-lifecycle/index.js | ✅ PASS（node --test 18/18） | 405 判定顺序：围栏拒则 403 优先，围栏过但方法错才 405（与 §7.3 骨架一致） |
| 5 | **插件真实挂载机制（实测发现，超出原清单）**：`dsh plugin add` 是 pnpm 转发器；包必须声明 `dsh.bundle.patch` 且随包带 `cordis.patch.yml`（`- insert: [{id, name}]`）才会进 `dsh.profile.bundles` 真正挂载，否则只是普通依赖 | plugin/dsh-lifecycle/package.json + cordis.patch.yml；对照 dsh lib/plugin-9h8shc4d.js `reconcilePlugins` 与 dsh-headless 等官方 bundle 的 insert 行 | ✅ PASS（源码级核验） | insert 行 schema 与官方 bundle 完全一致；README 给出实测安装命令 `dsh plugin --profile web add ./plugin/dsh-lifecycle`（仓库根执行）与 cordis.patch.yml 手工挂载两法 |
| 6 | popup 点击反馈举一反三：手动刷新（转圈/防重入/pending 在途忽略）、设置无效输入红框+抖动+聚焦、复制失败 toast、状态漂移通知（去重） | extension/popup.js/css/html | ✅ PASS（静态 + 渲染） | `node --check` 通过；vision 渲染 stopped/m2-health/m2-noplugin 三态核验，状态行放大无重叠 |
| 7 | popup M2 UI：hint 按 lifecycle 切换；明细行 health 富状态（uptime 格式化 + nodeVersion）；stop toast 按 stopMethod 三态文案；字段缺失按 false/null 兜底 | extension/popup.js | ✅ PASS（静态 + 渲染） | 同上 |
| 8 | fake-dsh 生命周期端点 + `DSH_FAKE_NO_LIFECYCLE=1` 无插件变体；smoke 场景 20-23 覆盖富状态/graceful/force/restart 语义 | native-host/test/fake-dsh.js + smoke.js | ✅ PASS（冒烟） | 见 §9.2 |

### 9.2 冒烟与测试结果

- **宿主冒烟**：`node native-host/test/smoke.js` → **PASS 94 / FAIL 0 / SKIP 0 / TOTAL 94**（既有 70 项 + M2 新 24 项；场景 22 的 taskkill force 路径在本环境实测走通，未触发 SKIP 分支）。主代理独立复核两轮结果一致。
- **插件单测**：`node --test plugin\dsh-lifecycle\test\*.test.js` → **18 passed / 0 failed**（围栏 403/405、health 形状、appExit(0) 时序、disposer 清理、port 兜底）。
- **确定性修复（主代理）**：smoke `BASE_ENV` 默认注入 `DSH_MANAGER_FAKE_PROCESSES='[]'` 屏蔽真实进程枚举——本会话 danger-full-access 下真实 dsh web（127.0.0.1:8080）会让「空目录→stopped」场景误报 external；外部发现场景 15-19 以各自 extraEnv 覆盖，不受影响。此后套件在任何环境确定性通过。

### 9.3 沙箱限制与遗留

- **真机预检（2026-08-14 已跑通）**：插件已按「复制到 `.dsh\plugins` + 相对路径 link + `dsh plugin --profile web install`」挂载进本机 web profile（bundles 含 dsh-lifecycle）；临时实例 `dsh web --port 31930` 实测：health 200、`POST /_lifecycle/shutdown` 202 后 0.5s 端口关闭、进程退出码 0 —— 插件在真实 dsh 上可用。剩余真机项：用户在 popup 对 3080 实例点「重启」后观察「已优雅停止」toast 与 hint 变化（manual-e2e.md 步骤 12.2）。
- **发现并规避上游缺陷（pnpm Windows 跨盘符）**：仓库（D:\）与 profile（C:\）不同盘时，pnpm v10 把 `D:\...` 当相对路径处理（`link:` 坏 junction → reconcile 报 `declares no dsh.bundle`；`file:`/`file:///` → ENOENT），`dsh plugin --profile web add ./plugin/dsh-lifecycle` 跨盘不可用。规避：复制到 `.dsh\plugins` + `pnpm add link:..\..\plugins\dsh-lifecycle`（与 vision-toolkit 同模式）。已写入 plugin README 与 manual-e2e.md 步骤 12.1；后续可考虑向上游 dsh/pnpm 报告。
- popup 动态交互（转圈/抖动/漂移 toast 去重的实际节奏）需加载扩展人工确认；
- dsh-lifecycle 与真实 dsh webServer 的运行时配合已真机验证（见上）；多实例并发、`--port 0` 场景下 health.port 的 getter 行为以临时实例验证为准。

---

## 10. 开源前修复核验（2026-08-14 追加）

规格依据：开源前安全审查报告 `.review/native-host.md`（重要发现 1/2/3/4 与建议 8）。

### 变更记录

| # | 变更 | 位置 | 说明 |
|---|------|------|------|
| 1 | 测试钩子门控 | host.js `testMode()` + 各钩子读取点 | 所有 `DSH_MANAGER_*` / `DSH_BIN_STUB` 测试钩子仅在 `DSH_MANAGER_TEST_MODE === '1'` 时生效；生产（浏览器拉起、无该 env）完全忽略。smoke.js / smoke-real.js 已注入 `DSH_MANAGER_TEST_MODE: '1'` |
| 2 | adopt 重放黑名单 | host.js `filterAdoptedExtraArgs` + `actionRestart` | 接管重放的 extraArgs 拒绝 `--host`/`--trusted-host`/`--port`/`--profile` 及含 `..` 的 token，其余（如 `--resume abc`）放行；冒烟场景 19 新增断言 |
| 3 | install.ps1 JSON 转义 | install.ps1 `ConvertTo-JsonString` + 路径 `"` 预检 | `path` 字段规范 JSON 转义；host.cmd 与 .reg 统一 UTF-8 无 BOM 写入 |
| 4 | uninstall.ps1 PID 校验 | uninstall.ps1 第 1 步 | pid 强转 `[int]` 且 >0；`Get-CimInstance` 校验命令行含 dsh/bin.js 关键字，否则跳过强杀并告警 |
| 5 | readRunRecord 结构校验 | host.js `readRunRecord` | host 强制 127.0.0.1、port 1-65535、profile `^[A-Za-z0-9_-]+$`、extraArgs 字符串数组，非法字段丢弃 |
| 6 | 隐私去个人化 | 删除 `com.dsh.manager.reg`；文档本机用户名/`C:\Users\`/仓库绝对路径 → `<user>`/`<repo-root>` 占位 | .reg 由 install.ps1 现场重新生成 |

### DSH_MANAGER_TEST_MODE 门控

> 宿主所有测试/调试钩子（`DSH_MANAGER_BASE_DIR`、`DSH_BIN_STUB`、`DSH_MANAGER_NPM_PREFIX`、`DSH_MANAGER_PID_CHECK`、`DSH_MANAGER_PORT`、`DSH_MANAGER_HOST`、`DSH_MANAGER_FAKE_PROCESSES`、`DSH_MANAGER_FAKE_LISTENERS`）现**仅在 `DSH_MANAGER_TEST_MODE=1` 时生效**。生产路径（浏览器按注册表拉起宿主，无该 env）完全忽略钩子，杜绝 `DSH_BIN_STUB` 等本地代码执行旁路。任何依赖测试钩子的调试/冒烟运行都必须显式设置该开关。
