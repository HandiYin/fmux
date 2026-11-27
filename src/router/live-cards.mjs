import { listTasks, readTaskLog } from '../agy-tasks.mjs';
import * as cards from '../cards.mjs';
import { log } from '../util.mjs';

export const DASH_TTL = 13 * 24 * 3600 * 1000; // Feishu lets a card be edited for 14 days

// Manages reusable root cards, thread posting, and live-updating dashboard/terminal/tasks cards.
export class LiveCardManager {
  constructor(router) {
    this.router = router;
    // message id -> { kind: 'dash' | 'peek' | 'term' | 'tasks', key, until, signature }
    this.entries = new Map();
    this.reusable = new Map(Object.entries(router.store.get('reusableCards') || {}));
    this.rootSessions = new Map(Object.entries(router.store.get('rootSessions') || {}));
    this.cardWrites = new Map();
    this.sessionRoots = new Set();
  }

  get peekTtl() {
    return (this.router.cfg.live?.peekMinutes ?? 10) * 60000;
  }

  rememberCard(slot, id, createdAt = Date.now()) {
    if (slot.startsWith('session:')) {
      const key = slot.slice('session:'.length);
      const previous = this.reusable.get(slot);
      // Renewing an editable root must not redirect replies in its older thread.
      if (previous) this.rootSessions.set(previous.id, key);
      this.rootSessions.set(id, key);
      while (this.rootSessions.size > 400) this.rootSessions.delete(this.rootSessions.keys().next().value);
      this.router.store.set('rootSessions', Object.fromEntries(this.rootSessions));
    }
    this.reusable.set(slot, { id, createdAt });
    this.router.store.set('reusableCards', Object.fromEntries(this.reusable));
  }

  // Serialize first creation and edits so concurrent status/output events share one card.
  reuseCard(slot, card, key, opts, fresh = false) {
    const next = (this.cardWrites.get(slot) || Promise.resolve()).catch(() => {}).then(async () => {
      const existing = this.reusable.get(slot);
      if (existing && !fresh && Date.now() - existing.createdAt < DASH_TTL) {
        try {
          await this.router.feishu.updater.flush(existing.id, card, { throwOnError: true });
          return existing.id;
        } catch (err) {
          // A transient API failure must not produce duplicate cards.
          if (!/deleted|recalled|not found|expired|message does not exist/i.test(err.message || '')) throw err;
          this.forget(existing.id);
        }
      } else if (existing) {
        this.forget(existing.id);
      }
      const id = await this.router.post(card, key, opts);
      this.rememberCard(slot, id);
      this.router.store.flush();
      return id;
    });
    this.cardWrites.set(slot, next);
    return next.finally(() => {
      if (this.cardWrites.get(slot) === next) this.cardWrites.delete(slot);
    });
  }

  clearSessionLive(key) {
    const id = this.reusable.get(`session:${key}`)?.id;
    if (id) this.forget(id);
  }

  sessionCard(session, card) {
    this.clearSessionLive(session.key);
    return this.reuseCard(`session:${session.key}`, card, session.key).then((id) => {
      this.forget(id);
      return id;
    });
  }

  async sessionRoot(session) {
    const slot = `session:${session.key}`;
    const existing = this.reusable.get(slot);
    if (existing && Date.now() - existing.createdAt < DASH_TTL && this.sessionRoots.has(existing.id)) return existing.id;
    // Also migrates roots previously overwritten with the turn-only layout.
    const id = await this.reuseCard(slot, cards.sessionCard({ session, attached: this.router.attachedKey() === session.key }), session.key);
    this.sessionRoots.add(id);
    this.forget(id);
    return id;
  }

  async postThreadCard(session, card) {
    const rootId = await this.sessionRoot(session);
    try {
      return await this.router.post(card, session.key, { replyTo: rootId, replyInThread: true });
    } catch (err) {
      if (!/deleted|recalled|not found|expired|message does not exist/i.test(err.message || '')) throw err;
      const slot = `session:${session.key}`;
      if (this.reusable.get(slot)?.id === rootId) {
        this.reusable.delete(slot);
        this.sessionRoots.delete(rootId);
        this.router.store.set('reusableCards', Object.fromEntries(this.reusable));
      }
      const replacement = await this.sessionRoot(session);
      return this.router.post(card, session.key, { replyTo: replacement, replyInThread: true });
    }
  }

