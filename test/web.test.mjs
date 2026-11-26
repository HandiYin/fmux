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

    h.tmux.keys.length = 0;
    const stopRes = await (await fetch(`${base}/api/session/%251/stop`, { method: 'POST', headers: auth })).json();
    assert.equal(stopRes.ok, true);
    assert.deepEqual(stopRes.keys, ['esc']);
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

test('WebMUX UI supports full GFM Markdown tables, lists, links, and wallpaper crop box', async () => {
  const vm = await import('node:vm');
  const html = fs.readFileSync(path.resolve('src/web/ui.html'), 'utf8');

  // Verify wallpaper cropper & stop button UI controls are present.
  for (const id of ['wpCropPane', 'wpCropFrame', 'wpCropBox', 'wpCropApply', 'wpRatioGroup', 'wpRecropBtn', 'stopBtn']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id} in ui.html`);
  }

  // Extract renderMarkdown and its pure helpers into a sandboxed VM context.
  const escLine = html.match(/const esc = [^\n]+;/)?.[0];
  const mathStart = html.indexOf('// ---- LaTeX Math Rendering');
  const hlStart = html.indexOf('// ---- DeepSeek Async Highlighting');
  assert.ok(escLine && mathStart > 0 && hlStart > mathStart);
  const snippet = `${escLine}\nconst window = {};\n${html.slice(mathStart, hlStart)}\n`;
  const ctx = vm.createContext({});
  vm.runInContext(snippet, ctx);

  const md = [
    '## 评估对比',
    '',
    '| 模型 | PSNR ↑ | 显存 (`A | B`) | 备注 |',
    '| :--- | :---: | ---: | :--- |',
    '| **v3-bf16** | `24.8 dB` | 35.8 GB | 含转义 \\| 管道与 $\\lambda=0.1$ |',
    '| ~~v2-fp16~~ | 23.1 dB | 38.2 GB | [报告](https://example.com/r) & [`ui.html`](https://example.com/ui) |',
    '',
    '> 第一行引用',
    '> 第二行引用含 `snake_case_var` 与 *斜体*',
    '',
    '- [x] 已完成表格渲染',
    '- [ ] 待验证壁纸裁剪',
    '  - 嵌套子项',
    '',
    '1. 步骤一',
    '2. 步骤二 [危险](javascript:alert(1))',
    '',
    '---',
    '```python',
    'print("streaming...")',
  ].join('\n');

  const out = ctx.renderMarkdown(md);
  assert.match(out, /<div class="md-table-wrap"><table class="md-table">/);
  assert.match(out, /<th style="text-align:center">PSNR ↑<\/th>/);
  assert.match(out, /<th style="text-align:right">显存 \(<code class="inline">A \| B<\/code>\)<\/th>/);
  assert.match(out, /<td style="text-align:left">含转义 \| 管道与 <span class="math-inline"/);
  assert.match(out, /<del>v2-fp16<\/del>/);
  assert.match(out, /<a class="md-link" href="https:\/\/example\.com\/ui"[^>]*><code class="inline">ui\.html<\/code><\/a>/);
  assert.match(out, /<blockquote><p>第一行引用<br>第二行引用含 <code class="inline">snake_case_var<\/code> 与 <em>斜体<\/em><\/p><\/blockquote>/);
  assert.match(out, /<li class="md-task"><span class="md-chk done">✓<\/span>已完成表格渲染<\/li>/);
  assert.match(out, /<li class="md-task"><span class="md-chk"><\/span>待验证壁纸裁剪<\/li>/);
  assert.match(out, /<ul><li>嵌套子项<\/li><\/ul>/);
  assert.match(out, /<ol><li>步骤一<\/li><li>步骤二 \[危险\]\(javascript:alert\(1\)\)<\/li><\/ol>/);
    assert.doesNotMatch(out, /href="javascript:/);
    assert.match(out, /<hr class="md-hr" \/>/);
    assert.match(out, /<div class="code-frame">.*print\(&quot;streaming\.\.\.&quot;\)/);
});

