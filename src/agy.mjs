import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { agyTranscriptPath, defaultAgyHome } from './agent-files.mjs';
import { readTailSlice } from './jsonl.mjs';
import { openFiles, procArgs } from './procs.mjs';
import { oneLine } from './util.mjs';

const PRESENCE_RE = /[/\\]presence[/\\]([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.lock$/i;
const CONV_DB_RE = /[/\\]conversations[/\\]([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.db$/i;
const CLI_LOG_RE = /[/\\]log[/\\]cli-[^/\\]+\.log$/i;
const LOG_CONV_RE = /(?:(?:Resuming|Streaming|Starting conversation update stream for|Forwarding user message to|Sending user message to|Full redraw completed[^\n]*?for|Created)\s+conversation\s+|cascade_id:)([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/gi;
const RESUME_FLAG_RE = /(?:^|\s)(?:-r|--resume)(?:=|\s+)([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\s|$)/i;
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// Unwrap agy's JSON-encoded string values inside tool_calls[].args (e.g. "\"ls -la\"" -> "ls -la").
function unwrapArg(val) {
  if (typeof val !== 'string') return val;
  if (val.startsWith('"') || val.startsWith('{') || val.startsWith('[')) {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val;
}

function agyToolSummary(name, rawArgs = {}) {
  const args = {};
  for (const [k, v] of Object.entries(rawArgs || {})) args[k] = unwrapArg(v);
  if (args.toolSummary) return oneLine(String(args.toolSummary), 90);
  if (args.CommandLine) return oneLine(String(args.CommandLine), 90);
  if (args.Description) return oneLine(String(args.Description), 90);
  if (args.Role) return oneLine(String(args.Role), 90);
  if (args.Path) return path.basename(String(args.Path));
  if (args.Prompt) return oneLine(String(args.Prompt), 90);
  if (args.CronExpression) return `cron ${args.CronExpression}`;
  if (args.DurationSeconds) return `timer ${args.DurationSeconds}s`;
  if (args.Action && args.TaskId) return `${args.Action} ${String(args.TaskId).split('/').pop()}`;
  if (args.query) return oneLine(String(args.query), 90);
  return '';
}

function extractUserRequest(content) {
  const raw = String(content || '');
  const matches = [...raw.matchAll(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/g)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  if (matches.length) return matches.join('\n');
  const stripped = raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
    .trim();
  return stripped;
}

function classifyBackgroundKind(description, logFile) {
  if (/^(Timer|Cron):/i.test(description)) return 'schedule';
  if (/workflow/i.test(description) || /workflow/i.test(logFile)) return 'workflow';
  return 'command';
}

function parseGenericTasks(d) {
  const content = String(d.content || '');
  const ts = Date.parse(d.created_at) || Date.now();
  const events = [];

  // Background command, timer/cron schedule, or workflow:
  // Real background launches have status === 'RUNNING' and a clean "<uuid>/task-<N>" line.
  const bgMatch = d.status === 'RUNNING'
    && content.match(/^Tool is running as a background task with task id:\s*([0-9a-f-]+\/task-\d+)\s*$/m);
  if (bgMatch) {
    const taskId = bgMatch[1].trim();
    const shortId = taskId.split('/').pop();
    const descMatch = content.match(/^Task Description:\s*([^\n]+)/m);
    const logMatch = content.match(/^Task logs are available at:\s*file:\/\/([^\s\n]+)/m);
    const description = descMatch ? oneLine(descMatch[1], 140) : shortId;
    const logFile = logMatch ? logMatch[1].trim() : '';
    const kind = classifyBackgroundKind(description, logFile);
    events.push({ type: 'task_start', taskId, shortId, kind, description, logFile, startedAt: ts });
    return events;
  }

  // Subagent launched: "Created the following subagent:\n{ \"conversationId\": \"...\" }"
  if (/^Created the following subagent:\r?\n\{/m.test(content)) {
    const idMatch = content.match(/"conversationId"\s*:\s*"([0-9a-f-]+)"/i);
    const logMatch = content.match(/"logAbsoluteUri"\s*:\s*"file:\/\/([^"]+)"/);
    if (idMatch) {
      const taskId = idMatch[1];
      events.push({
        type: 'task_start',
        taskId,
        shortId: `sub-${taskId.slice(0, 6)}`,
        kind: 'subagent',
        description: `Subagent ${taskId.slice(0, 8)}`,
        logFile: logMatch ? logMatch[1] : '',
        startedAt: ts,
      });
    }
    return events;
  }

  // Reconcile from `manage_task` status checks ("Task: <id>\nStatus: RUNNING|COMPLETED|...").
  const statusMatch = content.match(/^Task:\s*([0-9a-f-]+\/task-\d+)\s*\r?\nStatus:\s*(\w+)/m);
  if (statusMatch) {
    const taskId = statusMatch[1].trim();
    const st = statusMatch[2].toUpperCase();
    const logMatch = content.match(/^Log:\s*file:\/\/([^\s\n]+)/m);
    const logFile = logMatch ? logMatch[1].trim() : '';
    if (st === 'RUNNING') {
      events.push({ type: 'task_tick', taskId, status: 'running', logFile, endedAt: ts });
    } else if (['COMPLETED', 'DONE', 'FAILED', 'CANCELED', 'CANCELLED', 'KILLED', 'ERROR'].includes(st)) {
      const norm = st === 'FAILED' || st === 'ERROR' ? 'error' : (st === 'COMPLETED' || st === 'DONE' ? 'done' : 'killed');
      events.push({ type: 'task_end', taskId, status: norm, endedAt: ts });
    }
    return events;
  }

  // Attempting to kill an already-finished task reconciles stale running status.
  const notRunning = String(d.error || content).match(/cannot kill task "([^"]+)":\s*task is not running/i);
  if (notRunning) {
    events.push({ type: 'task_end', taskId: notRunning[1], status: 'done', summary: '已结束', endedAt: ts });
  }
  return events;
}

function parseSystemMessage(d) {
  const content = String(d.content || '');
  const ts = Date.parse(d.created_at) || Date.now();
  const msgMatch = content.match(/\[Message\][^\n]*?sender=(\S+)[^\n]*?content=([\s\S]*)$/);
  if (!msgMatch) return [];
  const sender = msgMatch[1];
  const body = msgMatch[2].replace(/<\/SYSTEM_MESSAGE>\s*$/g, '').trim();

  // Server restart stops all prior subagents and background tasks in this conversation.
  if (/All your subagents and background tasks have been stopped/i.test(body)) {
    return [{ type: 'tasks_reset', summary: '会话重启已停止', endedAt: ts }];
  }

  // Background task finished (command, one-shot timer, workflow):
  const finished = body.match(/Task id "([^"]+)" finished with result:\s*([\s\S]*)/);
  if (finished) {
    const taskId = finished[1];
    const resultText = finished[2].trim();
    const exitMatch = resultText.match(/Command exited with code (\d+)/);
    const failed = (exitMatch && exitMatch[1] !== '0') || /\b(error|failed|exception)\b/i.test(resultText.slice(0, 200));
    const summary = exitMatch
      ? `exit ${exitMatch[1]}`
      : oneLine(resultText.split('\n').find((l) => l.trim() && !l.startsWith('The tool\'s output')) || '已完成', 100);
    return [{ type: 'task_end', taskId, status: failed ? 'error' : 'done', summary, endedAt: ts }];
  }

  // Background task explicitly canceled:
  const canceled = body.match(/Task id "([^"]+)" was canceled/i);
  if (canceled) {
    return [{ type: 'task_end', taskId: canceled[1], status: 'killed', summary: '已取消', endedAt: ts }];
  }

  // Notification from a task sender:
  // "Background command is still running after 900s" (NotificationTimeoutSeconds) and recurring crons MUST stay running!
  if (sender.includes('/task-')) {
    const stillRunning = /is still running|still running after|cron|recurring/i.test(body);
    return [{
      type: stillRunning ? 'task_tick' : 'task_end',
      taskId: sender,
      status: stillRunning ? 'running' : 'done',
      summary: oneLine(body, 100),
      endedAt: ts,
    }];
  }
  if (UUID_RE.test(sender)) {
    return [{ type: 'task_end', taskId: sender, status: 'done', summary: oneLine(body, 100), endedAt: ts }];
  }
  return [];
}

// Adapter for Antigravity CLI (`agy`) transcript_full.jsonl / transcript.jsonl lines.
export function agyAdapter(d) {
  if (!d || typeof d !== 'object') return [];
  if (d.type === 'USER_INPUT') {
    const text = extractUserRequest(d.content);
    return text ? [{ type: 'user', text }] : [];
  }
  if (d.type === 'PLANNER_RESPONSE') {
    const out = [];
    if (d.model) out.push({ type: 'model', model: d.model });
    if (typeof d.thinking === 'string' && d.thinking.trim()) {
      out.push({ type: 'thinking', text: d.thinking.trim() });
    }
    const tools = Array.isArray(d.tool_calls) ? d.tool_calls : [];
    for (const tc of tools) {
      out.push({ type: 'tool', name: tc.name, summary: agyToolSummary(tc.name, tc.args || tc.arguments) });
      // Detect explicit task kill via manage_task.
      if (tc.name === 'manage_task') {
        const action = unwrapArg((tc.args || tc.arguments)?.Action);
        const taskId = unwrapArg((tc.args || tc.arguments)?.TaskId);
        if (action === 'kill' && taskId) {
          out.push({ type: 'task_end', taskId, status: 'killed', summary: '已终止', endedAt: Date.parse(d.created_at) || Date.now() });
        }
      }
    }
    if (typeof d.content === 'string' && d.content.trim()) {
      out.push({ type: 'text', text: d.content.trim() });
    }
    if (d.status === 'DONE' && tools.length === 0) {
      out.push({ type: 'turn_end' });
    }
    return out;
  }
  if (d.type === 'GENERIC') return parseGenericTasks(d);
  if (d.type === 'SYSTEM_MESSAGE') return parseSystemMessage(d);
  return [];
}

// Locate an active or idle `agy` process's exact conversation transcript via:
//   1. open presence/<uuid>.lock or conversations/<uuid>.db FD (when running)
//   2. open log/cli-*.log FD (held open for the entire lifetime of agy, even when idle)
//   3. cmdline `-r <uuid>` / `--resume <uuid>` fallback
export function createAgyLocator({ home = defaultAgyHome(), files = openFiles, argsOf = procArgs } = {}) {
  return async (pid) => {
    const opened = await files(pid);
    for (const file of opened) {
      const m = PRESENCE_RE.exec(file);
      if (m) {
        const root = path.dirname(path.dirname(file));
        return agyTranscriptPath(m[1], root);
      }
    }
    for (const file of opened) {
      const m = CONV_DB_RE.exec(file);
      if (m) {
        const root = path.dirname(path.dirname(file));
        return agyTranscriptPath(m[1], root);
      }
    }
    for (const file of opened) {
      if (!CLI_LOG_RE.test(file)) continue;
      const tail = readTailSlice(file, 256 * 1024);
      if (!tail) continue;
      let lastId = '';
      for (const m of tail.matchAll(LOG_CONV_RE)) lastId = m[1];
      if (lastId) {
        const root = path.dirname(path.dirname(file));
        const found = agyTranscriptPath(lastId, root);
        if (found) return found;
      }
    }
    try {
      const cmd = await argsOf(pid);
      const m = RESUME_FLAG_RE.exec(String(cmd || ''));
      if (m) return agyTranscriptPath(m[1], home);
    } catch {
      // process exited or unreadable
    }
    return null;
  };
}

// While an `agy` turn is actively executing (including long thinking pauses and tool calls),
// `agy` holds `conversations/<uuid>.db` open and closes it as soon as the turn finishes or cancels.
export async function hasAgyActiveDb(pid, { files = openFiles } = {}) {
  if (!pid) return false;
  try {
    const opened = await files(pid);
    return opened.some((f) => CONV_DB_RE.test(f));
  } catch {
    return false;
  }
}

const DEFAULT_AGY_MODEL_LINES = [
  ['gemini-4-neon-xhigh', 'Gemini 4 Neon (XHigh)'],
  ['gemini-4-neon-high', 'Gemini 4 Neon (High)'],
  ['gemini-4-neon-medium', 'Gemini 4 Neon (Medium)'],
  ['gemini-4-neon-low', 'Gemini 4 Neon (Low)'],
  ['gemini-4-carbon-high', 'Gemini 4 Carbon (High)'],
  ['gemini-4-carbon-medium', 'Gemini 4 Carbon (Medium)'],
  ['gemini-4-carbon-low', 'Gemini 4 Carbon (Low)'],
  ['gemini-4-argon-high', 'Gemini 4 Argon (High)'],
  ['gemini-4-argon-medium', 'Gemini 4 Argon (Medium)'],
  ['gemini-4-argon-low', 'Gemini 4 Argon (Low)'],
  ['gemini-4-hydrogen-xhigh', 'Gemini 4 Hydrogen (XHigh)'],
  ['gemini-4-hydrogen-high', 'Gemini 4 Hydrogen (High)'],
  ['gemini-4-hydrogen-medium', 'Gemini 4 Hydrogen (Medium)'],
  ['gemini-4-hydrogen-low', 'Gemini 4 Hydrogen (Low)'],
  ['gemini-pro-orchestrator-neon', 'Orchestrator (Neon)'],
  ['gemini-pro-orchestrator', 'Orchestrator (Carbon)'],
  ['gemini-pro-orchestrator-argon', 'Orchestrator (Argon)'],
  ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
  ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)'],
  ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'],
  ['claude-opus-5-5-high', 'Claude Opus 5.5 (High)'],
  ['claude-opus-5-5-medium', 'Claude Opus 5.5 (Medium)'],
  ['claude-opus-5-5-low', 'Claude Opus 5.5 (Low)'],
  ['claude-sonnet-5-5-high', 'Claude Sonnet 5.5 (High)'],
  ['claude-sonnet-5-5-medium', 'Claude Sonnet 5.5 (Medium)'],
  ['claude-sonnet-5-5-low', 'Claude Sonnet 5.5 (Low)'],
  ['gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)'],
];

function buildAgyModelEntry(id, label) {
  const m = String(label || '').match(/^(.+?)\s+\((Low|Medium|High|XHigh|Max)\)$/i);
  if (m) {
    return { id, label: label.trim(), family: m[1].trim(), effort: m[2].toLowerCase() };
  }
  const idEff = String(id || '').match(/-(low|medium|high|xhigh|max)$/i);
  return { id, label: label.trim(), family: label.trim(), effort: idEff ? idEff[1].toLowerCase() : '' };
}

export function parseAgyModelsOutput(raw) {
  const clean = String(raw || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n');
  const seen = new Map();
  for (const line of clean.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || /fetching available models/i.test(trimmed)) continue;
    const m = trimmed.match(/^([a-z0-9][a-z0-9._-]{2,})\s{2,}(.+?)\s*$/i);
    if (!m) continue;
    seen.set(m[1], buildAgyModelEntry(m[1], m[2]));
  }
  return [...seen.values()];
}

export const DEFAULT_AGY_MODELS = DEFAULT_AGY_MODEL_LINES.map(([id, label]) => buildAgyModelEntry(id, label));

let cachedAgyModels = null;
let cachedAgyModelsAt = 0;

export async function listAgyModels({ force = false, execImpl = execFile } = {}) {
  if (!force && cachedAgyModels && Date.now() - cachedAgyModelsAt < 10 * 60 * 1000) {
    return cachedAgyModels;
  }
  const parsed = await new Promise((resolve) => {
    execImpl('agy', ['models'], {
      timeout: 6000,
      env: { ...process.env, PATH: `${process.env.HOME || ''}/.local/bin:${process.env.PATH || ''}` },
    }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(parseAgyModelsOutput(stdout));
    });
  });
  cachedAgyModels = parsed.length ? parsed : DEFAULT_AGY_MODELS;
  cachedAgyModelsAt = Date.now();
  return cachedAgyModels;
}

// Parse live model & reasoning effort from the bottom status line of an `agy` tmux pane, e.g.:
//   "? for shortcuts                                         Gemini 4 Carbon · high"
//   "esc to cancel                                           Gemini 4 Neon · xhigh"
//   "? for shortcuts                                         Orchestrator (Carbon)"
export function parseAgyFooter(screen) {
  const lines = String(screen || '').split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-5);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const m = line.match(/(?:(?:\?\s+for\s+shortcuts|esc\s+to\s+cancel).*?\s{2,}|\s{6,})([A-Za-z][A-Za-z0-9 .()+-]{2,48}?)(?:\s*·\s*(low|medium|high|xhigh|max))?\s*$/i);
    if (!m) continue;
    const family = m[1].trim();
    if (/^(for shortcuts|to cancel|ctrl\+|shift\+)/i.test(family)) continue;
    const effort = m[2] ? m[2].toLowerCase() : '';
    return { family, effort, display: effort ? `${family} · ${effort}` : family };
  }
  return null;
}

export function inferEffortFromModel(model) {
  const s = String(model || '').trim();
  const dot = s.match(/·\s*(low|medium|high|xhigh|max)\s*$/i);
  if (dot) return dot[1].toLowerCase();
  const paren = s.match(/\((low|medium|high|xhigh|max)\)\s*$/i);
  if (paren) return paren[1].toLowerCase();
  const dash = s.match(/-(low|medium|high|xhigh|max)$/i);
  if (dash) return dash[1].toLowerCase();
  return '';
}

let agyMetaCache = { mtimeMs: 0, titles: new Map() };

export function readAgyConversationTitle(convId, home = defaultAgyHome()) {
  if (!convId) return '';
  const metaFile = path.join(home, 'cache', 'conversation_metadata.json');
  try {
    const st = fs.statSync(metaFile);
    if (st.mtimeMs !== agyMetaCache.mtimeMs) {
      const parsed = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      const titles = new Map();
      for (const [id, entry] of Object.entries(parsed?.conversations || {})) {
        const t = entry?.summary?.Title;
        if (typeof t === 'string' && t.trim()) titles.set(id.toLowerCase(), t.trim());
      }
      agyMetaCache = { mtimeMs: st.mtimeMs, titles };
    }
    return agyMetaCache.titles.get(String(convId).toLowerCase()) || '';
  } catch {
    return '';
  }
}
