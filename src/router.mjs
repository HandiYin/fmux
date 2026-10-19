import fs from 'node:fs';
import path from 'node:path';
import * as realTmux from './tmux.mjs';
import * as cards from './cards.mjs';
import { lookupConversation, recentConversations } from './history.mjs';
import { compactScreen, findDialog, keysFor } from './screen.mjs';
import { adapters, lastTurns } from './transcript.mjs';
import { expandHome, fmtDuration, log, oneLine, quoteArg, sleep } from './util.mjs';

const ALIASES = {
  sessions: 'ls', 会话: 'ls', attach: 'a', 接入: 'a', detach: 'd', 断开: 'd',
  p: 'peek', 看: 'peek', keys: 'key', 帮助: 'help',
};
const COMMANDS = new Set(['ls', 'a', 'd', 'peek', 'key', 'new', 'pi', 'help', 'kill', 'stop']);
const MEDIA_ONLY = new Set(['image', 'file', 'audio', 'media', 'video', 'sticker']);
// Sent alone, these words bring up the dashboard even while attached: easier on a phone than "//ls".
const PANEL_WORDS = new Set(['面板', '会话面板', '会话']);
const DASH_TTL = 13 * 24 * 3600 * 1000; // Feishu lets a card be edited for 14 days
const TICK_MS = 3000;

const toast = (content, type = 'success') => ({ toast: { type, content } });
const replace = (card, toastText) => ({ ...(toastText ? toast(toastText) : {}), card: { type: 'raw', data: card } });

function sniffExt(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf.slice(0, 3).toString() === 'GIF') return '.gif';
  if (buf.slice(8, 12).toString() === 'WEBP') return '.webp';
  return '.bin';
}

// Decides where each chat message and card click goes, and turns session events into cards.
export class Router {
  constructor({ feishu, registry, concierge = null, store, cfg, tmux = realTmux, history = { recentConversations, lookupConversation } }) {
    Object.assign(this, { feishu, registry, concierge, store, cfg, tmux, history });
    this.views = new Map(); // session key -> live turn card of a followed session
    this.oneShot = new Set(); // sessions followed until their current turn ends
    this.blocked = new Map(); // session key -> the open "waiting for a choice" card
    this.finished = new Map(); // message id -> { key, turn } of a "finished" card, for re-rendering
    this.follows = new Map(); // session key -> token of a running screen follow
    this.promised = new Set(); // sessions left mid-turn: their result is announced whatever the notify settings
    this.live = new Map(); // message id -> { kind: 'dash' | 'peek' | 'term', key, until, signature }: cards kept current
    this.piView = null;
    this.ticking = false;
    this.nudgeTimer = null;
    this.startedAt = Date.now();
  }

  wire() {
    const guard = (name, fn) => (...args) => Promise.resolve(fn.apply(this, args)).catch((err) => log('error', `router.${name}`, { message: err.message, stack: err.stack }));
    this.registry.on('output', guard('output', this.onOutput));
    this.registry.on('status', guard('status', this.onStatus));
    this.registry.on('blocked', guard('blocked', this.onBlocked));
    this.registry.on('turn_end', guard('turn_end', this.onTurnEnd));
    this.registry.on('removed', guard('removed', this.onRemoved));
    this.registry.on('changed', () => this.nudge());
    this.feishu.updater.onError = (messageId) => this.forget(messageId);
    if (this.concierge) {
      this.concierge.on('text', (delta) => this.onPiProgress((v) => { v.text += delta; }));
      this.concierge.on('tool', (tool) => this.onPiProgress((v) => { v.tools++; v.lastTool = tool.summary ? `${tool.name} · ${tool.summary}` : tool.name; }));
      this.concierge.on('end', guard('pi.end', this.onPiEnd));
    }
    this.feishu.onMessage((msg) => this.onMessage(msg));
    this.feishu.onCardAction((evt) => this.onCardAction(evt));
    this.feishu.onBotMenu((evt) => this.onBotMenu(evt));
  }

  // ---- small helpers ----

  get chatId() {
    return this.store.get('chatId') || this.cfg.owner.chatId;
  }

  attachedKey() {
    return this.store.get('attached')?.key || null;
  }

  attachedSession() {
    const key = this.attachedKey();
    return key ? this.registry.sessions.get(key) || null : null;
  }

  isFollowed(s) {
    return this.attachedKey() === s.key || this.oneShot.has(s.key);
  }

  localActive() {
    const quiet = this.cfg.notify.quietIfLocalActiveSec;
    return quiet > 0 && Date.now() - this.registry.localActiveAt < quiet * 1000;
  }

  find(value) {
    return this.registry.sessions.get(value?.s) || (value?.n ? this.registry.resolve(value.n) : null);
  }

  async post(card, sessionKey, opts) {
    if (!this.chatId) throw new Error('owner chat is unknown: send the bot a message first');
    const messageId = await this.feishu.sendCard(this.chatId, card, opts);
    if (sessionKey) this.store.rememberMessage(messageId, sessionKey);
    return messageId;
  }

  info(title, text, extra = {}) {
    return this.post(cards.infoCard({ title, text, ...extra }));
  }

  // ---- inbound chat messages ----

