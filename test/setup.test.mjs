import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// config.mjs reads these when it is loaded, so they are set before the imports below.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmux-setup-'));
process.env.FMUX_CONFIG = path.join(dir, 'config.json');
process.env.FMUX_SOCK = path.join(dir, 'no-daemon.sock');
const { isPipe, loadConfig, readRawConfig, resolveSecret, socketPath } = await import('../src/config.mjs');
const { NEEDS, createApp, pair, useExistingApp } = await import('../src/setup.mjs');
const { hubBatch, hubCommand, launchdPlist, serviceCommands, serviceEnv, serviceUnit, startupBatch, startupFile } = await import('../src/service.mjs');

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
  assert.ok(options.addons.scopes.tenant.every((scope) => !scope.startsWith('application:')), 'optional menu management must not add application permissions to basic setup');
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
  const unit = serviceUnit({ node: '/opt/node/bin/node', root: '/srv/fmux', env: { PATH: '/usr/bin:/bin' } });
  assert.match(unit, /^ExecStart=\/opt\/node\/bin\/node \/srv\/fmux\/bin\/fmux\.mjs$/m);
  assert.match(unit, /^Environment=PATH=\/usr\/bin:\/bin$/m);
  assert.doesNotMatch(unit, /FMUX_CONFIG/);
  assert.match(serviceUnit({ env: { PATH: '/bin', FMUX_CONFIG: '/etc/fmux.json' } }), /^Environment=FMUX_CONFIG=\/etc\/fmux\.json$/m);
});

test('a unit value with spaces is quoted: a WSL PATH carries Windows directories', () => {
  const unit = serviceUnit({ node: '/opt/my node/node', root: '/srv/fmux', env: { PATH: '/usr/bin:/mnt/c/Program Files (x86)/Git/cmd:/mnt/c/100%' } });
  assert.match(unit, /^ExecStart="\/opt\/my node\/node" \/srv\/fmux\/bin\/fmux\.mjs$/m);
  assert.ok(unit.includes('Environment="PATH=/usr/bin:/mnt/c/Program Files (x86)/Git/cmd:/mnt/c/100%%"'));
});

test('the service takes PATH and the FMUX_ variables from the shell that installs it', () => {
  const env = serviceEnv({ PATH: '/usr/bin', FMUX_CONFIG: '/c.json', FMUX_SOCK: '/s.sock', HOME: '/home/x' });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.FMUX_CONFIG, '/c.json');
  assert.equal(env.FMUX_SOCK, '/s.sock');
  assert.equal(env.HOME, undefined);
});

test('the launchd job runs this checkout, restarts, and has a PATH and a UTF-8 locale', () => {
  const plist = launchdPlist({ node: '/opt/homebrew/bin/node', root: '/Users/me/fmux', env: { PATH: '/opt/homebrew/bin:/usr/bin', LANG: 'en_US.UTF-8', FMUX_CONFIG: '/Users/me/a&b.json' }, logFile: '/Users/me/Library/Logs/fmux.log', home: '/Users/me' });
  assert.ok(plist.includes('<key>Label</key><string>com.primatix.fmux</string>'));
  assert.ok(plist.includes('<array><string>/opt/homebrew/bin/node</string><string>/Users/me/fmux/bin/fmux.mjs</string></array>'));
  assert.ok(plist.includes('<key>KeepAlive</key><true/>'));
  assert.ok(plist.includes('<key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>'));
  assert.ok(plist.includes('<key>LANG</key><string>en_US.UTF-8</string>'));
  assert.ok(plist.includes('<string>/Users/me/a&amp;b.json</string>'), 'XML special characters are escaped');
});

test('without a service manager the hub runs in a loop that a POSIX shell can read', () => {
  const command = hubCommand({ node: '/usr/bin/node', root: "/home/o'neil/fmux", env: { PATH: '/usr/bin:/mnt/c/Program Files' } });
  assert.ok(command.includes(`env 'PATH=/usr/bin:/mnt/c/Program Files' '/usr/bin/node' '/home/o'\\''neil/fmux/bin/fmux.mjs'`));
  assert.match(command, /^while true; do .*; sleep 5 \|\| break; done$/);
});

