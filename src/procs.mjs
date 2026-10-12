import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sh } from './util.mjs';

// How fmux looks at processes. Linux (WSL included) reads /proc. Every other system
// (macOS, the BSDs) asks ps and lsof. FMUX_PROCS=ps forces the second way, for tests.
export const BACKEND = process.env.FMUX_PROCS || (process.platform === 'linux' ? 'proc' : 'ps');

const JS_RUNTIMES = new Set(['node', 'MainThread', 'bun', 'deno']);
const AGENTS = new Set(['claude', 'codex', 'pi']);

function baseName(word) {
  return path.basename(word || '').replace(/^-/, '');
}

// The kind of agent a process is, or null. `comm` is the short process name, `args` the command
// line as one string. macOS names a process after the file it runs, and for Claude Code that
// file is named after its version, so the first word of the command line counts too.
export function classify(comm, args = '') {
  const first = args.split(/\s+/)[0] || '';
  const name = baseName(first);
  if (AGENTS.has(comm)) return comm;
  if (AGENTS.has(name)) return name;
  if (first.includes('/claude/versions/')) return 'claude';
  if (JS_RUNTIMES.has(comm) || JS_RUNTIMES.has(name)) {
    if (/pi-coding-agent|\/bin\/pi(\s|$)/.test(args)) return 'pi';
    if (/@openai\/codex|\/bin\/codex(\s|$)/.test(args)) return 'codex';
    if (/claude-code|\/bin\/claude(\s|$)/.test(args)) return 'claude';
  }
  return null;
}

function index(procs) {
  const children = new Map();
  for (const [pid, proc] of procs) {
    if (!children.has(proc.ppid)) children.set(proc.ppid, []);
    children.get(proc.ppid).push(pid);
  }
  return { procs, children };
}

// ---- Linux: /proc ----

const proc = {
  snapshot() {
    const procs = new Map();
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      let stat;
      try {
        stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      } catch {
        continue;
      }
      const open = stat.indexOf('(');
      const close = stat.lastIndexOf(')');
      if (open < 0 || close < 0) continue;
      procs.set(Number(name), { ppid: Number(stat.slice(close + 2).split(' ')[1]), comm: stat.slice(open + 1, close) });
    }
    return index(procs);
  },
  args(pid) {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    } catch {
      return '';
    }
  },
  stdin(pid) {
    try {
      return fs.readlinkSync(`/proc/${pid}/fd/0`);
    } catch {
      return '';
    }
  },
  startMs(pid) {
    try {
      return fs.statSync(`/proc/${pid}`).ctimeMs;
    } catch {
      return 0;
    }
  },
  cwd(pid) {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  },
  openFiles(pid) {
    const out = [];
    try {
      for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
        try {
          out.push(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
        } catch {
          // fd closed between readdir and readlink
        }
      }
    } catch {
      // process gone or not ours
    }
    return out;
  },
};

// ---- macOS and the BSDs: ps and lsof ----

// The C locale keeps the start time in one format: "Mon Oct 12 14:35:02 2026".
const PS_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/;

// Output of `ps -A -o pid=,ppid=,tty=,lstart=,args=`.
export function parsePs(out) {
  const procs = new Map();
  for (const line of out.split('\n')) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    const args = m[5].trim();
    procs.set(Number(m[1]), {
      ppid: Number(m[2]),
      comm: baseName(args.split(/\s+/)[0]),
      args,
      // "ttys003" on macOS, "pts/3" on Linux, "??" or "?" for no terminal.
      tty: /^\?+$/.test(m[3]) || m[3] === '-' ? '' : `/dev/${m[3]}`,
      startMs: Date.parse(m[4].replace(/\s+/g, ' ')) || 0,
    });
  }
  return procs;
}

// Output of `lsof -F fn`: file descriptor -> name. A descriptor is "cwd", "txt" or a number.
export function parseLsof(out) {
  const files = [];
  let fd = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('f')) fd = line.slice(1);
    else if (line.startsWith('n')) files.push({ fd, name: line.slice(1) });
  }
  return files;
}

