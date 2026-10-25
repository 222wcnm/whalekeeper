'use strict';

// Whalekeeper — popup 逻辑
//
// 行为（docs/design.md §8.2）：
//   1. 打开即调 status，随后每 2s 轮询（popup 关闭自动停止）；
//   2. 所有 native 请求经 SW 中转（chrome.runtime.sendMessage，MV3 返回 Promise）；
//   3. starting 就绪后按 settings.autoOpen 自动打开 Web UI；
//   4. 错误态展示错误码中文文案 + [复制日志]；
//   5. 内嵌设置面板，保存到 chrome.storage.local（key 'settings'）；
//   6. external 状态（§6.6/§6.7）：蓝点 + 接管按钮，可接管后由扩展管理；
//   7. 点击反馈：操作立即乐观更新（按钮禁用+转圈+进度条+阶段文案+耗时），
//      完成后 toast 确认（启动完成/已停止/重启完成/接管成功/失败原因）；
//      操作在途（native ack 前）暂停轮询，避免 SW 串行队列堆积。

const $ = (id) => document.getElementById(id);

// 错误码中文文案（与 docs/design.md §6.2 表一致）
const ERROR_TEXTS = {
  DSH_NOT_FOUND: '未检测到 dsh，请先执行 npm i -g @deepseek-ai/dsh',
  PORT_BUSY: '端口已被其他程序占用，请在设置中更换端口',
  ALREADY_RUNNING: 'dsh web 已在运行（幂等成功）',
  ALREADY_STOPPED: 'dsh web 已停止（幂等成功）',
  START_TIMEOUT: '启动超时：等待服务就绪未完成，请查看日志',
  STOP_FAILED: '停止失败：无法终止 dsh 进程，请检查权限或手动处理',
  EXTERNAL_UNMANAGED: '未找到可接管的外部实例（可能已退出或变化）；请重新打开面板刷新，或在其原终端停止',
  BUSY: '操作进行中，请稍候再试',
  BAD_REQUEST: '请求参数错误（开发期诊断）',
  INTERNAL: '宿主内部错误，请查看日志',
  HOST_NOT_INSTALLED: '未安装宿主，请运行 native-host 目录下的 install.ps1 后重启浏览器',
  NATIVE_ERROR: '与宿主通信失败，请确认已安装宿主并重启浏览器',
};

const DEFAULT_SETTINGS = {
  port: 3080, profile: 'web', autoOpen: true, badgeInterval: 30, theme: 'follow-webui',
  launchMode: 'global', // 'global' | 'npx' | 'source'
  customPath: '',       // 本地源码目录或 bin.js 路径
  attention: true, attentionDone: true,
  // M11 会话感知(design §8.10 演进):完成会话保留时长(分钟)——刚完成的会话在此
  // 时间窗内显示,过期/已读后从列表消失;5~1440,0 = 从不显示已完成。
  retentionMins: 30,
  // M10 颜色语义（design §8.12）：五角色预设色板（提案值，体验后定稿）；error 红与
  // 字符语义锁定；与 background.js DEFAULT_SETTINGS 保持一致（防 onInstalled 合并丢弃）
  colorMap: DSHColors.DEFAULT_COLOR_MAP,
};

// 清洗本地路径输入：剥除首尾双引号/单引号/空格，去除尾部反斜杠（防 Windows 命令行转义问题）
function sanitizePathInput(val) {
  let s = (val || '').trim();
  while ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  if (!/^[A-Za-z]:[\\/]$/.test(s) && s.length > 1) {
    s = s.replace(/[\\/]+$/, '');
  }
  return s;
}

// 操作进行中的按钮文案与阶段说明（点击反馈）
const ACTION_LABELS = {
  start: { idle: '启动', busy: '启动中…', progress: { starting: '正在启动：等待端口就绪' } },
  stop: { idle: '停止', busy: '停止中…', progress: { stopping: '正在停止：等待端口关闭' } },
  restart: {
    idle: '重启', busy: '重启中…',
    progress: { restarting: '正在重启：等待宿主完成并确认服务就绪' },
  },
  adopt: { idle: '接管', busy: '接管中…', progress: { starting: '正在接管外部实例' } },
};

let settings = null;
let state = 'unknown'; // stopped | starting | running | stopping | error | external | unknown
let detail = null; // 最近一次 status 的 result
let lastError = null; // { code, message, logTail? }
// pending —— 用户发起、尚未收敛到终态的操作（乐观反馈：按钮转圈 + 进度条 + 阶段文案）
// { action, phase: 'stopping' | 'starting' | 'restarting', atMs, ack }；ack=true 表示 native 请求在途
let pending = null;
let startedAtMs = null; // running 起点（用于 mm:ss 时长）
let reqSeq = 0;
let pollTimer = null;
let tickTimer = null;
let toastTimer = null;
let refreshing = false; // 手动刷新在途：btn-refresh 转圈 + 禁用，防止重入
let lastDriftKey = null; // 上次状态漂移提示的键（相同漂移去重）

// M9 会话区（design §8.10）：只读摘要元数据（{available, items}），不读消息内容。
// sessionsData===null 表示尚未拿到数据或请求失败（会话区隐藏）。
let sessionsData = null;
let sessionsRevision = 0; // mirror 到达后，丢弃此前在途的 native 快照（包括失败）
let sessionsRequestSeq = 0;
let sessionsUpdatedAt = 0;
let sessionsMirrorTimer = null;
let sessionsFromMirror = false;
const SESSIONS_MIRROR_MAX_AGE_MS = 5000; // 镜像没有连接状态字段，过期只依赖 native 2s 保底

// M11 已读机制（本地展示层，不触碰 dsh 数据）：readSessions { [sessionId]: readAt }。
// 已读只作用于「已完成会话」：readAt 晚于完成时刻 → 隐藏；会话重新活跃（working/
// waiting）自动重现；再次完成后完成时刻更新 → 重新出现，需再次已读。
const READ_STORE_KEY = 'readSessions';
let readSessions = {};
// 已读倒计时（原地微药丸「已读 · 撤销 3s」，点已读后 REMAIN 秒内可撤销）：
let pendingReadMap = {}; // { [sessionId]: { remaining, intervalId } }
const READ_COUNTDOWN_SECONDS = 3;
let readTimers = []; // 全部倒计时 setInterval 句柄（unload 统一清理）

// 防抖：会话区渲染签名。status 轮询(2s) + refreshSessions 返回都会重入 applySessions；
// 签名未变时直接短路（全量重建会让 hover 态丢失/点阵动画跳相，表现为闪烁抽动）。
let lastSessionSig = null;

function sessionRenderSig() {
  const dshOff = state === 'stopped' || state === 'error' || state === 'unknown';
  const items = (sessionsData && Array.isArray(sessionsData.items)) ? sessionsData.items : [];
  return JSON.stringify({
    avail: !!(sessionsData && sessionsData.available === true),
    off: dshOff,
    r: settings ? settings.retentionMins : DEFAULT_SETTINGS.retentionMins,
    rd: readSessions,
    pd: Object.keys(pendingReadMap),
    items: items.map((it) => [
      it.sessionId, it.state, it.updatedAt, it.title || '',
      it.hasActiveChildren, JSON.stringify(it.childRuns || []),
    ]),
  });
}

// 已完成会话的「新鲜」判定：完成时刻距今 ≤ retentionMins（0 = 永不显示已完成）。
function isFreshCompleted(item, now) {
  const mins = settings && Number.isFinite(Number(settings.retentionMins))
    ? Number(settings.retentionMins)
    : DEFAULT_SETTINGS.retentionMins;
  if (!(mins > 0)) return false;
  const ageMs = now - (item.updatedAt || now);
  return ageMs >= 0 && ageMs <= mins * 60000;
}

function readAtOf(id) {
  const v = readSessions[id];
  return typeof v === 'number' ? v : 0;
}

function saveReadSessions() {
  // 防膨胀兜底：超过上限时按最旧已读时间裁剪（纯展示层记录，过期只影响「已完成」是否隐藏）
  const MAX_READ = 500;
  const keys = Object.keys(readSessions);
  if (keys.length > MAX_READ) {
    keys.sort((a, b) => (readSessions[a] || 0) - (readSessions[b] || 0));
    for (const k of keys.slice(0, keys.length - MAX_READ)) delete readSessions[k];
  }
  chrome.storage.local.set({ [READ_STORE_KEY]: readSessions });
}

function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// M11 会话感知（design §8.10 演进）：四态 —— waiting > working/已停止(有子代理) >
// 已完成(新鲜且未已读)；idle 不渲染；语义色沿用 M10.1 定稿（蓝=进行中/黄=待确认/
// 绿=完成,已停止与已完成同族以文字区分）。

