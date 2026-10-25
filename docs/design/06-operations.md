# 流程、安装、安全与验收

[返回设计规格索引](../design.md) · 原规格 §9–14

---

## 9. 关键流程时序

### 9.1 一键启动（核心体验）

> **本节示意以 §6.3 当前契约为准**：宿主 start 先等待就绪再应答 `running`（或错误），并非 spawn 即返回 starting。端口发现与就绪从 spawn 起共享 150s，URL 捕获额外最多 5s；SW start 210s / restart 240s 等待完整应答。Popup 应答前乐观展示 starting，随后 2s 轮询收敛。

```
Popup                     Background SW                Native Host                 dsh
  │  点击「启动」              │                            │                        │
  ├─sendMessage(start)──────▶│                            │                        │
  │                          ├─connectNative()───────────▶│                        │
  │                          │   {action:"start"}          │                        │
  │                          │                            ├─ 抢锁/解析/校验         │
  │                          │                            ├─spawn(detached)────────▶│ 开始加载
  │                          │                            │   写 run 记录 + 日志    │
  │                          │                            ├─ 共享就绪（≤150s；      │
  │                          │                            │   --port 0 先发现端口） │
  │                          │◀─ {ok, state:"running"} ────┤◀─ GET / 200 ───────────┤
  │◀─sendResponse(running)───│                            │                        │
  │  green 状态 + tabs.create("http://127.0.0.1:3080")     │                        │
```

要点：SW 不等待超时兜底之外的轮询——轮询编排权在宿主；popup 在应答前以乐观反馈展示 `starting`（按钮转圈 + 进度条），应答后应用终态并由 2s 轮询收敛（popup 关闭也无碍——下次打开重新 status）。

### 9.2 停止

```
Popup ──▶ SW ──▶ Host {action:"stop"}
                    ├─ (M2 插件存在) POST /_lifecycle/shutdown → dsh 官方 dispose 后退出
                    │      └─ 轮询端口关闭（≤10s）
                    ├─ (v1/回退) taskkill /PID <pid> /T /F
                    ├─ 轮询端口关闭（≤10s）
                    └─ 清理 run 记录
Popup ◀── {state:"stopped"}
```

### 9.3 宿主突然死亡 / SW 被回收

- 宿主死亡 → dsh 不受影响（detached + 独立日志 fd）。
- SW 被回收 → 连接断开 → 宿主收到 stdin EOF 正常退出（应答已发或丢弃无妨，动作幂等）。
- 两者都无需恢复逻辑：状态在文件与端口上，下次 status 自动收敛。

---

## 10. 安装与注册（install.ps1 / uninstall.ps1 / install.sh / uninstall.sh）

### 10.1 install.ps1 流程（Windows）

1. 参数：`-ExtensionId <id>`（可省略；省略时从 `extension/manifest.json` 的 `key` 自动计算，见 §10.2）。
2. 检查 Node（`node -v`）与 dsh（`dsh --version`），缺失则给出安装指引并中止。
3. 创建 `%LOCALAPPDATA%\dsh-manager\{host,run,logs}`。
4. 生成 `host.cmd`（写死本机 node.exe 与 host.js 绝对路径）与 `com.dsh.manager.json`（注入扩展 ID 与 Firefox gecko id，M4）。
5. 写注册表：Chrome + Edge + Firefox 三条（HKCU，失败时提示手动导入 `.reg` 文件，安装器同时导出 `com.dsh.manager.reg` 备用）。
6. 打印验收指引：「打开扩展 popup，应显示 stopped 而非 HOST_NOT_INSTALLED」。
7. （可选）安装生命周期插件：见 `plugin/dsh-lifecycle/README.md`（本地包安装或 cordis.patch.yml 挂载）；未安装时宿主自动降级强停，功能不受影响。

### 10.1a install.sh 流程（Linux / macOS，M4）

与 install.ps1 同构，注册方式为写用户级 NativeMessagingHosts 清单文件（无需 sudo）：

