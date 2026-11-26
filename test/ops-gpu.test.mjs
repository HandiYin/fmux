import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { createDshLocator, dshAdapter } from '../src/dsh.mjs';
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

  // dshAdapter parses model, real user messages (ignoring system reminders), assistant replies, tool calls, and turn_end.
  assert.deepEqual(dshAdapter({ type: 'request/context', data: { model: 'deepseek-flash' } }), [{ type: 'model', model: 'deepseek-flash' }]);
  assert.deepEqual(dshAdapter({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '测试' }] } }), [{ type: 'user', text: '测试' }]);
  assert.deepEqual(dshAdapter({ type: 'user/message', data: { source: { kind: 'user-approval' }, content: [{ type: 'text', text: 'approval changed' }] } }), []);
  assert.deepEqual(dshAdapter({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: '收到 ✅' }] } } }), [{ type: 'thinking', text: 'hmm' }, { type: 'text', text: '收到 ✅' }]);
  assert.deepEqual(dshAdapter({ type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}' } }), [{ type: 'tool', name: 'bash', summary: 'ls' }]);
  assert.deepEqual(dshAdapter({ type: 'turn/end', data: {} }), [{ type: 'turn_end' }]);
});

test('createDshLocator resolves session.v4.jsonl.zstd via child host-entry session.lock fd', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmux-dsh-'));
  const sessDir = path.join(dir, '.dsh', 'sessions', '--home-u--', 'abc-123');
  fs.mkdirSync(sessDir, { recursive: true });
  const lockFile = path.join(sessDir, 'session.lock');
  const zstdFile = path.join(sessDir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(lockFile, '');
  fs.writeFileSync(zstdFile, '');
  const locator = createDshLocator({
    home: dir,
    io: {
      snapshot: async () => ({ children: new Map([[100, [101]]]) }),
      openFiles: async (pid) => (pid === 101 ? [lockFile] : []),
      procCwd: async () => '/home/u',
      procStartMs: async () => Date.now(),
    },
  });
  assert.equal(await locator(100, { cwd: '/home/u' }), zstdFile);
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

test('GpuRegistry parses nvidia-smi, polls Gongji live jobs, and classifies local/gongji/volc leases over HTTP', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmux-gpu-'));
  const gjEnv = path.join(dir, 'gongji.env');
  fs.writeFileSync(gjEnv, 'SUANLI_TOKEN=fake_tok\nSUANLI_BASE_URL=https://openapi.suanli.test\n');
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
  const mockFetch = async () => new Response(JSON.stringify({
    code: '0000',
    data: {
      results: [
        { task_id: 3897077, task_name: 'handi-v72-1card-obj-0198', status: 'Pending', job_status: { status: 'Running' }, sub_type: 'Spot', create_time: '2026-11-26 18:52:00', billing_value: 0, forecast_value: 500000 },
        { task_id: 3893246, task_name: 'colleague-job', status: 'Running', job_status: { status: 'Running' }, sub_type: '按需', create_time: '2026-11-26 13:31:00', billing_value: 11750000, forecast_value: 0 },
      ],
    },
  }), { status: 200 });

  const gpu = new GpuRegistry({
    registry: h.router.registry,
    stateDir: dir,
    gongjiHome: dir,
    gongjiEnvFile: gjEnv,
    exec: mockExec,
    fetchImpl: mockFetch,
  });
  await gpu.poll({ forceGongji: true });
  assert.equal(gpu.localGpus.length, 1);
  assert.equal(gpu.localGpus[0].processes.length, 1);
  assert.equal(gpu.gongjiJobs.length, 2);
  assert.equal(gpu.gongjiJobs.filter((j) => j.own).length, 1);

  h.cfg.web = { enabled: true, host: '127.0.0.1', port: 0, token: 'gpu-tok' };
  h.cfg.highlight = { enabled: false };
  const web = await startWebServer({ router: h.router, cfg: h.cfg, gpu });
  const base = `http://127.0.0.1:${web.port}`;
  const headers = { Authorization: 'Bearer gpu-tok', 'Content-Type': 'application/json' };

  try {
    const volcReg = await (await fetch(`${base}/api/gpu/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ cluster: 'volc', host: 'cn-beijing', jobId: 't-20261126-abc', gpus: '8', session: 'train_hand', task: 'SFT v3', model: 'A100-80G', memoryGb: 640 }),
    })).json();
    assert.ok(volcReg.id.startsWith('gpu_'));
    assert.equal(volcReg.cluster, 'volc');

    // Re-registering same (cluster, jobId) upserts idempotently instead of duplicating.
    const volcUpsert = await (await fetch(`${base}/api/gpu/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ cluster: 'volc', host: 'cn-beijing', jobId: 't-20261126-abc', gpus: '8', session: 'train_hand', task: 'SFT v3 updated', model: 'A100-80G' }),
    })).json();
    assert.equal(volcUpsert.id, volcReg.id);
    assert.equal(volcUpsert.task, 'SFT v3 updated');

    const gjReg = await (await fetch(`${base}/api/gpu/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ cluster: 'gongji', host: 'tj1q', jobId: '3897077', gpus: '1', session: 'obj', task: 'handi-v72-1card-obj-0198', model: 'RTX 5090' }),
    })).json();
    assert.equal(gjReg.cluster, 'gongji');

    const snap = await (await fetch(`${base}/api/gpu`, { headers })).json();
    assert.equal(snap.summary.localCount, 1);
    assert.equal(snap.summary.localBusy, 1);
    assert.equal(snap.summary.gongjiOwn, 1);
    assert.equal(snap.summary.gongjiTotal, 2);
    assert.equal(snap.summary.volcLeases, 1);
    assert.equal(snap.summary.volcGpus, 8);
    assert.equal(snap.clusters.gongji.leases.length, 1);
    assert.equal(snap.clusters.volc.leases.length, 1);

    const rel = await (await fetch(`${base}/api/gpu/release`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jobId: 't-20261126-abc', cluster: 'volc' }),
    })).json();
    assert.equal(rel.released, 1);
    assert.equal(gpu.snapshot().summary.volcLeases, 0);
  } finally {
    await web.close();
  }
});
