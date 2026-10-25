// dsh-lifecycle — a DSH host plugin providing a loopback-fenced graceful
// shutdown endpoint, a health endpoint, and a read-only sessions-summary
// endpoint against the dsh web surface.
//
// Injected services (verified against @deepseek-ai/dsh@0.1.0-rc.6 source):
//   - webServer  `register({ kind, path, handler })` returns a disposer; its
//                `port` getter returns the OS-assigned listening port.
//   - appExit    `ctx.appExit(code)` is a graceful-dispose request: it triggers
//                the dsh fiber dispose (which closes the listening port) but
//                does NOT guarantee process exit. Process exit depends on the
//                event loop draining naturally; the Whalekeeper host treats port
//                closure as the authoritative signal and falls back to taskkill
//                when needed. It is NOT a bare process.exit.
//   - sessions   (optional, read via ctx.get) live session store: `list()`
//                returns attached sessions in creation order (docs/design.md
//                §8.10 M9.1 spike).
//
// A route handler receives Node http `IncomingMessage` / `ServerResponse`.
// The webserver dispatches `await route.handler(req, res)`; a handled exact
// route answers before the SPA fallback, so these paths never hit `/api`.

import { createResourceScope, publishReadiness } from './readiness.js'

export const name = 'dsh-lifecycle'
export const inject = ['webServer', 'appExit']

const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

// Security fence (self-managed; plugin routes bypass the /api trust fence).
// All of the following must hold for a request to be allowed, else 403:
//   - remoteAddress is loopback (127.0.0.1 / ::1 / ::ffff:127.0.0.1);
//   - Host header matches a loopback authority (optionally with :port);
//   - sec-fetch-site, when present and "cross-site", is rejected — aligned
//     with the official /api fence `isTrustedApiRequest`
//     (dsh-client-connection/lib/index.js), which rejects cross-site before
//     the Origin same-origin check;
//   - Origin, when present, must be same-host as the Host header.
function allow(req) {
  if (!isLoopback(req.socket.remoteAddress ?? '')) return false
  const host = req.headers.host ?? ''
  if (!LOOPBACK_HOST.test(host)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  return true
}

// Route boilerplate shared by every endpoint: fence first, then the method
// check (405 with Allow). Returns false when the request was answered and the
// handler must return immediately.
function routeGuard(req, res, method) {
  if (!allow(req)) {
    res.writeHead(403)
    res.end()
    return false
  }
  if (req.method !== method) {
    res.writeHead(405, { allow: method })
    res.end()
    return false
  }
  return true
}

// Archived-session id set, or null when the registry is absent (no filtering).
function archivedSessionIds(ctx) {
  const workspaceRegistry = ctx.get('workspaceRegistry')
  return (workspaceRegistry && Array.isArray(workspaceRegistry.archivedSessionIds))
    ? new Set(workspaceRegistry.archivedSessionIds)
    : null
}

// Session 事件数组的版本兼容读取（§2.1.1 B5）：
// dsh < 0.1.2（rc.2 及更早）的 live Session 暴露 `.events` 数组属性；
// dsh >= 0.1.2（alpha.4 起，rc.1 确认）移除该属性，改为 `snapshotEvents()` 方法。
// 两者都缺时回退空数组（静默降级，绝不让单条会话拖垮端点）。
function sessionEvents(session) {
  if (session == null || typeof session !== 'object') return []
  if (Array.isArray(session.events)) return session.events
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  return []
}

// Fold the latest session title out of the event stream. The `session/title`
// event is appended by the official dsh-session-title service and its payload
// is already normalized; this plugin reads the event stream directly instead
// of depending on the service, so the endpoint also works on deployments that
// mount no title provider.
function foldTitle(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.type !== 'session/title') continue
    const title = event.data?.title
    return typeof title === 'string' && title.length > 0 ? title : undefined
  }
  return undefined
}

