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
function autoName(router, agent) {
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const prefix = router.cfg.sessions?.namePrefix || '';
  const base = `${prefix}${agent}-${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
  const taken = new Set(router.registry.list().map((s) => s.tmuxSession));
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

// Serialize concurrent session creation so conflict checks & autoName remain race-free.
export async function createSession(router, options) {
  const next = (router.creating || Promise.resolve()).catch(() => {}).then(() => createSessionOnce(router, options));
  router.creating = next;
  return next;
}

// resume: 'new', 'last' (latest conversation of the directory), '<agent>:<conversation id>',
// or words from a conversation's title. yolo: start the agent with its `flags` (-d, --yolo).
async function createSessionOnce(router, { name, agent = 'claude', cwd = '~', prompt = '', resume = 'new', yolo = true }) {
  let template;
  if (resume && resume !== 'new' && resume !== 'last') {
    const tagged = resume.match(/^(claude|codex|agy|dsh):(.+)$/);
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
  name = String(name || '').trim() || autoName(router, agent);
  const prefix = router.cfg.sessions?.namePrefix || '';
  if (prefix && !name.startsWith(prefix)) name = prefix + name;
  if (router.tmux.SESSION_NAME_RE && !router.tmux.SESSION_NAME_RE.test(name)) throw new Error('无效的会话名称');
  if (router.registry.allows && !router.registry.allows(name)) throw new Error(`会话 ${name} 被用户的 tmux 过滤设置排除`);
  const dir = expandHome(cwd || '~');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`目录不存在：${cwd}`);
  const exists = router.registry.list().some((s) => s.tmuxSession === name);
  if (exists && router.cfg.sessions?.onConflict !== 'replace-idle') throw new Error(`已有叫 ${name} 的会话`);
  const base = template.replace('{flags}', yolo ? spec.flags || '' : '').replace('{name}', name).replace(/\s+/g, ' ').trim();
  const promptPart = prompt ? (spec.promptFlag ? `${spec.promptFlag} ${quoteArg(prompt)}` : quoteArg(prompt)) : '';
  const command = base ? (promptPart ? `${base} ${promptPart}` : base) : prompt;
  if (exists) {
    if (!router.registry.replaceSession) throw new Error('当前 registry 不支持替换同名会话');
    await router.registry.replaceSession({ name, cwd: dir, command, agent });
  } else {
    await router.tmux.newSession({ name, cwd: dir, command });
  }
  await router.registry.poll();
  const session = router.registry.list().find((s) => s.tmuxSession === name);
  if (!session) throw new Error('会话创建后没有出现在 tmux 里');
  router.registry.setLaunchPolicy?.(session, { agent, yolo });
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

const RENAMEABLE_AGENTS = new Set(['agy', 'dsh', 'claude', 'codex']);

export async function renameSessionBoth(router, session, { tmuxName = '', sessionTitle = '' } = {}) {
  const nextTmux = String(tmuxName || '').trim();
  const nextTitle = String(sessionTitle || '').replace(/[\r\n\t]+/g, ' ').replace(/@/g, ' ').trim();
  if (!nextTmux && !nextTitle) throw new Error('请填写新的 tmux 会话名或内部对话标题');

  const oldTmux = session.tmuxSession;
  const oldName = session.name;
  let renamedTmux = false;
  let renamedAgent = false;
  let warning = '';

  if (nextTmux && nextTmux !== oldTmux) {
    const conflict = [...router.registry.sessions.values()].some((s) => s.tmuxSession === nextTmux && s.tmuxSession !== oldTmux);
    if (conflict) throw new Error(`已存在名为 ${nextTmux} 的 tmux 会话`);
    await router.tmux.renameSession(oldTmux, nextTmux);
    for (const s of router.registry.sessions.values()) {
      if (s.tmuxSession !== oldTmux) continue;
      const wasSingle = s.name === oldTmux;
      s.tmuxSession = nextTmux;
      s.name = wasSingle ? nextTmux : `${nextTmux}:${s.windowIndex}.${s.paneIndex}`;
      router.registry.codexBindings?.checkpoint?.(s);
    }
    const attached = router.store?.get?.('attached');
    if (attached && attached.name === oldName) {
      router.store.set('attached', { ...attached, name: session.name });
    }
    router.ops?.renameSessionRef?.(oldName, session.name);
    router.gpu?.renameSessionRef?.(oldName, session.name);
    renamedTmux = true;
    log('info', 'session.rename_tmux', { from: oldTmux, to: nextTmux });
  }

  if (nextTitle && nextTitle !== session.title) {
    if (!RENAMEABLE_AGENTS.has(session.kind)) {
      if (!renamedTmux) throw new Error(`${session.kind} 会话不支持内部 /rename 对话标题`);
      warning = `${session.kind} 会话无内部对话标题，已仅重命名 tmux 会话`;
    } else if (session.status === 'working') {
      if (!renamedTmux) throw new Error('当前 Agent 正在思考/运行中，请先等待完成或点击 STOP 后再重命名内部对话标题');
      warning = 'tmux 会话已重命名；Agent 正在运行中，内部对话标题需等回合结束后再改';
    } else {
      await router.tmux.sendText(session.key, `/rename ${nextTitle}`, { keys: true });
      session.title = nextTitle;
      router.touchAttached(session);
      renamedAgent = true;
      log('info', 'session.rename_agent', { session: session.name, kind: session.kind, title: nextTitle });
    }
  }

  await sleep(renamedAgent ? 550 : 120);
  await router.registry.poll().catch(() => {});
  return {
    ok: true,
    key: session.key,
    name: session.name,
    tmuxSession: session.tmuxSession,
    title: session.title,
    renamedTmux,
    renamedAgent,
    ...(warning ? { warning } : {}),
  };
}
