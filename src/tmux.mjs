import { sh, sleep } from './util.mjs';

const SEP = '|#|';
const FIELDS = [
  'session_name', 'window_index', 'window_name', 'pane_index', 'pane_id', 'pane_pid',
  'pane_current_command', 'pane_current_path', 'pane_title', 'session_attached',
  'window_activity', 'pane_in_mode', 'pane_dead', 'session_windows', 'window_panes', 'pane_tty',
];

// Keys a card button or fmuxctl may send. Anything else is rejected.
export const KEYS = {
  enter: 'Enter', esc: 'Escape', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  tab: 'Tab', btab: 'BTab', space: 'Space', bs: 'BSpace',
  'c-c': 'C-c', 'c-d': 'C-d', 'c-u': 'C-u', 'c-l': 'C-l', 'c-o': 'C-o', 'c-r': 'C-r',
  pgup: 'PPage', pgdn: 'NPage',
  y: 'y', n: 'n',
  0: '0', 1: '1', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
};

function noServer(err) {
  return /no server running|No such file or directory|error connecting/i.test(`${err.stderr || ''} ${err.message || ''}`);
}

export async function listPanes() {
  let out;
  try {
    out = await sh('tmux', ['list-panes', '-a', '-F', FIELDS.map((f) => `#{${f}}`).join(SEP)]);
  } catch (err) {
    if (noServer(err)) return [];
    throw err;
  }
  const panes = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const v = line.split(SEP);
    if (v.length !== FIELDS.length) continue;
    const p = Object.fromEntries(FIELDS.map((f, i) => [f, v[i]]));
    if (p.pane_dead === '1') continue;
    panes.push({
      sessionName: p.session_name,
      windowIndex: Number(p.window_index),
      windowName: p.window_name,
      paneIndex: Number(p.pane_index),
      paneId: p.pane_id,
      panePid: Number(p.pane_pid),
      command: p.pane_current_command,
      cwd: p.pane_current_path,
      title: p.pane_title,
      tty: p.pane_tty,
      clients: Number(p.session_attached),
      activityAt: Number(p.window_activity) * 1000,
      inMode: p.pane_in_mode === '1',
      single: p.session_windows === '1' && p.window_panes === '1',
    });
  }
  return panes;
}

// Last time any tmux client received keyboard input, in ms. 0 when no client is attached.
export async function lastClientActivity() {
  try {
    const out = await sh('tmux', ['list-clients', '-F', '#{client_activity}']);
    return Math.max(0, ...out.split('\n').filter(Boolean).map((s) => Number(s) * 1000));
  } catch (err) {
    if (noServer(err)) return 0;
    throw err;
  }
}

export async function capture(paneId, { history = 0 } = {}) {
  const args = ['capture-pane', '-p', '-J', '-t', paneId];
  if (history > 0) args.push('-S', `-${history}`);
  const out = await sh('tmux', args);
  return out.replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
}

async function leaveCopyMode(paneId) {
  const inMode = (await sh('tmux', ['display-message', '-p', '-t', paneId, '#{pane_in_mode}'])).trim();
  if (inMode === '1') await sh('tmux', ['send-keys', '-t', paneId, '-X', 'cancel']);
}

// One line sent key by key. tmux reads a trailing ";" in an argument as a command separator, so it is escaped.
async function typeLine(paneId, line) {
  const clean = line.replace(/\t/g, '  ').replace(/[\u0000-\u001f\u007f]/g, '');
  if (!clean) return;
  await sh('tmux', ['send-keys', '-t', paneId, '-l', '--', clean.endsWith(';') ? `${clean.slice(0, -1)}\\;` : clean]);
}

const MAX_TYPED_LINES = 40;
const MAX_TYPED_CHARS = 4000;

// Can this text go in key by key, with Ctrl+J between lines? "@" opens a file picker in the
// agents' input box, where Enter would pick a file and not send the message.
export function canType(text) {
  return !text.includes('@') && text.length <= MAX_TYPED_CHARS && text.split('\n').length <= MAX_TYPED_LINES;
}

// Put text into a pane and press Enter.
//
// Pasted text (the default) goes through a tmux buffer and arrives as one block. An agent marks a
// multi-line paste as "pasted from somewhere else". `typed` is one line sent key by key before
// the paste: what the agent reads as written by its user. `keys: true` sends the whole text key
// by key, with `newline` (a tmux key name) between lines.
export async function sendText(paneId, text, { enter = true, typed = '', keys = false, newline = 'C-j' } = {}) {
  await leaveCopyMode(paneId);
  const lead = typed.replace(/\s+/g, ' ').trim();
  if (lead) {
    await typeLine(paneId, lead);
    if (text.length) await sh('tmux', ['send-keys', '-t', paneId, keys ? newline : 'Space']);
  }
  let pasted = false;
  if (keys && canType(text)) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await sh('tmux', ['send-keys', '-t', paneId, newline]);
      await typeLine(paneId, lines[i]);
    }
  } else if (text.length > 0) {
    // Not argv: tmux would read a trailing ";" as a command separator, and a long text may not fit.
    const buffer = `fmux-${process.pid}`;
    await sh('tmux', ['load-buffer', '-b', buffer, '-'], { input: text });
    await sh('tmux', ['paste-buffer', '-p', '-d', '-b', buffer, '-t', paneId]);
    pasted = true;
  }
  if (enter) {
    await sleep(pasted && (text.includes('\n') || text.length > 300) ? 450 : 150);
    await sh('tmux', ['send-keys', '-t', paneId, 'Enter']);
  }
}

export async function sendKeys(paneId, keys) {
  const mapped = keys.map((k) => {
    const key = KEYS[String(k).toLowerCase()];
    if (!key) throw new Error(`key not allowed: ${k}`);
    return key;
  });
  await leaveCopyMode(paneId);
  for (const key of mapped) {
    await sh('tmux', ['send-keys', '-t', paneId, key]);
    if (mapped.length > 1) await sleep(60);
  }
}

export const SESSION_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

export async function newSession({ name, cwd, command }) {
  if (!SESSION_NAME_RE.test(name)) throw new Error('会话名只能用字母、数字、_ 和 -（最长 40）');
  const args = ['new-session', '-d', '-s', name, '-x', '160', '-y', '48', '-c', cwd];
  // Under systemd, a tmux server started from here would live in the hub's control group and
  // die with every hub restart. A scope of its own keeps the first session alive.
  if (process.env.INVOCATION_ID) await sh('systemd-run', ['--user', '--scope', '--quiet', '--collect', 'tmux', ...args]);
  else await sh('tmux', args);
  if (command) {
    await sleep(300);
    await sendText(`=${name}:`, command);
  }
}

export async function killSession(name) {
  await sh('tmux', ['kill-session', '-t', `=${name}`]);
}
