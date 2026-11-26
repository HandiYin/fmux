import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshot as procSnapshot } from './procs.mjs';
import { log, sh } from './util.mjs';

const uid = () => `gpu_${crypto.randomBytes(4).toString('hex')}`;

export const CLUSTER_META = {
  local: { id: 'local', label: '本机器', en: 'LOCAL MACHINE' },
  gongji: { id: 'gongji', label: '共绩集群', en: 'GONGJI CLUSTER' },
  volc: { id: 'volc', label: '火山集群', en: 'VOLCANO MLP' },
};

export function normalizeCluster(cluster = '', host = '') {
  const raw = `${cluster || ''} ${host || ''}`.toLowerCase();
  if (/gongji|共绩|suanli|tj1q/.test(raw)) return 'gongji';
  if (/volc|volcano|火山|mlp|vepfs|cn-beijing|cn-shanghai|hpcpni/.test(raw)) return 'volc';
  if (/local|本机|localhost/.test(raw)) return 'local';
  const c = String(cluster || '').trim().toLowerCase();
  if (c === 'gongji' || c === 'volc' || c === 'local') return c;
  return 'local';
}

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

// Read ~/gongji/.env safely without ever logging token values.
function readGongjiEnv(envFile) {
  const out = {
    token: process.env.SUANLI_TOKEN || '',
    baseUrl: process.env.SUANLI_BASE_URL || 'https://openapi.suanli.cn',
    taskPrefix: process.env.GONGJI_TASK_PREFIX || 'handi-',
  };
  try {
    if (!envFile || !fs.existsSync(envFile)) return out;
    for (const raw of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const i = line.indexOf('=');
      const k = line.slice(0, i).trim().replace(/^export\s+/, '');
      const v = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
      if (k === 'SUANLI_TOKEN' && !out.token) out.token = v;
      if (k === 'SUANLI_BASE_URL' && v) out.baseUrl = v;
      if (k === 'GONGJI_TASK_PREFIX' && v) out.taskPrefix = v;
    }
  } catch {
    // ignore missing or unreadable env file
  }
  return out;
}

function readSubmittedGongjiIds(gongjiHome) {
  const ids = new Set();
  try {
    const dir = path.join(gongjiHome, 'jobs', 'submitted');
    if (!fs.existsSync(dir)) return ids;
    for (const name of fs.readdirSync(dir)) {
      if (/^\d+\.json$/.test(name)) ids.add(name.slice(0, -5));
    }
  } catch {
    // ignore
  }
  return ids;
}

function inferGpuSpecFromName(name) {
  const s = String(name || '');
  const countM = s.match(/(\d+)\s*(?:card|gpu|x(?:5090|4090|a100|a800|h100))|(?:5090|4090|a100|a800|h100)x(\d+)/i);
  const count = Number(countM?.[1] || countM?.[2] || 1) || 1;
  const modelM = s.match(/(5090|4090D?|A100|A800|H100|H800|3090)/i);
  return { count, model: modelM ? modelM[1].toUpperCase() : '' };
}

// Unified 3-cluster GPU telemetry & registration hub:
//   1. local  (本机器)  — live nvidia-smi + registered local leases
//   2. gongji (共绩集群) — live suanli.cn Open API jobs (hash-free token auth) + registered leases
//   3. volc   (火山集群) — registered Volcano MLP leases (via fmuxctl gpu / HTTP API)
export class GpuRegistry extends EventEmitter {
  constructor({
    registry,
    stateDir = '',
    pollMs = 5000,
    gongjiPollMs = 30000,
    gongjiEnabled = true,
    gongjiHome = process.env.GONGJI_HOME || path.join(os.homedir(), 'gongji'),
    gongjiEnvFile = process.env.SUANLI_ENV_FILE || '',
    exec = sh,
    fetchImpl = globalThis.fetch,
  } = {}) {
    super();
    this.registry = registry;
    this.file = stateDir ? path.join(stateDir, 'gpu-leases.json') : '';
    this.pollMs = pollMs;
    this.gongjiPollMs = gongjiPollMs;
    this.gongjiEnabled = gongjiEnabled;
    this.gongjiHome = gongjiHome;
    this.gongjiEnvFile = gongjiEnvFile || path.join(gongjiHome, '.env');
    this.exec = exec;
    this.fetchImpl = fetchImpl;
    this.leases = [];
    this.localGpus = [];
    this.gongjiJobs = [];
    this.lastPolledAt = 0;
    this.gongjiPolledAt = 0;
    this.gongjiError = '';
    this.hostName = os.hostname();
    this.timer = null;
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(parsed.leases)) {
        this.leases = parsed.leases.map((l) => ({
          ...l,
          cluster: normalizeCluster(l.cluster, l.host),
          jobId: String(l.jobId || ''),
        }));
      }
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
    this.poll({ forceGongji: true }).catch(() => {});
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

