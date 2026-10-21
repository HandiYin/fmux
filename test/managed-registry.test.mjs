import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ManagedRegistry, conversationId } from '../src/managed-registry.mjs';
import { Store } from '../src/store.mjs';
import { Router } from '../src/router.mjs';
import { createFakeFeishu } from '../src/feishu.mjs';
import { SESSION_NAME_RE } from '../src/tmux.mjs';
import { fakeTmux, pane, OWNER, CHAT } from './helpers.mjs';

const ID = '11111111-aaaa-bbbb-cccc-000000000001';

async function setup(t, { agent = 'claude' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmux-managed-'));
  const file = path.join(dir, `${ID}.jsonl`);
  fs.writeFileSync(file, agent === 'codex' ? JSON.stringify({ type: 'session_meta', payload: { id: ID } }) + '\n' : '');
  let clock = Date.now();
  let kind = agent;
  const children = new Map();
  const meta = { status: 'idle', sessionId: ID };
  const tmux = fakeTmux([pane({ clients: 0, cwd: dir })]);
  tmux.SESSION_NAME_RE = SESSION_NAME_RE;
  tmux.setSessionIdentity = async (key, logicalId) => {
    tmux.panes.find((p) => p.paneId === key).logicalId = logicalId;
  };
  tmux.killSession = async (name) => {
    tmux.killed.push(name);
    tmux.panes = tmux.panes.filter((p) => p.sessionName !== name);
  };
  tmux.newSession = async (spec) => {
    tmux.created.push(spec);
    tmux.panes.push(pane({ paneId: `%${tmux.created.length + 1}`, sessionName: spec.name,
      logicalId: spec.logicalId, cwd: spec.cwd, clients: 0 }));
  };
  const cfg = {
    poll: { intervalMs: 2000 }, tmux: { hide: [] },
    lifecycle: { enabled: true, idleMinutes: 60, restoreTimeoutMs: 1000 },
    agents: {
      claude: { flags: '-d --permission-mode auto', resume: 'claude {flags} -r {id}' },
      codex: { flags: '--yolo', resume: 'codex {flags} resume {id}' },
    },
    owner: { openId: OWNER, chatId: CHAT },
    notify: { enabled: true, quietIfLocalActiveSec: 180, minWorkSec: 20 },
  };
  const probe = {
    snapshot: () => ({ procs: new Map(), children }),
    findAgent: () => kind === 'shell' ? null : { kind, pid: 200 },
    readClaudeMeta: () => meta,
    locateTranscript: () => kind === 'shell' ? null : file,
  };
  const storeFile = path.join(dir, 'state.json');
  const build = (store = new Store(storeFile)) => new ManagedRegistry({ cfg, store, tmux, probe,
    now: () => clock, wait: async (ms) => { clock += ms; } });
  const registry = build();
  t.after(() => {
    registry.store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await registry.poll();
  const session = registry.list()[0];
  return { registry, session, cfg, storeFile, build, meta, tmux, children,
    age: () => { clock += 61 * 60000; }, setKind: (value) => { kind = value; } };
}

test('idle retirement keeps the durable target; the next message resumes the exact conversation', async (t) => {
  const h = await setup(t);
  h.registry.setLaunchPolicy(h.session, { agent: 'claude', yolo: false });
  await h.registry.poll();
  const key = h.session.key;
  h.age();
  await h.registry.poll();
  assert.deepEqual(h.tmux.killed, ['work']);
  assert.equal(h.session.dormant, true);
  assert.equal(h.registry.sessions.get(key), h.session);
  assert.equal(JSON.parse(fs.readFileSync(h.storeFile)).managedSessions[key].conversationId, ID);
  await h.registry.transport.sendText(key, 'continue');
  assert.equal(h.tmux.created.length, 1);
  assert.match(h.tmux.created[0].command, new RegExp(ID));
  assert.doesNotMatch(h.tmux.created[0].command, /permission-mode/);
  assert.deepEqual(h.tmux.sent, [['%2', 'continue']]);
  assert.equal(h.session.key, key);
  assert.equal(h.session.dormant, false);
});

test('quoted cards and an attached conversation still route after retirement', async (t) => {
  const h = await setup(t);
  const feishu = createFakeFeishu();
  const router = new Router({ feishu, registry: h.registry, store: h.registry.store, cfg: h.cfg, tmux: h.registry.transport });
  router.wire();
  t.after(() => clearTimeout(router.nudgeTimer));
  await router.attach(h.session, { announce: false });
  const messageId = await router.post({ header: { title: { content: 'reply' } } }, h.session.key);
  h.age();
  await h.registry.poll();
  assert.equal(router.attachedKey(), h.session.key);
  await router.onMessage({ senderId: OWNER, chatId: CHAT, chatType: 'p2p', content: 'follow up',
    rawContentType: 'text', resources: [], replyToMessageId: messageId });
  assert.deepEqual(h.tmux.sent, [['%2', 'follow up']]);
});

test('a reboot restores durable attachment and message bindings without trusting reused pane IDs', async (t) => {
  const h = await setup(t);
  const key = h.session.key;
  h.registry.store.set('attached', { key, name: 'work' });
  h.registry.store.rememberMessage('old-card', key);
  h.registry.store.flush();
  h.tmux.panes = [pane({ paneId: '%1', sessionName: 'unrelated', clients: 1, cwd: '/tmp' })];
  const restarted = h.build();
  t.after(() => restarted.store.flush());
  await restarted.poll();
  assert.equal(restarted.store.sessionKeyFor('old-card'), key);
  assert.equal(restarted.sessions.get(key).dormant, true);
  await restarted.transport.sendText(key, 'after reboot');
  assert.deepEqual(h.tmux.sent, [['%2', 'after reboot']]);
  assert.notEqual(restarted.resolve('unrelated').key, key);
});

test('a hub restart keeps identities of still-running tmux panes', async (t) => {
  const h = await setup(t);
  h.registry.store.flush();
  const restarted = h.build();
  t.after(() => restarted.store.flush());
  await restarted.poll();
  assert.equal(restarted.list().length, 1);
  assert.equal(restarted.list()[0].key, h.session.key);
  assert.equal(restarted.list()[0].dormant, false);
});

test('simultaneous follow-ups create one replacement and send both inputs in order', async (t) => {
  const h = await setup(t);
  h.age();
  await h.registry.poll();
  await Promise.all(['one', 'two'].map((text) => h.registry.transport.sendText(h.session.key, text)));
  assert.equal(h.tmux.created.length, 1);
  assert.deepEqual(h.tmux.sent, [['%2', 'one'], ['%2', 'two']]);
});

for (const condition of ['working', 'blocked', 'clients', 'children', 'multiple panes', 'unknown identity', 'disabled']) {
  test(`does not retire ${condition}`, async (t) => {
    const h = await setup(t);
    if (condition === 'working') h.meta.status = 'busy';
    if (condition === 'blocked') h.meta.status = 'waiting';
    if (condition === 'clients') h.tmux.panes[0].clients = 1;
    if (condition === 'children') h.children.set(200, [300]);
    if (condition === 'multiple panes') h.tmux.panes[0].single = false;
    if (condition === 'unknown identity') { h.meta.sessionId = 'unverified'; h.registry.records.clear(); }
    if (condition === 'disabled') h.cfg.lifecycle.enabled = false;
    await h.registry.poll();
    h.age();
    await h.registry.poll();
    assert.equal(h.tmux.killed.length, 0);
  });
}

test('rechecks status before retirement to protect a newly started local task', async (t) => {
  const h = await setup(t);
  h.age();
  let count = 0;
  h.registry.liveRegistry.probe.readClaudeMeta = () => {
    if (++count === 2) h.meta.status = 'busy';
    return h.meta;
  };
  await h.registry.poll();
  assert.equal(h.tmux.killed.length, 0);
});

test('failed persistence prevents retirement', async (t) => {
  const h = await setup(t);
  h.age();
  const flush = h.registry.store.flush.bind(h.registry.store);
  h.registry.store.flush = () => { throw new Error('disk full'); };
  await assert.rejects(h.registry.poll(), /disk full/);
  h.registry.store.flush = flush;
  assert.equal(h.tmux.killed.length, 0);
});

test('an unrelated same-name terminal is never used as a restoration target', async (t) => {
  const h = await setup(t);
  h.age();
  await h.registry.poll();
  h.tmux.panes.push(pane({ paneId: '%99', sessionName: 'work' }));
  await assert.rejects(h.registry.transport.sendText(h.session.key, 'private'), /同名终端/);
  await h.registry.poll();
  assert.equal(h.registry.lookup('work').match, null);
  assert.equal(h.registry.lookup('work').candidates.length, 2);
  assert.equal(h.tmux.sent.length, 0);
});

test('startup timeout and repeated retries never type a prompt into a shell or wrong conversation', async (t) => {
  const h = await setup(t);
  h.age();
  await h.registry.poll();
  h.setKind('shell');
  await assert.rejects(h.registry.transport.sendText(h.session.key, 'private'), /尚未就绪/);
  await assert.rejects(h.registry.transport.sendText(h.session.key, 'retry'), /尚未就绪/);
  assert.equal(h.tmux.created.length, 1);
  assert.equal(h.tmux.sent.length, 0);
  h.setKind('claude');
  h.meta.sessionId = '22222222-aaaa-bbbb-cccc-000000000002';
  await assert.rejects(h.registry.transport.sendText(h.session.key, 'wrong conversation'), /尚未就绪/);
  assert.equal(h.tmux.sent.length, 0);
  h.meta.sessionId = ID;
  await h.registry.transport.sendText(h.session.key, 'ready');
  assert.deepEqual(h.tmux.sent, [['%2', 'ready']]);
});

test('explicit deletion forgets dormant sessions instead of resurrecting them', async (t) => {
  const h = await setup(t);
  h.age();
  await h.registry.poll();
  await h.registry.transport.killSession('work');
  await assert.rejects(h.registry.transport.sendText(h.session.key, 'retry'), /已删除/);
  assert.equal(h.registry.records.size, 0);
});

test('replying to a deleted conversation never falls through to another attached session', async (t) => {
  const h = await setup(t);
  const feishu = createFakeFeishu();
  const router = new Router({ feishu, registry: h.registry, store: h.registry.store, cfg: h.cfg, tmux: h.registry.transport });
  router.wire();
  t.after(() => clearTimeout(router.nudgeTimer));
  h.registry.store.rememberMessage('deleted-card', h.session.key);
  await h.registry.transport.killSession('work');
  h.tmux.panes = [pane({ paneId: '%99', sessionName: 'other', clients: 1 })];
  await h.registry.poll();
  await router.attach(h.registry.resolve('other'), { announce: false });
  await router.onMessage({ senderId: OWNER, chatId: CHAT, chatType: 'p2p', content: 'private',
    rawContentType: 'text', resources: [], replyToMessageId: 'deleted-card' });
  assert.equal(h.tmux.sent.length, 0);
  assert.match(JSON.stringify(feishu.sent), /会话已删除/);
});

test('restoration retains the chosen launch flags', async (t) => {
  const h = await setup(t);
  h.registry.setLaunchPolicy(h.session, { agent: 'claude', yolo: true });
  await h.registry.poll();
  h.age();
  await h.registry.poll();
  await h.registry.transport.sendText(h.session.key, 'continue');
  assert.match(h.tmux.created[0].command, /-d --permission-mode auto/);
});

test('a confirmation discovered at startup blocks text but permits explicit key input', async (t) => {
  const h = await setup(t);
  h.age();
  await h.registry.poll();
  h.meta.status = 'waiting';
  await assert.rejects(h.registry.transport.sendText(h.session.key, 'do not approve'), /等待确认/);
  assert.equal(h.tmux.sent.length, 0);
  await h.registry.transport.sendKeys(h.session.key, ['esc']);
  assert.deepEqual(h.tmux.keys, [['%2', ['esc']]]);
});

test('an unverified startup can be inspected and answered without forwarding text', async (t) => {
  const h = await setup(t);
  h.age();
  await h.registry.poll();
  h.setKind('shell');
  await assert.rejects(h.registry.transport.sendText(h.session.key, 'private'), /尚未就绪/);
  await h.registry.transport.sendKeys(h.session.key, ['enter']);
  assert.equal(h.tmux.sent.length, 0);
  assert.deepEqual(h.tmux.keys, [['%2', ['enter']]]);
});

test('a restart during agent startup retains the identity verification requirement', async (t) => {
  const h = await setup(t);
  h.age();
  await h.registry.poll();
  h.setKind('shell');
  await assert.rejects(h.registry.transport.sendText(h.session.key, 'private'), /尚未就绪/);
  const restarted = h.build();
  t.after(() => restarted.store.flush());
  await restarted.poll();
  await assert.rejects(restarted.transport.sendText(h.session.key, 'after restart'), /尚未就绪/);
  assert.equal(h.tmux.created.length, 1);
  assert.equal(h.tmux.sent.length, 0);
});

test('Codex resume identity comes from rollout metadata, not a filename or directory', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmux-meta-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: ID } }) + '\n');
  assert.equal(conversationId({ kind: 'codex', transcript }), ID);
  fs.writeFileSync(transcript, '{"type":"session_meta","payload":{"id":"bad"}}\n');
  assert.equal(conversationId({ kind: 'codex', transcript }), null);
});

