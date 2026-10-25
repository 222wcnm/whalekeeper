# 浏览器扩展界面与后台

[返回设计规格索引](../design.md) · 原规格 §8.1–8.9

---

## 8. 浏览器扩展设计（extension/）

### 8.1 manifest.json（MV3）

```json
{
  "manifest_version": 3,
  "name": "DSH Manager",
  "version": "0.1.0",
  "key": "<固定公钥，见 §10.2，项目初始化时生成一次>",
  "permissions": ["storage", "nativeMessaging", "alarms"],
  "host_permissions": ["http://127.0.0.1/*", "http://localhost/*"],
  "action": { "default_popup": "popup.html", "default_title": "DSH Manager" },
  "background": { "service_worker": "background.js" },
  "content_scripts": [
    {
      "matches": ["http://127.0.0.1/*", "http://localhost/*"],  // 匹配模式忽略端口：任意端口生效
      "js": ["content/panel.js"],
      "run_at": "document_idle"
    }
  ],
  "icons": { "16": "icons/16.png", "48": "icons/48.png", "128": "icons/128.png" }
}
```

说明：

- `nativeMessaging`：连接宿主所必需。
- `host_permissions` 限回环：既用于 popup/SW 的 `fetch` 探活（`GET /`），也杜绝扩展对任意网络地址的访问面。
- `chrome.tabs.create` 打开 Web UI 无需任何额外权限。
- `alarms` 用于周期徽标刷新（可选功能，默认开、30s 间隔）。
- **不申请** `webRequest` / `declarativeNetRequest` / 任意文件系统权限——不需要，也避免商店审核与用户信任问题。

### 8.2 popup（popup.html/js/css，V6 侧边 Rail 导轨空间架构）

**rc.2 导航与等待契约（2026-10-18）**：会话行只读，不生成未获上游支持的
`/#/chat/{id}`；已读/撤销及统一 Web UI 入口保留。标签复用以 URL 解析后的 HTTP、
127.0.0.1/localhost 与有效端口精确比较（省略端口为 80，3080 不匹配 30801）。
新增 Popup→content script 只读认证查询，只返回认证状态和有效端口；查询不读取
消息/凭据，令牌不进入消息。确认已认证仅聚焦；401/休眠/无法确认且有合法启动 URL
时另开认证页，不覆盖原标签和草稿。启动 URL 必须为 HTTP 回环、实际端口、根路径，
无用户名密码；external/adopted 无令牌时裸 URL 降级并提示使用原启动入口。
SW 动作预算 start/restart/stop=210/240/60 秒；错误文案不写死 30 秒，不虚构重启阶段。

**空间架构与尺寸基线：380px 宽度 × 270px 严格物理锁定高度（零抖动）。** 采用 Master-Detail 侧边导轨架构（左侧 **46px 极窄 Rail 导轨** + 右侧 **334px 独立视口**），尺寸从 360×240px 舒展放大至 380×270px，不仅彻底根除传统单列视图在面板展开、设置切换时的尺寸拉长与跳动问题，还为多会话列表与运维操作提供了从容呼吸的视觉空间。

**视觉规范：100% 对齐 dsh Web UI 设计系统与原厂原生资产。**
1. **设计令牌与色彩**：直接内联 dsh 前端设计令牌（`--dsw-*` 变量，浅色 + 深色两套（§8.7））：主文字 `--dsw-alias-label-primary`；次要/说明文字 label-secondary / label-tertiary / label-caption；面板底 `--dsw-alias-bg-base`；模块底 `--dsw-alias-bg-module-platform`；边框 `--dsw-alias-border-l1/l2`；悬停 `--dsw-alias-interactive-bg-hover`。
2. **官方真实选中态（Active State）**：严格遵循 Web UI 真实规范——**无粗重实心反色填充，无多余黑/白外框线，采用纯净柔和的灰色圆角背景**（深色模式 `rgba(255, 255, 255, 0.14)`，浅色模式 `rgba(38, 49, 72, 0.10)`），图标与文本高亮提亮为 Primary 色。
3. **官方原生 SVG 资产库 (`dsh-assets-library.js`)**：全量接入从官方 bundle 提取的精准资产：`FishLogo`（精准 23.16:17.04 比例）、`BrandBadge`（矩形微胶囊字标）、`StateMatrix`（进行中跑马灯点阵）、`IconPanelLeftOutline16`（概览）、`IconNewChatOutline16`（会话）、`IconSettingsOutline16`（设置）、四态主题图标等。
4. **官方动效系统（Keyframes）**：
   - 小鲸鱼游弋（`dsh-fish-swim`）：悬停触发原厂 0.6s 平滑游动；
   - 面板平滑滑入（`dsh-panel-in`）：面板切换带 `translateX(6px) → 0` 0.18s 顺滑进场；
   - 进行中流光扫光（`dsh-shimmer`）：2.2s 高光渐变扫过文字；
   - 全局呼吸 Document Timeline 同步：所有指示灯以打开瞬间为零点基准，绝对同频同相呼吸；
   - 触觉按压反馈（`:active` scale 0.96）。

布局架构（V6 导轨双栏）：

```
┌─────────────────────────────────────────────────────────────┐
│ [46px Rail 导轨] │ [334px 独立视口 (高度物理锁定 270px)]      │
│                  │                                          │
│ [ ◫ 服务概览 ]   │ [FishLogo] Whalekeeper [DSH WEB]  [3080] │
│ [ 💬 会话感知 ]  │ ──────────────────────────────────────── │
│ [ ⚙ 偏好设置 ]   │  ● 运行中                           健康 │
│                  │  已运行 76m43s · PID 53844 · node v24.19 │
│                  │                                          │
│                  │  [             打开 DSH Web UI          ] │
│                  │  [ ▷ 启动 ]    [ ■ 停止 ]      [ ↻ 重启 ] │
│                  │                                          │
│ ● (常驻同频呼吸) │  优雅停机已就绪                 查看日志 │
└──────────────────┴──────────────────────────────────────────┘
```

