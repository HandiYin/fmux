import assert from 'node:assert/strict';
import test from 'node:test';
import { CHAT, harness, session } from './helpers.mjs';

const ref = { s: '%1', n: 'work' };
const turn = (seconds, over = {}) => ({ startedAt: Date.now() - seconds * 1000, endedAt: Date.now(), texts: ['all done'], tools: 2, lastTool: 'Bash', worked: true, ...over });

test('a stranger can neither talk nor click', async () => {
  const h = harness();
  await h.say('rm -rf /', { senderId: 'ou_stranger' });
  await h.say('hello group', { chatType: 'group' });
  const reply = await h.click({ a: 'key', k: 'enter', ...ref }, { operator: { openId: 'ou_stranger' } });
  assert.equal(reply.toast.type, 'error');
  assert.deepEqual(h.tmux.sent, []);
  assert.deepEqual(h.tmux.keys, []);
  assert.deepEqual(h.concierge.prompts, []);
  assert.equal(h.feishu.sent.length, 0);
});

test('detached: text goes to the concierge', async () => {
  const h = harness();
  await h.say('现在有哪些会话');
  assert.deepEqual(h.concierge.prompts, ['现在有哪些会话']);
  assert.deepEqual(h.tmux.sent, []);
  assert.equal(h.heads()[0], 'Pi 管家 [运行中]');
});

test('attached: text goes to the session, its slash commands too, // stays with the hub', async () => {
  const h = harness();
  const reply = await h.click({ a: 'attach', from: 'dash', ...ref });
  assert.equal(reply.toast.content, '已接入 work');
  assert.equal(reply.card.data.header.title.content, '会话面板');
  await h.say('跑测试');
  await h.say('/compact');
  assert.deepEqual(h.tmux.sent, [['%1', '跑测试'], ['%1', '/compact']]);
  assert.deepEqual(h.concierge.prompts, []);

  await h.say('//pi 帮我看看磁盘');
  assert.deepEqual(h.concierge.prompts, ['帮我看看磁盘']);
  await h.say('//d');
  await h.say('之后的话');
  assert.equal(h.tmux.sent.length, 2);
  assert.deepEqual(h.concierge.prompts, ['帮我看看磁盘', '之后的话']);
});

test('text commands resolve a session by number or prefix', async () => {
  const h = harness({ sessions: [session(), session({ key: '%2', name: 'zeta', tmuxSession: 'zeta' })] });
  await h.say('/a 2');
  assert.equal(h.store.get('attached').name, 'zeta');
  await h.say('//a wo');
  assert.equal(h.store.get('attached').name, 'work');
  await h.say('//nonsense');
  assert.equal(h.titles().at(-1), 'fmux 用法');
});

test('a blocked session holds the message back and shows the dialog', async () => {
  const dialogScreen = ' Do you want to proceed?\n ❯ 1. Yes\n   2. No\n';
  const h = harness({ sessions: [session({ status: 'blocked' })] });
  h.tmux.screens.set('%1', dialogScreen);
  h.store.set('attached', { key: '%1', name: 'work' });
  await h.say('继续');
  assert.deepEqual(h.tmux.sent, []);
  assert.equal(h.heads().at(-1), 'work [等待确认 Claude]');

  const reply = await h.click({ a: 'pick', i: 1, l: 'No', ...ref });
  assert.deepEqual(h.tmux.keys, [['%1', ['2']]]);
  assert.equal(reply.card.data.header.text_tag_list[0].text.content, '已处理');

  h.tmux.screens.set('%1', ' Overwrite file?\n ❯ 1. Overwrite\n   2. Keep\n');
  const stale = await h.click({ a: 'pick', i: 0, l: 'Yes', ...ref });
  assert.equal(stale.toast.type, 'warning');
  assert.equal(h.tmux.keys.length, 1);
});

