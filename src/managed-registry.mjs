import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Registry } from './registry.mjs';
import * as realTmux from './tmux.mjs';
import { log, quoteArg, sleep } from './util.mjs';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const LOGICAL = /^session:[0-9a-f-]{36}$/i;

// Never resume "the latest in this directory": retirement needs an exact identity.
export function conversationId(session) {
  if (session.kind === 'claude') {
    if (!session.transcript || !fs.existsSync(session.transcript)) return null;
    const id = session.conversationId || path.basename(session.transcript || '', '.jsonl');
    return UUID.test(id) ? id : null;
  }
  if (session.kind !== 'codex' || !session.transcript) return null;
  let fd;
  try {
    fd = fs.openSync(session.transcript, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const row = JSON.parse(buffer.toString('utf8', 0, n).split('\n')[0]);
    return row.type === 'session_meta' && UUID.test(row.payload?.id) ? row.payload.id : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The router sees durable conversation handles. Only this layer addresses tmux panes.
export class ManagedRegistry extends Registry {
  constructor({ cfg, store, tmux = realTmux, probe, now = Date.now, wait = sleep } = {}) {
    super({ tmux, intervalMs: cfg.poll.intervalMs, ...cfg.tmux });
    Object.assign(this, { cfg, store, rawTmux: tmux, now, wait });
    this.liveRegistry = new Registry({ tmux, intervalMs: this.intervalMs, ...cfg.tmux, probe });
    this.records = new Map(Object.entries(store.get('managedSessions') || {}));
    this.rawKeys = new Map();
    this.operations = new Map();
    this.policies = new Map();
    this.replacing = new Set();
    this.starting = new Map(Object.entries(store.get('startingSessions') || {}));
    this.restoring = new Set([...this.records].filter(([, r]) => r.restoring).map(([key]) => key));
    for (const [key, record] of this.records) if (this.allows(record.tmuxSession)) this.sessions.set(key, this.dormant(record));
    for (const event of ['added', 'output', 'status', 'blocked', 'turn_end']) {
      this.liveRegistry.on(event, (raw, ...args) => this.emit(event, this.convert(raw), ...args));
    }
    this.liveRegistry.on('removed', (raw) => {
      const key = this.rawKeys.get(raw.key);
      this.rawKeys.delete(raw.key);
      const session = this.sessions.get(key);
      if (!session) return;
      if (this.replacing.has(key)) return;
      if (session.paneId && session.paneId !== raw.key) return;
      if (this.records.has(key)) Object.assign(session, this.dormant(this.records.get(key)));
      else { this.sessions.delete(key); this.emit('removed', session); }
    });
    const pane = (key) => {
      const session = this.sessions.get(key);
      if (!session?.paneId) throw new Error('会话正在休眠；发送消息后会自动恢复。');
      return session.paneId;
    };
    this.transport = {
      ...tmux,
      capture: async (key, options) => {
        const session = this.sessions.get(key);
        return session?.dormant ? session.lastText || '会话已休眠，发送消息会自动恢复。' : tmux.capture(pane(key), options);
      },
      sendText: (key, text, options) => this.use(key, (s) => tmux.sendText(s.paneId, text, options)),
      sendKeys: (key, keys) => this.use(key, (s) => tmux.sendKeys(s.paneId, keys), { allowBlocked: true }),
      killSession: async (name) => {
        const first = this.list().find((s) => s.tmuxSession === name);
        if (!first) throw new Error('会话已删除。');
        return this.exclusive(first.key, async () => {
          const targets = this.list().filter((s) => s.tmuxSession === name);
          if (targets.some((s) => !s.dormant)) await tmux.killSession(name);
          for (const s of targets) {
            this.records.delete(s.key);
            this.sessions.delete(s.key);
            this.policies.delete(s.key);
            this.restoring.delete(s.key);
            this.starting.delete(s.key);
            this.emit('removed', s);
          }
          this.save(true);
        });
      },
    };
  }

  dormant(record) {
    return { ...record, paneId: null, dormant: true, status: 'idle', turn: null, pending: null,
      tail: null, dialog: null, note: '已休眠，发送消息会自动恢复', windowIndex: 0, paneIndex: 0 };
  }

  convert(raw) {
    let key = this.rawKeys.get(raw.key);
    if (!key) {
      key = LOGICAL.test(raw.logicalId || '') ? raw.logicalId : `session:${randomUUID()}`;
      // A duplicated tmux option must never alias two different live panes.
      if ([...this.rawKeys.values()].includes(key) && !this.sessions.get(key)?.dormant) key = `session:${randomUUID()}`;
      this.rawKeys.set(raw.key, key);
    }
    const s = this.sessions.get(key) || { lastUseAt: this.now() };
    const changed = s.status !== raw.status || s.lastText !== raw.lastText || s.lastPrompt !== raw.lastPrompt;
    Object.assign(s, raw, { key, paneId: raw.key, dormant: false });
    if (changed) s.lastUseAt = this.now();
    this.sessions.set(key, s);
    return s;
  }

  setLaunchPolicy(session, { agent, yolo }) {
    this.policies.set(session.key, yolo ? this.cfg.agents[agent]?.flags || '' : '');
  }

  async replaceSession({ name, cwd, command, agent }) {
    const existing = this.list().filter((s) => s.tmuxSession === name);
    if (existing.length !== 1) throw new Error('同名会话包含多个窗格，不能自动替换。');
    const s = existing[0];
    return this.exclusive(s.key, async () => {
      await this.liveRegistry.poll();
      const raw = this.liveRegistry.sessions.get(s.paneId);
      if (raw) this.convert(raw);
      if (!s.dormant && (!['idle', 'shell'].includes(s.status) || s.turn || s.pending || s.note ||
          s.clients || s.hasChildren || s.single === false)) throw new Error('同名会话正在使用或执行任务，不能自动替换。');
      const prior = this.records.get(s.key);
      this.replacing.add(s.key);
      try {
        if (!s.dormant) await this.rawTmux.killSession(name);
        await this.liveRegistry.poll();
        this.records.delete(s.key);
        this.policies.delete(s.key);
        this.restoring.delete(s.key);
        this.starting.set(s.key, agent);
        Object.assign(s, { paneId: null, dormant: true, kind: agent, cwd, lastText: '', lastPrompt: '',
          transcript: null, conversationId: null, turn: null, pending: null, note: '', status: 'idle', lastUseAt: this.now() });
        this.save(true);
        await this.rawTmux.newSession({ name, cwd, command, logicalId: s.key });
        await this.liveRegistry.poll();
        for (const live of this.liveRegistry.list()) this.convert(live);
        if (!s.paneId) throw new Error('替换后的会话未出现在 tmux 中。');
        this.emit('replaced', s);
        this.emit('changed');
        return s;
      } catch (err) {
        this.starting.delete(s.key);
        if (prior) this.records.set(s.key, prior);
        this.save(true);
        throw err;
      } finally {
        this.replacing.delete(s.key);
      }
    });
  }

  save(flush = false) {
    const data = Object.fromEntries(this.records);
    const starting = Object.fromEntries(this.starting);
    const signature = JSON.stringify({ data, starting });
    if (signature !== this.saved) {
      this.store.set('managedSessions', data);
      this.store.set('startingSessions', starting);
      this.saved = signature;
    }
    if (flush) this.store.flush();
  }

  async checkpoint(s) {
    if (this.restoring.has(s.key)) return;
    const id = conversationId(s);
    if (!id || !s.single || !this.rawTmux.SESSION_NAME_RE?.test(s.tmuxSession) || !this.cfg.agents[s.kind]?.resume?.includes('{id}')) return;
    // Persist the identity in tmux too, so a hub restart does not change card targets.
    if (s.logicalId !== s.key) {
      await this.rawTmux.setSessionIdentity(s.paneId, s.key);
      s.logicalId = s.key;
    }
    const prior = this.records.get(s.key);
    const record = {};
    for (const field of ['key', 'name', 'tmuxSession', 'kind', 'cwd', 'title', 'lastText', 'lastPrompt', 'transcript', 'statusSince', 'lastUseAt']) record[field] = s[field];
    Object.assign(record, { conversationId: id, flags: this.policies.get(s.key) ?? prior?.flags ?? '' });
    this.records.set(s.key, record);
  }

  canRetire(s) {
    const minutes = this.cfg.lifecycle.idleMinutes;
    return this.cfg.lifecycle.enabled && Number.isFinite(minutes) && minutes > 0 &&
      !s.dormant && s.single && !s.clients && !s.hasChildren && s.status === 'idle' &&
      !s.pending && !s.turn && !s.note && this.records.has(s.key) &&
      this.now() - Math.max(s.lastUseAt || 0, s.statusSince || 0, s.activityAt || 0, this.localActiveAt || 0) >= minutes * 60000;
  }

  exclusive(key, fn) {
    const previous = this.operations.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.operations.set(key, next);
    return next.finally(() => { if (this.operations.get(key) === next) this.operations.delete(key); });
  }

  async pollOnce() {
    await this.liveRegistry.poll();
    this.localActiveAt = this.liveRegistry.localActiveAt;
    for (const raw of this.liveRegistry.list()) {
      const s = this.convert(raw);
      try { await this.checkpoint(s); }
      catch (err) { log('warn', 'lifecycle.checkpoint', { session: s.name, message: err.message }); }
    }
    this.save();
    for (const s of this.list()) {
      if (!this.canRetire(s) || this.operations.has(s.key)) continue;
      await this.exclusive(s.key, async () => {
        // Re-probe immediately before killing; a locally submitted task may have started.
        await this.liveRegistry.poll();
        const raw = this.liveRegistry.sessions.get(s.paneId);
        if (!raw) return;
        this.convert(raw);
        if (!this.canRetire(s) || conversationId(s) !== this.records.get(s.key)?.conversationId) return;
        await this.checkpoint(s);
        this.save(true);
        await this.rawTmux.killSession(s.tmuxSession);
        Object.assign(s, this.dormant(this.records.get(s.key)));
        log('info', 'lifecycle.retired', { session: s.name });
      });
    }
    const signature = this.list().map((s) => [s.key, s.name, s.status, s.dormant, s.note, s.lastText].join('\u0001')).join('\u0002');
    if (signature !== this.signature) { this.signature = signature; this.emit('changed'); }
  }

  async activate(key) {
    return this.exclusive(key, async () => {
      let s = this.sessions.get(key);
      if (!s) throw new Error('会话已删除。');
      s.lastUseAt = this.now();
      if (s.dormant || this.restoring.has(key)) s = await this.restore(s);
      await this.checkpoint(s);
      this.save(true);
      return s;
    });
  }

  async use(key, fn, { allowBlocked = false } = {}) {
    return this.exclusive(key, async () => {
      let s = this.sessions.get(key);
      if (!s) throw new Error('会话已删除，消息没有发出。');
      s.lastUseAt = this.now();
      if (s.dormant || (this.restoring.has(key) && !(allowBlocked && s.logicalId === key))) s = await this.restore(s);
      if (this.starting.has(key) && !allowBlocked) {
        const deadline = this.now() + this.cfg.lifecycle.restoreTimeoutMs;
        do {
          await this.liveRegistry.poll();
          const raw = this.liveRegistry.sessions.get(s.paneId);
          if (raw) this.convert(raw);
          if (s.kind === this.starting.get(key) && ['idle', 'blocked', 'shell'].includes(s.status) && !s.pending) break;
          await this.wait(250);
        } while (this.now() < deadline);
        if (s.kind !== this.starting.get(key) || !['idle', 'blocked', 'shell'].includes(s.status) || s.pending) throw new Error('新会话尚未就绪，消息没有发出。');
        this.starting.delete(key);
      }
      // Startup can reveal a permission dialog; never type the user's message into it.
      if (!allowBlocked && s.status === 'blocked') throw new Error('会话正在等待确认，消息没有发出。请先处理终端中的提示。');
      await fn(s);
      s.lastUseAt = this.now();
      await this.checkpoint(s).catch((err) => log('warn', 'lifecycle.checkpoint', { message: err.message }));
      this.save(true);
    });
  }

  async restore(s) {
    const record = this.records.get(s.key);
    if (!record || !UUID.test(record.conversationId)) throw new Error('没有可验证的历史对话，消息没有发出。');
    if (!fs.existsSync(record.cwd)) throw new Error(`目录不存在：${record.cwd}；消息没有发出。`);
    const template = this.cfg.agents[record.kind]?.resume;
    if (!template) throw new Error(`${record.kind} 没有配置恢复命令；消息没有发出。`);
    const command = template.replace('{id}', quoteArg(record.conversationId))
      .replace('{flags}', record.flags || '').replace('{name}', record.tmuxSession);
    if (s.dormant) {
      const panes = await this.rawTmux.listPanes();
      if (panes.some((p) => p.sessionName === record.tmuxSession)) throw new Error('同名终端已存在；为避免发送到错误会话，消息没有发出。');
      this.restoring.add(s.key);
      record.restoring = true;
      this.save(true);
      await this.rawTmux.newSession({ name: record.tmuxSession, cwd: record.cwd, command, logicalId: s.key });
    }
    const deadline = this.now() + this.cfg.lifecycle.restoreTimeoutMs;
    do {
      await this.liveRegistry.poll();
      for (const raw of this.liveRegistry.list()) this.convert(raw);
      s = this.sessions.get(record.key);
      if (s && !s.dormant && s.kind === record.kind && conversationId(s) === record.conversationId &&
          (s.status === 'idle' || s.status === 'blocked') && !s.pending) {
        s.lastUseAt = this.now();
        this.restoring.delete(s.key);
        delete record.restoring;
        this.save(true);
        log('info', 'lifecycle.restored', { session: s.name });
        return s;
      }
      await this.wait(250);
    } while (this.now() < deadline);
    throw new Error('恢复尚未就绪，消息没有发出。请查看终端后重试。');
  }
}