三大面板职责与排版：

1. **面板 1：服务概览 (Dashboard)**：
   - 顶栏：悬停游弋 `FishLogo` + `Whalekeeper` + `BrandBadge[DSH WEB]` + 端口微胶囊 `[3080]`；
   - 状态卡：分层圆点 + 运行状态 + 健康度 + PID/uptime/nodeVersion 明细；
   - 主操作区：宽幅「打开 DSH Web UI」主入口 + 启动/停止/重启运维操作行（34px 舒适操作高度）；
   - 底栏：优雅停机状态感知 + 「查看日志」独立全页入口（§8.4）。
2. **面板 2：会话状态感知 (Sessions)**：
   - 顶栏：`会话状态感知` + 胶囊 `[3 活跃]` + `只读感知`；
   - **原厂无框通透平铺列表**：移除每个会话的实体外框与小卡片背景，对齐 DSH Web UI 侧栏会话风格，透明背景 + 悬停轻盈半透灰底（`var(--dsw-alias-interactive-bg-hover)`），配备 4px 极窄半透明滚动条；包含待确认（琥珀呼吸点）、进行中（`StateMatrix` 点阵 + `shimmer` 流光扫光）、已完成（柔绿呼吸点）；
   - 底部操作：宽幅「前往 Web UI 统一处理」。
3. **面板 3：首选项设置 (Settings)**：
   - 分组微卡片化结构（Section Cards）：
     - **服务运行环境**：端口（0=自动）、Profile 方案（方案 A 友好注记：*默认 web，用于指定 dsh 启动方案，一般无需修改*）、自动打开 Web UI 开关；
     - **徽标感知与外观**：刷新间隔、双徽标感知开关、4 态外观 Theme Cubes；
     - **扩展徽标与会话颜色**：待确认/进行中/已完成 3 角色单层静态柔光色盘（安静不呼吸）+「恢复默认」；
   - 底部操作栏：双按钮 `[ 保存设置 ]` 与 `[ 取消 ]`。

### 8.4 日志查看页（logs.html/js/css，M3）

popup「查看日志」打开的全页日志查看器，视觉延续同一套 `--dsw-*` 设计令牌（logs.css 与 popup.css 同源）；日志区等宽字体、纯文本渲染。

布局（自上而下）：

```
┌──────────────────────────────────────────────────────────┐
│ ● dsh web 日志      [☑自动刷新] [加载更早] [复制全部] [刷新] │
│ [错误横幅（宿主缺失/通信失败，附重试）]                     │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ <pre> 日志内容（等宽、纯文本、可滚动）                 │ │
│ └──────────────────────────────────────────────────────┘ │
│ 日志文件：…\logs\dsh-web.log · 大小 1.2 MB · 已加载 500 行 │
└──────────────────────────────────────────────────────────┘
```

行为规范：

1. 打开即经 SW 调宿主 `logs`（`tailLines:500`，默认 `maxBytes` 256KB）取尾部块；先并行拉一次 `status` 决定状态圆点颜色（running 绿 / 其余灰，仅展示用途，失败不阻塞）。
2. **加载更早**：`beforeByte = 首块 fromByte` 逐块向前翻页直至 `hasMore:false`（宿主保证行边界对齐与块间严格衔接）；`fromByte===0` 时 toast「已到日志开头」。点击「加载更早」自动**暂停自动刷新**（阅读历史与跟随互斥，toast 告知），避免新内容到来重置视图。
3. **自动刷新**（默认开，2s）：仅取尾部块；按块衔接契约合并——新尾部覆盖全部已加载内容时整视图重置，否则裁掉与尾部重叠的后缀块再追加；与最后一块之间出现缺口（日志轮转/截断）时插入视觉分隔标记。页面隐藏（`visibilitychange`）时暂停轮询，重新可见立即刷一次。用户停留在底部时新内容到达自动贴底，上翻阅读时保持位置。
4. **复制全部**：复制当前已加载的全部日志行（`navigator.clipboard` + `execCommand` 兜底，失败 toast）。
5. 错误横幅：`HOST_NOT_INSTALLED` / `NATIVE_ERROR` 等展示中文文案与重试按钮；圆点转红。
6. 安全：日志内容一律 `textContent` 渲染（含 gap 标记），绝不进入 `innerHTML`；页面仅 `127.0.0.1` 探活之外的本地扩展资源，无新权限。

### 8.3 background service worker

职责与约束：

1. **串行化 native 调用**：维护单一 `pending` promise 队列，一次只允许一个 connectNative 连接；并发请求排队（状态模型本身幂等，但串行化可消除锁竞争与 Chrome 多宿主进程）。
2. 单次 native 往返时长按动作区分：**start/restart 的「轮询到就绪」在宿主侧完成**（三种模式从 spawn 起 150s 共享发现/就绪截止，URL 捕获最多额外 5s；restart 先 stop 再 start）。SW 以 start 210s / restart 240s 等待；返回 `running` 或超时错误，popup 应用结果后由 2s 轮询收敛。
3. 连接异常处理：`connectNative` 抛 `Specified native messaging host not found` → 向 popup 返回 `HOST_NOT_INSTALLED`，引导运行安装器。
4. 徽标刷新：`chrome.alarms`（30s）→ 本地 fetch 探活（不惊动宿主）→ 更新 **图标角标**（`action.setIcon`，绿点=运行/红点=错误/无点=停止，M8.1）+ title；徽标字符专职会话状态层（§8.9）。**M4：settings.port === 0（动态端口）时本地探活不可行，改经 native `status` 判定**（宿主解析实际端口）。
5. 全部 native 消息走 `chrome.runtime.sendMessage` 的 async 应答（`return true` + `sendResponse`）。
6. **兜底超时按动作区分（rc.2）**：restart 240s、start 210s、stop 60s、adopt 45s、sessions 8s、其余 30s；仅在该动作在途时持有 native 连接，处理完断开，不引入常驻保活。

