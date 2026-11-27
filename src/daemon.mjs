import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_PATH, ROOT, loadConfig, resolveSecret } from './config.mjs';
import { Concierge } from './concierge.mjs';
import { startControl } from './control.mjs';
import { createFakeFeishu, createFeishu } from './feishu.mjs';
import { GpuRegistry } from './gpu.mjs';
import { ManagedRegistry } from './managed-registry.mjs';
import { OpsEngine } from './ops.mjs';
import { Router } from './router.mjs';
import { Store } from './store.mjs';
import { log } from './util.mjs';
import { startWebServer } from './web.mjs';

// The long-running process: Feishu connection, tmux registry, router, control socket, optional web UI.
export async function runDaemon({ fake = false, web = false } = {}) {
  const cfg = loadConfig();
  if (web) cfg.web = { ...cfg.web, enabled: true };
  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });

  if (!fake && (!cfg.app.id || !cfg.owner.openId)) {
    console.error(`fmux: ${CONFIG_PATH} has no app.id or no owner.openId. Run "fmux setup" first (see docs/setup.zh.md).`);
    process.exit(2);
  }
  if (fake && !cfg.owner.openId) cfg.owner = { openId: 'ou_fake_owner', chatId: 'oc_fake_chat' };

  const appSecret = fake ? '' : await resolveSecret(cfg.app.secret);
  const feishu = fake
    ? createFakeFeishu({ dir: path.join(cfg.stateDir, 'fake') })
    : await createFeishu({ appId: cfg.app.id, appSecret, ownerOpenId: cfg.owner.openId, tenant: cfg.app.tenant });

  const store = new Store(path.join(cfg.stateDir, fake ? 'state.fake.json' : 'state.json'));
  const registry = new ManagedRegistry({ cfg, store });
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
  const gpu = new GpuRegistry({ registry, stateDir: cfg.stateDir });
  const router = new Router({ feishu, registry, concierge, store, cfg, tmux: registry.transport, gpu });
  const ops = new OpsEngine({ router, stateDir: cfg.stateDir });
  router.ops = ops;
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
    store.set('attached', byName ? { ...attached, key: byName.key, name: byName.name, lastInputAt: attached.lastInputAt || Date.now() } : null);
  }
  registry.start();
  ops.start();
  gpu.start();
  const control = startControl({ socket: cfg.socket, methods });
  const webServer = cfg.web?.enabled ? await startWebServer({ router, cfg, ops, gpu, getAppSecret: async () => appSecret || resolveSecret(cfg.app.secret) }) : null;
  await feishu.connect();
  await router.resume();
  log('info', 'hub.ready', {
    fake,
    sessions: registry.sessions.size,
    bot: feishu.botName(),
    attached: store.get('attached')?.name || null,
    web: webServer ? `http://${webServer.host}:${webServer.port}` : null,
  });

  function shutdown(signal) {
    log('info', 'hub.stop', { signal });
    registry.stop();
    ops.stop();
    gpu.stop();
    concierge?.stop();
    store.flush();
    control.close();
    webServer?.close().catch(() => {});
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
