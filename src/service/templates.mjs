// Pure service unit, plist, shell loop, and Windows batch templates for fmux.
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../config.mjs';
import { shellQuote } from '../util.mjs';

export const LAUNCHD_LABEL = 'com.primatix.fmux';
// The tmux session that holds the hub where there is no service manager. The registry never lists it.
export const HUB_SESSION = 'fmux-hub';
export const LAUNCHD_LOG = path.join(os.homedir(), 'Library', 'Logs', 'fmux.log');

// The variables the service needs from the shell that installs it. tmux and the agent CLIs
// (claude, codex, pi) must be on this PATH. launchd starts a service without a locale.
export function serviceEnv(env = process.env) {
  const out = { PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin' };
  for (const name of ['FMUX_CONFIG', 'FMUX_SOCK', 'FMUX_FAKE']) if (env[name]) out[name] = env[name];
  if (process.platform === 'darwin') out.LANG = env.LC_ALL || env.LANG || 'en_US.UTF-8';
  return out;
}

// systemd reads a value up to the first space unless it is quoted, and "%" starts a specifier.
// A WSL PATH carries Windows directories such as "/mnt/c/Program Files".
function unitValue(s, { exec = false } = {}) {
  const text = String(s).replace(/%/g, '%%');
  if (/^[\w@:/.,+=%-]+$/.test(text)) return text;
  const quoted = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${exec ? quoted.replace(/\$/g, '$$$$') : quoted}"`;
}

export function serviceUnit({ node = process.execPath, root = ROOT, env = serviceEnv() } = {}) {
  return [
    '[Unit]',
    'Description=fmux: Feishu cards for tmux sessions',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${unitValue(node, { exec: true })} ${unitValue(path.join(root, 'bin', 'fmux.mjs'), { exec: true })}`,
    'Restart=always',
    'RestartSec=5',
    '# tmux and the agent CLIs (claude, codex, pi) must be on this PATH.',
    ...Object.entries(env).map(([name, value]) => `Environment=${unitValue(`${name}=${value}`)}`),
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function launchdPlist({ node = process.execPath, root = ROOT, env = serviceEnv(), logFile = LAUNCHD_LOG, home = os.homedir() } = {}) {
  const string = (s) => `<string>${xml(s)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${string(LAUNCHD_LABEL)}`,
    '  <key>ProgramArguments</key>',
    `  <array>${string(node)}${string(path.join(root, 'bin', 'fmux.mjs'))}</array>`,
    `  <key>WorkingDirectory</key>${string(home)}`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    '  <key>ThrottleInterval</key><integer>5</integer>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(env).map(([name, value]) => `    <key>${xml(name)}</key>${string(value)}`),
    '  </dict>',
    `  <key>StandardOutPath</key>${string(logFile)}`,
    `  <key>StandardErrorPath</key>${string(logFile)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// The command of the hub's tmux session: start the hub again 5 s after it stops.
export function hubCommand({ node = process.execPath, root = ROOT, env = serviceEnv() } = {}) {
  const vars = Object.entries(env).map(([name, value]) => shellQuote(`${name}=${value}`));
  const run = ['env', ...vars, shellQuote(node), shellQuote(path.join(root, 'bin', 'fmux.mjs'))].join(' ');
  return `while true; do ${run}; echo "fmux stopped, starting again in 5 s (Ctrl+C twice to end)"; sleep 5 || break; done`;
}

// Windows: the batch file that the hub's session runs. It starts the hub again 5 s after it stops.
// PATH is not written: the session has the PATH of the shell that installs, or of the logon.
const batchValue = (s) => String(s).replace(/%/g, '%%');
const batchEnv = (env) => Object.entries(env).filter(([name]) => name !== 'PATH').map(([name, value]) => `set "${name}=${batchValue(value)}"`);

export function hubBatch({ node = process.execPath, root = ROOT, env = serviceEnv() } = {}) {
  return [
    '@echo off',
    'rem Written by "fmux install-service". The fmux-hub session runs this file.',
    ...batchEnv(env),
    ':loop',
    `"${batchValue(node)}" "${batchValue(path.win32.join(root, 'bin', 'fmux.mjs'))}"`,
    'echo fmux stopped, starting again in 5 s',
    'ping -n 6 127.0.0.1 >nul',
    'goto loop',
    '',
  ].join('\r\n');
}

// Windows: a batch file in the Startup folder. At logon it brings the hub's session up again.
export function startupBatch({ node = process.execPath, root = ROOT, env = serviceEnv() } = {}) {
  return [
    '@echo off',
    'rem Written by "fmux install-service". Starts the fmux hub at logon. Delete this file to stop that.',
    ...batchEnv(env),
    `start "fmux" /min "${batchValue(node)}" "${batchValue(path.win32.join(root, 'bin', 'fmux.mjs'))}" install-service`,
    '',
  ].join('\r\n');
}

export function startupFile(env = process.env) {
  return path.win32.join(env.APPDATA || path.win32.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'fmux.cmd');
}

// Commands a person types to manage the service, for messages and for `fmux doctor`.
export function serviceCommands(kind) {
  const target = `gui/$(id -u)/${LAUNCHD_LABEL}`;
  if (kind === 'launchd') {
    return {
      status: `launchctl print ${target} | head -20`,
      stop: `launchctl bootout ${target}`,
      start: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`,
      restart: `launchctl kickstart -k ${target}`,
      logs: 'tail -n 30 ~/Library/Logs/fmux.log',
    };
  }
  if (kind === 'tmux') {
    return {
      status: `tmux has-session -t =${HUB_SESSION} && echo running`,
      stop: `tmux kill-session -t =${HUB_SESSION}`,
      start: 'fmux install-service --tmux',
      restart: 'fmux install-service --tmux',
      logs: `tmux capture-pane -p -S -200 -t =${HUB_SESSION}:`,
    };
  }
  return {
    status: 'systemctl --user status fmux',
    stop: 'systemctl --user stop fmux',
    start: 'systemctl --user start fmux',
    restart: 'systemctl --user restart fmux',
    logs: 'journalctl --user -u fmux -n 30 --no-pager',
  };
}
