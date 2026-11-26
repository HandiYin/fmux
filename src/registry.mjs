import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasAgyActiveDb, inferEffortFromModel, parseAgyFooter, readAgyConversationTitle } from './agy.mjs';
import { applyTaskEvent, convIdFromTranscript, runningTasks, seedTasksFromTranscript, taskNote } from './agy-tasks.mjs';
import { CodexBindingStore } from './codex-bindings.mjs';
import { pick } from './match.mjs';
import { findAgent, snapshot } from './procs.mjs';
import { findDialog, looksWorking } from './screen.mjs';
import { HUB_SESSION } from './service.mjs';
import * as realTmux from './tmux.mjs';
import { Tail, adapters, lastExchange, lastTurns, locateTranscript, readClaudeMeta } from './transcript.mjs';
import { log } from './util.mjs';

const SHELLS = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'pwsh', 'powershell', 'cmd', 'nu']);
// psmux keeps a spare server under this name to start sessions fast. It is not a session of the user.
const INTERNAL_SESSION = /^__warm/;
const CLAUDE_STATUS = { busy: 'working', idle: 'idle', shell: 'idle', waiting: 'blocked' };
const MAX_TURN_TEXTS = 60;

function cleanTitle(title, sessionName) {
  const t = String(title || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
  return !t || t === os.hostname() || t === sessionName ? '' : t;
}

function newTurn(session) {
  return { startedAt: Date.now(), texts: [], tools: 0, lastTool: null, prompt: session.lastPrompt || null };
}

function paneNum(paneId) {
  const m = String(paneId || '').match(/^%(\d+)$/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

// Watches every tmux pane and emits:
//   added(session) / removed(session)
//   status(session, previous)      status changed (debounced)
//   output(session, events)        new transcript events
//   blocked(session)               a dialog is waiting for a choice
//   turn_end(session, turn)        the agent handed control back
//   changed()                      something the dashboard shows is different
export class Registry extends EventEmitter {
  // `probe` is how the registry looks at processes and transcripts; tests replace it.
  // `store` keeps the last confirmed Codex transcript per pane across hub restarts.
  constructor({ tmux = realTmux, intervalMs = 2000, hide = [], probe = {}, store = null } = {}) {
    super();
    this.tmux = tmux;
    this.probe = { snapshot, findAgent, readClaudeMeta, locateTranscript, hasAgyActiveDb, ...probe };
    this.intervalMs = intervalMs;
    this.hide = new Set([...hide, HUB_SESSION]);
    this.codexBindings = new CodexBindingStore(store);
    this.store = store;
    const savedIds = store?.get?.('unitIds') || {};
    this.unitIds = new Map(Object.entries(savedIds).map(([k, v]) => [k, Number(v)]).filter(([, v]) => Number.isFinite(v) && v > 0));
    this.nextUnitId = Math.max(0, ...this.unitIds.values()) + 1;
    this.sessions = new Map();
    this.localActiveAt = 0;
    this.polls = 0;
    this.signature = '';
    this.timer = null;
  }

  start() {
    const tick = async () => {
      try {
        await this.poll();
      } catch (err) {
        log('error', 'registry.poll', { message: err.message });
      }
      if (this.timer !== false) this.timer = setTimeout(tick, this.intervalMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = false;
  }

  list() {
    return [...this.sessions.values()].sort((a, b) =>
      a.tmuxSession.localeCompare(b.tmuxSession) || a.windowIndex - b.windowIndex || a.paneIndex - b.paneIndex);
  }

  // Fixed creation-order list for WebMUX: ordered by immutable unitId / tmux paneId so sessions
  // never float up or change their left-hand ID when tasks start, finish, or close.
  listStable() {
    return [...this.sessions.values()].sort((a, b) =>
      (a.unitId || 0) - (b.unitId || 0) || paneNum(a.key) - paneNum(b.key));
  }

  markStopped(s) {
    if (!s) return;
    s.stoppedAt = Date.now();
    s.sentAt = 0;
    s.turn = null;
    s.lastActivityAt = 0;
    s.pending = null;
    s.pendingAt = 0;
    if (s.status === 'working') {
      const next = runningTasks(s).length > 0 ? 'background' : 'idle';
      this.commit(s, next);
      this.emit('changed');
    }
  }

  // A dashboard number, a pane id, or a loose name: part of the tmux name, of the agent's
  // title, of the directory, or the kind of agent. Returns { match, candidates }.
  lookup(ref) {
    const text = String(ref ?? '').trim();
    const list = this.list();
    if (!text) return { match: null, candidates: [] };
    if (/^\d+$/.test(text)) return { match: list[Number(text) - 1] || null, candidates: [] };
    const exact = list.find((s) => s.key === text || s.name === text);
    if (exact) return { match: exact, candidates: [] };
    return pick(text, list, (s) => [[s.name, 1], [s.title, 0.9], [path.basename(s.cwd || ''), 0.5], [s.kind, 0.4]]);
  }

  resolve(ref) {
    return this.lookup(ref).match;
  }

  // Polls never overlap: a caller that needs fresh state right now queues behind the running one.
  poll() {
    this.chain = (this.chain || Promise.resolve()).catch(() => {}).then(() => this.pollOnce());
    return this.chain;
  }

  async pollOnce() {
    this.polls++;
    const panes = await this.tmux.listPanes();
    this.localActiveAt = await this.tmux.lastClientActivity();
    const snap = await this.probe.snapshot();
    const seen = new Set();
    const visible = panes
      .filter((p) => !this.hide.has(p.sessionName) && !INTERNAL_SESSION.test(p.sessionName))
      .sort((a, b) => paneNum(a.paneId) - paneNum(b.paneId));
    // Rebase unitIds cleanly to 1..N only when none of the saved paneIds are alive anymore (e.g. fresh tmux server).
    if (visible.length && !visible.some((p) => this.unitIds.has(p.paneId))) {
      this.unitIds.clear();
      this.nextUnitId = 1;
    }
    let idsChanged = false;
    for (const pane of visible) {
      if (!this.unitIds.has(pane.paneId)) {
        this.unitIds.set(pane.paneId, this.nextUnitId++);
        idsChanged = true;
      }
    }
    if (idsChanged && this.store?.set) {
      // Keep bounded map of recent paneIds so state.json stays tiny.
      const entries = [...this.unitIds.entries()].slice(-128);
      this.store.set('unitIds', Object.fromEntries(entries));
    }
    for (const pane of visible) {
      seen.add(pane.paneId);
      let session = this.sessions.get(pane.paneId);
      const isNew = !session;
      if (isNew) {
        session = {
          key: pane.paneId, unitId: this.unitIds.get(pane.paneId), kind: null, agentPid: null, status: null, statusSince: Date.now(),
          note: '', dialog: null, lastText: '', lastPrompt: '', turn: null, transcript: null,
          tail: null, pending: null, pendingAt: 0, bindingLostAt: 0, agentSeenAt: 0, firstSeenAt: Date.now(),
          stoppedAt: 0, sentAt: 0, model: '', modelFamily: '', effort: '', tasks: new Map(),
        };
        this.sessions.set(pane.paneId, session);
      } else {
        session.unitId = this.unitIds.get(pane.paneId) || session.unitId;
      }
      try {
        await this.refresh(session, pane, snap, isNew);
      } catch (err) {
        log('warn', 'registry.refresh', { session: session.name, message: err.message });
      }
      if (isNew) this.emit('added', session);
    }
    for (const [key, session] of this.sessions) {
      if (seen.has(key)) continue;
      this.codexBindings.forget(session);
      this.sessions.delete(key);
      this.emit('removed', session);
    }
    const signature = this.list().map((s) => [s.key, s.name, s.kind, s.status, s.model, s.effort, s.note, s.title, s.lastText.slice(0, 80), runningTasks(s).length, s.tasks.size].join('\u0001')).join('\u0002');
    if (signature !== this.signature) {
      this.signature = signature;
      this.emit('changed');
    }
  }

  async refresh(s, pane, snap, isNew) {
    s.tmuxSession = pane.sessionName;
    s.windowIndex = pane.windowIndex;
    s.paneIndex = pane.paneIndex;
    s.name = pane.single ? pane.sessionName : `${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex}`;
    s.cwd = pane.cwd;
    s.fgCommand = pane.command;
    s.activityAt = pane.activityAt;
    s.title = cleanTitle(pane.title, pane.sessionName);
    s.paneTitle = pane.title;

    const agent = await this.probe.findAgent(snap, pane.panePid, pane.tty);
    const kind = agent?.kind || 'shell';
    if (kind !== s.kind || (agent?.pid ?? null) !== s.agentPid) {
      // A new session object may be the same pane after a hub restart: keep the saved
      // transcript long enough for codexBindings.restore() below to use it.
      if (!isNew) this.codexBindings.forget(s);
      s.kind = kind;
      s.agentPid = agent?.pid ?? null;
      s.agentSeenAt = isNew ? 0 : Date.now();
      s.transcript = null;
      s.tail = null;
      s.bindingLostAt = 0;
      s.dialog = null;
      s.model = '';
      s.modelFamily = '';
      s.effort = '';
      s.tasks = new Map();
      if (!isNew) s.lastText = '';
    }
    const meta = kind === 'claude' ? this.probe.readClaudeMeta(s.agentPid) : null;

    await this.followTranscript(s, kind, meta);
    if (kind === 'agy' && s.transcript) {
      const agyTitle = readAgyConversationTitle(convIdFromTranscript(s.transcript));
      if (agyTitle) s.title = agyTitle;
    }
    const events = s.tail ? s.tail.read() : [];
    const sawTurnEnd = this.applyTranscriptEvents(s, events);

    const detected = await this.detectStatus(pane, snap, kind, meta);
    let { status, note } = detected;
    const { dialog, footer } = detected;
    if (footer) {
      s.modelFamily = footer.family;
      s.effort = footer.effort;
      s.model = footer.display;
    } else if (s.model && !s.effort) {
      s.effort = inferEffortFromModel(s.model);
    }
    // 1) Startup grace right after WebMUX/router delivers a prompt (prevents READY->RUNNING->READY dip).
    const activeSinceStop = !s.stoppedAt || (s.lastActivityAt && s.lastActivityAt > s.stoppedAt + 3000);
    const recentSend = s.sentAt && (!s.stoppedAt || s.sentAt > s.stoppedAt) && Date.now() - s.sentAt < 5000;
    if (status === 'idle' && !sawTurnEnd && recentSend) {
      status = 'working';
    }
    // 2) For `agy`, an open `conversations/<uuid>.db` FD means a turn is actively running in-process
    //    even across 90s thinking steps or synchronous tool executions where the TUI briefly redraws.
    if (status === 'idle' && kind === 'agy' && s.agentPid && (!s.stoppedAt || Date.now() - s.stoppedAt > 4000)) {
      if (await this.probe.hasAgyActiveDb?.(s.agentPid)) {
        status = 'working';
        if (!note && s.turn?.lastTool) note = s.turn.lastTool;
      }
    }
    // 3) Transcript-activity bridge: hold `working` across multi-step tool calls & long reasoning (up to 120s)
    //    until `turn_end` arrives, unless an explicit status file (`claude` idle) or `markStopped` says otherwise.
    const claudeExplicitIdle = kind === 'claude' && meta?.status === 'idle';
    if (status === 'idle' && !claudeExplicitIdle && !sawTurnEnd && s.turn && s.lastActivityAt && activeSinceStop && Date.now() - s.lastActivityAt < 120000 && (s.turn.inProgress || s.turn.tools > 0 || s.turn.thinking)) {
      status = 'working';
      if (!note && s.turn.lastTool) note = s.turn.lastTool;
    }
    const bgRunning = runningTasks(s);
    if (status === 'idle' && bgRunning.length > 0) {
      status = 'background';
      note = taskNote(s);
    } else if (bgRunning.length > 0 && !note) {
      note = taskNote(s);
    }
    s.note = note || (kind === 'codex' && !s.transcript ? '未定位到回复记录，请用 /rename 设置唯一会话名；可点「终端」查看回复。' : '');
    s.dialog = dialog;

    const minHoldMs = this.timer ? 1500 : 0;
    if (status === s.status) {
      s.pending = null;
      s.pendingAt = 0;
    } else if (
      isNew
      || s.status === null
      || status === 'working'
      || (s.pending === status && Date.now() - (s.pendingAt || 0) >= minHoldMs)
    ) {
      // Going to "working" shows at once; leaving it must hold for two polls (and >=1.5s on live daemon),
      // so a brief TUI redraw or gap between tool calls never flip-flops READY <-> RUNNING.
      this.commit(s, status, { silent: isNew, since: isNew ? Number(meta?.statusUpdatedAt) || 0 : 0 });
    } else if (s.pending !== status) {
      s.pending = status;
      s.pendingAt = Date.now();
    }

    // A reply that started and finished between two polls never showed as "working".
    if (s.turn && (s.status === 'idle' || s.status === 'background') && !s.pending) {
      s.turn.quietPolls = events.length ? 0 : (s.turn.quietPolls || 0) + 1;
      if (sawTurnEnd || s.turn.quietPolls >= 2) this.endTurn(s);
    }
    this.codexBindings.checkpoint(s);
  }

  applyTranscriptEvents(s, events) {
    let sawTurnEnd = false;
    for (const ev of events) {
      if (ev.type === 'user') {
        s.lastPrompt = ev.text;
        s.stoppedAt = 0;
        s.turn ??= newTurn(s);
        s.turn.prompt = ev.text;
        s.turn.inProgress = true;
        s.lastActivityAt = Date.now();
        continue;
      }
      if (ev.type === 'model') {
        s.model = ev.model;
        continue;
      }
      if (ev.type === 'task_start' || ev.type === 'task_tick' || ev.type === 'task_end' || ev.type === 'tasks_reset') {
        const ownerId = s.kind === 'agy' ? convIdFromTranscript(s.transcript) : '';
        if (applyTaskEvent(s.tasks, ev, { ownerId })) this.emit('task_update', s, ev);
        continue;
      }
      if (ev.type === 'turn_end') {
        sawTurnEnd = true;
        if (s.turn) s.turn.inProgress = false;
        s.sentAt = 0;
        s.lastActivityAt = 0;
        continue;
      }
      s.turn ??= newTurn(s);
      s.lastActivityAt = Date.now();
      if (ev.type === 'text') {
        s.lastText = ev.text;
        s.turn.texts.push(ev.text);
        if (s.turn.texts.length > MAX_TURN_TEXTS) s.turn.texts.shift();
      } else if (ev.type === 'thinking') {
        s.turn.thinking = true;
      } else if (ev.type === 'tool') {
        s.turn.tools++;
        s.turn.lastTool = ev.summary ? `${ev.name} · ${ev.summary}` : ev.name;
      }
    }
    if (events.length) this.emit('output', s, events);
    return sawTurnEnd;
  }

  async detectStatus(pane, snap, kind, meta) {
    if (kind === 'shell') {
      // A shell with a child is running something, even when tmux still reports the shell (a script).
      const child = (snap.children.get(pane.panePid) || [])[0];
      const note = SHELLS.has(pane.command.replace(/\.exe$/i, '').toLowerCase()) ? (child ? snap.procs.get(child)?.comm || '' : '') : pane.command;
      return { status: 'shell', note, dialog: null };
    }
    if (kind === 'claude' && CLAUDE_STATUS[meta?.status]) {
      let status = CLAUDE_STATUS[meta.status];
      let note = meta.status === 'shell' ? '后台命令运行中' : '';
      let dialog = null;
      if (status !== 'working') {
        // The status file does not cover every dialog (the folder trust prompt comes before it exists).
        dialog = findDialog(await this.tmux.capture(pane.paneId));
        if (dialog) status = 'blocked';
        if (status === 'blocked') note = meta.waitingFor || '';
      }
      return { status, note, dialog };
    }
    const screen = await this.tmux.capture(pane.paneId);
    const dialog = findDialog(screen);
    const status = dialog ? 'blocked' : looksWorking(screen) ? 'working' : 'idle';
    const footer = kind === 'agy' ? parseAgyFooter(screen) : null;
    return { status, note: '', dialog, footer };
  }

  async followTranscript(s, kind, meta) {
    if (kind === 'shell') return;
    // Recheck Claude/Codex/agy/dsh identity every poll (agy/dsh can switch conversations inside one TUI).
    const every = kind === 'claude' || kind === 'codex' || kind === 'agy' || kind === 'dsh' ? 1 : s.transcript ? 15 : 3;
    if (this.polls % every !== 0) return;
    const file = await this.probe.locateTranscript(kind, s.agentPid, meta, { cwd: s.cwd, title: s.paneTitle });
    // Both unknown: after a hub restart this may be a pane whose confirmed rollout is on disk.
    if (!file && !s.transcript && kind === 'codex' && this.codexBindings.restore(s, kind)) return;
    if (file === s.transcript) {
      s.bindingLostAt = 0;
      return;
    }
    if (!file) {
      // Codex replaces its title with only a spinner/cwd while working or "Action Required" while
      // blocked. Keep reading the last confirmed rollout so replies are not skipped.
      if (kind === 'codex' && s.transcript && !s.bindingLostAt) {
        s.bindingLostAt = Date.now();
        log('info', 'transcript.holding', { session: s.name, title: s.paneTitle, file: path.basename(s.transcript) });
      }
      return;
    }
    if (kind === 'codex' || kind === 'agy' || kind === 'dsh') {
      log('info', 'transcript.bound', { session: s.name, kind, title: s.paneTitle, file: path.basename(file) });
      if (kind === 'codex') this.codexBindings.forget(s);
      s.transcript = null;
      s.tail = null;
      s.lastText = '';
      s.lastPrompt = '';
      s.turn = null;
      s.tasks = new Map();
    }
    s.bindingLostAt = 0;
    let born = 0;
    try {
      born = fs.statSync(file).birthtimeMs;
    } catch {
      // keep 0
    }
    // A file created after we started watching this pane or agent holds nothing we should skip.
    const fromStart = born > 0 && born >= (s.agentSeenAt || s.firstSeenAt) - 2000;
    s.transcript = file;
    s.tail = new Tail(file, adapters[kind], { fromStart });
    if (!fromStart) {
      const last = lastExchange(file, adapters[kind]);
      s.lastText = last.text || s.lastText;
      s.lastPrompt = last.prompt || s.lastPrompt;
      if (last.model) s.model = last.model;
      // If the transcript was just updated with an unfinished turn (thinking/tools), mark it active immediately.
      try {
        const mtime = fs.statSync(file).mtimeMs;
        if (Date.now() - mtime < 15000 && adapters[kind]) {
          const latest = lastTurns(file, adapters[kind], 512 * 1024).at(-1);
          if (latest && !latest.done && (latest.tools?.length || latest.thoughts?.length)) {
            s.turn = {
              ...newTurn(s),
              tools: latest.tools.length,
              thinking: Boolean(latest.thoughts.length),
              lastTool: latest.tools.at(-1) ? `${latest.tools.at(-1).name}${latest.tools.at(-1).summary ? ` · ${latest.tools.at(-1).summary}` : ''}` : null,
            };
            s.lastActivityAt = mtime;
          }
        }
      } catch {
        // ignore stat errors
      }
      if (kind === 'agy') {
        const seeded = seedTasksFromTranscript(file, adapters.agy);
        s.tasks = seeded.tasks;
        if (seeded.model) s.model = seeded.model;
      }
    }
    if (kind === 'codex') this.codexBindings.remember(s);
  }

  commit(s, status, { silent = false, since = 0 } = {}) {
    const previous = s.status;
    s.status = status;
    s.statusSince = since || Date.now();
    s.pending = null;
    s.pendingAt = 0;
    if (status === 'working') {
      s.turn ??= { ...newTurn(s), startedAt: s.statusSince };
      s.turn.worked = true;
    }
    if (silent || previous === null) return;
    this.emit('status', s, previous);
    if (status === 'blocked') this.emit('blocked', s);
    // Also when the agent exits to the shell in the middle of a turn.
    const active = (st) => st === 'working' || st === 'blocked';
    if (active(previous) && !active(status)) this.endTurn(s);
  }

  endTurn(s) {
    const turn = s.turn || newTurn(s);
    s.turn = null;
    turn.endedAt = Date.now();
    this.emit('turn_end', s, turn);
  }
}