  async onMessage(msg) {
    try {
      if (msg.senderId !== this.cfg.owner.openId || msg.chatType !== 'p2p') return;
      if (this.store.get('chatId') !== msg.chatId) this.store.set('chatId', msg.chatId);
      let text = MEDIA_ONLY.has(msg.rawContentType) ? '' : String(msg.content || '').trim();
      if (msg.rawContentType === 'audio') {
        await this.info('语音消息没有转发', '会话只收文字。用输入法键盘上的语音输入把话转成文字再发。');
        return;
      }
      const files = await this.saveResources(msg);
      if (files.length) text = [text, ...files.map((f) => `[附件] ${f}`)].filter(Boolean).join('\n');
      if (!text) return;

      const command = this.parseCommand(text);
      if (command) {
        await this.runCommand(command, msg);
        return;
      }
      const quotedKey = this.store.sessionKeyFor(msg.replyToMessageId) || this.store.sessionKeyFor(msg.rootId);
      const quoted = quotedKey ? this.registry.sessions.get(quotedKey) : null;
      if (quoted) {
        await this.deliver(quoted, text, msg);
        return;
      }
      const attached = this.store.get('attached');
      if (attached) {
        const session = this.attachedSession();
        if (session) {
          await this.deliver(session, text, msg);
          return;
        }
        this.store.set('attached', null);
        await this.info(`会话 ${attached.name} 不在了`, '已回到 Pi 管家。这条消息没有发出去。');
        return;
      }
      await this.askConcierge(text);
    } catch (err) {
      log('error', 'router.message', { message: err.message, stack: err.stack });
      await this.info('出错了', `处理这条消息时失败：${err.message}`, { template: 'red' }).catch(() => {});
    }
  }

  async saveResources(msg) {
    const saved = [];
    for (const resource of msg.resources || []) {
      if (resource.type !== 'sticker') saved.push(await this.saveResource(msg, resource));
    }
    return saved;
  }

  async saveResource(msg, resource) {
    const buf = await this.feishu.download(msg.messageId, resource);
    const now = new Date();
    const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const dir = path.join(this.cfg.stateDir, 'inbox', day);
    fs.mkdirSync(dir, { recursive: true });
    const base = resource.fileName
      ? resource.fileName.replace(/[^\p{L}\p{N}._-]+/gu, '_')
      : `${resource.type}-${resource.fileKey.slice(-8)}${sniffExt(buf)}`;
    const file = path.join(dir, `${now.toTimeString().slice(0, 8).replace(/:/g, '')}-${base}`);
    fs.writeFileSync(file, buf);
    return file;
  }

  // "//cmd" always belongs to the hub. A single "/" does too, but only while detached:
  // an attached session has its own slash commands.
  parseCommand(text) {
    if (PANEL_WORDS.has(text)) return { name: 'ls', arg: '' };
    const m = text.match(/^(\/\/|／／|\/)\s*([A-Za-z一-龥-]+)(?:\s+([\s\S]*))?$/);
    if (!m) return null;
    const single = m[1] === '/';
    if (single && this.store.get('attached')) return null;
    const name = ALIASES[m[2].toLowerCase()] || m[2].toLowerCase();
    if (!COMMANDS.has(name)) return single ? null : { name: 'help', arg: '' };
    return { name, arg: (m[3] || '').trim() };
  }

  async runCommand({ name, arg }, msg) {
    switch (name) {
      case 'ls':
        await this.sendDashboard();
        return;
      case 'a': {
        const session = await this.choose(arg, 'attach', '用法：`//a <序号或名字>`');
        if (session) await this.attach(session);
        return;
      }
      case 'd':
        await this.detach();
        await this.ack(msg, 'DONE', '已断开。现在的消息由 Pi 管家处理。');
        return;
      case 'peek': {
        const session = arg ? await this.choose(arg, 'peek', '') : this.attachedSession();
        if (session) await this.sendPeek(session);
        else if (!arg) await this.info('找不到会话', '用法：`//peek <序号或名字>`，接入后可以省略名字。');
        return;
      }
      case 'key': {
        const tokens = arg.split(/\s+/).filter(Boolean);
        let session = tokens.length > 1 ? this.registry.resolve(tokens[0]) : null;
        if (session) tokens.shift();
        session ??= this.attachedSession();
        if (!session || !tokens.length) {
          await this.info('用法', '`//key [会话] <按键…>`，按键如 `esc` `enter` `up` `1` `c-c`。');
          return;
        }
        await this.tmux.sendKeys(session.key, tokens);
        await sleep(450);
        await this.sendTerminal(session);
        return;
      }
      case 'new': {
        const [sessionName, agent = 'claude', cwd = '~'] = arg.split(/\s+/).filter(Boolean);
        if (!sessionName) {
          await this.post(this.newSessionForm());
          return;
        }
        const session = await this.createSession({ name: sessionName, agent, cwd });
        await this.attach(session);
        return;
      }
      case 'pi':
        if (arg) await this.askConcierge(arg);
        else await this.info('用法', '`//pi <消息>`：不断开当前会话，临时问 Pi 管家。');
        return;
      case 'stop': {
        const session = this.attachedSession();
        if (session) await this.tmux.sendKeys(session.key, ['esc']);
        return;
      }
      case 'kill': {
        const session = await this.choose(arg, 'term', '用法：`//kill <名字>`');
        if (session) await this.sendTerminal(session);
        return;
      }
      default:
        await this.post(cards.helpCard());
    }
  }

  // A reaction on the owner's message says "done" without another card. A stub card stands in if it fails.
  async ack(msg, emoji, text) {
    const ok = msg?.messageId ? await this.feishu.react(msg.messageId, emoji) : null;
    if (!ok) await this.post(cards.stubCard(text));
  }

