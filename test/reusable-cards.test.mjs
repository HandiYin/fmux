import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, session } from './helpers.mjs';
import { Router } from '../src/router.mjs';
import { createFeishu } from '../src/feishu.mjs';
import { setLogSink } from '../src/util.mjs';

const turn = (seconds = 3, text = 'done') => ({ startedAt: Date.now() - seconds * 1000,
  endedAt: Date.now(), texts: [text], tools: 1, worked: true });
const stop = (t, router) => t.after(() => { clearTimeout(router.nudgeTimer); clearInterval(router.ticker); });

test('a deleted response card is replaced in the existing thread, without a new root', async (t) => {
  const s = session();
  const h = harness({ sessions: [s], notify: { completionPing: false } });
  stop(t, h.router);
  await h.router.attach(s);
  const root = h.cardsSent()[0].messageId;
  s.status = 'working'; s.turn = turn(1, 'progress');
  await h.router.onStatus(s, 'idle');
  const id = h.router.views.get(s.key).messageId;
  const update = h.feishu.updater.update;
  h.feishu.updater.update = async (messageId, card) => {
    if (messageId === id) throw new Error('message does not exist');
    return update(messageId, card);
  };
  s.status = 'idle';
  await h.router.onTurnEnd(s, turn(1, 'final'));
  const replacement = h.cardsSent().at(-1);
  assert.notEqual(replacement.messageId, id);
  assert.equal(replacement.replyTo, root);
  assert.equal(replacement.replyInThread, true);
  assert.equal(h.cardsSent().filter((r) => !r.replyInThread).length, 1);
  assert.deepEqual(h.store.get('pendingCompletions'), {});
});

test('connecting a dormant session acknowledges the card before restoration finishes', async (t) => {
  const s = session({ dormant: true });
  const h = harness({ sessions: [s] });
  stop(t, h.router);
  let release;
  h.registry.activate = () => new Promise((resolve) => { release = () => { s.dormant = false; resolve(s); }; });
  const attach = h.router.attach.bind(h.router);
  let attached;
  h.router.attach = (...args) => (attached = attach(...args));
  const result = await h.click({ a: 'attach', s: s.key, n: s.name });
  assert.match(result.toast.content, /正在恢复/);
  assert.equal(h.router.attachedKey(), null);
  release();
  await attached;
  assert.equal(h.router.attachedKey(), s.key);
  assert.deepEqual(h.tmux.sent, []);
});

test('one status update refreshes both the thread and dashboard without a changed event or timer', async (t) => {
  const s = session();
  const h = harness({ sessions: [s] });
  stop(t, h.router);
  await h.router.sendDashboard();
  const dashboard = h.cardsSent()[0].messageId;
  await h.router.attach(s, { announce: false });
  s.status = 'working';
  s.turn = { startedAt: Date.now(), texts: ['working'], tools: 0 };
  await h.router.onStatus(s, 'idle');
  assert.match(h.latest(dashboard).card.body.elements[0].content, /运行中/);
  assert.equal(h.latest(h.router.views.get(s.key).messageId).card.header.template, 'green');
  s.status = 'blocked';
  await h.router.onStatus(s, 'working');
  assert.match(h.latest(dashboard).card.body.elements[0].content, /等待确认/);
  s.status = 'idle';
  s.lastText = 'done';
  await h.router.onTurnEnd(s, turn());
  assert.match(h.latest(dashboard).card.body.elements[0].content, /已结束/);
});

test('a slow thread subscriber does not delay the dashboard subscriber', async (t) => {
  const s = session();
  const h = harness({ sessions: [s] });
  stop(t, h.router);
  await h.router.sendDashboard();
  const id = h.cardsSent()[0].messageId;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const unsubscribe = h.router.subscribeSession('thread', () => gate);
  s.status = 'working';
  const update = h.router.onStatus(s, 'idle');
  await new Promise(setImmediate);
  assert.match(h.latest(id).card.body.elements[0].content, /运行中/);
  release();
  await update;
  unsubscribe();
  assert.equal(h.router.sessionSubscribers.has('thread'), false);
});

