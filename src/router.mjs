import * as cards from './cards.mjs';
import { lookupConversation, recentConversations } from './history.mjs';
import { handleBotMenu, handleCardAction } from './router/actions.mjs';
import { parseCommand, runCommand, saveResources } from './router/commands.mjs';
import { createControlApi } from './router/control-api.mjs';
import { LiveCardManager } from './router/live-cards.mjs';
import { autoTrust, createSession, handoff, newSessionForm } from './router/sessions.mjs';
import { findDialog } from './screen.mjs';
import * as realTmux from './tmux.mjs';
import { fmtDuration, log, oneLine, sleep } from './util.mjs';

const MEDIA_ONLY = new Set(['image', 'file', 'audio', 'media', 'video', 'sticker']);
const TICK_MS = 3000;

// Decides where each chat message and card click goes, and turns session events into cards.
export class Router {
  constructor({ feishu, registry, concierge = null, store, cfg, tmux = realTmux, history = { recentConversations, lookupConversation } }) {
    Object.assign(this, { feishu, registry, concierge, store, cfg, tmux, history });
    this.liveCards = new LiveCardManager(this);
    this.live = this.liveCards.entries;
    this.views = new Map(); // session key -> live turn card of a followed session
    this.oneShot = new Set(); // sessions followed until their current turn ends
    this.blocked = new Map(); // session key -> the open "waiting for a choice" card
    this.finished = new Map(); // message id -> { key, turn } of a "finished" card, for re-rendering
    this.follows = new Map(); // session key -> token of a running screen follow
    this.promised = new Set(); // sessions left mid-turn: their result is announced whatever the notify settings
    this.piView = null;
    this.ticking = false;
    this.autoReturning = false;
    this.nudgeTimer = null;
    this.startedAt = Date.now();
    this.api = createControlApi(this);
  }