  // The session a loosely typed name means. When the name fits several, a card asks which one.
  async choose(text, action, usage) {
    const { match, candidates } = this.registry.lookup(text);
    if (match) return match;
    if (candidates.length) {
      await this.post(cards.infoCard({
        title: `「${text}」对上了 ${candidates.length} 个会话`,
        text: '点一个：',
        buttons: candidates.slice(0, 6).map((s) => ({ label: s.name, value: { a: action, s: s.key, n: s.name } })),
      }));
    } else {
      await this.info('找不到会话', text ? `没有能对上「${text}」的会话。` : usage);
    }
    return null;
  }

  // ---- sending into a session ----

  // `typed` is a line the session should read as the owner's own words, sent before the text.
  async deliver(session, text, msg, { typed = '' } = {}) {
    if (session.status === 'blocked') {
      await this.showBlocked(session, '这个会话在等确认，消息**没有发出**。先选一项；要直接输入文字，用「屏幕」卡片里的输入框。');
      return false;
    }
    if (this.attachedKey() !== session.key) this.oneShot.add(session.key);
    // Claude Code takes several lines key by key (Ctrl+J between them) and then reads them as typed.
    // A pasted block it marks as pasted. Everything else gets the paste, which every program accepts.
    const keys = !typed && session.kind === 'claude' && text.includes('\n') && this.tmux.canType(text);
    await this.tmux.sendText(session.key, text, { typed, keys });
    log('info', 'deliver', { session: session.name, chars: text.length, typed: typed.length, keys });
    if (msg?.messageId) this.feishu.react(msg.messageId, 'OK');
    if (session.kind === 'shell') this.followScreen(session);
    return true;
  }

  // A shell has no transcript: wait until the screen stops changing, then send a snapshot.
  followScreen(session) {
    const token = {};
    this.follows.set(session.key, token);
    (async () => {
      const deadline = Date.now() + 20000;
      let previous = null;
      let screen = '';
      let stable = 0;
      await sleep(500);
      while (Date.now() < deadline && this.follows.get(session.key) === token) {
        screen = await this.tmux.capture(session.key);
        stable = screen === previous ? stable + 1 : 0;
        previous = screen;
        if (stable >= 2) break;
        await sleep(700);
      }
      if (this.follows.get(session.key) !== token) return;
      this.follows.delete(session.key);
      this.oneShot.delete(session.key);
      await this.sendPeek(session);
    })().catch((err) => log('error', 'router.follow', { message: err.message }));
  }

  // ---- registry events ----

  renderTurn(session, state, turn = session.turn) {
    const t = turn || { texts: [], tools: 0, lastTool: null, startedAt: Date.now() };
    return cards.turnCard({ session, state, texts: t.texts, tools: t.tools, lastTool: t.lastTool, startedAt: t.startedAt, endedAt: t.endedAt, now: Date.now() });
  }

  ensureView(session) {
    let view = this.views.get(session.key);
    if (view) return view;
    view = { messageId: null, ready: null, minute: 0 };
    this.views.set(session.key, view);
    view.ready = this.post(this.renderTurn(session, 'working'), session.key)
      .then((id) => { view.messageId = id; })
      .catch((err) => {
        log('error', 'router.view', { message: err.message });
        if (this.views.get(session.key) === view) this.views.delete(session.key);
      });
    return view;
  }

  onOutput(session, events) {
    if (!this.isFollowed(session)) return;
    if (!events.some((e) => e.type === 'text' || e.type === 'tool')) return;
    const view = this.ensureView(session);
    view.ready.then(() => {
      if (view.messageId && this.views.get(session.key) === view) this.feishu.updater.schedule(view.messageId, this.renderTurn(session, 'working'));
    });
  }

  async onStatus(session, previous) {
    if (previous === 'blocked') await this.closeBlocked(session, '已在终端处理');
    if (session.status === 'working' && this.isFollowed(session)) this.ensureView(session);
  }

  async onBlocked(session) {
    if (!this.isFollowed(session) && (!this.cfg.notify.enabled || this.localActive())) return;
    await this.showBlocked(session);
  }

  async showBlocked(session, hint) {
    const screen = await this.tmux.capture(session.key);
    const state = { dialog: findDialog(screen) || session.dialog, screen };
    state.messageId = await this.post(cards.blockedCard({ session, ...state, hint }), session.key);
    this.blocked.set(session.key, state);
  }

  async closeBlocked(session, answered) {
    const state = this.blocked.get(session.key);
    if (!state) return;
    this.blocked.delete(session.key);
    await this.feishu.updater.flush(state.messageId, cards.blockedCard({ session, dialog: state.dialog, screen: state.screen, answered }));
  }