// 呼吸同步（2026-08-23 用户反馈：呼吸效果整个 popup 同步）：
// 以 popup 打开时刻为全局时钟零点，每个呼吸点（状态卡 running/external + 会话四态）
// 渲染时设置负 animation-delay（--dot-align-delay：out 至伪元素）折算回同一相位——
// CSS 动画从元素插入时刻起算，后渲染的点会晚走一段（不同步），负 delay 则等效于
// 「从 popup 打开（零点）就开始播放」。周期须与 popup.css 的 dsh-dot-breathe /
// dsh-halo-breathe 2.2s 一致。busy 脉冲（1.2s 秒级过渡态）不参与对齐。
const BREATHE_MS = 2200;
const BREATHE_T0 = performance.now();
function alignBreathe(el) {
  const elapsed = (performance.now() - BREATHE_T0) % BREATHE_MS;
  el.style.setProperty('--dot-align-delay', '-' + Math.round(elapsed) + 'ms');
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

let activeTab = 'dash'; // 'dash' | 'sess' | 'sett'

async function init() {
  DSHTheme.init(); // M6：尽早应用主题（避免浅色闪烁），并订阅 storage/webuiTheme + matchMedia
  DSHColors.init(); // M10：尽早应用颜色语义变量（settings.colorMap → --dsh-mgr-sem-*）
  if (typeof injectDSHAssets === 'function') injectDSHAssets(); // 注入官方原生 SVG 资产
  bindEvents();
  await loadSettings();
  await loadReadSessions(); // M11：已读记录（本地展示层）
  renderSettingsForm();
  initSessionsMirror(); // M12：storage 镜像桥（面板 SSE → SW → sessionsCache → popup）
  await refreshStatus();
  refreshSessions(); // M9：会话摘要（只读，失败静默降级）
  pollTimer = setInterval(refreshStatus, 2000);
  tickTimer = setInterval(() => {
    renderUptime();
    renderProgress(); // 每秒刷新操作耗时
    if (pending) renderStatusCard(); // 操作在途时每秒刷新状态卡内的已耗时
  }, 1000);
}

// M12：订阅镜像变化（面板 SSE 事件流经 SW 写 sessionsCache）+ 初始载入
function initSessionsMirror() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.sessionsCache) return;
    applyMirrorSessions(changes.sessionsCache.newValue || {});
  });
  chrome.storage.local.get({ sessionsCache: {} }, (d) => {
    applyMirrorSessions((d && d.sessionsCache) || {});
  });
}

