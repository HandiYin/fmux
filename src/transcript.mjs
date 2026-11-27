import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readClaudeMeta } from './agent-files.mjs';
import { agyAdapter, createAgyLocator } from './agy.mjs';
import { createCodexLocator } from './codex-transcript.mjs';
import { createDshLocator, dshAdapter, readZstdText } from './dsh.mjs';
import { parseJsonLines, readTailSlice } from './jsonl.mjs';
import { procCwd, procStartMs } from './procs.mjs';
import { oneLine } from './util.mjs';
export { readClaudeMeta };

// Each adapter turns one transcript line (parsed JSON) into zero or more events:
//   { type: 'text', text }           assistant prose
//   { type: 'tool', name, summary }  a tool call
//   { type: 'user', text }           a prompt typed by the user
//   { type: 'turn_end', durationMs } the agent handed control back

function toolSummary(input) {
  if (input == null) return '';
  if (typeof input === 'string') return oneLine(input, 90);
  if (Array.isArray(input.command)) return oneLine(input.command.join(' '), 90);
  const pick = input.description || input.command || input.cmd || input.pattern;
  if (pick) return oneLine(String(pick), 90);
  const file = input.file_path || input.path;
  if (typeof file === 'string') return path.basename(file);
  const other = input.query || input.url || input.prompt || input.skill;
  return other ? oneLine(String(other), 90) : '';
}

function parseArgs(raw) {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export const adapters = {
  claude(d) {
    if (d.isSidechain) return [];
    if (d.type === 'assistant') {
      const out = [];
      for (const b of d.message?.content || []) {
        if (b.type === 'thinking' && b.thinking?.trim()) out.push({ type: 'thinking', text: b.thinking.trim() });
        else if (b.type === 'text' && b.text?.trim()) out.push({ type: 'text', text: b.text.trim() });
        else if (b.type === 'tool_use') out.push({ type: 'tool', name: b.name, summary: toolSummary(b.input) });
      }
      return out;
    }
    if (d.type === 'user' && !d.isMeta && typeof d.message?.content === 'string') {
      // A multi-line paste is wrapped in <pasted_content>. The prompt is what was typed around it,
      // or the paste itself when nothing was typed.
      const pasted = [];
      let text = d.message.content.replace(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g, (_, inner) => {
        pasted.push(inner.trim());
        return ' ';
      }).trim();
      if (!text) text = pasted.join('\n');
      // Slash-command echoes and injected notices are wrapped in tags; a typed prompt is not.
      return text && !text.startsWith('<') ? [{ type: 'user', text }] : [];
    }
    if (d.type === 'system' && d.subtype === 'turn_duration') return [{ type: 'turn_end', durationMs: d.durationMs }];
    return [];
  },

  codex(d) {
    const p = d.payload || {};
    if (d.type === 'response_item') {
      if (p.type === 'message' && p.role === 'assistant') {
        const text = (p.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('').trim();
        return text ? [{ type: 'text', text }] : [];
      }
      if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
        const args = parseArgs(p.arguments ?? p.input ?? p.action);
        return [{ type: 'tool', name: p.name || 'shell', summary: toolSummary(args) }];
      }
      return [];
    }
    if (d.type === 'event_msg') {
      if (p.type === 'task_complete') return [{ type: 'turn_end', durationMs: Number(p.duration_ms) || undefined }];
      if (p.type === 'user_message' && p.message?.trim()) return [{ type: 'user', text: p.message.trim() }];
      // Paginated-history Codex writes UserMessage items instead of user_message events.
      if (p.type === 'item_completed' && p.item?.type === 'UserMessage') {
        const text = (p.item.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
        return text ? [{ type: 'user', text }] : [];
      }
    }
    return [];
  },

  pi(d) {
    if (d.type !== 'message') return [];
    const m = d.message || {};
    if (m.role === 'assistant') {
      const out = [];
      for (const b of m.content || []) {
        if (b.type === 'text' && b.text?.trim()) out.push({ type: 'text', text: b.text.trim() });
        else if (b.type === 'toolCall') out.push({ type: 'tool', name: b.name, summary: toolSummary(b.arguments) });
      }
      if (m.stopReason && m.stopReason !== 'toolUse') out.push({ type: 'turn_end' });
      return out;
    }
    if (m.role === 'user') {
      const text = (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'text').map((b) => b.text).join('') : String(m.content || '')).trim();
      return text ? [{ type: 'user', text }] : [];
    }
    return [];
  },

  agy: agyAdapter,
  dsh: dshAdapter,
};

const adaptLines = (text, adapter) => parseJsonLines(text).flatMap(adapter);

function readTranscriptText(file, maxBytes) {
  if (String(file || '').endsWith('.zstd')) {
    const full = readZstdText(file);
    return full === null ? null : (full.length > maxBytes ? full.slice(-maxBytes) : full);
  }
  return readTailSlice(file, maxBytes);
}

// Follows a JSONL (or multi-frame .zstd JSONL) transcript and returns events appended since the last read.
export class Tail {
  constructor(file, adapter, { fromStart = false, offset = null } = {}) {
    this.file = file;
    this.adapter = adapter;
    this.isZstd = String(file || '').endsWith('.zstd');
    this.partial = '';
    this.offset = 0;
    this.lineCount = 0;
    if (fromStart) return;
    if (this.isZstd) {
      try {
        this.offset = fs.statSync(file).size;
        const text = readZstdText(file);
        this.lineCount = text ? text.split('\n').filter(Boolean).length : 0;
      } catch {
        this.offset = 0;
        this.lineCount = 0;
      }
      return;
    }
    if (Number.isFinite(offset) && offset >= 0) {
      this.offset = offset;
      return;
    }
    try {
      this.offset = fs.statSync(file).size;
    } catch {
      this.offset = 0;
    }
  }

  read() {
    let size;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return [];
    }
    if (this.isZstd) {
      if (size === this.offset) return [];
      const text = readZstdText(this.file);
      if (text === null) return [];
      const lines = text.split('\n').filter(Boolean);
      if (lines.length < this.lineCount) this.lineCount = 0;
      const fresh = lines.slice(this.lineCount);
      this.lineCount = lines.length;
      this.offset = size;
      return fresh.length ? adaptLines(fresh.join('\n'), this.adapter) : [];
    }
    if (size < this.offset) {
      this.offset = 0;
      this.partial = '';
    }
    if (size === this.offset) return [];
    const fd = fs.openSync(this.file, 'r');
    try {
      const buf = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = size;
      const text = this.partial + buf.toString('utf8');
      const cut = text.lastIndexOf('\n');
      this.partial = cut < 0 ? text : text.slice(cut + 1);
      return cut < 0 ? [] : adaptLines(text.slice(0, cut), this.adapter);
    } finally {
      fs.closeSync(fd);
    }
  }
}

