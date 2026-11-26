import fs from 'node:fs';
import path from 'node:path';
import * as cards from '../cards.mjs';
import { sleep } from '../util.mjs';

const ALIASES = {
  sessions: 'ls', 会话: 'ls', attach: 'a', 接入: 'a', detach: 'd', 断开: 'd',
  p: 'peek', 看: 'peek', keys: 'key', 帮助: 'help',
};
const COMMANDS = new Set(['ls', 'a', 'd', 'peek', 'key', 'new', 'pi', 'help', 'kill', 'stop']);
// Sent alone, these words bring up the dashboard even while attached: easier on a phone than "//ls".
const PANEL_WORDS = new Set(['面板', '会话面板', '会话']);

function sniffExt(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf.slice(0, 3).toString() === 'GIF') return '.gif';
  if (buf.slice(8, 12).toString() === 'WEBP') return '.webp';
  return '.bin';
}

export async function saveResources(router, msg) {
  const saved = [];
  for (const resource of msg.resources || []) {
    if (resource.type === 'sticker') continue;
    const buf = await router.feishu.download(msg.messageId, resource);
    const now = new Date();
    const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const dir = path.join(router.cfg.stateDir, 'inbox', day);
    fs.mkdirSync(dir, { recursive: true });
    const base = resource.fileName
      ? resource.fileName.replace(/[^\p{L}\p{N}._-]+/gu, '_')
      : `${resource.type}-${resource.fileKey.slice(-8)}${sniffExt(buf)}`;
    const file = path.join(dir, `${now.toTimeString().slice(0, 8).replace(/:/g, '')}-${base}`);
    fs.writeFileSync(file, buf);
    saved.push(file);
  }
  return saved;
}

// "//cmd" always belongs to the hub. A single "/" does too, but only while detached:
// an attached session has its own slash commands.
export function parseCommand(text, attached) {
  if (PANEL_WORDS.has(text)) return { name: 'ls', arg: '' };
  const m = text.match(/^(\/\/|／／|\/)\s*([A-Za-z一-龥-]+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const single = m[1] === '/';
  if (single && attached) return null;
  const name = ALIASES[m[2].toLowerCase()] || m[2].toLowerCase();
  if (!COMMANDS.has(name)) return single ? null : { name: 'help', arg: '' };
  return { name, arg: (m[3] || '').trim() };
}

// The session a loosely typed name means. When the name fits several, a card asks which one.
async function choose(router, text, action, usage) {
  const { match, candidates } = router.registry.lookup(text);
  if (match) return match;
  if (candidates.length) {
    await router.post(cards.infoCard({
      title: `「${text}」对上了 ${candidates.length} 个会话`,
      text: '点一个：',
      buttons: candidates.slice(0, 6).map((s) => ({ label: s.name, value: { a: action, s: s.key, n: s.name } })),
    }));
  } else {
    await router.info('找不到会话', text ? `没有能对上「${text}」的会话。` : usage);
  }
  return null;
}

export async function runCommand(router, { name, arg }, msg) {
  switch (name) {
    case 'ls':
      await router.sendDashboard();
      return;
    case 'a': {
      const session = await choose(router, arg, 'attach', '用法：`//a <序号或名字>`');
      if (session) await router.attach(session);
      return;
    }
    case 'd':
      await router.detach();
      await router.ack(msg, 'DONE', '已断开。现在的消息由 Pi 管家处理。');
      return;
    case 'peek': {
      const session = arg ? await choose(router, arg, 'peek', '') : router.attachedSession();
      if (session) await router.sendPeek(session);
      else if (!arg) await router.info('找不到会话', '用法：`//peek <序号或名字>`，接入后可以省略名字。');
      return;
    }
    case 'key': {
      const tokens = arg.split(/\s+/).filter(Boolean);
      let session = tokens.length > 1 ? router.registry.resolve(tokens[0]) : null;
      if (session) tokens.shift();
      session ??= router.attachedSession();
      if (!session || !tokens.length) {
        await router.info('用法', '`//key [会话] <按键…>`，按键如 `esc` `enter` `up` `1` `c-c`。');
        return;
      }
      await router.tmux.sendKeys(session.key, tokens);
      router.touchAttached(session);
      await sleep(450);
      await router.sendTerminal(session);
      return;
    }
    case 'new': {
      const [sessionName, agent = 'claude', cwd = '~'] = arg.split(/\s+/).filter(Boolean);
      if (!sessionName) {
        await router.post(router.newSessionForm());
        return;
      }
      const session = await router.createSession({ name: sessionName, agent, cwd });
      await router.attach(session);
      return;
    }
    case 'pi':
      if (arg) await router.askConcierge(arg);
      else await router.info('用法', '`//pi <消息>`：不断开当前会话，临时问 Pi 管家。');
      return;
    case 'stop': {
      const session = router.attachedSession();
      if (session) {
        await router.tmux.sendKeys(session.key, ['esc']);
        router.touchAttached(session);
      }
      return;
    }
    case 'kill': {
      const session = await choose(router, arg, 'term', '用法：`//kill <名字>`');
      if (session) await router.sendTerminal(session);
      return;
    }
    default:
      await router.post(cards.helpCard());
  }
}
