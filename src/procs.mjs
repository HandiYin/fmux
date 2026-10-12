import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, sh } from './util.mjs';

// How fmux looks at processes. Linux (WSL included) reads /proc. Windows asks its process table
// through PowerShell. Every other system (macOS, the BSDs) asks ps and lsof.
// FMUX_PROCS=ps forces that last way on Linux, for tests.
export const BACKEND = process.env.FMUX_PROCS || { linux: 'proc', win32: 'win' }[process.platform] || 'ps';

const JS_RUNTIMES = new Set(['node', 'MainThread', 'bun', 'deno']);
const AGENTS = new Set(['claude', 'codex', 'pi']);

// The first word of a command line. On Windows it can be a quoted path with spaces.
function firstWord(args) {
  const quoted = /^"([^"]*)"/.exec(args);
  return quoted ? quoted[1] : args.split(/\s+/)[0] || '';
}

// "claude" from "/usr/bin/claude", "-zsh" (a login shell) or "C:\Users\me\.local\bin\claude.exe".
function baseName(word) {
  return (word || '').split(/[/\\]/).pop().replace(/^-/, '').replace(/\.(exe|cmd|bat)$/i, '');
}

// The kind of agent a process is, or null. `comm` is the short process name, `args` the command
// line as one string. macOS names a process after the file it runs, and for Claude Code that
// file is named after its version, so the first word of the command line counts too.
export function classify(comm, args = '') {
  const line = args.replace(/\\/g, '/');
  const first = firstWord(line);
  const name = baseName(first);
  comm = baseName(comm);
  if (AGENTS.has(comm)) return comm;
  if (AGENTS.has(name)) return name;
  if (first.includes('/claude/versions/')) return 'claude';
  if (JS_RUNTIMES.has(comm) || JS_RUNTIMES.has(name)) {
    if (/pi-coding-agent|\/bin\/pi(["\s]|$)/.test(line)) return 'pi';
    if (/@openai\/codex|\/bin\/codex(["\s]|$)/.test(line)) return 'codex';
    if (/claude-code|\/bin\/claude(["\s]|$)/.test(line)) return 'claude';
  }
  return null;
}

// Is this agent run by a program and not by a person at the terminal? Windows cannot tell what
// a process reads from, so there the command line has to say it: a subcommand such as
// `codex app-server`, or a flag such as `claude -p`, before the first plain word. Words after
// that are a prompt and prove nothing.
const SCRIPT_SUBCOMMANDS = { codex: ['app-server', 'exec', 'mcp-server', 'mcp', 'proto'] };
const SCRIPT_FLAGS = { claude: ['-p', '--print'], pi: ['-p', '--print'] };
export function drivenByScript(kind, args = '') {
  const words = (args.match(/"[^"]*"|\S+/g) || []).map((w) => w.replace(/"/g, ''));
  let i = 1;
  if (JS_RUNTIMES.has(baseName(words[0]).toLowerCase())) {
    while (i < words.length && words[i].startsWith('-')) i++;
    i++;
  }
  const flags = [];
  for (; i < words.length && words[i].startsWith('-'); i++) flags.push(words[i].split('=')[0]);
  if (SCRIPT_SUBCOMMANDS[kind]?.includes(words[i])) return true;
  if (flags.some((flag) => SCRIPT_FLAGS[kind]?.includes(flag))) return true;
  return kind === 'pi' && /\s--mode[\s=]+(rpc|json)(\s|$)/.test(args);
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
  reads(pid, entry, tty) {
    try {
      return fs.readlinkSync(`/proc/${pid}/fd/0`) === tty;
    } catch {
      return false;
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

// -b: lsof looks at every mount point when it starts, and without this flag it waits on one
// that does not answer (a network share that is down). Returns null when lsof fails.
async function lsof(pid, fds) {
  try {
    return parseLsof(await sh('lsof', ['-b', '-w', '-n', '-P', '-a', '-p', String(pid), ...(fds ? ['-d', fds] : []), '-F', 'fn'], { timeout: 4000 }));
  } catch (err) {
    // lsof exits with 1 when the process is gone or shows nothing
    return err.killed ? null : [];
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
  async reads(pid, entry, tty) {
    const known = stdins.get(pid);
    if (same(known, entry)) return known.stdin === tty;
    const files = await lsof(pid, '0');
    const stdin = files?.find((f) => f.fd === '0')?.name || '';
    // An lsof that ran out of time says nothing about the process: ask again at the next poll.
    if (entry && files) stdins.set(pid, { ppid: entry.ppid, args: entry.args, stdin });
    return stdin === tty;
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
    return (await lsof(pid, 'cwd'))?.find((f) => f.fd === 'cwd')?.name || null;
  },
  async openFiles(pid) {
    return ((await lsof(pid)) || []).map((f) => f.name);
  },
};

// ---- Windows: the process table, through PowerShell ----

// Output of src/win/procs.ps1 for one table: "pid<TAB>ppid<TAB>start ms<TAB>name<TAB>command line".
export function parseWinProcs(text) {
  const procs = new Map();
  for (const line of text.split(/\r?\n/)) {
    const [pid, ppid, started, name, ...rest] = line.split('\t');
    if (!/^\d+$/.test(pid) || !/^\d+$/.test(ppid || '')) continue;
    procs.set(Number(pid), { ppid: Number(ppid), comm: baseName(name || '').toLowerCase(), args: rest.join(' ').trim(), startMs: Number(started) || 0 });
  }
  return procs;
}

// Starting PowerShell costs about a second, so one PowerShell stays up and prints the table
// every two seconds. A snapshot is the newest table it printed.
const watcher = {
  child: null,
  latest: null,
  waiting: [],
  buffer: '',
  startedAt: 0,
  start() {
    // A PowerShell that cannot run (a policy forbids it) is not started again at every poll.
    if (this.child || Date.now() - this.startedAt < 30000) return;
    this.startedAt = Date.now();
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'win', 'procs.ps1');
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ParentPid', String(process.pid)];
    const child = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => log('warn', 'procs.powershell', { text: chunk.trim().slice(0, 300) }));
    const gone = (why) => {
      if (this.child !== child) return;
      this.child = null;
      this.buffer = '';
      log('warn', 'procs.powershell.exit', { why: String(why) });
      for (const done of this.waiting.splice(0)) done();
    };
    child.on('error', (err) => gone(err.message));
    child.on('exit', (code) => gone(`exit ${code}`));
    process.once('exit', () => child.kill());
  },
  onData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const end = this.buffer.indexOf('<<end>>');
      if (end < 0) return;
      const table = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + '<<end>>'.length);
      const failed = /^<<error>>\t(.*)$/m.exec(table);
      if (failed) log('warn', 'procs.powershell.query', { message: failed[1].trim() });
      else this.latest = parseWinProcs(table);
      for (const done of this.waiting.splice(0)) done();
    }
  },
  // The newest table. The first call waits for PowerShell to print one.
  async table() {
    this.start();
    if (!this.latest) {
      await new Promise((resolve) => {
        this.waiting.push(resolve);
        setTimeout(resolve, 15000);
      });
    }
    return this.latest || new Map();
  },
};

const win = {
  async snapshot() {
    return index(await watcher.table());
  },
  args(pid, entry) {
    return entry?.args || '';
  },
  reads(pid, entry, tty, kind) {
    return !drivenByScript(kind, entry?.args);
  },
  startMs(pid) {
    return watcher.latest?.get(Number(pid))?.startMs || 0;
  },
  // Windows gives the working directory and the open files of another process only to a
  // debugger. The callers fall back to the directory tmux reports for the pane.
  cwd() {
    return null;
  },
  openFiles() {
    return [];
  },
};

const backend = { proc, ps, win }[BACKEND] || ps;

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
        if (kind && (await via.reads(pid, entry, tty, kind))) return { kind, pid };
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
