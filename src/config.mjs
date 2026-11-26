import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandHome, sh } from './util.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = process.env.FMUX_CONFIG || path.join(os.homedir(), '.config', 'fmux', 'config.json');
// Groups are closed with a chat id that cannot exist so only the owner's direct chat reaches the hub.
export const CLOSED_GROUPS = ['oc_fmux_groups_closed'];
export const feishuDomain = (tenant) => (tenant === 'lark' ? { domain: 'https://open.larksuite.com' } : {});

const DEFAULTS = {
  app: { id: '', tenant: 'feishu', secret: null },
  owner: { openId: '', chatId: '' },
  stateDir: '~/.local/state/fmux',
  socket: '',
  poll: { intervalMs: 2000 },
  lifecycle: { enabled: true, idleMinutes: 60, restoreTimeoutMs: 30000 },
  tmux: { hide: [], include: [], exclude: [] },
  sessions: { namePrefix: '', onConflict: 'error' },
  notify: {
    // Notify about a session nobody is attached to once a turn ran at least this long.
    minWorkSec: 20,
    // Skip those notifications while a tmux client saw keyboard input this recently.
    quietIfLocalActiveSec: 180,
    // false: no completion or dialog card from a session that is not attached.
    enabled: true,
    scope: 'all',
    completionPing: true,
    detachedCompletion: true,
  },
  attach: {
    // Return to the dashboard after this many minutes without input, while the session is idle.
    // 0 keeps the attachment until the owner leaves explicitly.
    idleMinutes: 10,
  },
  live: {
    // How long a session or terminal card keeps refreshing itself.
    peekMinutes: 10,
  },
  web: {
    // Built-in HTTP + SSE web UI (Arknights PRTS console: Sessions, Heartbeat, Goals, GPU).
    enabled: false,
    host: '127.0.0.1',
    port: 18790,
    // Optional access token (?token=... or Authorization: Bearer ...).
    token: '',
    // Optional public HTTPS URL (e.g. Tailscale Funnel / reverse proxy) shown on Feishu cards & OIDC callback.
    publicUrl: '',
    oidc: {
      // Enable Feishu/Lark OIDC browser login reusing app.id + app.secret, restricted to owner.openId.
      enabled: false,
      redirectUri: '',
      allowedOpenIds: [],
      sessionHours: 24,
    },
  },
  highlight: {
    // DeepSeek API fast model for Agentboard-style message highlights & TL;DR.
    // Reads apiKey from config, DEEPSEEK_API_KEY env, or ~/.dsh/.credentials.yaml automatically.
    enabled: true,
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: '',
  },
  // How a new session starts each agent inside tmux. All coding agents default to full-permission (yolo) mode.
  agents: {
    claude: {
      flags: '--dangerously-skip-permissions',
      command: 'claude {flags} -n {name}',
      continue: 'claude {flags} -c',
      resume: 'claude {flags} -r {id}',
      autoTrust: true,
    },
    codex: { flags: '--yolo', command: 'codex {flags}', continue: 'codex {flags} resume --last', resume: 'codex {flags} resume {id}' },
    agy: {
      flags: '--dangerously-skip-permissions',
      command: 'agy {flags}',
      continue: 'agy {flags} -c',
      resume: 'agy {flags} -r {id}',
      promptFlag: '-i',
    },
    dsh: {
      // dsh-tui uses ~/.dsh-tui/permission.json ("danger-full-access") for full-permission DeepSeek sessions.
      flags: '',
      command: 'dsh-tui',
      continue: 'dsh-tui -c',
      resume: 'dsh-tui --resume {id}',
      promptFlag: '--',
    },
    pi: { flags: '', command: 'pi', continue: 'pi -c' },
    shell: { flags: '', command: '' },
  },
  concierge: {
    enabled: true,
    bin: 'pi',
    model: 'openai-codex/gpt-6.1-sol',
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
  const userFile = process.env.FMUX_USER_CONFIG || path.join(path.dirname(file), 'userconfig.json');
  const user = fs.existsSync(userFile) ? JSON.parse(fs.readFileSync(userFile, 'utf8')) : {};
  for (const key of Object.keys(user)) {
    if (!['tmux', 'notify', 'sessions', 'lifecycle', 'live', 'concierge', 'agents', 'attach', 'web', 'highlight'].includes(key)) {
      throw new Error(`Unsupported userconfig setting: ${key}`);
    }
  }
  const cfg = merge(merge(DEFAULTS, raw), user);
  const idleMinutes = Number(cfg.attach.idleMinutes);
  if (!Number.isFinite(idleMinutes) || idleMinutes < 0) throw new Error('attach.idleMinutes must be a number >= 0');
  cfg.attach.idleMinutes = idleMinutes;
  if (!['all', 'followed'].includes(cfg.notify.scope)) throw new Error('notify.scope must be all or followed');
  if (!['error', 'replace-idle'].includes(cfg.sessions.onConflict)) throw new Error('sessions.onConflict must be error or replace-idle');
  if (typeof cfg.sessions.namePrefix !== 'string' || !/^[A-Za-z0-9_-]*$/.test(cfg.sessions.namePrefix)) throw new Error('Invalid sessions.namePrefix');
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