test('followed short turn: one card, edited in place', async () => {
  const s = session({ status: 'working', turn: { startedAt: Date.now(), texts: [], tools: 0 } });
  const h = harness({ sessions: [s] });
  h.store.set('attached', { key: '%1', name: 'work' });
  await h.router.onStatus(s, 'idle');
  await h.router.views.get('%1').ready;
  assert.equal(h.cardsSent().length, 1);
  const liveId = h.cardsSent()[0].messageId;

  s.status = 'idle';
  await h.router.onTurnEnd(s, turn(3));
  assert.equal(h.cardsSent().length, 1);
  const last = h.feishu.sent.at(-1);
  assert.equal(last.kind, 'update');
  assert.equal(last.messageId, liveId);
  assert.equal(h.head(last), 'work [已结束 Claude]');
  assert.equal(h.router.views.size, 0);
});

test('followed long turn: the answer arrives as a new card', async () => {
  const s = session({ status: 'working', turn: { startedAt: Date.now(), texts: [], tools: 0 } });
  const h = harness({ sessions: [s] });
  h.store.set('attached', { key: '%1', name: 'work' });
  await h.router.onStatus(s, 'idle');
  await h.router.views.get('%1').ready;
  await h.router.onTurnEnd(s, turn(90));
  assert.equal(h.cardsSent().length, 2);
  assert.equal(h.cardsSent()[1].card.header.subtitle.content, '用时 1m30s');
  assert.equal(h.cardsSent()[1].card.body.elements[0].content, 'all done');
});

test('unattached sessions notify only after a long turn and only when the keyboard is idle', async () => {
  const s = session();
  const h = harness({ sessions: [s] });
  await h.router.onTurnEnd(s, turn(5));
  assert.equal(h.feishu.sent.length, 0);

  h.registry.localActiveAt = Date.now();
  await h.router.onTurnEnd(s, turn(90));
  assert.equal(h.feishu.sent.length, 0);

  h.registry.localActiveAt = Date.now() - 600000;
  await h.router.onTurnEnd(s, turn(90));
  assert.deepEqual(h.heads(), ['work [已结束 Claude]']);
  await h.router.onBlocked(s);
  assert.equal(h.heads().at(-1), 'work [等待确认 Claude]');
});

test('quote-reply and the reply form reach a session without attaching', async () => {
  const s = session();
  const h = harness({ sessions: [s] });
  await h.router.onTurnEnd(s, turn(90));
  const finishedId = h.cardsSent()[0].messageId;

  await h.say('再跑一遍', { replyToMessageId: finishedId });
  assert.deepEqual(h.tmux.sent, [['%1', '再跑一遍']]);
  assert.equal(h.store.get('attached'), null);
  assert.equal(h.router.isFollowed(s), true);

  const reply = await h.click({ a: 'reply', ...ref }, { messageId: finishedId, action: { value: { a: 'reply', ...ref }, formValue: { text: '好' } } });
  assert.deepEqual(h.tmux.sent.at(-1), ['%1', '好']);
  assert.equal(reply.toast.content, '已发送');
  assert.match(JSON.stringify(reply.card.data), /已回复：好/);
});

test('keys are limited to the whitelist', async () => {
  const h = harness();
  const bad = await h.click({ a: 'key', k: 'rm -rf', ...ref });
  assert.equal(bad.toast.type, 'error');
  await h.click({ a: 'key', k: 'esc', ...ref });
  assert.deepEqual(h.tmux.keys, [['%1', ['esc']]]);
});

test('attached session that disappeared: the message is not lost silently', async () => {
  const h = harness({ sessions: [] });
  h.store.set('attached', { key: '%9', name: 'gone' });
  await h.say('还在吗');
  assert.equal(h.store.get('attached'), null);
  assert.equal(h.titles().at(-1), '会话 gone 不在了');
  assert.deepEqual(h.concierge.prompts, []);
});

test('kill needs the session to exist and ends the tmux session', async () => {
  const h = harness();
  const reply = await h.click({ a: 'kill', ...ref });
  assert.deepEqual(h.tmux.killed, ['work']);
  assert.match(reply.card.data.header.title.content, /已结束/);
  const missing = await h.click({ a: 'kill', s: '%7', n: 'nope' });
  assert.equal(missing.toast.type, 'error');
});

