'use strict';
// ============================================================================
// fake-dsh.js — 伪 dsh bin.js（冒烟测试用，native-host/test/）
//
// 由 host.js 通过 DSH_BIN_STUB 以 `node fake-dsh.js --profile <p> --host <h>
// --port <n>` 方式拉起，模拟真实 dsh web 的最小可观测行为：
//   1. 解析 --port（默认 31900）与 --exit-immediately；
//   2. 启动时 stdout 打印一行 `dsh web: http://127.0.0.1:<port>`；
//      --port 0（M4 动态端口）与真实 dsh 一致：绑定后再打印实际端口；
//   3. HTTP 服务：
//        GET  /                    -> 200 HTML，含 <title>DeepSeek Harness</title>
//                                    （供外部实例发现的指纹探测匹配，host.js §6.6）
//        GET  /_lifecycle/health   -> 200 JSON {ok,pid,uptimeMs,port,nodeVersion}
//                                    （M2：宿主 getHealth 判定插件可用/填充富状态）
//        POST /_lifecycle/shutdown -> stdout 打印 SHUTDOWN-RECEIVED，
//                                     回 202，100ms 后 process.exit(0)
//   4. `--version` 时打印版本号并退出（宿主版本检查用，不启动服务）。
//
// 环境变量变体：
//   DSH_FAKE_EXIT_IMMEDIATELY=1 或命令行 --exit-immediately：
//     打印 URL 行后不启动 HTTP 服务，200ms 后 process.exit(0)
//     （端口从不就绪 -> 宿主轮询 30s 超时 -> START_TIMEOUT，日志尾部有内容）。
//   DSH_FAKE_NO_LIFECYCLE=1（模拟「无 dsh-lifecycle 插件」场景）：
//     health 与 shutdown 两个 lifecycle 路由都不注册——GET /_lifecycle/health 回
//     404（宿主 getHealth 判定插件不可达 -> stop 走 taskkill 'force'），
//     POST /_lifecycle/shutdown 落入 SPA 200 但不退出（宿主不得以状态码判定插件）。
//   DSH_FAKE_AUTH=1（M13，模拟 dsh ≥ 0.1.2 浏览器启动令牌认证，§2.1.1 B1）：
//     启动 URL 行携带 `?token=<fake-launch-token>`；GET /（含 query）一律回 401
//     （无 token/cookie）；GET /manifest.webmanifest 回 200 manifest JSON（公开
//     静态资产，含 "name": "DeepSeek Harness" 指纹）；lifecycle/manager 路由不受
//     影响（插件端点不过认证闸门）。用于验证宿主两处探测与 launchUrl 捕获。
//   DSH_FAKE_LOG_HEADERS=1（M13 回归）：每次请求把方法/URL/Accept-Encoding 头
//     打到 stdout（`FAKE-REQ GET / ae=ABSENT`），供 smoke 断言探测请求不携带
//     Accept-Encoding（§2.1.1 B2 约束）。
// ============================================================================

const http = require('http');
let listeningServer;

// Match the current launcher's profile/patch boundary for compatibility smoke.
if (process.env.DSH_FAKE_STRICT_CLI === '1' && !process.argv.includes('--version')) {
  const argv = process.argv.slice(2);
  if (argv.filter(a => a === '--profile').length !== 1 || argv.includes('web') && argv[0] === 'web'
    || argv.some((a, i) => a === '--patch' && i > argv.indexOf('--host'))) {
    console.error('Invalid launcher arguments: profile must be selected once and patches precede app flags');
    process.exit(1);
  }
  if (process.env.DSH_FAKE_ARGS_FILE) {
    require('fs').writeFileSync(process.env.DSH_FAKE_ARGS_FILE, JSON.stringify(argv));
  }
}

function arg(name, def) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  return def;
}

const port = parseInt(arg('--port', '31900'), 10);
const exitImmediately =
  process.argv.includes('--exit-immediately') ||
  process.env.DSH_FAKE_EXIT_IMMEDIATELY === '1';
// M2：模拟「无 dsh-lifecycle 插件」场景——lifecycle 路由一律不注册
const noLifecycle = process.env.DSH_FAKE_NO_LIFECYCLE === '1';
// M4：模拟「dsh 不打印 URL 行」场景（动态端口发现失败的活进程，供占位期 status 测试）
const noUrl = process.env.DSH_FAKE_NO_URL === '1';
// M9：模拟「未安装/未升级 dsh-manager 配套插件」场景——/_manager/sessions 不注册
//（落入 SPA 200 HTML -> 宿主 JSON 解析失败 -> sessions 不可用降级）。
// 默认注册：响应体 items 取自 DSH_FAKE_SESSIONS（JSON 数组），缺省为空数组。
const noManager = process.env.DSH_FAKE_NO_MANAGER === '1';
let managerItems = [];
if (!noManager && process.env.DSH_FAKE_SESSIONS !== undefined) {
  try {
    const parsed = JSON.parse(process.env.DSH_FAKE_SESSIONS);
    if (Array.isArray(parsed)) managerItems = parsed;
  } catch (err) {
    /* 非法 JSON 维持空数组 */
  }
}
// M13：模拟 dsh ≥ 0.1.2 启动令牌认证（§2.1.1 B1）——URL 行带 token、GET / 401、
// /manifest.webmanifest 公开 200 含指纹。lifecycle/manager 路由不受影响。
const fakeAuth = process.env.DSH_FAKE_AUTH === '1';
const launchToken = fakeAuth ? 'fake-launch-token-' + process.pid : null;
// M13 回归：把请求头打到 stdout（无 Accept-Encoding 断言用，§2.1.1 B2）
const logHeaders = process.env.DSH_FAKE_LOG_HEADERS === '1';

