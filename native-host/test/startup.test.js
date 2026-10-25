'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const net = require('node:net');
const { spawnSync } = require('node:child_process');

const source = fs.readFileSync(path.join(__dirname, '..', 'host.js'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, 'host section exists: ' + start);
  return source.slice(first, last);
}
const startup = section('async function startDshCore(', '\n// M5.5：失败路径');
class AppError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function clockedStart({ mode = 'global', port = 3080, portAt = 0, readyAt = 58000,
  probeCost = 0, spawnCost = 0 } = {}) {
  let now = 1000000, spawnedAt = now, record, released = false;
  const calls = { logs: [], probes: [], bestEffort: [] };
  const clock = { now: () => now };
  const context = {
    Date: clock, AppError, IS_WIN: false,
    START_TIMEOUT_MS: 150000, LAUNCH_URL_TIMEOUT_MS: 5000,
    testTimeout: (_key, fallback) => fallback,
    acquireLock: async () => true, releaseLock: () => { released = true; },
    readRunRecord: () => record || null,
    pidAlive: () => true, pidLooksLikeDsh: () => true,
    portConnectable: async () => false,
    resolveLaunchSpec: () => ({ binPath: 'fake-dsh.js', version: 'fake', launchMode: mode }),
    randomBytes: () => ({ toString: () => 'a'.repeat(32) }),
    watchReadiness: () => ({ wait: async ms => { now += Math.max(1, ms); }, close() {} }),
    fs: { statSync: () => ({ size: 0 }) }, LOG_FILE: 'log',
    spawnDsh: () => { spawnedAt = now; now += spawnCost; return { pid: 42 }; },
    readReadiness: () => null,
    discoverPortFromLog: () => now - spawnedAt >= portAt ? 3080 : null,
    httpProbe: async (_port, timeout) => {
      calls.probes.push(timeout);
      now += Math.min(probeCost, timeout);
      return now - spawnedAt >= readyAt;
    },
    captureLaunchUrl: async () => null,
    makeRunRecord: (_v, _bin, _version, pid, actual) => ({ pid, port: actual }),
    writeRunRecord: rec => { record = rec; }, writePidFile() {},
    writeBestEffortRecord: (...args) => calls.bestEffort.push(args),
    buildResult: (state, rec) => ({ state, ...rec }),
    log: text => calls.logs.push(text), sleep: async ms => { now += ms; },
  };
  const run = vm.runInNewContext(startup + '\nstartDshCore', context);
  return { run: () => run({ port, host: '127.0.0.1', profile: 'web', extraArgs: [], launchMode: mode }, false),
    elapsed: () => now - spawnedAt, released: () => released, calls };
}

for (const mode of ['global', 'npx', 'source']) {
  test(mode + ' accepts rc.2 readiness beyond the historical 30/60 second limits', async () => {
    const fixture = clockedStart({ mode, readyAt: 90000 });
    assert.equal((await fixture.run()).state, 'running');
    assert.ok(fixture.elapsed() >= 90000 && fixture.elapsed() <= 150000);
    assert.equal(fixture.released(), true);
  });
}
test('dynamic discovery and readiness consume one spawn-relative 150 second budget', async () => {
  const fixture = clockedStart({ port: 0, portAt: 100000, readyAt: 149000 });
  assert.equal((await fixture.run()).port, 3080);
  assert.ok(fixture.elapsed() >= 149000 && fixture.elapsed() <= 150000);
});
test('dynamic discovery does not reset readiness budget and in-flight probes are bounded', async () => {
  const fixture = clockedStart({ port: 0, portAt: 100000, readyAt: 170000, probeCost: 1200 });
  await assert.rejects(fixture.run(), { code: 'START_TIMEOUT' });
  assert.equal(fixture.elapsed(), 150000, 'discovery/probe/wait must not overrun or restart the deadline');
  assert.equal(fixture.released(), true);
});
test('fixed-port timeout includes synchronous spawn work and caps the final probe', async () => {
  const fixture = clockedStart({ readyAt: 200000, spawnCost: 2500, probeCost: 1200 });
  await assert.rejects(fixture.run(), { code: 'START_TIMEOUT' });
  assert.equal(fixture.elapsed(), 150000);
  assert.ok(fixture.calls.logs.some(line => /elapsedMs=150000/.test(line)), 'phase diagnostics include elapsed time');
});

test('timeout never claims an unverified Windows port owner or ambiguous command-line candidate', () => {
  const bestEffort = section('function writeBestEffortRecord(', '\n// 端口表反查 +');
  const writes = [];
  const context = { IS_WIN: true, DEFAULT_HOST: '127.0.0.1',
    readReadiness: () => null, findPidByPort: () => 99, findDshPidByCmdline: () => 99,
    listNodeProcesses: () => [], pidAlive: () => true, pidLooksLikeDsh: () => true,
    splitCmdlineTokens: line => line.split(/\s+/),
    makeRunRecord: (...args) => args, writeRunRecord: rec => writes.push(rec), writePidFile() {}, log() {} };
  const write = vm.runInNewContext(bestEffort + '\nwriteBestEffortRecord', context);
  write({ port: 3080, profile: 'web', host: '127.0.0.1' }, 'fake-dsh.js', 'fake', null, 3080, 0, false, { pid: 55 });
  assert.equal(writes.length, 0, 'listening node.exe alone is not proof that it is our launch');
});