### 8.5 宿主 manifest 与注册（§10 安装器生成）

宿主 manifest（`com.dsh.manager.json`）：

```json
{
  "name": "com.dsh.manager",
  "description": "DSH Manager native host — manages the dsh web process lifecycle",
  "path": "C:\\Users\\<user>\\AppData\\Local\\dsh-manager\\host\\host.cmd",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<固定扩展ID>/"],
  "allowed_extensions": ["<固定扩展ID>", "<gecko id>"]
}
```

说明：

- `path` 指向一个 `.cmd` 包装（Chrome 允许）：内容为 `@echo off` + `"<node.exe>" "<...>\host.js"`；由安装器现场生成绝对路径。
- `allowed_origins` 供 Chrome/Edge 校验；`allowed_extensions` 供 Firefox 校验（**M4 起同时含 Chrome 扩展 ID 与 manifest `browser_specific_settings.gecko.id`（`dsh-manager@local`）**，两者并存无害；Firefox 忽略 `allowed_origins`）。
- 注册表（HKCU，无需管理员权限）：
  - Chrome：`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dsh.manager` → manifest 路径
  - Edge：`HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.dsh.manager` → 同上
  - Firefox（M4）：`HKCU\Software\Mozilla\NativeMessagingHosts\com.dsh.manager` → 同上
  - （可选）Chrome Dev/Canary/Beta 同理各加一条。

### 8.6 页面内管理面板（content script，M3）

§15 M3「Web UI client 插件管理面板（页面内停止/重启）」的落地形态。**方案决策：不用 dsh client 插件**——实测核验 dsh@0.1.0-rc.6 的 Web 客户端插件机制后确认：外部插件需声明 `dsh.client` + 提供 `exports["./client"]` **预构建 bundle**（factory 形式 CJS，构建时纯化门禁，`client-modules` 缺失构建产物时报「run `pnpm run build` before launch」），即客户端插件必须走 dsh monorepo 自身构建链，社区插件作者没有独立构建路径。因此改用**扩展 content script 注入**，零 dsh 构建依赖，扩展一处安装即得，且覆盖任意端口的 dsh 页面（匹配模式忽略端口）。

行为规范（`extension/content/panel.js`，样式内联于脚本）：

1. **指纹激活**：仅当 `document.title` 匹配 `DeepSeek Harness`（与 §6.6 指纹同源）才注入面板，其余本地页面不注入；`window` 级标志防重复注入。
2. **归属验证（仅托管实例可操作）**：页面身份 ≠ 进程归属——指纹激活只说明页面是 dsh 的 UI，不说明其进程由扩展管理（终端/WSL 启动的实例同样满足指纹）。面板每轮 `status` 后做归属判定：仅当返回 `running` 且 `port` 与当前页面端口一致时，「停止/重启」才可用；`stopped`、端口不匹配、外部实例一律降级为只读——状态行显示「此实例不由本扩展管理（请在扩展 popup 中操作）」，徽章显示「未托管」，两按钮禁用（`stopped` 时不再允许「重启=启动」，防止在非本扩展实例页面上误拉起新实例）。**圆点颜色随展示语义而非原始状态**：绿仅表示「本页托管实例运行中」；外部实例（`external` 且端口匹配）为蓝；未托管/已停止/端口不匹配一律中性灰；启动/停止中为琥珀脉冲；「状态获取失败」为红（仅连续失败后，见第 4 条）。
3. **Shadow DOM 隔离**：宿主节点 + open shadow root，样式 `<style>` 内联在 shadow root 内（页面 CSS 不穿透 shadow，双向零干扰）；颜色复用经 CSS 自定义属性继承的 `--dsw-*` 令牌并带 fallback 值。**主题跟随零逻辑**：令牌值从宿主页面继承，页面切深色（`body[data-ds-dark-theme]`）时变量值变化、面板自动跟随（§8.7）；仅 box-shadow 与确认按钮前景色等少量值需兼顾两套主题。
4. **全部动作经 SW 中转 native 宿主**（复用 §8.3 既有 `{type:'native'}` 通道，面板自身不直连 `/_lifecycle`）：2s 轮询 `status`（页面隐藏时暂停）；「停止」两步确认（首次点击进入 3s 待确认态，再点才执行——面板所在页面即将随 dsh 关闭，防误触）；「重启」按宿主 restart 语义（优雅停优先 + 原参数重放，§6.3）；动作在途按钮禁用 + spinner + 内联状态文案。**状态失败容错**：单次 status 失败不立即报红——MV3 SW 休眠/唤醒竞态会让单次消息失败、下一轮即恢复，故连续 3 次失败（约 6s）才显示红色「状态获取失败」，期间保留上次成功状态；扩展在 `chrome://extensions` 重载/更新后，已打开页面里的旧内容脚本上下文失效（`chrome.runtime.id` 为空，孤儿脚本）——此时停止轮询，显示中性灰提示「扩展已重载或更新，请刷新页面恢复」（徽章「已断开」），不再永久误报红错。
5. **不读取页面内容**：面板只读 `document.title` 做指纹判断，追加自身节点，绝不修改 dsh 页面 DOM。
6. 收起态为右下角状态小徽章（圆点 + 文本），点击展开面板；**展开时胶囊位置不变**——面板体绝对定位在胶囊上方弹出（`position:absolute; bottom:calc(100%+8px)`），而非把胶囊顶上去；`prefers-reduced-motion` 关闭动画。

安全（§12.2 补充）：面板是扩展自有 content script（非页面脚本），消息只发给本扩展 SW；停止/重启走宿主全套防护（PID 复用校验、`EXTERNAL_UNMANAGED` 保护、锁、优雅降级链）；不新增任何权限与 host_permissions（回环匹配已有）。

