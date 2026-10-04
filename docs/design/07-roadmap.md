# 路线图、风险与参考

[返回设计规格索引](../design.md) · 原规格 §15–17

---

## 15. 分阶段路线图

| 阶段 | 内容 | 验收 |
|------|------|------|
| **M1 MVP**（本文档范围） | 扩展（popup+SW）、宿主（status/start/stop）、安装/卸载器、冒烟测试 | §14.3 全过 |
| **M1.1 外部实例检测**（§6.6） | status 发现非本扩展启动的 dsh web 及其端口（进程扫描 + netstat + HTTP 指纹），`external` 状态仅展示与打开 UI；`EXTERNAL_UNMANAGED` 保护 | smoke 场景 15-18 通过 |
| **M1.2 外部实例接管**（§6.7） | adopt 动作：pid+port 双重匹配回写 run 记录，接管后 stop/restart 可用、重启按原 argv 重放；popup「接管」按钮；popup UI 对齐 dsh Web UI 设计令牌 | smoke 场景 19 通过 |
| **M2 生命周期插件** | `dsh-lifecycle`（shutdown + health）；宿主 stop/restart 优雅链；popup 富状态与插件安装提示 | stop 走优雅路径、全程无 taskkill、会话无损；health 200 且字段正确（§14.2.9） |
| **M3 体验增强** | restart 按钮、日志查看与复制、启动后自动开 UI 开关、徽标周期刷新（alarms）；Web UI 页面内管理面板（页面内停止/重启） | 完成（2026-08-14：`logs` 动作与日志查看页 §6.3/§8.4 + 页面内管理面板 §8.6（content script 方案，替代 dsh client 插件：外部插件无独立构建路径，见 §8.6 决策）；smoke 场景 24 + verify-cdp 自动验收） |
| **M4 跨平台/跨浏览器** | macOS/Linux（SIGTERM 优雅路径、`~/.config` 状态目录、`kill` 代替 taskkill）；Firefox（`allowed_extensions` 已预留）；`--port 0` 端口发现 | 进行中：`--port 0` 已支持并对真实 dsh 实测通过（2026-08-14，§6.3 start 第 9 步 + smoke 场景 25 + smoke-real 扩展段）；Firefox Windows 宿主注册与 gecko id 已就绪（install/uninstall 含 Mozilla 注册表项，扩展运行时未实测）；**Linux 已实测通过（Kali WSL2，smoke 场景 26 真实 /proc 路径）**；macOS 与 Firefox 运行时待实测——**暂缓**（无对应设备，2026-08-14 用户决定） |
| **M5（可选）上游贡献** | 向 deepseek-harness 提 `dsh server start/stop/status` 子命令或官方 lifecycle 插件 PR，本项目宿主改为优先调用官方面 | 上游采纳或明确拒绝 |
| **M5.5 Windows 隐藏控制台载体**（2026-08-15 完成） | 消除 dsh 命令执行闪窗：wscript + `Run(cmd,0,False)` 隐藏控制台载体启动 + 端口表 PID 反查 + cmd 日志重定向（§6.3 第 5 步） | smoke 场景 27（Windows）通过；窗口实测：控制台存在但不可见、子进程零新窗口 |
| **M6 主题与深色模式**（§8.7） | 四态主题模型（follow-webui / follow-system / light / dark）+ 深色令牌内联（popup/logs）+ 外观行设置 + panel.js 镜像 → popup 实时跟随 webui 深浅切换 | verify-cdp 深色断言全过（§8.7.7）；浅/深截图与 webui 对照；`.btn.primary` 深色白底深字实测核对 |
| **M7 popup 排版优化**（§8.8，方案 A） | 应用栏 + 状态卡 + 分组设置三区结构；busy 态复刻 webui Matrix 点阵动效（三处统一）；错误态红调卡片 | 先跑 verify-cdp 50 基线 → 实施 → 全量 + 深色截图 vision 核验（§8.8 实施清单） |
| **M8 徽标提醒「该点回来看看了」**（§8.9） | dsh 页面后台时监视会话状态标记（工作完成/等待用户）→ 徽标「!」琥珀 /「?」紫；页面可见或标签关闭自动清除；`settings.attention` 开关 | verify-cdp 断言（SW 分层渲染 + 真实页面 e2e 注入等待标记 → 徽标「?」→ 切回标签自动清除）；`node --check` 全过 |
| **M9 扩展面板会话状态**（§8.10，路径 3） | dsh 配套插件新增只读端点 `/_manager/sessions`（lifecycle 同款围栏）→ 宿主 `sessions` 动作 → popup「会话」区（标题 + 状态圆点色表，只读不读内容）；降级提示 | **完成（2026-08-23）**：M9.1 spike（signal 全部 host 侧可读）→ M9.2 插件端点 + 单测 29/29 → M9.3 宿主 `sessions` action + popup 会话区 + smoke 356/0 + verify-cdp 82/0 → M9.4 真实实例 e2e 7/7（真实 dsh 0.1.1-rc.2 + 真实 profile 插件装配：端点 200/403/405、available:true、优雅停机无回归；本机插件已升级） |
| **M10 颜色语义自定义**（§8.12；M10.1 定稿 2026-08-24） | 用户可按语义角色调整展示色（如「完成」琥珀→绿）：`waiting/working/completed` 三角色预设色板，`settings.colorMap` 全域生效（popup 会话区走语义 CSS 变量、徽标 SW 读 storage）；error 红与字符语义锁定；**定稿色板：进行中=webui 蓝 #5686fe、等待=琥珀黄 #f59e0b、完成=绿 #22c55e**（去 idle、done 并入完成色；徽标完成提醒「!」随定稿改绿）；**顺带统一 working 双载体默认色** | 验收：verify-cdp 改色/恢复默认/撞色提示断言 + 字符语义不回归（**已完成 2026-08-24**） |
| **M11 项目更名**（§15.1，规划） | 一期：显示品牌（manifest 名、README、popup 品牌名、GitHub 仓库名）；二期：全量更名（native host 协议名 `com.dsh.manager`、注册表键、`%LOCALAPPDATA%\dsh-manager` 状态目录、`DSH_MANAGER_*` 测试钩子、代码/文档标识，含迁移脚本与卸载兼容）；**Chrome Web Store 上架前必须完成**（商店品牌一致性 + 图标重审准备） | 命名拍板（GitHub/npm/商店名冲突核查）→ 一期 → 二期迁移演练；§15.1 |
| **M12 会话推送（SSE）**（§8.10.1，2026-08-26） | 插件新增 `GET /_manager/events`（SSE：连接即快照 + 语义 diff 增量 upsert/removed + 15s 心跳；事件驱动 `session/event|created|disposed` + `agent/status`；零新依赖）→ 面板 `EventSource` 同源直连（徽标/面板 <100ms，SSE 存活时消除 1Hz 空轮询）→ popup storage 镜像桥（`sessionsCache` + `storage.onChanged`，<500ms）；故障三级回退（SSE → 1Hz 端点 → DOM）；无宿主协议/权限变更 | 插件单测（33→~45）+ `node --check`；verify-cdp 既有断言回归 + SSE 段（合成帧 → 徽标/面板即时更新且无轮询请求）；宿主 smoke 356/0 回归；真实实例 e2e（SSE 200/快照帧/状态流转/断流）；人工：双标签后台 + approval → 徽标「?」<100ms。**M12.1（2026-08-26）plan-review 判定补正**（§8.10 注记：`exit_plan_mode` 工具配对 → waiting）+ 单测 50/50 |
| **M13 上游 0.1.2 认证兼容 + 就绪信号反转**（§2.1.1、§15.2） | 一期（阻断修复）：宿主两处探测适配启动令牌认证（`httpDshProbe` 指纹端点改 `/manifest.webmanifest`、`httpProbe` 接受 401 为就绪），rc.2/0.1.2 双向兼容；二期（架构改良）：插件写「就绪文件」把存活/端口判定由**宿主轮询探测**反转为**dsh 主动告知**，HTTP 探测降级为无插件时的回退路径 | 一期：smoke 全量回归 + 双版本指纹端点断言（fake-dsh 增 401 变体）；二期：新增协议章节 §6.9 + 插件单测 + smoke 场景 + 真实实例 e2e（升级 0.1.2 后复跑） |