test('diagnostics redact URL tokens while preserving the launch URL result contract', () => {
  const redact = vm.runInNewContext(section('function redactTokens(', '\n// 日志只写 stderr') + '\nredactTokens');
  const message = 'dsh web: http://127.0.0.1:3080/?token=secret&x=1\nfailed token URL: http://localhost/?TOKEN=second#hash';
  const result = redact(message);
  assert.ok(!result.includes('secret') && !result.includes('second'));
  assert.ok(result.includes('token=[REDACTED]&x=1'));
  const tail = vm.runInNewContext(section('function readLogTail(', '\n// 读取日志文件 byteOffset') + '\nreadLogTail', {
    LOG_FILE: 'log', LOG_TAIL_LINES: 20, redactTokens: redact, fs: { readFileSync: () => message },
  });
  assert.equal(tail(), result);
});

test('URL capture caps its last wait to the remaining five second allowance', async () => {
  let now = 0;
  const capture = vm.runInNewContext(section('async function captureLaunchUrl(', '\n// ---------------------------------------------------------------------------') + '\ncaptureLaunchUrl', {
    Date: { now: () => now }, LAUNCH_URL_TIMEOUT_MS: 5000,
    discoverLaunchUrlFromLog: () => null, sleep: async ms => { now += ms; },
  });
  assert.equal(await capture(0, 725), null);
  assert.equal(now, 725);
});

test('test-only timeout override requires TEST_MODE and a positive bounded integer', () => {
  const sandbox = { require, process: { platform: process.platform, env: {}, execPath: process.execPath,
    stdin: { [Symbol.asyncIterator]: () => ({}) }, on() {} }, Buffer, console,
    setTimeout, clearTimeout, setInterval, clearInterval };
  vm.runInNewContext(source.slice(0, source.lastIndexOf('\nmain();'))
    + '\nthis.timeoutForTest = testTimeout;', sandbox);
  const timeout = sandbox.timeoutForTest;
  sandbox.process.env.DSH_MANAGER_START_TIMEOUT_MS = '25';
  assert.equal(timeout('START', 150000), 150000);
  sandbox.process.env.DSH_MANAGER_TEST_MODE = '1';
  assert.equal(timeout('START', 150000), 25);
  for (const invalid of ['0', '-1', '1.5', 'Infinity', '150001', 'foo', '']) {
    sandbox.process.env.DSH_MANAGER_START_TIMEOUT_MS = invalid;
    assert.equal(timeout('START', 150000), 150000, invalid);
  }
});

function transportFixture(t, extraEnv = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'whalekeeper-start-'));
  const env = { ...process.env, DSH_MANAGER_TEST_MODE: '1', DSH_MANAGER_BASE_DIR: base,
    DSH_MANAGER_PID_CHECK: '0', DSH_MANAGER_FAKE_PROCESSES: '[]',
    DSH_BIN_STUB: path.join(__dirname, 'fake-dsh.js'), ...extraEnv };
  t.after(() => {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(base, 'run', 'dsh-web.json'), 'utf8'));
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(rec.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else { try { process.kill(rec.pid, 'SIGKILL'); } catch {} }
    } catch {}
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, env };
}
function frame(request) {
  const body = Buffer.from(JSON.stringify(request));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

test('standard stdio preserves framed start/status/stop replies across a request longer than the idle watchdog', t => {
  const { env } = transportFixture(t, { DSH_FAKE_READY: '1', DSH_FAKE_READY_DELAY_MS: '16000',
    DSH_MANAGER_LAUNCH_URL_TIMEOUT_MS: '100' });
  const actions = ['start', 'status', 'stop'];
  const child = spawnSync(process.execPath, [path.join(__dirname, '..', 'host.js')], {
    input: Buffer.concat(actions.map(action => frame({ id: action, action, payload: { port: 0 } }))),
    env, timeout: 45000, windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr?.toString());
  const responses = [];
  for (let cursor = 0; cursor < child.stdout.length;) {
    const size = child.stdout.readUInt32LE(cursor); cursor += 4;
    responses.push(JSON.parse(child.stdout.subarray(cursor, cursor + size))); cursor += size;
  }
  assert.deepEqual(responses.map(response => response.id), actions);
  assert.ok(responses.every(response => response.ok), JSON.stringify(responses));
  assert.equal(responses[2].result.stopMethod, 'graceful');
  assert.ok(!child.stderr.toString().includes('看门狗退出'));
});

test('file-mode failed authenticated start returns a redacted log tail within its test-only budget', async t => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  // Allow the real Windows hidden carrier to write its diagnostic before timing
  // out; 1.8 seconds raced process startup under the full parallel test runner.
  const { base, env } = transportFixture(t, { DSH_MANAGER_START_TIMEOUT_MS: '10000',
    DSH_FAKE_EXIT_IMMEDIATELY: '1', DSH_FAKE_AUTH: '1' });
  const input = path.join(base, 'request.json'), output = path.join(base, 'response.json');
  fs.writeFileSync(input, JSON.stringify({ id: 'timeout', action: 'start', payload: { port } }));
  const child = spawnSync(process.execPath, [path.join(__dirname, '..', 'host.js'), '--req', input, '--res', output], {
    env, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr);
  const response = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(response.error.code, 'START_TIMEOUT');
  assert.ok(response.error.logTail.includes('token=[REDACTED]'));
  assert.ok(!JSON.stringify(response.error).includes('fake-launch-token-'));
  assert.ok(!child.stderr.includes('fake-launch-token-'));
  assert.ok(child.stderr.includes('phase=ready-timeout'));
});