test('WebMUX preserves fixed unitIds in creation order and markStopped prevents thinking resurrection', async () => {
  const { Registry } = await import('../src/registry.mjs');
  const panes = [
    { sessionName: 'handibot', windowIndex: 0, windowName: 'bash', paneIndex: 0, paneId: '%0', panePid: 100, command: 'bash', cwd: '/tmp', title: '', tty: '/dev/pts/0', clients: 0, activityAt: 1000, inMode: false, single: true },
    { sessionName: 'work', windowIndex: 0, windowName: 'agy', paneIndex: 0, paneId: '%3', panePid: 101, command: 'agy', cwd: '/tmp', title: '', tty: '/dev/pts/1', clients: 0, activityAt: 2000, inMode: false, single: true },
  ];
  const tmux = {
    listPanes: async () => panes,
    lastClientActivity: async () => 0,
    capture: async () => '> ',
    sendKeys: async () => {},
  };
  const probe = {
    snapshot: async () => ({ procs: new Map(), children: new Map() }),
    findAgent: async (_snap, pid) => (pid === 101 || pid === 102 ? { kind: 'agy', pid } : null),
    readClaudeMeta: () => null,
    locateTranscript: async () => null,
  };
  const memStore = { data: {}, get(k) { return this.data[k]; }, set(k, v) { this.data[k] = v; } };
  const reg = new Registry({ tmux, probe, store: memStore });
  await reg.poll();

  // Initial stable IDs follow tmux pane creation order (%0 -> 1, %3 -> 2).
  assert.deepEqual(reg.listStable().map((s) => [s.name, s.unitId]), [['handibot', 1], ['work', 2]]);

  // Spawn a new session named 'aaa-task' (%5) alphabetically before 'handibot' and mark it working:
  // It MUST stay at the bottom as unitId 3 and NEVER float above handibot/work!
  panes.push({ sessionName: 'aaa-task', windowIndex: 0, windowName: 'agy', paneIndex: 0, paneId: '%5', panePid: 102, command: 'agy', cwd: '/tmp', title: '', tty: '/dev/pts/2', clients: 0, activityAt: 9999, inMode: false, single: true });
  await reg.poll();
  const s3 = reg.sessions.get('%5');
  s3.status = 'working';
  s3.turn = { startedAt: Date.now(), texts: [], tools: 1, thinking: true, lastTool: 'run_command' };
  s3.lastActivityAt = Date.now();
  assert.deepEqual(reg.listStable().map((s) => [s.name, s.unitId]), [['handibot', 1], ['work', 2], ['aaa-task', 3]]);

  // Even if session #2 ('work') closes, 'aaa-task' keeps its fixed unitId 3 (never shifts to 2).
  panes.splice(1, 1);
  await reg.poll();
  assert.deepEqual(reg.listStable().map((s) => [s.name, s.unitId]), [['handibot', 1], ['aaa-task', 3]]);

  // Stopping 'aaa-task' immediately clears working/turn state and subsequent polls stay idle.
  reg.markStopped(s3);
  assert.equal(s3.status, 'idle');
  assert.ok(s3.stoppedAt > 0);
  await reg.poll();
  assert.equal(s3.status, 'idle');
});

