import fs from 'node:fs';
import { adapters, lastTurns } from '../transcript.mjs';
import { log } from '../util.mjs';

const normPrompt = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function safeFileSize(file) {
  if (!file) return 0;
  try { return fs.statSync(file).size; } catch { return 0; }
}

function readUserSegmentsSince(file, kind, minOffset) {
  const adapter = adapters[kind];
  if (!file || !adapter) return [];
  if (file.endsWith('.zstd')) {
    try {
      const turns = lastTurns(file, adapter, 512 * 1024);
      return turns.map((t, idx) => ({ endOffset: idx + 1, normText: normPrompt(t.prompt || '') })).filter((s) => s.normText);
    } catch {
      return [];
    }
  }
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    if (size <= minOffset) return [];
    const start = Math.max(0, minOffset);
    const len = Math.min(size - start, 1024 * 1024);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    const bytesRead = fs.readSync(fd, buf, 0, len, start);
    if (bytesRead <= 0) return [];
    const slice = buf.subarray(0, bytesRead);
    const segs = [];
    let pos = 0;
    while (pos < slice.length) {
      const nl = slice.indexOf(10, pos);
      if (nl < 0) break; // ignore incomplete trailing line
      const lineStr = slice.subarray(pos, nl).toString('utf8');
      const endOffset = start + nl + 1;
      pos = nl + 1;
      if (!lineStr.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(lineStr); } catch { continue; }
      const evs = adapter(parsed) || [];
      for (const ev of evs) {
        if (ev.type === 'user' && ev.text) {
          segs.push({ endOffset, normText: normPrompt(ev.text) });
        }
      }
    }
    return segs;
  } catch {
    return [];
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
  }
}

function currentTranscriptMarker(session) {
  if (!session?.transcript) return 0;
  if (session.transcript.endsWith('.zstd') && adapters[session.kind]) {
    try { return lastTurns(session.transcript, adapters[session.kind], 512 * 1024).length; } catch { return 0; }
  }
  return safeFileSize(session.transcript);
}

// Per-session FIFO candidate message queue: holds prompts while a session is busy/blocked,
// auto-dispatches on turn completion, pauses on manual STOP, and reconciles injected prompts
// against newly appended transcript bytes (or zstd turn count) with zero full-file hashing.
export class SessionQueueManager {
  constructor({ router, broadcast }) {
    this.router = router;
    this.broadcast = broadcast;
    this.queues = new Map(); // session.key -> { items: [], paused: false, flushing: false, nextSeq: 1 }
  }

  get(key) {
    let q = this.queues.get(key);
    if (!q) {
      q = { items: [], paused: false, flushing: false, nextSeq: 1 };
      this.queues.set(key, q);
    }
    return q;
  }

  delete(key) {
    this.queues.delete(key);
  }

  pauseIfQueued(key) {
    const q = this.queues.get(key);
    if (q?.items.some((x) => x.state === 'queued')) q.paused = true;
  }

  isPaused(session) {
    if (!session) return false;
    const q = this.queues.get(session.key);
    return Boolean(q?.paused && q.items.some((x) => x.state === 'queued'));
  }

  reconcile(session) {
    if (!session) return false;
    const q = this.queues.get(session.key);
    if (!q || !q.items.length) return false;
    const injected = q.items.filter((x) => x.state === 'injected');
    if (!injected.length) return false;

    const removeIds = new Set();
    const now = Date.now();
    if (session.kind === 'shell' || !session.transcript || !adapters[session.kind]) {
      for (const item of injected) {
        if (now - (item.injectedAt || item.createdAt) >= 1200) removeIds.add(item.id);
      }
    } else {
      const curSize = currentTranscriptMarker(session);
      for (const item of injected) {
        if (curSize < (item.baseSize || 0)) item.baseSize = 0;
      }
      const minBase = Math.min(...injected.map((x) => x.baseSize || 0));
      const segs = readUserSegmentsSince(session.transcript, session.kind, minBase);
      if (segs.length) {
        const segCursor = new Map();
        for (const item of injected) {
          const needle = normPrompt(item.text).slice(0, 80);
          if (!needle) { removeIds.add(item.id); continue; }
          for (let si = 0; si < segs.length; si++) {
            const seg = segs[si];
            if (seg.endOffset <= (item.baseSize || 0)) continue;
            const fromIdx = segCursor.get(si) || 0;
            const hit = seg.normText.indexOf(needle, fromIdx);
            if (hit >= 0) {
              segCursor.set(si, hit + needle.length);
              removeIds.add(item.id);
              break;
            }
          }
        }
      }
    }

    if (!removeIds.size) return false;
    q.items = q.items.filter((x) => !removeIds.has(x.id));
    if (!q.items.some((x) => x.state === 'queued')) q.paused = false;
    return true;
  }

  serialize(session) {
    if (!session) return [];
    this.reconcile(session);
    const q = this.queues.get(session.key);
    if (!q || !q.items.length) return [];
    return q.items.map((x, idx) => ({
      id: x.id,
      rank: idx + 1,
      text: x.text,
      state: x.state,
      createdAt: x.createdAt,
      injectedAt: x.injectedAt || 0,
    }));
  }

