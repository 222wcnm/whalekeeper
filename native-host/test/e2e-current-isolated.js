'use strict';
// Real acceptance: execute the production host.js, never a modified timeout copy.
// DSH_MANAGER_NPM_PREFIX selects an npm installation; EXPECT_DSH_VERSION defaults
// to the release under acceptance. DSH_MANAGER_E2E_ROUNDS=3 repeats BOTH fixed and
// dynamic start/restart/stop in new homes. DSH_MANAGER_VERIFY_UI=1 runs UI once.
// No models, daily profiles, Native Messaging registration, or existing GUI used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { randomUUID, createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HOST = path.join(ROOT, 'native-host', 'host.js');
const PLUGIN = path.join(ROOT, 'plugin', 'dsh-lifecycle');
const FIXED_PORT = 31992;
const PROTECTED_PORTS = new Set([58398, 64847]); // Existing Harness instances are NEVER targets.
const ACTION_MS = Object.freeze({ start: 210000, restart: 240000, stop: 60000,
  status: 30000, sessions: 15000 });
const SPAWN_MARGIN_MS = 15000;
const HTTP_MS = 15000; // Absolute deadline includes headers AND response body.
const UI_MS = 240000;
const secrets = new Set();
let passed = 0;

function redact(value) {
  let text = String(value ?? '');
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  return text.replace(/([?&](?:token|access_token)=)[^\s"'<>#&\\]+/gi, '$1[redacted]')
    .replace(/((?:"|')?(?:token|cookie|set-cookie|authorization|secret|password|apiKey)(?:"|')?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1[redacted]');
}
function safe(value, key = '') {
  if (/^(?:token|cookie|set-cookie|authorization|secret|password|apiKey)$/i.test(key)) return '[redacted]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => safe(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, safe(item, name)]));
  return value;
}
function rememberSecrets(value) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.launchUrl === 'string') {
    try { const token = new URL(value.launchUrl).searchParams.get('token'); if (token) secrets.add(token); } catch { /* Invalid URLs fail the assertion below. */ }
  }
  if (value.result) rememberSecrets(value.result);
}
function check(c, name, predicate) {
  assert.ok(predicate, name);
  passed += 1;
  c.report.checks.push(name);
  console.log('PASS | current-e2e | round=' + c.round + ' | ' + name);
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(safe(value), null, 2) + '\n', { mode: 0o600 });
}
function saveReport(c) { writeJson(path.join(c.dir, 'report.json'), c.report); }
function timing(c, phase, started, details = {}) {
  const entry = { phase, elapsedMs: Math.round(performance.now() - started), ...details };
  c.report.timings.push(entry);
  console.log('TIMING | current-e2e | round=' + c.round + ' | ' + redact(JSON.stringify(entry)));
  saveReport(c);
  return entry;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function canonical(file) {
  const resolved = path.resolve(String(file));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function samePath(a, b) { return typeof a === 'string' && typeof b === 'string' && canonical(a) === canonical(b); }
function assertInside(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'Refuse a path outside this case');
}
function validPort(port) { return Number.isInteger(port) && port > 0 && port <= 65535 && !PROTECTED_PORTS.has(port); }
function addPort(c, port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return;
  assert.ok(!PROTECTED_PORTS.has(port), 'Refuse the existing Harness port');
  c.ports.add(port);
}
function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (process.platform === 'linux') {
    try { if (/^\d+ \(.*\) Z /.test(fs.readFileSync('/proc/' + pid + '/stat', 'utf8'))) return false; } catch { /* kill(0) remains authoritative. */ }
  }
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function portOpen(port, timeoutMs = 800) {
  assert.ok(validPort(port), 'Refuse an invalid/protected TCP probe');
  return new Promise(resolve => {
    let settled = false;
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = open => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(open); };
    // An inconclusive timeout is BUSY, never permission to reuse someone else's port.
    const timer = setTimeout(() => finish(true), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', error => finish(error.code !== 'ECONNREFUSED'));
  });
}
function cleanEnvironment(c, prefix) {
  const env = { ...process.env };
  // Do not inherit another profile, ready path, fake binary, clock, short budget,
  // or PID-check bypass from a developer's shell. Only isolation hooks below.
  for (const name of Object.keys(env)) if (/^DSH_/i.test(name)) delete env[name];
  return { ...env, DSH_HOME: c.home, DSH_PROFILE: 'web', DSH_TELEMETRY_DISABLED: '1',
    HOME: c.userHome, USERPROFILE: c.userHome, APPDATA: path.join(c.userHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: c.dir, XDG_CONFIG_HOME: path.join(c.userHome, '.config'),
    TMP: c.tmp, TEMP: c.tmp, TMPDIR: c.tmp,
    DSH_MANAGER_TEST_MODE: '1', DSH_MANAGER_BASE_DIR: c.base,
    DSH_MANAGER_NPM_PREFIX: prefix, npm_config_prefix: prefix,
    // Read-only external discovery is fenced; all launched processes and HTTP,
    // PID checks, budgets and lifecycle behaviour are real production paths.
    DSH_MANAGER_FAKE_PROCESSES: '[]' };
}
function resolveBin(prefix) {
  const relative = path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  return [path.join(prefix, relative), path.join(prefix, 'lib', relative)].find(file => fs.existsSync(file)) || path.join(prefix, relative);
}
function resolvePrefix() {
  if (process.env.DSH_MANAGER_NPM_PREFIX) return path.resolve(process.env.DSH_MANAGER_NPM_PREFIX);
  if (process.platform === 'win32' && process.env.APPDATA) return path.join(process.env.APPDATA, 'npm');
  const result = spawnSync('npm', ['prefix', '-g'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.ok(!result.error && result.status === 0, 'Cannot locate npm prefix; set DSH_MANAGER_NPM_PREFIX');
  const prefix = String(result.stdout || '').trim();
  assert.ok(path.isAbsolute(prefix), 'npm prefix must be absolute');
  return prefix;
}

// Parse Windows argv instead of substring matching a UUID/path prefix. Linux
// reads the kernel's NUL-delimited argv; macOS uses ps and fails closed when the
// exact --patch argument cannot be established. No broad dsh/node kill exists.
function splitCommandLine(text) {
  const argv = [];
  let part = '', quoted = false, started = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (!quoted && /\s/.test(char)) { if (started) { argv.push(part); part = ''; started = false; } continue; }
    started = true;
    if (char === '\\') {
      let end = i;
      while (text[end] === '\\') end += 1;
      const count = end - i;
      if (text[end] === '"') {
        part += '\\'.repeat(Math.floor(count / 2));
        if (count % 2) part += '"'; else quoted = !quoted;
        i = end;
      } else { part += '\\'.repeat(count); i = end - 1; }
    } else if (char === '"') quoted = !quoted;
    else part += char;
  }
  if (quoted) return [];
  if (started) argv.push(part);
  return argv;
}
function captureCommand(command, args, timeout = 10000) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  assert.ok(!result.error && result.status === 0, 'Process inspection failed: ' + redact(result.error?.message || result.stderr || command));
  return String(result.stdout || '');
}
function processRows(pid) {
  if (process.platform === 'win32') {
    const filter = pid ? 'ProcessId=' + Number(pid) : "Name='node.exe'";
    const command = '$ErrorActionPreference=\'Stop\'; @(Get-CimInstance Win32_Process -Filter ' + JSON.stringify(filter)
      + ' | Select-Object ProcessId,Name,ExecutablePath,CommandLine,@{n=\'Birth\';e={$_.CreationDate.ToUniversalTime().ToString(\'o\')}}) | ConvertTo-Json -Compress';
    const text = captureCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
    const parsed = text.trim() ? JSON.parse(text) : [];
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map(row => ({ pid: row.ProcessId,
      name: row.Name, birth: row.Birth, argv: splitCommandLine(row.CommandLine || ''), executable: row.ExecutablePath }));
  }
  if (process.platform === 'linux') {
    const entries = pid ? [String(pid)] : fs.readdirSync('/proc').filter(name => /^\d+$/.test(name));
    const rows = [];
    for (const entry of entries) {
      try {
        const argv = fs.readFileSync('/proc/' + entry + '/cmdline', 'utf8').split('\0').filter(Boolean);
        const stat = fs.readFileSync('/proc/' + entry + '/stat', 'utf8');
        const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        rows.push({ pid: Number(entry), argv, name: path.basename(argv[0] || ''), birth: tail[19] });
      } catch (error) { if (pid && !['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    }
    return rows;
  }
  const args = pid ? ['-p', String(pid), '-o', 'pid=,lstart=,args='] : ['-ax', '-o', 'pid=,lstart=,args='];
  const result = spawnSync('ps', args, { encoding: 'utf8', timeout: 10000 });
  if (pid && result.status === 1 && !String(result.stdout || '').trim()) return [];
  assert.ok(!result.error && result.status === 0, 'Cannot inspect POSIX process ownership');
  return String(result.stdout).split(/\r?\n/).flatMap(line => {
    const match = /^\s*(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/.exec(line);
    if (!match) return [];
    const argv = splitCommandLine(match[3]);
    return [{ pid: Number(match[1]), birth: match[2], argv, name: path.basename(argv[0] || '') }];
  });
}
function patchArgumentMatches(argv, patch) {
  return Array.isArray(argv) && argv.some((argument, index) =>
    (argument === '--patch' && samePath(argv[index + 1], patch))
      || (argument.startsWith('--patch=') && samePath(argument.slice(8), patch)));
}
function ownsProcess(c, row) {
  return row && row.pid !== process.pid && Number.isSafeInteger(row.pid) && row.pid > 0
    && /^(?:node|nodejs)(?:\.exe)?$/i.test(row.name || path.basename(row.argv[0] || ''))
    && row.argv.some(argument => samePath(argument, c.bin)) && patchArgumentMatches(row.argv, c.patch);
}
function rememberProcess(c, row) {
  if (!ownsProcess(c, row)) return;
  const previous = c.processes.get(row.pid);
  assert.ok(!previous || !previous.birth || !row.birth || previous.birth === row.birth, 'A recorded PID was reused; refuse cleanup');
  c.processes.set(row.pid, { pid: row.pid, birth: row.birth || previous?.birth || null });
}
function ownsRun(c, record) {
  return record && record.profile === 'web' && samePath(record.binPath, c.bin)
    && patchArgumentMatches(record.extraArgs, c.patch) && /^[a-f0-9]{32}$/.test(record.launchId || '')
    && Number.isSafeInteger(record.launchStartedAt) && record.launchStartedAt >= c.startedAt - 1000
    && Number.isSafeInteger(record.pid) && record.pid > 0 && validPort(record.port);
}
function sameLaunch(a, b) {
  return a && b && a.pid === b.pid && a.launchId === b.launchId && a.launchStartedAt === b.launchStartedAt;
}
function rememberRecords(c, phase) {
  const record = readJson(c.runFile);
  const ready = readJson(c.readyFile);
  rememberSecrets(record);
  if (ownsRun(c, record)) {
    c.launches.set(record.launchId, { pid: record.pid, port: record.port,
      launchId: record.launchId, launchStartedAt: record.launchStartedAt });
    addPort(c, record.port);
  }
  // A ready file without run is useful, but may only claim an already verified
  // process. A foreign/new lease must never become cleanup authority by itself.
  if (ready && c.processes.has(ready.pid) && /^[a-f0-9]{32}$/.test(ready.launchId || '')
      && Number.isSafeInteger(ready.launchStartedAt) && ready.launchStartedAt >= c.startedAt - 1000 && validPort(ready.port)) {
    c.launches.set(ready.launchId, { pid: ready.pid, port: ready.port,
      launchId: ready.launchId, launchStartedAt: ready.launchStartedAt });
    addPort(c, ready.port);
  }
  if (ready && [...c.launches.values()].some(launch => sameLaunch(launch, ready))) {
    c.readyOwners.set(ready.launchId, { ...ready });
  }
  c.report.observations.push({ phase, at: new Date().toISOString(), run: safe(record), ready: safe(ready) });
  c.report.processes = [...c.processes.values()];
  c.report.launches = [...c.launches.values()];
  c.report.ports = [...c.ports];
  saveReport(c);
  return { record, ready };
}
function discoverCase(c) {
  const rows = processRows().filter(row => ownsProcess(c, row));
  for (const row of rows) rememberProcess(c, row);
  rememberRecords(c, 'process-discovery');
  return rows;
}
function listeningPorts(c, row) {
  if (!ownsProcess(c, row)) return [];
  if (process.platform === 'win32') {
    return captureCommand('netstat.exe', ['-ano', '-p', 'TCP']).split(/\r?\n/).flatMap(line => {
      const columns = line.trim().split(/\s+/);
      if (columns[0] !== 'TCP' || columns[3] !== 'LISTENING' || Number(columns[4]) !== row.pid) return [];
      const match = /:(\d+)$/.exec(columns[1]);
      return match ? [Number(match[1])] : [];
    });
  }
  if (process.platform === 'linux') {
    const inodes = new Set();
    for (const name of fs.readdirSync('/proc/' + row.pid + '/fd')) {
      try { const match = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync('/proc/' + row.pid + '/fd/' + name)); if (match) inodes.add(match[1]); } catch { /* Concurrent close. */ }
    }
    const ports = [];
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const line of text.split('\n').slice(1)) {
        const columns = line.trim().split(/\s+/);
        if (columns[3] === '0A' && inodes.has(columns[9])) ports.push(parseInt(columns[1].split(':').at(-1), 16));
      }
    }
    return ports;
  }
  const result = spawnSync('lsof', ['-nP', '-a', '-p', String(row.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8', timeout: 10000 });
  if (result.status === 1 && !String(result.stdout || '').trim()) return [];
  assert.ok(!result.error && result.status === 0, 'Cannot inspect this case\'s TCP listeners');
  return String(result.stdout).split(/\r?\n/).flatMap(line => { const match = /^n.*:(\d+)$/.exec(line); return match ? [Number(match[1])] : []; });
}

function host(c, action, payload = {}, cleanup = false) {
  const id = randomUUID();
  const input = path.join(c.dir, id + '.req.json');
  const output = path.join(c.dir, id + '.res.json');
  fs.writeFileSync(input, JSON.stringify({ id, action, payload }), { mode: 0o600 });
  const budgetMs = ACTION_MS[action] || 30000;
  const started = performance.now();
  let result, response;
  try {
    if (action === 'start' || action === 'restart') { c.spawnAttempted = true; saveReport(c); }
    result = spawnSync(process.execPath, [HOST, '--req', input, '--res', output],
      { cwd: ROOT, env: c.env, encoding: 'utf8', windowsHide: true,
        timeout: budgetMs + SPAWN_MARGIN_MS, maxBuffer: 8 * 1024 * 1024 });
    response = readJson(output);
    rememberSecrets(response);
    const elapsedMs = Math.round(performance.now() - started);
    timing(c, (cleanup ? 'cleanup.' : '') + 'host.' + action, started,
      { budgetMs, spawnTimeoutMs: budgetMs + SPAWN_MARGIN_MS, exitCode: result.status,
        signal: result.signal || null, responseOk: response?.ok === true, errorCode: response?.error?.code || result.error?.code || null });
    fs.writeFileSync(path.join(c.dir, id + '.host.log'), redact((result.stdout || '') + (result.stderr || '') + (result.error?.message || '')));
    assert.ok(!result.error && result.status === 0,
      'Production host ' + action + ' failed: ' + redact(result.error?.message || result.stderr || result.signal));
    assert.ok(response && response.id === id, 'Production host must return the matching request id');
    if (cleanup && response.error?.code === 'ALREADY_STOPPED') return response.result;
    assert.equal(response.ok, true, 'Production host ' + action + ': ' + redact(JSON.stringify(response.error)));
    if (!cleanup) assert.ok(elapsedMs <= budgetMs, action + ' exceeded its real extension action budget (' + budgetMs + 'ms)');
    return response.result;
  } finally {
    // File-mode responses necessarily contain launchUrl; keep it only in memory
    // for the live local auth test, and persist a redacted evidence copy.
    if (fs.existsSync(output)) {
      const raw = fs.readFileSync(output, 'utf8');
      fs.writeFileSync(output, response ? JSON.stringify(safe(response), null, 2) : redact(raw), { mode: 0o600 });
    }
    rememberRecords(c, 'after-host-' + action);
  }
}
function requestHttp(c, port, route, { method = 'GET', headers = {}, timeoutMs = HTTP_MS, record = true } = {}) {
  assert.ok(validPort(port), 'Refuse an invalid/protected HTTP target');
  assert.ok(typeof route === 'string' && route.startsWith('/') && !route.startsWith('//'), 'HTTP must stay on this loopback authority');
  assert.ok(!Object.keys(headers).some(name => name.toLowerCase() === 'accept-encoding'), 'Never send Accept-Encoding to dsh');
  const started = performance.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    let response;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) { response?.destroy(); request.destroy(); }
      if (record) timing(c, 'http.' + method, started, { path: route.split('?')[0],
        status: value?.status || response?.statusCode || null, error: error ? redact(error.message) : null });
      if (error) reject(error); else resolve(value);
    };
    const request = http.request({ host: '127.0.0.1', port, path: route, method,
      agent: false, headers: { Connection: 'close', ...headers } }, incoming => {
      response = incoming;
      incoming.setEncoding('utf8');
      let body = '';
      incoming.on('data', chunk => {
        body += chunk;
        if (Buffer.byteLength(body) > 8 * 1024 * 1024) finish(new Error('HTTP response exceeds evidence limit'));
      });
      incoming.once('aborted', () => finish(new Error('HTTP response aborted')));
      incoming.once('error', error => finish(error));
      incoming.once('end', () => finish(null, { status: incoming.statusCode, body, headers: incoming.headers }));
    });
    // Node http adds NO Accept-Encoding, performs NO implicit decompression and
    // follows NO redirect. The one timer is never reset by headers or chunks.
    const deadline = setTimeout(() => finish(new Error('Absolute HTTP deadline: ' + method + ' ' + route.split('?')[0])), timeoutMs);
    request.once('error', error => finish(error));
    request.end();
  });
}
const get = (c, port, route, headers) => requestHttp(c, port, route, { headers });
async function fixtureAction(c, port, action) {
  const result = await get(c, port, '/_fixture?action=' + encodeURIComponent(action));
  assert.equal(result.status, 200, 'The real fixture action must succeed');
  const state = JSON.parse(result.body);
  assert.equal(state.ok, true, 'The real fixture must be ready');
  return state;
}
function stream(c, port) {
  assert.ok(validPort(port), 'Refuse an invalid/protected SSE target');
  const frames = [];
  let buffer = '', error, response, closed = false;
  const started = performance.now();
  const request = http.get({ host: '127.0.0.1', port, path: '/_manager/events', agent: false,
    headers: { Connection: 'close' } }, incoming => {
    response = incoming;
    if (incoming.statusCode !== 200 || !/^text\/event-stream/i.test(incoming.headers['content-type'] || '')) {
      error = new Error('Real SSE must answer 200 text/event-stream'); incoming.destroy(); return;
    }
    incoming.setEncoding('utf8');
    incoming.on('data', chunk => {
      buffer += chunk.replace(/\r\n/g, '\n');
      if (buffer.length > 1024 * 1024) { error = new Error('SSE frame limit exceeded'); incoming.destroy(); return; }
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const event = /^event:\s*(.+)$/m.exec(raw)?.[1];
        const data = raw.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (event && data) {
          try { frames.push({ event, data: JSON.parse(data) }); } catch { error = new Error('Malformed JSON in real SSE frame'); }
        }
      }
    });
    incoming.once('error', value => { if (!closed) error = value; });
    incoming.once('end', () => { if (!closed) error = new Error('Real SSE ended before the expected frame'); });
  });
  request.once('error', value => { if (!closed) error = value; });
  const channel = { frames, close() {
    closed = true; response?.destroy(); request.destroy(); c.streams.delete(channel);
  }, async wait(predicate, from = 0) {
    const deadline = performance.now() + HTTP_MS;
    for (;;) {
      const frame = frames.slice(from).find(predicate);
      if (frame) return frame;
      if (error) throw error;
      assert.ok(performance.now() < deadline, 'Timed out waiting for a REAL SSE frame');
      await delay(25);
    }
  } };
  c.streams.add(channel);
  timing(c, 'sse.open', started, { port });
  return channel;
}

// Kept as ordinary JS, not an opaque template string: node --check checks the
// generated fixture's function body as well. It only appends public metadata to
// real Session objects; no agents, models, /api calls or fabricated SSE frames.
function fixturePlugin(ctx, config) {
  const sessionId = 'whalekeeper-fixture';
  const server = ctx.webServer;
  const disposers = [];
  const responses = new Set();
  let disposed = false, session, detachSession = () => {}, turn = 0, approvalId;
  let state = 'idle', eventsEnabled = true, eventRequests = 0, blockedEventRequests = 0, sessionRequests = 0;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    for (const response of responses) { try { response.destroy(); } catch { /* Continue cleanup. */ } }
    responses.clear();
    try { detachSession(); } catch { /* Remaining resources still belong to this effect. */ }
    for (const dispose of disposers.reverse()) { try { dispose(); } catch { /* One failure must not mask another release. */ } }
  };
  ctx.effect(() => cleanup, 'whalekeeper.e2e-fixture');
  const replaceSession = () => {
    detachSession();
    const next = ctx.sessions.prepare(sessionId, { meta: { cwd: config.caseDir } });
    detachSession = ctx.sessions.enter(next);
    session = next;
    ctx.sessions.announce(next);
    next.append('session/title', { title: '公开兼容性验收' });
    turn = 0; approvalId = undefined; state = 'idle';
  };
  const allowed = req => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false;
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(req.headers.host || '')) return false;
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    if (req.headers.origin !== undefined) {
      try { if (new URL(req.headers.origin).origin !== new URL('http://' + req.headers.host).origin) return false; } catch { return false; }
    }
    return true;
  };
  const disconnect = () => { for (const response of [...responses]) response.destroy(); responses.clear(); };
  try {
    // The patch gates lifecycle on our provided marker. Consequently ALL real
    // route registrations occur after this case-local wrapper, with their
    // original handlers/disposers and security fences left intact.
    const descriptor = Object.getOwnPropertyDescriptor(server, 'register');
    const register = server.register;
    const wrappedRegister = function (route) {
      if (!['/_manager/events', '/_manager/sessions'].includes(route.path)) return register.call(this, route);
      return register.call(this, { ...route, handler(req, res) {
        if (route.path === '/_manager/sessions') { sessionRequests += 1; return route.handler(req, res); }
        eventRequests += 1;
        // Keep the production handler authoritative for inadmissible requests.
        if (!allowed(req) || req.method !== 'GET') return route.handler(req, res);
        if (!eventsEnabled) {
          blockedEventRequests += 1;
          res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: 'isolated E2E disconnect' }));
          return;
        }
        responses.add(res);
        res.once('close', () => responses.delete(res));
        res.once('finish', () => responses.delete(res));
        return route.handler(req, res);
      } });
    };
    Object.defineProperty(server, 'register', { configurable: true, writable: true, value: wrappedRegister });
    disposers.push(() => {
      if (Object.getOwnPropertyDescriptor(server, 'register')?.value !== wrappedRegister) return;
      if (descriptor) Object.defineProperty(server, 'register', descriptor); else delete server.register;
    });
    disposers.push(server.register({ kind: 'exact', path: '/_fixture', handler(req, res) {
      const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
      if (!allowed(req)) return reply(403, { ok: false });
      if (req.method !== 'GET') return reply(405, { ok: false });
      if (disposed || !session) return reply(503, { ok: false, error: 'fixture not ready' });
      const action = new URL(req.url, 'http://127.0.0.1').searchParams.get('action') || 'state';
      if (action === 'ask' && state !== 'waiting') {
        turn += 1; approvalId = 'fixture-approval-' + turn;
        session.append('turn/start', { turn });
        session.append('approval/asked', { id: approvalId, toolName: 'fixture' });
        state = 'waiting';
      } else if (action === 'finish' && state !== 'completed') {
        if (state !== 'waiting') { turn += 1; session.append('turn/start', { turn }); }
        if (approvalId) session.append('approval/decided', { id: approvalId, outcome: 'cancelled' });
        session.append('turn/end', { turn, reason: { kind: 'completed' } });
        approvalId = undefined; state = 'completed';
      } else if (action === 'reset') {
        eventsEnabled = true; replaceSession();
      } else if (action === 'events-off') {
        eventsEnabled = false; disconnect();
      } else if (action === 'events-on') eventsEnabled = true;
      else if (action === 'disconnect') disconnect();
      else if (!['state', 'ask', 'finish'].includes(action)) return reply(400, { ok: false });
      return reply(200, { ok: true, sessionId, state, eventsEnabled,
        activeEventConnections: responses.size, eventRequests, blockedEventRequests, sessionRequests });
    } }));
    disposers.push(ctx.appReady.onReady(() => { if (!disposed) replaceSession(); }));
    ctx.provide('whalekeeperFixtureReady', { caseId: config.caseId });
  } catch (error) { cleanup(); throw error; }
}
function writeFixture(c) {
  fs.writeFileSync(c.fixture, "export const inject = ['sessions', 'webServer', 'appReady'];\nexport const apply = " + fixturePlugin.toString() + ';\n');
  fs.writeFileSync(c.patch, '- id: web-runtime\n  config:\n    openBrowser: false\n    printUrl: true\n'
    + '- id: dsh-lifecycle\n  inject: [webServer, appExit, whalekeeperFixtureReady]\n'
    + '- insert:\n    - id: whalekeeper-fixture\n      name: ' + JSON.stringify(pathToFileURL(c.fixture).href)
    + '\n      config:\n        caseId: ' + JSON.stringify(c.id) + '\n        caseDir: ' + JSON.stringify(c.dir) + '\n');
}