test('Codex retirement and restoration retain the exact rollout ID and launch policy', async (t) => {
  const h = await setup(t, { agent: 'codex' });
  h.registry.setLaunchPolicy(h.session, { agent: 'codex', yolo: false });
  await h.registry.poll();
  h.age();
  await h.registry.poll();
  assert.equal(h.session.dormant, true);
  await h.registry.transport.sendText(h.session.key, 'continue codex');
  assert.match(h.tmux.created[0].command, new RegExp(`codex +resume '${ID}'`));
  assert.doesNotMatch(h.tmux.created[0].command, /--yolo/);
  assert.deepEqual(h.tmux.sent, [['%2', 'continue codex']]);
});

test('include/exclude filters ignore private live panes and saved dormant records', async (t) => {
  const h = await setup(t);
  h.registry.store.flush();
  h.cfg.tmux.include = ['fmux-*'];
  h.cfg.tmux.exclude = ['fmux-private-*'];
  h.tmux.panes.push(pane({ paneId: '%2', sessionName: 'fmux-work', clients: 0, cwd: h.session.cwd }));
  h.tmux.panes.push(pane({ paneId: '%3', sessionName: 'fmux-private-debug', clients: 0, cwd: h.session.cwd }));
  const inspected = [];
  h.tmux.capture = async (key) => { inspected.push(key); return ''; };
  const filtered = h.build();
  t.after(() => filtered.store.flush());
  await filtered.poll();
  assert.deepEqual(filtered.list().map((s) => s.name), ['fmux-work']);
  assert.deepEqual(inspected, ['%2']);
  assert.equal(filtered.records.has(h.session.key), true, 'private restore records are retained on disk');
  await assert.rejects(filtered.transport.sendText(h.session.key, 'private'), /已删除/);
  assert.equal(h.tmux.sent.length, 0);
});