// Last assistant prose, model, and last user prompt near the end of a transcript, for the dashboard preview.
export function lastExchange(file, adapter, maxBytes = 768 * 1024) {
  const text = readTranscriptText(file, maxBytes);
  if (text === null) return {};
  const result = {};
  for (const ev of adaptLines(text, adapter)) {
    if (ev.type === 'text') result.text = ev.text;
    else if (ev.type === 'user') result.prompt = ev.text;
    else if (ev.type === 'model') result.model = ev.model;
  }
  return result;
}

// The turns near the end of a transcript, oldest first: { prompt, texts, thoughts, tools, done }.
// A turn starts at a prompt typed by the user. `done` is false for a turn the agent is still working on.
export function lastTurns(file, adapter, maxBytes = 2 * 1024 * 1024) {
  const text = readTranscriptText(file, maxBytes);
  if (text === null) return [];
  const turns = [];
  let current = null;
  const ensure = () => {
    if (!current || current.done) {
      current = { prompt: '', texts: [], thoughts: [], tools: [], done: false };
      turns.push(current);
    }
    return current;
  };
  for (const ev of adaptLines(text, adapter)) {
    if (ev.type === 'user') {
      if (current) current.done = true;
      current = { prompt: ev.text, texts: [], thoughts: [], tools: [], done: false };
      turns.push(current);
    } else if (ev.type === 'thinking') {
      const t = ensure();
      t.thoughts.push(ev.text.slice(0, 2000));
      if (t.thoughts.length > 8) t.thoughts.shift();
    } else if (ev.type === 'tool') {
      const t = ensure();
      t.tools.push({ name: ev.name || 'tool', summary: ev.summary || '' });
      if (t.tools.length > 20) t.tools.shift();
    } else if (ev.type === 'text') {
      ensure().texts.push(ev.text);
    } else if (ev.type === 'turn_end' && current) {
      current.done = true;
    }
  }
  return turns;
}

// ---- locating the transcript of a running agent process ----

const HOME = os.homedir();
const claudeTranscripts = new Map();

function claudeTranscript(sessionId) {
  if (!sessionId) return null;
  if (claudeTranscripts.has(sessionId)) return claudeTranscripts.get(sessionId);
  const root = path.join(HOME, '.claude', 'projects');
  let found = null;
  try {
    for (const dir of fs.readdirSync(root)) {
      const candidate = path.join(root, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) {
        found = candidate;
        break;
      }
    }
  } catch {
    // no projects directory yet
  }
  if (found) claudeTranscripts.set(sessionId, found);
  return found;
}

function newestSince(files, sinceMs) {
  let best = null;
  for (const file of files) {
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs >= sinceMs && (!best || st.mtimeMs > best.mtimeMs)) best = { file, mtimeMs: st.mtimeMs };
    } catch {
      // removed meanwhile
    }
  }
  return best?.file || null;
}

// pi names the session directory of a working directory: "/home/u/proj" gives "--home-u-proj--",
// "C:\\Users\\u\\proj" gives "--C--Users-u-proj--".
export function piSessionDir(cwd) {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

// `hint.cwd` is the directory tmux reports for the pane. It stands in where the system does not
// give the working directory of a process (Windows).
const codexTranscript = createCodexLocator();
const agyTranscript = createAgyLocator();
const dshTranscript = createDshLocator();

async function piTranscript(pid, hint) {
  const cwd = (await procCwd(pid)) || hint.cwd;
  if (!cwd) return null;
  const dir = path.join(HOME, '.pi', 'agent', 'sessions', piSessionDir(cwd));
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));
    return newestSince(files, (await procStartMs(pid)) - 5000);
  } catch {
    return null;
  }
}

export async function locateTranscript(kind, pid, meta, hint = {}) {
  if (kind === 'claude') return claudeTranscript(meta?.sessionId);
  if (kind === 'codex') return codexTranscript(pid, hint);
  if (kind === 'pi') return piTranscript(pid, hint);
  if (kind === 'agy') return agyTranscript(pid, hint);
  if (kind === 'dsh') return dshTranscript(pid, hint);
  return null;
}
