import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.mjs';
import { fakeTmux, pane } from './helpers.mjs';

function setup({ kind = 'claude' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmux-reg-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, '');
  const tmux = fakeTmux([pane()]);
  const meta = { status: 'idle', sessionId: 'x' };
  const registry = new Registry({
    tmux,
    probe: {
      snapshot: () => ({ procs: new Map(), children: new Map() }),
      findAgent: () => (kind === 'shell' ? null : { kind, pid: 200 }),
      readClaudeMeta: () => (kind === 'claude' ? meta : null),
      locateTranscript: () => file,
    },
  });
  const events = [];
  for (const name of ['added', 'removed', 'status', 'blocked', 'turn_end']) registry.on(name, (s, extra) => events.push([name, name === 'turn_end' ? extra : s.status]));
  const append = (...lines) => fs.appendFileSync(file, lines.map((l) => JSON.stringify(l) + '\n').join(''));
  return { tmux, meta, registry, events, file, append };
}

const text = (t) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const tool = (name) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input: {} }] } });

test('a normal turn: working shows at once, the end waits one more poll', async () => {
  const { meta, registry, events, append } = setup();
  await registry.poll();
  assert.deepEqual(events, [['added', 'idle']]);
  const s = registry.resolve('work');
  assert.equal(s.kind, 'claude');

  meta.status = 'busy';
  await registry.poll();
  assert.deepEqual(events.at(-1), ['status', 'working']);

  append(text('looking'), tool('Bash'), tool('Read'));
  await registry.poll();
  assert.equal(s.turn.tools, 2);
  assert.equal(s.lastText, 'looking');

  append(text('done'), { type: 'system', subtype: 'turn_duration', durationMs: 5000 });
  meta.status = 'idle';
  await registry.poll();
  assert.equal(s.status, 'working', 'one idle reading is not yet the end of the turn');
  await registry.poll();
  const [name, turn] = events.at(-1);
  assert.equal(name, 'turn_end');
  assert.deepEqual(turn.texts, ['looking', 'done']);
  assert.equal(turn.tools, 2);
  assert.equal(s.turn, null);
});

test('a gap between two queued prompts is not a finished turn', async () => {
  const { meta, registry, events } = setup();
  await registry.poll();
  meta.status = 'busy';
  await registry.poll();
  meta.status = 'idle';
  await registry.poll();
  meta.status = 'busy';
  await registry.poll();
  await registry.poll();
  assert.equal(events.filter(([n]) => n === 'turn_end').length, 0);
});

test('a reply that came and went between two polls still ends a turn', async () => {
  const { registry, events, append } = setup();
  await registry.poll();
  append(text('quick answer'), { type: 'system', subtype: 'turn_duration', durationMs: 900 });
  await registry.poll();
  const [name, turn] = events.at(-1);
  assert.equal(name, 'turn_end');
  assert.deepEqual(turn.texts, ['quick answer']);
});

test('a dialog on the screen blocks, even when the status file says idle', async () => {
  const { tmux, registry, events } = setup();
  await registry.poll();
  tmux.screens.set('%1', ' ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n');
  await registry.poll();
  await registry.poll();
  assert.deepEqual(events.slice(-2), [['status', 'blocked'], ['blocked', 'blocked']]);
  assert.equal(registry.resolve('work').dialog.options.length, 2);

  tmux.screens.set('%1', '❯ \n');
  await registry.poll();
  await registry.poll();
  assert.equal(events.at(-1)[0], 'turn_end');
});

test('agents without a status file are read from the screen', async () => {
  const { tmux, registry, events } = setup({ kind: 'codex' });
  await registry.poll();
  tmux.screens.set('%1', '• Working (12s • esc to interrupt)\n');
  await registry.poll();
  assert.deepEqual(events.at(-1), ['status', 'working']);
});

