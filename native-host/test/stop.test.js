'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function fixture(t, exitDelay = 1500, extraEnv = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'whalekeeper-stop-'));
  const record = () => {
    try { return JSON.parse(fs.readFileSync(path.join(base, 'run', 'dsh-web.json'), 'utf8')); } catch { return null; }
  };
  const pids = new Set();
  t.after(() => {
    for (const pid of pids) if (alive(pid)) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else process.kill(pid, 'SIGKILL');
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  function host(action) {
    const input = path.join(base, 'request.json'), output = path.join(base, 'response.json');
    fs.writeFileSync(input, JSON.stringify({ id: action, action, payload: { port: 0 } }));
    const child = spawnSync(process.execPath, [path.join(__dirname, '..', 'host.js'), '--req', input, '--res', output],
      { encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env,
        DSH_MANAGER_TEST_MODE: '1', DSH_MANAGER_BASE_DIR: base, DSH_MANAGER_PID_CHECK: '0',
        DSH_MANAGER_FAKE_PROCESSES: '[]', DSH_BIN_STUB: path.join(__dirname, 'fake-dsh.js'),
        DSH_FAKE_EXIT_DELAY_MS: String(exitDelay), ...extraEnv } });
    const current = record();
    if (current?.pid) pids.add(current.pid);
    assert.equal(child.status, 0, child.stderr);
    const response = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(response.ok, true, JSON.stringify(response.error));
    return response.result;
  }
  return { host, record, base,
    readyExists: () => fs.existsSync(path.join(base, 'ready', 'dsh-web.json')),
    log: () => fs.readFileSync(path.join(base, 'logs', 'dsh-web.log'), 'utf8') };
}

const source = fs.readFileSync(path.join(__dirname, '..', 'host.js'), 'utf8');
const coreSource = source.slice(source.indexOf('async function stopCore('), source.indexOf('async function actionStop('));
function stopModel({ lease = false, health = [true], closeAt = 5000, exitAt = 6000,
  failForce = false, replacement = null, dead = false, identityChanges = false } = {}) {
  let now = 0, forced = false, healthCalls = 0, posted = 0, removals = 0, cleanup = 0, checks = 0;
  const rec = { pid: 42, port: 3080, binPath: 'fake-dsh.js', launchId: 'a'.repeat(32), launchStartedAt: 100 };
  class AppError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const context = { Date: { now: () => now }, AppError,
    testTimeout: (_key, fallback) => fallback,
    lifecycleNow: () => now, log() {},
    acquireLock: async () => true, releaseLock() {},
    readRunRecord: () => replacement || rec,
    sameRunIdentity: (a, b) => a.pid === b.pid && a.launchId === b.launchId && a.launchStartedAt === b.launchStartedAt,
    pidAlive: () => !dead && !forced && now < exitAt,
    pidLooksLikeDsh: () => { checks++; return !(identityChanges && checks > 1); },
    readReadiness: () => lease ? { pid: rec.pid, port: rec.port, state: 'ready' } : null,
    portConnectable: async () => !forced && now < closeAt,
    getHealth: async () => { const ok = health[Math.min(healthCalls++, health.length - 1)]; return ok ? { ok: true, pid: 42, port: 3080 } : null; },
    sleep: async ms => { now += ms; },
    postShutdown: async () => { posted++; },
    waitPortClosed: async (_port, timeout) => { now += Math.min(timeout, Math.max(0, closeAt - now)); return now >= closeAt; },
    waitProcessStopped: async (_pid, _port, timeout) => {
      if (forced) return true;
      now += Math.min(timeout, Math.max(0, Math.max(closeAt, exitAt) - now));
      return now >= closeAt && now >= exitAt;
    },
    terminateProcess: async () => { if (failForce) return { ok: false, error: 'denied' }; forced = true; return { ok: true }; },
    removeRunRecord: () => { removals++; }, removeRunRecordSafe: () => { removals++; },
    removeOwnedReadiness: () => { cleanup++; },
  };
  const stop = vm.runInNewContext(coreSource + '\nstopCore', context);
  return { run: () => stop(rec), stats: () => ({ now, forced, healthCalls, posted, removals, cleanup, checks }) };
}

