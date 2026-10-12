import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pick } from './match.mjs';

// Past conversations of Claude Code and Codex that a new tmux session can resume.
// Each item: { agent, id, title, cwd, updatedAt, lastPrompt }.

const HOME = os.homedir();

function readSlice(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function jsonLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a line cut by the slice boundary
    }
  }
  return out;
}

// Session ids that a running Claude Code has open. Resuming one of these would open it twice.
function openClaudeSessions() {
  const open = new Set();
  const dir = path.join(HOME, '.claude', 'sessions');
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      if (!fs.existsSync(`/proc/${name.slice(0, -5)}`)) continue;
      try {
        open.add(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).sessionId);
      } catch {
        // half-written file
      }
    }
  } catch {
    // Claude Code never ran here
  }
  return open;
}

function claudeConversation(file, st) {
  const head = jsonLines(readSlice(file, 0, Math.min(st.size, 48 * 1024)));
  const first = head.find((d) => d.cwd);
  if (!first || (first.entrypoint && first.entrypoint !== 'cli')) return null;
  const tailStart = Math.max(0, st.size - 256 * 1024);
  const tail = jsonLines(readSlice(file, tailStart, st.size - tailStart));
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
  const open = openClaudeSessions();
  const out = [];
  for (const { file, st } of files) {
    if (out.length >= limit) break;
    if (open.has(path.basename(file, '.jsonl'))) continue;
    const conversation = claudeConversation(file, st);
    if (conversation) out.push(conversation);
  }
  return out;
}

function codexRollouts() {
  const byId = new Map();
  const root = path.join(HOME, '.codex', 'sessions');
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && depth < 3) walk(path.join(dir, entry.name), depth + 1);
      else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) byId.set(entry.name.slice(-42, -6), path.join(dir, entry.name));
    }
  };
  walk(root, 0);
  return byId;
}

function codexConversations(limit) {
  let index;
  try {
    index = jsonLines(fs.readFileSync(path.join(HOME, '.codex', 'session_index.jsonl'), 'utf8'));
  } catch {
    return [];
  }
  const latest = new Map();
  for (const row of index) if (row.id) latest.set(row.id, row);
  const rows = [...latest.values()].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  const rollouts = codexRollouts();
  const out = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    const file = rollouts.get(row.id);
    if (!file) continue;
    // The first line holds the whole system prompt, so the two fields are cut out of its start.
    const head = readSlice(file, 0, 4096);
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
