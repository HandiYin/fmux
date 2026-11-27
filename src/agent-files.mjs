import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJsonLines, readFirstJsonLine } from './jsonl.mjs';

const HOME = os.homedir();
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// ---- Claude Code session files (~/.claude/sessions/<pid>.json) ----

export function readClaudeMeta(pid, home = HOME) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, '.claude', 'sessions', `${pid}.json`), 'utf8'));
  } catch {
    return null;
  }
}

// Session ids that a running Claude Code process currently has open.
export function listOpenClaudeSessionIds(isAlive, home = HOME) {
  const open = new Set();
  const dir = path.join(home, '.claude', 'sessions');
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const pid = name.slice(0, -5);
      if (!isAlive(pid)) continue;
      const meta = readClaudeMeta(pid, home);
      if (meta?.sessionId) open.add(meta.sessionId);
    }
  } catch {
    // Claude Code has not created a sessions directory yet
  }
  return open;
}

// ---- Codex session index & rollout files (~/.codex) ----

export function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(HOME, '.codex');
}

// Parse session_index.jsonl, keeping the latest entry per thread UUID.
export function readCodexIndex(root = defaultCodexHome()) {
  const file = path.join(root, 'session_index.jsonl');
  const entries = new Map();
  for (const row of parseJsonLines(fs.readFileSync(file, 'utf8'))) {
    if (UUID_RE.test(row.id)) entries.set(row.id, row);
  }
  return entries;
}

// Recursively scan <root>/sessions for rollout-*.jsonl files, returning Map<uuid, fullPath>.
export function scanCodexRollouts(root = defaultCodexHome()) {
  const byId = new Map();
  const dir = path.join(root, 'sessions');
  try {
    for (const rel of fs.readdirSync(dir, { recursive: true })) {
      const name = path.basename(rel);
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const id = name.slice(-42, -6);
      if (UUID_RE.test(id)) byId.set(id, path.join(dir, rel));
    }
  } catch {
    // sessions directory does not exist
  }
  return byId;
}

// First-line session_meta payload of a Codex rollout file.
export function readCodexSessionMeta(file) {
  const first = readFirstJsonLine(file);
  return first?.type === 'session_meta' ? first.payload : null;
}

// ---- Antigravity CLI (agy) files (~/.gemini/antigravity-cli) ----

export function defaultAgyHome() {
  return process.env.AGY_HOME || path.join(HOME, '.gemini', 'antigravity-cli');
}

export function agyTranscriptPath(conversationId, root = defaultAgyHome()) {
  if (!UUID_RE.test(conversationId || '')) return null;
  const logsDir = path.join(root, 'brain', conversationId, '.system_generated', 'logs');
  const full = path.join(logsDir, 'transcript_full.jsonl');
  if (fs.existsSync(full)) return full;
  const compact = path.join(logsDir, 'transcript.jsonl');
  return fs.existsSync(compact) ? compact : null;
}

export function readAgyHistory(root = defaultAgyHome()) {
  const file = path.join(root, 'history.jsonl');
  try {
    return parseJsonLines(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

