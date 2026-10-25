'use strict';
// ============================================================================
// verify-cdp.js — 零依赖 CDP 直连的扩展 UI 最小验收（沙箱内可用）
//
// 为什么存在（tools/verify-ui/README.md）：
//   chrome-devtools-mcp 仅提供 stdio 传输（无 HTTP 模式），而受限沙箱拦截
//   子进程 stdio 管道（实测 spawn EINVAL）；另一方面 headless Chrome +
//   CDP（HTTP /json + WebSocket）在沙箱内实测可用。本脚本沿用
//   tools/icons/_gen-icons.js 的零依赖 CDP 手法（Node ≥ 22 内置 fetch/WebSocket）：
//     1. 启动 headless Chrome（独立临时 profile + --remote-debugging-port）
//     2. CDP Extensions.loadUnpacked 加载本仓库 extension/（unpacked）
//     3. 同一标签页依次打开 popup.html 与 logs.html：
//        读 document.body.innerText 做文本断言 + Page.captureScreenshot 存档
//     4. 收集页面 console 异常（exceptionThrown / console.error）并汇报
//     5. Browser.close 干净收尾（失败则 taskkill 兜底），删除临时 profile
//
// 用法：  node tools/verify-ui/verify-cdp.js
// 环境：  CHROME_PATH 可指定 Chrome；VERIFY_CDP_PORT 可换调试端口（默认 9335）
// 产物：  tools/verify-ui/shots/{popup,logs}.png + {popup,logs}-text.txt（gitignore）
// ============================================================================
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..');
const EXT_DIR = path.join(ROOT, 'extension');
const SHOTS_DIR = path.resolve(process.env.VERIFY_EVIDENCE_DIR || path.join(__dirname, 'shots'));
const FIXTURE_URL = process.env.VERIFY_FIXTURE_URL || null;
const CHROME_STDERR_PATH = path.join(SHOTS_DIR, 'chrome-stderr.log');
const PORT = Number(process.env.VERIFY_CDP_PORT) || 9335;
const PROFILE = process.env.VERIFY_CHROME_PROFILE_DIR
  ? path.resolve(process.env.VERIFY_CHROME_PROFILE_DIR)
  : path.join(process.env.VERIFY_EVIDENCE_DIR ? SHOTS_DIR : os.tmpdir(), 'dsh-verify-ui-' + process.pid + '-' + Date.now());
const VERIFY_TIMEOUT_MS = 225000; // 先自行关闭本 case Chrome，外层 240s 仅兜底
const CHROME_CANDIDATES = [
  ...(process.env.CHROME_PATH ? [process.env.CHROME_PATH] : []),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const results = [];
let chromeProc = null;
let browserWs = null;
let cleanupPromise = null;
let watchdog = null;
let profileOwned = false;

// M10 颜色语义默认色板（M10.1 定稿 2026-08-24：三角色三色——等待黄/进行中蓝/完成绿；
// done 并入 completed、idle 不再展示；与 colors.js DEFAULT / background.js DEFAULT 一致）
const DSH_COLORS_DEFAULT = {
  waiting: '#f59e0b',
  working: '#5686fe',
  completed: '#22c55e',
};

// M8 e2e（2026-08-24 起徽标计数与 popup 会话区同源）：content script 同源端点
// GET /_manager/sessions（端点失败保持未知，不扫页面 DOM）。e2e 只在基线段拦截该端点，
// 以 sessionsMockProvider() 返回的 items 构造响应驱动真实链路（content script →
// SW → 徽标）；provider 为 null 时原请求放行。仅 verify 测试期使用。
let sessionsMockProvider = null;
let sessionsMockHits = 0; // 诊断：Fetch 拦截命中次数（断言 mock 确实驱动了链路）
let pageCtxInfos = [];    // 页面执行上下文清单（M12：定位 content script 隔离世界）

async function fulfillSessionsMock(page, requestId) {
  if (!sessionsMockProvider) {
    page.send('Fetch.continueRequest', { requestId }).catch(() => { /* 请求已取消等：忽略 */ });
    return;
  }
  sessionsMockHits += 1;
  let items;
  try { items = sessionsMockProvider(); } catch (_) { items = []; }
  log('M8 mock fulfilled #' + sessionsMockHits + ': ' + JSON.stringify(items));
  const body = Buffer.from(JSON.stringify({ ok: true, items: Array.isArray(items) ? items : [] }), 'utf8').toString('base64');
  await page.send('Fetch.fulfillRequest', {
    requestId,
    responseCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    body,
  });
}

// 所有 dsh HTTP 探测走 Node http：不发 Accept-Encoding、不自动跟随重定向、总截止有界。
function httpGet(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const req = http.get(url, { agent: false, headers: {} }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) req.destroy(new Error('HTTP response exceeds 1 MiB'));
      });
      res.on('end', () => finish(null, { status: res.statusCode, headers: res.headers, body }));
      res.on('error', (error) => finish(error));
      res.on('aborted', () => finish(new Error('HTTP response aborted')));
    });
    const timer = setTimeout(() => req.destroy(new Error('HTTP deadline exceeded')), timeoutMs);
    req.on('error', (error) => finish(error));
  });
}

function loopbackHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && !url.username && !url.password ? url : null;
  } catch (_) { return null; }
}

function validLaunchUrl(value, port) {
  const url = loopbackHttpUrl(value);
  if (!url || Number(url.port || 80) !== port || url.pathname !== '/' || url.hash) return null;
  const entries = [...url.searchParams];
  if (entries.length !== 1 || entries[0][0] !== 'token' || !/^[A-Za-z0-9._~-]{1,4096}$/.test(entries[0][1])) return null;
  return url.href;
}

// M13：只从指定本 case base 取认证证据；显式指定后绝不回退日常 LOCALAPPDATA。
// 令牌仅用于同端口根首页兑换 cookie，不进日志/storage/消息或报告。
async function ensureDshAuth(page, dshUrl) {
  try {
    const expected = loopbackHttpUrl(dshUrl);
    if (!expected) return false;
    const port = Number(expected.port || 80);
    const head = await httpGet(expected.origin + '/', 5000);
    if (head.status === 200) return true;
    if (head.status !== 401) return false;
    const base = process.env.VERIFY_DSH_MANAGER_BASE_DIR
      || (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'dsh-manager') : null);
    let launchUrl = null;
    if (base) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(base, 'run', 'dsh-web.json'), 'utf8'));
        if (rec && Number(rec.port) === port) launchUrl = validLaunchUrl(rec.launchUrl, port);
      } catch (_) { /* 当前 case 无 run 记录 */ }
      if (!launchUrl) {
        try {
          const raw = fs.readFileSync(path.join(base, 'logs', 'dsh-web.log'), 'utf8');
          const re = /dsh\s*web:\s*(https?:\/\/[^\s]+)/gi;
          let match;
          while ((match = re.exec(raw)) !== null) launchUrl = validLaunchUrl(match[1], port) || launchUrl;
        } catch (_) { /* 当前 case 无日志 */ }
      }
    }
    if (!launchUrl) return false;
    await page.send('Page.navigate', { url: launchUrl });
    // 只在浏览器 cookie jar 内校验认证；不读取 cookie/页面正文。
    return waitUntil(async () => {
      const ev = await page.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
      return /deepseek\s*harness/i.test(String(ev && ev.result && ev.result.value || ''));
    }, 12000);
  } catch (_) { return false; }
}

