import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultCodexHome, readCodexIndex, readCodexSessionMeta } from './agent-files.mjs';
import { openFiles, procCwd } from './procs.mjs';

const isRollout = (file) => /[/\\]sessions[/\\].*[/\\]rollout-.*\.jsonl$/.test(file);
const sameCwd = (a, b) => typeof a === 'string' && typeof b === 'string'
  && (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

// New Codex TUIs use a shared app-server, so the TUI no longer holds its rollout open.
// Match its displayed name to a unique indexed thread ID, never to the newest file in a cwd.
// Missing/ambiguous identity is deliberately unbound: forwarding another thread is worse
// than a visible "reply unavailable" notice. All Codex state is read-only.
export function createCodexLocator({ home = defaultCodexHome(), hostname = os.hostname(), files = openFiles, cwdOf = procCwd } = {}) {
  const indexes = new Map();
  const paths = new Map();

  function names(root) {
    const file = path.join(root, 'session_index.jsonl');
    try {
      const st = fs.statSync(file);
      const signature = `${st.mtimeMs}:${st.size}`;
      if (indexes.get(root)?.signature === signature) return indexes.get(root).names;
      const result = new Map();
      for (const [id, entry] of readCodexIndex(root)) {
        if (typeof entry.thread_name === 'string') result.set(id, entry.thread_name);
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
    // Codex decorates the same title with a spinner while working and a dot on completion.
    // While a dialog waits it prefixes "[ ! ] Action Required | ". Keep the literal form too:
    // a real name starting with a marker must not silently resolve to a different thread.
    const action = title.replace(/^\[\s*[.!]\s*\]\s*Action Required\s*\|\s*/iu, '');
    const titles = new Set();
    for (const form of [title, action]) {
      titles.add(form);
      titles.add(form.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●]\s+(?:\|\s+)?/u, ''));
    }
    const logDb = opened.find((f) => /^logs_\d+\.sqlite$/.test(path.basename(f)));
    const root = logDb ? path.dirname(logDb) : home;
    const directory = path.basename(cwd.replaceAll('\\', '/'));
    const ids = [...names(root)].filter(([, name]) => titles.has(name)
      || titles.has(`${name} | ${directory}`) || titles.has(`${name} | ${hostname}`));
    if (ids.length !== 1) return null;
    const id = ids[0][0];
    const file = rollout(root, id);
    const meta = file && readCodexSessionMeta(file);
    return meta?.id === id && sameCwd(meta.cwd, cwd) ? file : null;
  };
}