test('agy task tracking rejects foreign session task IDs and clears tasks on server restart notice', async () => {
  const { seedTasksFromTranscript, runningTasks } = await import('../src/agy-tasks.mjs');
  const { agyAdapter } = await import('../src/agy.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmux-agy-owner-'));
  const ownId = '46bb36cb-e450-4407-8515-42f82eea482d';
  const otherId = 'eedc81c4-f159-43c2-baac-d737f63db57f';
  const logDir = path.join(dir, 'brain', ownId, '.system_generated', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const trFile = path.join(logDir, 'transcript_full.jsonl');

  fs.writeFileSync(trFile, [
    // Foreign task inspected via grep/cat in a GENERIC output MUST NOT attach to ownId!
    JSON.stringify({ type: 'GENERIC', status: 'DONE', content: `Task: ${otherId}/task-586\nStatus: RUNNING` }),
    // Own task started before restart:
    JSON.stringify({ type: 'GENERIC', status: 'RUNNING', content: `Tool is running as a background task with task id: ${ownId}/task-10\nTask Description: train.py` }),
    // Server restart notice stops prior tasks:
    JSON.stringify({ type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[Message] timestamp=2026-11-26T14:11:36Z sender=system priority=MESSAGE_PRIORITY_LOW content=[Notice] All your subagents and background tasks have been stopped due to server restart.' }),
    // Own fresh task after restart stays running:
    JSON.stringify({ type: 'GENERIC', status: 'RUNNING', content: `Tool is running as a background task with task id: ${ownId}/task-20\nTask Description: eval.py` }),
  ].join('\n') + '\n');

  const seeded = seedTasksFromTranscript(trFile, agyAdapter);
  assert.equal(seeded.tasks.has(`${otherId}/task-586`), false);
  assert.equal(seeded.tasks.get(`${ownId}/task-10`)?.status, 'killed');
  assert.deepEqual(runningTasks(seeded).map((t) => t.id), [`${ownId}/task-20`]);

  // Also verify Enter does NOT submit composer in ui.html (TRANSMIT click required).
  const uiHtml = fs.readFileSync(path.resolve('src/web/ui.html'), 'utf8');
  assert.doesNotMatch(uiHtml, /e\.key === 'Enter' && !e\.shiftKey/);
  assert.match(uiHtml, /id="modelBar"/);
  assert.match(uiHtml, /id="modelDialog"/);
});

test('agy model catalog, live footer parser, and WebMUX /model & /effort switching API work end-to-end', async () => {
  const { parseAgyFooter, parseAgyModelsOutput } = await import('../src/agy.mjs');

  assert.deepEqual(
    parseAgyFooter('>\n────\n? for shortcuts                                                    Gemini 4 Carbon · high'),
    { family: 'Gemini 4 Carbon', effort: 'high', display: 'Gemini 4 Carbon · high' },
  );
  assert.deepEqual(
    parseAgyFooter('esc to cancel                                                      Gemini 4 Neon · xhigh'),
    { family: 'Gemini 4 Neon', effort: 'xhigh', display: 'Gemini 4 Neon · xhigh' },
  );
  assert.deepEqual(
    parseAgyFooter('? for shortcuts                                                    Orchestrator (Neon)'),
    { family: 'Orchestrator (Neon)', effort: '', display: 'Orchestrator (Neon)' },
  );

  const parsed = parseAgyModelsOutput('\x1b[2K⠋ Fetching available models...\rgemini-4-neon-xhigh    Gemini 4 Neon (XHigh)\ngemini-pro-orchestrator   Orchestrator (Carbon)\n');
  assert.deepEqual(parsed, [
    { id: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon (XHigh)', family: 'Gemini 4 Neon', effort: 'xhigh' },
    { id: 'gemini-pro-orchestrator', label: 'Orchestrator (Carbon)', family: 'Orchestrator (Carbon)', effort: '' },
  ]);

  const s = session({ kind: 'agy', status: 'idle', model: 'Gemini 4 Carbon · high' });
  const h = harness({ sessions: [s] });
  h.tmux.screens.set('%1', '>\n────\n? for shortcuts                                                    Gemini 4 Neon · xhigh');
  h.cfg.web = { enabled: true, host: '127.0.0.1', port: 0, token: 'tok' };
  h.cfg.highlight = { enabled: false };

  const web = await startWebServer({ router: h.router, cfg: h.cfg });
  const base = `http://127.0.0.1:${web.port}`;
  const headers = { Authorization: 'Bearer tok', 'Content-Type': 'application/json' };

  try {
    const cat = await (await fetch(`${base}/api/models`, { headers })).json();
    assert.ok(Array.isArray(cat.agy) && cat.agy.length > 5);

    // Switching to an agy variant sends a single `/model <id>` command and refreshes live footer model/effort.
    const sw1 = await (await fetch(`${base}/api/session/%251/model`, {
      method: 'POST', headers, body: JSON.stringify({ model: 'gemini-4-neon-xhigh', effort: 'xhigh' }),
    })).json();
    assert.equal(sw1.ok, true);
    assert.deepEqual(h.tmux.sent.at(-1), ['%1', '/model gemini-4-neon-xhigh']);

    // Switching effort alone sends `/effort <level>`.
    const sw2 = await (await fetch(`${base}/api/session/%251/model`, {
      method: 'POST', headers, body: JSON.stringify({ effort: 'medium' }),
    })).json();
    assert.equal(sw2.ok, true);
    assert.deepEqual(h.tmux.sent.at(-1), ['%1', '/effort medium']);

    // Rejects switching while session is actively working.
    s.status = 'working';
    const busyRes = await fetch(`${base}/api/session/%251/model`, {
      method: 'POST', headers, body: JSON.stringify({ effort: 'low' }),
    });
    assert.equal(busyRes.status, 409);
  } finally {
    await web.close();
  }
});
