'use strict';
// ============================================================================
// Whalekeeper —— Native Messaging 宿主（Windows）
// 通过浏览器扩展（Chrome/Edge）管理 DeepSeek Harness（dsh）web 服务的生命周期：
//   ping / status / start / stop / restart / adopt / logs
// 单文件、纯 Node CJS、零第三方依赖、Node >= 18。
// M3：logs 动作读取日志文件尾部/分页（design §6.3 logs）。
// M2：status 附 lifecycle/health；stop 用同身份 lease 或有界 health 重试确认插件，
//   POST shutdown 后共等 PID+端口 10s，超时复核后 force（stopMethod 据真实路径）。
// ============================================================================
// 协议摘要（与 docs/design.md §6.2 一致）
// ----------------------------------------------------------------------------
// 帧格式（stdio 模式，与 Chrome Native Messaging 规范一致）：
//   4 字节小端序无符号整数 = 后续 JSON 载荷的 UTF-8 字节数，随后紧跟载荷本体。
//   宿主 -> 浏览器：单条消息上限 1MB（本项目响应远小于此）。
// 请求：  { "id": "...", "action": "ping|status|start|stop|restart|adopt|logs", "payload": {...} }
// 响应：  { "id": "...", "ok": true,  "result": {...}, "error": null }
//         { "id": "...", "ok": false, "result": null, "error": { "code", "message", "logTail?" } }
// 错误码：DSH_NOT_FOUND / PORT_BUSY / ALREADY_RUNNING / ALREADY_STOPPED /
//         START_TIMEOUT / STOP_FAILED / EXTERNAL_UNMANAGED / BUSY /
//         BAD_REQUEST / INTERNAL
//         （START_TIMEOUT / STOP_FAILED / INTERNAL 的 error 必须带 logTail，
//           即日志文件最近 20 行；其余错误码不带。）
// ----------------------------------------------------------------------------
// 两种传输模式
// ----------------------------------------------------------------------------
// 1) 默认 stdio 模式（生产）：
//    - 从 stdin 读帧（4 字节 LE 长度前缀 + JSON），处理后把响应以同帧格式写 stdout；
//    - 日志一律写 stderr（带时间戳），stdout 绝不出现非协议内容；
//    - 循环处理多条请求；stdin end/close 后退出；
//    - 15 秒无消息看门狗退出（timer.unref）；
//    - 入站帧长度超 1MB 直接断开（不写响应）。
// 2) 文件模式（测试用，因沙箱管道受限）：
//    node host.js --req <in.json> --res <out.json>
//    - 读取 in.json（一条请求对象或请求对象数组），逐一处理，
//      把响应（对象或与输入对应的数组）写 out.json 后退出。
// 两种模式共用同一套 handleRequest 逻辑。
// ----------------------------------------------------------------------------
// 环境变量（全部可选）：
//   以下测试/调试钩子仅在 DSH_MANAGER_TEST_MODE === '1' 时生效（见 testMode()），
//   生产路径（宿主被浏览器拉起，无该 env）完全忽略，杜绝测试钩子旁路。
//   DSH_MANAGER_BASE_DIR    状态根目录（默认 %LOCALAPPDATA%\dsh-manager；
//                            其下 run\ 放记录与锁、logs\ 放 dsh 日志）
//   DSH_BIN_STUB            伪造的 dsh bin.js 路径（测试用，直接替代真实 bin.js）
//   DSH_MANAGER_NPM_PREFIX  npm 全局 prefix（跳过自动探测）
//   DSH_MANAGER_PID_CHECK=0 关闭 PID 命令行校验
//   DSH_MANAGER_PORT / DSH_MANAGER_HOST  start payload 缺省值覆盖（调试）
//   DSH_MANAGER_FAKE_PROCESSES  JSON [{pid,cmdline}]，替代进程枚举（外部发现测试）
//   DSH_MANAGER_FAKE_LISTENERS   JSON [{pid,addr,port}]，替代 netstat 端口表（测试）
// ============================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const http = require('http');
const { randomBytes } = require('crypto');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const HOST_VERSION = '0.1.0';
const DEFAULT_PORT = 3080;
const DEFAULT_HOST = '127.0.0.1';
const MAX_MSG_BYTES = 1024 * 1024; // 入站帧长度上限 1MB
const WATCHDOG_MS = 15000; // 15 秒无消息看门狗
const START_TIMEOUT_MS = 150000; // All launch modes share one spawn-relative readiness deadline.
const LAUNCH_URL_TIMEOUT_MS = 5000; // Only URL capture may extend that deadline.
const LOG_TAIL_LINES = 20; // 错误响应附带的日志尾部行数
const ACTIONS = ['ping', 'status', 'start', 'stop', 'restart', 'adopt', 'logs', 'sessions'];

// M3 日志查看（design §6.3 logs）：tailLines/maxBytes/beforeByte 参数边界
const LOGS_DEFAULT_TAIL_LINES = 500;
const LOGS_MAX_TAIL_LINES = 2000;
const LOGS_DEFAULT_MAX_BYTES = 256 * 1024; // 256KB
const LOGS_MIN_MAX_BYTES = 1024; // 1KB
const LOGS_MAX_MAX_BYTES = 1024 * 1024; // 1MB

// 需要强制附带 logTail 的错误码
const NEEDS_LOG_TAIL = new Set(['START_TIMEOUT', 'STOP_FAILED', 'INTERNAL']);

// ---------------------------------------------------------------------------
// 路径（状态根目录，见 design §6.8 平台抽象层）
// ---------------------------------------------------------------------------
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

function defaultBaseDir() {
  // Windows：%LOCALAPPDATA%\dsh-manager；LOCALAPPDATA 缺失时退回用户主目录
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'dsh-manager');
  }
  // macOS：~/Library/Application Support/dsh-manager
  if (IS_MAC) {
    return path.join(os.homedir(), 'Library', 'Application Support', 'dsh-manager');
  }
  // Linux：$XDG_CONFIG_HOME/dsh-manager 或 ~/.config/dsh-manager
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'dsh-manager');
}

const BASE_DIR = (testMode() && process.env.DSH_MANAGER_BASE_DIR) || defaultBaseDir();
const RUN_DIR = path.join(BASE_DIR, 'run');
const LOGS_DIR = path.join(BASE_DIR, 'logs');
const RUN_FILE = path.join(RUN_DIR, 'dsh-web.json'); // 唯一权威 run 记录（原子写）
const PID_FILE = path.join(RUN_DIR, 'dsh-web.pid'); // 冗余纯文本 pid
const LOCK_FILE = path.join(RUN_DIR, 'host.lock'); // 跨宿主互斥锁（'wx' 原子创建）
const LOG_FILE = path.join(LOGS_DIR, 'dsh-web.log'); // dsh stdout+stderr 追加日志
const READY_DIR = path.join(BASE_DIR, 'ready');
const READY_FILE = path.join(READY_DIR, 'dsh-web.json');

// Plugin-owned readiness lease (design §6.9); never accept a path from a request/run record.
function readReadiness(expected, skipPidCommandCheck = false) {
  if (!expected || !/^[a-f0-9]{32}$/.test(expected.launchId || '')
    || !Number.isSafeInteger(expected.launchStartedAt)) return null;
  try {
    if (fs.statSync(READY_FILE).size > 8192) return null;
    const signal = JSON.parse(fs.readFileSync(READY_FILE, 'utf8'));
    const now = Date.now();
    if (!signal || signal.schemaVersion !== 1 || signal.launchId !== expected.launchId
      || signal.launchStartedAt !== expected.launchStartedAt
      || signal.host !== DEFAULT_HOST || !['starting', 'ready'].includes(signal.state)
      || !Number.isInteger(signal.pid) || signal.pid <= 0
      || (expected.pid && signal.pid !== expected.pid)
      || !Number.isInteger(signal.port) || signal.port < 1 || signal.port > 65535
      || (expected.port > 0 && signal.port !== expected.port)
      || !Number.isSafeInteger(signal.startedAt) || signal.startedAt <= 0 || signal.startedAt > now + 2000
      || !Number.isSafeInteger(signal.updatedAt) || signal.updatedAt < expected.launchStartedAt
      || now - signal.updatedAt > 10000 || signal.updatedAt > now + 2000
      || typeof signal.pluginVersion !== 'string' || typeof signal.nodeVersion !== 'string'
      || !pidAlive(signal.pid)
      || (!skipPidCommandCheck && !pidLooksLikeDsh(signal.pid, expected.binPath))) return null;
    return signal;
  } catch (_) { return null; }
}