async function verifyInterfaces(c, started, version, label) {
  check(c, label + ' unauthenticated index returns 401', (await get(c, started.port, '/')).status === 401);
  const manifest = await get(c, started.port, '/manifest.webmanifest');
  check(c, label + ' public manifest retains dsh fingerprint', manifest.status === 200 && /deepseek\s*harness/i.test(manifest.body));
  const status = host(c, 'status');
  const launchUrl = new URL(status.launchUrl);
  check(c, label + ' status captures exact version and loopback token URL', status.version === version
    && launchUrl.protocol === 'http:' && launchUrl.hostname === '127.0.0.1'
    && Number(launchUrl.port || 80) === started.port && launchUrl.pathname === '/'
    && !launchUrl.username && !launchUrl.password && !!launchUrl.searchParams.get('token'));
  check(c, label + ' clean URL and lifecycle health', status.url === 'http://127.0.0.1:' + started.port
    && status.health?.pid === started.pid && status.health?.port === started.port && status.lifecycle === true);
  const login = await get(c, started.port, launchUrl.pathname + launchUrl.search);
  const setCookies = login.headers['set-cookie'];
  const cookie = (Array.isArray(setCookies) ? setCookies : [setCookies]).filter(Boolean).map(value => value.split(';')[0]).join('; ');
  secrets.add(cookie);
  for (const value of cookie.split('; ')) { const at = value.indexOf('='); if (at >= 0) secrets.add(value.slice(at + 1)); }
  check(c, label + ' token exchanges via manual 303 for browser cookie', login.status === 303 && !!cookie);
  const location = new URL(login.headers.location, launchUrl);
  check(c, label + ' auth redirect stays on clean same-origin root', location.origin === launchUrl.origin && location.pathname === '/' && !location.search);
  check(c, label + ' authenticated root returns 200', (await get(c, started.port, '/', { cookie })).status === 200);
  const fixtureState = await fixtureAction(c, started.port, 'state');
  const sessions = JSON.parse((await get(c, started.port, '/_manager/sessions')).body);
  check(c, label + ' real Session title is readable', sessions.ok && sessions.items.some(item => item.sessionId === fixtureState.sessionId && item.title === '公开兼容性验收'));
  check(c, label + ' session endpoint retains cross-origin 403', (await get(c, started.port, '/_manager/sessions', { origin: 'https://untrusted.example' })).status === 403);
  const events = stream(c, started.port);
  try {
    const snapshot = await events.wait(frame => frame.event === 'snapshot');
    check(c, label + ' REAL SSE snapshot matches HTTP listing', JSON.stringify(snapshot.data.items) === JSON.stringify(sessions.items));
    let index = events.frames.length;
    await fixtureAction(c, started.port, 'ask');
    await events.wait(frame => frame.event === 'upsert' && frame.data.session?.sessionId === fixtureState.sessionId && frame.data.session.state === 'waiting', index);
    check(c, label + ' REAL Session append pushes waiting', true);
    index = events.frames.length;
    await fixtureAction(c, started.port, 'finish');
    await events.wait(frame => frame.event === 'upsert' && frame.data.session?.sessionId === fixtureState.sessionId && frame.data.session.state === 'completed', index);
    check(c, label + ' REAL Session append pushes completed', true);
    check(c, label + ' native sessions forwards real completed summary', host(c, 'sessions').items.some(item => item.sessionId === fixtureState.sessionId && item.state === 'completed'));
    writeJson(path.join(c.dir, label + '-sse.json'), events.frames);
  } finally { events.close(); }
  return status;
}
function verifyLease(c, result, label, previous) {
  const { record, ready } = rememberRecords(c, label);
  check(c, label + ' running PID/port matches isolated run', result.state === 'running' && ownsRun(c, record)
    && record.pid === result.pid && record.port === result.port);
  check(c, label + ' official ready lease matches launch triple', ready?.schemaVersion === 1 && ready.state === 'ready'
    && sameLaunch(ready, record) && ready.port === result.port && ready.host === '127.0.0.1'
    && Date.now() - ready.updatedAt <= 10000 && ready.updatedAt >= record.launchStartedAt);
  if (previous) check(c, label + ' has a fresh PID and launch identity', result.pid !== previous.pid && record.launchId !== previous.launchId);
  const row = processRows(result.pid).find(item => ownsProcess(c, item));
  check(c, label + ' real process has exact case overlay argument', !!row);
  rememberProcess(c, row);
  return { ...record };
}
async function assertExited(c, launches, label) {
  const started = performance.now();
  const ports = [...new Set(launches.map(launch => launch.port))];
  let live = [], open = [];
  do {
    live = launches.filter(launch => pidAlive(launch.pid)).map(launch => launch.pid);
    open = (await Promise.all(ports.map(async port => ({ port, open: await portOpen(port) })))).filter(item => item.open).map(item => item.port);
    if (!live.length && !open.length) break;
    await delay(100);
  } while (performance.now() - started < 5000);
  timing(c, label + '.exit', started, { livePids: live, openPorts: open });
  check(c, label + ' recorded PIDs exited and ports closed', live.length === 0 && open.length === 0);
}
async function stopAndAssert(c, record, label) {
  const stopped = host(c, 'stop');
  // NORMAL real acceptance NEVER permits force. Fault-force belongs in unit tests.
  check(c, label + ' stops strictly gracefully', stopped.state === 'stopped' && stopped.stopMethod === 'graceful');
  await assertExited(c, [record], label);
  check(c, label + ' clears run, PID and readiness lease', !fs.existsSync(c.runFile) && !fs.existsSync(c.pidFile) && !fs.existsSync(c.readyFile));
}
async function runUi(c, status) {
  await fixtureAction(c, status.port, 'reset');
  const started = performance.now();
  const result = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'verify-ui', 'verify-cdp.js')],
    { cwd: ROOT, env: { ...c.env, VERIFY_DSH_URL: status.url + '/', VERIFY_DSH_MANAGER_BASE_DIR: c.base,
      VERIFY_FIXTURE_URL: status.url + '/_fixture', VERIFY_EVIDENCE_DIR: path.join(c.dir, 'ui'),
      VERIFY_CHROME_PROFILE_DIR: path.join(c.dir, 'ui', 'chrome-profile'), VERIFY_RUN_ID: c.id },
      encoding: 'utf8', windowsHide: true, timeout: UI_MS, maxBuffer: 16 * 1024 * 1024 });
  fs.writeFileSync(path.join(c.dir, 'ui.log'), redact((result.stdout || '') + (result.stderr || '') + (result.error?.message || '')));
  timing(c, 'ui', started, { budgetMs: UI_MS, exitCode: result.status, signal: result.signal || null, errorCode: result.error?.code || null });
  assert.ok(!result.error && result.status === 0, 'Browser acceptance failed: ' + redact((result.stdout || '') + (result.stderr || '') + (result.error?.message || '')).slice(-7000));
  c.report.ui = true;
  check(c, 'browser popup/panel/auth/REAL SSE recovery regressions pass', true);
}

