import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const pluginVersion = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

// One explicitly effect-owned resource stack. Register cleanup BEFORE acquiring
// resources; nested scopes share the same owner. Sync cleanup stays synchronous,
// async cleanup is awaited in reverse order, and one failure cannot skip peers.
export function createResourceScope(ctx, label, parent) {
  const cleanups = new Set()
  let disposed = false
  let disposal
  const add = (callback) => {
    if (disposed) throw new Error(`cannot acquire resource in disposed ${label}`)
    let active = true
    const release = () => {
      if (!active) return
      active = false
      cleanups.delete(release)
      try {
        const result = callback()
        if (result && typeof result.then === 'function') return Promise.resolve(result).catch(() => {})
      } catch { /* Teardown is best-effort; all other resources must release. */ }
    }
    cleanups.add(release)
    return release
  }
  let detachParent
  const cleanup = () => {
    if (disposed) return disposal
    disposed = true
    detachParent?.()
    let task
    for (const release of [...cleanups].reverse()) {
      if (task) task = task.then(release)
      else task = release()
    }
    return (disposal = task)
  }
  if (parent) detachParent = parent.add(cleanup)
  else ctx.effect(() => cleanup, label)
  return { add, cleanup, get disposed() { return disposed },
    acquire(setup) {
      let dispose
      const release = add(() => dispose?.())
      try { dispose = setup() } catch (error) { release(); throw error }
      return release
    },
  }
}

// Only manager-launched processes opt in. A standalone publication owns its own
// effect; apply() supplies its mount scope so all resources unwind together.
export function publishReadiness(ctx, env = process.env, owner) {
  const file = env.DSH_MANAGER_READY_FILE
  const launchId = env.DSH_MANAGER_LAUNCH_ID
  const launchStartedAt = Number(env.DSH_MANAGER_LAUNCH_STARTED_AT)
  if (typeof file !== 'string' || !path.isAbsolute(file)
    || !/^[a-f0-9]{32}$/.test(launchId || '')
    || !Number.isSafeInteger(launchStartedAt) || launchStartedAt <= 0) return () => {}

  const scope = createResourceScope(ctx, 'dsh-lifecycle/readiness', owner)
  const mountId = randomBytes(16).toString('hex')
  const tmp = `${file}.${mountId}.tmp`
  const startedAt = Date.now() - Math.round(process.uptime() * 1000)
  let state = 'starting'
  const publish = () => {
    if (scope.disposed) return
    const port = ctx.webServer.port
    if (!Number.isInteger(port) || port < 1 || port > 65535) return
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify({
        schemaVersion: 1, launchId, launchStartedAt, mountId,
        pid: process.pid, host: '127.0.0.1', port, state,
        startedAt, updatedAt: Date.now(), pluginVersion, nodeVersion: process.version,
      }), { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch {
      try { fs.unlinkSync(tmp) } catch { /* HTTP remains available. */ }
    }
  }
  const markReady = () => {
    if (scope.disposed) return
    state = 'ready'
    publish()
  }
  try {
    scope.add(() => {
      try { fs.unlinkSync(tmp) } catch { /* No pending publication. */ }
    })
    scope.add(() => {
      try {
        const current = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (current.launchId === launchId && current.mountId === mountId) fs.unlinkSync(file)
      } catch { /* Missing/unwritable files use the host's HTTP fallback. */ }
    })
    publish()
    let timer
    scope.add(() => { if (timer !== undefined) clearInterval(timer) })
    timer = setInterval(publish, 2000)
    timer.unref()
    const appReady = ctx.get('appReady')
    if (typeof appReady?.onReady === 'function') {
      scope.acquire(() => appReady.onReady(markReady))
    } else {
      // Awaiting inside apply would deadlock Loader settlement on our own
      // mount. The disposed guard prevents a late settlement from republishing.
      void (async () => {
        try {
          await ctx.get('loader')?.await()
          markReady()
        } catch { /* Failed startup must never publish ready. */ }
      })()
    }
  } catch (error) {
    scope.cleanup()
    throw error
  }
  return scope.cleanup
}