  wire() {
    const guard = (name, fn) => (...args) => Promise.resolve(fn.apply(this, args)).catch((err) => log('error', `router.${name}`, { message: err.message, stack: err.stack }));
    this.registry.on('output', guard('output', this.onOutput));
    this.registry.on('status', guard('status', this.onStatus));
    this.registry.on('blocked', guard('blocked', this.onBlocked));
    this.registry.on('turn_end', guard('turn_end', this.onTurnEnd));
    this.registry.on('removed', guard('removed', this.onRemoved));
    this.registry.on('changed', () => this.nudge());
    this.registry.on('task_update', () => this.nudge());
    this.feishu.updater.onError = (messageId) => this.liveCards.forget(messageId);
    if (this.concierge) {
      this.concierge.on('text', (delta) => this.onPiProgress((v) => { v.text += delta; }));
      this.concierge.on('tool', (tool) => this.onPiProgress((v) => { v.tools++; v.lastTool = tool.summary ? `${tool.name} · ${tool.summary}` : tool.name; }));
      this.concierge.on('end', guard('pi.end', this.onPiEnd));
    }
    this.feishu.onMessage((msg) => this.onMessage(msg));
    this.feishu.onCardAction((evt) => handleCardAction(this, evt));
    this.feishu.onBotMenu((evt) => handleBotMenu(this, evt));
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

  // Remember when the owner last typed into the attached session. The auto-return timer reads it.
  touchAttached(session = this.attachedSession()) {
    const attached = this.store.get('attached');
    if (!attached || !session || attached.key !== session.key) return;
    this.store.set('attached', { ...attached, lastInputAt: Date.now() });
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

  need(refText) {
    const { match, candidates } = this.registry.lookup(refText);
    if (match) return match;
    if (candidates.length) throw new Error(`"${refText}" fits several sessions: ${candidates.map((s) => s.name).join(', ')}. Ask the owner which one.`);
    throw new Error(`no session fits "${refText}". Sessions: ${this.registry.list().map((s) => s.name).join(', ') || 'none'}`);
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

  // A reaction on the owner's message says "done" without another card. A stub card stands in if it fails.
  async ack(msg, emoji, text) {
    const ok = msg?.messageId ? await this.feishu.react(msg.messageId, emoji) : null;
    if (!ok) await this.post(cards.stubCard(text));
  }

  runningNotice() {
    return this.cfg.notify.enabled ? '仍在运行，结束后会通知你。' : '仍在运行。';
  }

  // ---- delegates to sub-modules ----

  sendDashboard() { return this.liveCards.sendDashboard(); }
  sendPeek(session) { return this.liveCards.sendPeek(session); }
  sendTerminal(session) { return this.liveCards.sendTerminal(session); }
  sendTasks(session) { return this.liveCards.sendTasks(session); }
  newSessionForm(error) { return newSessionForm(this, error); }
  createSession(opts) { return createSession(this, opts); }
  autoTrust(key, opts) { return autoTrust(this, key, opts); }
  handoff(opts) { return handoff(this, opts); }

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
      const files = await saveResources(this, msg);
      if (files.length) text = [text, ...files.map((f) => `[附件] ${f}`)].filter(Boolean).join('\n');
      if (!text) return;

      const command = parseCommand(text, Boolean(this.store.get('attached')));
      if (command) {
        await runCommand(this, command, msg);
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
    this.touchAttached(session);
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
      if (view?.messageId) await this.feishu.updater.flush(view.messageId, cards.stubCard(`${session.name}：已处理。`)).catch(() => {});
      return;
    }
    if (followed) {
      await this.finishFollowedTurn(session, turn, view, { long, seconds });
      return;
    }
    if (empty) return;
    // A disabled notification setting silences every unsolicited card for an unattached
    // session, including the "you left this turn running" completion.
    if (this.cfg.notify.enabled && (promised || (long && !this.localActive()))) {
      const messageId = await this.post(cards.finishedCard({ session, turn }), session.key);
      this.finished.set(messageId, { key: session.key, turn });
      while (this.finished.size > 40) this.finished.delete(this.finished.keys().next().value);
    }
  }

  async finishFollowedTurn(session, turn, view, { long, seconds }) {
    const done = this.renderTurn(session, 'done', turn);
    if (view) await view.ready;
    let finalId = view?.messageId || null;
    let delivered = false;
    if (finalId) {
      try {
        await this.feishu.updater.flush(finalId, done, { throwOnError: true });
        delivered = true;
      } catch (err) {
        // The card may have been deleted, or Feishu refused this edit: repost as a new card below.
        log('warn', 'turn.card_failed', { session: session.name, messageId: finalId, message: err.message });
      }
    }
    if (!delivered) {
      finalId = await this.post(done, session.key);
      log('info', 'turn.card_reposted', { session: session.name, messageId: finalId });
    }
    // An edit does not ring the phone. After a long turn that edited a live card, one short
    // line does. A card posted from scratch already rings, so it needs no extra line.
    if (long && view?.messageId && delivered) {
      const preview = oneLine(turn.texts.at(-1) || '', 60);
      const line = `**${session.name}** 已结束（${fmtDuration(seconds)}）${preview ? `：${preview}` : ''}`;
      this.feishu.sendText(this.chatId, line, { replyTo: finalId })
        .then((id) => this.store.rememberMessage(id, session.key))
        .catch((err) => log('warn', 'turn.ping', { message: err.message }));
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
    if (previous && previous.key !== session.key) this.dropView(previous, `已切到 ${session.name}。${previous.name} ${this.runningNotice()}`);
    this.promised.delete(session.key);
    this.store.set('attached', { key: session.key, name: session.name, lastInputAt: Date.now() });
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
    if (previous) this.dropView(previous, `已断开。${previous.name} ${this.runningNotice()}`);
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

  // ---- lifecycle & ticker ----

  resume() {
    this.liveCards.resume();
    const savedAttached = this.store.get('attached');
    if (savedAttached) {
      // A hub restart is not the owner walking away: give the attachment a fresh window.
      this.store.set('attached', { ...savedAttached, lastInputAt: Date.now() });
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

  nudge() {
    if (this.nudgeTimer) return;
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      this.tick();
    }, 1000);
    this.nudgeTimer.unref();
  }

  // Once the attached session is idle and nothing was typed into it for attach.idleMinutes,
  // detach and return to a fresh dashboard.
  async maybeReturnToDashboard() {
    if (this.autoReturning) return;
    const attached = this.store.get('attached');
    if (!attached) return;
    const session = this.attachedSession();
    if (!session) return;
    const minutes = Number(this.cfg.attach?.idleMinutes ?? 10);
    if (!(minutes > 0)) return;
    if (session.status === 'working' || session.status === 'blocked' || session.status === 'background' || session.turn) return;
    if (session.kind === 'shell' && session.note) return;
    const lastInputAt = Number(attached.lastInputAt);
    if (!Number.isFinite(lastInputAt) || lastInputAt <= 0) {
      this.touchAttached(session);
      return;
    }
    if (Date.now() - lastInputAt < minutes * 60000) return;
    this.autoReturning = true;
    try {
      log('info', 'attach.auto_return', { session: session.name, idleMinutes: minutes });
      await this.detach();
      await this.sendDashboard();
    } finally {
      this.autoReturning = false;
    }
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      await this.liveCards.tick(now);
      // Turn cards change with the agent's output; between outputs only the elapsed time moves.
      for (const [key, view] of this.views) {
        const session = this.registry.sessions.get(key);
        if (!session?.turn || !view.messageId) continue;
        const minute = Math.floor((now - session.turn.startedAt) / 60000);
        if (minute === view.minute) continue;
        view.minute = minute;
        this.feishu.updater.schedule(view.messageId, this.renderTurn(session, 'working'));
      }
      await this.maybeReturnToDashboard();
    } catch (err) {
      log('error', 'router.tick', { message: err.message });
    } finally {
      this.ticking = false;
    }
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
}
