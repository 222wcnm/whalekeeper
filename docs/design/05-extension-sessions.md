# 会话感知与扩展边界

[返回设计规格索引](../design.md) · 原规格 §8.10–8.12

---

## 8. 浏览器扩展设计（会话与边界）

### 8.10 扩展面板会话状态（M9，路径 3：dsh 插件侧只读端点）

**目标（2026-08-22 用户需求 + 决策）**：把扩展管理的实例（含接管实例，§6.6/§6.7）的**运行会话状态**放进 popup——只查状态（进行中/等你拍板/已完成/空闲），不查看会话内容。用户决策：**直奔路径 3**（dsh host 插件侧新增只读端点，而非扩展侧 DOM 扫描或宿主直连官方 /api）。

**事实基线（2026-08-22 本地包核验）**：
- 官方 `POST /api/session.list`（dsh-host-apiproxy）返回 `sessionSummarySchema`：`sessionId/updatedAt/running/blank/parentSessionId/origin/cwd/agentPreset/projections`——**无 title、无 pendingInteraction**（等待语义不在列表 RPC 上；详情经按会话查询）。
- `/api` 围栏 = 只收 `application/json`（浏览器必发预检、服务器不应答 → **扩展/网页直连被拒**）；native host 是 Node fetch（无 CORS），技术上可直连——但**路径 2（宿主直连官方 API）被否决**：官方 API 无稳定性承诺（基线 0.1.0-rc.6）、等待语义取不到、宿主与 dsh 内部形状耦合加深。
- dsh-lifecycle 插件（§7）已实证：host 插件 `ctx.get('webServer')` 注册 loopback 围栏端点（`allow()`：remoteAddress 回环 + Host 回环 + sec-fetch-site 拒跨站 + Origin 同源），扩展→宿主→HTTP 链路无 Origin 天然合规。
- apiproxy 源码显示 host 侧服务面含 `workspaceRegistry / sessionQuery / sessions / sessionTitle` 等（**具名与可用性实施期 spike 确认**）。
- **M9.1 spike 结论（2026-08-23，0.1.1-rc.2 事实基线）**：主机侧全部信号均可权威读取，无需依赖 apiproxy 内部状态：
  - 会话清单：`ctx.sessions.list()`（live 会话，创建序）、`sessions.get(id)`、`sessions.flush(session)`（dsh-session 服务已核验）；
  - running：`ctx.get('agents')?.get(id)?.status === 'running'`——与 apiproxy `summarizeAttached` 同款判定；
  - title：fold 会话事件流中 `session/title` 事件（`events.findLast(e => e.type === 'session/title')?.data.title`，该事件由 session-title 服务 append，内容已归一化）；无标题事件 → 降级「会话 #<id 前 8>」。**不依赖 sessionTitle 服务本身**（事件流是唯一权威），避免服务缺挂时插件挂起；
  - waiting：事件流判定——`approval/asked`（data.id）无匹配 `approval/decided`（apiproxy 1909-1918 同款回扫逻辑）→ 等待审批；或 `tool/call`（name=`ask_user_question`，dsh-tool-ask-user 工具）无匹配 `tool/result`（callId 配对）→ 等待问答（**M12.1 修订 2026-08-26：新增 `exit_plan_mode` 工具配对 → 等待计划审查**，见下）。
  - completed：events 含 `turn/end` 且非 running 非 pending（webui 侧为客户端 running 边沿推断，host 侧以 turn/end 存在性等价近似）；
  - idle：其余（blank / 无 turn/end）。
  - **范围决策**：v1 端点只返回 **live（attached）会话**——§8.10 验收 e2e 场景（start → 当前会话行 → 状态流转）即 live；冷会话（历史）状态恒为 completed/idle、title 需读持久化，价值低且增加读盘成本，留给后续增强。
  - **idle 实际存在性注记（2026-08-24 用户实机观察）**：新会话默认**不在** Web UI 会话列表；创建后才出现，但**若未发送任何内容就离开该会话，它不会存在**（不保留下落）。即"空壳会话"（blank）在 live 集合里实际不出现——idle 的典型场景进一步收窄为"已承载内容但从未完成过任意一轮"的边角情形（近零出现）；这也解释了用户"空闲没用"的直觉（Web UI 本体同样不分 idle/completed，统一 data-state=done）。倾向：若后续优化，以 popup 折叠/弱化 idle 为优先（不动契约）。
  - **M12.1 补正（2026-08-26 用户实机反馈：计划待审显示为「进行中」而非「待确认」；本会话事件流实测）**：plan-review 的 Web UI 「计划待审」面板由**客户端帧**驱动——`dsh-plan-mode` 的 `exit_plan_mode` 工具执行体经 `ctx.userQuestions.ask({questions:[{intent.kind:'plan-review'}]})`（dsh-plan-mode L286-311）发出 `question/requested` **客户端 UI 帧**（dsh-client-runtime），**不进服务端 session 事件流**（本会话 31 种事件类型无 question 类，实证）；服务端唯一权威信号 = **`exit_plan_mode` 工具的 call↔result 配对**（提交计划即调用并阻塞等待，用户确认/拒绝后 result 才 append——实测时序 11:42:51 `tool/call` → 11:44:28 `tool/result`）。**修正**：`hasPendingInteraction` 工具配对白名单由 `ask_user_question` 扩为 `ask_user_question | exit_plan_mode`；**不可**用 `plan/mode {active:true}` 单独判等待（该事件从"模型正在写计划"阶段即 true，早于 wait 语义对应的 question/requested 帧时刻——双条件冗余且不如 call↔result 精确）。「拒绝/继续规划」路径 result（含错误）照常 append，闭合成非等待，语义与客户端 pendingInteraction 清除对齐。
