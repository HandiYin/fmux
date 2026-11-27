import { readClaudeMeta } from './agent-files.mjs';
import { classify, drivenByScript, indexProcs } from './procs/common.mjs';
import { procBackend } from './procs/linux.mjs';
import { parseEtime, parseLsof, parsePs, psBackend } from './procs/posix.mjs';
import { parseWinProcs, winBackend } from './procs/win.mjs';

export { classify, drivenByScript, parseEtime, parseLsof, parsePs, parseWinProcs };

// How fmux looks at processes. Linux (WSL included) reads /proc. Windows asks its process table
// through PowerShell. Every other system (macOS, the BSDs) asks ps and lsof.
// FMUX_PROCS=ps forces that last way on Linux, for tests.
export const BACKEND = process.env.FMUX_PROCS || { linux: 'proc', win32: 'win' }[process.platform] || 'ps';

const backend = { proc: procBackend, ps: psBackend, win: winBackend }[BACKEND] || psBackend;

// One pass over all processes: pid -> { ppid, comm, … } plus a parent -> children index.
export async function snapshot() {
  return indexProcs(await backend.snapshot());
}

// Claude Code writes ~/.claude/sessions/<pid>.json while it runs. A file left by a dead
// process whose pid went to another one is older than that process.
async function hasClaudeSession(pid, startMs) {
  const meta = readClaudeMeta(pid);
  if (!meta || (meta.kind ?? 'interactive') !== 'interactive') return false;
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

export async function procArgs(pid) {
  return backend.args(pid);
}

export function alive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
