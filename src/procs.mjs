import fs from 'node:fs';

// One pass over /proc: pid -> { ppid, comm } plus a parent -> children index.
export function snapshot() {
  const procs = new Map();
  const children = new Map();
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
    const pid = Number(name);
    const ppid = Number(stat.slice(close + 2).split(' ')[1]);
    procs.set(pid, { ppid, comm: stat.slice(open + 1, close) });
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  return { procs, children };
}

function cmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

export function classify(comm, argv) {
  if (comm === 'claude') return 'claude';
  if (comm === 'codex') return 'codex';
  if (comm === 'pi') return 'pi';
  if (comm === 'node' || comm === 'MainThread' || comm === 'bun') {
    const joined = argv.join(' ');
    if (/pi-coding-agent|\/bin\/pi(\s|$)/.test(joined)) return 'pi';
    if (/@openai\/codex|\/bin\/codex(\s|$)/.test(joined)) return 'codex';
    if (/claude-code|\/bin\/claude(\s|$)/.test(joined)) return 'claude';
  }
  return null;
}

function stdinPath(pid) {
  try {
    return fs.readlinkSync(`/proc/${pid}/fd/0`);
  } catch {
    return '';
  }
}

// Nearest agent process below the pane's root process (breadth first), or null for a plain shell.
// The agent must read from the pane's terminal: one that a script drives over a pipe
// (`codex app-server`, `pi --mode rpc`) is not something to type into.
export function findAgent(snap, rootPid, tty, maxDepth = 4) {
  let level = [rootPid];
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next = [];
    for (const pid of level) {
      const proc = snap.procs.get(pid);
      if (!proc) continue;
      const needsArgv = proc.comm === 'node' || proc.comm === 'MainThread' || proc.comm === 'bun';
      const kind = classify(proc.comm, needsArgv ? cmdline(pid) : []);
      if (kind && stdinPath(pid) === tty) return { kind, pid };
      next.push(...(snap.children.get(pid) || []));
    }
    level = next;
  }
  return null;
}

export function procStartMs(pid) {
  try {
    return fs.statSync(`/proc/${pid}`).ctimeMs;
  } catch {
    return 0;
  }
}

export function procCwd(pid) {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

export function openFiles(pid) {
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
}
