import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTasks, readTaskLog } from './agy-tasks.mjs';
import { findDialog } from './screen.mjs';
import { adapters, lastTurns } from './transcript.mjs';
import { log } from './util.mjs';

const UI_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web', 'ui.html');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
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

// Lightweight HTTP + SSE server sharing the live Registry & Router state.
// Works directly in a local/Tailscale browser or mounted as a Feishu built-in web app.
export function startWebServer({ router, cfg }) {
  const webCfg = cfg.web || {};
  const host = webCfg.host || '127.0.0.1';
  const port = webCfg.port ?? 18790;
  const token = String(webCfg.token || '').trim();
  const sseClients = new Set();

  const snapshot = async () => ({
    sessions: await router.api.ls(),
    status: await router.api.status(),
    agents: Object.keys(cfg.agents || {}),
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

  function authorize(req, url, res) {
    if (!token) return true;
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
    if (safeEqual(bearer, token) || safeEqual(cookieToken, token)) return true;
    sendJson(res, 401, { error: 'unauthorized: provide ?token=... or Authorization: Bearer <token>' });
    return false;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const authResult = authorize(req, url, res);
      if (authResult !== true) return;

      if (req.method === 'GET' && url.pathname === '/') {
        const html = fs.readFileSync(UI_HTML, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        sendJson(res, 200, await snapshot());
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        sseClients.add(res);
        res.write(`event: state\ndata: ${JSON.stringify(await snapshot())}\n\n`);
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
      log('info', 'web.listening', { host, port: actualPort, auth: Boolean(token) });
      if (!token && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
        log('warn', 'web.unauthenticated_non_loopback', { host });
      }
      resolve({
        server,
        host,
        port: actualPort,
        close: () => {
          clearInterval(keepalive);
          clearTimeout(pushTimer);
          for (const name of events) router.registry.off(name, broadcast);
          for (const client of sseClients) client.end();
          sseClients.clear();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}
