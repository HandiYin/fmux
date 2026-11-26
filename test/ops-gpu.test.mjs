import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { GpuRegistry, parseNvidiaApps, parseNvidiaGpus } from '../src/gpu.mjs';
import { cronMatches, OpsEngine } from '../src/ops.mjs';
import { classify } from '../src/procs/common.mjs';
import { startWebServer } from '../src/web.mjs';
import { harness, session } from './helpers.mjs';

test('dsh process classification and default full-permission (yolo) agent templates', () => {
  assert.equal(classify('dsh-tui', 'dsh-tui'), 'dsh');
  assert.equal(classify('dsh-tui', '/home/ubuntu/.local/bin/dsh-tui --resume abc'), 'dsh');
  assert.equal(classify('node', 'node /opt/node_modules/@deepseek-ai/dsh/cli.js'), 'dsh');
  assert.equal(classify('dst', 'dst'), 'dsh');

  const cfg = loadConfig(path.join(os.tmpdir(), `nonexistent-${Date.now()}.json`));
  assert.equal(cfg.agents.claude.flags, '--dangerously-skip-permissions');
  assert.equal(cfg.agents.codex.flags, '--yolo');
  assert.equal(cfg.agents.agy.flags, '--dangerously-skip-permissions');
  assert.equal(cfg.agents.dsh.command, 'dsh-tui');
});

test('cronMatches evaluates standard 5-field expressions accurately', () => {
  const d = new Date(2026, 10, 26, 14, 30); // Thu (4) Nov 26, 14:30
  assert.equal(cronMatches('*/15 * * * *', d), true);
  assert.equal(cronMatches('30 14 * * 4', d), true);
  assert.equal(cronMatches('0 9-17 * * 1-5', d), false);
  assert.equal(cronMatches('30 9-17 * * 1-5', d), true);
  assert.equal(cronMatches('invalid', d), false);
});

test('OpsEngine runs Heartbeat tasks and Long-Horizon Goal supervision with persistence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmux-ops-'));
  const worker = session({ key: '%1', name: 'trainer', kind: 'agy', status: 'working', lastText: 'epoch 4 loss 0.12' });
  const supervisor = session({ key: '%2', name: 'lead_sup', kind: 'dsh', status: 'idle' });
  const h = harness({ sessions: [worker, supervisor] });
  h.cfg.agents.dsh = { flags: '', command: 'dsh-tui', continue: 'dsh-tui -c', resume: 'dsh-tui --resume {id}', promptFlag: '--' };
  const ops = new OpsEngine({ router: h.router, stateDir: dir, tickMs: 60000 });

  // Heartbeat targeting an existing session delivers prompt into tmux.
  const hb = ops.addHeartbeat({
    name: 'Disk check',
    scheduleKind: 'interval',
    everyMinutes: 15,
    targetMode: 'session',
    targetRef: 'trainer',
    prompt: '检查磁盘剩余空间',
  });
  const res1 = await ops.runHeartbeat(hb.id, { manual: true });
  assert.equal(res1.ok, true);
  assert.equal(res1.session, 'trainer');
  assert.match(h.tmux.sent.at(-1)[1], /\[HEARTBEAT:Disk check\]/);

  // Heartbeat in spawn mode creates a new yolo tmux session.
  const hb2 = ops.addHeartbeat({
    name: 'Nightly eval',
    scheduleKind: 'cron',
    cron: '0 2 * * *',
    targetMode: 'spawn',
    agent: 'dsh',
    cwd: '/tmp',
    prompt: '跑一轮评测',
  });
  const res2 = await ops.runHeartbeat(hb2.id, { manual: true });
  assert.equal(res2.ok, true);
  assert.ok(h.tmux.created.length >= 1);
  assert.match(h.tmux.created.at(-1).command, /dsh-tui/);

  // Long-Horizon Goal dispatches structured supervision directive into supervisor conversation.
  const goal = ops.addGoal({
    title: '完成手部模型 SFT',
    objective: '将测试集 MPJPE 降到 8mm 以下',
    criteria: '验证集 MPJPE < 8mm 且导出 ONNX',
    workerRef: 'trainer',
    supervisorRef: 'lead_sup',
    checkEveryMinutes: 20,
    progress: 45,
  });
  const supRes = await ops.superviseGoal(goal.id, { manual: true });
  assert.equal(supRes.ok, true);
  assert.equal(supRes.supervisor, 'lead_sup');
  const [supKey, supMsg] = h.tmux.sent.at(-1);
  assert.equal(supKey, '%2');
  assert.match(supMsg, /长期目标监督检查 · 完成手部模型 SFT/);
  assert.match(supMsg, /epoch 4 loss 0\.12/);

  // Reloading from stateDir restores persisted heartbeats and goals.
  const opsReloaded = new OpsEngine({ router: h.router, stateDir: dir, tickMs: 60000 });
  assert.equal(opsReloaded.data.heartbeats.length, 2);
  assert.equal(opsReloaded.data.goals.length, 1);
  assert.equal(opsReloaded.data.goals[0].progress, 45);
});