test('all posts go to the owner chat', async () => {
  const h = harness();
  await h.say('/ls');
  assert.ok(h.cardsSent().every((r) => r.chatId === CHAT));
});

test('leaving a session in the middle of a turn still announces its result', async () => {
  const s = session({ status: 'working', turn: { startedAt: Date.now(), texts: [], tools: 0 } });
  const h = harness({ sessions: [s] });
  h.store.set('attached', { key: '%1', name: 'work' });
  await h.router.onStatus(s, 'idle');
  await h.router.views.get('%1').ready;
  await h.router.detach();
  h.registry.localActiveAt = Date.now();
  await h.router.onTurnEnd(s, turn(3));
  assert.equal(h.heads().at(-1), 'work [已结束 Claude]');
  assert.match(JSON.stringify(h.cardsSent().at(-1).card), /"a":"reply"/);
});

test('a dialog answered while the agent was idle does not post an empty turn', async () => {
  const s = session();
  const h = harness({ sessions: [s] });
  h.store.set('attached', { key: '%1', name: 'work' });
  await h.router.onTurnEnd(s, { startedAt: Date.now(), endedAt: Date.now(), texts: [], tools: 0 });
  assert.equal(h.feishu.sent.length, 0);
});

test('the word 面板 brings up the dashboard, attached or not', async () => {
  const h = harness();
  await h.say('面板');
  h.store.set('attached', { key: '%1', name: 'work' });
  await h.say('面板');
  await h.say('看一下面板的代码');
  assert.deepEqual(h.titles().filter((t) => t === '会话面板').length, 2);
  assert.deepEqual(h.tmux.sent, [['%1', '看一下面板的代码']]);
});

test('a voice message is not forwarded', async () => {
  const h = harness();
  h.store.set('attached', { key: '%1', name: 'work' });
  await h.say('', { rawContentType: 'audio', resources: [{ type: 'audio', fileKey: 'file_x' }] });
  assert.deepEqual(h.tmux.sent, []);
  assert.equal(h.titles().at(-1), '语音消息没有转发');
});

test('the dashboard is edited in place when a session changes, and only then', async () => {
  const s = session();
  const h = harness({ sessions: [s] });
  await h.say('/ls');
  const id = h.cardsSent()[0].messageId;
  await h.router.tick();
  assert.equal(h.feishu.sent.filter((r) => r.kind === 'update').length, 0);

  s.status = 'working';
  s.statusSince = Date.now();
  h.registry.signature = 'changed';
  await h.router.tick();
  await h.feishu.updater.flush(id);
  const card = h.latest(id).card;
  assert.match(JSON.stringify(card), /🟢 \*\*1\. work\*\* <text_tag color='green'>运行中/);
  assert.equal(card.header.subtitle.content, '1 个会话 · 1 个运行中');
});

test('a second dashboard takes over and the first one says it stopped', async () => {
  const h = harness();
  await h.say('/ls');
  await h.say('/ls');
  const [first, second] = h.cardsSent().map((r) => r.messageId);
  await new Promise((r) => setTimeout(r, 20));
  assert.match(JSON.stringify(h.latest(first).card), /已停止更新/);
  assert.deepEqual([...h.router.live.keys()], [second]);
});

test('the attached card follows the session and closes on detach', async () => {
  const s = session({ lastText: 'old reply' });
  const h = harness({ sessions: [s] });
  await h.click({ a: 'attach', ...ref });
  const id = h.cardsSent().find((r) => r.card.header.title.content === '已接入 work').messageId;
  assert.equal(h.head(h.latest(id)), '已接入 work [已结束 Claude]');

  s.status = 'working';
  s.statusSince = Date.now();
  s.lastText = 'new reply';
  await h.router.tick();
  await h.feishu.updater.flush(id);
  assert.equal(h.head(h.latest(id)), '已接入 work [运行中 Claude]');
  assert.match(JSON.stringify(h.latest(id).card), /new reply/);

  await h.router.detach();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.latest(id).card.header.title.content, '已断开 work');
  assert.equal(h.router.live.size, 0);
});