// Forced exits cannot run the publisher's disposer. Remove only the stopped launch's
// exact identity; freshness/liveness are deliberately irrelevant for stale cleanup.
function removeOwnedReadiness(expected) {
  if (!expected || !/^[a-f0-9]{32}$/.test(expected.launchId || '')
    || !Number.isSafeInteger(expected.launchStartedAt)
    || !Number.isInteger(expected.pid) || expected.pid <= 0) return;
  try {
    if (fs.statSync(READY_FILE).size > 8192) return;
    const signal = JSON.parse(fs.readFileSync(READY_FILE, 'utf8'));
    if (signal && signal.schemaVersion === 1 && signal.launchId === expected.launchId
      && signal.launchStartedAt === expected.launchStartedAt && signal.pid === expected.pid) {
      fs.unlinkSync(READY_FILE);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') log('清理本次就绪文件失败: ' + err.message);
  }
}

function readinessEnv(v) {
  return {
    ...process.env,
    DSH_MANAGER_READY_FILE: READY_FILE,
    DSH_MANAGER_LAUNCH_ID: v.launchId,
    DSH_MANAGER_LAUNCH_STARTED_AT: String(v.launchStartedAt),
  };
}

// Watch before spawning, and retain a timer fallback for unsupported/missed fs events.
function watchReadiness() {
  let wake = null;
  let watcher = null;
  try {
    fs.mkdirSync(READY_DIR, { recursive: true });
    watcher = fs.watch(READY_DIR, () => { if (wake) wake(); });
    watcher.on('error', () => { watcher.close(); watcher = null; if (wake) wake(); });
  } catch (_) { /* Timer fallback. */ }
  return {
    wait(ms) {
      return new Promise((resolve) => {
        const done = () => { clearTimeout(timer); wake = null; resolve(); };
        const timer = setTimeout(done, ms);
        wake = done;
      });
    },
    close() { if (watcher) watcher.close(); if (wake) wake(); },
  };
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------
// 测试钩子门控（安全，见 §12.1）：所有 DSH_MANAGER_* / DSH_BIN_STUB 等测试钩子
// 仅在显式测试开关 DSH_MANAGER_TEST_MODE === '1' 时才生效。生产（宿主被浏览器
// 在普通登录会话环境拉起，无该 env）完全忽略钩子，杜绝 DSH_BIN_STUB 等旁路。
function testMode() {
  return process.env.DSH_MANAGER_TEST_MODE === '1';
}

// Short budgets are environment-only test hooks; payloads never control them.
function testTimeout(name, fallback) {
  if (!testMode()) return fallback;
  const raw = process.env['DSH_MANAGER_' + name + '_TIMEOUT_MS'];
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 && value <= fallback ? value : fallback;
}

// Diagnostics must never expose browser launch credentials (including exception text).
function redactTokens(text) {
  return String(text).replace(/([?&]token=)[^\s&#"'<>]+/gi, '$1[REDACTED]');
}

// 日志只写 stderr，带时间戳前缀；stdout 只用于协议应答。
function log(msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[${ts}] ${redactTokens(msg)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 业务错误：code 属于协议错误码集合；result 用于幂等错误附带当前状态
class AppError extends Error {
  constructor(code, message, opts) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.result = opts && opts.result !== undefined ? opts.result : undefined;
    this.needLogTail = !!(opts && opts.needLogTail);
  }
}

// ---------------------------------------------------------------------------
// 互斥锁（design §4.2.5）：'wx' 原子创建，冲突重试 3 次（每次间隔 300ms）
// ---------------------------------------------------------------------------
async function acquireLock() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err; // 其他错误（权限等）向上抛
      if (attempt === 3) return false; // 1 次 + 3 次重试均冲突 -> BUSY
      await sleep(300);
    }
  }
  return false;
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch (err) {
    if (err.code !== 'ENOENT') log('释放锁失败: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// run 记录读写（原子写：先写 .tmp 再 rename）
// ---------------------------------------------------------------------------
function readRunRecord() {
  let raw;
  try {
    raw = fs.readFileSync(RUN_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    log('读取 run 记录失败: ' + err.message);
    return null;
  }
  try {
    const rec = JSON.parse(raw);
    // trust-but-verify（design §6.3 / §12.1，发现 8）：对 run 记录字段做结构校验，
    // 非法字段丢弃/整条拒绝，避免本机篡改 run 记录导致误杀或参数透传放大。
    // M4：port 允许 0（--port 0 动态端口：spawn 后从日志回填实际端口前为占位值）。
    if (rec && typeof rec === 'object'
      && Number.isInteger(rec.pid) && rec.pid > 0
      && Number.isInteger(rec.port) && rec.port >= 0 && rec.port <= 65535) {
      // host：强制回环 127.0.0.1，非法则弃用该字段（后续按 DEFAULT_HOST 兜底）
      if (rec.host !== undefined && (typeof rec.host !== 'string' || rec.host !== '127.0.0.1')) {
        delete rec.host;
      }
      // profile：强制 ^[A-Za-z0-9_-]+$，非法则弃用该字段（后续按 'web' 兜底）
      if (rec.profile !== undefined && (typeof rec.profile !== 'string' || !/^[A-Za-z0-9_-]+$/.test(rec.profile))) {
        delete rec.profile;
      }
      // extraArgs：强制字符串数组，非法则弃用该字段（避免非字符串进入 spawn 数组）
      if (rec.extraArgs !== undefined
        && !(Array.isArray(rec.extraArgs) && rec.extraArgs.every((a) => typeof a === 'string'))) {
        delete rec.extraArgs;
      }
      // requestedPort（M4）：0-65535 整数；非法则弃用（按 port 兜底）
      if (rec.requestedPort !== undefined
        && (!Number.isInteger(rec.requestedPort) || rec.requestedPort < 0 || rec.requestedPort > 65535)) {
        delete rec.requestedPort;
      }
      // logStartBytes（M4）：非负整数（spawn 时刻的日志字节偏移，动态端口发现只解析其后的内容）
      if (rec.logStartBytes !== undefined && (!Number.isInteger(rec.logStartBytes) || rec.logStartBytes < 0)) {
        delete rec.logStartBytes;
      }
      return rec;
    }
    log('run 记录格式非法，按无记录处理并清除');
    try { fs.unlinkSync(RUN_FILE); } catch (e) { /* 忽略 */ }
    return null;
  } catch (err) {
    log('run 记录 JSON 解析失败，按无记录处理并清除: ' + err.message);
    try { fs.unlinkSync(RUN_FILE); } catch (e) { /* 忽略 */ }
    return null;
  }
}

function writeRunRecord(rec) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const tmp = RUN_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8');
  fs.renameSync(tmp, RUN_FILE);
}

function writePidFile(pid) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(pid), 'utf8');
}

function removeRunRecord() {
  for (const f of [RUN_FILE, PID_FILE]) {
    try {
      fs.unlinkSync(f);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

function sameRunIdentity(a, b) {
  return !!a && !!b && a.pid === b.pid && a.launchId === b.launchId
    && a.launchStartedAt === b.launchStartedAt
    && (a.launchId || (a.startedAt === b.startedAt && a.binPath === b.binPath));
}

function removeRunRecordSafe() {
  try {
    removeRunRecord();
  } catch (err) {
    log('清理 run 记录失败: ' + err.message);
  }
}

// 无 run 记录时顺带清理残留的孤儿 pid 文件（design §6.3 status）
function cleanupOrphanPidFile() {
  try {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
      log('清理孤儿 pid 文件: ' + PID_FILE);
    }
  } catch (err) {
    log('清理孤儿 pid 文件失败: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// 进程判定
// ---------------------------------------------------------------------------
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM：进程存在但属更高权限（视作存活）；ESRCH 等：不存在
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

// 可选 PID 命令行校验（design §6.3 / §12.1 PID 复用防护）：
//   Windows：tasklist /FI "PID eq <pid>"，输出须包含 'dsh' 或 bin 路径关键字；
//   Linux：/proc/<pid>/cmdline；macOS：ps -p <pid> -o args=。
//   本环境可能 EPERM，必须 try/catch：任何异常一律静默跳过（视为通过）；
//   DSH_MANAGER_PID_CHECK=0 时直接跳过。
function pidLooksLikeDsh(pid, binPath, timeoutMs = 5000) {
  if (testMode() && process.env.DSH_MANAGER_PID_CHECK === '0') return true;
  if (!IS_WIN) {
    // POSIX：读命令行；读取失败按通过处理（权限等）
    let cmd = '';
    try {
      if (IS_LINUX) {
        cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').join(' ');
      } else {
        const r = spawnSync('ps', ['-p', String(pid), '-o', 'args='], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: timeoutMs,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        if (!r.error && r.status === 0) cmd = (r.stdout || '').trim();
      }
    } catch (err) {
      return true; // 无法校验，按通过
    }
    if (!cmd) return true; // 无输出（权限受限等）——按通过处理
    if (/dsh/.test(cmd)) return true;
    if (binPath && cmd.includes(String(binPath))) return true;
    return false;
  }
  let out;
  try {
    const r = spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (r.error) {
      log('PID 校验 tasklist 不可用，跳过（视为通过）: ' + r.error.message);
      return true;
    }
    out = r.stdout || '';
  } catch (err) {
    log('PID 校验异常，跳过（视为通过）: ' + (err && err.message));
    return true;
  }
  if (!String(out).trim()) return true; // 无输出（权限受限等）——按通过处理
  const lower = String(out).toLowerCase();
  if (lower.includes('dsh')) return true;
  if (binPath && lower.includes(String(binPath).toLowerCase())) return true;
  // 兼容：dsh 由 node.exe 运行（tasklist 只能看到镜像名，看不到命令行），
  // 因此 node.exe 镜像名同样视为通过；其余镜像名（如 chrome.exe）判定为 PID 复用。
  if (/node\.exe/.test(lower)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 网络探测
// ---------------------------------------------------------------------------
// HTTP 探活：GET http://127.0.0.1:<port>/，timeoutMs 超时，任意 2xx/3xx 视为成功。
// M13（§2.1.1 B1）：dsh ≥ 0.1.2 起 GET / 对无凭据请求返回 401——401 恰证明 dsh
// 认证中间件已挂载（比 200 更强的「这是 dsh 且已起来」信号），一并视为就绪。
// 探测请求不得发送 Accept-Encoding（§2.1.1 B2，gzip 默认开启）。
function httpProbe(port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve(v);
    };
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: '/',
      timeout: timeoutMs,
      headers: { Connection: 'close' },
      agent: false,
    }, (res) => {
      const code = res.statusCode || 0;
      res.resume(); // 丢弃响应体
      finish((code >= 200 && code < 400) || code === 401);
    });
    req.on('timeout', () => finish(false));
    req.on('error', () => finish(false));
  });
}

// M2 健康探测：GET /_lifecycle/health，timeoutMs 超时（1.5s）。
// 仅 HTTP 200 且响应体 JSON 可解析且 ok===true 才返回解析对象；
// 任何失败（超时/连接拒绝/非 200/JSON 非法/ok!==true/响应体超 8KB）一律静默返回 null，
// 绝不向上抛错（design §6.3 status 第 6 步 / §6.3 stop 优雅判定）。
// 参照 httpDshProbe：用 data/end 事件真正读全 body（≤8KB 截断），再 JSON.parse。
function getHealth(port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch (e) { /* 忽略 */ }
      resolve(v);
    };
    let req;
    try {
      req = http.get({
        host: '127.0.0.1',
        port,
        path: '/_lifecycle/health',
        timeout: timeoutMs,
        headers: { Connection: 'close' },
        agent: false,
      }, (res) => {
        const code = res.statusCode || 0;
        if (code !== 200) {
          res.resume();
          finish(null);
          return;
        }
        let body = '';
        let truncated = false;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (truncated) return;
          body += chunk;
          if (body.length > 8192) {
            truncated = true; // 超过 8KB 截断，视为失败
            finish(null);
          }
        });
        res.on('end', () => {
          if (truncated) return;
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch (err) {
            finish(null);
            return;
          }
          if (parsed && typeof parsed === 'object' && parsed.ok === true) {
            finish(parsed);
          } else {
            finish(null);
          }
        });
        res.on('error', () => finish(null));
      });
      req.on('timeout', () => finish(null));
      req.on('error', () => finish(null));
    } catch (err) {
      finish(null);
    }
  });
}

// M9 会话摘要探测：GET /_manager/sessions（dsh-lifecycle 插件端点，1.5s 超时）。
// 仅 HTTP 200 且 body JSON.ok===true 才返回 items 数组；任何失败（超时/连接拒绝/
// 非 200/JSON 非法/ok!==true/响应体超 128KB）一律静默返回 null，绝不向上抛错
// （design §8.10：sessions 是不可用即降级的可选富状态）。
function getManagerSessions(port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch (e) { /* 忽略 */ }
      resolve(v);
    };
    let req;
    try {
      req = http.get({
        host: '127.0.0.1',
        port,
        path: '/_manager/sessions',
        timeout: timeoutMs || 1500,
        headers: { Connection: 'close' },
        agent: false,
      }, (res) => {
        const code = res.statusCode || 0;
        if (code !== 200) {
          res.resume();
          finish(null);
          return;
        }
        let body = '';
        let truncated = false;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (truncated) return;
          body += chunk;
          if (body.length > 128 * 1024) {
            truncated = true; // 超过 128KB 截断，视为失败
            finish(null);
          }
        });
        res.on('end', () => {
          if (truncated) return;
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch (err) {
            finish(null);
            return;
          }
          if (parsed && typeof parsed === 'object' && parsed.ok === true && Array.isArray(parsed.items)) {
            finish(parsed.items);
          } else {
            finish(null);
          }
        });
        res.on('error', () => finish(null));
      });
      req.on('timeout', () => finish(null));
      req.on('error', () => finish(null));
    } catch (err) {
      finish(null);
    }
  });
}

// TCP 端口占用探测：能连上即认为端口被占用
function portConnectable(port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (e) { /* 忽略 */ }
      resolve(v);
    };
    const sock = net.createConnection({ host: '127.0.0.1', port });
    sock.setTimeout(timeoutMs || 1500);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
  });
}

// M2 优雅停机预留：POST /_lifecycle/shutdown（Content-Length:0，2s 超时）。
// 注意：dsh 的 SPA fallback 对未匹配路径也返回 200，因此不能用状态码判断
// 插件是否存在——是否成功由后续「轮询端口关闭」判定。
function postShutdown(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (req) req.destroy();
      resolve();
    };
    let req;
    try {
      req = http.request({
        host: '127.0.0.1',
        port,
        path: '/_lifecycle/shutdown',
        method: 'POST',
        headers: { 'Content-Length': '0', Connection: 'close' },
        timeout: timeoutMs,
        agent: false,
      }, (res) => {
        res.resume(); // 丢弃响应体（状态码不可用于判定）
        finish();
      });
      req.on('timeout', () => { try { req.destroy(); } catch (e) { /* 忽略 */ } finish(); });
      req.on('error', () => finish());
      req.end();
    } catch (err) {
      finish();
    }
  });
}

// 轮询端口关闭（用于优雅路径：端口必须从打开变为关闭）
async function waitPortClosed(port, totalMs, intervalMs) {
  const deadline = Date.now() + totalMs;
  for (;;) {
    if (!(await portConnectable(port, 800))) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  return !(await portConnectable(port, 800));
}

// PID AND listener must both be gone; port 0 is an unknown-port placeholder.
async function waitProcessStopped(pid, port, totalMs, intervalMs) {
  const deadline = Date.now() + totalMs;
  for (;;) {
    const remaining = Math.max(0, deadline - Date.now());
    if (!pidAlive(pid) && (port <= 0 || !(await portConnectable(port, Math.max(1, Math.min(800, remaining)))))) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(intervalMs, deadline - Date.now()));
  }
}

// ---------------------------------------------------------------------------
// 外部实例发现（design §6.6）：检测非本扩展启动的 dsh web 及其运行端口
// 全部只读：进程枚举 + netstat 端口表 + 回环 GET 指纹探测。
// 任一命令失败（EPERM/未安装/超时）静默降级：按无外部实例处理，绝不报错。
// ---------------------------------------------------------------------------