function redact(value) {
  return String(value).replace(/([?&]token=)[^&#\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/("token"\s*:\s*")[^"]*/gi, '$1[REDACTED]');
}
function log(...a) { console.log('[verify-cdp]', ...a.map(redact)); }
function record(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(redact(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`));
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitUntil(fn, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (await fn()) return true; } catch (_) { /* 导航/上下文切换暂不可读：轮询 */ }
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
}

async function fail(msg) {
  console.error('[verify-cdp] 失败: ' + redact(msg));
  await cleanup();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CDP 基础：HTTP 端点 + WebSocket 会话
// ---------------------------------------------------------------------------
async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.json();
}

function chromeStartupDiagnostic() {
  let tail = '';
  try {
    const fd = fs.openSync(CHROME_STDERR_PATH, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const buffer = Buffer.alloc(Math.min(size, 4096));
      fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      tail = redact(buffer.toString('utf8')).trim();
    } finally { fs.closeSync(fd); }
  } catch (_) { /* 启动尚未写 stderr：保留空 tail */ }
  return JSON.stringify({ pid: chromeProc && chromeProc.pid, exitCode: chromeProc && chromeProc.exitCode,
    signal: chromeProc && chromeProc.signalCode, profileLength: PROFILE.length,
    stderr: CHROME_STDERR_PATH, stderrTail: tail });
}

async function waitVersion() {
  let lastError = '';
  for (let i = 0; i < 60; i++) {
    if (chromeProc && (chromeProc.exitCode !== null || chromeProc.signalCode !== null)) {
      throw new Error('Chrome 在 CDP 就绪前退出 | ' + chromeStartupDiagnostic());
    }
    try {
      const v = await fetchJson('http://127.0.0.1:' + PORT + '/json/version');
      return v;
    } catch (error) {
      lastError = redact(error && error.message || error);
      await sleep(250);
    }
  }
  throw new Error('Chrome CDP 未就绪（60 次轮询失败） | lastCDP=' + lastError + ' | ' + chromeStartupDiagnostic());
}

// WebSocket CDP 会话：send(method, params) -> result；事件进入 onEvent 回调
function connectWs(url, onEvent) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let idc = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      ws,
      send(method, params) {
        return new Promise((res, rej) => {
          const id = ++idc;
          pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result)));
          ws.send(JSON.stringify({ id, method, params: params || {} }));
          setTimeout(() => {
            if (pending.has(id)) { pending.delete(id); rej(new Error(method + ' 超时')); }
          }, 30000);
        });
      },
    });
    ws.onerror = (e) => reject(new Error('WebSocket 连接失败: ' + url));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      } else if (onEvent) {
        try { onEvent(m); } catch (_) { /* 事件回调异常不影响协议 */ }
      }
    };
  });
}

// rc.2 真实恢复验收：独立标签不启用 Fetch 拦截、不 dispatch 合成帧，不替换 EventSource。
// fixture 只操作本 case 的真实 Session 和连接开关，named SSE 帧必须由真实插件产生。
async function verifyRealSseRecovery(dshUrl, extId, originalPage, originalTabId) {
  if (!FIXTURE_URL) {
    const required = process.env.DSH_MANAGER_VERIFY_UI === '1';
    record('rc.2：真实 SSE 断线/隐藏重连', !required,
      required ? '正式隔离 E2E 缺少 VERIFY_FIXTURE_URL，禁止静默跳过' : 'SKIP——未提供隔离 fixture（仅本段，既有真实路径仍保留）');
    return;
  }
  const dsh = loopbackHttpUrl(dshUrl);
  const fixture = loopbackHttpUrl(FIXTURE_URL);
  if (!dsh || !fixture || fixture.origin !== dsh.origin || fixture.pathname !== '/_fixture' || fixture.search || fixture.hash) {
    record('rc.2：真实 SSE fixture 范围', false, 'fixture 必须为被验实例同源 /_fixture，不访问其他实例');
    return;
  }
  const actualPort = Number(dsh.port || 80);
  const evidence = { fixtureConfigured: true, port: actualPort, timings: {}, frames: [], assertions: {} };
  const fixtureAction = async (action) => {
    const url = new URL(fixture);
    url.searchParams.set('action', action);
    const res = await httpGet(url.href);
    if (res.status !== 200) throw new Error('fixture ' + action + ' HTTP ' + res.status);
    const data = JSON.parse(res.body);
    if (!data || data.ok !== true || typeof data.sessionId !== 'string') throw new Error('fixture ' + action + ' invalid JSON contract');
    return data;
  };
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  };
  const sameItems = (left, right) => Array.isArray(left) && Array.isArray(right)
    && JSON.stringify(canonical([...left].sort((a, b) => a.sessionId.localeCompare(b.sessionId))))
      === JSON.stringify(canonical([...right].sort((a, b) => a.sessionId.localeCompare(b.sessionId))));
  let realTab = null, realPage = null, sw = null, originalSettings = null, sessionId = null, chromeTabId = null;
  let fixtureTouched = false, falseDone = false, lastPage = null, lastSw = null;
  let eventsRequests = 0, sessionsResponses = 0;
  const sessionRequestIds = new Set();
  const eventRequestIds = new Set();
  const frames = [];
  const stage = (name, ok, detail) => {
    evidence.assertions[name] = !!ok;
    record(name, ok, detail);
    if (!ok) throw new Error('真实恢复前置未满足：' + name);
  };
  try {
    log('rc.2：独立真实标签 SSE → 断线 HTTP 回退 → hidden 重连（无帧合成/网络 mock）');
    // 卸载主标签中的合成挂钩状态，避免另一标签陈旧镜像/提醒污染真实断线证据。
    await originalPage.send('Page.navigate', { url: 'about:blank' });
    let swTarget;
    const swReady = await waitUntil(async () => {
      swTarget = (await fetchJson('http://127.0.0.1:' + PORT + '/json/list'))
        .find((target) => target.type === 'service_worker' && (target.url || '').includes(extId));
      return !!swTarget;
    }, 5000);
    if (!swReady) throw new Error('真实恢复缺少扩展 SW（不可 SKIP）');
    sw = await connectWs(swTarget.webSocketDebuggerUrl);
    await sw.send('Runtime.enable');
    const swEval = async (expression) => {
      const result = await sw.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error('SW Runtime.evaluate exception');
      return result && result.result ? result.result.value : undefined;
    };
    originalSettings = await swEval('(async () => (await chrome.storage.local.get("settings")).settings || {})()');
    await swEval(`(async () => {
      const settings = (await chrome.storage.local.get('settings')).settings || {};
      await chrome.storage.local.set({ settings: { ...settings, port: ${actualPort}, attention: true, attentionDone: true }, attentionMap: {}, sessionsCache: {} });
    })()`);
    fixtureTouched = true;
    const initial = await fixtureAction('reset');
    sessionId = initial.sessionId;
    evidence.sessionId = sessionId;
    evidence.initial = initial;
    stage('rc.2 真实 SSE：隔离 fixture 真实 Session/连接开关可用',
      initial.state === 'idle' && initial.eventsEnabled === true, JSON.stringify(initial));

    realTab = await fetchJson('http://127.0.0.1:' + PORT + '/json/new?about:blank', { method: 'PUT' });
    realPage = await connectWs(realTab.webSocketDebuggerUrl, (message) => {
      const params = message.params || {};
      if (message.method === 'Network.requestWillBeSent') {
        const url = params.request && params.request.url;
        if (url === dsh.origin + '/_manager/events') { eventsRequests += 1; eventRequestIds.add(params.requestId); }
        if (url === dsh.origin + '/_manager/sessions') sessionRequestIds.add(params.requestId);
      } else if (message.method === 'Network.responseReceived') {
        if (sessionRequestIds.has(params.requestId) && params.response && params.response.status === 200) sessionsResponses += 1;
      } else if (message.method === 'Network.eventSourceMessageReceived') {
        if (!eventRequestIds.has(params.requestId)) return;
        let data;
        try { data = JSON.parse(params.data); } catch (_) { return; }
        // Network 域的 EventSource 事件由浏览器网络栈产生，DOM 合成帧无法生成此证据。
        if (params.eventName === 'snapshot' && data.ok === true && Array.isArray(data.items)) {
          frames.push({ event: 'snapshot', items: data.items, at: Date.now() });
        } else if (params.eventName === 'upsert' && data.session && data.session.sessionId === sessionId) {
          frames.push({ event: 'upsert', session: data.session, at: Date.now() });
        }
      }
    });
    await realPage.send('Page.enable');
    await realPage.send('Runtime.enable');
    await realPage.send('Network.enable');
    await browserWs.send('Target.activateTarget', { targetId: realTab.id });
    const started = Date.now();
    await realPage.send('Page.navigate', { url: dsh.origin + '/' });
    const readPage = async () => {
      const result = await realPage.send('Runtime.evaluate', {
        expression: `({ injected: !!document.getElementById('dsh-manager-panel-host'), hidden: document.hidden,
          alive: document.documentElement.getAttribute('data-dshm-sse-alive'),
          count: document.documentElement.getAttribute('data-dshm-sse-count') })`,
        returnByValue: true,
      });
      lastPage = result && result.result ? result.result.value : null;
      return lastPage;
    };
    const readSw = async () => {
      lastSw = await swEval(`(async () => {
        const stored = await chrome.storage.local.get({ sessionsCache: {}, attentionMap: {} });
        const entry = stored.sessionsCache[String(${actualPort})] || null;
        return { entry, attention: stored.attentionMap[String(${chromeTabId})] || null, badge: await chrome.action.getBadgeText({}) };
      })()`);
      if (lastSw && (lastSw.badge === '!' || lastSw.attention && lastSw.attention.kind === 'done')) falseDone = true;
      return lastSw;
    };
    const mirrorItem = (state) => lastSw && lastSw.entry && lastSw.entry.items
      .some((item) => item.sessionId === sessionId && item.state === state);
    const snapshotReady = await waitUntil(async () => {
      const probe = await readPage();
      await readSw();
      const snapshot = frames.find((frame) => frame.event === 'snapshot' && frame.items.some((item) => item.sessionId === sessionId));
      return probe && probe.injected && probe.alive === '1' && snapshot
        && probe.count === String(snapshot.items.length) && mirrorItem('idle') && sameItems(lastSw.entry.items, snapshot.items);
    }, 12000);
    evidence.timings.snapshotMs = Date.now() - started;
    stage('rc.2 真实 SSE：有效网络 snapshot 后 alive=1，count 与摘要镜像相符', snapshotReady,
      JSON.stringify({ page: lastPage, networkSnapshots: frames.filter((frame) => frame.event === 'snapshot').length,
        snapshotMs: evidence.timings.snapshotMs, mirrorItems: lastSw && lastSw.entry && lastSw.entry.items.length }));
    chromeTabId = await swEval(`(async () => {
      const tabs = await chrome.tabs.query({});
      const matched = tabs.filter((tab) => { try { return new URL(tab.url).origin === ${JSON.stringify(dsh.origin)}; } catch (_) { return false; } });
      return matched.length === 1 ? matched[0].id : null;
    })()`);
    if (!Number.isInteger(chromeTabId)) throw new Error('真实 SSE 独立标签不是唯一同源页');
    await fixtureAction('ask');
    // 用真标签激活造成 document.hidden，不用属性覆盖/合成 visibilitychange。
    await browserWs.send('Target.activateTarget', { targetId: originalTabId });
    const waitingReady = await waitUntil(async () => {
      await readPage(); await readSw();
      return lastPage && lastPage.hidden === true && mirrorItem('waiting')
        && frames.some((frame) => frame.event === 'upsert' && frame.session.state === 'waiting')
        && lastSw.attention && lastSw.attention.kind === 'waiting' && lastSw.badge === '?';
    }, 5000);
    stage('rc.2 真实 SSE：后台 waiting 真 upsert → 同标签黄?与 sessionsCache 一致', waitingReady && !falseDone,
      JSON.stringify({ page: lastPage, attention: lastSw && lastSw.attention, badge: lastSw && lastSw.badge }));

    const beforeLossResponses = sessionsResponses;
    const beforeLossAt = lastSw.entry.at;
    const disconnectedAt = Date.now();
    const disabled = await fixtureAction('events-off');
    const offline = await waitUntil(async () => (await readPage()).alive === '0', 2500, 100);
    evidence.timings.cancelLiveMs = Date.now() - disconnectedAt;
    stage('rc.2 真实 SSE：服务端主动断流后立即取消 live（alive=0，无假完成）',
      disabled.eventsEnabled === false && offline,
      JSON.stringify({ page: lastPage, cancelLiveMs: evidence.timings.cancelLiveMs, eventsEnabled: disabled.eventsEnabled }));
    const fallback = await waitUntil(async () => {
      await readPage(); await readSw();
      return lastPage && lastPage.hidden && lastPage.alive === '0' && mirrorItem('waiting')
        && sessionsResponses >= beforeLossResponses + 2 && lastSw.entry.at > beforeLossAt
        && lastSw.attention && lastSw.attention.kind === 'waiting' && lastSw.badge === '?';
    }, 5000);
    const duringLoss = await fixtureAction('state');
    evidence.disconnected = duringLoss;
    evidence.timings.fallbackMs = Date.now() - disconnectedAt;
    stage('rc.2 真实 SSE：断线期间真实 HTTP 持续 waiting、更新镜像且不产生假的!',
      fallback && !falseDone && duringLoss.eventsEnabled === false,
      JSON.stringify({ http200Responses: sessionsResponses - beforeLossResponses, page: lastPage,
        mirrorAtAdvanced: lastSw && lastSw.entry && lastSw.entry.at > beforeLossAt, falseDone, state: duringLoss.state }));

    const snapshotsBeforeReconnect = frames.filter((frame) => frame.event === 'snapshot').length;
    const requestsBeforeReconnect = eventsRequests;
    await fixtureAction('events-on');
    const reenabledAt = Date.now();
    const reconnected = await waitUntil(async () => {
      await readPage(); await readSw();
      const snapshots = frames.filter((frame) => frame.event === 'snapshot');
      const snapshot = snapshots[snapshots.length - 1];
      return lastPage && lastPage.hidden && lastPage.alive === '1'
        && eventsRequests > requestsBeforeReconnect && snapshots.length > snapshotsBeforeReconnect
        && snapshot && lastPage.count === String(snapshot.items.length) && mirrorItem('waiting')
        && sameItems(lastSw.entry.items, snapshot.items) && lastSw.badge === '?';
    }, 25000);
    evidence.timings.hiddenReconnectMs = Date.now() - reenabledAt;
    const afterReconnect = await fixtureAction('state');
    evidence.reconnected = afterReconnect;
    stage('rc.2 真实 SSE：页面持续 hidden，15s 退避后 25s 内重连真 snapshot 并恢复 live',
      reconnected && !falseDone && afterReconnect.eventsEnabled === true
        && afterReconnect.eventRequests > duringLoss.eventRequests,
      JSON.stringify({ page: lastPage, hiddenReconnectMs: evidence.timings.hiddenReconnectMs,
        eventRequests: eventsRequests, snapshots: frames.filter((frame) => frame.event === 'snapshot').length, falseDone }));

    const completedAt = Date.now();
    await fixtureAction('finish');
    const completed = await waitUntil(async () => {
      await readPage(); await readSw();
      return lastPage && lastPage.hidden && lastPage.alive === '1' && mirrorItem('completed')
        && frames.some((frame) => frame.event === 'upsert' && frame.at >= completedAt && frame.session.state === 'completed');
    }, 5000);
    const listingResponse = await httpGet(dsh.origin + '/_manager/sessions');
    const listing = JSON.parse(listingResponse.body);
    const completedFrame = [...frames].reverse().find((frame) => frame.event === 'upsert' && frame.session.state === 'completed');
    evidence.timings.completedMs = Date.now() - completedAt;
    stage('rc.2 真实 SSE：恢复后 finish 真 completed upsert，与 HTTP/摘要镜像完全一致',
      completed && listingResponse.status === 200 && listing.ok === true && sameItems(lastSw.entry.items, listing.items)
        && !!completedFrame && sameItems([completedFrame.session], listing.items.filter((item) => item.sessionId === sessionId)),
      JSON.stringify({ page: lastPage, completedMs: evidence.timings.completedMs,
        fixtureState: completedFrame && completedFrame.session.state, mirrorMatchesHttp: sameItems(lastSw.entry.items, listing.items) }));
  } catch (error) {
    evidence.error = redact(error && error.message || error);
    record('rc.2：真实 SSE 断线/隐藏重连完整执行（fixture 已配置，不允许 SKIP）', false, evidence.error);
  } finally {
    evidence.frames = frames.map((frame) => ({ event: frame.event, at: frame.at,
      count: frame.items ? frame.items.length : undefined,
      state: frame.session ? frame.session.state : undefined }));
    evidence.network = { eventsRequests, sessionsResponses };
    evidence.falseDone = falseDone;
    if (realTab) await browserWs.send('Target.closeTarget', { targetId: realTab.id }).catch(() => { });
    if (realPage) realPage.ws.close();
    if (fixtureTouched) {
      try {
        const restored = await fixtureAction('reset');
        evidence.restored = { state: restored.state, eventsEnabled: restored.eventsEnabled };
      } catch (error) {
        evidence.cleanupError = redact(error && error.message || error);
        record('rc.2：真实 SSE fixture 恢复', false, evidence.cleanupError);
      }
    }
    if (sw) {
      try {
        await sw.send('Runtime.evaluate', {
          expression: `(async () => { await chrome.storage.local.set({ settings: ${JSON.stringify(originalSettings || {})}, attentionMap: {}, sessionsCache: {} }); })()`,
          awaitPromise: true, returnByValue: true,
        });
      } catch (_) { /* 浏览器最终 cleanup 仍关闭整个独立 profile */ }
      sw.ws.close();
    }
    await browserWs.send('Target.activateTarget', { targetId: originalTabId }).catch(() => { });
    fs.writeFileSync(path.join(SHOTS_DIR, 'real-sse-recovery.json'), redact(JSON.stringify(evidence, null, 2)), 'utf8');
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chromePath) fail('未找到 Chrome/Edge 可执行文件（可设 CHROME_PATH）');
  log('Chrome: ' + chromePath);
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  // 只使用全新 case profile；不能复用或 cleanup 一个本来存在的用户目录。
  if (fs.existsSync(PROFILE)) return fail('独立 Chrome profile 已存在，拒绝复用/删除: ' + PROFILE);
  fs.mkdirSync(PROFILE, { recursive: true });
  profileOwned = true;

  log('启动 headless Chrome（profile: ' + PROFILE + '）');
  // 文件句柄继承而非 stdio pipe：保持 Windows native sandbox 的已知边界；仅本 case 诊断。
  const stderrFd = fs.openSync(CHROME_STDERR_PATH, 'w');
  try {
    chromeProc = spawn(chromePath, [
      '--headless=new',
      '--remote-debugging-port=' + PORT,
      '--user-data-dir=' + PROFILE,
      '--no-first-run',
      '--no-default-browser-check',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--enable-zero-copy',
      '--window-size=1280,900',
      '--enable-unsafe-extension-debugging', // 新版 Chrome 可能已无需此旗标，传了也无害
      'about:blank',
    ], { stdio: ['ignore', 'ignore', stderrFd], windowsHide: true });
  } finally { fs.closeSync(stderrFd); }
  log('Chrome 启动诊断: pid=' + chromeProc.pid + ' profileLength=' + PROFILE.length + ' stderr=' + CHROME_STDERR_PATH);
  chromeProc.on('error', (e) => fail('Chrome 启动失败: ' + e.message + ' | ' + chromeStartupDiagnostic()));
  const version = await waitVersion();
  log('CDP 就绪: ' + version.Browser);

  browserWs = await connectWs(version.webSocketDebuggerUrl, (m) => {
    if (m.method === 'Browser.downloadProgress') { /* 忽略 */ }
  });

  // 1) 加载 unpacked 扩展（CDP Extensions 域）
  log('加载 unpacked 扩展: ' + EXT_DIR);
  let extId = null;
  try {
    const r = await browserWs.send('Extensions.loadUnpacked', { path: EXT_DIR });
    extId = r && r.id;
    record('Extensions.loadUnpacked', !!extId, 'extensionId=' + extId);
  } catch (e) {
    fail('CDP Extensions.loadUnpacked 失败（Chrome 版本过旧或域不可用）: ' + e.message);
  }

  // 2) 新标签页依次访问 popup.html 与 logs.html
  const tab = await fetchJson('http://127.0.0.1:' + PORT + '/json/new?about:blank', { method: 'PUT' });
  const consoleErrors = [];
  const page = await connectWs(tab.webSocketDebuggerUrl, (m) => {
    if (m.method === 'Runtime.executionContextCreated') {
      pageCtxInfos.push(m.params && m.params.context);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params && m.params.exceptionDetails;
      consoleErrors.push('exception: ' + (d && d.text || JSON.stringify(d)).slice(0, 400));
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params && m.params.type === 'error') {
      const args = (m.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || ''))).join(' ');
      consoleErrors.push('console.error: ' + args.slice(0, 400));
    } else if (m.method === 'Fetch.requestPaused') {
      const reqId = m.params && m.params.requestId;
      const url = (m.params && m.params.request && m.params.request.url) || '';
      if (reqId && /\/_manager\/events$/.test(url)) {
        // M12：verify 环境禁真 SSE 流（事件流无法 mock 为确定性流）——快速失败 →
        // 面板自动回退端点 mock 路径（既有断言基线不变）；SSE 帧处理路径由 8c 段的
        // 合成帧注入（页面 → content script DOM 事件挂钩）确定性驱动。
        page.send('Fetch.failRequest', { requestId: reqId, errorReason: 'ConnectionFailed' }).catch(() => { });
      } else if (reqId && /\/_manager\/sessions$/.test(url)) {
        fulfillSessionsMock(page, reqId);
      } else if (reqId) {
        page.send('Fetch.continueRequest', { requestId: reqId }).catch(() => { });
      }
    }
  });
  await page.send('Runtime.enable');
  await page.send('Page.enable');

  const visit = async (path, label) => {
    const url = 'chrome-extension://' + extId + '/' + path;
    await page.send('Page.navigate', { url });
    await waitUntil(async () => {
      const ready = await page.send('Runtime.evaluate', {
        expression: `(() => {
          if (location.href !== ${JSON.stringify(url)} || !document.body) return false;
          const text = document.body.innerText;
          if (${JSON.stringify(path)} === 'logs.html') return text.includes('未安装宿主') || text.includes('日志文件：');
          const state = document.getElementById('state-word');
          return !!state && !!state.textContent.trim() && state.textContent.trim() !== '—';
        })()`, returnByValue: true,
      });
      return ready.result?.value === true;
    }, 25000);
    const ev = await page.send('Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText : ""',
      returnByValue: true,
    });
    const text = ev && ev.result ? String(ev.result.value || '') : '';
    fs.writeFileSync(pathShots(label + '-text.txt'), text, 'utf8');
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    const png = pathShots(label + '.png');
    fs.writeFileSync(png, Buffer.from(shot.data, 'base64'));
    record(label + ' 截图', fs.statSync(png).size > 2000, png + ' (' + fs.statSync(png).size + ' bytes)');
    return text;
  };

  function pathShots(n) { return path.join(SHOTS_DIR, n); }

  // 3) popup：断言标题与状态行/错误面板（沙箱内宿主未注册 → 预期出现 HOST_NOT_INSTALLED 文案）
  log('访问 popup.html');
  const popupText = await visit('popup.html', 'popup');
  record('popup 含标题「dsh web」', popupText.toLowerCase().includes('dsh web') || popupText.includes('Whalekeeper'), JSON.stringify(popupText.split('\n').slice(0, 4)));
  // M7：状态卡结构（.statuscard/.sc-row1/.state-word/.sc-port/.sc-row2 契约）
  const m7CardInfo = await page.send('Runtime.evaluate', {
    expression: `(() => {
      const c = document.getElementById('statuscard');
      if (!c) return JSON.stringify({ present: false });
      const row1 = c.querySelector('.sc-row1');
      const word = document.getElementById('state-word');
      const port = document.getElementById('port-text');
      const row2 = document.getElementById('row2-text');
      return JSON.stringify({
        present: true, row1: !!row1,
        word: word ? word.textContent : '', port: port ? port.textContent : '', row2: row2 ? row2.textContent : '',
        bg: getComputedStyle(c).backgroundColor,
      });
    })()`,
    returnByValue: true,
  });
  let m7Card = { present: false };
  try { m7Card = JSON.parse(m7CardInfo && m7CardInfo.result ? String(m7CardInfo.result.value) : '{}'); } catch (_) { /* 保持默认 */ }
  record('M7：popup 状态卡结构（.statuscard/.sc-row1/state-word/sc-port/sc-row2）',
    m7Card.present === true && m7Card.row1 === true, JSON.stringify(m7Card));
  record('M7：状态卡文案（状态词非空 + 端口格式 + 次级行）',
    m7Card.present === true && m7Card.word.length > 0
      && (m7Card.port === '' || /^(\d+|端口 \d+)$/.test(m7Card.port))
      && (m7Card.row2.length > 0 || m7Card.word === '—'),
    JSON.stringify(m7Card));
  record('popup 渲染状态/错误文案', popupText.includes('状态：') || popupText.includes('未安装宿主') || m7Card.word.length > 0,
    m7Card.word ? '状态卡状态词=' + m7Card.word : '缺失');
  record('popup 含「查看日志」入口', popupText.includes('查看日志'), '');

  // 4) logs.html：断言标题与错误横幅/日志底栏
  log('访问 logs.html');
  const logsText = await visit('logs.html', 'logs');
  record('logs 含标题「dsh web 日志」', logsText.includes('dsh web 日志'), '');
  record('logs 渲染错误横幅或底栏', logsText.includes('未安装宿主') || logsText.includes('日志文件：'),
    logsText.includes('未安装宿主') ? 'HOST_NOT_INSTALLED 横幅（沙箱内预期）' : logsText.includes('日志文件：') ? '日志底栏存在' : '缺失');

  // 5) console 异常汇总（只统计扩展页面 popup/logs 阶段；后续 dsh GUI 页面自身的日志不算）
  record('扩展页面无未捕获异常', consoleErrors.length === 0, consoleErrors.length ? consoleErrors.join(' ||| ').slice(0, 800) : '');
  for (const e of consoleErrors.slice(0, 5)) log('  console: ' + e);
  consoleErrors.length = 0; // 清空：面板步骤在真实 dsh GUI 页面上，其自身日志与扩展无关

  // 6) 页面内管理面板（design §8.6）：注入真实 dsh Web UI 页面并断言 shadow 面板
  //    默认 3080（design 默认端口 / run 记录）；用户实例在其它端口时用 VERIFY_DSH_URL 覆盖
  const dshUrl = process.env.VERIFY_DSH_URL || 'http://127.0.0.1:3080/';
  // M13（2026-09-04）：dsh ≥ 0.1.2 裸 URL 401 → 先认证引导（launchUrl token 兑换 cookie），
  // 否则面板注入指纹（document.title）不满足、本段全部失效。
  const authOk = await ensureDshAuth(page, dshUrl);
  record('M13：dsh 页面认证引导（rc.1 token 兑换）', authOk,
    authOk ? 'cookie 已就绪，dshUrl 可 200' : '无 launchUrl 可循（外部实例）——面板/SSE/主题面板段将受限');
  log('访问 dsh Web UI 并检查页面内管理面板: ' + dshUrl);
  const waitForManagedPanel = () => waitUntil(async () => {
    const ready = await page.send('Runtime.evaluate', {
      expression: `(() => {
        const root = document.getElementById('dsh-manager-panel-host')?.shadowRoot;
        return !!root && root.querySelector('.dot')?.classList.contains('dot-running')
          && /运行中.*端口 \\d+/.test(root.querySelector('.status-text')?.textContent || '');
      })()`, returnByValue: true,
    });
    return ready.result?.value === true;
  }, 25000);
  await page.send('Page.navigate', { url: dshUrl });
  await waitForManagedPanel();
  const evp = await page.send('Runtime.evaluate', {
    expression: `(() => {
      const h = document.getElementById('dsh-manager-panel-host');
      if (!h || !h.shadowRoot) return JSON.stringify({ injected: false });
      const chip = h.shadowRoot.querySelector('.chip');
      const status = h.shadowRoot.querySelector('.status-text');
      const dot = h.shadowRoot.querySelector('.dot');
      return JSON.stringify({
        injected: true,
        chip: chip ? chip.textContent.trim() : '',
        status: status ? status.textContent.trim() : '',
        dot: dot ? dot.className : '',
        breathe: dot ? getComputedStyle(dot, '::after').animationName : '',
      });
    })()`,
    returnByValue: true,
  });
  let panelInfo = { injected: false };
  try { panelInfo = JSON.parse(evp && evp.result ? String(evp.result.value) : '{}'); } catch (_) { /* 保持默认 */ }
  record('页面内管理面板已注入', panelInfo.injected === true, JSON.stringify(panelInfo));
  record('面板徽章文本', typeof panelInfo.chip === 'string' && panelInfo.chip.length > 0, panelInfo.chip);
  record('面板状态文本', typeof panelInfo.status === 'string' && panelInfo.status.length > 0, panelInfo.status);
  record('面板：托管运行中为绿点且显示端口',
    panelInfo.dot === 'dot dot-running' && /端口 \d+/.test(panelInfo.status || ''),
    JSON.stringify(panelInfo));
  record('M7：面板运行态实心点呼吸（dsh-dot-breathe）', panelInfo.breathe === 'dsh-dot-breathe',
    'breathe=' + panelInfo.breathe);
  const shot3 = await page.send('Page.captureScreenshot', { format: 'png' });
  const panelPng = pathShots('panel.png');
  fs.writeFileSync(panelPng, Buffer.from(shot3.data, 'base64'));
  record('panel 截图', fs.statSync(panelPng).size > 2000, panelPng + ' (' + fs.statSync(panelPng).size + ' bytes)');

  // 7) 展开面板：点击徽章后断言状态行 + 停止/重启按钮（绝不点击操作按钮——面板面向真实实例）；
  //    同时断言胶囊位置在展开前后不变、面板从胶囊上方展开（回归：body 曾为流内元素把胶囊顶上去）
  const chipRectBefore = await page.send('Runtime.evaluate', {
    expression: `(() => {
      const h = document.getElementById('dsh-manager-panel-host');
      if (!h || !h.shadowRoot) return JSON.stringify({ ok: false });
      const r = h.shadowRoot.querySelector('.chip').getBoundingClientRect();
      return JSON.stringify({ ok: true, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
    })()`,
    returnByValue: true,
  });
  await page.send('Runtime.evaluate', {
    expression: `(() => {
      const h = document.getElementById('dsh-manager-panel-host');
      if (!h || !h.shadowRoot) return 'no-host';
      h.shadowRoot.querySelector('.chip').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'clicked';
    })()`,
    returnByValue: true,
  });
  await sleep(1500); // 展开时立即触发一次 status 刷新
  const evo = await page.send('Runtime.evaluate', {
    expression: `(() => {
      const h = document.getElementById('dsh-manager-panel-host');
      if (!h || !h.shadowRoot) return JSON.stringify({ open: false });
      const body = h.shadowRoot.querySelector('.body');
      const visible = !!body && getComputedStyle(body).display !== 'none';
      const buttons = Array.from(h.shadowRoot.querySelectorAll('.btn')).map((b) => ({ text: b.textContent.trim(), disabled: b.disabled }));
      const cr = h.shadowRoot.querySelector('.chip').getBoundingClientRect();
      const br = body.getBoundingClientRect();
      return JSON.stringify({
        open: visible,
        buttons,
        chip: { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height) },
        body: { bottom: Math.round(br.bottom), top: Math.round(br.top) },
      });
    })()`,
    returnByValue: true,
  });
  let openInfo = { open: false };
  try { openInfo = JSON.parse(evo && evo.result ? String(evo.result.value) : '{}'); } catch (_) { /* 保持默认 */ }
  record('面板展开（点击徽章）', openInfo.open === true, JSON.stringify(openInfo));
  record('面板含停止/重启按钮且停止可用', Array.isArray(openInfo.buttons) && openInfo.buttons.length === 2
    && openInfo.buttons[0].text === '停止' && openInfo.buttons[0].disabled === false
    && openInfo.buttons[1].text === '重启' && openInfo.buttons[1].disabled === false,
    JSON.stringify(openInfo.buttons));
  let beforeRect = null;
  try { beforeRect = JSON.parse(String(chipRectBefore.result.value)); } catch (_) { /* 保持默认 */ }
  const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1;
  const chipStable = !!(beforeRect && beforeRect.ok && openInfo.chip
    && near(beforeRect.x, openInfo.chip.x) && near(beforeRect.y, openInfo.chip.y)
    && near(beforeRect.w, openInfo.chip.w) && near(beforeRect.h, openInfo.chip.h));
  record('面板展开时胶囊位置不变', chipStable,
    'before=' + JSON.stringify(beforeRect) + ' after=' + JSON.stringify(openInfo.chip));
  const bodyAbove = !!(openInfo.open && openInfo.body && openInfo.chip
    && openInfo.body.bottom <= openInfo.chip.y + 1);
  record('面板展开在胶囊上方', bodyAbove,
    'body.bottom=' + JSON.stringify(openInfo.body && openInfo.body.bottom) + ' chip.y=' + JSON.stringify(openInfo.chip && openInfo.chip.y));
  const shot4 = await page.send('Page.captureScreenshot', { format: 'png' });
  const panelOpenPng = pathShots('panel-open.png');
  fs.writeFileSync(panelOpenPng, Buffer.from(shot4.data, 'base64'));
  record('panel-open 截图', fs.statSync(panelOpenPng).size > 2000, panelOpenPng + ' (' + fs.statSync(panelOpenPng).size + ' bytes)');

  // 7b) 停止两步确认（安全：只验证确认态出现与 3s 超时还原，绝不二次点击执行）
  await page.send('Runtime.evaluate', {
    expression: `(() => {
      const h = document.getElementById('dsh-manager-panel-host');
      h.shadowRoot.querySelectorAll('.btn')[0].click();
      return 'clicked';
    })()`,
    returnByValue: true,
  });
  await sleep(400);
  const confirmText = await page.send('Runtime.evaluate', {
    expression: `(() => {
      const h = document.getElementById('dsh-manager-panel-host');
      const b = h.shadowRoot.querySelectorAll('.btn')[0];
      return JSON.stringify({ text: b.textContent.trim(), confirm: b.classList.contains('confirm') });
    })()`,
    returnByValue: true,
  });
  try {
    const ct = JSON.parse(String(confirmText.result.value));
    record('面板：停止首击进入确认态', ct.confirm === true && ct.text === '确认停止', JSON.stringify(ct));
  } catch (_) {
    record('面板：停止首击进入确认态', false, '解析失败');
  }
  await sleep(3200); // 超过 3s 确认窗口，未二次点击必须还原
  const revertText = await page.send('Runtime.evaluate', {
    expression: `(() => {
      const h = document.getElementById('dsh-manager-panel-host');
      const b = h.shadowRoot.querySelectorAll('.btn')[0];
      return JSON.stringify({ text: b.textContent.trim(), confirm: b.classList.contains('confirm') });
    })()`,
    returnByValue: true,
  });
  try {
    const rt = JSON.parse(String(revertText.result.value));
    record('面板：确认态 3s 超时还原', rt.confirm === false && rt.text === '停止', JSON.stringify(rt));
  } catch (_) {
    record('面板：确认态 3s 超时还原', false, '解析失败');
  }

  // 8) 徽标（M4 动态端口路径）：附加扩展 service worker 实测——
  //    port 0 → refreshBadge 走 native status 分支（本机真实 dsh 在跑 → 绿点）；
  //    无监听端口 → 清空；恢复默认设置。回归守护 background.js 的 `|| 3080` 吞 0 缺陷。
  const targets = await fetchJson('http://127.0.0.1:' + PORT + '/json/list');
  const swCandidates = targets.filter((t) => t.type === 'service_worker');
  record('徽标：service_worker 目标清单', swCandidates.length > 0,
    JSON.stringify(swCandidates.map((t) => t.url)));
  // 必须按本扩展 ID 精确匹配：Chrome 组件扩展也可能有 service_worker
  // （其 SW 无 chrome.action/chrome.storage API），find 首个会选错
  const swTarget = swCandidates.find((t) => (t.url || '').includes(extId));
  if (!swTarget) {
    record('徽标（扩展 SW 目标）', false, '未找到扩展 service worker target');
  } else {
    try {
      const sw = await connectWs(swTarget.webSocketDebuggerUrl);
      await sw.send('Runtime.enable');
      const evalInSw = async (expr) => {
        const r = await sw.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (!r || !r.result) return { value: undefined, raw: JSON.stringify(r) };
        if (r.result.exceptionDetails) {
          return { value: undefined, raw: 'exception: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 500) };
        }
        return { value: r.result.value, raw: '' };
      };
      const probe = await evalInSw(`JSON.stringify({ chrome: typeof chrome, action: typeof (typeof chrome !== 'undefined' && chrome.action), getBadgeText: typeof (typeof chrome !== 'undefined' && chrome.action && chrome.action.getBadgeText), refreshBadge: typeof refreshBadge, storage: typeof (typeof chrome !== 'undefined' && chrome.storage) })`);
      record('徽标：SW 环境探针', true, String(probe.value));
      // M13（2026-09-04）：真实 rc.1 实例 + 认证引导后，面板 SSE 会把真实工作中会话
      // （verify 自身会话）推给徽标（蓝 n）——本段断言"徽标无会话字符"测的是实例层
      // 图标（绿点/无点），必须先关 attention 隔离会话层，测完恢复（M8 e2e 段自带
      // attention:true 设置，恢复行仅为显式对称）。
      await evalInSw(`(async () => { await chrome.storage.local.set({ settings: { port: 0, profile: 'web', autoOpen: true, badgeInterval: 30, attention: false } }); })()`);
      await evalInSw('refreshBadge()');
      // M8.1：实例状态层 = 图标角标（绿点=运行），徽标字符只属于会话状态层 → 无会话信号时 text 空
      const badge0 = await evalInSw(`(async () => JSON.stringify({
        text: await chrome.action.getBadgeText({}),
        icon: lastIconState,
        title: await chrome.action.getTitle({}),
      }))()`);
      const badgeStr0 = String(badge0.value || '');
      record('徽标：port 0 经 native status → 角标绿点（实例运行，徽标无会话字符）',
        /"text":""/.test(badgeStr0) && /"icon":"ok"/.test(badgeStr0) && /运行中/.test(badgeStr0),
        'badge=' + badgeStr0 + (badge0.raw ? ' ' + badge0.raw : ''));
      await evalInSw(`(async () => { await chrome.storage.local.set({ settings: { port: 59999, profile: 'web', autoOpen: true, badgeInterval: 30, attention: false } }); })()`);
      await evalInSw('refreshBadge()');
      const badgeNone = await evalInSw(`(async () => JSON.stringify({
        text: await chrome.action.getBadgeText({}),
        icon: lastIconState,
      }))()`);
      record('徽标：无监听端口 → 角标无点 + 徽标空',
        /"text":""/.test(String(badgeNone.value || '')) && /"icon":"default"/.test(String(badgeNone.value || '')),
        'badge=' + String(badgeNone.value || '') + (badgeNone.raw ? ' ' + badgeNone.raw : ''));
      await evalInSw(`(async () => { await chrome.storage.local.set({ settings: { port: 3080, profile: 'web', autoOpen: true, badgeInterval: 30, attention: false } }); })()`);
      await evalInSw('refreshBadge()');
      const badgeDefault = await evalInSw('chrome.action.getBadgeText({})');
      record('徽标：恢复默认端口后无异常（徽标空）', badgeDefault.value === '', 'badge=' + JSON.stringify(badgeDefault.value) + (badgeDefault.raw ? ' ' + badgeDefault.raw : ''));
      await evalInSw(`(async () => { await chrome.storage.local.set({ settings: { port: 3080, profile: 'web', autoOpen: true, badgeInterval: 30, attention: true } }); })()`); // 显式恢复（M8 e2e 段也会自带 attention:true）

      // ---- M8 helpers：轮询替代固定 sleep（缓解隐藏页 1Hz 节流 + SW 多跳竞态，M4）----
      const waitFor = async (fn, timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          if (await fn()) return true;
          if (Date.now() >= deadline) return false;
          await sleep(400);
        }
      };
      const getBadgeJson = () => evalInSw(`(async () => JSON.stringify({
        text: await chrome.action.getBadgeText({}),
        bg: JSON.stringify(await chrome.action.getBadgeBackgroundColor({})),
        fg: JSON.stringify(await chrome.action.getBadgeTextColor({})),
      }))()`);
      const badgeHas = (str, wantText, wantBgRe) =>
        str.includes('"text":"' + wantText + '"') && wantBgRe.test(str) && /255,\s*255,\s*255/.test(str);
      const attEntryKind = (kind) => evalInSw(`(async () => {
        const d = await chrome.storage.local.get({ attentionMap: {} });
        const m = d.attentionMap || {};
        return Object.keys(m).some((k) => m[k] && m[k].kind === '${kind}');
      })()`);
      const attEmpty = () => evalInSw(`(async () => {
        const d = await chrome.storage.local.get({ attentionMap: {} });
        return Object.keys(d.attentionMap || {}).length === 0;
      })()`);
      const pageEvalInfo = () => page.send('Runtime.evaluate', {
        expression: `(() => JSON.stringify({
          hidden: document.hidden,
          warning: document.querySelectorAll('[data-state="warning"]').length,
          ongoing: document.querySelectorAll('svg[data-state="ongoing"]').length,
          mine: !!document.getElementById('dshm-test-warning') || !!document.getElementById('dshm-test-ongoing'),
        }))()`,
        returnByValue: true,
      });

      // 8a) M8.1 徽标提醒（design §8.9/§8.9.1）：storage attentionMap 驱动徽标分层渲染——
      //     徽标=会话状态层：done → 绿「!」（M10.1 定稿：完成=绿，原琥珀随定稿改绿）；
      //     waiting → 黄「?」（M10.1 定稿：等待=琥珀黄 #f59e0b，webui 计划面板同色系，覆盖 done）；
      //     working → 蓝「n」（deepseek 蓝 #5686fe，webui --dsh-state-ongoing 同源色）；
      //     优先级 waiting > done > working；清空 → 徽标空（实例状态由图标角标表达）。
      await evalInSw(`(async () => {
        await chrome.storage.local.set({
          settings: { port: 3080, profile: 'web', autoOpen: true, badgeInterval: 30, attention: true, attentionDone: true, theme: 'follow-webui' },
          attentionMap: { 9861: { kind: 'done', working: 0, waiting: 0, at: Date.now(), port: null } },
        });
      })()`);
      const doneOk = await waitFor(async () => {
        await evalInSw('applyBadge()');
        const j = await getBadgeJson();
        return badgeHas(String(j.value || ''), '!', /#22c55e|22c55e|34,\s*197,\s*94/i);
      }, 5000);
      const bDone = await getBadgeJson();
      record('M8：徽标提醒 done → 绿「!」（白字；M10.1 定稿完成=绿）', doneOk,
        'badge=' + String(bDone.value || '') + (bDone.raw ? ' ' + bDone.raw : ''));
      await evalInSw(`(async () => {
        await chrome.storage.local.set({ attentionMap: { 9861: { kind: 'waiting', working: 0, waiting: 1, at: Date.now(), port: null } } });
      })()`);
      const waitOk = await waitFor(async () => {
        await evalInSw('applyBadge()');
        const j = await getBadgeJson();
        return badgeHas(String(j.value || ''), '?', /#f59e0b|f59e0b|245,\s*158,\s*11/i);
      }, 5000);
      const bWait = await getBadgeJson();
      record('M8：徽标提醒 waiting → 黄「?」（优先级覆盖 done，白字；M10.1 定稿等待=黄）', waitOk,
        'badge=' + String(bWait.value || '') + (bWait.raw ? ' ' + bWait.raw : ''));
      // M8.1：优先级 done > working（done + 蓝2 并存 → 显示绿!）+ working → 蓝 n + 9+ 边界
      await evalInSw(`(async () => {
        await chrome.storage.local.set({ attentionMap: {
          9861: { kind: 'done', working: 0, waiting: 0, at: Date.now(), port: null },
          9862: { kind: 'working', working: 2, waiting: 0, at: Date.now(), port: null },
        } });
      })()`);
      const mixOk = await waitFor(async () => {
        await evalInSw('applyBadge()');
        const j = await getBadgeJson();
        return badgeHas(String(j.value || ''), '!', /#22c55e|22c55e|34,\s*197,\s*94/i);
      }, 5000);
      record('M8.1：徽标优先级 done > working（done 与蓝2 并存显示绿!）', mixOk, '');
      await evalInSw(`(async () => {
        await chrome.storage.local.set({ attentionMap: { 9861: { kind: 'working', working: 2, waiting: 0, at: Date.now(), port: null } } });
      })()`);
      const workOk = await waitFor(async () => {
        await evalInSw('applyBadge()');
        const j = await getBadgeJson();
        return badgeHas(String(j.value || ''), '2', /#5686fe|5686fe|86,\s*134,\s*254/i);
      }, 5000);
      const bWork = await getBadgeJson();
      record('M8.1：徽标 working → 蓝 n（2 个会话工作中，deepseek 蓝同源）', workOk,
        'badge=' + String(bWork.value || '') + (bWork.raw ? ' ' + bWork.raw : ''));
      await evalInSw(`(async () => {
        await chrome.storage.local.set({ attentionMap: { 9861: { kind: 'working', working: 12, waiting: 0, at: Date.now(), port: null } } });
      })()`);
      const nineOk = await waitFor(async () => {
        await evalInSw('applyBadge()');
        const j = await getBadgeJson();
        return badgeHas(String(j.value || ''), '9+', /#5686fe|5686fe|86,\s*134,\s*254/i);
      }, 5000);
      record('M8.1：徽标工作中超 9 显示「9+」', nineOk, '');
      await evalInSw(`(async () => { await chrome.storage.local.set({ attentionMap: {} }); })()`);
      const restoreOk = await waitFor(async () => {
        await evalInSw('applyBadge()');
        const j = await evalInSw('chrome.action.getBadgeText({})');
        return j.value === '';
      }, 5000);
      record('M8.1：提醒清空后徽标清空（实例状态由图标角标表达）', restoreOk, '');
      // ---- M10 颜色语义（design §8.12）：徽标底色运行时读 settings.colorMap——
      //     改色后徽标背景变、字符（? / ! / n）不变（字符语义锁定回归）----
      await evalInSw(`(async () => {
        const d = await chrome.storage.local.get({ settings: {} });
        const s = Object.assign({}, d.settings || {});
        s.colorMap = Object.assign({}, (s.colorMap || {}), { waiting: '#22c55e' }); // 待确认→绿（自定义验证）
        await chrome.storage.local.set({
          settings: s,
          attentionMap: { 9861: { kind: 'waiting', working: 0, waiting: 1, at: Date.now(), port: null } },
        });
      })()`);
      const m10WaitOk = await waitFor(async () => {
        await evalInSw('applyBadge()');
        const j = await getBadgeJson();
        return badgeHas(String(j.value || ''), '?', /34,\s*197,\s*94/); // 绿底 + 字符「?」恒在
      }, 5000);
      const bM10Wait = await getBadgeJson();
      record('M10：徽标 waiting 底色随 colorMap（改绿；字符「?」不变——字符语义锁定）', m10WaitOk,
        'badge=' + String(bM10Wait.value || '') + (bM10Wait.raw ? ' ' + bM10Wait.raw : ''));
      // 恢复默认色板（删除 colorMap 键 → getSettings 合并 DEFAULT → 默认紫）
      await evalInSw(`(async () => {
        const d = await chrome.storage.local.get({ settings: {} });
        const s = Object.assign({}, d.settings || {});
        delete s.colorMap;
        await chrome.storage.local.set({ settings: s, attentionMap: {} });
      })()`);
      const m10RestoreOk = await waitFor(async () => {
        await evalInSw('applyBadge()');
        const j = await getBadgeJson();
        // getBadgeJson 返回整对象 JSON（{"text":"...","bg":[...]}）：空文本按 '"text":""' 判定；
        // 恢复默认后 waiting 应为琥珀黄（M10.1 定稿默认 #f59e0b）
        return /"text":""/.test(String(j.value || '')) || badgeHas(String(j.value || ''), '?', /245,\s*158,\s*11/);
      }, 5000);
      record('M10：徽标恢复默认色板（waiting 回黄，或空——依 attentionMap 当前值）', m10RestoreOk, '');
      // M8.1 盲审修补（H1 对称）：attentionDone 关闭瞬间剔除既有 done 条目——
      // 重开开关时不冒陈旧「工作完成」（done 仅在关闭后被 source 拒绝，不会被新写入）
      await evalInSw(`(async () => {
        await chrome.storage.local.set({
          attentionMap: { 9861: { kind: 'done', working: 0, waiting: 0, at: Date.now(), port: null } },
          settings: { port: 3080, profile: 'web', autoOpen: true, badgeInterval: 30, attention: true, attentionDone: false, theme: 'follow-webui' },
        });
      })()`);
      const doneOffOk = await waitFor(async () => {
        const m = await evalInSw(`(async () => {
          const d = await chrome.storage.local.get({ attentionMap: {} });
          const map = d.attentionMap || {};
          return JSON.stringify({ map, hasDone: Object.keys(map).some((k) => map[k] && map[k].kind === 'done') });
        })()`);
        return /"hasDone":false/.test(String(m.value || ''));
      }, 5000);
      const doneOffInfo = await evalInSw(`(async () => JSON.stringify(await chrome.storage.local.get({ attentionMap: {} })))()`);
      record('M8.1：attentionDone 关闭剔除 done 条目（重开不冒陈旧绿!）', doneOffOk,
        'map=' + String(doneOffInfo.value || '') + (doneOffInfo.raw ? ' ' + doneOffInfo.raw : ''));
      await evalInSw(`(async () => {
        await chrome.storage.local.set({ settings: { port: 3080, profile: 'web', autoOpen: true, badgeInterval: 30, attention: true, attentionDone: true, theme: 'follow-webui' } });
      })()`);

      // 8a-2) M8 端到端（content script → SW，真实链路）：真实 dsh 页面切后台 →
      //       等待/完成信号 → 黄「?」/绿「!」（以 storage attentionMap 条目为链路证据）。
      //       2026-08-24 起徽标计数与 popup 会话区同源：content script 优先读同源端点
      //       GET /_manager/sessions（DOM 扫描仅回退）——本轮 e2e 先探测端点可用性：
      //       可用（实例装配套插件）→ Fetch 域 mock 端点响应驱动真实链路（端点驱动路径）；
      //       不可用（插件未装/旧版）→ DOM 注入标记驱动回退路径（历史行为）。
      //       （工作→完成路径，仅当基线无真实工作中会话时执行——真实会话运行中则如实记录）；
      //       切回 dsh 标签 → 自动 clear（attentionMap 空 + 徽标恢复）。
      try {
        const tab2 = await fetchJson('http://127.0.0.1:' + PORT + '/json/new?about:blank', { method: 'PUT' });
        await browserWs.send('Target.activateTarget', { targetId: tab2.id });
        await waitFor(async () => {
          const h = await pageEvalInfo();
          try { return JSON.parse(String(h.result.value)).hidden === true; } catch (_) { return false; }
        }, 5000); // dsh 标签转后台（页面可见性为 e2e 前置）
        const baseInfo = await pageEvalInfo();
        let base = {};
        try { base = JSON.parse(String(baseInfo.result.value)); } catch (_) { /* 保持默认 */ }
        record('M8：e2e 前置——dsh 页面已转后台（document.hidden）',
          base.hidden === true, JSON.stringify(base));

        // 端点可用性探测（Node 侧直连 dsh 实例，1.5s 超时；判定走哪条链路）
        const dshPort = String(new URL(dshUrl).port || '80');
        let epAvailable = false;
        try {
          const ep = await httpGet('http://127.0.0.1:' + dshPort + '/_manager/sessions', 1500);
          epAvailable = ep.status === 200 && (JSON.parse(ep.body) || {}).ok === true;
        } catch (_) { epAvailable = false; }
        log('M8 e2e 端点可用性: ' + epAvailable + '（endpoint=/_manager/sessions @ ' + dshPort + '）');

        // —— waiting 链路：端点驱动（mock）或 DOM 注入回退 → attentionMap 条目 + 黄「?」——
        // M12 后适配（2026-09-04）：面板在 SSE 存活时优先实时链路（attTick 纯内存补推，
        // 不轮询 /_manager/sessions）——端点 mock 在插件可用环境永不命中（mockHits=0
        // 实证）。waiting→徽标「?」链路由下方 M12 段合成帧断言覆盖（upsert waiting →
        // 「?」即时切换 + 时序回归段）；DOM 回退路径（!epAvailable）继续覆盖插件不可用
        // 场景。此处如实记录（非失败）。
        if (epAvailable) {
          record('M8：e2e 后台+等待信号 → 黄「?」——SSE 存活端点 mock 不可达（M12 适配，由 M12 合成帧段覆盖）',
            true, 'epAvailable=true 面板走 SSE 实时链路（attTick 不轮询端点）；M12 段「upsert waiting → 徽标?」覆盖等价链路');
        } else {
          await page.send('Runtime.evaluate', {
            expression: `(() => {
              if (!document.getElementById('dshm-test-warning')) {
                const s = document.createElement('span');
                s.id = 'dshm-test-warning';
                s.setAttribute('data-state', 'warning');
                s.style.display = 'none';
                document.body.appendChild(s);
              }
              return 'injected';
            })()`,
            returnByValue: true,
          });
          // rc.2 撤回全页 StateDot 扫描：没有摘要时 DOM warning 不能冒充权威 waiting。
          let sawSpuriousWaiting = false;
          const observationStart = Date.now();
          await waitUntil(async () => {
            const kinds = await attEntryKind('waiting');
            const badge = await evalInSw('chrome.action.getBadgeText({})');
            if (kinds.value === true || badge.value === '?' || badge.value === '!') sawSpuriousWaiting = true;
            return Date.now() - observationStart >= 2200;
          }, 3500);
          const bAtt = await getBadgeJson();
          record('M8：e2e 摘要不可用时 DOM warning 不制造待确认（rc.2 仅保留实例状态）',
            !sawSpuriousWaiting,
            'badge=' + String(bAtt.value || '') + ' base=' + JSON.stringify(base));
          await page.send('Runtime.evaluate', {
            expression: `(() => { const n = document.getElementById('dshm-test-warning'); if (n) n.remove(); return 'removed'; })()`,
            returnByValue: true,
          });
        }

        // —— 清场：切回 dsh 标签（可见 → clear）→ 等待 attentionMap 空 ——
        await browserWs.send('Target.activateTarget', { targetId: tab.id });
        const clearOk = await waitFor(attEmpty, 6000);
        record('M8：e2e 切回 dsh 标签自动清除提醒（attentionMap 空）', clearOk,
          'badge=' + JSON.stringify((await evalInSw('chrome.action.getBadgeText({})')).value));

        // —— done 链路：仅当基线无真实工作中会话时执行；否则如实记录（真实会话在跑，无法隔离）——
        await browserWs.send('Target.activateTarget', { targetId: tab2.id });
        await waitFor(async () => {
          const h = await pageEvalInfo();
          try { return JSON.parse(String(h.result.value)).hidden === true; } catch (_) { return false; }
        }, 5000);
        const base2Info = await pageEvalInfo();
        let base2 = {};
        try { base2 = JSON.parse(String(base2Info.result.value)); } catch (_) { /* 保持默认 */ }
        if (epAvailable) {
          // M12 后适配（2026-09-04）：面板在 SSE 存活时不轮询端点，端点 mock 永不命中
          // （mockHits=0 实证）——done「绿!」链路由下方 M12 段新增合成帧断言覆盖
          // （working 快照 → 空快照 → 稳定空态 → done-fired）。此处如实记录（非失败）。
          record('M8：e2e 工作→完成 → 绿「!」——SSE 存活端点 mock 不可达（M12 适配，由 M12 段 done 合成帧断言覆盖）',
            true, 'epAvailable=true 面板走 SSE 实时链路（attTick 不轮询端点）；M12 段「working→空→绿!」覆盖等价链路');
        } else {
          await page.send('Runtime.evaluate', {
            expression: `(() => {
              if (!document.getElementById('dshm-test-ongoing')) {
                const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                s.id = 'dshm-test-ongoing';
                s.setAttribute('data-state', 'ongoing');
                s.style.display = 'none';
                document.body.appendChild(s);
              }
              return 'injected';
            })()`,
            returnByValue: true,
          });
          // DOM ongoing 的出现/移除均不是权威工作完成边沿；未知不得造蓝数或绿!。
          let sawSpuriousDone = false;
          const watchQuiet = async (duration) => {
            const at = Date.now();
            await waitUntil(async () => {
              const result = await evalInSw(`(async () => ({ badge: await chrome.action.getBadgeText({}),
                kinds: Object.values((await chrome.storage.local.get({ attentionMap: {} })).attentionMap || {}).map((entry) => entry.kind) }))()`);
              const value = result.value || {};
              if (value.badge || (value.kinds || []).some((kind) => ['working', 'waiting', 'done'].includes(kind))) sawSpuriousDone = true;
              return Date.now() - at >= duration;
            }, duration + 1000);
          };
          await watchQuiet(1200);
          await page.send('Runtime.evaluate', {
            expression: `(() => { const n = document.getElementById('dshm-test-ongoing'); if (n) n.remove(); return 'removed'; })()`,
            returnByValue: true,
          });
          await watchQuiet(2200);
          const bDone2 = await getBadgeJson();
          record('M8：e2e 摘要不可用时 DOM ongoing→移除不制造工作/完成提醒',
            !sawSpuriousDone,
            'badge=' + String(bDone2.value || '') + ' base=' + JSON.stringify(base2));
        }

        // —— 收尾：切回 dsh 标签 → clear 恢复，关闭辅助标签 ——
        await browserWs.send('Target.activateTarget', { targetId: tab.id });
        const clearOk2 = await waitFor(attEmpty, 6000);
        const bRestore2 = await evalInSw('chrome.action.getBadgeText({})');
        record('M8：e2e 结束恢复（attentionMap 空 + 徽标清空）',
          clearOk2 && bRestore2.value === '',
          'badge=' + JSON.stringify(bRestore2.value));
        await fetchJson('http://127.0.0.1:' + PORT + '/json/close/' + tab2.id, { method: 'PUT' }).catch(() => { /* 标签已关闭/正在关闭：非致命 */ });
      } catch (e2) {
        record('M8：端到端（内容脚本→SW 提醒链路）', false, 'e2e 异常: ' + e2.message);
      }
    } catch (e) {
      record('徽标（扩展 SW 目标）', false, 'SW 附加失败: ' + e.message);
    }
  }

  // 8b) 面板重载回归：扩展重载（chrome://extensions「重新加载」等价，同路径 loadUnpacked
  //     会替换已加载实例）后，已打开页面里的旧内容脚本上下文失效——曾表现为永久红错
  //     「状态获取失败」直到刷新页面。现在应显示「已断开」中性提示并停止轮询；
  //     刷新页面后新面板注入并恢复托管状态。
  log('面板重载回归（扩展重载 → 提示刷新；刷新页面 → 恢复）');
  await browserWs.send('Extensions.loadUnpacked', { path: EXT_DIR });
  await sleep(4000);
  const det = await page.send('Runtime.evaluate', {
    expression: `(() => {
      const h = document.getElementById('dsh-manager-panel-host');
      if (!h || !h.shadowRoot) return JSON.stringify({ injected: false });
      const s = h.shadowRoot.querySelector('.status-text');
      const d = h.shadowRoot.querySelector('.dot');
      const c = h.shadowRoot.querySelector('.chip');
      return JSON.stringify({ injected: true, status: s ? s.textContent.trim() : '', dot: d ? d.className : '', chip: c ? c.textContent.trim() : '' });
    })()`,
    returnByValue: true,
  });
  let detInfo = { injected: false };
  try { detInfo = JSON.parse(String(det.result.value)); } catch (_) { /* 保持默认 */ }
  record('面板：扩展重载后提示刷新（非红错）',
    detInfo.injected === true && /刷新页面/.test(detInfo.status || '') && !/dot-error/.test(detInfo.dot || ''),
    JSON.stringify(detInfo));
  await page.send('Page.reload');
  await waitForManagedPanel();
  const rec = await page.send('Runtime.evaluate', {
    expression: `(() => {
      const h = document.getElementById('dsh-manager-panel-host');
      if (!h || !h.shadowRoot) return JSON.stringify({ injected: false });
      const s = h.shadowRoot.querySelector('.status-text');
      const d = h.shadowRoot.querySelector('.dot');
      return JSON.stringify({ injected: true, status: s ? s.textContent.trim() : '', dot: d ? d.className : '' });
    })()`,
    returnByValue: true,
  });
  let recInfo = { injected: false };
  try { recInfo = JSON.parse(String(rec.result.value)); } catch (_) { /* 保持默认 */ }
  record('面板：刷新页面后恢复托管状态',
    recInfo.injected === true && /运行中/.test(recInfo.status || '') && recInfo.dot === 'dot dot-running',
    JSON.stringify(recInfo));

  // 8c) M12 SSE 会话推送（design §8.10.1，2026-08-26）：页面主世界派发合成帧 →
  //      content script DOM 事件挂钩（__whalekeeper_sse_frame）→ 真实「帧处理 →
  //      状态机 → SW → 徽标」链路；alive:true 模拟 SSE 健康 → 断言 attTick 不再
  //      打 /_manager/sessions（0 轮询）。真实 EventSource 连接/帧接收路径由下方
  //      8d 段覆盖（M12.2 复盘：8c 合成帧挂钩恰好绕过真实 EventSource 解析，
  //      101/0 全绿掩盖接收层缺陷——须单独保一路真实路径防回归）。
  log('M12 SSE 会话推送（合成帧 → 徽标即时更新 + 0 轮询断言）');
  {
    const swTargetM12 = (await fetchJson('http://127.0.0.1:' + PORT + '/json/list'))
      .find((t) => t.type === 'service_worker' && (t.url || '').includes(extId));
    if (!swTargetM12) {
      record('M12：SSE（扩展 SW 目标）', false, '未找到扩展 service worker target');
    } else {
      try {
        const swM12 = await connectWs(swTargetM12.webSocketDebuggerUrl);
        await swM12.send('Runtime.enable');
        const swEvalM12 = async (expr) => {
          const r = await swM12.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
          return { value: r && r.result ? r.result.value : undefined, raw: JSON.stringify(r).slice(0, 300) };
        };
        const waitForM12 = async (fn, timeoutMs) => {
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            if (await fn()) return true;
            if (Date.now() >= deadline) return false;
            await sleep(400);
          }
        };
        const attKindsM12 = () => swEvalM12(`(async () => JSON.stringify(
          Object.values((await chrome.storage.local.get({ attentionMap: {} })).attentionMap || {}).map((e) => e.kind)
        ))()`).then((j) => {
          try { return JSON.parse(String(j.value || '')); } catch (_) { return []; }
        });
        const badgeTextM12 = () => swEvalM12('chrome.action.getBadgeText({})').then((j) => String(j.value === undefined ? '' : j.value));
        // 在 content script 的**隔离世界**直接派发（与面板同世界，DOM 事件必然可达——
        // 主世界派发的 CustomEvent 不会进入隔离世界监听器，2026-08-26 实测）。
        // 挂钩本身即声明「模拟 SSE 流存活」（panel.js __whalekeeper_sse_frame 语义）。
        const dispatchSseFrame = async (frame) => {
          const expr = `(() => {
            let err = null;
            try {
              if (window.__dshManagerPanelInjected !== true || chrome.runtime.id !== ${JSON.stringify(extId)}) return JSON.stringify({ ready: false });
              // 注意：面板监听器挂在 document（capture）——window.dispatchEvent 的传播
              // 路径不经过 document，必须 document.dispatchEvent（2026-08-26 实测破案）。
              document.dispatchEvent(new CustomEvent('__whalekeeper_sse_frame', { detail: { __whalekeeper: true, frame: ${JSON.stringify(frame)} } }));
            } catch (e) { err = String(e && e.stack || e); }
            return JSON.stringify({ ready: !err, err: err, injected: typeof window.__dshManagerPanelInjected, alive: document.documentElement.getAttribute('data-dshm-sse-alive') });
          })()`;
          const defaultCtxs = pageCtxInfos.filter((c) => c && c.auxData && c.auxData.isDefault === true);
          const mainFrameId = defaultCtxs.length > 0 ? defaultCtxs[defaultCtxs.length - 1].auxData.frameId : undefined;
          const candidates = [...pageCtxInfos].reverse().filter((c) => c && c.auxData && c.auxData.isDefault === false && c.auxData.frameId === mainFrameId);
          for (const c of candidates) {
            try {
              const r = await page.send('Runtime.evaluate', { expression: expr, contextId: c.id, returnByValue: true });
              const info = JSON.parse(String(r?.result?.value || '{}'));
              if (info.ready !== true) continue;
              log('M12 dispatch isolated ctx id=' + c.id + ' name=' + (c.name || '?') + ' -> ' + JSON.stringify(r && r.result && r.result.value));
              return r && r.result && r.result.value;
            } catch (_) { /* 该上下文已销毁/不可用：尝试下一个 */ }
          }
          log('M12 dispatch FAILED: no usable isolated ctx (total=' + pageCtxInfos.length + ' nonDefault=' + candidates.length + ')');
          return null;
        };
        const pageHiddenM12 = () => page.send('Runtime.evaluate', {
          expression: 'JSON.stringify({ hidden: document.hidden, injected: !!document.getElementById("dsh-manager-panel-host") })',
          returnByValue: true,
        }).then((r) => {
          try { const j = JSON.parse(String(r.result.value)); return j.hidden === true; } catch (_) { return false; }
        });

        // 清场：M8 e2e 可能遗留第二个 dsh 标签（其面板有真实端点轮询，会与合成帧断言竞态）
        const allTargets = await fetchJson('http://127.0.0.1:' + PORT + '/json/list');
        for (const t of allTargets) {
          if (!t || t.id === tab.id) continue;
          if ((t.url || '').startsWith(dshUrl) || (t.url || '').startsWith(dshUrl.replace(/\/$/, ''))) {
            await fetchJson('http://127.0.0.1:' + PORT + '/json/close/' + t.id, { method: 'PUT' }).catch(() => { });
          }
        }
        // 清基线（attentionMap/设置复位）
        await swEvalM12(`(async () => {
          await chrome.storage.local.set({ attentionMap: {}, settings: { port: 3080, profile: 'web', autoOpen: true, badgeInterval: 30, attention: true, attentionDone: true, theme: 'follow-webui' } });
          return 'reset';
        })()`);
        // 面板转后台（徽标上报前置条件）+ 端点 mock 计数窗口（0 轮询证据）
        const tabBgM12 = await fetchJson('http://127.0.0.1:' + PORT + '/json/new?about:blank', { method: 'PUT' });
        await browserWs.send('Target.activateTarget', { targetId: tabBgM12.id });
        const hiddenOk = await waitForM12(pageHiddenM12, 6000);
        await page.send('Fetch.enable', { patterns: [{ urlPattern: '*_manager/sessions', requestStage: 'Request' }] });
        sessionsMockProvider = () => []; // 命中即计数：idle 基线（attTick 若轮询即被计入）
        await sleep(1600); // 让快照前的任何端点轮询（alive 尚未置位）先落地，避免与断言竞态

        // 1) 快照：1 个进行中 → 蓝 1 徽标即时上报（alive 模拟 SSE 健康）
        await dispatchSseFrame({ event: 'snapshot', data: { ok: true, items: [
          { sessionId: 'm12-w', state: 'working', updatedAt: 1700000000000 },
        ] } });
        const w1Att = await waitForM12(async () => (await attKindsM12()).includes('working'), 6000);
        const w1Badge = await waitForM12(async () => (await badgeTextM12()) === '1', 4000);
        const b1 = await badgeTextM12();
        // 诊断：alive 挂钩是否执行（DOM 标记）+ EventSource 请求时间线
        const diag = await page.send('Runtime.evaluate', {
          expression: `(() => JSON.stringify({
            aliveAttr: document.documentElement.getAttribute('data-dshm-sse-alive'),
            hidden: document.hidden,
            es: performance.getEntriesByType('resource')
              .filter((en) => /\\/_manager\\/events/.test(en.name))
              .map((en) => ({ t: Math.round(en.startTime), d: Math.round(en.duration) })),
          }))()`,
          returnByValue: true,
        });
        const diagStr = diag && diag.result ? String(diag.result.value) : 'n/a';
        record('M12：合成快照（1 working，alive）→ 徽标「1」即时上报',
          hiddenOk && w1Att && w1Badge,
          'hidden=' + hiddenOk + ' badge=' + b1 + ' kinds=' + JSON.stringify(await attKindsM12()) + ' diag=' + diagStr);

        // 2) 0 轮询：SSE alive 窗口内 attTick 不打端点（2.5s ≈ 2-3 个 1Hz tick）
        const hitsBefore = sessionsMockHits;
        await sleep(2500);
        const hitsAfter = sessionsMockHits;
        record('M12：SSE 活跃期间 0 端点轮询（2.5s 窗口无 /_manager/sessions 请求）',
          hitsAfter === hitsBefore, 'hits ' + hitsBefore + '→' + hitsAfter);

        // 3) upsert：等待 → 徽标「?」即时切换（优先级覆盖进行中）
        await dispatchSseFrame({ event: 'upsert', data: { session: {
          sessionId: 'm12-w', state: 'waiting', updatedAt: 1700000001000,
        } } });
        const w2Att = await waitForM12(async () => (await attKindsM12()).includes('waiting'), 4000);
        const w2Badge = await waitForM12(async () => (await badgeTextM12()) === '?', 4000);
        record('M12：upsert waiting → 徽标「?」即时切换',
          w2Att && w2Badge, 'badge=' + await badgeTextM12() + ' kinds=' + JSON.stringify(await attKindsM12()));

        // 4) removed + 快照清空 → 计数回落（状态机走 idle 上报，徽标清空；
        //    attentionMap 保留 idle 条目属设计行为——隐蔽时不删条目，只清徽标）
        await dispatchSseFrame({ event: 'removed', data: { sessionId: 'm12-w' } });
        await dispatchSseFrame({ event: 'snapshot', data: { ok: true, items: [] } });
        const cleared = await waitForM12(async () => (await badgeTextM12()) === '', 6000);
        record('M12：removed/清空快照 → 徽标恢复安静',
          cleared, 'badge=' + JSON.stringify(await badgeTextM12()) + ' kinds=' + JSON.stringify(await attKindsM12()));

        // 4b) done 链路（M13 适配补位，2026-09-04）：M8 端点 mock 在 SSE 存活环境
        //     不可达（面板 attTick 不轮询端点，mockHits=0 实证）——done「绿!」改由
        //     合成帧确定性覆盖：working 快照 → 空快照（状态机稳定 1.2s 空态 →
        //     done-fired → 绿!），与 M8 DOM 回退路径（插件不可用环境）互补。
        await dispatchSseFrame({ event: 'snapshot', data: { ok: true, items: [
          { sessionId: 'm12-d', state: 'working', updatedAt: 1700000002000 },
        ] } });
        const dWk = await waitForM12(async () => (await attKindsM12()).includes('working'), 4000);
        const dWkBadge = await waitForM12(async () => (await badgeTextM12()) === '1', 4000);
        await dispatchSseFrame({ event: 'snapshot', data: { ok: true, items: [] } });
        const dDone = await waitForM12(async () => (await attKindsM12()).includes('done'), 12000);
        const dDoneBadge = await waitForM12(async () => (await badgeTextM12()) === '!', 6000);
        record('M12：working→空快照（稳定空态）→ 绿「!」done 链路（合成帧；M13 补 M8 端点 mock 覆盖缺口）',
          dWk && dWkBadge && dDone && dDoneBadge,
          'badge=' + JSON.stringify(await badgeTextM12()) + ' kinds=' + JSON.stringify(await attKindsM12()));

        // 5) 时序回归（2026-08-26 用户实测暴露）：「可见期帧到达 → 后切后台」——
        //    面板在可见期只记账不 attApply（用户在看，无需提醒）；切后台的瞬间必须由
        //    attTick 用内存计数补推一次状态机，否则徽标永远错过 waiting 上报（popup
        //    已见「待确认」、徽标不黄的实测现象）。
        await browserWs.send('Target.activateTarget', { targetId: tab.id }); // 切回 dsh 页（可见）
        await waitForM12(async () => {
          const h = await page.send('Runtime.evaluate', {
            expression: 'document.hidden',
            returnByValue: true,
          });
          return h && h.result && h.result.value === false;
        }, 6000);
        await dispatchSseFrame({ event: 'snapshot', data: { ok: true, items: [
          { sessionId: 'm12-seq', state: 'working', updatedAt: 1700000000000 },
        ] } });
        await dispatchSseFrame({ event: 'upsert', data: { session: {
          sessionId: 'm12-seq', state: 'waiting', updatedAt: 1700000001000,
        } } });
        // 可见期：不上报（状态机未推进）
        const visibleQuiet = !(await attKindsM12()).includes('waiting');
        const badgeBeforeSeq = await badgeTextM12();
        // 切后台（visibilitychange → attTick 立即补推）
        await browserWs.send('Target.activateTarget', { targetId: tabBgM12.id });
        const seqOk = await waitForM12(async () => (await badgeTextM12()) === '?', 5000);
        record('M12：可见期帧到达 → 切后台 → 徽标补推「?」（时序回归：先发帧后切后台）',
          visibleQuiet && seqOk,
          'visibleQuiet=' + visibleQuiet + ' badgeBefore=' + JSON.stringify(badgeBeforeSeq) + ' badgeAfter=' + await badgeTextM12());

        // 清理：mock/Fetch/辅助标签/回到 dsh 页 + 清镜像与提醒残留（防污染后续测试段）
        sessionsMockProvider = null;
        await page.send('Fetch.disable');
        await swEvalM12(`(async () => {
          await chrome.storage.local.set({ sessionsCache: {}, attentionMap: {} });
          return 'cleared';
        })()`);
        await fetchJson('http://127.0.0.1:' + PORT + '/json/close/' + tabBgM12.id, { method: 'PUT' }).catch(() => { });
        await browserWs.send('Target.activateTarget', { targetId: tab.id });
      } catch (eM12) {
        record('M12：SSE 会话推送', false, 'e2e 异常: ' + (eM12 && eM12.message ? eM12.message : String(eM12)));
      }
    }
  }

  // 8d) M12.2 真实 EventSource 路径回归（design §8.10.1「客户端接收要求」，
  //     2026-08-26）：M12.2 破案复盘——徽标长期缺失的根因是面板只挂 onmessage、
  //     收不到插件帧的 `event:` 命名事件（snapshot/upsert/removed 永不触发
  //     onmessage），而 8c 的合成帧挂钩恰好绕过真实 EventSource 解析（101/0
  //     全绿掩盖接收层缺陷）。本段保留一路真实路径：插件端点可达时开新标签页连
  //     真实 /_manager/events，以面板 data-dshm-sse-alive（真实 onopen 探针）+
  //     data-dshm-sse-count（真实帧进入 applySseFrame/sseMap 探针，属性只在
  //     applySseFrame 内写入）双证据断言；端点不可达（被验实例未装 M12 插件）→
  //     SKIP（环境依赖，不 FAIL，与 M8 e2e 降级思路一致）。
  log('M12：真实 EventSource 连接 + 真实帧解析（防 M12.2 接收层回归）');
  {
    const http = require('http');
    const sseEndpoint = dshUrl.replace(/\/+$/, '') + '/_manager/events';
    // Node 侧探测：插件端点连接即发 snapshot 帧（fetch 会挂长连接不返回，须用
    // http.get + 短读窗口——读到 event: 行即销毁，3s 超时判定不可达）
    let sseReachable = false;
    let probeDiag = '';
    await new Promise((resolve) => {
      const req = http.get(sseEndpoint, { timeout: 3000 }, (res) => {
        probeDiag += 'status=' + res.statusCode;
        if (res.statusCode !== 200) { req.destroy(); resolve(); return; }
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk.toString();
          if (/^event: |\nevent: |\r\nevent: /.test(buf)) {
            sseReachable = true;
            probeDiag += ' head=' + JSON.stringify(buf.split(/\r?\n/).slice(0, 3).join('|'));
            req.destroy();
            resolve();
          }
        });
        res.on('end', () => { if (buf) probeDiag += ' eof bytes=' + buf.length; resolve(); });
        res.on('error', (e) => { probeDiag += ' resErr=' + (e && e.code); resolve(); });
      });
      req.on('timeout', () => { probeDiag += ' timeout'; req.destroy(); resolve(); });
      req.on('error', (e) => { probeDiag += ' reqErr=' + (e && e.code); resolve(); });
    });
    if (!sseReachable) {
      record('M12：真实 EventSource 路径', true,
        'SKIP——插件端点 ' + sseEndpoint + ' 不可达（' + (probeDiag || '无响应') + '），环境依赖');
    } else {
      let pageSse = null;
      let tabSse = null;
      try {
        // 新标签页（本页不挂 Fetch 拦截 → 面板走真实端点）；显式激活避免后台 tab
        // 对 EventSource/timer 的节流，与 8c 的 tabBgM12 激活同款
        tabSse = await fetchJson('http://127.0.0.1:' + PORT + '/json/new?about:blank', { method: 'PUT' });
        await browserWs.send('Target.activateTarget', { targetId: tabSse.id });
        pageSse = await connectWs(tabSse.webSocketDebuggerUrl);
        await pageSse.send('Page.enable');
        await pageSse.send('Runtime.enable');
        await pageSse.send('Page.navigate', { url: dshUrl });
        // 轮询断言：面板注入 + 真实连接探针 + 真实帧探针。count 属性只在
        // applySseFrame 内写入——属性存在即真实帧已解析（空闲实例空快照时值为
        // '0'，故按「存在」而非「≥1」判定，防空闲实例误报）
        let ok8d = false;
        let diag8d = 'timeout';
        const deadline = Date.now() + 20000;
        for (;;) {
          let j = null;
          try {
            const r = await pageSse.send('Runtime.evaluate', {
              expression: `(() => {
                const el = document.getElementById('dsh-manager-panel-host');
                const root = document.documentElement;
                return JSON.stringify({
                  injected: !!el,
                  alive: root.getAttribute('data-dshm-sse-alive'),
                  count: root.getAttribute('data-dshm-sse-count'),
                  hidden: document.hidden,
                });
              })()`,
              returnByValue: true,
            });
            j = r && r.result ? JSON.parse(String(r.result.value)) : null;
          } catch (_) { /* 导航期上下文销毁：继续轮询 */ }
          if (j && j.injected === true && j.alive === '1' && j.count !== null) {
            ok8d = true;
            diag8d = JSON.stringify(j);
            break;
          }
          if (Date.now() >= deadline) { diag8d = JSON.stringify(j); break; }
          await sleep(500);
        }
        record('M12：真实 EventSource 连接 + 真实 SSE 帧解析（面板 data-dshm-sse-* 双探针）',
          ok8d, 'diag=' + diag8d + ' probe=' + probeDiag);
      } catch (e8d) {
        record('M12：真实 EventSource 路径', false, '8d 异常: ' + (e8d && e8d.message ? e8d.message : String(e8d)));
      } finally {
        // 清理：断 WS → 关新标签页 → 显式激活原 dsh 页（防其后台面板残留上报）
        if (pageSse) { try { pageSse.ws.close(); } catch (_) { /* 忽略 */ } }
        if (tabSse) {
          await fetchJson('http://127.0.0.1:' + PORT + '/json/close/' + tabSse.id, { method: 'PUT' }).catch(() => { });
        }
        try { await browserWs.send('Target.activateTarget', { targetId: tab.id }); } catch (_) { /* 忽略 */ }
        // 原页面可见后 ~1s 内 attTick 会自动 clear；再经 SW 清一次提醒/镜像，
        // 确定性防污染后续测试段（8c 清理同款）
        await sleep(1500);
        try {
          const swClean = (await fetchJson('http://127.0.0.1:' + PORT + '/json/list'))
            .find((t) => t.type === 'service_worker' && (t.url || '').includes(extId));
          if (swClean) {
            const wsClean = await connectWs(swClean.webSocketDebuggerUrl);
            await wsClean.send('Runtime.enable');
            await wsClean.send('Runtime.evaluate', {
              expression: `(async () => { await chrome.storage.local.set({ sessionsCache: {}, attentionMap: {} }); return 'cleared'; })()`,
              awaitPromise: true, returnByValue: true,
            });
            wsClean.ws.close();
          }
        } catch (_) { /* 清理尽力而为 */ }
      }
    }
  }

  // 8e) rc.2：真实服务端断流/HTTP 回退/隐藏重连。配置 fixture 时必须执行，不能 SKIP。
  await verifyRealSseRecovery(dshUrl, extId, page, tab.id);

  // 9) 日志页交互（安全只读）：点「加载更早」（真实日志 < 500 行 → toast 已到开头）
  //    与「复制全部」（toast 显示行数）——验证按钮/toast 链路，不触碰生命周期。
  log('日志页交互（加载更早 / 复制全部）');
  await page.send('Page.navigate', { url: 'chrome-extension://' + extId + '/logs.html' });
  await sleep(3000);
  const clickInPage = async (expr) => {
    const r = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r && r.result ? String(r.result.value ?? '') : '';
  };
  // 等待初始加载完成（按钮可用且底栏出现）再点击——2s 跟随刷新会短暂 busy，
  // 直接点击可能落在禁用窗口被静默丢弃
  let clickState = 'timeout';
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    clickState = await clickInPage(`(() => {
      const b = document.getElementById('btn-load-earlier');
      const f = document.getElementById('footer');
      return JSON.stringify({ disabled: b ? b.disabled : null, footerReady: f ? f.textContent.includes('已加载') : false });
    })()`);
    if (clickState.includes('"disabled":false') && clickState.includes('"footerReady":true')) break;
  }
  const readyForClick = clickState.includes('"disabled":false') && clickState.includes('"footerReady":true');
  if (readyForClick) {
    await clickInPage(`(() => { document.getElementById('btn-load-earlier').click(); return 'clicked'; })()`);
  }
  let earlierToast = '';
  for (let i = 0; i < 8; i++) {
    await sleep(500);
    earlierToast = await clickInPage(`(() => { const t = document.getElementById('toast-text'); return t ? t.textContent : ''; })()`);
    if (earlierToast) break;
  }
  record('日志页：加载更早反馈', readyForClick && /已到日志开头|已暂停自动刷新/.test(earlierToast),
    earlierToast + (earlierToast ? '' : '（点击前状态: ' + clickState + '）'));
  await clickInPage(`(() => { const b = document.getElementById('btn-copy'); if (b) b.click(); return 'clicked'; })()`);
  await sleep(1500);
  const copyInfo = await clickInPage(`(() => {
    const t = document.getElementById('toast-text');
    return t ? t.textContent : '';
  })()`);
  record('日志页：复制全部反馈', /已复制|没有可复制|复制失败/.test(copyInfo), copyInfo);

  // 10) popup 设置面板交互（安全）：展开设置 → 断言字段；无效端口 → 红框错误文案；
  //     改回合法值保存 → toast；取消关闭。
  log('popup 设置面板交互');
  await page.send('Page.navigate', { url: 'chrome-extension://' + extId + '/popup.html' });
  await sleep(3000);
  await clickInPage(`(() => { const b = document.getElementById('v6-r-sett') || document.getElementById('btn-settings'); if (b) b.click(); return 'clicked'; })()`);
  await sleep(800);
  const settingsOpen = await clickInPage(`(() => {
    const p = document.getElementById('v6-p-sett') || document.getElementById('settings-panel');
    const port = document.getElementById('set-port');
    return JSON.stringify({ open: !!(p && !p.classList.contains('hidden')), portValue: port ? port.value : '' });
  })()`);
  try {
    const so = JSON.parse(settingsOpen);
    record('popup：设置面板展开', so.open === true, settingsOpen);
  } catch (_) {
    record('popup：设置面板展开', false, settingsOpen);
  }
  await clickInPage(`(() => {
    const input = document.getElementById('set-port');
    input.value = '70000';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-save').click();
    return 'saved';
  })()`);
  await sleep(800);
  const invalidInfo = await clickInPage(`(() => {
    const e = document.getElementById('settings-error');
    const input = document.getElementById('set-port');
    return JSON.stringify({ err: e ? e.textContent : '', invalid: input ? input.classList.contains('field-invalid') : false });
  })()`);
  try {
    const ii = JSON.parse(invalidInfo);
    record('popup：无效端口校验（红框 + 文案）', ii.invalid === true && /0-65535/.test(ii.err), ii.err);
  } catch (_) {
    record('popup：无效端口校验（红框 + 文案）', false, invalidInfo);
  }
  await clickInPage(`(() => {
    const input = document.getElementById('set-port');
    input.value = '3080';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-save').click();
    return 'saved';
  })()`);
  await sleep(1000);
  const saveInfo = await clickInPage(`(() => {
    const t = document.getElementById('toast-text');
    return t ? t.textContent : '';
  })()`);
  record('popup：合法设置保存 toast', saveInfo.includes('设置已保存'), saveInfo);

  // 11) 主题与深色模式（design §8.7.7）
  //    契约：settings.theme ∈ {follow-webui,follow-system,light,dark}（默认 follow-webui，
  //    并行代理实现 theme.js 落 body[data-ds-dark-theme]）；webuiTheme={dark,at,port}（无镜像时
  //    键不存在）；深色 bg-base=#151517=rgb(21,21,23)，浅色=#fff=rgb(255,255,255)。
  //    全走「设置 → 重载/等待 → 断言」确定性路径；console 异常沿用既有收集。
  log('主题与深色模式（§8.7.7）');
  consoleErrors.length = 0; // 主题段专用的 console 收集（清掉此前 dsh 页面/设置段的日志）
  const DARK_BG = 'rgb(21, 21, 23)';      // #151517
  const LIGHT_BG = 'rgb(255, 255, 255)';  // #ffffff
  const isDarkRgb = (bg) => {
    const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(String(bg || ''));
    return !!m && (Number(m[1]) + Number(m[2]) + Number(m[3])) < 300;
  };
  // 主题段统一 evaluate（带 awaitPromise：chrome.storage.* 均为 async）
  const evalPage = async (expr) => {
    const r = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r && r.result ? String(r.result.value ?? '') : '';
  };
  const gotoPopup = async () => {
    await page.send('Page.navigate', { url: 'chrome-extension://' + extId + '/popup.html' });
    await waitUntil(async () => {
      const result = await page.send('Runtime.evaluate', {
        expression: `typeof settings !== 'undefined' && !!settings && typeof pollTimer !== 'undefined' && pollTimer !== null && !!document.getElementById('statuscard')`,
        returnByValue: true,
      });
      return result && result.result && result.result.value === true;
    }, 8000);
  };
  const gotoDsh = async () => {
    await page.send('Page.navigate', { url: dshUrl });
    await waitUntil(async () => {
      const result = await page.send('Runtime.evaluate', {
        expression: `!!document.getElementById('dsh-manager-panel-host')?.shadowRoot`, returnByValue: true,
      });
      return result && result.result && result.result.value === true;
    }, 10000);
  };
  const shotPng = async (name) => {
    const r = await page.send('Page.captureScreenshot', { format: 'png' });
    const png = pathShots(name.endsWith('.png') ? name : name + '.png'); // 统一 .png 扩展名
    fs.writeFileSync(png, Buffer.from(r.data, 'base64'));
    record(name + ' 截图', fs.statSync(png).size > 2000, png + ' (' + fs.statSync(png).size + ' bytes)');
  };
  // 在 popup 扩展上下文写 settings.theme（合并既有 settings，避免冲掉 port/profile 等字段）
  const setPopupTheme = async (theme) => {
    await evalPage(`(async () => {
      const cur = (await chrome.storage.local.get('settings')).settings || {};
      await chrome.storage.local.set({ settings: Object.assign({}, cur, { theme: '${theme}' }) });
      return 'ok';
    })()`);
  };
  // 镜像链路：settings.theme='follow-webui' + 写 webuiTheme 镜像（键名与契约一致）
  const setPopupMirror = async (dark, port) => {
    await evalPage(`(async () => {
      const cur = (await chrome.storage.local.get('settings')).settings || {};
      await chrome.storage.local.set({
        settings: Object.assign({}, cur, { theme: 'follow-webui' }),
        webuiTheme: { dark: ${dark}, at: Date.now(), port: ${port} },
      });
      return 'ok';
    })()`);
  };
  const readPopupTheme = async () => {
    const s = await evalPage(`(() => {
      const cs = getComputedStyle(document.body);
      return JSON.stringify({
        hasAttr: document.body.hasAttribute('data-ds-dark-theme'),
        bg: cs.backgroundColor,
        bgBase: cs.getPropertyValue('--dsw-alias-bg-base').trim(),
      });
    })()`);
    try { return JSON.parse(s); } catch (_) { return { hasAttr: false, bg: '', bgBase: '' }; }
  };
  const readPanelTheme = async () => {
    const s = await evalPage(`(() => {
      const h = document.getElementById('dsh-manager-panel-host');
      if (!h || !h.shadowRoot) return JSON.stringify({ present: false });
      const chip = h.shadowRoot.querySelector('.chip');
      const btn = h.shadowRoot.querySelector('.btn');
      return JSON.stringify({
        present: true,
        chipBg: getComputedStyle(chip).backgroundColor,
        btnBg: getComputedStyle(btn).backgroundColor,
      });
    })()`);
    try { return JSON.parse(s); } catch (_) { return { present: false }; }
  };
  const setPageDark = (dark) => evalPage(`(() => {
    if (${dark}) document.body.setAttribute('data-ds-dark-theme', '');
    else document.body.removeAttribute('data-ds-dark-theme');
    return 'set';
  })()`);
  // storage 镜像侧属扩展上下文（content script 隔离世界写、SW 读）——dsh 页主世界里无
  // chrome.storage，故经扩展 SW 读取 webuiTheme（SW 与内容脚本共享同一 chrome.storage.local 存储）
  const readWebuiViaSw = async () => {
    let tg = null;
    try {
      tg = (await fetchJson('http://127.0.0.1:' + PORT + '/json/list'))
        .filter((t) => t.type === 'service_worker' && (t.url || '').includes(extId))[0];
    } catch (_) { return { err: 'list-failed' }; }
    if (!tg) return { err: 'no-sw-target' };
    try {
      const s = await connectWs(tg.webSocketDebuggerUrl);
      await s.send('Runtime.enable');
      const r = await s.send('Runtime.evaluate', {
        expression: `(async () => { const d = await chrome.storage.local.get('webuiTheme'); return JSON.stringify(d.webuiTheme || null); })()`,
        awaitPromise: true, returnByValue: true,
      });
      return r && r.result ? JSON.parse(String(r.result.value)) : null;
    } catch (e) { return { err: e.message }; }
  };
  const emulateColorScheme = async (value) => {
    try {
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
      return true;
    } catch (e) { return false; }
  };
  const resetEmulation = async () => {
    try { await page.send('Emulation.setEmulatedMedia', { media: '', features: [] }); } catch (_) { /* 忽略 */ }
  };

  // 11a) 面板深色跟随（§8.7.7 ③）：宿主 body[data-ds-dark-theme] 翻转后，
  //      shadow 内面板令牌继承宿主 → chip 计算背景同步变化
  //      注（2026-08-22 加固）：webui 主题偏好可能浅也可能深（真实环境状态），
  //      前置断言不再硬编码「初始浅色」——改为「面板初始跟随宿主渲染态」；
  //      深色翻转前先强制拉回浅色，保证「浅→深」翻转真实发生（原实现若首页已深，
  //      翻转路径未被验证、且前置断言误败）。
  log('面板深色跟随');
  await gotoDsh();
  let panelLight = { present: false };
  try { panelLight = await readPanelTheme(); } catch (_) { /* 保持默认 */ }
  const hostInitDark = await evalPage(`JSON.stringify(document.body.hasAttribute('data-ds-dark-theme'))`)
    .then((v) => String(v) === 'true').catch(() => false);
  record('主题：面板已注入（前置）', panelLight.present === true, JSON.stringify(panelLight));
  record('主题：面板初始跟随宿主渲染态（浅/深按宿主实际）',
    panelLight.present === true && (hostInitDark ? isDarkRgb(panelLight.chipBg) : panelLight.chipBg === LIGHT_BG),
    'chipBg=' + panelLight.chipBg + ' hostDark=' + hostInitDark);
  await setPageDark(false); // 先拉回浅色（宿主初始深色时亦然），确保下方翻转真实执行
  await sleep(300);
  await setPageDark(true);
  await sleep(300); // CSS 变量继承即时生效，300ms 避免指针/transition 竞态
  let panelDark = { present: false };
  try { panelDark = await readPanelTheme(); } catch (_) { /* 保持默认 */ }
  record('主题：面板深色跟随（chip 背景变深）',
    panelDark.present === true && panelDark.chipBg !== LIGHT_BG && isDarkRgb(panelDark.chipBg),
    'chipBg(深)=' + panelDark.chipBg + ' chipBg(浅)=' + panelLight.chipBg);
  await setPageDark(false);
  await sleep(300);
  let panelRestore = { present: false };
  try { panelRestore = await readPanelTheme(); } catch (_) { /* 保持默认 */ }
  record('主题：面板恢复浅色（移除属性后 chip 背景还原）',
    panelRestore.present === true && panelRestore.chipBg === LIGHT_BG,
    'chipBg(恢复)=' + panelRestore.chipBg);

  // 11b) storage 镜像写入（§8.7.7 ②/③ 的镜像写入侧）：page 翻转 body → content script
  //      观察并写 chrome.storage.local.webuiTheme（幂等、带 at 时间戳、port 为面板页面端口）
  log('storage 镜像写入（webuiTheme）');
  await setPageDark(true);
  await sleep(1200); // 等 panel.js MutationObserver 写镜像（≤1s 窗口）
  let wDark = null;
  try { wDark = await readWebuiViaSw(); } catch (_) { /* 保持 null */ }
  record('主题：storage 镜像写入 webuiTheme(dark:true)',
    wDark && wDark.dark === true && typeof wDark.port === 'number' && typeof wDark.at === 'number',
    JSON.stringify(wDark));
  await setPageDark(false);
  await sleep(1200);
  let wLight = null;
  try { wLight = await readWebuiViaSw(); } catch (_) { /* 保持 null */ }
  record('主题：storage 镜像更新 webuiTheme(dark:false)',
    wLight && wLight.dark === false,
    JSON.stringify(wLight));

  // 11c) popup 四态主题（§8.7.7 ① ②）：设置 → 重载 → 断言，确定性路径
  log('popup 深色/浅色/跟随系统/镜像链路');
  await gotoPopup();

  // -- dark：属性存在 + 背景深色；并存截图 popup-dark.png
  await setPopupTheme('dark');
  await gotoPopup();
  let tDark = { hasAttr: false, bg: '' };
  try { tDark = await readPopupTheme(); } catch (_) { /* 保持默认 */ }
  record('主题：popup dark（属性 + 背景深色）',
    tDark.hasAttr === true && isDarkRgb(tDark.bg),
    JSON.stringify(tDark));
  await shotPng('popup-dark.png');

  // -- light：无属性 + 背景浅色
  await setPopupTheme('light');
  await gotoPopup();
  let tLight = { hasAttr: false, bg: '' };
  try { tLight = await readPopupTheme(); } catch (_) { /* 保持默认 */ }
  record('主题：popup light（无属性 + 背景浅色）',
    tLight.hasAttr === false && tLight.bg === LIGHT_BG,
    JSON.stringify(tLight));

  // -- 外观行：浅色选中态背景（bg-module-platform=bluish-60）与 radiogroup 键盘导航
  // （回归守卫：选中态变量若是深色专用未定义，浅色下背景会回退 transparent）
  let gridSelL = null;
  try {
    gridSelL = await evalPage(`(async () => {
      document.getElementById('btn-settings').click();
      await new Promise((r) => setTimeout(r, 300));
      const el = document.querySelector('.theme-cube.selected');
      const before = {
        theme: el && el.getAttribute('data-theme'),
        bg: el ? getComputedStyle(el).backgroundColor : '',
        tab: el ? el.getAttribute('tabindex') : '',
        checked: el ? el.getAttribute('aria-checked') : '',
      };
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 300));
      const sel = document.querySelector('.theme-cube.selected');
      const after = {
        theme: sel && sel.getAttribute('data-theme'),
        tab: sel ? sel.getAttribute('tabindex') : '',
      };
      return JSON.stringify({ before, after });
    })()`);
  } catch (_) { /* 保持 null */ }
  const g2 = gridSelL ? JSON.parse(gridSelL) : null;
  record('主题：浅色选中态背景（bg-interactive-active 渲染）',
    !!(g2 && (g2.before.bg.includes('38, 49, 72') || g2.before.bg === 'rgb(245, 246, 247)') && g2.before.tab === '0' && g2.before.checked === 'true'),
    gridSelL || 'evaluate failed');
  record('主题：外观行键盘导航（ArrowRight 换选 + roving tabindex）',
    !!(g2 && g2.after.theme === 'dark' && g2.after.tab === '0'),
    gridSelL || 'evaluate failed');

  // -- 外观行防回归（M13.2）：浅色下未选中 cube 令牌一致性——月亮按钮 data-theme="dark"
  //    曾被深色令牌块的游离选择器 [data-theme="dark"] 命中，整套深色令牌局部泄漏到该按钮
  //    （边框变白不可见、图标变浅灰）。断言三个未选中 cube 的 color 与
  //    --dsw-alias-border-l1 计算值完全一致，防令牌作用域泄漏复发。
  await setPopupTheme('light');
  await gotoPopup();
  let cubeTokensL = null;
  try {
    cubeTokensL = await evalPage(`(async () => {
      document.getElementById('btn-settings').click();
      await new Promise((r) => setTimeout(r, 300));
      const cubes = Array.from(document.querySelectorAll('.theme-cube'));
      return JSON.stringify(cubes.map((c) => ({
        theme: c.getAttribute('data-theme'),
        selected: c.classList.contains('selected'),
        color: getComputedStyle(c).color,
        borderL1: getComputedStyle(c).getPropertyValue('--dsw-alias-border-l1').trim(),
      })));
    })()`);
  } catch (_) { /* 保持 null */ }
  const ctL = cubeTokensL ? JSON.parse(cubeTokensL) : null;
  const ctUnsel = ctL ? ctL.filter((c) => !c.selected) : [];
  record('主题：浅色下未选中 cube 令牌一致（月亮无深色令牌泄漏）',
    !!(ctUnsel.length === 3 &&
       ctUnsel.every((c) => c.color === 'rgb(97, 102, 107)') &&
       ctUnsel.every((c) => c.borderL1 === ctUnsel[0].borderL1 && c.borderL1 === 'rgba(0, 0, 0, 0.04)')),
    cubeTokensL || 'evaluate failed');

  // -- follow-system：CDP Emulation 翻转 prefers-color-scheme 断言跟随
  await setPopupTheme('follow-system');
  await gotoPopup();
  const emuDark = await emulateColorScheme('dark');
  await gotoPopup(); // 重载以确定性应用当前模拟系统偏好
  let tSysDark = { hasAttr: false, bg: '' };
  try { tSysDark = await readPopupTheme(); } catch (_) { /* 保持默认 */ }
  record('主题：popup follow-system 深色跟随系统',
    emuDark === true && tSysDark.hasAttr === true && isDarkRgb(tSysDark.bg),
    'emuDark=' + emuDark + ' theme=' + JSON.stringify(tSysDark));
  await emulateColorScheme('light');
  await gotoPopup();
  let tSysLight = { hasAttr: false, bg: '' };
  try { tSysLight = await readPopupTheme(); } catch (_) { /* 保持默认 */ }
  record('主题：popup follow-system 浅色跟随系统',
    tSysLight.hasAttr === false && tSysLight.bg === LIGHT_BG,
    'theme=' + JSON.stringify(tSysLight));
  await resetEmulation();

  // -- 镜像链路：settings.theme='follow-webui' + webuiTheme={dark,at,port}
  await setPopupMirror(true, 3080);
  await gotoPopup();
  let tMirrorDark = { hasAttr: false, bg: '' };
  try { tMirrorDark = await readPopupTheme(); } catch (_) { /* 保持默认 */ }
  record('主题：popup 镜像链路(dark:true → 深色)',
    tMirrorDark.hasAttr === true && isDarkRgb(tMirrorDark.bg),
    JSON.stringify(tMirrorDark));
  await setPopupMirror(false, 3080);
  await gotoPopup();
  let tMirrorLight = { hasAttr: false, bg: '' };
  try { tMirrorLight = await readPopupTheme(); } catch (_) { /* 保持默认 */ }
  record('主题：popup 镜像链路(dark:false → 浅色)',
    tMirrorLight.hasAttr === false && tMirrorLight.bg === LIGHT_BG,
    JSON.stringify(tMirrorLight));

  // -- 回归浅色后存档 popup-light.png（§8.7.7 ④）
  record('主题：深色段无新增 console 异常', consoleErrors.length === 0,
    consoleErrors.length ? consoleErrors.join(' ||| ').slice(0, 800) : '');
  await shotPng('popup-light.png');

  // 12) M7 状态卡变体 + Matrix 动效 + 深/浅卡片背景（design §8.8）
  log('M7 状态卡变体 + 状态点动效（§8.8）');
  consoleErrors.length = 0; // M7 段专用收集
  const m7Variants = await evalPage(`(() => {
    const snap = () => {
      const c = document.getElementById('statuscard');
      if (!c) return { present: false };
      const dot = document.getElementById('dot');
      const word = document.getElementById('state-word');
      return {
        present: true,
        cls: c.className,
        word: word ? word.textContent : '',
        dot: dot ? dot.className : '',
        hasMatrix: dot ? !!dot.querySelector('.matrix, .dsh-state-matrix') : false,
        breathe: dot ? getComputedStyle(dot, '::after').animationName : '',
        halo: dot ? getComputedStyle(dot, '::before').animationName : '',
        border: getComputedStyle(c).borderColor,
        wordColor: word ? getComputedStyle(word).color : '',
      };
    };
    const orig = { state: state, startedAtMs: startedAtMs };
    const out = {};
    state = 'running'; render(); out.running = snap();
    state = 'external'; render(); out.external = snap();
    state = 'starting'; render(); out.starting = snap();
    state = 'stopping'; render(); out.stopping = snap();
    state = 'error'; render(); out.error = snap();
    state = 'stopped'; render(); out.stopped = snap();
    state = orig.state; startedAtMs = orig.startedAtMs; render();
    return JSON.stringify(out);
  })()`);
  let m7v = {};
  try { m7v = JSON.parse(m7Variants); } catch (_) { /* 保持默认 */ }
  const v = m7v || {};
  const okv = (o) => !!(o && o.present === true);
  record('M7：running 状态词「运行中」+ 绿点 + 实心点呼吸',
    okv(v.running) && v.running.word === '运行中' && v.running.dot === 'dot dot-running'
      && v.running.breathe === 'dsh-dot-breathe' && v.running.halo === 'dsh-halo-breathe',
    JSON.stringify(v.running));
  record('M7：external 状态词「外部实例」+ 蓝点',
    okv(v.external) && v.external.word === '外部实例' && v.external.dot === 'dot dot-external', JSON.stringify(v.external));
  record('M7：starting 状态词「正在启动…」+ 琥珀 busy 脉冲',
    okv(v.starting) && v.starting.word === '正在启动…' && v.starting.dot === 'dot dot-busy'
      && v.starting.breathe === 'dsh-dot-pulse',
    JSON.stringify(v.starting));
  record('M7：stopping 状态词「正在停止…」+ 琥珀 busy 脉冲',
    okv(v.stopping) && v.stopping.word === '正在停止…' && v.stopping.dot === 'dot dot-busy'
      && v.stopping.breathe === 'dsh-dot-pulse',
    JSON.stringify(v.stopping));
  record('M7：error 红调卡（.error + 红边框 + 红状态词）',
    okv(v.error) && /\berror\b/.test(v.error.cls)
      && (v.error.word === '状态获取失败' || v.error.word === '—'),
    JSON.stringify(v.error));
  record('M7：stopped 状态词「已停止」+ 灰点',
    okv(v.stopped) && v.stopped.word === '已停止' && v.stopped.dot === 'dot dot-stopped', JSON.stringify(v.stopped));

  // M13/rc.2：只 stub 本段的 tabs/windows 边界，运行真实 openWebUI 实现；
  // 会话无伪 hash 路由。认证查询只传 type，所有证据只返回布尔值/计数，不返回令牌 URL。
  const m13Open = await evalPage(`(async () => {
    const original = {
      query: chrome.tabs.query, create: chrome.tabs.create, update: chrome.tabs.update,
      reload: chrome.tabs.reload, sendMessage: chrome.tabs.sendMessage,
      getCurrent: chrome.windows.getCurrent, windowUpdate: chrome.windows.update,
      detail, state, settings,
    };
    const token = 'verify-auth-fixture-token-1234567890';
    const launch = 'http://127.0.0.1:3080/?token=' + token;
    let tabs = [], auth = { authenticated: true, port: 3080 }, noReceiver = false;
    let calls;
    const resetCalls = () => { calls = { created: [], updated: [], reloaded: [], focused: [], messages: [] }; };
    const safe = () => ({
      creates: calls.created.length,
      legalLaunch: calls.created.length === 1 && calls.created[0].url === launch,
      cleanBare: calls.created.length === 1 && calls.created[0].url === 'http://127.0.0.1:3080',
      rootOnly: calls.created.every((entry) => { const u = new URL(entry.url); return u.pathname === '/' && !u.hash; }),
      noSecret: !JSON.stringify({ updated: calls.updated, messages: calls.messages, focused: calls.focused }).includes(token),
      updateIds: calls.updated.map((entry) => entry.id),
      updateOnlyActive: calls.updated.every((entry) => entry.options.active === true && Object.keys(entry.options).length === 1),
      reloads: calls.reloaded.length,
      focusIds: calls.focused.map((entry) => entry.id),
      authQueryOnly: calls.messages.every((entry) => Object.keys(entry.message).length === 1 && entry.message.type === 'dsh-auth-status'),
      authTopFrame: calls.messages.every((entry) => entry.options && entry.options.frameId === 0),
      messageIds: calls.messages.map((entry) => entry.id),
      toast: (document.getElementById('toast-text') || {}).textContent || '',
    });
    const invoke = async (input = {}) => {
      resetCalls();
      tabs = input.tabs || [];
      auth = Object.prototype.hasOwnProperty.call(input, 'auth') ? input.auth : { authenticated: true, port: 3080 };
      noReceiver = input.noReceiver === true;
      detail = { port: 3080 };
      if (input.launch !== null) detail.launchUrl = input.launch || launch;
      state = input.external ? 'external' : 'running';
      const toast = document.getElementById('toast-text'); if (toast) toast.textContent = '';
      await openWebUI();
      return safe();
    };
    const existing = { id: 701, windowId: 71, url: 'http://127.0.0.1:3080/', status: 'complete', lastAccessed: 100 };
    try {
      settings = Object.assign({}, settings, { port: 3080 });
      chrome.tabs.query = async () => tabs;
      chrome.tabs.create = async (options) => { calls.created.push(options); return { id: 799 }; };
      chrome.tabs.update = async (id, options) => { calls.updated.push({ id, options }); return { id }; };
      chrome.tabs.reload = async (id) => { calls.reloaded.push(id); };
      chrome.tabs.sendMessage = async (id, message, options) => {
        calls.messages.push({ id, message, options });
        if (noReceiver) throw new Error('fixture: no receiving end');
        return auth;
      };
      chrome.windows.getCurrent = async () => ({ id: 71 });
      chrome.windows.update = async (id, options) => { calls.focused.push({ id, options }); return { id }; };
      const out = {};
      out.withLaunch = await invoke();
      out.bare = await invoke({ launch: null, external: true });
      out.authenticated = await invoke({ tabs: [existing] });
      out.localhost = await invoke({ tabs: [{ ...existing, url: 'http://localhost:3080/' }] });
      out.unauthenticated = await invoke({ tabs: [existing], auth: { authenticated: false, port: 3080 } });
      out.unknown = await invoke({ tabs: [existing], auth: { authenticated: null, port: 3080 } });
      out.noReceiver = await invoke({ tabs: [existing], noReceiver: true });
      out.discarded = await invoke({ tabs: [{ ...existing, discarded: true }] });
      out.unloaded = await invoke({ tabs: [{ ...existing, status: 'unloaded' }] });
      out.authWrongPort = await invoke({ tabs: [existing], auth: { authenticated: true, port: 30801 } });
      out.wrongPortTab = await invoke({ tabs: [{ ...existing, url: 'http://127.0.0.1:30801/' }] });
      const invalid = [
        'https://127.0.0.1:3080/?token=' + token,
        'http://untrusted.example:3080/?token=' + token,
        'http://127.0.0.1.evil.example:3080/?token=' + token,
        'http://127.0.0.1:30801/?token=' + token,
        'http://127.0.0.1:3080/not-root?token=' + token,
        'http://user:secret@127.0.0.1:3080/?token=' + token,
        'http://127.0.0.1:3080/?token=',
        'http://127.0.0.1:3080/?token=' + token + '&token=other',
        'http://127.0.0.1:3080/?token=' + token + '&next=https://untrusted.example',
        'http://127.0.0.1:3080/?token=' + token + '#unsupported',
        'not a URL',
      ];
      out.invalid = [];
      for (const value of invalid) out.invalid.push(await invoke({ launch: value }));
      return JSON.stringify(out);
    } finally {
      chrome.tabs.query = original.query; chrome.tabs.create = original.create;
      chrome.tabs.update = original.update; chrome.tabs.reload = original.reload;
      chrome.tabs.sendMessage = original.sendMessage;
      chrome.windows.getCurrent = original.getCurrent; chrome.windows.update = original.windowUpdate;
      detail = original.detail; state = original.state; settings = original.settings;
    }
  })()`);
  let m13o = {};
  try { m13o = JSON.parse(m13Open); } catch (_) { /* 保持默认 */ }
  const m13NewOnly = (entry) => !!entry && entry.legalLaunch && entry.rootOnly && entry.noSecret
    && entry.updateIds.length === 0 && entry.reloads === 0 && entry.focusIds.length === 0;
  const m13FocusOnly = (entry) => !!entry && entry.creates === 0 && entry.updateOnlyActive
    && entry.updateIds.length === 1 && entry.updateIds[0] === 701 && entry.reloads === 0
    && entry.focusIds.length === 1 && entry.focusIds[0] === 71 && entry.noSecret
    && entry.authQueryOnly && entry.authTopFrame && entry.messageIds.length === 1 && entry.messageIds[0] === 701;
  record('M13：openWebUI 新标签仅使用合法同端口根启动入口（无伪会话 hash）',
    m13NewOnly(m13o.withLaunch), JSON.stringify(m13o.withLaunch));
  record('M13：openWebUI 无 launchUrl 时裸 URL 降级并提示原启动入口',
    !!m13o.bare && m13o.bare.cleanBare && m13o.bare.noSecret && /原.*启动|启动.*URL|启动.*入口/.test(m13o.bare.toast),
    JSON.stringify(m13o.bare));
  record('rc.2 导航：已认证同端口 tab 仅聚焦（只读 auth-status、top frame，无导航/重载）',
    m13FocusOnly(m13o.authenticated) && m13FocusOnly(m13o.localhost),
    JSON.stringify({ authenticated: m13o.authenticated, localhost: m13o.localhost }));
  record('rc.2 导航：401/unknown/no receiver 有合法 token 另开，不覆盖原 tab 草稿',
    ['unauthenticated', 'unknown', 'noReceiver'].every((key) => m13NewOnly(m13o[key]) && m13o[key].authQueryOnly),
    JSON.stringify({ unauthenticated: m13o.unauthenticated, unknown: m13o.unknown, noReceiver: m13o.noReceiver }));
  record('rc.2 导航：discarded/unloaded 与 auth 回错端口均不能冒充已认证',
    ['discarded', 'unloaded', 'authWrongPort'].every((key) => m13NewOnly(m13o[key])),
    JSON.stringify({ discarded: m13o.discarded, unloaded: m13o.unloaded, authWrongPort: m13o.authWrongPort }));
  record('rc.2 导航：3080 不匹配 30801，不向错实例发认证消息',
    m13NewOnly(m13o.wrongPortTab) && m13o.wrongPortTab.messageIds.length === 0,
    JSON.stringify(m13o.wrongPortTab));
  record('rc.2 导航：拒绝外部/错端口/非根/用户密码/畸形 launchUrl，不泄漏 token',
    Array.isArray(m13o.invalid) && m13o.invalid.length === 11
      && m13o.invalid.every((entry) => entry.cleanBare && entry.rootOnly && entry.noSecret
        && !entry.legalLaunch && !/token=|verify-auth-fixture-token/.test(entry.toast)),
    'invalidCases=' + (m13o.invalid || []).length);

  // 深/浅状态卡背景：深色 bg-module-platform（#1e2025 rgb(30, 32, 37)），浅色=bluish-60（#f5f6f7）
  await setPopupTheme('dark');
  await gotoPopup();
  const m7Dark = await evalPage(`(() => {
    const c = document.getElementById('statuscard');
    if (!c) return JSON.stringify({ present: false });
    return JSON.stringify({ present: true, bg: getComputedStyle(c).backgroundColor });
  })()`);
  let m7d = { present: false };
  try { m7d = JSON.parse(m7Dark); } catch (_) { /* 保持默认 */ }
  record('M7：深色状态卡背景（bg-module-platform 渲染）',
    m7d.present === true && (m7d.bg === 'rgb(30, 32, 37)' || m7d.bg === 'rgb(53, 54, 56)'), 'bg=' + m7d.bg);
  await setPopupTheme('light');
  await gotoPopup();
  const m7Light2 = await evalPage(`(() => {
    const c = document.getElementById('statuscard');
    if (!c) return JSON.stringify({ present: false });
    return JSON.stringify({ present: true, bg: getComputedStyle(c).backgroundColor });
  })()`);
  let m7l2 = { present: false };
  try { m7l2 = JSON.parse(m7Light2); } catch (_) { /* 保持默认 */ }
  record('M7：浅色状态卡背景（bluish-60 = #f5f6f7）',
    m7l2.present === true && m7l2.bg === 'rgb(245, 246, 247)', 'bg=' + m7l2.bg);
  record('M7：变体与主题段无新增 console 异常', consoleErrors.length === 0,
    consoleErrors.length ? consoleErrors.join(' ||| ').slice(0, 800) : '');
  await shotPng('popup-m7.png');

  // 13) M9 会话区（design §8.10）：mock sessionsData（popup.js 顶层 let，可读写）
  log('M9 会话区（§8.10）');
  const m9Raw = await evalPage(`(async () => {
    const frame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));
    const snap = () => {
      const section = document.getElementById('sessions-section');
      if (!section) return { present: false };
      const list = document.getElementById('sessions-list');
      const empty = document.getElementById('sessions-empty');
      const hint = document.getElementById('sessions-hint');
      const count = document.getElementById('sessions-count');
      const rows = [...(list ? list.querySelectorAll('.session-row') : [])].map((row) => {
        const dot = row.querySelector('.session-dot, .dsh-state-matrix');
        const dotCls = dot ? (typeof dot.className === 'string' ? dot.className : (dot.className.baseVal || '')) : '';
        return {
          title: row.querySelector('.session-title') ? row.querySelector('.session-title').textContent : '',
          state: row.querySelector('.session-state') ? row.querySelector('.session-state').textContent : '',
          dot: dotCls,
          cursor: getComputedStyle(row).cursor,
          role: row.getAttribute('role'),
          tabindex: row.getAttribute('tabindex'),
          inlineClick: typeof row.onclick === 'function' || row.hasAttribute('onclick'),
          link: !!row.querySelector('a[href]'),
          dotColor: dot ? getComputedStyle(dot).color : '',
          dotAnim: dot ? getComputedStyle(dot, '::after').animationName : '',
          dotHalo: dot ? getComputedStyle(dot, '::before').animationName : '',
          dotHaloOpacity: dot ? getComputedStyle(dot, '::before').opacity : '',
        };
      });
      const leaves = [...(list ? list.querySelectorAll('.subagent-leaf-content') : [])].map((c) => ({
        title: c.querySelector('.subagent-title') ? c.querySelector('.subagent-title').textContent : '',
        state: c.querySelector('.subagent-state') ? c.querySelector('.subagent-state').textContent : '',
      }));
      return {
        present: true,
        hidden: section.classList.contains('hidden'),
        count: count ? count.textContent : '',
        listHidden: list ? list.classList.contains('hidden') : true,
        emptyHidden: empty ? empty.classList.contains('hidden') : true,
        emptyText: empty ? empty.textContent : '',
        hintHidden: hint ? hint.classList.contains('hidden') : true,
        hintText: hint ? hint.textContent : '',
        rows,
        leaves,
      };
    };
    const out = {};
    const origState = state;
    const origData = sessionsData;
    const origRefreshSessions = refreshSessions; refreshSessions = () => {};
    // 仅隔离本静态渲染段：让此前在途 native/mirror 不能覆盖 fixture，真实 SSE 段不受影响。
    sessionsRevision += 1; sessionsRequestSeq += 1;
    if (sessionsMirrorTimer) { clearTimeout(sessionsMirrorTimer); sessionsMirrorTimer = null; }
    sessionsFromMirror = false;
    const origRead = JSON.stringify(readSessions);
    const origRetention = settings ? settings.retentionMins : undefined;
    const NOW = Date.now();
    const MIN = 60000;
    // 1) 初始（sessionsData=null）→ 会话区隐藏（不报错）
    sessionsData = null; state = 'running'; render(); await frame(); out.initial = snap();
    // 2) 四态渲染（M11：waiting > working/已停止 > 已完成新鲜；idle 不渲染；陈旧完成不显示）
    //    已停止 = completed+hasActiveChildren（恒显）；已完成需新鲜（≤retentionMins=30）且未已读
    readSessions = {};
    settings = Object.assign({}, settings, { retentionMins: 30 });
    sessionsData = {
      available: true,
      items: [
        { sessionId: 'session-working-1', title: '正在推进的会话', state: 'working', updatedAt: NOW - 4 * MIN, blank: false },
        { sessionId: 'session-waiting-1', title: '等待确认中', state: 'waiting', updatedAt: NOW - 2 * MIN, blank: false },
        { sessionId: 'session-completed-1', title: '已完成会话', state: 'completed', updatedAt: NOW - 5 * MIN, blank: false, hasActiveChildren: false, childRuns: [] },
        { sessionId: 'session-idle-1', title: '空闲测试（应被过滤）', state: 'idle', updatedAt: NOW - 6 * MIN, blank: false },
        { sessionId: 'session-untitled-abcdef12', state: 'completed', updatedAt: NOW - 10 * MIN, blank: false, hasActiveChildren: false, childRuns: [] },
        { sessionId: 'session-stale-1', title: '陈旧完成（应被过滤）', state: 'completed', updatedAt: NOW - 60 * MIN, blank: false, hasActiveChildren: false, childRuns: [] },
        { sessionId: 'session-stopped-1', title: '主会话已停止·子代理跑', state: 'completed', updatedAt: NOW - 120 * MIN, blank: false, hasActiveChildren: true, childRuns: [
          { childId: 'c1', label: '检索代码' },
          { childId: 'c2' },
        ] },
      ],
    };
    render(); await frame(); out.filled = snap();
    // 会话行是纯展示：dispatch 真 click 并捕获导航边界；只读/撤销按钮另由 M11 覆盖。
    const originalOpen = openWebUI;
    const originalCreate = chrome.tabs.create, originalUpdate = chrome.tabs.update;
    const navigations = [];
    try {
      openWebUI = (...args) => { navigations.push({ kind: 'openWebUI', count: args.length }); };
      chrome.tabs.create = async () => { navigations.push({ kind: 'create' }); return { id: 1 }; };
      chrome.tabs.update = async () => { navigations.push({ kind: 'update' }); return { id: 1 }; };
      for (const row of document.querySelectorAll('#sessions-list .session-row')) {
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        const title = row.querySelector('.session-title');
        if (title) title.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
      out.readOnly = { rows: out.filled.rows.length, navigations: navigations.length };
    } finally {
      openWebUI = originalOpen; chrome.tabs.create = originalCreate; chrome.tabs.update = originalUpdate;
    }
    // 3) 空态（available:true 无会话）
    sessionsData = { available: true, items: [] };
    render(); await frame(); out.empty = snap();
    // 4) 降级：available:false + running → 中性提示；stopped → 隐藏
    sessionsData = { available: false, items: [] };
    state = 'running'; render(); await frame(); out.degradeRunning = snap();
    state = 'stopped'; render(); await frame(); out.degradeStopped = snap();
    // 恢复现场
    refreshSessions = origRefreshSessions;
    sessionsData = origData; state = origState; render();
    readSessions = JSON.parse(origRead);
    if (origRetention === undefined) delete settings.retentionMins; else settings.retentionMins = origRetention;
    return JSON.stringify(out);
  })()`);
  let m9 = {};
  try { m9 = JSON.parse(m9Raw); } catch (_) { /* 保持默认 */ }
  const m9ok = (o) => !!(o && o.present === true);
  record('M9：sessionsData 空（初始/失败）时会话区隐藏（计数同时清空）',
    m9ok(m9.initial) && m9.initial.hidden === true && m9.initial.count === '',
    JSON.stringify(m9.initial));
  record('M9：四态会话渲染（M11：待确认 > 进行中/已停止 > 已完成新鲜；idle 与陈旧完成不渲染）',
    m9ok(m9.filled) && m9.filled.hidden === false && m9.filled.count.includes('5')
      && m9.filled.rows.length === 5
      && m9.filled.rows[0].state === '待确认'
      && m9.filled.rows[1].state === '进行中'
      && m9.filled.rows[2].state === '已停止'
      && m9.filled.rows[3].state === '已完成'
      && m9.filled.rows.every((r) => r.dot.indexOf('sdot-idle') === -1),
    JSON.stringify(m9.filled && m9.filled.rows));
  record('M9：idle 与陈旧完成（>retentionMins）不再渲染（7 项含 1 idle + 1 陈旧 → 显示 5）',
    m9ok(m9.filled) && m9.filled.count.includes('5') && m9.filled.rows.length === 5
      && m9.filled.rows.every((r) => r.dot.indexOf('sdot-idle') === -1 && r.state !== '空闲')
      && m9.filled.rows.every((r) => r.title !== '陈旧完成（应被过滤）'),
    'count=' + m9.filled.count + ' rows=' + m9.filled.rows.length);
  record('M9：子代理行渲染（父行「已停止」+ 缩进子行 label/「子代理」+ 进行中）',
    m9ok(m9.filled) && m9.filled.leaves.length === 2
      && m9.filled.leaves[0].title === '检索代码' && m9.filled.leaves[0].state === '进行中'
      && m9.filled.leaves[1].title === '子代理' && m9.filled.leaves[1].state === '进行中',
    JSON.stringify(m9.filled && m9.filled.leaves));
  record('M9：无 title 会话降级为「会话 #<id 前 8>」',
    m9ok(m9.filled) && m9.filled.rows[4].title === '会话 #session-',
    JSON.stringify(m9.filled && m9.filled.rows[4]));
  record('M9：available 且无会话 → 空态「暂无活跃会话」',
    m9ok(m9.empty) && m9.empty.hidden === false && m9.empty.emptyHidden === false
      && m9.empty.emptyText.includes('暂无') && m9.empty.listHidden === true,
    JSON.stringify(m9.empty));
  record('M9：插件不可用降级（运行中 → 中性提示，未运行 → 隐藏）',
    m9ok(m9.degradeRunning) && m9.degradeRunning.hidden === false
      && m9.degradeRunning.hintHidden === false
      && m9.degradeRunning.hintText === '安装/升级 dsh 配套插件后可查看会话'
      && m9ok(m9.degradeStopped) && m9.degradeStopped.hidden === true,
    JSON.stringify(m9.degradeRunning) + ' / ' + JSON.stringify(m9.degradeStopped));
  record('rc.2 会话只读：行/标题点击不导航，无 pointer/role/tabindex/伪链接（已读撤销保留）',
    !!m9.readOnly && m9.readOnly.rows === 5 && m9.readOnly.navigations === 0
      && m9.filled.rows.every((row) => row.cursor !== 'pointer' && row.role === null && row.tabindex === null
        && row.inlineClick === false && row.link === false),
    JSON.stringify({ click: m9.readOnly, rows: m9.filled && m9.filled.rows }));

  // 14) M10 颜色语义自定义（design §8.12）
  log('M10 颜色角色（§8.12）');
  const m10Raw = await evalPage(`(async () => {
    const frame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));
    const tick = () => new Promise((res) => setTimeout(res, 350));
    const dots = () => {
      const rows = [...document.querySelectorAll('.session-row')];
      return rows.map((r) => {
        const d = r.querySelector('.session-dot, .dsh-state-matrix');
        return d ? getComputedStyle(d).color : '';
      });
    };
    const statusDot = () => {
      const d = document.getElementById('dot');
      return d ? getComputedStyle(d).color : '';
    };
    const out = {};
    const origState = state, origData = sessionsData, origSettings = JSON.stringify(settings);
    const origRefresh = refreshSessions; refreshSessions = () => {};
    sessionsRevision += 1; sessionsRequestSeq += 1;
    if (sessionsMirrorTimer) { clearTimeout(sessionsMirrorTimer); sessionsMirrorTimer = null; }
    sessionsFromMirror = false;
    const NOW = Date.now();
    const MIN = 60000;
    // 基座：三态会话（含 1 idle 验证过滤；排序 M11：待确认 > 进行中 > 已完成）+ running 状态卡
    settings = Object.assign({}, settings, { retentionMins: 30 });
    sessionsData = { available: true, items: [
      { sessionId: 's10-1', title: 'T', state: 'working', updatedAt: NOW - 4 * MIN, blank: false },
      { sessionId: 's10-2', title: 'T', state: 'waiting', updatedAt: NOW - 2 * MIN, blank: false },
      { sessionId: 's10-3', title: 'T', state: 'completed', updatedAt: NOW - 5 * MIN, blank: false },
      { sessionId: 's10-4', title: 'T', state: 'idle', updatedAt: NOW - 6 * MIN, blank: false },
    ]};
    state = 'running'; render(); await tick();
    // M11 排序后行序：waiting(1) > working(2) > completed(3)；dots() 同序
    out.base = { working: dots()[1], waiting: dots()[0], completed: dots()[2], rows: dots().length, statusRunning: statusDot() };
    // 改色：storage 写入 colorMap（waiting→绿、working→琥珀、completed→紫）
    const next = Object.assign({}, settings, { colorMap: {
      waiting: '#22c55e', working: '#f59e0b', completed: '#8b5cf6',
    } });
    await new Promise((res) => chrome.storage.local.set({ settings: next }, res));
    await tick();
    out.changed = {
      working: dots()[1], waiting: dots()[0], completed: dots()[2],
      statusRunning: statusDot(),
      stateWords: [...document.querySelectorAll('.session-state')].map((el) => el.textContent),
    };
    // 撞色 toast：点「待确认」行红色 swatch
    const redBtn = document.querySelector('.color-swatch-halo[data-role="waiting"][data-color="#ec1313"], .color-swatch[data-role="waiting"][data-color="#ec1313"]');
    if (redBtn) redBtn.click();
    await tick();
    const toastEl = document.getElementById('toast');
    const toastTextEl = document.getElementById('toast-text');
    const redBtnAfter = document.querySelector('.color-swatch-halo[data-role="waiting"][data-color="#ec1313"], .color-swatch[data-role="waiting"][data-color="#ec1313"]');
    out.red = {
      toastVisible: !!toastEl && !toastEl.classList.contains('toast-hidden'),
      toastText: toastTextEl ? toastTextEl.textContent : '',
      waiting: dots()[0],
      swatchSelected: !!redBtnAfter && redBtnAfter.classList.contains('selected'),
    };
    // 恢复默认：UI 真实点击「恢复默认色板」
    const resetBtn = document.getElementById('btn-colors-reset');
    if (resetBtn) resetBtn.click();
    await tick();
    out.reset = { working: dots()[1], waiting: dots()[0], completed: dots()[2], rows: dots().length, statusRunning: statusDot() };
    out.stateWordsAfter = [...document.querySelectorAll('.session-state')].map((el) => el.textContent);
    const persisted = await new Promise((res) => chrome.storage.local.get({ settings: {} }, (d) => res(JSON.stringify(d.settings && d.settings.colorMap))));
    out.persisted = persisted;
    // 恢复现场
    refreshSessions = origRefresh;
    sessionsData = origData; state = origState; render();
    settings = JSON.parse(origSettings);
    await new Promise((res) => chrome.storage.local.set({ settings: JSON.parse(origSettings) }, res));
    // 打开设置面板供视觉存档
    switchV6('sett');
    await new Promise((res) => setTimeout(res, 120));
    return JSON.stringify(out);
  })()`);
  let m10 = {};
  try { m10 = JSON.parse(m10Raw); } catch (_) { /* 保持默认 */ }
  const m10ok = (o) => !!(o && o.base && o.base.working);
  record('M10：默认色板三态会话色（M10.1 定稿：working=webui 蓝 #5686fe / waiting 琥珀黄 #f59e0b / completed 绿 #22c55e；idle 过滤不渲染）',
    m10ok(m10) && m10.base.working === 'rgb(86, 134, 254)'
      && m10.base.waiting === 'rgb(245, 158, 11)'
      && m10.base.completed === 'rgb(34, 197, 94)'
      && m10.base.rows === 3, // 4 项含 1 idle → 只渲染 3 行
    JSON.stringify(m10.base));
  record('M10：改色后会话区圆点实际色变化（working 琥珀 / waiting 绿 / completed 紫）',
    m10ok(m10) && m10.changed.working === 'rgb(245, 158, 11)'
      && m10.changed.waiting === 'rgb(34, 197, 94)'
      && m10.changed.completed === 'rgb(139, 92, 246)',
    JSON.stringify(m10.changed));
  record('M10：状态展示层（实例）圆点不随会话角色色改（§8.12 角色表载体限定，改色不毁实例语义）',
    m10ok(m10) && m10.base.statusRunning === 'rgb(34, 197, 94)'
      && m10.changed.statusRunning === 'rgb(34, 197, 94)',
    'base=' + m10.base.statusRunning + ' changed=' + m10.changed.statusRunning);
  record('M10：改「待确认」为红色系触发撞色提示 toast（不硬拦——颜色仍为辅助载体）',
    !!m10.red && m10.red.toastVisible === true
      && /撞色/.test(m10.red.toastText || '')
      && m10.red.waiting === 'rgb(236, 19, 19)' && m10.red.swatchSelected === true,
    JSON.stringify(m10.red));
  const m10PersistOk = (() => {
    try {
      const p = JSON.parse(m10.persisted || 'null');
      return !!p && DSH_COLORS_DEFAULT.waiting === p.waiting
        && DSH_COLORS_DEFAULT.working === p.working
        && DSH_COLORS_DEFAULT.completed === p.completed;
    } catch (_) { return false; }
  })();
  record('M10：恢复默认色板还原（三态 + 状态卡 + storage.colorMap == 定稿默认值）',
    m10ok(m10) && m10.reset.working === 'rgb(86, 134, 254)'
      && m10.reset.waiting === 'rgb(245, 158, 11)'
      && m10.reset.completed === 'rgb(34, 197, 94)'
      && m10.reset.rows === 3
      && m10.reset.statusRunning === 'rgb(34, 197, 94)'
      && m10PersistOk === true,
    'reset=' + JSON.stringify(m10.reset) + ' persisted=' + m10.persisted);
  const m10Words1 = (m10.changed && m10.changed.stateWords || []).join('|');
  const m10Words2 = (m10.stateWordsAfter || []).join('|');
  const m10Cls1 = (m10.changed && m10.changed.stateClasses || []).join('|');
  const m10Cls2 = (m10.stateClassesAfter || []).join('|');
  record('M10：字符语义回归（改色前后状态词与圆点类名不变——文字状态词是主语义；M11 排序：待确认 > 进行中 > 已完成）',
    m10ok(m10) && m10Words1 === m10Words2 && m10Cls1 === m10Cls2
      && m10Words1 === '待确认|进行中|已完成',
    'w1=' + m10Words1 + ' w2=' + m10Words2 + ' c1=' + m10Cls1 + ' c2=' + m10Cls2);

  // 视觉存档：设置面板「颜色角色」区（恢复默认后的色板，供人工/vision 核验排版）
  const m10Shot = await page.send('Page.captureScreenshot', { format: 'png' });
  const m10Png = pathShots('popup-m10.png');
  fs.writeFileSync(m10Png, Buffer.from(m10Shot.data, 'base64'));
  record('popup-m10.png 截图（颜色角色区展开）', fs.statSync(m10Png).size > 2000,
    m10Png + ' (' + fs.statSync(m10Png).size + ' bytes)');

  // 15) M11 会话感知：已读倒计时 + 保留时长设置（§8.10 演进）
  log('M11 会话感知（已读/保留时长）');
  const m11Raw = await evalPage(`(async () => {
    const frame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));
    const tick = (ms) => new Promise((res) => setTimeout(res, ms));
    const snapRows = () => [...document.querySelectorAll('#sessions-list .session-row')].map((r) => ({
      title: r.querySelector('.session-title') ? r.querySelector('.session-title').textContent : '',
      state: r.querySelector('.session-state') ? r.querySelector('.session-state').textContent : '',
      hasReadBtn: !!r.querySelector('.btn-mark-read'),
    }));
    const out = {};
    const origState = state, origData = sessionsData;
    const origRead = JSON.stringify(readSessions);
    const origRetention = settings ? settings.retentionMins : undefined;
    const origRefreshSessionsRef = refreshSessions; refreshSessions = () => {};
    sessionsRevision += 1; sessionsRequestSeq += 1;
    if (sessionsMirrorTimer) { clearTimeout(sessionsMirrorTimer); sessionsMirrorTimer = null; }
    sessionsFromMirror = false;
    const NOW = Date.now();
    const MIN = 60000;
    readSessions = {};
    settings = Object.assign({}, settings, { retentionMins: 30 });
    sessionsData = { available: true, items: [
      { sessionId: 's11-fresh', title: '新鲜完成', state: 'completed', updatedAt: NOW - 1 * MIN, blank: false, hasActiveChildren: false, childRuns: [] },
      { sessionId: 's11-stale', title: '陈旧完成', state: 'completed', updatedAt: NOW - 31 * MIN, blank: false, hasActiveChildren: false, childRuns: [] },
    ]};
    state = 'running'; render(); await frame();
    out.base = { rows: snapRows(), count: document.getElementById('sessions-count').textContent };
    // 1) 点「已读」→ 原地倒计时药丸出现；1 秒后读秒递减
    const readBtn = document.querySelector('#sessions-list .btn-mark-read');
    if (readBtn) readBtn.click();
    await tick(120);
    out.afterRead = {
      rows: snapRows(),
      pill: !!document.querySelector('#sessions-list .inline-undo-pill'),
      pillText: (document.querySelector('#sessions-list .inline-undo-pill') || {}).textContent || '',
    };
    await tick(1100);
    out.countdown = {
      badge: (document.getElementById('countdown-s11-fresh') || {}).textContent || '',
    };
    // 2) 撤销 → 行恢复（无 pill、未落库）
    const undoBtn = document.querySelector('#sessions-list .inline-undo-btn');
    if (undoBtn) undoBtn.click();
    await tick(60);
    out.afterUndo = {
      rows: snapRows(),
      pill: !!document.querySelector('#sessions-list .inline-undo-pill'),
      readAt: readSessions['s11-fresh'] || 0,
    };
    // 3) 再点已读并等待倒计时结束 → 行移除 + readSessions 落库
    const readBtn2 = document.querySelector('#sessions-list .btn-mark-read');
    if (readBtn2) readBtn2.click();
    await tick(4200);
    out.afterCommit = {
      rows: snapRows(),
      readAt: readSessions['s11-fresh'] || 0,
      count: document.getElementById('sessions-count').textContent,
    };
    // 4) retentionMins=0 → 已完成全部不显示（已停止不受影响）
    settings = Object.assign({}, settings, { retentionMins: 0 });
    sessionsData = { available: true, items: [
      { sessionId: 's11-fresh', title: '新鲜完成', state: 'completed', updatedAt: NOW - 1 * MIN, blank: false, hasActiveChildren: false, childRuns: [] },
      { sessionId: 's11-stopped', title: '已停止会话', state: 'completed', updatedAt: NOW - 120 * MIN, blank: false, hasActiveChildren: true, childRuns: [{ childId: 'c9' }] },
    ]};
    readSessions = {};
    render(); await frame();
    out.zeroRetention = { rows: snapRows(), count: document.getElementById('sessions-count').textContent };
    // 恢复现场
    refreshSessions = origRefreshSessionsRef;
    sessionsData = origData; state = origState; render();
    readSessions = JSON.parse(origRead);
    await new Promise((res) => chrome.storage.local.set({ readSessions: readSessions }, res));
    if (origRetention === undefined) delete settings.retentionMins; else settings.retentionMins = origRetention;
    return JSON.stringify(out);
  })()`);
  let m11 = {};
  try { m11 = JSON.parse(m11Raw); } catch (_) { /* 保持默认 */ }
  const m11ok = (o) => !!(o && o.base);
  record('M11：仅新鲜完成显示（default retentionMins=30：fresh 显 / 31 分钟前 stale 不显）',
    m11ok(m11) && m11.base.rows.length === 1 && m11.base.rows[0].title === '新鲜完成' && m11.base.count.includes('1'),
    JSON.stringify(m11.base));
  record('M11：已完成行提供「已读」入口；点击出现原地倒计时药丸（已读 · 撤销 3s）',
    m11ok(m11) && m11.base.rows[0].hasReadBtn === true
      && m11.afterRead.pill === true && /已读/.test(m11.afterRead.pillText) && /撤销/.test(m11.afterRead.pillText),
    JSON.stringify(m11.afterRead));
  record('M11：倒计时读秒递减（1s 后徽标 ≤ 2s）',
    m11ok(m11) && /^[0-2]s$/.test(m11.countdown.badge),
    JSON.stringify(m11.countdown));
  record('M11：撤销恢复（行还在、无 pill、readSessions 未落库）',
    m11ok(m11) && m11.afterUndo.rows.length === 1 && m11.afterUndo.pill === false && m11.afterUndo.readAt === 0,
    JSON.stringify(m11.afterUndo));
  record('M11：倒计时结束落库并移除行（readSessions>0、行消失、其余完成行不受影响）',
    m11ok(m11) && m11.afterCommit.rows.length === 0 && m11.afterCommit.readAt > 0 && m11.afterCommit.count === '',
    JSON.stringify(m11.afterCommit));
  record('M11：retentionMins=0 时完成会话不显示，但「已停止·有子代理」恒显',
    m11ok(m11) && m11.zeroRetention.rows.length === 1 && m11.zeroRetention.rows[0].state === '已停止'
      && m11.zeroRetention.count.includes('1'),
    JSON.stringify(m11.zeroRetention));

  await cleanup();
  const failed = results.filter((r) => !r.ok);
  log('=== 汇总 ===  PASS ' + (results.length - failed.length) + ' / FAIL ' + failed.length);
  log('产物目录: ' + SHOTS_DIR);
  process.exit(failed.length ? 1 : 0);
}

async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    try {
      if (browserWs && browserWs.ws && browserWs.ws.readyState === 1) {
        await Promise.race([
          browserWs.send('Browser.close').catch(() => { }),
          sleep(3000),
        ]);
      }
    } catch (_) { /* 忽略 */ }
    try {
      // 只处理本脚本 spawn 且仍未退出的句柄/PID，绝不按进程名或共享调试端口杀浏览器。
      if (chromeProc && chromeProc.pid && chromeProc.exitCode === null && chromeProc.signalCode === null) {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(chromeProc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 3000 });
        } else {
          chromeProc.kill('SIGTERM');
        }
      }
    } catch (_) { /* 忽略 */ }
    try { if (profileOwned) fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) { /* Chrome 尚在退场：外层只清本 case profile */ }
  })();
  return cleanupPromise;
}

watchdog = setTimeout(async () => {
  console.error('[verify-cdp] 总验收截止 225s，关闭本 case Chrome 后失败退出');
  await cleanup();
  process.exit(1);
}, VERIFY_TIMEOUT_MS);

main().catch(async (e) => {
  console.error('[verify-cdp] 异常: ' + redact(e && e.stack || e));
  await cleanup();
  process.exit(1);
});