// True when the session log shows an open question or approval wait — the
// host-side equivalent of the webui client's pending-interaction tracking
// (docs/design.md §8.10 M9.1 spike):
//   - approval: an `approval/asked` whose id has no matching `approval/decided`
//     (same blind scan the official api-proxy performs, §8.10 spike);
//   - question/plan-review: an open tool call awaiting the user — the
//     `ask_user_question` tool (question) or the `exit_plan_mode` tool
//     (plan review: dsh-plan-mode blocks on `userQuestions.ask` while the
//     webui shows the 计划待审 panel; the plan/mode event alone is NOT the
//     wait signal — it is true from the moment plan writing starts).
//     callId pairing: tool/call.data.callId vs
//     tool/result.data.message.source.callId. Ordinary tools (pwsh/edit/...)
//     running do NOT count — working is not waiting.
function hasPendingInteraction(events) {
  const asked = new Set()
  const decided = new Set()
  const pendingCalls = new Map()
  const answeredCalls = new Set()
  for (const event of events) {
    if (event.type === 'approval/asked') {
      const id = event.data?.id
      if (typeof id === 'string') asked.add(id)
    } else if (event.type === 'approval/decided') {
      const id = event.data?.id
      if (typeof id === 'string') decided.add(id)
    } else if (event.type === 'tool/call') {
      const callId = event.data?.callId
      const toolName = event.data?.name
      if (typeof callId === 'string' && (toolName === 'ask_user_question' || toolName === 'exit_plan_mode')) pendingCalls.set(callId, true)
    } else if (event.type === 'tool/result') {
      const callId = event.data?.message?.source?.callId
      if (typeof callId === 'string') answeredCalls.add(callId)
    }
  }
  for (const id of asked) if (!decided.has(id)) return true
  for (const callId of pendingCalls.keys()) if (!answeredCalls.has(callId)) return true
  return false
}

// Compatibility fallback for old/test session logs containing run edges. Real
// dsh publishes these on the event bus, not the log; the live index below is
// authoritative and this fold must not replace its lifecycle ownership.
function activeChildIds(events) {
  const started = new Map() // runId -> child session id
  const ended = new Set() // runIds that settled
  for (const event of events) {
    if (event.type === 'subagent/start') {
      const runId = event.data?.runId
      const childId = event.data?.id
      if (typeof runId === 'string' && typeof childId === 'string') started.set(runId, childId)
    } else if (event.type === 'subagent/end') {
      const runId = event.data?.runId
      if (typeof runId === 'string') ended.add(runId)
    }
  }
  const ids = new Set()
  for (const [runId, childId] of started) if (!ended.has(runId)) ids.add(childId)
  return [...ids]
}

// ---------------------------------------------------------------------------
// 子代理活跃索引（M13.1 修复，2026-09-04；design §8.10 契约注记）
// ---------------------------------------------------------------------------
// dsh 0.1.1-rc.2 与 0.1.2-rc.1 源码核验（packages/subagent/subagent/src/
// lifecycle.ts observeRun）：`subagent/start|end` 只经事件总线（scoped
// dispatch）发布，**从不 append 进父会话的 session log**（全库仅
// `subagent/descriptor`/`sandbox/mode`/`approval/policy` 等写入子会话 log）。
// 旧实现从 `sessionEvents()` 配对 → 生产环境 childRuns 恒空、popup 不显示
// 子代理行（单测用 mock events 数组所以全绿）。修复：以事件总线为权威源，
// 父子关系经 `session/created` 的 `header.parentSession` 反查（sdk/server.ts
// 同款模式），并保留会话日志配对 + live 扫描做兼容/冷恢复兜底。
//
// 三路信号合并（按 childId 去重）：
//   ① 事件总线索引（activeByParent：父 → runId → childId）——真实 dsh 权威源；
//   ② 会话日志配对（activeChildIds）——旧版 dsh / 测试桩兼容；
//   ③ live 扫描：插件热重载后索引为空时，origin='subagent' 且父会话匹配且
//      子 agent status==='running' 的会话视为活跃（对齐 dsh list-children 的
//      activity 判定，control.ts）。
function liveParentOf(sessions, childId) {
  for (const s of sessions?.list?.() ?? []) {
    if (s?.id === childId && s.header?.origin === 'subagent' && typeof s.header.parentSession === 'string') {
      return s.header.parentSession
    }
  }
  return undefined
}

