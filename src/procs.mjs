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

const PS_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/;

// Output of `ps -A -o pid=,ppid=,tty=,args=`.
export function parsePs(out) {
  const procs = new Map();
  for (const line of out.split('\n')) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    const args = m[4].trim();
    procs.set(Number(m[1]), {
      ppid: Number(m[2]),
      comm: baseName(args.split(/\s+/)[0]),
      args,
      // "ttys003" on macOS, "pts/3" on Linux, "??" or "?" for no terminal.
      tty: /^\?+$/.test(m[3]) || m[3] === '-' ? '' : `/dev/${m[3]}`,
    });
  }
  return procs;
}

// Output of `ps -o etime=`: how long a process has run, as [[dd-]hh:]mm:ss. Returns seconds.
export function parseEtime(out) {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(out.trim());
  return m ? ((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3])) * 60 + Number(m[4]) : null;
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

// What a process reads from does not change while it lives, so lsof runs once for each process.
// An entry is dropped when its pid is gone or belongs to another command.
const stdins = new Map();
const same = (a, b) => a && b && a.ppid === b.ppid && a.args === b.args;

const ps = {
  async snapshot() {
    const procs = parsePs(await sh('ps', ['-A', '-ww', '-o', 'pid=,ppid=,tty=,args='], { env: PS_ENV }));
    for (const [pid, known] of stdins) if (!same(procs.get(pid), known)) stdins.delete(pid);
    return index(procs);
  },
  args(pid, entry) {
    return entry?.args || '';
  },
  async stdin(pid, entry) {
    const known = stdins.get(pid);
    if (same(known, entry)) return known.stdin;
    const stdin = (await lsof(pid, '0')).find((f) => f.fd === '0')?.name || '';
    if (entry) stdins.set(pid, { ppid: entry.ppid, args: entry.args, stdin });
    return stdin;
  },
  async startMs(pid) {
    try {
      const seconds = parseEtime(await sh('ps', ['-o', 'etime=', '-p', String(pid)], { env: PS_ENV }));
      return seconds === null ? 0 : Date.now() - seconds * 1000;
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
async function hasClaudeSession(pid, startMs) {
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'sessions', `${pid}.json`), 'utf8'));
  } catch {
    return false;
  }
  if ((meta.kind ?? 'interactive') !== 'interactive') return false;
  const started = await startMs();
  return !started || !meta.startedAt || meta.startedAt >= started - 5000;
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
        if (!kind && (await hasClaudeSession(pid, () => via.startMs(pid)))) kind = 'claude';
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
