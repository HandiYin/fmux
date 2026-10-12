import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_PATH, ROOT, loadConfig, resolveSecret } from './config.mjs';
import { Concierge } from './concierge.mjs';
import { startControl } from './control.mjs';
import { createFakeFeishu, createFeishu } from './feishu.mjs';
import { Registry } from './registry.mjs';
import { Router } from './router.mjs';
import { Store } from './store.mjs';
import { log } from './util.mjs';

// The long-running process: Feishu connection, tmux registry, router, control socket.
export async function runDaemon({ fake = false } = {}) {
  const cfg = loadConfig();
  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });

  if (!fake && (!cfg.app.id || !cfg.owner.openId)) {
    console.error(`fmux: ${CONFIG_PATH} has no app.id or no owner.openId. Run "fmux setup" first (see docs/setup.zh.md).`);
    process.exit(2);
  }
  if (fake && !cfg.owner.openId) cfg.owner = { openId: 'ou_fake_owner', chatId: 'oc_fake_chat' };

  const feishu = fake
    ? createFakeFeishu({ dir: path.join(cfg.stateDir, 'fake') })
    : await createFeishu({ appId: cfg.app.id, appSecret: await resolveSecret(cfg.app.secret), ownerOpenId: cfg.owner.openId, tenant: cfg.app.tenant });

  const store = new Store(path.join(cfg.stateDir, fake ? 'state.fake.json' : 'state.json'));
  const registry = new Registry({ intervalMs: cfg.poll.intervalMs, hide: cfg.tmux.hide });
  const concierge = cfg.concierge.enabled
    ? new Concierge({
        bin: cfg.concierge.bin,
        cwd: path.join(ROOT, 'agent'),
        sessionDir: path.join(cfg.stateDir, 'pi-sessions'),
        promptFile: path.join(ROOT, 'agent', 'CONCIERGE.md'),
        model: cfg.concierge.model,
        thinking: cfg.concierge.thinking,
        // bin/ holds fmuxctl for the concierge. On Windows that file is not runnable; `npm link` puts fmuxctl on the PATH there.
        env: { ...process.env, ...(process.platform === 'win32' ? {} : { PATH: `${path.join(ROOT, 'bin')}:${process.env.PATH}` }), FMUX_SOCK: cfg.socket, FMUX_ROOT: ROOT, FMUX_CONFIG: CONFIG_PATH },
      })
    : null;
  const router = new Router({ feishu, registry, concierge, store, cfg });
  router.wire();

  const methods = { ...router.api };
  if (fake) {
    let seq = 0;
    methods['dev.say'] = async ({ text, replyTo }) => {
      await feishu.say({ messageId: `om_user_${++seq}`, chatId: cfg.owner.chatId, chatType: 'p2p', senderId: cfg.owner.openId, content: text, rawContentType: 'text', resources: [], replyToMessageId: replyTo });
      return { ok: true };
    };
    methods['dev.click'] = async ({ value, messageId, formValue }) =>
      feishu.click({ messageId, chatId: cfg.owner.chatId, operator: { openId: cfg.owner.openId }, action: { value, tag: 'button', formValue } });
    methods['dev.outbox'] = async ({ last = 5 }) => feishu.sent.slice(-last);
  }

  // The first poll finishes before Feishu connects, so the first message already sees every session.
  await registry.poll();
  const attached = store.get('attached');
  if (attached && !registry.sessions.has(attached.key)) {
    const byName = registry.resolve(attached.name);
    store.set('attached', byName ? { key: byName.key, name: byName.name } : null);
  }
  registry.start();
  const control = startControl({ socket: cfg.socket, methods });
  await feishu.connect();
  router.resume();
  log('info', 'hub.ready', { fake, sessions: registry.sessions.size, bot: feishu.botName(), attached: store.get('attached')?.name || null });

  function shutdown(signal) {
    log('info', 'hub.stop', { signal });
    registry.stop();
    concierge?.stop();
    store.flush();
    control.close();
    try {
      fs.unlinkSync(cfg.socket);
    } catch {
      // already gone
    }
    router.shutdown().then(() => feishu.disconnect()).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => log('error', 'unhandledRejection', { message: String(err?.message || err), stack: err?.stack }));
}
