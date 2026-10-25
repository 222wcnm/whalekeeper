'use strict';

// Whalekeeper — background service worker
//
// 职责（docs/design.md §8.3）：
//   1. 串行化 native 调用：模块级 promise 链，一次只允许一个 connectNative 连接；
//   2. Native Messaging 消息收发：帧格式（4 字节小端长度前缀 + UTF-8 JSON）由
//      Chrome 平台与宿主（native-host/host.js §6.1）两侧实现，扩展只收发
//      JSON 对象，绝不手动编解码帧（Chrome 会自动序列化/反序列化）；
//   3. 本地健康探测（fetch GET /，1.5s 超时，任何 HTTP 响应码都算 up）；
//   4. chrome.alarms 周期刷新图标徽标；
//   5. onInstalled 初始化默认设置。
//
// 注意：MV3 下本文件是经典脚本（无 import/export），全局作用域即 SW 作用域。

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const NATIVE_HOST = 'com.dsh.manager';
const DEFAULT_SETTINGS = {
  port: 3080,
  profile: 'web',
  launchMode: 'global', // 'global' | 'npx' | 'source'
  customPath: '',       // 本地源码根目录或 bin.js 路径（launchMode === 'source' 时有效）
  autoOpen: true,
  badgeInterval: 30, // 秒；chrome.alarms 最小周期 0.5 分钟（30s）
  attention: true,   // M8：徽标提醒「该点回来看看了」（design §8.9）
  attentionDone: true, // M8.1：工作完成提醒「绿!」独立开关（默认开；语义见 §8.9；M10.1 定稿色）
  theme: 'follow-webui', // M6：与 popup.js 默认值保持一致（防 onInstalled 合并丢弃主题）
  retentionMins: 30, // M11：完成会话保留时长（分钟；5~1440，0=不显示已完成；与 popup.js 保持一致）
  // M10 颜色语义（design §8.12）——M10.1 定稿（2026-08-24 用户拍板）：三角色三色——
  // 待确认=琥珀黄 #f59e0b（webui 计划面板同色系）/ 进行中=webui 蓝 #5686fe / 完成=绿 #22c55e
  // （done 完成待办消息并入 completed 色：徽标「!」底色取 completed）；idle 不再展示；
  // error 红与字符语义锁定；与 popup.js DEFAULT_SETTINGS 保持一致（防 onInstalled 合并丢弃）
  colorMap: {
    waiting: '#f59e0b',
    working: '#5686fe',
    completed: '#22c55e',
  },
};
const PROBE_TIMEOUT_MS = 1500; // 探活超时
const NATIVE_TIMEOUT_MS = 30000; // 等待宿主响应兜底超时（默认）
// rc.2：宿主从 spawn 起共享 150s + 最多 5s URL 捕获；预检、停止与 IPC 留有余量。
// Native Messaging port 仅在该动作在途时持有；不依赖 Popup 存活，不使用常驻保活。
const ACTION_TIMEOUT_MS = {
  restart: 240000,
  start: 210000,
  stop: 60000,
  adopt: 45000,
  sessions: 8000, // M9：只读会话快查，含宿主 1.5s 端点超时
};

