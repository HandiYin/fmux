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
    case 'dash':
      return replace(await liveCards.adopt('dash', evt.messageId, null, DASH_TTL), '已刷新');
    case 'dash.new':
      router.sendDashboard().catch((err) => log('error', 'dash.send', { message: err.message }));
      return {};
    case 'help':
      router.post(cards.helpCard()).catch(() => {});
      return {};
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
      const existing = liveCards.reusable.get(`session:${session.key}`);
      if (existing && existing.id !== evt.messageId) {
        await router.sendPeek(session);
        return replace(cards.stubCard(`${session.name}：已更新原会话卡片。`), `已创建 ${session.name}`);
      }
      return replace(await liveCards.adopt('peek', evt.messageId, session, liveCards.peekTtl), `已创建 ${session.name}`);
    }
    default:
      break;
  }

  const session = router.find(v);
  if (!session) return toast(`会话 ${v.n || ''} 已不存在`, 'error');
  switch (v.a) {
    case 'attach': {
      if (session.dormant || router.registry.restoring?.has(session.key)) {
        router.attach(session).catch(async (err) => {
          log('error', 'session.activate', { session: session.name, message: err.message });
          const rootId = liveCards.reusable.get(`session:${session.key}`)?.id || evt.messageId;
          await router.notifyThread(session, `恢复 ${session.name} 失败：${err.message}`, rootId)
            .catch((reportError) => log('error', 'session.activate_report', { message: reportError.message }));
        });
        return toast(`正在恢复 ${session.name}，就绪后会接入`);
      }
      // A click on the session's own card needs no second card: that card turns into "已接入".
      const own = liveCards.entries.get(evt.messageId)
        || (liveCards.reusable.get(`session:${session.key}`)?.id === evt.messageId ? { kind: 'peek', key: session.key } : null);
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
      // Restoring an agent may take longer than Feishu's callback deadline.
      const send = async () => {
        if (v.from === 'term' || v.from === 'peek') {
          await router.tmux.sendText(session.key, text, { allowBlocked: true });
          router.touchAttached(session);
          await sleep(600);
          await router.feishu.updater.flush(evt.messageId, await liveCards.redraw(session, evt, 'term'));
          return;
        }
        if (!(await router.deliver(session, text))) return;
        const finished = router.finished.get(evt.messageId);
        if (finished) await router.feishu.updater.flush(evt.messageId, cards.finishedCard({ session, turn: finished.turn, replied: text }));
      };
      send().catch(async (err) => {
        log('error', 'card.deliver', { session: session.name, message: err.message });
        await router.postThreadCard(session, cards.infoCard({ title: '发送失败', text: err.message, template: 'red' }))
          .catch((reportError) => log('error', 'card.deliver_report', { message: reportError.message }));
      });
      return toast('已接收，正在发送');
    }
    case 'kill':
      liveCards.forget(evt.messageId);
      await router.tmux.killSession(session.tmuxSession, { key: session.key });
      return replace(cards.stubCard(`tmux 会话 ${session.tmuxSession} 已结束。`), '已结束');
    default:
      return toast('未知操作', 'warning');
  }
}