### 15.1 项目命名与更名规划（M11，2026-08-23 用户提出「名字太朴实」）

**现状**：`dsh-manager` / 「DSH Manager」——直白但无记忆点，且「DSH Manager」易被误读为 DeepSeek 官方产品（开源审查 🟡-4 已记录同名混淆风险，更名一并解决）。

**命名候选（最终由用户拍板；拍板前须核查 GitHub 仓库名 / npm 包名 / Chrome Web Store 可用性与冲突）**：

| 候选 | 中文副名（可选） | 理由 | 取舍 |
|---|---|---|---|
| **Whalekeeper** | 鲸守 | 与鲸鱼 logo 强呼应，「keeper」= 管理守护；品牌记忆点最好 | **✔ 已确认为候选（2026-08-23 用户认可）**；「DSH」术语不再出现在主名，混淆风险归零；最终定名前须完成冲突核查 |
| **Portwatch** | 端口守望 | 直描功能（守护 3080 端口的状态） | 技术感强、品牌联想弱；备选 |
| **Loopkeeper** | 回环守护 | 点出 127.0.0.1 回环安全模型 | 技术黑话，门外用户不解；备选 |
| （保持）dsh-manager | — | 直观、已有认知 | 被否（用户已定方向：太朴实） |

**更名范围分级（决定成本的关键）**：

