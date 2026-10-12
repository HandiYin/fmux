// Keep the hub running: systemd on Linux, launchd on macOS, and a tmux session where neither is
// there. Windows has neither, so there the tmux session (psmux) is the way.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, loadConfig } from './config.mjs';
import { TMUX_BIN } from './tmux.mjs';
import { sh, shellQuote, sleep } from './util.mjs';

const WINDOWS = process.platform === 'win32';

export const LAUNCHD_LABEL = 'com.primatix.fmux';
// The tmux session that holds the hub where there is no service manager. The registry never lists it.
export const HUB_SESSION = 'fmux-hub';

const SYSTEMD_UNIT = path.join(os.homedir(), '.config', 'systemd', 'user', 'fmux.service');
const LAUNCHD_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const LAUNCHD_LOG = path.join(os.homedir(), 'Library', 'Logs', 'fmux.log');

export function isWsl(release = os.release()) {
  return process.platform === 'linux' && /microsoft/i.test(release);
}

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
function batchEnv(env) {
  return Object.entries(env).filter(([name]) => name !== 'PATH').map(([name, value]) => `set "${name}=${batchValue(value)}"`);
}
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

async function works(cmd, args) {
  try {
    await sh(cmd, args, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// Which way this machine keeps a service running.
export async function serviceKind({ platform = process.platform } = {}) {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux' && fs.existsSync('/run/systemd/system') && (await works('systemctl', ['--user', 'show-environment']))) return 'systemd';
  return 'tmux';
}

// The kind that is installed here, or else the one this machine would use.
export async function installedKind() {
  if (fs.existsSync(LAUNCHD_PLIST)) return 'launchd';
  if (fs.existsSync(SYSTEMD_UNIT)) return 'systemd';
  if (await works(TMUX_BIN, ['has-session', '-t', `=${HUB_SESSION}`])) return 'tmux';
  return serviceKind();
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

async function installSystemd({ print }) {
  fs.mkdirSync(path.dirname(SYSTEMD_UNIT), { recursive: true });
  fs.writeFileSync(SYSTEMD_UNIT, serviceUnit());
  await sh('systemctl', ['--user', 'daemon-reload']);
  await sh('systemctl', ['--user', 'enable', 'fmux.service']);
  await sh('systemctl', ['--user', 'restart', 'fmux.service']);
  return () => {
    print(`服务已启动：${SYSTEMD_UNIT}`);
    print('要让它在注销后继续运行、开机自启：loginctl enable-linger $USER');
    if (isWsl()) print('systemd 服务不能让 WSL 保持运行。关掉最后一个 WSL 窗口后 WSL 可能停止，要长期运行就留一个窗口开着。');
  };
}

async function installLaunchd({ print }) {
  const uid = process.getuid();
  fs.mkdirSync(path.dirname(LAUNCHD_PLIST), { recursive: true });
  fs.mkdirSync(path.dirname(LAUNCHD_LOG), { recursive: true });
  fs.writeFileSync(LAUNCHD_PLIST, launchdPlist());
  await sh('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`]).catch(() => {});
  let failure;
  // launchd unloads the old job a moment after bootout returns.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await sh('launchctl', ['bootstrap', `gui/${uid}`, LAUNCHD_PLIST]);
      failure = null;
      break;
    } catch (err) {
      failure = err;
      await sleep(1000);
    }
  }
  if (failure) {
    throw new Error(`launchctl bootstrap 失败：${(failure.stderr || failure.message).trim()}\n没有登录桌面的 Mac（只用 SSH）没有 gui 域，改用：fmux install-service --tmux`);
  }
  return () => {
    print(`服务已启动：${LAUNCHD_PLIST}`);
    print(`登录后自动启动。日志：${LAUNCHD_LOG}`);
  };
}

async function installTmux({ print }) {
  await sh(TMUX_BIN, ['kill-session', '-t', `=${HUB_SESSION}`]).catch(() => {});
  if (WINDOWS) return installPsmux({ print });
  // Not one string: tmux would hand that to the user's shell, which may be fish.
  await sh(TMUX_BIN, ['new-session', '-d', '-s', HUB_SESSION, '-c', os.homedir(), 'sh', '-c', hubCommand()]);
  return () => {
    print(`fmux 已在 tmux 会话 ${HUB_SESSION} 里运行（这个会话不出现在面板里）。`);
    print('它不会开机自启。要在登录时自动拉起，把这一行加到 ~/.profile（zsh 用 ~/.zprofile）：');
    print(`  tmux has-session -t =${HUB_SESSION} 2>/dev/null || fmux install-service --tmux >/dev/null`);
    if (isWsl()) print('WSL 里更好的做法是打开 systemd：在 /etc/wsl.conf 写 [boot] 和 systemd=true 两行，在 Windows 里运行 wsl --shutdown，再运行 fmux install-service。');
  };
}

async function installPsmux({ print }) {
  const { stateDir } = loadConfig();
  const hubFile = path.join(stateDir, 'hub.cmd');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(hubFile, hubBatch());
  await sh(TMUX_BIN, ['new-session', '-d', '-s', HUB_SESSION, '-c', os.homedir(), '--', 'cmd.exe', '/d', '/c', hubFile]);
  const startup = startupFile();
  let auto = true;
  try {
    fs.mkdirSync(path.dirname(startup), { recursive: true });
    fs.writeFileSync(startup, startupBatch());
  } catch {
    auto = false;
  }
  return () => {
    print(`fmux 已在 psmux 会话 ${HUB_SESSION} 里运行（这个会话不出现在面板里）。`);
    print(auto ? `登录 Windows 后自动启动：${startup}（删掉这个文件就不再自启）` : `没能写入启动文件夹（${startup}）。登录后要手动运行 fmux install-service。`);
    print('注销或重启后，psmux 里的其他会话不会保留，要重新开。');
  };
}

// Install and start the service with the node binary and PATH of this shell. Returns the kind used.
export async function installService({ kind, running, print = console.log } = {}) {
  kind ??= await serviceKind();
  const install = { systemd: installSystemd, launchd: installLaunchd, tmux: installTmux }[kind];
  if (!install) throw new Error(`unknown service kind: ${kind}`);
  const done = await install({ print });
  for (let i = 0; i < 30 && !(await running()); i++) await sleep(1000);
  if (!(await running())) throw new Error(`服务没有起来。看日志：${serviceCommands(kind).logs}`);
  done();
  return kind;
}