function bindEvents() {
  // V6 导轨导航按钮
  $('v6-r-dash').addEventListener('click', () => switchV6('dash'));
  $('v6-r-sess').addEventListener('click', () => switchV6('sess'));
  $('v6-r-sett').addEventListener('click', () => switchV6('sett'));
  $('btn-sess-open').addEventListener('click', () => openWebUI());

  // 兼容旧按钮 ID 契约
  const btnSett = $('btn-settings');
  if (btnSett) btnSett.addEventListener('click', () => switchV6(activeTab === 'sett' ? 'dash' : 'sett'));
  const btnRef = $('btn-refresh');
  if (btnRef) btnRef.addEventListener('click', manualRefresh);

  $('btn-save').addEventListener('click', saveSettings);
  $('btn-cancel').addEventListener('click', () => switchV6('dash'));
  $('btn-start').addEventListener('click', () => doAction('start'));
  $('btn-stop').addEventListener('click', () => doAction('stop'));
  $('btn-restart').addEventListener('click', () => doAction('restart'));
  $('btn-adopt').addEventListener('click', () => doAction('adopt'));
  $('btn-open').addEventListener('click', () => openWebUI());
  $('btn-copy-log').addEventListener('click', copyLog);
  $('btn-logs').addEventListener('click', openLogs);
  const btnBannerRestart = $('btn-banner-restart');
  if (btnBannerRestart) {
    btnBannerRestart.addEventListener('click', () => doAction('restart'));
  }

  const portText = $('port-text');
  if (portText) {
    portText.addEventListener('click', async () => {
      const port = (portText.textContent || '').trim();
      if (!port || port === '-' || isNaN(Number(port))) return;
      const url = `http://127.0.0.1:${port}`;
      try {
        await navigator.clipboard.writeText(url);
        showToast(`已复制 ${url}`, 'success');
      } catch (_) {
        showToast(`服务地址: ${url}`, 'info');
      }
    });
  }

  // 输入时清除无效反馈
  $('set-port').addEventListener('input', () => clearFieldInvalid('set-port'));
  $('set-badge').addEventListener('input', () => clearFieldInvalid('set-badge'));
  $('set-retention').addEventListener('input', () => clearFieldInvalid('set-retention')); // M11
  const launchModeEl = $('set-launch-mode');
  if (launchModeEl) {
    launchModeEl.addEventListener('change', () => {
      clearFieldInvalid('set-custom-path');
      updateLaunchModeUI();
    });
  }
  const customPathEl = $('set-custom-path');
  if (customPathEl) {
    customPathEl.addEventListener('input', () => clearFieldInvalid('set-custom-path'));
    customPathEl.addEventListener('blur', () => {
      customPathEl.value = sanitizePathInput(customPathEl.value);
    });
  }

  // 外观行（M6）：点选即生效（写入 settings.theme + 即时应用，不弹 toast、不触发 saveSettings）
  document.querySelectorAll('.theme-cube').forEach((btn) => {
    btn.addEventListener('click', () => onThemeSelect(btn.getAttribute('data-theme')));
  });
  // radiogroup 键盘导航（roving tabindex + 方向键/Home/End）
  const tgrid = $('theme-grid');
  if (tgrid) tgrid.addEventListener('keydown', onThemeGridKeydown);

  // M10 颜色语义（design §8.12）：预设色盘点选即生效
  const cgrid = $('colors-grid');
  if (cgrid) {
    cgrid.addEventListener('click', (e) => {
      const btn = e.target.closest('.color-swatch-halo, .color-swatch');
      if (!btn) return;
      onColorSelect(btn.getAttribute('data-role'), btn.getAttribute('data-color'));
    });
    cgrid.addEventListener('keydown', onColorGridKeydown);
  }
  const btnCReset = $('btn-colors-reset');
  if (btnCReset) btnCReset.addEventListener('click', onColorReset);

  window.addEventListener('unload', () => {
    if (pollTimer) clearInterval(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
    for (const t of readTimers) clearInterval(t);
    readTimers = [];
    if (sessionsMirrorTimer) clearTimeout(sessionsMirrorTimer);
  });
}

// V6 导轨面板切换 (带平滑进场动效)
function switchV6(tab) {
  activeTab = tab;
  ['dash', 'sess', 'sett'].forEach((t) => {
    const r = $('v6-r-' + t);
    const p = $('v6-p-' + t);
    if (r) r.classList.toggle('active', t === tab);
    if (p) {
      p.classList.toggle('hidden', t !== tab);
      if (t === tab) {
        p.classList.remove('panel-slide-in');
        void p.offsetWidth; // 触发重绘以平滑进场
        p.classList.add('panel-slide-in');
      }
    }
  });
  if (tab === 'sett') {
    renderSettingsForm();
    const serr = $('settings-error');
    if (serr) serr.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// 与 SW 通信
// ---------------------------------------------------------------------------

async function nativeRequest(action, payload) {
  const id = 'p' + (++reqSeq) + '-' + Date.now().toString(36);
  const resp = await chrome.runtime.sendMessage({
    type: 'native',
    id,
    action,
    payload: payload || {},
  });
  return resp || { ok: false, error: { code: 'NATIVE_ERROR', message: '宿主无响应' } };
}

// ---------------------------------------------------------------------------
// 状态轮询
// ---------------------------------------------------------------------------

async function refreshStatus() {
  // 操作请求在途时跳过轮询：SW 串行队列会让 status 排在操作之后，白白堆积
  if (pending && pending.ack) return;
  const reqAt = Date.now(); // 快照发出时刻（用于识别"早于操作"的旧快照）
  let resp;
  try {
    resp = await nativeRequest('status', {});
  } catch (_) {
    setError({ code: 'NATIVE_ERROR', message: '无法连接扩展后台，请重新打开面板' });
    return;
  }
  if (!resp.ok) {
    setError(resp.error || { code: 'NATIVE_ERROR', message: '未知错误' });
    return;
  }
  // 快照早于操作发起（请求在途时用户点了操作）：丢弃，等应答后轮询收敛
  if (pending && pending.atMs > reqAt) return;
  clearError();
  applyStatus(resp.result || {});
  if (state === 'running' || state === 'external') refreshSessions(); // M9：随状态轮询刷新会话摘要
}

// 手动刷新：直接拉取一次 status 并应用结果（与 refreshStatus 一致）。
// 有 pending（操作在途/乐观反馈中）时静默忽略，避免破坏乐观反馈。
async function manualRefresh() {
  if (refreshing) return; // 防重入
  if (pending) return; // 操作在途：保持按钮禁用、乐观反馈不被破坏
  refreshing = true;
  const btn = $('btn-refresh');
  btn.classList.add('is-pending');
  btn.disabled = true;
  try {
    const reqAt = Date.now(); // 快照发出时刻（用于识别"早于操作"的旧快照）
    let resp;
    try {
      resp = await nativeRequest('status', {});
    } catch (_) {
      setError({ code: 'NATIVE_ERROR', message: '无法连接扩展后台，请重新打开面板' });
      return;
    }
    if (!resp.ok) {
      setError(resp.error || { code: 'NATIVE_ERROR', message: '未知错误' });
      return;
    }
    if (pending && pending.atMs > reqAt) return; // 快照早于操作发起：丢弃
    clearError();
    applyStatus(resp.result || {});
  } finally {
    refreshing = false;
    btn.classList.remove('is-pending');
    btn.disabled = false;
  }
}

function applyStatus(result) {
  const prev = state;
  const previousPort = detail && detail.port;
  state = result.state || 'unknown';
  detail = result;
  if ((state !== 'running' && state !== 'external') || previousPort !== detail.port) invalidateSessions();

  // 状态漂移通知（无用户操作时；首次 init 的 prev='unknown' 不触发）
  if (!pending && prev !== 'unknown') {
    notifyDrift(prev, state);
  }

  // ack=true 表示操作请求仍在途：status 快照可能早于操作，不得判定终态
  // （否则 restart 应答前的 stopped 旧快照会误清 pending，见 doAction 312 防御）
  const settled = !pending || !pending.ack;

  if (state === 'running') {
    startedAtMs = result.startedAt || Date.now();
    if (!settled) return render();
    // 我们发起的启动/重启收敛到 running → 完成确认（toast + autoOpen）
    const wasOurStart = !!pending && (pending.action === 'start' || pending.action === 'restart');
    if (wasOurStart) {
      finishPending(pending.action === 'restart'
        ? '重启完成，dsh web 已就绪'
        : '启动完成，dsh web 已就绪', 'success');
    }
    if (wasOurStart && prev !== 'running' && settings && settings.autoOpen) {
      openWebUI();
    }
  } else if (state === 'stopped' || state === 'error' || state === 'external') {
    startedAtMs = null;
    if (settled && pending) {
      if (state === 'stopped' && pending.action === 'stop') {
        finishPending(stopStoppedText(), 'success');
      } else if (state === 'error') {
        finishPending('操作未完成，请查看下方错误信息', 'error');
      } else if (state === 'stopped' && (pending.action === 'start' || pending.action === 'restart')) {
        // start/restart 的合法中间快照：M5.5 时序下新进程端口就绪前无 run 记录、
        // status 报 stopped（或 stop 间隙）——保留 pending，等待下一轮 starting/running
      } else {
        finishPending(null, null); // 罕见：目标态变化（如 external 漂移），静默结束 pending
      }
    }
  }
  render();
}

// 状态漂移提示（仅无 pending；去重：相同的 prev→state 键不重复弹）
function notifyDrift(prev, next) {
  if (prev === next) return;
  let msg = null;
  if (prev === 'stopped' && next === 'external') {
    msg = '检测到外部 dsh web 实例';
  } else if (prev === 'external' && next === 'stopped') {
    msg = '外部实例已退出';
  } else if (prev === 'running' && next === 'stopped') {
    msg = 'dsh web 已停止（非本扩展操作）';
  } else if (prev === 'error' && next !== 'error') {
    msg = '已恢复';
  }
  if (!msg) return;
  const key = prev + '->' + next;
  if (key === lastDriftKey) return;
  lastDriftKey = key;
  showToast(msg, 'info');
}

// stop 完成 toast 文案：按 stopMethod 区分（graceful/force/缺失）
function stopStoppedText() {
  const m = detail && detail.stopMethod;
  if (m === 'graceful') return '已优雅停止';
  if (m === 'force') return '已强制停止（未检测到插件或优雅停止超时）';
  return '已停止';
}

// 结束 pending 并（可选）弹出完成 toast
function finishPending(msg, kind) {
  pending = null;
  if (msg) showToast(msg, kind);
}

function invalidateSessions() {
  sessionsRevision += 1;
  sessionsData = null;
  sessionsUpdatedAt = 0;
  sessionsFromMirror = false;
  if (sessionsMirrorTimer) { clearTimeout(sessionsMirrorTimer); sessionsMirrorTimer = null; }
}

// 失败静默：会话区隐藏而非报错（§8.10：不阻断其余功能，除降级提示外不打扰）
async function refreshSessions() {
  const revision = sessionsRevision;
  const sequence = ++sessionsRequestSeq;
  const port = detail && detail.port;
  let resp;
  try { resp = await nativeRequest('sessions', {}); } catch (_) { /* 不可用 */ }
  if (revision !== sessionsRevision || sequence !== sessionsRequestSeq || port !== (detail && detail.port)) return;
  if (sessionsMirrorTimer) { clearTimeout(sessionsMirrorTimer); sessionsMirrorTimer = null; }
  sessionsFromMirror = false;
  sessionsUpdatedAt = Date.now();
  sessionsData = resp && resp.ok && resp.result && typeof resp.result === 'object' ? {
    available: resp.result.available === true,
    items: Array.isArray(resp.result.items) ? resp.result.items : [],
  } : null;
  applySessions();
}

// 镜像只作新鲜摘要；无连接状态字段，不能让已缓存 completed 永久冒充当前数据。
// native 2s 保底仍执行，任何早于新镜像的在途 native 响应均丢弃。
function applyMirrorSessions(cache) {
  const port = detail && detail.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  if (state !== 'running' && state !== 'external') return;
  const entry = cache && typeof cache === 'object' ? cache[String(port)] : null;
  if (!entry || !Array.isArray(entry.items) || !Number.isFinite(entry.at)) return;
  const age = Date.now() - entry.at;
  if (age < 0 || age >= SESSIONS_MIRROR_MAX_AGE_MS || entry.at < sessionsUpdatedAt) return;
  sessionsRevision += 1;
  sessionsUpdatedAt = entry.at;
  sessionsFromMirror = true;
  sessionsData = { available: true, items: entry.items };
  if (sessionsMirrorTimer) clearTimeout(sessionsMirrorTimer);
  sessionsMirrorTimer = setTimeout(() => {
    sessionsMirrorTimer = null;
    if (!sessionsFromMirror) return;
    sessionsFromMirror = false;
    sessionsRevision += 1;
    sessionsData = null;
    applySessions();
  }, SESSIONS_MIRROR_MAX_AGE_MS - age);
  applySessions();
}

// 会话区渲染：折叠头计数 + 列表 / 空态 / 降级提示（§8.10 与 V6 导轨联动）。
// M11：四态感知 —— waiting > working/已停止(有子代理) > 已完成(新鲜且未已读)；
// idle 不渲染；已完成行 hover 出现「已读」；子代理行作为父行嵌套树行（进行中）。
// M11.1 防抖：数据/显示输入未变化时短路，避免 2s 轮询全量重建（hover 丢失→闪烁）。
function applySessions() {
  const sig = sessionRenderSig();
  if (sig === lastSessionSig) return;
  lastSessionSig = sig;
  const section = $('sessions-section');
  if (!section) return;
  const list = $('sessions-list');
  const empty = $('sessions-empty');
  const hint = $('sessions-hint');
  const count = $('sessions-count');
  const railBadge = $('v6-sess-badge');

  // 未加载 / 失败 / dsh 未运行 -> 整个会话区隐藏（不报错）
  if (!sessionsData) {
    section.classList.add('hidden');
    if (count) count.textContent = '';
    if (railBadge) railBadge.classList.add('hidden');
    return;
  }
  const dshOff = state === 'stopped' || state === 'error' || state === 'unknown';
  if (!sessionsData.available) {
    if (dshOff) {
      section.classList.add('hidden');
      if (railBadge) railBadge.classList.add('hidden');
    } else {
      section.classList.remove('hidden');
      list.classList.add('hidden');
      empty.classList.add('hidden');
      hint.classList.remove('hidden');
      hint.textContent = '安装/升级 dsh 配套插件后可查看会话';
      count.textContent = '';
      if (railBadge) railBadge.classList.add('hidden');
    }
    return;
  }

  const items = sessionsData.items;
  section.classList.remove('hidden');
  hint.classList.add('hidden');

  const now = Date.now();
  // 过滤：idle 不渲染；waiting/working 恒显；completed ---
  //   有子代理在跑 → 恒显（感知优先，不受时长/已读约束）；
  //   无子代理 → 新鲜（≤retentionMins）且 未已读（updatedAt > readAt）才显。
  const shown = items.filter((it) => {
    if (it.state === 'idle') return false;
    if (it.state === 'waiting' || it.state === 'working') return true;
    if (it.state === 'completed') {
      if (it.hasActiveChildren) return true;
      if (it.updatedAt && it.updatedAt <= readAtOf(it.sessionId)) return false;
      return isFreshCompleted(it, now);
    }
    return false;
  });

  // 排序：待确认 > 进行中/已停止(有子代理) > 已完成；组内 updatedAt 降序
  const prio = (it) => {
    if (it.state === 'waiting') return 1;
    if (it.state === 'working' || (it.state === 'completed' && it.hasActiveChildren)) return 2;
    if (it.state === 'completed') return 3;
    return 4;
  };
  shown.sort((a, b) => {
    const pA = prio(a);
    const pB = prio(b);
    if (pA !== pB) return pA - pB;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  count.textContent = shown.length > 0 ? shown.length + ' 活跃' : '';

  // 导轨会话红点感知：有待确认或进行中（含已停止·子代理）会话时在导轨亮小黄点
  const hasPending = shown.some((it) => it.state === 'waiting' || it.state === 'working'
    || (it.state === 'completed' && it.hasActiveChildren));
  if (railBadge) railBadge.classList.toggle('hidden', !hasPending);

  if (shown.length === 0) {
    list.textContent = ''; // 清残留行（隐藏列表不留陈旧节点：已读移除/过期为空的语义完整）
    list.classList.add('hidden');
    empty.classList.remove('hidden');
    empty.textContent = '暂无活跃会话';
    return;
  }

  empty.classList.add('hidden');
  list.classList.remove('hidden');
  list.textContent = '';
  for (const item of shown) {
    list.appendChild(renderSessionUnit(item));
  }
}

// 状态圆点：M11 已停止沿用 completed 绿（主会话已停，与已完成同族、以文字区分）
function sessionDotCls(state) {
  if (state === 'waiting') return 'session-dot sdot-waiting breathe';
  if (state === 'working') return 'session-dot sdot-working breathe';
  return 'session-dot sdot-completed breathe';
}

// 单行渲染（含子代理树行与已读交互），返回 DOM 节点
function renderSessionUnit(item) {
  const unit = document.createElement('div');
  const isPendingUndo = !!pendingReadMap[item.sessionId];
  unit.className = 'session-unit' + (isPendingUndo ? ' is-pending-undo' : '');
  unit.id = 'unit-' + item.sessionId;

  const isCompletedNoChild = item.state === 'completed' && !item.hasActiveChildren;

  const row = document.createElement('div');
  row.className = 'session-row' + (isCompletedNoChild && !isPendingUndo ? ' can-read' : '');
  row.title = item.title || '';

  const leftWrap = document.createElement('div');
  leftWrap.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0;flex:1';

  let dot;
  if (item.state === 'working' && typeof renderStateMatrix === 'function') {
    dot = document.createElement('span');
    dot.innerHTML = renderStateMatrix(10, null, performance.now()); // 绝对时间相位：重建不跳相
  } else {
    dot = document.createElement('span');
    dot.className = sessionDotCls(item.state);
    dot.setAttribute('aria-hidden', 'true');
    alignBreathe(dot);
  }

  const titleEl = document.createElement('span');
  titleEl.className = 'session-title';
  titleEl.textContent = (typeof item.title === 'string' && item.title)
    ? item.title
    : '会话 #' + String(item.sessionId || '').slice(0, 8);

  leftWrap.appendChild(dot);
  leftWrap.appendChild(titleEl);

  const rightWrap = document.createElement('div');
  rightWrap.style.cssText = 'display:flex;align-items:center;gap:4px';

  if (isPendingUndo) {
    // 原地倒计时等待态
    rightWrap.appendChild(buildInlineUndoPill(item.sessionId, pendingReadMap[item.sessionId].remaining));
  } else {
    const stateEl = document.createElement('span');
    stateEl.className = 'session-state' + (item.state === 'working' ? ' shimmer-text' : '');
    if (item.state === 'waiting') stateEl.style.color = 'var(--dsh-mgr-sem-waiting)';
    if (item.state === 'completed') {
      stateEl.textContent = item.hasActiveChildren ? '已停止' : '已完成';
      stateEl.style.color = 'var(--dsh-mgr-sem-completed)';
    } else if (item.state === 'waiting') {
      stateEl.textContent = '待确认';
    } else {
      stateEl.textContent = '进行中';
    }
    rightWrap.appendChild(stateEl);

    if (isCompletedNoChild) {
      rightWrap.appendChild(buildMarkReadBtn(item.sessionId, item.title));
    }
  }

  // rc.2 无会话 URL 导航契约：摘要行只读，导航交回统一 Web UI 入口。

  row.appendChild(leftWrap);
  row.appendChild(rightWrap);
  unit.appendChild(row);

  // 子代理树行（挂在父行下方：缩进连接线 + 蓝点 + label + 进行中）
  if (item.hasActiveChildren && Array.isArray(item.childRuns) && item.childRuns.length > 0) {
    const branch = document.createElement('div');
    branch.className = 'subagent-branch-wrap';
    for (const child of item.childRuns) {
      const leaf = document.createElement('div');
      leaf.className = 'subagent-leaf-row';
      const content = document.createElement('div');
      content.className = 'subagent-leaf-content';
      let cdot;
      if (typeof renderStateMatrix === 'function') {
        cdot = document.createElement('span');
        cdot.innerHTML = renderStateMatrix(8, null, performance.now()); // 绝对时间相位：重建不跳相
      } else {
        cdot = document.createElement('span');
        cdot.className = 'session-dot sdot-working breathe';
        alignBreathe(cdot);
      }
      const ctitle = document.createElement('span');
      ctitle.className = 'subagent-title';
      ctitle.title = (typeof child.label === 'string' && child.label) ? child.label : '子代理';
      ctitle.textContent = ctitle.title;
      const cstate = document.createElement('span');
      cstate.className = 'subagent-state shimmer-text';
      cstate.textContent = '进行中';
      content.appendChild(cdot);
      content.appendChild(ctitle);
      content.appendChild(cstate);
      leaf.appendChild(content);
      branch.appendChild(leaf);
    }
    unit.appendChild(branch);
  }

  return unit;
}

// 「已读」按钮（中性幽灵微胶囊；hover 行时替换状态词）
function buildMarkReadBtn(sessionId, title) {
  const btn = document.createElement('button');
  btn.className = 'btn-mark-read';
  btn.type = 'button';
  btn.title = '标记已读';
  btn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3.5 8.5 6.5 11.5 12.5 4.5"/></svg><span>已读</span>';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    startInlineCountdown(sessionId, title);
  });
  return btn;
}

// 原地倒计时微药丸（已读 · 撤销 Ns）
function buildInlineUndoPill(sessionId, remaining) {
  const pill = document.createElement('div');
  pill.className = 'inline-undo-pill';
  const label = document.createElement('span');
  label.textContent = '已读';
  const undoBtn = document.createElement('button');
  undoBtn.className = 'inline-undo-btn';
  undoBtn.type = 'button';
  undoBtn.title = '点击恢复会话';
  const undoText = document.createElement('span');
  undoText.textContent = '撤销';
  const badge = document.createElement('span');
  badge.className = 'countdown-badge';
  badge.id = 'countdown-' + sessionId;
  badge.textContent = remaining + 's';
  undoBtn.appendChild(undoText);
  undoBtn.appendChild(badge);
  undoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    cancelInlineUndo(sessionId);
  });
  pill.appendChild(label);
  pill.appendChild(undoBtn);
  return pill;
}

// 点击「已读」→ 原地倒计时；倒计时结束落库并移除行；期间可撤销
function startInlineCountdown(sessionId, title) {
  if (pendingReadMap[sessionId]) return;
  pendingReadMap[sessionId] = { remaining: READ_COUNTDOWN_SECONDS, intervalId: null, title };
  renderSessionsNow();

  const intervalId = setInterval(() => {
    const entry = pendingReadMap[sessionId];
    if (!entry) { clearInterval(intervalId); return; }
    entry.remaining -= 1;
    if (entry.remaining <= 0) {
      clearInterval(intervalId);
      const el = document.getElementById('unit-' + sessionId);
      if (el) el.classList.add('removing');
      setTimeout(() => {
        readSessions[sessionId] = Date.now();
        delete pendingReadMap[sessionId];
        saveReadSessions();
        renderSessionsNow();
      }, 180);
    } else {
      const badge = document.getElementById('countdown-' + sessionId);
      if (badge) badge.textContent = entry.remaining + 's';
      else renderSessionsNow();
    }
  }, 1000);
  pendingReadMap[sessionId].intervalId = intervalId;
  readTimers.push(intervalId);
}

// 撤销：取消倒计时，行恢复原样
function cancelInlineUndo(sessionId) {
  const entry = pendingReadMap[sessionId];
  if (!entry) return;
  if (entry.intervalId) clearInterval(entry.intervalId);
  delete pendingReadMap[sessionId];
  readTimers = readTimers.filter((t) => t !== entry.intervalId);
  renderSessionsNow();
}

function renderSessionsNow() {
  applySessions();
}

// ---------------------------------------------------------------------------
// 操作（启动 / 停止 / 重启 / 接管）
// ---------------------------------------------------------------------------

async function doAction(action) {
  if (pending) return; // 操作进行中（按钮已禁用，双保险）

  // 乐观反馈：立即进入过渡态 —— 按钮禁用+转圈、圆点脉冲、进度条与阶段文案
  pending = {
    action,
    phase: action === 'restart' ? 'restarting' : action === 'stop' ? 'stopping' : 'starting',
    atMs: Date.now(),
    ack: true,
  };
  if (action === 'start') state = 'starting';
  else if (action === 'stop' || action === 'restart') state = 'stopping';
  // adopt：保持 external 状态，仅按钮与进度条反馈
  render();

  // adopt 的 payload 来自最近一次 status 的 external 结果（pid+port，design §6.7）
  const payload = action === 'adopt'
    ? { pid: detail ? detail.pid : null, port: detail ? detail.port : null }
    : {
        profile: settings ? settings.profile : DEFAULT_SETTINGS.profile,
        port: settings ? settings.port : DEFAULT_SETTINGS.port,
        launchMode: settings ? (settings.launchMode || DEFAULT_SETTINGS.launchMode) : DEFAULT_SETTINGS.launchMode,
        customPath: settings ? (settings.customPath || '') : '',
      };

  let resp;
  try {
    resp = await nativeRequest(action, payload);
  } catch (_) {
    pending = null;
    setError({ code: 'NATIVE_ERROR', message: '无法连接扩展后台，请重新打开面板' });
    showToast('操作失败：无法连接扩展后台', 'error');
    render();
    return;
  }

  if (!resp.ok) {
    const err = resp.error || {};
    if (err.code === 'ALREADY_RUNNING') {
      // 幂等成功：刷新状态；若配置自动打开则打开 UI
      pending = null;
      showToast('dsh web 已在运行（无需操作）', 'success');
      await refreshStatus();
      if (settings && settings.autoOpen && state === 'running') openWebUI();
      return;
    }
    if (err.code === 'ALREADY_STOPPED') {
      pending = null;
      showToast('dsh web 已停止（无需操作）', 'success');
      await refreshStatus();
      return;
    }
    pending = null;
    setError(err);
    showToast('操作失败：' + (ERROR_TEXTS[err.code] || err.message || err.code), 'error');
    return;
  }

  // 应答成功：立即应用返回状态，后续由 2s 轮询继续收敛到终态
  if (action === 'adopt') {
    pending = null; // adopt 应答即终态
    showToast('接管成功，实例已由扩展管理', 'success');
    applyStatus(resp.result || {});
    refreshStatus();
    return;
  }

  // 防御：在途 status 快照的竞态可导致 pending 已被提前收敛（applyStatus 已加守卫，
  // refreshStatus/manualRefresh 已丢弃旧快照，此为兜底）——null 时整体跳过尾处理，
  // 状态由 2s 轮询自愈；绝不在 null 上写字段（Cannot set properties of null）
  if (!pending) return;
  const result = resp.result || {};
  pending.ack = false;
  applyStatus(result); // 若已 running → finishPending 弹完成 toast
  refreshStatus(); // 立即收敛一次（SW 队列此时空闲）
}

// ---------------------------------------------------------------------------
// 打开 Web UI：只聚焦已确认认证的同端口标签，绝不重载/覆盖原标签的草稿。
// rc.2 没有 URL 会话定位契约，不接收/生成会话 hash。
// ---------------------------------------------------------------------------

function loopbackHttpUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
      || url.username || url.password) return null;
    return url;
  } catch (_) { return null; }
}