test('subscriber failures are isolated and identify the failing callback', async (t) => {
  const logs = [];
  setLogSink((line) => logs.push(JSON.parse(line)));
  t.after(() => setLogSink(() => {}));
  const s = session();
  const h = harness({ sessions: [s] });
  stop(t, h.router);
  await h.router.sendDashboard();
  const id = h.cardsSent()[0].messageId;
  h.router.subscribeSession('thread', () => { throw new Error('thread failed'); });
  s.status = 'working';
  const results = await h.router.onStatus(s, 'idle');
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'fulfilled']);
  assert.equal(results[0].reason.message, 'thread failed');
  const failure = logs.find((l) => l.event === 'session.update_failed');
  const success = logs.find((l) => l.event === 'session.updated');
  assert.equal(failure.subscriber, 'thread');
  assert.equal(success.subscriber, 'dashboard');
  assert.equal(failure.updateId, success.updateId);
  assert.equal(failure.change, 'status');
  assert.match(h.latest(id).card.body.elements[0].content, /运行中/);
  h.router.subscribeSession('thread', () => {});
  h.feishu.updater.update = async () => { throw new Error('dashboard failed'); };
  const failed = await h.router.onStatus(s, 'idle');
  assert.deepEqual(failed.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.equal(failed[1].reason.message, 'dashboard failed');
});

test('restart notices are plain thread messages and preserve the running reply card', async (t) => {
  const s = session({ status: 'working', turn: { startedAt: Date.now(), texts: ['progress so far'], tools: 1 } });
  const h = harness({ sessions: [s] });
  stop(t, h.router);
  await h.router.attach(s);
  const view = h.router.views.get(s.key);
  await view.ready;
  const original = h.latest(view.messageId).card;
  const count = h.cardsSent().length;
  await h.router.shutdown();
  assert.deepEqual(h.latest(view.messageId).card, original);
  assert.equal(h.cardsSent().length, count);
  const notice = h.feishu.sent.filter((r) => r.kind === 'text').at(-1);
  assert.equal(notice.replyTo, view.rootId);
  assert.equal(notice.replyInThread, true);
  assert.match(notice.text, /正在重启.*后续回复会继续发到此线程/);
});

test('a quiet unfollowed completion immediately refreshes the dashboard even with an unchanged registry signature', async (t) => {
  const s = session({ status: 'working' });
  const h = harness({ sessions: [s], notify: { scope: 'followed', completionPing: false } });
  stop(t, h.router);
  await h.router.sendDashboard();
  const id = h.cardsSent()[0].messageId;
  assert.match(JSON.stringify(h.latest(id).card), /运行中/);
  s.status = 'idle';
  s.lastText = 'finished';
  await h.router.onTurnEnd(s, turn());
  assert.doesNotMatch(JSON.stringify(h.latest(id).card.body), /运行中/);
  assert.match(JSON.stringify(h.latest(id).card), /已结束/);
  assert.equal(h.cardsSent().length, 1);
  assert.equal(h.feishu.sent.filter((r) => r.kind === 'text').length, 0);
});

for (const liveTracking of [true, false]) {
  test(`restart immediately refreshes the existing panel with filtered sessions (live tracking: ${liveTracking})`, async (t) => {
    const h = harness();
    stop(t, h.router);
    await h.router.sendDashboard();
    const id = h.cardsSent()[0].messageId;
    assert.match(JSON.stringify(h.latest(id).card), /work/);
    // The daemon has already polled using the newly loaded include/exclude settings.
    h.registry.sessions.clear();
    h.store.set('attached', null);
    if (!liveTracking) h.store.set('live', []);
    const restarted = new Router({ feishu: h.feishu, registry: h.registry, store: h.store, cfg: h.cfg, tmux: h.tmux });
    stop(t, restarted);
    await restarted.resume();
    assert.equal(h.cardsSent().length, 1, 'restart edits the saved panel without posting another');
    assert.doesNotMatch(JSON.stringify(h.latest(id).card), /work/);
    assert.deepEqual([...restarted.live.keys()], [id]);
  });
}

