import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { publishReadiness } from '../readiness.js'

function fixture(t, loader) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ready-'))
  const file = path.join(dir, 'ready.json')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const env = { DSH_MANAGER_READY_FILE: file, DSH_MANAGER_LAUNCH_ID: 'a'.repeat(32),
    DSH_MANAGER_LAUNCH_STARTED_AT: String(Date.now()) }
  const ctx = { webServer: { port: 31930 }, get: () => loader }
  const start = () => {
    const dispose = publishReadiness(ctx, env)
    t.after(dispose)
    return dispose
  }
  return { ctx, env, file, start, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) }
}

test('readiness waits for Loader, reports actual process/port, and cleans up', async (t) => {
  let settle
  const f = fixture(t, { await: () => new Promise(resolve => { settle = resolve }) })
  const dispose = f.start()
  assert.equal(f.read().state, 'starting')
  settle()
  await new Promise(setImmediate)
  const signal = f.read()
  assert.equal(signal.state, 'ready')
  assert.equal(signal.pid, process.pid)
  assert.equal(signal.port, f.ctx.webServer.port)
  assert.equal(signal.launchId, f.env.DSH_MANAGER_LAUNCH_ID)
  assert.equal(signal.launchStartedAt, Number(f.env.DSH_MANAGER_LAUNCH_STARTED_AT))
  assert.equal(signal.schemaVersion, 1)
  assert.equal(signal.pluginVersion, '0.4.1')
  assert.equal(JSON.stringify(signal).includes('token'), false)
  dispose()
  assert.equal(fs.existsSync(f.file), false)
})

test('dispose before Loader settlement cannot republish', async (t) => {
  let settle
  const f = fixture(t, { await: () => new Promise(resolve => { settle = resolve }) })
  f.start()()
  settle()
  await new Promise(setImmediate)
  assert.equal(fs.existsSync(f.file), false)
})

test('appReady takes precedence over Loader settlement', async (t) => {
  const f = fixture(t, { await: async () => {} })
  let ready
  f.ctx.get = name => name === 'appReady'
    ? { onReady(callback) { ready = callback; return () => { ready = undefined } } }
    : { await: async () => {} }
  f.start()
  await new Promise(setImmediate)
  assert.equal(f.read().state, 'starting')
  assert.equal(typeof ready, 'function')
  ready()
  assert.equal(f.read().state, 'ready')
})

test('failed startup without appReady commit remains starting', async (t) => {
  const f = fixture(t)
  f.ctx.get = name => name === 'appReady'
    ? { onReady() { return () => {} } }
    : { await: async () => {} }
  f.start()
  await new Promise(setImmediate)
  assert.equal(f.read().state, 'starting')
})

test('dispose cancels appReady and a late callback cannot republish', (t) => {
  const f = fixture(t)
  let ready
  let cancelled = false
  f.ctx.get = () => ({ onReady(callback) {
    ready = callback
    return () => { cancelled = true }
  } })
  f.start()()
  assert.equal(cancelled, true)
  ready()
  assert.equal(fs.existsSync(f.file), false)
})

test('failed Loader never publishes ready', async (t) => {
  const f = fixture(t, { await: async () => { throw new Error('boot failed') } })
  f.start()
  await new Promise(setImmediate)
  assert.equal(f.read().state, 'starting')
})

test('older mount disposal does not delete a newer publication', async (t) => {
  const f = fixture(t)
  const first = f.start()
  await new Promise(setImmediate)
  f.start()
  await new Promise(setImmediate)
  const newer = f.read().mountId
  first()
  assert.equal(f.read().mountId, newer)
})

test('missing opt-in, invalid path/id/time and unbound port do not publish', (t) => {
  const f = fixture(t)
  for (const patch of [ { DSH_MANAGER_READY_FILE: undefined },
    { DSH_MANAGER_READY_FILE: 'relative.json' }, { DSH_MANAGER_LAUNCH_ID: 'bad' },
    { DSH_MANAGER_LAUNCH_STARTED_AT: 'NaN' } ]) {
    publishReadiness(f.ctx, { ...f.env, ...patch })()
    assert.equal(fs.existsSync(f.file), false)
  }
  f.ctx.webServer.port = 0
  f.start()()
  assert.equal(fs.existsSync(f.file), false)
})

test('write failure is nonfatal', async (t) => {
  const f = fixture(t)
  fs.mkdirSync(f.file)
  const dispose = f.start()
  await new Promise(setImmediate)
  assert.doesNotThrow(dispose)
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['ready.json'])
})

test('lease refreshes while mounted and stops after dispose', async (t) => {
  const f = fixture(t)
  const dispose = f.start()
  await new Promise(setImmediate)
  const before = f.read().updatedAt
  await new Promise(resolve => setTimeout(resolve, 2150))
  assert.ok(f.read().updatedAt > before)
  dispose()
  assert.equal(fs.existsSync(f.file), false)
})
