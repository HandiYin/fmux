import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCodexLocator } from '../src/codex-transcript.mjs';

const A = '01a13b2b-467b-7281-ad15-e38412ba37b4';
const B = '01a1452e-752b-7a33-b2ad-bcaf44c44de0';
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fmux-codex-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const index = (id, name) => fs.appendFileSync(path.join(home, 'session_index.jsonl'), `${JSON.stringify({ id, thread_name: name })}\n`);
  const rollout = (id, day, cwd = '/home/user') => {
    const dir = path.join(home, 'sessions', ...day.split('-'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-${day}T00-00-00-${id}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id, cwd } })}\n`);
    return file;
  };
  let opened = [];
  const locate = createCodexLocator({ home, hostname: 'host', files: async () => opened, cwdOf: async () => '/home/user' });
  return { home, index, rollout, locate, open: (files) => { opened = files; } };
}

test('shared Codex follows an old named thread, never another recently updated thread in the same cwd', async (t) => {
  const f = fixture(t);
  const old = f.rollout(A, '2020-01-01');
  f.index(A, '训练');
  f.rollout(B, '2026-10-18');
  f.index(B, '排查转发');
  fs.utimesSync(old, 1, 1);
  assert.equal(await f.locate(1, { title: '训练 | user' }), old);
  assert.equal(await f.locate(1, { title: '训练 | host' }), old);
  assert.equal(await f.locate(1, { title: '训练' }), old);
  assert.equal(await f.locate(1, {}), null);
  assert.equal(await f.locate(1, { title: 'unknown' }), null);
});

test('duplicate names, mismatched cwd and mismatched metadata never bind', async (t) => {
  const f = fixture(t);
  const a = f.rollout(A, '2020-01-01');
  f.index(A, 'same');
  f.rollout(B, '2026-10-18');
  f.index(B, 'same');
  assert.equal(await f.locate(1, { title: 'same' }), null);
  f.index(B, 'different');
  f.rollout(A, '2020-01-01', '/other');
  assert.equal(await f.locate(1, { title: 'same' }), null);
  fs.writeFileSync(a, JSON.stringify({ type: 'session_meta', payload: { id: B, cwd: '/home/user' } }) + '\n');
  assert.equal(await f.locate(1, { title: 'same' }), null);
});

test('renaming or switching in the same TUI re-resolves identity; a missing index does not reuse it', async (t) => {
  const f = fixture(t);
  const a = f.rollout(A, '2020-01-01');
  const b = f.rollout(B, '2026-10-18');
  f.index(A, 'first'); f.index(B, 'second');
  assert.equal(await f.locate(1, { title: 'first' }), a);
  assert.equal(await f.locate(1, { title: 'second' }), b);
  f.index(A, 'renamed');
  assert.equal(await f.locate(1, { title: 'first' }), null);
  assert.equal(await f.locate(1, { title: 'renamed' }), a);
  fs.unlinkSync(path.join(f.home, 'session_index.jsonl'));
  assert.equal(await f.locate(1, { title: 'renamed' }), null);
});

test('legacy Codex uses its own open rollout and refuses multiple open rollouts', async (t) => {
  const f = fixture(t);
  const a = f.rollout(A, '2020-01-01');
  const b = f.rollout(B, '2026-10-18');
  f.open([a, a]);
  assert.equal(await f.locate(1), a);
  f.open([a, b]);
  assert.equal(await f.locate(1), null);
});

test('Codex activity decorations keep the same identity through working and completion', async (t) => {
  const f = fixture(t);
  const a = f.rollout(A, '2020-01-01');
  f.index(A, '训练');
  for (const marker of '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●') {
    assert.equal(await f.locate(1, { title: `${marker} 训练 | user` }), a, marker);
    assert.equal(await f.locate(1, { title: `${marker} | 训练 | user` }), a, marker);
  }
});

test('activity normalization does not choose between a decorated name and a literal name', async (t) => {
  const f = fixture(t);
  f.rollout(A, '2020-01-01'); f.index(A, '训练');
  f.rollout(B, '2020-01-02'); f.index(B, '⠋ 训练');
  assert.equal(await f.locate(1, { title: '⠋ 训练 | user' }), null);
  assert.equal(await f.locate(1, { title: '??? 训练 | user' }), null);
});