  async onTurnEnd(session, turn) {
    const followed = this.isFollowed(session);
    this.oneShot.delete(session.key);
    const view = this.views.get(session.key);
    this.views.delete(session.key);
    const seconds = (turn.endedAt - turn.startedAt) / 1000;
    const long = seconds >= this.cfg.notify.minWorkSec;
    const promised = this.promised.delete(session.key);
    const empty = !turn.texts.length && !turn.tools;

    // A dialog that opened and closed while the agent was idle (the folder trust prompt) is not a turn.
    if (empty && !turn.worked) {
      if (view) await view.ready;
      if (view?.messageId) await this.feishu.updater.flush(view.messageId, cards.stubCard(`${session.name}：已处理。`));
      return;
    }
    if (followed) {
      const done = this.renderTurn(session, 'done', turn);
      if (view) await view.ready;
      if (!view?.messageId) {
        await this.post(done, session.key);
        return;
      }
      await this.feishu.updater.flush(view.messageId, done);
      // An edit does not ring the phone. After a long turn, one short line does.
      if (long) {
        const preview = oneLine(turn.texts.at(-1) || '', 60);
        const line = `**${session.name}** 已结束（${fmtDuration(seconds)}）${preview ? `：${preview}` : ''}`;
        this.feishu.sendText(this.chatId, line, { replyTo: view.messageId })
          .then((id) => this.store.rememberMessage(id, session.key))
          .catch((err) => log('warn', 'turn.ping', { message: err.message }));
      }
      return;
    }
    if (empty) return;
    if (promised || (this.cfg.notify.enabled && long && !this.localActive())) {
      const messageId = await this.post(cards.finishedCard({ session, turn }), session.key);
      this.finished.set(messageId, { key: session.key, turn });
      while (this.finished.size > 40) this.finished.delete(this.finished.keys().next().value);
    }
  }

  async onRemoved(session) {
    this.views.delete(session.key);
    this.oneShot.delete(session.key);
    this.blocked.delete(session.key);
    this.follows.delete(session.key);
    this.promised.delete(session.key);
    if (this.attachedKey() === session.key) {
      this.store.set('attached', null);
      await this.info(`会话 ${session.name} 已结束`, '已回到 Pi 管家。');
    }
  }

  // ---- attach / detach ----

  async attach(session, { announce = true } = {}) {
    const previous = this.attachedSession();
    if (previous && previous.key !== session.key) this.dropView(previous, `已切到 ${session.name}。${previous.name} 仍在运行，结束后会通知你。`);
    this.promised.delete(session.key);
    this.store.set('attached', { key: session.key, name: session.name });
    this.nudge();
    log('info', 'attach', { session: session.name });
    if (!announce) return;
    // One card says where the session is: its dialog, its running turn, or its last reply.
    if (session.status === 'blocked') await this.showBlocked(session);
    else if (session.status === 'working') this.ensureView(session);
    else await this.sendPeek(session);
  }

  async detach() {
    const previous = this.attachedSession();
    if (previous) this.dropView(previous, `已断开。${previous.name} 仍在运行，结束后会通知你。`);
    this.store.set('attached', null);
    this.nudge();
  }

  dropView(session, text) {
    const view = this.views.get(session.key);
    if (!view) return;
    this.views.delete(session.key);
    this.promised.add(session.key);
    view.ready.then(() => view.messageId && this.feishu.updater.flush(view.messageId, cards.stubCard(text)));
  }

  // Before a restart: turn cards cannot be picked up again, so they say where the reply will be.
  async shutdown() {
    clearInterval(this.ticker);
    const pending = [];
    for (const [key, view] of this.views) {
      const session = this.registry.sessions.get(key);
      if (view.messageId) pending.push(this.feishu.updater.flush(view.messageId, cards.stubCard(`fmux 重启了。${session?.name || '会话'} 这一轮的回复会出现在新的卡片里。`)));
    }
    this.views.clear();
    await Promise.race([Promise.allSettled(pending), sleep(2000)]);
  }

  // ---- cards that stay current: the dashboard, the "attached" card, screen cards ----

  // One dashboard is live at a time, and for each session one session card and one terminal card.
  track(kind, messageId, key = '', ttlMs = Infinity) {
    for (const [id, other] of [...this.live]) {
      if (id !== messageId && other.kind === kind && (kind === 'dash' || other.key === key)) this.retire(id, { replaced: true });
    }
    const entry = this.live.get(messageId) || { signature: '' };
    Object.assign(entry, { kind, key, until: Date.now() + ttlMs });
    this.live.set(messageId, entry);
    this.persistLive();
    return entry;
  }

  // Stop updating a card, and say so on the card. A card that a newer one replaced shrinks to
  // one line, so the chat does not keep two copies of the same content.
  retire(messageId, { replaced = false } = {}) {
    const entry = this.live.get(messageId);
    if (!entry) return;
    this.forget(messageId);
    const name = this.registry.sessions.get(entry.key)?.name;
    const shrink = replaced && entry.kind !== 'dash' && name;
    (shrink ? Promise.resolve({ card: cards.stubCard(`${name}：看下面更新的卡片。`) }) : this.renderLive(entry, { final: true }))
      .then((out) => this.feishu.updater.flush(messageId, out.card))
      .catch((err) => log('warn', 'live.retire', { message: err.message }));
  }

  retireKind(kind) {
    for (const [id, entry] of [...this.live]) if (entry.kind === kind) this.retire(id);
  }

  forget(messageId) {
    if (this.live.delete(messageId)) this.persistLive();
  }

  persistLive() {
    this.store.set('live', [...this.live].map(([id, e]) => ({ id, kind: e.kind, key: e.key, until: Number.isFinite(e.until) ? e.until : null })));
  }

  // After a restart the cards sent before it go on being updated.
  resume() {
    const saved = this.store.get('live') || [];
    const legacy = this.store.get('dash');
    if (legacy?.messageId && !saved.some((e) => e.kind === 'dash')) saved.push({ id: legacy.messageId, kind: 'dash', key: '', until: null });
    for (const e of saved) {
      // "attached" cards of an earlier version are session cards now, with the same time limit.
      const legacy = e.kind === 'attached';
      this.live.set(e.id, { kind: legacy ? 'peek' : e.kind, key: e.key, until: legacy ? Date.now() + this.peekTtl : e.until ?? Infinity, signature: '' });
    }
    const attached = this.attachedSession();
    if (attached?.status === 'working') this.ensureView(attached);
    this.startTicker();
  }

