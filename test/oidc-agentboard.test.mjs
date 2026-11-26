import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { AgentboardBridge } from '../src/agentboard.mjs';
import { startWebServer } from '../src/web.mjs';
import { OWNER, harness, session } from './helpers.mjs';

function mockFeishuFetch({ openId = OWNER, name = 'Doctor', avatarUrl = 'https://img.example/a.png' } = {}) {
  return async (url, opts) => {
    const s = String(url);
    if (s.endsWith('/app_access_token/internal')) {
      return new Response(JSON.stringify({ code: 0, app_access_token: 'app_tok_123' }), { status: 200 });
    }
    if (s.endsWith('/authen/v1/oidc/access_token')) {
      assert.equal(opts.headers.Authorization, 'Bearer app_tok_123');
      return new Response(JSON.stringify({ code: 0, data: { access_token: 'user_tok_456' } }), { status: 200 });
    }
    if (s.endsWith('/authen/v1/user_info')) {
      assert.equal(opts.headers.Authorization, 'Bearer user_tok_456');
      return new Response(JSON.stringify({ code: 0, data: { open_id: openId, name, avatar_thumb: avatarUrl } }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 404, msg: 'not mocked' }), { status: 404 });
  };
}

function startStubAgentboard() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><html><head><link rel="manifest" href="/manifest.webmanifest"></head><body><h1>Agentboard Stub</h1></body></html>');
        return;
      }
      if (req.url === '/api/state') {
        assert.equal(req.headers.cookie, undefined, 'fmux OIDC cookie must never leak to upstream agentboard');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ board: 'ok', cards: 3 }));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({ port: srv.address().port, close: () => new Promise((d) => srv.close(() => d())) });
    });
  });
}

test('Feishu OIDC gates PRTS UI & Agentboard proxy to owner.openId, rejects strangers, and injects PRTS skin + path rewrite', async () => {
  const upstream = await startStubAgentboard();
  const h = harness({ sessions: [session({ kind: 'agy', status: 'background' })] });
  h.cfg.app = { id: 'cli_prts_test', tenant: 'feishu' };
  h.cfg.web = {
    enabled: true,
    host: '127.0.0.1',
    port: 0,
    oidc: { enabled: true, allowedOpenIds: [] },
    agentboard: { enabled: true, url: `http://127.0.0.1:${upstream.port}`, autoStart: false },
  };

  let currentUser = { openId: OWNER, name: 'Doctor' };
  const web = await startWebServer({
    router: h.router,
    cfg: h.cfg,
    getAppSecret: async () => 'app_secret_xyz',
    fetchImpl: (url, opts) => mockFeishuFetch(currentUser)(url, opts),
  });
  const base = `http://127.0.0.1:${web.port}`;

  try {
    // Unauthenticated root shows PRTS OIDC login gate; API and agentboard return 401.
    const gate = await fetch(`${base}/`);
    assert.equal(gate.status, 200);
    assert.match(await gate.text(), /PRTS NEURAL ACCESS/);
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/agentboard/`)).status, 401);

    // Step 1: /auth/login issues CSRF state cookie and redirects to Feishu authorize URL.
    const login = await fetch(`${base}/auth/login`, { redirect: 'manual' });
    assert.equal(login.status, 302);
    const loc = new URL(login.headers.get('location'));
    assert.equal(loc.origin, 'https://accounts.feishu.cn');
    assert.equal(loc.searchParams.get('client_id'), 'cli_prts_test');
    const state = loc.searchParams.get('state');
    const stateCookie = login.headers.get('set-cookie').split(';')[0];

    // Stranger Feishu user gets 403 ACCESS DENIED.
    currentUser = { openId: 'ou_stranger', name: 'Intruder' };
    const denied = await fetch(`${base}/auth/callback?code=c1&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: stateCookie },
      redirect: 'manual',
    });
    assert.equal(denied.status, 403);
    assert.match(await denied.text(), /403 ACCESS DENIED/);

    // Owner Feishu user completes OIDC callback and receives HttpOnly session cookie.
    currentUser = { openId: OWNER, name: 'Doctor' };
    const login2 = await fetch(`${base}/auth/login`, { redirect: 'manual' });
    const state2 = new URL(login2.headers.get('location')).searchParams.get('state');
    const stateCookie2 = login2.headers.get('set-cookie').split(';')[0];

    const cb = await fetch(`${base}/auth/callback?code=c2&state=${encodeURIComponent(state2)}`, {
      headers: { Cookie: stateCookie2 },
      redirect: 'manual',
    });
    assert.equal(cb.status, 302);
    const setCookies = cb.headers.getSetCookie ? cb.headers.getSetCookie() : [cb.headers.get('set-cookie')];
    const sessCookie = setCookies.find((c) => c.startsWith('fmux_session=')).split(';')[0];
    assert.ok(sessCookie);

    // Authenticated user gets PRTS UI and /auth/me identity.
    const me = await (await fetch(`${base}/auth/me`, { headers: { Cookie: sessCookie } })).json();
    assert.equal(me.mode, 'oidc');
    assert.equal(me.user.openId, OWNER);
    assert.equal(me.user.name, 'Doctor');

    const ui = await (await fetch(`${base}/`, { headers: { Cookie: sessCookie } })).text();
    assert.match(ui, /PRTS \/\/ FMUX/);
    assert.match(ui, /AGENTBOARD/);

    // Embedded Agentboard proxy rewrites /api/* via injected script, injects PRTS skin, and proxies JSON APIs.
    const abHtml = await (await fetch(`${base}/agentboard/`, { headers: { Cookie: sessCookie } })).text();
    assert.match(abHtml, /Agentboard Stub/);
    assert.match(abHtml, /prts-agentboard-skin/);
    assert.match(abHtml, /href="\/agentboard\/manifest\.webmanifest"/);

    const abApi = await (await fetch(`${base}/agentboard/api/state`, { headers: { Cookie: sessCookie } })).json();
    assert.deepEqual(abApi, { board: 'ok', cards: 3 });

    // Logout revokes the opaque session immediately.
    const out = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { Cookie: sessCookie } });
    assert.equal(out.status, 200);
    assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: sessCookie } })).status, 401);
  } finally {
    await web.close();
    await upstream.close();
  }
});

test('AgentboardBridge detects vendored server.py cleanly', () => {
  const bridge = new AgentboardBridge({ enabled: true, autoStart: false });
  assert.equal(bridge.isAvailable(), true);
});