- **rc.1 适配注记（2026-09-04，§2.1.1 B5）**：dsh ≥ 0.1.2 起 `Session.events` 数组属性移除，插件统一改 `session.snapshotEvents()` 读取事件流（返回数组形状同构）；`agents.get(id).status`、`session/created|disposed|event`、`agent/status`（`{agent,status}`，`agentEvents` 融合主体）、`subagent/*`、`session/title`、`turn/*`、`approval/*` 事件均存活（rc.1 源码复核）。
- **D1 决策（2026-08-23 定稿）**：扩展现有 `dsh-lifecycle` 包（同一安装/升级面、同一 cordis.patch.yml 挂载、单测/README 同源），不新建 `dsh-manager-sessions` 包。

**端点契约（设计定稿）**：

```
GET /_manager/sessions          （dsh 配套插件，lifecycle 同款 allow() 围栏；只读幂等）
200 → { ok: true, items: [ { sessionId, title?, state: 'working'|'waiting'|'completed'|'idle',
                             updatedAt, blank, cwd?, workspaceId?,
                             hasActiveChildren, childRuns: [ { childId, label? } ] } ] }
403 → 围栏拒绝；404 → 端点未注册（= 插件未装/版本过旧）；405 → 非 GET
```

- **契约演进（M11 定稿，子代理感知；M13.1 修正数据源）**：items 新增
  `hasActiveChildren`/`childRuns`（子代理感知）——活动子代理判定 = `subagent/start`（runId）
  无配对 `subagent/end`（配对判据权威：覆盖 cold-resume 新 epoch、孙子代链 end 延迟、
  中断/取消 end 照发）。**M13.1 数据源修正（2026-09-04，dsh 0.1.1-rc.2/0.1.2-rc.1 源码
  核验）**：`subagent/start|end` 只经事件总线（scoped dispatch，
  `packages/subagent/subagent/src/lifecycle.ts` observeRun）发布，**不写入父会话
  session log**——旧实现从 `sessionEvents()` 配对在真实环境恒空、popup 不显示子代理行。
  修复后插件以事件总线为权威源维护活跃子代理索引（父子关系经 `session/created` 的
  `header.parentSession` 反查，sdk/server.ts 同款），并保留会话日志配对（旧版 dsh/测试桩
  兼容）与 live 扫描兜底（插件热重载后：`origin='subagent'` + `parentSession` 匹配 + 子
  agent `status==='running'`，对齐 dsh list-children 的 activity 判定）。`label` 折叠自
  子代理会话自身 `subagent/descriptor` 事件的 label 字段（无则不返回，客户端降级显示
  「子代理」）。**origin='subagent' 会话不单独出列**（官方 Web UI 亦隐藏；运行状态归并进
  父行）。**官方归档对齐**：`archivedSessionIds` 命中即过滤；**但已归档且仍有活动子代理的
  会话保留**（感知优先：工作未真正结束）。workspaceRegistry 缺失部署自然降级为不过滤。

- `state` 映射：`running && pendingInteraction` → `waiting`（等待：批准/问答/计划审查）；`running` → `working`；`completed` → `completed`；其余 → `idle`。**契约仍为 4 态（后端完整语义）；M10.1（2026-08-24 用户定稿）扩展展示层只呈现 3 态**（遵循 Web UI 的区分：进行中/等待/完成——`idle` 不渲染：用户实机观察新会话默认不在列表、未发内容即离开则会话不存在，idle 在 live 集合近零出现，且 Web UI 本体也不区分 idle/completed（统一 data-state=done）；见上「idle 实际存在性注记」）。**字段缺失时降级**：title 不可得 → 会话行显示「会话 #<id 前 8>」；pendingInteraction 不可得 → `waiting` 不可判（仅 working/idle，如实标注）。**内容零读取**：端点只出摘要元数据，不读消息/事件体。
- 插件包形态：**D1 决策点**——扩展现有 `dsh-lifecycle` 包（同一安装/升级面，推荐）或新包 `dsh-manager-sessions`（语义命名更清晰，但多一个挂载/升级面）。