### 8.7 主题与深色模式（M6）

**目标**：扩展全部界面（popup、日志页、页面内面板）支持深色模式，且视觉与 dsh Web UI 深色主题严格一致（同一 `--dsw-*` 令牌体系、同一渲染标记）。

#### 8.7.1 事实基础（F14）

- Web UI 主题偏好三态 `light` / `dark` / `system`（默认 system），存 dsh settings namespace `ui-theme.preference`（host 用户设置文档）。
- 实际渲染以 `body[data-ds-dark-theme]` 属性标记（浅色无属性）；`system` 偏好时由 `prefers-color-scheme` 媒体查询驱动实时翻转。
- 全部 `--dsw-*` 令牌（static / alias / specific）浅、深两套，由 `dsh-client-ui-theme` 注入；深色值驻留在 `body[data-ds-dark-theme]{…}` 块（本仓库提取存档：`tools/ui-theme/dsw-tokens-dark.css`）。
- 主题偏好经 F9/F10 围栏（Settings RPC 为 loopback-gated privileged 域），扩展不能直接读取 → 扩展只做 **DOM 镜像**，不回写 webui 偏好。

#### 8.7.2 主题模型（四态）

| 模式 | 语义 | 取值来源 |
|---|---|---|
| `follow-webui`（**默认**） | 与 webui 实际渲染一致 | storage 镜像 `webuiTheme.dark`；**从未有镜像**时回退系统（仅此一种回退）。注：webui 关闭（标签不存在）后镜像保留最后状态，本模式继续跟随最后镜像而非回退系统——保持「最后一次所见 = 当前呈现」的一致性语义 |
| `follow-system` | 与操作系统一致 | `matchMedia("(prefers-color-scheme: dark)")` + change 监听 |
| `light` / `dark` | 手动锁定 | 硬编码 |

storage 布局（chrome.storage.local）：

```
settings.theme = 'follow-webui' | 'follow-system' | 'light' | 'dark'   ← 扩展现有 settings 对象新增字段
webuiTheme    = { dark: boolean, at: timestamp, port }                 ← panel.js 只读镜像
```

#### 8.7.3 数据流

```
webui body[data-ds-dark-theme] 变化
   └─ panel.js: MutationObserver（attributes + 初始读取）→ chrome.storage.local.webuiTheme
popup / logs 页打开或 storage.onChanged 触发
   └─ theme.js applyTheme(): 解析四态 → <body data-ds-dark-theme> 设/移除 → CSS 换肤
```

- `theme.js`（新，`extension/theme.js`，约 40 行，popup.js 与 logs.js 共用）：`applyTheme()` 读 `settings.theme` + `webuiTheme` 镜像 + `matchMedia`；在 `document.body` 上设/移除 `data-ds-dark-theme`；导出 `initTheme()`（立即应用一次 + 订阅 `chrome.storage.onChanged` + `matchMedia change`）。
- panel.js 的镜像写入幂等（值未变不写），且页面隐藏时照常观察（属性变化与 visibility 无关）。
- 应用时机：popup `DOMContentLoaded` 尽早（避免浅色闪烁）；logs 页同理；主题切换即时生效（无需点「保存」，与 webui AppearanceRow 行为一致）。

#### 8.7.4 各载体行为

| 载体 | 机制 | 备注 |
|---|---|---|
| popup | theme.js 全量 | 打开即应用；open 期间 storage.onChanged 实时跟随（webui 开着时切主题，popup 即变） |
| logs 页 | 同 popup | 与 popup 同主题，无独立开关 |
| 页面内面板 | CSS 变量继承，**换肤零 JS 逻辑** | 永远跟随宿主页面；仅局部值（box-shadow、确认按钮前景色）在两套主题下取合适值（fallback 值保留）。注：panel.js 另含只读镜像 observer（§8.7.3，写 storage 供 popup/logs 消费），与换肤无关 |

#### 8.7.5 设置 UI：外观行

popup 设置面板新增「外观」行（四个互斥选项按钮），复刻 Web UI AppearanceRow 主题立方体视觉（同款令牌）。**2026-08-22 用户决策（M6 后修订）：改为 icon-only——一行 4 列网格，按钮仅显示图标（16×16 outline），hover 时以原生 `title` 弹出文案提示；为有意偏离 webui 原文案版的用户偏好（省约 40px 垂直空间），按钮的无障碍名称由 `aria-label` 提供，点选/选中态/键盘语义不变**：

- 按钮：`border: 1px solid var(--dsw-alias-border-l2)`、`border-radius: 16px`、网格 4 列（`grid-template-columns: repeat(4, 1fr)`）、`height: 32px; padding: 0`（图标水平/垂直居中）；选中态：`background: var(--dsw-alias-bg-module-platform)`（浅色 = bluish-60，深色 = bluish-800，须在两套主题中均定义）+ `border-color: var(--dsw-static-neutral-bluish-400)`。
- 键盘可访问性（radiogroup 规范）：选中项 `tabindex=0`（roving），其余 `-1`；`keydown` 处理 ArrowLeft/Right/Up/Down（循环换选）+ Home/End（首/末），换选即触发 point 即生效。
- 文案：按钮原文案（跟随 Web UI / 跟随系统 / 浅色 / 深色）移入 `title`（hover 提示）+ `aria-label`（读屏名称）；图标 16×16 outline 风格（跟随 Web UI 用鲸鱼剪影，其余用太阳/月亮/显示器，与 webui 同款提取，来源注明）。
- 点击即写 `settings.theme` 并即时应用（不改变「保存」按钮语义——保存只管 port/profile/autoOpen/badge）。
- 安全：主题值白名单校验（四态枚举），非法值落回默认。

