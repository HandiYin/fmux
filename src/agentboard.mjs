import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { log, sleep } from './util.mjs';

const VENDOR_DIR = path.join(ROOT, 'vendor', 'agentboard');

// Injected into Agentboard's proxied HTML so its root-relative /api/* calls resolve under
// /agentboard/api/* AND its visual palette blends with the Arknights PRTS tactical console.
const AGENTBOARD_INJECT = `
<script>
(() => {
  const PREFIX = '/agentboard';
  const rewrite = (u) => {
    if (typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') && !u.startsWith(PREFIX + '/')) return PREFIX + u;
    return u;
  };
  const origFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === 'string') return origFetch(rewrite(input), init);
    if (input instanceof Request) return origFetch(new Request(rewrite(input.url), input), init);
    return origFetch(input, init);
  };
})();
</script>
<style id="prts-agentboard-skin">
  :root, body, [data-theme="dark"], [data-theme="light"] {
    --bg: #0d0f13 !important;
    --bg2: #13161c !important;
    --panel: #171b22 !important;
    --card: #1a1f28 !important;
    --card-bg: #1a1f28 !important;
    --surface: #171b22 !important;
    --border: rgba(255, 255, 255, 0.1) !important;
    --line: rgba(255, 255, 255, 0.1) !important;
    --text: #f3f5f8 !important;
    --fg: #f3f5f8 !important;
    --muted: #788394 !important;
    --accent: #22bbff !important;
    --blue: #22bbff !important;
    --amber: #ffcf00 !important;
    --green: #1fd18b !important;
    --red: #ff4757 !important;
  }
  ::-webkit-scrollbar { width: 5px; height: 5px; }
  ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.14); }
  body {
    background: #0d0f13 !important;
    background-image:
      linear-gradient(rgba(255, 255, 255, 0.022) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, 0.022) 1px, transparent 1px) !important;
    background-size: 36px 36px !important;
    color: #f3f5f8 !important;
  }
  .col, .column, .card, .modal, .sheet, .drawer, header, .topbar, .bar {
    border-radius: 0 !important;
    border-color: rgba(255, 255, 255, 0.1) !important;
  }
  .card {
    background: #171b22 !important;
    box-shadow: inset 2px 0 0 rgba(34, 187, 255, 0.45) !important;
  }
  .card:hover {
    border-color: #f4f6f8 !important;
  }
  button, .btn {
    border-radius: 0 !important;
  }
</style>`;

// Manages the embedded Primatix-Intelligence/agentboard Python server and proxies /agentboard/*
// behind fmux's Feishu OIDC / token gate.
export class AgentboardBridge {
  constructor({ enabled = false, dir = VENDOR_DIR, port = 8789, url = '', python = 'python3', autoStart = true } = {}) {
    this.enabled = enabled;
    this.dir = dir;
    this.port = port;
    this.externalUrl = url ? url.replace(/\/+$/, '') : '';
    this.python = python;
    this.autoStart = autoStart;
    this.child = null;
    this.starting = null;
  }

  get target() {
    if (this.externalUrl) {
      const u = new URL(this.externalUrl);
      return { host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) };
    }
    return { host: '127.0.0.1', port: this.port };
  }

  isAvailable() {
    return Boolean(this.externalUrl) || fs.existsSync(path.join(this.dir, 'server.py'));
  }

  async isHealthy() {
    const { host, port } = this.target;
    return new Promise((resolve) => {
      const req = http.get({ host, port, path: '/api/state', timeout: 1200 }, (res) => {
        res.resume();
        resolve(res.statusCode < 500);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  async ensureStarted() {
    if (!this.enabled) return false;
    if (this.externalUrl) return this.isHealthy();
    if (await this.isHealthy()) return true;
    if (!this.autoStart || !this.isAvailable()) return false;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      const dataDir = path.join(this.dir, 'data');
      const cfgFile = path.join(dataDir, 'config.json');
      fs.mkdirSync(dataDir, { recursive: true });
      let current = {};
      try {
        if (fs.existsSync(cfgFile)) current = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      } catch {
        current = {};
      }
      if (current.host !== '127.0.0.1' || current.port !== this.port) {
        fs.writeFileSync(cfgFile, JSON.stringify({ ...current, host: '127.0.0.1', port: this.port }, null, 2));
      }

      const child = spawn(this.python, [path.join(this.dir, 'server.py')], {
        cwd: this.dir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => log('info', 'agentboard.stdout', { text: chunk.trim().slice(0, 200) }));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => log('warn', 'agentboard.stderr', { text: chunk.trim().slice(0, 200) }));
      child.on('exit', (code, signal) => {
        if (this.child === child) this.child = null;
        log('info', 'agentboard.exit', { code, signal });
      });

      for (let i = 0; i < 20; i++) {
        if (await this.isHealthy()) {
          log('info', 'agentboard.ready', { port: this.port, pid: child.pid });
          return true;
        }
        if (!this.child) return false;
        await sleep(250);
      }
      return false;
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async proxy(req, res, subpath) {
    if (!this.enabled) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'agentboard integration is disabled in config.web.agentboard.enabled' }));
      return;
    }
    const ok = await this.ensureStarted();
    if (!ok) {
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><meta charset="utf-8"><body style="background:#0b0d10;color:#eef3f8;font-family:monospace;padding:32px"><h3 style="color:#facc15">PRTS // AGENTBOARD OFFLINE</h3><p>Embedded Agentboard process could not start. Check Python 3 and logs.</p></body>');
      return;
    }

    const { host, port } = this.target;
    const isRootHtml = req.method === 'GET' && (subpath === '/' || subpath === '' || subpath.startsWith('/?'));
    const upstreamPath = subpath || '/';
    const headers = { ...req.headers, host: `${host}:${port}` };
    if (isRootHtml) delete headers['accept-encoding']; // receive uncompressed HTML for injection
    delete headers.cookie; // never leak fmux OIDC cookies to upstream

    const proxyReq = http.request({ host, port, method: req.method, path: upstreamPath, headers }, (proxyRes) => {
      const contentType = String(proxyRes.headers['content-type'] || '');
      if (isRootHtml && contentType.includes('text/html')) {
        const chunks = [];
        proxyRes.on('data', (c) => chunks.push(c));
        proxyRes.on('end', () => {
          let html = Buffer.concat(chunks).toString('utf8');
          html = html
            .replace(/href="\/(manifest\.webmanifest|icon-[^"]+)"/g, 'href="/agentboard/$1"')
            .replace(/<head([^>]*)>/i, `<head$1>${AGENTBOARD_INJECT}`);
          const outHeaders = { ...proxyRes.headers, 'cache-control': 'no-store' };
          delete outHeaders['content-length'];
          delete outHeaders['content-encoding'];
          res.writeHead(proxyRes.statusCode || 200, outHeaders);
          res.end(html);
        });
        return;
      }
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `agentboard upstream error: ${err.message}` }));
      }
    });
    req.pipe(proxyReq);
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (child) child.kill('SIGTERM');
  }
}
