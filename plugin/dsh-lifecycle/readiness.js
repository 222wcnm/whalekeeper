import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const pluginVersion = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

// Only manager-launched processes opt in. Each mount owns its own publication.
export function publishReadiness(ctx, env = process.env) {
  const file = env.DSH_MANAGER_READY_FILE
  const launchId = env.DSH_MANAGER_LAUNCH_ID
  const launchStartedAt = Number(env.DSH_MANAGER_LAUNCH_STARTED_AT)
  if (typeof file !== 'string' || !path.isAbsolute(file)
    || !/^[a-f0-9]{32}$/.test(launchId || '')
    || !Number.isSafeInteger(launchStartedAt) || launchStartedAt <= 0) return () => {}

  const mountId = randomBytes(16).toString('hex')
  const tmp = `${file}.${mountId}.tmp`
  const startedAt = Date.now() - Math.round(process.uptime() * 1000)
  let disposed = false
  let state = 'starting'
  const publish = () => {
    if (disposed) return
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
  publish()
  const timer = setInterval(publish, 2000)
  timer.unref()
  const markReady = () => {
    if (disposed) return
    state = 'ready'
    publish()
  }
  const appReady = ctx.get('appReady')
  let cancelReady = () => {}
  if (typeof appReady?.onReady === 'function') {
    cancelReady = appReady.onReady(markReady)
  } else {
    // Older dsh has no launcher signal. Awaiting inside apply would deadlock
    // Loader settlement on our own mount, so keep this fallback asynchronous.
    void (async () => {
      try {
        await ctx.get('loader')?.await()
        markReady()
      } catch { /* Failed startup must never publish ready. */ }
    })()
  }
  return () => {
    disposed = true
    cancelReady()
    clearInterval(timer)
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (current.launchId === launchId && current.mountId === mountId) fs.unlinkSync(file)
    } catch { /* Missing/unwritable files are handled by the host fallback. */ }
    try { fs.unlinkSync(tmp) } catch { /* No pending publication. */ }
  }
}
