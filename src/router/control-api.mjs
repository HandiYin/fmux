import { listTasks, readTaskLog, runningTasks } from '../agy-tasks.mjs';
import * as cards from '../cards.mjs';

// Local control API exposed over the Unix socket / named pipe for fmuxctl and the concierge.
export function createControlApi(router) {
  const summary = (s) => ({
    name: s.name, key: s.key, kind: s.kind, status: s.status, since: new Date(s.statusSince).toISOString(), note: s.note,
    cwd: s.cwd, title: s.title, model: s.model || '', attached: router.attachedKey() === s.key,
    runningTasks: runningTasks(s).length,
    tasks: listTasks(s).slice(0, 10).map((t) => ({
      id: t.id, shortId: t.shortId, kind: t.kind, status: t.status, description: t.description,
      startedAt: t.startedAt, endedAt: t.endedAt, summary: t.summary, hasLog: Boolean(t.logFile),
    })),
    lastPrompt: s.lastPrompt.slice(0, 300), lastText: s.lastText.slice(0, 600),
  });

  return {
    ls: async () => router.registry.list().map(summary),
    status: async () => ({
      pid: process.pid,
      uptimeSec: Math.round((Date.now() - router.startedAt) / 1000),
      sessions: router.registry.sessions.size,
      attached: router.store.get('attached')?.name || null,
      chatKnown: Boolean(router.chatId),
      conciergeRunning: Boolean(router.concierge?.child),
      liveCards: router.live.size,
      localKeyboardActive: router.localActive(),
    }),
    peek: async ({ ref, lines = 40 }) => {
      const session = router.need(ref);
      const screen = await router.tmux.capture(session.key, { history: Math.max(0, lines - 50) });
      return { ...summary(session), screen: screen.split('\n').slice(-lines).join('\n') };
    },
    send: async ({ ref, text }) => {
      const session = router.need(ref);
      if (session.status === 'blocked') throw new Error(`${session.name} is waiting on a dialog; answer it with "fmuxctl keys" first`);
      await router.deliver(session, text);
      return { sent: session.name, note: 'the reply will show up in the chat as a card' };
    },
    keys: async ({ ref, keys }) => {
      const session = router.need(ref);
      await router.tmux.sendKeys(session.key, keys);
      return { sent: session.name, keys };
    },
    attach: async ({ ref }) => {
      const session = router.need(ref);
      await router.attach(session);
      return { attached: session.name };
    },
    detach: async () => {
      await router.detach();
      return { attached: null };
    },
    history: async () => router.history.recentConversations(),
    form: async () => ({ messageId: await router.post(router.newSessionForm()) }),
    new: async ({ name, agent, cwd, prompt, resume, yolo = true, attach = true }) => {
      const session = await router.createSession({ name, agent, cwd, prompt, resume, yolo });
      if (attach) await router.attach(session);
      return summary(session);
    },
    kill: async ({ ref }) => {
      const session = router.need(ref);
      await router.tmux.killSession(session.tmuxSession);
      return { killed: session.tmuxSession };
    },
    notify: async ({ title = 'fmux', text }) => ({ messageId: await router.post(cards.infoCard({ title, text })) }),
    dashboard: async () => ({ messageId: await router.sendDashboard() }),
    handoff: async (params) => router.handoff(params),
    tasks: async ({ ref, taskId, lines = 40 }) => {
      const session = router.need(ref);
      const tasks = listTasks(session);
      const selected = taskId
        ? tasks.find((t) => t.id === taskId || t.shortId === taskId)
        : (tasks.find((t) => t.status === 'running' && t.logFile) || tasks.find((t) => t.logFile) || tasks[0] || null);
      return {
        ...summary(session),
        selectedTaskId: selected?.id || null,
        log: selected ? readTaskLog(selected, { maxLines: Math.max(1, lines) }) : '',
      };
    },
    show: async ({ ref, terminal = false, tasks = false }) => {
      const session = router.need(ref);
      const messageId = await (tasks ? router.sendTasks(session) : terminal ? router.sendTerminal(session) : router.sendPeek(session));
      return { messageId };
    },
    'gpu.ls': async () => {
      if (!router.gpu) throw new Error('GPU registry is not initialized');
      await router.gpu.poll();
      return router.gpu.snapshot();
    },
    'gpu.register': async (params) => {
      if (!router.gpu) throw new Error('GPU registry is not initialized');
      return router.gpu.register(params);
    },
    'gpu.heartbeat': async ({ id, ...rest }) => {
      if (!router.gpu) throw new Error('GPU registry is not initialized');
      return router.gpu.heartbeat(id, rest);
    },
    'gpu.release': async (params) => {
      if (!router.gpu) throw new Error('GPU registry is not initialized');
      return router.gpu.release(params);
    },
    'ops.ls': async () => (router.ops ? router.ops.snapshot() : { heartbeats: [], goals: [] }),
  };
}