test('session controls remain intact while progress, confirmations and later turns stay in its thread', async (t) => {
  const s = session();
  const h = harness({ sessions: [s] });
  stop(t, h.router);
  await h.router.attach(s);
  const id = h.cardsSent()[0].messageId;
  const originalRoot = h.latest(id).card;
  s.status = 'working';
  await h.router.onStatus(s, 'idle');
  await h.router.views.get(s.key).ready;
  const firstTurn = h.router.views.get(s.key).messageId;
  assert.notEqual(firstTurn, id);
  assert.equal(h.head(h.latest(firstTurn)), 'work [运行中 Claude]');
  s.status = 'blocked';
  h.tmux.screens.set(s.key, ' Proceed?\n ❯ 1. Yes\n   2. No\n');
  await h.router.onBlocked(s);
  const prompt = h.router.blocked.get(s.key);
  assert.equal(h.head(h.latest(prompt.messageId)), 'work [等待确认 Claude]');
  s.status = 'working';
  await h.router.onStatus(s, 'blocked');
  await h.router.views.get(s.key).ready;
  s.status = 'idle';
  await h.router.onTurnEnd(s, turn());
  assert.match(JSON.stringify(h.latest(firstTurn).card), /done/);
  await h.say('next request');
  s.status = 'working';
  await h.router.onStatus(s, 'idle');
  await h.router.views.get(s.key).ready;
  const secondTurn = h.router.views.get(s.key).messageId;
  assert.notEqual(secondTurn, firstTurn);
  s.status = 'idle';
  await h.router.onTurnEnd(s, turn(3, 'next result'));
  assert.equal(h.cardsSent().filter((r) => !r.replyInThread).length, 1);
  assert.ok(h.cardsSent().filter((r) => r.replyInThread).every((r) => r.replyTo === id));
  assert.match(JSON.stringify(h.latest(secondTurn).card), /next result/);
  assert.deepEqual(h.latest(id).card, originalRoot, 'task output never replaces the root input form');
  assert.ok(h.latest(firstTurn).card.body.elements.some((el) => el.tag === 'form'));
});

test('concurrent card creation is serialized into one root', async (t) => {
  const h = harness();
  stop(t, h.router);
  const s = h.registry.list()[0];
  const ids = await Promise.all(['first', 'second', 'third'].map((text) => h.router.sessionCard(s, { text })));
  assert.equal(new Set(ids).size, 1);
  assert.equal(h.cardsSent().length, 1);
  assert.deepEqual(h.latest(ids[0]).card, { text: 'third' });
});

test('a hub restart reuses the root and creates the next turn inside its existing thread', async (t) => {
  const h = harness();
  stop(t, h.router);
  const s = h.registry.list()[0];
  await h.router.attach(s);
  const id = h.cardsSent()[0].messageId;
  const restarted = new Router({ feishu: h.feishu, registry: h.registry, store: h.store, cfg: h.cfg, tmux: h.tmux });
  stop(t, restarted);
  s.status = 'working';
  await restarted.onStatus(s, 'idle');
  await restarted.views.get(s.key).ready;
  await restarted.onTurnEnd(s, turn());
  assert.equal(h.cardsSent().filter((r) => !r.replyInThread).length, 1);
  const child = h.cardsSent().find((r) => r.replyInThread);
  assert.equal(child.replyTo, id);
  assert.match(JSON.stringify(h.latest(child.messageId).card), /done/);
  assert.ok(h.latest(id).card.body.elements.some((el) => el.tag === 'form'));
});

test('muted background completions do not replace session controls or post unsolicited thread updates', async (t) => {
  const h = harness({ notify: { scope: 'followed', detachedCompletion: false } });
  stop(t, h.router);
  const s = h.registry.list()[0];
  const id = await h.router.sendPeek(s);
  await h.router.onTurnEnd(s, turn(90));
  assert.equal(h.cardsSent().length, 1);
  assert.doesNotMatch(JSON.stringify(h.latest(id).card), /done/);
  assert.equal(h.feishu.sent.filter((r) => r.kind === 'text').length, 0);
});