  async inject(session, item) {
    const baseSize = currentTranscriptMarker(session);
    session.stoppedAt = 0;
    const sent = await this.router.deliver(session, item.text);
    if (!sent) return false;
    item.state = 'injected';
    item.injectedAt = Date.now();
    item.baseSize = baseSize;
    if (session.kind !== 'shell') {
      session.sentAt = Date.now();
      this.router.registry.commit?.(session, 'working');
    }
    setTimeout(() => this.router.registry.poll().then(() => this.broadcast()).catch(() => {}), 800);
    setTimeout(() => this.router.registry.poll().then(() => this.broadcast()).catch(() => {}), 2200);
    return true;
  }

  async maybeFlush(session) {
    if (!session) return;
    this.reconcile(session);
    const q = this.queues.get(session.key);
    if (!q || !q.items.length || q.paused || q.flushing) return;
    if (session.status === 'working' || session.status === 'blocked') return;
    if (session.kind !== 'shell' && q.items.some((x) => x.state === 'injected' && Date.now() - x.injectedAt < 4000)) return;
    const head = q.items.find((x) => x.state === 'queued');
    if (!head) return;
    q.flushing = true;
    try {
      const ok = await this.inject(session, head);
      if (ok) this.broadcast();
    } catch (err) {
      log('warn', 'web.queue_flush', { session: session.name, message: err.message });
    } finally {
      q.flushing = false;
    }
  }

  async enqueueOrSend(session, text, { immediate = false } = {}) {
    this.reconcile(session);
    const q = this.get(session.key);
    q.paused = false;
    const item = {
      id: `q-${Date.now().toString(36)}-${q.nextSeq++}`,
      text,
      state: 'queued',
      createdAt: Date.now(),
      injectedAt: 0,
      baseSize: 0,
    };
    const hasQueuedAhead = q.items.some((x) => x.state === 'queued')
      || (session.kind !== 'shell' && q.items.some((x) => x.state === 'injected' && Date.now() - x.injectedAt < 2500));
    const busyOrBlocked = session.status === 'working' || session.status === 'blocked';

    if (!immediate && (busyOrBlocked || hasQueuedAhead)) {
      q.items.push(item);
      this.broadcast();
      const pendingQueue = this.serialize(session);
      return { ok: true, queued: true, injected: false, item: pendingQueue.find((x) => x.id === item.id) || item, pendingQueue, queuePaused: false };
    }

    q.items.push(item);
    const sent = await this.inject(session, item);
    this.broadcast();
    const pendingQueue = this.serialize(session);
    return {
      ok: true,
      queued: !sent,
      injected: sent,
      blocked: !sent && session.status === 'blocked',
      item: pendingQueue.find((x) => x.id === item.id) || item,
      pendingQueue,
      queuePaused: false,
    };
  }

  async applyAction(session, { action, id = '', dir = 'down', all = false }) {
    const q = this.get(session.key);
    this.reconcile(session);

    if (action === 'remove') {
      const idx = q.items.findIndex((x) => x.id === id);
      const removed = idx >= 0 ? q.items.splice(idx, 1)[0] : null;
      if (!q.items.some((x) => x.state === 'queued')) q.paused = false;
      this.broadcast();
      return { status: 200, body: { ok: true, removed, pendingQueue: this.serialize(session), queuePaused: this.isPaused(session) } };
    }
    if (action === 'move') {
      const step = dir === 'up' ? -1 : 1;
      const idx = q.items.findIndex((x) => x.id === id && x.state === 'queued');
      if (idx >= 0) {
        let swapIdx = idx + step;
        while (swapIdx >= 0 && swapIdx < q.items.length && q.items[swapIdx].state !== 'queued') swapIdx += step;
        if (swapIdx >= 0 && swapIdx < q.items.length) {
          const tmp = q.items[idx];
          q.items[idx] = q.items[swapIdx];
          q.items[swapIdx] = tmp;
        }
      }
      this.broadcast();
      return { status: 200, body: { ok: true, pendingQueue: this.serialize(session), queuePaused: this.isPaused(session) } };
    }
    if (action === 'flush') {
      if (session.status === 'blocked') {
        return { status: 409, body: { error: '当前会话正在等待终端确认，请先响应确认框后再注入' } };
      }
      q.paused = false;
      const target = id
        ? q.items.find((x) => x.id === id && x.state === 'queued')
        : q.items.find((x) => x.state === 'queued');
      if (target) await this.inject(session, target);
      this.broadcast();
      return { status: 200, body: { ok: true, pendingQueue: this.serialize(session), queuePaused: this.isPaused(session) } };
    }
    if (action === 'resume') {
      q.paused = false;
      await this.maybeFlush(session);
      this.broadcast();
      return { status: 200, body: { ok: true, pendingQueue: this.serialize(session), queuePaused: false } };
    }
    if (action === 'clear') {
      q.items = all ? [] : q.items.filter((x) => x.state !== 'queued');
      q.paused = false;
      this.broadcast();
      return { status: 200, body: { ok: true, pendingQueue: this.serialize(session), queuePaused: false } };
    }
    return { status: 400, body: { error: `unknown queue action: ${action}` } };
  }
}
