import * as cards from '../cards.mjs';

// Local control API exposed over the Unix socket / named pipe for fmuxctl and the concierge.
export function createControlApi(router) {
  const summary = (s) => ({
    name: s.name, key: s.key, kind: s.kind, status: s.status, since: new Date(s.statusSince).toISOString(), note: s.note,
    cwd: s.cwd, title: s.title, attached: router.attachedKey() === s.key,
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
    show: async ({ ref, terminal = false }) => ({
      messageId: await (terminal ? router.sendTerminal(router.need(ref)) : router.sendPeek(router.need(ref))),
    }),
  };
}
