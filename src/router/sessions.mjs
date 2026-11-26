import fs from 'node:fs';
import * as cards from '../cards.mjs';
import { compactScreen, findDialog, keysFor } from '../screen.mjs';
import { adapters, lastTurns } from '../transcript.mjs';
import { expandHome, log, oneLine, quoteArg, sleep } from '../util.mjs';

export function newSessionForm(router, error) {
  return cards.newSessionCard({
    error,
    agents: Object.keys(router.cfg.agents),
    conversations: router.history.recentConversations(),
  });
}

// A name for a session created without one: the agent and the time, made unique.
function autoName(registry, agent) {
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const base = `${agent}-${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
  const taken = new Set(registry.list().map((s) => s.tmuxSession));
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  return name;
}

// Claude Code asks whether to trust a folder it has not seen. The owner picked the folder
// for this session, so the prompt is answered for them. Nothing else is answered here.
export async function autoTrust(router, key, { tries = 25, everyMs = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    await sleep(everyMs);
    if (!router.registry.sessions.has(key)) return false;
    const screen = await router.tmux.capture(key);
    const dialog = findDialog(screen);
    const index = dialog ? dialog.options.findIndex((o) => /^Yes, I trust/i.test(o.label)) : -1;
    if (index >= 0) {
      await router.tmux.sendKeys(key, keysFor(dialog, index));
      log('info', 'autotrust', { session: router.registry.sessions.get(key)?.name });
      return true;
    }
    // The agent's own prompt is up: there was no trust question.
    if (!dialog && router.registry.sessions.get(key)?.kind !== 'shell' && i >= 5) return false;
  }
  return false;
}

// resume: 'new', 'last' (latest conversation of the directory), '<agent>:<conversation id>',
// or words from a conversation's title. yolo: start the agent with its `flags` (-d, --yolo).
export async function createSession(router, { name, agent = 'claude', cwd = '~', prompt = '', resume = 'new', yolo = true }) {
  let template;
  if (resume && resume !== 'new' && resume !== 'last') {
    const tagged = resume.match(/^(claude|codex):(.+)$/);
    const { match: conversation, candidates } = router.history.lookupConversation(tagged ? tagged[2] : resume, { agent: tagged?.[1] });
    if (!conversation && candidates.length) {
      throw new Error(`「${resume}」对上了多个对话：${candidates.slice(0, 5).map((c) => `${c.id.slice(0, 8)} ${oneLine(c.title, 24)}`).join('；')}`);
    }
    if (!conversation) throw new Error(`找不到要恢复的对话：${resume}`);
    agent = conversation.agent;
    cwd = conversation.cwd;
    template = router.cfg.agents[agent]?.resume?.replace('{id}', conversation.id);
    if (!template) throw new Error(`${agent} 没有配置恢复命令`);
  }
  const spec = router.cfg.agents[agent];
  if (!spec) throw new Error(`未知类型：${agent}（可选 ${Object.keys(router.cfg.agents).join(' / ')}）`);
  if (resume === 'last') {
    template = spec.continue;
    if (!template) throw new Error(`${agent} 不支持「继续最近一次对话」`);
  }
  template ??= spec.command;
  name = String(name || '').trim() || autoName(router.registry, agent);
  const dir = expandHome(cwd || '~');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`目录不存在：${cwd}`);
  if (router.registry.list().some((s) => s.tmuxSession === name)) throw new Error(`已有叫 ${name} 的会话`);
  const base = template.replace('{flags}', yolo ? spec.flags || '' : '').replace('{name}', name).replace(/\s+/g, ' ').trim();
  const command = base ? (prompt ? `${base} ${quoteArg(prompt)}` : base) : prompt;
  await router.tmux.newSession({ name, cwd: dir, command });
  await router.registry.poll();
  const session = router.registry.list().find((s) => s.tmuxSession === name);
  if (!session) throw new Error('会话创建后没有出现在 tmux 里');
  log('info', 'session.new', { name, agent, cwd: dir, resume, yolo });
  if (spec.autoTrust) autoTrust(router, session.key).catch((err) => log('warn', 'autotrust', { message: err.message }));
  return session;
}

// What to hand over from a session: its last finished replies, or the end of its screen.
async function handoffContent(router, source, { turns = 1, whole = false, screen = false, lines = 40 }) {
  if (screen || source.kind === 'shell' || !source.transcript) {
    const tail = compactScreen(await router.tmux.capture(source.key, { history: 200 }), Math.max(1, lines), 200);
    return { what: `终端最后 ${tail.split('\n').length} 行`, body: tail, note: '' };
  }
  const all = lastTurns(source.transcript, adapters[source.kind]).filter((t) => t.texts.length);
  const finished = all.filter((t) => t.done);
  // While the agent works, its newest turn is not a reply yet. Take what it finished before.
  const pool = finished.length ? finished : all;
  const note = finished.length < all.length ? `${source.name} 还在运行，转交的是它上一条已完成的回复` : '';
  const picked = pool.slice(-Math.max(1, turns));
  const one = (t) => (whole ? t.texts.join('\n\n') : t.texts.at(-1));
  const body = picked.length > 1
    ? picked.map((t, i) => `（第 ${i + 1} 条${t.prompt ? `，当时的输入：${oneLine(t.prompt, 80)}` : ''}）\n${one(t)}`).join('\n\n')
    : picked.length ? one(picked[0]) : source.lastText;
  return { what: picked.length > 1 ? `最近 ${picked.length} 条回复` : '最后一条回复', body, note };
}

export async function handoff(router, { from, to, comment = '', ...options }) {
  const source = router.need(from);
  const target = router.need(to);
  if (source.key === target.key) throw new Error('the source and the target are the same session');
  const { what, body, note } = await handoffContent(router, source, options);
  if (!body?.trim()) throw new Error(`${source.name} has no reply to hand over yet`);
  const limit = 30000;
  const cut = Array.from(body).length > limit;
  const text = cut ? `${Array.from(body).slice(0, limit).join('')}\n…（太长，已截断）` : body;
  const block = `【来自会话 ${source.name} 的${what}】\n\n${text}`;
  // The comment is typed, so an agent reads it as the owner's instruction. The other session's
  // reply is pasted, so the agent reads it as material and not as orders. A shell gets one paste.
  const lead = comment.replace(/\s+/g, ' ').trim() || `下面是会话 ${source.name} 的${what}，供参考。`;
  const typed = target.kind !== 'shell' && !lead.includes('@') ? lead : '';
  const sent = await router.deliver(target, typed ? block : `${lead}\n\n${block}`, undefined, { typed });
  if (!sent) throw new Error(`${target.name} is waiting on a dialog and took nothing. Answer the dialog first.`);
  log('info', 'handoff', { from: source.name, to: target.name, chars: text.length, what });
  return {
    from: source.name, to: target.name, what, chars: Array.from(text).length, truncated: cut,
    preview: oneLine(text, 160), comment: comment.trim(), note,
    next: `${target.name}'s reply will arrive in the chat as its own card`,
  };
}