test('Windows: the hub session runs a batch file that starts the hub again', () => {
  const batch = hubBatch({ node: 'C:\\Program Files\\nodejs\\node.exe', root: 'C:\\Users\\me\\fmux', env: { PATH: 'C:\\x', FMUX_CONFIG: 'C:\\Users\\me\\100%.json' } });
  const lines = batch.split('\r\n');
  assert.equal(lines[0], '@echo off');
  assert.ok(lines.includes('set "FMUX_CONFIG=C:\\Users\\me\\100%%.json"'), 'a percent sign is doubled in a batch file');
  assert.ok(!batch.includes('PATH'), 'the session keeps the PATH it starts with');
  assert.ok(lines.includes('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\fmux\\bin\\fmux.mjs"'));
  assert.deepEqual(lines.slice(-3), ['ping -n 6 127.0.0.1 >nul', 'goto loop', '']);
});

test('Windows: a batch file in the Startup folder brings the hub up at logon', () => {
  const batch = startupBatch({ node: 'C:\\node\\node.exe', root: 'C:\\Users\\me\\fmux', env: { PATH: 'C:\\x' } });
  assert.ok(batch.includes('start "fmux" /min "C:\\node\\node.exe" "C:\\Users\\me\\fmux\\bin\\fmux.mjs" install-service'));
  assert.equal(startupFile({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }), 'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\fmux.cmd');
});

test('the control channel: a runtime directory on Linux, the state directory on macOS, a named pipe on Windows', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'fmux-runtime-'));
  assert.equal(socketPath('/state', { platform: 'linux', env: { XDG_RUNTIME_DIR: runtime } }), path.join(runtime, 'fmux.sock'));
  assert.equal(socketPath('/state', { platform: 'linux', env: { XDG_RUNTIME_DIR: '/no/such/dir' } }), '/state/fmux.sock');
  assert.equal(socketPath('/state', { platform: 'darwin', env: { XDG_RUNTIME_DIR: runtime } }), '/state/fmux.sock');
  const pipe = socketPath('C:\\state', { platform: 'win32', user: 'John Smith' });
  assert.equal(pipe, '\\\\.\\pipe\\fmux-John_Smith');
  assert.equal(isPipe(pipe), true);
  assert.equal(isPipe('/run/user/1000/fmux.sock'), false);
});

test('each kind of service has its own commands', () => {
  assert.match(serviceCommands('systemd').stop, /^systemctl --user stop fmux$/);
  assert.match(serviceCommands('launchd').stop, /^launchctl bootout gui\/\$\(id -u\)\/com\.primatix\.fmux$/);
  assert.match(serviceCommands('tmux').stop, /^tmux kill-session -t =fmux-hub$/);
});

test('an existing app is taken over with its id and secret; the owner is bound again', async () => {
  await assert.rejects(useExistingApp({ appId: 'not-an-id', secret: 'x', print: quiet }), /cli_/);
  await assert.rejects(useExistingApp({ appId: 'cli_other', secret: 'x', print: quiet }), /already has the app cli_test/);
  await assert.rejects(useExistingApp({ appId: 'cli_other', force: true, print: quiet }), /App Secret/);

  await useExistingApp({ appId: 'cli_other', secret: ' other-secret \n', tenant: 'lark', force: true, print: quiet });
  const raw = readRawConfig();
  assert.equal(raw.app.id, 'cli_other');
  assert.equal(raw.app.tenant, 'lark');
  assert.deepEqual(raw.owner, { openId: '', chatId: '' }, 'open_ids belong to one app, so the old owner id is dropped');
  assert.equal(await resolveSecret(raw.app.secret), 'other-secret');
  assert.ok(!JSON.stringify(raw).includes('other-secret'));
});
