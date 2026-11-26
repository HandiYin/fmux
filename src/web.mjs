import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTasks, readTaskLog } from './agy-tasks.mjs';
import { createFeishuOidc, parseCookies } from './feishu-oidc.mjs';
import { GpuRegistry } from './gpu.mjs';
import { createHighlighter } from './highlight.mjs';
import { OpsEngine } from './ops.mjs';
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
  html, body { margin: 0; height: 100%; background: #0d0f13; color: #f3f5f8; font-family: "Inter", -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; overflow: hidden; }
  body {
    display: grid; place-items: center; padding: 24px; position: relative;
    background-image:
      radial-gradient(circle at 20% 20%, rgba(34, 187, 255, 0.08), transparent 45%),
      radial-gradient(circle at 80% 80%, rgba(255, 207, 0, 0.05), transparent 40%),
      linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px);
    background-size: 100% 100%, 100% 100%, 36px 36px, 36px 36px;
  }
  .bg-mark {
    position: fixed; right: -20px; bottom: -30px; font-family: "JetBrains Mono", monospace;
    font-size: 200px; font-weight: 900; letter-spacing: 0.08em; color: rgba(255,255,255,0.02);
    pointer-events: none; user-select: none; line-height: 0.85;
  }
  .reticle { position: fixed; width: 18px; height: 18px; border-color: rgba(255,255,255,0.22); border-style: solid; pointer-events: none; }
  .r-tl { top: 20px; left: 20px; border-width: 2px 0 0 2px; }
  .r-tr { top: 20px; right: 20px; border-width: 2px 2px 0 0; }
  .r-bl { bottom: 20px; left: 20px; border-width: 0 0 2px 2px; }
  .r-br { bottom: 20px; right: 20px; border-width: 0 2px 2px 0; }
  .gate {
    width: min(460px, 100%); background: rgba(19, 22, 28, 0.96); border: 1px solid rgba(255,255,255,0.16);
    clip-path: polygon(0 0, calc(100% - 24px) 0, 100% 24px, 100% 100%, 24px 100%, 0 calc(100% - 24px));
    box-shadow: 0 28px 80px rgba(0,0,0,0.7); position: relative;
  }
  .stripe { height: 4px; background: repeating-linear-gradient(-45deg, #ffcf00 0 10px, #13161c 10px 20px); }
  .inner { padding: 30px 28px 24px; }
  .head { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
  .kicker { font-family: "JetBrains Mono", monospace; font-size: 10px; letter-spacing: 0.22em; color: #22bbff; }
  h1 { margin: 2px 0 0; font-size: 21px; font-weight: 800; letter-spacing: 0.06em; }
  p { margin: 0 0 24px; font-size: 13.5px; color: #9ea8b8; line-height: 1.7; }
  code { font-family: "JetBrains Mono", monospace; font-size: 12px; color: #f3f5f8; background: rgba(255,255,255,0.07); padding: 1px 6px; }
  .btn {
    display: flex; align-items: center; justify-content: space-between; width: 100%;
    text-decoration: none; background: #f4f6f8; color: #0a0c10; font-family: "JetBrains Mono", monospace;
    font-weight: 800; padding: 14px 18px; letter-spacing: 0.1em; font-size: 13px;
    clip-path: polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 0 100%);
    transition: background .15s;
  }
  .btn:hover { background: #22bbff; }
  .meta {
    margin-top: 22px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.08);
    display: flex; justify-content: space-between; font-family: "JetBrains Mono", monospace;
    font-size: 10px; letter-spacing: 0.12em; color: #6e7888;
  }
</style>
</head>
<body>
  <div class="reticle r-tl"></div><div class="reticle r-tr"></div><div class="reticle r-bl"></div><div class="reticle r-br"></div>
  <div class="bg-mark">PRTS</div>
  <div class="gate">
    <div class="stripe"></div>
    <div class="inner">
      <div class="head">
        <svg width="34" height="34" viewBox="0 0 32 32" fill="none">
          <polygon points="16,2 30,16 16,30 2,16" stroke="#f4f6f8" stroke-width="1.5"/>
          <polygon points="16,7 25,16 16,25 7,16" stroke="#22bbff" stroke-width="1.2"/>
          <rect x="14" y="14" width="4" height="4" fill="#22bbff"/>
        </svg>
        <div>
          <div class="kicker">RHODES ISLAND // PRTS NEURAL ACCESS</div>
          <h1>FMUX 战术控制台</h1>
        </div>
      </div>
      <p>需要通过 <strong>${brand} OIDC</strong> 校验操作员身份（<code>owner.openId</code>），验证通过后方可访问 Agent 会话、Heartbeat 调度、长期目标与 GPU 看板。</p>
      <a class="btn" href="/auth/login"><span>AUTHORIZE // ${brand.toUpperCase()} OIDC</span><span>→</span></a>
      <div class="meta"><span>APP: ${String(appId || 'UNSET').replace(/[<>&"]/g, '')}</span><span>SECURITY: OWNER_ONLY</span></div>
    </div>
  </div>
</body>
</html>`;
}

// Lightweight HTTP + SSE server sharing the live Registry, Router, OpsEngine, and GpuRegistry,
// with Feishu OIDC auth and DeepSeek Flash message highlighting.
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

  const hlCfg = cfg.highlight || {};
  const highlighter = customHighlighter || createHighlighter({
    stateDir: cfg.stateDir && cfg.stateDir !== '/nonexistent' ? cfg.stateDir : '',
    baseUrl: hlCfg.baseUrl || 'https://api.deepseek.com/v1',
    model: hlCfg.model || 'deepseek-chat',
    apiKey: hlCfg.apiKey || '',
    enabled: hlCfg.enabled !== false,
    fetchImpl,
  });

  const sseClients = new Set();

  // Optional custom wallpaper stored in stateDir (shared across desktop/mobile browsers).
  const wpDir = cfg.stateDir && cfg.stateDir !== '/nonexistent' ? cfg.stateDir : '';
  const wpBin = wpDir ? path.join(wpDir, 'wallpaper.bin') : '';
  const wpMetaFile = wpDir ? path.join(wpDir, 'wallpaper.json') : '';
  let memWallpaper = null;

  function readWallpaperMeta() {
    if (memWallpaper) return { mime: memWallpaper.mime, updatedAt: memWallpaper.updatedAt };
    if (wpMetaFile && wpBin && fs.existsSync(wpMetaFile) && fs.existsSync(wpBin)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(wpMetaFile, 'utf8'));
        if (parsed?.mime && parsed?.updatedAt) return parsed;
      } catch {
        // ignore damaged metadata
      }
    }
    return null;
  }

  function readWallpaper() {
    if (memWallpaper) return memWallpaper;
    const meta = readWallpaperMeta();
    if (!meta || !wpBin || !fs.existsSync(wpBin)) return null;
    try {
      return { ...meta, buf: fs.readFileSync(wpBin) };
    } catch {
      return null;
    }
  }

  function saveWallpaper(mime, buf) {
    const updatedAt = Date.now();
    memWallpaper = { mime, updatedAt, buf };
    if (wpDir) {
      fs.mkdirSync(wpDir, { recursive: true });
      const tmpBin = `${wpBin}.tmp`;
      const tmpMeta = `${wpMetaFile}.tmp`;
      fs.writeFileSync(tmpBin, buf, { mode: 0o600 });
      fs.renameSync(tmpBin, wpBin);
      fs.writeFileSync(tmpMeta, JSON.stringify({ mime, updatedAt }), { mode: 0o600 });
      fs.renameSync(tmpMeta, wpMetaFile);
    }
    return updatedAt;
  }

  function clearWallpaper() {
    memWallpaper = null;
    for (const f of [wpBin, wpMetaFile]) {
      if (f && fs.existsSync(f)) try { fs.unlinkSync(f); } catch {}
    }
  }

  const snapshot = async () => ({
    sessions: await router.api.ls(),
    status: await router.api.status(),
    agents: Object.keys(cfg.agents || {}),
    ops: opsEngine.snapshot(),
    gpu: gpuRegistry.snapshot(),
    wallpaperVersion: readWallpaperMeta()?.updatedAt || 0,
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

  const regEvents = ['added', 'removed', 'status', 'output', 'task_update', 'turn_end', 'changed'];
  for (const name of regEvents) router.registry.on(name, broadcast);
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

      if (req.method === 'GET' && url.pathname === '/api/wallpaper') {
        const wp = readWallpaper();
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
        const updatedAt = saveWallpaper(mime, buf);
        broadcast();
        sendJson(res, 200, { ok: true, updatedAt, bytes: buf.length });
        return;
      }

      if (req.method === 'DELETE' && url.pathname === '/api/wallpaper') {
        clearWallpaper();
        broadcast();
        sendJson(res, 200, { ok: true, updatedAt: 0 });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/history') {
        sendJson(res, 200, { conversations: await router.api.history() });
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

      // ---- 1. Heartbeat Scheduled Tasks API ----
      if (req.method === 'GET' && url.pathname === '/api/ops') {
        sendJson(res, 200, opsEngine.snapshot());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/heartbeats') {
        const body = await readJsonBody(req);
        sendJson(res, 200, opsEngine.addHeartbeat(body));
        return;
      }
      const hbMatch = url.pathname.match(/^\/api\/heartbeats\/([^/]+)(?:\/([a-z]+))?$/);
      if (hbMatch) {
        const id = decodeURIComponent(hbMatch[1]);
        const sub = hbMatch[2];
        if (req.method === 'PATCH' && !sub) {
          sendJson(res, 200, opsEngine.updateHeartbeat(id, await readJsonBody(req)));
          return;
        }
        if (req.method === 'DELETE' && !sub) {
          sendJson(res, 200, opsEngine.deleteHeartbeat(id));
          return;
        }
        if (req.method === 'POST' && sub === 'run') {
          sendJson(res, 200, await opsEngine.runHeartbeat(id, { manual: true }));
          return;
        }
      }

      // ---- 2. Long-Horizon Goals API ----
      if (req.method === 'POST' && url.pathname === '/api/goals') {
        sendJson(res, 200, opsEngine.addGoal(await readJsonBody(req)));
        return;
      }
      const goalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)(?:\/([a-z]+))?$/);
      if (goalMatch) {
        const id = decodeURIComponent(goalMatch[1]);
        const sub = goalMatch[2];
        if (req.method === 'PATCH' && !sub) {
          sendJson(res, 200, opsEngine.updateGoal(id, await readJsonBody(req)));
          return;
        }
        if (req.method === 'DELETE' && !sub) {
          sendJson(res, 200, opsEngine.deleteGoal(id));
          return;
        }
        if (req.method === 'POST' && sub === 'supervise') {
          sendJson(res, 200, await opsEngine.superviseGoal(id, { manual: true }));
          return;
        }
      }

      // ---- 3. Unified GPU Registry & Dashboard API ----
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
        if (!session) {
          sendJson(res, 404, { error: `session not found: ${key}` });
          return;
        }
        if (req.method === 'GET' && action === 'turns') {
          const turns = session.transcript && adapters[session.kind]
            ? lastTurns(session.transcript, adapters[session.kind], 6 * 1024 * 1024).slice(-60)
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
          setTimeout(() => router.registry.poll().catch(() => {}), 450);
          broadcast();
          sendJson(res, sent ? 200 : 409, { ok: sent, blocked: !sent });
          return;
        }
        if (req.method === 'POST' && action === 'stop') {
          const keys = session.kind === 'shell' ? ['c-c'] : ['esc'];
          await router.tmux.sendKeys(session.key, keys);
          router.touchAttached(session);
          setTimeout(() => router.registry.poll().then(() => broadcast()).catch(() => {}), 250);
          setTimeout(() => router.registry.poll().then(() => broadcast()).catch(() => {}), 900);
          broadcast();
          sendJson(res, 200, { ok: true, stopped: session.name, keys });
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
