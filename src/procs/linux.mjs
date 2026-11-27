import fs from 'node:fs';

// Linux (WSL included): read process metadata directly from /proc.
export const procBackend = {
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
    return procs;
  },
  args(pid) {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    } catch {
      return '';
    }
  },
  reads(pid, _entry, tty) {
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