#### 8.7.6 深色令牌落地（CSS）

1. `popup.css` / `logs.css` 各加 `body[data-ds-dark-theme]{…}` 块：深色 static + alias 令牌（取自 `tools/ui-theme/dsw-tokens-dark.css` 提取存档，值与 webui 逐字一致）＋ 该块内 `color-scheme: dark`（webui 未显式声明，浏览器默认随系统，行为等价；原生 checkbox/number spinner 在扩展页内才正确变深）。
2. `.btn.primary` 改 `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground`（浅色视觉不变；深色 = 近白底/深字，与 webui 主按钮一致；现用 `brand-primary`+`bluish-00` 在深色下会白底白字，必须修正）。
3. toast 三色变体（success/error/info）硬编码浅色背景 → 深色下换 `--dsw-alias-toast-bg` / `--dsw-alias-bg-layer-*` + 对应 state 文字色；`.error` 面板、`.field-invalid` 红系 rgba → 深色语义。
4. 固定 box-shadow（popup/panel 的 `rgba(15,17,21,…)`）统一到 `--dsw-shadow-lv1/2`（webui 浅深通用）。
5. `prefers-reduced-motion` 覆盖不动。

#### 8.7.7 验收

- `tools/verify-ui/verify-cdp.js` 新增深色断言：① popup 设 `settings.theme:'dark'` → `body[data-ds-dark-theme]` 存在 + 背景计算色为深色值；`'light'` 反之；`'follow-system'` 用 CDP `Emulation.setEmulatedMedia` 翻转系统主题断言跟随；② 镜像链路：模拟 storage `webuiTheme` 写入 → popup 跟随；③ 面板：宿主页面 body 属性翻转后 shadow 内面板计算背景同步变化（抽取自定义属性计算值或背景色比对）；④ 截图浅/深两套存档（vision 核验）与 console 零异常。
- 视觉抽查：popup 浅/深截图对照 webui 存档截图。

### 8.8 popup 排版优化（M7，方案 A：应用栏 + 状态卡 + 分组设置）

**目标**：解决 §8.2 现行排版的「平铺朴实感」——信息无分区、重量均等、按钮不突出。保持与 webui 设计系统一致（全部 `--dsw-*` 令牌，零新增色），深色随 §8.7 令牌自动适配。
**设计参考产物**：`tools/ui-theme/mockup-preview.html`（方案 A 高保真预览，浅色两状态：默认视图 + 设置面板；用 `vision_html_screenshot` 渲染核验）。

**布局（新三区结构，覆盖 §8.2 布局示意图的呈现层）**：

```
┌──────────────────────────────┐
│ 🐳 DSH Manager  [dsh web]    │  ① 应用栏：小鲸鱼 20px + 名称 15/600 + 胶囊标签
│                 [⊙刷新][⚙]   │     （右）圆形图标按钮 28px（hover 浅底）
│ ┌──────────────────────────┐ │
│ │ ● 运行中        端口 8080  │ │  ② 状态卡（焦点区）：bluish-60 底 + border-l1 + 圆角 12
│ │ 健康 · 76m43s · PID …     │ │     左：10px 分层圆点 + 状态词 13/500；右：端口 12/500 蓝
│ └──────────────────────────┘ │     第二行：次级信息 11.5px caption 色（tabular-nums）
│ [ 启动 ] [ 停止 ] [ 重启 ]    │  ③ 操作区：主操作 h32（primary/danger/outline 同现有语义）
│ [    打开 Web UI        ]    │     「打开 Web UI」全宽 ghost（bluish-60 底 + business 蓝字 500）
│ ──────────────────────────── │  ④ 底栏：border-top-l1 + 提示 11px caption + 「查看日志」link
│ 优雅停机已启用   [查看日志]    │
└──────────────────────────────┘
```

**组件规格**（数值/色值，均取自现有令牌）：
- 面板：`padding: 16px 14px 12px`；应用栏行高 28、间距 12。
- 状态卡：`background: var(--dsw-alias-bg-module-platform)`（浅=bluish-60 #f5f6f7 / 深=bluish-800）+ `border: 1px solid var(--dsw-alias-border-l1)` + 圆角 12 + `padding: 10px 12px`。
- 状态词层级：13/500 `--dsw-alias-label-primary`；端口 12/500 `--dsw-alias-state-business-primary`；次级行 11.5px（11px 与 12px 间，用 `font-size: 12px` + caption 色亦可，实施时二选一并保持三页一致）。
- 状态变体（卡片整体配色随语义）：
  - running：常规（背景如规格；绿点，**实心点呼吸 2.2s**——用户偏好（2026-08-22 反馈）：光晕太淡难观察，呼吸作用于**实心点**（opacity .5↔1 + scale .88↔1，肉眼可见的脉动），光晕同步 .08↔.16；浅深通用；`prefers-reduced-motion` 关闭；页面内面板/logs 页同源规则）；
  - stopped/未托管：圆点灰、状态词 label-secondary；
  - external：蓝点（同呼吸）、端口显示；
  - starting/stopping（含操作在途）：**琥珀圆点脉冲**（1.2s `dsh-dot-pulse`）+ 状态词琥珀 warn——webui 点阵语义为「长时进行中的会话工作」，扩展 busy 是秒级过渡态，语义不匹配（§8.8.1 已撤销，2026-08-22）；
  - error：卡片红调（`border-color: rgba(236,19,19,.25)` + 状态词 error 红），错误详情仍走既有 error 面板。