test('GpuRegistry parses nvidia-smi telemetry and manages unified GPU leases over HTTP', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmux-gpu-'));
  const gpus = parseNvidiaGpus('0, GPU-abc, NVIDIA GeForce RTX 4090, 62, 18400, 49140, 67, 290.5, 450.0\n');
  assert.equal(gpus.length, 1);
  assert.equal(gpus[0].name, 'NVIDIA GeForce RTX 4090');
  assert.equal(gpus[0].memoryTotalMb, 49140);

  const apps = parseNvidiaApps('GPU-abc, 4242, /usr/bin/python3, 18200\n');
  assert.equal(apps.length, 1);
  assert.equal(apps[0].processName, 'python3');

  const h = harness({ sessions: [session({ key: '%1', name: 'train_hand', kind: 'agy' })] });
  const mockExec = async (_cmd, args) => {
    if (args[0].includes('query-gpu')) return '0, GPU-abc, NVIDIA GeForce RTX 4090, 62, 18400, 49140, 67, 290.5, 450.0\n';
    return 'GPU-abc, 4242, /usr/bin/python3, 18200\n';
  };
  const gpu = new GpuRegistry({ registry: h.router.registry, stateDir: dir, exec: mockExec });
  await gpu.poll();
  assert.equal(gpu.localGpus.length, 1);
  assert.equal(gpu.localGpus[0].processes.length, 1);

  h.cfg.web = { enabled: true, host: '127.0.0.1', port: 0, token: 'gpu-tok' };
  h.cfg.highlight = { enabled: false };
  const web = await startWebServer({ router: h.router, cfg: h.cfg, gpu });
  const base = `http://127.0.0.1:${web.port}`;
  const headers = { Authorization: 'Bearer gpu-tok', 'Content-Type': 'application/json' };

  try {
    const reg = await (await fetch(`${base}/api/gpu/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ host: 'h100-node-02', gpus: '0,1', session: 'train_hand', task: 'SFT v3', model: 'H100 80GB', memoryGb: 140 }),
    })).json();
    assert.ok(reg.id.startsWith('gpu_'));
    assert.deepEqual(reg.gpus, ['0', '1']);

    const snap = await (await fetch(`${base}/api/gpu`, { headers })).json();
    assert.equal(snap.summary.localCount, 1);
    assert.equal(snap.summary.localBusy, 1);
    assert.equal(snap.summary.activeLeases, 1);
    assert.equal(snap.summary.registeredGpus, 2);

    const rel = await (await fetch(`${base}/api/gpu/release`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: reg.id }),
    })).json();
    assert.equal(rel.released, 1);
    assert.equal(gpu.snapshot().summary.activeLeases, 0);
  } finally {
    await web.close();
  }
});