async function lsof(pid, fds) {
  try {
    return parseLsof(await sh('lsof', ['-w', '-n', '-P', '-a', '-p', String(pid), ...(fds ? ['-d', fds] : []), '-F', 'fn']));
  } catch {
    // lsof exits with 1 when the process is gone or shows nothing
    return [];
  }
}

// What a process reads from and where it stands do not change while it lives.
// Entries are keyed by pid and start time, and dropped when the process is gone.
const facts = new Map();

const ps = {
  async snapshot() {
    const procs = parsePs(await sh('ps', ['-A', '-ww', '-o', 'pid=,ppid=,tty=,lstart=,args='], { env: PS_ENV }));
    for (const [pid, fact] of facts) if (procs.get(pid)?.startMs !== fact.startMs) facts.delete(pid);
    return index(procs);
  },
  args(pid, entry) {
    return entry?.args || '';
  },
  async stdin(pid, entry) {
    const cached = facts.get(pid);
    if (cached && cached.startMs === entry?.startMs && cached.stdin !== undefined) return cached.stdin;
    const stdin = (await lsof(pid, '0')).find((f) => f.fd === '0')?.name || '';
    if (entry) facts.set(pid, { ...facts.get(pid), startMs: entry.startMs, stdin });
    return stdin;
  },
  async startMs(pid) {
    try {
      const out = await sh('ps', ['-o', 'lstart=', '-p', String(pid)], { env: PS_ENV });
      return Date.parse(out.trim().replace(/\s+/g, ' ')) || 0;
    } catch {
      return 0;
    }
  },
  async cwd(pid) {
    return (await lsof(pid, 'cwd')).find((f) => f.fd === 'cwd')?.name || null;
  },
  async openFiles(pid) {
    return (await lsof(pid)).map((f) => f.name);
  },
};

const backend = BACKEND === 'proc' ? proc : ps;

// One pass over all processes: pid -> { ppid, comm, … } plus a parent -> children index.
export async function snapshot() {
  return backend.snapshot();
}

// Claude Code writes ~/.claude/sessions/<pid>.json while it runs. A file left by a dead
// process whose pid went to another one is older than that process.
function hasClaudeSession(pid, startMs) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'sessions', `${pid}.json`), 'utf8'));
    return (meta.kind ?? 'interactive') === 'interactive' && (!startMs || !meta.startedAt || meta.startedAt >= startMs - 5000);
  } catch {
    return false;
  }
}

// Nearest agent process below the pane's root process (breadth first), or null for a plain shell.
// The agent must read from the pane's terminal: one that a script drives over a pipe
// (`codex app-server`, `pi --mode rpc`) is not something to type into.
export function finder(via) {
  return async function findAgent(snap, rootPid, tty, maxDepth = 4) {
    let level = [rootPid];
    for (let depth = 0; depth <= maxDepth && level.length; depth++) {
      const next = [];
      for (const pid of level) {
        const entry = snap.procs.get(pid);
        if (!entry) continue;
        next.push(...(snap.children.get(pid) || []));
        // ps knows the terminal a process belongs to. One on another terminal does not read from this pane.
        if (entry.tty !== undefined && entry.tty !== tty) continue;
        let kind = classify(entry.comm, await via.args(pid, entry));
        if (!kind && hasClaudeSession(pid, entry.startMs ?? (await via.startMs(pid)))) kind = 'claude';
        if (kind && (await via.stdin(pid, entry)) === tty) return { kind, pid };
      }
      level = next;
    }
    return null;
  };
}

export const findAgent = finder(backend);

export async function procStartMs(pid) {
  return backend.startMs(pid);
}

export async function procCwd(pid) {
  return backend.cwd(pid);
}

export async function openFiles(pid) {
  return backend.openFiles(pid);
}

export function alive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
