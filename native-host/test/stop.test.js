'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function fixture(t, exitDelay = 1500) {
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
        DSH_FAKE_EXIT_DELAY_MS: String(exitDelay) } });
    const current = record();
    if (current?.pid) pids.add(current.pid);
    assert.equal(child.status, 0, child.stderr);
    const response = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(response.ok, true, JSON.stringify(response.error));
    return response.result;
  }
  return { host };
}

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

test('stop forces a verified process that outlives the disposal grace', t => {
  const { host } = fixture(t, 15000);
  const started = host('start');
  assert.equal(host('stop').stopMethod, 'force');
  assert.equal(alive(started.pid), false);
});
