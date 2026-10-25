import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as plugin from '../index.js'
import { createResourceScope } from '../readiness.js'

const req = (method = 'GET') => ({ method, socket: { remoteAddress: '127.0.0.1' },
  headers: { host: '127.0.0.1:43123' } })
const event = (type, data = {}, time = 1) => ({ type, data, time })
function session(id, events = [], header = {}) {
  return { id, events, header: { createdAt: 1, ...header }, snapshotEvents: () => events }
}
function response() {
  const res = new EventEmitter()
  Object.assign(res, {
    chunks: [], writableEnded: false, destroyed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    write(text) { this.chunks.push(text); return true },
    end(body, callback) { this.body = body; this.writableEnded = true; callback?.() },
  })
  return res
}
function frames(res, type) {
  return res.chunks.flatMap(text => text.split('\n\n')).filter(text => text.includes(`event: ${type}\n`))
    .map(text => ({ id: Number(/^id: (.+)$/m.exec(text)[1]), data: JSON.parse(/^data: (.+)$/m.exec(text)[1]) }))
}
function timers(t) {
  const active = new Map()
  const all = []
  for (const kind of ['Timeout', 'Interval']) {
    t.mock.method(globalThis, `set${kind}`, (callback, delay) => {
      const handle = { kind, callback, delay, unref() {} }
      all.push(handle)
      active.set(handle, handle)
      return handle
    })
    t.mock.method(globalThis, `clear${kind}`, handle => active.delete(handle))
  }
  return { active, all, flushTimeouts() {
    for (const handle of [...active.keys()]) if (handle.kind === 'Timeout') {
      active.delete(handle)
      handle.callback()
    }
  } }
}
function services(live = [], agents = {}, workspaceRegistry) {
  return { sessions: { list: () => live, get: id => live.find(s => s.id === id) },
    agents: { get: id => agents[id] }, workspaceRegistry }
}
function rawContext(extra = {}, { failAt = 0, failCleanup = false } = {}) {
  const routes = new Map(), listeners = new Map(), removed = [], exits = [], effects = []
  let registrations = 0
  const ctx = {
    get: name => extra[name],
    effect(callback) { const dispose = callback(); effects.push(dispose); return dispose },
    on(name, callback) {
      const callbacks = listeners.get(name) ?? new Set()
      listeners.set(name, callbacks)
      callbacks.add(callback)
      return () => {
        callbacks.delete(callback)
        if (failCleanup && name === 'agent/status') return Promise.reject(new Error('listener cleanup failed'))
      }
    },
    webServer: { port: 43123, register(spec) {
      if (++registrations === failAt) throw new Error('route registration failed')
      if (routes.has(spec.path)) throw new Error(`duplicate route ${spec.path}`)
      routes.set(spec.path, spec.handler)
      return () => {
        routes.delete(spec.path)
        removed.push(spec.path)
        if (failCleanup && spec.path === '/_lifecycle/shutdown') throw new Error('route cleanup failed')
      }
    } },
    appExit(code) { exits.push(code) },
  }
  return { ctx, routes, listeners, removed, exits, effects,
    emit(name, ...args) { for (const fn of [...(listeners.get(name) ?? [])]) fn(...args) },
    async connect() { const res = response(); await routes.get('/_manager/events')(req(), res); return res } }
}
function mount(t, extra, options) {
  const f = rawContext(extra, options)
  f.cleanup = plugin.apply(f.ctx)
  t.after(() => f.cleanup())
  return f
}
function readyEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lifecycle-cordis-'))
  const env = { DSH_MANAGER_READY_FILE: path.join(dir, 'ready.json'),
    DSH_MANAGER_LAUNCH_ID: 'b'.repeat(32), DSH_MANAGER_LAUNCH_STARTED_AT: String(Date.now()) }
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return env
}