- **展示品牌（轻，一期）**：`manifest.json` 的 `name`/`description`、README 标题与提及、popup 应用栏品牌名、GitHub 仓库名（旧 URL GitHub 自动重定向，风险低）。扩展 ID 由固定 `key` 生成——**换名不换 key 则 ID 不变**，宿主 `allowed_origins` 零改动，一期可无感落地。
- **协议与标识（重，二期）**：host 协议名 `com.dsh.manager`（Chrome/Firefox 注册表键 + 清单 `allowed_origins` + `host.cmd`/`host.sh` 路径）、状态目录 `%LOCALAPPDATA%\dsh-manager`（含 run/logs）、测试钩子与代码前缀 `DSH_MANAGER_*`、`DSH_MANAGER_BASE_DIR` 等、全部文档/注释/包名（`dsh-lifecycle` 插件包是否同步更名——独立决策点：包名属于 dsh 生态，改名影响安装路径；建议插件名不动或单独评估）。

**分期建议**：一期（显示品牌）独立低成本里程碑，可与 M10 同批；二期（全量更名）为单独里程碑，**必须含**：旧→新状态目录/注册表迁移脚本 + 卸载器兼容旧名清理 + 发布公告与「旧版本升级」指引（旧版扩展/宿主/插件与新名并存时的行为定义）。二期不晚于 Chrome Web Store 上架前。

**决策点**：① 命名**最终定名**（Whalekeeper 已确认为候选（2026-08-23 用户认可），Portwatch/Loopkeeper 保留备选；定名前完成 GitHub/npm/Chrome 商店名冲突核查）② 一期/二期是否分拆 ③ 中文副名「鲸守」是否采用 ④ `dsh-lifecycle` 插件包名是否跟随。

### 15.2 就绪信号反转规划（M13 二期，2026-08-28 用户提出「让 dsh 主动传递状态」）

**动机（实施前的现状）**：存活判定曾由宿主从外部 HTTP 探测。这条链路脆在两处：① 判定依据是前端产物内容，上游改一次静态资源或加一道闸门就断（§2.1.1 B1 即为实例）；② 轮询有固有延迟，`start` 需最长 30s 轮询才能确认就绪。

**已有的正确先例**：会话状态早已是推送制——插件 `GET /_manager/events`（SSE，§8.10.1）在 `session/event` 触发时主动推给面板。实施前，「实例是否活着、端口是多少」仍由宿主探测。

**已实现（2026-09-21，协议 §6.9）**：插件发布 starting，等待 Loader settlement 后发布 ready，`ctx.effect` 注册清理器；文件每 2 秒续期。宿主以匹配当前启动标识、PID 存活且新鲜的 ready 文件为优先信号，通过目录 `fs.watch` 唤醒启动等待；保留定时检查防漏事件。**修正规划中的消失语义**：文件缺失/过期回退 HTTP，不直接报 stopped，避免插件热卸载和写失败影响实例判断。

**取舍**

- ✔ 完全不经 HTTP，上游认证/压缩/路由怎么改都无法影响；
- ✔ 判定依据从「外人的推断」变为「dsh 亲口声明」（插件跑在 host 进程内，pid/port 是第一手事实）；
- ✔ `start` 就绪反馈由「轮询至敲通」变为「插件写文件的瞬间」；
- ✖ 依赖插件已安装且为新版——插件未装/旧版时无人写文件，**必须保留 HTTP 探测作为回退**（与 §8.10 sessions 端点同样的降级哲学：富信号不可用即降级，不可用不等于故障）；
- ✖ 引入新的宿主↔插件文件协议，已在 §6.9 定义并同步两处实现；
- ✖ 就绪文件位置需与状态目录（§6.5）区分：它由 **dsh 进程**写、宿主读，与宿主自己写的 run 记录不是同一权属，不可混放同一文件。

**已否决的替代**：`externally_connectable` 让 dsh 页面直连扩展 SW。§8.6 已核验外部插件无独立前端构建路径（这正是面板改用 content script 的原因），且现行「SSE → content script → SW」链路已达成同等实时性，为此新开一条通道无收益。

**已确定**：① 宿主 BASE_DIR 下独立 `ready/`，插件写、宿主只读；② 每次启动随机 launchId + 启动时间 + PID 校验 + 10 秒租约；③ 有效文件优先，HTTP 仅回退，不做每次双探测。无需新扩展权限，不包含认证 token。

### 15.3 README 图文改进计划（2026-09-26）

