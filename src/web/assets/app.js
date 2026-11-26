// PRTS // WebMUX Console Core Application
const STATUS_LABEL = { working: 'RUNNING', background: 'ASYNC', blocked: 'CONFIRM', idle: 'READY', shell: 'SHELL' };
const KIND_LABEL = { agy: 'AGY', dsh: 'DSH', claude: 'CLAUDE', codex: 'CODEX', pi: 'PI', shell: 'SHELL' };
const LS = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const state = {
  sessions: [], status: null, agents: [], user: null, authMode: 'local',
  ops: { heartbeats: [], goals: [] },
  gpu: { hostName: 'local', localGpus: [], leases: [], summary: {} },
  selectedKey: null, mode: 'sessions', tab: 'chat', lastTab: 'chat', gpuClusterFilter: 'all', selectedTaskId: null,
  lastChatSig: '', lastChatKey: '', boostPollUntil: 0, pendingSend: null, stopNotice: null,
  stoppedKeys: new Map(), lastTurnCount: new Map(), sessionCache: new Map(), lastWsFetchAt: 0,
  killingKeys: new Set(), killTargetKey: null, knownUnitKeys: new Set(), rosterSeeded: false,
  bootDone: false, viewEntryAnim: false,
  optimisticQueue: new Map(), queueCollapsed: false,
  modelCatalog: null, switchingModel: false, modelFlash: '', modelFlashAt: 0,
  cornerCollapsed: false, cornerExpandedTaskId: null,
  theme: (() => { try { return localStorage.getItem('fmux_theme') || 'night'; } catch { return 'night'; } })(),
  wp: {
    version: 0,
    opacity: LS.get('fmux_wp_opacity', 45),
    blur: LS.get('fmux_wp_blur', 6),
  },
  hl: { on: LS.get('fmux_hl_on', true), fade: LS.get('fmux_hl_fade', false), tldr: LS.get('fmux_hl_tldr', false), cache: new Map() },
};

const $ = (id) => document.getElementById(id);
const pad2 = (n) => String(n).padStart(2, '0');
const fmtSec = (sec) => {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m < 60 ? `${pad2(m)}:${pad2(s)}` : `${Math.floor(m / 60)}h${pad2(m % 60)}m`;
};
const fmtTime = (ms) => (ms ? new Date(ms).toTimeString().slice(0, 8) : '--:--:--');

function updateClock() { $('clock').textContent = new Date().toTimeString().slice(0, 8); }
updateClock();
setInterval(updateClock, 1000);

// ---- Day / Night Theme ----
function applyTheme(mode) {
  state.theme = mode === 'day' ? 'day' : 'night';
  document.documentElement.dataset.theme = state.theme;
  $('themeBtn').textContent = state.theme === 'day' ? '☾ NIGHT' : '☀ DAY';
  try { localStorage.setItem('fmux_theme', state.theme); } catch {}
}
applyTheme(state.theme);
$('themeBtn').onclick = () => applyTheme(state.theme === 'day' ? 'night' : 'day');

// ---- PRTS Boot Sequence + Tactical Motion Helpers ----
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function finishBoot() {
  if (state.bootDone) return;
  state.bootDone = true;
  const bootEl = $('prtsBoot');
  if (bootEl) bootEl.classList.add('boot-hidden');
  document.body.classList.remove('boot-reveal');
}

function noteBootSseReady() {
  if ($('bootStage')) $('bootStage').textContent = 'NEURAL LINK ESTABLISHED';
  if ($('bootPct')) $('bootPct').textContent = '100%';
}

(function initBootSequence() {
  const bootEl = $('prtsBoot');
  if (!bootEl) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    finishBoot();
    return;
  }
  setTimeout(() => { if ($('bootStage')) $('bootStage').textContent = 'MOUNTING TMUX MATRIX…'; }, 220);
  setTimeout(() => { if ($('bootPct')) $('bootPct').textContent = '100%'; }, 480);
  setTimeout(() => finishBoot(), 1060);
  window.addEventListener('keydown', () => { if (!state.bootDone) finishBoot(); }, { once: true });
})();

// Load KaTeX purely asynchronously post-boot so unreachable/slow CDNs NEVER block UI startup!
setTimeout(() => {
  try {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css';
    css.crossOrigin = 'anonymous';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = 'https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.js';
    js.async = true;
    js.crossOrigin = 'anonymous';
    js.onload = () => { if (window.__onKatexReady) window.__onKatexReady(); };
    document.head.appendChild(js);
  } catch {}
}, 900);

const ANIM_CLASSES = ['anim-view-right', 'anim-view-left', 'anim-tab-right', 'anim-tab-left', 'anim-unit-down', 'anim-unit-up', 'anim-id', 'anim-wm', 'unit-lock-pulse'];
const animTimers = new WeakMap();
function triggerAnim(el, cls, ms = 280) {
  if (!el) return;
  const prev = animTimers.get(el);
  if (prev) clearTimeout(prev);
  el.classList.remove(...ANIM_CLASSES);
  void el.offsetWidth;
  el.classList.add(cls);
  animTimers.set(el, setTimeout(() => { el.classList.remove(cls); }, ms));
}

let scanFlashTimer = null;
function flashPanelScan() {
  const wrap = document.querySelector('.panel-wrap');
  if (!wrap) return;
  if (scanFlashTimer) clearTimeout(scanFlashTimer);
  wrap.classList.remove('scan-flash');
  void wrap.offsetWidth;
  wrap.classList.add('scan-flash');
  scanFlashTimer = setTimeout(() => wrap.classList.remove('scan-flash'), 340);
}

function syncSubtabGlider(container, immediate = false) {
  if (!container) return;
  let glider = container.querySelector(':scope > .subtab-glider');
  if (!glider) {
    glider = document.createElement('span');
    glider.className = 'subtab-glider';
    glider.setAttribute('aria-hidden', 'true');
    container.prepend(glider);
  }
  const active = container.querySelector(':scope > .subtab.active');
  if (!active || !active.offsetWidth || !active.offsetHeight) {
    container.classList.remove('has-glider');
    glider.style.opacity = '0';
    return;
  }
  if (immediate || !container.classList.contains('has-glider')) {
    container.classList.add('glider-instant');
  }
  container.classList.add('has-glider');
  glider.style.width = `${active.offsetWidth}px`;
  glider.style.height = `${active.offsetHeight}px`;
  glider.style.transform = `translate3d(${active.offsetLeft}px, ${active.offsetTop}px, 0)`;
  glider.style.opacity = '1';
  if (container.classList.contains('glider-instant')) {
    requestAnimationFrame(() => container.classList.remove('glider-instant'));
  }
}

function initSubtabGliders() {
  try {
    ['wsSubtabs', 'gpuClusterTabs'].forEach((id) => {
      const el = $(id);
      if (!el) return;
      syncSubtabGlider(el, true);
      if (typeof window.ResizeObserver === 'function') {
        const ro = new window.ResizeObserver(() => syncSubtabGlider(el, true));
        ro.observe(el);
      }
    });
    window.addEventListener('resize', () => {
      syncSubtabGlider($('wsSubtabs'), true);
      syncSubtabGlider($('gpuClusterTabs'), true);
    });
  } catch {}
}
requestAnimationFrame(initSubtabGliders);


// ---- Highlight Controls ----
function syncHlClasses() {
  document.body.classList.toggle('hl-off', !state.hl.on);
  document.body.classList.toggle('hl-fade', state.hl.on && state.hl.fade);
  document.body.classList.toggle('tldr-off', !state.hl.tldr);
  $('chkHl').checked = state.hl.on;
  $('chkFade').checked = state.hl.fade;
  $('chkFade').disabled = !state.hl.on;
  $('chkTldr').checked = state.hl.tldr;
}
syncHlClasses();
$('chkHl').onchange = () => { state.hl.on = $('chkHl').checked; LS.set('fmux_hl_on', state.hl.on); syncHlClasses(); applyAllHighlights(); };
$('chkFade').onchange = () => { state.hl.fade = $('chkFade').checked; LS.set('fmux_hl_fade', state.hl.fade); syncHlClasses(); };
$('chkTldr').onchange = () => { state.hl.tldr = $('chkTldr').checked; LS.set('fmux_hl_tldr', state.hl.tldr); syncHlClasses(); applyAllHighlights(); };


async function loadHighlightFor(wrap, tries = 0) {
  if (!wrap.isConnected || wrap.dataset.hlDone || (!state.hl.on && !state.hl.tldr)) return;
  const raw = wrap.dataset.raw || '';
  if (raw.length < 40) { wrap.dataset.hlDone = '1'; return; }
  const cached = state.hl.cache.get(raw);
  if (cached) { paintHighlightOnto(wrap, cached); return; }
  const badge = wrap.querySelector('.hl-status');
  try {
    const res = await api('/api/highlight', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: raw }),
    });
    if (res.pending) {
      if (badge && badge.textContent !== '· DEEPSEEK HIGHLIGHTING…') badge.textContent = '· DEEPSEEK HIGHLIGHTING…';
      if (tries < 25) setTimeout(() => loadHighlightFor(wrap, tries + 1), 2200);
      else if (badge) badge.textContent = '';
      return;
    }
    state.hl.cache.set(raw, res);
    if (wrap.isConnected) paintHighlightOnto(wrap, res);
  } catch {
    if (badge) badge.textContent = '';
  }
}