async function waitForCleanup(c, milliseconds) {
  const deadline = performance.now() + milliseconds;
  do {
    const pids = [...c.processes.keys()].filter(pidAlive);
    const ports = (await Promise.all([...c.ports].map(async port => ({ port, open: await portOpen(port, 400) })))).filter(item => item.open);
    if (!pids.length && !ports.length) return true;
    await delay(100);
  } while (performance.now() < deadline);
  return false;
}
function forceOwnedProcess(c, observed) {
  const fresh = processRows(observed.pid).find(row => ownsProcess(c, row));
  if (!fresh) { assert.ok(!pidAlive(observed.pid), 'Refuse force: PID is alive but no longer belongs to this exact case'); return; }
  assert.ok(!observed.birth || fresh.birth === observed.birth, 'Refuse force: PID creation identity changed');
  if (process.platform === 'win32') {
    // Revalidate birth and EXACT argv path boundaries in the terminating query,
    // too. Never /IM, wildcard command-line matching, process groups or /T.
    const ps = value => "'" + String(value).replace(/'/g, "''") + "'";
    const command = '$ErrorActionPreference=\'Stop\'; $p=Get-CimInstance Win32_Process -Filter ' + ps('ProcessId=' + observed.pid)
      + '; if (!$p) { exit 0 }; $patch=' + ps(c.patch) + '; $bin=' + ps(c.bin)
      + '; $edge=\'(?:^|[\\s"]){0}(?=$|[\\s"])\'; if ($p.Name -ne \'node.exe\' -or '
      + '$p.CreationDate.ToUniversalTime().ToString(\'o\') -ne ' + ps(fresh.birth)
      + ' -or $p.CommandLine -notmatch ($edge -f [regex]::Escape($patch))'
      + ' -or $p.CommandLine -notmatch ($edge -f [regex]::Escape($bin))) { throw \'Refuse changed case process\' }; '
      + '$r=Invoke-CimMethod -InputObject $p -MethodName Terminate; if ($r.ReturnValue -ne 0) { throw \'Exact case PID termination failed\' }';
    captureCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
  } else {
    // Per-PID only; the fresh argv/start-time guard must pass immediately before
    // SIGKILL. Unrelated descendants or reused process groups are not targets.
    try { process.kill(fresh.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  c.report.cleanup.forcedPids.push(observed.pid);
}
function removeOwnedFiles(c) {
  const matches = record => [...c.launches.values()].some(launch => sameLaunch(launch, record));
  let run = readJson(c.runFile);
  if (run && ownsRun(c, run) && matches(run) && !pidAlive(run.pid)) {
    const current = readJson(c.runFile);
    if (sameLaunch(current, run) && ownsRun(c, current)) { assertInside(c.dir, c.runFile); fs.unlinkSync(c.runFile); }
  }
  const ready = readJson(c.readyFile);
  if (ready && matches(ready) && !pidAlive(ready.pid)) {
    const owned = c.readyOwners.get(ready.launchId);
    const current = readJson(c.readyFile);
    if (owned && sameLaunch(current, owned) && current.mountId === owned.mountId) { assertInside(c.dir, c.readyFile); fs.unlinkSync(c.readyFile); }
  }
  // Plain PID has no launch triple: only remove it after the owned run is gone,
  // and only if its value is a PID independently verified for this case.
  run = readJson(c.runFile);
  if (!fs.existsSync(c.runFile) && !run && fs.existsSync(c.pidFile)) {
    const pid = Number(fs.readFileSync(c.pidFile, 'utf8').trim());
    if (c.processes.has(pid) && !pidAlive(pid)) { assertInside(c.dir, c.pidFile); fs.unlinkSync(c.pidFile); }
  }
}
async function cleanupCase(c) {
  const started = performance.now();
  c.report.cleanup = { forcedPids: [], errors: [], warnings: [], done: false };
  for (const channel of [...c.streams]) channel.close();
  const note = (kind, error) => c.report.cleanup[kind].push(redact(error.stack || error));
  let rows = [];
  try { rows = discoverCase(c); } catch (error) { note('errors', error); }
  for (const row of rows) {
    try { for (const port of listeningPorts(c, row)) addPort(c, port); } catch (error) { if (pidAlive(row.pid)) note('errors', error); }
  }
  rememberRecords(c, 'cleanup.before');
  const record = readJson(c.runFile);
  if (rows.some(row => row.pid === record?.pid) && ownsRun(c, record)) {
    try { host(c, 'stop', {}, true); } catch (error) { note('warnings', error); }
  }
  // Even with NO run record, only a kernel-verified bin + unique case patch may
  // receive shutdown or force. HTTP health must independently match PID+port.
  for (const row of rows) {
    if (!pidAlive(row.pid)) continue;
    for (const port of [...c.ports]) {
      try {
        const health = await requestHttp(c, port, '/_lifecycle/health', { timeoutMs: 2000, record: false });
        const body = JSON.parse(health.body);
        if (health.status === 200 && body.ok === true && body.pid === row.pid && body.port === port) {
          const current = processRows(row.pid).find(item => ownsProcess(c, item));
          if (current && current.birth === row.birth) await requestHttp(c, port, '/_lifecycle/shutdown', { method: 'POST', timeoutMs: 2000, record: false });
        }
      } catch (error) { note('warnings', error); }
    }
    if (process.platform !== 'win32' && pidAlive(row.pid)) {
      const current = processRows(row.pid).find(item => ownsProcess(c, item));
      if (current && current.birth === row.birth) { try { process.kill(row.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') note('warnings', error); } }
    }
  }
  if (rows.length) await waitForCleanup(c, 10000);
  // A failed launcher/carrier can create its node after the host has returned.
  // Rescan for that exact marker before deciding that no run means no process.
  if (c.spawnAttempted && !c.report.sequenceComplete) await delay(1000);
  try {
    rows = discoverCase(c);
    for (const row of rows) {
      for (const port of listeningPorts(c, row)) addPort(c, port);
      if (pidAlive(row.pid)) forceOwnedProcess(c, c.processes.get(row.pid));
    }
  } catch (error) { note('errors', error); }
  await waitForCleanup(c, 5000);
  let remaining = [];
  try { remaining = discoverCase(c); } catch (error) { note('errors', error); }
  const livePids = [...c.processes.keys()].filter(pidAlive);
  const openPorts = (await Promise.all([...c.ports].map(async port => ({ port, open: await portOpen(port, 400) })))).filter(item => item.open).map(item => item.port);
  if (!livePids.length && !openPorts.length && !remaining.length) {
    try { removeOwnedFiles(c); } catch (error) { note('errors', error); }
  }
  rememberRecords(c, 'cleanup.after');
  const files = { run: fs.existsSync(c.runFile), pid: fs.existsSync(c.pidFile), ready: fs.existsSync(c.readyFile) };
  if (c.report.sequenceComplete && c.report.cleanup.forcedPids.length) c.report.cleanup.errors.push('A normal graceful sequence needed emergency force cleanup');
  c.report.cleanup = { ...c.report.cleanup, livePids, openPorts, remainingOwnedPids: remaining.map(row => row.pid), files,
    done: !livePids.length && !openPorts.length && !remaining.length && !Object.values(files).some(Boolean) && !c.report.cleanup.errors.length };
  // Keep failure evidence, not secrets. Never truncate an active process's log.
  if (!livePids.length && !remaining.length) {
    for (const file of [path.join(c.base, 'logs', 'dsh-web.log'), path.join(c.base, 'logs', 'host.log')]) {
      if (fs.existsSync(file)) { assertInside(c.dir, file); fs.writeFileSync(file, redact(fs.readFileSync(file, 'utf8'))); }
    }
  }
  timing(c, 'cleanup', started, c.report.cleanup);
  assert.ok(c.report.cleanup.done, 'Isolated cleanup incomplete; foreign/new records were preserved. See ' + path.join(c.dir, 'report.json'));
}

function newCase(suite, round, prefix) {
  // Keep the case hierarchy short: Chrome's nested profile files still hit MAX_PATH on Windows.
  const id = 'r' + round + '-' + randomUUID().slice(0, 8);
  const dir = path.join(suite.dir, id);
  assertInside(suite.dir, dir);
  const c = { id, round, dir, startedAt: Date.now(), base: path.join(dir, 'dsh-manager'), home: path.join(dir, 'dsh-home'),
    userHome: path.join(dir, 'user-home'), tmp: path.join(dir, 'tmp'), fixture: path.join(dir, 'fixture.mjs'), patch: path.join(dir, 'fixture.patch.yml'),
    bin: resolveBin(prefix), streams: new Set(),
    processes: new Map(), launches: new Map(), readyOwners: new Map(), ports: new Set(), spawnAttempted: false };
  c.runFile = path.join(c.base, 'run', 'dsh-web.json'); c.pidFile = path.join(c.base, 'run', 'dsh-web.pid'); c.readyFile = path.join(c.base, 'ready', 'dsh-web.json');
  // SHGetFolderPath verifies USERPROFILE/AppData/Local even when LOCALAPPDATA is
  // redirected separately for native-host isolation; missing Local makes Chrome
  // unable to prove its profile is non-default and correctly refuses CDP.
  for (const file of [c.base, c.home, c.userHome, c.tmp, path.join(c.userHome, 'AppData', 'Roaming'), path.join(c.userHome, 'AppData', 'Local'), path.join(c.userHome, '.config'), path.join(dir, 'ui')]) fs.mkdirSync(file, { recursive: true });
  c.env = cleanEnvironment(c, prefix);
  c.report = { schemaVersion: 1, runId: suite.id, caseId: id, round, startedAt: new Date(c.startedAt).toISOString(),
    host: HOST, hostSha256: createHash('sha256').update(fs.readFileSync(HOST)).digest('hex'), cli: c.bin,
    expectedVersion: suite.expectedVersion, home: c.home, base: c.base, fixturePath: c.fixture, exactProcessMarker: c.patch,
    actionBudgetsMs: ACTION_MS, spawnMarginMs: SPAWN_MARGIN_MS, httpDeadlineMs: HTTP_MS, uiBudgetMs: UI_MS,
    checks: [], timings: [], observations: [], processes: [], launches: [], ports: [], ui: false, sequenceComplete: false };
  saveReport(c);
  return c;
}
async function runRound(suite, c) {
  let failure;
  const started = performance.now();
  // Enter try BEFORE version/install/host/UI can spawn anything.
  try {
    check(c, 'fixed port preflight is free (no existing service displaced)', !(await portOpen(FIXED_PORT)));
    const version = readJson(path.join(path.dirname(c.bin), '..', 'package.json'))?.version;
    check(c, 'selected CLI manifest is exactly ' + suite.expectedVersion, version === suite.expectedVersion);
    const versionStarted = performance.now();
    const versionResult = spawnSync(process.execPath, [c.bin, '--version'], { cwd: c.dir, env: c.env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    fs.writeFileSync(path.join(c.dir, 'version.log'), redact((versionResult.stdout || '') + (versionResult.stderr || '')));
    timing(c, 'cli.version', versionStarted, { exitCode: versionResult.status, version });
    check(c, 'official CLI --version proves exact release', !versionResult.error && versionResult.status === 0 && String(versionResult.stdout || '').trim() === version);
    c.report.version = version;
    const requireDsh = createRequire(c.bin);
    const { evaluatePluginCompatibility } = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-app-boot')).href);
    const manifest = readJson(path.join(PLUGIN, 'package.json'));
    for (const target of ['0.1.2-rc.1', version, '0.2.1-alpha.1']) check(c, 'official peer validation accepts ' + target, evaluatePluginCompatibility(manifest, {}, target) === undefined);
    check(c, 'peer range excludes unverified 0.3.x', evaluatePluginCompatibility(manifest, {}, '0.3.0-alpha.1') !== undefined);
    writeFixture(c);
    const installStarted = performance.now();
    const install = spawnSync(process.execPath, [c.bin, 'plugin', '--profile', 'web', 'add', PLUGIN],
      { cwd: c.dir, env: c.env, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    fs.writeFileSync(path.join(c.dir, 'install.log'), redact((install.stdout || '') + (install.stderr || '') + (install.error?.message || '')));
    timing(c, 'cli.install', installStarted, { exitCode: install.status, errorCode: install.error?.code || null });
    assert.ok(!install.error && install.status === 0, 'Official isolated plugin installation failed: ' + redact((install.stdout || '') + (install.stderr || '') + (install.error?.message || '')));
    check(c, 'local bundle admitted by official CLI without exemption', true);
    // Explicit profile and real overlay also verify production argument order.
    const fixed = host(c, 'start', { profile: 'web', launchMode: 'global', host: '127.0.0.1', port: FIXED_PORT, extraArgs: ['--patch', c.patch] });
    let fixedRun = verifyLease(c, fixed, 'fixed.start');
    check(c, 'fixed start binds requested port', fixed.port === FIXED_PORT);
    const fixedStatus = await verifyInterfaces(c, fixed, version, 'fixed');
    if (suite.verifyUi && c.round === 1) await runUi(c, fixedStatus);
    const restarted = host(c, 'restart');
    const restartedRun = verifyLease(c, restarted, 'fixed.restart', fixedRun);
    check(c, 'fixed restart retains port and case overlay', restarted.port === FIXED_PORT && patchArgumentMatches(restartedRun.extraArgs, c.patch));
    check(c, 'fixed restart waits for old PID exit', !pidAlive(fixedRun.pid));
    check(c, 'fixed restart resets fixture generation to idle', (await fixtureAction(c, restarted.port, 'state')).state === 'idle');
    fixedRun = restartedRun;
    await stopAndAssert(c, fixedRun, 'fixed.stop');
    const dynamic = host(c, 'start', { profile: 'web', launchMode: 'global', host: '127.0.0.1', port: 0, extraArgs: ['--patch', c.patch] });
    const dynamicRun = verifyLease(c, dynamic, 'dynamic.start', fixedRun);
    check(c, 'dynamic start records actual port and requested zero', validPort(dynamic.port) && dynamicRun.requestedPort === 0);
    await verifyInterfaces(c, dynamic, version, 'dynamic');
    const dynamicRestart = host(c, 'restart');
    const dynamicRestartRun = verifyLease(c, dynamicRestart, 'dynamic.restart', dynamicRun);
    check(c, 'dynamic restart retains zero-port semantics and overlay', dynamicRestartRun.requestedPort === 0 && patchArgumentMatches(dynamicRestartRun.extraArgs, c.patch));
    check(c, 'dynamic restart waits for old PID exit', !pidAlive(dynamicRun.pid));
    // The OS is allowed to reuse an ephemeral port; PID/launch must still change.
    if (dynamicRestart.port !== dynamic.port) check(c, 'previous dynamic listener closed before replacement', !(await portOpen(dynamic.port)));
    check(c, 'dynamic restart resets fixture generation to idle', (await fixtureAction(c, dynamicRestart.port, 'state')).state === 'idle');
    await stopAndAssert(c, dynamicRestartRun, 'dynamic.stop');
    await assertExited(c, [...c.launches.values()], 'round.all-launches');
    c.report.sequenceComplete = true;
  } catch (error) { failure = error; c.report.failure = redact(error.stack || error); }
  finally {
    try { await cleanupCase(c); } catch (error) {
      c.report.cleanupFailure = redact(error.stack || error);
      if (!failure) failure = error;
    }
    c.report.finishedAt = new Date().toISOString();
    c.report.ok = !failure;
    timing(c, 'round.total', started, { ok: !failure });
    saveReport(c);
  }
  if (failure) {
    const log = path.join(c.base, 'logs', 'dsh-web.log');
    if (fs.existsSync(log)) console.error(redact(fs.readFileSync(log, 'utf8').split('\n').slice(-35).join('\n')));
    console.error('Evidence: ' + c.dir);
    throw failure;
  }
  console.log('PASS | current-e2e | round=' + c.round + ' | evidence: ' + c.dir);
}
async function main() {
  const rounds = Number(process.env.DSH_MANAGER_E2E_ROUNDS || 1);
  assert.ok(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 20, 'DSH_MANAGER_E2E_ROUNDS must be an integer in 1..20');
  const id = 'run-' + Date.now().toString(36) + '-' + randomUUID().slice(0, 8);
  const suite = { schemaVersion: 1, id, dir: path.join(ROOT, '.e2e-current', id),
    expectedVersion: process.env.EXPECT_DSH_VERSION || '0.2.1-rc.2', rounds,
    verifyUi: process.env.DSH_MANAGER_VERIFY_UI === '1', startedAt: new Date().toISOString(), cases: [] };
  fs.mkdirSync(suite.dir, { recursive: true });
  let failure;
  try {
    const prefix = resolvePrefix();
    suite.prefix = prefix;
    for (let round = 1; round <= rounds; round += 1) {
      const c = newCase(suite, round, prefix);
      suite.cases.push({ round, id: c.id, evidence: c.dir });
      writeJson(path.join(suite.dir, 'report.json'), suite);
      await runRound(suite, c);
      Object.assign(suite.cases.at(-1), { ok: true, ui: c.report.ui });
    }
    assert.ok(!suite.verifyUi || suite.cases.some(c => c.ui), 'Requested browser acceptance must run in at least one round');
  } catch (error) { failure = error; suite.failure = redact(error.stack || error); }
  finally {
    suite.finishedAt = new Date().toISOString(); suite.passed = passed; suite.ok = !failure;
    writeJson(path.join(suite.dir, 'report.json'), suite);
    console.log((failure ? 'FAIL' : 'PASS') + ' | current-e2e | checks=' + passed + ' | rounds=' + suite.cases.filter(c => c.ok).length + '/' + rounds
      + ' | version=' + suite.expectedVersion + ' | evidence: ' + suite.dir);
  }
  if (failure) throw failure;
}
if (require.main === module) main().catch(error => { console.error(redact(error.stack || error)); process.exitCode = 1; });
