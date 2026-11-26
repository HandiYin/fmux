import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshot as procSnapshot } from './procs.mjs';
import { log, sh } from './util.mjs';

const uid = () => `gpu_${crypto.randomBytes(4).toString('hex')}`;

export function parseNvidiaGpus(csv) {
  const gpus = [];
  for (const raw of String(csv || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(',').map((c) => c.trim());
    if (cols.length < 7) continue;
    gpus.push({
      index: Number(cols[0]),
      uuid: cols[1],
      name: cols[2],
      utilization: Number(cols[3]) || 0,
      memoryUsedMb: Number(cols[4]) || 0,
      memoryTotalMb: Number(cols[5]) || 0,
      temperatureC: Number(cols[6]) || 0,
      powerW: Number(cols[7]) || 0,
      powerLimitW: Number(cols[8]) || 0,
      processes: [],
    });
  }
  return gpus;
}

export function parseNvidiaApps(csv) {
  const apps = [];
  for (const raw of String(csv || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(',').map((c) => c.trim());
    if (cols.length < 4) continue;
    apps.push({
      gpuUuid: cols[0],
      pid: Number(cols[1]),
      processName: path.basename(cols[2] || ''),
      usedMemoryMb: Number(cols[3]) || 0,
    });
  }
  return apps;
}

// Unified GPU resource registration & live nvidia-smi telemetry hub.
// Any conversation, agent, or script can register local or remote GPU leases via HTTP or `fmuxctl gpu`.
export class GpuRegistry extends EventEmitter {
  constructor({ registry, stateDir = '', pollMs = 5000, exec = sh } = {}) {
    super();
    this.registry = registry;
    this.file = stateDir ? path.join(stateDir, 'gpu-leases.json') : '';
    this.pollMs = pollMs;
    this.exec = exec;
    this.leases = [];
    this.localGpus = [];
    this.lastPolledAt = 0;
    this.hostName = os.hostname();
    this.timer = null;
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(parsed.leases)) this.leases = parsed.leases;
    } catch {
      // start clean
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ leases: this.leases }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  start() {
    if (this.timer) return;
    this.poll().catch(() => {});
    this.timer = setInterval(() => this.poll().catch(() => {}), this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // Map a running GPU compute PID up its parent chain to the owning tmux session, if any.
  findOwningSession(pid, snap) {
    if (!snap || !this.registry) return '';
    const byPid = new Map();
    for (const s of this.registry.sessions.values()) {
      if (s.agentPid) byPid.set(s.agentPid, s.name);
    }
    let cur = pid;
    for (let depth = 0; depth < 12 && cur > 1; depth++) {
      if (byPid.has(cur)) return byPid.get(cur);
      const entry = snap.procs.get(cur);
      if (!entry || entry.ppid === cur) break;
      cur = entry.ppid;
    }
    return '';
  }

  async poll() {
    try {
      const gpuCsv = await this.exec('nvidia-smi', [
        '--query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit',
        '--format=csv,noheader,nounits',
      ], { timeout: 3000 });
      const gpus = parseNvidiaGpus(gpuCsv);
      const appCsv = await this.exec('nvidia-smi', [
        '--query-compute-apps=gpu_uuid,pid,process_name,used_memory',
        '--format=csv,noheader,nounits',
      ], { timeout: 3000 }).catch(() => '');
      const apps = parseNvidiaApps(appCsv);
      const snap = apps.length ? await procSnapshot().catch(() => null) : null;
      const byUuid = new Map(gpus.map((g) => [g.uuid, g]));
      for (const app of apps) {
        const gpu = byUuid.get(app.gpuUuid);
        if (gpu) gpu.processes.push({ ...app, session: this.findOwningSession(app.pid, snap) });
      }
      this.localGpus = gpus;
      this.lastPolledAt = Date.now();
      this.emit('changed');
    } catch {
      // machine has no NVIDIA GPU or nvidia-smi unavailable
      this.localGpus = [];
      this.lastPolledAt = Date.now();
    }
    return this.localGpus;
  }

  register({
    host = 'local',
    gpus = ['0'],
    session = '',
    task = '',
    model = '',
    note = '',
    memoryGb = null,
    utilization = null,
    ttlMinutes = 240,
  } = {}) {
    const gpuList = Array.isArray(gpus)
      ? gpus.map((g) => String(g).trim()).filter(Boolean)
      : String(gpus || '0').split(',').map((g) => g.trim()).filter(Boolean);
    if (!gpuList.length) throw new Error('at least one GPU index/id is required');
    const now = Date.now();
    const ttl = Math.max(0, Number(ttlMinutes) || 0);
    const lease = {
      id: uid(),
      host: String(host || 'local').trim(),
      gpus: gpuList,
      session: String(session || '').trim(),
      task: String(task || '').trim() || 'GPU job',
      model: String(model || '').trim(),
      note: String(note || '').trim(),
      memoryGb: memoryGb !== null && memoryGb !== '' ? Number(memoryGb) : null,
      utilization: utilization !== null && utilization !== '' ? Number(utilization) : null,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      expiresAt: ttl > 0 ? now + ttl * 60000 : null,
    };
    this.leases.unshift(lease);
    this.save();
    this.emit('changed');
    log('info', 'gpu.register', { id: lease.id, host: lease.host, gpus: lease.gpus, session: lease.session });
    return lease;
  }

  heartbeat(id, { status, note, utilization, memoryGb, ttlMinutes } = {}) {
    const lease = this.leases.find((l) => l.id === id);
    if (!lease) throw new Error(`gpu lease not found: ${id}`);
    const now = Date.now();
    if (status) lease.status = String(status);
    if (note !== undefined) lease.note = String(note);
    if (utilization !== undefined && utilization !== null) lease.utilization = Number(utilization);
    if (memoryGb !== undefined && memoryGb !== null) lease.memoryGb = Number(memoryGb);
    if (ttlMinutes !== undefined) lease.expiresAt = Number(ttlMinutes) > 0 ? now + Number(ttlMinutes) * 60000 : null;
    lease.updatedAt = now;
    this.save();
    this.emit('changed');
    return lease;
  }

  release({ id, session } = {}) {
    const before = this.leases.length;
    if (id) this.leases = this.leases.filter((l) => l.id !== id);
    else if (session) this.leases = this.leases.filter((l) => l.session !== session);
    else throw new Error('specify lease id or session');
    const removed = before - this.leases.length;
    if (removed) {
      this.save();
      this.emit('changed');
    }
    return { released: removed };
  }

  snapshot() {
    const now = Date.now();
    const leases = this.leases.map((l) => ({
      ...l,
      expired: Boolean(l.expiresAt && l.expiresAt <= now),
    }));
    const activeLeases = leases.filter((l) => !l.expired && l.status === 'running');
    const totalRegisteredGpus = activeLeases.reduce((sum, l) => sum + l.gpus.length, 0);
    return {
      hostName: this.hostName,
      lastPolledAt: this.lastPolledAt,
      localGpus: this.localGpus,
      leases,
      summary: {
        localCount: this.localGpus.length,
        localBusy: this.localGpus.filter((g) => g.utilization >= 10 || g.processes.length > 0).length,
        activeLeases: activeLeases.length,
        registeredGpus: totalRegisteredGpus,
      },
    };
  }
}