for (const dormant of [false, true]) {
  test(`same-name replacement retains attachment and old card bindings (${dormant ? 'dormant' : 'idle'})`, async (t) => {
    const h = await setup(t);
    const key = h.session.key;
    h.cfg.sessions = { onConflict: 'replace-idle', namePrefix: '' };
    h.cfg.agents.claude.command = 'claude {flags} -n {name}';
    const feishu = createFakeFeishu();
    const router = new Router({ feishu, registry: h.registry, store: h.registry.store, cfg: h.cfg, tmux: h.registry.transport });
    router.wire();
    t.after(() => clearTimeout(router.nudgeTimer));
    await router.attach(h.session, { announce: false });
    h.registry.store.rememberMessage('old-reply', key);
    if (dormant) { h.age(); await h.registry.poll(); }
    const replacement = await router.createSession({ name: 'work', agent: 'claude', cwd: h.session.cwd });
    assert.equal(replacement.key, key);
    assert.equal(h.registry.list().length, 1);
    assert.equal(h.registry.store.get('attached').key, key);
    assert.equal(h.registry.store.sessionKeyFor('old-reply'), key);
    assert.equal(h.tmux.created.length, 1);
    assert.equal(h.tmux.killed.length, 1);
    assert.equal(feishu.sent.length, 0, 'replacement does not announce removal or detach');
    await router.onMessage({ senderId: OWNER, chatId: CHAT, chatType: 'p2p', content: 'new request',
      rawContentType: 'text', resources: [], replyToMessageId: 'old-reply' });
    assert.deepEqual(h.tmux.sent, [['%2', 'new request']]);
  });
}