- 注（2026-08-22 用户反馈修补）：**logs 页状态点只表达 dsh 运行状态**（error/running/stopped）——页面日志请求在途（busy）不得映射到状态点（原实现把 2s 自动刷新的请求窗口映射为 dot-busy，绿点每 2s 短暂变 Matrix，观感为「点阵闪现」）；popup 状态卡与面板 chip 的 busy=真实 dsh 状态转换/操作在途（琥珀脉冲）。
- 底栏：`border-top: 1px solid var(--dsw-alias-border-l1)`；提示 11px caption；「查看日志」link 12px business 蓝（hover 浅底）。
- 设置面板（内嵌视图）：分组标题「服务」「界面」11px / 500 caption 色 + 组间距 12；表单行保持现有 `.field`；「外观」四 cube 保留（§8.7.5）；actions 在分组外底部（与现状一致）。

**§8.8.1 Matrix 动效（已撤销，2026-08-22 用户复盘；提取存档见 git 历史）**：webui 会话侧栏
「正在工作」点阵（SVG 10×10 viewBox、3×3 外圈 8 个 2×2 rect、`@keyframes dot-chase` 1s 循环、
125ms 相位差）的语义是**长时进行中的会话工作**（连续数秒至数分钟）；扩展的 busy 态
（starting/stopping/操作在途）是**秒级过渡态**，1Hz 追逐动画套在短暂状态上观感为「点阵
闪现」，语义不匹配 → **不使用**。busy 态统一用琥珀圆点脉冲（1.2s，`dsh-dot-pulse`），
与 webui「过渡中」信号一致；`.dot` 的 class 名与语义保留（`dot-busy` 不改名）。

**实施清单（文件级）**：
1. `extension/popup.html`：应用栏/状态卡结构替换（保留全部既有 id 与语义钩子：`dot`、`btn-*`、`settings-panel`、`theme-grid` 等，仅调整结构与 class）；品牌 wordmark 换 20px 鲸鱼 + 文字（鲸鱼 path 复用现有内联）。
2. `extension/popup.css`：新增 `.appbar/.brand/.statuscard/.ops/.foot/.s-group/.statuscard.error` 等样式；删除/替换原 `.status-row/.url-row/.detail/.hint-row` 的部分规则（保留接口类名不变的规则）；busy 琥珀脉冲沿用既有 `.dot-busy:after`（Matrix 已撤销，见 §8.8.1）。
3. `extension/popup.js`：结构变更后的事件绑定与 getElementById 目标核对（id 不变则基本无改动；状态卡渲染逻辑从「三处文字行」合并为卡片内两行——实现 `renderStatusCard()` 并把 `dotStateClass()` 的语义映射迁入）。
4. `extension/content/panel.js`：chip busy 态 = 琥珀脉冲（保持 `dot-*` class 语义与 10px 尺寸；Matrix 已撤销）。
5. `extension/logs.css`/`logs.js`（如有 log 页状态点 busy 态）：同上。
6. `tools/verify-ui/verify-cdp.js`：新增/更新断言——状态卡结构与文案（`.statuscard` 存在、状态词/端口/次级行文本）、busy 态琥珀脉冲（dot-busy + `:after` 动画非 none + 无 matrix）、错误态红调卡片、深色下状态卡背景翻转；截图 `popup-m7.png`。
7. `tools/ui-theme/mockup-preview.html`：已入库（本设计参考）。

**验证**：先跑基线 `verify-cdp.js`（50 PASS）→ 实施 → 全量 + 深色截图 vision 核验；`node --check` 全部受影响 JS。

**决策点默认取向**（实施时若用户无异议按此执行）：
- 「dsh web」胶囊标签：保留（指示连接目标）。
- 状态卡第二行信息：保留完整（健康/uptime/PID），窄屏溢出自适应省略。
- 错误态：红调卡片（见状态变体）。
- Matrix 动效：已撤销（2026-08-22 用户复盘——webui 点阵语义为长时进行中，扩展 busy 是秒级过渡，不适用；busy 用琥珀脉冲，见 §8.8.1）。

### 8.9 徽标提醒「该点回来看看了」（M8）+ M8.1 徽标语义重构（2026-08-22 用户决策）

**目标**：用户不长时间驻守 dsh 标签页（切去别的标签/窗口，或窗口最小化）。这时 dsh Web UI 里「一轮工作完成」或「会话正在等你拍板（批准 / 问答 / 计划审查）」应经**工具栏徽标**提醒用户回来——徽标是扩展已有的常驻信息面（§8.3），零新增权限、零持续后台占用（检测发生在已注入的 content script 里，SW 只在事件驱动的消息时唤醒）。

**M8.1 语义重构（用户决策）**：原 M8 把「实例运行状态（绿●/空白）」与「会话提醒（紫?/琥珀!）」都塞进徽标字符，两者互斥覆盖——显示「?」时看不到实例状态，且实例停止后提醒仍残留（4h TTL）。重构把两个语义层**拆分到双载体**（§8.9.1 表）：

| 载体 | 语义层 | 表达 | 说明 |
|---|---|---|---|
| **图标角标**（action.setIcon 预生成 PNG 变体） | 实例状态层 | 绿点=运行中、红点=错误/未装宿主、无点=停止 | 与徽标同屏共存，不互斥覆盖 |
| **徽标字符+色**（action badge） | 会话状态层 | 黄「?」=等你（待确认）、绿「!」=工作完成（事件提醒）、**蓝 n**=n 个会话工作中、空=安静 | 等待/完成两色均取 `settings.colorMap`（M10.1 定稿：等待黄 #f59e0b、完成绿 #22c55e——与 webui 计划面板黄及「完成=绿」同构）；工作蓝 #5686fe = webui `--dsh-state-ongoing` 同源色 |

优先级：**waiting（黄?）> done（绿!）> working（蓝 n）**；多 tab 全局聚合（working 计数求和、waiting/done 任一即有）。字符上限「9+」（徽标字符区约 2 字符）。

**独立开关**：`settings.attentionDone`（默认 true，popup「界面」分组新增「徽标：工作完成提醒（绿!）」）——done 事件可单独关闭；总开关 `settings.attention` 关闭则整个会话状态层停显（徽标空，角标照常）。**自定义语义（预设档位/每状态字符映射）——M10.1 起字符仍锁定（用户问询 emoji 后决定暂不引入，字符语义= ! / ? / n 不变；文字状态词永锁）**。