function applyAllHighlights() {
  if (!state.hl.on && !state.hl.tldr) return;
  document.querySelectorAll('.msg-bot-wrap[data-raw]:not([data-hl-done])').forEach((w) => loadHighlightFor(w));
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (res.status === 401) { location.reload(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function paneOrder(key) {
  const m = String(key || '').match(/^%(\d+)$/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}
function orderedSessions() {
  return [...state.sessions].sort((a, b) => (a.unitId || 0) - (b.unitId || 0) || paneOrder(a.key) - paneOrder(b.key));
}
function selectedSession() { return state.sessions.find((s) => s.key === state.selectedKey) || null; }

const MODE_ORDER = { sessions: 0, heartbeat: 1, goals: 2, gpu: 3 };
const SUBTAB_ORDER = { chat: 0, tasks: 1, term: 2 };
const CLUSTER_ORDER = { all: 0, local: 1, gongji: 2, volc: 3 };

function setMode(mode) {
  const prev = state.mode;
  const changed = prev !== mode;
  state.mode = mode;
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('viewSessions').style.display = mode === 'sessions' ? 'grid' : 'none';
  $('viewHeartbeat').style.display = mode === 'heartbeat' ? 'flex' : 'none';
  $('viewGoals').style.display = mode === 'goals' ? 'flex' : 'none';
  $('viewGpu').style.display = mode === 'gpu' ? 'flex' : 'none';

  const targetEl = mode === 'sessions' ? $('viewSessions')
    : mode === 'heartbeat' ? $('viewHeartbeat')
    : mode === 'goals' ? $('viewGoals') : $('viewGpu');

  if (changed) state.viewEntryAnim = true;
  if (mode === 'sessions') {
    renderSessions();
    renderWorkspace();
    requestAnimationFrame(() => syncSubtabGlider($('wsSubtabs'), !changed));
  }
  if (mode === 'heartbeat') renderHeartbeats();
  if (mode === 'goals') renderGoals();
  if (mode === 'gpu') {
    renderGpu();
    requestAnimationFrame(() => syncSubtabGlider($('gpuClusterTabs'), true));
  }
  state.viewEntryAnim = false;

  if (changed && targetEl) {
    const dir = (MODE_ORDER[mode] ?? 0) >= (MODE_ORDER[prev] ?? 0) ? 'anim-view-right' : 'anim-view-left';
    triggerAnim(targetEl, dir, 290);
    if (mode === 'sessions') flashPanelScan();
  }
}
document.querySelectorAll('.mode-btn').forEach((b) => { b.onclick = () => { if (state.mode !== b.dataset.mode) setMode(b.dataset.mode); }; });

function getEffectiveQueue(s) {
  if (!s) return [];
  const serverList = Array.isArray(s.pendingQueue) ? s.pendingQueue : [];
  const optList = state.optimisticQueue.get(s.key) || [];
  if (!optList.length) return serverList;
  const now = Date.now();
  const stillPending = optList.filter((o) => now - o.createdAt < 6000 && !serverList.some((sv) => sv.text === o.text && Math.abs(sv.createdAt - o.createdAt) < 5000));
  if (stillPending.length !== optList.length) {
    if (stillPending.length) state.optimisticQueue.set(s.key, stillPending);
    else state.optimisticQueue.delete(s.key);
  }
  return [...serverList, ...stillPending].map((x, i) => ({ ...x, rank: i + 1 }));
}

function selectSessionKey(key, { animDir = '' } = {}) {
  if (!key || state.selectedKey === key || state.killingKeys.has(key)) return;
  const ordered = orderedSessions();
  const prevIdx = ordered.findIndex((x) => x.key === state.selectedKey);
  const nextIdx = ordered.findIndex((x) => x.key === key);
  state.selectedKey = key;
  state.selectedTaskId = null;
  state.cornerExpandedTaskId = null;
  state.lastChatSig = '';
  renderSessions();
  renderWorkspace({ forceScroll: true });

  const card = $('sessionList')?.querySelector(`.unit-card[data-key="${CSS.escape(key)}"]`);
  if (card) {
    triggerAnim(card, 'unit-lock-pulse', 320);
    if (window.innerWidth <= 920) {
      card.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }
  const down = animDir ? animDir === 'down' : (nextIdx >= prevIdx);
  const isMobile = window.innerWidth <= 920;
  const panelCls = isMobile
    ? (down ? 'anim-tab-right' : 'anim-tab-left')
    : (down ? 'anim-unit-down' : 'anim-unit-up');
  triggerAnim($('panel'), panelCls, 250);
  triggerAnim(document.querySelector('.ws-identity'), 'anim-id', 250);
  triggerAnim($('wsWatermark'), 'anim-wm', 340);
  flashPanelScan();
}

function renderHeader() {
  if (state.user) {
    $('opBadge').style.display = '';
    $('opBadge').innerHTML = `${state.user.avatarUrl ? `<img class="op-avatar" src="${esc(state.user.avatarUrl)}" alt="" />` : '<span class="op-dot"></span>'}<span>${esc(state.user.name || 'OPERATOR')}</span>`;
  }
  $('logoutBtn').style.display = state.authMode === 'oidc' ? '' : 'none';
  const hbActive = (state.ops?.heartbeats || []).filter((h) => h.enabled).length;
  const gActive = (state.ops?.goals || []).filter((g) => g.status === 'active').length;
  const gpuActive = (state.gpu?.summary?.localBusy || 0) + (state.gpu?.summary?.activeLeases || 0);
  $('navHbCnt').textContent = String(hbActive); $('navHbCnt').style.display = hbActive ? '' : 'none';
  $('navGoalCnt').textContent = String(gActive); $('navGoalCnt').style.display = gActive ? '' : 'none';
  $('navGpuCnt').textContent = String(gpuActive); $('navGpuCnt').style.display = gpuActive ? '' : 'none';
}

function renderSessions() {
  renderHeader();
  const sessions = orderedSessions().filter((s) => !state.killingKeys.has(s.key));
  const total = sessions.length;
  const activeCount = sessions.filter((s) => s.status === 'working').length;
  const bgCount = sessions.reduce((sum, s) => sum + (s.runningTasks || 0), 0);
  $('statTotal').textContent = pad2(total);
  $('statActive').textContent = pad2(activeCount);
  $('statBg').textContent = pad2(bgCount);

  const list = $('sessionList');
  if (!total && !state.killingKeys.size) {
    list.innerHTML = '<div class="empty"><strong>NO UNITS</strong>START A TMUX SESSION OR CLICK + DEPLOY</div>';
    return;
  }
  if (total && (!state.selectedKey || !sessions.some((s) => s.key === state.selectedKey))) {
    state.selectedKey = sessions[0].key;
  }

  // Patch .unit-card DOM nodes in-place in fixed unitId order so cards never float, jump scroll, or drop clicks.
  const emptyEl = list.querySelector(':scope > .empty');
  if (emptyEl && (total || state.killingKeys.size)) emptyEl.remove();
  const existing = new Map();
  list.querySelectorAll(':scope > .unit-card').forEach((el) => existing.set(el.dataset.key, el));
  const keepKeys = new Set(sessions.map((s) => s.key));
  for (const [k, el] of existing) {
    if (!keepKeys.has(k) && !state.killingKeys.has(k)) el.remove();
  }

  const shouldAnimateDeploy = state.rosterSeeded;
  sessions.forEach((s, idx) => {
    let card = existing.get(s.key);
    const isBrandNew = !state.knownUnitKeys.has(s.key);
    state.knownUnitKeys.add(s.key);
    if (!card) {
      card = document.createElement('div');
      card.dataset.key = s.key;
      card.innerHTML = `<div class="u-top"><div class="u-name-wrap"><span class="u-idx"></span><span class="u-name"></span></div><span class="u-chip u-st"></span></div><div class="u-meta"></div><div class="u-preview"></div>`;
      card.onclick = () => selectSessionKey(s.key);
      if (isBrandNew && shouldAnimateDeploy) {
        card.classList.add('deploy-enter');
        setTimeout(() => card.classList.remove('deploy-enter'), 400);
      }
      list.appendChild(card);
    } else if (!state.killingKeys.size && list.children[idx] !== card) {
      list.insertBefore(card, list.children[idx] || null);
    }
    card.style.setProperty('--u-idx', String(idx));
    const active = s.key === state.selectedKey ? ' active' : '';
    const keepExtra = ['unit-lock-pulse', 'deploy-enter'].filter((c) => card.classList.contains(c)).map((c) => ` ${c}`).join('');
    const nextCls = `unit-card st-${s.status}${active}${keepExtra}`;
    if (card.className !== nextCls) card.className = nextCls;
    const fixedId = pad2(s.unitId || idx + 1);
    const idxEl = card.querySelector('.u-idx');
    if (idxEl.textContent !== fixedId) idxEl.textContent = fixedId;
    const nameEl = card.querySelector('.u-name');
    if (nameEl.textContent !== s.name) nameEl.textContent = s.name;
    const stEl = card.querySelector('.u-st');
    const stText = STATUS_LABEL[s.status] || s.status;
    const stCls = `u-chip u-st st-${s.status}`;
    if (stEl.className !== stCls) stEl.className = stCls;
    if (stEl.textContent !== stText) stEl.textContent = stText;
    const bgTag = s.runningTasks > 0 ? `<span class="u-chip st-background">BG:${s.runningTasks}</span>` : '';
    const qLen = getEffectiveQueue(s).filter((x) => x.state === 'queued').length;
    const qTag = qLen > 0 ? `<span class="u-chip st-blocked">QUEUE:${qLen}</span>` : '';
    const metaHtml = `<span class="u-chip">${esc(KIND_LABEL[s.kind] || s.kind)}</span>${s.model ? `<span class="u-chip chip-model">${esc(s.model)}</span>` : ''}${bgTag}${qTag}`;
    const metaEl = card.querySelector('.u-meta');
    if (metaEl.dataset.sig !== metaHtml) { metaEl.dataset.sig = metaHtml; metaEl.innerHTML = metaHtml; }
    const prevText = s.note || s.lastText || s.title || s.cwd || '';
    const prevEl = card.querySelector('.u-preview');
    if (prevEl.textContent !== prevText) prevEl.textContent = prevText;
  });
  if (total) state.rosterSeeded = true;
}

// ---- Top-Right Async Mini-HUD directly below Highlight bar (running tasks only, patched in-place) ----
async function renderCornerBg(s) {
  const box = $('cornerBg');
  const tasks = (s?.tasks || [])
    .filter((t) => t.status === 'running')
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  if (state.tab !== 'chat' || !tasks.length) { box.style.display = 'none'; return; }
  box.style.display = '';
  box.classList.toggle('collapsed', state.cornerCollapsed);
  const togTxt = state.cornerCollapsed ? '+' : '−';
  if ($('cornerToggle').textContent !== togTxt) $('cornerToggle').textContent = togTxt;
  const titleTxt = `ASYNC // ${tasks.length} RUNNING`;
  if ($('cornerTitle').textContent !== titleTxt) $('cornerTitle').textContent = titleTxt;
  if (state.cornerExpandedTaskId && !tasks.some((t) => t.id === state.cornerExpandedTaskId)) {
    state.cornerExpandedTaskId = null;
  }

  let inlineLog = '';
  if (!state.cornerCollapsed && state.cornerExpandedTaskId) {
    try {
      const res = await api(`/api/session/${encodeURIComponent(s.key)}/tasks?lines=12&taskId=${encodeURIComponent(state.cornerExpandedTaskId)}`);
      inlineLog = res.log || '(no log output yet)';
    } catch { inlineLog = ''; }
  }

  const body = $('cornerBody');
  const visible = tasks.slice(0, 4);
  const existing = new Map();
  body.querySelectorAll(':scope > .corner-task').forEach((el) => existing.set(el.dataset.ctid, el));
  const keepIds = new Set(visible.map((t) => t.id));
  for (const [id, el] of existing) if (!keepIds.has(id)) el.remove();

  visible.forEach((t, idx) => {
    let el = existing.get(t.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'corner-task running';
      el.dataset.ctid = t.id;
      el.innerHTML = '<div class="corner-task-top"><span class="ct-id"></span><span class="ct-dur"></span></div><div class="corner-task-desc"></div>';
      el.onclick = () => {
        state.cornerExpandedTaskId = state.cornerExpandedTaskId === t.id ? null : t.id;
        renderCornerBg(selectedSession());
      };
      body.appendChild(el);
    } else if (body.children[idx] !== el) {
      body.insertBefore(el, body.children[idx] || null);
    }
    const idTxt = `${t.shortId} · ${t.kind.toUpperCase()}`;
    const durTxt = `RUNNING ${fmtSec((Date.now() - t.startedAt) / 1000)}`;
    const descTxt = `${t.description}${t.summary ? ` · ${t.summary}` : ''}`;
    const idEl = el.querySelector('.ct-id');
    const durEl = el.querySelector('.ct-dur');
    const descEl = el.querySelector('.corner-task-desc');
    if (idEl.textContent !== idTxt) idEl.textContent = idTxt;
    if (durEl.textContent !== durTxt) durEl.textContent = durTxt;
    if (descEl.textContent !== descTxt) descEl.textContent = descTxt;
    let pre = el.querySelector('.corner-task-log');
    if (state.cornerExpandedTaskId === t.id) {
      if (!pre) { pre = document.createElement('pre'); pre.className = 'corner-task-log'; el.appendChild(pre); }
      if (pre.textContent !== inlineLog) pre.textContent = inlineLog;
    } else if (pre) {
      pre.remove();
    }
  });
}
$('cornerToggle').onclick = () => { state.cornerCollapsed = !state.cornerCollapsed; renderCornerBg(selectedSession()); };
$('cornerJump').onclick = () => {
  const prevTab = state.tab;
  state.tab = 'tasks';
  document.querySelectorAll('#wsSubtabs .subtab').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'tasks'));
  syncSubtabGlider($('wsSubtabs'));
  renderWorkspace({ forceScroll: true });
  const dir = (SUBTAB_ORDER.tasks ?? 1) >= (SUBTAB_ORDER[prevTab] ?? 0) ? 'anim-tab-right' : 'anim-tab-left';
  triggerAnim($('panel'), dir, 240);
  flashPanelScan();
};

function getSessionCache(key) {
  let c = state.sessionCache.get(key);
  if (!c) { c = { turns: null, dialog: null, tasksData: null, screenData: null }; state.sessionCache.set(key, c); }
  return c;
}

function wireTurnButtons(root) {
  root.querySelectorAll('.js-stop-turn').forEach((btn) => { btn.onclick = () => stopSession(); });
  root.querySelectorAll('.hazard-box button').forEach((btn) => { btn.onclick = () => sendKeys([btn.dataset.key]); });
  root.querySelectorAll('.code-copy').forEach((btn) => {
    btn.onclick = () => {
      const pre = btn.closest('.code-frame')?.querySelector('pre');
      if (pre) navigator.clipboard?.writeText(pre.textContent || '');
      btn.textContent = 'COPIED';
      setTimeout(() => { btn.textContent = 'COPY'; }, 1200);
    };
  });
}

function buildTurnHtml(s, t, i, isLast, isTurnActive, pend, stopNote) {
  const chunks = [];
  if (t.prompt) chunks.push(`<div class="msg-user-label">OPERATOR // T-${pad2(i + 1)} · RECEIVED ✓</div><div class="msg-user">${esc(t.prompt)}</div>`);
  const traceParts = [];
  if (t.thoughts?.length) {
    const combined = t.thoughts.join('\n\n---\n\n');
    const openAttr = (isLast && isTurnActive && !t.texts?.length) ? ' open' : '';
    traceParts.push(`<details class="thought-box"${openAttr}><summary>▸ THOUGHT · ${t.thoughts.length} BLOCK${t.thoughts.length > 1 ? 'S' : ''}</summary><div class="thought-body">${esc(combined)}</div></details>`);
  }
  if (t.tools?.length) {
    const rows = t.tools.slice(-8).map((tl) =>
      `<div class="tool-row"><span class="tool-name">⚙ ${esc(tl.name)}</span><span class="tool-sum">${esc(tl.summary)}</span></div>`).join('');
    traceParts.push(`<div class="tools-list">${rows}</div>`);
  }
  if (traceParts.length) chunks.push(`<div class="trace-wrap">${traceParts.join('')}</div>`);
  if (t.texts?.length) {
    const fullText = t.texts.join('\n\n');
    const turnBadge = t.done ? 'DONE' : (isLast && isTurnActive ? 'STREAMING' : 'STOPPED');
    chunks.push(`<div class="msg-bot-wrap" data-raw="${esc(fullText)}"><div class="msg-bot-head"><span>${esc((KIND_LABEL[s.kind] || s.kind).toUpperCase())} // ${esc(s.model || 'RESPONSE')}<span class="hl-status"></span></span><span>${turnBadge}</span></div><div class="msg-bot-body">${renderMarkdown(fullText)}</div></div>`);
  }
  if (isLast && isTurnActive && !pend && !stopNote) {
    const lastTool = t.tools?.at(-1);
    const actText = lastTool ? `RUNNING · ${lastTool.name}${lastTool.summary ? ` — ${lastTool.summary.slice(0, 60)}` : ''}` : 'AGENT THINKING / STREAMING…';
    chunks.push(`<div class="live-pulse"><span class="dot"></span><span>${esc(actText)}</span></div>`);
  } else if (isLast && !t.done && !isTurnActive && !stopNote) {
    chunks.push(`<div class="stop-ack" style="border-color:var(--line-strong);background:var(--bg-rail);color:var(--muted)">⏹ TURN INTERRUPTED // 当前回合已停止</div>`);
  }
  return chunks.join('');
}

function syncStopButton(s) {
  const q = getEffectiveQueue(s);
  const hasInjected = Boolean(s && s.kind !== 'shell' && q.some((x) => x.state === 'injected'));
  const stoppedHere = s ? (Boolean(s.stoppedAt) || state.stoppedKeys.has(s.key)) : false;
  const active = Boolean(s && !stoppedHere && (s.status === 'working' || hasInjected));
  const btn = $('stopBtn');
  btn.disabled = !active;
  btn.classList.toggle('active-run', active);
  btn.textContent = '■ STOP';

  // Sync composer send button & placeholder with queue state
  const sendBtn = $('sendBtn');
  const inp = $('input');
  if (s && sendBtn && inp) {
    const willQueue = s.status === 'working' || s.status === 'blocked' || q.some((x) => x.state === 'queued');
    const nextLbl = willQueue ? 'QUEUE +' : 'TRANSMIT';
    if (sendBtn.textContent !== nextLbl) sendBtn.textContent = nextLbl;
    sendBtn.classList.toggle('cyan', willQueue);
    sendBtn.classList.toggle('solid', !willQueue);
    const nextPh = willQueue
      ? '当前运行中，点击 QUEUE + 自动排入上方候选队列（支持插队 / 调序 / 撤回重编）'
      : '输入指令后点击右侧 TRANSMIT 发送（Enter 换行，空输入按 Esc 停止）';
    if (inp.placeholder !== nextPh) inp.placeholder = nextPh;
  }
  return active;
}

async function queueAction(sessionKey, payload, { restoreToInput = false } = {}) {
  if (!sessionKey) return;
  try {
    const res = await api(`/api/session/${encodeURIComponent(sessionKey)}/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const target = state.sessions.find((x) => x.key === sessionKey);
    if (target && Array.isArray(res.pendingQueue)) {
      target.pendingQueue = res.pendingQueue;
      target.queuePaused = Boolean(res.queuePaused);
    }
    if (restoreToInput && res.removed?.text) {
      const inp = $('input');
      inp.value = inp.value.trim() ? `${inp.value.trim()}\n${res.removed.text}` : res.removed.text;
      inp.style.height = 'auto';
      inp.style.height = `${Math.min(130, inp.scrollHeight)}px`;
      inp.focus();
    }
    renderSessions();
    const cur = selectedSession();
    renderQueueTray(cur);
    syncStopButton(cur);
    if (cur && cur.key === sessionKey && state.tab === 'chat') {
      const c = getSessionCache(cur.key);
      if (c.turns) paintChat(cur, c.turns, c.dialog, { forceScroll: payload.action === 'flush' || payload.action === 'resume' });
    }
  } catch (err) {
    alert(err.message);
  }
}

function renderQueueTray(s) {
  const tray = $('queueTray');
  if (!tray) return;
  // Only show the Candidate Queue tray when there are actually queued items waiting to enter the session.
  // Messages sent immediately to an idle session (state === 'injected') render directly up in the chat stream!
  const queuedItems = getEffectiveQueue(s).filter((x) => x.state === 'queued');
  if (!s || !queuedItems.length) {
    tray.style.display = 'none';
    return;
  }
  tray.style.display = 'flex';
  const paused = Boolean(s.queuePaused);
  tray.classList.toggle('paused', paused);
  tray.classList.toggle('collapsed', state.queueCollapsed);
  const togTxt = state.queueCollapsed ? '+' : '−';
  if ($('queueToggleBtn').textContent !== togTxt) $('queueToggleBtn').textContent = togTxt;

  const titleTxt = paused
    ? `CANDIDATE QUEUE // ${queuedItems.length} (PAUSED)`
    : `CANDIDATE QUEUE // ${queuedItems.length} QUEUED`;
  if ($('queueTitle').textContent !== titleTxt) $('queueTitle').textContent = titleTxt;

  const hintTxt = paused
    ? '因手动 STOP 已暂停自动派发 · 点击 RESUME 恢复或逐条撤回/编辑'
    : '尚未进入会话的候选消息按序排队 · 当前回合结束后自动依序送入对话流';
  if ($('queueHint').textContent !== hintTxt) $('queueHint').textContent = hintTxt;

  $('queueResumeBtn').style.display = paused ? '' : 'none';
  $('queueFlushBtn').style.display = (!paused && queuedItems.length && s.status !== 'blocked') ? '' : 'none';
  $('queueClearBtn').style.display = queuedItems.length > 1 ? '' : 'none';

  const listEl = $('queueList');
  const existing = new Map();
  listEl.querySelectorAll(':scope > .queue-item').forEach((el) => existing.set(el.dataset.qid, el));
  const keepIds = new Set(queuedItems.map((x) => x.id));
  for (const [id, el] of existing) if (!keepIds.has(id)) el.remove();

  const firstQueuedId = queuedItems[0]?.id || '';
  const lastQueuedId = queuedItems.at(-1)?.id || '';

  queuedItems.forEach((item, idx) => {
    let row = existing.get(item.id);
    if (!row) {
      row = document.createElement('div');
      row.dataset.qid = item.id;
      row.innerHTML = '<div class="q-left"><span class="q-rank"></span><span class="q-chip"></span><span class="q-text"></span><span class="q-age"></span></div><div class="q-actions"></div>';
      listEl.appendChild(row);
    } else if (listEl.children[idx] !== row) {
      listEl.insertBefore(row, listEl.children[idx] || null);
    }
    const rowCls = 'queue-item';
    if (row.className !== rowCls) row.className = rowCls;

    const rankEl = row.querySelector('.q-rank');
    const rankTxt = `#${pad2(idx + 1)}`;
    if (rankEl.textContent !== rankTxt) rankEl.textContent = rankTxt;

    const chipEl = row.querySelector('.q-chip');
    const chipCls = `q-chip ${paused ? 'paused' : ''}`.trim();
    const chipTxt = paused ? 'PAUSED · 已暂停' : 'QUEUED · 排队待发';
    if (chipEl.className !== chipCls) chipEl.className = chipCls;
    if (chipEl.textContent !== chipTxt) chipEl.textContent = chipTxt;

    const textEl = row.querySelector('.q-text');
    const oneLineTxt = item.text.replace(/\s+/g, ' ');
    if (textEl.textContent !== oneLineTxt) {
      textEl.textContent = oneLineTxt;
      textEl.title = item.text;
    }

    const ageEl = row.querySelector('.q-age');
    const ageTxt = fmtSec((Date.now() - (item.createdAt || Date.now())) / 1000);
    if (ageEl.textContent !== ageTxt) ageEl.textContent = ageTxt;

    const actEl = row.querySelector('.q-actions');
    const isOptimistic = String(item.id).startsWith('opt-');
    const canMoveUp = !isOptimistic && item.id !== firstQueuedId && queuedItems.length > 1;
    const canMoveDown = !isOptimistic && item.id !== lastQueuedId && queuedItems.length > 1;
    const actSig = `${isOptimistic}|${canMoveUp}|${canMoveDown}|${s.status === 'blocked'}`;
    if (actEl.dataset.sig !== actSig) {
      actEl.dataset.sig = actSig;
      if (isOptimistic) {
        actEl.innerHTML = '<span class="q-age">SYNC…</span>';
      } else {
        const injectBtn = s.status !== 'blocked'
          ? '<button type="button" class="btn xs cyan" data-qact="flush" title="立即注入终端会话（不等当前回合结束）">INJECT ↗</button>'
          : '';
        const upBtn = canMoveUp ? '<button type="button" class="btn xs ghost" data-qact="up" title="上移顺位">↑</button>' : '';
        const dnBtn = canMoveDown ? '<button type="button" class="btn xs ghost" data-qact="down" title="下移顺位">↓</button>' : '';
        actEl.innerHTML = `${injectBtn}${upBtn}${dnBtn}<button type="button" class="btn xs ghost" data-qact="edit" title="撤回至输入框重新编辑">✎</button><button type="button" class="btn xs danger" data-qact="remove" title="取消并移除该候选消息">✕</button>`;
      }
      actEl.querySelectorAll('[data-qact]').forEach((b) => {
        b.onclick = () => {
          const act = b.dataset.qact;
          if (act === 'flush') queueAction(s.key, { action: 'flush', id: item.id });
          else if (act === 'up' || act === 'down') queueAction(s.key, { action: 'move', id: item.id, dir: act });
          else if (act === 'edit') queueAction(s.key, { action: 'remove', id: item.id }, { restoreToInput: true });
          else if (act === 'remove') queueAction(s.key, { action: 'remove', id: item.id });
        };
      });
    }
  });
}
$('queueToggleBtn').onclick = () => { state.queueCollapsed = !state.queueCollapsed; renderQueueTray(selectedSession()); };
$('queueResumeBtn').onclick = () => { const s = selectedSession(); if (s) queueAction(s.key, { action: 'resume' }); };
$('queueFlushBtn').onclick = () => { const s = selectedSession(); if (s) queueAction(s.key, { action: 'flush' }); };
$('queueClearBtn').onclick = () => { const s = selectedSession(); if (s) queueAction(s.key, { action: 'clear' }); };

function paintChat(s, turns, dialog, { forceScroll = false } = {}) {
  const panel = $('panel');
  $('hlBar').style.display = 'flex';
  state.lastTurnCount.set(s.key, turns.length);
  const stoppedTurnLen = state.stoppedKeys.get(s.key);
  if (stoppedTurnLen !== undefined && turns.length > stoppedTurnLen) state.stoppedKeys.delete(s.key);
  const enteringItems = getEffectiveQueue(s).filter((x) => x.state === 'injected');
  const pend = enteringItems.length ? enteringItems : null;
  if (state.stopNotice && Date.now() - state.stopNotice.at > 4000) state.stopNotice = null;
  const stopNote = state.stopNotice && state.stopNotice.key === s.key ? state.stopNotice : null;
  const isTurnActive = syncStopButton(s);
  renderQueueTray(s);

  const viewId = `chat:${s.key}`;
  const switched = panel.dataset.view !== viewId;
  const wasAtBottom = switched || (panel.scrollHeight - panel.scrollTop - panel.clientHeight) < 90;

  if (switched) {
    panel.dataset.view = viewId;
    panel.innerHTML = '<div id="chatDialog"></div><div id="chatTurns" style="display:flex;flex-direction:column;gap:16px"></div><div id="chatTail" style="display:flex;flex-direction:column;gap:10px"></div>';
  }
  state.lastTab = 'chat';
  state.lastChatKey = s.key;

  // 1) Dialog alert bar
  const dlgWrap = $('chatDialog');
  const dlgSig = dialog ? JSON.stringify(dialog) : '';
  if (dlgWrap.dataset.sig !== dlgSig) {
    dlgWrap.dataset.sig = dlgSig;
    if (dialog) {
      const opts = dialog.options.map((o, i) =>
        `<button class="btn amber" data-key="${esc(o.key || String(i + 1))}">${esc(o.key ? `${o.key}. ` : '')}${esc(o.label)}</button>`).join('');
      dlgWrap.innerHTML = `<div class="hazard-box"><div class="hazard-title">PRTS ALERT // CONFIRMATION REQUIRED</div><div class="hazard-q">${esc(dialog.question || '')}</div><div class="keybar" style="padding:0;background:transparent;border:0">${opts}<button class="btn ghost" data-key="esc">ESC</button></div></div>`;
      wireTurnButtons(dlgWrap);
    } else {
      dlgWrap.innerHTML = '';
    }
  }

  // 2) Incremental per-turn DOM diffing (finished turns never re-mount or blink!)
  const turnsWrap = $('chatTurns');
  if (!turns.length && !pend) {
    const emptySig = `empty:${s.kind}`;
    if (turnsWrap.dataset.sig !== emptySig) {
      turnsWrap.dataset.sig = emptySig;
      turnsWrap.innerHTML = `<div class="empty"><strong>${s.kind === 'shell' ? 'SHELL UNIT' : 'NO RECORDS'}</strong>${s.kind === 'shell' ? 'SHELL 会话无对话记录，请切换至 TTY 终端查看实时输出' : 'SEND A DIRECTIVE BELOW TO BEGIN'}</div>`;
    }
  } else {
    if (turnsWrap.dataset.sig?.startsWith('empty:')) {
      turnsWrap.dataset.sig = '';
      turnsWrap.innerHTML = '';
    }
    while (turnsWrap.children.length > turns.length) turnsWrap.lastElementChild.remove();
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      const isLast = i === turns.length - 1;
      const tSig = JSON.stringify([
        t.prompt || '',
        t.thoughts?.length || 0,
        t.thoughts?.at(-1)?.length || 0,
        t.tools?.length || 0,
        t.tools?.at(-1)?.name || '',
        t.tools?.at(-1)?.summary || '',
        t.texts?.length || 0,
        t.texts?.at(-1)?.length || 0,
        t.texts?.at(-1)?.slice(-32) || '',
        Boolean(t.done),
        isLast ? (isTurnActive ? 2 : 1) : 0,
        isLast && Boolean(pend),
        isLast && Boolean(stopNote),
        s.model || '',
      ]);
      let block = turnsWrap.children[i];
      if (!block) {
        block = document.createElement('div');
        block.className = 'turn-block';
        turnsWrap.appendChild(block);
      }
      if (block.dataset.sig !== tSig) {
        block.dataset.sig = tSig;
        block.innerHTML = buildTurnHtml(s, t, i, isLast, isTurnActive, pend, stopNote);
        // Apply cached DeepSeek highlights & TL;DR synchronously BEFORE paint so zero layout jump!
        block.querySelectorAll('.msg-bot-wrap[data-raw]').forEach((w) => {
          const cached = (state.hl.on || state.hl.tldr) ? state.hl.cache.get(w.dataset.raw || '') : null;
          if (cached) paintHighlightOnto(w, cached);
        });
        wireTurnButtons(block);
      }
    }
  }

  // 3) Tail notices (direct-sent messages entering session + stop notice)
  const tailWrap = $('chatTail');
  const tailSig = JSON.stringify([enteringItems.map((x) => [x.id, x.text]), stopNote?.at || 0]);
  if (tailWrap.dataset.sig !== tailSig) {
    tailWrap.dataset.sig = tailSig;
    const tailParts = [];
    for (const item of enteringItems) {
      tailParts.push(`<div class="turn-block"><div class="msg-user-label">OPERATOR // SENT TO SESSION</div><div class="msg-user">${esc(item.text)}</div><div class="pending-ack"><span>⏳ 已送入会话（${esc(s.name)}），等待模型响应…</span></div></div>`);
    }
    if (stopNote) {
      tailParts.push(`<div class="stop-ack">■ 已向 ${esc(s.name)} 发送中断指令（${esc(stopNote.keyHint)}）</div>`);
    }
    tailWrap.innerHTML = tailParts.join('');
    wireTurnButtons(tailWrap);
  }

  applyAllHighlights();
  renderCornerBg(s);
  if (forceScroll || switched || wasAtBottom) panel.scrollTop = panel.scrollHeight;
}

function paintTasks(s, data) {
  const panel = $('panel');
  $('hlBar').style.display = 'none';
  $('cornerBg').style.display = 'none';
  state.lastTab = 'tasks';
  const runningTasks = (data.tasks || [])
    .filter((t) => t.status === 'running')
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  if (!runningTasks.length) {
    state.selectedTaskId = null;
    const emptyView = `tasks-empty:${s.key}`;
    if (panel.dataset.view !== emptyView) {
      panel.dataset.view = emptyView;
      panel.innerHTML = '<div class="empty"><strong>NO RUNNING ASYNC OPERATIONS</strong>当前无运行中的后台任务</div>';
    }
    return;
  }
  const activeId = runningTasks.some((t) => t.id === data.selectedTaskId) ? data.selectedTaskId : runningTasks[0].id;
  state.selectedTaskId = activeId;
  const viewId = `tasks:${s.key}:${runningTasks.map((t) => t.id).join(',')}`;
  if (panel.dataset.view !== viewId) {
    panel.dataset.view = viewId;
    const tiles = runningTasks.map((t, idx) => `<div class="op-card clickable running" data-tid="${esc(t.id)}">
        <div class="op-top"><span class="op-code">OP-${pad2(idx + 1)} // ${esc(t.shortId)}</span><span class="u-chip st-background">running</span></div>
        <div class="op-desc">${esc(t.description)}</div>
        <div class="op-foot"><span class="op-kind"></span><span class="op-dur"></span></div>
      </div>`).join('');
    const logBox = `<div class="console-frame"><div class="console-bar"><span id="taskLogTitle"></span><button id="refreshTasks" class="btn xs ghost">SYNC</button></div><pre class="terminal-box"></pre></div>`;
    panel.innerHTML = `<div class="ops-grid">${tiles}</div>${logBox}`;
    panel.querySelectorAll('.op-card').forEach((el) => { el.onclick = () => { state.selectedTaskId = el.dataset.tid; renderWorkspace(); }; });
    const rt = $('refreshTasks');
    if (rt) rt.onclick = () => renderWorkspace();
  }
  runningTasks.forEach((t) => {
    const card = panel.querySelector(`.op-card[data-tid="${CSS.escape(t.id)}"]`);
    if (!card) return;
    card.classList.toggle('selected', t.id === activeId);
    const kindTxt = `${t.kind.toUpperCase()}${t.summary ? ` · ${t.summary}` : ''}`;
    const durTxt = `ELAPSED ${fmtSec((Date.now() - t.startedAt) / 1000)}`;
    const kEl = card.querySelector('.op-kind');
    const dEl = card.querySelector('.op-dur');
    if (kEl && kEl.textContent !== kindTxt) kEl.textContent = kindTxt;
    if (dEl && dEl.textContent !== durTxt) dEl.textContent = durTxt;
  });
  const titleEl = $('taskLogTitle');
  const titleTxt = `LIVE STREAM // ${activeId}`;
  if (titleEl && titleEl.textContent !== titleTxt) titleEl.textContent = titleTxt;
  const term = panel.querySelector('.terminal-box');
  const nextLog = data.log || '(awaiting log output...)';
  if (term && term.textContent !== nextLog) {
    const atBottom = !term.textContent || (term.scrollHeight - term.scrollTop - term.clientHeight) < 40;
    term.textContent = nextLog;
    if (atBottom) term.scrollTop = term.scrollHeight;
  }
}

function paintTerm(s, data, { forceScroll = false } = {}) {
  const panel = $('panel');
  $('hlBar').style.display = 'none';
  $('cornerBg').style.display = 'none';
  state.lastTab = 'term';
  const viewId = `term:${s.key}`;
  let created = false;
  if (panel.dataset.view !== viewId) {
    panel.dataset.view = viewId;
    created = true;
    const keys = ['enter', 'esc', 'up', 'down', 'tab', 'c-c', '1', '2', '3', 'y', 'n'];
    panel.innerHTML = `
      <div class="console-frame">
        <div class="console-bar"><span>TTY CAPTURE // ${esc(s.name)} (${esc(s.key)})</span><button id="refreshTerm" class="btn xs ghost">SYNC</button></div>
        <pre class="terminal-box"></pre>
        <div class="keybar">${keys.map((k) => `<button class="btn ghost" data-k="${k}">${k.toUpperCase()}</button>`).join('')}</div>
      </div>`;
    panel.querySelectorAll('[data-k]').forEach((b) => { b.onclick = () => sendKeys([b.dataset.k]); });
    $('refreshTerm').onclick = () => renderWorkspace();
  }
  const term = panel.querySelector('.terminal-box');
  const nextScreen = data.screen || '(empty screen)';
  if (term && term.textContent !== nextScreen) {
    const atBottom = created || forceScroll || (term.scrollHeight - term.scrollTop - term.clientHeight) < 40;
    term.textContent = nextScreen;
    if (atBottom) term.scrollTop = term.scrollHeight;
  }
}

let wsRenderSeq = 0;

async function ensureModelCatalog(force = false) {
  if (state.modelCatalog && !force) return state.modelCatalog;
  try {
    state.modelCatalog = await api(`/api/models${force ? '?refresh=1' : ''}`);
  } catch {
    state.modelCatalog = { agy: [], presets: {}, efforts: ['low', 'medium', 'high', 'xhigh'] };
  }
  return state.modelCatalog;
}

function groupAgyFamilies(list = []) {
  const map = new Map();
  for (const item of list) {
    let g = map.get(item.family);
    if (!g) { g = { family: item.family, variants: new Map(), rawId: item.id }; map.set(item.family, g); }
    if (item.effort) g.variants.set(item.effort, item.id);
    else g.rawId = item.id;
  }
  return [...map.values()];
}

function resolveCurrentAgyFamily(s) {
  const agyList = state.modelCatalog?.agy || [];
  if (!agyList.length || !s) return null;
  const raw = String(s.model || '').toLowerCase();
  const fam = String(s.modelFamily || '').toLowerCase();
  const exact = agyList.find((m) => m.id.toLowerCase() === raw || m.label.toLowerCase() === raw);
  if (exact) return groupAgyFamilies(agyList).find((g) => g.family === exact.family) || null;
  if (fam) {
    const byFam = groupAgyFamilies(agyList).find((g) => g.family.toLowerCase() === fam);
    if (byFam) return byFam;
  }
  const stripped = raw.replace(/\s*·\s*(low|medium|high|xhigh|max)\s*$/i, '').trim();
  if (stripped) {
    return groupAgyFamilies(agyList).find((g) => g.family.toLowerCase() === stripped) || null;
  }
  return null;
}

function renderModelBar(s) {
  const bar = $('modelBar');
  if (!s || s.kind === 'shell') {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  const busy = s.status === 'working' || state.switchingModel;
  bar.classList.toggle('busy', busy);
  $('modelPickBtn').disabled = busy;

  const agyFam = s.kind === 'agy' ? resolveCurrentAgyFamily(s) : null;
  const inferredEff = (String(s.model || '').match(/(?:·\s*|-|\()(low|medium|high|xhigh|max)\)?\s*$/i)?.[1] || '').toLowerCase();
  const curEffort = String(s.effort || inferredEff).toLowerCase();
  const displayModel = agyFam?.family || s.modelFamily || (s.model ? s.model.replace(/\s*·\s*(low|medium|high|xhigh|max)\s*$/i, '') : '') || `${(KIND_LABEL[s.kind] || s.kind).toUpperCase()} MODEL`;
  if ($('modelPickText').textContent !== displayModel) $('modelPickText').textContent = displayModel;

  const supportsEffort = s.kind === 'agy' || s.kind === 'dsh' || s.kind === 'claude';
  $('effortWrap').style.display = supportsEffort ? 'inline-flex' : 'none';
  if (supportsEffort) {
    $('effortGroup').querySelectorAll('.eff-btn').forEach((btn) => {
      const eff = btn.dataset.eff;
      const allowed = agyFam ? agyFam.variants.has(eff) : true;
      btn.disabled = busy || !allowed;
      btn.classList.toggle('active', curEffort === eff);
    });
  }

  if (state.modelFlash && Date.now() - state.modelFlashAt > 3500) state.modelFlash = '';
  $('modelSwitchMsg').textContent = state.switchingModel ? 'SWITCHING…' : state.modelFlash;
}

async function applyModelSwitch({ model = '', effort = '', label = '' } = {}) {
  const s = selectedSession();
  if (!s || state.switchingModel) return;
  if (s.status === 'working') {
    alert('当前会话正在思考/生成中，请先等待结束或点击 STOP 后再切换模型与思考强度。');
    return;
  }
  state.switchingModel = true;
  renderModelBar(s);
  try {
    const res = await api(`/api/session/${encodeURIComponent(s.key)}/model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, effort }),
    });
    if (res.model) s.model = res.model;
    if (res.modelFamily !== undefined) s.modelFamily = res.modelFamily;
    if (res.effort !== undefined) s.effort = res.effort;
    state.modelFlash = `✓ ${label || res.model || effort.toUpperCase()}`;
    state.modelFlashAt = Date.now();
    setTimeout(() => renderModelBar(selectedSession()), 3600);
  } catch (err) {
    alert(err.message);
  } finally {
    state.switchingModel = false;
    renderSessions();
    renderModelBar(selectedSession());
  }
}

async function openModelDialog(forceRefresh = false) {
  const s = selectedSession();
  if (!s || s.kind === 'shell') return;
  $('modelDialogTitle').textContent = `切换模型与思考强度 // ${s.name}`;
  const listEl = $('modelList');
  listEl.innerHTML = '<div class="empty" style="padding:18px">LOADING MODELS…</div>';
  if (!$('modelDialog').open) $('modelDialog').showModal();
  const cat = await ensureModelCatalog(forceRefresh);
  const inferredEff = (String(s.model || '').match(/(?:·\s*|-|\()(low|medium|high|xhigh|max)\)?\s*$/i)?.[1] || '').toLowerCase();
  const curEffort = String(s.effort || inferredEff).toLowerCase();
  const EFF_LABEL = { low: 'LOW', medium: 'MED', high: 'HIGH', xhigh: 'XHIGH', max: 'MAX' };

  if (s.kind === 'agy') {
    const curFam = resolveCurrentAgyFamily(s)?.family || '';
    const groups = groupAgyFamilies(cat.agy || []);
    listEl.innerHTML = groups.map((g) => {
      const isCur = g.family === curFam || String(s.model || '').toLowerCase() === g.rawId.toLowerCase();
      let btns = '';
      if (g.variants.size) {
        btns = ['low', 'medium', 'high', 'xhigh'].filter((e) => g.variants.has(e)).map((e) => {
          const vid = g.variants.get(e);
          const act = isCur && curEffort === e;
          return `<button type="button" class="btn xs ${act ? 'cyan' : 'ghost'}" data-mid="${esc(vid)}" data-mlbl="${esc(`${g.family} · ${e}`)}">${EFF_LABEL[e] || e.toUpperCase()}</button>`;
        }).join('');
      } else {
        btns = `<button type="button" class="btn xs ${isCur ? 'cyan' : 'ghost'}" data-mid="${esc(g.rawId)}" data-mlbl="${esc(g.family)}">${isCur ? 'ACTIVE' : 'SELECT'}</button>`;
      }
      return `<div class="model-row${isCur ? ' current' : ''}"><span class="model-fam">${esc(g.family)}</span><div class="model-variants">${btns}</div></div>`;
    }).join('');
  } else {
    const presets = cat.presets?.[s.kind] || [];
    listEl.innerHTML = presets.length
      ? presets.map((id) => {
          const isCur = String(s.model || '').toLowerCase() === id.toLowerCase();
          return `<div class="model-row${isCur ? ' current' : ''}"><span class="model-fam">${esc(id)}</span><div class="model-variants"><button type="button" class="btn xs ${isCur ? 'cyan' : 'ghost'}" data-mid="${esc(id)}" data-mlbl="${esc(id)}">${isCur ? 'ACTIVE' : 'SELECT'}</button></div></div>`;
        }).join('')
      : '<div class="empty" style="padding:14px">在下方输入要切换的模型名称</div>';
  }
  $('customEffortWrap').style.display = (s.kind === 'agy' || s.kind === 'dsh' || s.kind === 'claude') ? '' : 'none';
  listEl.querySelectorAll('[data-mid]').forEach((btn) => {
    btn.onclick = async () => {
      $('modelDialog').close();
      await applyModelSwitch({ model: btn.dataset.mid, label: btn.dataset.mlbl });
    };
  });
}

async function renderWorkspace({ forceScroll = false } = {}) {
  if (state.mode !== 'sessions') return;
  const s = selectedSession();
  $('wsBar').style.display = s ? '' : 'none';
  $('composer').style.display = s ? '' : 'none';
  if (!s) {
    $('queueTray').style.display = 'none';
    $('modelBar').style.display = 'none';
    $('hlBar').style.display = 'none';
    $('wsWatermark').textContent = 'PRTS';
    $('cornerBg').style.display = 'none';
    $('panel').dataset.view = 'empty';
    $('panel').innerHTML = '<div class="empty"><strong>PRTS TERMINAL READY</strong>SELECT AN AGENT UNIT FROM THE ROSTER</div>';
    return;
  }
  const fixedId = s.unitId ? `${pad2(s.unitId)} // ` : '';
  $('wsWatermark').textContent = (KIND_LABEL[s.kind] || s.kind).toUpperCase();
  if ($('wsTitle').textContent !== `${fixedId}${s.name}`) $('wsTitle').textContent = `${fixedId}${s.name}`;
  if ($('wsKind').textContent !== (KIND_LABEL[s.kind] || s.kind)) $('wsKind').textContent = KIND_LABEL[s.kind] || s.kind;
  const stTxt = STATUS_LABEL[s.status] || s.status;
  if ($('wsStatus').textContent !== stTxt) $('wsStatus').textContent = stTxt;
  if ($('wsStatus').className !== `u-chip st-${s.status}`) $('wsStatus').className = `u-chip st-${s.status}`;
  $('wsModel').textContent = s.model || '';
  $('wsModel').style.display = s.model ? '' : 'none';
  const subTxt = [s.cwd, s.title].filter(Boolean).join('  //  ');
  if ($('wsSub').textContent !== subTxt) $('wsSub').textContent = subTxt;
  const count = s.runningTasks || 0;
  $('taskBadge').textContent = String(count);
  $('taskBadge').style.display = count ? '' : 'none';
  syncStopButton(s);
  renderQueueTray(s);
  renderModelBar(s);
  if (s.kind === 'agy' && !state.modelCatalog) ensureModelCatalog().then(() => renderModelBar(selectedSession()));
  document.querySelectorAll('#wsSubtabs .subtab').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  syncSubtabGlider($('wsSubtabs'));

  // Instant 0ms paint from sessionCache on tab/session switch so UI never blinks waiting for network!
  const cache = getSessionCache(s.key);
  const tabAtStart = state.tab;
  const keyAtStart = s.key;
  const panelView = $('panel').dataset.view || '';
  if (tabAtStart === 'chat' && cache.turns && !panelView.startsWith(`chat:${s.key}`)) {
    paintChat(s, cache.turns, cache.dialog, { forceScroll });
  } else if (tabAtStart === 'tasks' && cache.tasksData && !panelView.startsWith(`tasks:${s.key}`)) {
    paintTasks(s, cache.tasksData);
  } else if (tabAtStart === 'term' && cache.screenData && panelView !== `term:${s.key}`) {
    paintTerm(s, cache.screenData, { forceScroll });
  }

  const keyEnc = encodeURIComponent(s.key);
  const seq = ++wsRenderSeq;
  state.lastWsFetchAt = Date.now();
  try {
    if (tabAtStart === 'chat') {
      const [turnsRes, screenData] = await Promise.all([
        api(`/api/session/${keyEnc}/turns`),
        s.status === 'blocked' ? api(`/api/session/${keyEnc}/screen?lines=30`) : Promise.resolve(null),
      ]);
      const turns = turnsRes.turns || [];
      if (Array.isArray(turnsRes.pendingQueue)) {
        s.pendingQueue = turnsRes.pendingQueue;
        s.queuePaused = Boolean(turnsRes.queuePaused);
      }
      cache.turns = turns;
      cache.dialog = screenData?.dialog || null;
      if (seq !== wsRenderSeq || state.tab !== 'chat' || state.selectedKey !== keyAtStart) return;
      renderSessions();
      paintChat(s, turns, cache.dialog, { forceScroll });
    } else if (tabAtStart === 'tasks') {
      const validSel = state.selectedTaskId && (s.tasks || []).some((t) => t.id === state.selectedTaskId && t.status === 'running');
      const q = validSel ? `&taskId=${encodeURIComponent(state.selectedTaskId)}` : '';
      const data = await api(`/api/session/${keyEnc}/tasks?lines=120${q}`);
      cache.tasksData = data;
      if (seq !== wsRenderSeq || state.tab !== 'tasks' || state.selectedKey !== keyAtStart) return;
      paintTasks(s, data);
    } else {
      const data = await api(`/api/session/${keyEnc}/screen?lines=100`);
      cache.screenData = data;
      if (seq !== wsRenderSeq || state.tab !== 'term' || state.selectedKey !== keyAtStart) return;
      paintTerm(s, data, { forceScroll });
    }
  } catch (err) {
    if (seq !== wsRenderSeq) return;
    $('panel').dataset.view = 'error';
    $('panel').innerHTML = `<div class="empty"><strong>TELEMETRY ERROR</strong>${esc(err.message)}</div>`;
  }
}

// ---- 02 // HEARTBEAT VIEW ----
function renderHeartbeats() {
  const list = state.ops?.heartbeats || [];
  const wrap = $('hbList');
  if (!list.length) {
    wrap.innerHTML = '<div class="empty"><strong>NO HEARTBEAT SCHEDULES</strong>点击右上角 + NEW HEARTBEAT 设定定时任务</div>';
    return;
  }
  wrap.innerHTML = list.map((hb, idx) => {
    const sched = hb.scheduleKind === 'cron' ? `CRON: ${hb.cron}` : `EVERY ${hb.everyMinutes}m`;
    const target = hb.targetMode === 'spawn' ? `SPAWN ${hb.agent.toUpperCase()} (${hb.cwd})` : `SESSION: ${hb.targetRef || 'AUTO'}`;
    const stClass = !hb.enabled ? '' : hb.lastStatus === 'error' ? 'st-error' : 'st-working';
    const staggerCls = state.viewEntryAnim ? ' ops-stagger-item' : '';
    const staggerSty = state.viewEntryAnim ? ` style="--card-i:${Math.min(idx, 10)}"` : '';
    return `<div class="op-card ${hb.enabled ? 'running' : ''}${staggerCls}"${staggerSty}>
      <div class="op-top">
        <span class="op-code">${esc(hb.name)}</span>
        <span class="u-chip ${stClass}">${hb.enabled ? 'ACTIVE' : 'PAUSED'}</span>
      </div>
      <div class="u-meta">
        <span class="u-chip st-background">${esc(sched)}</span>
        <span class="u-chip">${esc(target)}</span>
      </div>
      <div class="op-desc">${esc(hb.prompt)}</div>
      <div class="op-foot">
        <span>LAST: ${fmtTime(hb.lastRunAt)}${hb.lastNote ? ` · ${esc(hb.lastNote)}` : ''}</span>
        <div style="display:flex;gap:5px">
          <button class="btn xs cyan" data-hbrun="${esc(hb.id)}">RUN NOW</button>
          <button class="btn xs ghost" data-hbtog="${esc(hb.id)}" data-en="${hb.enabled ? '0' : '1'}">${hb.enabled ? 'PAUSE' : 'ENABLE'}</button>
          <button class="btn xs danger" data-hbdel="${esc(hb.id)}">DEL</button>
        </div>
      </div>
    </div>`;
  }).join('');
  wrap.querySelectorAll('[data-hbrun]').forEach((b) => {
    b.onclick = async () => { b.disabled = true; try { await api(`/api/heartbeats/${b.dataset.hbrun}/run`, { method: 'POST' }); } catch (e) { alert(e.message); } finally { b.disabled = false; } };
  });
  wrap.querySelectorAll('[data-hbtog]').forEach((b) => {
    b.onclick = () => api(`/api/heartbeats/${b.dataset.hbtog}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: b.dataset.en === '1' }) });
  });
  wrap.querySelectorAll('[data-hbdel]').forEach((b) => {
    b.onclick = () => { if (confirm('删除这个定时任务？')) api(`/api/heartbeats/${b.dataset.hbdel}`, { method: 'DELETE' }); };
  });
}

// ---- 03 // LONG-HORIZON GOALS VIEW ----
function renderGoals() {
  const list = state.ops?.goals || [];
  const wrap = $('goalList');
  if (!list.length) {
    wrap.innerHTML = '<div class="empty"><strong>NO LONG-HORIZON GOALS</strong>点击右上角 + NEW GOAL 设定长期目标与监督会话</div>';
    return;
  }
  wrap.innerHTML = list.map((g, idx) => {
    const stClass = g.status === 'achieved' ? 'st-working' : g.status === 'blocked' ? 'st-blocked' : g.status === 'active' ? 'st-background' : '';
    const notesHtml = (g.notes || []).slice(0, 3).map((n) => `<div style="font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:4px">[${fmtTime(n.at)} · ${esc(n.by)}] ${esc(n.text)}</div>`).join('');
    const staggerCls = state.viewEntryAnim ? ' ops-stagger-item' : '';
    const staggerSty = state.viewEntryAnim ? ` style="--card-i:${Math.min(idx, 10)}"` : '';
    return `<div class="op-card ${g.status === 'active' ? 'running' : ''}${staggerCls}"${staggerSty}>
      <div class="op-top">
        <span class="op-code">${esc(g.title)}</span>
        <span class="u-chip ${stClass}">${esc(g.status)}</span>
      </div>
      <div class="u-meta">
        <span class="u-chip">WORKER: ${esc(g.workerRef || 'UNSET')}</span>
        <span class="u-chip st-background">SUPERVISOR: ${esc(g.supervisorRef || 'UNSET')}</span>
        ${g.checkEveryMinutes > 0 ? `<span class="u-chip">CHECK / ${g.checkEveryMinutes}m</span>` : ''}
      </div>
      ${g.objective ? `<div class="op-desc">${esc(g.objective)}</div>` : ''}
      ${g.criteria ? `<div style="margin-top:6px;font-family:var(--mono);font-size:11px;color:var(--amber)">CRITERIA: ${esc(g.criteria)}</div>` : ''}
      <div class="meter-wrap">
        <div class="meter-head"><span>PROGRESS</span><span>${g.progress}%</span></div>
        <div class="meter-track"><div class="meter-fill ${g.progress >= 100 ? 'green' : ''}" style="width:${g.progress}%"></div></div>
      </div>
      ${notesHtml}
      <div class="op-foot">
        <div style="display:flex;gap:5px;flex-wrap:wrap">
          <button class="btn xs cyan" data-gsup="${esc(g.id)}">SUPERVISE CHECK →</button>
          <button class="btn xs ghost" data-gnote="${esc(g.id)}">+ NOTE</button>
          <button class="btn xs green" data-gprog="${esc(g.id)}" data-cur="${g.progress}">PROGRESS</button>
          <button class="btn xs amber" data-gstat="${esc(g.id)}" data-next="${g.status === 'achieved' ? 'active' : 'achieved'}">${g.status === 'achieved' ? 'REOPEN' : 'ACHIEVE'}</button>
          <button class="btn xs danger" data-gdel="${esc(g.id)}">DEL</button>
        </div>
      </div>
    </div>`;
  }).join('');
  wrap.querySelectorAll('[data-gsup]').forEach((b) => {
    b.onclick = async () => { try { const r = await api(`/api/goals/${b.dataset.gsup}/supervise`, { method: 'POST' }); alert(`已向监督会话 ${r.supervisor} 下发巡检指令`); } catch (e) { alert(e.message); } };
  });
  wrap.querySelectorAll('[data-gnote]').forEach((b) => {
    b.onclick = () => { const note = prompt('添加检查点备注：'); if (note) api(`/api/goals/${b.dataset.gnote}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }) }); };
  });
  wrap.querySelectorAll('[data-gprog]').forEach((b) => {
    b.onclick = () => { const p = prompt('输入进度百分比 (0-100)：', b.dataset.cur); if (p !== null && !Number.isNaN(Number(p))) api(`/api/goals/${b.dataset.gprog}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ progress: Number(p) }) }); };
  });
  wrap.querySelectorAll('[data-gstat]').forEach((b) => {
    b.onclick = () => api(`/api/goals/${b.dataset.gstat}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: b.dataset.next, ...(b.dataset.next === 'achieved' ? { progress: 100 } : {}) }) });
  });
  wrap.querySelectorAll('[data-gdel]').forEach((b) => {
    b.onclick = () => { if (confirm('删除这个长期目标？')) api(`/api/goals/${b.dataset.gdel}`, { method: 'DELETE' }); };
  });
}

// ---- 04 // GPU REGISTER VIEW (3 Clusters: 本机器 / 共绩集群 / 火山集群) ----
function renderLeaseTable(el, leases, emptyMsg) {
  if (!leases?.length) {
    el.innerHTML = emptyMsg ? `<div class="empty" style="padding:18px 14px">${emptyMsg}</div>` : '';
    return;
  }
  el.innerHTML = `<div class="table-scroll"><table class="lease-table">
    <thead><tr><th>ID / JOB</th><th>HOST / SPEC</th><th>GPUS</th><th>SESSION</th><th>TASK</th><th>STATUS</th><th>TTL</th><th>ACTION</th></tr></thead>
    <tbody>${leases.map((l) => {
      const rem = l.expiresAt ? (l.expired ? 'EXPIRED' : `${Math.max(0, Math.round((l.expiresAt - Date.now()) / 60000))}m`) : '∞';
      return `<tr>
        <td>${esc(l.jobId || l.id)}</td>
        <td>${esc(l.host)}${l.model ? ` · ${esc(l.model)}` : ''}</td>
        <td><span class="u-chip st-background">${esc(l.gpus.join(','))}</span></td>
        <td>${esc(l.session || '-')}</td>
        <td>${esc(l.task)}${l.memoryGb ? ` · ${l.memoryGb}GB` : ''}${l.note ? ` (${esc(l.note)})` : ''}</td>
        <td><span class="u-chip ${l.expired ? 'st-error' : 'st-working'}">${l.expired ? 'EXPIRED' : esc(l.status)}</span></td>
        <td>${rem}</td>
        <td><button class="btn xs danger" data-gpurel="${esc(l.id)}">RELEASE</button></td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
  el.querySelectorAll('[data-gpurel]').forEach((b) => {
    b.onclick = () => api('/api/gpu/release', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.dataset.gpurel }) });
  });
}

