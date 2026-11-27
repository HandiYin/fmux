import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { agyAdapter, createAgyLocator } from '../src/agy.mjs';
import { listTasks, readTaskLog, seedTasksFromTranscript } from '../src/agy-tasks.mjs';
import * as cards from '../src/cards.mjs';
import { classify, drivenByScript } from '../src/procs.mjs';
import { Registry } from '../src/registry.mjs';
import { fakeTmux, harness, pane, session } from './helpers.mjs';

const CONV_ID = '46bb36cb-e450-4407-8515-42f82eea482d';
const SUB_ID = '2a0661e5-b362-45d0-8a80-f66ee184ff62';

test('process classification distinguishes interactive agy from script subcommands and print mode', () => {
  assert.equal(classify('agy', 'agy --dangerously-skip-permissions'), 'agy');
  assert.equal(classify('antigravity', '/usr/local/bin/antigravity'), 'agy');
  assert.equal(drivenByScript('agy', 'agy --dangerously-skip-permissions'), false);
  assert.equal(drivenByScript('agy', 'agy -c'), false);
  assert.equal(drivenByScript('agy', 'agy -p "hello"'), true);
  assert.equal(drivenByScript('agy', 'agy --print "hello"'), true);
  assert.equal(drivenByScript('agy', 'agy acp'), true);
});

test('agy locator binds the exact active conversation via presence lock or db fd', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fmux-agy-'));
  const logsDir = path.join(root, 'brain', CONV_ID, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const compact = path.join(logsDir, 'transcript.jsonl');
  const full = path.join(logsDir, 'transcript_full.jsonl');
  fs.writeFileSync(compact, '');

  const locate = createAgyLocator({
    home: root,
    files: async () => [path.join(root, 'presence', `${CONV_ID}.lock`)],
  });
  assert.equal(await locate(100), compact);

  fs.writeFileSync(full, '');
  assert.equal(await locate(100), full, 'prefers transcript_full.jsonl when present');

  const locateViaDb = createAgyLocator({
    home: root,
    files: async () => [path.join(root, 'conversations', `${CONV_ID}.db`)],
  });
  assert.equal(await locateViaDb(100), full);

  // When agy is idle it closes presence/db FDs but keeps log/cli-*.log open.
  const cliLogDir = path.join(root, 'log');
  fs.mkdirSync(cliLogDir, { recursive: true });
  const cliLog = path.join(cliLogDir, 'cli-20261126_201635.log');
  fs.writeFileSync(cliLog, `I1126 20:16:35 common.go:496] Resuming conversation ${CONV_ID}\n`);
  const locateViaLog = createAgyLocator({
    home: root,
    files: async () => [cliLog],
    argsOf: async () => 'agy --dangerously-skip-permissions',
  });
  assert.equal(await locateViaLog(100), full);

  // Cmdline -r <uuid> fallback when neither lock nor log has flushed yet.
  const locateViaArgs = createAgyLocator({
    home: root,
    files: async () => [],
    argsOf: async () => `agy --dangerously-skip-permissions -r ${CONV_ID}`,
  });
  assert.equal(await locateViaArgs(100), full);
});