1. 参数：`--extension-id <id>`（缺省自动计算）、`--dry-run`（预演）。
2. 前置检查 node 与 dsh（`command -v`，仅存在性）。
3. 创建状态根目录（Linux `$XDG_CONFIG_HOME/dsh-manager` 或 `~/.config/dsh-manager`；macOS `~/Library/Application Support/dsh-manager`）下 `{host,run,logs}`。
4. 生成 `host.sh`（`#!/bin/sh` + `exec "node" "host.js" "$@"`，写死绝对路径、chmod +x）与 `com.dsh.manager.json`（JSON 转义由 node 完成；allowed_extensions 同含 Chrome ID 与 gecko id）。
5. 写入四份浏览器注册（幂等）：
   - `~/.config/google-chrome/NativeMessagingHosts/com.dsh.manager.json`
   - `~/.config/chromium/NativeMessagingHosts/com.dsh.manager.json`
   - `~/.config/microsoft-edge/NativeMessagingHosts/com.dsh.manager.json`
   - `~/.mozilla/native-messaging-hosts/com.dsh.manager.json`（Firefox）
6. 打印验收指引（同 Windows）。

uninstall.sh 与 uninstall.ps1 同构：宿主 stop 动作（复用全套防护链）→ 删四份浏览器注册 → `--keep-logs` 可选备份 → 删状态目录。

**验证状态**：install.sh/uninstall.sh 在 Kali WSL2 **真实安装 E2E 实测通过**（tools/linux/run-e2e-linux.sh：npm i -g 真实 dsh → 安装 → 清单断言 → 经已安装 host.sh 拉起真实 dsh web start/status/指纹/stop → 卸载清理；2026-08-14）。macOS 同脚本复用（`uname -s` 分支），未实测。

### 10.2 固定扩展 ID

开发期（unpacked）扩展 ID 由 manifest 的 `key` 字段决定；不固定 key 则 ID 随绝对路径变化，宿主 manifest 会失效。初始化时生成一次并永久保留：

```js
// 一次性执行（node -e），输出 manifest "key" 与对应扩展 ID
const crypto = require('crypto');
const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = publicKey.export({ type: 'spki', format: 'der' });
const key = der.toString('base64');
const hash = crypto.createHash('sha256').update(der).digest().subarray(0, 16);
const id = Array.from(hash, b =>
  String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join('');
console.log(JSON.stringify({ key, id }, null, 2));
```

生成的 `key` 写入 manifest，`id` 写入宿主 manifest 的 `allowed_origins`。项目仓库提交 key（不是机密，仅为稳定 ID）。

### 10.3 uninstall.ps1