// 子进程捕获输出的统一封装：任何异常（含沙箱 EPERM）→ { ok:false }
function spawnCapture(exe, args, timeoutMs) {
  try {
    const r = spawnSync(exe, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs || 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (r.error) return { ok: false, error: r.error.message };
    return { ok: true, out: r.stdout || '' };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

// 测试钩子：注入假进程表（仅在 DSH_MANAGER_TEST_MODE=1 时生效）
function fakeProcessTable() {
  if (!testMode() || !process.env.DSH_MANAGER_FAKE_PROCESSES) return null;
  try {
    const arr = JSON.parse(process.env.DSH_MANAGER_FAKE_PROCESSES);
    return Array.isArray(arr) ? arr : null;
  } catch (err) {
    log('DSH_MANAGER_FAKE_PROCESSES 解析失败，忽略: ' + err.message);
    return null;
  }
}

// 测试钩子：注入假端口表（仅在 DSH_MANAGER_TEST_MODE=1 时生效）
function fakeListenerTable() {
  if (!testMode() || !process.env.DSH_MANAGER_FAKE_LISTENERS) return null;
  try {
    const arr = JSON.parse(process.env.DSH_MANAGER_FAKE_LISTENERS);
    return Array.isArray(arr) ? arr : null;
  } catch (err) {
    log('DSH_MANAGER_FAKE_LISTENERS 解析失败，忽略: ' + err.message);
    return null;
  }
}

// 枚举本机 node.exe 进程：返回 { pid, cmdline }[]；失败返回 []
function listNodeProcesses() {
  const fake = fakeProcessTable();
  if (fake !== null) {
    return fake.filter((p) => p && Number.isInteger(p.pid) && typeof p.cmdline === 'string');
  }
  if (IS_WIN) {
    return listNodeProcessesWin();
  }
  if (IS_LINUX) {
    return listNodeProcessesLinux();
  }
  // macOS：ps -eo pid=,args= 过滤 argv0 为 node 的进程（未实测，见 design §6.8）
  const r = spawnCapture('ps', ['-eo', 'pid=,args=']);
  if (!r.ok) {
    log('进程枚举不可用，跳过外部实例发现: ' + r.error);
    return [];
  }
  const out = [];
  for (const line of String(r.out).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const cmdline = m[2].trim();
    const argv0 = (cmdline.split(/\s+/)[0] || '');
    if (/(?:^|[\\/ ])node(?:\.exe)?$/.test(argv0)) out.push({ pid: Number(m[1]), cmdline });
  }
  return out;
}

// Linux：扫描 /proc/*/cmdline + comm（零外部依赖，design §6.8）
function listNodeProcessesLinux() {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch (err) {
    log('进程枚举不可用，跳过外部实例发现: ' + (err && err.message));
    return [];
  }
  for (const e of entries) {
    const pid = Number(e);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    let cmdline = '';
    try {
      cmdline = fs.readFileSync('/proc/' + e + '/cmdline', 'utf8').split('\0').join(' ').trim();
    } catch (err) {
      continue; // 进程退出/权限
    }
    if (!cmdline) continue;
    let comm = '';
    try {
      comm = fs.readFileSync('/proc/' + e + '/comm', 'utf8').trim();
    } catch (err) { /* 忽略 */ }
    const argv0 = (cmdline.split(/\s+/)[0] || '');
    const isNode = /^node(js)?(\.exe)?$/i.test(comm)
      || /(?:^|[\\/ ])node(?:js)?(?:\.exe)?$/.test(argv0);
    if (isNode) out.push({ pid, cmdline });
  }
  return out;
}

// Windows：powershell Get-CimInstance 枚举 node.exe（design §6.6）
function listNodeProcessesWin() {
  const cmd = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress";
  const r = spawnCapture('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd]);
  if (!r.ok) {
    log('进程枚举不可用，跳过外部实例发现: ' + r.error);
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(r.out);
  } catch (err) {
    log('进程枚举输出解析失败，跳过外部实例发现: ' + err.message);
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .filter((p) => p && Number.isInteger(p.ProcessId))
    .map((p) => ({ pid: p.ProcessId, cmdline: typeof p.CommandLine === 'string' ? p.CommandLine : '' }));
}

// 命令行是否为 dsh web 入口。返回：
//   undefined 不是 dsh 入口；null 是入口但未指定端口；0 是 --port 0（动态）；n>0 指定端口
function classifyDshCmdline(cmdline) {
  const isDshBin =
    /node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js/.test(cmdline) ||
    /deepseek-harness.*[\\/]bin\.js/.test(cmdline) ||
    /@deepseek-ai[\\/]dsh.*[\\/]bin\.js/.test(cmdline);
  if (!isDshBin) return undefined;
  const isWeb =
    /(?:^|\s)--profile(?:=|\s+)web(?=\s|$)/.test(cmdline) ||
    /(?:^|\s)web(?=\s|$)/.test(cmdline) ||
    /(?:^|\s)--port(?:=|\s)/.test(cmdline);
  if (!isWeb) return undefined;
  const m = /(?:^|\s)--port(?:=|\s+)(\d{1,5})(?=\s|$)/.exec(cmdline);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 0 || n > 65535) return null;
  return n; // 0 = 动态端口（走 netstat 回退）
}

// netstat -ano -p TCP：解析 LISTENING 行 -> { pid, addr, port }[]；失败返回 []
function listTcpListeners() {
  const fake = fakeListenerTable();
  if (fake !== null) {
    return fake.filter((l) => l && Number.isInteger(l.pid) && Number.isInteger(l.port) && typeof l.addr === 'string');
  }
  if (IS_WIN) {
    return listTcpListenersWin();
  }
  return listTcpListenersProcfs();
}

// Linux：/proc/net/tcp(+tcp6) 的 LISTEN 行只含 inode，经 /proc/*/fd 反查 pid
//（零外部依赖，design §6.8）。IPv4 地址为 4 字节小端 hex，IPv6 为 4×32 位小端 hex。
function listTcpListenersProcfs() {
  const listen = new Map(); // inode -> { addr, port }
  const ipv4FromHexLE = (hex) => [6, 4, 2, 0].map((i) => String(parseInt(hex.slice(i, i + 2), 16))).join('.');
  const ipv6FromHexLE = (hex) => {
    const groups = [];
    for (let w = 0; w < 4; w++) {
      const word = hex.slice(w * 8, w * 8 + 8);
      groups.push(word.slice(6, 8) + word.slice(4, 6));
      groups.push(word.slice(2, 4) + word.slice(0, 2));
    }
    // 压缩一次全 0 段（只用于回环/通配判断，无需完全规范的 IPv6 文本）
    return groups.join(':').replace(/(?:^|:)0(?::0)+(?::|$)/, '::') || '::';
  };
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let raw;
    try {
      raw = fs.readFileSync(f, 'utf8');
    } catch (err) {
      continue;
    }
    for (const line of raw.split('\n')) {
      // sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode
      const m = /^\s*\d+:\s+([0-9A-Fa-f]+):([0-9A-Fa-f]+)\s+[0-9A-Fa-f]+:[0-9A-Fa-f]+\s+0A\s+[^\s]+\s+[^\s]+\s+[^\s]+\s+(\d+)\s+\d+\s+(\d+)\s/.exec(line);
      if (!m) continue;
      const hex = m[1];
      const addr = hex.length === 8 ? ipv4FromHexLE(hex) : ipv6FromHexLE(hex);
      listen.set(m[3], { addr, port: parseInt(m[2], 16) });
    }
  }
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch (err) {
    return out;
  }
  for (const e of entries) {
    const pid = Number(e);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    let fds;
    try {
      fds = fs.readdirSync('/proc/' + e + '/fd');
    } catch (err) {
      continue;
    }
    for (const fd of fds) {
      let link;
      try {
        link = fs.readlinkSync('/proc/' + e + '/fd/' + fd);
      } catch (err) {
        continue;
      }
      const sm = /^socket:\[(\d+)\]$/.exec(link);
      if (sm && listen.has(sm[1])) {
        const l = listen.get(sm[1]);
        out.push({ addr: l.addr, port: l.port, pid });
      }
    }
  }
  return out;
}

// Windows：netstat -ano -p TCP 解析 LISTENING 行
function listTcpListenersWin() {
  const r = spawnCapture('netstat', ['-ano', '-p', 'TCP']);
  if (!r.ok) {
    log('netstat 不可用，跳过端口表解析: ' + r.error);
    return [];
  }
  const out = [];
  for (const line of String(r.out).split(/\r?\n/)) {
    let m = /^\s*TCP\s+(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (m) {
      out.push({ addr: m[1], port: Number(m[2]), pid: Number(m[3]) });
      continue;
    }
    m = /^\s*TCP\s+\[([0-9a-f:]+)\]:(\d{1,5})\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (m) out.push({ addr: m[1], port: Number(m[2]), pid: Number(m[3]) });
  }
  return out;
}

// dsh 指纹探测：GET / 读响应体前 8KB，须含 'DeepSeek Harness'（真实 index.html <title>）
// M13（§2.1.1 B1）：dsh ≥ 0.1.2 起 GET / 受启动令牌认证（无凭据 401 且 body 无指纹），
// 指纹端点改探公开静态资产 /manifest.webmanifest（上游明示非 index 资产保持公开；
// rc.2 与 0.1.2-rc.1 均 200 且含 "name": "DeepSeek Harness"；body 仅 267 字节，
// 8KB 早退分支天然不触发）。探测请求不得发送 Accept-Encoding（§2.1.1 B2）。
function httpDshProbe(port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch (e) { /* 忽略 */ }
      resolve(v);
    };
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: '/manifest.webmanifest',
      timeout: timeoutMs,
      headers: { Connection: 'close' },
      agent: false,
    }, (res) => {
      const code = res.statusCode || 0;
      if (code < 200 || code >= 400) {
        res.resume();
        finish(false);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 8192) finish(/deepseek\s*harness/i.test(body));
      });
      res.on('end', () => finish(/deepseek\s*harness/i.test(body)));
      res.on('error', () => finish(false));
    });
    req.on('timeout', () => finish(false));
    req.on('error', () => finish(false));
  });
}

// 发现外部 dsh web 实例：返回 [{ pid, port, cmdline }]（已通过指纹探测，按进程表顺序）
async function discoverExternalDsh() {
  const procs = listNodeProcesses().filter((p) => classifyDshCmdline(p.cmdline) !== undefined);
  if (procs.length === 0) return [];
  const listeners = listTcpListeners();
  const isLoopbackOrWildcard = (addr) =>
    addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === '0.0.0.0' || addr === '::';
  const found = [];
  for (const p of procs) {
    if (!pidAlive(p.pid)) continue;
    const portArg = classifyDshCmdline(p.cmdline);
    const candidates = new Set();
    if (portArg && portArg > 0) {
      candidates.add(portArg);
    } else {
      for (const l of listeners) {
        if (l.pid === p.pid && isLoopbackOrWildcard(l.addr)) candidates.add(l.port);
      }
    }
    for (const port of candidates) {
      if (await httpDshProbe(port, 1500)) {
        found.push({ pid: p.pid, port, cmdline: p.cmdline });
        break;
      }
    }
  }
  return found;
}

// 按空白切分命令行 token（尊重双引号分组，供接管解析用）
function splitCmdlineTokens(cmdline) {
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(cmdline))) tokens.push(m[1] !== undefined ? m[1] : m[2]);
  return tokens;
}

// 从外部实例命令行解析接管字段（design §6.7）：
//   profile —— --profile <name> / --profile=<name> / 入口后位置参数 web
//   host    —— --host <v> / --host=<v>；非 127.0.0.1 时归一回环（我们的探测只达回环）
//   extraArgs —— 其余 argv（lifecycle 参数与 bin 入口本身剔除；--port 以实际端口为准）
//   portArg —— 原命令行的 --port 值（仅日志参考；记录用实际端口）
function parseAdoptInfo(cmdline) {
  const tokens = splitCmdlineTokens(cmdline);
  // 定位 bin.js 入口 token，其后的参数才属于 dsh
  let binIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (/node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/i.test(tokens[i])) { binIdx = i; break; }
  }
  const args = binIdx >= 0 ? tokens.slice(binIdx + 1) : tokens;
  let profile = 'web';
  let host = '127.0.0.1';
  const extraArgs = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (i === 0 && t === 'web') { profile = 'web'; continue; } // dsh web 位置形式
    const eqProfile = /^--profile=(.+)$/.exec(t);
    if (eqProfile) { profile = eqProfile[1]; continue; }
    if (t === '--profile') {
      if (args[i + 1] !== undefined && args[i + 1] !== '') { profile = args[i + 1]; i += 1; }
      continue;
    }
    const eqHost = /^--host=(.+)$/.exec(t);
    if (eqHost) { host = eqHost[1]; continue; }
    if (t === '--host') {
      if (args[i + 1] !== undefined && args[i + 1] !== '') { host = args[i + 1]; i += 1; }
      continue;
    }
    if (/^--port(?:=.+)?$/.test(t)) {
      if (t === '--port' && args[i + 1] !== undefined) i += 1;
      continue; // 端口以发现到的实际端口为准（--port 0 归一化）
    }
    extraArgs.push(t);
  }
  if (host !== '127.0.0.1') {
    log(`接管实例的命令行 host=${host} 非回环，归一回环 127.0.0.1（探测仅达回环）`);
    host = '127.0.0.1';
  }
  return { profile, host, extraArgs };
}