for (const condition of ['working', 'blocked', 'clients', 'children', 'multiple panes']) {
  test(`same-name replacement refuses ${condition}`, async (t) => {
    const h = await setup(t);
    if (condition === 'working') h.meta.status = 'busy';
    if (condition === 'blocked') h.meta.status = 'waiting';
    if (condition === 'clients') h.tmux.panes[0].clients = 1;
    if (condition === 'children') h.children.set(200, [300]);
    if (condition === 'multiple panes') h.tmux.panes[0].single = false;
    await assert.rejects(h.registry.replaceSession({ name: 'work', cwd: h.session.cwd, command: 'claude', agent: 'claude' }), /不能自动替换/);
    assert.equal(h.tmux.created.length, 0);
    assert.equal(h.tmux.killed.length, 0);
  });
}

test('replacement startup verification survives a hub restart', async (t) => {
  const h = await setup(t);
  const create = h.tmux.newSession;
  h.tmux.newSession = async (spec) => { await create(spec); h.setKind('shell'); };
  await h.registry.replaceSession({ name: 'work', cwd: h.session.cwd, command: 'claude', agent: 'claude' });
  h.registry.store.flush();
  const restarted = h.build();
  t.after(() => restarted.store.flush());
  await restarted.poll();
  await assert.rejects(restarted.transport.sendText(h.session.key, 'private'), /新会话尚未就绪/);
  assert.equal(h.tmux.sent.length, 0);
});