**触发信号（webui 事实基线，取自 `@deepseek-ai/dsh-client-ui-workspace` 0.1.1-rc.2 客户端包与 `dsh-web-frontend` bundle）**：会话侧栏行由 `StateDot` 渲染——**工作中** = `svg[data-state="ongoing"]`（基线为 10×10 点阵追逐动画；2026-08-22 用户实测当前版本渲染为**蓝色状态标签**（如「Deep diving…」，`--dsh-state-ongoing: --dsw-static-deepseek-450` #5686fe）；徽标蓝 n 与 webui 同源）；**等待用户**（pendingInteraction: approval / question / plan-review）= `span[data-state="warning"]`；空闲/完成 = `data-state="done"`。这组 `data-state` 值是 StateDot 的**语义 API 属性**（非 CSS-module 哈希类名），跨 webui 版本漂移风险低。

> **数据源修订（2026-08-24，徽标←→popup 会话区计数一致性）**：`data-state` 是 webui **显示态**，相对服务端事件流存在前端渲染延迟——会话完成/空闲瞬间扫描会拿到旧计数，且同实例多标签各自上报会被重复累加，产生「徽标蓝 2、popup 会话区进行中 1」的偶发不一致（2026-08-23 用户实机反馈）。**计数改为优先读服务端点** `GET /_manager/sessions`（§8.10，与 popup「会话」区同一端点、同一状态判定），历史曾用 `data-state` 回退；rc.2 起删除该路径，插件摘要不可用就降为仅实例管理。同实例多标签的重复计数由 SW 聚合去重（见下第 3 条）。
>
> **数据源再修订（2026-08-26，M12 会话推送）**：M12 起徽标计数**改为 SSE 事件流优先**——面板经同源 `EventSource('/_manager/events')` 订阅（§8.10），事件到达即刷新计数并经既有 `attention` 上报（延迟从 ≤1s+30s 降为 <100ms），**SSE 存活期间不再 1Hz 打端点**；端点 `1Hz` 轮询作为回退；rc.2 起无可靠摘要则仅实例管理，不再 DOM 扫描。「计数与 popup 会话区同源」性质不变（SSE 与 `/_manager/sessions` 共享同一 `buildItems`/同一状态判定）。

**行为规范（`extension/content/panel.js` 检测段 + `extension/background.js` 双载体渲染）**：

