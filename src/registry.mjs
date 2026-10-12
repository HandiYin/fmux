import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as realTmux from './tmux.mjs';
import { findAgent, snapshot } from './procs.mjs';
import { HUB_SESSION } from './service.mjs';
import { Tail, adapters, lastExchange, locateTranscript, readClaudeMeta } from './transcript.mjs';
import { pick } from './match.mjs';
import { findDialog, looksWorking } from './screen.mjs';
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

// Watches every tmux pane and emits:
//   added(session) / removed(session)
//   status(session, previous)      status changed (debounced)
//   output(session, events)        new transcript events
//   blocked(session)               a dialog is waiting for a choice
//   turn_end(session, turn)        the agent handed control back
//   changed()                      something the dashboard shows is different
export class Registry extends EventEmitter {
  // `probe` is how the registry looks at processes and transcripts; tests replace it.
  constructor({ tmux = realTmux, intervalMs = 2000, hide = [], probe = {} } = {}) {
    super();
    this.tmux = tmux;
    this.probe = { snapshot, findAgent, readClaudeMeta, locateTranscript, ...probe };
    this.intervalMs = intervalMs;
    this.hide = new Set([...hide, HUB_SESSION]);
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
    for (const pane of panes) {
      if (this.hide.has(pane.sessionName) || INTERNAL_SESSION.test(pane.sessionName)) continue;
      seen.add(pane.paneId);
      let session = this.sessions.get(pane.paneId);
      const isNew = !session;
      if (isNew) {
        session = {
          key: pane.paneId, kind: null, agentPid: null, status: null, statusSince: Date.now(),
          note: '', dialog: null, lastText: '', lastPrompt: '', turn: null, transcript: null,
          tail: null, pending: null, agentSeenAt: 0, firstSeenAt: Date.now(),
        };
        this.sessions.set(pane.paneId, session);
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
      this.sessions.delete(key);
      this.emit('removed', session);
    }
    const signature = this.list().map((s) => [s.key, s.name, s.kind, s.status, s.note, s.title, s.lastText.slice(0, 80)].join('\u0001')).join('\u0002');
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

    const agent = await this.probe.findAgent(snap, pane.panePid, pane.tty);
    const kind = agent?.kind || 'shell';
    if (kind !== s.kind || (agent?.pid ?? null) !== s.agentPid) {
      s.kind = kind;
      s.agentPid = agent?.pid ?? null;
      s.agentSeenAt = isNew ? 0 : Date.now();
      s.transcript = null;
      s.tail = null;
      s.dialog = null;
      if (!isNew) s.lastText = '';
    }
    const meta = kind === 'claude' ? this.probe.readClaudeMeta(s.agentPid) : null;

    await this.followTranscript(s, kind, meta);
    const events = s.tail ? s.tail.read() : [];
    let sawTurnEnd = false;
    for (const ev of events) {
      if (ev.type === 'user') {
        s.lastPrompt = ev.text;
        continue;
      }
      if (ev.type === 'turn_end') {
        sawTurnEnd = true;
        continue;
      }
      s.turn ??= newTurn(s);
      if (ev.type === 'text') {
        s.lastText = ev.text;
        s.turn.texts.push(ev.text);
        if (s.turn.texts.length > MAX_TURN_TEXTS) s.turn.texts.shift();
      } else if (ev.type === 'tool') {
        s.turn.tools++;
        s.turn.lastTool = ev.summary ? `${ev.name} · ${ev.summary}` : ev.name;
      }
    }
    if (events.length) this.emit('output', s, events);

    let status;
    let note = '';
    let dialog = null;
    if (kind === 'shell') {
      status = 'shell';
      // A shell with a child is running something, even when tmux still reports the shell (a script).
      const child = (snap.children.get(pane.panePid) || [])[0];
      note = SHELLS.has(pane.command.replace(/\.exe$/i, '').toLowerCase()) ? (child ? snap.procs.get(child)?.comm || '' : '') : pane.command;
    } else if (kind === 'claude' && CLAUDE_STATUS[meta?.status]) {
      status = CLAUDE_STATUS[meta.status];
      if (meta.status === 'shell') note = '后台命令运行中';
      if (status !== 'working') {
        // The status file does not cover every dialog (the folder trust prompt comes before it exists).
        dialog = findDialog(await this.tmux.capture(pane.paneId));
        if (dialog) status = 'blocked';
        if (status === 'blocked') note = meta.waitingFor || '';
      }
    } else {
      const screen = await this.tmux.capture(pane.paneId);
      dialog = findDialog(screen);
      status = dialog ? 'blocked' : looksWorking(screen) ? 'working' : 'idle';
    }
    s.note = note;
    s.dialog = dialog;

    if (status === s.status) {
      s.pending = null;
    } else if (isNew || s.status === null || status === 'working' || s.pending === status) {
      // Going to "working" shows at once; leaving it must hold for two polls, so a
      // gap between two queued prompts does not read as a finished turn.
      this.commit(s, status, { silent: isNew, since: isNew ? Number(meta?.statusUpdatedAt) || 0 : 0 });
    } else {
      s.pending = status;
    }

    // A reply that started and finished between two polls never showed as "working".
    if (s.turn && s.status === 'idle' && !s.pending) {
      s.turn.quietPolls = events.length ? 0 : (s.turn.quietPolls || 0) + 1;
      if (sawTurnEnd || s.turn.quietPolls >= 2) this.endTurn(s);
    }
  }

  async followTranscript(s, kind, meta) {
    if (kind === 'shell') return;
    // Claude's lookup is a cached map, so it runs every poll and catches /clear. The others scan directories.
    const every = kind === 'claude' ? 1 : s.transcript ? 15 : 3;
    if (this.polls % every !== 0) return;
    const file = await this.probe.locateTranscript(kind, s.agentPid, meta, { cwd: s.cwd });
    if (!file || file === s.transcript) return;
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
    }
  }

  commit(s, status, { silent = false, since = 0 } = {}) {
    const previous = s.status;
    s.status = status;
    s.statusSince = since || Date.now();
    s.pending = null;
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
