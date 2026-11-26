import * as cards from './cards.mjs';
import { lookupConversation, recentConversations } from './history.mjs';
import { handleBotMenu, handleCardAction } from './router/actions.mjs';
import { parseCommand, runCommand, saveResources } from './router/commands.mjs';
import { createControlApi } from './router/control-api.mjs';
import { LiveCardManager } from './router/live-cards.mjs';
import { autoTrust, createSession, handoff, newSessionForm, renameSessionBoth } from './router/sessions.mjs';
import { findDialog } from './screen.mjs';
import * as realTmux from './tmux.mjs';
import { fmtDuration, log, oneLine, sleep } from './util.mjs';

const MEDIA_ONLY = new Set(['image', 'file', 'audio', 'media', 'video', 'sticker']);
const TICK_MS = 3000;

// Decides where each chat message and card click goes, and turns session events into cards.
export class Router {
  constructor({ feishu, registry, concierge = null, store, cfg, tmux = realTmux, history = { recentConversations, lookupConversation }, ops = null, gpu = null }) {
    Object.assign(this, { feishu, registry, concierge, store, cfg, tmux, history, ops, gpu });
    this.liveCards = new LiveCardManager(this);
    this.live = this.liveCards.entries;
    this.reusable = this.liveCards.reusable;
    this.rootSessions = this.liveCards.rootSessions;
    this.sessionRoots = this.liveCards.sessionRoots;
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
    this.pendingCompletions = new Map(Object.entries(store.get('pendingCompletions') || {}));
    this.completing = new Set();
    this.sessionSubscribers = new Map();
    this.sessionUpdateId = 0;
    this.subscribeSession('thread', (event, session, ...args) => {
      const handlers = {
        output: this.outputThread,
        status: this.statusThread,
        blocked: this.blockedThread,
        turn_end: this.finishTurn,
        removed: this.removeThread,
      };
      return handlers[event]?.call(this, session, ...args);
    });
    this.subscribeSession('dashboard', (event) =>
      (event === 'output' ? this.nudge() : this.refreshDashboard(event, { throwOnError: true })));
    this.api = createControlApi(this);
  }

  subscribeSession(name, listener) {
    this.sessionSubscribers.set(name, listener);
    return () => { if (this.sessionSubscribers.get(name) === listener) this.sessionSubscribers.delete(name); };
  }

  async publishSession(event, session, ...args) {
    const update = { updateId: ++this.sessionUpdateId, change: event, session: session.name, status: session.status };
    log('info', 'session.update', update);
    return Promise.allSettled([...this.sessionSubscribers].map(async ([subscriber, listener]) => {
      try {
        await listener(event, session, ...args);
        log('info', 'session.updated', { ...update, subscriber });
      } catch (err) {
        log('error', 'session.update_failed', { ...update, subscriber, message: err.message });
        throw err;
      }
    }));
  }