// ---------------------------------------------------------------------------
// M8/M8.1 徽标语义分层（design §8.9/§8.9.1，2026-08-22 用户决策；M10.1 定稿 2026-08-24）：
//   - 徽标（action badge）专职「会话状态层」：字符为主语义——
//     黄「?」= 等待（待确认，M10.1 定稿 #f59e0b，webui 计划面板同色系）、绿「!」= 工作完成
//     （M10.1 定稿 #22c55e——原琥珀随「完成=绿」定稿改绿）、蓝 n = n 个会话工作中
//     （#5686fe = webui --dsh-state-ongoing 同源色）；
//     优先级 waiting > done > working；全空 = 安静。实例运行状态不再上徽标（互斥覆盖问题）。
//   - 图标角标（action.setIcon）专职「实例状态层」：绿点 = 运行中、红点 = 错误、
//     无点 = 停止/未安装——与徽标字符同屏共存、互不覆盖（双载体分离）。
// 安全：只接受带 sender.tab 的上报（扩展自身页面无 tab，不可伪造他 tab）；
// 只存 tabId + kind + 计数 + 端口 + 时间戳，不存任何页面内容。
const ATTENTION_STORE_KEY = 'attentionMap';
const ATTENTION_TTL_MS = 4 * 3600 * 1000; // 4h 兜底防僵尸键（正常由 clear/onRemoved/onStartup 清理）
const ATTENTION_KINDS = { idle: 1, working: 1, waiting: 1, done: 1 };
// M12 popup 镜像桥（design §8.10.1）：面板 SSE 事件流 → storage 镜像（摘要 only）
const SESSIONS_CACHE_KEY = 'sessionsCache';
const SESSIONS_CACHE_MAX = 50; // 防御性上限（与宿主侧一致）；只存摘要 items，不存内容
let sessionsCache = {};        // { [port]: { items, at } } — 内存镜像，storage 为事实源
let sessionsCacheTimer = null; // 多帧爆发合并写（200ms 防抖）
// 会话状态层徽标：文字色显式白（徽标字符可见）；底色由 colorMap 运行时覆盖（M10），
// 此为无 colorMap（旧数据）时的兜底——M10.1 定稿：waiting 黄 / done（完成提醒）绿 / working 蓝
const SESSION_BADGES = {
  waiting: { text: '?', bg: '#f59e0b', fg: '#ffffff', title: 'dsh：正在等你确认（批准 / 问答 / 计划审查）——点回来看' },
  done: { text: '!', bg: '#22c55e', fg: '#ffffff', title: 'dsh：有一轮工作完成——回来看看' },
  working: { bg: '#5686fe', fg: '#ffffff' }, // text 动态（n / 9+，applyBadge 覆盖），无字面量
};

// M10 colorMap 规范化（SW 侧与 colors.js 同口径但零依赖：徽标渲染是纯字符串路径，
// 不能引入页面脚本）：徽标键（waiting/done/working）→ colorMap 键映射，白名单色值
// （预设色板），非法回退默认色板。M10.1：done 并入 completed 色（徽标「!」取 completed）。
const BADGE_COLOR_KEYS = { waiting: 'waiting', done: 'completed', working: 'working' };
const COLOR_PALETTE_HEX = ['#5686fe', '#f59e0b', '#8b5cf6', '#22c55e', '#ec1313', '#adb2b8'];
function normColorMap(map) {
  const out = {
    waiting: DEFAULT_SETTINGS.colorMap.waiting,
    done: DEFAULT_SETTINGS.colorMap.completed,
    working: DEFAULT_SETTINGS.colorMap.working,
  };
  if (map && typeof map === 'object') {
    for (const kind of Object.keys(BADGE_COLOR_KEYS)) {
      const v = String(map[BADGE_COLOR_KEYS[kind]] || '').toLowerCase();
      if (COLOR_PALETTE_HEX.indexOf(v) !== -1) out[kind] = v;
    }
  }
  return out;
}

// 实例状态层：图标角标（预生成 PNG 变体，tool _gen-icons.js）+ 无会话徽标时的 title
const ICON_PATHS = {
  default: { 16: 'icons/16.png', 48: 'icons/48.png', 128: 'icons/128.png' },
  ok: { 16: 'icons/ok-16.png', 48: 'icons/ok-48.png', 128: 'icons/ok-128.png' },
  error: { 16: 'icons/error-16.png', 48: 'icons/error-48.png', 128: 'icons/error-128.png' },
};
const STATE_TITLES = {
  ok: 'dsh web 运行中',
  down: 'dsh web 未运行',
  error: 'dsh web 状态异常——点开查看',
  hostMissing: 'dsh 未安装宿主——点开查看',
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ settings: DEFAULT_SETTINGS }, (data) => {
      const s = (data && data.settings) || {};
      resolve(Object.assign({}, DEFAULT_SETTINGS, s));
    });
  });
}

