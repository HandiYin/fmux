import assert from 'node:assert/strict';
import test from 'node:test';
import { startWebServer } from '../src/web.mjs';
import { harness, session } from './helpers.mjs';

test('Feishu OIDC gates access to owner open_id and issues HttpOnly session cookies', async () => {
  const h = harness({ sessions: [session({ kind: 'agy', name: 'neon_dev' })] });
  h.cfg.app = { id: 'cli_test_app', tenant: 'feishu', secret: null };
  h.cfg.owner = { openId: 'ou_owner_001', chatId: 'oc_owner' };
  h.cfg.highlight = { enabled: false };
  h.cfg.web = {
    enabled: true,
    host: '127.0.0.1',
    port: 0,
    token: '',
    publicUrl: 'https://fmux.example.com',
    oidc: { enabled: true, redirectUri: '', allowedOpenIds: [], sessionHours: 12 },
  };

  let mockUser = { open_id: 'ou_owner_001', union_id: 'on_1', name: 'Doctor', en_name: 'Doctor', avatar_thumb: '' };
  const mockFetch = async (url) => {
    const s = String(url);
    if (s.includes('/app_access_token/internal')) {
      return new Response(JSON.stringify({ code: 0, app_access_token: 'app_tok_123' }), { status: 200 });
    }
    if (s.includes('/authen/v1/oidc/access_token')) {
      return new Response(JSON.stringify({ code: 0, data: { access_token: 'user_tok_456' } }), { status: 200 });
    }
    if (s.includes('/authen/v1/user_info')) {
      return new Response(JSON.stringify({ code: 0, data: mockUser }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };

  const web = await startWebServer({
    router: h.router,
    cfg: h.cfg,
    getAppSecret: async () => 'app_secret_xyz',
    fetchImpl: mockFetch,
  });
  const base = `http://127.0.0.1:${web.port}`;

  try {
    // Unauthenticated `/` renders the PRTS Feishu OIDC login gate; API returns 401.
    const gate = await fetch(`${base}/`);
    assert.equal(gate.status, 200);
    assert.match(await gate.text(), /AUTHORIZE \/\/ .*OIDC/);
    assert.equal((await fetch(`${base}/api/state`)).status, 401);

    // `/auth/login` redirects to Feishu accounts authorize endpoint and sets state cookie.
    const loginRes = await fetch(`${base}/auth/login`, { redirect: 'manual' });
    assert.equal(loginRes.status, 302);
    const loc = new URL(loginRes.headers.get('location'));
    assert.equal(loc.origin, 'https://accounts.feishu.cn');
    assert.equal(loc.searchParams.get('client_id'), 'cli_test_app');
    assert.equal(loc.searchParams.get('redirect_uri'), 'https://fmux.example.com/auth/callback');
    const state = loc.searchParams.get('state');
    const stateCookie = loginRes.headers.get('set-cookie').split(';')[0];
    assert.ok(state && stateCookie.startsWith('fmux_oidc_state='));

    // Mismatched state is rejected with 400.
    const badState = await fetch(`${base}/auth/callback?code=c1&state=wrong`, { headers: { Cookie: stateCookie } });
    assert.equal(badState.status, 400);

    // Stranger open_id is denied with 403.
    mockUser = { open_id: 'ou_stranger_999', name: 'Intruder' };
    const login2 = await fetch(`${base}/auth/login`, { redirect: 'manual' });
    const state2 = new URL(login2.headers.get('location')).searchParams.get('state');
    const stateCookie2 = login2.headers.get('set-cookie').split(';')[0];
    const denied = await fetch(`${base}/auth/callback?code=c2&state=${encodeURIComponent(state2)}`, {
      headers: { Cookie: stateCookie2 },
      redirect: 'manual',
    });
    assert.equal(denied.status, 403);
    assert.match(await denied.text(), /403 ACCESS DENIED/);

    // Owner open_id succeeds, sets fmux_session cookie, and unlocks /auth/me & /api/state.
    mockUser = { open_id: 'ou_owner_001', union_id: 'on_1', name: 'Doctor' };
    const login3 = await fetch(`${base}/auth/login`, { redirect: 'manual' });
    const state3 = new URL(login3.headers.get('location')).searchParams.get('state');
    const stateCookie3 = login3.headers.get('set-cookie').split(';')[0];
    const okCb = await fetch(`${base}/auth/callback?code=c3&state=${encodeURIComponent(state3)}`, {
      headers: { Cookie: stateCookie3 },
      redirect: 'manual',
    });
    assert.equal(okCb.status, 302);
    const setCookies = okCb.headers.getSetCookie ? okCb.headers.getSetCookie() : [okCb.headers.get('set-cookie')];
    const sessionCookie = setCookies.find((c) => c.startsWith('fmux_session=')).split(';')[0];

    const me = await (await fetch(`${base}/auth/me`, { headers: { Cookie: sessionCookie } })).json();
    assert.equal(me.authenticated, true);
    assert.equal(me.mode, 'oidc');
    assert.equal(me.user.openId, 'ou_owner_001');

    const stateRes = await (await fetch(`${base}/api/state`, { headers: { Cookie: sessionCookie } })).json();
    assert.equal(stateRes.sessions[0].name, 'neon_dev');

    // Logout invalidates the session.
    const out = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { Cookie: sessionCookie } });
    assert.equal(out.status, 200);
    assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: sessionCookie } })).status, 401);
  } finally {
    await web.close();
  }
});