- **演示层（M11 定稿，UI 走查 V1 落地）**：`state` 契约仍 4 态；展示演进为 **四态感知**——`waiting`(待确认,琥珀黄) > `working`(进行中,蓝) / `completed+hasActiveChildren`(**已停止**,绿,主会话已停但子代理在跑,恒显不受时长/已读约束) > `completed` 无子代理(**已完成**,绿,仅"新鲜"显示);`idle` 不渲染。**新鲜 = 完成时刻距今 ≤ `settings.retentionMins`（默认 30，合法 5~1440，0 = 从不显示已完成）**。**已读机制（本地展示层，不触碰 dsh 数据）**：已完成行 hover 出现「已读」（原地微药丸「已读 · 撤销 3s」，倒计时结束落库 `readSessions`{sessionId:readAt} 并移除行；期内可撤销）；显示判定 `updatedAt > readAt`；会话重新活跃自动重现；再次完成后需再次已读。**子代理行**：父行下方缩进连接线 + 标签(label||「子代理」) + 「进行中」(蓝,shimmer)。排序：待确认 > 进行中/已停止 > 已完成；同组 updatedAt 降序。计数「N 活跃」= 主会话行数（子代理行不单独计数）。徽标口径：有子代理运行归入进行中（蓝 n 优先于完成提醒；**M13.1 落实：面板端点/SSE 两路计数均含 `completed+hasActiveChildren`**）。

**扩展侧**：
- host 新增只读 action `sessions`（§6.3 白名单 + SW `{type:'native'}` 通道复用，无新权限）；经宿主 fetch `http://127.0.0.1:<port>/_manager/sessions`（1.5s 超时，失败静默→会话区显示降级提示）。
- popup 新增「会话」区（状态卡下、操作区上，可折叠、默认展开）；会话行 = 标题 + **状态圆点色表（状态展示层扩展；M10 起色值走 `settings.colorMap` 语义变量；M10.1（2026-08-24）定稿三态三色：进行中=webui 蓝 #5686fe、等待=琥珀黄 #f59e0b（与 webui 计划面板黄色同构）、完成=绿 #22c55e；**idle 不渲染**（见上））**：蓝=进行中、黄=等待、绿=完成。**防混淆硬规则**：会话行**永远带文字状态词**（颜色是辅助；M10.1 定稿状态词：进行中 / **待确认** / 已完成——「等你拍板」口语祈使句正式化为「待确认」，2026-08-24 用户拍板）；「蓝=进行中」与顶层状态卡「蓝=外部实例」靠区域 + 文字区分（§8.9.1 表扩展注记）。**圆点动画与结构（2026-08-23 实机反馈补定，第二次修订，定稿）**：会话点为**分层圆点**（复刻 `.dot` 组件：外圈 10% 光晕 + 内实心——用户反馈「会话点没光晕」；**尺寸与实例点统一 10px**——M9 初版 8px 是次级元素旧尺寸，升级为同款组件后大小差不一致）；**四态全呼吸 2.2s**（用户决策：各颜色/状态都要呼吸；动画仅辅助，文字状态词仍为主语义——§8.9.1 防混淆规则不因动画弱化）；**呼吸全 popup 同步**（实例状态点 + 全部会话点同周期同相位——popup.js 以打开时刻（`BREATHE_T0`）为时钟零点，渲染时负 `animation-delay`（`--dot-align-delay`，注入元素 inline 变量，伪元素经 var() 继承）折算回零点相位，消除「CSS 动画自元素插入时起算」的天然相位差；实例点 className 不变时轮询不重设 delay（防动画重算跳变）；busy 脉冲（1.2s 秒级过渡态）不参与对齐）；`prefers-reduced-motion` 全局关闭。
- **行交互修订（2026-08-23 实机反馈，原「行点击 → 打开该实例 Web UI」撤回）**：实测发现 Web UI **无 URL 会话深链**（无 query/hash 路由，打开后恢复 localStorage 的「上次选中会话」）——行点击只能打开实例首页，落点首屏是**另一会话**（点 B 行却进 A 会话），构成误导交互。修订：**会话行为纯展示（无 role/tabindex/pointer/点击），导航交互收回给语义明确的「打开 Web UI」按钮**；「会话深链」列为后续增强（见下）。
- **会话深链（规划，属 §8.11 快速入口象限——是"带路"而非"会话内操作"）**：待 Web UI 支持 URL 定位指定会话（如 `?session=<id>` / hash 路由）后，行点击改为以 sessionId 打开指定会话的 URL；**在此之前不提供页面内模拟点击**（§8.6「页面唯一写操作=追加面板节点」与 §8.11 边界不变）。
- **降级**：插件未装/端点 404/HOST 未装 → 会话区显示中性提示「安装/升级 dsh 配套插件后可用」，不阻断其余功能（会话区隐藏而非报错）。