// 本地健康探测：GET http://127.0.0.1:<port>/，1.5s 超时；
// 任何 HTTP 响应码都算 up；fetch 抛错 -> false。
// M13（§2.1.1 B1）：dsh ≥ 0.1.2 起 GET / 无凭据返回 401——fetch 仍正常 resolve，
// 天然视为 up（401 恰证明 dsh 认证中间件已挂载），无需特判。
async function probePort(port) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch('http://127.0.0.1:' + port + '/', {
      signal: ctrl.signal,
      cache: 'no-store',
    });
    return { up: true };
  } catch (_) {
    return { up: false };
  } finally {
    clearTimeout(timer);
  }
}

// 未安装宿主的标准错误应答
function hostNotInstalled() {
  return {
    ok: false,
    error: {
      code: 'HOST_NOT_INSTALLED',
      message: '未安装宿主，请运行 native-host 目录下的 install.ps1 后重启浏览器',
    },
  };
}

// ---------------------------------------------------------------------------
// M8 徽标提醒状态（storage 为事实源；以下为镜像缓存，onChanged 保持同步）
// ---------------------------------------------------------------------------

let attentionCache = {};   // { [tabId]: {kind:'idle'|'working'|'waiting'|'done', working, waiting, at, port} }
let lastIconState = 'default'; // 'default'|'ok'|'error'（verify 只读探针；refreshBadge 更新）
let lastStateTitle = STATE_TITLES.down; // 无会话徽标时的 title（refreshBadge 更新）
let cachedSettings = Object.assign({}, DEFAULT_SETTINGS);

// 启动/唤醒时载入提醒镜像（规范化旧结构残留；完成后立即按当前状态渲染一次徽标）
function loadAttentionOnce() {
  chrome.storage.local.get({ [ATTENTION_STORE_KEY]: {} }, (d) => {
    attentionCache = pruneAttention((d && d[ATTENTION_STORE_KEY]) || {});
    applyBadge();
  });
}

// 计数/端口规范化：非负整数上限 99（字符区至多「9+」/「99」，端口上限 65535）
function boundNum(v, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(max, Math.floor(n)));
}

// 修剪：只保留合法 kind 与 TTL 内的条目（防僵尸键/脏数据；计数/端口规范化）
function pruneAttention(map) {
  const out = {};
  const now = Date.now();
  for (const key of Object.keys(map || {})) {
    const e = map[key];
    if (!e || !ATTENTION_KINDS[e.kind]) continue;
    if (!Number.isFinite(e.at) || now - e.at > ATTENTION_TTL_MS) continue;
    out[key] = {
      kind: e.kind,
      working: boundNum(e.working, 99),
      waiting: boundNum(e.waiting, 99),
      at: e.at,
      port: boundNum(e.port, 65535) || null, // 0 视为未知（动态端口未回填/无端口）
    };
  }
  return out;
}

