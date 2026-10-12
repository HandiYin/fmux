import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export function sh(cmd, args, { input, timeout = 8000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '');
        reject(err);
      } else {
        resolve(String(stdout));
      }
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function shortPath(p) {
  const home = os.homedir();
  if (!p) return '';
  return p === home ? '~' : p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`;
  return `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m`;
}

export function fmtClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Cut by code points so a surrogate pair is never split.
export function truncate(s, max, tail = '…') {
  const cps = Array.from(s ?? '');
  return cps.length <= max ? cps.join('') : cps.slice(0, max).join('') + tail;
}

export function truncateHead(s, max, head = '…') {
  const cps = Array.from(s ?? '');
  return cps.length <= max ? cps.join('') : head + cps.slice(cps.length - max).join('');
}

export function oneLine(s, max = 120) {
  return truncate(String(s ?? '').replace(/\s+/g, ' ').trim(), max);
}

export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

let logSink = (line) => process.stderr.write(line + '\n');
export function setLogSink(fn) {
  logSink = fn;
}
export function log(level, event, fields = {}) {
  logSink(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
}