**验证（§14 扩展）**：插件单测（端点响应/围栏/幂等 + ctx 服务 mock）；宿主 smoke 新场景（fake-dsh 增 `/_manager/sessions` 应答；`sessions` 动作参数与超时）；verify-cdp popup 断言（mock SW 应答 → 会话区渲染 + 状态圆点 + 降级提示 + 行点击）；真实 dsh 实例 e2e（§14.2 追加步骤：start → 会话区出现当前会话行 → 状态随会话流转）。

**里程碑拆解**：M9.1 可行性 spike（临时 dsh 实例 + 探测插件打印 ctx 服务可用性与字段；确认 title/pendingInteraction 可读性）→ M9.2 插件端点 + 单测 + smoke → M9.3 host `sessions` + popup 会话区 + verify 断言 → M9.4 真实实例 e2e + §12.3 数据边界补充（会话元数据=只读摘要，不读消息体/凭据，范围不变）。

---

#### 8.10.1 M12 会话推送（SSE，2026-08-26 定稿）

**rc.2 修复契约（2026-10-18；覆盖下文旧恢复描述）**：新 SSE 连接不得单独前移共享
广播基线：已有客户端时先用同一当前快照广播语义差异，再给新客户端 snapshot；首连接
初始化基线。子会话 dispose 先保存父关联、删除活跃索引，再计算父摘要，迟到 end 幂等。
浏览器收到有效 snapshot 才视为 live，任何 error 立即取消 live、关闭旧流，15 秒退避；
5 秒无 snapshot 同样恢复，可见/隐藏都重试。回调绑定连接代次，旧流/旧 HTTP 响应不得
覆盖新快照。失联清本标签陈旧提醒并复位完成状态，未知不等于完成，不得产生假的 !。
HTTP 摘要是回退并刷新镜像，Popup native 2 秒保底保留；两端都不可用则只显示实例状态，
**不再全页扫描 data-state 生成精确计数或待确认**。摘要/SSE/镜像字段不变，无新权限。
会话行导航以 §8.2 为准：恢复只读，不保留伪 hash 深链。

**动机**：M9 后所有消费面都靠轮询——popup 2s（native 往返：每次 spawn 宿主进程 + 状态探测 + 端点 1.5s 快取）、面板隐藏时 **1Hz/标签** 打 `/_manager/sessions`（贴着 Chrome 隐藏页节流上限）、徽标 30s alarms。会话状态切换（working→waiting approval、子代理 start/end、turn/end）的感知延迟 1s~30s 且空轮询消耗真实网络/进程开销。**目标**：状态变化由 dsh 宿主事件即时推送，0 延迟、0 空轮询。

**事件源（0.1.1-rc.2 源码核验，见 §2 M12 注记）**：Cordis 事件总线——`session/created` / `session/event`（append 同步触发，种子不发射）/ `session/disposed` / `agent/status`（`{status, agent}`）。插件挂载于 app 层（untagged），按 dsh-scope `scopeTarget` 语义**接收全部作用域会话事件**（与官方 apiproxy 订阅模式同构）。

**端点契约（设计定稿）**：

```
GET /_manager/events          （SSE；lifecycle 同款 allow() 围栏；只读；零依赖 Node http 原生写）
200 → text/event-stream:
  retry: 3000
  id: 1
  event: snapshot
  data: {"ok":true,"items":[ <与 /_manager/sessions 完全同形> ]}     ← 连接即快照（重连=重拿快照，无 Last-Event-ID 回放）
  ...
  id: N
  event: upsert
  data: {"session":<summary 行>}                                      ← 语义变化才推
  id: M
  event: removed
  data: {"sessionId":"session-xxx"}
  : ping                                                             ← 15s 心跳
403 → 围栏拒绝；405 → 非 GET；500 → sessions 服务不可用（与 GET /_manager/sessions 语义一致）
```

