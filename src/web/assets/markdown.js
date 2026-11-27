// Full GFM Markdown (tables, task lists, nested lists, blockquotes, safe links),
// LaTeX math (KaTeX + offline fallback), and TreeWalker semantic highlighter.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- LaTeX Math Rendering (KaTeX + offline fallback) ----
const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ',
  phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ',
  Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  times: '×', cdot: '·', pm: '±', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
  approx: '≈', infty: '∞', to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒',
  sum: '∑', prod: '∏', int: '∫', partial: '∂', nabla: '∇', in: '∈', notin: '∉', subset: '⊂',
  forall: '∀', exists: '∃', sqrt: '√', ldots: '…', cdots: '⋯',
};
const MATH_BB = { E: '𝔼', R: 'ℝ', N: 'ℕ', Z: 'ℤ', P: 'ℙ', C: 'ℂ', Q: 'ℚ' };
const MATH_CAL = { L: 'ℒ', F: 'ℱ', H: 'ℋ', O: '𝒪', D: '𝒟', N: '𝒩', X: '𝒳', Y: '𝒴' };
function fallbackMath(tex) {
  let s = esc(tex.trim());
  s = s.replace(/\\left\s*/g, '').replace(/\\right\s*/g, '');
  s = s.replace(/\\\|/g, '‖').replace(/\\,/g, ' ').replace(/\\;/g, ' ').replace(/\\quad/g, '  ');
  s = s.replace(/\\mathbb\{([A-Za-z])\}/g, (_, c) => MATH_BB[c] || c);
  s = s.replace(/\\mathcal\{([A-Za-z])\}/g, (_, c) => MATH_CAL[c] || c);
  s = s.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '($1)/($2)');
  s = s.replace(/\\sqrt\{([^{}]+)\}/g, '√($1)');
  s = s.replace(/\\text\{([^{}]+)\}/g, '<span style="font-style:normal">$1</span>');
  s = s.replace(/\\([A-Za-z]+)/g, (_, cmd) => GREEK[cmd] || cmd);
  s = s.replace(/\^\{([^{}]+)\}/g, '<sup>$1</sup>').replace(/\^([A-Za-z0-9])/g, '<sup>$1</sup>');
  s = s.replace(/_\{([^{}]+)\}/g, '<sub>$1</sub>').replace(/_([A-Za-z0-9])/g, '<sub>$1</sub>');
  return `<span class="math-fallback">${s}</span>`;
}
function renderMathTex(tex, displayMode) {
  if (window.katex?.renderToString) {
    try { return window.katex.renderToString(tex.trim(), { displayMode, throwOnError: false, strict: false }); } catch {}
  }
  return fallbackMath(tex);
}
window.__onKatexReady = () => {
  document.querySelectorAll('[data-tex]').forEach((el) => {
    el.innerHTML = renderMathTex(el.dataset.tex, el.dataset.display === '1');
  });
};