test('a screen card refreshes while the screen changes and stops after its time', async () => {
  const s = session();
  const h = harness({ sessions: [s] });
  h.tmux.screens.set('%1', 'line one');
  await h.say('//peek work');
  const id = h.cardsSent()[0].messageId;
  await h.router.tick();
  assert.equal(h.feishu.sent.filter((r) => r.kind === 'update').length, 0, 'an unchanged screen is not sent again');

  h.tmux.screens.set('%1', 'line one\nline two');
  await h.router.tick();
  await h.feishu.updater.flush(id);
  assert.match(h.latest(id).card.body.elements[0].content, /line two/);
  assert.match(JSON.stringify(h.latest(id).card), /自动刷新中/);

  h.router.live.get(id).until = Date.now() - 1;
  await h.router.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.match(JSON.stringify(h.latest(id).card), /自动刷新已停止/);
  assert.equal(h.router.live.size, 0);

  const reply = await h.click({ a: 'peek.refresh', ...ref }, { messageId: id });
  assert.match(JSON.stringify(reply.card.data), /自动刷新中/);
  assert.equal(h.router.live.size, 1);
});

test('live cards survive a restart', async () => {
  const h = harness();
  await h.say('/ls');
  const id = h.cardsSent()[0].messageId;
  const again = harness();
  again.store.set('live', h.store.get('live'));
  again.router.resume();
  assert.deepEqual([...again.router.live.keys()], [id]);
  await again.router.tick();
  await again.feishu.updater.flush(id);
  assert.equal(again.latest(id).card.header.title.content, '会话面板');
  clearInterval(again.router.ticker);
});

test('the new-session form offers past conversations, and resuming one takes its agent and directory', async () => {
  const h = harness();
  await h.say('//new');
  const form = JSON.stringify(h.cardsSent()[0].card);
  assert.match(form, /恢复：Claude · 生产GT代码检查/);
  assert.match(form, /"value":"codex:22222222-aaaa-bbbb-cccc-000000000002"/);

  const submit = (formValue) => h.click({ a: 'new.submit' }, { messageId: 'om_form', action: { value: { a: 'new.submit' }, formValue } });
  await submit({ name: 'gt_old', resume: 'claude:11111111-aaaa-bbbb-cccc-000000000001', agent: 'shell', cwd: '/nonexistent' });
  assert.deepEqual(h.tmux.created.at(-1), { name: 'gt_old', cwd: '/tmp', command: 'claude -d -r 11111111-aaaa-bbbb-cccc-000000000001' });
  assert.equal(h.store.get('attached').name, 'gt_old');

  await submit({ name: 'ssh_old', resume: 'codex:22222222-aaaa-bbbb-cccc-000000000002', prompt: "what's next" });
  assert.deepEqual(h.tmux.created.at(-1), { name: 'ssh_old', cwd: '/usr', command: "codex --yolo resume 22222222-aaaa-bbbb-cccc-000000000002 'what'\\''s next'" });
});