1. **检测（panel.js，只读；2026-08-24 数据源修订；2026-08-26 M12 再修订）**：与面板共注入（同一指纹激活）。**SSE 优先（2026-08-26 起）**：面板订阅同源 `EventSource('/_manager/events')`（§8.10 M12），事件到达即更新计数并走下述状态机/上报；**SSE 未存活时才回到「每 1s 取一次计数快照」**路径。快照路径**端点优先**：同源 `fetch('/_manager/sessions')`（1.5s 超时，失败静默；只读摘要元数据，与 §8.10 同口径，不读消息内容/文本）→ 统计 `items` 中 `state==='working'` / `state==='waiting'` 的数量；端点不可用（插件未装/旧版/网络失败）时仅保留实例状态，清本标签陈旧会话信号并复位完成基线，不扫描 DOM 或将未知当成完成。状态机：`idle → working →(稳定 1.2s 空态)→ done-fired`；`任意 → waiting-fired`（waiting 出现立即上报，优先级覆盖 done）。等待用户 outranks 工作进行中（用户侧语义：需要拍板 > 继续观察）。注：隐藏页定时器被 Chrome 节流至 1Hz，取 1s 周期与节流上限对齐；端点快取在途（超时最长 1.5s > 1s 周期）时跳过重叠 tick；SSE 事件驱动路径不存在该节流问题（事件即达）。
2. **触发即上报（页面隐藏时；计数签名变化才发）**：仅在 `document.hidden === true`（标签不活跃或窗口最小化）时上报；`set`: `{type:'attention', op:'set', kind:'idle'|'working'|'waiting'|'done', counts:{working,waiting}}` → SW；**waiting:0→working:0 的计数签名（`waiting:working`）变化即上报**（蓝 n 常驻概览的数据源），`done` 为工作→空闲稳定 1.2s 的事件上报；SW 侧 `sender.tab.id` 为事实键（多个 dsh 标签页各记各的）。**页面重新可见即发 `op:'clear'`**（防「用户已在看却仍挂提醒」）。
3. **SW 侧（background.js）**：`attentionMap`（storage.local，`{ [tabId]: {kind, working, waiting, at, port} }`）持久化——MV3 SW 可回收，徽标状态以 storage 为事实源；`tabs.onRemoved` 清理；**同标签导航离开 dsh（tab 未关闭）由 `tabs.onUpdated` 按 URL 判定清理（M8 修补 M2，content script 侧 pagehide 亦发 clear 双保险）**；`onStartup`/`onInstalled` 清空（浏览器重启/扩展更新后的旧提醒无意义，沿用占位即可）；4 小时 TTL 防僵尸键（兜底，不影响正常使用）。**同实例多标签去重（2026-08-24 修订）**：聚合前按条目 `port` 归并——同端口只保留 `at` 最新条目（idle 无信号条目不参与同端口竞争，保持「空=安静」语义）；无端口条目（外部/旧数据兼容）按 tab 独立参与。徽标渲染优先级：**waiting（黄「?」#f59e0b，M10.1 定稿）> done（绿「!」#22c55e，M10.1 定稿——原琥珀!随「完成」定稿改绿）> working（蓝 n #5686fe，n≥10 显示「9+」）**；文字色显式 `#ffffff`。**死提醒联动（M8.1 修补）**：refreshBadge 判定实例未运行/异常时，按条目 `port`（上报时从 tab.url 解析）清除对应端口的会话信号——此前「实例已停、黄?/绿! 仍挂 4h TTL」的误导场景。title 同步：等待/完成/工作三条文案 + 服务态（角标层）title。
4. **设置**：`settings.attention`（默认 `true`，popup 设置面板「界面」分组开关「徽标提醒（回来看看）」）——关闭后 SW 忽略 set 且清空累积条目（`handleAttention` 的 set 分支以前置判断拒绝 + storage.onChanged 在开关变 off 瞬间清空 attentionMap），否则关闭期间的条目会在重开开关时冒出一条「凭空」提醒（H1 修补；M8.1 盲审补正：清理以**本次变化的权威值**为基——单次 set 同时改 settings+attentionMap 时 onChanged 回调内 settings 分支先于 attentionMap 分支、快照条目尚未入内存，旧实现会清理扑空，且 newValue 旧快照会把已删条目恢复回内存，已加 purged 防恢复）。`settings.attentionDone`（默认 `true`，「徽标：工作完成提醒（绿!）」独立开关）——已上表的 done 事件单独可关，waiting/working 不受影响；关闭瞬间同样剔除既有 done 条目（H1 对称修补），期间 done 也不会被新写入（set 分支前置拒绝）。
5. **防误报**：① 完成判定需空态稳定 1.2s（React 重渲染/点阵属性瞬时抖动被吸收）；② 工作→空闲→再工作 可再次上报（每次真实完成都提醒，cooldown 由「见到新 working 才复位」保证——done-fired 后须再观测到 working 才可能再次 done-fired）；③ sending 失败（SW 休眠/唤醒竞态）静默吞掉（storage 缓存与下游 clear 自愈）。
6. **局限（v1 接受并记录）**：端点路径下徽标计数与 popup 会话区同源一致（2026-08-24 起）；DOM 回退路径（插件未装/旧版/端点失败）保留历史局限：会话侧栏**完全关闭**（sidebar 宽度 0，行组件卸载）时无标记可扫，检测不可用（默认布局与窄屏 rail 均渲染行，仅完全关闭受影响）；用户仅 alt-tab 到其他应用（窗口未最小化、标签仍是活动标签）时 `document.hidden` 为 false，不触发——这是浏览器页面可见性语义，无法绕过；**蓝 n 仅在至少一个 dsh 页面存在且后台时可用**（无页面=无会话信息=徽标空，∈双向分层）。
7. **安全**（§12.2 补充）：端点路径只读 `/_manager/sessions` 的**摘要元数据**（sessionId/标题/四态/时间戳，与 popup 会话区间源同口径，不读消息内容/文本——§8.10 已定「摘要」边界），仅同源请求（页面 origin = 实例 origin；插件 `allow()` 围栏对回环 + 同源放行，§12.1）；DOM 回退路径只读两个语义属性（存在性/计数判定），不读取/采集页面 DOM 内容与消息文本；上报消息只含 kind（四值枚举）+ 计数值 + 端口（从 tab.url 解析）；SW 只接受带 `sender.tab` 的上报（扩展自身页面无 tab，不可伪造他 tab），**并校验 `sender.tab.url` 为 dsh 回环页**（127.0.0.1/localhost，本扩展 host_permissions 恰好覆盖，无新增权限）；无新增权限与 host_permissions。

#### 8.9.1 三层颜色语义分层（避免跨载体混淆，2026-08-22 用户决策）

三处视觉载体属于**两个不同语义层**，颜色与字符的「主语义载体」不同，必须明确区分：

| 载体 | 层级 | 主语义载体 | 语义色表 |
|---|---|---|---|
| **图标角标**（setIcon 变体） | 实例状态层（服务生命周期） | **颜色**（角标点） | 绿=运行中、红=错误/未装宿主、无点=停止 |
| **工具栏徽标** | 会话状态层（全局聚合，任意 dsh 标签） | **字符**（`?` 等你/待确认 / `!` 完成待办 / `n` 工作中数 / 空 安静） | **黄=等待**（`#f59e0b`，M10.1 定稿）、**绿=完成**（`#22c55e`，M10.1 定稿——原琥珀「!」随「完成」定稿改绿）、**蓝=工作中**（#5686fe webui 同源）、空=安静 |
| **popup 状态卡圆点** | 状态展示层（服务生命周期） | **颜色** | 绿=运行/健康、蓝=外部实例、琥珀=启动停止过渡、红=错误、灰=已停止 |
| **页面内胶囊 chip dot** | 状态展示层（**本页**托管实例） | **颜色** | 同上 + 灰=未托管/端口不匹配、红=连续失败 |
| logs 页状态点 | 状态展示层（运行状态） | **颜色** | 绿/红/灰 |

**约定（防混淆的硬规则）**：
- **红色只属于「错误」语义**（状态层）；徽标提醒层**不使用红色**。（2026-08-22 用户决策原立「紫=等你拍板专用」；M10.1（2026-08-24）用户实机观察 Web UI **计划面板=黄色**并定稿：等待语义改琥珀黄 `#f59e0b`——**紫色退出默认色板**（不再专语义），「等你」与「完成待办」在不同载体上以字符（? / !）区分，与「琥珀=完成待办」原约定同法。）
- **琥珀**在徽标=等待（`?`）/完成待办历史配色由**绿**取代（M10.1 定稿）、在状态层=过渡态（busy）——互不同时出现视觉冲突：状态层琥珀仅在 popup/面板内；徽标层靠字符（? / !）天然区分。
- **徽标（会话层）与图标角标（实例层）双载体并存、互不覆盖**：看到徽标「?」应理解为「某个 dsh 页面有状态变化」（实例是否在跑看角标点）；实例状态卡/胶囊是**单实例视图**——具体信息请点开 popup/对应页面查看。
