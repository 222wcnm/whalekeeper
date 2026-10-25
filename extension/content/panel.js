'use strict';
// ============================================================================
// panel.js — Whalekeeper 页面内管理面板（content script，design §8.6）
//
// 在 dsh Web UI 页面（127.0.0.1 / localhost 任意端口）右下角注入一个状态徽章 +
// 可展开的管理面板：停止 / 重启 dsh web，全部动作经 SW 中转 native 宿主
// （复用 background.js 的 {type:'native'} 通道），面板自身不直连 /_lifecycle。
//
// 关键决策（design §8.6）：
//   - 指纹激活：仅 document.title 含 "DeepSeek Harness" 才注入，误注入面为零；
//   - 归属验证：仅当扩展管理的实例运行中且端口与当前页面一致时才开放操作；
//     其余情况（stopped、端口不匹配、外部/WSL 启动的实例）一律只读提示「未托管」；
//   - Shadow DOM：宿主节点 + open shadow root，样式内联在 shadow 内，与页面
//     CSS 双向零干扰；颜色用 --dsw-* 令牌（CSS 自定义属性可穿透 shadow 继承）
//     并带 fallback；
//   - 主题镜像：MutationObserver 观察 body[data-ds-dark-theme] →
//     chrome.storage.local.webuiTheme（design §8.7.3），供 popup/logs 跟随；
//   - 停止两步确认：面板所在页面将随 dsh 关闭，首次点击进入 3s 待确认态；
//   - 只读页面：仅追加自身节点，不读取/修改 dsh 页面 DOM 与数据；
//   - 圆点语义随「展示语义」而非原始状态：绿=本页托管运行中、蓝=外部实例、
//     灰=未托管/已停止、琥珀=启动/停止中、红=连续失败后才报「状态获取失败」；
//   - 扩展重载/更新后旧脚本上下文失效（chrome.runtime.id 为空）→ 停止轮询并
//     提示刷新页面，避免孤儿脚本永久误报红错；
//   - 展开面板绝对定位在胶囊上方：胶囊位置不动，面板向上弹出；
//   - 徽标提醒（§8.9）：仅同源 SSE/HTTP 摘要计数，失联未知不伪造完成；页面
//     后台时 工作完成/等待用户 → 经 SW 上报表栏「!」/「?」提醒；并上报工作中/等待
//     计数（蓝 n 会话状态概览）；可见即清除。
// ============================================================================
(() => {
  // 401 首页没有 DSH title，故只读认证 listener 必须先于指纹早退；普通本地页不注入面板。
  let pageUrl;
  try { pageUrl = new URL(window.location.href); } catch (_) { return; }
  if (pageUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(pageUrl.hostname)
    || pageUrl.username || pageUrl.password) return;
  const pagePort = Number(pageUrl.port || 80);
  if (!Number.isInteger(pagePort) || pagePort < 1 || pagePort > 65535) return;
  if (!window.__dshManagerAuthListenerInstalled) {
    window.__dshManagerAuthListenerInstalled = true;
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || message.type !== 'dsh-auth-status' || !chrome.runtime.id
        || !sender || sender.id !== chrome.runtime.id) return;
      (async () => {
        const ctrl = new AbortController();
        let timer;
        let authenticated = null;
        try {
          const timeout = new Promise((resolve) => {
            timer = setTimeout(() => { ctrl.abort(); resolve(null); }, 1200);
          });
          // 只看状态，不读取正文/cookie，不接收或转发任何 token。
          const resp = await Promise.race([
            fetch(pageUrl.origin + '/', {
              method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: ctrl.signal,
            }),
            timeout,
          ]);
          if (resp && resp.status === 200) authenticated = true;
          else if (resp && resp.status === 401) authenticated = false;
          // 不读正文；取消未消费的流，避免首页响应保留连接。
          if (resp && resp.body) await resp.body.cancel().catch(() => {});
        } catch (_) { /* 断网/超时/重定向：未知，不能把旧页面当作已认证 */ }
        finally { clearTimeout(timer); }
        try { sendResponse({ authenticated, port: pagePort }); } catch (_) { /* 页面/扩展已卸载 */ }
      })();
      return true;
    });
  }

  // ---- 指纹激活：仅 DSH 页面追加自有面板 ----
  if (!/deepseek\s*harness/i.test(document.title)) return;
  if (window.__dshManagerPanelInjected) return; // 防重复注入
  window.__dshManagerPanelInjected = true;

  const POLL_MS = 2000;
  const CONFIRM_WINDOW_MS = 3000;
  const FAIL_STREAK_LIMIT = 3; // 连续失败次数阈值：MV3 SW 唤醒竞态等瞬时失败不立即红

  // ---- 样式（内联于 shadow root；令牌来自页面 :root 的 --dsw-*，fallback 兜底） ----
  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; padding: 0; }