- **推送判定（防事件风暴）**：仅当 `state/title/blank/cwd/childRuns` **语义字段**变化才推送；**`updatedAt` 不参与 diff**（否则 `assistant/chunk` 每秒多次触发推送）。事件类型白名单：`approval/asked`、`approval/decided`、`tool/call`(name=`ask_user_question`)、`tool/result`、`turn/start`、`turn/end`、`subagent/start`、`subagent/end`、`session/title`；其余高频事件直接忽略。同会话 50ms 内多事件合并（debounce）。
- **派生与口径**：复用 `buildItems()`（与 `/_manager/sessions` 共享：`summarizeSession` 四态判定、`foldTitle`、`activeChildIds` 子代理配对、`foldChildLabel` 标签折叠、`workspaceRegistry` 归档过滤——**归档且无活动子代理的会话在 upsert 时按 removed 处理**，与 GET 端点「不出现该行」同语义）。
- **订阅生命周期**：`ctx.on(...)` disposer 纳入插件 dispose 数组；`connections` Set + `res.on('close')` 清理；写前守卫 `writableEnded/destroyed`；`connections.size===0` 时事件回调零重算；插件 dispose → `closeAllConnections()` 断流（webserver 既有行为）。
- **已知局限（v1 接受）**：webui 中归档集合变更**不实时推送**（快照/重连时收敛；归档操作发生在 webui 页面，页面打开即重连）；`/api/events.host` 官方通道不复用（426 WebSocket-only + waiting 需 mux 帧=含消息内容，违反 §12.2；见 §2 M12 注记）。

**消费路径（两级，均为合规路径）**：

| 消费面 | 链路 | 延迟 | 降级 |
|---|---|---|---|
| 页面面板/徽标（一级，收益主体） | 面板（content script，**同源页面**）`EventSource('/_manager/events')` → 事件即更新计数 → 既有 `attention` 上报 SW → 徽标/面板 | <100ms | SSE 失败 → 1Hz 摘要轮询；两者均不可用 → 仅实例状态，无 DOM 猜测 |
| popup 会话区（二级） | 面板事件 → SW `sessions-sync`（按端口去重）→ `storage.local.sessionsCache`（防抖 100ms）→ popup `storage.onChanged` 即时渲染 | <500ms | 无 dsh 标签/镜像缺失 → native `sessions` 2s 轮询（现状，为正确性保底） |

- **popup 不能直连**：`chrome-extension://` Origin 被 `allow()` 围栏拒绝（与 `/_manager/sessions` 相同）——镜像桥只经扩展内部 storage，**只存摘要 items（不读消息内容/文本，§12.2 边界不变）**；无宿主协议变更（§6.2 不动）、无新增权限。
- **SW 只接受带 `sender.tab` 的回溯校验**（url 为 dsh 回环页）——与 `attention` 上报同款 L3 加固；`sessionsCache` 随实例失活清理（与死提醒联动同点）。

**验证（§14 扩展）**：插件单测（快照/upsert/removed/diff 抑制/无关事件零帧/403/405/断连清理/dispose 断流/零连接零重算）；verify-cdp（Fetch 拦截扩展 `/_manager/events` 快速失败保持现有 mock 路径回归；新增 SSE 段——合成帧注入 → 徽标/面板 <1s 更新且无轮询网络请求）；真实实例 e2e（200+快照帧、状态流转 upsert、shutdown 断流）；人工（双标签后台 + approval → 徽标「?」<100ms）。

**客户端接收要求（契约注记，2026-08-26 实机破案补记）**：本端点**所有数据帧均带 `event:` 头**（`snapshot` / `upsert` / `removed`）。按 WHATWG EventSource 规范，带 `event:` 头的帧派发为**命名事件**，**永不触发 `onmessage`**（`onmessage` 只收无 `event:` 头的默认 message 事件）——消费方必须 `addEventListener('snapshot'|'upsert'|'removed')` 按命名事件接收，不得只依赖 `onmessage`。
实机教训（M12.2）：面板曾只挂 `onmessage` → `applySseFrame` 从未执行 → `sseMap` 恒空而 `sseAlive=true`（连接真实存在）→ 徽标全链路失效（working 蓝 n 与 waiting 黄? 均缺失）且永不回退 1Hz 端点轮询；popup 会话区因走 native `sessions` 2s 轮询（独立数据源）不受影响。verify 合成帧挂钩直接调 `applySseFrame` 绕过真实 EventSource 解析，此类「接收层」缺陷不会被 verify 暴露——**SSE 段验证须保留一路真实 EventSource 路径**（e2e/人工实测），不能只依赖合成帧注入。
真实帧 `e.data` 为裸对象（snapshot→`{ok,items}`、upsert→`{session}`、removed→`{sessionId}`），接收端须包成 `{event, data}` 形状再进入既有 `applySseFrame`；建议以 `onmessage` 兜底防御无 `event:` 头的默认帧（当前插件不发，防御未来契约漂移）。帧格式实证见 `.sse-witness.log`（id 递增 + `event:` 头 + 状态切换 upsert）。**2026-08-26 实机复测闭环**：重载扩展 + 刷新页面后，提问等待弹窗切后台 30s → 工具栏黄「?」出现，接收修复生效。