// 聚合（多 dsh 标签全局）：waiting > done（最新）> working（计数合计）> null（安静）
// 2026-08-24 修复（同实例多标签重复计数）：attentionMap 是 tab 维度，而同一实例
// （相同端口）常被多个标签同时打开——各标签独立上报会被重复累加（「徽标蓝 2、
// popup 会话区进行中 1」类不一致）。聚合前先按端口归并：同端口只保留 at 最新的
// 条目；idle（无信号）不参与同端口竞争（保持「空=安静」语义）；无端口条目
// （外部/旧数据兼容）按 tab 独立参与。
function pickAggregate() {
  const byPort = new Map(); // key -> {kind, working, waiting, at}
  for (const key of Object.keys(attentionCache)) {
    const e = attentionCache[key];
    if (!e) continue;
    if (e.kind === 'idle') continue;
    const k = (Number.isInteger(e.port) && e.port > 0) ? 'p' + e.port : 't' + key;
    const prev = byPort.get(k);
    if (!prev || (e.at || 0) > (prev.at || 0)) byPort.set(k, e);
  }
  let waitingAny = false;
  let doneAt = 0;
  let workingSum = 0;
  for (const e of byPort.values()) {
    if (e.kind === 'waiting') waitingAny = true;
    else if (e.kind === 'done') doneAt = Math.max(doneAt, e.at || 0);
    workingSum += e.working || 0;
  }
  if (waitingAny) return { kind: 'waiting' };
  if (doneAt > 0 && cachedSettings.attentionDone !== false) return { kind: 'done' };
  if (workingSum > 0) return { kind: 'working', n: workingSum };
  return null;
}

// 只接受当前支持的 HTTP 回环实例；按有效端口归并，浏览器省略 :80 不等于未知。
function portFromUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)
      || parsed.username || parsed.password) return null;
    const port = parsed.port === '' ? 80 : Number(parsed.port);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  } catch (_) { return null; }
}

// content script 上报：仅 sender.tab 存在且为 dsh 回环页时接受（页面来源），
// 键 = 真实 tabId；attention 总关闭时忽略 set（design §8.9 item 4「关闭后忽略 set」）；
// attentionDone 关闭时忽略 done set（M8.1 独立开关）。
async function handleAttention(msg, sender) {
  const tabId = sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
  if (!tabId) return;
  // L3 加固：只接受 dsh 页面（127.0.0.1/localhost 回环）来源——扩展/其他页面的 content
  // script 无法伪造（其 tab.url 不在本扩展 host_permissions 内时不填充，同样被拒）
  const tabUrl = sender.tab.url;
  const instancePort = portFromUrl(tabUrl);
  if (instancePort === null) return;
  if (msg.op === 'clear') {
    if (!attentionCache[tabId]) return;
    delete attentionCache[tabId];
  } else if (msg.op === 'set') {
    if (cachedSettings.attention === false) return; // 关闭：忽略上报，不写 storage
    const kind = ATTENTION_KINDS[msg.kind] ? msg.kind : 'idle';
    if (kind === 'done' && cachedSettings.attentionDone === false) return; // 完成提醒独立开关
    const counts = msg.counts || {};
    attentionCache[tabId] = {
      kind,
      working: boundNum(counts.working, 99),
      waiting: boundNum(counts.waiting, 99),
      at: Date.now(),
      port: instancePort,
    };
  } else {
    return;
  }
  attentionCache = pruneAttention(attentionCache);
  try {
    await chrome.storage.local.set({ [ATTENTION_STORE_KEY]: attentionCache });
  } catch (_) { /* SW 生命周期竞态：缓存仍正确，下次 onChanged 收敛 */ }
  applyBadge();
}

// 死提醒联动（M8.1）：实例未运行（port 失活）时清除该端口的会话信号——
// 此前 4h TTL 内「实例已停、徽标仍挂黄?/绿!」的误导场景（design §8.9 item 3 修订）
async function clearAttentionForPort(port) {
  if (!port) return false;
  let removed = false;
  for (const key of Object.keys(attentionCache)) {
    const e = attentionCache[key];
    if (e && e.port === port) {
      delete attentionCache[key];
      removed = true;
    }
  }
  // M12：实例失活 → 同步清该端口镜像（popup 侧无陈旧摘要可渲染；保底 native 轮询）
  if (sessionsCache[String(port)]) {
    delete sessionsCache[String(port)];
    removed = true;
  }
  if (removed) {
    attentionCache = pruneAttention(attentionCache);
    try {
      await chrome.storage.local.set({
        [ATTENTION_STORE_KEY]: attentionCache,
        [SESSIONS_CACHE_KEY]: sessionsCache,
      });
    } catch (_) { /* 同上：缓存正确，onChanged 收敛 */ }
    applyBadge();
  }
  return removed;
}

