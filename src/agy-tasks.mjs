import { parseJsonLines, readTailSlice } from './jsonl.mjs';
import { oneLine } from './util.mjs';

const MAX_FINISHED_TASKS = 15;
const SEED_MAX_BYTES = 4 * 1024 * 1024;
const BRAIN_CONV_RE = /[/\\]brain[/\\]([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})[/\\]/i;
const UUID_PREFIX_RE = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/task-\d+$/i;

export function convIdFromTranscript(file) {
  const m = BRAIN_CONV_RE.exec(String(file || ''));
  return m ? m[1].toLowerCase() : '';
}

function belongsToOwner(taskId, ownerId) {
  if (!ownerId || !taskId) return true;
  const m = UUID_PREFIX_RE.exec(String(taskId));
  // If taskId carries a "<conv-uuid>/task-<N>" prefix, it MUST match this session's own conversation UUID.
  if (m && m[1].toLowerCase() !== ownerId.toLowerCase()) return false;
  return true;
}

// Apply a task lifecycle event (`task_start`, `task_tick`, `task_end`, `tasks_reset`) onto a session's Map<taskId, task>.
export function applyTaskEvent(tasks, ev, { ownerId = '' } = {}) {
  if (!ev) return false;
  if (ev.type === 'tasks_reset') {
    let changed = false;
    for (const t of tasks.values()) {
      if (t.status === 'running') {
        t.status = 'killed';
        t.endedAt = ev.endedAt || Date.now();
        if (ev.summary) t.summary = ev.summary;
        changed = true;
      }
    }
    if (changed) pruneTasks(tasks);
    return changed;
  }
  if (!ev.taskId || !belongsToOwner(ev.taskId, ownerId)) return false;
  if (ev.type === 'task_start') {
    tasks.set(ev.taskId, {
      id: ev.taskId,
      shortId: ev.shortId || ev.taskId.split('/').pop(),
      kind: ev.kind || 'command',
      description: ev.description || ev.shortId || ev.taskId,
      logFile: ev.logFile || '',
      status: 'running',
      startedAt: ev.startedAt || Date.now(),
      endedAt: null,
      summary: '',
    });
    pruneTasks(tasks);
    return true;
  }
  if (ev.type === 'task_tick') {
    const existing = tasks.get(ev.taskId);
    if (existing) {
      if (ev.status === 'running') {
        existing.status = 'running';
        existing.endedAt = null;
      }
      if (ev.logFile && !existing.logFile) existing.logFile = ev.logFile;
      if (ev.summary) existing.summary = ev.summary;
      existing.lastTickAt = ev.endedAt || Date.now();
    } else if (ev.status === 'running') {
      tasks.set(ev.taskId, {
        id: ev.taskId,
        shortId: ev.taskId.split('/').pop(),
        kind: ev.taskId.includes('/task-') ? 'command' : 'subagent',
        description: ev.summary || ev.taskId.split('/').pop(),
        logFile: ev.logFile || '',
        status: 'running',
        startedAt: ev.endedAt || Date.now(),
        endedAt: null,
        summary: ev.summary || '',
      });
    }
    return true;
  }
  if (ev.type === 'task_end') {
    const existing = tasks.get(ev.taskId);
    if (existing) {
      existing.status = ev.status || 'done';
      existing.endedAt = ev.endedAt || Date.now();
      if (ev.summary) existing.summary = ev.summary;
    } else {
      tasks.set(ev.taskId, {
        id: ev.taskId,
        shortId: ev.taskId.split('/').pop(),
        kind: ev.taskId.includes('/task-') ? 'command' : 'subagent',
        description: ev.taskId.split('/').pop(),
        logFile: '',
        status: ev.status || 'done',
        startedAt: ev.endedAt || Date.now(),
        endedAt: ev.endedAt || Date.now(),
        summary: ev.summary || '',
      });
    }
    pruneTasks(tasks);
    return true;
  }
  return false;
}

// Keep every running task plus the most recent finished tasks.
function pruneTasks(tasks) {
  const finished = [...tasks.values()]
    .filter((t) => t.status !== 'running')
    .sort((a, b) => (b.endedAt || b.startedAt) - (a.endedAt || a.startedAt));
  for (const old of finished.slice(MAX_FINISHED_TASKS)) tasks.delete(old.id);
}

// Reconstruct currently running and recent background tasks when attaching to an existing agy transcript.
export function seedTasksFromTranscript(file, adapter, maxBytes = SEED_MAX_BYTES) {
  const tasks = new Map();
  let model = '';
  const ownerId = convIdFromTranscript(file);
  const text = readTailSlice(file, maxBytes);
  if (text === null) return { tasks, model };
  for (const row of parseJsonLines(text)) {
    for (const ev of adapter(row)) {
      if (ev.type === 'model' && ev.model) model = ev.model;
      else if (ev.type === 'task_start' || ev.type === 'task_tick' || ev.type === 'task_end' || ev.type === 'tasks_reset') {
        applyTaskEvent(tasks, ev, { ownerId });
      }
    }
  }
  return { tasks, model };
}

export function runningTasks(session) {
  if (!session?.tasks) return [];
  return [...session.tasks.values()]
    .filter((t) => t.status === 'running')
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function listTasks(session) {
  if (!session?.tasks) return [];
  return [...session.tasks.values()].sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (b.status === 'running' && a.status !== 'running') return 1;
    return (b.endedAt || b.startedAt) - (a.endedAt || a.startedAt);
  });
}

// Read the last `maxLines` of a background task's log file (when available on disk).
export function readTaskLog(task, { maxLines = 40, maxBytes = 64 * 1024 } = {}) {
  if (!task?.logFile) return '';
  const raw = readTailSlice(task.logFile, maxBytes);
  if (raw === null) return '';
  return raw.replace(/\r\n/g, '\n').split('\n').slice(-maxLines).join('\n').trim();
}

export function taskNote(session) {
  const running = runningTasks(session);
  if (!running.length) return '';
  const head = oneLine(running[0].description, 36);
  return running.length === 1 ? `后台任务：${head}` : `后台任务 ${running.length} 个：${head}`;
}
