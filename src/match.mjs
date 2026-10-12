// Loose name matching, for sessions and past conversations named from a phone or by an agent.

const squash = (s) => String(s ?? '').toLowerCase().replace(/[\s_\-./:]+/g, '');

function isSubsequence(needle, hay) {
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i++;
  return i === needle.length;
}

// How well one word names a text: exact 100, prefix 80, inside 60, letters in order 30, no match 0.
export function scoreWord(word, text) {
  const w = squash(word);
  const t = squash(text);
  if (!w || !t) return 0;
  if (t === w) return 100;
  if (t.startsWith(w)) return 80;
  if (t.includes(w)) return 60;
  return w.length >= 3 && isSubsequence(w, t) ? 30 : 0;
}

// `fields(item)` returns [text, weight] pairs. Every word of the query must match some field.
function scoreItem(query, item, fields) {
  const words = String(query).trim().split(/\s+/).filter(Boolean);
  const whole = Math.max(0, ...fields(item).map(([text, weight]) => scoreWord(query, text) * weight));
  let byWord = 0;
  for (const word of words) {
    const best = Math.max(0, ...fields(item).map(([text, weight]) => scoreWord(word, text) * weight));
    if (best === 0) {
      byWord = 0;
      break;
    }
    byWord += best / words.length;
  }
  return Math.max(whole, byWord);
}

// The single best item, or the tied candidates when the query does not decide.
export function pick(query, items, fields) {
  const scored = items
    .map((item) => ({ item, score: scoreItem(query, item, fields) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { match: null, candidates: [] };
  const tied = scored.filter((x) => x.score === scored[0].score);
  return tied.length === 1 ? { match: tied[0].item, candidates: [] } : { match: null, candidates: tied.map((x) => x.item) };
}
