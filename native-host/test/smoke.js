'use strict';
// ============================================================================
// smoke.js — Whalekeeper 宿主冒烟测试（native-host/test/）
//
// 运行方式（沙箱内，文件传输模式，无管道捕获）：
//   node native-host/test/smoke.js
//
// 原理：
//   - 每次请求写一个请求 JSON 文件，以 spawnSync(stdio:'inherit') 拉起
//     `node host.js --req <in.json> --res <out.json>`（host.js 文件模式），
//     同步等待结束后读取响应文件并断言；
//   - 伪 dsh 由 host.js 通过 DSH_BIN_STUB 环境变量拉起（fake-dsh.js）；
//   - 状态目录 DSH_MANAGER_BASE_DIR 指向 <项目根>\.smoke（工作区内）；
//   - DSH_MANAGER_PID_CHECK=0 关闭 PID 命令行校验（tasklist 管道在本沙箱受限）。
//
// 环境注意：danger-full-access / 沙箱外运行时 real powershell/netstat 枚举可用；
//   BASE_ENV 默认注入 DSH_MANAGER_FAKE_PROCESSES='[]' 屏蔽真实枚举（本 DSH 会话自带
//   127.0.0.1:8080 真实 dsh web，会让「空目录→stopped」误报 external），
//   外部发现场景 15-19 在各自 extraEnv 覆盖为自己的假进程表，不受影响。
//
// 场景（端口 31901-31923，1 基索引）：
//   1  ping -> ok
//   2  status 空目录 -> stopped
//   3  start -> starting|running，run 记录存在
//   4  再 start -> ALREADY_RUNNING
//   5  status -> running 且 pid/port 正确
//   6  restart -> running 且 pid 变化
//   7  stop -> stopped，端口关闭，记录清除，fake-dsh 进程退出
//   8  再 stop -> ALREADY_STOPPED
//   9  端口占用（本进程监听）-> start -> PORT_BUSY
//   10 非法 action 与 extraArgs 含 --host 0.0.0.0 / payload.host=0.0.0.0 -> BAD_REQUEST
//   11 锁竞争：手工创建 run\host.lock -> start -> BUSY；删除后重试成功
//   12 残留清理：手写 run\dsh-web.json 指向死 pid（999999）-> status -> stopped 且记录被清
//   13 START_TIMEOUT：DSH_FAKE_EXIT_IMMEDIATELY=1 变体 -> START_TIMEOUT 且 error.logTail 存在
//   14 优雅停路径：start 后 stop -> 日志含 SHUTDOWN-RECEIVED（说明走 POST /_lifecycle/shutdown）
//   15 外部实例检测：外部 fake-dsh + DSH_MANAGER_FAKE_PROCESSES 注入 -> status external
//      （pid/port/url/source/startedAt=null）；stop/restart -> EXTERNAL_UNMANAGED；
//      start 同端口 -> PORT_BUSY 且提示外部 dsh；双实例 -> externalCount=2；
//      外部实例退出后 -> stopped
//   16 --port 0 动态端口：FAKE_PROCESSES(--port 0) + FAKE_LISTENERS -> external 且端口解析正确
//   17 负例：指纹不匹配 / 非 dsh 命令行 / 死 pid 候选 -> 一律 stopped 不误报
//   18 managed 优先：run 记录存在时发现不参与，source=managed
//   19 接管（adopt）：status external -> adopt 错误 pid 拒绝 -> adopt 正确 pid+port
//      -> running/managed 且 run 记录正确（adopted/profile/extraArgs 保留）-> 再 adopt
//      幂等 ALREADY_RUNNING -> restart 按原 argv 重放（pid 变化、adopted 消失）->
//      stop -> 无外部实例时 adopt 拒绝
//   20 M2 富状态：start 后 status -> lifecycle===true、health.ok/pid/port 正确
//   21 M2 优雅停：stop -> stopMethod==='graceful' 且日志含 SHUTDOWN-RECEIVED
//   22 M2 无插件降级：DSH_FAKE_NO_LIFECYCLE=1 变体 -> status lifecycle===false、
//      health===null；stop -> stopMethod==='force'（taskkill；若环境拦截则记 SKIP）
//   23 M2 restart 语义：插件存在时 restart -> start 语义（running、pid 变化），
//      不上报 stopMethod
//   24 M3 日志查看（logs 动作）：无日志文件 -> exists:false；8000 行编号日志
//      （含中文）尾部读取（tailLines 上限语义/maxBytes/toByte===size/hasMore）->
//      beforeByte 逐块分页（块间严格衔接、分页到底 fromByte=0）-> 全量重建行数与
//      首尾行正确（行边界对齐：每块首行为完整行）-> 非法 tailLines/maxBytes/beforeByte
//      -> BAD_REQUEST -> beforeByte>=size 按尾部块、beforeByte=0 空块 -> 定宽行文件
//      （每行 50 字节）：块起点恰在行边界时首行不丢、fromByte 精确、分页到底
//      全量重建逐字节等于原文
//   25 M4 --port 0 动态端口：start -> running 且实际端口从日志 URL 行回填
//      （run 记录 requestedPort=0/logStartBytes/port=实际）-> status 一致 ->
//      restart 再次发现且 pid 变化 -> stop 无残留 -> port=-1/70000 -> BAD_REQUEST
//      -> 动态端口未报告 -> START_TIMEOUT -> 死 pid 残留记录被 status 清理
//   27 M5.5 Windows 隐藏控制台载体：start -> run 记录 pid 为端口表反查的真实进程
//      （非载体 wscript 的 pid）且存活 -> status 一致 -> restart pid 变化 ->
//      stop 优雅 -> 记录清除（POSIX 记 SKIP：无载体，直接 spawn）
//   28 M9 会话摘要（sessions 动作）：无 run 记录 -> available:false；
//      start（DSH_FAKE_SESSIONS 注入两态会话）-> sessions -> available:true 且
//      items 原样透传；DSH_FAKE_NO_MANAGER=1（插件未装，SPA 200 非 JSON）->
//      available:false（降级不抛错）
//   29 M13 认证兼容（DSH_FAKE_AUTH=1 模拟 dsh ≥ 0.1.2 启动令牌认证，§2.1.1 B1）：
//      start（auth）-> running（httpProbe 对 401 视为就绪）；run 记录与 status
//      携带 launchUrl（含 token，url 保持裸 URL）；stop 优雅不受影响；
//      FAKE-REQ 打点断言探测请求无 Accept-Encoding（§2.1.1 B2）；外部 auth 实例
//      经 /manifest.webmanifest 指纹发现 -> external；start 同端口 -> PORT_BUSY
//      且提示外部 dsh
//
// 确定性：BASE_ENV 默认注入 DSH_MANAGER_FAKE_PROCESSES='[]' 屏蔽真实进程枚举
//（本机常驻真实 dsh web 8080 会让 2/8/12 等「空目录」场景误报 external）；
// 外部发现场景（15-19）在各自 extraEnv 中覆盖为自己的假进程表，不受影响。
//   20 M2 健康探测：start 后 status -> lifecycle===true、health.ok===true、
//      health.pid===fake-dsh pid、health.port===端口
//   21 M2 优雅停止：start 后 stop -> result.stopMethod==='graceful'（日志 SHUTDOWN-RECEIVED 保持）
//   22 M2 无插件降级：DSH_FAKE_NO_LIFECYCLE=1 变体 start -> status lifecycle===false、
//      health===null；stop -> stopMethod==='force'（taskkill 被拦截时记 SKIP，不失败退出）
//   23 M2 插件存在时 restart -> 返回 start 语义（state running、pid 变化），无回归
//
// 每场景结束强制清理：残留 fake-dsh 用 taskkill /PID <pid> /T /F 兜底；
// 清理 .smoke 与临时请求/响应文件。
// ============================================================================

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HOST_JS = path.join(ROOT, 'native-host', 'host.js');
const FAKE_DSH = path.join(__dirname, 'fake-dsh.js');
const BASE = path.join(ROOT, '.smoke'); // DSH_MANAGER_BASE_DIR（工作区内）
const TMP = path.join(BASE, 'tmp');
const IS_WIN = process.platform === 'win32';

// 平台无关的强制清理（M4：Linux/WSL 下无 taskkill，用 SIGKILL 进程组兜底）
function killPidForce(pid) {
  if (IS_WIN) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch (_) {
    try { process.kill(pid, 'SIGKILL'); } catch (__) { /* 已退出 */ }
  }
}