function removeChildFromActive(activeByParent, parentId, childId) {
  const byRun = activeByParent.get(parentId)
  if (byRun === undefined) return
  for (const [runId, cid] of byRun) {
    if (cid === childId) byRun.delete(runId)
  }
  if (byRun.size === 0) activeByParent.delete(parentId)
}

function activeChildRuns(parentId, sessions, agents, childLabelBy, activeByParent, events = sessionEvents(sessions?.get?.(parentId))) {
  const ids = new Set()
  const byRun = activeByParent.get(parentId)
  if (byRun !== undefined) {
    for (const childId of byRun.values()) ids.add(childId)
  }
  for (const childId of activeChildIds(events)) ids.add(childId)
  if (ids.size === 0 && sessions?.list) {
    for (const s of sessions.list()) {
      if (s && s.header?.origin === 'subagent'
        && s.header.parentSession === parentId
        && agents?.get?.(s.id)?.status === 'running') {
        ids.add(s.id)
      }
    }
  }
  return [...ids].map((childId) => ({
    childId,
    ...(childLabelBy?.get?.(childId) !== undefined
      ? { label: childLabelBy.get(childId) }
      : {}),
  }))
}

// Fold the child's task label out of its own `subagent/descriptor` event (the
// durable, model-hidden composition record). The first descriptor is
// authoritative; `label` is optional by contract.
function foldChildLabel(events) {
  for (const event of events) {
    if (event.type !== 'subagent/descriptor') continue
    const label = event.data?.label
    if (typeof label === 'string' && label.length > 0) return label
  }
  return undefined
}

// Derive the four-state session summary the extension renders
// (docs/design.md §8.10): waiting > working > completed > idle.
// `childRuns` is computed by the caller via activeChildRuns() (M13.1: the
// event-bus index is the authoritative source; see note above).
function summarizeSession(session, agents, childRuns, events = sessionEvents(session)) {
  const running = agents?.get?.(session.id)?.status === 'running'
  let state = 'idle'
  if (hasPendingInteraction(events)) state = 'waiting'
  else if (running) state = 'working'
  else if (events.some((event) => event.type === 'turn/end')) state = 'completed'
  // M13.1：无 turn/end 但仍有活跃子代理（如冷恢复的父会话）→ 归入「进行中」，
  // 与「有子代理运行归入进行中」定稿一致（否则 popup 按 idle 隐藏整行）。
  else if (childRuns.length > 0) state = 'working'
  let updatedAt
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const time = events[i]?.time
    if (typeof time === 'number') { updatedAt = time; break }
  }
  if (updatedAt === undefined) updatedAt = session.header?.createdAt ?? Date.now()
  let blank = events.length === 0
  for (const event of events) if (event.type === 'turn/start') { blank = false; break }
  const title = foldTitle(events)
  return {
    sessionId: session.id,
    ...(title !== undefined ? { title } : {}),
    state,
    updatedAt,
    blank,
    hasActiveChildren: childRuns.length > 0,
    childRuns,
    ...(session.header?.cwd !== undefined ? { cwd: session.header.cwd } : {}),
  }
}

// Live-session child-label index: subagent sessions fold their own
// `subagent/descriptor` label; unlabelable child runs fall back to no label
// (the client renders '子代理').
function buildChildLabelMap(live) {
  const childLabelBy = new Map()
  for (const child of live) {
    if (!child || typeof child !== 'object') continue
    if (child.header?.origin !== 'subagent') continue
    const label = foldChildLabel(sessionEvents(child))
    if (label !== undefined) childLabelBy.set(child.id, label)
  }
  return childLabelBy
}

