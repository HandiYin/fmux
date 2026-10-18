import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Tail, adapters, cwdNeedle, lastExchange, lastTurns, piSessionDir } from '../src/transcript.mjs';
import { expandHome, quoteArg, shortPath } from '../src/util.mjs';

const claudeLines = [
  { type: 'user', message: { role: 'user', content: '跑一下测试' } },
  { type: 'user', isMeta: true, message: { role: 'user', content: 'injected notice' } },
  { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
  { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '...' }], stop_reason: 'tool_use' } },
  { type: 'assistant', message: { content: [{ type: 'text', text: '先看一下目录。' }], stop_reason: 'tool_use' } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }] } },
  { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent chatter' }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/home/u/proj/src/main.py' } }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: '测试都过了。' }], stop_reason: 'end_turn' } },
  { type: 'system', subtype: 'turn_duration', durationMs: 4200 },
];

test('claude adapter', () => {
  const events = claudeLines.flatMap((l) => adapters.claude(l));
  assert.deepEqual(events, [
    { type: 'user', text: '跑一下测试' },
    { type: 'text', text: '先看一下目录。' },
    { type: 'tool', name: 'Bash', summary: 'Run the tests' },
    { type: 'tool', name: 'Read', summary: 'main.py' },
    { type: 'text', text: '测试都过了。' },
    { type: 'turn_end', durationMs: 4200 },
  ]);
});

test('codex adapter', () => {
  const events = [
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '我先看仓库。' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["bash","-lc","git status"]}' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '完成。' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', duration_ms: 84486 } },
  ].flatMap((l) => adapters.codex(l));
  assert.deepEqual(events, [
    { type: 'text', text: '我先看仓库。' },
    { type: 'tool', name: 'shell', summary: 'bash -lc git status' },
    { type: 'tool', name: 'apply_patch', summary: '*** Begin Patch' },
    { type: 'text', text: '完成。' },
    { type: 'turn_end', durationMs: 84486 },
  ]);
});

test('pi adapter', () => {
  const events = [
    { type: 'session', cwd: '/home/u' },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'message', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'ls' } }] } },
    { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'a b' }] } },
    { type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'two files' }] } },
  ].flatMap((l) => adapters.pi(l));
  assert.deepEqual(events, [
    { type: 'user', text: 'hi' },
    { type: 'tool', name: 'bash', summary: 'ls' },
    { type: 'text', text: 'two files' },
    { type: 'turn_end' },
  ]);
});

test('Codex paginated history reads real user prompts once and ignores injected context', () => {
  const events = [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>context</environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '怎么样了' }] } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '怎么样了' }] } } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '正在运行。' }] } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', text: '正在运行。' } } },
  ].flatMap(adapters.codex);
  assert.deepEqual(events, [{ type: 'user', text: '怎么样了' }, { type: 'text', text: '正在运行。' }]);
});

test('Tail returns only complete new lines, and lastExchange reads the end', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fmux-test-')), 't.jsonl');
  const line = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(file, line(claudeLines[0]) + line(claudeLines[4]));
  const tail = new Tail(file, adapters.claude);
  assert.deepEqual(tail.read(), []);

  const next = line(claudeLines[9]);
  fs.appendFileSync(file, next.slice(0, 20));
  assert.deepEqual(tail.read(), []);
  fs.appendFileSync(file, next.slice(20) + line(claudeLines[10]));
  assert.deepEqual(tail.read(), [{ type: 'text', text: '测试都过了。' }, { type: 'turn_end', durationMs: 4200 }]);
  assert.deepEqual(tail.read(), []);

  assert.deepEqual(lastExchange(file, adapters.claude), { prompt: '跑一下测试', text: '测试都过了。' });
  assert.equal(new Tail(file, adapters.claude, { fromStart: true }).read().length, 4);

  fs.writeFileSync(file, line(claudeLines[4]));
  assert.deepEqual(tail.read(), [{ type: 'text', text: '先看一下目录。' }]);
});

test('lastTurns splits a transcript at the prompts and knows which turn is finished', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fmux-test-')), 't.jsonl');
  const user = (t) => ({ type: 'user', message: { role: 'user', content: t } });
  const say = (t) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
  const end = { type: 'system', subtype: 'turn_duration', durationMs: 1 };
  const lines = [user('first'), say('thinking aloud'), say('answer one'), end, user('second'), say('answer two'), end, user('third'), say('working on it')];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.deepEqual(lastTurns(file, adapters.claude), [
    { prompt: 'first', texts: ['thinking aloud', 'answer one'], done: true },
    { prompt: 'second', texts: ['answer two'], done: true },
    { prompt: 'third', texts: ['working on it'], done: false },
  ]);
  assert.deepEqual(lastTurns('/no/such/file', adapters.claude), []);
});

test('a pasted block in a Claude prompt: the prompt is what was typed around it', () => {
  const user = (content) => adapters.claude({ type: 'user', message: { role: 'user', content } });
  assert.deepEqual(user('照着改 <pasted_content id="1">\nA\nB\n</pasted_content id="1">'), [{ type: 'user', text: '照着改' }]);
  assert.deepEqual(user('\n\n<pasted_content id="2">\nonly pasted\nlines\n</pasted_content id="2">\n'), [{ type: 'user', text: 'only pasted\nlines' }]);
  assert.deepEqual(user('<local-command-stdout>x</local-command-stdout>'), []);
});

test('a working directory is matched in a Codex rollout the way JSON writes it', () => {
  assert.equal(cwdNeedle('/home/u/proj', 'linux'), '"cwd":"/home/u/proj"');
  const line = JSON.stringify({ type: 'session_meta', payload: { cwd: 'C:\\Users\\Me\\proj' } });
  assert.ok(line.toLowerCase().includes(cwdNeedle('c:\\users\\me\\proj', 'win32')), 'Windows paths differ in case');
});

test('the pi session directory follows the rule pi uses, for both kinds of path', () => {
  assert.equal(piSessionDir('/home/u/proj'), '--home-u-proj--');
  assert.equal(piSessionDir('C:\\Users\\u\\proj'), '--C--Users-u-proj--');
});

test('home paths and quoting work with both kinds of separator', () => {
  assert.equal(expandHome('~/a'), path.join(os.homedir(), 'a'));
  assert.equal(expandHome('~\\a'), path.join(os.homedir(), 'a'));
  assert.equal(shortPath('C:\\Users\\me\\proj', 'C:\\Users\\me'), '~\\proj');
  assert.equal(shortPath('/home/me/proj', '/home/me'), '~/proj');
  assert.equal(quoteArg("it's", 'linux'), `'it'\\''s'`);
  assert.equal(quoteArg("it's", 'win32'), "'it''s'", 'PowerShell doubles the quote');
});
