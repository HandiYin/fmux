import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, session } from './helpers.mjs';
import { Router } from '../src/router.mjs';
import { createFeishu } from '../src/feishu.mjs';

const turn = (seconds = 3, text = 'done') => ({ startedAt: Date.now() - seconds * 1000,
  endedAt: Date.now(), texts: [text], tools: 1, worked: true });
const stop = (t, router) => t.after(() => { clearTimeout(router.nudgeTimer); clearInterval(router.ticker); });

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
