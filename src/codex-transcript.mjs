import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openFiles, procCwd } from './procs.mjs';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const isRollout = (file) => /[/\\]sessions[/\\].*[/\\]rollout-.*\.jsonl$/.test(file);
const sameCwd = (a, b) => typeof a === 'string' && typeof b === 'string'
  && (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function metadata(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const first = JSON.parse(buf.toString('utf8', 0, n).split('\n')[0]);
    return first.type === 'session_meta' ? first.payload : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// New Codex TUIs use a shared app-server, so the TUI no longer holds its rollout open.
// Match its displayed name to a unique indexed thread ID, never to the newest file in a cwd.
// Missing/ambiguous identity is deliberately unbound: forwarding another thread is worse
// than a visible "reply unavailable" notice. All Codex state is read-only.
export function createCodexLocator({ home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  hostname = os.hostname(), files = openFiles, cwdOf = procCwd } = {}) {
  const indexes = new Map();
  const paths = new Map();

  function names(root) {
    const file = path.join(root, 'session_index.jsonl');
    try {
      const st = fs.statSync(file);
      const signature = `${st.mtimeMs}:${st.size}`;
      if (indexes.get(root)?.signature === signature) return indexes.get(root).names;
      const result = new Map();
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        try {
          const entry = JSON.parse(line);
          if (UUID.test(entry.id) && typeof entry.thread_name === 'string') result.set(entry.id, entry.thread_name);
        } catch { /* ignore a partial append */ }
      }
      indexes.set(root, { signature, names: result });
      return result;
    } catch {
      indexes.delete(root);
      return new Map();
    }
  }

  function rollout(root, id) {
    const key = `${root}:${id}`;
    const cached = paths.get(key);
    if (cached && fs.existsSync(cached)) return cached;
    // A resumed session may be months old. Its creation date is not the process start date.
    const dir = path.join(root, 'sessions');
    try {
      const matches = fs.readdirSync(dir, { recursive: true })
        .filter((f) => path.basename(f).startsWith('rollout-') && f.endsWith(`-${id}.jsonl`));
      if (matches.length !== 1) return null;
      const file = path.join(dir, matches[0]);
      paths.set(key, file);
      return file;
    } catch {
      return null;
    }
  }

  return async (pid, hint = {}) => {
    const opened = await files(pid);
    const direct = [...new Set(opened.filter(isRollout))];
    if (direct.length) return direct.length === 1 ? direct[0] : null;
    const title = String(hint.title || '').trim();
    const cwd = (await cwdOf(pid)) || hint.cwd;
    if (!title || !cwd) return null;
    const logDb = opened.find((f) => /^logs_\d+\.sqlite$/.test(path.basename(f)));
    const root = logDb ? path.dirname(logDb) : home;
    const directory = path.basename(cwd.replaceAll('\\', '/'));
    const ids = [...names(root)].filter(([, name]) => title === name
      || title === `${name} | ${directory}` || title === `${name} | ${hostname}`);
    if (ids.length !== 1) return null;
    const id = ids[0][0];
    const file = rollout(root, id);
    const meta = file && metadata(file);
    return meta?.id === id && sameCwd(meta.cwd, cwd) ? file : null;
  };
}
