import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Tail, adapters, lastExchange } from '../src/transcript.mjs';

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
