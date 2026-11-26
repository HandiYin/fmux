"""Make a self-contained HTML report switchable between English and Chinese (used when the board publishes a report).

Every piece of visible text is translated by the board's translation call (DeepSeek, then Codex, never Claude) and kept next to the
original in the same file; a small EN / 中 switch at the top right shows one or the other. Code, scripts, styles, tables of numbers
and anything without letters are left alone. Used by report-publish; nothing here touches the original file.
"""
import html
import json
import re
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser

SKIP = {"script", "style", "pre", "code", "textarea", "select", "option", "title", "svg", "math", "kbd", "samp"}
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
CJK = re.compile(r"[一-鿿]")
LETTER = re.compile(r"[A-Za-z一-鿿]")


class _Split(HTMLParser):
    """Walks the document once, keeping every tag exactly as written; text nodes are collected in `nodes`."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.nodes, self.skip = [], [], 0

    def handle_starttag(self, tag, attrs):
        self.parts.append(self.get_starttag_text())
        if tag in SKIP and tag not in VOID:
            self.skip += 1

    def handle_startendtag(self, tag, attrs):
        self.parts.append(self.get_starttag_text())

    def handle_endtag(self, tag):
        self.parts.append(f"</{tag}>")
        if tag in SKIP and self.skip:
            self.skip -= 1

    def handle_data(self, data):
        if self.skip or not LETTER.search(data) or len(data.strip()) < 2:
            self.parts.append(data if self.skip else html.escape(data, quote=False))
            return
        self.parts.append(("NODE", len(self.nodes)))
        self.nodes.append(data)

    def handle_comment(self, data):
        self.parts.append(f"<!--{data}-->")

    def handle_decl(self, decl):
        self.parts.append(f"<!{decl}>")

    def handle_pi(self, data):
        self.parts.append(f"<?{data}>")


ASK = None   # set by the caller: ask(text, to) -> translated text, or "" when it needs none


def _ask(text, to):
    return ASK(text, to) or ""


def _flat(s):
    return re.sub(r"\s+", " ", s).strip()


def _translate_batch(items, to):
    """items: [(index, text)]. Sent together with [[n]] markers; whatever does not come back marked is asked again alone."""
    out = {}
    body = "\n\n".join(f"[[{i}]] {_flat(t)}" for i, t in items)
    try:
        reply = _ask(body, to)
    except Exception:
        reply = ""
    pieces = re.split(r"\[\[(\d+)\]\]", reply)
    for k in range(1, len(pieces) - 1, 2):
        i = int(pieces[k])
        if i in dict(items) and pieces[k + 1].strip():
            out[i] = pieces[k + 1].strip()
    for i, t in items:
        if i not in out and len(_flat(t)) >= 25:
            try:
                one = _ask(_flat(t), to)
            except Exception:
                one = ""
            if one.strip():
                out[i] = one.strip()
    return out


_CSS = """<style id="bl-style">
.bl-zh{display:none}
html[data-lang=zh] .bl-zh,html:has(#bl-r-zh:checked) .bl-zh{display:inline}
html[data-lang=zh] .bl-en,html:has(#bl-r-zh:checked) .bl-en{display:none}
#bl-switch{position:fixed;top:10px;right:10px;z-index:2147483647;display:flex;border:2px solid #4f46e5;border-radius:9px;overflow:hidden;font:700 14px system-ui,-apple-system,sans-serif;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.25)}
#bl-switch input{position:absolute;opacity:0;width:0;height:0;pointer-events:none}
#bl-switch label{padding:6px 14px;cursor:pointer;color:#4f46e5;background:#fff;user-select:none}
#bl-switch input:checked+label{background:#4f46e5;color:#fff}
@media print{#bl-switch{display:none}}
</style>"""
# the switch is plain HTML (radio buttons and labels, no script needed); the script only remembers your choice
_SWITCH = """<div id="bl-switch" role="group" aria-label="Language"><input type="radio" name="bl-lang" id="bl-r-en" %EN%><label for="bl-r-en">EN</label><input type="radio" name="bl-lang" id="bl-r-zh" %ZH%><label for="bl-r-zh">中</label></div>"""
_JS = """<script id="bl-script">
(function(){var d=document.documentElement,src=%SRC%,en=document.getElementById('bl-r-en'),zh=document.getElementById('bl-r-zh');if(!en||!zh)return;
function set(l){d.setAttribute('data-lang',l);(l==='zh'?zh:en).checked=true;try{localStorage.setItem('report-lang',l)}catch(e){}}
en.onchange=zh.onchange=function(){set(zh.checked?'zh':'en')};
var s=null;try{s=localStorage.getItem('report-lang')}catch(e){}d.setAttribute('data-lang',s==='en'||s==='zh'?s:src);(d.getAttribute('data-lang')==='zh'?zh:en).checked=true})();
</script>"""


def make_bilingual(text, cache=None, corner="top"):
    """Returns the switchable HTML, or None when there is nothing to translate or the board could not be reached. Each piece of text
    goes the way it needs (Chinese to English, everything else to Chinese), so a page that mixes both works. cache (a dict) keeps
    what was translated, so a page built again only pays for what changed."""
    cache = {} if cache is None else cache
    p = _Split()
    p.feed(text)
    p.close()
    if not p.nodes:
        return None
    cjk = sum(len(CJK.findall(n)) for n in p.nodes)
    letters = sum(len(LETTER.findall(n)) for n in p.nodes) or 1
    src = "zh" if cjk / letters > .3 else "en"   # the language the page opens in
    way = {i: ("en" if CJK.search(n) else "zh") for i, n in enumerate(p.nodes)}
    done, todo = {}, {"en": [], "zh": []}
    for i, n in enumerate(p.nodes):
        hit = cache.get(f"{way[i]}\0{_flat(n)}")
        if hit:
            done[i] = hit
        else:
            todo[way[i]].append((i, n))
    jobs = []
    for to, items in todo.items():
        cur, size = [], 0
        for i, n in items:
            if cur and size + len(n) > 2200:
                jobs.append((cur, to))
                cur, size = [], 0
            cur.append((i, n))
            size += len(n) + 8
        if cur:
            jobs.append((cur, to))
    with ThreadPoolExecutor(3) as ex:
        for (batch, to), res in zip(jobs, ex.map(lambda j: _translate_batch(j[0], j[1]), jobs)):
            for i, t in res.items():
                done[i] = t
                cache[f"{to}\0{_flat(p.nodes[i])}"] = t
    if not done:
        return None
    out = []
    for part in p.parts:
        if isinstance(part, tuple):
            n = p.nodes[part[1]]
            tr = done.get(part[1])
            lead, trail = n[:len(n) - len(n.lstrip())], n[len(n.rstrip()):]
            if tr:
                orig, other = html.escape(n.strip(), quote=False), html.escape(tr, quote=False)
                en, zh = (orig, other) if way[part[1]] == "zh" else (other, orig)
                out.append(f'{lead}<span class="bl-en" lang="en">{en}</span><span class="bl-zh" lang="zh">{zh}</span>{trail}')
            else:  # not translated (short, numbers, names, already in the other language): the same in both
                out.append(html.escape(n, quote=False))
        else:
            out.append(part)
    doc = "".join(out)
    css = _CSS if corner == "top" else _CSS.replace("top:10px;right:10px", "bottom:16px;right:16px")
    if re.search(r"</head>", doc, re.I):
        doc = re.sub(r"</head>", lambda m: css + "</head>", doc, count=1, flags=re.I)
    else:
        doc = css + doc
    sw = _SWITCH.replace("%EN%", "checked" if src == "en" else "").replace("%ZH%", "checked" if src == "zh" else "")
    if re.search(r"<body[^>]*>", doc, re.I):
        doc = re.sub(r"<body[^>]*>", lambda m: m.group(0) + sw, doc, count=1, flags=re.I)
    else:
        doc = sw + doc
    js = _JS.replace("%SRC%", json.dumps(src))
    if re.search(r"</body>", doc, re.I):
        doc = re.sub(r"</body>", lambda m: js + "</body>", doc, count=1, flags=re.I)
    else:
        doc += js
    return doc
