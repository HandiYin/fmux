import { EventEmitter } from 'node:events';
import { createFakeFeishu } from '../src/feishu.mjs';
import { lookupConversation } from '../src/history.mjs';
import { Registry } from '../src/registry.mjs';
import { Router } from '../src/router.mjs';
import { Store } from '../src/store.mjs';
import { KEYS } from '../src/tmux.mjs';
import { setLogSink } from '../src/util.mjs';

setLogSink(() => {});

export function fakeTmux(panes = []) {
  const tmux = {
    panes,
    screens: new Map(),
    sent: [],
    keys: [],
    killed: [],
    clientActivity: 0,
    listPanes: async () => tmux.panes.map((p) => ({ ...p })),
    lastClientActivity: async () => tmux.clientActivity,
    capture: async (id) => tmux.screens.get(id) || '',
    sendText: async (id, text) => { tmux.sent.push([id, text]); },
    sendKeys: async (id, keys) => {
      for (const k of keys) if (!KEYS[String(k).toLowerCase()]) throw new Error(`key not allowed: ${k}`);
      tmux.keys.push([id, keys]);
    },
    created: [],
    newSession: async (spec) => { tmux.created.push(spec); },
    killSession: async (name) => { tmux.killed.push(name); },
  };
  return tmux;
}

export function pane(over = {}) {
  return {
    sessionName: 'work', windowIndex: 0, windowName: 'bash', paneIndex: 0, paneId: '%1', panePid: 100,
    command: 'claude', cwd: '/home/u/proj', title: '', tty: '/dev/pts/1', clients: 1, activityAt: 0, inMode: false, single: true, ...over,
  };
}

export function session(over = {}) {
  return {
    key: '%1', name: 'work', tmuxSession: 'work', windowIndex: 0, paneIndex: 0, kind: 'claude', status: 'idle',
    statusSince: Date.now(), note: '', title: '', cwd: '/home/u/proj', lastText: '', lastPrompt: '', turn: null,
    transcript: '/t.jsonl', dialog: null, ...over,
  };
}

// A registry whose sessions the test sets by hand.
class StaticRegistry extends Registry {
  async pollOnce() {}
}

export const OWNER = 'ou_owner';
export const CHAT = 'oc_chat';

export function harness({ sessions = [session()], notify = {} } = {}) {
  const tmux = fakeTmux();
  const feishu = createFakeFeishu();
  const registry = new StaticRegistry({ tmux });
  for (const s of sessions) registry.sessions.set(s.key, s);
  const concierge = new EventEmitter();
  concierge.prompts = [];
  concierge.prompt = (text) => concierge.prompts.push(text);
  concierge.abort = () => {};
  const cfg = {
    owner: { openId: OWNER, chatId: CHAT },
    stateDir: '/nonexistent',
    notify: { minWorkSec: 20, quietIfLocalActiveSec: 180, enabled: true, ...notify },
    agents: {
      claude: { flags: '-d', command: 'claude {flags} -n {name}', continue: 'claude {flags} -c', resume: 'claude {flags} -r {id}' },
      codex: { flags: '--yolo', command: 'codex {flags}', continue: 'codex {flags} resume --last', resume: 'codex {flags} resume {id}' },
      shell: { flags: '', command: '' },
    },
  };
  // A created tmux session shows up in the registry, as the next poll would make it.
  const create = tmux.newSession;
  tmux.newSession = async (spec) => {
    await create(spec);
    const key = `%new${tmux.created.length}`;
    registry.sessions.set(key, session({ key, name: spec.name, tmuxSession: spec.name, kind: 'shell', status: 'shell', cwd: spec.cwd }));
  };
  const conversations = [
    { agent: 'claude', id: '11111111-aaaa-bbbb-cccc-000000000001', title: '生产GT代码检查', cwd: '/tmp', updatedAt: Date.now() - 60000, lastPrompt: '' },
    { agent: 'codex', id: '22222222-aaaa-bbbb-cccc-000000000002', title: '配置 SSH', cwd: '/usr', updatedAt: Date.now() - 120000, lastPrompt: '' },
  ];
  const history = {
    recentConversations: () => conversations,
    lookupConversation: (ref, opts = {}) => lookupConversation(ref, { ...opts, list: conversations }),
  };
  const store = new Store(null);
  const router = new Router({ feishu, registry, concierge, store, cfg, tmux, history });
  router.wire();
  let seq = 0;
  const say = (text, over = {}) => feishu.say({
    messageId: `om_user_${++seq}`, chatId: CHAT, chatType: 'p2p', senderId: OWNER, content: text, rawContentType: 'text', resources: [], ...over,
  });
  const click = (value, over = {}) => feishu.click({ messageId: 'om_clicked', chatId: CHAT, operator: { openId: OWNER }, action: { value, tag: 'button' }, ...over });
  const cardsSent = () => feishu.sent.filter((r) => r.kind === 'card');
  const titles = (kind = 'card') => feishu.sent.filter((r) => r.kind === kind).map((r) => r.card.header.title.content);
  // "title [tag tag]" of the newest record of a message, however it got there
  const head = (record) => `${record.card.header.title.content} [${(record.card.header.text_tag_list || []).map((t) => t.text.content).join(' ')}]`;
  const heads = () => cardsSent().map(head);
  const latest = (messageId) => feishu.sent.filter((r) => r.messageId === messageId && r.card).at(-1);
  return { tmux, feishu, registry, concierge, cfg, store, router, say, click, cardsSent, titles, head, heads, latest };
}
