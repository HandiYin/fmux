import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { inferEffortFromModel, listAgyModels } from './agy.mjs';
import { listTasks, readTaskLog } from './agy-tasks.mjs';
import { createFeishuOidc, parseCookies } from './feishu-oidc.mjs';
import { GpuRegistry } from './gpu.mjs';
import { createHighlighter } from './highlight.mjs';
import { OpsEngine } from './ops.mjs';
import { findDialog, looksWorking } from './screen.mjs';
import { adapters, lastTurns } from './transcript.mjs';
import { log } from './util.mjs';
import { renderOidcLoginGate } from './web/login-page.mjs';
import { SessionQueueManager } from './web/queue.mjs';
import { createWallpaperStore } from './web/wallpaper.mjs';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const UI_HTML = path.join(WEB_DIR, 'ui.html');
const STATIC_ASSETS = new Map([
  ['/assets/app.css', { file: path.join(WEB_DIR, 'assets', 'app.css'), mime: 'text/css; charset=utf-8' }],
  ['/assets/markdown.js', { file: path.join(WEB_DIR, 'assets', 'markdown.js'), mime: 'application/javascript; charset=utf-8' }],
  ['/assets/wallpaper.js', { file: path.join(WEB_DIR, 'assets', 'wallpaper.js'), mime: 'application/javascript; charset=utf-8' }],
  ['/assets/app.js', { file: path.join(WEB_DIR, 'assets', 'app.js'), mime: 'application/javascript; charset=utf-8' }],
]);

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

function sendJson(res, status, data, req = null) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  const acceptEnc = String(req?.headers?.['accept-encoding'] || '');
  if (body.length >= 2048 && /\bgzip\b/i.test(acceptEnc)) {
    const gz = zlib.gzipSync(body, { level: 1 });
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'gzip',
      Vary: 'Accept-Encoding',
      'Cache-Control': 'no-store',
    });
    res.end(gz);
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readTranscriptRev(file) {
  if (!file) return '';
  try {
    const st = fs.statSync(file);
    return `${st.size}:${Math.trunc(st.mtimeMs)}`;
  } catch {
    return '';
  }
}

