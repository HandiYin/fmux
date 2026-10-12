import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// config.mjs reads these when it is loaded, so they are set before the imports below.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmux-setup-'));
process.env.FMUX_CONFIG = path.join(dir, 'config.json');
process.env.FMUX_SOCK = path.join(dir, 'no-daemon.sock');
const { loadConfig, readRawConfig, resolveSecret } = await import('../src/config.mjs');
const { NEEDS, createApp, pair, serviceUnit } = await import('../src/setup.mjs');

const quiet = () => {};

test('setup writes the app id, keeps the secret in its own file, and leaves the owner to pairing', async () => {
  let options;
  const registerApp = async (opts) => {
    options = opts;
    opts.onQRCodeReady({ url: 'https://example.invalid/qr', expireIn: 600 });
    return { client_id: 'cli_test', client_secret: 's3cret', user_info: { open_id: 'ou_scanner', tenant_brand: 'feishu' } };
  };
  const shown = [];
  await createApp({ registerApp, renderQr: (url, _opts, done) => done(`QR(${url})`), print: (line) => shown.push(line) });

  assert.deepEqual(options.addons, { scopes: { tenant: NEEDS.scopes }, events: { items: { tenant: ['im.message.receive_v1'] } }, callbacks: { items: ['card.action.trigger'] } });
  assert.equal(options.createOnly, true);
  assert.ok(shown.some((line) => line.includes('QR(https://example.invalid/qr)')));
  assert.ok(!shown.join('\n').includes('s3cret'), 'the secret is never printed');

  const raw = readRawConfig();
  assert.equal(raw.app.id, 'cli_test');
  assert.deepEqual(raw.owner, { openId: '', chatId: '' });
  assert.ok(!JSON.stringify(raw).includes('s3cret'), 'the secret is not in the config file');
  assert.equal(fs.statSync(raw.app.secret.path).mode & 0o777, 0o600);
  assert.equal(await resolveSecret(raw.app.secret), 's3cret');

  await assert.rejects(createApp({ registerApp, renderQr: quiet, print: quiet }), /already has the app cli_test/);
  await createApp({ force: true, registerApp, renderQr: quiet, print: quiet });
});

test('pair binds the sender of the first direct message and confirms in the chat', async () => {
  const sent = [];
  let options;
  let disconnected = false;
  const createChannel = (opts) => {
    options = opts;
    const handlers = [];
    return {
      on: (name, fn) => name === 'message' && handlers.push(fn),
      connect: async () => {
        setTimeout(() => {
          handlers.forEach((fn) => fn({ chatType: 'group', senderId: 'ou_other', chatId: 'oc_group', messageId: 'om_0' }));
          handlers.forEach((fn) => fn({ chatType: 'p2p', senderId: 'ou_me', chatId: 'oc_dm', messageId: 'om_1' }));
        }, 5);
      },
      send: async (to, input, sendOptions) => { sent.push([to, sendOptions.replyTo]); },
      disconnect: async () => { disconnected = true; },
    };
  };
  assert.equal(await pair({ createChannel, print: quiet }), 'ou_me');
  assert.equal(options.appId, 'cli_test');
  assert.equal(options.appSecret, 's3cret');
  assert.equal(options.policy.dmMode, 'open');
  assert.deepEqual(readRawConfig().owner, { openId: 'ou_me', chatId: 'oc_dm' });
  assert.deepEqual(sent, [['oc_dm', 'om_1']]);
  assert.equal(disconnected, true);
  assert.equal(loadConfig().owner.openId, 'ou_me');
});

test('pair gives up with a hint when no message arrives', async () => {
  const createChannel = () => ({ on: quiet, connect: async () => {}, send: async () => {}, disconnect: async () => {} });
  await assert.rejects(pair({ createChannel, print: quiet, timeoutMs: 20 }), /没有收到消息/);
});

test('the service unit runs this checkout with the given node and PATH', () => {
  const unit = serviceUnit({ node: '/opt/node/bin/node', root: '/srv/fmux', pathEnv: '/usr/bin:/bin', configPath: '' });
  assert.match(unit, /^ExecStart=\/opt\/node\/bin\/node \/srv\/fmux\/bin\/fmux\.mjs$/m);
  assert.match(unit, /^Environment=PATH=\/usr\/bin:\/bin$/m);
  assert.doesNotMatch(unit, /FMUX_CONFIG/);
  assert.match(serviceUnit({ configPath: '/etc/fmux.json' }), /^Environment=FMUX_CONFIG=\/etc\/fmux\.json$/m);
});