---

### 8.11 扩展能力边界（防「喧宾夺主」规范，2026-08-23）

> 本节的动机（用户提出）：扩展会随迭代膨胀——功能越加越多，就会不自觉去复制 dsh web UI 的职责，变成「第二个 dsh 客户端」；扩展应当**始终守在其专属的薄壳位置**。本节是所有新增功能（规划/实现/评审）的**强制对照表**。

**定位一句话**：DSH Manager 是 dsh web 的**管理仪表盘 + 遥控器**，不是第二个 dsh 客户端，更不是替代 web UI 的入口；「使用 dsh」永远回交 web UI，「管理 dsh 进程」才是扩展的正业。

**能力四象限（扩展应做的全部，能力地图）**：

| 象限 | 内容 | 说明 |
|---|---|---|
| ① 生命周期管理（核心专长） | start / stop / restart / adopt、端口回填、日志尾读、优雅停机链 | dsh 自身与 web UI **都不提供**的进程管理——这是本扩展存在的唯一理由 |
| ② 状态情报（摘要层） | 实例状态、健康富状态、会话四态摘要、徽标提醒 | **只做摘要、存在性、计数**；永远不做内容 |
| ③ 快速入口（薄壳） | 打开 Web UI、日志页、跳转 | 把「进一步使用」交回 web UI，扩展只负责带路 |
| ④ 安全护栏 | PID 复用校验、外部实例只读保护、跨宿主锁、回环围栏、两步确认 | 破坏性动作的护栏属于本扩展（双保险），但**绝不扩展护栏之外的权力** |

**不该做（红线，六条）**：

1. **不做会话内容体验**：不渲染会话历史 / 消息流 / 对话 UI / 附件预览——那是 web UI 的领域；扩展只出摘要行 + 跳转入口（M9 已确立「摘要粒度是上限」）。
2. **不做会话内操作**：不发起 prompt / steer / cancel / 模型选择 / 审批问答 / 计划审查等会话内动作——这些属于 dsh 客户端侧（web UI 或客户端插件生态）；扩展若做即复制 dsh client、绕过官方 `/api` 围栏并与其 UI 竞态。
3. **不替 dsh 做配置与编排**：不改 agent preset、不写 profile / settings、不代装代卸 dsh 插件（可做「检测 + 提示 + 跳转」，执行权在用户/终端/dsh 侧）。
4. **不做完整状态镜像**：完整会话列表、内容搜索、工作区浏览、冷会话历史——都留给 web UI（其本身已演进这些能力）；扩展的会话视图只限「live + 四态摘要」。
5. **不碰凭据 / 数据**：不读 `$DSH_HOME` 凭据、模型密钥、会话持久化文件、工作区内容（§12.3 数据边界，此处作为边界重申——「内容零读取」是硬线）。
6. **不越权管理任意进程 / 端口**：只管理「run 记录实例」+「指纹确认的外部 dsh」；绝不把 taskkill / 端口扫描 / 进程枚举泛化到「顺手的其他东西」（§12.1 攻击面收敛）。

**三问准则（新功能立项自检，全部通过才允许进规划）**：

1. 这是「**管理实例**」还是「**使用 dsh**」？→ 只做前者；后者一律回交 web UI。
2. 数据是「**摘要元数据**」还是「**会话内容**」？→ 只碰前者；内容零读取。
3. 缺了扩展，用户能否在 web UI / 终端完成这件事？→ 必须能（扩展是增强不是必需路径——生命周期管理除外，那是正业）；若「扩展独有才能做」且它属于使用体验 → 多半是走错了层（应下沉为 dsh 客户端插件/上游能力）。
4. （附加）破坏性动作：是否用户**显式触发** + 误触有**确认/护栏**？→ 停止两步确认、外部实例只读、PID 校验即此；新增破坏性能力必须自证满足。

**体积与权限纪律**：零依赖原生 JS、零远程请求；权限与 host_permissions 最小化，每新增一个 API 权限须在 §12 登记理由；不引入 UI 框架/图表库/图标包（内联令牌 + SVG 已覆盖）；扩展代码体量增长超阈值（功能数、约 3 年量级）时先做「哪块应下沉」的边界复核。

**演进流程**：任何新能力先在本篇标注**象限归属**并经本节对照；归属模糊时默认**拒收走「不下沉扩展」**（先问 dsh 侧/客户端插件生态；D1 模式——dsh 插件端点 + 扩展薄壳是既成范式）。

---

### 8.12 颜色语义自定义（颜色角色，M10 规划，2026-08-23 用户提出）