test('agy adapter parses user prompts, planner tool calls, background commands, timers, subagents, and wakeups', () => {
  const logFile = `/tmp/task-110.log`;
  const lines = [
    {
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\n跑全量测试\n</USER_REQUEST>\n<ADDITIONAL_METADATA>ts</ADDITIONAL_METADATA>',
    },
    {
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      model: 'gemini-4-neon-high',
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"npm test"', toolSummary: '"Run test suite"' } }],
    },
    {
      type: 'GENERIC',
      status: 'RUNNING',
      created_at: '2026-11-26T10:38:44Z',
      content: `Created At: 2026-11-26T19:38:44+09:00\nTool is running as a background task with task id: ${CONV_ID}/task-110\nTask Description: npm test\nTask logs are available at: file://${logFile}`,
    },
    {
      type: 'GENERIC',
      status: 'RUNNING',
      created_at: '2026-11-26T10:38:45Z',
      content: `Tool is running as a background task with task id: ${CONV_ID}/task-111\nTask Description: Timer: 1m 30s, Prompt: Check job status`,
    },
    {
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-26T10:38:46Z',
      content: `Created the following subagent:\n{\n  "conversationId": "${SUB_ID}",\n  "logAbsoluteUri": "file:///tmp/sub.log"\n}`,
    },
    {
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      model: 'gemini-4-neon-high',
      content: '测试已在后台运行。',
    },
    {
      type: 'SYSTEM_MESSAGE',
      created_at: '2026-11-26T10:39:38Z',
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T10:39:38Z sender=${CONV_ID}/task-110 priority=HIGH content=Task id "${CONV_ID}/task-110" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>`,
    },
    {
      type: 'SYSTEM_MESSAGE',
      created_at: '2026-11-26T10:39:40Z',
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T10:39:40Z sender=${SUB_ID} priority=HIGH content=Subagent finished\n</SYSTEM_MESSAGE>`,
    },
  ];
  const events = lines.flatMap(agyAdapter);
  assert.equal(events[0].type, 'user');
  assert.equal(events[0].text, '跑全量测试');
  assert.ok(events.some((e) => e.type === 'tool' && e.name === 'run_command' && e.summary === 'Run test suite'));
  const bgCmd = events.find((e) => e.type === 'task_start' && e.shortId === 'task-110');
  assert.equal(bgCmd.kind, 'command');
  assert.equal(bgCmd.logFile, logFile);
  const bgTimer = events.find((e) => e.type === 'task_start' && e.shortId === 'task-111');
  assert.equal(bgTimer.kind, 'schedule');
  const bgSub = events.find((e) => e.type === 'task_start' && e.taskId === SUB_ID);
  assert.equal(bgSub.kind, 'subagent');
  assert.ok(events.some((e) => e.type === 'turn_end'));
  const cmdDone = events.find((e) => e.type === 'task_end' && e.taskId === `${CONV_ID}/task-110`);
  assert.equal(cmdDone.status, 'done');
  assert.equal(cmdDone.summary, 'exit 0');
  const subDone = events.find((e) => e.type === 'task_end' && e.taskId === SUB_ID);
  assert.equal(subDone.status, 'done');

  // Ordinary DONE tool output that happens to quote background-task strings must NOT spawn fake tasks.
  assert.deepEqual(agyAdapter({
    type: 'GENERIC',
    status: 'DONE',
    content: `stdout: {"content":"Tool is running as a background task with task id: ${CONV_ID}/task-999\\nTask Description: fake"}`,
  }), []);

  // NotificationTimeoutSeconds ("still running after 900s") and manage_task RUNNING checks MUST keep tasks running!
  const stillRunning = agyAdapter({
    type: 'SYSTEM_MESSAGE',
    created_at: '2026-11-26T12:30:32Z',
    content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T12:30:32Z sender=${CONV_ID}/task-110 priority=HIGH content=Background command is still running after 900s: npm test\n</SYSTEM_MESSAGE>`,
  });
  assert.equal(stillRunning[0].type, 'task_tick');
  assert.equal(stillRunning[0].status, 'running');

  const statusRunning = agyAdapter({
    type: 'GENERIC',
    status: 'DONE',
    created_at: '2026-11-26T12:38:37Z',
    content: `Task: ${CONV_ID}/task-110\nStatus: RUNNING\nLog: file://${logFile}\nLog output:\nstep 1000`,
  });
  assert.equal(statusRunning[0].type, 'task_tick');
  assert.equal(statusRunning[0].status, 'running');
  assert.equal(statusRunning[0].logFile, logFile);
});

