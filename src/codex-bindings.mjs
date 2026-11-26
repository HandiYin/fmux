import fs from 'node:fs';
import path from 'node:path';
import { Tail, adapters, lastExchange } from './transcript.mjs';
import { log } from './util.mjs';

// A stale/zero offset must never make a restart allocate and parse a multi-hundred-MB rollout.
const MAX_RESTORE_REPLAY = 8 * 1024 * 1024;
const CHECKPOINT_INTERVAL_MS = 10000;

// Persists the last confirmed Codex rollout and byte offset per pane so a hub restart
// during a turn resumes the same rollout even while the pane title has only a spinner and cwd.
export class CodexBindingStore {
  constructor(store = null) {
    this.store = store;
    this.bindings = new Map(Object.entries(store?.get('transcripts') || {}));
  }

  remember(session) {
    if (session.kind !== 'codex' || !this.store || !session.transcript) return;
    const entry = {
      agentPid: session.agentPid,
      tmuxSession: session.tmuxSession,
      cwd: session.cwd,
      file: session.transcript,
      offset: session.tail?.offset || 0,
      at: Date.now(),
    };
    const prior = this.bindings.get(session.key);
    if (prior && prior.agentPid === entry.agentPid && prior.tmuxSession === entry.tmuxSession
      && prior.cwd === entry.cwd && prior.file === entry.file && prior.offset === entry.offset) return;
    this.bindings.set(session.key, entry);
    this.store.set('transcripts', Object.fromEntries(this.bindings));
  }

  // Output arrives in batches; writing every poll would rewrite state.json every 2 s.
  checkpoint(session) {
    if (session.kind !== 'codex' || !this.store || !session.transcript || !session.tail) return;
    const now = Date.now();
    if (now - (session.transcriptSavedAt || 0) < CHECKPOINT_INTERVAL_MS) return;
    session.transcriptSavedAt = now;
    this.remember(session);
  }

  forget(session) {
    if (!this.bindings.delete(session.key)) return;
    this.store?.set('transcripts', Object.fromEntries(this.bindings));
  }

  restore(session, kind) {
    if (kind !== 'codex' || !session.agentPid || session.transcript) return false;
    const saved = this.bindings.get(session.key);
    if (!saved) return false;
    if (saved.agentPid !== session.agentPid || saved.tmuxSession !== session.tmuxSession || saved.cwd !== session.cwd
      || !saved.file || !fs.existsSync(saved.file)) {
      this.forget(session);
      return false;
    }
    const offset = Number.isFinite(saved.offset) && saved.offset >= 0 ? saved.offset : 0;
    let size;
    try {
      size = fs.statSync(saved.file).size;
    } catch {
      this.forget(session);
      return false;
    }
    // Keep a restart bounded even if the offset was never checkpointed (or state is old).
    let start = offset;
    if (start > size || size - start > MAX_RESTORE_REPLAY) start = Math.max(0, size - MAX_RESTORE_REPLAY);
    if (start !== offset) log('warn', 'transcript.restore_clamped', { session: session.name, offset, size, start });
    session.transcript = saved.file;
    session.tail = new Tail(saved.file, adapters[kind], { offset: start });
    session.transcriptSavedAt = Date.now();
    session.bindingLostAt = 0;
    if (start >= size) {
      try {
        const last = lastExchange(saved.file, adapters[kind]);
        session.lastText = last.text || '';
        session.lastPrompt = last.prompt || '';
      } catch {
        // the tail will report the file gone on its next read
      }
    }
    log('info', 'transcript.restored', { session: session.name, title: session.paneTitle, file: path.basename(saved.file), offset: start });
    return true;
  }
}
