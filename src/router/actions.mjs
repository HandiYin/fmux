import * as cards from '../cards.mjs';
import { findDialog, keysFor } from '../screen.mjs';
import { log, sleep } from '../util.mjs';
import { DASH_TTL } from './live-cards.mjs';

const toast = (content, type = 'success') => ({ toast: { type, content } });
const replace = (card, toastText) => ({ ...(toastText ? toast(toastText) : {}), card: { type: 'raw', data: card } });

// Bot menus remain available when the chat has scrolled past the last panel.
// They operate on the hub directly, even when an agent is busy or blocked.
export async function handleBotMenu(router, evt) {
  if (evt.operator?.openId !== router.cfg.owner.openId) return;
  switch (evt.key) {
    case 'fmux.dashboard':
      await router.sendDashboard();
      break;
    case 'fmux.concierge':
      await router.detach();
      await router.sendDashboard();
      break;
    case 'fmux.new':
      await router.post(router.newSessionForm());
      break;
    default:
      return;
  }
  log('info', 'menu.action', { key: evt.key });
}

export async function handleCardAction(router, evt) {
  try {
    if (evt.operator?.openId !== router.cfg.owner.openId) return toast('无权限', 'error');
    const value = typeof evt.action?.value === 'string' ? JSON.parse(evt.action.value) : evt.action?.value || {};
    return await dispatchAction(router, value, evt);
  } catch (err) {
    log('error', 'router.action', { message: err.message, stack: err.stack });
    return toast(`失败：${err.message}`, 'error');
  }
}

async function dispatchAction(router, v, evt) {
  const form = evt.action?.formValue || {};
  const { liveCards } = router;
  switch (v.a) {
    case 'new.form':
      router.post(router.newSessionForm()).catch((err) => log('error', 'new.form', { message: err.message }));
      return {};
    case 'detach':
      await router.detach();
      return v.from === 'dash' ? replace(await liveCards.adopt('dash', evt.messageId, null, DASH_TTL), '已断开') : toast('已断开，消息回到 Pi 管家');
    case 'pi.stop':
      router.concierge?.abort();
      return toast('已请求停止');
    case 'new.submit': {
      let session;
      try {
        session = await router.createSession({
          name: String(form.name || '').trim(), agent: form.agent || 'claude', cwd: String(form.cwd || '~').trim(),
          prompt: String(form.prompt || '').trim(), resume: String(form.resume || 'new'), yolo: form.yolo !== 'no',
        });
      } catch (err) {
        return replace(router.newSessionForm(err.message));
      }
      await router.attach(session, { announce: false });
      router.store.rememberMessage(evt.messageId, session.key);
      return replace(await liveCards.adopt('peek', evt.messageId, session, liveCards.peekTtl), `已创建 ${session.name}`);
    }
    default:
      break;
  }

  const session = router.find(v);
  if (!session) return toast(`会话 ${v.n || ''} 已不存在`, 'error');
  switch (v.a) {
    case 'attach': {
      // A click on the session's own card needs no second card: that card turns into "已接入".
      const own = liveCards.entries.get(evt.messageId);
      const sameCard = own && own.kind !== 'dash' && own.key === session.key && session.status !== 'working' && session.status !== 'blocked';
      await router.attach(session, { announce: !sameCard });
      if (sameCard) return replace(await liveCards.redraw(session, evt, own.kind), `已接入 ${session.name}`);
      return v.from === 'dash' ? replace(await liveCards.adopt('dash', evt.messageId, null, DASH_TTL), `已接入 ${session.name}`) : toast(`已接入 ${session.name}`);
    }
    case 'peek':
      router.sendPeek(session).catch((err) => log('error', 'peek.send', { message: err.message }));
      return {};
    case 'term':
      router.sendTerminal(session).catch((err) => log('error', 'term.send', { message: err.message }));
      return {};
    case 'tasks':
      router.sendTasks(session).catch((err) => log('error', 'tasks.send', { message: err.message }));
      return {};
    case 'peek.refresh':
      return replace(await liveCards.redraw(session, evt, 'peek'));
    case 'term.refresh':
      return replace(await liveCards.redraw(session, evt, 'term'));
    case 'tasks.refresh':
      return replace(await liveCards.redraw(session, evt, 'tasks'));
    case 'key': {
      await router.tmux.sendKeys(session.key, [v.k]);
      router.touchAttached(session);
      if (v.from === 'term' || v.from === 'peek') {
        await sleep(450);
        return replace(await liveCards.redraw(session, evt, 'term'), `已发送 ${v.k}`);
      }
      return toast(`已发送 ${v.k}`);
    }
    case 'pick': {
      // Read the dialog again: the choice must match what is on the screen now, not when the card was sent.
      const screen = await router.tmux.capture(session.key);
      const dialog = findDialog(screen);
      const state = router.blocked.get(session.key);
      if (v.i === -1) {
        await router.tmux.sendKeys(session.key, ['esc']);
      } else {
        const option = dialog?.options[v.i];
        if (!option || !option.label.startsWith(v.l)) return toast('屏幕上的对话框已经变了，点「屏幕」看一下', 'warning');
        await router.tmux.sendKeys(session.key, keysFor(dialog, v.i));
      }
      router.touchAttached(session);
      router.blocked.delete(session.key);
      const answered = v.i === -1 ? 'Esc' : dialog.options[v.i].label;
      return replace(cards.blockedCard({ session, dialog, screen: state?.screen || screen, answered }), '已发送');
    }
    case 'reply': {
      const text = String(form.text || '').trim();
      if (!text) return toast('内容为空', 'warning');
      if (v.from === 'term' || v.from === 'peek') {
        // The terminal card talks to the terminal as it is, dialog or not.
        await router.tmux.sendText(session.key, text);
        router.touchAttached(session);
        await sleep(600);
        return replace(await liveCards.redraw(session, evt, 'term'), '已发送');
      }
      if (!(await router.deliver(session, text))) return toast('会话在等确认，没有发出', 'warning');
      const finished = router.finished.get(evt.messageId);
      return finished ? replace(cards.finishedCard({ session, turn: finished.turn, replied: text }), '已发送') : toast('已发送');
    }
    case 'kill':
      liveCards.forget(evt.messageId);
      await router.tmux.killSession(session.tmuxSession);
      return replace(cards.stubCard(`tmux 会话 ${session.tmuxSession} 已结束。`), '已结束');
    default:
      return toast('未知操作', 'warning');
  }
}
