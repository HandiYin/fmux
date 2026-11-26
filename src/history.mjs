import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultCodexHome, listOpenClaudeSessionIds, readCodexIndex, scanCodexRollouts } from './agent-files.mjs';
import { parseJsonLines, readFileSlice } from './jsonl.mjs';
import { pick } from './match.mjs';
import { alive } from './procs.mjs';

// Past conversations of Claude Code and Codex that a new tmux session can resume.
// Each item: { agent, id, title, cwd, updatedAt, lastPrompt }.

const HOME = os.homedir();

function claudeConversation(file, st) {
  const head = parseJsonLines(readFileSlice(file, 0, Math.min(st.size, 48 * 1024)));
  const first = head.find((d) => d.cwd);
  if (!first || (first.entrypoint && first.entrypoint !== 'cli')) return null;
  const tailStart = Math.max(0, st.size - 256 * 1024);
  const tail = parseJsonLines(readFileSlice(file, tailStart, st.size - tailStart));
  let aiTitle = '';
  let customTitle = '';
  let lastPrompt = '';
  for (const d of tail) {
    if (d.type === 'ai-title' && d.aiTitle) aiTitle = d.aiTitle;
    else if (d.type === 'custom-title' && d.customTitle) customTitle = d.customTitle;
    else if (d.type === 'last-prompt' && d.lastPrompt) lastPrompt = d.lastPrompt;
  }
  const title = customTitle || aiTitle || lastPrompt;
  if (!title) return null;
  return { agent: 'claude', id: path.basename(file, '.jsonl'), title, cwd: first.cwd, updatedAt: st.mtimeMs, lastPrompt };
}

function claudeConversations(limit) {
  const root = path.join(HOME, '.claude', 'projects');
  const files = [];
  try {
    for (const project of fs.readdirSync(root)) {
      let names;
      try {
        names = fs.readdirSync(path.join(root, project));
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(root, project, name);
        try {
          const st = fs.statSync(file);
          if (st.size > 2048) files.push({ file, st });
        } catch {
          // removed meanwhile
        }
      }
    }
  } catch {
    return [];
  }
  files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const open = listOpenClaudeSessionIds(alive);
  const out = [];
  for (const { file, st } of files) {
    if (out.length >= limit) break;
    if (open.has(path.basename(file, '.jsonl'))) continue;
    const conversation = claudeConversation(file, st);
    if (conversation) out.push(conversation);
  }
  return out;
}

function codexConversations(limit) {
  const root = defaultCodexHome();
  let latest;
  try {
    latest = readCodexIndex(root);
  } catch {
    return [];
  }
  const rows = [...latest.values()].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  const rollouts = scanCodexRollouts(root);
  const out = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    const file = rollouts.get(row.id);
    if (!file) continue;
    // The first line holds the whole system prompt, so the two fields are cut out of its start.
    const head = readFileSlice(file, 0, 4096);
    const cwd = head.match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1];
    const originator = head.match(/"originator":"([^"]*)"/)?.[1];
    // Only conversations held in the terminal UI; threads driven by a script (app-server) are not resumable by hand.
    if (!cwd || (originator && originator !== 'codex-tui')) continue;
    out.push({ agent: 'codex', id: row.id, title: row.thread_name || '(未命名)', cwd: JSON.parse(`"${cwd}"`), updatedAt: Date.parse(row.updated_at) || 0, lastPrompt: '' });
  }
  return out;
}

// Newest first. Each agent has its own quota, so a busy Claude history does not hide Codex.
// A conversation whose directory is gone cannot be resumed and is left out.
export function recentConversations({ claude = 10, codex = 5 } = {}) {
  return [...claudeConversations(claude + 5), ...codexConversations(codex + 5)]
    .filter((c) => fs.existsSync(c.cwd))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((c, i, all) => all.slice(0, i).filter((o) => o.agent === c.agent).length < (c.agent === 'claude' ? claude : codex));
}

// By id (or the start of one), or loosely by title. Returns { match, candidates }.
export function lookupConversation(ref, { agent, list = recentConversations({ claude: 60, codex: 30 }) } = {}) {
  const wanted = String(ref || '').trim();
  const pool = list.filter((c) => !agent || c.agent === agent);
  if (/^[0-9a-f-]{6,}$/i.test(wanted)) {
    const byId = pool.filter((c) => c.id.toLowerCase().startsWith(wanted.toLowerCase()));
    if (byId.length === 1) return { match: byId[0], candidates: [] };
    if (byId.length > 1) return { match: null, candidates: byId };
  }
  return pick(wanted, pool, (c) => [[c.title, 1], [path.basename(c.cwd), 0.5], [c.agent, 0.3]]);
}
