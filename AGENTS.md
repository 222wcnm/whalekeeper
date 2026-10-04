# AGENTS.md — Whalekeeper

浏览器扩展 + Native Messaging 宿主，管理 DeepSeek Harness（dsh）web 服务生命周期：
浏览器一键启动/停止/重启 `dsh web`（默认 http://127.0.0.1:3080），免开终端。

## 权威文档（改动前必读）

- `docs/design.md` — 设计规格索引；主题正文在 `docs/design/`：事实基线与上游变更台账
  （§2/§2.1）、宿主协议（§6）、扩展（§8）、安全模型（§12）、路线图（§15）。
  **dsh 版本跳变时先查 §2.1 台账，勿重复调查**
- `native-host/test/VERIFICATION.md` — M1 验收报告与已知偏差清单
- `native-host/test/manual-e2e.md` — 人工验证步骤
- `CHANGELOG.md` — 里程碑历史档案（Keep a Changelog，M13→M1 完整记录）

**约定：重大改动先改对应主题规格再改代码，新增主题须更新 `docs/design.md` 索引；扩展与宿主间的协议变更必须同步 §6.2 与两处
实现；改 host.js 必须补跑/新增 smoke 场景。**

## 目录

- `extension/` — Chrome MV3 扩展，原生 JS 零依赖：
  - `manifest.json` 含固定 key → 扩展 ID `dahcfklamlpgkngijomlnoclclfodkjm`
  - `background.js`（串行 native 调用 + 徽标）、`popup.*`、`logs.*`（M3 日志查看页）
  - `content/panel.js`（M3 页面内管理面板，content script + Shadow DOM）
  - `theme.js`（M6 主题引擎）、`colors.js`（M10 颜色角色）、`dsh-assets-library.js`
    （官方原生资产库）
- `native-host/` — `host.js` 零依赖 CJS 宿主（stdio 4 字节帧 + `--req/--res` 文件模式）；
  `install.ps1`/`uninstall.ps1`（Windows）；`install.sh`/`uninstall.sh`（Linux/macOS，
  M4，用户级 NativeMessagingHosts 清单）；`test/`（smoke.js、fake-dsh.js、smoke-real.js、
  e2e-m9-manager.js（M9 真实实例 e2e）、e2e-rc1-isolated.js（M13 真实 rc.1 隔离 e2e））
- `plugin/` — M2 起：dsh-lifecycle 插件（优雅停机 / 健康 / 会话摘要 / SSE 推送）
- `tools/` — 开发期工具：`visual-audit/`（视觉审计）、`icons/`（图标生成）、
  `verify-ui/`（扩展 UI 自动验收）、`ui-theme/`（主题提取与预览）、`linux/`（WSL 验证）
- `docs/` — 设计文档、接手说明

## 常用命令

```powershell
node --check native-host/host.js                     # 宿主语法检查
node native-host/test/smoke.js                       # 冒烟测试 32 场景（全模拟，无前置）
node native-host/test/smoke-real.js                  # 真实 dsh 集成（需 DSH_MANAGER_NPM_PREFIX=%APPDATA%\npm）
node native-host/test/e2e-m9-manager.js              # M9 真实实例 e2e（真实 profile 插件装配；需 danger-full-access）
node native-host/test/e2e-rc1-isolated.js            # M13 真实 rc.1 隔离 e2e（临时前缀；见下）
node native-host/test/e2e-current-isolated.js        # DSH_MANAGER_VERIFY_UI=1 时含浏览器
node --test "plugin\dsh-lifecycle\test\*.test.js"    # dsh-lifecycle 插件单测（69 项）
node --test native-host/test/readiness.test.js       # 就绪文件校验（4 项）
node --test native-host/test/stop.test.js            # 端口先关/PID 后退出与强制清理（3 项）
powershell -ExecutionPolicy Bypass -File native-host\install.ps1 -DryRun   # 安装预演（Windows）
sh native-host/install.sh --dry-run                                          # 安装预演（Linux/macOS）
powershell -ExecutionPolicy Bypass -File tools\linux\verify-linux.ps1 -E2E  # WSL Linux 冒烟 + 真实安装 E2E
node tools/verify-ui/verify-cdp.js                   # 扩展 UI 自动验收 108 断言
node tools/verify-ui/verify-ui.js --list             # MCP 路径诊断（chrome-devtools-mcp，需沙箱外）
```

