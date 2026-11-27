import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from './util.mjs';

// Agentboard-style semantic highlighter backed by DeepSeek API (fast model) with instant
// local fallback and zero content hashing.

const HL_MARKS = `"marks": a list of {"q": "...", "k": "..."} highlighting the message so a busy reader can get its important points from the highlights alone.
q: words copied character for character from the message, in its own language, without ** or \` marks. Only the key words of the point: at most 12 words, or 25 characters in Chinese. Never a whole sentence if part of it says enough.
k is one of:
- "result": a conclusion, or what was found, done or fixed
- "problem": a failure, risk, limit, warning, consequence, or something not verified or not done
- "action": something the reader (not the writer) must decide, answer or do
- "fact": a value the reader may need later: a key number, name, version, date, file path, URL or command
Mark every problem and every action, even small ones. Mark the main results. Aim for about one mark per two sentences across the whole message so highlights cover ~25% of it. Do not change any words.`;

const HL_TLDR = `"tldr": the message's bottom line in at most 3 short "- " lines, in the message's own language: what happened or the answer, the main problem if there is one, and what the reader must do if anything. Use only what the message says. Copy numbers and names exactly. No heading, no preamble.`;

const NEGATED_PROBLEM_RE = /(?:没有|无|未|零|\b0\s*个?|\bno\b|\bzero\b|\bwithout\b)\s*(?:发现|出现|任何)?\s*(?:报错|失败|异常|错误|风险|问题|errors?|failed|failures?|bugs?|warnings?)/gi;
const PROBLEM_RE = /\b(error|failed|failure|bug|broken|warning|timeout|denied|missing|crash|exception|blocked|invalid|conflict)\b|报错|失败|异常|错误|阻塞|风险|遗留|缺失|无法|冲突|误报|拦截|拒绝/i;
const ACTION_RE = /\b(please|confirm|choose|restart|next step|todo|should we|would you|run |configure|enable)\b|请确认|下一步|需要你|是否|要不要|建议你|重启|你可以|告诉我|？|\?$/i;
const RESULT_RE = /\b(passed|fixed|completed|created|added|removed|updated|done|resolved|verified|committed|ready|success)\b|已完成|已修复|全部通过|通过|成功|已提交|已创建|已清理|已接入|生效|完成/i;
const FACT_RE = /\b\d+(?:\.\d+)?\s*(?:%|ms|s|kb|mb|gb|passed|failed|lines?|files?|ports?)\b|:\d{4,5}\b|\b[0-9a-f]{7,10}\b|`[^`]{2,40}`|\d+\s*(?:个|行|处|项|秒|分钟|字节)/i;

function plainText(s) {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanMarks(marks, text) {
  const plain = plainText(text);
  const limit = Math.max(0.35, Math.min(0.6, 120 / Math.max(1, plain.length)));
  const keep = [];
  const seen = new Set();
  for (const m of Array.isArray(marks) ? marks : []) {
    if (!m || typeof m !== 'object') continue;
    const q = plainText(m.q || '');
    const k = m.k;
    if (!q || seen.has(q) || !plain.includes(q) || !['result', 'problem', 'action', 'fact'].includes(k)) continue;
    seen.add(q);
    keep.push({ q, k });
  }
  for (const kind of ['fact', 'result']) {
    while (keep.reduce((sum, x) => sum + x.q.length, 0) > limit * plain.length && keep.some((x) => x.k === kind)) {
      let longestIdx = -1;
      for (let i = 0; i < keep.length; i++) {
        if (keep[i].k === kind && (longestIdx < 0 || keep[i].q.length > keep[longestIdx].q.length)) longestIdx = i;
      }
      if (longestIdx >= 0) keep.splice(longestIdx, 1);
    }
  }
  return keep;
}

export function cleanTldr(tldr, text) {
  if (typeof tldr !== 'string') return '';
  const trimmed = tldr.trim();
  if (!trimmed) return '';
  const nums = (s) => new Set(String(s).match(/\d+(?:\.\d+)?/g) || []);
  const srcNums = nums(text);
  for (const n of nums(trimmed)) if (!srcNums.has(n)) return '';
  return trimmed.slice(0, 800);
}

// Fast local heuristic fallback when no DeepSeek API key is configured or the API is unreachable.
export function heuristicHighlights(text, { marksOnly = false } = {}) {
  const raw = String(text || '');
  if (raw.trim().length < 40) return { marks: [], tldr: '', source: 'heuristic' };
  const prose = raw.replace(/```[\s\S]*?```/g, '\n').replace(/\$\$[\s\S]*?\$\$/g, ' ').replace(/\\\[[\s\S]*?\\\]/g, ' ');
  const clauses = [];
  for (const rawLine of prose.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    for (const part of line.split(/(?<=[。！？!?]|\.(?=\s|$))/)) {
      const q = part.replace(/^\s*(?:[-*•+]|\d+[.)]|#{1,4}|>)\s+/, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*`~]/g, '').replace(/\s+/g, ' ').trim();
      if (q.length >= 10 && q.length <= 140) clauses.push(q);
    }
  }
  const scored = [];
  for (let i = 0; i < clauses.length; i++) {
    const q = clauses[i];
    const withoutNeg = q.replace(NEGATED_PROBLEM_RE, '');
    const candidates = [
      ['problem', PROBLEM_RE.test(withoutNeg) ? 4 : 0],
      ['action', ACTION_RE.test(q) ? 3.5 : 0],
      ['result', RESULT_RE.test(q) ? 3 : 0],
      ['fact', FACT_RE.test(q) ? 2.2 : 0],
    ].sort((a, b) => b[1] - a[1]);
    if (candidates[0][1] > 0) scored.push({ q, k: candidates[0][0], score: candidates[0][1], idx: i });
  }
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const picked = [];
  for (const item of scored) {
    if (picked.length >= 6) break;
    if (picked.some((p) => p.q.includes(item.q) || item.q.includes(p.q))) continue;
    picked.push(item);
  }
  picked.sort((a, b) => a.idx - b.idx);
  const tldr = !marksOnly && raw.length >= 260 && picked.length
    ? picked.slice(0, 3).map((x) => `- ${x.q}`).join('\n')
    : '';
  return { marks: picked.map(({ q, k }) => ({ q, k })), tldr, source: 'heuristic' };
}

