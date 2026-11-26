import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startWebServer } from '../src/web.mjs';
import { harness, session } from './helpers.mjs';

test('Web server enforces token auth, serves UI, APIs, agy task logs, and SSE state updates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmux-web-'));
  const transcript = path.join(dir, 'transcript_full.jsonl');
  const taskLog = path.join(dir, 'task-9.log');
  fs.writeFileSync(taskLog, 'epoch 1\nepoch 2 done\n');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>\n检查状态\n</USER_REQUEST>' }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', model: 'gemini-4-neon-high', content: '一切正常。' }),
  ].join('\n') + '\n');

  const tasks = new Map([
    ['conv/task-9', { id: 'conv/task-9', shortId: 'task-9', kind: 'command', description: 'train.py', logFile: taskLog, status: 'running', startedAt: Date.now() - 4000, endedAt: null, summary: '' }],
  ]);
  const s = session({ kind: 'agy', status: 'background', model: 'gemini-4-neon-high', transcript, tasks });
  const h = harness({ sessions: [s] });
  h.tmux.screens.set('%1', 'agy ready\n> ');
  h.cfg.web = { enabled: true, host: '127.0.0.1', port: 0, token: 'secret-token' };
  h.cfg.highlight = { enabled: false };

  const web = await startWebServer({ router: h.router, cfg: h.cfg });
  const base = `http://127.0.0.1:${web.port}`;
  const auth = { Authorization: 'Bearer secret-token' };

  try {
    // Reject unauthenticated requests.
    const unauth = await fetch(`${base}/api/state`);
    assert.equal(unauth.status, 401);

    // Query token redirects and sets HttpOnly cookie.
    const redir = await fetch(`${base}/?token=secret-token`, { redirect: 'manual' });
    assert.equal(redir.status, 302);
    const cookie = redir.headers.get('set-cookie');
    assert.match(cookie, /fmux_token=secret-token/);

    // Cookie accesses HTML UI.
    const ui = await fetch(`${base}/`, { headers: { Cookie: cookie.split(';')[0] } });
    assert.equal(ui.status, 200);
    assert.match(await ui.text(), /fmux/i);

    // State API includes session model, runningTasks count, ops, and gpu snapshots.
    const state = await (await fetch(`${base}/api/state`, { headers: auth })).json();
    assert.equal(state.sessions.length, 1);
    assert.equal(state.sessions[0].runningTasks, 1);
    assert.equal(state.sessions[0].model, 'gemini-4-neon-high');
    assert.ok(Array.isArray(state.ops.heartbeats));
    assert.ok(Array.isArray(state.ops.goals));
    assert.ok(Array.isArray(state.gpu.leases));

    // Turns API returns full untruncated agy turns.
    const turns = await (await fetch(`${base}/api/session/%251/turns`, { headers: auth })).json();
    assert.equal(turns.turns.length, 1);
    assert.equal(turns.turns[0].prompt, '检查状态');
    assert.equal(turns.turns[0].texts[0], '一切正常。');

    // Tasks API returns running background tasks and live log tail.
    const taskRes = await (await fetch(`${base}/api/session/%251/tasks`, { headers: auth })).json();
    assert.equal(taskRes.tasks.length, 1);
    assert.equal(taskRes.selectedTaskId, 'conv/task-9');
    assert.match(taskRes.log, /epoch 2 done/);

    // Send & keys APIs forward to tmux.
    const sendRes = await fetch(`${base}/api/session/%251/send`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '继续执行' }),
    });
    assert.equal(sendRes.status, 200);
    assert.deepEqual(h.tmux.sent.at(-1), ['%1', '继续执行']);

    const keyRes = await fetch(`${base}/api/session/%251/keys`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: ['esc'] }),
    });
    assert.equal(keyRes.status, 200);
    assert.deepEqual(h.tmux.keys.at(-1), ['%1', ['esc']]);

    // Highlight API extracts result/problem/action/fact marks and TL;DR without hashing.
    const hl = await (await fetch(`${base}/api/highlight`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: '全部 119 个测试已通过，没有发现异常。发现一个报错风险：超时未关闭句柄。请确认下一步是否重启服务？' + '补充说明。'.repeat(60),
      }),
    })).json();
    assert.ok(hl.marks.some((m) => m.k === 'result'));
    assert.ok(hl.marks.some((m) => m.k === 'problem'));
    assert.ok(hl.marks.some((m) => m.k === 'action'));
    assert.ok(hl.tldr.length > 0);

    // Wallpaper upload, serve, and reset APIs work cleanly without hashing.
    assert.equal((await fetch(`${base}/api/wallpaper`, { headers: auth })).status, 404);
    const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const up = await (await fetch(`${base}/api/wallpaper`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: png1x1 }),
    })).json();
    assert.equal(up.ok, true);
    assert.ok(up.updatedAt > 0);
    const wpGet = await fetch(`${base}/api/wallpaper`, { headers: auth });
    assert.equal(wpGet.status, 200);
    assert.equal(wpGet.headers.get('content-type'), 'image/png');
    const del = await (await fetch(`${base}/api/wallpaper`, { method: 'DELETE', headers: auth })).json();
    assert.equal(del.ok, true);
    assert.equal((await fetch(`${base}/api/wallpaper`, { headers: auth })).status, 404);

    // SSE pushes initial state immediately.
    const controller = new AbortController();
    const sseRes = await fetch(`${base}/api/events`, { headers: auth, signal: controller.signal });
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body.getReader();
    const firstChunk = new TextDecoder().decode((await reader.read()).value);
    assert.match(firstChunk, /event: state/);
    assert.match(firstChunk, /"runningTasks":1/);
    controller.abort();
  } finally {
    await web.close();
  }
});