function renderGpu() {
  const g = state.gpu || { localGpus: [], gongjiJobs: [], leases: [], clusters: {}, summary: {} };
  const sum = g.summary || {};
  const cl = g.clusters || {};
  const localLeases = cl.local?.leases || (g.leases || []).filter((l) => (l.cluster || 'local') === 'local');
  const gongjiLeases = cl.gongji?.leases || (g.leases || []).filter((l) => l.cluster === 'gongji');
  const volcLeases = cl.volc?.leases || (g.leases || []).filter((l) => l.cluster === 'volc');
  const gongjiLive = g.gongjiJobs || cl.gongji?.liveJobs || [];

  const kpiCls = state.viewEntryAnim ? 'kpi-box ops-stagger-item' : 'kpi-box';
  $('gpuKpis').innerHTML = `
    <div class="${kpiCls}" style="--card-i:0"><div class="kpi-val" style="color:var(--green)">${pad2(sum.localBusy || 0)}/${pad2(sum.localCount || 0)}</div><div class="kpi-lbl">01 本机器 BUSY/TOTAL</div></div>
    <div class="${kpiCls}" style="--card-i:1"><div class="kpi-val" style="color:var(--cyan)">${pad2(sum.gongjiOwn || 0)} (${pad2(sum.gongjiTotal || 0)})</div><div class="kpi-lbl">02 共绩集群 OUR (TEAM)</div></div>
    <div class="${kpiCls}" style="--card-i:2"><div class="kpi-val" style="color:var(--amber)">${pad2(sum.volcGpus || 0)} GPU</div><div class="kpi-lbl">03 火山集群 (${sum.volcLeases || 0} JOBS)</div></div>
    <div class="${kpiCls}" style="--card-i:3"><div class="kpi-val">${pad2(sum.activeLeases || 0)}</div><div class="kpi-lbl">ALL REGISTERED LEASES</div></div>`;

  const f = state.gpuClusterFilter || 'all';
  $('gpuClusterLocal').style.display = (f === 'all' || f === 'local') ? 'flex' : 'none';
  $('gpuClusterGongji').style.display = (f === 'all' || f === 'gongji') ? 'flex' : 'none';
  $('gpuClusterVolc').style.display = (f === 'all' || f === 'volc') ? 'flex' : 'none';
  $('gpuClusterTabs').querySelectorAll('[data-cluster]').forEach((b) => b.classList.toggle('active', b.dataset.cluster === f));
  syncSubtabGlider($('gpuClusterTabs'));

  // 01 // 本机器
  $('gpuLocalMeta').textContent = `${g.hostName || 'LOCAL'} · ${g.localGpus?.length || 0} CARDS · ${localLeases.length} LEASES`;
  const localWrap = $('gpuLocalList');
  if (!g.localGpus?.length) {
    localWrap.innerHTML = '<div class="empty" style="padding:18px 14px"><strong>NO LOCAL NVIDIA GPU DETECTED</strong>本机无可用 nvidia-smi 显卡</div>';
  } else {
    localWrap.innerHTML = g.localGpus.map((card) => {
      const memPct = card.memoryTotalMb ? Math.round((card.memoryUsedMb / card.memoryTotalMb) * 100) : 0;
      const utilCls = card.utilization >= 85 ? 'amber' : 'green';
      const memCls = memPct >= 85 ? 'red' : '';
      const procs = (card.processes || []).map((p) =>
        `<span class="u-chip ${p.session ? 'st-background' : ''}">PID ${p.pid} ${esc(p.processName)} (${p.usedMemoryMb}MiB${p.session ? ` · ${esc(p.session)}` : ''})</span>`).join('');
      return `<div class="op-card ${card.utilization >= 10 ? 'running' : ''}">
        <div class="op-top">
          <span class="op-code">GPU ${card.index} // ${esc(card.name)}</span>
          <span class="u-chip ${card.temperatureC >= 80 ? 'st-error' : 'st-working'}">${card.temperatureC}°C · ${Math.round(card.powerW)}W</span>
        </div>
        <div class="meter-wrap">
          <div class="meter-head"><span>COMPUTE UTIL</span><span>${card.utilization}%</span></div>
          <div class="meter-track"><div class="meter-fill ${utilCls}" style="width:${card.utilization}%"></div></div>
        </div>
        <div class="meter-wrap">
          <div class="meter-head"><span>VRAM</span><span>${(card.memoryUsedMb / 1024).toFixed(1)} / ${(card.memoryTotalMb / 1024).toFixed(1)} GiB (${memPct}%)</span></div>
          <div class="meter-track"><div class="meter-fill ${memCls}" style="width:${memPct}%"></div></div>
        </div>
        <div class="u-meta" style="margin-top:10px">${procs || '<span class="u-chip">NO ACTIVE COMPUTE PID</span>'}</div>
      </div>`;
    }).join('');
  }
  renderLeaseTable($('gpuLocalLeases'), localLeases, '');

  // 02 // 共绩集群
  $('gpuGongjiMeta').textContent = g.gongjiError
    ? `SYNC ERR: ${g.gongjiError}`
    : `LIVE ${gongjiLive.length} JOBS (${sum.gongjiOwn || 0} OUR) · ${gongjiLeases.length} REGISTERED · SYNC ${fmtTime(g.gongjiPolledAt)}`;
  const gjWrap = $('gpuGongjiLive');
  if (!gongjiLive.length) {
    gjWrap.innerHTML = '<div class="empty" style="padding:18px 14px"><strong>NO ACTIVE GONGJI LIVE JOBS</strong>当前共绩集群无 Pending/Running 任务</div>';
  } else {
    gjWrap.innerHTML = gongjiLive.map((j) => {
      const stCls = j.status === 'Running' ? 'st-working' : 'st-blocked';
      return `<div class="op-card ${j.own ? 'running' : ''}">
        <div class="op-top">
          <span class="op-code">#${esc(j.taskId)} // ${esc(j.name)}</span>
          <span class="u-chip ${j.own ? 'st-background' : ''}">${j.own ? 'OUR' : 'TEAM'}</span>
        </div>
        <div class="u-meta">
          <span class="u-chip ${stCls}">${esc(j.status)}${j.jobStatus && j.jobStatus !== j.status ? ` / ${esc(j.jobStatus)}` : ''}</span>
          <span class="u-chip">${esc(j.subType)}</span>
          <span class="u-chip">${esc(j.gpuCount)}× ${esc(j.model)}${j.region ? ` @ ${esc(j.region)}` : ''}</span>
          <span class="u-chip">¥${Number(j.costYuan || 0).toFixed(2)}</span>
        </div>
        <div class="op-foot"><span>CREATED ${esc(j.createTime || '-')}</span><span>SUANLI.CN LIVE</span></div>
      </div>`;
    }).join('');
  }
  renderLeaseTable($('gpuGongjiLeases'), gongjiLeases, '');

  // 03 // 火山集群
  $('gpuVolcMeta').textContent = `${volcLeases.length} REGISTERED LEASES · ${sum.volcGpus || 0} ACTIVE GPUS`;
  renderLeaseTable($('gpuVolcLeases'), volcLeases, '<strong>NO REGISTERED VOLCANO MLP JOBS</strong>提交火山 MLP 任务后通过 <code>fmuxctl gpu register --cluster volc --gpus 8 --job-id &lt;id&gt; --task "..."</code> 登记');
}

