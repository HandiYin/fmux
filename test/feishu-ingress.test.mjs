import assert from 'node:assert/strict';
import test from 'node:test';
import { createFeishu } from '../src/feishu.mjs';
import { setLogSink } from '../src/util.mjs';

test('card updates surface API rejections instead of silently accepting stale content', async () => {
  let response = { code: 230011, msg: 'message does not exist' };
  let request;
  const api = await createFeishu({ appId: 'cli_test', appSecret: 'unused', ownerOpenId: 'ou_owner',
    createChannel: () => ({ on() {}, onRawEvent() {}, rawClient: { im: { v1: { message: {
      patch: async (value) => { request = value; return response; },
    } } } } }),
  });
  await assert.rejects(api.updateCard('om_panel', { schema: '2.0' }), /230011.*message does not exist/);
  assert.equal(request.path.message_id, 'om_panel');
  assert.deepEqual(JSON.parse(request.data.content), { schema: '2.0' });
  response = { code: 0 };
  await api.updateCard('om_panel', {});
});

test('ingress diagnostics trace event and handler stages without recording message bodies', async (t) => {
  const lines = [];
  setLogSink((line) => lines.push(JSON.parse(line)));
  t.after(() => setLogSink(() => {}));
  const rawHandlers = new Map();
  const handlers = new Map();
  let options;
  const api = await createFeishu({ appId: 'cli_test', appSecret: 'secret-must-not-log', ownerOpenId: 'ou_owner',
    createChannel: (value) => { options = value; return { on: (name, fn) => handlers.set(name, fn), onRawEvent: (name, fn) => rawHandlers.set(name, fn) }; },
  });
  const msg = { messageId: 'om_test', chatId: 'oc_test', rawContentType: 'text', content: 'private message must not log' };
  let received;
  api.onMessage(async (value) => { received = value; });
  rawHandlers.get('im.message.receive_v1')({ message: { message_id: msg.messageId, chat_id: msg.chatId, message_type: 'text', content: msg.content } });
  await handlers.get('message')(msg);
  assert.equal(received, msg);
  assert.deepEqual(lines.map((l) => l.event), ['feishu.message_event', 'feishu.message_received']);
  assert.doesNotMatch(JSON.stringify(lines), /private message|secret-must-not-log/);
  assert.equal(options.safety.batch.text.maxMessages, 1);
  assert.equal(options.safety.batch.text.delayMs, 0);
  assert.equal(options.safety.chatQueue.cardActions, 'separate');
});