// The full listing payload shared by GET /_manager/sessions and the SSE
// snapshot — one derivation, two views, so the poll and push surfaces can
// never drift (subagent sessions never row; archived sessions without
// running children are omitted, archive masters WITH running children stay).
function buildItems(ctx, sessions, agents, activeByParent) {
  const live = sessions.list()
  const childLabelBy = buildChildLabelMap(live)
  const archivedIds = archivedSessionIds(ctx)
  const items = []
  for (const session of live) {
    if (!session || typeof session !== 'object') continue
    if (session.header?.origin === 'subagent') continue
    try {
      const events = sessionEvents(session)
      const childRuns = activeChildRuns(session.id, sessions, agents, childLabelBy, activeByParent, events)
      const summary = summarizeSession(session, agents, childRuns, events)
      if (archivedIds !== null && archivedIds.has(session.id) && summary.childRuns.length === 0) continue
      items.push(summary)
    } catch {
      // One malformed session must never take down the whole listing.
    }
  }
  return items
}

// Semantic diff that gates SSE pushes. `updatedAt` is deliberately excluded:
// every `assistant/chunk` would otherwise re-push a session that has not
// actually changed visible state. childRuns is a tiny JSON array — JSON is
// the simplest exact comparison here.
function summariesEqual(a, b) {
  return a.state === b.state
    && a.title === b.title
    && a.blank === b.blank
    && a.cwd === b.cwd
    && a.hasActiveChildren === b.hasActiveChildren
    && JSON.stringify(a.childRuns ?? []) === JSON.stringify(b.childRuns ?? [])
}

// Session-event types that can change a summary's semantic fields. Pushing
// on any of these and diff-suppressing afterwards keeps the SSE surface at
// transition granularity while ignoring the high-frequency chunk floods.
const RELEVANT_EVENT_TYPES = new Set([
  'approval/asked',
  'approval/decided',
  'tool/result',
  'turn/start',
  'turn/end',
  'subagent/start',
  'subagent/end',
  'session/title',
])