- 扩展改动 → `chrome://extensions` 重新加载
- 宿主或安装器改动 → 重跑 `install.ps1`，并**完全重启浏览器**（native host 注册只在浏览器
  启动时读取）。`host.js` 本身被 `host.cmd` 直接引用，改动即生效，无需重装。

### 测试套件速览

| 测试 | 口径 | 运行前提 |
|---|---|---|
| `smoke.js` | 32 场景；Windows 412 PASS + 1 SKIP（场景 26 POSIX 专属） | 无（fake-dsh 全模拟；BASE_ENV 进程枚举围栏仅 Windows） |
| `smoke-real.js` | 真实 dsh 全链路（start→status→stop + `--port 0`） | `DSH_MANAGER_NPM_PREFIX=%APPDATA%\npm` |
| `e2e-m9-manager.js` | 7/7 | 真实 profile 插件装配；插件未升级时 SKIP；需 danger-full-access |
| `e2e-rc1-isolated.js` | 14/14 | 隔离 DSH_HOME + rc.1（缺省 `%TEMP%\dsh-rc1-prefix`，`DSH_MANAGER_NPM_PREFIX` 可覆盖）+ 本地插件方式 B |
| `e2e-current-isolated.js` | 26/26（含 UI）；dsh 0.2.0-rc.2 | 隔离 DSH_HOME + 官方 CLI 安装插件；`DSH_MANAGER_VERIFY_UI=1` 含浏览器；`DSH_MANAGER_NPM_PREFIX` 选 CLI 安装 |
| `lifecycle.test.js` + `readiness.test.js` + `stop.test.js` | 插件 69 项、宿主 7 项 | `node --test` |
| `verify-cdp.js` | 108 断言 | headless Chrome（沙箱拦 mojo 管道时需 danger-full-access 侧挂）；默认 dsh URL 3080（`VERIFY_DSH_URL` 覆盖） |

> **verify-cdp 覆盖（M13 起）**：真实 rc.1 实例认证引导（探测 401 → 读 run 记录
> launchUrl → token 兑换 cookie）；popup/logs/面板注入与展开；面板停止两步确认态；
> 日志页「加载更早/复制全部」；popup 设置校验；徽标 M8/M8.1/M12（分层 done「!」/
> waiting「?」/ 蓝 n 计数 / 9+ 边界 / 优先级 / SSE 合成帧：快照→徽标即时、SSE 活跃
> 0 端点轮询、upsert→「?」即时、removed→恢复、working→空→done「!」、时序回归）；
> 主题与深色（面板跟随、storage 镜像、四态 + Emulation 模拟、无新增 console 异常）；
> M7 状态卡；M9 会话区（四态/子代理/空态/降级）；M10 颜色角色（改色/恢复/撞色）；
> M11（仅新鲜完成、已读与 3s 撤销、retentionMins=0 恒显）；M13（openWebUI 有 launchUrl
> 用 launchUrl（深链 hash 保留）/无则回退裸 URL）；console 异常检查。

## 环境事实

- 2026-10-04 实测：Node **v24.19.0**；dsh **0.2.0-rc.2** 全局与源码安装，npm
  `latest` / `next` = rc.2、`alpha` = `0.2.1-alpha.1`；默认端口 3080。
  dsh 0.2.x 要求 Node 22.19+（22.x）或 24+。
- **上游 dsh 版本跟踪**：破坏性变更集中登记于 design §2.1 台账，版本跳变先查此表。
  **M13 二期已实现**：插件主动报告就绪/端口（§6.9），新鲜文件优先、HTTP 回退。
  当前配套插件为 0.4.1；本机已同步 5 个发行文件并保留 0.4.0 备份，现有服务未重启。
  下次启动加载新版本，profile 与宿主注册信息不变。
