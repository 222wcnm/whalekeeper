'use strict';
// Current dsh acceptance against an isolated profile, without model requests.
// Defaults to the installed npm CLI; DSH_MANAGER_NPM_PREFIX selects another
// installation. DSH_MANAGER_VERIFY_UI=1 also runs the existing browser checks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CASE = path.join(ROOT, '.e2e-current', randomUUID());
const BASE = path.join(CASE, 'dsh-manager');
const HOME = path.join(CASE, 'dsh-home');
const PREFIX = process.env.DSH_MANAGER_NPM_PREFIX || path.join(process.env.APPDATA, 'npm');
const BIN = path.join(PREFIX, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const PLUGIN = path.join(ROOT, 'plugin', 'dsh-lifecycle');
const READY = path.join(BASE, 'ready', 'dsh-web.json');
const ENV = { ...process.env, DSH_HOME: HOME, DSH_TELEMETRY_DISABLED: '1',
  DSH_MANAGER_TEST_MODE: '1', DSH_MANAGER_BASE_DIR: BASE,
  DSH_MANAGER_NPM_PREFIX: PREFIX, DSH_MANAGER_FAKE_PROCESSES: '[]',
  DSH_MANAGER_PID_CHECK: '0', DSH_BIN_STUB: '' };
let passed = 0;
const redact = text => String(text).replace(/([?&]token=)[^\s"']+/g, '$1[redacted]');
function check(name, predicate) {
  assert.ok(predicate, name);
  passed += 1;
  console.log('PASS | current-e2e | ' + name);
}
function runRecord() {
  try { return JSON.parse(fs.readFileSync(path.join(BASE, 'run', 'dsh-web.json'), 'utf8')); }
  catch { return null; }
}
function host(action, payload = {}) {
  const id = randomUUID();
  const input = path.join(CASE, id + '.req.json');
  const output = path.join(CASE, id + '.res.json');
  fs.writeFileSync(input, JSON.stringify({ id, action, payload }));
  const result = spawnSync(process.execPath, [path.join(ROOT, 'native-host', 'host.js'), '--req', input, '--res', output],
    { env: ENV, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(result.status, 0, redact(result.stderr || result.error));
  const response = JSON.parse(fs.readFileSync(output, 'utf8'));
  fs.writeFileSync(path.join(CASE, id + '.host.log'), redact(result.stderr || ''));
  assert.equal(response.ok, true, redact(JSON.stringify(response.error)));
  return response.result;
}
async function get(port, route, headers) {
  const response = await fetch('http://127.0.0.1:' + port + route,
    { headers, redirect: 'manual', signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.text(), headers: response.headers };
}
function stream(port) {
  const frames = [];
  let buffer = '';
  let error;
  const request = http.get({ host: '127.0.0.1', port, path: '/_manager/events', agent: false }, response => {
    response.setEncoding('utf8');
    response.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (event && data) frames.push({ event, data: JSON.parse(data) });
      }
    });
    response.on('error', value => { error = value; });
  });
  request.on('error', value => { error = value; });
  return { request, frames, async wait(predicate) {
    const deadline = Date.now() + 5000;
    while (!frames.some(predicate)) {
      if (error) throw error;
      assert.ok(Date.now() < deadline, 'Timed out waiting for real SSE frame');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } };
}
async function main() {
  fs.mkdirSync(CASE, { recursive: true });
  const version = JSON.parse(fs.readFileSync(path.join(PREFIX, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version;
  check('installed current dsh ' + version, /^0\.2\./.test(version));
  const requireDsh = createRequire(BIN);
  const { evaluatePluginCompatibility } = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-app-boot')).href);
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'));
  for (const target of ['0.1.2-rc.1', version, '0.2.1-alpha.1']) {
    check('official peer validation accepts ' + target, evaluatePluginCompatibility(manifest, {}, target) === undefined);
  }
  check('peer range excludes unverified 0.3.x', evaluatePluginCompatibility(manifest, {}, '0.3.0-alpha.1') !== undefined);

  // Install through the supported CLI so the actual compatibility and bundle
  // admission checks run; no version exemption or direct lifecycle mount.
  const install = spawnSync(process.execPath, [BIN, 'plugin', '--profile', 'web', 'add', PLUGIN],
    { cwd: ROOT, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  fs.writeFileSync(path.join(CASE, 'install.log'), redact((install.stdout || '') + (install.stderr || '')));
  assert.equal(install.status, 0, redact((install.stdout || '') + (install.stderr || '') + (install.error || '')));
  check('local lifecycle bundle installed without exemption', true);

  // Fixture owns real Session objects and append/event dispatch. It supplies
  // deterministic public metadata; it does not start agents or call a model.
  const fixture = path.join(CASE, 'fixture.mjs');
  fs.writeFileSync(fixture, `export const inject = ['sessions', 'webServer', 'appReady'];
export function apply(ctx) {
  let session;
  ctx.appReady.onReady(() => {
    session = ctx.sessions.create('whalekeeper-fixture', { meta: { cwd: ${JSON.stringify(CASE)} } });
    session.append('session/title', { title: '公开兼容性验收' });
  });
  ctx.webServer.register({ kind: 'exact', path: '/_fixture', handler(req, res) {
    const action = new URL(req.url, 'http://127.0.0.1').searchParams.get('action');
    if (action === 'ask') {
      session.append('turn/start', { turn: 1 });
      session.append('approval/asked', { id: 'fixture-approval', toolName: 'fixture' });
    } else if (action === 'finish') {
      session.append('approval/decided', { id: 'fixture-approval', outcome: 'cancelled' });
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    }
    res.writeHead(200); res.end('ok');
  } });
}
`);
  const patch = path.join(CASE, 'fixture.patch.yml');
  fs.writeFileSync(patch, `- id: web-runtime\n  config:\n    openBrowser: false\n    printUrl: true\n- insert:\n    - id: whalekeeper-fixture\n      name: '${pathToFileURL(fixture).href}'\n`);
  let events;
  try {
    // Passing a real overlay through extraArgs also verifies launcher ordering.
    const start = host('start', { port: 31992, extraArgs: ['--patch', patch] });
    check('fixed port start reports running', start.state === 'running' && start.port === 31992);
    const ready = JSON.parse(fs.readFileSync(READY, 'utf8'));
    check('official startup publishes matching ready lease', ready.state === 'ready'
      && ready.launchId === runRecord().launchId && ready.pid === start.pid && ready.port === start.port);
    check('unauthenticated index returns 401', (await get(start.port, '/')).status === 401);
    const fingerprint = await get(start.port, '/manifest.webmanifest');
    check('public manifest retains dsh fingerprint', fingerprint.status === 200 && /deepseek\s*harness/i.test(fingerprint.body));
    const status = host('status');
    check('status captures current version and token URL', status.version === version && new URL(status.launchUrl).searchParams.has('token'));
    check('status keeps clean local URL and lifecycle health', status.url === 'http://127.0.0.1:' + start.port
      && status.health?.pid === status.pid && status.lifecycle === true);
    const login = await get(start.port, new URL(status.launchUrl).pathname + new URL(status.launchUrl).search);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    check('launch token exchanges for browser cookie', login.status === 303 && !!cookie);
    check('authenticated page opens', (await get(start.port, '/', { cookie })).status === 200);
    const sessions = JSON.parse((await get(start.port, '/_manager/sessions')).body);
    check('real snapshotEvents session title is readable', sessions.ok && sessions.items.some(item => item.title === '公开兼容性验收'));
    check('session endpoint retains cross-origin fence', (await get(start.port, '/_manager/sessions', { origin: 'https://untrusted.example' })).status === 403);
    events = stream(start.port);
    await events.wait(frame => frame.event === 'snapshot');
    check('real SSE snapshot matches sessions listing', JSON.stringify(events.frames[0].data.items) === JSON.stringify(sessions.items));
    await get(start.port, '/_fixture?action=ask');
    await events.wait(frame => frame.event === 'upsert' && frame.data.session.state === 'waiting');
    check('real Session append pushes waiting', true);
    await get(start.port, '/_fixture?action=finish');
    await events.wait(frame => frame.event === 'upsert' && frame.data.session.state === 'completed');
    check('real Session append pushes completed', true);
    check('native sessions forwards current summaries', host('sessions').items.some(item => item.state === 'completed'));
    events.request.destroy(); events = undefined;
    if (process.env.DSH_MANAGER_VERIFY_UI === '1') {
      const ui = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'verify-ui', 'verify-cdp.js')],
        { cwd: ROOT, env: { ...ENV, LOCALAPPDATA: CASE, VERIFY_DSH_URL: status.url + '/' },
          encoding: 'utf8', windowsHide: true, timeout: 180000 });
      fs.writeFileSync(path.join(CASE, 'ui.log'), redact((ui.stdout || '') + (ui.stderr || '')));
      assert.equal(ui.status, 0, redact((ui.stdout || '') + (ui.stderr || '')).slice(-7000));
      check('browser popup, panel and session regressions pass', true);
    }
    const restarted = host('restart');
    check('restart retains overlay and changes PID', restarted.state === 'running' && restarted.pid !== start.pid);
    check('restart clears previous fixture generation', JSON.parse((await get(restarted.port, '/_manager/sessions')).body).items[0].state === 'idle');
    const stop = host('stop');
    check('fixed instance stops gracefully and clears ready file', stop.state === 'stopped' && stop.stopMethod === 'graceful' && !fs.existsSync(READY));
    const dynamic = host('start', { port: 0, extraArgs: ['--patch', patch] });
    const dynamicReady = JSON.parse(fs.readFileSync(READY, 'utf8'));
    check('dynamic port start reports actual port and fresh launch', dynamic.state === 'running' && dynamic.port > 0
      && dynamicReady.port === dynamic.port && dynamicReady.launchId !== ready.launchId);
    const dynamicStop = host('stop');
    check('dynamic instance stops gracefully and clears records', dynamicStop.stopMethod === 'graceful' && !runRecord() && !fs.existsSync(READY));
  } finally {
    events?.request.destroy();
    if (runRecord()) host('stop');
  }
  console.log('PASS ' + passed + ' / FAIL 0 | ' + version + ' | evidence: ' + CASE);
}
main().catch(error => {
  const log = path.join(BASE, 'logs', 'dsh-web.log');
  if (fs.existsSync(log)) console.error(redact(fs.readFileSync(log, 'utf8').split('\n').slice(-35).join('\n')));
  console.error(redact(error.stack || error));
  console.error('Evidence: ' + CASE);
  process.exitCode = 1;
});
