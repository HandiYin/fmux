import * as cards from '../cards.mjs';
import { log } from '../util.mjs';

export const DASH_TTL = 13 * 24 * 3600 * 1000; // Feishu lets a card be edited for 14 days

// Keeps dashboard, session ("peek"), and terminal ("term") cards updated in place until
// they expire or a newer card of the same kind takes over.
export class LiveCardManager {
  constructor(router) {
    this.router = router;
    // message id -> { kind: 'dash' | 'peek' | 'term', key, until, signature }
    this.entries = new Map();
  }

  get peekTtl() {
    return (this.router.cfg.live?.peekMinutes ?? 10) * 60000;
  }

  // One dashboard is live at a time, and for each session one session card and one terminal card.
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

  // Stop updating a card, and say so on the card. A card that a newer one replaced shrinks to
  // one line, so the chat does not keep two copies of the same content.
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
    this.router.store.set('live', [...this.entries].map(([id, e]) => ({ id, kind: e.kind, key: e.key, until: Number.isFinite(e.until) ? e.until : null })));
  }

  resume() {
    const saved = this.router.store.get('live') || [];
    for (const e of saved) {
      if (!e?.id || !['dash', 'peek', 'term'].includes(e.kind)) continue;
      this.entries.set(e.id, { kind: e.kind, key: e.key || '', until: e.until ?? Infinity, signature: '' });
    }
  }

  // The card of a live entry as it should look now, and a signature that changes only when the card does.
  async render(entry, { final = false } = {}) {
    const { registry, cfg, tmux } = this.router;
    const now = Date.now();
    if (entry.kind === 'dash') {
      if (final) return { signature: 'stale', card: cards.stubCard('这张面板已停止更新。发「面板」看最新的。') };
      const sessions = registry.list();
      const running = sessions.some((s) => s.status === 'working');
      // Elapsed times move once a minute while an agent runs. An idle dashboard gets a heartbeat every 5 minutes.
      const beat = Math.floor(now / (running ? 60000 : 300000));
      return {
        card: cards.dashboardCard({ sessions, attachedKey: this.router.attachedKey(), quiet: cfg.notify.enabled && this.router.localActive(), now }),
        signature: [registry.signature, this.router.attachedKey(), beat].join('\u0003'),
      };
    }
    const session = registry.sessions.get(entry.key);
    if (!session) return { gone: true, signature: 'gone', card: cards.stubCard('这个 tmux 会话已经结束。') };
    const attached = this.router.attachedKey() === session.key;
    const live = final ? 'off' : 'on';
    const minute = session.status === 'working' ? Math.floor((now - session.statusSince) / 60000) : 0;
    // A shell has nothing but its screen. An agent shows its last exchange unless the terminal was asked for.
    if (entry.kind === 'term' || session.kind === 'shell') {
      const screen = await tmux.capture(session.key);
      return {
        card: cards.terminalCard({ session, screen, attached, now, live }),
        signature: [screen, session.status, session.note, minute, attached, live].join('\u0003'),
      };
    }
    // While attached, replies arrive as their own cards below. This card then keeps the exchange it
    // showed at that moment, and only its state and buttons stay current.
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
      if (out.gone) {
        this.forget(messageId);
        await this.router.feishu.updater.flush(messageId, out.card);
      } else if (out.signature !== entry.signature) {
        entry.signature = out.signature;
        this.router.feishu.updater.schedule(messageId, out.card);
      }
    }
  }

  async post(kind, session, ttlMs) {
    const key = session?.key || '';
    const out = await this.render({ kind, key });
    const messageId = await this.router.post(out.card, key || undefined);
    this.track(kind, messageId, key, ttlMs).signature = out.signature;
    return messageId;
  }

  // Make the card a click came from the live one, and return its new content for the click's reply.
  async adopt(kind, messageId, session, ttlMs) {
    const entry = this.track(kind, messageId, session?.key || '', ttlMs);
    const out = await this.render(entry);
    entry.signature = out.signature;
    return out.card;
  }

  // The card a click came from, drawn again and kept current. Used as the reply to that click.
  async redraw(session, evt, fallbackKind) {
    await this.router.registry.poll();
    const kind = this.entries.get(evt.messageId)?.kind;
    return this.adopt(kind === 'peek' || kind === 'term' ? kind : fallbackKind, evt.messageId, session, this.peekTtl);
  }

  sendDashboard() {
    return this.post('dash', null, DASH_TTL);
  }

  // Poll first, so the status light matches the content of the same card.
  async sendPeek(session) {
    await this.router.registry.poll();
    return this.post('peek', session, this.peekTtl);
  }

  async sendTerminal(session) {
    await this.router.registry.poll();
    return this.post('term', session, this.peekTtl);
  }
}