  // Poll active (Pending / Running) jobs from Gongji Open API using token header (no secrets stored).
  async pollGongji({ force = false } = {}) {
    if (!this.gongjiEnabled || !this.fetchImpl) return this.gongjiJobs;
    const now = Date.now();
    if (!force && this.gongjiPolledAt && now - this.gongjiPolledAt < this.gongjiPollMs) {
      return this.gongjiJobs;
    }
    const env = readGongjiEnv(this.gongjiEnvFile);
    if (!env.token) {
      this.gongjiError = '';
      return this.gongjiJobs;
    }
    this.gongjiPolledAt = now;
    try {
      const url = `${env.baseUrl.replace(/\/+$/, '')}/api/task/job/search?page=1&page_size=50&status=Pending,Running`;
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { token: env.token, timestamp: String(now), version: '1.0.0' },
      });
      if (!res.ok) throw new Error(`Gongji HTTP ${res.status}`);
      const payload = await res.json();
      if (payload.code !== '0000') throw new Error(`Gongji code=${payload.code} ${payload.message || ''}`);
      const submittedIds = readSubmittedGongjiIds(this.gongjiHome);
      const items = payload.data?.results || [];
      this.gongjiJobs = items.map((t) => {
        const taskId = String(t.task_id ?? '');
        const name = String(t.task_name || '');
        const own = submittedIds.has(taskId) || name.startsWith(env.taskPrefix);
        const res0 = (t.resources || [])[0] || {};
        const spec = res0.resource || {};
        const inferred = inferGpuSpecFromName(name);
        return {
          taskId,
          name,
          own,
          status: String(t.status || ''),
          jobStatus: String(t.job_status?.status || ''),
          subType: String(t.sub_type || '按需'),
          createTime: String(t.create_time || '').slice(0, 19),
          costYuan: Number((((t.billing_value || 0) + (t.forecast_value || 0)) / 1e6).toFixed(2)),
          gpuCount: Number(spec.gpu_count || t.gpu_count || inferred.count || 1),
          model: String(spec.device_name || t.gpu_name || inferred.model || 'GPU'),
          region: String(res0.region_name || spec.region || ''),
        };
      });
      this.gongjiError = '';
      this.emit('changed');
    } catch (err) {
      this.gongjiError = err.message;
      log('warn', 'gpu.gongji.poll', { message: err.message });
    }
    return this.gongjiJobs;
  }

  async poll({ forceGongji = false } = {}) {
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
      this.localGpus = [];
      this.lastPolledAt = Date.now();
    }
    await this.pollGongji({ force: forceGongji });
    return this.localGpus;
  }

  register({
    cluster = '',
    host = '',
    gpus = ['0'],
    session = '',
    task = '',
    model = '',
    jobId = '',
    note = '',
    memoryGb = null,
    utilization = null,
    status = 'running',
    ttlMinutes = 240,
  } = {}) {
    const normCluster = normalizeCluster(cluster, host);
    const defaultHost = normCluster === 'gongji' ? 'gongji' : normCluster === 'volc' ? 'volc-mlp' : 'local';
    const gpuList = Array.isArray(gpus)
      ? gpus.map((g) => String(g).trim()).filter(Boolean)
      : String(gpus || '0').split(',').map((g) => g.trim()).filter(Boolean);
    if (!gpuList.length) throw new Error('at least one GPU index/id is required');
    const now = Date.now();
    const ttl = Math.max(0, Number(ttlMinutes) || 0);
    const normJobId = String(jobId || '').trim();

    // Idempotent upsert when re-registering the same (cluster, jobId).
    const existing = normJobId
      ? this.leases.find((l) => l.cluster === normCluster && l.jobId === normJobId)
      : null;

    if (existing) {
      existing.host = String(host || existing.host || defaultHost).trim();
      existing.gpus = gpuList;
      if (session) existing.session = String(session).trim();
      if (task) existing.task = String(task).trim();
      if (model) existing.model = String(model).trim();
      if (note) existing.note = String(note).trim();
      if (memoryGb !== null && memoryGb !== '') existing.memoryGb = Number(memoryGb);
      if (utilization !== null && utilization !== '') existing.utilization = Number(utilization);
      existing.status = String(status || 'running');
      existing.updatedAt = now;
      existing.expiresAt = ttl > 0 ? now + ttl * 60000 : null;
      this.save();
      this.emit('changed');
      return existing;
    }

    const lease = {
      id: uid(),
      cluster: normCluster,
      host: String(host || defaultHost).trim(),
      gpus: gpuList,
      jobId: normJobId,
      session: String(session || '').trim(),
      task: String(task || '').trim() || 'GPU job',
      model: String(model || '').trim(),
      note: String(note || '').trim(),
      memoryGb: memoryGb !== null && memoryGb !== '' ? Number(memoryGb) : null,
      utilization: utilization !== null && utilization !== '' ? Number(utilization) : null,
      status: String(status || 'running'),
      startedAt: now,
      updatedAt: now,
      expiresAt: ttl > 0 ? now + ttl * 60000 : null,
    };
    this.leases.unshift(lease);
    this.save();
    this.emit('changed');
    log('info', 'gpu.register', { id: lease.id, cluster: lease.cluster, host: lease.host, gpus: lease.gpus, jobId: lease.jobId, session: lease.session });
    return lease;
  }

  heartbeat(id, { status, note, utilization, memoryGb, ttlMinutes } = {}) {
    const lease = this.leases.find((l) => l.id === id || (l.jobId && l.jobId === id));
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

  release({ id, session, jobId, cluster } = {}) {
    const before = this.leases.length;
    if (id) this.leases = this.leases.filter((l) => l.id !== id);
    else if (jobId) this.leases = this.leases.filter((l) => !(l.jobId === String(jobId) && (!cluster || l.cluster === normalizeCluster(cluster))));
    else if (session) this.leases = this.leases.filter((l) => !(l.session === session && (!cluster || l.cluster === normalizeCluster(cluster))));
    else throw new Error('specify lease id, jobId, or session');
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
      cluster: normalizeCluster(l.cluster, l.host),
      expired: Boolean(l.expiresAt && l.expiresAt <= now),
    }));
    const active = (list) => list.filter((l) => !l.expired && l.status !== 'done' && l.status !== 'stopped');
    const gpuUnits = (l) => {
      if (l.gpus.length === 1 && /^x?\d+$/.test(l.gpus[0]) && l.cluster !== 'local' && Number(l.gpus[0].replace(/^x/, '')) > 0) {
        return Number(l.gpus[0].replace(/^x/, ''));
      }
      return l.gpus.length;
    };

    const localLeases = leases.filter((l) => l.cluster === 'local');
    const gongjiLeases = leases.filter((l) => l.cluster === 'gongji');
    const volcLeases = leases.filter((l) => l.cluster === 'volc');

    const activeLeases = active(leases);
    const localBusy = this.localGpus.filter((g) => g.utilization >= 10 || g.processes.length > 0).length;
    const gongjiOwnJobs = this.gongjiJobs.filter((j) => j.own);
    const gongjiLiveIds = new Set(this.gongjiJobs.map((j) => j.taskId));
    const gongjiExtraLeaseGpus = active(gongjiLeases)
      .filter((l) => !l.jobId || !gongjiLiveIds.has(l.jobId))
      .reduce((sum, l) => sum + gpuUnits(l), 0);
    const gongjiOwnGpus = gongjiOwnJobs.reduce((sum, j) => sum + (j.gpuCount || 1), 0) + gongjiExtraLeaseGpus;
    const volcActiveGpus = active(volcLeases).reduce((sum, l) => sum + gpuUnits(l), 0);

    return {
      hostName: this.hostName,
      lastPolledAt: this.lastPolledAt,
      gongjiPolledAt: this.gongjiPolledAt,
      gongjiError: this.gongjiError,
      localGpus: this.localGpus,
      gongjiJobs: this.gongjiJobs,
      leases,
      clusters: {
        local: { ...CLUSTER_META.local, localGpus: this.localGpus, leases: localLeases, totalGpus: this.localGpus.length, busyGpus: localBusy },
        gongji: { ...CLUSTER_META.gongji, liveJobs: this.gongjiJobs, ownJobs: gongjiOwnJobs.length, leases: gongjiLeases, activeGpus: gongjiOwnGpus },
        volc: { ...CLUSTER_META.volc, leases: volcLeases, activeGpus: volcActiveGpus },
      },
      summary: {
        localCount: this.localGpus.length,
        localBusy,
        gongjiOwn: gongjiOwnJobs.length,
        gongjiTotal: this.gongjiJobs.length,
        gongjiGpus: gongjiOwnGpus,
        volcLeases: active(volcLeases).length,
        volcGpus: volcActiveGpus,
        activeLeases: activeLeases.length,
        registeredGpus: activeLeases.reduce((sum, l) => sum + gpuUnits(l), 0),
      },
    };
  }
}
