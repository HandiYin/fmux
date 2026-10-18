import assert from 'node:assert/strict';
import test from 'node:test';
import * as cards from '../src/cards.mjs';
import { session } from './helpers.mjs';

const LIMIT = 28 * 1024; // Feishu rejects cards above about 30 KB

function check(card) {
  assert.equal(card.schema, '2.0');
  assert.equal(card.config.update_multi, true);
  const json = JSON.stringify(card);
  assert.ok(Buffer.byteLength(json) < LIMIT, `card is ${Buffer.byteLength(json)} bytes`);
  const walk = (el) => {
    assert.ok(el && typeof el === 'object', 'no empty element');
    if (el.tag === 'button') {
      assert.equal(el.behaviors[0].type, 'callback');
      assert.ok(el.behaviors[0].value.a, 'every button names an action');
    }
    for (const child of [...(el.elements || []), ...(el.columns || [])]) walk(child);
  };
  card.body.elements.forEach(walk);
  return json;
}

const buttonsOf = (card) => {
  const out = [];
  const walk = (el) => {
    if (el.tag === 'button') out.push(el.text.content);
    for (const child of [...(el.elements || []), ...(el.columns || [])]) walk(child);
  };
  card.body.elements.forEach(walk);
  return out;
};

const long = '长文本 with `code` and **bold** '.repeat(2000);

test('an unbound Codex reply explains the missing identity instead of claiming there was no answer', () => {
  const s = session({ kind: 'codex', transcript: null, lastText: '' });
  const turn = { texts: [], tools: 0, startedAt: 0, endedAt: 1000 };
  for (const card of [cards.turnCard({ session: s, state: 'done', ...turn }), cards.finishedCard({ session: s, turn })]) {
    const json = check(card);
    assert.match(json, /未定位到此会话的回复/);
    assert.doesNotMatch(json, /这一轮没有文字回复/);
    assert.ok(buttonsOf(card).some((label) => label.includes('终端')));
  }
});

test('every card is valid and stays under the size limit with very long content', () => {
  const s = session({ lastText: long, lastPrompt: long, title: 'x'.repeat(500) });
  const sessions = Array.from({ length: 30 }, (_, i) => session({ key: `%${i}`, name: `session_${i}`, lastText: long }));
  const turn = { startedAt: Date.now() - 65000, endedAt: Date.now(), texts: [long, long, long], tools: 12, lastTool: `Bash · ${long}` };
  const screen = Array.from({ length: 200 }, () => '宽'.repeat(300)).join('\n');
  const dialog = { numbered: true, question: 'Proceed?', options: Array.from({ length: 9 }, (_, i) => ({ key: String(i + 1), label: `option ${i} ${'y'.repeat(200)}`, selected: i === 0 })) };
  for (const card of [
    cards.dashboardCard({ sessions, attachedKey: '%3' }),
    cards.dashboardCard({ sessions: [], attachedKey: null }),
    cards.turnCard({ session: s, state: 'working', ...turn }),
    cards.turnCard({ session: s, state: 'done', ...turn }),
    cards.turnCard({ session: s, state: 'done', ...turn, texts: [] }),
    cards.finishedCard({ session: s, turn, replied: long }),
    cards.blockedCard({ session: s, dialog, screen }),
    cards.blockedCard({ session: s, dialog: null, screen, answered: 'Yes' }),
    cards.terminalCard({ session: s, screen }),
    cards.sessionCard({ session: s, attached: true }),
    cards.sessionCard({ session: s, live: 'off' }),
    cards.newSessionCard({ error: 'bad name' }),
    cards.newSessionCard({ conversations: Array.from({ length: 15 }, (_, i) => ({ agent: i % 2 ? 'codex' : 'claude', id: `id-${i}`, title: long, cwd: `/home/u/${'d'.repeat(200)}`, updatedAt: Date.now() })) }),
    cards.conciergeCard({ state: 'working', text: long, tools: 3, lastTool: 'bash · ls', startedAt: Date.now() }),
    cards.conciergeCard({ state: 'done', text: '', tools: 0, startedAt: Date.now(), endedAt: Date.now(), error: 'boom' }),
    cards.infoCard({ title: 't', text: 'x', buttons: [{ label: 'b', value: { a: 'dash' } }] }),
    cards.helpCard(),
    cards.stubCard(long),
  ]) check(card);
});

test('dashboard: one light and one line for each session, attach or detach, nothing else', () => {
  const card = cards.dashboardCard({ sessions: [session({ lastText: 'said this' }), session({ key: '%2', name: 'other', status: 'working' })], attachedKey: '%2' });
  const json = check(card);
  assert.match(json, /⚪ \*\*work\*\*　已结束 · \d\d:\d\d 结束\\n<font color='grey'>Claude · said this/);
  assert.match(json, /🟢 \*\*other\*\*　运行中 · 已 不到 1 分钟　<font color='blue'>已接入<\/font>/);
  assert.equal(card.header.subtitle.content, '消息发往 other');
  assert.equal(card.header.template, 'default');
  assert.deepEqual(buttonsOf(card), ['接入', '查看', '断开', '查看', '新建会话']);
  assert.match(json, /"a":"attach","from":"dash","s":"%1"/);
  assert.equal(cards.dashboardCard({ sessions: [session({ status: 'blocked' })], attachedKey: null }).header.template, 'orange');
});