function validLaunchUrl(value, port) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  const url = loopbackHttpUrl(value);
  if (!url || Number(url.port || 80) !== port || url.pathname !== '/' || url.hash) return null;
  const params = [...url.searchParams.entries()];
  if (params.length !== 1 || params[0][0] !== 'token' || !/^[A-Za-z0-9._~-]{1,4096}$/.test(params[0][1])) return null;
  return url.href;
}

async function tabAuthenticated(tab, port) {
  if (tab.discarded || tab.status === 'unloaded') return false;
  let timer;
  try {
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1500); });
    const status = await Promise.race([
      chrome.tabs.sendMessage(tab.id, { type: 'dsh-auth-status' }, { frameId: 0 }),
      timeout,
    ]);
    return !!status && status.authenticated === true && status.port === port;
  } catch (_) { return false; }
  finally { clearTimeout(timer); }
}

async function openWebUI() {
  // 有 status 时以实际端口为准，0/无效值不可回落到旧设置端口。
  const port = detail ? detail.port : (settings ? settings.port : DEFAULT_SETTINGS.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  const bareUrl = 'http://127.0.0.1:' + port;
  const launchUrl = validLaunchUrl(detail && detail.launchUrl, port);
  try {
    const tabs = await chrome.tabs.query({});
    const candidates = tabs.filter((tab) => {
      const url = loopbackHttpUrl(tab.url);
      return url && Number(url.port || 80) === port;
    });
    const current = await chrome.windows.getCurrent().catch(() => null);
    candidates.sort((a, b) => {
      const aHere = !!current && a.windowId === current.id;
      const bHere = !!current && b.windowId === current.id;
      if (aHere !== bHere) return aHere ? -1 : 1;
      return (b.lastAccessed || 0) - (a.lastAccessed || 0);
    });
    const authenticated = await Promise.all(candidates.map((tab) => tabAuthenticated(tab, port)));
    const best = candidates.find((_, index) => authenticated[index]);
    if (best) {
      await chrome.tabs.update(best.id, { active: true });
      if (Number.isInteger(best.windowId)) await chrome.windows.update(best.windowId, { focused: true }).catch(() => {});
      return;
    }
  } catch (_) { /* 查询/聚焦失败时仅新建，不把 URL（可能含 token）写入日志 */ }

  // 401/休眠/无 listener 不能确认认证：另开，不修改原标签。
  // 外部/接管实例无启动令牌只能裸 URL 降级，提示从原启动入口认证。
  if (!launchUrl) showToast('无法确认认证入口；如需登录，请使用该实例的原启动 URL', 'info');
  try { await chrome.tabs.create({ url: launchUrl || bareUrl }); }
  catch (_) { showToast('无法打开 Web UI，请使用该实例的原启动 URL', 'error'); }
}

// 打开日志查看页（智能复用已有日志 Tab，避免重复多开）
async function openLogs() {
  const logUrl = chrome.runtime.getURL('logs.html');
  try {
    const tabs = await chrome.tabs.query({ url: logUrl }).catch(() => []);
    if (tabs && tabs.length > 0) {
      const best = tabs[0];
      await chrome.tabs.update(best.id, { active: true });
      if (best.windowId) {
        await chrome.windows.update(best.windowId, { focused: true }).catch(() => {});
      }
      return;
    }
  } catch (_) {}
  chrome.tabs.create({ url: logUrl });
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function render() {
  const running = state === 'running';
  const external = state === 'external';
  const stopped = state === 'stopped';
  const isError = state === 'error';
  const locked = !!pending; // 操作在途：所有生命周期按钮锁定，防止并发

  // 状态圆点（dotStateClass 集中映射语义 class：running/external/error/stopped + busy 走 Matrix）
  const dotEl = $('dot');
  const railDotEl = $('rail-dot');
  const dotCls = 'dot ' + dotStateClass();
  if (dotEl && dotEl.className !== dotCls) {
    dotEl.className = dotCls;
    if (/dot-(running|external)/.test(dotCls)) alignBreathe(dotEl); // 呼吸全 popup 同步
  }
  if (railDotEl && railDotEl.className !== dotCls + ' breathe') {
    railDotEl.className = dotCls + ' breathe';
    if (/dot-(running|external)/.test(dotCls)) alignBreathe(railDotEl);
  }

  // 按钮随状态启用/禁用：external 可接管 + 打开 Web UI（design §6.6/§6.7）
  // error 态保留「启动」重试入口（修复端口/安装 dsh 后可直接重试，design §8.2.12）
  $('btn-start').disabled = locked || !(stopped || isError);
  $('btn-stop').disabled = locked || !running;
  $('btn-restart').disabled = locked || !running;
  $('btn-adopt').disabled = locked || !external;
  $('btn-open').disabled = !running && !external;

  // 接管按钮仅 external 状态显示（独占一行；打开 Web UI 恒为全宽 ghost）
  $('btn-adopt').classList.toggle('hidden', !external);

  // 进行中文案 + 转圈：pending 命中的按钮显示 spinner（点击即时反馈）
  setBtnLabel('btn-start', 'start');
  setBtnLabel('btn-stop', 'stop');
  setBtnLabel('btn-restart', 'restart');
  setBtnLabel('btn-adopt', 'adopt');

  // 操作进度行
  renderProgress();

  // 状态卡（新三区布局）：状态词 / 端口 / 次级信息行
  renderStatusCard();
  renderLegacyStatus(); // 兼容：继续写入隐藏的 url-text/uptime-text/detail-line（保留 id 契约）

  // M9 会话区：状态变化时按现有 sessionsData 收敛显示（隐藏/提示切换）
  applySessions();

  // 待重启提示微横幅（配置变更对比）
  renderRestartBanner();

  // 底部提示：M2 契约 —— lifecycle:true 显示优雅停机已启用
  renderHint();
}

// 待重启提示微横幅：对比当前运行中的 detail 与 settings，检测是否需要重启生效
function renderRestartBanner() {
  const banner = $('restart-pending-banner');
  if (!banner) return;
  if (state !== 'running' || !detail || pending) {
    banner.classList.add('hidden');
    return;
  }
  const curMode = detail.launchMode || 'global';
  const cfgMode = (settings && settings.launchMode) || DEFAULT_SETTINGS.launchMode;
  const curPath = detail.customPath || '';
  const cfgPath = (settings && settings.customPath) || '';
  const curPort = detail.port;
  const curRequestedPort = detail.requestedPort === 0 ? 0 : curPort;
  const cfgPort = settings && settings.port;

  const modeDiff = curMode !== cfgMode;
  const pathDiff = cfgMode === 'source' && curPath !== cfgPath;
  const portDiff = Number.isInteger(cfgPort) && curRequestedPort !== cfgPort;

  if (modeDiff || pathDiff || portDiff) {
    const modeNames = { global: '全局', npx: 'NPX', source: '本地源码' };
    const rpbText = $('rpb-text');
    if (rpbText) {
      if (modeDiff) {
        rpbText.textContent = `启动方式已修改（当前:${modeNames[curMode] || curMode} → 新选:${modeNames[cfgMode] || cfgMode}），重启生效`;
      } else if (pathDiff) {
        rpbText.textContent = '源码路径已修改，需重启生效';
      } else if (portDiff) {
        const oldPort = curRequestedPort === 0 ? '自动分配' : curRequestedPort;
        const newPort = cfgPort === 0 ? '自动分配' : cfgPort;
        rpbText.textContent = `端口已修改（当前:${oldPort} → 新选:${newPort}），需重启生效`;
      }
    }
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

// 状态词（#state-word）文本映射（M7 状态卡）
function stateWordText() {
  if (pending) {
    if (pending.action === 'restart') return '正在重启…';
    if (pending.action === 'start') return '正在启动…';
    if (pending.action === 'stop') return '正在停止…';
    if (pending.action === 'adopt') return '正在接管…';
  }
  switch (state) {
    case 'running': return '运行中';
    case 'external': return '外部实例';
    case 'starting': return '正在启动…';
    case 'stopping': return '正在停止…';
    case 'error': return '状态获取失败';
    case 'stopped': return '已停止';
    default: return '—';
  }
}

// dot className 语义映射（M7 从 render() 三元链抽取）：
//   running→dot-running / external→dot-external / busy(starting|stopping)→dot-busy
//   error→dot-error / 其余→dot-stopped
function dotStateClass() {
  if (state === 'running') return 'dot-running';
  if (state === 'external') return 'dot-external';
  if (state === 'starting' || state === 'stopping') return 'dot-busy';
  if (state === 'error') return 'dot-error';
  return 'dot-stopped';
}

// 解析当前端口（外部/运行用 detail.port，否则 settings.port；dynam port 未回填时回落 settings）
function resolvePort() {
  return (detail && detail.port) || (settings ? settings.port : DEFAULT_SETTINGS.port);
}

// uptimeMs → 紧凑「{m}m{s}s」（<60s 只显示「{s}s」；非法值兜底 0s）
function formatCompactUptime(ms) {
  const sec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return s + 's';
  return m + 'm' + s + 's';
}

// 状态卡次级信息（#row2-text）文案（M7）
function row2Text() {
  if (pending) {
    let text = ACTION_LABELS[pending.action].progress[pending.phase] || ACTION_LABELS[pending.action].busy;
    if (pending.action === 'adopt' && detail && detail.pid) {
      text += '（PID ' + detail.pid + '）';
    }
    const sec = Math.floor((Date.now() - pending.atMs) / 1000);
    return text + ' · 已耗时 ' + sec + 's';
  }
  if (state === 'running') {
    const health = detail && detail.health;
    const parts = [];
    if (detail && detail.launchMode) {
      const modeNames = { global: '全局', npx: 'NPX', source: '本地源码' };
      parts.push(modeNames[detail.launchMode] || detail.launchMode);
    }
    if (health) {
      if (health.uptimeMs) parts.push('已运行 ' + formatCompactUptime(health.uptimeMs));
    }
    if (detail && detail.pid) parts.push('PID ' + detail.pid);
    if (health && health.nodeVersion) parts.push('node ' + health.nodeVersion);
    return parts.join(' · ') || '已就绪';
  }
  if (state === 'external') {
    let t = '外部启动，接管后由扩展管理' + (detail && detail.pid ? ' · PID ' + detail.pid : '');
    if (detail && detail.externalCount > 1) t += ' · 共 ' + detail.externalCount + ' 个外部实例';
    return t;
  }
  if (state === 'starting') {
    let t = '正在启动：等待端口就绪';
    if (detail && detail.requestedPort === 0) t += '，端口自动分配中';
    return t;
  }
  if (state === 'stopping') return '正在停止：等待端口关闭';
  if (state === 'error') {
    const code = lastError && lastError.code;
    const msg = (ERROR_TEXTS[code] || (lastError && lastError.message) || code || '').split('\n')[0];
    return msg || '状态获取失败';
  }
  if (state === 'stopped') return 'dsh web 未在运行';
  return '正在获取状态…';
}

// 状态卡渲染（V6）：卡片 class + 状态词 + 端口 + 次级信息行 + 健康度标签
function renderStatusCard() {
  const card = $('statuscard');
  if (!card) return;
  const busy = state === 'starting' || state === 'stopping';
  const isError = state === 'error';
  card.className = 'statuscard' + (isError ? ' error' : busy ? ' warn' : '');

  const sw = $('state-word');
  if (sw) sw.textContent = stateWordText();

  const healthEl = $('health-tag');
  if (healthEl) {
    if (state === 'running') {
      healthEl.textContent = '健康';
      healthEl.style.display = '';
      healthEl.style.color = 'var(--dsw-alias-state-success-primary)';
    } else if (state === 'error') {
      healthEl.textContent = '异常';
      healthEl.style.display = '';
      healthEl.style.color = 'var(--dsw-alias-state-error-primary)';
    } else {
      healthEl.style.display = 'none';
    }
  }

  const portEl = $('port-text');
  if (portEl) {
    const port = resolvePort();
    portEl.textContent = port ? String(port) : '3080';
  }

  const row2 = $('row2-text');
  if (row2) row2.textContent = row2Text();
}

// 兼容：继续写入隐藏容器的 url-text/uptime-text/detail-line（保留 id 契约，展示以新状态卡为准）
function renderLegacyStatus() {
  const urlText = $('url-text');
  if (urlText) {
    urlText.textContent = (state === 'running' || state === 'external')
      ? 'http://127.0.0.1:' + resolvePort()
      : '';
  }
  renderUptime();
  const detailLine = $('detail-line');
  if (detailLine) detailLine.textContent = '状态：' + state;
}

// 底部提示：lifecycle:true → 优雅停机已启用；否则提示安装插件（宿主未升级字段缺失按 false 兜底）。
// 状态未知（首查未返回/失败前 detail 为空）保持中性文案，避免「安装插件」误导（M7 修补）。
function renderHint() {
  const hint = $('hint');
  if (!hint) return;
  if (!detail) {
    hint.textContent = '正在获取 dsh 状态…';
    return;
  }
  const lifecycle = !!detail.lifecycle;
  hint.textContent = lifecycle
    ? '优雅停机已就绪'
    : '安装 dsh-lifecycle 插件可优雅停机';
}

// 单个按钮：忙碌（本窗口 pending 命中，或无 pending 时轮询观察到的 starting/stopping）
// → spinner + 「…中」文案，视觉与状态对齐；否则按状态显示 idle 文案
function setBtnLabel(id, action) {
  const btn = $(id);
  if (!btn) return;
  const label = btn.querySelector('.btn-label');
  const mine = pending && pending.action === action;
  // 无 pending 的忙碌态（他处发起 / 宿主回填前 starting）：按钮也转圈，与圆点脉冲一致
  const stateBusy = !pending && (
    (state === 'starting' && action === 'start') ||
    (state === 'stopping' && (action === 'stop' || action === 'restart'))
  );
  if (mine || stateBusy) {
    if (label) label.textContent = ACTION_LABELS[action].busy;
    btn.classList.add('is-pending');
  } else {
    btn.classList.remove('is-pending');
    if (label) label.textContent = ACTION_LABELS[action].idle;
  }
}

// 操作进度行：阶段说明 + 已耗时（tickTimer 每秒刷新一次）
function renderProgress() {
  const prog = $('progress');
  if (!prog) return;
  if (!pending) {
    prog.classList.add('hidden');
    return;
  }
  prog.classList.remove('hidden');
  let text = ACTION_LABELS[pending.action].progress[pending.phase] || ACTION_LABELS[pending.action].busy;
  if (pending.action === 'adopt' && detail && detail.pid) {
    text += '（PID ' + detail.pid + '）';
  }
  const sec = Math.floor((Date.now() - pending.atMs) / 1000);
  $('progress-text').textContent = text + ' · 已耗时 ' + sec + 's';
}

function renderUptime() {
  const el = $('uptime-text');
  if (!el) return;
  if (state !== 'running' || !startedAtMs) {
    el.textContent = '';
    return;
  }
  const sec = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  el.textContent = '已运行 ' + mm + ':' + ss;
}

// ---------------------------------------------------------------------------
// 操作结果 toast（点击反馈：完成/失败即时确认，自动消退）
// ---------------------------------------------------------------------------

function showToast(msg, kind) {
  const t = $('toast');
  if (!t) return;
  $('toast-text').textContent = msg;
  t.classList.remove('toast-hidden', 'toast-out', 'toast-success', 'toast-error', 'toast-info');
  t.classList.add('toast-' + (kind || 'info'));
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 4000);
}

function hideToast() {
  const t = $('toast');
  if (!t || t.classList.contains('toast-hidden')) return;
  t.classList.add('toast-out');
  toastTimer = setTimeout(() => t.classList.add('toast-hidden'), 200);
}

// ---------------------------------------------------------------------------
// 错误面板
// ---------------------------------------------------------------------------

function setError(err) {
  lastError = err || {};
  invalidateSessions();
  state = 'error'; // 与 Web UI 一致：错误态显示红色圆点，下次 status 轮询自动恢复
  const code = lastError.code || 'NATIVE_ERROR';
  const friendly = ERROR_TEXTS[code] || lastError.message || code;
  let text = friendly;
  if (lastError.message && lastError.message !== friendly) {
    text += '\n' + lastError.message;
  }
  $('error-text').textContent = text;
  $('error-panel').classList.remove('hidden');
  $('btn-copy-log').classList.toggle('hidden', !(lastError.logTail || lastError.message));
  render();
}

function clearError() {
  lastError = null;
  $('error-panel').classList.add('hidden');
  $('btn-copy-log').classList.add('hidden');
}

async function copyLog() {
  if (!lastError) return;
  const text = lastError.logTail || lastError.message || '';
  try {
    await navigator.clipboard.writeText(text);
    showToast('日志已复制', 'success');
  } catch (_) {
    // 兜底：execCommand；两条路径都失败才报错 toast
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    document.body.removeChild(ta);
    if (ok) showToast('日志已复制', 'success');
    else showToast('复制失败，请手动选择复制', 'error');
  }
}

// ---------------------------------------------------------------------------
// 设置面板
// ---------------------------------------------------------------------------

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ settings: DEFAULT_SETTINGS }, (data) => {
      settings = Object.assign({}, DEFAULT_SETTINGS, (data && data.settings) || {});
      // M10：colorMap 规范化（白名单角色 × 白名单色值；旧数据/手工写入的非法值回退默认色板）
      settings.colorMap = DSHColors.normalizeColorMap(settings.colorMap);
      resolve();
    });
  });
}