test('DeepSeek API highlighter runs asynchronously, filters hallucinations, and caches on disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmux-hl-'));
  const h = harness({ sessions: [session({ kind: 'dsh' })] });
  h.cfg.stateDir = dir;
  h.cfg.web = { enabled: true, host: '127.0.0.1', port: 0, token: 'tok' };
  h.cfg.highlight = { enabled: true, baseUrl: 'https://api.deepseek.test/v1', model: 'deepseek-flash', apiKey: 'test-key' };

  let calls = 0;
  const mockFetch = async (url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    // Simulate deepseek-flash returning 404 once, falling back to deepseek-chat.
    if (body.model === 'deepseek-flash') {
      return new Response(JSON.stringify({ error: 'model not found' }), { status: 404 });
    }
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            tldr: '- 全部 128 个测试已通过\n- 请确认是否重启 fmux 服务',
            marks: [
              { q: '全部 128 个测试已通过', k: 'result' },
              { q: '不存在的幻觉句子', k: 'problem' },
              { q: '请确认是否重启 fmux 服务', k: 'action' },
            ],
          }),
        },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const web = await startWebServer({ router: h.router, cfg: h.cfg, fetchImpl: mockFetch });
  const base = `http://127.0.0.1:${web.port}`;
  const headers = { Authorization: 'Bearer tok', 'Content-Type': 'application/json' };
  const sampleText = '本次改造已完成，全部 128 个测试已通过，没有发现异常。接下来请确认是否重启 fmux 服务以生效？' + '详细背景说明。'.repeat(40);

  try {
    // First call triggers async DeepSeek fetch and returns pending.
    const first = await (await fetch(`${base}/api/highlight`, {
      method: 'POST', headers, body: JSON.stringify({ text: sampleText }),
    })).json();
    assert.equal(first.pending, true);

    // Wait briefly for mock fetch to finish and populate cache.
    let second;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 15));
      second = await (await fetch(`${base}/api/highlight`, {
        method: 'POST', headers, body: JSON.stringify({ text: sampleText }),
      })).json();
      if (!second.pending) break;
    }
    assert.equal(second.pending, undefined);
    assert.equal(second.source, 'deepseek:deepseek-chat');
    assert.equal(second.marks.length, 2); // hallucinated quote stripped by cleanMarks
    assert.ok(second.marks.some((m) => m.q === '全部 128 个测试已通过' && m.k === 'result'));
    assert.ok(second.marks.some((m) => m.q === '请确认是否重启 fmux 服务' && m.k === 'action'));
    assert.match(second.tldr, /128/);
    assert.equal(calls, 2); // 1 fallback 404 + 1 success, then cached
    assert.ok(fs.existsSync(path.join(dir, 'highlights.json')));
  } finally {
    await web.close();
  }
});
