import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { log, oneLine } from './util.mjs';

const uid = (prefix) => `${prefix}_${crypto.randomBytes(4).toString('hex')}`;

// Match a single standard 5-field cron token against an integer value.
function matchCronField(expr, value) {
  for (const part of String(expr).split(',')) {
    const [range, stepStr] = part.trim().split('/');
    const step = stepStr ? Math.max(1, Number(stepStr)) : 1;
    if (range === '*') {
      if (value % step === 0) return true;
      continue;
    }
    if (range.includes('-')) {
      const [lo, hi] = range.split('-').map(Number);
      if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
      continue;
    }
    if (Number(range) === value) return true;
  }
  return false;
}

export function cronMatches(expr, date = new Date()) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return matchCronField(fields[0], date.getMinutes())
    && matchCronField(fields[1], date.getHours())
    && matchCronField(fields[2], date.getDate())
    && matchCronField(fields[3], date.getMonth() + 1)
    && matchCronField(fields[4], date.getDay());
}

// Manages persistent Heartbeat scheduled tasks and Long-Horizon Goals with supervisor check-ins.
export class OpsEngine extends EventEmitter {
  constructor({ router, stateDir = '', tickMs = 15000 }) {
    super();
    this.router = router;
    this.file = stateDir ? path.join(stateDir, 'ops.json') : '';
    this.tickMs = tickMs;
    this.data = { heartbeats: [], goals: [] };
    this.timer = null;
    this.running = new Set();
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(parsed.heartbeats)) this.data.heartbeats = parsed.heartbeats;
      if (Array.isArray(parsed.goals)) this.data.goals = parsed.goals;
    } catch {
      // start clean if file is damaged
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  changed() {
    this.save();
    this.emit('changed');
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((err) => log('warn', 'ops.tick', { message: err.message })), this.tickMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  snapshot() {
    return {
      heartbeats: this.data.heartbeats,
      goals: this.data.goals,
    };
  }

  // ---- 1. Heartbeat Scheduled Tasks ----

  addHeartbeat({
    name,
    scheduleKind = 'interval',
    everyMinutes = 30,
    cron = '',
    targetMode = 'session',
    targetRef = '',
    agent = 'agy',
    cwd = '~',
    prompt = '',
    enabled = true,
  }) {
    if (!String(prompt || '').trim()) throw new Error('heartbeat prompt is required');
    if (scheduleKind === 'cron' && String(cron).trim().split(/\s+/).length !== 5) {
      throw new Error('cron must be a 5-field expression (e.g. "*/15 * * * *")');
    }
    const mins = Math.max(1, Number(everyMinutes) || 30);
    const now = Date.now();
    const hb = {
      id: uid('hb'),
      name: String(name || '').trim() || oneLine(prompt, 32),
      enabled: Boolean(enabled),
      scheduleKind: scheduleKind === 'cron' ? 'cron' : 'interval',
      everyMinutes: mins,
      cron: String(cron || '').trim(),
      targetMode: targetMode === 'spawn' ? 'spawn' : 'session',
      targetRef: String(targetRef || '').trim(),
      agent: String(agent || 'agy').trim(),
      cwd: String(cwd || '~').trim(),
      prompt: String(prompt).trim(),
      createdAt: now,
      lastRunAt: 0,
      lastCronMinute: '',
      nextRunAt: scheduleKind === 'cron' ? null : now + mins * 60000,
      lastStatus: 'idle',
      lastNote: '',
      history: [],
    };
    this.data.heartbeats.unshift(hb);
    this.changed();
    return hb;
  }

  updateHeartbeat(id, patch = {}) {
    const hb = this.data.heartbeats.find((x) => x.id === id);
    if (!hb) throw new Error(`heartbeat not found: ${id}`);
    for (const key of ['name', 'enabled', 'scheduleKind', 'everyMinutes', 'cron', 'targetMode', 'targetRef', 'agent', 'cwd', 'prompt']) {
      if (patch[key] !== undefined) hb[key] = patch[key];
    }
    hb.everyMinutes = Math.max(1, Number(hb.everyMinutes) || 30);
    hb.nextRunAt = hb.enabled && hb.scheduleKind === 'interval' ? Date.now() + hb.everyMinutes * 60000 : null;
    this.changed();
    return hb;
  }

  deleteHeartbeat(id) {
    const before = this.data.heartbeats.length;
    this.data.heartbeats = this.data.heartbeats.filter((x) => x.id !== id);
    if (this.data.heartbeats.length === before) throw new Error(`heartbeat not found: ${id}`);
    this.changed();
    return { deleted: id };
  }

  async runHeartbeat(id, { manual = false } = {}) {
    const hb = this.data.heartbeats.find((x) => x.id === id);
    if (!hb) throw new Error(`heartbeat not found: ${id}`);
    if (this.running.has(hb.id)) return { ok: false, note: 'already running' };
    this.running.add(hb.id);
    const now = Date.now();
    hb.lastRunAt = now;
    if (hb.scheduleKind === 'interval') hb.nextRunAt = now + hb.everyMinutes * 60000;
    try {
      let targetSession = hb.targetMode === 'session' && hb.targetRef ? this.router.registry.resolve(hb.targetRef) : null;
      let actionNote = '';
      if (targetSession) {
        const sent = await this.router.deliver(targetSession, `[HEARTBEAT:${hb.name}]\n${hb.prompt}`);
        if (!sent) throw new Error(`session ${targetSession.name} is blocked on a dialog`);
        actionNote = `dispatched to ${targetSession.name}`;
      } else {
        const sess = await this.router.createSession({
          name: '',
          agent: hb.agent || 'agy',
          cwd: hb.cwd || '~',
          prompt: hb.prompt,
          resume: 'new',
          yolo: true,
        });
        targetSession = sess;
        actionNote = `spawned ${sess.name} (${hb.agent}, yolo)`;
      }
      hb.lastStatus = 'ok';
      hb.lastNote = `${manual ? 'manual · ' : ''}${actionNote}`;
      hb.history.unshift({ at: now, ok: true, session: targetSession.name, note: hb.lastNote });
      hb.history = hb.history.slice(0, 12);
      log('info', 'ops.heartbeat.run', { id: hb.id, name: hb.name, session: targetSession.name });
      this.changed();
      return { ok: true, session: targetSession.name, note: hb.lastNote };
    } catch (err) {
      hb.lastStatus = 'error';
      hb.lastNote = err.message;
      hb.history.unshift({ at: now, ok: false, session: hb.targetRef || '', note: err.message });
      hb.history = hb.history.slice(0, 12);
      log('warn', 'ops.heartbeat.error', { id: hb.id, message: err.message });
      this.changed();
      return { ok: false, error: err.message };
    } finally {
      this.running.delete(hb.id);
    }
  }

  // ---- 2. Long-Horizon Goals & Supervision ----

  addGoal({
    title,
    objective = '',
    criteria = '',
    workerRef = '',
    workerAgent = 'agy',
    supervisorRef = '',
    checkEveryMinutes = 30,
    progress = 0,
  }) {
    if (!String(title || '').trim()) throw new Error('goal title is required');
    const now = Date.now();
    const goal = {
      id: uid('goal'),
      title: String(title).trim(),
      objective: String(objective || '').trim(),
      criteria: String(criteria || '').trim(),
      status: 'active',
      workerRef: String(workerRef || '').trim(),
      workerAgent: String(workerAgent || 'agy').trim(),
      supervisorRef: String(supervisorRef || '').trim(),
      checkEveryMinutes: Math.max(0, Number(checkEveryMinutes) || 0),
      progress: Math.max(0, Math.min(100, Number(progress) || 0)),
      lastCheckAt: 0,
      createdAt: now,
      updatedAt: now,
      notes: [],
    };
    this.data.goals.unshift(goal);
    this.changed();
    return goal;
  }

  updateGoal(id, patch = {}) {
    const goal = this.data.goals.find((x) => x.id === id);
    if (!goal) throw new Error(`goal not found: ${id}`);
    for (const key of ['title', 'objective', 'criteria', 'status', 'workerRef', 'workerAgent', 'supervisorRef', 'checkEveryMinutes']) {
      if (patch[key] !== undefined) goal[key] = patch[key];
    }
    if (patch.progress !== undefined) goal.progress = Math.max(0, Math.min(100, Number(patch.progress) || 0));
    if (patch.note) {
      goal.notes.unshift({ at: Date.now(), by: String(patch.by || 'operator'), text: String(patch.note).trim() });
      goal.notes = goal.notes.slice(0, 30);
    }
    goal.updatedAt = Date.now();
    this.changed();
    return goal;
  }

  deleteGoal(id) {
    const before = this.data.goals.length;
    this.data.goals = this.data.goals.filter((x) => x.id !== id);
    if (this.data.goals.length === before) throw new Error(`goal not found: ${id}`);
    this.changed();
    return { deleted: id };
  }

  // Dispatch a supervision inspection prompt into the designated supervisor conversation.
  async superviseGoal(id, { manual = false } = {}) {
    const goal = this.data.goals.find((x) => x.id === id);
    if (!goal) throw new Error(`goal not found: ${id}`);
    const supervisor = goal.supervisorRef ? this.router.registry.resolve(goal.supervisorRef) : null;
    if (!supervisor) throw new Error(`supervisor session not found: "${goal.supervisorRef || '(unset)'}"`);
    const worker = goal.workerRef ? this.router.registry.resolve(goal.workerRef) : null;
    const workerInfo = worker
      ? `${worker.name} (${worker.kind}, status=${worker.status}${worker.note ? `, ${worker.note}` : ''})\n最近输出摘要：${oneLine(worker.lastText || '(暂无)', 280)}`
      : `${goal.workerRef || '未指定'}（当前未在 tmux 中找到）`;
    const directive = [
      `【长期目标监督检查 · ${goal.title}】`,
      `当前状态：${goal.status} · 进度：${goal.progress}%`,
      goal.objective ? `目标说明：${goal.objective}` : '',
      goal.criteria ? `验收标准：${goal.criteria}` : '',
      `执行会话：${workerInfo}`,
      '请检查执行会话进展（可用 fmuxctl peek / fmuxctl tasks / fmuxctl ls 查看），判断是否有偏差或阻塞，必要时纠偏或推进下一步。',
    ].filter(Boolean).join('\n');

    const sent = await this.router.deliver(supervisor, directive);
    if (!sent) throw new Error(`supervisor session ${supervisor.name} is blocked on a dialog`);
    const now = Date.now();
    goal.lastCheckAt = now;
    goal.updatedAt = now;
    goal.notes.unshift({ at: now, by: manual ? 'manual-check' : 'auto-check', text: `已向监督会话 ${supervisor.name} 发送进度检查` });
    goal.notes = goal.notes.slice(0, 30);
    log('info', 'ops.goal.supervise', { id: goal.id, title: goal.title, supervisor: supervisor.name });
    this.changed();
    return { ok: true, supervisor: supervisor.name };
  }

  async tick(nowDate = new Date()) {
    const now = nowDate.getTime();
    const minuteTag = `${nowDate.getFullYear()}-${nowDate.getMonth()}-${nowDate.getDate()}-${nowDate.getHours()}-${nowDate.getMinutes()}`;

    for (const hb of this.data.heartbeats) {
      if (!hb.enabled) continue;
      if (hb.scheduleKind === 'cron') {
        if (hb.lastCronMinute !== minuteTag && cronMatches(hb.cron, nowDate)) {
          hb.lastCronMinute = minuteTag;
          await this.runHeartbeat(hb.id);
        }
      } else if (hb.nextRunAt && now >= hb.nextRunAt) {
        await this.runHeartbeat(hb.id);
      }
    }

    for (const goal of this.data.goals) {
      if (goal.status !== 'active' || !(goal.checkEveryMinutes > 0) || !goal.supervisorRef) continue;
      const elapsed = now - (goal.lastCheckAt || goal.createdAt);
      if (elapsed >= goal.checkEveryMinutes * 60000) {
        await this.superviseGoal(goal.id).catch((err) => {
          goal.lastCheckAt = now;
          goal.notes.unshift({ at: now, by: 'auto-check', text: `监督检查失败：${err.message}` });
          goal.notes = goal.notes.slice(0, 30);
          this.changed();
        });
      }
    }
  }
}
