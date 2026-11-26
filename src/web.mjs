import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentboardBridge } from './agentboard.mjs';
import { listTasks, readTaskLog } from './agy-tasks.mjs';
import { createFeishuOidc, parseCookies } from './feishu-oidc.mjs';
import { findDialog } from './screen.mjs';
import { adapters, lastTurns } from './transcript.mjs';
import { log } from './util.mjs';

const UI_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web', 'ui.html');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function readJsonBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function renderOidcLoginGate({ appId, tenant }) {
  const brand = tenant === 'lark' ? 'Lark' : '飞书 Feishu';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>PRTS // FMUX IDENTITY VERIFICATION</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #090b0e; color: #eef3f8; font-family: "JetBrains Mono", "SFMono-Regular", Menlo, "PingFang SC", sans-serif; }
  body {
    display: grid; place-items: center; padding: 20px;
    background-image:
      linear-gradient(rgba(0, 212, 255, 0.05) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0, 212, 255, 0.05) 1px, transparent 1px);
    background-size: 32px 32px;
  }
  .gate {
    width: min(460px, 100%); background: #11151b; border: 1px solid #263140; padding: 28px 26px;
    clip-path: polygon(0 0, calc(100% - 22px) 0, 100% 22px, 100% 100%, 22px 100%, 0 calc(100% - 22px));
    position: relative; box-shadow: 0 24px 60px rgba(0,0,0,0.65);
  }
  .stripe {
    height: 4px; margin: -28px -26px 20px;
    background: repeating-linear-gradient(-45deg, #facc15 0 12px, #11151b 12px 24px);
  }
  .kicker { font-size: 11px; letter-spacing: 0.18em; color: #00d4ff; text-transform: uppercase; margin-bottom: 8px; }
  h1 { margin: 0 0 8px; font-size: 22px; letter-spacing: 0.04em; }
  p { margin: 0 0 20px; font-size: 13px; color: #8c98a9; line-height: 1.6; }
  .meta { font-size: 11px; color: #647082; border-top: 1px solid #1e2733; padding-top: 12px; margin-top: 18px; display: flex; justify-content: space-between; }
  .btn {
    display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%;
    text-decoration: none; background: #00d4ff; color: #081018; font-weight: 700;
    padding: 13px 18px; letter-spacing: 0.08em; font-size: 14px;
    clip-path: polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px));
    transition: filter .15s;
  }
  .btn:hover { filter: brightness(1.1); }
</style>
</head>
<body>
  <div class="gate">
    <div class="stripe"></div>
    <div class="kicker">RHODES ISLAND // PRTS NEURAL ACCESS</div>
    <h1>FMUX 战术控制台</h1>
    <p>需要通过 <strong>${brand} OIDC</strong> 校验操作员身份（<code>owner.openId</code>）后才可访问本地 Agent 会话、后台任务日志与内置 Agentboard。</p>
    <a class="btn" href="/auth/login">AUTHORIZE VIA ${brand.toUpperCase()} OIDC →</a>
    <div class="meta"><span>APP_ID: ${String(appId || 'UNSET').replace(/[<>&"]/g, '')}</span><span>PROTOCOL: OIDC_V1</span></div>
  </div>
</body>
</html>`;
}

// Lightweight HTTP + SSE server sharing the live Registry & Router state,
// with Feishu OIDC auth and embedded Primatix-Intelligence/agentboard proxy.
export function startWebServer({ router, cfg, getAppSecret, oidc: customOidc = null, agentboard: customAgentboard = null, fetchImpl }) {
  const webCfg = cfg.web || {};
  const host = webCfg.host || '127.0.0.1';
  const port = webCfg.port ?? 18790;
  const token = String(webCfg.token || '').trim();
  const oidcCfg = webCfg.oidc || {};
  const oidcEnabled = Boolean(oidcCfg.enabled || customOidc);
  const oidc = customOidc || (oidcEnabled ? createFeishuOidc({
    appId: cfg.app?.id || '',
    getAppSecret: getAppSecret || (async () => ''),
    tenant: cfg.app?.tenant || 'feishu',
    ownerOpenId: cfg.owner?.openId || '',
    allowedOpenIds: oidcCfg.allowedOpenIds || [],
    redirectUri: oidcCfg.redirectUri || '',
    publicUrl: webCfg.publicUrl || '',
    sessionTtlMs: Math.max(1, Number(oidcCfg.sessionHours || 24)) * 3600 * 1000,
    fetchImpl,
  }) : null);

  const abCfg = webCfg.agentboard || {};
  const agentboard = customAgentboard || new AgentboardBridge({
    enabled: abCfg.enabled !== false,
    port: abCfg.port ?? 8789,
    url: abCfg.url || '',
    python: abCfg.python || 'python3',
    autoStart: abCfg.autoStart !== false,
  });

  const sseClients = new Set();

  const snapshot = async () => ({
    sessions: await router.api.ls(),
    status: await router.api.status(),
    agents: Object.keys(cfg.agents || {}),
    agentboard: { enabled: agentboard.enabled, available: agentboard.isAvailable() },
    oidcEnabled,
    now: Date.now(),
  });

  let pushTimer = null;
  const broadcast = () => {
    if (!sseClients.size || pushTimer) return;
    pushTimer = setTimeout(async () => {
      pushTimer = null;
      try {
        const payload = `event: state\ndata: ${JSON.stringify(await snapshot())}\n\n`;
        for (const res of sseClients) res.write(payload);
      } catch (err) {
        log('warn', 'web.broadcast', { message: err.message });
      }
    }, 150);
    pushTimer.unref?.();
  };

  const events = ['added', 'removed', 'status', 'output', 'task_update', 'turn_end', 'changed'];
  for (const name of events) router.registry.on(name, broadcast);

  const keepalive = setInterval(() => {
    for (const res of sseClients) res.write(': ping\n\n');
  }, 15000);
  keepalive.unref?.();

  function checkToken(req, url, res) {
    if (!token) return false;
    const queryToken = url.searchParams.get('token');
    const auth = String(req.headers.authorization || '');
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const cookieToken = parseCookies(req.headers.cookie).fmux_token || '';
    if (queryToken && safeEqual(queryToken, token)) {
      if (url.pathname === '/') {
        res.writeHead(302, {
          Location: '/',
          'Set-Cookie': `fmux_token=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax`,
        });
        res.end();
        return 'redirected';
      }
      return true;
    }
    return safeEqual(bearer, token) || safeEqual(cookieToken, token);
  }

  function authorize(req, url, res) {
    // 1. Check Feishu OIDC session first when enabled.
    if (oidc) {
      const sess = oidc.getSession(req);
      if (sess) return { ok: true, mode: 'oidc', user: { openId: sess.openId, name: sess.name, avatarUrl: sess.avatarUrl } };
    }
    // 2. Check static token when configured.
    if (token) {
      const tok = checkToken(req, url, res);
      if (tok === 'redirected') return { ok: false, handled: true };
      if (tok === true) return { ok: true, mode: 'token', user: { openId: cfg.owner?.openId || '', name: 'Operator', avatarUrl: '' } };
    }
    // 3. No auth configured: open (localhost mode).
    if (!oidc && !token) {
      return { ok: true, mode: 'local', user: { openId: cfg.owner?.openId || '', name: 'DOCTOR // LOCAL', avatarUrl: '' } };
    }
    // 4. Unauthorized: serve PRTS OIDC login gate for browser root, JSON 401 for APIs.
    if (oidc && req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(renderOidcLoginGate({ appId: cfg.app?.id, tenant: cfg.app?.tenant }));
      return { ok: false, handled: true };
    }
    sendJson(res, 401, { error: oidc ? 'unauthorized: Feishu OIDC login required (/auth/login)' : 'unauthorized: provide ?token=... or Authorization: Bearer <token>' });
    return { ok: false, handled: true };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      // Public OIDC endpoints
      if (oidc && req.method === 'GET' && url.pathname === '/auth/login') {
        oidc.startLogin(req, res, url.searchParams.get('next') || '/');
        return;
      }
      if (oidc && req.method === 'GET' && url.pathname === '/auth/callback') {
        await oidc.handleCallback(req, url, res);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/auth/logout') {
        if (oidc) oidc.logout(req, res);
        else sendJson(res, 200, { ok: true });
        return;
      }

      const auth = authorize(req, url, res);
      if (!auth.ok) return;

      if (req.method === 'GET' && url.pathname === '/auth/me') {
        sendJson(res, 200, { authenticated: true, mode: auth.mode, oidcEnabled, user: auth.user });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/') {
        const html = fs.readFileSync(UI_HTML, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }

      // Embedded Primatix-Intelligence/agentboard reverse proxy (protected by auth above!)
      if (url.pathname === '/agentboard') {
        res.writeHead(302, { Location: '/agentboard/' });
        res.end();
        return;
      }
      if (url.pathname.startsWith('/agentboard/')) {
        const subpath = url.pathname.slice('/agentboard'.length) + (url.search || '');
        await agentboard.proxy(req, res, subpath);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        sendJson(res, 200, { ...(await snapshot()), user: auth.user, authMode: auth.mode });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        sseClients.add(res);
        res.write(`event: state\ndata: ${JSON.stringify({ ...(await snapshot()), user: auth.user, authMode: auth.mode })}\n\n`);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/history') {
        sendJson(res, 200, { conversations: await router.api.history() });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/detach') {
        await router.detach();
        broadcast();
        sendJson(res, 200, { attached: null });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        const body = await readJsonBody(req);
        const created = await router.api.new({
          name: body.name || '',
          agent: body.agent || 'agy',
          cwd: body.cwd || '~',
          prompt: body.prompt || '',
          resume: body.resume || 'new',
          yolo: body.yolo !== false,
          attach: body.attach !== false,
        });
        broadcast();
        sendJson(res, 200, created);
        return;
      }

      const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/([a-z]+)$/);
      if (sessionMatch) {
        const key = decodeURIComponent(sessionMatch[1]);
        const action = sessionMatch[2];
        const session = router.registry.sessions.get(key) || router.registry.resolve(key);
        if (!session) {
          sendJson(res, 404, { error: `session not found: ${key}` });
          return;
        }
        if (req.method === 'GET' && action === 'turns') {
          const turns = session.transcript && adapters[session.kind]
            ? lastTurns(session.transcript, adapters[session.kind]).slice(-20)
            : [];
          sendJson(res, 200, { key: session.key, name: session.name, kind: session.kind, turns });
          return;
        }
        if (req.method === 'GET' && action === 'screen') {
          const lines = Math.max(10, Math.min(300, Number(url.searchParams.get('lines') || 80)));
          const screen = await router.tmux.capture(session.key, { history: Math.max(0, lines - 50) });
          const dialog = findDialog(screen);
          sendJson(res, 200, { key: session.key, screen: screen.split('\n').slice(-lines).join('\n'), dialog });
          return;
        }
        if (req.method === 'GET' && action === 'tasks') {
          const lines = Math.max(10, Math.min(300, Number(url.searchParams.get('lines') || 80)));
          const taskId = url.searchParams.get('taskId') || '';
          const tasks = listTasks(session);
          const selected = taskId
            ? tasks.find((t) => t.id === taskId || t.shortId === taskId)
            : (tasks.find((t) => t.status === 'running' && t.logFile) || tasks.find((t) => t.logFile) || tasks[0] || null);
          sendJson(res, 200, {
            key: session.key,
            tasks: tasks.map((t) => ({ ...t, hasLog: Boolean(t.logFile) })),
            selectedTaskId: selected?.id || null,
            log: selected ? readTaskLog(selected, { maxLines: lines }) : '',
          });
          return;
        }
        if (req.method === 'POST' && action === 'send') {
          const { text = '' } = await readJsonBody(req);
          if (!String(text).trim()) return sendJson(res, 400, { error: 'text is empty' });
          const sent = await router.deliver(session, String(text).trim());
          broadcast();
          sendJson(res, sent ? 200 : 409, { ok: sent, blocked: !sent });
          return;
        }
        if (req.method === 'POST' && action === 'keys') {
          const { keys = [] } = await readJsonBody(req);
          if (!Array.isArray(keys) || !keys.length) return sendJson(res, 400, { error: 'keys must be a non-empty array' });
          await router.tmux.sendKeys(session.key, keys);
          router.touchAttached(session);
          broadcast();
          sendJson(res, 200, { ok: true, keys });
          return;
        }
        if (req.method === 'POST' && action === 'attach') {
          await router.attach(session, { announce: false });
          broadcast();
          sendJson(res, 200, { attached: session.name });
          return;
        }
        if (req.method === 'POST' && action === 'kill') {
          await router.tmux.killSession(session.tmuxSession);
          broadcast();
          sendJson(res, 200, { killed: session.tmuxSession });
          return;
        }
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      log('warn', 'web.request', { url: req.url, message: err.message });
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      log('info', 'web.listening', { host, port: actualPort, oidc: oidcEnabled, token: Boolean(token), agentboard: agentboard.enabled });
      if (!oidcEnabled && !token && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
        log('warn', 'web.unauthenticated_non_loopback', { host });
      }
      resolve({
        server,
        host,
        port: actualPort,
        agentboard,
        close: () => {
          clearInterval(keepalive);
          clearTimeout(pushTimer);
          agentboard.stop();
          for (const name of events) router.registry.off(name, broadcast);
          for (const client of sseClients) client.end();
          sseClients.clear();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}