test('model: same-identity lease bypasses a transiently failing health endpoint', async () => {
  const fixture = stopModel({ lease: true, health: [false] });
  assert.equal((await fixture.run()).method, 'graceful');
  assert.equal(fixture.stats().healthCalls, 0);
  assert.equal(fixture.stats().posted, 1);
});
test('model: old plugin health gets one bounded retry before force', async () => {
  const fixture = stopModel({ health: [false, true] });
  assert.equal((await fixture.run()).method, 'graceful');
  assert.equal(fixture.stats().healthCalls, 2);
  assert.equal(fixture.stats().forced, false);
});
test('model: listener remaining open beyond 3 seconds is still graceful within 10 seconds', async () => {
  const fixture = stopModel({ closeAt: 5000, exitAt: 6000 });
  assert.equal((await fixture.run()).method, 'graceful');
  assert.equal(fixture.stats().forced, false);
  assert.equal(fixture.stats().now, 6000);
  assert.equal(fixture.stats().cleanup, 1, 'successful stop removes only its matching ready lease');
});
test('model: graceful timeout revalidates the PID before forcing, then cleans its lease', async () => {
  const fixture = stopModel({ closeAt: 15000, exitAt: 16000 });
  assert.equal((await fixture.run()).method, 'force');
  assert.equal(fixture.stats().now, 10000, 'one shared graceful wait, not 3s plus 10s');
  assert.ok(fixture.stats().checks >= 2);
  assert.equal(fixture.stats().cleanup, 1);
});
test('model: failed force and PID identity changes retain run and ready records', async () => {
  for (const settings of [{ failForce: true }, { identityChanges: true }]) {
    const fixture = stopModel({ closeAt: 15000, exitAt: 16000, ...settings });
    await assert.rejects(fixture.run(), { code: 'STOP_FAILED' });
    assert.equal(fixture.stats().removals, 0);
    assert.equal(fixture.stats().cleanup, 0);
  }
});
test('model: a new record appearing before the stop lock is never removed or killed', async () => {
  for (const replacement of [{ pid: 43 }, { pid: 42, launchId: 'b'.repeat(32), launchStartedAt: 100 }]) {
    const fixture = stopModel({ replacement });
    await assert.rejects(fixture.run(), { code: 'STOP_FAILED' });
    assert.equal(fixture.stats().removals, 0);
    assert.equal(fixture.stats().forced, false);
    assert.equal(fixture.stats().cleanup, 0);
  }
});

test('stop waits for the process after its HTTP listener closes', t => {
  const { host } = fixture(t);
  const started = host('start');
  const stopped = host('stop');
  assert.equal(stopped.stopMethod, 'graceful');
  assert.equal(alive(started.pid), false, 'old PID still owns the launch log after port closure');
});

test('restart releases the previous process before spawning its replacement', t => {
  const { host } = fixture(t);
  const started = host('start');
  const restarted = host('restart');
  assert.equal(restarted.state, 'running');
  assert.notEqual(restarted.pid, started.pid);
  assert.equal(alive(started.pid), false);
  assert.equal(host('stop').stopMethod, 'graceful');
});

test('stop forces a verified process that outlives the disposal grace and removes its ready lease', t => {
  const { host, readyExists } = fixture(t, 15000, { DSH_FAKE_READY: '1', DSH_MANAGER_STOP_TIMEOUT_MS: '1200' });
  const started = host('start');
  assert.equal(readyExists(), true);
  assert.equal(host('stop').stopMethod, 'force');
  assert.equal(alive(started.pid), false);
  assert.equal(readyExists(), false);
});

test('dynamic stop uses its lease without touching a failing health endpoint', t => {
  const { host, log, readyExists } = fixture(t, 200, {
    DSH_FAKE_READY: '1', DSH_FAKE_HEALTH_FAILURES: '99', DSH_FAKE_LOG_HEADERS: '1',
  });
  const started = host('start');
  assert.equal(host('stop').stopMethod, 'graceful');
  assert.equal(log().includes('HEALTH-TRANSIENT-FAILURE'), false, 'valid lease is sufficient plugin proof');
  assert.equal(readyExists(), false);
  assert.equal(alive(started.pid), false);
});

test('legacy dynamic stop retries a transient health failure once', t => {
  const { host, log } = fixture(t, 200, { DSH_FAKE_HEALTH_FAILURES: '1' });
  const started = host('start');
  assert.equal(host('stop').stopMethod, 'graceful');
  assert.equal((log().match(/HEALTH-TRANSIENT-FAILURE/g) || []).length, 1);
  assert.ok(log().includes('SHUTDOWN-RECEIVED'));
  assert.equal(alive(started.pid), false);
});

test('stop does not force a lifecycle listener that closes after the old 3 second limit', t => {
  const { host } = fixture(t, 4200, { DSH_FAKE_CLOSE_DELAY_MS: '3500' });
  const started = host('start');
  const before = Date.now();
  assert.equal(host('stop').stopMethod, 'graceful');
  assert.ok(Date.now() - before >= 3500, 'actually waited for slow disposal');
  assert.equal(alive(started.pid), false);
});
