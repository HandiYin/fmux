import fs from 'node:fs';
import path from 'node:path';
import { log } from './util.mjs';

// Feishu allows about five updates a second per message; one a second is plenty for a phone.
export class CardUpdater {
  constructor(update, minIntervalMs = 1100) {
    this.update = update;
    this.minIntervalMs = minIntervalMs;
    this.entries = new Map();
  }

  schedule(messageId, card) {
    let entry = this.entries.get(messageId);
    if (!entry) {
      entry = { lastSent: 0, card: null, timer: null, busy: Promise.resolve() };
      this.entries.set(messageId, entry);
    }
    entry.card = card;
    if (entry.timer) return;
    const wait = Math.max(0, entry.lastSent + this.minIntervalMs - Date.now());
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.send(messageId, entry);
    }, wait);
  }

  send(messageId, entry) {
    const card = entry.card;
    entry.card = null;
    if (!card) return entry.busy;
    entry.lastSent = Date.now();
    entry.busy = entry.busy
      .then(() => this.update(messageId, card))
      .catch((err) => {
        log('warn', 'card.update', { messageId, message: err.message });
        this.onError?.(messageId, err);
      });
    return entry.busy;
  }

  // Push the latest card now and wait for it; used for the final state of a card.
  async flush(messageId, card) {
    let entry = this.entries.get(messageId);
    if (!entry) {
      entry = { lastSent: 0, card: null, timer: null, busy: Promise.resolve() };
      this.entries.set(messageId, entry);
    }
    if (card) entry.card = card;
    clearTimeout(entry.timer);
    entry.timer = null;
    await this.send(messageId, entry);
    this.entries.delete(messageId);
  }
}

export async function createFeishu({ appId, appSecret, ownerOpenId, tenant = 'feishu' }) {
  const { createLarkChannel } = await import('@larksuite/channel');
  const channel = createLarkChannel({
    appId,
    appSecret,
    ...(tenant === 'lark' ? { domain: 'https://open.larksuite.com' } : {}),
    // Only the owner's direct chat reaches the handlers. Groups are closed with a chat id that cannot exist.
    policy: { dmMode: 'allowlist', dmAllowlist: [ownerOpenId], groupAllowlist: ['oc_fmux_groups_closed'], requireMention: true },
    safety: { staleMessageWindowMs: 5 * 60 * 1000 },
    keepalive: {
      enabled: true,
      onUnrecoverable: (err) => {
        log('error', 'feishu.unrecoverable', { message: String(err?.message || err) });
        process.exit(1);
      },
    },
    httpTimeoutMs: 20000,
    source: 'fmux',
  });
  channel.on('error', (err) => log('error', 'feishu.error', { code: err?.code, message: err?.message }));
  channel.on('reconnecting', () => log('warn', 'feishu.reconnecting'));
  channel.on('reconnected', () => log('info', 'feishu.reconnected'));
  channel.on('reject', (evt) => log('info', 'feishu.reject', { reason: evt.reason, sender: evt.senderId, chat: evt.chatId }));

  const api = {
    onMessage: (fn) => channel.on('message', fn),
    onCardAction: (fn) => channel.on('cardAction', fn),
    connect: () => channel.connect(),
    disconnect: () => channel.disconnect(),
    async sendCard(chatId, card, { replyTo } = {}) {
      const res = await channel.send(chatId, { card }, replyTo ? { replyTo } : undefined);
      return res.messageId;
    },
    updateCard: (messageId, card) => channel.updateCard(messageId, card),
    async sendText(chatId, text, { replyTo } = {}) {
      const res = await channel.send(chatId, { markdown: text }, replyTo ? { replyTo } : undefined);
      return res.messageId;
    },
    react: (messageId, emoji) => channel.addReaction(messageId, emoji).catch(() => null),
    download: (messageId, resource) => channel.downloadResource(messageId, resource.fileKey, resource.type === 'image' ? 'image' : 'file'),
    botName: () => {
      try {
        return channel.getBotIdentity().name;
      } catch {
        return '';
      }
    },
  };
  api.updater = new CardUpdater(api.updateCard);
  return api;
}

// Stands in for Feishu in tests and local runs: records every card instead of sending it.
export function createFakeFeishu({ dir } = {}) {
  let seq = Date.now() % 100000 * 100;
  const handlers = { message: [], cardAction: [] };
  const api = {
    sent: [],
    cards: new Map(),
    onMessage: (fn) => handlers.message.push(fn),
    onCardAction: (fn) => handlers.cardAction.push(fn),
    connect: async () => {},
    disconnect: async () => {},
    record(kind, messageId, payload) {
      const entry = { kind, messageId, at: Date.now(), ...payload };
      api.sent.push(entry);
      if (payload.card) api.cards.set(messageId, payload.card);
      if (dir) {
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, 'outbox.jsonl'), JSON.stringify(entry) + '\n');
      }
    },
    async sendCard(chatId, card, opts = {}) {
      const messageId = `om_fake_${++seq}`;
      api.record('card', messageId, { chatId, card, replyTo: opts.replyTo });
      return messageId;
    },
    async updateCard(messageId, card) {
      api.record('update', messageId, { card });
    },
    async sendText(chatId, text, opts = {}) {
      const messageId = `om_fake_${++seq}`;
      api.record('text', messageId, { chatId, text, replyTo: opts.replyTo });
      return messageId;
    },
    react: async (messageId, emoji) => api.record('reaction', messageId, { emoji }),
    download: async () => Buffer.from('fake'),
    botName: () => 'fmux (fake)',
    // test drivers
    async say(message) {
      for (const fn of handlers.message) await fn(message);
    },
    async click(event) {
      let reply;
      for (const fn of handlers.cardAction) reply = await fn(event);
      if (reply?.card?.data && event.messageId) api.record('update', event.messageId, { card: reply.card.data, viaCallback: true });
      return reply;
    },
  };
  api.updater = new CardUpdater(api.updateCard, 50);
  return api;
}