> 术语说明（2026-08-24 用户拍板）：设置面板 UI 标签为**「颜色角色」**（直观、点明"每种颜色承担一个角色"）；术语层为**语义色（semantic color）**——design token 标准语，代码 `--dsh-mgr-sem-*` / `settings.colorMap` 与本文标题沿用"颜色语义"表述。

**动机**：语义色表当前是硬编码约定（§8.9.1 / M7 / M9），用户希望可按偏好调整——典型诉求「任务结束（琥珀黄）改成绿色」。**先立规矩**：颜色永远是辅助载体，语义由字符/文字/图标承载（§8.9.1 硬规则不变）——改色不改义，把「完成」改绿后它仍是「完成」，只是表达色不同。

**规划调整（2026-08-23 用户决策）**：本表「默认色」取值均为**提案值**，**最终预设色板待 M10 自定义设置实现、用户实际体验调色后确定**——M10 先交付完整可自定义能力（`settings.colorMap` + 预设色板交互 + 恢复默认），体验阶段不改死任何默认色；定稿流程见节末。

**语义角色清单（可改 / 锁定；M10.1 定稿 2026-08-24——三态三色，遵循 Web UI 区分）**：

| 语义角色 | 承载载体 | 默认色（**定稿值**） | 可改？ |
|---|---|---|---|
| `waiting` 待确认 | 徽标「?」底、popup 会话区圆点 | **琥珀黄 `#f59e0b`**（M10.1 定稿——用户实机观察 webui 计划面板=黄色，等待语义取同色系；原紫经体验对比后放弃） | ✅（红撞色提示见下） |
| `working` 进行中 | 徽标「n」底、popup 会话区圆点 | **webui 蓝 `#5686fe`**（定稿；M10 统一双载体且经体验确认） | ✅ |
| `completed` 完成 | 徽标「!」底、popup 会话区圆点 | **绿 `#22c55e`**（定稿；**徽标完成提醒「!」随定稿改绿**——原琥珀，用户「完成是绿色，查看后不再显示绿色徽标」= 徽标完成提醒绿色 + 页面可见即清除（M8 行为不变）；`done` 事件角色并入 completed 色） | ✅ |
| ~~`done` 完成待办~~ | ~~徽标「!」底~~ | ~~琥珀 `#f59e0b`~~ | **已并入 completed**（M10.1 定稿：只显示三态；徽标「!」色取 completed；`attentionDone` 独立开关保留） |
| ~~`idle` 空闲~~ | ~~popup 会话区圆点~~ | ~~灰~~ | **已删除**（M10.1 定稿：idle 不再展示——live 集合近零出现 + Web UI 本体不区分，见 §8.10 idle 注记） |
| `error` 错误 | 全域（状态层/徽标角标/面板） | 红 `#ec1313` | 🔒 **锁定**（§8.9.1「红色只属于错误」；防语义毁坏） |
| 实例角标绿/红/无点 | 图标角标（setIcon PNG） | 绿/红 | 🔒 **v1 不改**（图标为预生成位图，改色=重生成；且绿=运行是大众语义） |
| 字符/文字（`?` `!` `n`、状态词） | 徽标字符、会话行文字 | — | 🔒 永不改（M10.1 用户问询 emoji 徽标后决定暂不引入；字符语义锁定规则维持） |

- **M10 顺带纠偏（已定稿）**：`working` 双载体默认色历史分歧（徽标蓝 `#5686fe` vs popup 会话区琥珀）→ 统一 webui 蓝，用户可改回琥珀。
- **撞色保护**：改 `waiting`/`completed` 为红色系时 toast 提示「与错误语义撞色（建议保留互斥色）」，但**允许**（主语义仍是字符/文字，颜色只是辅助；不硬拦）。

**交互形态**：popup 设置「界面」分组新增「颜色角色」子区（UI 标签；术语层=语义色 semantic color——design token 标准语，2026-08-24 用户拍板）——每个可改角色一行（M10.1：**仅 3 行**：待确认 / 进行中 / 完成）：语义标签 + 当前色块 + **预设色板**（复用 dsh 静态令牌色：蓝/琥珀/紫/绿/红/灰，圆形 swatch 点选即生效，同主题 cube 交互）；另有「恢复默认」按钮。保存进 `settings.colorMap`（`storage.local`，`DEFAULT_SETTINGS` 同步声明默认值）。

**生效范围（一处配置、全域同语义）**：
- popup 状态卡/hint、会话区圆点、面板胶囊 dot、logs 页状态点——以**语义角色 CSS 变量**（`--dsh-mgr-sem-waiting` 等）注入：`theme.js`（或新 colors.js，popup/logs 共用）读 `colorMap` 写 `:root`/`body` inline 覆盖，组件一律引用语义变量而非字面色值（M7/M9 教训：先立 token 再上色）。
- SW 徽标——`background.js` 渲染徽标时读 `colorMap`（已有 settings 读取路径，扩展 `SESSION_BADGES` 常量 → 运行时覆盖）。
- 面板（`content/panel.js`）——shadow DOM 内联样式按语义变量生成，经 storage 订阅实时同步（同 webuiTheme 镜像模式）。
- 图标角标 v1 不改（见锁定表）。

