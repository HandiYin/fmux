import crypto from 'node:crypto';
import { log } from './util.mjs';

const STATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function hostsForTenant(tenant) {
  return tenant === 'lark'
    ? { accounts: 'https://accounts.larksuite.com', api: 'https://open.larksuite.com' }
    : { accounts: 'https://accounts.feishu.cn', api: 'https://open.feishu.cn' };
}

function isSecureRequest(req, publicUrl = '') {
  if (String(publicUrl).startsWith('https://')) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https' || Boolean(req.socket?.encrypted);
}

function cookieAttrs({ maxAge, secure }) {
  return `HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}${secure ? '; Secure' : ''}`;
}

// Feishu / Lark OIDC OAuth2 authorization code flow using opaque in-memory session tokens.
// Strictly gates browser access to the configured owner open_id (and optional allowedOpenIds).
export function createFeishuOidc({
  appId,
  getAppSecret,
  tenant = 'feishu',
  ownerOpenId = '',
  allowedOpenIds = [],
  redirectUri = '',
  publicUrl = '',
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  fetchImpl = globalThis.fetch,
}) {
  const hosts = hostsForTenant(tenant);
  const allowed = new Set([ownerOpenId, ...(allowedOpenIds || [])].filter(Boolean));
  const pendingStates = new Map(); // state -> { expiresAt, returnTo }
  const sessions = new Map(); // sessionId -> { openId, unionId, name, enName, avatarUrl, expiresAt }

  function prune() {
    const now = Date.now();
    for (const [k, v] of pendingStates) if (v.expiresAt <= now) pendingStates.delete(k);
    for (const [k, v] of sessions) if (v.expiresAt <= now) sessions.delete(k);
  }

  function resolveRedirectUri(req) {
    if (redirectUri) return redirectUri;
    // When behind an HTTPS reverse proxy (publicUrl=https://...), always use publicUrl.
    // For direct HTTP access across multiple interfaces (Tailscale + WireGuard + localhost),
    // derive the callback from the request Host so the state cookie matches the callback host.
    if (publicUrl && (String(publicUrl).startsWith('https://') || !req.headers.host)) {
      return `${publicUrl.replace(/\/+$/, '')}/auth/callback`;
    }
    const proto = isSecureRequest(req, publicUrl) ? 'https' : 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1';
    return `${proto}://${host}/auth/callback`;
  }

  async function postJson(url, body, headers = {}) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data.code !== undefined && data.code !== 0)) {
      throw new Error(`Feishu OIDC ${url.split('/').pop()} failed (${res.status}): ${data.msg || data.error_description || 'unknown error'}`);
    }
    return data;
  }

  async function exchangeCode(code) {
    const appSecret = await getAppSecret();
    if (!appId || !appSecret) throw new Error('Feishu app.id or app.secret is not configured');

    const appTokenRes = await postJson(`${hosts.api}/open-apis/auth/v3/app_access_token/internal`, {
      app_id: appId,
      app_secret: appSecret,
    });
    const appAccessToken = appTokenRes.app_access_token;
    if (!appAccessToken) throw new Error('missing app_access_token from Feishu');

    const oidcRes = await postJson(
      `${hosts.api}/open-apis/authen/v1/oidc/access_token`,
      { grant_type: 'authorization_code', code },
      { Authorization: `Bearer ${appAccessToken}` },
    );
    const userAccessToken = oidcRes.data?.access_token;
    if (!userAccessToken) throw new Error('missing user access_token from Feishu OIDC');

    const infoRes = await fetchImpl(`${hosts.api}/open-apis/authen/v1/user_info`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${userAccessToken}` },
    });
    const infoData = await infoRes.json().catch(() => ({}));
    if (!infoRes.ok || (infoData.code !== undefined && infoData.code !== 0)) {
      throw new Error(`Feishu user_info failed (${infoRes.status}): ${infoData.msg || 'unknown error'}`);
    }
    const u = infoData.data || {};
    return {
      openId: u.open_id || '',
      unionId: u.union_id || '',
      name: u.name || u.en_name || 'Operator',
      enName: u.en_name || '',
      avatarUrl: u.avatar_thumb || u.avatar_url || '',
    };
  }

  return {
    getSession(req) {
      prune();
      const sid = parseCookies(req.headers.cookie).fmux_session;
      if (!sid) return null;
      const sess = sessions.get(sid);
      if (!sess || sess.expiresAt <= Date.now()) {
        sessions.delete(sid);
        return null;
      }
      return { sid, ...sess };
    },

    startLogin(req, res, returnTo = '/') {
      prune();
      const state = randomToken(24);
      const safeReturn = String(returnTo || '/').startsWith('/') && !String(returnTo).startsWith('//') ? returnTo : '/';
      pendingStates.set(state, { expiresAt: Date.now() + STATE_TTL_MS, returnTo: safeReturn });
      const cb = resolveRedirectUri(req);
      const authUrl = new URL(`${hosts.accounts}/open-apis/authen/v1/authorize`);
      authUrl.searchParams.set('client_id', appId);
      authUrl.searchParams.set('redirect_uri', cb);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('state', state);
      const secure = isSecureRequest(req, publicUrl);
      res.writeHead(302, {
        Location: authUrl.toString(),
        'Set-Cookie': `fmux_oidc_state=${encodeURIComponent(state)}; ${cookieAttrs({ maxAge: STATE_TTL_MS / 1000, secure })}`,
        'Cache-Control': 'no-store',
      });
      res.end();
    },

    async handleCallback(req, url, res) {
      prune();
      const code = url.searchParams.get('code') || '';
      const state = url.searchParams.get('state') || '';
      const cookieState = parseCookies(req.headers.cookie).fmux_oidc_state || '';
      const entry = pendingStates.get(state);
      pendingStates.delete(state);
      const secure = isSecureRequest(req, publicUrl);

      if (!code || !state || !entry || !safeEqual(state, cookieState)) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('PRTS AUTH ERROR: invalid or expired Feishu OIDC state. Please retry login.');
        return;
      }

      const user = await exchangeCode(code);
      if (allowed.size > 0 && !allowed.has(user.openId)) {
        log('warn', 'oidc.denied', { openId: user.openId, name: user.name });
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`<!DOCTYPE html><meta charset="utf-8"><body style="background:#0b0d10;color:#f2f5f8;font-family:monospace;padding:40px">
          <h2 style="color:#ff3b5c">PRTS // 403 ACCESS DENIED</h2>
          <p>Feishu operator <strong>${user.name.replace(/[<>&"]/g, '')}</strong> (<code>${user.openId.replace(/[<>&"]/g, '')}</code>) is not authorized for this fmux workstation.</p>
          <p style="color:#8a95a5">Add this open_id to <code>web.oidc.allowedOpenIds</code> or bind as <code>owner.openId</code>.</p>
        </body>`);
        return;
      }

      const sid = randomToken(32);
      sessions.set(sid, { ...user, expiresAt: Date.now() + sessionTtlMs });
      log('info', 'oidc.login', { openId: user.openId, name: user.name });
      res.writeHead(302, {
        Location: entry.returnTo || '/',
        'Set-Cookie': [
          `fmux_session=${encodeURIComponent(sid)}; ${cookieAttrs({ maxAge: sessionTtlMs / 1000, secure })}`,
          `fmux_oidc_state=; ${cookieAttrs({ maxAge: 0, secure })}`,
        ],
        'Cache-Control': 'no-store',
      });
      res.end();
    },

    logout(req, res) {
      const sid = parseCookies(req.headers.cookie).fmux_session;
      if (sid) sessions.delete(sid);
      const secure = isSecureRequest(req, publicUrl);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `fmux_session=; ${cookieAttrs({ maxAge: 0, secure })}`,
      });
      res.end(JSON.stringify({ ok: true }));
    },
  };
}