const BASE_ENV = {
  // 测试钩子门控：TEST_MODE=1 才让 DSH_MANAGER_* 钩子生效（主机 host.js 门控）
  DSH_MANAGER_TEST_MODE: '1',
  DSH_MANAGER_BASE_DIR: BASE,
  DSH_BIN_STUB: FAKE_DSH,
};
// Windows：默认围栏真实进程枚举 + 关闭 PID 命令行校验——
//   本机常驻真实 dsh web（127.0.0.1:8080）会让「空目录→stopped」类场景误报 external，
//   tasklist 管道在受限沙箱亦曾受限。
// POSIX（WSL Kali 等）：不设围栏、不关 PID 校验——让真实 /proc 枚举、/proc/net/tcp
//   端口表与 /proc PID 校验直接参与冒烟（design §6.8 平台层实测）。
if (IS_WIN) {
  BASE_ENV.DSH_MANAGER_FAKE_PROCESSES = '[]';
  BASE_ENV.DSH_MANAGER_PID_CHECK = '0';
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const results = [];

function record(cat, name, ok, detail) {
  results.push({ cat, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${cat} | ${name}${detail ? ' | ' + detail : ''}`);
}

// SKIP：明确记录但不算进 fail（仅用于场景 22 的 taskkill 被环境拦截这一允许情形）
function recordSkip(cat, name, detail) {
  results.push({ cat, name, ok: true, skip: true, detail });
  console.log(`SKIP | ${cat} | ${name}${detail ? ' | ' + detail : ''}`);
}

function expect(cond, name, detail) {
  record('场景', name, !!cond, detail);
  if (!cond) throw new Error(`${name} 断言失败: ${detail}`);
}

function readRunFile() {
  try {
    return JSON.parse(fs.readFileSync(path.join(BASE, 'run', 'dsh-web.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

function portOpen(port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch (_) {} resolve(v); } };
    sock.setTimeout(timeoutMs || 800);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 轮询等待端口打开（外部 fake-dsh 就绪判定）
async function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await portOpen(port, 500)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(150);
  }
}

// 轮询等待进程退出
async function waitPidGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!pidAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(150);
  }
}

// 以「外部方式」直接拉起 fake-dsh（模拟用户在终端手工启动，不经宿主、无 run 记录）
function spawnExtFakeDsh(port) {
  return spawn(process.execPath, [FAKE_DSH, '--port', String(port)], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
}

// 优雅终止外部 fake-dsh：POST /_lifecycle/shutdown（沙箱内 taskkill 被禁，见 VERIFICATION §4）
function shutdownExternal(port) {
  return new Promise((resolve) => {
    let req;
    try {
      req = http.request({
        host: '127.0.0.1',
        port,
        path: '/_lifecycle/shutdown',
        method: 'POST',
        headers: { 'Content-Length': '0', Connection: 'close' },
        timeout: 2000,
        agent: false,
      }, (res) => { res.resume(); resolve(); });
      req.on('timeout', () => { try { req.destroy(); } catch (_) { /* 忽略 */ } resolve(); });
      req.on('error', () => resolve());
      req.end();
    } catch (_) {
      resolve();
    }
  });
}

// 构造一条「像真实 dsh web 启动」的命令行（供 DSH_MANAGER_FAKE_PROCESSES 注入）
function fakeDshCmdline(portArg) {
  return '"C:\\Program Files\\nodejs\\node.exe"  "<user>\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" --profile web --host 127.0.0.1 --port ' + portArg;
}

// 调用宿主（文件模式）。extraEnv 追加到宿主环境（透传给 fake-dsh）。
function runHost(req, tag, extraEnv) {
  fs.mkdirSync(TMP, { recursive: true });
  const reqPath = path.join(TMP, `req-${tag}.json`);
  const resPath = path.join(TMP, `res-${tag}.json`);
  try { fs.unlinkSync(resPath); } catch (_) {}
  fs.writeFileSync(reqPath, JSON.stringify(req), 'utf8');
  const r = spawnSync(process.execPath, [HOST_JS, '--req', reqPath, '--res', resPath], {
    stdio: 'inherit',
    env: Object.assign({}, process.env, BASE_ENV, extraEnv || {}),
  });
  if (r.error) return { spawnError: String(r.error.message || r.error) };
  if (r.status !== 0) return { spawnError: '宿主退出码 ' + r.status };
  try {
    return JSON.parse(fs.readFileSync(resPath, 'utf8'));
  } catch (e) {
    return { spawnError: '响应文件缺失或不可解析: ' + e.message };
  }
}

// 强制清理：kill 残留 fake-dsh（按 run 记录 pid + 额外 pid），删除 .smoke
function cleanup(extraPids) {
  const rec = readRunFile();
  const pids = new Set(Array.isArray(extraPids) ? extraPids : []);
  if (rec && Number.isInteger(rec.pid) && rec.pid > 0) pids.add(rec.pid);
  for (const pid of pids) {
    killPidForce(pid);
  }
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) {}
}

// ---------------------------------------------------------------------------
// 静态核对：manifest key 独立计算扩展 ID + 全部 JSON 可解析
// ---------------------------------------------------------------------------
function staticChecks() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
    const key = manifest.key.trim();
    const der = Buffer.from(key, 'base64');
    const digest = crypto.createHash('sha256').update(der).digest().subarray(0, 16);
    let id = '';
    for (const b of digest) id += String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15));

    // 本地产物（EXTENSION_ID.txt / extension-key.json / .extension-id.json）由
    // install.ps1/keygen.js 现场生成且不入库：存在时核对一致性，缺失时记 SKIP
    // （全新克隆没有这些文件，不构成失败）。
    const txtPath = path.join(ROOT, 'EXTENSION_ID.txt');
    if (fs.existsSync(txtPath)) {
      const txtId = fs.readFileSync(txtPath, 'utf8').trim();
      record('静态', 'manifest key 独立计算 ID === EXTENSION_ID.txt', id === txtId, `computed=${id} txt=${txtId}`);
    } else {
      recordSkip('静态', 'manifest key 独立计算 ID === EXTENSION_ID.txt', 'EXTENSION_ID.txt 不存在（全新克隆，本地产物跳过）');
    }
    const extKeyPath = path.join(ROOT, 'extension', 'extension-key.json');
    if (fs.existsSync(extKeyPath)) {
      const extKeyJson = JSON.parse(fs.readFileSync(extKeyPath, 'utf8'));
      record('静态', 'extension-key.json id === 计算 ID', extKeyJson.id === id, extKeyJson.id);
      record('静态', 'extension-key.json key === manifest key', extKeyJson.key === key, '');
    } else {
      recordSkip('静态', 'extension-key.json 一致性核对', 'extension-key.json 不存在（全新克隆，本地产物跳过）');
    }
    const dotIdPath = path.join(ROOT, 'native-host', '.extension-id.json');
    if (fs.existsSync(dotIdPath)) {
      const dotIdJson = JSON.parse(fs.readFileSync(dotIdPath, 'utf8'));
      record('静态', 'native-host/.extension-id.json === 计算 ID', dotIdJson.extensionId === id, dotIdJson.extensionId);
    } else {
      recordSkip('静态', 'native-host/.extension-id.json === 计算 ID', '.extension-id.json 不存在（全新克隆，本地产物跳过）');
    }
    record('静态', 'ID 字符集 [a-p]{32}', /^[a-p]{32}$/.test(id), id);

    // M4 Firefox：manifest 声明 gecko id，且宿主模板 allowed_extensions 同时含
    // Chrome 扩展 ID 与 Firefox 附加组件 ID（Firefox 用 allowed_extensions 校验）
    const geckoId = manifest.browser_specific_settings && manifest.browser_specific_settings.gecko
      ? manifest.browser_specific_settings.gecko.id : null;
    record('静态', 'manifest 声明 gecko id（Firefox）', !!geckoId && /^[A-Za-z0-9_.@-]+$/.test(geckoId), String(geckoId));
    try {
      const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'native-host', 'com.dsh.manager.json.template'), 'utf8'));
      record('静态', '宿主模板 allowed_extensions 含 Chrome ID 与 gecko id',
        Array.isArray(tpl.allowed_extensions)
        && tpl.allowed_extensions.includes('__EXTENSION_ID__')
        && tpl.allowed_extensions.includes('__GECKO_ID__'),
        JSON.stringify(tpl.allowed_extensions));
    } catch (e) {
      record('静态', '宿主模板 allowed_extensions 含 Chrome ID 与 gecko id', false, e.message);
    }

    // 全部 JSON 可解析（仅入库文件；本地产物存在时追加核对）
    const jsonFiles = [
      path.join(ROOT, 'extension', 'manifest.json'),
      path.join(ROOT, 'native-host', 'com.dsh.manager.json.template'),
    ];
    if (fs.existsSync(extKeyPath)) jsonFiles.push(extKeyPath);
    if (fs.existsSync(dotIdPath)) jsonFiles.push(dotIdPath);
    for (const f of jsonFiles) {
      try { JSON.parse(fs.readFileSync(f, 'utf8')); record('静态', 'JSON 可解析: ' + path.relative(ROOT, f), true, ''); }
      catch (e) { record('静态', 'JSON 可解析: ' + path.relative(ROOT, f), false, e.message); }
    }
  } catch (e) {
    record('静态', '扩展 ID / JSON 核对', false, String(e.message || e));
  }
}

// ---------------------------------------------------------------------------
// 23 个场景
// ---------------------------------------------------------------------------
async function scenarioPing() {
  const resp = runHost({ id: 's1', action: 'ping', payload: {} }, 's1');
  expect(resp && resp.ok === true, '1 ping -> ok', JSON.stringify(resp));
  expect(resp.result && resp.result.hostVersion === '0.1.0', '1 ping 返回 hostVersion', resp.result && resp.result.hostVersion);
  expect(resp.result && resp.result.dshBin === FAKE_DSH, '1 ping dshBin 为 stub', resp.result && resp.result.dshBin);
}

function scenarioStatusEmpty() {
  const resp = runHost({ id: 's2', action: 'status', payload: {} }, 's2');
  expect(resp && resp.ok === true && resp.result.state === 'stopped', '2 status 空目录 -> stopped', JSON.stringify(resp));
}

async function scenarioLifecycle() {
  // S3 start
  const s3 = runHost({ id: 's3', action: 'start', payload: { port: 31903 } }, 's3');
  expect(s3 && s3.ok === true && (s3.result.state === 'starting' || s3.result.state === 'running'),
    '3 start -> starting|running', JSON.stringify(s3));
  const rec3 = readRunFile();
  expect(rec3 && Number.isInteger(rec3.pid) && rec3.port === 31903, '3 run 记录存在且 pid/port 正确',
    rec3 ? JSON.stringify(rec3) : 'run 记录缺失');
  const pid3 = rec3.pid;

  // S4 再 start -> ALREADY_RUNNING
  const s4 = runHost({ id: 's4', action: 'start', payload: { port: 31903 } }, 's4');
  expect(s4 && s4.ok === false && s4.error && s4.error.code === 'ALREADY_RUNNING',
    '4 再 start -> ALREADY_RUNNING', JSON.stringify(s4));

  // S5 status -> running 且 pid/port 正确
  const s5 = runHost({ id: 's5', action: 'status', payload: {} }, 's5');
  expect(s5 && s5.ok === true && s5.result.state === 'running' && s5.result.pid === pid3 && s5.result.port === 31903,
    '5 status -> running 且 pid/port 正确', JSON.stringify(s5 && s5.result));

  // S6 restart -> running 且 pid 变化
  const s6 = runHost({ id: 's6', action: 'restart', payload: { port: 31903 } }, 's6');
  expect(s6 && s6.ok === true && s6.result.state === 'running', '6 restart -> running', JSON.stringify(s6));
  const rec6 = readRunFile();
  expect(rec6 && rec6.pid !== pid3, '6 restart 后 pid 变化', `old=${pid3} new=${rec6 && rec6.pid}`);

  // S6b restart 携带与记录不同的端口 -> 生效（2026-08-24 修复：原实现忽略 payload，
  //     设置改端口后点重启仍起旧端口；协议 §6.2 声明 port/profile 为 start/restart 用）
  const s6b = runHost({ id: 's6b', action: 'restart', payload: { port: 31904 } }, 's6b');
  expect(s6b && s6b.ok === true && s6b.result.state === 'running' && s6b.result.port === 31904,
    '6 restart payload 端口覆盖 -> running@31904', JSON.stringify(s6b && s6b.result));
  const rec6b = readRunFile();
  expect(rec6b && rec6b.port === 31904 && rec6b.pid !== rec6.pid,
    '6 restart 端口覆盖后记录与 pid 正确', rec6b ? JSON.stringify({ pid: rec6b.pid, port: rec6b.port }) : '缺失');

  // S6c restart 显式改回 31903（覆盖「改回」路径，并保持 S7 的 31903 端口关闭断言成立）
  const s6c = runHost({ id: 's6c', action: 'restart', payload: { port: 31903 } }, 's6c');
  expect(s6c && s6c.ok === true && s6c.result.state === 'running' && s6c.result.port === 31903,
    '6 restart payload 改回 -> running@31903', JSON.stringify(s6c && s6c.result));
  const rec6c = readRunFile();
  expect(rec6c && rec6c.port === 31903 && rec6c.pid !== rec6b.pid,
    '6 restart 改回后记录与 pid 正确', rec6c ? JSON.stringify({ pid: rec6c.pid, port: rec6c.port }) : '缺失');
  const pid6 = rec6c.pid; // S7 停止目标：最后一次重启的实例

  // S7 stop -> stopped，端口关闭，记录清除，进程退出
  const s7 = runHost({ id: 's7', action: 'stop', payload: {} }, 's7');
  expect(s7 && s7.ok === true && s7.result.state === 'stopped', '7 stop -> stopped', JSON.stringify(s7));
  expect(readRunFile() === null, '7 run 记录已清除', '');
  expect(!(await portOpen(31903)), '7 端口 31903 已关闭', '');
  expect(!pidAlive(pid6), '7 fake-dsh 进程已退出', 'pid ' + pid6);

  // S8 再 stop -> ALREADY_STOPPED
  const s8 = runHost({ id: 's8', action: 'stop', payload: {} }, 's8');
  expect(s8 && s8.ok === false && s8.error && s8.error.code === 'ALREADY_STOPPED',
    '8 再 stop -> ALREADY_STOPPED', JSON.stringify(s8));
}

async function scenarioPortBusy() {
  cleanup();
  const server = net.createServer();
  await new Promise((r) => server.listen(31909, '127.0.0.1', r));
  try {
    const resp = runHost({ id: 's9', action: 'start', payload: { port: 31909 } }, 's9');
    expect(resp && resp.ok === false && resp.error && resp.error.code === 'PORT_BUSY',
      '9 端口占用 -> PORT_BUSY', JSON.stringify(resp));
  } finally {
    await new Promise((r) => server.close(r));
  }
  cleanup();
}

function scenarioBadRequest() {
  const a = runHost({ id: 's10a', action: 'nonsense-action', payload: {} }, 's10a');
  expect(a && a.ok === false && a.error && a.error.code === 'BAD_REQUEST',
    '10 非法 action -> BAD_REQUEST', JSON.stringify(a));
  const b = runHost({ id: 's10b', action: 'start', payload: { port: 31910, extraArgs: ['--host', '0.0.0.0'] } }, 's10b');
  expect(b && b.ok === false && b.error && b.error.code === 'BAD_REQUEST',
    '10 extraArgs 含 --host 0.0.0.0 -> BAD_REQUEST', JSON.stringify(b));
  const c = runHost({ id: 's10c', action: 'start', payload: { port: 31910, host: '0.0.0.0' } }, 's10c');
  expect(c && c.ok === false && c.error && c.error.code === 'BAD_REQUEST',
    '10 payload.host=0.0.0.0 -> BAD_REQUEST', JSON.stringify(c));
  const d = runHost({ id: 's10d', action: 'start', payload: { port: 31910, launchMode: 'unknown-mode' } }, 's10d');
  expect(d && d.ok === false && d.error && d.error.code === 'BAD_REQUEST',
    '10 非法 launchMode -> BAD_REQUEST', JSON.stringify(d));
  const e = runHost({ id: 's10e', action: 'start', payload: { port: 31910, launchMode: 'source', customPath: '' } }, 's10e');
  expect(e && e.ok === false && e.error && e.error.code === 'BAD_REQUEST',
    '10 source 模式空 customPath -> BAD_REQUEST', JSON.stringify(e));
  const f = runHost({ id: 's10f', action: 'start', payload: { port: 31910, launchMode: 'source', customPath: 'D:\\non_existent_dir_123456' } }, 's10f');
  expect(f && f.ok === false && f.error && f.error.code === 'BAD_REQUEST',
    '10 source 模式不存在 customPath -> BAD_REQUEST', JSON.stringify(f));

  // 重启预检事务化（先检后杀）：启动后发起携带非法 customPath 的 restart
  // 必须返回 BAD_REQUEST，且原运行中的旧服务绝不被停机（PID 依然存活，status 依然 running）
  const sStart = runHost({ id: 's10g', action: 'start', payload: { port: 31910 } }, 's10g');
  expect(sStart && sStart.ok === true && sStart.result.state === 'running',
    '10 重启预检基准：start -> running', JSON.stringify(sStart && sStart.result));
  const oldPid = sStart.result.pid;

  const rFail = runHost({ id: 's10h', action: 'restart', payload: { port: 31910, launchMode: 'source', customPath: 'D:\\non_existent_path_preflight' } }, 's10h');
  expect(rFail && rFail.ok === false && rFail.error && rFail.error.code === 'BAD_REQUEST',
    '10 restart 携带非法 customPath -> BAD_REQUEST', JSON.stringify(rFail && rFail.error));

  // 关键断言：预检失败后旧进程依然存活！
  expect(pidAlive(oldPid), '10 restart 预检失败后旧进程依然存活（未被杀死）', 'oldPid=' + oldPid);
  const sCheck = runHost({ id: 's10i', action: 'status', payload: {} }, 's10i');
  expect(sCheck && sCheck.ok === true && sCheck.result.state === 'running' && sCheck.result.pid === oldPid,
    '10 restart 预检失败后 status 依然为 running 且 pid 未变', JSON.stringify(sCheck && sCheck.result));

  // status 观测性字段断言：包含了 launchMode 与 customPath
  expect(sCheck.result.launchMode === 'global' && typeof sCheck.result.customPath === 'string',
    '10 status.result 包含 launchMode 与 customPath 字段', JSON.stringify({ mode: sCheck.result.launchMode, path: sCheck.result.customPath }));

  // 路径清洗验证：带双引号的合法文件路径
  const cleanPath = runHost({ id: 's10j', action: 'start', payload: { port: 31910, launchMode: 'source', customPath: '"' + FAKE_DSH + '"' } }, 's10j');
  // 已有实例运行中会报 ALREADY_RUNNING，证明成功通过了路径存在性校验与清洗（否则会抛 BAD_REQUEST 路径不存在）
  expect(cleanPath && cleanPath.ok === false && cleanPath.error && cleanPath.error.code === 'ALREADY_RUNNING',
    '10 带双引号的 customPath 成功清洗并通过路径校验', JSON.stringify(cleanPath && cleanPath.error));

  // 清理
  const sStop = runHost({ id: 's10k', action: 'stop', payload: {} }, 's10k');
  expect(sStop && sStop.ok === true && sStop.result.state === 'stopped', '10 清理：stop', JSON.stringify(sStop && sStop.result));
  cleanup();
}

async function scenarioLock() {
  cleanup();
  fs.mkdirSync(path.join(BASE, 'run'), { recursive: true });
  fs.writeFileSync(path.join(BASE, 'run', 'host.lock'), 'manual', 'utf8');
  const resp = runHost({ id: 's11a', action: 'start', payload: { port: 31911 } }, 's11a');
  expect(resp && resp.ok === false && resp.error && resp.error.code === 'BUSY',
    '11 锁存在 -> start -> BUSY', JSON.stringify(resp));
  try { fs.unlinkSync(path.join(BASE, 'run', 'host.lock')); } catch (_) {}
  const resp2 = runHost({ id: 's11b', action: 'start', payload: { port: 31911 } }, 's11b');
  expect(resp2 && resp2.ok === true && (resp2.result.state === 'starting' || resp2.result.state === 'running'),
    '11 删除锁后重试 start -> 成功', JSON.stringify(resp2));
  const stop = runHost({ id: 's11c', action: 'stop', payload: {} }, 's11c');
  expect(stop && stop.ok === true && stop.result.state === 'stopped', '11 清理：stop', JSON.stringify(stop));
  cleanup();
}

async function scenarioStaleRecord() {
  cleanup();
  fs.mkdirSync(path.join(BASE, 'run'), { recursive: true });
  fs.writeFileSync(path.join(BASE, 'run', 'dsh-web.json'), JSON.stringify({
    pid: 999999, port: 31912, host: '127.0.0.1', profile: 'web', startedAt: Date.now(),
    version: '0.0.0-fake', cmdline: 'stale',
  }, null, 2), 'utf8');
  const resp = runHost({ id: 's12', action: 'status', payload: {} }, 's12');
  expect(resp && resp.ok === true && resp.result.state === 'stopped',
    '12 死 pid 残留 -> status -> stopped', JSON.stringify(resp));
  expect(readRunFile() === null, '12 残留 run 记录已清除', '');
  cleanup();
}

async function scenarioStartTimeout() {
  cleanup();
  const resp = runHost({ id: 's13', action: 'start', payload: { port: 31913 } }, 's13',
    { DSH_FAKE_EXIT_IMMEDIATELY: '1' });
  expect(resp && resp.ok === false && resp.error && resp.error.code === 'START_TIMEOUT',
    '13 fake 立即退出 -> START_TIMEOUT', JSON.stringify(resp && resp.error));
  expect(resp && resp.error && typeof resp.error.logTail === 'string' && resp.error.logTail.length > 0,
    '13 error.logTail 存在且非空', JSON.stringify(resp && resp.error && resp.error.logTail));
  cleanup();
}

async function scenarioGracefulStop() {
  cleanup();
  const s = runHost({ id: 's14a', action: 'start', payload: { port: 31914 } }, 's14a');
  expect(s && s.ok === true, '14 start -> ok', JSON.stringify(s));
  const st = runHost({ id: 's14b', action: 'stop', payload: {} }, 's14b');
  expect(st && st.ok === true && st.result.state === 'stopped', '14 stop -> stopped', JSON.stringify(st));
  const log = fs.readFileSync(path.join(BASE, 'logs', 'dsh-web.log'), 'utf8');
  expect(log.includes('SHUTDOWN-RECEIVED'),
    '14 日志含 SHUTDOWN-RECEIVED（优雅停机路径，非 taskkill）', log.split('\n').slice(-6).join(' | '));
  cleanup();
}

async function scenarioExternalDetect() {
  cleanup();
  const ext1 = spawnExtFakeDsh(31915);
  const pids = [ext1.pid];
  try {
    const ok1 = await waitPort(31915, 5000);
    expect(ok1, '15 外部 fake-dsh(31915) 就绪', '');
    const hooks1 = {
      DSH_MANAGER_FAKE_PROCESSES: JSON.stringify([{ pid: ext1.pid, cmdline: fakeDshCmdline(31915) }]),
    };

    // 15a status -> external（真实 pid/port/url/source；startedAt=null、version=unknown）
    const s1 = runHost({ id: 's15a', action: 'status', payload: {} }, 's15a', hooks1);
    expect(s1 && s1.ok === true && s1.result.state === 'external' && s1.result.source === 'external'
      && s1.result.pid === ext1.pid && s1.result.port === 31915,
      '15 检测到外部 dsh -> external 且 pid/port 正确', JSON.stringify(s1 && s1.result));
    expect(s1 && s1.result && s1.result.url === 'http://127.0.0.1:31915',
      '15 external url 正确', s1 && s1.result && s1.result.url);
    expect(s1 && s1.result && s1.result.startedAt === null && s1.result.version === 'unknown',
      '15 external startedAt=null 且 version=unknown', JSON.stringify(s1 && s1.result));

    // 15b stop -> EXTERNAL_UNMANAGED（不误杀外部实例）
    const st = runHost({ id: 's15b', action: 'stop', payload: {} }, 's15b', hooks1);
    expect(st && st.ok === false && st.error && st.error.code === 'EXTERNAL_UNMANAGED',
      '15 stop 外部实例 -> EXTERNAL_UNMANAGED', JSON.stringify(st && st.error));

    // 15c restart -> EXTERNAL_UNMANAGED
    const rt = runHost({ id: 's15c', action: 'restart', payload: {} }, 's15c', hooks1);
    expect(rt && rt.ok === false && rt.error && rt.error.code === 'EXTERNAL_UNMANAGED',
      '15 restart 外部实例 -> EXTERNAL_UNMANAGED', JSON.stringify(rt && rt.error));

    // 15d start 同端口 -> PORT_BUSY 且提示「外部 dsh」
    const sta = runHost({ id: 's15d', action: 'start', payload: { port: 31915 } }, 's15d', hooks1);
    expect(sta && sta.ok === false && sta.error && sta.error.code === 'PORT_BUSY' && /dsh/.test(sta.error.message || ''),
      '15 start 同端口 -> PORT_BUSY 且提示外部 dsh', JSON.stringify(sta && sta.error));

    // 15e 双实例 -> externalCount=2，报告其一
    const ext2 = spawnExtFakeDsh(31925);
    pids.push(ext2.pid);
    const ok2 = await waitPort(31925, 5000);
    expect(ok2, '15 第二个外部 fake-dsh(31925) 就绪', '');
    const hooks2 = {
      DSH_MANAGER_FAKE_PROCESSES: JSON.stringify([
        { pid: ext1.pid, cmdline: fakeDshCmdline(31915) },
        { pid: ext2.pid, cmdline: fakeDshCmdline(31925) },
      ]),
    };
    const s2 = runHost({ id: 's15e', action: 'status', payload: {} }, 's15e', hooks2);
    expect(ok2 && s2 && s2.ok === true && s2.result.state === 'external' && s2.result.externalCount === 2
      && (s2.result.port === 31915 || s2.result.port === 31925),
      '15 双外部实例 -> externalCount=2', JSON.stringify(s2 && s2.result));

    // 15f 优雅终止外部实例 -> status 回 stopped（死 pid 候选被跳过）
    await shutdownExternal(31915);
    await shutdownExternal(31925);
    const gone = (await waitPidGone(ext1.pid, 5000)) && (await waitPidGone(ext2.pid, 5000));
    expect(gone, '15 外部 fake-dsh 已退出', '');
    const s3 = runHost({ id: 's15f', action: 'status', payload: {} }, 's15f', hooks2);
    expect(gone && s3 && s3.ok === true && s3.result.state === 'stopped',
      '15 外部实例退出后 -> stopped', JSON.stringify(s3 && s3.result));
  } finally {
    await shutdownExternal(31915);
    await shutdownExternal(31925);
    cleanup(pids);
  }
}

async function scenarioExternalPortZero() {
  cleanup();
  const ext = spawnExtFakeDsh(31916);
  try {
    const ok = await waitPort(31916, 5000);
    expect(ok, '16 外部 fake-dsh(31916) 就绪', '');
    const hooks = {
      // 位置参数 web + --port 0：端口必须从端口表（netstat）按 PID 解析
      DSH_MANAGER_FAKE_PROCESSES: JSON.stringify([{
        pid: ext.pid,
        cmdline: '"C:\\Program Files\\nodejs\\node.exe"  "<user>\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" web --port 0',
      }]),
      DSH_MANAGER_FAKE_LISTENERS: JSON.stringify([
        { pid: ext.pid, addr: '127.0.0.1', port: 31916 },
        { pid: 999999, addr: '127.0.0.1', port: 31916 }, // 干扰项：不同 pid 的同端口条目必须被过滤
      ]),
    };
    const s = runHost({ id: 's16a', action: 'status', payload: {} }, 's16a', hooks);
    expect(ok && s && s.ok === true && s.result.state === 'external' && s.result.port === 31916 && s.result.pid === ext.pid,
      '16 --port 0 经端口表解析 -> external 31916', JSON.stringify(s && s.result));
  } finally {
    await shutdownExternal(31916);
    cleanup([ext.pid]);
  }
}

async function scenarioExternalNegative() {
  cleanup();
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not-dsh server\n');
  });
  await new Promise((r) => srv.listen(31917, '127.0.0.1', r));
  try {
    // 17a 命令行像 dsh、端口在听，但指纹不匹配 -> 不误报
    const hooks1 = { DSH_MANAGER_FAKE_PROCESSES: JSON.stringify([
      { pid: process.pid, cmdline: fakeDshCmdline(31917) },
    ]) };
    const s1 = runHost({ id: 's17a', action: 'status', payload: {} }, 's17a', hooks1);
    expect(s1 && s1.ok === true && s1.result.state === 'stopped',
      '17 指纹不匹配 -> stopped', JSON.stringify(s1 && s1.result));

    // 17b 命令行不是 dsh 入口 -> 不误报
    const hooks2 = { DSH_MANAGER_FAKE_PROCESSES: JSON.stringify([
      { pid: process.pid, cmdline: '"C:\\Program Files\\nodejs\\node.exe"  "D:\\other\\server.js" --port 31917' },
    ]) };
    const s2 = runHost({ id: 's17b', action: 'status', payload: {} }, 's17b', hooks2);
    expect(s2 && s2.ok === true && s2.result.state === 'stopped',
      '17 非 dsh 命令行 -> stopped', JSON.stringify(s2 && s2.result));

    // 17c 死 pid 候选 -> 不误报
    const hooks3 = { DSH_MANAGER_FAKE_PROCESSES: JSON.stringify([
      { pid: 999999, cmdline: fakeDshCmdline(31917) },
    ]) };
    const s3 = runHost({ id: 's17c', action: 'status', payload: {} }, 's17c', hooks3);
    expect(s3 && s3.ok === true && s3.result.state === 'stopped',
      '17 死 pid 候选 -> stopped', JSON.stringify(s3 && s3.result));
  } finally {
    await new Promise((r) => srv.close(r));
    cleanup();
  }
}

async function scenarioManagedWins() {
  cleanup();
  const s = runHost({ id: 's18a', action: 'start', payload: { port: 31918 } }, 's18a');
  expect(s && s.ok === true && (s.result.state === 'starting' || s.result.state === 'running'),
    '18 start -> ok', JSON.stringify(s));
  const rec = readRunFile();
  // run 记录存在时发现不参与：即便注入外部假数据，source 仍为 managed
  const hooks = { DSH_MANAGER_FAKE_PROCESSES: JSON.stringify([
    { pid: process.pid, cmdline: fakeDshCmdline(31918) },
  ]) };
  const st = runHost({ id: 's18b', action: 'status', payload: {} }, 's18b', hooks);
  expect(st && st.ok === true && st.result.state === 'running' && st.result.source === 'managed'
    && st.result.pid === rec.pid && st.result.port === 31918,
    '18 managed 记录优先，source=managed', JSON.stringify(st && st.result));
  const so = runHost({ id: 's18c', action: 'stop', payload: {} }, 's18c');
  expect(so && so.ok === true && so.result.state === 'stopped', '18 清理：stop', JSON.stringify(so));
  cleanup();
}

async function scenarioAdopt() {
  cleanup();
  const ext = spawnExtFakeDsh(31919);
  try {
    const ok = await waitPort(31919, 5000);
    expect(ok, '19 外部 fake-dsh(31919) 就绪', '');
    // 位置形式 web（接管解析）+ 额外参数 --resume abc（验证重放保留）+
    // 危险参数 --trusted-host=attacker.com（验证 adoptedReplay 黑名单拒绝，重放时被丢弃）
    const cmdline = '"C:\\Program Files\\nodejs\\node.exe"  "<user>\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" web --host 127.0.0.1 --port 31919 --resume abc --trusted-host=attacker.com';
    const hooks = { DSH_MANAGER_FAKE_PROCESSES: JSON.stringify([{ pid: ext.pid, cmdline }]) };

    // 19a status -> external
    const s1 = runHost({ id: 's19a', action: 'status', payload: {} }, 's19a', hooks);
    expect(s1 && s1.ok === true && s1.result.state === 'external' && s1.result.pid === ext.pid && s1.result.port === 31919,
      '19 status -> external', JSON.stringify(s1 && s1.result));

    // 19b adopt 错误 pid -> EXTERNAL_UNMANAGED（双重匹配防接错）
    const a1 = runHost({ id: 's19b', action: 'adopt', payload: { pid: 999999, port: 31919 } }, 's19b', hooks);
    expect(a1 && a1.ok === false && a1.error && a1.error.code === 'EXTERNAL_UNMANAGED',
      '19 adopt 错误 pid -> EXTERNAL_UNMANAGED', JSON.stringify(a1 && a1.error));

    // 19c adopt 正确 pid+port -> running/managed（同一进程），run 记录正确
    const a2 = runHost({ id: 's19c', action: 'adopt', payload: { pid: ext.pid, port: 31919 } }, 's19c', hooks);
    expect(a2 && a2.ok === true && a2.result.state === 'running' && a2.result.source === 'managed'
      && a2.result.pid === ext.pid && a2.result.port === 31919,
      '19 adopt -> running/managed（同一进程）', JSON.stringify(a2 && a2.result));
    const rec = readRunFile();
    expect(rec && rec.adopted === true && rec.profile === 'web' && rec.host === '127.0.0.1'
      && Array.isArray(rec.extraArgs) && rec.extraArgs.includes('--resume') && rec.extraArgs.includes('abc'),
      '19 run 记录 adopted/profile/extraArgs 正确', rec ? JSON.stringify(rec) : 'run 记录缺失');

    // 19d 再 adopt -> ALREADY_RUNNING（幂等）
    const a3 = runHost({ id: 's19d', action: 'adopt', payload: { pid: ext.pid, port: 31919 } }, 's19d', hooks);
    expect(a3 && a3.ok === false && a3.error && a3.error.code === 'ALREADY_RUNNING',
      '19 再 adopt -> ALREADY_RUNNING', JSON.stringify(a3 && a3.error));

    // 19e restart 接管实例 -> 原 argv 重放（pid 变化、adopted 血统延续、端口不变）
    const r = runHost({ id: 's19e', action: 'restart', payload: {} }, 's19e', hooks);
    expect(r && r.ok === true && r.result.state === 'running' && r.result.port === 31919,
      '19 restart 接管实例 -> running', JSON.stringify(r && r.result));
    const rec2 = readRunFile();
    expect(rec2 && rec2.pid !== ext.pid && rec2.port === 31919 && rec2.adopted === true,
      '19 restart 后 pid 变化且 adopted 血统延续', rec2 ? JSON.stringify(rec2) : 'run 记录缺失');
    // 重放黑名单：--resume abc 保留，--trusted-host=attacker.com 被丢弃
    expect(rec2 && Array.isArray(rec2.extraArgs) && rec2.extraArgs.includes('--resume')
      && rec2.extraArgs.includes('abc')
      && !rec2.extraArgs.some((a) => /^--trusted-host/.test(a)),
      '19 adoptedReplay 黑名单：--resume 保留、--trusted-host 丢弃',
      rec2 ? JSON.stringify(rec2.extraArgs) : 'run 记录缺失');

    // 19e2 二次 restart -> 仍按接管 argv 重放（血统标记不丢，回归 --resume 白名单旁路）
    const r2 = runHost({ id: 's19e2', action: 'restart', payload: {} }, 's19e2', hooks);
    expect(r2 && r2.ok === true && r2.result.state === 'running' && r2.result.port === 31919,
      '19 二次 restart 接管血统 -> running', JSON.stringify(r2 && r2.result));
    const rec3 = readRunFile();
    expect(rec3 && rec3.adopted === true && Array.isArray(rec3.extraArgs) && rec3.extraArgs.includes('--resume'),
      '19 二次 restart 后血统与 argv 保持', rec3 ? JSON.stringify(rec3) : 'run 记录缺失');

    // 19f stop -> stopped，记录清除
    const so = runHost({ id: 's19f', action: 'stop', payload: {} }, 's19f');
    expect(so && so.ok === true && so.result.state === 'stopped', '19 stop -> stopped', JSON.stringify(so));
    expect(readRunFile() === null, '19 run 记录已清除', '');

    // 19g 无外部实例时 adopt -> EXTERNAL_UNMANAGED
    const a4 = runHost({ id: 's19g', action: 'adopt', payload: { pid: ext.pid, port: 31919 } }, 's19g', hooks);
    expect(a4 && a4.ok === false && a4.error && a4.error.code === 'EXTERNAL_UNMANAGED',
      '19 无外部实例 adopt -> EXTERNAL_UNMANAGED', JSON.stringify(a4 && a4.error));
  } finally {
    await shutdownExternal(31919);
    cleanup([ext.pid]);
  }
}

// ---------------------------------------------------------------------------
// M2 场景 20-23（健康探测 / 优雅停止 / 无插件降级 / 插件存在时 restart）
// ---------------------------------------------------------------------------
async function scenarioHealth() {
  cleanup();
  const s = runHost({ id: 's20a', action: 'start', payload: { port: 31920 } }, 's20a');
  expect(s && s.ok === true && (s.result.state === 'starting' || s.result.state === 'running'),
    '20 start -> ok', JSON.stringify(s));
  const rec = readRunFile();
  expect(rec && Number.isInteger(rec.pid) && rec.port === 31920, '20 run 记录存在', rec ? JSON.stringify(rec) : '缺失');

  const st = runHost({ id: 's20b', action: 'status', payload: {} }, 's20b');
  expect(st && st.ok === true && st.result.state === 'running', '20 status -> running', JSON.stringify(st && st.result));
  expect(st && st.result && st.result.lifecycle === true,
    '20 status lifecycle === true', JSON.stringify(st && st.result));
  expect(st && st.result && st.result.health && st.result.health.ok === true,
    '20 health.ok === true', JSON.stringify(st && st.result && st.result.health));
  expect(st && st.result && st.result.health && st.result.health.pid === rec.pid,
    '20 health.pid === fake-dsh pid', `health.pid=${st.result.health && st.result.health.pid} rec.pid=${rec.pid}`);
  expect(st && st.result && st.result.health && st.result.health.port === 31920,
    '20 health.port === 端口', JSON.stringify(st && st.result && st.result.health));
  expect(st && st.result && st.result.health && typeof st.result.health.uptimeMs === 'number'
    && typeof st.result.health.nodeVersion === 'string',
    '20 health.uptimeMs/nodeVersion 存在', JSON.stringify(st && st.result && st.result.health));

  const so = runHost({ id: 's20c', action: 'stop', payload: {} }, 's20c');
  expect(so && so.ok === true && so.result.state === 'stopped', '20 清理：stop', JSON.stringify(so));
  cleanup();
}

async function scenarioGracefulStopMethod() {
  cleanup();
  const s = runHost({ id: 's21a', action: 'start', payload: { port: 31921 } }, 's21a');
  expect(s && s.ok === true, '21 start -> ok', JSON.stringify(s));
  const st = runHost({ id: 's21b', action: 'stop', payload: {} }, 's21b');
  expect(st && st.ok === true && st.result.state === 'stopped',
    '21 stop -> stopped', JSON.stringify(st));
  expect(st && st.result && st.result.stopMethod === 'graceful',
    '21 stop 返回 stopMethod===\'graceful\'', JSON.stringify(st && st.result));
  const log = fs.readFileSync(path.join(BASE, 'logs', 'dsh-web.log'), 'utf8');
  expect(log.includes('SHUTDOWN-RECEIVED'),
    '21 日志含 SHUTDOWN-RECEIVED（优雅停机路径，非 taskkill）', log.split('\n').slice(-6).join(' | '));
  cleanup();
}

async function scenarioNoLifecycle() {
  cleanup();
  const s = runHost({ id: 's22a', action: 'start', payload: { port: 31922 } }, 's22a', { DSH_FAKE_NO_LIFECYCLE: '1' });
  expect(s && s.ok === true && (s.result.state === 'starting' || s.result.state === 'running'),
    '22 start(lifecycle off) -> ok', JSON.stringify(s));

  const st = runHost({ id: 's22b', action: 'status', payload: {} }, 's22b', { DSH_FAKE_NO_LIFECYCLE: '1' });
  expect(st && st.ok === true && st.result.state === 'running', '22 status -> running', JSON.stringify(st && st.result));
  expect(st && st.result && st.result.lifecycle === false,
    '22 status lifecycle === false', JSON.stringify(st && st.result));
  expect(st && st.result && st.result.health === null,
    '22 status health === null', JSON.stringify(st && st.result));

  // stop -> 走 taskkill 'force'。taskkill 在本环境若被拦截（EPERM 等）则该场景记 SKIP，不失败退出。
  let stopResp;
  try {
    stopResp = runHost({ id: 's22c', action: 'stop', payload: {} }, 's22c', { DSH_FAKE_NO_LIFECYCLE: '1' });
  } catch (e) {
    // runHost 不抛，异常兜底会返回 spawnError
    stopResp = { respError: e.message };
  }

  if (stopResp && stopResp.ok === true && stopResp.result && stopResp.result.state === 'stopped') {
    expect(stopResp.result.stopMethod === 'force',
      '22 stop -> stopped 且 stopMethod===\'force\'', JSON.stringify(stopResp.result));
  } else {
    // 允许的唯一 SKIP 理由：taskkill 被本环境（沙箱 EPERM 等）拦截，无法走 force 路径
    const why = stopResp && stopResp.error ? (stopResp.error.code + ': ' + stopResp.error.message) : JSON.stringify(stopResp);
    recordSkip('场景', '22 stop force 路径（taskkill 被环境拦截，记 SKIP）', why);
  }
  cleanup();
}

async function scenarioRestartWithPlugin() {
  cleanup();
  const s = runHost({ id: 's23a', action: 'start', payload: { port: 31923 } }, 's23a');
  expect(s && s.ok === true && (s.result.state === 'starting' || s.result.state === 'running'),
    '23 start -> ok', JSON.stringify(s));
  const rec1 = readRunFile();
  expect(rec1 && Number.isInteger(rec1.pid), '23 run 记录 pid', rec1 ? JSON.stringify(rec1) : '缺失');
  const pid1 = rec1.pid;

  const r = runHost({ id: 's23b', action: 'restart', payload: { port: 31923 } }, 's23b');
  expect(r && r.ok === true && r.result.state === 'running',
    '23 restart -> running（start 语义）', JSON.stringify(r));
  expect(!(r && r.result && r.result.stopMethod),
    '23 restart 不上报 stopMethod', JSON.stringify(r && r.result));
  const rec2 = readRunFile();
  expect(rec2 && Number.isInteger(rec2.pid) && rec2.pid !== pid1,
    '23 restart 后 pid 变化', `old=${pid1} new=${rec2 && rec2.pid}`);

  const so = runHost({ id: 's23c', action: 'stop', payload: {} }, 's23c');
  expect(so && so.ok === true && so.result.state === 'stopped', '23 清理：stop', JSON.stringify(so));
  cleanup();
}

// ---------------------------------------------------------------------------
// M3 场景 24（logs 动作：尾部读取 / beforeByte 分页 / 参数校验 / 行边界对齐）
// ---------------------------------------------------------------------------
async function scenarioLogs() {
  cleanup();
  // 24a 空目录：日志文件不存在 -> exists:false
  const e = runHost({ id: 's24a', action: 'logs', payload: {} }, 's24a');
  expect(e && e.ok === true && e.result && e.result.exists === false && e.result.sizeBytes === 0
    && e.result.tail === '' && e.result.hasMore === false,
    '24 无日志文件 -> exists:false', JSON.stringify(e && e.result));

  // 24b 构造确定性日志：8000 行编号行（含中文与 \r\n），用于分页与行边界断言
  const logPath = path.join(BASE, 'logs', 'dsh-web.log');
  fs.mkdirSync(path.join(BASE, 'logs'), { recursive: true });
  const lines = [];
  for (let i = 0; i < 8000; i++) lines.push('line-' + String(i).padStart(4, '0') + ' 中文内容测试 ' + i);
  fs.writeFileSync(logPath, lines.join('\r\n') + '\r\n', 'utf8');
  const size = fs.statSync(logPath).size;

  const stripCr = (s) => s.replace(/\r$/, '');
  const splitLines = (text) => {
    if (text === '') return [];
    const arr = text.split('\n');
    if (arr[arr.length - 1] === '') arr.pop();
    return arr;
  };

  // 24c 尾部块：tailLines=50、maxBytes=4096 -> toByte===size、hasMore；
  //      tailLines 是上限：字节窗口内不足 50 行时按实际完整行数返回（首行被窗口切断的行
  //      会在更早的分页块中完整出现，此处不重复计算）
  const t = runHost({ id: 's24c', action: 'logs', payload: { tailLines: 50, maxBytes: 4096 } }, 's24c');
  expect(t && t.ok === true && t.result && t.result.exists === true,
    '24 尾部读取 -> ok', JSON.stringify(t && t.result));
  expect(t.result.toByte === size && t.result.fromByte > 0 && t.result.hasMore === true,
    '24 尾部块 toByte===sizeBytes 且 fromByte>0 且 hasMore', JSON.stringify(t.result));
  const tLines = splitLines(t.result.tail).map(stripCr);
  expect(tLines.length <= 50 && t.result.tailLines === tLines.length
    && tLines.length > 0 && tLines[tLines.length - 1] === lines[7999]
    && tLines[0] === lines[8000 - tLines.length],
    '24 尾部为最后 N 行（tailLines 上限语义，N=' + tLines.length + '）',
    JSON.stringify([tLines.length, tLines[0], tLines[tLines.length - 1]]));

  // 24d 分页向前翻直至文件开头：每块与后块严格衔接（toByte === 后块 fromByte）
  const chunks = [t.result];
  let cur = t.result;
  let guard = 0;
  while (cur.hasMore && guard < 500) {
    guard += 1;
    const prev = runHost({ id: 's24d-' + guard, action: 'logs', payload: { beforeByte: cur.fromByte, maxBytes: 4096 } }, 's24d-' + guard);
    expect(prev && prev.ok === true && prev.result && prev.result.exists === true,
      '24 分页块 ' + guard + ' -> ok', JSON.stringify(prev && prev.result));
    expect(prev.result.toByte === cur.fromByte,
      '24 分页块 ' + guard + ' 与后块严格衔接', `toByte=${prev.result.toByte} 后块 fromByte=${cur.fromByte}`);
    chunks.unshift(prev.result);
    cur = prev.result;
  }
  expect(cur.fromByte === 0 && cur.hasMore === false,
    '24 分页到底：fromByte=0 且 hasMore=false', JSON.stringify(cur));
  expect(chunks.length >= 3, '24 分页产生多块', 'chunks=' + chunks.length);

  // 24e 全量重建：行边界对齐（每块首行为完整行）+ 拼接行数与首尾行正确
  let totalLines = 0;
  let joined = '';
  for (const c of chunks) {
    const txt = c.tail;
    const firstLine = stripCr(txt.split('\n')[0]);
    expect(/^line-\d{4} 中文内容测试 \d+$/.test(firstLine),
      '24 块首行为完整行（行边界对齐）', firstLine);
    joined += txt;
    totalLines += splitLines(txt).length;
  }
  expect(totalLines === 8000, '24 全量重建行数 === 8000', 'total=' + totalLines);
  expect(joined.includes('line-0000 中文内容测试 0') && joined.includes('line-7999 中文内容测试 7999'),
    '24 重建内容覆盖首尾行', '');

  // 24f 参数校验：非法 tailLines/maxBytes/beforeByte -> BAD_REQUEST
  for (const [tag, payload] of [
    ['s24f1', { tailLines: 0 }],
    ['s24f2', { tailLines: 2001 }],
    ['s24f3', { maxBytes: 100 }],
    ['s24f4', { maxBytes: 2 * 1024 * 1024 }],
    ['s24f5', { beforeByte: -1 }],
  ]) {
    const bad = runHost({ id: tag, action: 'logs', payload }, tag);
    expect(bad && bad.ok === false && bad.error && bad.error.code === 'BAD_REQUEST',
      '24 非法日志参数 -> BAD_REQUEST（' + JSON.stringify(payload) + '）', JSON.stringify(bad && bad.error));
  }

  // 24g beforeByte >= size 按尾部块处理；beforeByte=0 返回空块
  const g = runHost({ id: 's24g', action: 'logs', payload: { beforeByte: size + 100, tailLines: 10 } }, 's24g');
  expect(g && g.ok === true && g.result && g.result.toByte === size && g.result.tailLines === 10,
    '24 beforeByte>=size -> 尾部块语义', JSON.stringify(g && g.result));
  const h = runHost({ id: 's24h', action: 'logs', payload: { beforeByte: 0 } }, 's24h');
  expect(h && h.ok === true && h.result && h.result.exists === true && h.result.tail === ''
    && h.result.fromByte === 0 && h.result.toByte === 0 && h.result.hasMore === false,
    '24 beforeByte=0 -> 空块且 hasMore=false', JSON.stringify(h && h.result));

  // 24i 定宽行文件（每行恰 50 字节含 \n，字节偏移与行号严格对应）：
  //     验证「块起点恰在行边界」时首行不被误删、fromByte 按字节精确、tailLines 精确
  const fixed = [];
  for (let i = 0; i < 1000; i++) fixed.push('row-' + String(i).padStart(6, '0') + 'x'.repeat(39));
  fs.writeFileSync(logPath, fixed.join('\n') + '\n', 'utf8');
  const fsize = fs.statSync(logPath).size; // 1000 * 50 = 50000
  const ft = runHost({ id: 's24i', action: 'logs', payload: { tailLines: 100, maxBytes: 10000 } }, 's24i');
  expect(ft && ft.ok === true && ft.result && ft.result.exists === true
    && ft.result.toByte === fsize && ft.result.tailLines === 100 && ft.result.fromByte === 45000,
    '24 定宽行：边界起点不丢行（tailLines===100 且 fromByte===45000）',
    JSON.stringify(ft && ft.result));
  const fLines = splitLines(ft.result.tail);
  expect(fLines.length === 100 && fLines[0] === fixed[900] && fLines[99] === fixed[999],
    '24 定宽行：尾部为第 901-1000 行', JSON.stringify([fLines[0], fLines[fLines.length - 1]]));

  // 24j 定宽行分页：块间严格衔接（toByte === 后块 fromByte）、行数字段一致、
  //     分页到底后全量重建逐字节等于原文（中间块若在行边界误删首行会直接失败）
  const fchunks = [ft.result];
  let fcur = ft.result;
  let fguard = 0;
  while (fcur.hasMore && fguard < 100) {
    fguard += 1;
    const prev = runHost({ id: 's24j-' + fguard, action: 'logs', payload: { beforeByte: fcur.fromByte, maxBytes: 10000 } }, 's24j-' + fguard);
    const prevOk = prev && prev.ok === true && prev.result && prev.result.exists === true
      && prev.result.toByte === fcur.fromByte
      && prev.result.tailLines === splitLines(prev.result.tail).length;
    expect(prevOk,
      '24 定宽行分页块 ' + fguard + ' 衔接且行数字段一致', JSON.stringify(prev && prev.result));
    fchunks.unshift(prev.result);
    fcur = prev.result;
  }
  expect(fcur.fromByte === 0 && fcur.hasMore === false && fchunks.length === 6,
    '24 定宽行分页到底：fromByte=0 且共 6 块', JSON.stringify({ fromByte: fcur.fromByte, chunks: fchunks.length }));
  let fJoined = '';
  let fTotal = 0;
  for (const c of fchunks) {
    fJoined += c.tail;
    fTotal += splitLines(c.tail).length;
  }
  expect(fTotal === 1000 && fJoined === fixed.join('\n') + '\n',
    '24 定宽行全量重建逐字节等于原文', 'lines=' + fTotal);

  cleanup();
}

// ---------------------------------------------------------------------------
// M4 场景 25（--port 0 动态端口：日志 URL 行回填 / restart 再发现 / 校验 / 超时）
// ---------------------------------------------------------------------------
async function scenarioPortZero() {
  cleanup();
  // 25a start {port: 0} -> running 且实际端口已从日志回填
  const s = runHost({ id: 's25a', action: 'start', payload: { port: 0 } }, 's25a');
  expect(s && s.ok === true && s.result.state === 'running'
    && Number.isInteger(s.result.port) && s.result.port > 0,
    '25 start --port 0 -> running 且实际端口已回填', JSON.stringify(s && s.result));
  const rec = readRunFile();
  expect(rec && rec.requestedPort === 0 && rec.port === s.result.port && rec.port > 0
    && Number.isInteger(rec.logStartBytes) && rec.logStartBytes >= 0,
    '25 run 记录 requestedPort=0 且 port 回填实际端口',
    rec ? JSON.stringify({ port: rec.port, requestedPort: rec.requestedPort, logStartBytes: rec.logStartBytes }) : '缺失');
  const portA = rec.port;

  // 25b status -> running 且端口一致
  const st = runHost({ id: 's25b', action: 'status', payload: {} }, 's25b');
  expect(st && st.ok === true && st.result.state === 'running' && st.result.port === portA,
    '25 status -> running 且端口一致', JSON.stringify(st && st.result));

  // 25c restart -> running（动态端口再次发现，pid 变化，端口可能变化）
  const r = runHost({ id: 's25c', action: 'restart', payload: {} }, 's25c');
  expect(r && r.ok === true && r.result.state === 'running'
    && Number.isInteger(r.result.port) && r.result.port > 0,
    '25 restart -> running（动态端口再次发现）', JSON.stringify(r && r.result));
  const rec2 = readRunFile();
  expect(rec2 && rec2.port === r.result.port && rec2.requestedPort === 0 && rec2.pid !== rec.pid,
    '25 restart 后记录回填且 pid 变化', rec2 ? JSON.stringify({ pid: rec2.pid, port: rec2.port }) : '缺失');

  // 25d stop -> stopped 无残留、端口关闭
  const so = runHost({ id: 's25d', action: 'stop', payload: {} }, 's25d');
  expect(so && so.ok === true && so.result.state === 'stopped', '25 stop -> stopped', JSON.stringify(so && so.result));
  expect(readRunFile() === null, '25 run 记录已清除', '');
  expect(!(await portOpen(r.result.port)), '25 动态端口已关闭', 'port=' + r.result.port);

  // 25e 参数校验：-1 / 70000 -> BAD_REQUEST
  const b1 = runHost({ id: 's25e1', action: 'start', payload: { port: -1 } }, 's25e1');
  expect(b1 && b1.ok === false && b1.error && b1.error.code === 'BAD_REQUEST',
    '25 port=-1 -> BAD_REQUEST', JSON.stringify(b1 && b1.error));
  const b2 = runHost({ id: 's25e2', action: 'start', payload: { port: 70000 } }, 's25e2');
  expect(b2 && b2.ok === false && b2.error && b2.error.code === 'BAD_REQUEST',
    '25 port=70000 -> BAD_REQUEST', JSON.stringify(b2 && b2.error));

  // 25f 动态端口未报告（fake 立即退出，URL 行是 port 0 占位）-> START_TIMEOUT
  const t = runHost({ id: 's25f', action: 'start', payload: { port: 0 } }, 's25f', { DSH_FAKE_EXIT_IMMEDIATELY: '1' });
  expect(t && t.ok === false && t.error && t.error.code === 'START_TIMEOUT',
    '25 动态端口未报告 -> START_TIMEOUT', JSON.stringify(t && t.error));

  // 25g 超时残留（死 pid 的动态端口记录）被 status 清理
  const st2 = runHost({ id: 's25g', action: 'status', payload: {} }, 's25g');
  expect(st2 && st2.ok === true && st2.result.state === 'stopped',
    '25 残留动态端口记录（死 pid）-> status 清理为 stopped', JSON.stringify(st2 && st2.result));

  // 25h 占位期展示：手工构造 port 0 记录指向「不打印 URL 的存活 fake-dsh」→
  //     status = starting + port:null + requestedPort:0（发现失败不误判、不清理活记录）
  const silent = spawn(process.execPath, [FAKE_DSH, '--port', '0'], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: Object.assign({}, process.env, { DSH_FAKE_NO_URL: '1' }),
  });
  await sleep(600); // 等其绑定临时端口（无输出，无法探测具体值）
  fs.mkdirSync(path.join(BASE, 'run'), { recursive: true });
  // logStartBytes 必须取当前日志大小（宿主真实记录语义）：只解析 spawn 之后的追加内容，
  // 否则本场景前几步的历史 URL 行会被误当成本实例的端口
  const logPathNow = path.join(BASE, 'logs', 'dsh-web.log');
  let logStartNow = 0;
  try { logStartNow = fs.statSync(logPathNow).size; } catch (_) { logStartNow = 0; }
  fs.writeFileSync(path.join(BASE, 'run', 'dsh-web.json'), JSON.stringify({
    pid: silent.pid, port: 0, requestedPort: 0, logStartBytes: logStartNow,
    host: '127.0.0.1', profile: 'web', startedAt: Date.now(),
    version: '0.0.0-fake', binPath: FAKE_DSH, extraArgs: [],
    cmdline: 'node ' + FAKE_DSH + ' --port 0',
  }, null, 2), 'utf8');
  const stH = runHost({ id: 's25h', action: 'status', payload: {} }, 's25h');
  expect(stH && stH.ok === true && stH.result.state === 'starting'
    && stH.result.port === null && stH.result.requestedPort === 0,
    '25 占位期 status：starting + port:null + requestedPort:0（发现失败不误判）',
    JSON.stringify(stH && stH.result));
  killPidForce(silent.pid);
  await waitPidGone(silent.pid, 5000);

  cleanup();
}

// ---------------------------------------------------------------------------
// 场景 26（仅 POSIX）：平台层实测（design §6.8）——不注入任何 fake 钩子，
// 真实 /proc 枚举 + /proc/net/tcp 端口表 + /proc PID 命令行校验 + 指纹探测。
// Windows 记 SKIP：其平台路径由 smoke-real 外部发现段与 M1 生产实测覆盖。
// ---------------------------------------------------------------------------
async function scenarioPosixPlatform() {
  if (IS_WIN) {
    recordSkip('场景', '26 POSIX 平台层实测（/proc 枚举+端口表+PID 校验+指纹）',
      'Windows 平台：由 smoke-real 外部发现段与 M1 生产实测覆盖');
    return;
  }
  cleanup();
  // 复制 fake-dsh 到「真实 dsh」形态路径：真实 /proc/<pid>/cmdline 必须匹配
  // classifyDshCmdline 的 bin.js 指纹（node .../node_modules/@deepseek-ai/dsh/lib/bin.js --port N）
  const fakeBin = path.join(BASE, 'npm-global', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
  fs.copyFileSync(FAKE_DSH, fakeBin);
  const ext = spawn(process.execPath, [fakeBin, '--port', '31926'], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  try {
    const ready = await waitPort(31926, 5000);
    expect(ready, '26 外部 fake-dsh(31926) 就绪', 'pid=' + ext.pid);
    // 不注入 fake 钩子：真实 listNodeProcesses(/proc) + listTcpListeners(/proc/net/tcp) + 指纹
    const s = runHost({ id: 's26', action: 'status', payload: {} }, 's26');
    expect(s && s.ok === true && s.result.state === 'external'
      && s.result.port === 31926 && s.result.pid === ext.pid,
      '26 /proc 枚举+端口表发现外部实例（pid+port 一致）', JSON.stringify(s && s.result));
    // adopt -> 回写 run 记录（adopted 标记在记录上，不在响应 result 里）；随后的 status
    // 走真实 /proc PID 校验（cmdline 含 dsh -> 存活）
    const a = runHost({ id: 's26a', action: 'adopt', payload: { pid: ext.pid, port: 31926 } }, 's26a');
    expect(a && a.ok === true && a.result.state === 'running' && a.result.source === 'managed',
      '26 adopt 接管外部实例', JSON.stringify(a && a.result));
    const rec = readRunFile();
    expect(rec && rec.pid === ext.pid && rec.adopted === true,
      '26 run 记录回写（adopted）', JSON.stringify(rec));
    const st = runHost({ id: 's26b', action: 'status', payload: {} }, 's26b');
    expect(st && st.ok === true && st.result.state === 'running' && st.result.port === 31926,
      '26 status：/proc PID 校验通过 -> running', JSON.stringify(st && st.result));
    // stop -> fake 提供 lifecycle 端点，优雅停；SIGTERM 强停路径已由场景 22 在 POSIX 实测
    const so = runHost({ id: 's26c', action: 'stop', payload: {} }, 's26c');
    expect(so && so.ok === true && so.result.state === 'stopped',
      '26 stop -> stopped', JSON.stringify(so && so.result));
    expect(!(await portOpen(31926)), '26 端口 31926 已关闭', '');
  } finally {
    if (pidAlive(ext.pid)) killPidForce(ext.pid);
  }
  cleanup();
}

// ---------------------------------------------------------------------------
// 场景 27（M5.5，仅 Windows）：隐藏控制台载体启动链路——start 后 run 记录的
// pid 必须是端口表（netstat）反查出的真实 dsh 进程（而非载体 wscript 的 pid），
// 且 restart 后 pid 变化、stop 优雅停止、记录清除。POSIX 直接 spawn 无载体，
// 记 SKIP（其链路已由场景 3-25 全程覆盖）。
// ---------------------------------------------------------------------------
async function scenarioCarrierLaunch() {
  if (!IS_WIN) {
    recordSkip('场景', '27 载体启动链路（隐藏控制台）', 'POSIX 直接 spawn，无载体（design §6.3 第 5 步）');
    return;
  }
  cleanup();
  // start：经 wscript 载体拉起 fake-dsh；run 记录 pid 应为端口反查的真实进程
  const s = runHost({ id: 's27a', action: 'start', payload: { port: 31927 } }, 's27a');
  expect(s && s.ok === true && s.result.state === 'running',
    '27 载体 start -> running', JSON.stringify(s && s.result));
  const rec = readRunFile();
  expect(rec && Number.isInteger(rec.pid) && rec.pid > 0 && pidAlive(rec.pid)
    && rec.port === 31927,
    '27 run 记录 pid 为真实 dsh 进程（端口反查）且存活', rec ? JSON.stringify(rec) : 'run 记录缺失');
  // 记录 pid 不能是载体 wscript 的 pid：wscript 早已退出（pidAlive 已隐含覆盖）
  expect(rec && rec.cmdline && rec.cmdline.includes('fake-dsh.js'),
    '27 run 记录 cmdline 指向 dsh 入口', rec ? JSON.stringify(rec.cmdline) : 'run 记录缺失');

  // status：与记录一致
  const st = runHost({ id: 's27b', action: 'status', payload: {} }, 's27b');
  expect(st && st.ok === true && st.result.state === 'running' && st.result.pid === rec.pid,
    '27 status -> running 且 pid 与记录一致', JSON.stringify(st && st.result));

  // restart：按记录重放（载体再次启动）-> pid 变化
  const r = runHost({ id: 's27c', action: 'restart', payload: {} }, 's27c');
  expect(r && r.ok === true && r.result.state === 'running',
    '27 restart -> running', JSON.stringify(r && r.result));
  const rec2 = readRunFile();
  expect(rec2 && rec2.pid !== rec.pid && pidAlive(rec2.pid) && rec2.port === 31927,
    '27 restart 后 pid 变化且存活', rec2 ? JSON.stringify(rec2) : 'run 记录缺失');

  // stop：优雅停止（fake-dsh 提供 lifecycle）-> 记录清除
  const so = runHost({ id: 's27d', action: 'stop', payload: {} }, 's27d');
  expect(so && so.ok === true && so.result.state === 'stopped',
    '27 stop -> stopped', JSON.stringify(so && so.result));
  expect(readRunFile() === null, '27 run 记录已清除', '');
  cleanup();
}

// ---------------------------------------------------------------------------
// M9 场景 28（sessions 动作：插件端点应答 / 不可用降级）
// ---------------------------------------------------------------------------
async function scenarioSessions() {
  cleanup();
  // 28a 无 run 记录 -> available:false（不抛错）
  const a = runHost({ id: 's28a', action: 'sessions', payload: {} }, 's28a');
  expect(a && a.ok === true && a.result && a.result.available === false
    && Array.isArray(a.result.items) && a.result.items.length === 0,
    '28 无 run 记录 -> available:false', JSON.stringify(a && a.result));

  // 28b 插件应答：start（DSH_FAKE_SESSIONS 注入两态会话）-> sessions ->
  //     available:true 且 items 原样透传（sessionId/state/title，缺省字段不补）
  const fakeItems = [
    { sessionId: 'session-abc', title: 'alpha 会话', state: 'working', updatedAt: 1700000000000, blank: false, cwd: 'D:\\w' },
    { sessionId: 'session-def', state: 'completed', updatedAt: 1700000001000, blank: false },
  ];
  const s = runHost({ id: 's28b', action: 'start', payload: { port: 31928 } }, 's28b', {
    DSH_FAKE_SESSIONS: JSON.stringify(fakeItems),
  });
  expect(s && s.ok === true && (s.result.state === 'starting' || s.result.state === 'running'),
    '28 start -> ok', JSON.stringify(s));
  const se = runHost({ id: 's28c', action: 'sessions', payload: {} }, 's28c', {
    DSH_FAKE_SESSIONS: JSON.stringify(fakeItems),
  });
  expect(se && se.ok === true && se.result && se.result.available === true,
    '28 sessions -> available:true', JSON.stringify(se && se.result));
  expect(se.result.items.length === 2
    && se.result.items[0].sessionId === 'session-abc'
    && se.result.items[0].state === 'working'
    && se.result.items[0].title === 'alpha 会话',
    '28 items 透传（sessionId/state/title）', JSON.stringify(se.result.items));
  expect(se.result.items[1].cwd === undefined,
    '28 无 cwd 字段时不补默认值', JSON.stringify(se.result.items[1]));

  // 28c 插件未装降级：stop 清理 -> DSH_FAKE_NO_MANAGER=1 实例（SPA 200 非 JSON）
  //      -> sessions available:false（降级不抛错）
  const stop1 = runHost({ id: 's28d', action: 'stop', payload: {} }, 's28d', {
    DSH_FAKE_SESSIONS: JSON.stringify(fakeItems),
  });
  expect(stop1 && stop1.ok === true && stop1.result.state === 'stopped',
    '28 清理：stop', JSON.stringify(stop1));
  cleanup();
  const s2 = runHost({ id: 's28e', action: 'start', payload: { port: 31928 } }, 's28e', {
    DSH_FAKE_NO_MANAGER: '1',
  });
  expect(s2 && s2.ok === true && (s2.result.state === 'starting' || s2.result.state === 'running'),
    '28 start(no manager) -> ok', JSON.stringify(s2));
  const se2 = runHost({ id: 's28f', action: 'sessions', payload: {} }, 's28f', {
    DSH_FAKE_NO_MANAGER: '1',
  });
  expect(se2 && se2.ok === true && se2.result && se2.result.available === false
    && Array.isArray(se2.result.items) && se2.result.items.length === 0,
    '28 插件未装 -> available:false（降级不抛错）', JSON.stringify(se2 && se2.result));

  const stop2 = runHost({ id: 's28g', action: 'stop', payload: {} }, 's28g', {
    DSH_FAKE_NO_MANAGER: '1',
  });
  expect(stop2 && stop2.ok === true && stop2.result.state === 'stopped',
    '28 清理：stop(no manager)', JSON.stringify(stop2));
  cleanup();
}

// ---------------------------------------------------------------------------
// M13 场景 29（dsh ≥ 0.1.2 启动令牌认证兼容，§2.1.1 B1）：
//   DSH_FAKE_AUTH=1 模拟 rc.1——GET / 无凭据回 401、/manifest.webmanifest 公开
//   200 含指纹、启动 URL 行带 `?token=`。验证：httpProbe 对 401 视为就绪
//   （start 不误报 START_TIMEOUT、status 不停留在 starting）、httpDshProbe 经
//   manifest 识别（外部发现 / PORT_BUSY 指纹）、run 记录与 status 携带 launchUrl
//   （url 保持裸 URL 不含 token）、探测请求不携带 Accept-Encoding（§2.1.1 B2，
//   DSH_FAKE_LOG_HEADERS 打点回归）。
// ---------------------------------------------------------------------------
async function scenarioAuthCompat() {
  cleanup();
  const port = 31929;
  const port2 = 31930;
  const logFile = path.join(BASE, 'logs', 'dsh-web.log');

  // 29a managed start（auth 变体）：httpProbe 对 401 视为就绪
  const s1 = runHost({ id: 's29a', action: 'start', payload: { port } }, 's29a', {
    DSH_FAKE_AUTH: '1',
    DSH_FAKE_LOG_HEADERS: '1',
  });
  expect(s1 && s1.ok === true && s1.result.state === 'running' && s1.result.port === port,
    '29 start（auth）-> running（httpProbe 401 视为就绪）', JSON.stringify(s1 && s1.result));
  const rec1 = readRunFile();
  expect(rec1 && typeof rec1.launchUrl === 'string' && rec1.launchUrl.indexOf('?token=') !== -1,
    '29 run 记录含 launchUrl（带 token）', rec1 ? String(rec1.launchUrl) : '缺失');
  expect(rec1 && Number.isInteger(rec1.pid) && rec1.port === port,
    '29 run 记录 pid/port 正确', rec1 ? JSON.stringify({ pid: rec1.pid, port: rec1.port }) : '缺失');

  // 29b status：launchUrl 携带、url 保持裸 URL
  const s2 = runHost({ id: 's29b', action: 'status', payload: {} }, 's29b');
  expect(s2 && s2.ok === true && s2.result.state === 'running',
    '29 status（auth）-> running', JSON.stringify(s2 && s2.result));
  expect(s2 && s2.result && typeof s2.result.launchUrl === 'string'
    && s2.result.launchUrl.startsWith('http://127.0.0.1:' + port + '/?token='),
    '29 status.launchUrl 正确（含 token）', s2 && s2.result && String(s2.result.launchUrl));
  expect(s2 && s2.result && s2.result.url === 'http://127.0.0.1:' + port
    && String(s2.result.url).indexOf('token') === -1,
    '29 status.url 仍为裸 URL（不含 token）', s2 && s2.result && String(s2.result.url));

  // 29c 优雅停止不受认证影响（lifecycle 路由不过闸门）
  const s3 = runHost({ id: 's29c', action: 'stop', payload: {} }, 's29c');
  expect(s3 && s3.ok === true && s3.result.state === 'stopped',
    '29 stop（auth）-> stopped', JSON.stringify(s3 && s3.result));
  expect(!(await portOpen(port, 2000)), '29 端口已关闭', '');

  // 29d 无 Accept-Encoding 回归（fake-dsh 打点：FAKE-REQ ... ae=ABSENT）
  let raw = '';
  try { raw = fs.readFileSync(logFile, 'utf8'); } catch (_) { /* 日志缺失 */ }
  const reqLines = raw.split('\n').filter((l) => l.indexOf('FAKE-REQ ') === 0);
  const badAe = reqLines.filter((l) => !/ ae=ABSENT(?: |$)/.test(l));
  expect(reqLines.length > 0 && badAe.length === 0,
    '29 探测请求均未携带 Accept-Encoding（ae=ABSENT）',
    'FAKE-REQ ' + reqLines.length + ' 行' + (badAe.length ? '；异常: ' + badAe[0] : ''));
  cleanup();

  // 29e 外部 auth 实例发现：httpDshProbe 经 /manifest.webmanifest 指纹通过
  const ext = spawn(process.execPath, [FAKE_DSH, '--port', String(port2)], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: Object.assign({}, process.env, { DSH_FAKE_AUTH: '1' }),
  });
  const extPids = [ext.pid];
  try {
    const okE = await waitPort(port2, 5000);
    expect(okE, '29 外部 auth fake-dsh 就绪', '');
    const hooks = {
      DSH_MANAGER_FAKE_PROCESSES: JSON.stringify([{ pid: ext.pid, cmdline: fakeDshCmdline(port2) }]),
    };
    const sE = runHost({ id: 's29e', action: 'status', payload: {} }, 's29e', hooks);
    expect(okE && sE && sE.ok === true && sE.result.state === 'external' && sE.result.port === port2,
      '29 外部 auth 实例 -> external（manifest 指纹通过）', JSON.stringify(sE && sE.result));
    // PORT_BUSY 指纹同样走 manifest：start 同端口 -> PORT_BUSY 且提示外部 dsh
    const sF = runHost({ id: 's29f', action: 'start', payload: { port: port2 } }, 's29f', hooks);
    expect(sF && sF.ok === false && sF.error && sF.error.code === 'PORT_BUSY' && /dsh/.test(sF.error.message || ''),
      '29 start 同端口（auth 外部）-> PORT_BUSY 且提示外部 dsh', JSON.stringify(sF && sF.error));
  } finally {
    await shutdownExternal(port2);
    await waitPidGone(ext.pid, 5000);
    cleanup(extPids);
  }
}

// ---------------------------------------------------------------------------
// M13 phase 2: ready file provides PID/port even without a URL line or HTTP readiness.
async function scenarioReadiness() {
  const env = { DSH_FAKE_READY: '1', DSH_FAKE_NO_URL: '1', DSH_FAKE_LOG_HEADERS: '1' };
  let previousId;
  for (const port of [31930, 0]) {
    const s = runHost({ id: 'ready-start', action: 'start', payload: { port } }, 'ready-start', env);
    expect(s?.ok && s.result.state === 'running', '30 ready file starts with HTTP 503, port=' + port);
    if (!s?.ok) throw new Error('readiness start failed: ' + JSON.stringify(s));
    const rec = readRunFile();
    const file = path.join(BASE, 'ready', 'dsh-web.json');
    const signal = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(rec.launchId === signal.launchId && rec.launchId !== previousId,
      '30 launch identity is unique and persisted');
    previousId = rec.launchId;
    expect(signal.pid === rec.pid && signal.port === rec.port && rec.port > 0,
      '30 plugin PID and actual port match run record');
    const logFile = path.join(BASE, 'logs', 'dsh-web.log');
    const before = fs.readFileSync(logFile, 'utf8').length;
    const status = runHost({ id: 'ready-status', action: 'status' }, 'ready-status', env);
    expect(status?.result?.state === 'running' && status.result.lifecycle === true
      && status.result.health.pid === rec.pid, '30 status uses plugin health');
    expect(!fs.readFileSync(logFile, 'utf8').slice(before).includes('FAKE-REQ'),
      '30 fresh readiness status sends zero HTTP requests');
    const stop = runHost({ id: 'ready-stop', action: 'stop' }, 'ready-stop', env);
    expect(stop?.ok && stop.result.state === 'stopped', '30 readiness instance stops');
    await waitPidGone(rec.pid, 5000);
    expect(!fs.existsSync(file), '30 normal exit removes readiness file');
    cleanup();
  }
}

// Source mode passes a fixed, host-owned patch before Web runtime flags.
async function scenarioSourceOverlay() {
  const port = 31931;
  const response = runHost({ id: 'source-start', action: 'start', payload: {
    port, launchMode: 'source', customPath: FAKE_DSH,
  } }, 'source-start', { DSH_BIN_STUB: '' });
  expect(response?.ok && response.result.state === 'running',
    '31 source 模式可从指定脚本启动', JSON.stringify(response && response.error));
  const patchFile = path.join(BASE, 'run', 'source-no-ssh.patch.yml');
  expect(fs.readFileSync(patchFile, 'utf8') === '- id: mcp-ssh\n  disabled: true\n',
    '31 覆盖文件只禁用 mcp-ssh');
  const record = readRunFile();
  expect(record?.cmdline.includes('--profile web --patch ' + patchFile + ' --host 127.0.0.1'),
    '31 --patch 位于 Web 参数之前', record && record.cmdline);
  const stop = runHost({ id: 'source-stop', action: 'stop' }, 'source-stop');
  expect(stop?.ok && stop.result.state === 'stopped', '31 source 模式可停止');
}

// Exercise actual launch-spec resolution, including the NPX branch (no stub).
async function scenarioCurrentCli() {
  fs.mkdirSync(TMP, { recursive: true });
  const patch = path.join(TMP, 'launcher.patch.yml');
  fs.writeFileSync(patch, '[]\n');
  const argsFile = path.join(TMP, 'launcher-args.json');
  const shim = path.join(TMP, 'npx-shim.js');
  fs.writeFileSync(shim, `process.argv = [process.execPath, ${JSON.stringify(FAKE_DSH)}, ...process.argv.slice(4)];\nrequire(${JSON.stringify(FAKE_DSH)});\n`);
  const npx = path.join(TMP, IS_WIN ? 'npx.cmd' : 'npx');
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(npx, IS_WIN
    ? `@echo off\r\n"${process.execPath}" "${shim}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(shim)} "$@"\n`, { mode: 0o755 });
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'PATH';
  for (const mode of ['npx', 'global', 'source']) {
    const env = { DSH_FAKE_STRICT_CLI: '1', DSH_FAKE_ARGS_FILE: argsFile,
      [pathKey]: TMP + path.delimiter + (process.env[pathKey] || ''),
      ...(mode !== 'global' ? { DSH_BIN_STUB: '' } : {}) };
    const start = runHost({ id: 'cli-start', action: 'start', payload: {
      launchMode: mode, customPath: mode === 'source' ? FAKE_DSH : '',
      port: 31932, extraArgs: ['--patch', patch],
    } }, 'cli-start', env);
    expect(start?.ok && start.result.state === 'running', '32 ' + mode + ' accepts current CLI arguments',
      start?.error && start.error.message);
    const argv = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    expect(argv[0] === '--profile' && argv[1] === 'web', '32 ' + mode + ' selects profile once');
    expect(argv.indexOf(patch) < argv.indexOf('--host'), '32 ' + mode + ' patch precedes Web arguments');
    const stop = runHost({ id: 'cli-stop', action: 'stop' }, 'cli-stop', env);
    expect(stop?.ok && stop.result.stopMethod === 'graceful', '32 ' + mode + ' stops gracefully');
  }
}

// 主流程
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== Whalekeeper 宿主冒烟测试 ===');
  console.log('root  =', ROOT);
  console.log('base  =', BASE);
  console.log('stub  =', FAKE_DSH);

  staticChecks();
  cleanup(); // 干净起点

  try { await scenarioPing(); } catch (e) { console.log('  场景 1 异常:', e.message); }
  cleanup();
  try { await scenarioStatusEmpty(); } catch (e) { console.log('  场景 2 异常:', e.message); }
  cleanup();
  try { await scenarioLifecycle(); } catch (e) { console.log('  场景 3-8 异常:', e.message); }
  cleanup();
  try { await scenarioPortBusy(); } catch (e) { console.log('  场景 9 异常:', e.message); }
  cleanup();
  try { await scenarioBadRequest(); } catch (e) { console.log('  场景 10 异常:', e.message); }
  cleanup();
  try { await scenarioLock(); } catch (e) { console.log('  场景 11 异常:', e.message); }
  cleanup();
  try { await scenarioStaleRecord(); } catch (e) { console.log('  场景 12 异常:', e.message); }
  cleanup();
  try { await scenarioStartTimeout(); } catch (e) { console.log('  场景 13 异常:', e.message); }
  cleanup();
  try { await scenarioGracefulStop(); } catch (e) { console.log('  场景 14 异常:', e.message); }
  cleanup();
  try { await scenarioExternalDetect(); } catch (e) { console.log('  场景 15 异常:', e.message); }
  cleanup();
  try { await scenarioExternalPortZero(); } catch (e) { console.log('  场景 16 异常:', e.message); }
  cleanup();
  try { await scenarioExternalNegative(); } catch (e) { console.log('  场景 17 异常:', e.message); }
  cleanup();
  try { await scenarioManagedWins(); } catch (e) { console.log('  场景 18 异常:', e.message); }
  cleanup();
  try { await scenarioAdopt(); } catch (e) { console.log('  场景 19 异常:', e.message); }
  cleanup();
  try { await scenarioHealth(); } catch (e) { console.log('  场景 20 异常:', e.message); }
  cleanup();
  try { await scenarioGracefulStopMethod(); } catch (e) { console.log('  场景 21 异常:', e.message); }
  cleanup();
  try { await scenarioNoLifecycle(); } catch (e) { console.log('  场景 22 异常:', e.message); }
  cleanup();
  try { await scenarioRestartWithPlugin(); } catch (e) { console.log('  场景 23 异常:', e.message); }
  cleanup();
  try { await scenarioLogs(); } catch (e) { console.log('  场景 24 异常:', e.message); }
  cleanup();
  try { await scenarioPortZero(); } catch (e) { console.log('  场景 25 异常:', e.message); }
  cleanup();
  try { await scenarioPosixPlatform(); } catch (e) { console.log('  场景 26 异常:', e.message); }
  cleanup();
  try { await scenarioCarrierLaunch(); } catch (e) { console.log('  场景 27 异常:', e.message); }
  cleanup();
  try { await scenarioSessions(); } catch (e) { console.log('  场景 28 异常:', e.message); }
  cleanup();
  try { await scenarioAuthCompat(); } catch (e) { console.log('  场景 29 异常:', e.message); }
  cleanup();
  try { await scenarioReadiness(); } catch (e) { record('readiness', '场景 30 异常', false, e.message); }
  cleanup();
  try { await scenarioSourceOverlay(); } catch (e) { record('source', '场景 31 异常', false, e.message); }
  cleanup();
  try { await scenarioCurrentCli(); } catch (e) { record('cli', '场景 32 异常', false, e.message); }
  cleanup();

  const failed = results.filter((r) => !r.ok);
  const passed = results.filter((r) => r.ok && !r.skip);
  const skipped = results.filter((r) => r.skip);
  console.log('=== 汇总 ===');
  console.log(`PASS ${passed.length} / FAIL ${failed.length} / SKIP ${skipped.length} / TOTAL ${results.length}`);
  if (skipped.length) {
    console.log('跳过项（SKIP）：');
    for (const f of skipped) console.log('  -', f.cat, f.name, f.detail);
  }
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log('  -', f.cat, f.name, f.detail);
  }
  process.exit(failed.length ? 1 : 0);
}

// pidAlive 工具（供场景 7 使用）
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) {
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

main().catch((e) => { console.error('smoke 主流程异常:', e); process.exit(2); });
