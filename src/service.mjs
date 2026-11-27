// Keep the hub running: systemd on Linux, launchd on macOS, and a tmux session where neither is
// there. Windows has neither, so there the tmux session (psmux) is the way.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import {
  HUB_SESSION, LAUNCHD_LABEL, LAUNCHD_LOG,
  hubBatch, hubCommand, launchdPlist, serviceCommands, serviceEnv, serviceUnit, startupBatch, startupFile,
} from './service/templates.mjs';
import { TMUX_BIN } from './tmux.mjs';
import { sh, sleep } from './util.mjs';

export {
  HUB_SESSION, LAUNCHD_LABEL,
  hubBatch, hubCommand, launchdPlist, serviceCommands, serviceEnv, serviceUnit, startupBatch, startupFile,
};

const WINDOWS = process.platform === 'win32';
const SYSTEMD_UNIT = path.join(os.homedir(), '.config', 'systemd', 'user', 'fmux.service');
const LAUNCHD_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);

export function isWsl(release = os.release()) {
  return process.platform === 'linux' && /microsoft/i.test(release);
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