// ---- Actions & Dialog Wiring ----
function fillSessionSelect(el, allowEmpty = true) {
  const opts = state.sessions.map((s) => `<option value="${esc(s.name)}">${esc(s.name)} (${esc((KIND_LABEL[s.kind] || s.kind).toUpperCase())})</option>`).join('');
  el.innerHTML = (allowEmpty ? '<option value="">（未指定）</option>' : '') + opts;
}

async function sendKeys(keys) {
  const s = selectedSession();
  if (!s) return;
  await api(`/api/session/${encodeURIComponent(s.key)}/keys`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys }) });
  setTimeout(renderWorkspace, 350);
}

async function stopSession() {
  const s = selectedSession();
  if (!s) return;
  if (state.pendingSend?.key === s.key) state.pendingSend = null;
  state.stoppedKeys.set(s.key, state.lastTurnCount.get(s.key) ?? 0);
  s.stoppedAt = Date.now();
  if (s.status === 'working') s.status = s.runningTasks > 0 ? 'background' : 'idle';
  state.stopNotice = { key: s.key, at: Date.now(), keyHint: s.kind === 'shell' ? 'Ctrl+C' : 'ESC' };
  state.boostPollUntil = Date.now() + 10000;
  state.lastChatSig = '';
  renderSessions();
  renderWorkspace({ forceScroll: true });
  try {
    await api(`/api/session/${encodeURIComponent(s.key)}/stop`, { method: 'POST' });
    setTimeout(() => renderWorkspace(), 450);
    setTimeout(() => { state.lastChatSig = ''; renderWorkspace(); }, 4100);
  } catch (err) {
    alert(err.message);
  }
}