// ---------------------------------------------------------------------------
// dsh 启动器解析（design §6.4，顺序按任务要求）
// ---------------------------------------------------------------------------
function resolveDshBin() {
  // a. DSH_BIN_STUB（测试用，直接替代真实 bin.js，不做存在性校验；仅 TEST_MODE 生效）
  if (testMode() && process.env.DSH_BIN_STUB) {
    log('使用 DSH_BIN_STUB: ' + process.env.DSH_BIN_STUB);
    return process.env.DSH_BIN_STUB;
  }
  // b. DSH_MANAGER_NPM_PREFIX 拼接（仅 TEST_MODE 生效）
  if (testMode() && process.env.DSH_MANAGER_NPM_PREFIX) {
    const cand = path.join(process.env.DSH_MANAGER_NPM_PREFIX, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (fs.existsSync(cand)) return cand;
  }
  // c. %APPDATA%\npm
  if (process.env.APPDATA) {
    const cand = path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (fs.existsSync(cand)) return cand;
  }
  // d. npm prefix -g（本环境可能 EPERM，必须捕获）
  try {
    const r = spawnSync('npm', ['prefix', '-g'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (!r.error && r.status === 0 && r.stdout) {
      const prefix = String(r.stdout).trim();
      if (prefix) {
        // POSIX npm 全局布局为 <prefix>/lib/node_modules；Windows 为 <prefix>/node_modules
        const candidates = IS_WIN
          ? [path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')]
          : [
            path.join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
            path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
          ];
        for (const cand of candidates) {
          if (fs.existsSync(cand)) return cand;
        }
      }
    } else if (r.error) {
      log('npm prefix -g 不可用，跳过: ' + r.error.message);
    }
  } catch (err) {
    log('npm prefix -g 探测失败，跳过: ' + (err && err.message));
  }
  // e. 平台化定位 dsh 启动器（Windows: where dsh；POSIX: command -v dsh + realpath）
  try {
    const r = IS_WIN
      ? spawnSync('where', ['dsh'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      : spawnSync('sh', ['-c', 'command -v dsh'], {
        // command 是 POSIX shell 内建；最小发行版（如 Kali 精简镜像）可能没有
        // /usr/bin/command 独立二进制，经 sh 调用最稳
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    if (!r.error && r.status === 0 && r.stdout) {
      const lines = String(r.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      for (const line of lines) {
        if (IS_WIN) {
          if (/dsh\.cmd$/i.test(line) || /^dsh(\.exe)?$/i.test(path.basename(line))) {
            const cand = path.join(path.dirname(line), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
            if (fs.existsSync(cand)) return cand;
          }
        } else {
          // POSIX：启动器通常是 prefix/bin/dsh 符号链接 → lib/bin.js，realpath 直取本体
          try {
            const real = fs.realpathSync(line);
            if (real && /[\\/]bin\.js$/.test(real) && fs.existsSync(real)) return real;
          } catch (err2) {
            // 非符号链接，走 npm 布局回退
          }
          const cand = path.join(path.dirname(line), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
          if (fs.existsSync(cand)) return cand;
        }
      }
    } else if (r.error) {
      log((IS_WIN ? 'where dsh' : 'command -v dsh') + ' 不可用，跳过: ' + r.error.message);
    }
  } catch (err) {
    log((IS_WIN ? 'where dsh' : 'command -v dsh') + ' 探测失败，跳过: ' + (err && err.message));
  }
  return null;
}

// 版本检查（非致命）：失败记 'unknown' 并继续
function getDshVersion(bin) {
  try {
    const r = spawnSync(process.execPath, [bin, '--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (!r.error && r.status === 0 && r.stdout) {
      const first = String(r.stdout).trim().split(/\r?\n/)[0] || '';
      const m = first.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
      if (m) return m[0];
      if (first) return first;
    } else if (r.error) {
      log('dsh --version 不可用，记 unknown: ' + r.error.message);
    }
  } catch (err) {
    log('dsh --version 检查失败，记 unknown: ' + (err && err.message));
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// 进程启动与终止
// ---------------------------------------------------------------------------
// spawn：node.exe <bin.js> --profile <p> [extraArgs...] --host <h> --port <n>
// POSIX：直接 spawn（无控制台概念），stdout/stderr 追加写日志文件；透传全部环境变量。
// Windows（M5.5）：隐藏控制台载体（design §6.3 第 5 步）——wscript.exe 执行
// launch-hidden.vbs，WScript.Shell.Run(cmd, 0, False) 以 SW_HIDE 创建控制台：
// dsh 拥有控制台（命令子进程继承、不再闪窗）但窗口从不显示。命令经环境变量
// DSH_MANAGER_LAUNCH_CMD 传递；stdout/stderr 由 cmd `1>> 日志 2>&1` 重定向。
// 载体（wscript→cmd）即刻退出，dsh 独立存活；真实 PID 由 startDshCore 在端口
// 就绪后经端口表反查（findPidByPort），不以 wscript 的 pid 为准。
const VBS_LAUNCH_SOURCE = [
  "' Whalekeeper: launch dsh with a hidden console (design §6.3 M5.5)",
  "' Usage: wscript.exe launch-hidden.vbs  (command line via env DSH_MANAGER_LAUNCH_CMD)",
  "' windowStyle=0 (SW_HIDE): the console window is created but never shown -",
  "' dsh keeps a console (its children inherit it, no flash windows) while the",
  "' desktop stays clean.",
  "' 注意：必须显式经 cmd /d /c call 执行——WshShell.Run 对引号开头（exe 路径）的",
  "' 命令会直接 CreateProcess，stdout 重定向（1>> 日志 2>&1）会被当成普通参数丢失。",
  "' call 关键字避免 cmd /c 对首引号命令的剥引号规则。",
  'On Error Resume Next',
  'Set sh = CreateObject("WScript.Shell")',
  'Set env = sh.Environment("PROCESS")',
  'cmd = env("DSH_MANAGER_LAUNCH_CMD")',
  'If cmd = "" Then WScript.Quit 1',
  'sh.Run "cmd.exe /d /c call " & cmd, 0, False',
  'If Err.Number <> 0 Then WScript.Quit 1',
  'WScript.Quit 0',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// 启动规格解析（支持 global / npx / source 三种启动方式）
// ---------------------------------------------------------------------------
function sourceProfileOverlay() {
  const file = path.join(RUN_DIR, 'source-no-ssh.patch.yml');
  const content = '- id: mcp-ssh\n  disabled: true\n';
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return file;
    fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    throw new AppError('INTERNAL', '无法准备本地源码启动覆盖文件: ' + (err && err.message));
  }
  return file;
}

function resolveLaunchSpec(v) {
  const mode = (v && v.launchMode) || 'global';
  // a. DSH_BIN_STUB（测试用，直接替代真实 bin.js；仅 TEST_MODE 生效）
  if (testMode() && process.env.DSH_BIN_STUB) {
    log('使用 DSH_BIN_STUB: ' + process.env.DSH_BIN_STUB);
    const bin = process.env.DSH_BIN_STUB;
    return {
      exe: process.execPath,
      args: [bin, '--profile', v.profile, ...v.extraArgs, '--host', v.host, '--port', String(v.port)],
      binPath: bin,
      version: getDshVersion(bin),
      launchMode: mode,
      customPath: v.customPath || '',
    };
  }

  // b. npx 快速免安装启动（官方最新推文推荐）
  if (mode === 'npx') {
    let npxExe = IS_WIN ? 'npx.cmd' : 'npx';
    if (IS_WIN) {
      try {
        const r = spawnSync('where', ['npx'], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        if (!r.error && r.status === 0 && r.stdout) {
          const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
          if (first) npxExe = first;
        }
      } catch (_) {}
    }
    const pkg = '@deepseek-ai/dsh';
    return {
      exe: npxExe,
      args: ['-y', pkg, '--profile', v.profile, ...v.extraArgs, '--host', v.host, '--port', String(v.port)],
      binPath: 'npx:' + pkg,
      version: 'npx',
      launchMode: mode,
      customPath: '',
    };
  }

  // c. 本地源码 / 脚本路径
  if (mode === 'source') {
    const rawPath = sanitizeCustomPath(v.customPath);
    if (!rawPath || !fs.existsSync(rawPath)) {
      throw new AppError('BAD_REQUEST', `指定的本地源码路径不存在: ${rawPath}`);
    }
    let targetBin = null;
    try {
      const stat = fs.statSync(rawPath);
      if (stat.isFile()) {
        targetBin = rawPath;
      } else if (stat.isDirectory()) {
        const candidates = [
          path.join(rawPath, 'apps', 'cli', 'lib', 'bin.js'),
          path.join(rawPath, 'lib', 'bin.js'),
          path.join(rawPath, 'bin.js'),
          path.join(rawPath, 'packages', 'cli', 'lib', 'bin.js'),
          path.join(rawPath, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
        ];
        // 尝试从 apps/cli/package.json 或根目录 package.json 解析 bin
        for (const pkgRel of ['apps/cli/package.json', 'package.json']) {
          const pkgPath = path.join(rawPath, pkgRel);
          if (fs.existsSync(pkgPath)) {
            try {
              const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
              if (pkgJson.bin) {
                const binTarget = typeof pkgJson.bin === 'string' ? pkgJson.bin : (pkgJson.bin.dsh || Object.values(pkgJson.bin)[0]);
                if (binTarget) {
                  candidates.unshift(path.resolve(path.dirname(pkgPath), binTarget));
                }
              }
            } catch (_) {}
          }
        }
        for (const cand of candidates) {
          if (fs.existsSync(cand)) {
            targetBin = cand;
            break;
          }
        }
      }
    } catch (e) {
      throw new AppError('BAD_REQUEST', `检查本地源码路径失败: ${e && e.message}`);
    }
    if (!targetBin) {
      throw new AppError('BAD_REQUEST', `在源码目录 ${rawPath} 下未找到 lib/bin.js 或 bin.js 入口，请确认是否已完成构建`);
    }
    return {
      exe: process.execPath,
      args: [targetBin, '--profile', v.profile, '--patch', sourceProfileOverlay(),
        ...v.extraArgs, '--host', v.host, '--port', String(v.port)],
      binPath: targetBin,
      version: getDshVersion(targetBin),
      launchMode: mode,
      customPath: rawPath,
    };
  }

  // d. 默认 global 安装模式
  const bin = resolveDshBin();
  if (!bin) {
    throw new AppError('DSH_NOT_FOUND', '未检测到全局 dsh 安装。请先执行 npm i -g @deepseek-ai/dsh，或在扩展设置中切换为「NPX 免安装」启动方式。');
  }
  return {
    exe: process.execPath,
    args: [bin, '--profile', v.profile, ...v.extraArgs, '--host', v.host, '--port', String(v.port)],
    binPath: bin,
    version: getDshVersion(bin),
    launchMode: 'global',
    customPath: '',
  };
}

function spawnDsh(specOrBin, v) {
  const spec = (typeof specOrBin === 'object' && specOrBin && specOrBin.exe && Array.isArray(specOrBin.args))
    ? specOrBin
    : {
      exe: process.execPath,
      args: [specOrBin, '--profile', v.profile, ...v.extraArgs, '--host', v.host, '--port', String(v.port)],
    };
  if (IS_WIN) return spawnDshWinCarrier(spec, v);
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const logFd = fs.openSync(LOG_FILE, 'a'); // 追加打开；宿主退出后子进程持有自身副本，不受影响
  const child = spawn(spec.exe, spec.args, {
    detached: true, // dsh 必须独立于宿主存活（design §4.2.2）
    stdio: ['ignore', logFd, logFd], // 不用 pipe：避免宿主退出后 EPIPE
    env: readinessEnv(v), // 透传 DSH_HOME，并覆盖宿主专属就绪信号变量
  });
  // 必须有 error 监听，否则 spawn 失败会触发 uncaughtException
  child.on('error', (err) => log('dsh 子进程 error: ' + (err && err.message)));
  child.on('exit', (code, signal) => log('dsh 子进程退出 code=' + code + ' signal=' + signal));
  child.unref(); // 宿主可随时安全退出（design §6.3 start 第 8 步）
  return child;
}

// Windows：隐藏控制台载体启动（design §6.3 第 5 步，M5.5）
function spawnDshWinCarrier(specOrBin, v) {
  const spec = (typeof specOrBin === 'object' && specOrBin && specOrBin.exe && Array.isArray(specOrBin.args))
    ? specOrBin
    : {
      exe: process.execPath,
      args: [specOrBin, '--profile', v.profile, ...v.extraArgs, '--host', v.host, '--port', String(v.port)],
    };
  fs.mkdirSync(BASE_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true }); // cmd 重定向目标目录必须先存在
  const vbs = path.join(BASE_DIR, 'launch-hidden.vbs');
  try {
    fs.writeFileSync(vbs, VBS_LAUNCH_SOURCE, 'utf8');
  } catch (err) {
    throw new AppError('INTERNAL', '载体脚本写入失败: ' + (err && err.message));
  }
  // cmd 命令行：token 全部引号包裹（& | < > 在引号内为字面量），
  // 字面 % 转义为 %%（cmd 变量展开符）；stdout/stderr 追加重定向到日志文件
  const esc = (s) => s.replace(/%/g, '%%');
  const tokens = [spec.exe, ...spec.args].map((s) => '"' + esc(s) + '"');
  const cmdline = tokens.join(' ') + ' 1>> "' + esc(LOG_FILE) + '" 2>&1';
  const child = spawn('wscript.exe', [vbs], {
    detached: true, // 载体即刻退出，dsh 独立存活（design §4.2.2）
    windowsHide: true,
    stdio: 'ignore',
    env: Object.assign(readinessEnv(v), { DSH_MANAGER_LAUNCH_CMD: cmdline }),
  });
  // 必须有 error 监听，否则 spawn 失败会触发 uncaughtException
  child.on('error', (err) => log('dsh 载体（wscript）启动 error: ' + (err && err.message)));
  child.unref(); // 宿主可随时安全退出
  return child;
}

// 端口表反查监听 PID（Windows 载体链路：run 记录的 pid 必须是真的 dsh 进程，
// 而非载体 wscript 的 pid）。回环/通配地址过滤与外部发现（§6.6）一致。
function findPidByPort(port) {
  const isLoopbackOrWildcard = (addr) =>
    addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === '0.0.0.0' || addr === '::';
  for (const l of listTcpListeners()) {
    if (l.port === port && isLoopbackOrWildcard(l.addr)) return l.pid;
  }
  return null;
}

// 强制终止（design §6.8 平台抽象层）：Windows taskkill /T /F；
// POSIX 先 SIGTERM 进程组（detached 起组），3s 内未退出再 SIGKILL 兜底。
function terminateProcess(pid) {
  return IS_WIN ? taskkillProcess(pid) : killProcessPosix(pid);
}

// taskkill /PID <pid> /T /F；stdio:'ignore'，只等 exit 事件，不捕获输出（避免管道问题）
function taskkillProcess(pid) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    child.on('error', (err) => finish({ ok: false, error: err.message }));
    child.on('exit', (code) => finish({ ok: code === 0, code }));
  });
}

// POSIX：kill(-pid, SIGTERM) 进程组 → 3s 轮询 → SIGKILL 兜底。
// 返回 { ok, code }，与 taskkillProcess 同形。
function killProcessPosix(pid) {
  return new Promise((resolve) => {
    const sig = (s) => {
      try { process.kill(-pid, s); return; } catch (e1) {
        try { process.kill(pid, s); } catch (e2) { /* 已退出 */ }
      }
    };
    try {
      sig('SIGTERM');
    } catch (err) {
      resolve({ ok: false, error: (err && err.message) || String(err) });
      return;
    }
    const deadline = Date.now() + 3000;
    const iv = setInterval(() => {
      if (!pidAlive(pid)) {
        clearInterval(iv);
        resolve({ ok: true, code: 0 });
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(iv);
        try { sig('SIGKILL'); } catch (err) { /* 忽略 */ }
        resolve({ ok: !pidAlive(pid), code: 0 });
      }
    }, 200);
  });
}

// 读取日志文件最近 N 行（START_TIMEOUT / STOP_FAILED / INTERNAL 附带）
function readLogTail(lines) {
  const n = lines || LOG_TAIL_LINES;
  try {
    const raw = fs.readFileSync(LOG_FILE, 'utf8');
    const arr = raw.split(/\r?\n/);
    return redactTokens(arr.slice(-n).join('\n'));
  } catch (err) {
    return ''; // 日志文件不存在等
  }
}

// 读取日志文件 byteOffset 之后的追加内容（UTF-8，尽力而为；失败/空返回 ''）。
// M13：discoverPortFromLog 与 discoverLaunchUrlFromLog 共用的读取底座。
function readLogSince(byteOffset) {
  try {
    const stat = fs.statSync(LOG_FILE);
    const offset = Number.isInteger(byteOffset) ? Math.min(Math.max(byteOffset, 0), stat.size) : 0;
    if (stat.size <= offset) return '';
    const fd = fs.openSync(LOG_FILE, 'r');
    try {
      const len = stat.size - offset;
      const buf = Buffer.alloc(len);
      let off = 0;
      while (off < len) {
        const n = fs.readSync(fd, buf, off, len - off, offset + off);
        if (n <= 0) break;
        off += n;
      }
      return buf.subarray(0, off).toString('utf8');
    } finally {
      try { fs.closeSync(fd); } catch (e) { /* 忽略 */ }
    }
  } catch (err) {
    return '';
  }
}

// M4 动态端口发现（design §6.3 start）：从日志文件 byteOffset 之后的追加内容里
// 解析 `dsh web: http://127.0.0.1:<port>` URL 行（真实 dsh 绑定后打印实际端口）。
// 返回实际端口（1-65535，取最后一次匹配；port 0 的占位行被跳过），未找到返回 null。
// 任何读取/解析失败静默返回 null（不抛，发现失败走 START_TIMEOUT/starting 兜底）。
function discoverPortFromLog(byteOffset) {
  const raw = readLogSince(byteOffset);
  if (raw === '') return null;
  const re = /dsh\s*web:\s*https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})/gi;
  let found = null;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const p = Number(m[1]);
    if (Number.isInteger(p) && p >= 1 && p <= 65535) found = p;
  }
  return found;
}

// M13（§2.1.1 B1/F5）：从日志 byteOffset 之后的追加内容捕获完整启动 URL 行
// `dsh web: http://127.0.0.1:<port>/?token=...`（含进程级一次性 token query）。
// 取最后一次匹配；URL 行可能带 ` (LAN: ...)` 后缀——`[^\s]+` 在空格处停，
// 只捕获 loopback URL。任何失败静默返回 null。
function discoverLaunchUrlFromLog(byteOffset) {
  const raw = readLogSince(byteOffset);
  if (raw === '') return null;
  const re = /dsh\s*web:\s*(https?:\/\/[^\s]+)/gi;
  let found = null;
  let m;
  while ((m = re.exec(raw)) !== null) found = m[1];
  return found;
}

// M13：等待 launchUrl 出现（写 run 记录前调用）。动态端口场景端口行已出现
// （端口就是从该行解析的）；固定端口场景 URL 行在 loader settled 后才打印、
// 可能晚于 HTTP 就绪——短重试最多 timeoutMs（默认 5000，间隔 500ms）兜底。
async function captureLaunchUrl(logStartBytes, timeoutMs = LAUNCH_URL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const url = discoverLaunchUrlFromLog(logStartBytes);
    if (url !== null) return url;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await sleep(Math.min(500, remaining));
  }
}

// ---------------------------------------------------------------------------
// payload 校验（design §6.2 / §12.1 参数白名单）
// ---------------------------------------------------------------------------
// extraArgs 白名单：仅允许 --patch <绝对路径>（路径必须存在且为绝对路径），可重复
function validateExtraArgs(args) {
  if (!Array.isArray(args)) return { ok: false };
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') return { ok: false };
    if (a === '--patch') {
      i += 1;
      if (i >= args.length) return { ok: false };
      const p = args[i];
      if (typeof p !== 'string' || !path.isAbsolute(p) || !fs.existsSync(p)) return { ok: false };
      out.push('--patch', path.resolve(p));
    } else {
      return { ok: false };
    }
  }
  return { ok: true, args: out };
}

// adoptedReplay 重放的危险参数拒绝（design §6.7 / §12.1 黑色单边界收敛）：
// 接管重放的 extraArgs 源自本机进程表（可被本机任意进程伪造），重放前对
// 会扩大暴露面的参数做黑名单拒绝——禁止一切以 --host / --trusted-host /
// --port / --profile 开头的参数，以及含 .. 路径穿越的 token。其余参数
// （如 --resume abc、生命周期/自定义参数）照常放行。被过滤的参数记日志。
function filterAdoptedExtraArgs(args) {
  const out = [];
  let dropped = 0;
  const isDangerous = (a) =>
    /^--host(?:=|\s|$)/.test(a) ||
    /^--trusted-host(?:=|\s|$)/.test(a) ||
    /^--port(?:=|\s|$)/.test(a) ||
    /^--profile(?:=|\s|$)/.test(a) ||
    String(a).includes('..');
  for (const raw of args) {
    if (typeof raw !== 'string' || isDangerous(raw)) {
      dropped += 1;
      continue;
    }
    out.push(raw);
  }
  if (dropped > 0) {
    log(`已丢弃 ${dropped} 个不安全参数（接管重放黑名单拒绝）`);
  }
  return out;
}

// 清洗本地路径：去除首尾双引号/单引号/空白，去除末尾反斜杠/斜杠（避免 Windows 载体转义 \" 崩溃）
function sanitizeCustomPath(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  while ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  if (!/^[A-Za-z]:[\\/]$/.test(s) && s.length > 1) {
    s = s.replace(/[\\/]+$/, '');
  }
  return s;
}

function validateStartPayload(payload) {
  const p = payload || {};
  // host：必须为 127.0.0.1（缺省值可被 DSH_MANAGER_HOST 覆盖[仅 TEST_MODE]，覆盖后仍须为回环）
  let host = p.host !== undefined ? p.host : ((testMode() && process.env.DSH_MANAGER_HOST) || DEFAULT_HOST);
  if (typeof host !== 'string' || host !== '127.0.0.1') {
    throw new AppError('BAD_REQUEST', `host 仅允许 127.0.0.1（收到: ${JSON.stringify(host)}）`);
  }
  // port：0-65535 整数（缺省 3080，可被 DSH_MANAGER_PORT 覆盖[仅 TEST_MODE]）；
  // M4：0 = 动态端口（OS 分配，启动后从日志 URL 行回填实际端口，见 start 第 9 步）
  let port;
  if (p.port !== undefined) {
    port = p.port;
  } else if (testMode() && process.env.DSH_MANAGER_PORT) {
    port = Number(process.env.DSH_MANAGER_PORT);
  } else {
    port = DEFAULT_PORT;
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new AppError('BAD_REQUEST', `port 必须是 0-65535 的整数，0 表示动态端口（收到: ${JSON.stringify(p.port)}）`);
  }
  // profile：默认 'web'，仅允许字母数字-_
  let profile = p.profile !== undefined ? p.profile : 'web';
  if (typeof profile !== 'string' || !/^[A-Za-z0-9_-]+$/.test(profile)) {
    throw new AppError('BAD_REQUEST', `profile 仅允许字母数字-_（收到: ${JSON.stringify(profile)}）`);
  }
  // launchMode：默认 'global'，允许 'global' | 'npx' | 'source'
  let launchMode = p.launchMode !== undefined ? p.launchMode : 'global';
  if (typeof launchMode !== 'string' || !['global', 'npx', 'source'].includes(launchMode)) {
    throw new AppError('BAD_REQUEST', `launchMode 仅允许 'global'|'npx'|'source'（收到: ${JSON.stringify(launchMode)}）`);
  }
  // customPath：仅当 launchMode === 'source' 时必须为本机存在的目录或文件路径
  let customPath = p.customPath !== undefined ? p.customPath : '';
  if (typeof customPath !== 'string') {
    throw new AppError('BAD_REQUEST', `customPath 必须是字符串（收到: ${JSON.stringify(customPath)}）`);
  }
  if (launchMode === 'source') {
    const cleaned = sanitizeCustomPath(customPath);
    if (!cleaned) {
      throw new AppError('BAD_REQUEST', 'source 模式下必须指定 customPath（本地源码目录或 bin.js 路径）');
    }
    if (!fs.existsSync(cleaned)) {
      throw new AppError('BAD_REQUEST', `指定的本地源码路径不存在: ${cleaned}`);
    }
    customPath = cleaned;
  } else {
    customPath = sanitizeCustomPath(customPath);
  }
  // extraArgs：白名单
  let extraArgs = p.extraArgs !== undefined ? p.extraArgs : [];
  const va = validateExtraArgs(extraArgs);
  if (!va.ok) {
    throw new AppError('BAD_REQUEST', 'extraArgs 仅允许 --patch <绝对路径>（路径须存在，可重复），其余参数一律拒绝');
  }
  // 注：原 windowsHide（显示/隐藏 dsh 控制台窗口）字段已移除——实测核验 detached 下
  // 不生效（Windows DETACHED_PROCESS 语义，dsh 始终无控制台），见 design §6.3 第 5 步。
  return { host, port, profile, launchMode, customPath, extraArgs: va.args };
}

// ---------------------------------------------------------------------------
// 状态判定（design §5 / §6.3 status / §6.6 外部实例发现）
// ---------------------------------------------------------------------------
async function computeStatus(fastReadiness = false) {
  const rec = readRunRecord();
  let readiness;
  if (rec) {
    if (!pidAlive(rec.pid)) {
      log('run 记录指向的 PID 不存在，清理残留记录');
      removeOwnedReadiness(rec);
      removeRunRecordSafe();
    } else if (fastReadiness && (readiness = readReadiness(rec, true))) {
      // 只读 status：新鲜租约已绑定本次启动的 ID、PID 与端口，无须每轮启动 tasklist。
      if (rec.port === 0) {
        rec.port = readiness.port;
        rec.launchUrl = discoverLaunchUrlFromLog(rec.logStartBytes);
        writeRunRecord(rec);
      }
      return { state: readiness.state === 'ready' ? 'running' : 'starting', rec, readiness };
    } else if (!pidLooksLikeDsh(rec.pid, rec.binPath)) {
      // 可选 PID 校验：命令行不含 dsh/bin 关键字，疑似 PID 复用，清记录防误判
      log('PID 校验未通过（疑似 PID 复用），清理残留记录');
      removeRunRecordSafe();
    } else if ((readiness = readReadiness(rec, true))) {
      if (rec.port === 0) {
        rec.port = readiness.port;
        rec.launchUrl = discoverLaunchUrlFromLog(rec.logStartBytes);
        writeRunRecord(rec);
      }
      return { state: readiness.state === 'ready' ? 'running' : 'starting', rec, readiness };
    } else if (rec.port === 0) {
      // M4 动态端口占位：尝试从日志（spawn 偏移之后）回填实际端口；失败保持 starting
      const actual = discoverPortFromLog(rec.logStartBytes);
      if (actual !== null) {
        rec.port = actual;
        // M13：旧记录可能缺 launchUrl（升级前写入）——顺带从日志补齐（无则保持 null）
        if (typeof rec.launchUrl !== 'string') rec.launchUrl = discoverLaunchUrlFromLog(rec.logStartBytes);
        writeRunRecord(rec);
        log(`动态端口已从日志回填: ${actual}`);
        const probe = await httpProbe(rec.port, 1500);
        return probe ? { state: 'running', rec } : { state: 'starting', rec };
      }
      return { state: 'starting', rec };
    } else {
      const probe = await httpProbe(rec.port, 1500);
      return probe ? { state: 'running', rec } : { state: 'starting', rec };
    }
  }
  cleanupOrphanPidFile(); // 顺带清理孤儿 pid 文件
  // 外部实例发现（design §6.6）：无有效 run 记录时检测非本扩展启动的 dsh web
  const ext = await discoverExternalDsh();
  if (ext.length > 0) {
    return { state: 'external', rec: null, external: { pid: ext[0].pid, port: ext[0].port, count: ext.length } };
  }
  return { state: 'stopped', rec: null };
}

// 统一的 status 结果对象（design §6.2 响应 result）
function buildResult(state, rec, external) {
  const isExternal = state === 'external';
  const pid = isExternal ? (external && external.pid) : (rec && Number.isInteger(rec.pid) ? rec.pid : null);
  // M4：managed 记录的 port 可能为 0（动态端口未回填）——对外报 null 端口与 null URL
  const port = isExternal ? (external && external.port)
    : (rec && Number.isInteger(rec.port) && rec.port > 0 ? rec.port : null);
  const requestedPort = !isExternal && rec && Number.isInteger(rec.requestedPort) ? rec.requestedPort : null;
  const result = {
    state,
    source: isExternal ? 'external' : (rec ? 'managed' : null),
    pid: pid || null,
    port,
    url: port ? `http://127.0.0.1:${port}` : null,
    // M13（§2.1.1 B1）：dsh ≥ 0.1.2 起裸 URL 打开会 401，扩展「打开 Web UI」需
    // 携带 token；launchUrl 仅 managed 且日志捕获到时返回（含 token，§12.3 边界），
    // external/adopted/未捕获为 null（扩展回退裸 URL）。
    launchUrl: !isExternal && rec && typeof rec.launchUrl === 'string' && rec.launchUrl.length > 0 ? rec.launchUrl : null,
    version: rec && rec.version ? rec.version : 'unknown',
    startedAt: rec && Number.isInteger(rec.startedAt) ? rec.startedAt : null,
    launchMode: !isExternal && rec ? (rec.launchMode || 'global') : null,
    customPath: !isExternal && rec ? (rec.customPath || '') : null,
    lifecycle: false, // M2：running 时探测 /_lifecycle/health 可达才置 true（其余状态恒 false）
    health: null, // M2：lifecycle:true 时填充富状态；否则恒 null
    logFile: LOG_FILE,
  };
  // M4：动态端口占位期（port 未知）附带 requestedPort 供扩展侧展示「端口自动分配中」
  if (requestedPort === 0) result.requestedPort = 0;
  if (isExternal && external && Number.isInteger(external.count) && external.count > 1) {
    result.externalCount = external.count;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 动作实现（design §6.3）
// ---------------------------------------------------------------------------
async function actionPing() {
  const bin = resolveDshBin();
  const version = bin ? getDshVersion(bin) : 'unknown';
  return {
    hostVersion: HOST_VERSION,
    nodeVersion: process.version,
    dshBin: bin,
    dshVersion: version,
    baseDir: BASE_DIR,
  };
}

async function actionStatus() {
  const { state, rec, external, readiness } = await computeStatus(true);
  const result = buildResult(state, rec, external);
  if (state === 'running' && readiness) {
    result.lifecycle = true;
    result.health = { ok: true, pid: readiness.pid, port: readiness.port,
      uptimeMs: Math.max(0, Date.now() - readiness.startedAt), nodeVersion: readiness.nodeVersion };
    return result;
  }
  // M2：仅 running 探测 health（1.5s 超时，失败静默 false）；其余状态保持默认 false/null
  if (state === 'running' && rec && Number.isInteger(rec.port)) {
    const health = await getHealth(rec.port, 1500);
    if (health !== null) {
      result.lifecycle = true;
      result.health = health;
    }
  }
  return result;
}

// 启动核心（start / restart 共用，design §6.3 start）：
// v 为内部校验后的 {host, port, profile, extraArgs}；adoptedReplay=true 时
// extraArgs 来自接管解析（本机进程表，非扩展输入，跳过 §12.1 白名单，见 §6.7），
// 且新 run 记录延续 adopted 血统标记（后续 restart 继续按原 argv 重放）。
// M5.5：run 记录在「端口就绪 + PID 已知」后才写（Windows 载体链路下 spawn 时
// 拿不到 dsh 的真实 PID），启动期间（端口就绪前）无记录、status 显示 stopped；
// **锁保持到记录写入完成**——启动窗口内并发 start 被锁挡下（防双开，`--port 0`
// 无占用探测亦被覆盖，design §6.3 第 6/7 步）。
async function startDshCore(v, adoptedReplay) {
  // 抢锁（design §4.2.5）
  const locked = await acquireLock();
  if (!locked) throw new AppError('BUSY', '另一个操作正在进行，请稍后重试');
  // M4：spawn 时刻的日志字节偏移（动态端口发现只解析其后的追加内容，
  // 避免历史日志里旧实例的 URL 行干扰）；声明在锁块外供后续发现轮询使用
  let logStartBytes = 0;
  let child = null;
  let bin = null;
  let version = 'unknown';
  let readyWatch = null;
  try {
    // 锁内复查：防与其他宿主竞态双开（记录存在且 PID 存活即视为已在运行/启动中）
    const cur = readRunRecord();
    if (cur && pidAlive(cur.pid) && pidLooksLikeDsh(cur.pid, cur.binPath)) {
      throw new AppError('ALREADY_RUNNING', 'dsh 已在运行或正在启动（幂等）', { result: buildResult('running', cur) });
    }
    // 端口占用探测：能连上且不是我们的记录 -> PORT_BUSY（design §6.3 第 3 步；
    //    顺带做 dsh 指纹探测，占用者是 dsh 时给出针对性提示，见 §6.6）。
    //    M4：port 0（动态端口）跳过占用探测——端口由 OS 分配，不存在「占用」概念。
    if (v.port > 0 && await portConnectable(v.port, 1500)) {
      const rec = readRunRecord();
      const isOurs = rec && rec.port === v.port && pidAlive(rec.pid) && pidLooksLikeDsh(rec.pid, rec.binPath);
      if (!isOurs) {
        const isDsh = await httpDshProbe(v.port, 1500);
        throw new AppError('PORT_BUSY', isDsh
          ? `端口 ${v.port} 已有一个正在运行的 dsh web（外部启动，非本扩展管理），请先接管（adopt）或在其原终端停止，或更换端口`
          : `端口 ${v.port} 已被其他程序占用`);
      }
    }
    // 解析启动器规范（根据 launchMode: global | npx | source 解析 exe, args, binPath, version）
    const launchSpec = resolveLaunchSpec(v);
    bin = launchSpec.binPath;
    version = launchSpec.version;
    v = { ...v, launchId: randomBytes(16).toString('hex'), launchStartedAt: Date.now() };
    readyWatch = watchReadiness();
    // 记录 spawn 时刻的日志字节偏移（LOG_FILE 可能尚不存在 -> 0）
    try { logStartBytes = fs.statSync(LOG_FILE).size; } catch (e) { logStartBytes = 0; }
    // Start the ONE deadline before spawn; carrier/discovery/readiness share it.
    const spawnStartedAt = Date.now();
    const timeoutMs = testTimeout('START', START_TIMEOUT_MS);
    const deadline = spawnStartedAt + timeoutMs;
    const phase = (name) => log(`start phase=${name} mode=${launchSpec.launchMode} elapsedMs=${Date.now() - spawnStartedAt}`);
    child = spawnDsh(launchSpec, v);
    phase('spawn');
    if (!child || !child.pid) {
      throw new AppError('INTERNAL', IS_WIN
        ? 'dsh 载体（wscript）启动失败，未获得进程'
        : 'dsh 子进程启动失败（未获得 PID）');
    }
    // M5.5 Windows：载体早退检查——wscript 2s 内非 0 退出即载体失败（VBS Run 报错）
    if (IS_WIN) {
      const early = await Promise.race([
        new Promise((res) => child.once('exit', (code) => res(code))),
        sleep(Math.max(0, Math.min(2000, deadline - Date.now()))).then(() => null),
      ]);
      if (early !== null && early !== 0) {
        throw new AppError('INTERNAL', 'dsh 载体（wscript）启动失败，请检查系统组件后重试');
      }
    }
    let verifiedReadinessPid = null;
    const readLaunchReadiness = (port) => {
      const expected = { ...v, port, binPath: bin };
      // Cheap lease checks first. Query a candidate's command only once, bounded by
      // the remaining launch budget; polling never repeats Windows tasklist.
      let signal = readReadiness(expected, true);
      if (signal && signal.pid !== verifiedReadinessPid) {
        const remaining = deadline - Date.now();
        if (remaining <= 0 || !pidLooksLikeDsh(signal.pid, bin, Math.min(5000, remaining))) return null;
        verifiedReadinessPid = signal.pid;
        signal = readReadiness({ ...expected, pid: verifiedReadinessPid }, true);
      }
      return signal;
    };
    let targetPort = v.port;
    if (v.port === 0) {
      targetPort = null;
      while (Date.now() < deadline) {
        const signal = readLaunchReadiness(0);
        targetPort = signal ? signal.port : discoverPortFromLog(logStartBytes);
        if (targetPort !== null) break;
        await readyWatch.wait(Math.max(1, Math.min(500, deadline - Date.now())));
      }
      if (targetPort === null) {
        phase('port-timeout');
        writeBestEffortRecord(v, bin, version, verifiedReadinessPid, 0, logStartBytes, adoptedReplay, child, launchSpec);
        throw new AppError('START_TIMEOUT', `dsh 在 ${Math.round(timeoutMs / 1000)} 秒内未报告动态端口（--port 0），进程已保留，请查看日志`, { needLogTail: true });
      }
      phase('port-discovered');
    }
    let readiness = null;
    let ready = false;
    while (Date.now() < deadline) {
      readiness = readLaunchReadiness(targetPort);
      if (readiness) ready = readiness.state === 'ready';
      else {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        ready = await httpProbe(targetPort, Math.min(1200, remaining));
      }
      if (ready && Date.now() <= deadline) break;
      ready = false;
      if (Date.now() >= deadline) break;
      await readyWatch.wait(Math.min(500, deadline - Date.now()));
    }
    if (!ready) {
      phase('ready-timeout');
      // Only verified PIDs can be retained for later management; never kill on timeout.
      writeBestEffortRecord(v, bin, version, verifiedReadinessPid, targetPort, logStartBytes, adoptedReplay, child, launchSpec);
      const extraTip = (launchSpec && launchSpec.launchMode === 'npx')
        ? '（NPX 模式首次运行需联网下载依赖，可能耗时较长）'
        : '';
      throw new AppError('START_TIMEOUT', `dsh 在 ${Math.round(timeoutMs / 1000)} 秒内未就绪（端口 ${targetPort} 无响应）${extraTip}，进程已保留，请查看日志`, { needLogTail: true });
    }
    phase('ready');
    // M5.5 Windows：端口就绪后反查真实 PID（载体链路下 wscript 的 pid 不是 dsh 的 pid）
    let pid = readiness ? readiness.pid : child.pid;
    if (IS_WIN && !readiness) {
      pid = await findPidByPortRetry(targetPort);
      if (!pid) {
        throw new AppError('INTERNAL', `dsh 已就绪（端口 ${targetPort}）但未能解析其 PID（端口表反查失败），实例已保留运行，请查看日志或手动停止`, { needLogTail: true });
      }
      log(`载体启动完成，dsh PID 经端口表反查: ${pid}`);
    }
    // 写 run 记录（原子）与冗余 pid 文件（锁内，M5.5）。
    // M13：写记录前捕获完整启动 URL 行（含 token query，§6.2/F5）——固定端口场景
    // URL 行在 loader settled 后才打印、可能晚于 HTTP 就绪，captureLaunchUrl 短重试
    // 兜底（5s）；动态端口场景端口行已出现，首次即命中。捕获失败不阻塞启动
    // （launchUrl=null，扩展回退裸 URL）。adopted 重放同样捕获本进程新打印的 URL
    // （新进程新 token，不是复制旧记录，§12.3）。
    phase('pid-resolved');
    const launchUrl = await captureLaunchUrl(logStartBytes, testTimeout('LAUNCH_URL', LAUNCH_URL_TIMEOUT_MS));
    phase(launchUrl ? 'url-captured' : 'url-unavailable');
    const rec = makeRunRecord(v, bin, version, pid, targetPort, logStartBytes, adoptedReplay, launchUrl, launchSpec);
    writeRunRecord(rec);
    writePidFile(pid);
    phase('record-written');
  } finally {
    if (readyWatch) readyWatch.close();
    releaseLock(); // M5.5：锁保持到记录写入完成（防启动窗口并发双开，design §6.3 第 7 步）
  }
  return buildResult('running', readRunRecord());
}

// M5.5：失败路径只保留可归属于本次启动的活 PID，不杀进程。
// A listener or identical argv can belong to an external launch. On Windows the
// carrier PID is NOT dsh: only a previously command-checked same-launch lease can
// prove ownership. POSIX has the directly spawned child PID. No unbounded process
// enumeration is allowed to extend the readiness deadline on the failure path.
function writeBestEffortRecord(v, bin, version, pid, port, logStartBytes, adoptedReplay, child, launchSpec = null) {
  const signal = IS_WIN && pid ? readReadiness({ ...v, pid, port, binPath: bin }, true) : null;
  const ownedPid = IS_WIN ? (signal && signal.pid) : (child && child.pid);
  if (!ownedPid || !pidAlive(ownedPid)) {
    log(`失败路径未能核验本次 dsh 进程（port=${port}）——进程未被终止，可在确认后显式「接管」`);
    return;
  }
  writeRunRecord(makeRunRecord(v, bin, version, ownedPid, signal ? signal.port : port,
    logStartBytes, adoptedReplay, null, launchSpec));
  writePidFile(ownedPid);
  log(`失败路径已回写核验记录 pid=${ownedPid} port=${signal ? signal.port : port}`);
}

// 端口表反查 + 一次 200ms 短重试（HTTP 就绪与 netstat 可见之间偶发亚毫秒延迟）
async function findPidByPortRetry(port) {
  let pid = findPidByPort(port);
  if (pid) return pid;
  await sleep(200);
  return findPidByPort(port);
}

// 构造 run 记录（M5.5：pid/port 在启动流程后期才确定——端口就绪 + 端口表反查后写入；
// 动态端口场景 port 恒为实际端口，不再有 0 占位期。
// M13：launchUrl = 完整启动 URL 行（含 token query，§6.2/F5/§12.3），未捕获为 null）
function makeRunRecord(v, bin, version, pid, port, logStartBytes, adoptedReplay, launchUrl = null, launchSpec = null) {
  const cmdline = launchSpec
    ? [launchSpec.exe, ...launchSpec.args].join(' ')
    : [process.execPath, bin, '--profile', v.profile, '--host', v.host, '--port', String(v.port), ...v.extraArgs].join(' ');
  return {
    pid,
    port,
    requestedPort: v.port,
    logStartBytes,
    host: v.host,
    profile: v.profile,
    launchMode: v.launchMode || 'global',
    customPath: v.customPath || '',
    startedAt: Date.now(),
    ...(v.launchId ? { launchId: v.launchId, launchStartedAt: v.launchStartedAt } : {}),
    version,
    binPath: bin,
    extraArgs: v.extraArgs,
    launchUrl,
    ...(adoptedReplay ? { adopted: true } : {}),
    cmdline,
  };
}

async function actionStart(payload) {
  // 1. 已 running -> ALREADY_RUNNING（幂等）
  const pre = await computeStatus();
  if (pre.state === 'running') {
    throw new AppError('ALREADY_RUNNING', 'dsh 已在运行（幂等）', { result: buildResult('running', pre.rec) });
  }
  // 2. payload 校验（host / port / profile / extraArgs 白名单，§12.1）
  const v = validateStartPayload(payload);
  // 3. 启动核心（内部抢锁 + spawn + 轮询）
  return startDshCore(v, false);
}

// 停止核心逻辑（stop / restart 共用）：
// 同身份 lease / 最多两次 health -> POST + 一次10s PID/端口等待；再复核并 force。
// 无插件或端口从未打开（starting）直接 force，不能把未监听误报为 graceful。
// 返回 { status: 'stopped'|'already-stopped', method: 'graceful'|'force' }。
async function stopCore(rec) {
  const locked = await acquireLock();
  if (!locked) throw new AppError('BUSY', '另一个操作正在进行，请稍后重试');
  const stopStartedAt = Date.now();
  const phase = name => log(`stop phase=${name} elapsedMs=${Date.now() - stopStartedAt}`);
  try {
    const rec2 = readRunRecord();
    if (rec2 && !sameRunIdentity(rec2, rec)) {
      throw new AppError('STOP_FAILED', '实例记录已被新的启动替换，拒绝停止或清理新实例', { needLogTail: true });
    }
    if (!rec2 || !pidAlive(rec2.pid)) {
      // Do not let a stale stop request delete a replacement launch or its lease.
      removeOwnedReadiness(rec);
      if (rec2) removeRunRecordSafe();
      return { status: 'already-stopped', method: 'force' };
    }
    if (!pidLooksLikeDsh(rec2.pid, rec2.binPath)) {
      throw new AppError('STOP_FAILED', `PID ${rec2.pid} 不是 dsh 进程（疑似 PID 已被复用），拒绝强制终止`, { needLogTail: true });
    }
    // A live same-launch lease already proves the lifecycle plugin is mounted.
    // Legacy/no-lease plugins get at most TWO health attempts in a bounded window.
    const readiness = readReadiness(rec2, true);
    if (readiness && rec2.port === 0) rec2.port = readiness.port;
    let pluginAvailable = !!readiness;
    const wasListening = pluginAvailable || (rec2.port > 0 && await portConnectable(rec2.port, 1200));
    if (!pluginAvailable && wasListening) {
      const healthDeadline = Date.now() + 3250;
      for (let attempt = 0; attempt < 2; attempt++) {
        const remaining = healthDeadline - Date.now();
        if (remaining <= 0) break;
        const health = await getHealth(rec2.port, Math.min(1500, remaining));
        // Old plugins may omit identity fields. If present, never accept a different PID/port.
        if (health && (health.pid === undefined || health.pid === rec2.pid)
          && (health.port === undefined || health.port === rec2.port)) {
          pluginAvailable = true;
          break;
        }
        if (attempt === 0 && Date.now() < healthDeadline) await sleep(Math.min(250, healthDeadline - Date.now()));
      }
    }
    phase(pluginAvailable ? 'plugin-confirmed' : 'plugin-unavailable');
    let method = 'force';
    let stopped = false;
    if (pluginAvailable) {
      const shutdownDeadline = Date.now() + testTimeout('STOP', 10000);
      await postShutdown(rec2.port, Math.max(1, Math.min(2000, shutdownDeadline - Date.now())));
      phase('shutdown-sent');
      stopped = await waitProcessStopped(rec2.pid, rec2.port, Math.max(0, shutdownDeadline - Date.now()), 200);
      if (stopped) method = 'graceful';
    }
    if (!stopped) {
      // No 3-second listener-only shortcut: only the shared disposal deadline
      // triggers force, with a fresh PID/record check immediately before killing.
      const current = readRunRecord();
      if (current && !sameRunIdentity(current, rec2)) {
        throw new AppError('STOP_FAILED', '实例记录已变更，拒绝强制终止', { needLogTail: true });
      }
      if (pidAlive(rec2.pid)) {
        if (!pidLooksLikeDsh(rec2.pid, rec2.binPath)) {
          throw new AppError('STOP_FAILED', `PID ${rec2.pid} 已不属于 dsh，拒绝强制终止`, { needLogTail: true });
        }
        const k = await terminateProcess(rec2.pid);
        if (!k.ok && pidAlive(rec2.pid)) {
          throw new AppError('STOP_FAILED', '强制终止执行失败: ' + (k.error || ('退出码 ' + k.code)), { needLogTail: true });
        }
        phase('forced');
      }
      method = 'force';
      stopped = await waitProcessStopped(rec2.pid, rec2.port, testTimeout('FORCE_STOP', 3000), 200);
    }
    if (!stopped) {
      throw new AppError('STOP_FAILED', `dsh 进程 ${rec2.pid} 或端口 ${rec2.port} 未退出`, { needLogTail: true });
    }
    const current = readRunRecord();
    if (current && !sameRunIdentity(current, rec2)) {
      throw new AppError('STOP_FAILED', '停止期间实例记录已变更，保留新记录', { needLogTail: true });
    }
    removeOwnedReadiness(rec2);
    removeRunRecord();
    phase('stopped-' + method);
    return { status: 'stopped', method };
  } finally {
    releaseLock();
  }
}

async function actionStop() {
  const { state, rec, external } = await computeStatus();
  if (state === 'external') {
    // 外部实例不属于本扩展管理范围，绝不 taskkill（design §6.3 stop / §6.6）
    throw new AppError('EXTERNAL_UNMANAGED', '检测到外部运行的 dsh web（非本扩展启动），扩展不接管停止；请在原终端停止它', { result: buildResult('external', null, external) });
  }
  if (state === 'stopped' || !rec) {
    throw new AppError('ALREADY_STOPPED', 'dsh 未在运行（幂等）', { result: buildResult('stopped', null) });
  }
  const r = await stopCore(rec);
  if (r.status === 'already-stopped') {
    throw new AppError('ALREADY_STOPPED', 'dsh 未在运行（幂等）', { result: buildResult('stopped', null) });
  }
  // M2：把 stop 方法写入结果 stopMethod（design §6.2/§6.3 stop 第 6 步）
  const result = buildResult('stopped', null);
  result.stopMethod = r.method;
  return result;
}

async function actionRestart(payload) {
  const { state, rec, external } = await computeStatus();
  if (state === 'external') {
    throw new AppError('EXTERNAL_UNMANAGED', '检测到外部运行的 dsh web（非本扩展启动），扩展不接管重启；请先接管（adopt）', { result: buildResult('external', null, external) });
  }
  if (state === 'stopped' || !rec) {
    // 未在运行：restart 退化为 start（按请求 payload）
    return actionStart(payload);
  }

  // 1. 【原子预检阶段（Pre-flight Check，先检后杀）】
  // 在杀掉旧进程前，先组装待重启参数，并调用 validateStartPayload 与 resolveLaunchSpec 进行预检。
  // 若新配置有误（如非法模式、路径不存在、源码缺少 bin 等），在此处直接抛错拒绝，旧服务 rec 绝不被杀！
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  let validatedParams;
  const isAdopted = rec.adopted === true;

  if (isAdopted) {
    const life = validateStartPayload({
      host: p.host !== undefined ? p.host : (rec.host || DEFAULT_HOST),
      port: p.port !== undefined ? p.port : rec.port,
      profile: p.profile !== undefined ? p.profile : (rec.profile || 'web'),
      launchMode: p.launchMode !== undefined ? p.launchMode : (rec.launchMode || 'global'),
      customPath: p.customPath !== undefined ? p.customPath : (rec.customPath || ''),
    });
    validatedParams = {
      ...life,
      extraArgs: filterAdoptedExtraArgs(Array.isArray(rec.extraArgs) ? rec.extraArgs : []),
    };
    resolveLaunchSpec(validatedParams); // 预检寻径，不通过立即抛错
  } else {
    const startPayload = {
      host: p.host !== undefined ? p.host : (rec.host || DEFAULT_HOST),
      // M4：--port 0 血统按动态端口语义重放（OS 重新分配），其余按记录端口
      port: p.port !== undefined ? p.port : (rec.requestedPort === 0 ? 0 : rec.port),
      profile: p.profile !== undefined ? p.profile : (rec.profile || 'web'),
      launchMode: p.launchMode !== undefined ? p.launchMode : (rec.launchMode || 'global'),
      customPath: p.customPath !== undefined ? p.customPath : (rec.customPath || ''),
      extraArgs: p.extraArgs !== undefined ? p.extraArgs : (Array.isArray(rec.extraArgs) ? rec.extraArgs : []),
    };
    validatedParams = validateStartPayload(startPayload);
    resolveLaunchSpec(validatedParams); // 预检寻径，不通过立即抛错
  }

  // 2. 【预检通过，安全停机】
  // 先 stop（含优雅尝试），等待端口关闭（最长 10s，stopCore 内部处理）
  await stopCore(rec);

  // 3. 【拉起新进程】
  return startDshCore(validatedParams, isAdopted);
}

// 外部实例接管（design §6.7）：pid+port 双重匹配 -> 回写 run 记录 -> running/managed
async function actionAdopt(payload) {
  const p = payload || {};
  const pid = Number(p.pid);
  const port = Number(p.port);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError('BAD_REQUEST', 'adopt 需要有效的 pid 与 port（取自 status 的 external 结果）');
  }
  const { state, rec, external } = await computeStatus();
  if (state === 'running' && rec) {
    throw new AppError('ALREADY_RUNNING', '已有本扩展管理的 dsh 在运行（幂等）', { result: buildResult('running', rec) });
  }
  if (state !== 'external') {
    throw new AppError('EXTERNAL_UNMANAGED', '未找到可接管的外部 dsh web 实例（请先打开 popup 刷新状态）');
  }
  // 重新发现并按 pid+port 双重精确匹配（防止 PID 复用/接错实例，§6.7）
  const all = await discoverExternalDsh();
  const target = all.find((e) => e.pid === pid && e.port === port);
  if (!target) {
    throw new AppError('EXTERNAL_UNMANAGED', `未找到 pid=${pid} port=${port} 的外部 dsh web 实例（实例可能已退出或端口漂移）`);
  }
  const locked = await acquireLock();
  if (!locked) throw new AppError('BUSY', '另一个操作正在进行，请稍后重试');
  try {
    // 锁内复查：目标进程仍存活且端口仍是 dsh 指纹（防竞态接管）
    if (!pidAlive(target.pid)) {
      throw new AppError('EXTERNAL_UNMANAGED', '目标进程已退出，无法接管');
    }
    if (!(await httpDshProbe(target.port, 1500))) {
      throw new AppError('EXTERNAL_UNMANAGED', '目标端口已不再是 dsh web（实例已变化），无法接管');
    }
    const info = parseAdoptInfo(target.cmdline);
    const bin = resolveDshBin();
    if (!bin) {
      throw new AppError('DSH_NOT_FOUND', '未检测到 dsh 安装，无法建立接管后的重启能力。请先执行 npm i -g @deepseek-ai/dsh');
    }
    const version = getDshVersion(bin);
    const rec2 = {
      pid: target.pid,
      port: target.port,
      host: info.host,
      profile: info.profile,
      startedAt: Date.now(), // 接管时刻（真实启动时刻未知，§6.7）
      version,
      binPath: bin,
      extraArgs: info.extraArgs,
      adopted: true,
      cmdline: [process.execPath, bin, '--profile', info.profile, '--host', info.host, '--port', String(target.port), ...info.extraArgs].join(' '),
    };
    writeRunRecord(rec2);
    writePidFile(target.pid);
  } finally {
    releaseLock();
  }
  return buildResult('running', readRunRecord());
}

// M3 日志查看（design §6.3 logs）：读日志文件尾部或指定偏移之前的一段（只读，无锁）。
//   tailLines  返回的最后 N 行（1..2000，默认 500；仅尾部块生效）
//   maxBytes   单块最大字节数（1KB..1MB，默认 256KB）
//   beforeByte 可选非负整数：返回结束于该偏移的前一段（「加载更早」分页）；
//              缺省或 >= 文件大小时为尾部块
// 返回 { exists, path, sizeBytes, fromByte, toByte, hasMore, tailLines, tail }。
// 字节偏移精确（UTF-8 计字节），行边界对齐：跨块的首/尾不完整行被丢弃，
// 保证每块内容都是完整行；相邻块严格衔接（前块 toByte === 后块 fromByte）。
function actionLogs(payload) {
  const p = payload || {};
  let tailLines = p.tailLines !== undefined ? p.tailLines : LOGS_DEFAULT_TAIL_LINES;
  if (typeof tailLines !== 'number' || !Number.isInteger(tailLines) || tailLines < 1 || tailLines > LOGS_MAX_TAIL_LINES) {
    throw new AppError('BAD_REQUEST', `tailLines 必须是 1-${LOGS_MAX_TAIL_LINES} 的整数（收到: ${JSON.stringify(p.tailLines)}）`);
  }
  let maxBytes = p.maxBytes !== undefined ? p.maxBytes : LOGS_DEFAULT_MAX_BYTES;
  if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes < LOGS_MIN_MAX_BYTES || maxBytes > LOGS_MAX_MAX_BYTES) {
    throw new AppError('BAD_REQUEST', `maxBytes 必须是 ${LOGS_MIN_MAX_BYTES}-${LOGS_MAX_MAX_BYTES} 的整数（收到: ${JSON.stringify(p.maxBytes)}）`);
  }
  if (p.beforeByte !== undefined
    && (typeof p.beforeByte !== 'number' || !Number.isInteger(p.beforeByte) || p.beforeByte < 0)) {
    throw new AppError('BAD_REQUEST', `beforeByte 必须是非负整数（收到: ${JSON.stringify(p.beforeByte)}）`);
  }
  const beforeByte = p.beforeByte;

  const emptyOf = (size) => ({
    exists: true, path: LOG_FILE, sizeBytes: size, fromByte: 0, toByte: 0, hasMore: false, tailLines: 0, tail: '',
  });
  let stat;
  try {
    stat = fs.statSync(LOG_FILE);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { exists: false, path: LOG_FILE, sizeBytes: 0, fromByte: 0, toByte: 0, hasMore: false, tailLines: 0, tail: '' };
    }
    throw err;
  }
  const size = stat.size;
  if (!Number.isInteger(size) || size <= 0) return emptyOf(0);

  // 定位区间 [start, end)（end 不含）；beforeByte >= size 按尾部块处理
  const isTail = beforeByte === undefined || beforeByte >= size;
  if (!isTail && beforeByte <= 0) return emptyOf(size);
  const start = isTail ? Math.max(0, size - maxBytes) : Math.max(0, Math.min(beforeByte, size) - maxBytes);
  const end = isTail ? size : Math.min(beforeByte, size);

  // 精确读取 [bufStart, end)：start>0 时多读 start-1 处 1 字节用于行边界判定
  const bufStart = start > 0 ? start - 1 : 0;
  let buf = Buffer.alloc(0);
  let fd;
  try {
    fd = fs.openSync(LOG_FILE, 'r');
    const len = end - bufStart;
    buf = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const n = fs.readSync(fd, buf, off, len - off, bufStart + off);
      if (n <= 0) break;
      off += n;
    }
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (e) { /* 忽略 */ }
    }
  }
  if (buf.length === 0) return emptyOf(size);

  // 头部对齐（buf 从 bufStart 起）：
  //   start 前一字节是 \n（buf[0]===0x0a）→ 内容恰从行首开始，跳过该 \n 即可；
  //   否则 start 落在行中间 → 丢弃至第一个 \n 的不完整行；找不到 \n → 整块同属一行
  //   （head=0，midLine=true，由中间块分支按空块处理）。
  let head = 0;
  let midLine = false;
  if (start > 0) {
    if (buf[0] === 0x0a) {
      head = 1;
    } else {
      midLine = true;
      const nl = buf.indexOf(0x0a, 1);
      if (nl >= 0) head = nl + 1;
    }
  }
  let text = buf.subarray(head).toString('utf8');
  let fromByte = bufStart + head;

  const countLines = (t) => (t === '' ? 0 : t.split('\n').length - (t.endsWith('\n') ? 1 : 0));

  if (isTail) {
    // 尾部块：按 tailLines 截断最早的若干行（按字节精确计算 fromByte）。
    // 行数 = split('\n') 长度 - 末尾空串（text 以 \n 结尾时多出一个空元素）
    const parts = text.split('\n');
    const realLines = parts.length - (parts[parts.length - 1] === '' ? 1 : 0);
    if (realLines > tailLines) {
      const keep = realLines - tailLines;
      let idx = 0;
      for (let i = 0; i < keep; i++) idx += parts[i].length + 1;
      fromByte += Buffer.byteLength(text.slice(0, idx), 'utf8');
      text = text.slice(idx);
    }
    return {
      exists: true, path: LOG_FILE, sizeBytes: size,
      fromByte, toByte: size, hasMore: fromByte > 0,
      tailLines: countLines(text), tail: text,
    };
  }

  // 中间块：整块同属一行（midLine 且未找到 \n）→ 空块并推进到 end（该行会在更新的块中完整出现）
  if (midLine && head === 0) {
    return {
      exists: true, path: LOG_FILE, sizeBytes: size,
      fromByte: end, toByte: end, hasMore: end > 0, tailLines: 0, tail: '',
    };
  }

  // 中间块：丢弃尾部不完整行（该行的前半部分在更新的块里），toByte 按字节精确
  let toByte = end;
  if (end < size && text.length > 0) {
    const lastNl = text.lastIndexOf('\n');
    if (lastNl >= 0) {
      toByte = fromByte + Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8');
      text = text.slice(0, lastNl + 1);
    } else {
      // 整块都是同一行的不完整尾部（该行跨入更新的块）→ 空块并推进到 end
      return {
        exists: true, path: LOG_FILE, sizeBytes: size,
        fromByte: end, toByte: end, hasMore: end > 0, tailLines: 0, tail: '',
      };
    }
  }
  return {
    exists: true, path: LOG_FILE, sizeBytes: size,
    fromByte, toByte, hasMore: fromByte > 0,
    tailLines: countLines(text), tail: text,
  };
}

// M9 会话摘要（design §8.10）：只读、无锁——读取 dsh-lifecycle 插件端点
// /_manager/sessions（1.5s 超时）。不可用即降级：无 run 记录或端点不可达
// 一律返回 { available:false, items:[] }，绝不抛错（会话区由扩展侧隐藏/提示，
// 不阻断其余功能）。
const SESSIONS_MAX_ITEMS = 50; // live 会话防御性上限（实际为个位数~几十）

async function actionSessions() {
  const rec = readRunRecord();
  if (!rec || typeof rec.port !== 'number') {
    return { available: false, items: [] };
  }
  const list = await getManagerSessions(rec.port, 1500);
  if (list === null) return { available: false, items: [] };
  return { available: true, items: list.slice(0, SESSIONS_MAX_ITEMS) };
}

// ---------------------------------------------------------------------------
// 请求处理入口（两种模式共用）
// ---------------------------------------------------------------------------
async function handleRequest(req) {
  const id = req && typeof req === 'object' && !Array.isArray(req) && 'id' in req ? req.id : null;
  if (!req || typeof req !== 'object' || Array.isArray(req)) {
    return { id, ok: false, result: null, error: { code: 'BAD_REQUEST', message: '请求必须是 JSON 对象' } };
  }
  if (typeof req.action !== 'string' || !ACTIONS.includes(req.action)) {
    return { id, ok: false, result: null, error: { code: 'BAD_REQUEST', message: `非法 action: ${JSON.stringify(req.action)}（允许: ${ACTIONS.join('|')}）` } };
  }
  const payload = req.payload === undefined || req.payload === null ? {} : req.payload;
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return { id, ok: false, result: null, error: { code: 'BAD_REQUEST', message: 'payload 必须是对象' } };
  }
  try {
    let result;
    switch (req.action) {
      case 'ping': result = await actionPing(); break;
      case 'status': result = await actionStatus(); break;
      case 'start': result = await actionStart(payload); break;
      case 'stop': result = await actionStop(); break;
      case 'restart': result = await actionRestart(payload); break;
      case 'adopt': result = await actionAdopt(payload); break;
      case 'logs': result = actionLogs(payload); break;
      case 'sessions': result = await actionSessions(); break;
      default:
        return { id, ok: false, result: null, error: { code: 'BAD_REQUEST', message: '非法 action: ' + req.action } };
    }
    return { id, ok: true, result, error: null };
  } catch (err) {
    if (err instanceof AppError) {
      const e = { code: err.code, message: redactTokens(err.message) };
      if (err.needLogTail || NEEDS_LOG_TAIL.has(err.code)) e.logTail = readLogTail();
      return { id, ok: false, result: err.result !== undefined ? err.result : null, error: e };
    }
    // 未预期异常 -> INTERNAL（含 message 与 stack 摘要 + logTail）
    const stack = err && err.stack ? String(err.stack) : '';
    log('未预期异常: ' + stack);
    const summary = stack.split(/\r?\n/).slice(0, 3).join(' | ');
    const message = (err && err.message ? String(err.message) : String(err)) + ' @ ' + summary;
    return { id, ok: false, result: null, error: { code: 'INTERNAL', message: redactTokens(message), logTail: readLogTail() } };
  }
}

// ---------------------------------------------------------------------------
// stdio 模式：帧读写 + 看门狗
// ---------------------------------------------------------------------------
const stdinIterator = process.stdin[Symbol.asyncIterator]();
let pendingBuf = Buffer.alloc(0);
let stdinEof = false;

// 精确读取 n 字节；EOF 返回 null
async function readExactly(n) {
  while (pendingBuf.length < n) {
    if (stdinEof) return null;
    const { value, done } = await stdinIterator.next();
    if (done) {
      stdinEof = true;
      return null;
    }
    pendingBuf = Buffer.concat([pendingBuf, value]);
  }
  const out = Buffer.from(pendingBuf.subarray(0, n)); // 复制，避免与保留缓冲共享内存
  pendingBuf = pendingBuf.subarray(n);
  return out;
}

// 读一帧：4 字节 LE 长度前缀 + JSON 载荷；EOF 返回 null
async function readFrame() {
  const header = await readExactly(4);
  if (header === null) return null; // 干净 EOF
  const len = header.readUInt32LE(0);
  if (len > MAX_MSG_BYTES) {
    const err = new Error(`帧长度 ${len} 超过上限 ${MAX_MSG_BYTES} 字节，直接断开`);
    err.isFrameTooLarge = true;
    throw err;
  }
  if (len === 0) throw new Error('空帧（长度 0）');
  const body = await readExactly(len);
  if (body === null) throw new Error('帧被截断（EOF 提前出现）');
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (err) {
    err.isBadJson = true;
    throw err;
  }
}

// 写一帧到 stdout（协议唯一出口）
function writeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(header);
  process.stdout.write(body);
}

// 15 秒无消息看门狗（timer.unref，不阻止事件循环自然退出）
let watchdog = null;
function armWatchdog() {
  if (watchdog) clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    log('15 秒无消息，看门狗退出');
    process.exit(0);
  }, WATCHDOG_MS);
  if (watchdog.unref) watchdog.unref();
}
function disarmWatchdog() {
  if (watchdog) {
    clearTimeout(watchdog);
    watchdog = null;
  }
}