// M11 已读记录加载（本地存储；损坏/缺失时静默置空——已读是纯展示层，不阻断）
function loadReadSessions() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ [READ_STORE_KEY]: {} }, (data) => {
      const raw = data && data[READ_STORE_KEY];
      readSessions = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
      resolve();
    });
  });
}

const LAUNCH_MODE_DESCS = {
  global: '使用本地全局安装的 dsh 命令行启动',
  npx: '使用 npx @deepseek-ai/dsh 启动（免全局安装）',
  source: '从本地已构建源码启动；此模式暂不加载 SSH MCP',
};

function updateLaunchModeUI() {
  const modeEl = $('set-launch-mode');
  if (!modeEl) return;
  const mode = modeEl.value;
  const descEl = $('set-launch-desc');
  if (descEl) descEl.textContent = LAUNCH_MODE_DESCS[mode] || LAUNCH_MODE_DESCS.global;
  const wrap = $('set-source-wrap');
  if (wrap) wrap.classList.toggle('hidden', mode !== 'source');
}

function renderSettingsForm() {
  $('set-port').value = settings.port;
  $('set-profile').value = settings.profile;
  const mode = (settings.launchMode && ['global', 'npx', 'source'].includes(settings.launchMode))
    ? settings.launchMode : 'global';
  if ($('set-launch-mode')) $('set-launch-mode').value = mode;
  if ($('set-custom-path')) $('set-custom-path').value = settings.customPath || '';
  updateLaunchModeUI();
  $('set-autoopen').checked = !!settings.autoOpen;
  $('set-badge').value = settings.badgeInterval;
  $('set-attention').checked = settings.attention !== false; // 缺省视为开（向后兼容）
  $('set-attention-done').checked = settings.attentionDone !== false; // M8.1：完成提醒独立开关（缺省开）
  $('set-retention').value = settings.retentionMins; // M11：完成会话保留时长
  renderThemeGrid();
  renderColorGrid(settings.colorMap);
}