document.querySelectorAll('#wsSubtabs .subtab').forEach((b) => {
  b.onclick = () => {
    const nextTab = b.dataset.tab;
    if (state.tab === nextTab) return;
    const prevTab = state.tab;
    state.tab = nextTab;
    state.lastChatSig = '';
    document.querySelectorAll('#wsSubtabs .subtab').forEach((x) => x.classList.toggle('active', x === b));
    syncSubtabGlider($('wsSubtabs'));
    renderWorkspace({ forceScroll: true });
    const dir = (SUBTAB_ORDER[nextTab] ?? 0) >= (SUBTAB_ORDER[prevTab] ?? 0) ? 'anim-tab-right' : 'anim-tab-left';
    triggerAnim($('panel'), dir, 240);
    flashPanelScan();
  };
});
$('escBtn').onclick = () => sendKeys(['esc']);
$('stopBtn').onclick = () => { if (!$('stopBtn').disabled) stopSession(); };

function openRenameDialog() {
  const s = selectedSession();
  if (!s) return;
  $('rnTmux').value = s.tmuxSession || s.name || '';
  const canAgentRename = ['agy', 'dsh', 'claude', 'codex'].includes(s.kind);
  $('rnAgentWrap').style.display = canAgentRename ? '' : 'none';
  $('rnTitle').value = canAgentRename ? (s.title || '') : '';
  $('rnTitle').disabled = s.status === 'working';
  $('rnSyncBtn').disabled = s.status === 'working';
  $('rnBusyHint').style.display = (canAgentRename && s.status === 'working') ? '' : 'none';
  $('renameDialog').showModal();
  setTimeout(() => { $('rnTmux').focus(); $('rnTmux').select(); }, 30);
}
$('renameBtn').onclick = () => openRenameDialog();
$('wsTitle').style.cursor = 'pointer';
$('wsTitle').title = '点击重命名 tmux 会话与内部对话标题';
$('wsTitle').onclick = () => openRenameDialog();
$('rnSyncBtn').onclick = () => { $('rnTitle').value = $('rnTmux').value.trim(); };
$('renameForm').onsubmit = async (e) => {
  e.preventDefault();
  const s = selectedSession();
  if (!s) return;
  const tmuxName = $('rnTmux').value.trim();
  const canAgentRename = ['agy', 'dsh', 'claude', 'codex'].includes(s.kind) && s.status !== 'working';
  const rawTitle = canAgentRename ? $('rnTitle').value.trim() : '';
  const curTmux = s.tmuxSession || s.name;
  const sendTmux = tmuxName && tmuxName !== curTmux ? tmuxName : '';
  const sendTitle = rawTitle && rawTitle !== (s.title || '') ? rawTitle : '';
  if (!sendTmux && !sendTitle) {
    $('renameDialog').close();
    return;
  }
  $('rnSubmitBtn').disabled = true;
  $('rnSubmitBtn').textContent = 'SAVING...';
  try {
    const res = await api(`/api/session/${encodeURIComponent(s.key)}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tmuxName: sendTmux, sessionTitle: sendTitle }),
    });
    if (res.name) s.name = res.name;
    if (res.tmuxSession) s.tmuxSession = res.tmuxSession;
    if (res.title !== undefined) s.title = res.title;
    $('renameDialog').close();
    if (res.warning) alert(res.warning);
    renderSessions();
    renderWorkspace();
  } catch (err) {
    alert(err.message);
  } finally {
    $('rnSubmitBtn').disabled = false;
    $('rnSubmitBtn').textContent = 'SAVE RENAME';
  }
};
$('modelPickBtn').onclick = () => openModelDialog(false);
$('wsModel').style.cursor = 'pointer';
$('wsModel').title = '点击切换模型与思考强度';
$('wsModel').onclick = () => openModelDialog(false);
$('refreshModelsBtn').onclick = () => openModelDialog(true);
$('effortGroup').onclick = (e) => {
  const btn = e.target.closest('.eff-btn');
  if (!btn || btn.disabled) return;
  const s = selectedSession();
  if (!s) return;
  const eff = btn.dataset.eff;
  const agyFam = s.kind === 'agy' ? resolveCurrentAgyFamily(s) : null;
  const variantId = agyFam?.variants.get(eff) || '';
  if (variantId) applyModelSwitch({ model: variantId, label: `${agyFam.family} · ${eff}` });
  else applyModelSwitch({ effort: eff, label: `EFFORT · ${eff.toUpperCase()}` });
};
$('customModelForm').onsubmit = async (e) => {
  e.preventDefault();
  const model = $('customModelInput').value.trim();
  const effort = $('customEffortSelect').value;
  if (!model && !effort) return;
  $('customModelInput').value = '';
  $('modelDialog').close();
  await applyModelSwitch({ model, effort, label: [model, effort].filter(Boolean).join(' · ') });
};
function openKillDialog() {
  const s = selectedSession();
  if (!s || state.killingKeys.has(s.key)) return;
  state.killTargetKey = s.key;
  const fixedId = s.unitId ? `${pad2(s.unitId)} // ` : '';
  $('killTargetName').textContent = `${fixedId}${s.name}`;
  $('killTargetKind').textContent = KIND_LABEL[s.kind] || s.kind;
  $('killTargetKind').className = 'u-chip';
  $('killTargetStatus').textContent = STATUS_LABEL[s.status] || s.status;
  $('killTargetStatus').className = `u-chip st-${s.status}`;
  $('killTargetSub').textContent = [s.cwd, s.title].filter(Boolean).join('  //  ') || `PANE ${s.key}`;
  const isBusy = s.status === 'working' || (s.runningTasks || 0) > 0;
  $('killBusyWarn').style.display = isBusy ? '' : 'none';
  $('killDialog').showModal();
  setTimeout(() => $('confirmKillBtn')?.focus(), 30);
}

async function executeKillSession(s) {
  if (!s || state.killingKeys.has(s.key)) return;
  const orderedBefore = orderedSessions().filter((x) => !state.killingKeys.has(x.key));
  const killedIdx = orderedBefore.findIndex((x) => x.key === s.key);
  const neighbor = orderedBefore[killedIdx + 1] || orderedBefore[killedIdx - 1] || null;
  const wasSelected = state.selectedKey === s.key;

  state.killingKeys.add(s.key);
  const card = $('sessionList')?.querySelector(`.unit-card[data-key="${CSS.escape(s.key)}"]`);
  if (card) {
    if (window.innerWidth <= 920) card.style.maxWidth = `${card.offsetWidth}px`;
    else card.style.maxHeight = `${card.offsetHeight}px`;
    const stEl = card.querySelector('.u-st');
    if (stEl) stEl.textContent = 'OFFLINE';
    void card.offsetWidth;
    card.classList.add('killing');
  }

  const wsEl = $('workspaceEl');
  const fxEl = $('killFxOverlay');
  if (wasSelected && state.mode === 'sessions') {
    const fixedId = s.unitId ? `${pad2(s.unitId)} // ` : '';
    $('killFxSub').textContent = `${fixedId}${s.name} · TMUX SESSION TERMINATED`;
    wsEl?.classList.add('ws-killing');
    fxEl?.classList.add('active');
  }

  try {
    await Promise.all([
      api(`/api/session/${encodeURIComponent(s.key)}/kill`, { method: 'POST' }),
      sleepMs(430),
    ]);
    state.killingKeys.delete(s.key);
    state.knownUnitKeys.delete(s.key);
    state.sessionCache.delete(s.key);
    state.optimisticQueue.delete(s.key);
    state.sessions = state.sessions.filter((x) => x.key !== s.key);
    if (card?.isConnected) card.remove();
    wsEl?.classList.remove('ws-killing');
    fxEl?.classList.remove('active');

    if (wasSelected) {
      const nextSel = neighbor && state.sessions.some((x) => x.key === neighbor.key)
        ? neighbor.key
        : (orderedSessions()[0]?.key || null);
      state.selectedKey = nextSel;
      state.lastChatSig = '';
      renderSessions();
      await renderWorkspace({ forceScroll: true });
      if (nextSel) {
        triggerAnim($('panel'), 'anim-unit-up', 250);
        triggerAnim(document.querySelector('.ws-identity'), 'anim-id', 250);
        flashPanelScan();
      }
    } else {
      renderSessions();
    }
  } catch (err) {
    state.killingKeys.delete(s.key);
    if (card) {
      card.classList.remove('killing');
      card.style.maxHeight = '';
      card.style.maxWidth = '';
    }
    wsEl?.classList.remove('ws-killing');
    fxEl?.classList.remove('active');
    renderSessions();
    alert(err.message);
  }
}

$('killBtn').onclick = () => openKillDialog();
$('killForm').onsubmit = async (e) => {
  e.preventDefault();
  const target = state.sessions.find((x) => x.key === state.killTargetKey) || selectedSession();
  $('killDialog').close();
  if (target) await executeKillSession(target);
};
$('logoutBtn').onclick = async () => { await fetch('/auth/logout', { method: 'POST' }); location.reload(); };

$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const s = selectedSession();
  const text = $('input').value.trim();
  if (!s || !text) return;
  $('input').value = '';
  $('input').style.height = '';
  state.stoppedKeys.delete(s.key);
  state.stopNotice = null;
  s.stoppedAt = 0;

  // Instant 0ms optimistic Candidate Queue entry until server /send responds
  const optId = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const willWait = s.status === 'working' || s.status === 'blocked' || getEffectiveQueue(s).some((x) => x.state === 'queued');
  const optList = state.optimisticQueue.get(s.key) || [];
  optList.push({ id: optId, text, state: willWait ? 'queued' : 'injected', createdAt: Date.now(), injectedAt: willWait ? 0 : Date.now() });
  state.optimisticQueue.set(s.key, optList);

  renderSessions();
  renderQueueTray(s);
  syncStopButton(s);
  if (!willWait && state.tab === 'chat') {
    const c = getSessionCache(s.key);
    if (c.turns) paintChat(s, c.turns, c.dialog, { forceScroll: true });
  }

  try {
    const res = await api(`/api/session/${encodeURIComponent(s.key)}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const rem = (state.optimisticQueue.get(s.key) || []).filter((x) => x.id !== optId);
    if (rem.length) state.optimisticQueue.set(s.key, rem);
    else state.optimisticQueue.delete(s.key);
    if (Array.isArray(res.pendingQueue)) {
      s.pendingQueue = res.pendingQueue;
      s.queuePaused = Boolean(res.queuePaused);
    }
    state.boostPollUntil = Date.now() + 60000;
    renderSessions();
    const cur = selectedSession();
    renderQueueTray(cur);
    syncStopButton(cur);
    if (cur && cur.key === s.key && state.tab === 'chat') {
      const c = getSessionCache(cur.key);
      if (c.turns) paintChat(cur, c.turns, c.dialog, { forceScroll: !res.queued });
    }
    setTimeout(() => renderWorkspace({ forceScroll: !res.queued }), 650);
  } catch (err) {
    const rem = (state.optimisticQueue.get(s.key) || []).filter((x) => x.id !== optId);
    if (rem.length) state.optimisticQueue.set(s.key, rem);
    else state.optimisticQueue.delete(s.key);
    renderSessions();
    const cur = selectedSession();
    renderQueueTray(cur);
    syncStopButton(cur);
    if (cur && cur.key === s.key && state.tab === 'chat') {
      const c = getSessionCache(cur.key);
      if (c.turns) paintChat(cur, c.turns, c.dialog);
    }
    alert(err.message);
  }
};
$('input').addEventListener('input', () => {
  const el = $('input');
  el.style.height = 'auto';
  el.style.height = `${Math.min(130, el.scrollHeight)}px`;
});
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('input').value && !$('stopBtn').disabled) { e.preventDefault(); stopSession(); }
});

$('newBtn').onclick = async () => {
  const agentList = state.agents.length ? state.agents : ['agy', 'dsh', 'claude', 'codex', 'pi', 'shell'];
  $('fAgent').innerHTML = agentList.map((a) => `<option value="${esc(a)}">${esc((KIND_LABEL[a] || a).toUpperCase())}</option>`).join('');
  try {
    const { conversations } = await api('/api/history');
    $('fResume').innerHTML = '<option value="new">NEW SESSION // 新建全权限会话</option><option value="last">CONTINUE LAST // 继续目录最近对话</option>'
      + conversations.map((c) => `<option value="${esc(c.agent)}:${esc(c.id)}">${esc(c.agent.toUpperCase())} · ${esc(c.title.slice(0, 38))}</option>`).join('');
  } catch {}
  $('newDialog').showModal();
};
$('newForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const created = await api('/api/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resume: $('fResume').value, agent: $('fAgent').value, cwd: $('fCwd').value.trim() || '~', name: $('fName').value.trim(), prompt: $('fPrompt').value.trim(), yolo: true, attach: false }),
    });
    state.selectedKey = created.key;
    state.lastChatSig = '';
    setMode('sessions');
    $('newDialog').close();
    renderWorkspace({ forceScroll: true });
  } catch (err) { alert(err.message); }
};

$('hbKind').onchange = () => {
  const isCron = $('hbKind').value === 'cron';
  $('hbEveryWrap').style.display = isCron ? 'none' : '';
  $('hbCronWrap').style.display = isCron ? '' : 'none';
};
$('hbTargetMode').onchange = () => {
  const isSpawn = $('hbTargetMode').value === 'spawn';
  $('hbRefWrap').style.display = isSpawn ? 'none' : '';
  $('hbAgentWrap').style.display = isSpawn ? '' : 'none';
  $('hbCwdWrap').style.display = isSpawn ? '' : 'none';
};
$('addHbBtn').onclick = () => { fillSessionSelect($('hbRef'), true); $('hbDialog').showModal(); };
$('hbForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('/api/heartbeats', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $('hbName').value.trim(),
        scheduleKind: $('hbKind').value,
        everyMinutes: Number($('hbEvery').value),
        cron: $('hbCron').value.trim(),
        targetMode: $('hbTargetMode').value,
        targetRef: $('hbRef').value,
        agent: $('hbAgent').value,
        cwd: $('hbCwd').value.trim() || '~',
        prompt: $('hbPrompt').value.trim(),
      }),
    });
    $('hbForm').reset();
    $('hbDialog').close();
  } catch (err) { alert(err.message); }
};

$('addGoalBtn').onclick = () => { fillSessionSelect($('gWorker'), true); fillSessionSelect($('gSuper'), true); $('goalDialog').showModal(); };
$('goalForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('/api/goals', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: $('gTitle').value.trim(),
        objective: $('gObj').value.trim(),
        criteria: $('gCrit').value.trim(),
        workerRef: $('gWorker').value,
        supervisorRef: $('gSuper').value,
        checkEveryMinutes: Number($('gEvery').value || 0),
      }),
    });
    $('goalForm').reset();
    $('goalDialog').close();
  } catch (err) { alert(err.message); }
};

$('pollGpuBtn').onclick = () => api('/api/gpu/poll', { method: 'POST' });
$('gpuClusterTabs').querySelectorAll('[data-cluster]').forEach((b) => {
  b.onclick = () => {
    const next = b.dataset.cluster;
    if (state.gpuClusterFilter === next) return;
    const prev = state.gpuClusterFilter;
    state.gpuClusterFilter = next;
    renderGpu();
    const dir = (CLUSTER_ORDER[next] ?? 0) >= (CLUSTER_ORDER[prev] ?? 0) ? 'anim-tab-right' : 'anim-tab-left';
    ['gpuClusterLocal', 'gpuClusterGongji', 'gpuClusterVolc'].forEach((id) => {
      const el = $(id);
      if (el && el.style.display !== 'none') triggerAnim(el, dir, 230);
    });
  };
});
$('gpuCluster').onchange = () => {
  const c = $('gpuCluster').value;
  $('gpuHost').value = c === 'gongji' ? 'tj1q' : c === 'volc' ? 'cn-beijing' : 'local';
  $('gpuIds').value = c === 'local' ? '0' : '1';
};
$('copyGpuCli').onclick = () => {
  navigator.clipboard?.writeText('fmuxctl gpu register --cluster local --gpus 0 --session <session> --task "<task>"');
  $('copyGpuCli').textContent = 'COPIED';
  setTimeout(() => { $('copyGpuCli').textContent = 'COPY CLI'; }, 1200);
};
$('addGpuBtn').onclick = () => { fillSessionSelect($('gpuSess'), true); $('gpuDialog').showModal(); };
$('gpuForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('/api/gpu/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cluster: $('gpuCluster').value,
        jobId: $('gpuJobId').value.trim(),
        host: $('gpuHost').value.trim(),
        gpus: $('gpuIds').value.trim(),
        session: $('gpuSess').value,
        model: $('gpuModel').value.trim(),
        task: $('gpuTask').value.trim(),
        memoryGb: $('gpuMem').value ? Number($('gpuMem').value) : null,
        ttlMinutes: Number($('gpuTtl').value || 0),
      }),
    });
    $('gpuForm').reset();
    $('gpuDialog').close();
  } catch (err) { alert(err.message); }
};

function connectSSE() {
  const es = new EventSource('/api/events');
  es.onopen = () => { $('sseDot').classList.add('ok'); $('linkText').textContent = 'ONLINE'; };
  es.onerror = () => { $('sseDot').classList.remove('ok'); $('linkText').textContent = 'RECONNECTING'; };
  es.addEventListener('state', (e) => {
    const data = JSON.parse(e.data);
    state.sessions = data.sessions || [];
    state.status = data.status || null;
    state.agents = data.agents || [];
    if (data.ops) state.ops = data.ops;
    if (data.gpu) state.gpu = data.gpu;
    if (data.user) state.user = data.user;
    if (data.authMode) state.authMode = data.authMode;
    if (data.wallpaperVersion !== undefined && data.wallpaperVersion !== state.wp.version) {
      applyWallpaper(data.wallpaperVersion);
    }
    renderSessions();
    if (state.mode === 'sessions') renderWorkspace();
    else if (state.mode === 'heartbeat') renderHeartbeats();
    else if (state.mode === 'goals') renderGoals();
    else if (state.mode === 'gpu') renderGpu();
    noteBootSseReady();
  });
}

setInterval(() => {
  if (state.mode === 'sessions') {
    if (Date.now() - state.lastWsFetchAt < 1800) return;
    const s = selectedSession();
    if (!s) return;
    if (state.tab === 'term' || (state.tab === 'tasks' && s.runningTasks > 0)) renderWorkspace();
    else if (state.tab === 'chat') renderWorkspace();
  }
}, 2500);

const { applyWallpaper } = window.initWallpaperControls({ state, $, LS, api });
connectSSE();