// ---------------------------------------------------------------------------
// M12 会话镜像桥（sessions-sync）：面板 SSE 事件流 → storage.sessionsCache
// ---------------------------------------------------------------------------

// 规范化：只保留合法端口与数组条目（摘要 items ≤50，防御脏数据）
function sanitizeSessionsCache(map) {
  const out = {};
  for (const key of Object.keys(map || {})) {
    const port = Number(key);
    const e = map[key];
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    if (!e || typeof e !== 'object' || !Array.isArray(e.items)) continue;
    out[String(port)] = {
      items: e.items.slice(0, SESSIONS_CACHE_MAX),
      at: Number(e.at) || Date.now(),
    };
  }
  return out;
}

function scheduleSessionsCacheWrite() {
  if (sessionsCacheTimer) return;
  sessionsCacheTimer = setTimeout(() => {
    sessionsCacheTimer = null;
    chrome.storage.local.set({ [SESSIONS_CACHE_KEY]: sessionsCache }).catch(() => { /* SW 竞态：静默 */ });
  }, 200);
}

// M12：面板上报摘要 items（只读摘要元数据，不读消息内容——§12.2/§8.10.1 边界）。
// 与 attention 同款 L3 校验：仅带 sender.tab 且 URL 为 dsh 回环页；端口从 tab.url 解析。
async function handleSessionsSync(msg, sender) {
  const tabId = sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
  if (!tabId) return;
  const tabUrl = sender.tab.url;
  const port = portFromUrl(tabUrl);
  if (!port) return;
  const items = Array.isArray(msg.items) ? msg.items.slice(0, SESSIONS_CACHE_MAX) : [];
  sessionsCache[String(port)] = { items, at: Date.now() };
  scheduleSessionsCacheWrite();
}

// 启动/唤醒时载入既有镜像（供 popup 立即渲染；SW 重建后由面板下一帧同步自愈）
function loadSessionsCacheOnce() {
  chrome.storage.local.get({ [SESSIONS_CACHE_KEY]: {} }, (d) => {
    sessionsCache = sanitizeSessionsCache((d && d[SESSIONS_CACHE_KEY]) || {});
  });
}

// ---------------------------------------------------------------------------
// 串行 native 调用
// ---------------------------------------------------------------------------

// 模块级 promise 链：一次只允许一个 connectNative 连接，其余排队。
// 该状态允许 MV3 SW 重启后丢失：SW 被回收时已建立的 Native Messaging port 会随之
// 断开，调用方（popup）侧的消息通道也会关闭并收到 reject，不会永久挂起；
// 重启后新调用重新建立队列，宿主端（host.js）另有全局锁保证串行排他，双保险。
let nativeQueue = Promise.resolve();