// Resolve DeepSeek API key from config, env, or ~/.dsh/.credentials.yaml (never logged).
export function resolveDeepSeekKey(cfgKey = '', home = os.homedir()) {
  if (cfgKey && String(cfgKey).trim()) return String(cfgKey).trim();
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  try {
    const raw = fs.readFileSync(path.join(home, '.dsh', '.credentials.yaml'), 'utf8');
    const m = raw.match(/^\s*DEEPSEEK_API_KEY:\s*['"]?([^'"\s#]+)['"]?/m);
    if (m?.[1]) return m[1].trim();
  } catch {
    // no dsh credentials file
  }
  return '';
}

function cacheKeyOf(text, marksOnly) {
  return `${marksOnly ? 'm' : 'f'}:${text.length}:${text.slice(0, 120)}:${text.slice(-80)}`;
}

// Creates a DeepSeek API highlighter with disk-backed cache, concurrency cap, and graceful fallback.
export function createHighlighter({
  stateDir = '',
  baseUrl = 'https://api.deepseek.com/v1',
  model = 'deepseek-chat',
  apiKey = '',
  enabled = true,
  fetchImpl = globalThis.fetch,
} = {}) {
  const file = stateDir ? path.join(stateDir, 'highlights.json') : '';
  const cache = new Map();
  const inflight = new Map(); // key -> Promise or cooldown timestamp
  let active = 0;

  if (file && fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(saved || {})) cache.set(k, v);
    } catch {
      // ignore damaged cache
    }
  }

  function persist() {
    if (!file) return;
    try {
      while (cache.size > 400) cache.delete(cache.keys().next().value);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(cache)), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      // non-fatal
    }
  }

  async function callDeepSeek(text, marksOnly, keyVal) {
    const isLong = text.length >= 260 && !marksOnly;
    const prompt = `Reply with JSON only: ${isLong ? `{"tldr": "...", "marks": [...]}\n${HL_TLDR}` : '{"marks": [...]}\n'}${HL_MARKS}\n\nMESSAGE:\n${text.slice(0, 12000)}`;
    const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
    const tryModels = model === 'deepseek-flash' ? ['deepseek-flash', 'deepseek-chat'] : [model];
    let lastErr;
    for (const m of tryModels) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keyVal}` },
        body: JSON.stringify({
          model: m,
          temperature: 0.1,
          max_tokens: 900,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'You extract verbatim highlight quotes and concise TL;DR summaries in strict JSON.' },
            { role: 'user', content: prompt },
          ],
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const raw = data.choices?.[0]?.message?.content || '';
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('DeepSeek returned non-JSON highlight payload');
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          marks: cleanMarks(parsed.marks, text),
          tldr: isLong ? cleanTldr(parsed.tldr, text) : '',
          source: `deepseek:${m}`,
        };
      }
      lastErr = new Error(`DeepSeek HTTP ${res.status}`);
      if (res.status !== 400 && res.status !== 404) break;
    }
    throw lastErr;
  }

  return {
    request(text, { marksOnly = false } = {}) {
      const raw = String(text || '');
      if (raw.trim().length < 40) return { marks: [], tldr: '', source: 'short' };
      const key = cacheKeyOf(raw, marksOnly);
      if (cache.has(key)) return cache.get(key);

      const resolvedKey = enabled ? resolveDeepSeekKey(apiKey) : '';
      if (!resolvedKey) {
        const fallback = heuristicHighlights(raw, { marksOnly });
        cache.set(key, fallback);
        return fallback;
      }

      const busy = inflight.get(key);
      if (busy === 'running') return { pending: true, source: 'deepseek' };
      if (typeof busy === 'number' && busy > Date.now()) {
        return heuristicHighlights(raw, { marksOnly });
      }
      if (active >= 2) return { pending: true, source: 'deepseek' };

      inflight.set(key, 'running');
      active++;
      callDeepSeek(raw, marksOnly, resolvedKey)
        .then((res) => {
          cache.set(key, res);
          inflight.delete(key);
          persist();
        })
        .catch((err) => {
          log('warn', 'highlight.deepseek', { message: err.message });
          inflight.set(key, Date.now() + 60000);
        })
        .finally(() => {
          active--;
        });
      return { pending: true, source: 'deepseek' };
    },
  };
}