// 外观行（M6）：点选即生效。白名单校验 → 更新内存 settings → 写 storage（保留其它字段）
// → 调用 DSHTheme.apply() 即时应用（与 webui AppearanceRow 点选即生效一致；不触发
// saveSettings、不弹 toast）。非法值回退默认（normalizeTheme 已处理）。
function onThemeSelect(value) {
  const theme = DSHTheme.normalizeTheme(value);
  if (settings) settings.theme = theme;
  // 写回 storage：settings 是 loadSettings 后的完整对象，直接 set 即保留其余字段
  chrome.storage.local.set({ settings: settings || Object.assign({}, DEFAULT_SETTINGS, { theme }) }, () => {
    renderThemeGrid();
    DSHTheme.apply(); // 立即生效（storage.onChanged 亦会触发，幂等）
  });
}

// 外观行（M6，design §8.7.5）：按 settings.theme 给选中的 theme-cube 加 .selected + aria-checked
// radiogroup 键盘语义：选中项 tabindex=0（roving），其余 -1；keydown 方向键/Home/End 换选
function renderThemeGrid() {
  const theme = DSHTheme.normalizeTheme(settings.theme);
  const cubes = document.querySelectorAll('.theme-cube');
  cubes.forEach((btn) => {
    const sel = btn.getAttribute('data-theme') === theme;
    btn.classList.toggle('selected', sel);
    btn.setAttribute('aria-checked', sel ? 'true' : 'false');
    btn.setAttribute('tabindex', sel ? '0' : '-1'); // roving tabindex
  });
}

