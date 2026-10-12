import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandHome, sh } from './util.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = process.env.FMUX_CONFIG || path.join(os.homedir(), '.config', 'fmux', 'config.json');

const DEFAULTS = {
  app: { id: '', tenant: 'feishu', secret: null },
  owner: { openId: '', chatId: '' },
  stateDir: '~/.local/state/fmux',
  socket: '',
  poll: { intervalMs: 2000 },
  tmux: { hide: [] },
  notify: {
    // Notify about a session nobody is attached to once a turn ran at least this long.
    minWorkSec: 20,
    // Skip those notifications while a tmux client saw keyboard input this recently.
    quietIfLocalActiveSec: 180,
    enabled: true,
  },
  // How a new session starts each agent. {name} is the tmux session name, {id} a conversation id.
  // `continue` resumes the latest conversation of the directory, `resume` a chosen one.
  // {flags} is filled with `flags` unless the session is created with "no -d / --yolo".
  agents: {
    claude: {
      // -d is Claude Code's debug mode. The auto permission mode is what skips the prompts.
      flags: '-d --permission-mode auto',
      command: 'claude {flags} -n {name}',
      continue: 'claude {flags} -c',
      resume: 'claude {flags} -r {id}',
      // Answer Claude Code's "do you trust this folder" prompt: the owner chose the directory.
      autoTrust: true,
    },
    codex: { flags: '--yolo', command: 'codex {flags}', continue: 'codex {flags} resume --last', resume: 'codex {flags} resume {id}' },
    pi: { flags: '', command: 'pi', continue: 'pi -c' },
    shell: { flags: '', command: '' },
  },
  concierge: {
    enabled: true,
    bin: 'pi',
    model: '',
    thinking: '',
  },
};

function merge(base, over) {
  if (over === undefined) return base;
  if (base === null || typeof base !== 'object' || Array.isArray(base) || over === null || typeof over !== 'object' || Array.isArray(over)) return over;
  const out = { ...base };
  for (const key of Object.keys(over)) out[key] = merge(base[key], over[key]);
  return out;
}

export function loadConfig(file = CONFIG_PATH) {
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const cfg = merge(DEFAULTS, raw);
  cfg.stateDir = expandHome(cfg.stateDir);
  cfg.socket = process.env.FMUX_SOCK || cfg.socket || socketPath(cfg.stateDir);
  return cfg;
}

// The config file as written, without defaults: what setup reads and rewrites.
export function readRawConfig(file = CONFIG_PATH) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

export function writeRawConfig(config, file = CONFIG_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

// Where the hub listens. Linux has a runtime directory for each user. macOS has none, so the
// socket is in the state directory, which the service and a shell both find without an
// environment variable. Windows has no socket files: the hub listens on a named pipe.
export function socketPath(stateDir = expandHome(DEFAULTS.stateDir), { platform = process.platform, env = process.env, user } = {}) {
  if (platform === 'win32') {
    // Pipe names are shared by the whole machine, so each user has their own.
    user ??= env.USERNAME || os.userInfo().username;
    return `\\\\.\\pipe\\fmux-${String(user).replace(/[^\w.-]/g, '_')}`;
  }
  const runtime = platform === 'linux' ? env.XDG_RUNTIME_DIR : '';
  return path.join(runtime && fs.existsSync(runtime) ? runtime : stateDir, 'fmux.sock');
}

export const isPipe = (socket) => String(socket).startsWith('\\\\.\\pipe\\');

// The app secret is never stored in the config. It is read at start from where it already lives.
export async function resolveSecret(ref) {
  if (!ref) throw new Error('config.app.secret is not set');
  if (ref.source === 'env') {
    const value = process.env[ref.name];
    if (!value) throw new Error(`environment variable ${ref.name} is empty`);
    return value;
  }
  if (ref.source === 'file') return fs.readFileSync(expandHome(ref.path), 'utf8').trim();
  if (ref.source === 'exec') {
    const out = await sh(expandHome(ref.command), ref.args || [], { input: JSON.stringify({ protocolVersion: 1, ids: [ref.id] }), timeout: 15000 });
    const reply = JSON.parse(out);
    const value = reply.values?.[ref.id];
    if (!value) throw new Error(`secret provider returned nothing for ${ref.id}: ${reply.errors?.[ref.id]?.message || 'no value'}`);
    return value;
  }
  throw new Error(`unknown secret source: ${ref.source}`);
}
