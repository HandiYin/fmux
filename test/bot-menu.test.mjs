import assert from 'node:assert/strict';
import test from 'node:test';
import { BOT_MENU_EVENT, createBotMenuHandler } from '../src/bot-menu.mjs';
import { createFeishu } from '../src/feishu.mjs';
import { harness, OWNER, session } from './helpers.mjs';

const NOW = 1802740000000;
const event = (over = {}) => ({
  event_id: 'evt_menu_1', create_time: String(NOW), event_key: 'fmux.dashboard',
  operator: { operator_id: { open_id: OWNER } }, ...over,
});

test('menu events accept SDK payloads and v2 envelopes, rejecting strangers, stale events and retries', async () => {
  const received = [];
  const dispatch = createBotMenuHandler({ ownerOpenId: OWNER, now: () => NOW, onMenu: async (e) => received.push(e), onError: assert.fail });
  await dispatch(event());
  await dispatch(event());
  await dispatch(event({ event_id: 'stranger', operator: { operator_id: { open_id: 'ou_stranger' } } }));
  await dispatch(event({ event_id: 'missing-owner', operator: {} }));
  await dispatch(event({ event_id: 'stale', create_time: String(NOW - 301000) }));
  await dispatch(event({ event_id: 'invalid-time', create_time: 'invalid' }));
  await dispatch(event({ event_id: 'unknown', event_key: 'fmux.kill' }));
  await dispatch(null);
  await dispatch({
    schema: '2.0', header: { event_id: 'evt_menu_2', create_time: String(NOW), event_type: BOT_MENU_EVENT },
    event: { event_key: 'fmux.concierge', operator: { operator_id: { open_id: OWNER } } },
  });
  assert.deepEqual(received.map(({ key }) => key), ['fmux.dashboard', 'fmux.concierge']);
});

test('menu actions stay ordered and a failed delivery does not block later clicks', async () => {
  const actions = [], errors = [];
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const dispatch = createBotMenuHandler({
    ownerOpenId: OWNER, now: () => NOW,
    onMenu: async ({ key }) => {
      actions.push(key);
      if (key === 'fmux.dashboard') { await gate; throw new Error('delivery failed'); }
    },
    onError: (error) => errors.push(error.message),
  });
  const first = dispatch(event());
  const second = dispatch(event({ event_id: 'evt_menu_2', event_key: 'fmux.concierge' }));
  await Promise.resolve();
  assert.deepEqual(actions, ['fmux.dashboard']);
  finish();
  await Promise.all([first, second]);
  assert.deepEqual(actions, ['fmux.dashboard', 'fmux.concierge']);
  assert.deepEqual(errors, ['delivery failed']);
});

test('the Feishu adapter uses the existing channel and acknowledges without waiting for card delivery', async () => {
  let rawHandler, release;
  const gate = new Promise(resolve => { release = resolve; });
  const delivered = [];
  let channels = 0;
  const feishu = await createFeishu({
    appId: 'cli_test', appSecret: 'test-only', ownerOpenId: OWNER,
    createChannel: () => {
      channels++;
      return { on() {}, onRawEvent: (type, fn) => { assert.equal(type, BOT_MENU_EVENT); rawHandler = fn; } };
    },
  });
  feishu.onBotMenu(async (e) => { await gate; delivered.push(e.key); });
  const payload = event({ create_time: String(Date.now()) });
  assert.equal(rawHandler(payload), undefined);
  assert.equal(rawHandler(payload), undefined);
  assert.deepEqual(delivered, []);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(channels, 1);
  assert.deepEqual(delivered, ['fmux.dashboard']);
});

test('the menu opens a fresh panel while attached, including busy and blocked sessions', async () => {
  for (const status of ['idle', 'working', 'blocked']) {
    const h = harness({ sessions: [session({ status })] });
    h.store.set('attached', { key: '%1', name: 'work' });
    const click = () => h.feishu.menu({ key: 'fmux.dashboard', operator: { openId: OWNER } });
    await click();
    const firstId = h.cardsSent().at(-1).messageId;
    await click();
    assert.equal(h.titles().at(-1), '会话面板');
    assert.notEqual(h.cardsSent().at(-1).messageId, firstId);
    assert.equal(h.store.get('attached').key, '%1');
    assert.deepEqual(h.tmux.sent, []);
    assert.deepEqual(h.tmux.keys, []);
    assert.deepEqual(h.concierge.prompts, []);
    await h.router.shutdown();
  }
});

test('return to concierge detaches without stopping tmux; new session opens only a form', async () => {
  const h = harness();
  h.store.set('attached', { key: '%1', name: 'work' });
  const menu = (key, openId = OWNER) => h.feishu.menu({ key, operator: { openId } });
  await menu('fmux.concierge', 'ou_stranger');
  await menu('fmux.kill');
  assert.equal(h.store.get('attached').key, '%1');
  assert.equal(h.feishu.sent.length, 0);
  await menu('fmux.new');
  assert.equal(h.titles().at(-1), '新建会话');
  assert.equal(h.store.get('attached').key, '%1');
  assert.deepEqual(h.tmux.created, []);
  await menu('fmux.concierge');
  assert.equal(h.store.get('attached'), null);
  assert.equal(h.titles().at(-1), '会话面板');
  assert.equal(h.cardsSent().at(-1).card.header.subtitle.content, '消息发往 Pi 管家');
  assert.deepEqual(h.tmux.keys, []);
  assert.deepEqual(h.tmux.killed, []);
  await h.say('继续聊');
  assert.deepEqual(h.concierge.prompts, ['继续聊']);
  await h.router.shutdown();
});