test('Codex keeps the last confirmed transcript through an unknown title and forwards the whole turn', async () => {
  const { registry, file, append } = setup({ kind: 'codex' });
  const output = [];
  registry.on('output', (_, events) => output.push(...events));
  await registry.poll();
  const s = registry.resolve('work');
  const say = (text) => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
  append(say('correct reply'));
  await registry.poll();
  assert.equal(s.lastText, 'correct reply');

  // While Codex works it sometimes sets the title to only the spinner and the cwd.
  registry.probe.locateTranscript = () => null;
  registry.tmux.panes[0].title = '⠧ ubuntu';
  append(say('reply during the transient title'));
  await registry.poll();
  assert.equal(s.transcript, file);
  assert.equal(s.lastText, 'reply during the transient title');
  assert.doesNotMatch(s.note, /未定位到回复记录/);

  // When the title comes back to the same conversation, nothing is reset and nothing is skipped.
  registry.probe.locateTranscript = () => file;
  registry.tmux.panes[0].title = '⠧ work | u';
  append(say('reply after the title came back'));
  await registry.poll();
  assert.equal(s.transcript, file);
  assert.deepEqual(output.filter((ev) => ev.type === 'text').map((ev) => ev.text), [
    'correct reply', 'reply during the transient title', 'reply after the title came back',
  ]);
});

test('Codex rebinds when the title resolves another thread, without forwarding the old file', async () => {
  const { registry, tmux, file, append } = setup({ kind: 'codex' });
  const output = [];
  registry.on('output', (_, events) => output.push(...events));
  await registry.poll();
  const s = registry.resolve('work');
  const say = (text) => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
  append(say('old thread'));
  await registry.poll();
  assert.equal(s.lastText, 'old thread');

  const other = path.join(path.dirname(file), 'other.jsonl');
  fs.writeFileSync(other, '');
  registry.probe.locateTranscript = () => other;
  tmux.panes[0].title = 'other conversation';
  append(say('old thread continues'));
  fs.appendFileSync(other, JSON.stringify(say('new thread')) + '\n');
  await registry.poll();
  assert.equal(s.transcript, other);
  assert.equal(s.lastText, 'new thread');
  assert.deepEqual(output.filter((ev) => ev.type === 'text').map((ev) => ev.text), ['old thread', 'new thread']);
});

test('Codex with no known identity from the start stays unbound until it can be resolved', async () => {
  const { registry, tmux, file, append } = setup({ kind: 'codex' });
  registry.probe.locateTranscript = () => null;
  tmux.panes[0].title = '⠧ ubuntu';
  await registry.poll();
  const s = registry.resolve('work');
  assert.equal(s.transcript, null);
  assert.match(s.note, /未定位到回复记录/);

  registry.probe.locateTranscript = () => file;
  tmux.panes[0].title = '⠧ work | u';
  const say = { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'recovered' }] } };
  append(say);
  await registry.poll();
  assert.equal(s.transcript, file);
  assert.equal(s.lastText, 'recovered');
  assert.doesNotMatch(s.note, /未定位到回复记录/);
});

test('a pane that goes away is removed; names follow the pane layout', async () => {
  const { tmux, registry, events } = setup({ kind: 'shell' });
  tmux.panes = [pane(), pane({ paneId: '%2', paneIndex: 1, single: false, sessionName: 'multi' })];
  await registry.poll();
  assert.deepEqual(registry.list().map((s) => s.name), ['multi:0.1', 'work']);
  assert.equal(registry.resolve('1').name, 'multi:0.1');
  assert.equal(registry.resolve('%1').name, 'work');
  assert.equal(registry.resolve('nothing'), null);
  tmux.panes = [pane()];
  await registry.poll();
  assert.equal(events.at(-1)[0], 'removed');
});

test('an agent that exits to the shell in the middle of a turn ends the turn', async () => {
  const { meta, registry, events, append } = setup();
  await registry.poll();
  meta.status = 'busy';
  await registry.poll();
  append(text('halfway'));
  await registry.poll();
  registry.probe.findAgent = () => null;
  await registry.poll();
  await registry.poll();
  const ended = events.filter(([n]) => n === 'turn_end');
  assert.equal(ended.length, 1);
  assert.deepEqual(ended[0][1].texts, ['halfway']);
  assert.equal(registry.resolve('work').kind, 'shell');
});