.panel {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483000;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary, rgb(15, 17, 21));
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-1, rgb(255, 255, 255));
  box-shadow: var(--dsw-shadow-lv1, 0 4px 16px rgba(15, 17, 21, 0.12));
  cursor: pointer;
  user-select: none;
  transition: background 0.1s ease-in-out;
}
.chip:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06)); }
.dot {
  position: relative;
  width: 10px;
  height: 10px;
  flex: none;
  color: var(--dsw-static-neutral-bluish-400, rgb(173, 178, 184));
  transition: color 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.dot:before {
  content: "";
  position: absolute; inset: 0;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.1;
}
.dot:after {
  content: "";
  position: absolute;
  top: 20%; right: 20%; bottom: 20%; left: 20%;
  border-radius: 50%;
  background: currentColor;
}
.dot-running { color: var(--dsw-alias-state-success-primary, rgb(34, 197, 94)); }
.dot-external { color: var(--dsw-alias-state-business-primary, rgb(65, 118, 230)); }
.dot-busy { color: var(--dsw-alias-state-warn-primary, rgb(245, 158, 11)); }
.dot-error { color: var(--dsw-alias-state-error-primary, rgb(236, 19, 19)); }
/* 运行态呼吸（design §8.8：实心点 opacity .5↔1 + scale .88↔1，光晕同步 .08↔.16；
   reduced-motion 见下方媒体查询） */
@keyframes dsh-dot-breathe {
  0%, 100% { opacity: 0.5; transform: scale(0.88); }
  50% { opacity: 1; transform: scale(1); }
}
@keyframes dsh-halo-breathe {
  0%, 100% { opacity: 0.08; }
  50% { opacity: 0.16; }
}
.dot-running:after,
.dot-external:after {
  animation: dsh-dot-breathe 2.2s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}
.dot-running:before,
.dot-external:before {
  animation: dsh-halo-breathe 2.2s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}
@keyframes dshm-pulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }
.dot-busy:after { animation: dshm-pulse 1.2s cubic-bezier(0.4, 0, 0.2, 1) infinite; }
.body {
  display: none;
  /* 展开面板绝对定位在胶囊上方：胶囊（chip）位置不动，面板向上弹出 */
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  padding: 10px 12px;
  width: 240px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, rgb(255, 255, 255));
  box-shadow: var(--dsw-shadow-lv2, 0 6px 24px rgba(15, 17, 21, 0.14));
}
.panel.open .body { display: block; }
.status-line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  color: var(--dsw-alias-label-secondary, rgb(97, 102, 107));
}
.status-text { word-break: break-all; }
.btn-row { display: flex; gap: 8px; margin-top: 10px; }
.btn {
  flex: 1;
  height: 28px;
  padding: 4px 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  border-radius: 12px;
  background: var(--dsw-alias-bg-base, rgb(255, 255, 255));
  color: var(--dsw-alias-label-primary, rgb(15, 17, 21));
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  transition: background 0.1s ease-in-out, transform 0.1s ease-in-out;
}
.btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06)); }
.btn:active:not(:disabled) { transform: scale(0.96); }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn.danger {
  color: var(--dsw-alias-state-error-primary, rgb(236, 19, 19));
}
.btn.danger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(236, 19, 19, 0.05));
}
.btn.confirm {
  background: var(--dsw-alias-state-error-primary, rgb(236, 19, 19));
  border-color: var(--dsw-alias-state-error-primary, rgb(236, 19, 19));
  color: rgb(255, 255, 255);
}
.feedback {
  display: none;
  margin-top: 8px;
  color: var(--dsw-alias-label-caption, rgb(173, 178, 184));
  word-break: break-all;
}
.feedback.visible { display: block; }
.feedback.error { color: var(--dsw-alias-state-error-primary, rgb(236, 19, 19)); }
.spinner {
  display: none;
  width: 10px;
  height: 10px;
  margin-right: 6px;
  vertical-align: -1px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: dshm-spin 0.8s linear infinite;
}
.btn.pending .spinner { display: inline-block; }
@keyframes dshm-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .dot-running:after, .dot-running:before, .dot-external:after, .dot-external:before, .dot-busy:after, .spinner { animation-duration: 0.01ms; animation-iteration-count: 1; }
  .chip, .dot, .btn { transition-duration: 0.01ms; }
}
`;

  // ---- DOM 构建（全部 createElement + textContent，无 innerHTML） ----
  const hostEl = document.createElement('div');
  hostEl.id = 'dsh-manager-panel-host';
  const root = hostEl.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  const panel = document.createElement('div');
  panel.className = 'panel';
  const chip = document.createElement('div');
  chip.className = 'chip';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const chipText = document.createElement('span');
  chipText.textContent = 'dsh web';
  chip.appendChild(dot);
  chip.appendChild(chipText);

  const body = document.createElement('div');
  body.className = 'body';
  const statusLine = document.createElement('div');
  statusLine.className = 'status-line';
  const statusText = document.createElement('span');
  statusText.className = 'status-text';
  statusText.textContent = '—';
  statusLine.appendChild(statusText);
  const btnRow = document.createElement('div');
  btnRow.className = 'btn-row';
  const btnStop = document.createElement('button');
  btnStop.className = 'btn danger';
  btnStop.textContent = '停止';
  const btnRestart = document.createElement('button');
  btnRestart.className = 'btn';
  btnRestart.textContent = '重启';
  btnRow.appendChild(btnStop);
  btnRow.appendChild(btnRestart);
  const feedback = document.createElement('div');
  feedback.className = 'feedback';
  body.appendChild(statusLine);
  body.appendChild(btnRow);
  body.appendChild(feedback);
  panel.appendChild(chip);
  panel.appendChild(body);
  root.appendChild(panel);
  document.body.appendChild(hostEl);

  // ---- 状态 ----
  let state = 'unknown'; // stopped | starting | running | stopping | external | error | detached
  let detail = null;
  let busy = false;
  let failStreak = 0; // 连续 status 失败计数（达 FAIL_STREAK_LIMIT 才进 error）
  let confirmTimer = null;
  let pollTimer = null;
  let reqSeq = 0;

  function setBusy(v) {
    busy = v;
    btnStop.disabled = v;
    btnRestart.disabled = v;
    dot.className = 'dot ' + (v ? 'dot-busy' : dotStateClass());
    if (v) {
      btnStop.classList.add('pending');
      btnStop.insertBefore(makeSpinner(), btnStop.firstChild);
    } else {
      btnStop.classList.remove('pending');
      const sp = btnStop.querySelector('.spinner');
      if (sp) sp.remove();
    }
  }

  function makeSpinner() {
    const s = document.createElement('span');
    s.className = 'spinner';
    return s;
  }

  // 归属判定：页面身份 ≠ 进程归属（页面标题只说明「有 dsh 的 UI」，不说明
  // 「这个 dsh 归扩展管」——WSL/终端启动的实例同样满足注入指纹）。仅当扩展
  // 管理的实例正在运行且其端口与当前页面端口一致时，本面板才有控制权。
  function ownership() {
    const repPort = detail && Number(detail.port);
    return {
      repPort,
      isManagedHere: state === 'running' && repPort === pagePort,
      isExternalHere: state === 'external' && repPort === pagePort,
    };
  }

  // 圆点颜色跟随「展示语义」而非原始状态：绿只表示「本页托管实例运行中」；
  // 未托管（stopped / 端口不匹配 / external 不在本页）一律中性灰，外部实例蓝，
  // 启动/停止中琥珀脉冲，状态获取失败红（连续失败后）
  function dotStateClass() {
    const o = ownership();
    if (state === 'error') return 'dot-error';
    if (state === 'starting' || state === 'stopping') return 'dot-busy';
    if (o.isManagedHere) return 'dot-running';
    if (o.isExternalHere) return 'dot-external';
    return '';
  }

  function renderStatus() {
    if (!busy) dot.className = 'dot ' + dotStateClass();
    const o = ownership();
    let text = '';
    let chip = '';
    if (state === 'detached') {
      // 扩展重载/更新后旧内容脚本上下文失效（孤儿脚本）：页面刷新前无法恢复，
      // 明确提示而非误报「状态获取失败」
      text = '扩展已重载或更新，请刷新页面恢复';
      chip = 'dsh web · 已断开';
      btnStop.disabled = true;
      btnRestart.disabled = true;
    } else if (state === 'unknown') {
      // 状态未就绪：保持中性占位，按钮先禁用（refresh 很快收敛）
      if (!busy) { btnStop.disabled = true; btnRestart.disabled = true; }
      return;
    } else if (o.isManagedHere) {
      text = '运行中';
      if (Number.isInteger(o.repPort)) text += ' · 端口 ' + o.repPort;
      if (detail && detail.health && detail.health.ok) text += ' · 健康';
      chip = 'dsh web · ' + (Number.isInteger(o.repPort) ? o.repPort : '运行中');
    } else if (o.isExternalHere) {
      text = '外部实例（非本扩展启动）';
      if (Number.isInteger(o.repPort)) text += ' · 端口 ' + o.repPort;
      chip = 'dsh web · 外部';
    } else if (state === 'starting') {
      text = '正在启动…';
      chip = 'dsh web · 启动中';
    } else if (state === 'stopping') {
      text = '正在停止…';
      chip = 'dsh web · 停止中';
    } else if (state === 'error') {
      text = '状态获取失败';
      chip = 'dsh web · 错误';
    } else {
      // stopped，或 running/external 但端口与当前页面不一致：
      // 当前页面的 dsh 不由本扩展管理（如终端/WSL 启动的另一实例）
      text = '此实例不由本扩展管理（请在扩展 popup 中操作）';
      chip = 'dsh web · 未托管';
    }
    statusText.textContent = text;
    chipText.textContent = chip;
    // 仅「扩展管理的实例（运行中且端口匹配）」可停止/重启；其余一律只读
    if (!busy) {
      btnStop.disabled = !o.isManagedHere;
      btnRestart.disabled = !o.isManagedHere;
    }
  }

  // ---- 与 SW 通信（复用既有 {type:'native'} 通道） ----
  async function nativeRequest(action, payload) {
    const id = 'cs' + (++reqSeq) + '-' + Date.now().toString(36);
    const resp = await chrome.runtime.sendMessage({
      type: 'native',
      id,
      action,
      payload: payload || {},
    });
    return resp || { ok: false, error: { code: 'NATIVE_ERROR', message: '扩展后台无响应' } };
  }

  // 扩展重载/更新后，旧内容脚本的 chrome.runtime 上下文失效（孤儿脚本）：
  // 消息将永远失败且页面刷新前无法恢复——统一走 detached（停止轮询 + 提示刷新）
  function contextAlive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  async function refresh() {
    if (busy) return;
    if (!contextAlive()) {
      state = 'detached';
      stopPoll();
      renderStatus();
      return;
    }
    let resp;
    try {
      resp = await nativeRequest('status', {});
    } catch (_) {
      failTick();
      return;
    }
    if (resp && resp.ok) {
      failStreak = 0;
      detail = resp.result || {};
      state = detail.state || 'stopped';
    } else {
      failTick();
      return;
    }
    renderStatus();
  }

  // 瞬时失败去抖：MV3 SW 休眠/唤醒竞态会让单次消息失败、下一轮即恢复；
  // 连续 FAIL_STREAK_LIMIT 次失败（约 6s）才显示红色错误态，期间保留上次成功状态
  function failTick() {
    failStreak += 1;
    if (failStreak >= FAIL_STREAK_LIMIT) {
      state = 'error';
      renderStatus();
    }
  }

  // ---- 操作 ----
  async function doStop() {
    if (busy) return;
    setBusy(true);
    feedback.className = 'feedback visible';
    feedback.textContent = '正在停止 dsh web（此页面将随之断开）…';
    try {
      const resp = await nativeRequest('stop', {});
      if (resp && resp.ok) {
        state = 'stopped';
        feedback.textContent = '已停止。如需再次管理，请在扩展 popup 中操作。';
      } else if (resp && resp.error && resp.error.code === 'ALREADY_STOPPED') {
        state = 'stopped';
        feedback.textContent = 'dsh web 已停止（幂等）。';
      } else {
        feedback.className = 'feedback visible error';
        feedback.textContent = '停止失败：' + ((resp && resp.error && (resp.error.message || resp.error.code)) || '未知错误');
      }
    } catch (_) {
      feedback.className = 'feedback visible error';
      feedback.textContent = '停止失败：无法连接扩展后台';
    } finally {
      setBusy(false);
      // 动作在途扩展被重载：立即进 detached，避免短暂恢复旧状态（≤2s 后才被轮询纠正）
      if (!contextAlive()) { state = 'detached'; stopPoll(); }
      renderStatus();
    }
  }

  async function doRestart() {
    if (busy) return;
    setBusy(true);
    feedback.className = 'feedback visible';
    feedback.textContent = '正在重启：停止旧进程 → 新进程启动中…';
    try {
      const resp = await nativeRequest('restart', {});
      if (resp && resp.ok) {
        detail = resp.result || {};
        state = detail.state || 'starting';
        feedback.textContent = '重启完成，dsh web 已就绪。';
      } else {
        feedback.className = 'feedback visible error';
        feedback.textContent = '重启失败：' + ((resp && resp.error && (resp.error.message || resp.error.code)) || '未知错误');
      }
    } catch (_) {
      feedback.className = 'feedback visible error';
      feedback.textContent = '重启失败：无法连接扩展后台';
    } finally {
      setBusy(false);
      // 动作在途扩展被重载：立即进 detached，避免短暂恢复旧状态（≤2s 后才被轮询纠正）
      if (!contextAlive()) { state = 'detached'; stopPoll(); }
      renderStatus();
    }
  }

  // 两步确认：首次点击进入 3s 待确认态（面板所在页面将随 dsh 关闭，防误触）
  function onStopClick() {
    if (busy) return;
    if (btnStop.classList.contains('confirm')) {
      if (confirmTimer) clearTimeout(confirmTimer);
      btnStop.classList.remove('confirm');
      btnStop.textContent = '停止';
      doStop();
      return;
    }
    btnStop.classList.add('confirm');
    btnStop.textContent = '确认停止';
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => {
      btnStop.classList.remove('confirm');
      btnStop.textContent = '停止';
      confirmTimer = null;
    }, CONFIRM_WINDOW_MS);
  }

  function onChipClick() {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) refresh();
  }

  chip.addEventListener('click', onChipClick);
  btnStop.addEventListener('click', onStopClick);
  btnRestart.addEventListener('click', doRestart);

  // ---- 轮询与生命周期 ----
  function startPoll() { if (!pollTimer) pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS); }
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopPoll(); attTick(); }
    else { startPoll(); refresh(); attTick(); }
  });

  // ---- 主题镜像（design §8.7.3）----
  // webui 深色状态以 <body data-ds-dark-theme> 属性标记（浅色无属性）。扩展
  // 无法直接读 dsh 的主题偏好（F9/F10 围栏），故此处只做 DOM 镜像：webui 翻主题
  // 时观察器回调 → 读 body 属性得 dark → 写 chrome.storage.local.webuiTheme，
  // 供 popup/logs 的 theme.js 跟随。幂等：值未变不写，避免无谓 storage 通知。
  function syncThemeMirror() {
    // 扩展重载/更新后旧上下文失效（孤儿脚本）：停止观察并静默，与既有 detached 模式一致
    if (!contextAlive()) {
      themeObserver.disconnect();
      return;
    }
    const dark = document.body.hasAttribute('data-ds-dark-theme');
    const port = pagePort;
    chrome.storage.local.get({ webuiTheme: null }, (items) => {
      if (chrome.runtime.lastError) return; // SW/SW 上下文失效时静默跳过
      const prev = items.webuiTheme;
      if (prev && prev.dark === dark && prev.port === port) return; // 幂等
      chrome.storage.local.set({ webuiTheme: { dark, at: Date.now(), port } });
    });
  }

  const themeObserver = new MutationObserver(syncThemeMirror);
  themeObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['data-ds-dark-theme'],
  });

  // ---- 徽标提醒（§8.9 / rc.2）：SSE 优先、HTTP 摘要回退，不扫描全页 DOM ----
  // waiting → 黄?，working（含活动子代理）→ 蓝 n；已知工作→稳定零计数1.2s→绿!。
  // 页面可见或数据失联即 clear 并复位；未知绝不等同已完成。摘要字段与镜像协议不变。
  const ATTENTION_TICK_MS = 1000; // 隐藏页定时器被 Chrome 节流到 1Hz，取 1s 与节流上限对齐
  const ATTENTION_DEBOUNCE_MS = 1200; // 工作→空闲需稳定空态 1.2s（吸收 React 重渲染瞬时抖动）
  const ATT_SESSIONS_ENDPOINT = '/_manager/sessions';
  const ATT_FETCH_TIMEOUT_MS = 1500; // 端点快取超时（与服务端点探测/宿主动作一致）
  let attPhase = 'idle'; // idle | working | waiting-fired | done-fired
  let attIdleSince = 0;
  let attActive = false; // 已向 SW 上报过（重新可见时需要 clear）
  let attLastSig = '';   // 最近上报过的 waiting:working 计数签名（变化才上报）
  let attTimer = null;
  let attBusy = false;   // 端点快取在途：跳过重叠 tick（fetch 超时可 > 1s 周期）

  let pageStopped = false;

  function validSummary(item) {
    return item && typeof item === 'object' && typeof item.sessionId === 'string' && item.sessionId.length > 0
      && ['working', 'waiting', 'completed', 'idle'].includes(item.state);
  }

  function validSnapshot(data) {
    return data && data.ok === true && Array.isArray(data.items) && data.items.every(validSummary);
  }

  // 失败保持未知，不回退全页 DOM 扫描；超时覆盖请求与 JSON 解析。
  async function attSnapshot() {
    const ctrl = new AbortController();
    let timer;
    try {
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => { ctrl.abort(); resolve(null); }, ATT_FETCH_TIMEOUT_MS);
      });
      const request = async () => {
        const resp = await fetch(ATT_SESSIONS_ENDPOINT, {
          method: 'GET', credentials: 'same-origin', signal: ctrl.signal, cache: 'no-store',
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        return validSnapshot(data) ? data : null;
      };
      return await Promise.race([request(), timeout]);
    } catch (_) { return null; }
    finally { clearTimeout(timer); }
  }

  function attReset() {
    if (attActive) { attActive = false; attSend('clear'); }
    attPhase = 'idle';
    attIdleSince = 0;
    attLastSig = '';
  }

  function attSend(op, kind, s) {
    if (!contextAlive()) { attStop(); return; }
    const counts = { working: s ? s.working : 0, waiting: s ? s.waiting : 0 };
    chrome.runtime.sendMessage({ type: 'attention', op, kind, counts }).catch(() => { /* SW 休眠/唤醒竞态：静默，storage 引理自愈 */ });
  }

  // 计数快照 → 状态机（与 attTick 共用；SSE 事件驱动时同样走这里）。
  // 行为与 2026-08-24 定稿完全一致：idle → working →(稳定 1.2s 空态)→ done-fired；
  // 任意 → waiting-fired（立即，优先级覆盖 done）；计数签名变化即上报。
  function attApply(s) {
    const now = Date.now();
    const sig = s.waiting + ':' + s.working;
    if (s.waiting > 0) {
      // 等待用户：立即上报（等待 > 进行中 > 完成）；计数变化（其他会话工作变化）也更新
      attIdleSince = 0;
      if (attPhase !== 'waiting-fired') attPhase = 'waiting-fired';
      if (sig !== attLastSig) {
        attLastSig = sig;
        attActive = true;
        attSend('set', 'waiting', s);
      }
    } else if (s.working > 0) {
      // 工作中：计数变化即上报（蓝 n 常驻概览）
      attIdleSince = 0;
      attPhase = 'working';
      if (sig !== attLastSig) {
        attLastSig = sig;
        attActive = true;
        attSend('set', 'working', s);
      }
    } else if (attPhase === 'working') {
      // 工作 → 空闲：稳定 ATTENTION_DEBOUNCE_MS 后上报「回来看看」
      if (attIdleSince === 0) attIdleSince = now;
      else if (now - attIdleSince >= ATTENTION_DEBOUNCE_MS) {
        attPhase = 'done-fired';
        attLastSig = sig;
        attActive = true;
        attSend('set', 'done', s);
      }
    } else if (attPhase !== 'done-fired') {
      // 一直空闲（无事件）：首次/计数变化时上报 idle（清空该 tab 的会话信号）
      attIdleSince = 0;
      if (sig !== attLastSig) {
        attLastSig = sig;
        attActive = true;
        attSend('set', 'idle', s);
      }
    }
  }

  // ---- M12 SSE 会话推送（design §8.10.1）：同源主动推送优先，1Hz 空轮询消除 ----
  // 仅依赖浏览器内建 EventSource；插件未装/旧版/断流时自动回退下述端点轮询路径。
  const SSE_ENDPOINT = '/_manager/events';
  const SSE_SNAPSHOT_TIMEOUT_MS = 5000;
  const SSE_RETRY_GAP_MS = 15000;
  let sse = null;
  let sseAlive = false; // 仅有效 snapshot 后 live，open 不是摘要有效性证据
  let sseGeneration = 0;
  let sseRetryAt = 0;
  let sseSnapshotTimer = null;
  let dataRevision = 0; // 新帧/失联前发出的旧 HTTP 响应不得覆盖当前数据
  let sessionsKnown = false;
  const sseMap = new Map(); // 最近有效摘要（SSE / HTTP 同构），未知时不参与完成判定

  function sseCounts() {
    let working = 0;
    let waiting = 0;
    for (const it of sseMap.values()) {
      if (!it || typeof it !== 'object') continue;
      if (it.state === 'waiting') waiting += 1;
      // M13.1 口径（design §8.10 M11 定稿）：有子代理运行的会话归入「进行中」（蓝 n）
      else if (it.state === 'working' || it.hasActiveChildren === true) working += 1;
    }
    return { working, waiting };
  }

  // M12 摘要数据 → SW storage 镜像（popup 镜像桥，§8.10.1）：只传摘要 items，
  // 防御性节流（多帧爆发合并为一次写入）。
  let syncTimer = null;
  function syncSessionsToSW() {
    if (syncTimer) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      if (pageStopped || !contextAlive() || !sessionsKnown) return;
      const items = [...sseMap.values()];
      chrome.runtime.sendMessage({ type: 'sessions-sync', items }).catch(() => { /* SW 休眠竞态：静默 */ });
    }, 100);
  }

  function publishSessions() {
    sessionsKnown = true;
    dataRevision += 1;
    syncSessionsToSW(); // HTTP 回退亦刷新现有 sessions-sync mirror，字段不变
    document.documentElement.setAttribute('data-dshm-sse-count', String(sseMap.size));
    if (document.hidden) attApply(sseCounts());
    else attReset();
  }

  function applySseFrame(frame) {
    if (pageStopped || !contextAlive() || !frame || typeof frame !== 'object') return false;
    if (frame.event === 'snapshot') {
      if (!validSnapshot(frame.data)) return false;
      sseMap.clear();
      for (const item of frame.data.items) sseMap.set(item.sessionId, item);
      sseAlive = true;
      if (sseSnapshotTimer) { clearTimeout(sseSnapshotTimer); sseSnapshotTimer = null; }
      document.documentElement.setAttribute('data-dshm-sse-alive', '1');
    } else if (frame.event === 'upsert') {
      if (!sseAlive || !validSummary(frame.data && frame.data.session)) return false;
      const item = frame.data.session;
      sseMap.set(item.sessionId, item);
    } else if (frame.event === 'removed') {
      const id = frame.data && frame.data.sessionId;
      if (!sseAlive || typeof id !== 'string' || !id) return false;
      sseMap.delete(id);
    } else { return false; }
    publishSessions();
    return true;
  }

  function sessionsUnavailable() {
    dataRevision += 1;
    sessionsKnown = false;
    sseMap.clear();
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
    document.documentElement.setAttribute('data-dshm-sse-count', '0');
    attReset(); // 只 clear 本 tab；不发送空 snapshot，更不能把未知当完成
  }

  function closeSse() {
    sseGeneration += 1;
    const previous = sse;
    sse = null;
    sseAlive = false;
    if (sseSnapshotTimer) { clearTimeout(sseSnapshotTimer); sseSnapshotTimer = null; }
    document.documentElement.setAttribute('data-dshm-sse-alive', '0');
    try { if (previous && typeof previous.close === 'function') previous.close(); } catch (_) { /* 已关闭 */ }
  }

  function failSse() {
    closeSse();
    sseRetryAt = Date.now() + SSE_RETRY_GAP_MS;
    sessionsUnavailable();
  }

  function startSse() {
    if (pageStopped || sse || !contextAlive() || Date.now() < sseRetryAt) return;
    let instance;
    try { instance = new EventSource(SSE_ENDPOINT); }
    catch (_) { failSse(); return; }
    sse = instance;
    const generation = ++sseGeneration;
    const isCurrent = () => !pageStopped && contextAlive() && sse === instance && sseGeneration === generation;
    sseSnapshotTimer = setTimeout(() => { if (isCurrent() && !sseAlive) failSse(); }, SSE_SNAPSHOT_TIMEOUT_MS);
    // open 不赋予 live；只有同代次的有效 snapshot 才可信。
    instance.onopen = () => { if (!isCurrent()) return; };
    // 插件带 event: 头，必须监听命名帧；每一个回调（不只 open/error）均绑定代次。
    const onSseEvent = (name) => (event) => {
      if (!isCurrent()) return;
      let payload;
      try { payload = JSON.parse(event && event.data); } catch (_) { return; }
      applySseFrame({ event: name, data: payload });
    };
    instance.addEventListener('snapshot', onSseEvent('snapshot'));
    instance.addEventListener('upsert', onSseEvent('upsert'));
    instance.addEventListener('removed', onSseEvent('removed'));
    instance.onmessage = onSseEvent('message');
    instance.onerror = () => { if (isCurrent()) failSse(); };
  }

  // verify-cdp 合成帧注入挂钩：事件处理路径与真实 EventSource 完全一致。
  // 派发语义（2026-08-26 自动验收实测）：监听器挂在 document（capture）——主世界或
  // 面板自身世界均可派发，但必须 dispatch 在 **document** 上（window.dispatchEvent 的
  // 传播路径不经过 document）。verify 采用 CDP 隔离世界 evaluate 确定性派发。
  // 语义（仅测试注入，生产中不会触发）：挂钩本身就是「模拟 SSE 流存活」——
  // 声明 sseAlive 并占位 sse 席位（可见分支不再重连、onerror 无从触发），使 attTick
  // 跳过端点快取，verify 据此确定性断言「SSE 活跃期间 0 轮询」；陈旧实例的事件由
  // startSse 的实例守卫隔离。验证期在 documentElement 写探针属性供 CDP 读取。
  document.addEventListener('__whalekeeper_sse_frame', (e) => {
    const detail = e && e.detail;
    if (pageStopped || !contextAlive() || !detail || detail.__whalekeeper !== true) return;
    const frame = detail.frame;
    if (frame && frame.event === 'snapshot' && validSnapshot(frame.data)) {
      closeSse(); // 模拟代次替换真实流，隔离旧 callbacks / HTTP 响应
      sse = { simulated: true };
      applySseFrame(frame);
    } else if (sse && sse.simulated) {
      applySseFrame(frame);
    }
  }, true);

  async function attTick() {
    if (pageStopped) return;
    if (!contextAlive()) { attStop(); return; }
    if (!document.hidden) attReset();
    startSse(); // visible / hidden 都重试，不依赖切回标签
    if (sseAlive) {
      if (document.hidden) attApply(sseCounts()); // 纯内存推进，0 HTTP
      return;
    }
    if (attBusy) return;
    const revision = dataRevision;
    const generation = sseGeneration;
    attBusy = true;
    let snapshot;
    try { snapshot = await attSnapshot(); }
    finally { attBusy = false; }
    // 新 SSE 帧或连接代次已改变，迟到 HTTP 成功/失败都不能改新快照。
    if (pageStopped || !contextAlive() || sseAlive || revision !== dataRevision || generation !== sseGeneration) return;
    if (!snapshot) { sessionsUnavailable(); return; }
    sseMap.clear();
    for (const item of snapshot.items) sseMap.set(item.sessionId, item);
    publishSessions();
  }

  function attStop() {
    if (attTimer) { clearInterval(attTimer); attTimer = null; }
    closeSse();
    sessionsUnavailable();
  }

  refresh();
  startPoll();
  syncThemeMirror(); // 覆盖「面板注入时页面已是深色」场景
  attTimer = setInterval(attTick, ATTENTION_TICK_MS);
  attTick(); // 立即按当前可见性建基线
  startSse(); // M12：同源 SSE 订阅（端点不可用/插件未装时 onerror 自动回退）
  // M2：同标签导航离开 dsh（tab 不关闭）时主动清除提醒；SW 侧 tabs.onUpdated 同规则兜底
  window.addEventListener('pagehide', () => {
    pageStopped = true;
    stopPoll();
    attStop();
    themeObserver.disconnect();
  });
  // BFCache 恢复仍可使用原面板，但不得沿用离页前的流和完成基线。
  window.addEventListener('pageshow', () => {
    if (!pageStopped || !contextAlive()) return;
    pageStopped = false;
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
    syncThemeMirror();
    if (!document.hidden) startPoll();
    attTimer = setInterval(attTick, ATTENTION_TICK_MS);
    attTick();
  });
})();