function enqueueNativeCall(id, action, payload) {
  const timeoutMs = ACTION_TIMEOUT_MS[action] || NATIVE_TIMEOUT_MS;
  const task = nativeQueue.then(() => runNativeCall(id, action, payload, timeoutMs));
  // 队列吞掉错误，避免后续任务因前一个失败而断链
  nativeQueue = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

// 单次 native 往返：连接 -> postMessage 请求对象 -> 按 id 匹配响应（超时兜底）-> 断开
function runNativeCall(id, action, payload, timeoutMs) {
  return new Promise((resolve) => {
    let port = null;
    let timer = null;
    let settled = false;

    const finish = (resp) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (port !== null) {
        try { port.disconnect(); } catch (_) { /* 忽略 */ }
      }
      resolve(resp);
    };

    const isHostMissingError = (msg) =>
      typeof msg === 'string' && /not found|not installed/i.test(msg);

    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      finish(isHostMissingError(msg) ? hostNotInstalled()
        : { ok: false, error: { code: 'NATIVE_ERROR', message: msg } });
      return;
    }

    // Chrome Native Messaging 自带 4 字节长度前缀 + JSON 帧（design §6.1），
    // onMessage 直接收到解析后的对象；禁止在此手动编解码帧。
    port.onMessage.addListener((obj) => {
      if (obj && typeof obj === 'object' && obj.id === id) finish(obj);
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      const err = chrome.runtime.lastError;
      const msg = err && err.message ? err.message : '';
      if (isHostMissingError(msg)) {
        finish(hostNotInstalled());
      } else {
        finish({
          ok: false,
          error: {
            code: 'NATIVE_ERROR',
            message: msg || '宿主连接意外断开',
          },
        });
      }
    });

    timer = setTimeout(() => {
      finish({
        ok: false,
        error: { code: 'NATIVE_ERROR', message: '等待宿主响应超时（' + Math.round(timeoutMs / 1000) + ' 秒）' },
      });
    }, timeoutMs);

    try {
      port.postMessage({ id, action, payload });
    } catch (e) {
      finish({
        ok: false,
        error: {
          code: 'NATIVE_ERROR',
          message: (e && e.message) ? e.message : String(e),
        },
      });
    }
  });
}

// ---------------------------------------------------------------------------
// 消息路由（popup -> SW）
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'native') {
    const id = (typeof msg.id === 'string' && msg.id) ||
      'sw-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const action = String(msg.action || '');
    const payload = (msg.payload && typeof msg.payload === 'object') ? msg.payload : {};
    enqueueNativeCall(id, action, payload).then((resp) => {
      try { sendResponse(resp); } catch (_) { /* 消息通道已关闭（popup 已关闭/页面刷新），忽略 */ }
    });
    return true; // 异步应答
  }

  if (msg.type === 'probe') {
    const port = Number(msg.port);
    probePort(Number.isFinite(port) ? port : DEFAULT_SETTINGS.port).then((resp) => {
      try { sendResponse(resp); } catch (_) { /* 消息通道已关闭，忽略 */ }
    });
    return true; // 异步应答
  }

  // M8 徽标提醒：content script 上报（页面后台时 工作完成/等待用户）
  if (msg.type === 'attention') {
    handleAttention(msg, sender); // 无需应答；失败静默（panel.js 侧不 await 结果）
    return false;
  }

  // M12 会话镜像：面板 SSE 事件流 → storage.sessionsCache（popup 镜像桥）
  if (msg.type === 'sessions-sync') {
    handleSessionsSync(msg, sender);
    return false;
  }

  return false;
});

// ---------------------------------------------------------------------------
// 徽标（chrome.alarms 刷新 + M8 提醒分层）
// ---------------------------------------------------------------------------

// 刷新实例状态层（alarm 驱动/启动时；探测不惊动宿主，见 §8.3）：
// 图标角标（绿点=运行/红点=错误/无点=停止）+ 服务态 title；
// 实例未运行 → 死提醒联动清对应端口会话信号（M8.1）。
async function refreshBadge() {
  const s = await getSettings();
  cachedSettings = Object.assign({}, DEFAULT_SETTINGS, s);
  const rawPort = Number(s.port);
  const port = Number.isFinite(rawPort) && rawPort >= 0 ? rawPort : DEFAULT_SETTINGS.port;
  let iconState = 'default';
  let title = STATE_TITLES.down;
  if (port === 0) {
    // M4：port 0（动态端口）无法本地探活——经 native status 判定（宿主解析日志/记录中的实际端口）
    const resp = await enqueueNativeCall('bg-badge-' + Date.now().toString(36), 'status', {});
    const st = resp && resp.ok && resp.result ? resp.result.state : null;
    const p = resp && resp.ok && resp.result ? resp.result.port : 0;
    if (st === 'running' || st === 'external') {
      iconState = 'ok';
      title = STATE_TITLES.ok + (p ? ' (端口 ' + p + ')' : '');
    } else if (st === 'error') {
      iconState = 'error';
      title = STATE_TITLES.error;
      await clearAttentionForPort(p);
    } else if (resp && resp.error && resp.error.code === 'HOST_NOT_INSTALLED') {
      iconState = 'error'; // 未安装宿主 = 需处理的异常（红点=错误专语义）
      title = STATE_TITLES.hostMissing;
      await clearAttentionForPort(p);
    } else {
      iconState = 'default';
      title = STATE_TITLES.down;
      await clearAttentionForPort(p);
    }
  } else {
    const { up } = await probePort(port);
    if (up) {
      iconState = 'ok';
      title = STATE_TITLES.ok + ' (端口 ' + port + ')';
    } else {
      iconState = 'default';
      title = STATE_TITLES.down;
      await clearAttentionForPort(port); // 死提醒联动：实例停止 → 清该端口会话信号
    }
  }
  lastIconState = iconState;
  lastStateTitle = title;
  chrome.action.setIcon({ path: ICON_PATHS[iconState] });
  applyBadge();
}