1. 若 run 记录存在 → 执行 stop。
2. 删除注册表项（Chrome/Edge）。
3. 删除 `%LOCALAPPDATA%\dsh-manager\`（保留日志可选，默认备份 logs 到桌面后删除）。
4. （M2）`dsh plugin --profile web remove dsh-lifecycle`（可选，询问）。

---

## 11. 目录规划（仓库 `<repo-root>`）

```
dsh-manager/
├─ AGENTS.md / README.md / CHANGELOG.md / CHROMEWEBSTORE.md / CONTRIBUTING.md
├─ docs/
│  ├─ design.md                  # 设计规格索引
│  ├─ design/                    # 按主题拆分的规格正文（§1–17）
│  └─ publish.md / upstream-feedback.md / open-source-review.md …
├─ extension/                    # 浏览器扩展（可直接「加载已解压的扩展程序」）
│  ├─ manifest.json
│  ├─ background.js / popup.html / popup.css / popup.js
│  ├─ logs.html / logs.css / logs.js      # M3 日志查看页
│  ├─ content/
│  │  └─ panel.js                 # M3 页面内管理面板（content script，样式内联 + Shadow DOM）
│  ├─ scripts/keygen.js           # 扩展 ID 密钥生成工具
│  └─ icons/{16,48,128}.png
├─ native-host/
│  ├─ host.js                    # 宿主主程序（零依赖）
│  ├─ host.cmd.template / com.dsh.manager.json.template
│  ├─ compute-id.js              # 扩展 ID 计算工具
│  ├─ install.ps1 / uninstall.ps1        # Windows 安装/卸载器
│  ├─ install.sh / uninstall.sh          # Linux/macOS 安装/卸载器（M4）
│  └─ test/
│     ├─ smoke.js                # 宿主冒烟 27 场景（--req/--res 文件模式，见 §14）
│     ├─ smoke-real.js           # 真实 dsh 集成（best-effort，隔离 DSH_HOME）
│     ├─ fake-dsh.js             # 伪 dsh bin（冒烟用，支持 --port 0 / lifecycle 端点）
│     └─ manual-e2e.md / VERIFICATION.md
├─ plugin/dsh-lifecycle/         # M2 生命周期插件（独立 npm 包，dsh 侧）
├─ tools/                        # 开发期工具
│  ├─ icons/                     # 鲸鱼图标生成（headless Chrome 渲染）
│  ├─ linux/                     # WSL Linux 冒烟/E2E 验证脚本
│  ├─ publish/                   # 发布副本构建（robocopy /MIR + tar 中转）
│  ├─ verify-ui/                 # 扩展 UI 自动验收（CDP / MCP 两路径）
│  └─ visual-audit/              # 视觉审计
└─ …                             # LICENSE / NOTICE / SECURITY.md 等
```

---

## 12. 安全设计

### 12.1 攻击面收敛（宿主侧）

- **action 白名单**：仅 `ping|status|start|stop|restart`，任何其他输入拒绝。
- **参数白名单**：`extraArgs` 仅允许通过正则校验的有限集合（例如 `--patch <绝对路径>`、`--dump-config` 类无害项）；**明确禁止** `--host 0.0.0.0`（F3 本就拒绝，宿主再拦一道）、`--trusted-host`（v1）。
- 宿主拒绝执行任何 shell 字符串拼接命令（无 `exec()`、无 `shell: true` 主路径）；taskkill 参数仅由 run 记录中的数字 PID 构成。
- **外部实例发现只读**（§6.6）：仅执行本机只读命令（进程枚举、netstat 端口表）与回环 GET 探测；外部实例绝不写入 run 记录、绝不纳入 stop/restart 的 taskkill 目标（`EXTERNAL_UNMANAGED`）。
- **接管（adopt）边界**（§6.7）：仅当 pid+port 双重命中发现结果且进程仍为 dsh 时才回写 run 记录；接管实例的 restart 重放参数取自本机进程表（用户自己的命令行），**扩展消息输入的 extraArgs 仍严格白名单**——两条输入通道不可混淆。
- **PID 复用防护**：stop/status 对 pid 做命令行校验（§6.3），防误杀无关进程。
- 宿主 manifest 的 `allowed_origins` 仅含本项目固定 ID：其他扩展（甚至同一浏览器其他 profile）无法调用本宿主。
- 消息长度上限校验（读帧 > 1MB 直接断开）。
- **测试钩子门控**：所有 `DSH_MANAGER_*` 测试钩子环境变量（`DSH_MANAGER_BASE_DIR`、`DSH_BIN_STUB`、`DSH_MANAGER_NPM_PREFIX`、`DSH_MANAGER_PID_CHECK`、`DSH_MANAGER_FAKE_PROCESSES`、`DSH_MANAGER_FAKE_LISTENERS` 等）**仅当 `DSH_MANAGER_TEST_MODE=1` 时生效**；发行构建不启用这些钩子。
- §6.9 三个就绪环境变量属于生产进程间协议，不是测试钩子：由宿主覆盖后传给子进程，宿主不从外部环境或扩展 payload 接受就绪文件路径。

### 12.2 遵守 dsh 自身的安全模型

**2026-10-18 修复补充（优先于下列旧 DOM 回退描述）**：无可靠摘要时不扫描全页
StateDot 推导精确状态；仅实例管理可用。Popup 可用内部消息询问 content script 的同源
首页认证状态（HTTP 响应码与有效端口），不读响应正文、消息、cookie 或凭据，不传 token。
认证状态未知时有合法启动 URL 则新开页面，不改原标签；不能把标签存在当成已认证。
实际请求预算按 §6.3，150 秒未就绪才报 START_TIMEOUT，不再沿用历史 30 秒文案。

### 12.2.1 既有围栏

- 不调用 `/api`（Origin 围栏，F9）；探活只用 `GET /`。
- 生命周期插件端点（§7）必须自我设限：仅回环连接 + Origin 缺失或同源，**绝不注册为公开 RPC**；「扩展 → 宿主 → HTTP」链路因宿主请求无 Origin 而天然合规，扩展直连则被拒。
- 扩展 host_permissions 仅回环；不申请任何超出需求的权限。
- **页面内面板（§8.6）**：content script 只注入 dsh 指纹页面（127.0.0.1/localhost 任意端口）；面板对页面的唯一写操作是追加自身 shadow 节点，不读取/修改页面 DOM 与数据；停止/重启经 SW → 宿主全套防护（PID 校验、外部实例保护、锁），面板不持有任何特权 API（无 `/_lifecycle` 直连、无宿主角色的独立判定）。**例外（M8，§8.9；2026-08-24 扩为端点摘要；2026-08-26 M12 扩为 SSE 事件流）**：徽标提醒段优先**同源只读** `GET /_manager/sessions`（§8.10 摘要元数据：sessionId/标题/四态/时间戳，**不读消息体/事件内容/凭据**；仅同源回环请求）；M12 起同级**同源只读** `GET /_manager/events`（SSE，§8.10.1：snapshot/upsert/removed 帧**仅携带与 `/_manager/sessions` 完全同构的摘要元数据**，无任何消息内容/文本）为优先数据源、端点快照为其回退；端点不可用时不采集页面图标猜测会话状态，只保留实例管理；上报 SW 仅为两值枚举 `done|waiting` + 计数（M12 起增加 `sessions-sync` 摘要 items 镜像——仍为 §8.10 同构摘要，扩展内部 storage 中转，popup 侧经 `storage.onChanged` 消费；popup/SW 直连端点仍被 Origin 围栏拒绝，不构成例外扩大）。

### 12.3 数据与凭据

- 扩展不读取、不存储 `$DSH_HOME` 下的凭据文件（`.credentials.yaml`）；状态展示仅含 pid/端口/时长/版本/健康字段。
- run 记录与日志落在 `%LOCALAPPDATA%`，仅本用户可读；日志中可能出现工作区路径，属于本机用户自身信息。
- **M9 会话元数据边界（2026-08-23）**：`/_manager/sessions` 端点只出**只读摘要元数据**（sessionId/title/state/updatedAt/blank/cwd）——title 取自 `session/title` 事件（已归一化），state 由事件流判定（`approval/asked`↔`decided`、`tool/call`(ask_user_question)↔`tool/result` 配对）；**不读消息体/事件内容/凭据**；扩展侧渲染仅用摘要，会话行只读，无伪深链，统一入口打开 Web UI。§12.2 的「不调用 /api、不读页面内容」范围不变。
- **M12 推送边界（2026-08-26）**：`/_manager/events`（SSE）帧与 `/_manager/sessions` 完全同构（同上摘要字段，无消息内容/文本）；popup 镜像桥（`storage.local.sessionsCache`）只存该摘要 items（≤50 条/端口），**不存储/转发事件正文、工具结果、附件、凭据**；插件侧事件订阅仅用于派生摘要状态（`summarizeSession` 同款判定），任何事件内容都不进入推送/存储面。
- **M13 launchUrl/token 边界（2026-09-04，2026-10-18 澄清）**：dsh ≥ 0.1.2 的首页需 token/cookie。宿主从本次启动日志捕获完整启动 URL，存本用户 run 记录，经 native 临时返回 Popup 用于导航；不写 storage，不显示到 UI，不进入摘要/SSE/认证状态查询，不随 adopt 跨实例复制。导航前校验 HTTP 回环、实际端口、根路径和无用户密码。token 只在浏览器导航认证请求中使用（不能误写为“不进入任何网络请求”）；raw dsh 启动日志与 run 记录属于其原有本机信任域，宿主诊断日志、测试报告和控制台输出须脱敏。

---

## 13. 错误处理与边界情况

| 场景 | 行为 |
|------|------|
| dsh 未安装 / npm 全局路径变化 | `DSH_NOT_FOUND`，popup 给出安装命令；ping 可诊断路径解析链 |
| 端口被其他程序占用 | `PORT_BUSY`，建议换端口（设置面板） |
| 从 spawn 起 150s 未就绪 | `START_TIMEOUT` + 脱敏日志尾部及阶段/耗时；进程保留，用户可看日志决定 |
| 旧版本 dsh（缺 `--port` 等） | start 前 `dsh --version` 校验最低版本（v1 定为 0.1.0-rc.x 基线） |
| run 记录指向已死 PID（上次崩溃残留） | status 自动清理；stop 幂等 |
| 快速连点启动 ×N | 锁 + `ALREADY_RUNNING` 幂等 |
| SW 回收 / popup 中途关闭 | 无状态收敛（§9.3） |
| 宿主被 Chrome 以旧版本缓存 | 提示「重启浏览器」；安装器写入的 manifest 变化需重启浏览器生效（Chrome 平台行为） |
| 用户名/路径含空格或中文 | 全部 spawn 走数组参数（非 shell 拼接），路径引号由宿主统一处理 |
| `--port 0`（用户配置动态端口） | **M4 已支持**（本扩展启动场景）：spawn 后从日志 URL 行回填实际端口（§6.3 start 第 9 步）；外部实例的 `--port 0` 经 netstat 按 PID 解析（§6.6） |
| 用户手工运行了 dsh web（无 run 记录） | status 外部实例发现（§6.6）→ `external`：展示真实端口/URL、可打开 UI；stop/restart 返回 `EXTERNAL_UNMANAGED`，不误杀 |
| 外部实例使用 `--port 0` | netstat 按 PID 解析实际监听端口后再指纹探测（§6.6 第 4 步） |
| 发现命令不可用（PowerShell/WMI 受限、netstat 缺失、EPERM） | 静默降级：按无外部实例处理（stopped），绝不影响 start/stop 主流程 |
| 非 dsh 服务监听端口（误报面） | 指纹探测（`GET /manifest.webmanifest` 含 DeepSeek Harness，§6.6 第 5 步）不通过 → 不报告 external |
| 同时存在多个外部 dsh web | 报告首个实例 + `externalCount`；接管其一后 managed 优先，其余实例待该实例停止后再次发现（§6.7） |
| adopt 目标已退出 / pid 复用 / 端口漂移 | pid+port 双重匹配不命中 → `EXTERNAL_UNMANAGED`，绝不硬写记录 |
| adopt 后 stop/restart | 标准 managed 路径（优雅→taskkill）；重启按原 argv 归一化重放，`--port 0` 重放为实际端口 |
| 接管实例命令行含 `--trusted-host` 等非常规参数 | restart 原样重放（参数源自本机进程表，非扩展输入，§6.7） |
| 生命周期插件未安装 / 版本过旧 | 高概率（M1/未装用户） | stop 自动降级 taskkill（预期路径）；popup 一次性提示安装指引（§8.2.6） |
| 优雅路径 10s 未关端口（插件挂起） | 回退 taskkill 强制路径，不悬挂（§6.3 stop） |

---

## 14. 测试计划

### 14.1 宿主冒烟（不依赖浏览器）

**2026-10-19 rc.2 增量实测**：33 场景 Windows **428 PASS / 0 FAIL / 1 POSIX SKIP**；
插件 87、宿主 29、扩展 62 共 **178/178 单测**，0 SKIP。新回归覆盖共享 150s
截止、STDIO 在途跨 15s、health 重试、迟关端口、lease 所有权与清理、真实 Cordis
重挂与 SSE 一致性、扩展退避及安全入口；下面的 27/21 等数字是历史基线。

`test/smoke.js`（27 场景，2026-08-15 计数：Windows 347 PASS + 1 SKIP / Linux 337 PASS + 1 SKIP——场景 26 POSIX 专属、场景 27 载体为 Windows 专属）：以 `--req/--res` 文件模式逐请求
拉起 `node host.js`（沙箱管道受限环境兼容），伪 dsh 由 `DSH_BIN_STUB` 指向
`test/fake-dsh.js`（含 lifecycle 端点、`--port 0`、退出立即/不打印 URL 变体），
状态目录隔离在工作区 `.smoke`，`BASE_ENV` 围栏真实进程枚举**仅 Windows 生效**（本机常驻真实 dsh web 会干扰「空目录→stopped」场景）。覆盖：ping/status
/start/stop/restart/adopt 主链路与幂等、端口占用、参数校验、锁竞争、残留清理、
START_TIMEOUT、优雅停与 force 降级、外部实例发现/接管、M2 富状态、M3 logs 分页
（行边界对齐 + 定宽行逐字节重建）、M4 `--port 0`（回填/重放/校验/超时/占位期展示）、
gecko id 与宿主模板静态断言；**场景 26（仅 POSIX）不注入任何 fake 钩子**：真实 /proc 枚举 +
/proc/net/tcp 端口表 + /proc PID 校验 + 指纹探测发现/接管/停止外部实例全链路（Windows 记 SKIP，其平台路径由 smoke-real 与生产实测覆盖）。

`test/smoke-real.js`（真实 dsh 集成，best-effort）：真实 bin.js + 隔离 DSH_HOME，
start/status/stop 全链路、`--port 0` 真机回填、外部发现生产路径（真实
powershell/netstat，只读，不接管不停止）与 `EXTERNAL_UNMANAGED` 保护。

扩展 UI：`tools/verify-ui/verify-cdp.js`（零依赖 CDP，沙箱内可用；断言数随里程碑递增，
M7 口径 63、M8 新增 5 条徽标提醒断言）——
扩展加载、popup/logs 截图与文本断言、页面内面板注入/展开/停止两步确认态、日志页
「加载更早/复制全部」交互、popup 设置校验交互、徽标三步实测、M6 主题/深色断言、
M7 状态卡断言、M8 徽标提醒分层渲染（done/waiting/清空恢复）与端到端（后台页注入等待
标记 → 红「?」→ 切回标签自动清除）、console 异常检查。

插件：`plugin/dsh-lifecycle/test/*.test.js` 单测（21 项）。

### 14.2 集成/E2E（真实 dsh）

1. 安装器一键安装 → 注册表三项（Chrome/Edge/Firefox）存在、宿主 manifest 的 allowed_origins/allowed_extensions 与扩展 ID、gecko id 一致。
2. 加载 unpacked 扩展 → popup 显示 stopped（非 HOST_NOT_INSTALLED）。
3. Start → 徽标变绿 → 自动打开 `http://127.0.0.1:3080` → 页面可交互。
4. **宿主死亡实验**：启动后 taskkill 掉宿主进程 → dsh 仍在运行 → popup status 仍为 running。
5. **SW 回收实验**：`chrome://serviceworker-internals` 手动 stop SW → dsh 不受影响 → 再次打开 popup 状态正确。
6. Stop → 进程树消失（`Get-Process node` 无残留 bin.js）→ 端口关闭 → popup 灰点。
7. Restart → 旧会话在 Web UI 中仍可继续（会话持久化 F8 验证）。
8. 异常矩阵：端口占用 / 假 DSH_HOME / 无 Node / 快速连点 / 开机后首次使用。
9. （M2）安装 dsh-lifecycle 后：stop 走优雅路径（无 taskkill 调用、会话无损）；health 返回 200 且字段正确；卸载插件后回归 M1 路径无退化。
10. （M3）打开任意 dsh Web UI 页面 → 右下角出现页面内管理面板（§8.6）：状态徽章随 status 轮询更新；展开后「停止」两步确认、「重启」走宿主语义；非 dsh 的本地页面不注入。verify-cdp.js 已自动覆盖「注入 + 渲染 + 状态文本 + 展开 + 两步确认态（首击确认/3s 还原）」。

### 14.3 验收标准（MVP 历史体验目标）

本节 ≤15s 和 20 次属于早期体验/耐久目标，不代表 rc.2 已实测或硬超时；本轮正式门槛
为 §2.1.3 的三轮固定/动态端口与至少一次真实浏览器恢复，就绪实际预算按 §6.3。

- 安装 ≤ 2 分钟（跑一个脚本 + 浏览器加载目录）。
- Start 点击到 Web UI 打开 ≤ 15s（含 dsh 冷启动）。
- Stop/Start 各 20 次无僵尸进程、无残留 run 记录、无锁死。
- dsh 停止时，系统内无本项目任何驻留进程。

---