test('background completion notifications share the root card thread', async (t) => {
  const h = harness();
  stop(t, h.router);
  const s = h.registry.list()[0];
  await h.router.onTurnEnd(s, turn(90));
  await h.router.onTurnEnd(s, turn(90, 'second result'));
  const id = h.cardsSent()[0].messageId;
  assert.equal(h.cardsSent().filter((r) => !r.replyInThread).length, 1);
  const alerts = h.cardsSent().filter((r) => r.replyInThread);
  assert.equal(alerts.length, 2);
  assert.ok(alerts.every((r) => r.replyTo === id && r.replyInThread === true));
  assert.ok(alerts.every((r) => h.store.sessionKeyFor(r.messageId) === s.key));
});

test('explicit terminal views reuse their own card without multiplying session cards', async (t) => {
  const h = harness();
  stop(t, h.router);
  const s = h.registry.list()[0];
  const main = await h.router.sendPeek(s);
  const terminal = await h.router.sendTerminal(s);
  assert.equal(await h.router.sendTerminal(s), terminal);
  assert.equal(await h.router.sendPeek(s), main);
  assert.equal(h.cardsSent().length, 2);
});

test('concierge replies reuse their card on later requests', async (t) => {
  const h = harness();
  stop(t, h.router);
  await h.router.askConcierge('first');
  await h.router.onPiEnd({});
  await h.router.askConcierge('second');
  await h.router.onPiEnd({});
  assert.equal(h.cardsSent().length, 1);
});

test('expired or deleted roots are replaced, but transient update failures never create duplicates', async (t) => {
  const h = harness();
  stop(t, h.router);
  const s = h.registry.list()[0];
  const original = await h.router.sessionCard(s, { text: 'original' });
  const update = h.feishu.updater.update;
  h.feishu.updater.update = async () => { throw new Error('HTTP 429: retry later'); };
  await assert.rejects(h.router.sessionCard(s, { text: 'retry' }), /429/);
  assert.equal(h.cardsSent().length, 1);
  assert.equal(h.router.reusable.get(`session:${s.key}`).id, original);
  h.feishu.updater.update = async () => { throw new Error('message deleted'); };
  const replacement = await h.router.sessionCard(s, { text: 'replacement' });
  assert.notEqual(replacement, original);
  assert.equal(h.cardsSent().length, 2);
  h.feishu.updater.update = update;
  h.router.reusable.get(`session:${s.key}`).createdAt = Date.now() - 14 * 86400000;
  const renewed = await h.router.sessionCard(s, { text: 'renewed' });
  assert.notEqual(renewed, replacement);
  assert.equal(h.cardsSent().length, 3);
});

test('the Feishu adapter requests actual thread messages, not ordinary quoted replies', async () => {
  const sent = [];
  const api = await createFeishu({ appId: 'cli_test', appSecret: 'test', ownerOpenId: 'ou_owner',
    createChannel: () => ({ on() {}, onRawEvent() {}, send: async (...args) => { sent.push(args); return { messageId: 'om_alert' }; } }),
  });
  await api.sendText('oc_chat', 'done', { replyTo: 'om_root', replyInThread: true });
  assert.deepEqual(sent[0][2], { replyTo: 'om_root', replyInThread: true });
  await api.sendCard('oc_chat', { text: 'result' }, { replyTo: 'om_root', replyInThread: true });
  assert.deepEqual(sent[1][2], { replyTo: 'om_root', replyInThread: true });
});