const THEME_ORDER = ['follow-webui', 'follow-system', 'light', 'dark'];

// radiogroup 方向键导航：ArrowRight/Down 下一个、ArrowLeft/Up 上一个、Home/End 首/末
function onThemeGridKeydown(e) {
  const idx = THEME_ORDER.indexOf(e.target.getAttribute('data-theme'));
  if (idx < 0) return; // 焦点不在 cube 上
  let next = -1;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % THEME_ORDER.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + THEME_ORDER.length) % THEME_ORDER.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = THEME_ORDER.length - 1;
  else return;
  e.preventDefault();
  const target = document.querySelector('.theme-cube[data-theme="' + THEME_ORDER[next] + '"]');
  if (target) { target.focus(); target.click(); } // 换选并即时生效（click 走 onThemeSelect）
}

// ---------------------------------------------------------------------------
// M10 颜色语义自定义（design §8.12 - 单层柔光色盘升级）
// ---------------------------------------------------------------------------

// 角色展示名（与徽标/会话区状态词一致；字符语义锁定；M10.1 定稿三角色）
const COLOR_ROLE_LABELS = {
  waiting: '待确认',
  working: '进行中',
  completed: '已完成',
};

// 预览徽标字符 = 真实扩展徽标字符（M10.1 定稿，§8.9/§8.12）：
// 等待「?」/ 进行中 n（动态计数示意）/ 完成「!」——设置卡预览与实际徽标所见一致
const COLOR_ROLE_ICONS = {
  waiting: '?',
  working: 'n',
  completed: '!',
};

