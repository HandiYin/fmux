// Zero-hash, zero-latency semantic highlighter inspired by Agentboard's 4-category marking:
//   result  (✓) — outcomes, completions, passed tests, decisions
//   problem (!) — errors, bugs, failures, warnings, blockers
//   action  (→) — questions, next steps, confirmations needed from operator
//   fact    (#) — metrics, counts, paths, versions, key technical facts

const MAX_CACHE = 300;
const cache = new Map();

const NEGATED_PROBLEM_RE = /(?:没有|无|未|零|\b0\s*个?|\bno\b|\bzero\b|\bwithout\b)\s*(?:发现|出现|任何)?\s*(?:报错|失败|异常|错误|风险|问题|errors?|failed|failures?|bugs?|warnings?)/gi;
const PROBLEM_RE = /\b(error|failed|failure|bug|broken|warning|timeout|denied|missing|crash|exception|blocked|invalid|conflict)\b|报错|失败|异常|错误|阻塞|风险|遗留|缺失|无法|冲突|误报|拦截|拒绝/i;
const ACTION_RE = /\b(please|confirm|choose|restart|next step|todo|should we|would you|run |configure|enable)\b|请确认|下一步|需要你|是否|要不要|建议你|重启|你可以|告诉我|？|\?$/i;
const RESULT_RE = /\b(passed|fixed|completed|created|added|removed|updated|done|resolved|verified|committed|ready|success)\b|已完成|已修复|全部通过|通过|成功|已提交|已创建|已清理|已接入|生效|完成/i;
const FACT_RE = /\b\d+(?:\.\d+)?\s*(?:%|ms|s|kb|mb|gb|passed|failed|lines?|files?|ports?)\b|:\d{4,5}\b|\b[0-9a-f]{7,10}\b|`[^`]{2,40}`|\d+\s*(?:个|行|处|项|秒|分钟|字节)/i;

function stripForAnalysis(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\\\[[\s\S]*?\\\]/g, ' ');
}

function cleanQuote(s) {
  return s
    .replace(/^\s*(?:[-*•+]|\d+[.)]|#{1,4}|>)\s+/, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyClause(clause) {
  const withoutNegated = clause.replace(NEGATED_PROBLEM_RE, '');
  const scores = {
    problem: PROBLEM_RE.test(withoutNegated) ? 4 : 0,
    action: ACTION_RE.test(clause) ? 3.5 : 0,
    result: RESULT_RE.test(clause) ? 3 : 0,
    fact: FACT_RE.test(clause) ? 2.2 : 0,
  };
  let bestKind = null;
  let bestScore = 0;
  for (const [k, v] of Object.entries(scores)) {
    if (v > bestScore) {
      bestKind = k;
      bestScore = v;
    }
  }
  return bestKind ? { kind: bestKind, score: bestScore } : null;
}

function splitClauses(prose) {
  const out = [];
  for (const rawLine of prose.split('\n')) {
    const line = rawLine.trim();
    if (!line || /^#{1,4}\s/.test(line) && line.length < 10) continue;
    const parts = line.split(/(?<=[。！？!?]|\.(?=\s|$))/);
    for (const part of parts) {
      const q = cleanQuote(part);
      if (q.length >= 10 && q.length <= 160) out.push(q);
      else if (q.length > 160) {
        // Split very long sentences on semicolons / Chinese commas for crisp, readable highlights.
        for (const sub of q.split(/[；;]+/)) {
          const t = sub.trim();
          if (t.length >= 10 && t.length <= 140) out.push(t);
        }
      }
    }
  }
  return out;
}

export function analyzeHighlights(text, { marksOnly = false } = {}) {
  const raw = String(text || '');
  if (raw.trim().length < 40) return { marks: [], tldr: '' };
  const cacheKey = `${marksOnly ? 'm' : 'f'}:${raw.length}:${raw.slice(0, 120)}:${raw.slice(-80)}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const prose = stripForAnalysis(raw);
  const clauses = splitClauses(prose);
  const scored = [];
  for (let i = 0; i < clauses.length; i++) {
    const q = clauses[i];
    const hit = classifyClause(q);
    if (!hit) continue;
    // Slight preference for concise, punchy statements near start or end.
    const posBonus = i === 0 || i === clauses.length - 1 ? 0.4 : 0;
    const lenBonus = q.length >= 16 && q.length <= 90 ? 0.3 : 0;
    scored.push({ q, k: hit.kind, score: hit.score + posBonus + lenBonus, idx: i });
  }

  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const picked = [];
  const seen = new Set();
  for (const item of scored) {
    if (picked.length >= 6) break;
    const norm = item.q.toLowerCase();
    if (seen.has(norm) || picked.some((p) => p.q.includes(item.q) || item.q.includes(p.q))) continue;
    seen.add(norm);
    picked.push(item);
  }
  picked.sort((a, b) => a.idx - b.idx);

  let tldr = '';
  if (!marksOnly && raw.length >= 260) {
    const summaryItems = picked.slice(0, 3);
    if (summaryItems.length) {
      tldr = summaryItems.map((x) => `- ${x.q}`).join('\n');
    } else if (clauses.length) {
      tldr = clauses.slice(0, 2).map((q) => `- ${q}`).join('\n');
    }
  }

  const result = { marks: picked.map(({ q, k }) => ({ q, k })), tldr };
  cache.set(cacheKey, result);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  return result;
}
