import assert from 'node:assert/strict';
import test from 'node:test';
import { CardUpdater } from '../src/feishu.mjs';
import { Router } from '../src/router.mjs';
import { harness, session } from './helpers.mjs';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const stop = (t, r) => t.after(() => { clearInterval(r.ticker); clearTimeout(r.nudgeTimer); });
const turn = (text = 'final') => ({ startedAt: Date.now() - 1000, endedAt: Date.now(), texts: [text], tools: 0, worked: true });

test('overlapping flushes retain one queue and the newest card wins', async () => {
  const a = deferred(); const b = deferred(); const startedB = deferred(); const completed = [];
  const updater = new CardUpdater(async (_, card) => {
    if (card === 'a') await a.promise;
    if (card === 'b') { startedB.resolve(); await b.promise; }
    completed.push(card);
  }, 0);
  const first = updater.flush('id', 'a');
  const second = updater.flush('id', 'b');
  a.resolve(); await first; await startedB.promise;
  assert.equal(updater.entries.has('id'), true);
  const third = updater.flush('id', 'c');
  b.resolve(); await Promise.all([second, third]);
  assert.deepEqual(completed, ['a', 'b', 'c']);
  assert.equal(updater.entries.size, 0);
});

test('a flush reports its own failure even when a later queued edit succeeds', async () => {
  const updater = new CardUpdater(async (_, card) => { if (card === 'bad') throw new Error('temporary outage'); }, 0);
  const first = updater.flush('id', 'bad', { throwOnError: true });
  const second = updater.flush('id', 'good', { throwOnError: true });
  await assert.rejects(first, /temporary outage/);
  await second;
});

test('failed final edits are persisted, retried and survive a hub restart', async (t) => {
  const s = session(); const h = harness({ sessions: [s] }); stop(t, h.router);
  await h.router.attach(s, { announce: false });
  s.status = 'working'; s.turn = turn('progress');
  await h.router.onStatus(s, 'idle');
  const view = h.router.views.get(s.key); await view.ready;
  const update = h.feishu.updater.update;
  h.feishu.updater.update = async () => { throw new Error('temporary outage'); };
  s.status = 'idle';
  const result = await h.router.onTurnEnd(s, turn()).catch((err) => err);
  if (result instanceof Error) assert.match(result.message, /temporary outage/);
  else assert.equal(result[0].status, 'rejected');
  assert.equal(h.store.get('pendingCompletions')[view.messageId].card.header.template, 'default');
  h.feishu.updater.update = update;
  const restarted = new Router({ feishu: h.feishu, registry: h.registry, store: h.store, cfg: h.cfg, tmux: h.tmux });
  stop(t, restarted);
  for (const p of restarted.pendingCompletions.values()) p.retryAt = 0;
  await restarted.tick();
  assert.equal(h.latest(view.messageId).card.header.template, 'default');
  assert.deepEqual(h.store.get('pendingCompletions'), {});
});

for (const completedOffline of [false, true]) {
  test(`restart reuses the active reply card (completed offline: ${completedOffline})`, async (t) => {
    const s = session({ status: 'working', turn: turn('progress') });
    const h = harness({ sessions: [s] }); stop(t, h.router);
    h.store.set('attached', { key: s.key, name: s.name });
    const view = h.router.ensureView(s); await view.ready;
    await h.router.shutdown();
    if (completedOffline) { s.status = 'idle'; s.lastText = 'final'; }
    const restarted = new Router({ feishu: h.feishu, registry: h.registry, store: h.store, cfg: h.cfg, tmux: h.tmux });
    stop(t, restarted);
    await restarted.resume();
    if (!completedOffline) { s.status = 'idle'; await restarted.onTurnEnd(s, turn()); }
    assert.equal(h.latest(view.messageId).card.header.template, 'default');
    assert.match(JSON.stringify(h.latest(view.messageId).card), /final/);
    assert.equal(h.cardsSent().filter((r) => r.card.header.subtitle?.content?.startsWith('用时 ')).length, 0);
  });
}

test('reused pane IDs do not adopt reply cards from a different conversation', async (t) => {
  const s = session({ status: 'working', turn: turn('progress') });
  const h = harness({ sessions: [s] }); stop(t, h.router);
  const view = h.router.ensureView(s); await view.ready;
  s.transcript = '/different-conversation.jsonl';
  const restarted = new Router({ feishu: h.feishu, registry: h.registry, store: h.store, cfg: h.cfg, tmux: h.tmux });
  stop(t, restarted); await restarted.resume();
  assert.equal(restarted.views.has(s.key), false);
});