test('new conversation, continue the latest, and the errors', async () => {
  const h = harness();
  const submit = (formValue) => h.click({ a: 'new.submit' }, { messageId: 'om_form', action: { value: { a: 'new.submit' }, formValue } });
  await submit({ name: 'fresh', resume: 'new', agent: 'claude', cwd: '/tmp' });
  assert.deepEqual(h.tmux.created.at(-1), { name: 'fresh', cwd: '/tmp', command: 'claude -d -n fresh' });
  await submit({ name: 'again', resume: 'last', agent: 'codex', cwd: '/tmp' });
  assert.equal(h.tmux.created.at(-1).command, 'codex --yolo resume --last');
  await submit({ name: 'plain_claude', resume: 'new', agent: 'claude', cwd: '/tmp', yolo: 'no' });
  assert.equal(h.tmux.created.at(-1).command, 'claude -n plain_claude');
  await submit({ name: 'plain_codex', resume: 'codex:22222222', agent: 'claude', yolo: 'no' });
  assert.equal(h.tmux.created.at(-1).command, 'codex resume 22222222-aaaa-bbbb-cccc-000000000002');
  assert.deepEqual(await h.router.api.new({ name: 'by_title', resume: 'GT代码', attach: false }).then((r) => r.name), 'by_title');
  assert.equal(h.tmux.created.at(-1).command, 'claude -d -r 11111111-aaaa-bbbb-cccc-000000000001');

  const count = h.tmux.created.length;
  for (const bad of [
    { name: 'x1', resume: 'claude:99999999', agent: 'claude', cwd: '/tmp' },
    { name: 'x2', resume: 'last', agent: 'shell', cwd: '/tmp' },
    { name: 'x3', resume: 'new', agent: 'claude', cwd: '/no/such/dir' },
    { name: 'fresh', resume: 'new', agent: 'claude', cwd: '/tmp' },
  ]) {
    const reply = await submit(bad);
    assert.match(JSON.stringify(reply.card.data), /❌/, JSON.stringify(bad));
  }
  assert.equal(h.tmux.created.length, count);
});

test('the folder trust prompt of a new Claude session is answered, other dialogs are not', async () => {
  const h = harness();
  h.tmux.screens.set('%1', ' Is this a project you trust?\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n');
  assert.equal(await h.router.autoTrust('%1', { tries: 2, everyMs: 1 }), true);
  assert.deepEqual(h.tmux.keys, [['%1', ['down', 'enter']]]);

  h.tmux.screens.set('%1', ' Do you want to proceed?\n ❯ 1. Yes\n   2. No\n');
  assert.equal(await h.router.autoTrust('%1', { tries: 2, everyMs: 1 }), false);
  assert.equal(h.tmux.keys.length, 1);
});

test('sessions are found by a loose name; a name that fits several asks which one', async () => {
  const sessions = [
    session({ key: '%1', name: 'gt_collection', tmuxSession: 'gt_collection', title: '' }),
    session({ key: '%2', name: 'gt_process', tmuxSession: 'gt_process', title: '生产GT代码检查' }),
    session({ key: '%3', name: 'handibot', tmuxSession: 'handibot', kind: 'shell', status: 'shell', cwd: '/home/u' }),
  ];
  const h = harness({ sessions });
  const found = (text) => h.registry.lookup(text).match?.name;
  assert.equal(found('process'), 'gt_process');
  assert.equal(found('gtproc'), 'gt_process');
  assert.equal(found('GT Process'), 'gt_process');
  assert.equal(found('代码检查'), 'gt_process');
  assert.equal(found('coll'), 'gt_collection');
  assert.equal(found('hbot'), 'handibot');
  assert.equal(found('shell'), 'handibot');
  assert.equal(found('2'), 'gt_process');
  assert.equal(found('nothing-like-it'), undefined);
  assert.deepEqual(h.registry.lookup('gt').candidates.map((s) => s.name), ['gt_collection', 'gt_process']);

  await h.say('/a gt');
  const ask = h.cardsSent().at(-1).card;
  assert.match(ask.header.title.content, /「gt」对上了 2 个会话/);
  assert.match(JSON.stringify(ask), /"a":"attach","s":"%2","n":"gt_process"/);
  assert.equal(h.store.get('attached'), null);

  await h.say('/a 采集');
  assert.equal(h.titles().at(-1), '找不到会话');
  await h.say('/a collect');
  assert.equal(h.store.get('attached').name, 'gt_collection');

  await assert.rejects(h.router.api.attach({ ref: 'gt' }), /fits several sessions: gt_collection, gt_process/);
  await assert.rejects(h.router.api.peek({ ref: 'zzz' }), /no session fits "zzz". Sessions: gt_collection, gt_process, handibot/);
  assert.equal((await h.router.api.peek({ ref: 'proc' })).name, 'gt_process');
});