  boundSession(messageId) {
    if (!messageId) return null;
    const key = this.router.store.sessionKeyFor(messageId) || this.rootSessions.get(messageId);
    if (key) return key;
    // Long-lived roots may outlast the bounded message-ID cache.
    for (const [slot, root] of this.reusable) {
      if (root.id === messageId && /^(session|terminal|tasks):/.test(slot)) return slot.slice(slot.indexOf(':') + 1);
    }
    return null;
  }

  // One dashboard is live at a time, and for each session one terminal/tasks card.
  track(kind, messageId, key = '', ttlMs = Infinity) {
    for (const [id, other] of [...this.entries]) {
      if (id !== messageId && other.kind === kind && (kind === 'dash' || other.key === key)) this.retire(id, { replaced: true });
    }
    const entry = this.entries.get(messageId) || { signature: '' };
    Object.assign(entry, { kind, key, until: Date.now() + ttlMs });
    this.entries.set(messageId, entry);
    this.persist();
    return entry;
  }

  retire(messageId, { replaced = false } = {}) {
    const entry = this.entries.get(messageId);
    if (!entry) return;
    this.forget(messageId);
    const name = this.router.registry.sessions.get(entry.key)?.name;
    const shrink = replaced && entry.kind !== 'dash' && name;
    (shrink ? Promise.resolve({ card: cards.stubCard(`${name}：看下面更新的卡片。`) }) : this.render(entry, { final: true }))
      .then((out) => this.router.feishu.updater.flush(messageId, out.card))
      .catch((err) => log('warn', 'live.retire', { message: err.message }));
  }

  forget(messageId) {
    if (this.entries.delete(messageId)) this.persist();
  }

  persist() {
    this.router.store.set('live', [...this.entries].map(([id, e]) => ({
      id, kind: e.kind, key: e.key, until: Number.isFinite(e.until) ? e.until : null,
    })));
  }

  resume() {
    const saved = [...(this.router.store.get('live') || [])];
    const legacy = this.router.store.get('dash');
    if (legacy?.messageId && !saved.some((e) => e.kind === 'dash')) saved.push({ id: legacy.messageId, kind: 'dash', key: '', until: null });
    for (const e of saved) {
      if (!e?.id) continue;
      const slot = e.kind === 'dash' ? 'dashboard' : `${e.kind === 'term' ? 'terminal' : e.kind === 'tasks' ? 'tasks' : 'session'}:${e.key}`;
      if (!this.reusable.has(slot)) this.rememberCard(slot, e.id);
      if (e.kind === 'peek' || e.kind === 'attached') continue;
      this.entries.set(e.id, { kind: e.kind, key: e.key || '', until: e.until ?? Infinity, signature: '' });
    }
    this.persist();
  }

  async refreshDashboard(reason, { throwOnError = false } = {}) {
    if (!this.reusable.has('dashboard')) return;
    try {
      const out = await this.render({ kind: 'dash', key: '' });
      const id = await this.reuseCard('dashboard', out.card);
      this.track('dash', id, '', DASH_TTL).signature = out.signature;
      log('info', 'dashboard.refreshed', { reason, sessions: this.router.registry.list().map((s) => ({ name: s.name, status: s.status })) });
    } catch (err) {
      log('warn', 'dashboard.refresh', { reason, message: err.message });
      if (throwOnError) throw err;
    }
  }