test('a screen that contains a code fence cannot break out of the code block', () => {
  const card = cards.terminalCard({ session: session(), screen: 'before\n```\nafter' });
  assert.equal(card.body.elements[0].content.match(/```/g).length, 2);
});

test('the terminal card is cut for a phone and shows four keys until the fold is opened', () => {
  const wide = Array.from({ length: 60 }, (_, i) => `line ${i}${' '.repeat(80)}right`).join('\n');
  const card = cards.terminalCard({ session: session({ kind: 'shell', status: 'shell' }), screen: wide });
  const lines = card.body.elements[0].content.split('\n').slice(1, -1);
  assert.equal(lines.length, 18);
  assert.equal(lines.at(-1), 'line 59  right');
  assert.deepEqual(card.body.elements[1].columns.map((c) => c.elements[0].text.content), ['⏎', 'Esc', '↑', '↓']);
  assert.equal(card.body.elements[2].tag, 'collapsible_panel');
  assert.equal(card.body.elements[2].expanded, false);
});

test('a finished reply carries no buttons; a running one can be interrupted', () => {
  const s = session();
  const turn = { texts: ['answer'], tools: 2, lastTool: 'Bash', startedAt: 0, endedAt: 65000 };
  const done = cards.turnCard({ session: s, state: 'done', ...turn });
  assert.deepEqual(buttonsOf(done), []);
  assert.equal(done.header.template, 'default');
  assert.equal(done.header.subtitle.content, '用时 1m05s · 工具调用 2 次');
  const running = cards.turnCard({ session: s, state: 'working', ...turn, startedAt: Date.now() });
  assert.deepEqual(buttonsOf(running), ['中断', '终端']);
  assert.equal(running.header.template, 'green');
  assert.deepEqual(buttonsOf(cards.turnCard({ session: s, state: 'done', ...turn, texts: [] })), ['终端']);
});

test('color is kept for running and for waiting', () => {
  const tones = (over) => cards.sessionCard({ session: session(over) }).header.template;
  assert.equal(tones({ status: 'idle' }), 'default');
  assert.equal(tones({ status: 'working' }), 'green');
  assert.equal(tones({ status: 'blocked' }), 'orange');
  assert.equal(cards.stubCard('x').header, undefined);
});

test('a done turn keeps earlier text in a collapsed panel and the answer in the body', () => {
  const card = cards.turnCard({ session: session(), state: 'done', texts: ['step one', 'final answer'], tools: 0, startedAt: 0, endedAt: 1000 });
  assert.equal(card.body.elements[0].tag, 'collapsible_panel');
  assert.equal(card.body.elements[1].content, 'final answer');
  assert.equal(card.body.elements.length, 2);
});

test('the light: green while running, off when ended, orange when waiting', () => {
  const now = Date.now();
  assert.deepEqual(cards.light(session({ status: 'working', statusSince: now - 185000 }), now), { dot: '🟢', label: '运行中', color: 'green', detail: '已 3 分钟' });
  assert.equal(cards.light(session({ status: 'idle', lastText: 'x' }), now).label, '已结束');
  assert.equal(cards.light(session({ status: 'idle', lastText: 'x' }), now).dot, '⚪');
  assert.equal(cards.light(session({ status: 'idle' }), now).label, '空闲', 'nothing was asked yet');
  assert.equal(cards.light(session({ status: 'blocked' }), now).color, 'orange');
  assert.equal(cards.light(session({ kind: 'shell', status: 'shell', note: 'python3' }), now).label, '运行中');
  assert.equal(cards.light(session({ kind: 'shell', status: 'shell' }), now).label, '空闲');
  assert.equal(cards.fmtElapsed(59000), '不到 1 分钟');
  assert.equal(cards.fmtElapsed(3900000), '1 小时 5 分');
});

test('buttons use icons from the Feishu library, not emoji', () => {
  const buttons = new Map();
  const walk = (el) => {
    if (el.tag === 'button') buttons.set(el.text.content, el);
    for (const child of [...(el.elements || []), ...(el.columns || [])]) walk(child);
  };
  cards.dashboardCard({ sessions: [session()], attachedKey: null }).body.elements.forEach(walk);
  assert.deepEqual(buttons.get('接入').icon, { tag: 'standard_icon', token: 'connect_outlined' });
  assert.deepEqual(buttons.get('查看').icon, { tag: 'standard_icon', token: 'visible_outlined' });
  assert.equal(buttons.get('接入').type, 'primary');
  assert.equal(buttons.get('接入').size, 'small');
  for (const label of buttons.keys()) assert.match(label, /^[\p{L}\p{N} ]+$/u, `no emoji in "${label}"`);
  for (const token of Object.values(cards.ICON)) assert.match(token, /^[a-z0-9-]+_outlined$/);
});