- 约束：**任何 dsh HTTP 探测一律不发 `Accept-Encoding`**（0.1.2 起 webserver 默认 gzip）
- 宿主安装位置 Windows `%LOCALAPPDATA%\dsh-manager\host\`（host.cmd 内是绝对路径，
  **项目移动必须重跑 install.ps1**）；注册表 HKCU：Chrome/Edge/Firefox 的
  `NativeMessagingHosts\com.dsh.manager`。Linux/macOS 为 `$XDG_CONFIG_HOME/dsh-manager`
  （或 `~/.config` / `~/Library/Application Support`），install.sh 写四份用户级浏览器
  清单（google-chrome/chromium/microsoft-edge/.mozilla），无需 sudo
- 宿主测试钩子（环境变量）：`DSH_MANAGER_BASE_DIR`、`DSH_BIN_STUB`、
  `DSH_MANAGER_NPM_PREFIX`、`DSH_MANAGER_PID_CHECK=0`、`DSH_MANAGER_FAKE_PROCESSES`
  （JSON `[{pid,cmdline}]`）、`DSH_MANAGER_FAKE_LISTENERS`（JSON `[{pid,addr,port}]`）；
  仅当 `DSH_MANAGER_TEST_MODE=1` 时生效

## 当前状态

- **0.2.x 兼容完成（2026-10-04，台账 §2.1.2）**：修复 NPX 重复 profile 和三种
  启动模式的 patch 参数顺序；插件 0.4.1 放宽至 `<0.3.0-0`，通过官方版本检查，
  优先使用 appReady 正式信号；stop 等 PID 与端口都退出，超时复核 PID 后强制清理，
  修复真实 Windows restart 的日志句柄竞争。验证：76 项单测、smoke 412 PASS /
  0 FAIL / 1 POSIX SKIP、真实 0.2.0-rc.2 隔离 E2E 26/26（含浏览器 108/108）。
  alpha.1 仅完成相关源码 diff 和版本范围核对，未运行 alpha 实例；macOS/Firefox
  最新版运行未实测。生产插件已备份后同步，用户自行选择日常实例的重启时机。

- **M13 一期完成（2026-09-04）**：上游 0.1.2 认证兼容（`httpProbe` 401 视为就绪、
  指纹端点 `/manifest.webmanifest`、启动日志捕获 `launchUrl` 含 token）+ 插件
  `Session.events` → `sessionEvents()` 三级回退适配 + peerDeps 范围修正
  `>=0.1.0-rc.6 <0.2.0-0`。验证：插件单测 52/52；smoke 372 PASS / FAIL 0 / SKIP 1；
  verify-cdp 107 PASS / FAIL 0；e2e-rc1-isolated 9/9；smoke-real 全链路 +
  e2e-m9-manager 7/7 真机回归。详见 CHANGELOG M13 条目与 design §2.1.1。
- **M13.1 子代理感知修复（2026-09-04，插件单测 58/58）**：`subagent/start|end` 只经
  事件总线发布、不写入父会话 session log（dsh 0.1.1-rc.2/0.1.2-rc.1 源码核验）——旧实现
  从会话事件流配对在真实环境恒空、popup 不显示子代理行。修复：插件订阅总线事件 +
  `header.parentSession` 维护活跃子代理索引（runId 配对权威），保留日志配对与 live 扫描
  兜底；徽标口径落实（`completed+hasActiveChildren` 计入蓝 n）。详见 CHANGELOG M13.1。
- **M13.2 popup 月亮主题 cube 边框修复（2026-09-06，verify-cdp 104 PASS / 4 FAIL
  环境干扰）**：深色令牌块游离选择器 `[data-theme="dark"]` 命中月亮按钮自身
  `data-theme="dark"`，整套深色令牌局部泄漏——浅色下月亮 cube 无边框 + 图标浅灰。
  修复：popup.css 两处选择器收窄为 `body[data-ds-dark-theme]`（规格值零改动）；
  verify-cdp 新增浅色未选中 cube 令牌一致断言（107→108）。遗留：design §8.7.5
  与 V6 实际数值（l1/8px/28px）漂移待决策。详见 CHANGELOG M13.2。
- **M13 二期完成（2026-09-21）**：插件 0.4.0 主动发布 starting/ready 文件，等待
  Loader 完成、2 秒续期、`ctx.effect` 清理；宿主按 launchId/启动时间/PID/10 秒租约校验，
  fs.watch 唤醒启动、从文件取 PID/动态端口/health，无有效文件时回退 HTTP。见 §6.9。
  验证：插件 66/66；`node --test native-host/test/readiness.test.js` 3/3；Windows
  smoke 30 场景 396 PASS / 0 FAIL / 1 SKIP；真实 rc.1 隔离 E2E 14/14。
  真实 E2E 禁用隔离 profile 自动开浏览器，避免桌面干扰和日志句柄影响连续启动。
- **本地源码模式与 SSH MCP（2026-09-23）**：本机 `D:\deepseek-harness` 为
  `0.1.6-alpha.1`，须先在 clone 中执行 `pnpm install --frozen-lockfile` 与
  `pnpm run build`；未构建时缺 `lib/index.js`。用户选择仅在 source 启动时用宿主生成的
  `run/source-no-ssh.patch.yml` 禁用 profile 的 `mcp-ssh`，不改真实 profile，global/NPX
  模式保持原行为。真实 profile 原样启动约 82s，禁用该项约 19s；隔离 source + 插件 E2E
  start/status/stop 全过。Windows smoke 更新为 31 场景 400 PASS / 0 FAIL / 1 SKIP。
- **已知遗留**：
  - 外部实例（无 run 记录 token）打开 Web UI 仍会 401（回退裸 URL；上游安全模型
    固有限制，design 已标注）
  - verify-cdp 主题段有多处固定 sleep 与「SW 不在线即失败」判定（潜在 flaky 源，
    待改 waitFor 轮询 + SW 离线 SKIP）
  - 插件安装须走「复制到 `.dsh\plugins` + 相对 link」方式（pnpm Windows 跨盘符缺陷，
    见 plugin/README 与 manual-e2e.md 步骤 12.1）
  - `install.ps1`/`uninstall.ps1` 为 UTF-8 **带 BOM**（Windows PowerShell 5.1 解析中文
    需要，编辑工具改写后必须补回 BOM）
  - Firefox 运行时行为未实测（本机无 Firefox）；macOS 平台层已实现未实测（无设备）
  - 接管（adopt）生产路径未自动实测（会写 run 记录并获停真实实例能力，按
    manual-e2e.md 步骤 9 用一次性实例沙箱外验证）

## 里程碑档案

> 完整历史见 `CHANGELOG.md`（Keep a Changelog）；设计细节见 `docs/design.md` 对应章节。
> 以下一行摘要供快速回顾。

- **M13**（2026-09-04）：上游 0.1.2 认证兼容 + 插件 Session.events 适配
  —— CHANGELOG、design §2.1.1/§6.2/§8.10/§12.3/§15.2
- **M12 / M12.1 / M12.2**（2026-08-26）：SSE 会话推送（`/_manager/events`，快照+增量
  diff+心跳）+ plan-review 等待判定补正 + SSE 帧接收修复 —— CHANGELOG、
  design §8.10.1、`docs/sse-push-research.md`
- **M11 / M11.1**（2026-08-25）：会话感知升级（四态/已读撤销/保留时长/子代理折叠/
  归档过滤）+ popup V6 侧边 Rail 空间架构（380×270 锁定）—— CHANGELOG、
  design §8.2/§8.10
- **M10 / M10.1**（2026-08-24）：颜色语义自定义「颜色角色」（三态三色定稿：
  进行中蓝/待确认黄/完成绿；idle 不渲染）—— CHANGELOG、design §8.12
- **M9**（2026-08-23）：扩展面板会话状态（插件只读端点 + 宿主 sessions 动作 + popup
  会话区；行纯展示防误导）—— CHANGELOG、design §8.10
- **M8 / M8.1**（2026-08-22）：徽标提醒「该点回来看看了」+ 双载体分层语义
  （图标角标=实例层；字符徽标=会话层：紫?/琥珀!/蓝 n）—— CHANGELOG、
  design §8.9/§8.9.1
- **M7**（2026-08-22）：popup 排版优化（方案 A：应用栏+状态卡+分组设置）+ 动效体系
  修复重设计 —— CHANGELOG、design §8.8
- **M6**（2026-08-22）：主题与深色模式（四态模型、深色令牌、webui 镜像）——
  CHANGELOG、design §8.7
- **M5.5**（2026-08-15）：Windows 隐藏控制台载体（launch-hidden.vbs + wscript
  SW_HIDE）—— CHANGELOG、design §6.3 第 5 步
- **M4**（2026-08-14）：`--port 0` 动态端口 + Firefox 宿主注册 + Linux 实测
  （Kali WSL 337/337 + 安装器 E2E 15/15）—— CHANGELOG、design §6.8
- **M3 / M3.1**（2026-08-14/16）：日志查看页 + 页面内管理面板 + 面板体验修复 ——
  CHANGELOG、design §8.4/§8.6
- **M2**（2026-08-13）：dsh-lifecycle 插件（优雅停机/健康端点，实测挂载机制修正）
  —— CHANGELOG、design §7
- **M1 / M1.1 / M1.2 / M1.3**：MVP + 外部实例检测/接管 + 鲸鱼图标与点击反馈动效 ——
  CHANGELOG、VERIFICATION.md