function webUrlLine(actualPort) {
  const base = 'http://127.0.0.1:' + actualPort;
  return 'dsh web: ' + (launchToken === null ? base : base + '/?token=' + launchToken);
}

// Exercise the actual plugin publisher while making HTTP readiness unusable.
async function publishReady(actualPort) {
  if (process.env.DSH_FAKE_READY !== '1') return;
  const { publishReadiness } = await import('../../plugin/dsh-lifecycle/readiness.js');
  const dispose = publishReadiness({ webServer: { port: actualPort }, get: () => undefined });
  process.once('exit', dispose);
}

// 宿主版本检查：node fake-dsh.js --version
if (process.argv.includes('--version')) {
  process.stdout.write('0.0.0-fake\n');
  process.exit(0);
}

// --port 0（M4 动态端口）：与真实 dsh 一致——绑定后再打印实际端口；
// 固定端口保持原有「先打印 URL 行再监听」行为。
// 退出立即变体（--exit-immediately）：不监听，打印 port 0 的 URL 行后退出
// （宿主日志解析会跳过 port 0 -> 发现失败 -> START_TIMEOUT）。
if (port === 0 && !exitImmediately) {
  const server = http.createServer((req, res) => {
    respond(server.address().port, req, res);
  });
  listeningServer = server;
  server.listen(0, '127.0.0.1', () => {
    const actual = server.address().port;
    void publishReady(actual);
    if (!noUrl) {
      console.log(webUrlLine(actual));
      console.log('fake-dsh listening on 127.0.0.1:' + actual);
    }
    // noUrl：进程保持存活但不打印 URL（宿主动态端口发现将失败 → 占位期 starting）
  });
  return;
}

console.log(webUrlLine(port));

if (exitImmediately) {
  console.log('FAKE-EXIT-IMMEDIATELY: 不启动 HTTP 服务，200ms 后退出');
  setTimeout(() => process.exit(0), 200);
  return; // 仅保持进程存活 200ms
}

const server = http.createServer((req, res) => {
  respond(port, req, res);
});
listeningServer = server;

server.listen(port, '127.0.0.1', () => {
  void publishReady(port);
  console.log('fake-dsh listening on 127.0.0.1:' + port);
});

// 统一路由（M2：health/shutdown 供宿主优雅路径探测；SPA 200 兜底）
function respond(actualPort, req, res) {
  if (logHeaders) {
    console.log(`FAKE-REQ ${req.method} ${req.url} ae=${req.headers['accept-encoding'] ?? 'ABSENT'}`);
  }
  if (process.env.DSH_FAKE_READY === '1' && req.url === '/') {
    res.writeHead(503);
    res.end('HTTP readiness deliberately unavailable');
    return;
  }
  if (!noLifecycle && req.method === 'GET' && req.url === '/_lifecycle/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      pid: process.pid,
      uptimeMs: Math.floor(process.uptime() * 1000),
      port: actualPort,
      nodeVersion: process.version,
    }));
    return;
  }
  if (!noLifecycle && req.method === 'POST' && req.url === '/_lifecycle/shutdown') {
    console.log('SHUTDOWN-RECEIVED');
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    const exitDelay = Number(process.env.DSH_FAKE_EXIT_DELAY_MS) || 100;
    if (exitDelay > 100) listeningServer.close();
    setTimeout(() => process.exit(0), exitDelay);
    return;
  }
  if (!noManager && req.method === 'GET' && req.url === '/_manager/sessions') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, items: managerItems }));
    return;
  }
  // M13（§2.1.1 B1）：模拟 dsh ≥ 0.1.2 启动令牌认证——GET /（含 query）无凭据
  // 一律 401；/manifest.webmanifest 为公开静态资产 200（含指纹）。
  if (fakeAuth && req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
    return;
  }
  if (fakeAuth && req.method === 'GET' && req.url === '/manifest.webmanifest') {
    res.writeHead(200, { 'content-type': 'application/manifest+json' });
    res.end(JSON.stringify({
      id: '/',
      name: 'DeepSeek Harness',
      short_name: 'DSH',
      start_url: '/',
      scope: '/',
      display: 'fullscreen',
      icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
    }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><head><title>DeepSeek Harness</title></head><body>fake-dsh web ok</body></html>\n');
}
