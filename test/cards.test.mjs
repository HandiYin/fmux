import assert from 'node:assert/strict';
import test from 'node:test';
import * as cards from '../src/cards.mjs';
import { session } from './helpers.mjs';

const LIMIT = 28 * 1024; // Feishu rejects cards above about 30 KB

function check(card) {
  assert.equal(card.schema, '2.0');
  assert.equal(card.config.update_multi, true);
  assert.ok(card.header.title.content);
  const json = JSON.stringify(card);
  assert.ok(Buffer.byteLength(json) < LIMIT, `card is ${Buffer.byteLength(json)} bytes`);
  const walk = (el) => {
    if (el.tag === 'button') {
      assert.equal(el.behaviors[0].type, 'callback');
      assert.ok(el.behaviors[0].value.a, 'every button names an action');
    }
    for (const child of [...(el.elements || []), ...(el.columns || [])]) walk(child);
  };
  card.body.elements.forEach(walk);
  return json;
}

const long = '长文本 with `code` and **bold** '.repeat(2000);

test('every card is valid and stays under the size limit with very long content', () => {
  const s = session({ lastText: long, lastPrompt: long, title: 'x'.repeat(500) });
  const sessions = Array.from({ length: 30 }, (_, i) => session({ key: `%${i}`, name: `session_${i}`, lastText: long }));
  const turn = { startedAt: Date.now() - 65000, endedAt: Date.now(), texts: [long, long, long], tools: 12, lastTool: `Bash · ${long}` };
  const screen = Array.from({ length: 200 }, () => '宽'.repeat(300)).join('\n');
  const dialog = { numbered: true, question: 'Proceed?', options: Array.from({ length: 9 }, (_, i) => ({ key: String(i + 1), label: `option ${i} ${'y'.repeat(200)}`, selected: i === 0 })) };
  check(cards.dashboardCard({ sessions, attachedKey: '%3' }));
  check(cards.dashboardCard({ sessions: [], attachedKey: null }));
  check(cards.turnCard({ session: s, state: 'working', ...turn }));
  check(cards.turnCard({ session: s, state: 'done', ...turn }));
  check(cards.turnCard({ session: s, state: 'done', ...turn, texts: [] }));
  check(cards.finishedCard({ session: s, turn, replied: long }));
  check(cards.blockedCard({ session: s, dialog, screen }));
  check(cards.blockedCard({ session: s, dialog: null, screen, answered: 'Yes' }));
  check(cards.peekCard({ session: s, screen }));
  check(cards.attachedCard({ session: s }));
  check(cards.newSessionCard({ error: 'bad name' }));
  check(cards.newSessionCard({ conversations: Array.from({ length: 15 }, (_, i) => ({ agent: i % 2 ? 'codex' : 'claude', id: `id-${i}`, title: long, cwd: `/home/u/${'d'.repeat(200)}`, updatedAt: Date.now() })) }));
  check(cards.conciergeCard({ state: 'working', text: long, tools: 3, lastTool: 'bash · ls', startedAt: Date.now() }));
  check(cards.conciergeCard({ state: 'done', text: '', tools: 0, startedAt: Date.now(), endedAt: Date.now(), error: 'boom' }));
  check(cards.infoCard({ title: 't', text: 'x', buttons: [{ label: 'b', value: { a: 'dash' } }] }));
  check(cards.helpCard());
});

test('dashboard marks the attached session and offers detach on it', () => {
  const json = check(cards.dashboardCard({ sessions: [session(), session({ key: '%2', name: 'other', status: 'working' })], attachedKey: '%2' }));
  assert.match(json, /2\. other\*\* <text_tag color='green'>运行中<\/text_tag> <text_tag color='blue'>已接入/);
  assert.match(json, /"a":"attach","from":"dash","s":"%1"/);
  assert.doesNotMatch(json, /"a":"attach","from":"dash","s":"%2"/);
});

test('a screen that contains a code fence cannot break out of the code block', () => {
  const card = cards.peekCard({ session: session(), screen: 'before\n```\nafter' });
  assert.equal(card.body.elements[0].content.match(/```/g).length, 2);
});

test('a done turn keeps earlier text in a collapsed panel and the answer in the body', () => {
  const card = cards.turnCard({ session: session(), state: 'done', texts: ['step one', 'final answer'], tools: 0, startedAt: 0, endedAt: 1000 });
  assert.equal(card.body.elements[0].tag, 'collapsible_panel');
  assert.equal(card.body.elements[1].content, 'final answer');
});

test('the light: green while running, off when ended, orange when waiting', () => {
  const now = Date.now();
  assert.deepEqual(cards.light(session({ status: 'working', statusSince: now - 185000 }), now), { dot: '🟢', label: '运行中', color: 'green', detail: '已 3 分钟' });
  assert.equal(cards.light(session({ status: 'idle' }), now).label, '已结束');
  assert.equal(cards.light(session({ status: 'idle' }), now).dot, '⚪');
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
  for (const label of buttons.keys()) assert.match(label, /^[\p{L}\p{N} ]+$/u, `no emoji in "${label}"`);
  for (const token of Object.values(cards.ICON)) assert.match(token, /^[a-z0-9-]+_outlined$/);
});