**约束**：只提供预设色板选择（不开放任意输入色值——省去对比度/深浅两套主题调优，色彩工程交给令牌体系）；预设色板保证浅/深主题均可见；**每处新用色必须走语义变量**（改色只动 `colorMap` 一处，禁止散落硬编码）。

**验收**：verify-cdp 新增断言——改色后 popup 会话区/状态卡圆点实际色变化 + 徽标 background 变化 + 面板 dot 变化 + 恢复默认还原；「改红触发撞色 toast」断言；字符语义（`?`/`!`/n/文字状态词）不受影响的回归断言。

**定稿流程（2026-08-23 用户决策；已于 2026-08-24 完成定稿——M10.1）**：M10 自定义设置交付 → 用户实际体验调色（`working` 琥珀/蓝、`done` 琥珀/绿、`waiting` 紫/黄对比）→ **用户确认最终预设色板**（2026-08-24：三态三色——进行中蓝 / 等待黄 / 完成绿；去 idle；done 并入完成色）→ 回填本表「默认色」为定稿值（已落实，见上表）→ 落实为 v1 默认（`DEFAULT_SETTINGS` / `SESSION_BADGES` 默认值）→ 新装与「恢复默认」用户即得最终色板。**定稿已完成：实现与默认值见 M10.1 交付记录（AGENTS.md 顶部）**。

**范围外（明确不做）**：字母/图标形状自定义、每会话独立配色、按主题（浅/深）分别配色、任意色值输入器。

**实施注记（M10 完成，2026-08-24；本节与实现合一后以代码为准）**：

- **生效范围取舍（关键）**：colorMap 严格按上方「语义角色清单」的**载体列**生效——`waiting`→徽标「?」底 + popup 会话区圆点、`done`→徽标「!」底、`working`→徽标「n」底 + 会话区圆点、`completed`/`idle`→会话区圆点。**状态展示层（popup 状态卡/面板胶囊 dot/logs 状态点）不随角色色改**（verify 显式断言「改色后实例圆点不变」）：§8.9.1 状态展示层的主语义载体是颜色本身（绿=运行/蓝=外部/琥珀=过渡/灰=停止/红=错误），若让会话角色色（如 idle 灰）联动实例层，用户把「空闲」改成绿色会把**已停止实例渲染成绿点**——实例层语义被用户配色毁坏，违背「改色不改义」。状态展示层继续走既有 alias 令牌（`--dsw-alias-state-*`，M6 起已是语义变量）；唯一集中化：error 红统一引用 `--dsh-mgr-sem-error`（锁定值 `#ec1313`）。「popup 状态卡/hint、面板胶囊 dot、logs 页状态点在生效范围列」按「均走语义变量（alias 令牌）」落实，不指可配色。
- **working 双载体统一（M10.1 定稿）**：默认值 = webui 蓝 `#5686fe`（`--dsw-static-deepseek-450`，徽标原值不变、popup 会话区由琥珀 `warn-label` 改蓝）——**用户体验后定稿**（2026-08-24）。
- **M10.1 定稿附加**（2026-08-24 用户拍板）：① waiting 默认色紫→琥珀黄 `#f59e0b`；② 状态词「等你拍板」→「待确认」；③ 五角色→三角色（done 并入 completed、idle 删除——popup 会话区只渲染 working/waiting/completed，idle 行不显示；`settings.colorMap` 键收敛，旧 5 键存储被 normalize 忽略）；④ verify-cdp 断言同步（M8 徽标黄?/绿!、M9 三态渲染 + idle 过滤、M10 三角色）。
- **新文件**：`extension/colors.js`（`window.DSHColors`，popup 页内联；结构同 theme.js：storage 订阅 + documentElement inline 变量 `--dsh-mgr-sem-<role>`；白名单色板，无任意输入）；`background.js` SW 侧 `normColorMap` 零依赖同口径（徽标渲染是纯字符串路径，不能引入页面脚本）。
- **验收**（verify-cdp，92/92）：改色后 popup 会话区/徽标底色实际变化 + 实例圆点不变 + 撞色 toast + 恢复默认还原（storage 键级比对）+ 字符语义（`?`/`!`/n/状态词/类名）回归。**注意：verify 默认 dsh URL 已更新为 3080**（此前 8080 为用户旧实例端口；实例在其它端口时 `VERIFY_DSH_URL` 覆盖）。

---
