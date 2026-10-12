// First-time setup: create the Feishu app, bind the owner, install the service.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_PATH, loadConfig, readRawConfig, resolveSecret, writeRawConfig } from './config.mjs';
import { callControl } from './control.mjs';
import { BACKEND } from './procs.mjs';
import { HUB_SESSION, installService as installAs, installedKind, isWsl, serviceCommands, serviceKind } from './service.mjs';
import { sh } from './util.mjs';

// What fmux needs from its Feishu app. The same list is in docs/setup.zh.md for a hand-made app.
export const NEEDS = {
  scopes: [
    'im:message.p2p_msg:readonly', // receive the owner's direct messages
    'im:message:send_as_bot', // send cards and edit them
    'im:message:readonly', // download images and files the owner sends
    'im:message.reactions:write_only', // the "OK" reaction on a delivered message
  ],
  events: ['im.message.receive_v1'],
  callbacks: ['card.action.trigger'],
};

const CLOSED_GROUPS = ['oc_fmux_groups_closed'];
const domainOf = (tenant) => (tenant === 'lark' ? { domain: 'https://open.larksuite.com' } : {});

async function daemonRunning() {
  try {
    await callControl(loadConfig().socket, 'status', {}, 2000);
    return true;
  } catch {
    return false;
  }
}