async function stdioMode() {
  armWatchdog();
  try {
    for (;;) {
      let req;
      try {
        req = await readFrame();
      } catch (err) {
        if (err && err.isFrameTooLarge) {
          log(err.message);
          process.exit(1); // 入站长度超限：直接断开，不写响应
        }
        if (err && err.isBadJson) {
          log('请求 JSON 解析失败: ' + err.message);
          writeFrame({ id: null, ok: false, result: null, error: { code: 'BAD_REQUEST', message: '请求 JSON 解析失败: ' + err.message } });
          armWatchdog();
          continue;
        }
        throw err;
      }
      if (req === null) break; // stdin end/close -> 退出
      disarmWatchdog(); // 在途 start/restart 可超过15s；仅空闲读帧时武装
      const resp = await handleRequest(req);
      writeFrame(resp);
      armWatchdog(); // 响应写完后重新武装
    }
  } catch (err) {
    log('stdio 模式异常: ' + (err && err.stack || err));
    process.exit(1);
  }
  log('stdin EOF，正常退出');
  // 不调用 process.exit：让事件循环自然清空（stdout 冲刷完成后退出）
}

// ---------------------------------------------------------------------------
// 文件模式（测试用）：node host.js --req <in.json> --res <out.json>
// ---------------------------------------------------------------------------
async function fileMode() {
  const argv = process.argv.slice(2);
  const reqIdx = argv.indexOf('--req');
  const resIdx = argv.indexOf('--res');
  const reqPath = reqIdx >= 0 ? argv[reqIdx + 1] : undefined;
  const resPath = resIdx >= 0 ? argv[resIdx + 1] : undefined;
  if (!reqPath || !resPath) {
    log('文件模式用法: node host.js --req <in.json> --res <out.json>');
    process.exit(2);
  }
  let input;
  try {
    input = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
  } catch (err) {
    const out = { id: null, ok: false, result: null, error: { code: 'BAD_REQUEST', message: '输入文件无法解析: ' + (err && err.message) } };
    fs.writeFileSync(resPath, JSON.stringify(out, null, 2), 'utf8');
    log('输入文件解析失败: ' + (err && err.message));
    process.exit(0);
  }
  const isArray = Array.isArray(input);
  const list = isArray ? input : [input];
  const responses = [];
  for (const r of list) {
    try {
      responses.push(await handleRequest(r));
    } catch (err) {
      // handleRequest 理论上不抛；这里兜底
      const stack = err && err.stack ? String(err.stack) : '';
      log('文件模式处理异常: ' + stack);
      responses.push({
        id: null,
        ok: false,
        result: null,
        error: {
          code: 'INTERNAL',
          message: String(err && err.message || err) + ' @ ' + stack.split(/\r?\n/).slice(0, 3).join(' | '),
          logTail: readLogTail(),
        },
      });
    }
  }
  const out = isArray ? responses : responses[0];
  fs.writeFileSync(resPath, JSON.stringify(out, null, 2), 'utf8');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  const isFileMode = argv.includes('--req') || argv.includes('--res');
  if (isFileMode) {
    fileMode().catch((err) => {
      log('文件模式致命错误: ' + (err && err.stack || err));
      process.exit(1);
    });
  } else {
    stdioMode().catch((err) => {
      log('stdio 模式致命错误: ' + (err && err.stack || err));
      process.exit(1);
    });
  }
}

// 全局兜底：任何未捕获异常都只写 stderr，绝不污染 stdout 协议流
process.on('uncaughtException', (err) => {
  log('uncaughtException: ' + (err && err.stack || err));
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log('unhandledRejection: ' + (reason && reason.stack || reason));
  process.exit(1);
});

main();