// 徽标（会话状态层）最终渲染：waiting > done > working（蓝 n）；无信号 = 清徽标。
// 实例状态层由图标角标表达（refreshBadge 设置），与徽标同屏共存、互不覆盖（§8.9.1）。
function applyBadge() {
  const e = cachedSettings.attention !== false ? pickAggregate() : null;
  if (e) {
    // M10：底色运行时读 colorMap（一处配置、全域同语义；字符/文字仍为锁定主语义）
    const cm = normColorMap(cachedSettings.colorMap);
    const proto = e.kind === 'working'
      ? { text: e.n >= 10 ? '9+' : String(e.n), bg: cm.working, fg: SESSION_BADGES.working.fg, title: 'dsh：' + e.n + ' 个会话正在工作（回到 dsh 页面查看）' }
      : Object.assign({}, SESSION_BADGES[e.kind], { bg: cm[e.kind] });
    const b = proto;
    chrome.action.setBadgeText({ text: b.text });
    chrome.action.setBadgeBackgroundColor({ color: b.bg });
    chrome.action.setBadgeTextColor({ color: b.fg });
    chrome.action.setTitle({ title: b.title });
    return;
  }
  chrome.action.setBadgeText({ text: '' }); // 空字符 → 徽标整体不渲染（M7 修补）
  chrome.action.setTitle({ title: lastStateTitle });
}

// 按设置重建徽标告警（默认 badgeInterval=30 -> periodInMinutes=0.5；Chrome 最小周期 30s）
function ensureBadgeAlarm() {
  getSettings().then((s) => {
    const sec = Math.max(30, Number(s.badgeInterval) || DEFAULT_SETTINGS.badgeInterval);
    chrome.alarms.create('badge', { periodInMinutes: sec / 60 });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === 'badge') refreshBadge();
});