// Lightweight HTTP + SSE server sharing the live Registry, Router, OpsEngine, and GpuRegistry,
// with Feishu OIDC auth, modular static UI assets, candidate message queue, and DeepSeek highlighting.
export function startWebServer({
  router,
  cfg,
  ops = null,
  gpu = null,
  getAppSecret,
  oidc: customOidc = null,
  highlighter: customHighlighter = null,
  fetchImpl,
}) {
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

  const ownedOps = !ops && !router.ops;
  const opsEngine = ops || router.ops || new OpsEngine({ router, stateDir: '' });
  const ownedGpu = !gpu && !router.gpu;
  const gpuRegistry = gpu || router.gpu || new GpuRegistry({ registry: router.registry, stateDir: '' });
  router.ops ??= opsEngine;
  router.gpu ??= gpuRegistry;

  const hlCfg = cfg.highlight || {};
  const highlighter = customHighlighter || createHighlighter({
    stateDir: cfg.stateDir && cfg.stateDir !== '/nonexistent' ? cfg.stateDir : '',
    baseUrl: hlCfg.baseUrl || 'https://api.deepseek.com/v1',
    model: hlCfg.model || 'deepseek-chat',
    apiKey: hlCfg.apiKey || '',
    enabled: hlCfg.enabled !== false,
    fetchImpl,
  });

  const wallpaperStore = createWallpaperStore(cfg.stateDir);
  const sseClients = new Set();

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

  const queueMgr = new SessionQueueManager({ router, broadcast });

  // Metadata-keyed (size + mtimeMs, zero hashing) transcript turns cache so tab switches are <1ms.
  const turnsCache = new Map(); // file -> { rev, turns }
  function getCachedTurns(session) {
    if (!session?.transcript || !adapters[session.kind]) return { rev: '', turns: [] };
    const file = session.transcript;
    const rev = readTranscriptRev(file);
    if (!rev) return { rev: '', turns: [] };
    const hit = turnsCache.get(file);
    if (hit && hit.rev === rev) return hit;
    const turns = lastTurns(file, adapters[session.kind], 6 * 1024 * 1024).slice(-60);
    const entry = { rev, turns };
    turnsCache.set(file, entry);
    if (turnsCache.size > 32) turnsCache.delete(turnsCache.keys().next().value);
    return entry;
  }

  const snapshot = async () => {
    const rawSessions = await router.api.ls({ stable: true });
    const sessions = rawSessions.map((s) => {
      const live = router.registry.sessions.get(s.key) || s;
      const pendingQueue = queueMgr.serialize(live);
      return {
        ...s,
        transcriptRev: readTranscriptRev(live.transcript),
        pendingQueue,
        queuePaused: queueMgr.isPaused(live),
      };
    });
    return {
      sessions,
      status: await router.api.status(),
      agents: Object.keys(cfg.agents || {}),
      ops: opsEngine.snapshot(),
      gpu: gpuRegistry.snapshot(),
      wallpaperVersion: wallpaperStore.readMeta()?.updatedAt || 0,
      oidcEnabled,
      now: Date.now(),
    };
  };

  const onRegSessionProgress = (session) => {
    if (session) {
      queueMgr.reconcile(session);
      if (session.status !== 'working' && session.status !== 'blocked') {
        queueMgr.maybeFlush(session);
      }
    }
    broadcast();
  };
  const onRegRemoved = (session) => {
    if (session?.key) queueMgr.delete(session.key);
    broadcast();
  };

  const regEvents = ['added', 'task_update', 'changed'];
  for (const name of regEvents) router.registry.on(name, broadcast);
  router.registry.on('status', onRegSessionProgress);
  router.registry.on('output', onRegSessionProgress);
  router.registry.on('turn_end', onRegSessionProgress);
  router.registry.on('removed', onRegRemoved);
  opsEngine.on('changed', broadcast);
  gpuRegistry.on('changed', broadcast);

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
    if (oidc) {
      const sess = oidc.getSession(req);
      if (sess) return { ok: true, mode: 'oidc', user: { openId: sess.openId, name: sess.name, avatarUrl: sess.avatarUrl } };
    }
    if (token) {
      const tok = checkToken(req, url, res);
      if (tok === 'redirected') return { ok: false, handled: true };
      if (tok === true) return { ok: true, mode: 'token', user: { openId: cfg.owner?.openId || '', name: 'Operator', avatarUrl: '' } };
    }
    if (!oidc && !token) {
      return { ok: true, mode: 'local', user: { openId: cfg.owner?.openId || '', name: 'DOCTOR // LOCAL', avatarUrl: '' } };
    }
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

      // Whitelisted static UI assets (no secrets/session data; avoids WebView cookie edge cases)
      if (req.method === 'GET' && STATIC_ASSETS.has(url.pathname)) {
        const asset = STATIC_ASSETS.get(url.pathname);
        const body = fs.readFileSync(asset.file);
        const acceptEnc = String(req.headers['accept-encoding'] || '');
        if (body.length >= 2048 && /\bgzip\b/i.test(acceptEnc)) {
          res.writeHead(200, { 'Content-Type': asset.mime, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Cache-Control': 'no-cache' });
          res.end(zlib.gzipSync(body, { level: 1 }));
        } else {
          res.writeHead(200, { 'Content-Type': asset.mime, 'Cache-Control': 'no-cache' });
          res.end(body);
        }
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

      // ---- Wallpaper API ----
      if (req.method === 'GET' && url.pathname === '/api/wallpaper') {
        const wp = wallpaperStore.read();
        if (!wp) return sendJson(res, 404, { error: 'no wallpaper configured' });
        res.writeHead(200, {
          'Content-Type': wp.mime,
          'Content-Length': wp.buf.length,
          'Cache-Control': 'private, max-age=300',
        });
        res.end(wp.buf);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/wallpaper') {
        const body = await readJsonBody(req, 16 * 1024 * 1024);
        const match = String(body.dataUrl || '').match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i);
        if (!match) return sendJson(res, 400, { error: 'invalid image dataUrl (supports PNG/JPG/WebP/GIF)' });
        const mime = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
        const buf = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
        if (!buf.length || buf.length > 12 * 1024 * 1024) return sendJson(res, 400, { error: 'image must be under 12 MB' });
        const updatedAt = wallpaperStore.save(mime, buf);
        broadcast();
        sendJson(res, 200, { ok: true, updatedAt, bytes: buf.length });
        return;
      }
      if (req.method === 'DELETE' && url.pathname === '/api/wallpaper') {
        wallpaperStore.clear();
        broadcast();
        sendJson(res, 200, { ok: true, updatedAt: 0 });
        return;
      }

      // ---- Global APIs ----
      if (req.method === 'GET' && url.pathname === '/api/history') {
        sendJson(res, 200, { conversations: await router.api.history() });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/models') {
        const force = url.searchParams.get('refresh') === '1';
        sendJson(res, 200, {
          agy: await listAgyModels({ force }),
          efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          presets: {
            dsh: ['deepseek-chat', 'deepseek-reasoner'],
            claude: ['claude-opus-4-6', 'claude-sonnet-4-6', 'opus', 'sonnet', 'haiku'],
            codex: ['gpt-5-codex', 'o3', 'o4-mini'],
          },
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/highlight') {
        const body = await readJsonBody(req);
        sendJson(res, 200, highlighter.request(body.text || '', { marksOnly: Boolean(body.marks_only) }));
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

      // ---- Heartbeat & Long-Horizon Goals APIs ----
      if (req.method === 'GET' && url.pathname === '/api/ops') {
        sendJson(res, 200, opsEngine.snapshot());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/heartbeats') {
        sendJson(res, 200, opsEngine.addHeartbeat(await readJsonBody(req)));
        return;
      }
      const hbMatch = url.pathname.match(/^\/api\/heartbeats\/([^/]+)(?:\/([a-z]+))?$/);
      if (hbMatch) {
        const id = decodeURIComponent(hbMatch[1]);
        const sub = hbMatch[2];
        if (req.method === 'PATCH' && !sub) return sendJson(res, 200, opsEngine.updateHeartbeat(id, await readJsonBody(req)));
        if (req.method === 'DELETE' && !sub) return sendJson(res, 200, opsEngine.deleteHeartbeat(id));
        if (req.method === 'POST' && sub === 'run') return sendJson(res, 200, await opsEngine.runHeartbeat(id, { manual: true }));
      }
      if (req.method === 'POST' && url.pathname === '/api/goals') {
        sendJson(res, 200, opsEngine.addGoal(await readJsonBody(req)));
        return;
      }
      const goalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)(?:\/([a-z]+))?$/);
      if (goalMatch) {
        const id = decodeURIComponent(goalMatch[1]);
        const sub = goalMatch[2];
        if (req.method === 'PATCH' && !sub) return sendJson(res, 200, opsEngine.updateGoal(id, await readJsonBody(req)));
        if (req.method === 'DELETE' && !sub) return sendJson(res, 200, opsEngine.deleteGoal(id));
        if (req.method === 'POST' && sub === 'supervise') return sendJson(res, 200, await opsEngine.superviseGoal(id, { manual: true }));
      }

      // ---- Unified GPU Registry APIs ----
      if (req.method === 'GET' && url.pathname === '/api/gpu') {
        sendJson(res, 200, gpuRegistry.snapshot());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/gpu/poll') {
        await gpuRegistry.poll({ forceGongji: true });
        sendJson(res, 200, gpuRegistry.snapshot());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/gpu/register') {
        sendJson(res, 200, gpuRegistry.register(await readJsonBody(req)));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/gpu/heartbeat') {
        const { id, ...rest } = await readJsonBody(req);
        sendJson(res, 200, gpuRegistry.heartbeat(id, rest));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/gpu/release') {
        sendJson(res, 200, gpuRegistry.release(await readJsonBody(req)));
        return;
      }

      // ---- Session-specific APIs ----
      const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/([a-z]+)$/);
      if (sessionMatch) {
        const key = decodeURIComponent(sessionMatch[1]);
        const action = sessionMatch[2];
        const session = router.registry.sessions.get(key) || router.registry.resolve(key);
        if (!session) return sendJson(res, 404, { error: `session not found: ${key}` });

        if (req.method === 'GET' && action === 'turns') {
          const since = url.searchParams.get('since') || '';
          const pendingQueue = queueMgr.serialize(session);
          const queuePaused = queueMgr.isPaused(session);
          const rev = readTranscriptRev(session.transcript);
          if (since && rev && since === rev) {
            sendJson(res, 200, { key: session.key, name: session.name, kind: session.kind, rev, unchanged: true, pendingQueue, queuePaused }, req);
            return;
          }
          const { turns } = getCachedTurns(session);
          sendJson(res, 200, { key: session.key, name: session.name, kind: session.kind, rev, turns, pendingQueue, queuePaused }, req);
          return;
        }
        if (req.method === 'GET' && action === 'screen') {
          const lines = Math.max(10, Math.min(300, Number(url.searchParams.get('lines') || 80)));
          const screen = await router.tmux.capture(session.key, { history: Math.max(0, lines - 50) });
          sendJson(res, 200, { key: session.key, screen: screen.split('\n').slice(-lines).join('\n'), dialog: findDialog(screen) }, req);
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
          }, req);
          return;
        }
        if (req.method === 'POST' && action === 'model') {
          if (session.kind === 'shell') return sendJson(res, 400, { error: 'shell 会话不支持切换模型' });
          if (session.status === 'working') return sendJson(res, 409, { error: '当前会话正在思考/生成中，请先等待完成或点击 STOP 后再切换' });
          const body = await readJsonBody(req);
          const model = String(body.model || '').trim();
          const effort = String(body.effort || '').trim().toLowerCase();
          if (!model && !effort) return sendJson(res, 400, { error: 'model or effort required' });
          if (model && !/^[A-Za-z0-9._:/-]+$/.test(model)) return sendJson(res, 400, { error: 'invalid model identifier' });
          if (effort && !/^(low|medium|high|xhigh|max)$/.test(effort)) return sendJson(res, 400, { error: 'invalid effort level' });

          if (model) {
            await router.tmux.sendText(session.key, `/model ${model}`, { keys: true });
            session.model = model;
            const inferred = inferEffortFromModel(model);
            if (inferred) session.effort = inferred;
          }
          const modelAlreadyHasEffort = model && effort && model.toLowerCase().endsWith(`-${effort}`);
          if (effort && !modelAlreadyHasEffort) {
            if (model) await new Promise((r) => setTimeout(r, 420));
            await router.tmux.sendText(session.key, `/effort ${effort}`, { keys: true });
            session.effort = effort;
          }
          router.touchAttached(session);
          await new Promise((r) => setTimeout(r, 550));
          await router.registry.poll().catch(() => {});
          broadcast();
          sendJson(res, 200, { ok: true, model: session.model, modelFamily: session.modelFamily, effort: session.effort });
          return;
        }
        if (req.method === 'POST' && action === 'send') {
          const body = await readJsonBody(req);
          const trimmed = String(body.text || '').trim();
          if (!trimmed) return sendJson(res, 400, { error: 'text is empty' });
          const result = await queueMgr.enqueueOrSend(session, trimmed, { immediate: Boolean(body.immediate) });
          sendJson(res, 200, result);
          return;
        }
        if (action === 'queue') {
          if (req.method === 'GET') {
            sendJson(res, 200, { ok: true, pendingQueue: queueMgr.serialize(session), queuePaused: queueMgr.isPaused(session) });
            return;
          }
          if (req.method === 'POST') {
            const body = await readJsonBody(req);
            const resObj = await queueMgr.applyAction(session, {
              action: String(body.action || '').trim(),
              id: String(body.id || '').trim(),
              dir: body.dir,
              all: Boolean(body.all),
            });
            sendJson(res, resObj.status, resObj.body);
            return;
          }
        }
        if (req.method === 'POST' && action === 'stop') {
          queueMgr.pauseIfQueued(session.key);
          const keys = session.kind === 'shell' ? ['c-c'] : ['esc'];
          await router.tmux.sendKeys(session.key, keys);
          router.registry.markStopped?.(session);
          router.touchAttached(session);
          setTimeout(async () => {
            try {
              if (session.kind !== 'shell') {
                const scr = await router.tmux.capture(session.key);
                if (looksWorking(scr)) {
                  await router.tmux.sendKeys(session.key, ['esc']);
                  router.registry.markStopped?.(session);
                }
              }
              await router.registry.poll();
              broadcast();
            } catch {}
          }, 350);
          setTimeout(() => router.registry.poll().then(() => broadcast()).catch(() => {}), 1100);
          broadcast();
          sendJson(res, 200, { ok: true, stopped: session.name, keys });
          return;
        }
        if (req.method === 'POST' && action === 'keys') {
          const { keys = [] } = await readJsonBody(req);
          if (!Array.isArray(keys) || !keys.length) return sendJson(res, 400, { error: 'keys must be a non-empty array' });
          await router.tmux.sendKeys(session.key, keys);
          if (keys.some((k) => /^(esc|c-c)$/i.test(String(k)))) router.registry.markStopped?.(session);
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
        if (req.method === 'POST' && action === 'rename') {
          const body = await readJsonBody(req);
          try {
            const out = await router.renameSession(session, {
              tmuxName: body.tmuxName ?? '',
              sessionTitle: body.sessionTitle ?? '',
            });
            broadcast();
            sendJson(res, 200, out);
          } catch (err) {
            sendJson(res, /运行中/.test(err.message) ? 409 : 400, { error: err.message });
          }
          return;
        }
        if (req.method === 'POST' && action === 'kill') {
          queueMgr.delete(session.key);
          await router.tmux.killSession(session.tmuxSession, { key: session.key });
          await router.registry.poll().catch(() => {});
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
      log('info', 'web.listening', { host, port: actualPort, oidc: oidcEnabled, token: Boolean(token) });
      resolve({
        server,
        host,
        port: actualPort,
        ops: opsEngine,
        gpu: gpuRegistry,
        close: () => {
          clearInterval(keepalive);
          clearTimeout(pushTimer);
          if (ownedOps) opsEngine.stop();
          if (ownedGpu) gpuRegistry.stop();
          for (const name of regEvents) router.registry.off(name, broadcast);
          router.registry.off('status', onRegSessionProgress);
          router.registry.off('output', onRegSessionProgress);
          router.registry.off('turn_end', onRegSessionProgress);
          router.registry.off('removed', onRegRemoved);
          opsEngine.off('changed', broadcast);
          gpuRegistry.off('changed', broadcast);
          for (const client of sseClients) client.end();
          sseClients.clear();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}