test('root input, result input and thread messages route to their session despite a different attachment', async (t) => {
  const s = session();
  const other = session({ key: '%2', name: 'other', tmuxSession: 'other' });
  const h = harness({ sessions: [s, other] });
  stop(t, h.router);
  const root = await h.router.sendPeek(s);
  h.store.set('attached', { key: other.key, name: other.name });
  const action = { a: 'reply', s: s.key, n: s.name };
  await h.click(action, { messageId: root, action: { value: action, formValue: { text: 'root input' } } });
  s.status = 'working';
  await h.router.onStatus(s, 'idle');
  await h.router.views.get(s.key).ready;
  const child = h.router.views.get(s.key).messageId;
  s.status = 'idle';
  await h.router.onTurnEnd(s, turn());
  await h.click(action, { messageId: child, action: { value: action, formValue: { text: 'result input' } } });
  await h.say('thread follow up', { replyToMessageId: child, rootId: root, threadId: 'omt_session' });
  await h.say('reply to user message', { replyToMessageId: 'unknown-parent', rootId: root, threadId: 'omt_session' });
  await h.say('thread only', { threadId: 'omt_session' });
  assert.deepEqual(h.tmux.sent, ['root input', 'result input', 'thread follow up', 'reply to user message', 'thread only'].map((text) => [s.key, text]));
  assert.equal(h.store.get('attached').key, other.key);
});

test('persistent roots still route messages after the recent-message cache is evicted', async (t) => {
  const h = harness();
  stop(t, h.router);
  const s = h.registry.list()[0];
  const root = await h.router.sendPeek(s);
  for (let i = 0; i < 450; i++) h.store.rememberMessage(`other-${i}`, 'another-session');
  assert.equal(h.store.sessionKeyFor(root), null);
  await h.say('late thread reply', { rootId: root, replyToMessageId: 'old-parent' });
  assert.deepEqual(h.tmux.sent, [[s.key, 'late thread reply']]);
});

test('renewed roots retain old thread routing after cache eviction and a hub restart', async (t) => {
  const s = session();
  const other = session({ key: '%2', name: 'other', tmuxSession: 'other' });
  const h = harness({ sessions: [s, other] });
  stop(t, h.router);
  const oldRoot = await h.router.sendPeek(s);
  h.router.reusable.get(`session:${s.key}`).createdAt = Date.now() - 14 * 86400000;
  const newRoot = await h.router.sendPeek(s);
  assert.notEqual(newRoot, oldRoot);
  for (let i = 0; i < 450; i++) h.store.rememberMessage(`other-${i}`, other.key);
  h.store.set('attached', { key: other.key, name: other.name });
  const restarted = new Router({ feishu: h.feishu, registry: h.registry, store: h.store, cfg: h.cfg, tmux: h.tmux });
  stop(t, restarted);
  await restarted.onMessage({ senderId: h.cfg.owner.openId, chatId: h.cfg.owner.chatId, chatType: 'p2p',
    messageId: 'om_late_reply', content: 'continue original task', rawContentType: 'text',
    rootId: oldRoot, replyToMessageId: 'old-child', threadId: 'omt_old_thread' });
  assert.deepEqual(h.tmux.sent, [[s.key, 'continue original task']]);
  assert.equal(h.store.get('attached').key, other.key);
});

test('unresolved thread and quote targets never fall through to the attachment or concierge', async (t) => {
  const h = harness();
  stop(t, h.router);
  const s = h.registry.list()[0];
  for (const attached of [null, { key: s.key, name: s.name }]) {
    h.store.set('attached', attached);
    for (const context of [{ rootId: 'unknown-root' }, { threadId: 'unknown-thread' }, { replyToMessageId: 'unknown-parent' }]) {
      await h.say('private follow up', context);
      assert.match(JSON.stringify(h.cardsSent().at(-1).card), /无法定位回复会话/);
    }
  }
  assert.deepEqual(h.tmux.sent, []);
  assert.deepEqual(h.concierge.prompts, []);
});