test('Registry tracks agy background tasks across turn sleep and reactive wakeup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmux-agy-reg-'));
  const transcript = path.join(dir, 'transcript_full.jsonl');
  const taskLog = path.join(dir, 'task-110.log');
  fs.writeFileSync(transcript, '');
  fs.writeFileSync(taskLog, 'step 1 ok\nstep 2 running...\n');

  const tmux = fakeTmux([pane({ command: 'agy', title: 'agy' })]);
  const registry = new Registry({
    tmux,
    probe: {
      snapshot: () => ({ procs: new Map(), children: new Map() }),
      findAgent: () => ({ kind: 'agy', pid: 300 }),
      readClaudeMeta: () => null,
      locateTranscript: () => transcript,
    },
  });
  const events = [];
  for (const name of ['status', 'turn_end', 'task_update']) {
    registry.on(name, (s, extra) => events.push([name, name === 'status' ? s.status : extra]));
  }
  const append = (...rows) => fs.appendFileSync(transcript, rows.map((r) => JSON.stringify(r) + '\n').join(''));

  await registry.poll();
  const s = registry.resolve('work');
  assert.equal(s.kind, 'agy');
  assert.equal(s.status, 'idle');

  // Agent starts working and backgrounds a command, then sleeps waiting for wakeup.
  tmux.screens.set('%1', 'Running (esc to cancel)');
  append(
    { type: 'PLANNER_RESPONSE', status: 'DONE', model: 'gemini-4-neon-high', tool_calls: [{ name: 'run_command', args: { CommandLine: '"npm test"' } }] },
    { type: 'GENERIC', status: 'RUNNING', created_at: new Date().toISOString(), content: `Tool is running as a background task with task id: ${CONV_ID}/task-110\nTask Description: npm test\nTask logs are available at: file://${taskLog}` },
    { type: 'PLANNER_RESPONSE', status: 'DONE', model: 'gemini-4-neon-high', content: '后台测试已启动。' },
  );
  await registry.poll();
  assert.equal(s.status, 'working');
  assert.equal(s.model, 'gemini-4-neon-high');
  assert.equal(listTasks(s).length, 1);
  assert.equal(listTasks(s)[0].status, 'running');
  assert.match(readTaskLog(listTasks(s)[0]), /step 2 running/);

  // Screen becomes idle, but background task is still running -> status becomes `background`!
  tmux.screens.set('%1', '> ');
  await registry.poll();
  await registry.poll();
  assert.equal(s.status, 'background');
  assert.match(s.note, /后台任务：npm test/);
  assert.equal(events.filter(([n]) => n === 'turn_end').length, 1);

  // Background task finishes and wakes agy up -> agy responds -> returns to idle.
  append(
    { type: 'SYSTEM_MESSAGE', created_at: new Date().toISOString(), content: `[Message] sender=${CONV_ID}/task-110 content=Task id "${CONV_ID}/task-110" finished with result:\nCommand exited with code 0.` },
    { type: 'PLANNER_RESPONSE', status: 'DONE', model: 'gemini-4-neon-high', content: '后台测试全部通过！' },
  );
  await registry.poll();
  await registry.poll();
  assert.equal(s.status, 'idle');
  assert.equal(listTasks(s)[0].status, 'done');
  assert.equal(s.lastText, '后台测试全部通过！');

  // Seeding from existing transcript hydrates task history on restart.
  const seeded = seedTasksFromTranscript(transcript, agyAdapter);
  assert.equal(seeded.tasks.get(`${CONV_ID}/task-110`).status, 'done');
  assert.equal(seeded.model, 'gemini-4-neon-high');
});

test('Router keeps attachment during agy background tasks, shows tasks card, and launches agy with -i', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmux-agy-router-'));
  const taskLog = path.join(dir, 'task-110.log');
  fs.writeFileSync(taskLog, 'building...\nall passed\n');
  const tasks = new Map([
    [`${CONV_ID}/task-110`, { id: `${CONV_ID}/task-110`, shortId: 'task-110', kind: 'command', description: 'npm test', logFile: taskLog, status: 'running', startedAt: Date.now() - 5000, endedAt: null, summary: '' }],
  ]);
  const s = session({ kind: 'agy', status: 'background', note: '后台任务：npm test', tasks });
  const h = harness({ sessions: [s] });
  h.cfg.agents.agy = { flags: '--dangerously-skip-permissions', command: 'agy {flags}', continue: 'agy {flags} -c', resume: 'agy {flags} -r {id}', promptFlag: '-i' };

  // Must NOT auto-return to dashboard while a background task is running.
  h.store.set('attached', { key: '%1', name: 'work', lastInputAt: Date.now() - 20 * 60000 });
  await h.router.tick();
  assert.equal(h.store.get('attached').name, 'work');

  // //tasks opens the live tasks card with task log tail.
  await h.say('//tasks');
  const card = h.cardsSent().at(-1).card;
  assert.equal(card.header.template, 'blue');
  assert.match(JSON.stringify(card), /task-110/);
  assert.match(JSON.stringify(card), /all passed/);

  // New agy session with prompt uses `-i`.
  await h.router.api.new({ name: 'neon_job', agent: 'agy', cwd: '/tmp', prompt: 'fix tests', attach: false });
  assert.equal(h.tmux.created.at(-1).command, "agy --dangerously-skip-permissions -i 'fix tests'");

  // Cards light reflects background status in blue.
  assert.equal(cards.light(s).dot, '🔵');
  assert.equal(cards.light(s).color, 'blue');
});