  startTicker() {
    if (this.ticker) return;
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    this.ticker.unref();
  }

  // Something changed: do not wait for the next tick.
  nudge() {
    if (this.nudgeTimer) return;
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      this.tick();
    }, 1000);
    this.nudgeTimer.unref();
  }

  // The card of a live entry as it should look now, and a signature that changes only when the card does.
  async renderLive(entry, { final = false } = {}) {
    const now = Date.now();
    if (entry.kind === 'dash') {
      if (final) return { signature: 'stale', card: cards.stubCard('这张面板已停止更新。发「面板」看最新的。') };
      const sessions = this.registry.list();
      const running = sessions.some((s) => s.status === 'working');
      // Elapsed times move once a minute while an agent runs. An idle dashboard gets a heartbeat every 5 minutes.
      const beat = Math.floor(now / (running ? 60000 : 300000));
      return {
        card: cards.dashboardCard({ sessions, attachedKey: this.attachedKey(), quiet: this.cfg.notify.enabled && this.localActive(), now }),
        signature: [this.registry.signature, this.attachedKey(), beat].join('\u0003'),
      };
    }
    const session = this.registry.sessions.get(entry.key);
    if (!session) return { gone: true, signature: 'gone', card: cards.stubCard('这个 tmux 会话已经结束。') };
    const attached = this.attachedKey() === session.key;
    const live = final ? 'off' : 'on';
    const minute = session.status === 'working' ? Math.floor((now - session.statusSince) / 60000) : 0;
    // A shell has nothing but its screen. An agent shows its last exchange unless the terminal was asked for.
    if (entry.kind === 'term' || session.kind === 'shell') {
      const screen = await this.tmux.capture(session.key);
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

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      for (const [messageId, entry] of [...this.live]) {
        if (now > entry.until) {
          this.retire(messageId);
          continue;
        }
        const out = await this.renderLive(entry);
        if (out.gone) {
          this.forget(messageId);
          await this.feishu.updater.flush(messageId, out.card);
        } else if (out.signature !== entry.signature) {
          entry.signature = out.signature;
          this.feishu.updater.schedule(messageId, out.card);
        }
      }
      // Turn cards change with the agent's output; between outputs only the elapsed time moves.
      for (const [key, view] of this.views) {
        const session = this.registry.sessions.get(key);
        if (!session?.turn || !view.messageId) continue;
        const minute = Math.floor((now - session.turn.startedAt) / 60000);
        if (minute === view.minute) continue;
        view.minute = minute;
        this.feishu.updater.schedule(view.messageId, this.renderTurn(session, 'working'));
      }
    } catch (err) {
      log('error', 'router.tick', { message: err.message });
    } finally {
      this.ticking = false;
    }
  }

  // Send a new live card.
  async postLive(kind, session, ttlMs) {
    const key = session?.key || '';
    const out = await this.renderLive({ kind, key });
    const messageId = await this.post(out.card, key || undefined);
    this.track(kind, messageId, key, ttlMs).signature = out.signature;
    return messageId;
  }

  // Make the card a click came from the live one, and return its new content for the click's reply.
  async adopt(kind, messageId, session, ttlMs) {
    const entry = this.track(kind, messageId, session?.key || '', ttlMs);
    const out = await this.renderLive(entry);
    entry.signature = out.signature;
    return out.card;
  }

  sendDashboard() {
    return this.postLive('dash', null, DASH_TTL);
  }

  get peekTtl() {
    return (this.cfg.live?.peekMinutes ?? 10) * 60000;
  }

  // Poll first, so the status light matches the content of the same card.
  async sendPeek(session) {
    await this.registry.poll();
    return this.postLive('peek', session, this.peekTtl);
  }

  async sendTerminal(session) {
    await this.registry.poll();
    return this.postLive('term', session, this.peekTtl);
  }

  // The card a click came from, drawn again and kept current. Used as the reply to that click.
  async redraw(session, evt, fallbackKind) {
    await this.registry.poll();
    const kind = this.live.get(evt.messageId)?.kind;
    return this.adopt(kind === 'peek' || kind === 'term' ? kind : fallbackKind, evt.messageId, session, this.peekTtl);
  }

  // ---- card clicks ----

  // Bot menus remain available when the chat has scrolled past the last panel.
  // They operate on the hub directly, even when an agent is busy or blocked.
  async onBotMenu(evt) {
    if (evt.operator?.openId !== this.cfg.owner.openId) return;
    switch (evt.key) {
      case 'fmux.dashboard':
        await this.sendDashboard();
        break;
      case 'fmux.concierge':
        await this.detach();
        await this.sendDashboard();
        break;
      case 'fmux.new':
        await this.post(this.newSessionForm());
        break;
      default:
        return;
    }
    log('info', 'menu.action', { key: evt.key });
  }

  async onCardAction(evt) {
    try {
      if (evt.operator?.openId !== this.cfg.owner.openId) return toast('无权限', 'error');
      const value = typeof evt.action?.value === 'string' ? JSON.parse(evt.action.value) : evt.action?.value || {};
      return await this.handleAction(value, evt);
    } catch (err) {
      log('error', 'router.action', { message: err.message, stack: err.stack });
      return toast(`失败：${err.message}`, 'error');
    }
  }

  async handleAction(v, evt) {
    const form = evt.action?.formValue || {};
    switch (v.a) {
      case 'dash':
        return replace(await this.adopt('dash', evt.messageId, null, DASH_TTL), '已刷新');
      case 'dash.new':
        this.sendDashboard().catch((err) => log('error', 'dash.send', { message: err.message }));
        return {};
      case 'help':
        this.post(cards.helpCard()).catch(() => {});
        return {};
      case 'new.form':
        this.post(this.newSessionForm()).catch((err) => log('error', 'new.form', { message: err.message }));
        return {};
      case 'detach':
        await this.detach();
        return v.from === 'dash' ? replace(await this.adopt('dash', evt.messageId, null, DASH_TTL), '已断开') : toast('已断开，消息回到 Pi 管家');
      case 'pi.stop':
        this.concierge?.abort();
        return toast('已请求停止');
      case 'new.submit': {
        let session;
        try {
          session = await this.createSession({
            name: String(form.name || '').trim(), agent: form.agent || 'claude', cwd: String(form.cwd || '~').trim(),
            prompt: String(form.prompt || '').trim(), resume: String(form.resume || 'new'), yolo: form.yolo !== 'no',
          });
        } catch (err) {
          return replace(this.newSessionForm(err.message));
        }
        await this.attach(session, { announce: false });
        this.store.rememberMessage(evt.messageId, session.key);
        return replace(await this.adopt('peek', evt.messageId, session, this.peekTtl), `已创建 ${session.name}`);
      }
      default:
        break;
    }

    const session = this.find(v);
    if (!session) return toast(`会话 ${v.n || ''} 已不存在`, 'error');
    switch (v.a) {
      case 'attach': {
        // A click on the session's own card needs no second card: that card turns into "已接入".
        const own = this.live.get(evt.messageId);
        const sameCard = own && own.kind !== 'dash' && own.key === session.key && session.status !== 'working' && session.status !== 'blocked';
        await this.attach(session, { announce: !sameCard });
        if (sameCard) return replace(await this.redraw(session, evt, own.kind), `已接入 ${session.name}`);
        return v.from === 'dash' ? replace(await this.adopt('dash', evt.messageId, null, DASH_TTL), `已接入 ${session.name}`) : toast(`已接入 ${session.name}`);
      }
      case 'peek':
        this.sendPeek(session).catch((err) => log('error', 'peek.send', { message: err.message }));
        return {};
      case 'term':
        this.sendTerminal(session).catch((err) => log('error', 'term.send', { message: err.message }));
        return {};
      case 'peek.refresh':
        return replace(await this.redraw(session, evt, 'peek'));
      case 'term.refresh':
        return replace(await this.redraw(session, evt, 'term'));
      case 'key': {
        await this.tmux.sendKeys(session.key, [v.k]);
        if (v.from === 'term' || v.from === 'peek') {
          await sleep(450);
          return replace(await this.redraw(session, evt, 'term'), `已发送 ${v.k}`);
        }
        return toast(`已发送 ${v.k}`);
      }
      case 'pick': {
        // Read the dialog again: the choice must match what is on the screen now, not when the card was sent.
        const screen = await this.tmux.capture(session.key);
        const dialog = findDialog(screen);
        const state = this.blocked.get(session.key);
        if (v.i === -1) {
          await this.tmux.sendKeys(session.key, ['esc']);
        } else {
          const option = dialog?.options[v.i];
          if (!option || !option.label.startsWith(v.l)) return toast('屏幕上的对话框已经变了，点「屏幕」看一下', 'warning');
          await this.tmux.sendKeys(session.key, keysFor(dialog, v.i));
        }
        this.blocked.delete(session.key);
        const answered = v.i === -1 ? 'Esc' : dialog.options[v.i].label;
        return replace(cards.blockedCard({ session, dialog, screen: state?.screen || screen, answered }), '已发送');
      }
      case 'reply': {
        const text = String(form.text || '').trim();
        if (!text) return toast('内容为空', 'warning');
        if (v.from === 'term' || v.from === 'peek') {
          // The terminal card talks to the terminal as it is, dialog or not.
          await this.tmux.sendText(session.key, text);
          await sleep(600);
          return replace(await this.redraw(session, evt, 'term'), '已发送');
        }
        if (!(await this.deliver(session, text))) return toast('会话在等确认，没有发出', 'warning');
        const finished = this.finished.get(evt.messageId);
        return finished ? replace(cards.finishedCard({ session, turn: finished.turn, replied: text }), '已发送') : toast('已发送');
      }
      case 'kill':
        this.forget(evt.messageId);
        await this.tmux.killSession(session.tmuxSession);
        return replace(cards.stubCard(`tmux 会话 ${session.tmuxSession} 已结束。`), '已结束');
      default:
        return toast('未知操作', 'warning');
    }
  }

  // ---- sessions ----

  newSessionForm(error) {
    return cards.newSessionCard({ error, agents: Object.keys(this.cfg.agents), conversations: this.history.recentConversations() });
  }

  // resume: 'new', 'last' (latest conversation of the directory), '<agent>:<conversation id>',
  // or words from a conversation's title. yolo: start the agent with its `flags` (-d, --yolo).
  async createSession({ name, agent = 'claude', cwd = '~', prompt = '', resume = 'new', yolo = true }) {
    let template;
    if (resume && resume !== 'new' && resume !== 'last') {
      const tagged = resume.match(/^(claude|codex):(.+)$/);
      const { match: conversation, candidates } = this.history.lookupConversation(tagged ? tagged[2] : resume, { agent: tagged?.[1] });
      if (!conversation && candidates.length) {
        throw new Error(`「${resume}」对上了多个对话：${candidates.slice(0, 5).map((c) => `${c.id.slice(0, 8)} ${oneLine(c.title, 24)}`).join('；')}`);
      }
      if (!conversation) throw new Error(`找不到要恢复的对话：${resume}`);
      agent = conversation.agent;
      cwd = conversation.cwd;
      template = this.cfg.agents[agent]?.resume?.replace('{id}', conversation.id);
      if (!template) throw new Error(`${agent} 没有配置恢复命令`);
    }
    const spec = this.cfg.agents[agent];
    if (!spec) throw new Error(`未知类型：${agent}（可选 ${Object.keys(this.cfg.agents).join(' / ')}）`);
    if (resume === 'last') {
      template = spec.continue;
      if (!template) throw new Error(`${agent} 不支持「继续最近一次对话」`);
    }
    template ??= spec.command;
    name = String(name || '').trim() || this.autoName(agent);
    const dir = expandHome(cwd || '~');
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`目录不存在：${cwd}`);
    if (this.registry.list().some((s) => s.tmuxSession === name)) throw new Error(`已有叫 ${name} 的会话`);
    const base = template.replace('{flags}', yolo ? spec.flags || '' : '').replace('{name}', name).replace(/\s+/g, ' ').trim();
    const command = base ? (prompt ? `${base} ${quoteArg(prompt)}` : base) : prompt;
    await this.tmux.newSession({ name, cwd: dir, command });
    await this.registry.poll();
    const session = this.registry.list().find((s) => s.tmuxSession === name);
    if (!session) throw new Error('会话创建后没有出现在 tmux 里');
    log('info', 'session.new', { name, agent, cwd: dir, resume, yolo });
    if (spec.autoTrust) this.autoTrust(session.key).catch((err) => log('warn', 'autotrust', { message: err.message }));
    return session;
  }

  // A name for a session created without one: the agent and the time, made unique.
  autoName(agent) {
    const d = new Date();
    const two = (n) => String(n).padStart(2, '0');
    const base = `${agent}-${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
    const taken = new Set(this.registry.list().map((s) => s.tmuxSession));
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
    return name;
  }

  // Claude Code asks whether to trust a folder it has not seen. The owner picked the folder
  // for this session, so the prompt is answered for them. Nothing else is answered here.
  async autoTrust(key, { tries = 25, everyMs = 1000 } = {}) {
    for (let i = 0; i < tries; i++) {
      await sleep(everyMs);
      if (!this.registry.sessions.has(key)) return false;
      const screen = await this.tmux.capture(key);
      const dialog = findDialog(screen);
      const index = dialog ? dialog.options.findIndex((o) => /^Yes, I trust/i.test(o.label)) : -1;
      if (index >= 0) {
        await this.tmux.sendKeys(key, keysFor(dialog, index));
        log('info', 'autotrust', { session: this.registry.sessions.get(key)?.name });
        return true;
      }
      // The agent's own prompt is up: there was no trust question.
      if (!dialog && this.registry.sessions.get(key)?.kind !== 'shell' && i >= 5) return false;
    }
    return false;
  }

  // ---- handoff: what one session said goes to another, with the owner's comment on top ----

  // What to hand over from a session: its last finished replies, or the end of its screen.
  async handoffContent(source, { turns = 1, whole = false, screen = false, lines = 40 }) {
    if (screen || source.kind === 'shell' || !source.transcript) {
      const tail = compactScreen(await this.tmux.capture(source.key, { history: 200 }), Math.max(1, lines), 200);
      return { what: `终端最后 ${tail.split('\n').length} 行`, body: tail, note: '' };
    }
    const all = lastTurns(source.transcript, adapters[source.kind]).filter((t) => t.texts.length);
    const finished = all.filter((t) => t.done);
    // While the agent works, its newest turn is not a reply yet. Take what it finished before.
    const pool = finished.length ? finished : all;
    const note = finished.length < all.length ? `${source.name} 还在运行，转交的是它上一条已完成的回复` : '';
    const picked = pool.slice(-Math.max(1, turns));
    const one = (t) => (whole ? t.texts.join('\n\n') : t.texts.at(-1));
    const body = picked.length > 1
      ? picked.map((t, i) => `（第 ${i + 1} 条${t.prompt ? `，当时的输入：${oneLine(t.prompt, 80)}` : ''}）\n${one(t)}`).join('\n\n')
      : picked.length ? one(picked[0]) : source.lastText;
    return { what: picked.length > 1 ? `最近 ${picked.length} 条回复` : '最后一条回复', body, note };
  }

  async handoff({ from, to, comment = '', ...options }) {
    const source = this.need(from);
    const target = this.need(to);
    if (source.key === target.key) throw new Error('the source and the target are the same session');
    const { what, body, note } = await this.handoffContent(source, options);
    if (!body?.trim()) throw new Error(`${source.name} has no reply to hand over yet`);
    const limit = 30000;
    const cut = Array.from(body).length > limit;
    const text = cut ? `${Array.from(body).slice(0, limit).join('')}\n…（太长，已截断）` : body;
    const block = `【来自会话 ${source.name} 的${what}】\n\n${text}`;
    // The comment is typed, so an agent reads it as the owner's instruction. The other session's
    // reply is pasted, so the agent reads it as material and not as orders. A shell gets one paste.
    const lead = comment.replace(/\s+/g, ' ').trim() || `下面是会话 ${source.name} 的${what}，供参考。`;
    const typed = target.kind !== 'shell' && !lead.includes('@') ? lead : '';
    const sent = await this.deliver(target, typed ? block : `${lead}\n\n${block}`, undefined, { typed });
    if (!sent) throw new Error(`${target.name} is waiting on a dialog and took nothing. Answer the dialog first.`);
    log('info', 'handoff', { from: source.name, to: target.name, chars: text.length, what });
    return {
      from: source.name, to: target.name, what, chars: Array.from(text).length, truncated: cut,
      preview: oneLine(text, 160), comment: comment.trim(), note,
      next: `${target.name}'s reply will arrive in the chat as its own card`,
    };
  }

  // ---- concierge (pi) ----

  async askConcierge(text) {
    if (!this.concierge) {
      await this.info('没有接入会话', '发「面板」选一个会话接入，消息才有去处。');
      return;
    }
    if (!this.piView) {
      const view = { text: '', tools: 0, lastTool: null, startedAt: Date.now(), messageId: null };
      this.piView = view;
      view.ready = this.post(cards.conciergeCard({ state: 'working', ...view }))
        .then((id) => { view.messageId = id; })
        .catch((err) => log('error', 'pi.view', { message: err.message }));
    }
    this.concierge.prompt(text);
  }

  onPiProgress(apply) {
    const view = this.piView;
    if (!view) return;
    apply(view);
    view.ready.then(() => {
      if (view.messageId && this.piView === view) this.feishu.updater.schedule(view.messageId, cards.conciergeCard({ state: 'working', ...view, text: view.text.trim() }));
    });
  }

  async onPiEnd({ error }) {
    const view = this.piView;
    if (!view) return;
    this.piView = null;
    await view.ready;
    const done = cards.conciergeCard({ state: 'done', ...view, text: view.text.trim(), endedAt: Date.now(), error });
    if (view.messageId) await this.feishu.updater.flush(view.messageId, done);
    else await this.post(done);
  }

  // ---- control API (fmuxctl, and through it the concierge) ----

  summary(s) {
    return {
      name: s.name, key: s.key, kind: s.kind, status: s.status, since: new Date(s.statusSince).toISOString(), note: s.note,
      cwd: s.cwd, title: s.title, attached: this.attachedKey() === s.key, lastPrompt: s.lastPrompt.slice(0, 300), lastText: s.lastText.slice(0, 600),
    };
  }

  need(refText) {
    const { match, candidates } = this.registry.lookup(refText);
    if (match) return match;
    if (candidates.length) throw new Error(`"${refText}" fits several sessions: ${candidates.map((s) => s.name).join(', ')}. Ask the owner which one.`);
    throw new Error(`no session fits "${refText}". Sessions: ${this.registry.list().map((s) => s.name).join(', ') || 'none'}`);
  }

  api = {
    ls: async () => this.registry.list().map((s) => this.summary(s)),
    status: async () => ({
      pid: process.pid,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      sessions: this.registry.sessions.size,
      attached: this.store.get('attached')?.name || null,
      chatKnown: Boolean(this.chatId),
      conciergeRunning: Boolean(this.concierge?.child),
      liveCards: this.live.size,
      localKeyboardActive: this.localActive(),
    }),
    peek: async ({ ref, lines = 40 }) => {
      const session = this.need(ref);
      const screen = await this.tmux.capture(session.key, { history: Math.max(0, lines - 50) });
      return { ...this.summary(session), screen: screen.split('\n').slice(-lines).join('\n') };
    },
    send: async ({ ref, text }) => {
      const session = this.need(ref);
      if (session.status === 'blocked') throw new Error(`${session.name} is waiting on a dialog; answer it with "fmuxctl keys" first`);
      await this.deliver(session, text);
      return { sent: session.name, note: 'the reply will show up in the chat as a card' };
    },
    keys: async ({ ref, keys }) => {
      const session = this.need(ref);
      await this.tmux.sendKeys(session.key, keys);
      return { sent: session.name, keys };
    },
    attach: async ({ ref }) => {
      const session = this.need(ref);
      await this.attach(session);
      return { attached: session.name };
    },
    detach: async () => {
      await this.detach();
      return { attached: null };
    },
    history: async () => this.history.recentConversations(),
    form: async () => ({ messageId: await this.post(this.newSessionForm()) }),
    new: async ({ name, agent, cwd, prompt, resume, yolo = true, attach = true }) => {
      const session = await this.createSession({ name, agent, cwd, prompt, resume, yolo });
      if (attach) await this.attach(session);
      return this.summary(session);
    },
    kill: async ({ ref }) => {
      const session = this.need(ref);
      await this.tmux.killSession(session.tmuxSession);
      return { killed: session.tmuxSession };
    },
    notify: async ({ title = 'fmux', text }) => ({ messageId: await this.post(cards.infoCard({ title, text })) }),
    dashboard: async () => ({ messageId: await this.sendDashboard() }),
    handoff: async (params) => this.handoff(params),
    show: async ({ ref, terminal = false }) => ({ messageId: await (terminal ? this.sendTerminal(this.need(ref)) : this.sendPeek(this.need(ref))) }),
  };
}