// Create a bot app by scanning a QR code with the Feishu app, and write its id and secret.
export async function createApp({ force = false, registerApp, renderQr, print = console.log } = {}) {
  const existing = readRawConfig();
  if (existing.app?.id && !force) {
    throw new Error(`${CONFIG_PATH} already has the app ${existing.app.id}. Run "fmux setup --force" to replace it, or "fmux pair" to bind the owner again.`);
  }
  registerApp ??= (await import('@larksuite/channel')).registerApp;
  if (!renderQr) {
    const qrcode = (await import('qrcode-terminal')).default;
    renderQr = (text, options, done) => qrcode.generate(text, options, done);
  }
  const result = await registerApp({
    source: 'fmux',
    createOnly: true,
    appPreset: { name: 'fmux', desc: '在飞书里接入这台电脑上的 tmux 会话' },
    addons: {
      scopes: { tenant: NEEDS.scopes },
      events: { items: { tenant: NEEDS.events } },
      callbacks: { items: NEEDS.callbacks },
    },
    onQRCodeReady: ({ url, expireIn }) => {
      print('用手机飞书扫这个二维码，按页面提示创建机器人应用：\n');
      renderQr(url, { small: true }, (qr) => print(qr));
      print(`也可以在手机飞书里打开这个链接（${Math.round(expireIn / 60)} 分钟内有效）：\n${url}\n`);
    },
  });
  const secretFile = path.join(path.dirname(CONFIG_PATH), 'app-secret');
  fs.mkdirSync(path.dirname(secretFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(secretFile, `${result.client_secret}\n`, { mode: 0o600 });
  const config = {
    ...existing,
    app: { id: result.client_id, tenant: result.user_info?.tenant_brand || 'feishu', secret: { source: 'file', path: secretFile } },
    owner: { openId: '', chatId: '' },
  };
  writeRawConfig(config);
  print(`应用已创建：${result.client_id}。App Secret 存在 ${secretFile}。`);
  return config;
}

// Use a bot app that exists already. Its secret is typed in, or stays where lark-channel-bridge keeps it.
export async function useExistingApp({ appId, secret, fromBridge = false, tenant = 'feishu', force = false, print = console.log } = {}) {
  if (!/^cli_[A-Za-z0-9]+$/.test(appId || '')) throw new Error('App ID 的样子是 cli_xxxxxxxx，在开发者后台的「凭证与基础信息」里。');
  const existing = readRawConfig();
  if (existing.app?.id && existing.app.id !== appId && !force) {
    throw new Error(`${CONFIG_PATH} already has the app ${existing.app.id}. Add --force to replace it.`);
  }
  let secretRef;
  if (fromBridge) {
    const getter = path.join(os.homedir(), '.lark-channel', 'secrets-getter');
    if (!fs.existsSync(getter)) throw new Error(`找不到 ${getter}：这台机器上没有 lark-channel-bridge 的密钥库。`);
    secretRef = { source: 'exec', command: getter, id: `app-${appId}` };
    await resolveSecret(secretRef);
  } else {
    if (!secret) throw new Error('没有收到 App Secret。');
    const secretFile = path.join(path.dirname(CONFIG_PATH), 'app-secret');
    fs.mkdirSync(path.dirname(secretFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(secretFile, `${secret.trim()}\n`, { mode: 0o600 });
    secretRef = { source: 'file', path: secretFile };
  }
  const config = { ...existing, app: { id: appId, tenant, secret: secretRef }, owner: { openId: '', chatId: '' } };
  writeRawConfig(config);
  print(`已写入配置：应用 ${appId}。`);
  return config;
}

// Read one line from the terminal without showing it.
export function promptHidden(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    if (!stdin.isTTY) {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (chunk) => { data += chunk; });
      stdin.on('end', () => resolve(data.split('\n')[0].trim()));
      return;
    }
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// Bind the owner: the sender of the first direct message to the bot. This also proves that
// messages reach this machine, and it keeps a connection open while a hand-made app is configured.
export async function pair({ timeoutMs = 10 * 60 * 1000, createChannel, print = console.log } = {}) {
  const cfg = loadConfig();
  if (!cfg.app.id) throw new Error(`${CONFIG_PATH} has no app.id. Run "fmux setup", or write the config by hand (docs/setup.zh.md).`);
  if (await daemonRunning()) throw new Error(`fmux 服务正在运行。同一个应用只能有一个连接，先停掉它：${serviceCommands(await installedKind()).stop}`);
  createChannel ??= (await import('@larksuite/channel')).createLarkChannel;
  const channel = createChannel({
    appId: cfg.app.id,
    appSecret: await resolveSecret(cfg.app.secret),
    ...domainOf(cfg.app.tenant),
    policy: { dmMode: 'open', groupAllowlist: CLOSED_GROUPS, requireMention: true },
    source: 'fmux',
  });
  let timer;
  const first = new Promise((resolve, reject) => {
    channel.on('message', (msg) => {
      if (msg.chatType === 'p2p') resolve(msg);
    });
    timer = setTimeout(() => reject(new Error('等了 10 分钟没有收到消息。检查应用是否已发布、事件 im.message.receive_v1 是否已订阅（docs/setup.zh.md）。')), timeoutMs);
  });
  await channel.connect();
  print('已连上飞书。现在在飞书里找到这个机器人，给它发一条消息（内容随意）。');
  print('这个应用以前接在别的程序上时，先在开发者后台确认事件和回调都用长连接（docs/setup.zh.md 方式 C2 第 3 步），再发消息。');
  try {
    const msg = await first;
    const raw = readRawConfig();
    writeRawConfig({ ...raw, owner: { ...raw.owner, openId: msg.senderId, chatId: msg.chatId } });
    await channel.send(msg.chatId, { markdown: '已绑定。以后只有你能用这个机器人。启动 fmux 服务后，发「面板」查看会话。' }, { replyTo: msg.messageId }).catch(() => {});
    print(`已绑定：${msg.senderId}。只有这个账号的消息和点击会被接受。`);
    return msg.senderId;
  } finally {
    clearTimeout(timer);
    await Promise.resolve(channel.disconnect()).catch(() => {});
  }
}

// Install and start the service: systemd, launchd, or a tmux session (`tmux: true`, or where neither is there).
export async function installService({ tmux = false, print = console.log } = {}) {
  const cfg = loadConfig();
  if (!cfg.app.id || !cfg.owner.openId) throw new Error(`${CONFIG_PATH} is not complete. Run "fmux setup" first.`);
  return installAs({ kind: tmux ? 'tmux' : undefined, running: daemonRunning, print });
}

async function has(command) {
  try {
    await sh('sh', ['-c', `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

const SYSTEMS = { linux: 'Linux', darwin: 'macOS' };

// What is in place and what is missing.
export async function doctor({ print = console.log } = {}) {
  const cfg = loadConfig();
  const lines = [];
  const add = (ok, text) => lines.push(`${ok ? '✓' : '✗'} ${text}`);
  const system = SYSTEMS[process.platform];
  add(Boolean(system), system ? `系统 ${system}${isWsl() ? '（WSL）' : ''}` : `系统 ${process.platform}：不支持。Windows 上请装在 WSL 里（docs/setup.zh.md）`);
  add(Number(process.versions.node.split('.')[0]) >= 20, `Node.js ${process.versions.node}（需要 20.12 以上）`);
  add(await has('tmux'), 'tmux');
  if (BACKEND === 'ps') add((await has('ps')) && (await has('lsof')), '进程识别用 ps 和 lsof');
  add(fs.existsSync(CONFIG_PATH), `配置 ${CONFIG_PATH}`);
  add(Boolean(cfg.app.id), `飞书应用 ${cfg.app.id || '（没有，运行 fmux setup）'}`);
  add(Boolean(cfg.owner.openId), `主人 ${cfg.owner.openId || '（没有绑定，运行 fmux pair）'}`);
  for (const agent of ['claude', 'codex', 'pi']) add(await has(agent), `${agent}${agent === 'pi' ? '（管家用；没有的话把 concierge.enabled 设为 false）' : '（可选）'}`);
  const kind = await serviceKind();
  const manager = { systemd: ' systemd 用户服务', launchd: ' launchd ', tmux: ` tmux 会话 ${HUB_SESSION}（这里没有可用的 systemd）` }[kind];
  const running = await daemonRunning();
  add(running, running ? `fmux 服务在运行（${cfg.socket}）` : `fmux 服务没有运行。fmux install-service 会用${manager}托管`);
  print(lines.join('\n'));
  return lines;
}