**本轮已做**：采用“快速上手手册”排版；首屏使用 Whalekeeper 原版双面板主图（不使用浅深拼贴稿），工具栏图示区分实例角标和会话字符徽标；把设置页两处滚动截图换成按完整模块排开的总览图，并提供连续长图。图片中的会话标题使用公开演示数据。移除已过时的构建者名单与末尾社区工具提醒。

README 仍有以下优化空间，后续按证据推进：

| 事项 | 后续动作 | 完成标准 |
|---|---|---|
| 工具栏徽标图 | 在 Chrome / Edge 真实工具栏中采集绿点、红点、蓝 `n`、黄 `?`、绿 `!`，替换当前基于真实图标的示意组合图 | 图与扩展当时的默认字符、颜色、优先级一致；不含个人会话内容 |
| 页面适配 | 在 GitHub 实际 README 的窄屏和深色页面检查主图、三列表格、设置总览及长图 | 字体可读、图片不溢出、长图仍可按需展开 |
| 安装与排错 | 获得 macOS / Firefox 实测环境后补平台步骤和截图；整理 README 图片的可复现生成方式 | 未实测平台不写成已验证；图片可由仓库内工具和公开演示数据重建 |

注（2026-08-14 用户决定）：**Chrome Web Store 上架与 macOS/Firefox 适配暂缓**；CHROMEWEBSTORE.md 保留为将来上架素材。README 当前版式与后续计划见 §15.3。

---

## 16. 风险清单

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| dsh CLI 面随版本漂移（flag/路径变化） | 中 | start 失效 | 版本基线校验（§13）；宿主解析链有回退；E2E 覆盖；**上游变更集中登记于 §2.1 台账**，每次版本跳变按耦合面逐行复核 |
| **上游改动 HTTP 表面导致探测判定失效**（认证/压缩/路由/静态资产） | 中（已发生一次） | 高（start 误报超时、status 卡 starting、外部发现失效） | 已发生实例：0.1.2 启动令牌认证（§2.1.1 B1）。缓解分两层——短期：指纹端点改用上游明示公开的 `/manifest.webmanifest` + 401 视为就绪（M13 一期）；根治：就绪判定改为插件主动写文件、不经 HTTP（M13 二期 §15.2）。约束：探测一律不发 `Accept-Encoding`（§2.1.1 B2） |
| Windows 下无法优雅停（F7）导致会话尾部丢失 | 中 | 低（F8 兜底） | M2 生命周期插件；文案提示「停止前确认任务完成」 |
| Chrome 对 native host 缓存/注册表变更需重启浏览器 | 高 | 低 | 安装器验收指引明确写出 |
| 安全软件拦截 `.cmd` 包装的宿主 | 低 | 高 | 备用方案：pkg 编译为独立 exe（M4 评估） |
| 用户手工运行了一个 dsh web（无 run 记录） | 低 | 低（已缓解） | M1.1 外部实例发现（§6.6）：status 报告 `external` 状态与真实端口/URL；M1.2 接管（§6.7）后可管理；未接管前 stop/restart 返回 `EXTERNAL_UNMANAGED` 不误杀 |
| 多浏览器 profile / 多台机器共享 LOCALAPPDATA | 低 | 低 | run 记录含 startedAt 与 pid，冲突自愈 |
| dsh 插件 API 变化（appExit/webServer 契约） | 低 | 中 | 插件按 dsh 同版本号发布并声明 `peerDependencies`（`"@deepseek-ai/dsh": ">=0.1.0-rc.6 <0.2.0"`，已落实于 `plugin/dsh-lifecycle/package.json`；**范围语义待修正为 `<0.2.0-0` 以涵盖预发布版，§2.1.1 R2**）；宿主对优雅路径失败始终有 taskkill 回退。**0.1.2-alpha.1 全量核验：插件用到的每个 seam 均存活且形状兼容，零改动（§2.1.1 B3）** |
| 命令执行闪现终端窗口 | 低（M5.5 起已缓解） | 低（闪窗不阻塞，stdout 仍入日志文件） | M5.5 隐藏控制台载体：dsh 获得从不显示的控制台，子进程继承、不再闪窗（§6.3 第 5 步）；残留风险：wscript 不可用或载体链路失败时实例不可托管（INTERNAL 提示）；若上游修复受限令牌限制可移除载体回归直接 spawn |

---

## 17. 附录：参考链接

- dsh 仓库：https://github.com/deepseek-ai/deepseek-harness
- dsh npm 包：https://www.npmjs.com/package/@deepseek-ai/dsh
- dsh-web-app：https://www.npmjs.com/package/@deepseek-ai/dsh-web-app
- Chrome Native Messaging 文档：https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- 社区相关项目（思路佐证）：oh-dsh-desktop（macOS 桌面工作台，https://github.com/hust-open-atom-club/oh-dsh-desktop）、dsh-web-ui 插件合集（https://github.com/zhu1090093659/dsh-web-ui）