// 设置变更（popup 保存）后立即重建徽标周期；提醒/设置变动同步镜像缓存并重渲染徽标
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  let purged = false; // 本回调已按开关清理内存（防止 newValue 旧快照把已删条目恢复回内存）
  if (changes.settings) {
    const wasOn = cachedSettings.attention !== false;
    const wasDoneOn = cachedSettings.attentionDone !== false;
    cachedSettings = Object.assign({}, DEFAULT_SETTINGS, changes.settings.newValue || {});
    // 本次 set 若同时携带 attentionMap（编程/测试写入），以其 newValue 为权威——
    // done 条目可能在快照里尚未进入内存镜像（onChanged 回调时序），清空逻辑必须以它为基
    const newMap = changes[ATTENTION_STORE_KEY]
      ? (changes[ATTENTION_STORE_KEY].newValue || {})
      : attentionCache;
    // H1：总开关关闭的瞬间清空累积条目——重开时以当前页面实时状态为准，不冒陈旧提醒
    if (wasOn && cachedSettings.attention === false && Object.keys(newMap).length) {
      attentionCache = {};
      purged = true;
      chrome.storage.local.set({ [ATTENTION_STORE_KEY]: {} });
    } else if (wasDoneOn && cachedSettings.attentionDone === false) {
      // H1 对称（M8.1 盲审发现）：done 独立开关关闭的瞬间剔除既有 done 条目——
      // 重开时不冒陈旧「工作完成」（期间 done 也不会被新写入，set 分支前置拒绝）；
      // idle/working/waiting 条目不受影响
      const cleaned = pruneAttention(newMap);
      let removed = false;
      for (const key of Object.keys(cleaned)) {
        if (cleaned[key] && cleaned[key].kind === 'done') {
          delete cleaned[key];
          removed = true;
        }
      }
      if (removed) {
        attentionCache = pruneAttention(cleaned);
        purged = true;
        chrome.storage.local.set({ [ATTENTION_STORE_KEY]: attentionCache });
      }
    }
    ensureBadgeAlarm();
    applyBadge();
  }
  if (changes[ATTENTION_STORE_KEY]) {
    if (!purged) {
      // 未被开关清理（常规 set/clear 路径）：采用 storage 新值
      attentionCache = changes[ATTENTION_STORE_KEY].newValue || {};
    }
    // purged 时内存已按清理结果收敛（二次写回会再触发本监听器收敛）
    applyBadge();
  }
});

// ---------------------------------------------------------------------------
// 安装/启动初始化
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  // 初始化默认设置（不覆盖用户已有值）
  chrome.storage.local.get({ settings: DEFAULT_SETTINGS }, (data) => {
    const merged = Object.assign({}, DEFAULT_SETTINGS, (data && data.settings) || {});
    chrome.storage.local.set({ settings: merged });
  });
  // M8：扩展重载/更新后旧 content script 成为孤儿（无法再发 clear），清空旧提醒
  // M12：镜像同步清理（面板重注入后经 SSE 快照自愈）
  attentionCache = {};
  sessionsCache = {};
  chrome.storage.local.set({ [ATTENTION_STORE_KEY]: {}, [SESSIONS_CACHE_KEY]: {} });
  ensureBadgeAlarm();
  refreshBadge();
});

chrome.runtime.onStartup.addListener(() => {
  // M8：浏览器重启后的旧提醒无意义（标签恢复后 content script 会按新状态重新判定）
  // M12：镜像同步清理（同上）
  attentionCache = {};
  sessionsCache = {};
  chrome.storage.local.set({ [ATTENTION_STORE_KEY]: {}, [SESSIONS_CACHE_KEY]: {} });
  ensureBadgeAlarm();
  refreshBadge();
});

// M8：dsh 标签页被关闭 → 其提醒条目随之删除；同标签导航离开 dsh（tab 未关闭，
// content script 已随页面卸载）→ 由 SW 按 URL 兜底清理（M2 反残留）
chrome.tabs.onRemoved.addListener((tabId) => {
  if (!attentionCache[tabId]) return;
  delete attentionCache[tabId];
  chrome.storage.local.set({ [ATTENTION_STORE_KEY]: attentionCache });
  applyBadge();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return; // 仅 URL 变化时判定（标题/图标等变化与归属无关）
  if (portFromUrl(changeInfo.url) !== null) return; // 仍在支持的 HTTP 回环页
  if (!attentionCache[tabId]) return;
  delete attentionCache[tabId];
  chrome.storage.local.set({ [ATTENTION_STORE_KEY]: attentionCache });
  applyBadge();
});

// SW 被唤醒（如用户重新加载扩展）时立即刷新一次徽标
loadAttentionOnce(); // M8：先载入提醒镜像（回调内 applyBadge），再补服务态
loadSessionsCacheOnce(); // M12：会话镜像（popup 打开时即时可渲染）
refreshBadge();
