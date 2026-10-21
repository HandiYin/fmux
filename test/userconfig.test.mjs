import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { sessionFilter } from '../src/session-filter.mjs';

test('user preferences override behavior while retaining credentials and other settings', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmux-usercfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  const raw = { app: { id: 'cli_test', secret: { source: 'env', name: 'SECRET' } }, notify: { minWorkSec: 123 }, tmux: { hide: ['reserved'] } };
  fs.writeFileSync(file, JSON.stringify(raw));
  fs.writeFileSync(path.join(dir, 'userconfig.json'), JSON.stringify({
    tmux: { include: ['fmux-*'], exclude: ['fmux-private-*'] },
    notify: { scope: 'followed', completionPing: false },
    sessions: { namePrefix: 'fmux-', onConflict: 'replace-idle' },
  }));
  const cfg = loadConfig(file);
  assert.deepEqual(cfg.app, { ...raw.app, tenant: 'feishu' });
  assert.equal(cfg.notify.minWorkSec, 123);
  assert.equal(cfg.notify.scope, 'followed');
  assert.equal(cfg.notify.completionPing, false);
  assert.deepEqual(cfg.tmux.hide, ['reserved']);
  assert.deepEqual(cfg.tmux.include, ['fmux-*']);
  assert.equal(cfg.sessions.onConflict, 'replace-idle');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), raw);
  fs.writeFileSync(path.join(dir, 'userconfig.json'), '{"app":{"id":"wrong"}}');
  assert.throws(() => loadConfig(file), /Unsupported userconfig setting/);
});

test('session filters allow only requested globs, with exclusions and legacy hide taking precedence', () => {
  const allows = sessionFilter({ include: ['fmux-*'], exclude: ['fmux-private-*'], hide: ['fmux-hidden'] });
  assert.equal(allows('fmux-work'), true);
  for (const name of ['private', 'fmux', 'fmux-private-work', 'fmux-hidden']) assert.equal(allows(name), false);
  assert.equal(sessionFilter({})('anything'), true);
  assert.equal(sessionFilter({ include: ['one.?.[x]'] })('one.a.[x]'), true);
  assert.equal(sessionFilter({ include: ['one.?.[x]'] })('oneXaXx'), false);
  assert.throws(() => sessionFilter({ include: 'fmux-*' }), /arrays/);
});