// 每角色一行：语义微徽标 + 标签 + 6 个单层柔光色盘 swatch（radiogroup）。
function renderColorGrid(map) {
  const grid = $('colors-grid');
  if (!grid) return;
  const cm = DSHColors.normalizeColorMap(map);
  let html = '';
  DSHColors.ROLES.forEach((role) => {
    const cur = cm[role];
    html += '<div class="color-row" role="radiogroup" aria-label="' + COLOR_ROLE_LABELS[role] + '">'
      + '<div class="color-label-wrap">'
      + '<span class="color-badge-preview" id="prev-badge-' + role + '" style="--badge-bg:' + cur + '">' + COLOR_ROLE_ICONS[role] + '</span>'
      + '<span>' + COLOR_ROLE_LABELS[role] + '</span>'
      + '</div>'
      + '<div class="color-swatches" data-role="' + role + '">'
      + DSHColors.PALETTE.map((p) =>
        '<button type="button" class="color-swatch-halo' + (p.color === cur ? ' selected' : '') + '"'
        + ' data-role="' + role + '" data-color="' + p.color + '"'
        + ' role="radio" aria-checked="' + (p.color === cur ? 'true' : 'false') + '"'
        + ' aria-label="' + p.name + '" title="' + p.name + '"'
        + ' style="--sw:' + p.color + ';--swatch-color:' + p.color + '"></button>'
      ).join('')
      + '</div></div>';
  });
  grid.innerHTML = html;
}

// 点选即生效：白名单校验 → 更新内存 settings → 写 storage → DSHColors.applyVars 即时应用
function onColorSelect(role, color) {
  if (DSHColors.ROLES.indexOf(role) === -1) return;
  const cm = DSHColors.normalizeColorMap(settings && settings.colorMap);
  cm[role] = color;
  settings = Object.assign({}, settings, { colorMap: cm });
  chrome.storage.local.set({ settings: settings || Object.assign({}, DEFAULT_SETTINGS, { colorMap: cm }) }, () => {
    renderColorGrid(settings.colorMap);
    DSHColors.applyVars(cm); // 立即生效
    const prev = $('prev-badge-' + role);
    if (prev) prev.style.setProperty('--badge-bg', color);

    // 撞色保护
    if (DSHColors.isReddish(color) && (role === 'waiting' || role === 'completed')) {
      showToast('与错误语义撞色（建议保留互斥色）', 'warn');
    }
  });
}

// 恢复默认色板
function onColorReset() {
  const cm = Object.assign({}, DSHColors.DEFAULT_COLOR_MAP);
  settings = Object.assign({}, settings, { colorMap: cm });
  chrome.storage.local.set({ settings: settings || Object.assign({}, DEFAULT_SETTINGS, { colorMap: cm }) }, () => {
    renderColorGrid(settings.colorMap);
    DSHColors.applyVars(cm);
    showToast('已恢复默认色板', 'success');
  });
}

// swatch radiogroup 键盘导航
function onColorGridKeydown(e) {
  const btn = e.target.closest('.color-swatch-halo, .color-swatch');
  if (!btn) return;
  const row = btn.parentElement && btn.parentElement.parentElement;
  const swatches = row ? Array.prototype.slice.call(row.querySelectorAll('.color-swatch-halo, .color-swatch')) : [];
  const idx = swatches.indexOf(btn);
  if (idx < 0) return;
  let next = -1;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % swatches.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + swatches.length) % swatches.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = swatches.length - 1;
  else return;
  e.preventDefault();
  swatches[next].focus();
  swatches[next].click();
}

function toggleSettings(force) {
  const show = (force !== undefined) ? force : activeTab !== 'sett';
  switchV6(show ? 'sett' : 'dash');
}

function saveSettings() {
  const port = parseInt($('set-port').value, 10);
  const badge = parseInt($('set-badge').value, 10);
  const retention = parseInt($('set-retention').value, 10);
  const profile = $('set-profile').value.trim();
  const launchModeEl = $('set-launch-mode');
  const launchMode = launchModeEl ? launchModeEl.value : 'global';
  const customPathEl = $('set-custom-path');
  const customPath = customPathEl ? sanitizePathInput(customPathEl.value) : '';
  if (customPathEl && customPathEl.value !== customPath) {
    customPathEl.value = customPath;
  }
  const errEl = $('settings-error');

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    errEl.textContent = '端口必须是 0-65535 的整数（0 = 自动分配动态端口）';
    errEl.classList.remove('hidden');
    markFieldInvalid('set-port');
    return;
  }
  if (!Number.isInteger(badge) || badge < 30 || badge > 3600) {
    errEl.textContent = '徽标刷新间隔必须是 30-3600 秒的整数（Chrome 最小周期 30 秒）';
    errEl.classList.remove('hidden');
    markFieldInvalid('set-badge');
    return;
  }
  if (!Number.isInteger(retention) || retention < 0 || retention > 1440) {
    errEl.textContent = '完成会话保留时长必须是 0-1440 分钟的整数（0 = 不显示已完成会话）';
    errEl.classList.remove('hidden');
    markFieldInvalid('set-retention');
    return;
  }
  if (launchMode === 'source' && !customPath) {
    errEl.textContent = '本地源码模式下，必须填写源码根目录或 bin.js 路径';
    errEl.classList.remove('hidden');
    markFieldInvalid('set-custom-path');
    return;
  }

  const next = {
    port,
    profile: profile || 'web',
    launchMode: ['global', 'npx', 'source'].includes(launchMode) ? launchMode : 'global',
    customPath,
    autoOpen: $('set-autoopen').checked,
    badgeInterval: badge,
    theme: settings ? settings.theme : DEFAULT_SETTINGS.theme, // 保留主题选择（M6）
    attention: $('set-attention').checked, // M8 徽标提醒开关（design §8.9）
    attentionDone: $('set-attention-done').checked, // M8.1 完成提醒「绿!」独立开关（M10.1 定稿色）
    retentionMins: retention, // M11 完成会话保留时长
    colorMap: settings ? settings.colorMap : DSHColors.DEFAULT_COLOR_MAP, // M10 保留颜色语义（点选即生效，保存不覆盖）
  };

  chrome.storage.local.set({ settings: next }, () => {
    settings = next; // 立即重读生效
    errEl.classList.add('hidden');
    toggleSettings(false);
    showToast('设置已保存', 'success');
    refreshStatus();
  });
}

// 校验失败：红边框 + 抖动一次（0.3s）+ 聚焦到出错输入框
function markFieldInvalid(id) {
  const input = $(id);
  clearFieldInvalid(id, true);
  input.classList.add('field-invalid');
  input.classList.remove('field-shake');
  // 强制重排以重启动画（连续两次同一错误也会抖动）
  void input.offsetWidth;
  input.classList.add('field-shake');
  input.focus();
}

// 输入时清除无效反馈；skipShake 用于抖动重排前不动 shake 类
function clearFieldInvalid(id, skipShake) {
  const input = $(id);
  input.classList.remove('field-invalid');
  if (!skipShake) input.classList.remove('field-shake');
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