  async render(entry, { final = false } = {}) {
    const { registry, cfg, tmux } = this.router;
    const now = Date.now();
    if (entry.kind === 'dash') {
      if (final) return { signature: 'stale', card: cards.stubCard('这张面板已停止更新。发「面板」看最新的。') };
      const sessions = registry.list();
      const running = sessions.some((s) => s.status === 'working' || s.status === 'background');
      const beat = Math.floor(now / (running ? 60000 : 300000));
      const webUrl = cfg.web?.enabled && cfg.web?.publicUrl ? cfg.web.publicUrl : '';
      return {
        card: cards.dashboardCard({ sessions, attachedKey: this.router.attachedKey(), quiet: cfg.notify.enabled && this.router.localActive(), webUrl, now }),
        signature: [registry.signature, this.router.attachedKey(), beat, webUrl].join('\u0003'),
      };
    }
    const session = registry.sessions.get(entry.key);
    if (!session) return { gone: true, signature: 'gone', card: cards.stubCard('这个 tmux 会话已经结束。') };
    const attached = this.router.attachedKey() === session.key;
    const live = final ? 'off' : 'on';
    const minute = session.status === 'working' || session.status === 'background' ? Math.floor((now - session.statusSince) / 60000) : 0;
    if (entry.kind === 'tasks') {
      const tasks = listTasks(session);
      const selectedTask = tasks.find((t) => t.status === 'running' && t.logFile) || tasks.find((t) => t.logFile) || tasks[0] || null;
      const logText = selectedTask ? readTaskLog(selectedTask, { maxLines: 20 }) : '';
      const taskSig = tasks.map((t) => `${t.id}:${t.status}:${t.summary}`).join(',');
      return {
        card: cards.tasksCard({ session, tasks, selectedTask, logText, attached, now, live }),
        signature: [taskSig, logText, session.status, minute, attached, live].join('\u0003'),
      };
    }
    if (!session.dormant && entry.kind === 'term') {
      const screen = await tmux.capture(session.key);
      return {
        card: cards.terminalCard({ session, screen, attached, now, live }),
        signature: [screen, session.status, session.note, minute, attached, live].join('\u0003'),
      };
    }
    if (attached) entry.frozen ??= { lastText: session.lastText, lastPrompt: session.lastPrompt };
    else entry.frozen = null;
    const shown = entry.frozen ? { ...session, ...entry.frozen } : session;
    return {
      card: cards.sessionCard({ session: shown, attached, now, live }),
      signature: [session.status, session.statusSince, session.note, session.title, shown.lastPrompt.slice(0, 90), shown.lastText.length, shown.lastText.slice(-60), minute, attached, live].join('\u0003'),
    };
  }

  async tick(now) {
    for (const [messageId, entry] of [...this.entries]) {
      if (now > entry.until) {
        this.retire(messageId);
        continue;
      }
      const out = await this.render(entry);
      if (this.entries.get(messageId) !== entry) continue;
      if (out.gone) {
        this.forget(messageId);
        await this.router.feishu.updater.flush(messageId, out.card);
      } else if (out.signature !== entry.signature) {
        entry.signature = out.signature;
        this.router.feishu.updater.schedule(messageId, out.card);
      }
    }
  }

  slotFor(kind, key) {
    if (kind === 'dash') return 'dashboard';
    if (kind === 'term') return `terminal:${key}`;
    if (kind === 'tasks') return `tasks:${key}`;
    return `session:${key}`;
  }

  async postLive(kind, session, ttlMs, fresh = false) {
    const key = session?.key || '';
    const out = await this.render({ kind, key });
    const slot = this.slotFor(kind, key);
    const opts = kind === 'term' || kind === 'tasks' ? { replyTo: await this.sessionRoot(session), replyInThread: true } : undefined;
    const messageId = await this.reuseCard(slot, out.card, key || undefined, opts, fresh);
    if (kind === 'peek') {
      this.sessionRoots.add(messageId);
      this.forget(messageId);
      return messageId;
    }
    this.track(kind, messageId, key, ttlMs).signature = out.signature;
    return messageId;
  }

  async adopt(kind, messageId, session, ttlMs) {
    if (kind === 'peek') this.sessionRoots.add(messageId);
    const slot = this.slotFor(kind, session?.key);
    const sameMain = session && this.reusable.get(`session:${session.key}`)?.id === messageId;
    if ((kind !== 'term' && kind !== 'tasks') || !sameMain) {
      if (this.reusable.get(slot)?.id !== messageId) this.rememberCard(slot, messageId);
    }
    const entry = kind === 'peek' ? { kind, key: session.key } : this.track(kind, messageId, session?.key || '', ttlMs);
    if (kind === 'peek') this.forget(messageId);
    const out = await this.render(entry);
    entry.signature = out.signature;
    return out.card;
  }

  async redraw(session, evt, fallbackKind) {
    await this.router.registry.poll();
    const kind = this.entries.get(evt.messageId)?.kind;
    return this.adopt(['peek', 'term', 'tasks'].includes(kind) ? kind : fallbackKind, evt.messageId, session, this.peekTtl);
  }

  sendDashboard() {
    // Clearing local chat history does not invalidate the server-side card ID.
    // An explicit request must therefore send a visible new panel.
    return this.postLive('dash', null, DASH_TTL, true);
  }

  async sendPeek(session) {
    await this.router.registry.poll();
    return this.postLive('peek', session, this.peekTtl);
  }

  async sendTerminal(session) {
    await this.router.registry.poll();
    return this.postLive('term', session, this.peekTtl);
  }

  async sendTasks(session) {
    await this.router.registry.poll();
    return this.postLive('tasks', session, this.peekTtl);
  }
}
