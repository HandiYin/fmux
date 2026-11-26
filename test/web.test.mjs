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
    assert.match(await ui.text(), /fmux/);

    // State API includes session model and runningTasks count.
    const state = await (await fetch(`${base}/api/state`, { headers: auth })).json();
    assert.equal(state.sessions.length, 1);
    assert.equal(state.sessions[0].runningTasks, 1);
    assert.equal(state.sessions[0].model, 'gemini-4-neon-high');

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
