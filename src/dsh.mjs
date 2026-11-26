import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { openFiles, procCwd, procStartMs, snapshot as procSnapshot } from './procs.mjs';
import { oneLine } from './util.mjs';

const SESSION_LOCK_RE = /\/\.dsh\/sessions\/[^/]+\/([^/]+)\/session\.lock$/;

function parseArgs(raw) {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toolSummary(input) {
  if (input == null) return '';
  if (typeof input === 'string') return oneLine(input, 90);
  const pick = input.description || input.command || input.cmd || input.pattern || input.file_path || input.path || input.query || input.url;
  return pick ? oneLine(String(pick), 90) : '';
}

// Decode multi-frame concatenated zstd JSONL files written by dsh-tui (`session.v4.jsonl.zstd`).
export function readZstdText(file) {
  try {
    return execFileSync('zstd', ['-dc', file], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    try {
      const buf = fs.readFileSync(file);
      return zlib.zstdDecompressSync(buf).toString('utf8');
    } catch {
      return null;
    }
  }
}

// Adapter for DeepSeek Harness (`dsh-tui`) `session.v4.jsonl.zstd` records.
export function dshAdapter(d) {
  if (!d || typeof d !== 'object') return [];
  const data = d.data || {};

  if (d.type === 'request/context' && data.model) {
    return [{ type: 'model', model: String(data.model) }];
  }
  if (d.type === 'request/header' && data.header?.config?.model) {
    return [{ type: 'model', model: String(data.header.config.model) }];
  }

  // Real typed user prompts carry `source.kind === 'user'`; system reminders / approval notices do not.
  if (d.type === 'user/message' && data.source?.kind === 'user') {
    const text = (Array.isArray(data.content)
      ? data.content.filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join('\n')
      : String(data.content || '')
    ).trim();
    return text ? [{ type: 'user', text }] : [];
  }

  if (d.type === 'assistant/message') {
    const out = [];
    for (const b of data.message?.content || []) {
      if (b?.type === 'reasoning' && b.text?.trim()) out.push({ type: 'thinking', text: b.text.trim() });
      else if (b?.type === 'text' && b.text?.trim()) out.push({ type: 'text', text: b.text.trim() });
    }
    return out;
  }

  if (d.type === 'tool/call') {
    const args = parseArgs(data.arguments ?? data.input);
    return [{ type: 'tool', name: data.name || 'tool', summary: toolSummary(args) }];
  }

  if (d.type === 'turn/end') {
    return [{ type: 'turn_end' }];
  }

  return [];
}

function cwdSlug(cwd) {
  return `--${String(cwd || '').replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

// Locate the live `session.v4.jsonl.zstd` for a running `dsh-tui` process by checking
// `session.lock` open file descriptors on the process and its child host-entry.js process.
export function createDshLocator({ home = os.homedir(), io = {} } = {}) {
  const fdsOf = io.openFiles || openFiles;
  const snapOf = io.snapshot || procSnapshot;
  const cwdOf = io.procCwd || procCwd;
  const startOf = io.procStartMs || procStartMs;
  const root = path.join(home, '.dsh', 'sessions');

  async function findLock(pid) {
    const pids = [pid];
    try {
      const snap = await snapOf();
      for (const child of snap.children.get(pid) || []) pids.push(child);
    } catch {
      // ignore
    }
    for (const p of pids) {
      for (const file of await fdsOf(p)) {
        const norm = String(file).replace(/\\/g, '/');
        if (SESSION_LOCK_RE.test(norm)) {
          const candidate = path.join(path.dirname(file), 'session.v4.jsonl.zstd');
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    }
    return null;
  }

  return async function locateDsh(pid, hint = {}) {
    if (pid) {
      const locked = await findLock(pid);
      if (locked) return locked;
    }
    const cwd = (pid ? await cwdOf(pid) : null) || hint.cwd;
    if (!cwd) return null;
    const dir = path.join(root, cwdSlug(cwd));
    if (!fs.existsSync(dir)) return null;
    const since = pid ? (await startOf(pid)) - 5000 : 0;
    let best = null;
    try {
      for (const entry of fs.readdirSync(dir)) {
        const candidate = path.join(dir, entry, 'session.v4.jsonl.zstd');
        try {
          const st = fs.statSync(candidate);
          if (st.mtimeMs >= since && (!best || st.mtimeMs > best.mtimeMs)) {
            best = { file: candidate, mtimeMs: st.mtimeMs };
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    return best?.file || null;
  };
}