export function apply(ctx) {
  // Cordis constructs ordinary apply functions and does not collect their
  // return value. The mount effect must own cleanup before any acquisition.
  const scope = createResourceScope(ctx, 'dsh-lifecycle')
  const connections = new Map() // response -> idempotent release
  const summaryBy = new Map() // last state delivered to all current clients
  const pending = new Map() // session id -> debounce release
  const childParentBy = new Map()
  const activeByParent = new Map()
  let exiting = false // private to this mount, never shared with another one
  let frameId = 0

  scope.add(() => {
    connections.clear()
    summaryBy.clear()
    pending.clear()
    childParentBy.clear()
    activeByParent.clear()
  })
  const sseFrame = (event, data) => {
    frameId += 1
    return `id: ${frameId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  }
  function writeAll(line) {
    for (const [res, release] of connections) {
      if (res.writableEnded || res.destroyed) { release(); continue }
      try { res.write(line) } catch { release() }
    }
  }
  function broadcast(event, data) {
    if (scope.disposed || connections.size === 0) return
    writeAll(sseFrame(event, data))
  }
  function removed(sessionId) {
    if (!summaryBy.delete(sessionId)) return
    broadcast('removed', { sessionId })
  }
  function upsert(summary) {
    const prev = summaryBy.get(summary.sessionId)
    if (prev !== undefined && summariesEqual(prev, summary)) return
    summaryBy.set(summary.sessionId, summary)
    broadcast('upsert', { session: summary })
  }

  // Mirrors GET: child sessions never get rows and archived parents disappear
  // only after their active children settle. No clients means no derivation.
  function recompute(sessionId) {
    if (scope.disposed || connections.size === 0) return
    const sessions = ctx.get('sessions')
    if (sessions === undefined) return
    const session = sessions.get?.(sessionId)
    if (session === undefined || session === null) { removed(sessionId); return }
    if (session.header?.origin === 'subagent') return
    const agents = ctx.get('agents')
    let summary
    try {
      const events = sessionEvents(session)
      const childRuns = activeChildRuns(sessionId, sessions, agents, buildChildLabelMap(sessions.list()), activeByParent, events)
      summary = summarizeSession(session, agents, childRuns, events)
    } catch {
      return
    }
    const archivedIds = archivedSessionIds(ctx)
    if (archivedIds?.has(sessionId) && summary.childRuns.length === 0) removed(sessionId)
    else upsert(summary)
  }
  function scheduleRecompute(sessionId) {
    if (scope.disposed || connections.size === 0 || pending.has(sessionId)) return
    let timer
    const release = scope.add(() => {
      if (timer !== undefined) clearTimeout(timer)
      pending.delete(sessionId)
    })
    pending.set(sessionId, release)
    try {
      timer = setTimeout(() => { release(); recompute(sessionId) }, 50)
      timer.unref?.()
    } catch (error) { release(); throw error }
  }
  function clearPending() {
    for (const release of pending.values()) release()
  }

  // One current snapshot is used BOTH for catching existing clients up and
  // initializing the newcomer. Never silently advance the global baseline.
  function synchronizeSnapshot(items) {
    clearPending()
    const next = new Map(items.map(item => [item.sessionId, item]))
    if (connections.size > 0) {
      for (const id of [...summaryBy.keys()]) if (!next.has(id)) removed(id)
      for (const item of items) upsert(item)
    }
    summaryBy.clear()
    for (const [id, item] of next) summaryBy.set(id, item)
  }
  function register(spec) {
    scope.acquire(() => ctx.webServer.register(spec))
  }
  function listen(event, callback) {
    scope.acquire(() => ctx.on(event, (...args) => {
      if (!scope.disposed) callback(...args)
    }))
  }

  try {
    // Heartbeat and every dynamically created timeout/socket use the same
    // resource stack. Completed resources detach instead of accumulating.
    let heartbeat
    scope.add(() => { if (heartbeat !== undefined) clearInterval(heartbeat) })
    heartbeat = setInterval(() => {
      if (!scope.disposed) writeAll(': ping\n\n')
    }, 15000)
    heartbeat.unref()

    register({
      kind: 'exact',
      path: '/_lifecycle/health',
      handler: async (req, res) => {
        if (!routeGuard(req, res, 'GET')) return
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          ok: true,
          pid: process.pid,
          uptimeMs: Math.round(process.uptime() * 1000),
          port: ctx.webServer.port ?? 0,
          nodeVersion: process.version,
        }))
      },
    })
    register({
      kind: 'exact',
      path: '/_lifecycle/shutdown',
      handler: async (req, res) => {
        if (!routeGuard(req, res, 'POST') || scope.disposed) return
        if (exiting) {
          res.writeHead(409, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'shutdown already in progress' }))
          return
        }
        exiting = true
        // The response must flush before shutdown, but disposal can win that
        // race. Own the callback before res.end and cancel the queued immediate.
        let immediate
        let flushed = false
        const cancelExit = scope.add(() => {
          if (immediate !== undefined) clearImmediate(immediate)
        })
        try {
          res.writeHead(202, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true }), () => {
            if (scope.disposed || flushed) return
            flushed = true
            immediate = setImmediate(() => {
              cancelExit()
              if (!scope.disposed) ctx.appExit(0)
            })
          })
        } catch (error) { cancelExit(); throw error }
      },
    })
    register({
      kind: 'exact',
      path: '/_manager/sessions',
      handler: async (req, res) => {
        if (!routeGuard(req, res, 'GET')) return
        const sessions = ctx.get('sessions')
        if (sessions === undefined) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'sessions service unavailable' }))
          return
        }
        const items = buildItems(ctx, sessions, ctx.get('agents'), activeByParent)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, items }))
      },
    })
    register({
      kind: 'exact',
      path: '/_manager/events',
      handler: (req, res) => {
        if (!routeGuard(req, res, 'GET') || scope.disposed) return
        const sessions = ctx.get('sessions')
        if (sessions === undefined) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'sessions service unavailable' }))
          return
        }
        // Prune dead responses even if their close notification was missed.
        for (const [old, release] of connections) if (old.writableEnded || old.destroyed) release()
        const onClose = () => release()
        const release = scope.add(() => {
          connections.delete(res)
          try {
            if (typeof res.off === 'function') res.off('close', onClose)
            else res.removeListener?.('close', onClose)
          } finally {
            try { if (!res.writableEnded && !res.destroyed) res.end() } finally {
              if (connections.size === 0) { clearPending(); summaryBy.clear() }
            }
          }
        })
        try {
          res.on('close', onClose)
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
          })
          res.write('retry: 3000\n\n')
          let items
          try { items = buildItems(ctx, sessions, ctx.get('agents'), activeByParent) } catch { items = [] }
          synchronizeSnapshot(items)
          res.write(sseFrame('snapshot', { ok: true, items }))
          if (res.writableEnded || res.destroyed) release()
          else connections.set(res, release)
        } catch (error) { release(); throw error }
      },
    })

    // Index maintenance is unconditional; summary derivation is client-gated.
    // Merge dispose handling so index removal ALWAYS precedes parent recompute.
    listen('session/created', (session) => {
      const id = session?.id
      if (typeof id !== 'string') return
      if (session.header?.origin === 'subagent') {
        const parentId = session.header.parentSession
        if (typeof parentId === 'string') childParentBy.set(id, parentId)
      } else recompute(id)
    })
    listen('session/disposed', (session) => {
      const id = session?.id
      if (typeof id !== 'string') return
      const parentId = childParentBy.get(id) ?? session.header?.parentSession
      childParentBy.delete(id)
      if (typeof parentId === 'string') removeChildFromActive(activeByParent, parentId, id)
      activeByParent.delete(id)
      for (const [childId, parent] of childParentBy) if (parent === id) childParentBy.delete(childId)
      pending.get(id)?.()
      if (connections.size === 0) return
      removed(id)
      if (typeof parentId === 'string') recompute(parentId)
    })
    listen('session/event', (session, event) => {
      if (connections.size === 0) return
      const type = event?.type
      if (type === 'tool/call') {
        if (event?.data?.name !== 'ask_user_question' && event?.data?.name !== 'exit_plan_mode') return
      } else if (!RELEVANT_EVENT_TYPES.has(type)) return
      const id = session?.id
      if (typeof id !== 'string') return
      scheduleRecompute(session.header?.origin === 'subagent'
        ? childParentBy.get(id) ?? session.header.parentSession ?? id : id)
    })
    listen('agent/status', (payload) => {
      if (connections.size === 0) return
      const id = payload?.agent?.id
      if (typeof id !== 'string') return
      recompute(childParentBy.get(id) ?? liveParentOf(ctx.get('sessions'), id) ?? id)
    })
    listen('subagent/start', (info) => {
      const childId = info?.id
      if (typeof childId !== 'string') return
      const parentId = childParentBy.get(childId) ?? liveParentOf(ctx.get('sessions'), childId)
      if (parentId === undefined) return
      childParentBy.set(childId, parentId)
      if (typeof info?.runId === 'string') {
        let byRun = activeByParent.get(parentId)
        if (byRun === undefined) {
          byRun = new Map()
          activeByParent.set(parentId, byRun)
        }
        byRun.set(info.runId, childId)
      }
      recompute(parentId)
    })
    listen('subagent/end', (info) => {
      const childId = info?.id
      if (typeof childId !== 'string') return
      const parentId = childParentBy.get(childId) ?? liveParentOf(ctx.get('sessions'), childId)
      if (parentId === undefined) return // already disposed: late end is a no-op
      if (typeof info?.runId === 'string') {
        const byRun = activeByParent.get(parentId)
        if (byRun !== undefined) {
          byRun.delete(info.runId)
          if (byRun.size === 0) activeByParent.delete(parentId)
        }
      }
      recompute(parentId)
    })
    publishReadiness(ctx, process.env, scope)
  } catch (error) {
    scope.cleanup() // partial mounts roll back too; preserve the setup error
    throw error
  }
  return scope.cleanup // also supports direct callers; effect owns runtime use
}
