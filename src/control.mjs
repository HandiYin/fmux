import fs from 'node:fs';
import net from 'node:net';
import { log } from './util.mjs';

// Local control socket for robinctl. One JSON request line in, one JSON reply line out.
export function startControl({ socket, methods }) {
  try {
    fs.unlinkSync(socket);
  } catch {
    // no stale socket
  }
  const server = net.createServer((conn) => {
    let buffer = '';
    conn.setEncoding('utf8');
    conn.on('data', async (chunk) => {
      buffer += chunk;
      const cut = buffer.indexOf('\n');
      if (cut < 0) return;
      const line = buffer.slice(0, cut);
      buffer = '';
      let reply;
      try {
        const { method, params = {} } = JSON.parse(line);
        const fn = methods[method];
        if (!fn) throw new Error(`unknown method: ${method}`);
        reply = { ok: true, result: await fn(params) };
      } catch (err) {
        reply = { ok: false, error: err.message };
      }
      conn.end(JSON.stringify(reply) + '\n');
    });
    conn.on('error', () => {});
  });
  server.listen(socket, () => {
    fs.chmodSync(socket, 0o600);
    log('info', 'control.listening', { socket });
  });
  return server;
}

export function callControl(socket, method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socket);
    let buffer = '';
    const timer = setTimeout(() => conn.destroy(new Error('timed out waiting for robin-hub')), timeoutMs);
    conn.setEncoding('utf8');
    conn.on('connect', () => conn.write(JSON.stringify({ method, params }) + '\n'));
    conn.on('data', (chunk) => { buffer += chunk; });
    conn.on('end', () => {
      clearTimeout(timer);
      try {
        const reply = JSON.parse(buffer);
        if (reply.ok) resolve(reply.result);
        else reject(new Error(reply.error));
      } catch {
        reject(new Error('bad reply from robin-hub'));
      }
    });
    conn.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' || err.code === 'ECONNREFUSED' ? new Error('robin-hub is not running') : err);
    });
  });
}