  wire() {
    const guard = (name, fn) => (...args) => Promise.resolve(fn.apply(this, args))
      .catch((err) => log('error', `router.${name}`, { message: err.message, stack: err.stack }));
    this.registry.on('output', guard('output', this.onOutput));
    this.registry.on('status', guard('status', this.onStatus));
    this.registry.on('blocked', guard('blocked', this.onBlocked));
    this.registry.on('turn_end', guard('turn_end', this.onTurnEnd));
    this.registry.on('removed', guard('removed', this.onRemoved));
    this.registry.on('changed', () => this.nudge());
    this.registry.on('task_update', () => this.nudge());
    this.registry.on('replaced', (session) => {
      for (const map of [this.views, this.blocked, this.follows]) map.delete(session.key);
      this.oneShot.delete(session.key);
      this.promised.delete(session.key);
      for (const entry of this.live.values()) if (entry.key === session.key) entry.frozen = null;
      for (const [id, finished] of this.finished) if (finished.key === session.key) this.finished.delete(id);
    });
    this.feishu.updater.onError = (messageId) => this.liveCards.forget(messageId);
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
    if (value?.s?.startsWith('session:')) return this.registry.sessions.get(value.s) || null;
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

  async notifyThread(session, text, rootId) {
    const id = await this.feishu.sendText(this.chatId, text, { replyTo: rootId, replyInThread: true });
    if (session) this.store.rememberMessage(id, session.key);
    return id;
  }

  // ---- delegates to sub-modules ----

  reuseCard(slot, card, key, opts, fresh = false) { return this.liveCards.reuseCard(slot, card, key, opts, fresh); }
  sessionCard(session, card) { return this.liveCards.sessionCard(session, card); }
  sessionRoot(session) { return this.liveCards.sessionRoot(session); }
  postThreadCard(session, card) { return this.liveCards.postThreadCard(session, card); }
  boundSession(messageId) { return this.liveCards.boundSession(messageId); }
  refreshDashboard(reason, opts) { return this.liveCards.refreshDashboard(reason, opts); }
  sendDashboard() { return this.liveCards.sendDashboard(); }
  sendPeek(session) { return this.liveCards.sendPeek(session); }
  sendTerminal(session) { return this.liveCards.sendTerminal(session); }
  sendTasks(session) { return this.liveCards.sendTasks(session); }
  onCardAction(evt) { return handleCardAction(this, evt); }
  onBotMenu(evt) { return handleBotMenu(this, evt); }
  newSessionForm(error) { return newSessionForm(this, error); }
  createSession(opts) { return createSession(this, opts); }
  renameSession(session, opts) { return renameSessionBoth(this, session, opts); }
  autoTrust(key, opts) { return autoTrust(this, key, opts); }
  handoff(opts) { return handoff(this, opts); }

  // ---- inbound chat messages ----

  async onMessage(msg) {
    try {
      if (msg.senderId !== this.cfg.owner.openId || msg.chatType !== 'p2p') {
        log('info', 'message.ignored', { messageId: msg.messageId, reason: msg.senderId !== this.cfg.owner.openId ? 'not_owner' : 'not_p2p' });
        return;
      }
      if (this.store.get('chatId') !== msg.chatId) this.store.set('chatId', msg.chatId);
      let text = MEDIA_ONLY.has(msg.rawContentType) ? '' : String(msg.content || '').trim();
      if (msg.rawContentType === 'audio') {
        await this.info('语音消息没有转发', '会话只收文字。用输入法键盘上的语音输入把话转成文字再发。');
        return;
      }
      const files = await saveResources(this, msg);
      if (files.length) text = [text, ...files.map((f) => `[附件] ${f}`)].filter(Boolean).join('\n');
      if (!text) {
        log('info', 'message.ignored', { messageId: msg.messageId, reason: 'empty_or_unsupported' });
        return;
      }

      const command = parseCommand(text, Boolean(this.store.get('attached')));
      if (command) {
        log('info', 'message.command', { messageId: msg.messageId, command: command.name });
        await runCommand(this, command, msg);
        return;
      }
      const quotedKey = this.boundSession(msg.replyToMessageId) || this.boundSession(msg.rootId)
        || (msg.threadId ? this.store.get('threadSessions')?.[msg.threadId] : null);
      const quoted = quotedKey ? this.registry.sessions.get(quotedKey) : null;
      if (quotedKey && !quoted) {
        await this.info('会话已删除', '这条回复没有发出。请从面板选择要继续的会话。');
        return;
      }
      if (quoted) {
        if (msg.threadId) {
          const bindings = new Map(Object.entries(this.store.get('threadSessions') || {}));
          bindings.set(msg.threadId, quoted.key);
          while (bindings.size > 400) bindings.delete(bindings.keys().next().value);
          this.store.set('threadSessions', Object.fromEntries(bindings));
        }
        await this.deliver(quoted, text, msg);
        return;
      }
      if (msg.threadId || msg.rootId || msg.replyToMessageId) {
        await this.info('无法定位回复会话', '这条回复没有发出。请从面板选择会话，在对应的新卡片中继续。');
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

  async deliver(session, text, msg, { typed = '' } = {}) {
    log('info', 'deliver.start', { messageId: msg?.messageId, session: session.name, status: session.status, dormant: Boolean(session.dormant) });
    if (session.status === 'blocked') {
      await this.showBlocked(session, '这个会话在等确认，消息**没有发出**。先选一项；要直接输入文字，用「屏幕」卡片里的输入框。');
      return false;
    }
    if (this.attachedKey() !== session.key) this.oneShot.add(session.key);
    const keys = !typed && session.kind === 'claude' && text.includes('\n') && this.tmux.canType(text);
    await this.tmux.sendText(session.key, text, { typed, keys });
    this.touchAttached(session);
    if (msg?.messageId) this.store.rememberMessage(msg.messageId, session.key);
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
      await this.postThreadCard(session, cards.terminalCard({ session, screen, attached: this.attachedKey() === session.key, live: 'off' }));
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
    view = { messageId: null, ready: null, minute: 0, identity: this.viewIdentity(session), turn: session.turn };
    this.views.set(session.key, view);
    view.ready = this.postThreadCard(session, this.renderTurn(session, 'working'))
      .then((id) => { view.messageId = id; view.rootId = this.reusable.get(`session:${session.key}`)?.id; this.persistViews(); })
      .catch((err) => {
        log('error', 'router.view', { message: err.message });
        if (this.views.get(session.key) === view) this.views.delete(session.key);
      });
    return view;
  }

  viewIdentity(session) {
    return JSON.stringify([session.kind, session.cwd, session.transcript]);
  }

  persistViews() {
    this.store.set('turnCards', Object.fromEntries([...this.views].filter(([, v]) => v.messageId)
      .map(([key, v]) => [key, { messageId: v.messageId, rootId: v.rootId, identity: v.identity, turn: v.turn }])));
  }

  persistCompletions() {
    this.store.set('pendingCompletions', Object.fromEntries(this.pendingCompletions));
  }

  async completeCard(session, messageId, card) {
    this.pendingCompletions.set(messageId, { key: session.key, card, attempts: 0, retryAt: 0 });
    this.persistCompletions();
    this.store.flush();
    await this.deliverCompletion(messageId);
  }

  async deliverCompletion(messageId) {
    const pending = this.pendingCompletions.get(messageId);
    if (!pending || this.completing.has(messageId)) return;
    this.completing.add(messageId);
    try {
      try {
        await this.feishu.updater.flush(messageId, pending.card, { throwOnError: true });
      } catch (err) {
        if (!/deleted|recalled|not found|expired|message does not exist/i.test(err.message || '')) throw err;
        await this.postCompletionReplacement(pending);
      }
      if (this.pendingCompletions.get(messageId) === pending) this.pendingCompletions.delete(messageId);
      this.persistCompletions();
      this.store.flush();
    } catch (err) {
      pending.attempts++;
      pending.retryAt = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(pending.attempts, 6));
      this.persistCompletions();
      throw err;
    } finally {
      this.completing.delete(messageId);
    }
  }

  postCompletionReplacement(pending) {
    const session = this.registry.sessions.get(pending.key);
    if (!session) throw new Error('会话已删除，无法恢复回复卡片。');
    return this.postThreadCard(session, pending.card);
  }

  onOutput(session, events) { return this.publishSession('output', session, events); }
  onStatus(session, previous) { return this.publishSession('status', session, previous); }
  onBlocked(session) { return this.publishSession('blocked', session); }
  onTurnEnd(session, turn) { return this.publishSession('turn_end', session, turn); }
  onRemoved(session) { return this.publishSession('removed', session); }

  outputThread(session, events) {
    if (!this.isFollowed(session)) return;
    if (session.status === 'blocked') return;
    if (!events.some((e) => e.type === 'text' || e.type === 'tool')) return;
    const view = this.ensureView(session);
    view.turn = session.turn;
    this.persistViews();
    return view.ready.then(() => {
      if (view.messageId && this.views.get(session.key) === view) this.feishu.updater.schedule(view.messageId, this.renderTurn(session, 'working'));
    });
  }

  async statusThread(session, previous) {
    if (previous === 'blocked') await this.closeBlocked(session, '已在终端处理');
    if (session.status === 'working' && this.isFollowed(session)) await this.ensureView(session).ready;
  }

  async blockedThread(session) {
    if (!this.isFollowed(session) && (!this.cfg.notify.enabled || this.cfg.notify.scope === 'followed' || this.localActive())) return;
    await this.showBlocked(session);
  }

  async showBlocked(session, hint) {
    const screen = await this.tmux.capture(session.key);
    const state = { dialog: findDialog(screen) || session.dialog, screen };
    const previous = this.blocked.get(session.key);
    if (previous) {
      state.messageId = previous.messageId;
      await this.feishu.updater.flush(state.messageId, cards.blockedCard({ session, ...state, hint }));
    } else {
      state.messageId = await this.postThreadCard(session, cards.blockedCard({ session, ...state, hint }));
    }
    this.blocked.set(session.key, state);
  }

  async closeBlocked(session, answered) {
    const state = this.blocked.get(session.key);
    if (!state) return;
    this.blocked.delete(session.key);
    await this.feishu.updater.flush(state.messageId, cards.blockedCard({ session, dialog: state.dialog, screen: state.screen, answered }));
  }

  async finishTurn(session, turn) {
    const followed = this.isFollowed(session);
    this.oneShot.delete(session.key);
    const view = this.views.get(session.key);
    this.views.delete(session.key);
    this.persistViews();
    const seconds = (turn.endedAt - turn.startedAt) / 1000;
    const long = seconds >= this.cfg.notify.minWorkSec;
    const promised = this.promised.delete(session.key);
    const empty = !turn.texts.length && !turn.tools;

    // A dialog that opened and closed while the agent was idle (the folder trust prompt) is not a turn.
    if (empty && !turn.worked) {
      if (view) await view.ready;
      if (view?.messageId) await this.completeCard(session, view.messageId, cards.stubCard(`${session.name}：已处理。`));
      return;
    }
    if (followed) {
      const done = this.renderTurn(session, 'done', turn);
      if (view) await view.ready;
      if (view?.messageId) await this.completeCard(session, view.messageId, done);
      else await this.postThreadCard(session, done);
      // An edit does not ring the phone. After a long turn, one short line does.
      if (view?.messageId && long && this.cfg.notify.enabled && this.cfg.notify.completionPing !== false && !this.localActive()) {
        const preview = oneLine(turn.texts.at(-1) || '', 60);
        const line = `**${session.name}** 已结束（${fmtDuration(seconds)}）${preview ? `：${preview}` : ''}`;
        await this.notifyThread(session, line, view.rootId || await this.sessionRoot(session))
          .catch((err) => log('warn', 'turn.ping', { message: err.message }));
      }
      return;
    }
    if (empty) return;
    const notify = this.cfg.notify.enabled && (
      (promised && this.cfg.notify.detachedCompletion !== false)
      || (!promised && this.cfg.notify.scope !== 'followed' && long && !this.localActive())
    );
    if (view) await view.ready;
    if (view?.messageId || notify) {
      const done = cards.finishedCard({ session, turn });
      const messageId = view?.messageId || await this.postThreadCard(session, done);
      if (view?.messageId) await this.completeCard(session, messageId, done);
      this.finished.set(messageId, { key: session.key, turn });
      while (this.finished.size > 40) this.finished.delete(this.finished.keys().next().value);
      if (notify && view?.messageId) {
        await this.notifyThread(session, `**${session.name}** 已结束（${fmtDuration(seconds)}）：${oneLine(turn.texts.at(-1) || '', 60)}`, view.rootId || await this.sessionRoot(session));
      }
    }
  }

  async removeThread(session) {
    this.views.delete(session.key);
    this.persistViews();
    for (const [id, pending] of this.pendingCompletions) if (pending.key === session.key) this.pendingCompletions.delete(id);
    this.persistCompletions();
    this.oneShot.delete(session.key);
    this.blocked.delete(session.key);
    this.follows.delete(session.key);
    this.promised.delete(session.key);
    if (this.attachedKey() === session.key) {
      this.store.set('attached', null);
      const card = cards.infoCard({ title: `会话 ${session.name} 已结束`, text: '已回到 Pi 管家。' });
      if (this.reusable.has(`session:${session.key}`)) await this.sessionCard(session, card);
      else await this.post(card);
    }
  }

  // ---- attach / detach ----

  async attach(session, { announce = true } = {}) {
    if (this.registry.activate) session = await this.registry.activate(session.key);
    const previous = this.attachedSession();
    if (previous && previous.key !== session.key) this.leaveSession(previous);
    this.promised.delete(session.key);
    this.store.set('attached', { key: session.key, name: session.name, lastInputAt: Date.now() });
    this.nudge();
    await this.refreshDashboard('attach');
    log('info', 'attach', { session: session.name });
    if (!announce) return;
    if (session.status === 'blocked') await this.showBlocked(session);
    else if (session.status === 'working') this.ensureView(session);
    else await this.sendPeek(session);
  }

  async detach() {
    const previous = this.attachedSession();
    if (previous) this.leaveSession(previous);
    this.store.set('attached', null);
    this.nudge();
  }

  leaveSession(session) {
    if (this.views.has(session.key) || session.status === 'working' || session.status === 'blocked') this.promised.add(session.key);
    // Keep the turn card so its final result can arrive as a silent edit after detaching.
  }

  // ---- lifecycle & ticker ----

  async resume() {
    this.liveCards.resume();
    const savedAttached = this.store.get('attached');
    if (savedAttached) {
      // A hub restart is not the owner walking away: give the attachment a fresh window.
      this.store.set('attached', { ...savedAttached, lastInputAt: Date.now() });
    }
    for (const [key, saved] of Object.entries(this.store.get('turnCards') || {})) {
      const session = this.registry.sessions.get(key);
      // Raw pane IDs can be reused after reboot; a transcript must also match.
      if (!session?.transcript || saved.identity !== this.viewIdentity(session)) continue;
      this.views.set(key, { ...saved, ready: Promise.resolve(), minute: 0 });
      if (session.status === 'idle') {
        const turn = {
          ...saved.turn,
          texts: [...(saved.turn?.texts || [])],
          tools: saved.turn?.tools || 0,
          startedAt: saved.turn?.startedAt || session.statusSince,
          endedAt: Date.now(),
          worked: true,
        };
        if (session.lastText && turn.texts.at(-1) !== session.lastText) turn.texts.push(session.lastText);
        await this.onTurnEnd(session, turn).catch((err) => log('error', 'turn.resume', { message: err.message }));
      }
    }
    const attached = this.attachedSession();
    if (attached?.status === 'working') this.ensureView(attached);
    // Startup configuration (especially filters) must be reflected immediately,
    // including when a previous update failure removed the panel from live tracking.
    await this.refreshDashboard('resume');
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
      for (const [id, pending] of this.pendingCompletions) {
        if (pending.retryAt <= now) {
          await this.deliverCompletion(id).catch((err) => log('warn', 'turn.retry', { message: err.message, messageId: id }));
        }
      }
      await this.liveCards.tick(now);
      // Turn cards change with the agent's output; between outputs only the elapsed time moves.
      for (const [key, view] of this.views) {
        const session = this.registry.sessions.get(key);
        if (!session?.turn || session.status !== 'working' || !this.isFollowed(session) || !view.messageId) continue;
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

  // Keep turn output intact; operational notices belong in the thread as text.
  async shutdown() {
    clearInterval(this.ticker);
    const pending = [];
    for (const [key, view] of this.views) {
      const session = this.registry.sessions.get(key);
      pending.push((async () => {
        await view.ready;
        if (!view.messageId) return;
        await this.feishu.updater.flush(view.messageId);
        const rootId = view.rootId || this.reusable.get(`session:${key}`)?.id;
        if (rootId) await this.notifyThread(session, `fmux 正在重启。${session?.name || '会话'} 的后续回复会继续发到此线程。`, rootId);
      })());
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
      view.ready = this.reuseCard('concierge', cards.conciergeCard({ state: 'working', ...view }))
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
    else await this.reuseCard('concierge', done);
  }
}
