import { sh } from '../util.mjs';
import { baseName } from './common.mjs';

// macOS and the BSDs: ps and lsof.
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

export const psBackend = {
  async snapshot() {
    const procs = parsePs(await sh('ps', ['-A', '-ww', '-o', 'pid=,ppid=,tty=,args='], { env: PS_ENV }));
    for (const [pid, known] of stdins) if (!same(procs.get(pid), known)) stdins.delete(pid);
    return procs;
  },
  args(_pid, entry) {
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