test('detached tasks finish by editing their own thread card, without touching the root', async (t) => {
  const h = harness({ notify: { scope: 'followed', detachedCompletion: false } });
  stop(t, h.router);
  const s = h.registry.list()[0];
  await h.router.attach(s);
  const root = h.cardsSent()[0].messageId;
  const original = h.latest(root).card;
  s.status = 'working';
  await h.router.onStatus(s, 'idle');
  await h.router.views.get(s.key).ready;
  const child = h.router.views.get(s.key).messageId;
  await h.router.detach();
  s.status = 'idle';
  await h.router.onTurnEnd(s, turn());
  assert.equal(h.cardsSent().length, 2);
  assert.match(JSON.stringify(h.latest(child).card), /done/);
  assert.deepEqual(h.latest(root).card, original);
  assert.equal(h.feishu.sent.filter((r) => r.kind === 'text').length, 0);
});

test('persisted thread routing survives a restart when only the thread ID is present', async (t) => {
  const s = session();
  const other = session({ key: '%2', name: 'other' });
  const h = harness({ sessions: [s, other] });
  stop(t, h.router);
  const root = await h.router.sendPeek(s);
  h.store.set('attached', { key: other.key, name: other.name });
  await h.say('before restart', { rootId: root, threadId: 'omt_persisted' });
  const restarted = new Router({ feishu: h.feishu, registry: h.registry, store: h.store, cfg: h.cfg, tmux: h.tmux });
  stop(t, restarted);
  await restarted.onMessage({ senderId: h.cfg.owner.openId, chatId: h.cfg.owner.chatId, chatType: 'p2p',
    threadId: 'omt_persisted', messageId: 'om_after_restart', content: 'after restart', rawContentType: 'text' });
  assert.deepEqual(h.tmux.sent, [[s.key, 'before restart'], [s.key, 'after restart']]);
});

test('a deleted thread root is replaced once and updates go under the replacement', async (t) => {
  const h = harness();
  stop(t, h.router);
  const s = h.registry.list()[0];
  const oldRoot = await h.router.sendPeek(s);
  const send = h.feishu.sendCard;
  h.feishu.sendCard = async (chatId, card, opts) => {
    if (opts?.replyTo === oldRoot) throw new Error('message deleted');
    return send(chatId, card, opts);
  };
  const child = await h.router.postThreadCard(s, { text: 'result' });
  const root = h.router.reusable.get(`session:${s.key}`).id;
  assert.notEqual(root, oldRoot);
  assert.equal(h.cardsSent().filter((r) => !r.replyInThread).length, 2);
  const posted = h.cardsSent().find((r) => r.messageId === child);
  assert.equal(posted.replyTo, root);
  assert.equal(posted.replyInThread, true);
});

test('card input acknowledges immediately while session restoration is still pending', async (t) => {
  const h = harness();
  stop(t, h.router);
  const s = h.registry.list()[0];
  const root = await h.router.sendPeek(s);
  let release;
  let delivered = false;
  h.tmux.sendText = async () => { await new Promise((resolve) => { release = resolve; }); delivered = true; };
  t.after(() => release?.());
  const action = { a: 'reply', s: s.key, n: s.name };
  const ack = await Promise.race([
    h.click(action, { messageId: root, action: { value: action, formValue: { text: 'resume and continue' } } }),
    new Promise((resolve) => setImmediate(() => resolve(null))),
  ]);
  assert.ok(ack, 'callback must return before the delayed terminal operation');
  assert.equal(ack.toast.content, '已接收，正在发送');
  assert.equal(delivered, false);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered, true);
});

test('failed asynchronous card input reports its failure in the session thread', async (t) => {
  const h = harness();
  stop(t, h.router);
  const s = h.registry.list()[0];
  const root = await h.router.sendPeek(s);
  const original = h.latest(root).card;
  h.tmux.sendText = async () => { throw new Error('session restoration failed'); };
  const action = { a: 'reply', s: s.key, n: s.name };
  const ack = await h.click(action, { messageId: root, action: { value: action, formValue: { text: 'continue' } } });
  assert.equal(ack.toast.content, '已接收，正在发送');
  await new Promise((resolve) => setImmediate(resolve));
  const report = h.cardsSent().find((r) => r.replyInThread);
  assert.equal(report.replyTo, root);
  assert.match(JSON.stringify(report.card), /session restoration failed/);
  assert.deepEqual(h.latest(root).card, original);
});