// ---- Full GFM Markdown (Tables, Lists, Tasks, Links, Quotes) + Math Renderer ----
function safeUrl(u) {
  const s = String(u || '').trim();
  if (/^(https?:\/\/|mailto:|\/|#)/i.test(s)) return s;
  return '';
}

function splitTableRow(line) {
  let s = String(line || '').trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|' && !inCode) { cur += '|'; i++; continue; }
    if (c === '`') { inCode = !inCode; cur += c; continue; }
    if (c === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function isTableSep(line) {
  const t = String(line || '').trim();
  if (!t.includes('|') || !t.includes('-')) return false;
  const cells = splitTableRow(t);
  return cells.length >= 1 && cells.every((c) => /^:?-+:?$/.test(c));
}

function renderMarkdown(raw, depth = 0) {
  const src = String(raw || '').replace(/\r\n/g, '\n');
  const blocks = [];
  const stashBlock = (html) => { const id = blocks.length; blocks.push(html); return `\u0000BLOCK_${id}\u0000`; };

  // Fenced code blocks (``` or ~~~, including trailing unclosed fence during streaming)
  let text = src.replace(/(^|\n)[ \t]*(```|~~~)([a-zA-Z0-9_+-]*)[ \t]*\n([\s\S]*?)(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, (_, lead, _fence, lang, code) => {
    const id = blocks.length;
    return `${lead}${stashBlock(`<div class="code-frame"><div class="code-bar"><span>${esc((lang || 'TEXT').toUpperCase())}</span><button type="button" class="code-copy" data-copy="${id}">COPY</button></div><pre data-code="${id}">${esc(code.replace(/\n$/, ''))}</pre></div>`)}`;
  });
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) =>
    stashBlock(`<div class="math-block" data-tex="${esc(tex)}" data-display="1">${renderMathTex(tex, true)}</div>`));
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) =>
    stashBlock(`<div class="math-block" data-tex="${esc(tex)}" data-display="1">${renderMathTex(tex, true)}</div>`));

  const inline = (line) => {
    const inlines = [];
    const stashIn = (html) => { const i = inlines.length; inlines.push(html); return `\u0001IN_${i}\u0001`; };
    let s = String(line || '')
      .replace(/``([^`\n]+?)``/g, (_, c) => stashIn(`<code class="inline">${esc(c.trim())}</code>`))
      .replace(/`([^`\n]+)`/g, (_, c) => stashIn(`<code class="inline">${esc(c)}</code>`))
      .replace(/\\\((.+?)\\\)/g, (_, tex) => stashIn(`<span class="math-inline" data-tex="${esc(tex)}" data-display="0">${renderMathTex(tex, false)}</span>`))
      .replace(/(?<!\\)\$([^$\n]+?)(?<!\\)\$/g, (m, tex) => {
        if (/^\s|\s$|^\d+$/.test(tex)) return m;
        return stashIn(`<span class="math-inline" data-tex="${esc(tex)}" data-display="0">${renderMathTex(tex, false)}</span>`);
      })
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, url) => {
        const u = safeUrl(url);
        return u ? stashIn(`<img class="md-img" src="${esc(u)}" alt="${esc(alt)}" loading="lazy" />`) : m;
      })
      .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, label, url) => {
        const u = safeUrl(url);
        if (!u) return m;
        const inner = esc(label).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
        return stashIn(`<a class="md-link" href="${esc(u)}" target="_blank" rel="noopener noreferrer">${inner}</a>`);
      });
    s = esc(s)
      .replace(/\*\*\*([^*\n]+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<![\w])__([^_\n]+?)__(?![\w])/g, '<strong>$1</strong>')
      .replace(/~~([^~\n]+?)~~/g, '<del>$1</del>')
      .replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '<em>$1</em>')
      .replace(/(?<![\w])_([^_\n]+?)_(?![\w])/g, '<em>$1</em>');
    for (let pass = 0; pass < 3 && /\u0001IN_\d+\u0001/.test(s); pass++) {
      s = s.replace(/\u0001IN_(\d+)\u0001/g, (_, i) => inlines[Number(i)]);
    }
    return s;
  };

  const lines = text.split('\n');
  const out = [];
  let para = [];
  const listStack = []; // { tag: 'ul'|'ol', indent: number }

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${para.map((l) => inline(l)).join('<br>')}</p>`);
    para = [];
  };
  const closeLists = (toIndent = -1) => {
    while (listStack.length && listStack[listStack.length - 1].indent > toIndent) {
      out.push(`</${listStack.pop().tag}>`);
    }
  };
  const isBlockStart = (idx) => {
    const ln = lines[idx];
    if (!ln || !ln.trim()) return true;
    if (/^\u0000BLOCK_(\d+)\u0000$/.test(ln.trim())) return true;
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(ln)) return true;
    if (/^(#{1,6})\s+/.test(ln)) return true;
    if (/^\s*>\s?/.test(ln)) return true;
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(ln)) return true;
    if (idx + 1 < lines.length && ln.includes('|') && isTableSep(lines[idx + 1])) return true;
    return false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const bm = trimmed.match(/^\u0000BLOCK_(\d+)\u0000$/);
    if (bm) { flushPara(); closeLists(); out.push(blocks[Number(bm[1])]); continue; }

    if (!trimmed) { flushPara(); closeLists(); continue; }

    // GFM Table: header row + alignment separator row + body rows
    if (i + 1 < lines.length && line.includes('|') && isTableSep(lines[i + 1])) {
      flushPara(); closeLists();
      const headers = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1]).map((c) => {
        if (c.startsWith(':') && c.endsWith(':')) return 'center';
        if (c.endsWith(':')) return 'right';
        return 'left';
      });
      const rows = [];
      let j = i + 2;
      while (j < lines.length) {
        const r = lines[j];
        if (!r.trim() || !r.includes('|') || /^\u0000BLOCK_\d+\u0000$/.test(r.trim())) break;
        rows.push(splitTableRow(r));
        j++;
      }
      const cols = Math.max(headers.length, aligns.length, ...rows.map((r) => r.length));
      const thHtml = Array.from({ length: cols }, (_, c) =>
        `<th style="text-align:${aligns[c] || 'left'}">${inline(headers[c] || '')}</th>`).join('');
      const tbHtml = rows.map((r) => `<tr>${Array.from({ length: cols }, (_, c) =>
        `<td style="text-align:${aligns[c] || 'left'}">${inline(r[c] || '')}</td>`).join('')}</tr>`).join('');
      out.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${thHtml}</tr></thead><tbody>${tbHtml}</tbody></table></div>`);
      i = j - 1;
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushPara(); closeLists();
      out.push('<hr class="md-hr" />');
      continue;
    }

    // Headings h1-h6
    const hm = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (hm) {
      flushPara(); closeLists();
      out.push(`<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>`);
      continue;
    }

    // Multi-line Blockquote (supports nested Markdown)
    if (/^\s*>\s?/.test(line)) {
      flushPara(); closeLists();
      const qLines = [];
      let j = i;
      while (j < lines.length && /^\s*>\s?/.test(lines[j])) {
        qLines.push(lines[j].replace(/^\s*>\s?/, ''));
        j++;
      }
      const inner = depth < 3
        ? renderMarkdown(qLines.join('\n'), depth + 1)
        : `<p>${qLines.map((l) => inline(l)).join('<br>')}</p>`;
      out.push(`<blockquote>${inner}</blockquote>`);
      i = j - 1;
      continue;
    }

    // Unordered, Task, or Ordered List (with indentation nesting)
    const ulm = line.match(/^(\s*)[-*+]\s+(.*)$/);
    const olm = !ulm ? line.match(/^(\s*)(\d+)[.)]\s+(.*)$/) : null;
    if (ulm || olm) {
      flushPara();
      const indent = (ulm ? ulm[1] : olm[1]).replace(/\t/g, '  ').length;
      const tag = ulm ? 'ul' : 'ol';
      const content = ulm ? ulm[2] : olm[3];
      const startNum = olm ? Number(olm[2]) : 1;
      while (listStack.length && listStack[listStack.length - 1].indent > indent) {
        out.push(`</${listStack.pop().tag}>`);
      }
      const top = listStack[listStack.length - 1];
      if (!top || top.indent < indent) {
        out.push(tag === 'ol' && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`);
        listStack.push({ tag, indent });
      } else if (top.tag !== tag) {
        out.push(`</${listStack.pop().tag}>`);
        out.push(tag === 'ol' && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`);
        listStack.push({ tag, indent });
      }
      const task = ulm ? content.match(/^\[([ xX])\]\s+(.*)$/) : null;
      if (task) {
        const done = task[1].toLowerCase() === 'x';
        out.push(`<li class="md-task"><span class="md-chk${done ? ' done' : ''}">${done ? '✓' : ''}</span>${inline(task[2])}</li>`);
      } else {
        out.push(`<li>${inline(content)}</li>`);
      }
      continue;
    }

    // Inline block token inside normal line
    if (/\u0000BLOCK_\d+\u0000/.test(line)) {
      flushPara(); closeLists();
      out.push(line.replace(/\u0000BLOCK_(\d+)\u0000/g, (_, id) => blocks[Number(id)]));
      continue;
    }

    // Plain paragraph line
    closeLists();
    para.push(line);
    if (i + 1 < lines.length && isBlockStart(i + 1)) flushPara();
  }

  flushPara();
  closeLists();
  return out.join('');
}

// ---- DeepSeek Async Highlighting (TreeWalker skipping code & KaTeX) ----
function hlWrap(root, quote, kind) {
  const map = [];
  let txt = '';
  let sp = false;
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('.code-frame,.math-block,.math-inline,.katex,mark') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  while (tw.nextNode()) {
    const n = tw.currentNode;
    for (let i = 0; i < n.length; i++) {
      const c = n.data[i];
      if (/\s/.test(c)) { if (sp) continue; sp = true; txt += ' '; map.push([n, i]); }
      else { sp = false; txt += c; map.push([n, i]); }
    }
  }
  const at = txt.indexOf(quote);
  if (at < 0) return false;
  const parts = new Map();
  for (let i = at; i < at + quote.length; i++) {
    const [n, o] = map[i];
    const p = parts.get(n);
    if (p) p[1] = o + 1;
    else parts.set(n, [o, o + 1]);
  }
  let first = true;
  for (const [n, [a, b]] of parts) {
    if (n.parentElement?.closest('mark')) continue;
    try {
      const r = document.createRange();
      r.setStart(n, a); r.setEnd(n, b);
      const m = document.createElement('mark');
      m.className = `hk-${kind}${first ? ' first' : ''}`;
      first = false;
      r.surroundContents(m);
    } catch {}
  }
  return true;
}

function paintHighlightOnto(wrap, got) {
  if (!wrap || !got || wrap.dataset.hlDone) return;
  wrap.dataset.hlDone = '1';
  const badge = wrap.querySelector('.hl-status');
  if (badge) badge.textContent = got.source?.startsWith('deepseek') ? '· DEEPSEEK HL' : '';
  if (got.tldr && !wrap.querySelector('.tldr-box')) {
    const head = wrap.querySelector('.msg-bot-head');
    head?.insertAdjacentHTML('afterend', `<div class="tldr-box"><div class="tldr-head">PRTS // TL;DR EXECUTIVE SUMMARY</div>${renderMarkdown(got.tldr)}</div>`);
  }
  const body = wrap.querySelector('.msg-bot-body');
  if (body && got.marks?.length) {
    let wrapped = 0;
    for (const x of got.marks) if (hlWrap(body, x.q, x.k)) wrapped++;
    if (wrapped > 0) body.classList.add('has-hl');
  }
}

if (typeof window !== 'undefined') {
  window.FMUX_MD = { esc, renderMarkdown, renderMathTex, hlWrap, paintHighlightOnto };
}
