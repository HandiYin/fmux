import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../util.mjs';
import { baseName, drivenByScript } from './common.mjs';

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
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'win', 'procs.ps1');
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

export const winBackend = {
  async snapshot() {
    return watcher.table();
  },
  args(_pid, entry) {
    return entry?.args || '';
  },
  reads(_pid, entry, _tty, kind) {
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