// Resolve the installed CLI's own Cordis, never an ASAR dependency or a new
// production dependency. CI without an installed CLI reports this layer skipped.
const prefix = process.env.DSH_MANAGER_NPM_PREFIX ?? path.join(process.env.APPDATA ?? os.homedir(), 'npm')
const cliBin = process.env.DSH_MANAGER_TEST_DSH_BIN ?? path.join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
let installed
try {
  const requireDsh = createRequire(path.resolve(cliBin))
  installed = { Context: (await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/cordis')).href)).Context,
    cordisVersion: requireDsh('@deepseek-ai/cordis/package.json').version,
    dshVersion: requireDsh('../package.json').version }
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_MODULE_NOT_FOUND') throw error
}

test('real Cordis: ctx.plugin dispose removes every resource and permits remount', { skip: !installed && 'installed npm CLI unavailable' }, async t => {
  t.diagnostic(`installed npm DSH ${installed.dshVersion}; Cordis ${installed.cordisVersion}`)
  assert.match(installed.dshVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
  assert.match(installed.cordisVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
  if (process.env.EXPECT_DSH_VERSION) assert.equal(installed.dshVersion, process.env.EXPECT_DSH_VERSION)
  if (process.env.EXPECT_CORDIS_VERSION) assert.equal(installed.cordisVersion, process.env.EXPECT_CORDIS_VERSION)
  const clock = timers(t)
  const env = readyEnv(t)
  const root = new installed.Context()
  t.after(() => root.fiber.dispose())
  const registered = rawContext()
  const readyCallbacks = new Set()
  root.provide('webServer', registered.ctx.webServer)
  root.provide('appExit', registered.ctx.appExit)
  root.provide('appReady', { onReady(fn) { readyCallbacks.add(fn); return () => readyCallbacks.delete(fn) } })
  const main = session('parent', [event('turn/start')])
  const live = services([main], { parent: { status: 'running' } })
  root.provide('sessions', live.sessions)
  root.provide('agents', live.agents)
  const first = await root.plugin(plugin)
  const res = response()
  await registered.routes.get('/_manager/events')(req(), res)
  main.events.push(event('approval/asked', { id: 'ask' }))
  root.emit('session/event', main, main.events.at(-1))
  assert.equal(registered.routes.size, 4)
  assert.equal(clock.active.size, 3, 'heartbeat, readiness lease and debounce')
  assert.equal(readyCallbacks.size, 1)
  assert.ok(fs.existsSync(env.DSH_MANAGER_READY_FILE))
  await first.dispose()
  assert.equal(registered.routes.size, 0, 'ordinary apply return is not Cordis ownership')
  assert.deepEqual(registered.removed, ['/_manager/events', '/_manager/sessions', '/_lifecycle/shutdown', '/_lifecycle/health'])
  assert.equal(res.writableEnded, true)
  assert.equal(res.listenerCount('close'), 0)
  assert.equal(clock.active.size, 0)
  assert.equal(readyCallbacks.size, 0)
  assert.equal(fs.existsSync(env.DSH_MANAGER_READY_FILE), false)
  const second = await root.plugin(plugin)
  assert.equal(registered.routes.size, 4)
  await first.dispose()
  assert.equal(registered.routes.size, 4, 'old mount cannot remove new routes')
  await second.dispose()
  assert.equal(registered.routes.size, 0)
})

test('real Cordis: mid-route failure rolls back previously acquired resources', { skip: !installed && 'installed npm CLI unavailable' }, async t => {
  const clock = timers(t)
  const root = new installed.Context()
  t.after(() => root.fiber.dispose())
  const f = rawContext({}, { failAt: 3 })
  root.provide('webServer', f.ctx.webServer)
  root.provide('appExit', f.ctx.appExit)
  await assert.rejects(async () => await root.plugin(plugin), /route registration failed/)
  assert.equal(f.routes.size, 0)
  assert.deepEqual(f.removed, ['/_lifecycle/shutdown', '/_lifecycle/health'])
  assert.equal(clock.active.size, 0)
})

test('effect ownership is registered before the first resource allocation', t => {
  const clock = timers(t)
  const f = rawContext()
  f.ctx.effect = () => { throw new Error('effect unavailable') }
  assert.throws(() => plugin.apply(f.ctx), /effect unavailable/)
  assert.equal(f.routes.size, 0)
  assert.equal(clock.active.size, 0)
})

test('cleanup is reverse, idempotent and continues after sync and async failures', async t => {
  const clock = timers(t)
  const f = mount(t, services([session('parent')]), { failCleanup: true })
  const res = await f.connect()
  await assert.doesNotReject(async () => await f.cleanup())
  assert.equal(f.routes.size, 0)
  assert.deepEqual(f.removed, ['/_manager/events', '/_manager/sessions', '/_lifecycle/shutdown', '/_lifecycle/health'])
  assert.ok([...f.listeners.values()].every(callbacks => callbacks.size === 0))
  assert.equal(res.writableEnded, true)
  assert.equal(res.listenerCount('close'), 0)
  assert.equal(clock.active.size, 0)
  await f.cleanup()
  assert.equal(f.removed.length, 4)
  for (const effect of f.effects) await effect()
  assert.equal(f.removed.length, 4, 'manual cleanup followed by effect cleanup is harmless')
})

test('resource cleanup awaits reverse async releases and shares one idempotent completion', async t => {
  const f = rawContext()
  const scope = createResourceScope(f.ctx, 'test')
  const order = []
  let finish
  scope.add(() => { order.push('first') })
  scope.add(() => { order.push('middle'); throw new Error('sync cleanup failed') })
  scope.add(() => {
    order.push('last-start')
    return new Promise(resolve => { finish = () => { order.push('last-end'); resolve() } })
  })
  const completion = scope.cleanup()
  assert.equal(scope.cleanup(), completion)
  assert.deepEqual(order, ['last-start'])
  finish()
  await completion
  assert.deepEqual(order, ['last-start', 'last-end', 'middle', 'first'])
  await f.effects[0]()
  assert.equal(order.length, 4)
})

test('listener setup failure rolls back routes, heartbeat and prior listeners', t => {
  const clock = timers(t)
  const f = rawContext()
  const on = f.ctx.on
  f.ctx.on = (name, callback) => {
    if (name === 'agent/status') throw new Error('listener setup failed')
    return on(name, callback)
  }
  assert.throws(() => plugin.apply(f.ctx), /listener setup failed/)
  assert.equal(f.routes.size, 0)
  assert.equal(clock.active.size, 0)
  assert.ok([...f.listeners.values()].every(callbacks => callbacks.size === 0))
  f.effects[0]()
  assert.equal(f.removed.length, 4)
})

test('readiness setup failure rolls back the entire mount, not only its publication', t => {
  const clock = timers(t)
  const env = readyEnv(t)
  const f = rawContext({ appReady: { onReady() { throw new Error('readiness setup failed') } } })
  assert.throws(() => plugin.apply(f.ctx), /readiness setup failed/)
  assert.equal(f.routes.size, 0)
  assert.equal(clock.active.size, 0)
  assert.ok([...f.listeners.values()].every(callbacks => callbacks.size === 0))
  assert.equal(fs.existsSync(env.DSH_MANAGER_READY_FILE), false)
  f.effects[0]()
  assert.equal(f.removed.length, 4)
})

test('shutdown guard is private to each mount', async t => {
  const a = mount(t), b = mount(t)
  const ar = response(), br = response()
  await a.routes.get('/_lifecycle/shutdown')(req('POST'), ar)
  await b.routes.get('/_lifecycle/shutdown')(req('POST'), br)
  assert.equal(ar.status, 202)
  assert.equal(br.status, 202)
  const duplicate = response()
  await a.routes.get('/_lifecycle/shutdown')(req('POST'), duplicate)
  assert.equal(duplicate.status, 409)
  await new Promise(setImmediate)
  assert.deepEqual(a.exits, [0])
  assert.deepEqual(b.exits, [0])
})

test('dispose cancels a queued shutdown and ignores a late response flush', async t => {
  const f = mount(t)
  const res = response()
  await f.routes.get('/_lifecycle/shutdown')(req('POST'), res)
  await f.cleanup()
  await new Promise(setImmediate)
  assert.deepEqual(f.exits, [])
  const g = mount(t)
  const delayed = response()
  let flush
  delayed.end = (body, callback) => { flush = callback }
  await g.routes.get('/_lifecycle/shutdown')(req('POST'), delayed)
  await g.cleanup()
  flush()
  await new Promise(setImmediate)
  assert.deepEqual(g.exits, [])
})

test('second SSE connection flushes the 50ms pending change to existing clients before snapshot', async t => {
  const clock = timers(t)
  const main = session('parent', [event('turn/start')])
  let reads = 0
  delete main.events
  const events = [event('turn/start')]
  main.snapshotEvents = () => { reads += 1; return events }
  const f = mount(t, services([main], { parent: { status: 'running' } }))
  const a = await f.connect()
  const asking = event('approval/asked', { id: 'ask' }, 2)
  events.push(asking)
  f.emit('session/event', main, asking)
  const before = reads
  const b = await f.connect()
  assert.equal(reads, before + 1, 'one shared current snapshot, not per-client recomputes')
  assert.equal(frames(a, 'upsert').length, 1)
  assert.equal(frames(a, 'upsert')[0].data.session.state, 'waiting')
  assert.equal(frames(b, 'snapshot')[0].data.items[0].state, 'waiting')
  assert.ok(frames(a, 'upsert')[0].id < frames(b, 'snapshot')[0].id)
  clock.flushTimeouts()
  assert.equal(frames(a, 'upsert').length, 1)
  assert.equal(frames(b, 'upsert').length, 0)
})

test('new SSE snapshot broadcasts omitted rows to old clients and keeps semantic diff', async t => {
  const archived = { archivedSessionIds: [] }
  const main = session('parent', [event('turn/end')])
  const gone = session('gone')
  const live = [main, gone]
  const f = mount(t, services(live, {}, archived))
  const a = await f.connect()
  live.pop()
  archived.archivedSessionIds.push('parent')
  const b = await f.connect()
  assert.deepEqual(frames(a, 'removed').map(f => f.data.sessionId).sort(), ['gone', 'parent'])
  assert.deepEqual(frames(b, 'snapshot')[0].data.items, [])
  archived.archivedSessionIds.length = 0
  f.emit('agent/status', { agent: { id: 'parent' }, status: 'idle' })
  assert.equal(frames(a, 'upsert').length, 1)
  main.events.push(event('turn/start', {}, 3))
  await f.connect()
  assert.equal(frames(a, 'upsert').length, 1, 'updatedAt-only snapshot change remains suppressed')
})

test('last client closing before debounce means zero recomputes and no stale baseline', async t => {
  const clock = timers(t)
  let reads = 0
  const main = session('parent')
  delete main.events
  main.snapshotEvents = () => { reads += 1; return [] }
  const f = mount(t, services([main]))
  const res = await f.connect()
  f.emit('session/event', main, event('turn/end'))
  res.destroyed = true
  res.emit('close')
  const before = reads
  clock.flushTimeouts()
  f.emit('agent/status', { agent: { id: 'parent' }, status: 'idle' })
  assert.equal(reads, before)
  assert.equal(res.listenerCount('close'), 0)
})

for (const archived of [false, true]) {
  test(`child disposed before subagent/end updates parent immediately (archived=${archived})`, async t => {
    const parent = session('parent', [event('turn/end')])
    const child = session('child', [], { origin: 'subagent', parentSession: 'parent' })
    const live = [parent, child]
    const f = mount(t, services(live, {}, { archivedSessionIds: archived ? ['parent'] : [] }))
    f.emit('session/created', child)
    f.emit('subagent/start', { id: 'child', runId: 'run' })
    const res = await f.connect()
    assert.equal(frames(res, 'snapshot')[0].data.items[0].hasActiveChildren, true)
    live.pop()
    f.emit('session/disposed', child)
    if (archived) assert.equal(frames(res, 'removed').at(-1)?.data.sessionId, 'parent')
    else {
      const pushed = frames(res, 'upsert').at(-1)?.data.session
      assert.equal(pushed?.hasActiveChildren, false)
      assert.deepEqual(pushed.childRuns, [])
    }
    const before = res.chunks.length
    f.emit('subagent/end', { id: 'child', runId: 'run' })
    f.emit('session/disposed', child)
    assert.equal(res.chunks.length, before, 'late end and repeated dispose are idempotent')
    const get = response()
    await f.routes.get('/_manager/sessions')(req(), get)
    const items = JSON.parse(get.body).items
    assert.equal(items.length, archived ? 0 : 1)
    if (!archived) assert.equal(items[0].hasActiveChildren, false)
  })
}
