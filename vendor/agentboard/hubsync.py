"""Keeps a hand-built "reports hub" index page up to date with the reports the board copies.

The hub page lists every report twice (once under its project, once in a flat list) and states counts in several places. add_entries()
inserts or refreshes a report's rows, creates the project's section, tile and filter pill when the project is new, and recounts every
number from the page itself, so the page stays consistent. It only ever returns new text; the caller writes it.
"""
import html
import re
import time
from datetime import datetime

ROW_END = "</tr>"


def _esc(s):
    return html.escape(s, quote=True)


def _row(project, project_name, title, href, mtime, size, desc, flat):
    when = datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M")
    kb = f"{size / 1024:.1f} KB"
    folder = href.rsplit("/", 1)[0] + "/" if "/" in href else ""
    search = _esc(" ".join([project, project_name, title, "html", desc, href]).lower())
    proj_cell = f'\n      <td class="col-proj"><span class="proj-slug">{_esc(project)}</span></td>' if flat else ""
    return (f'<tr class="report-row" data-order="{-mtime:.3f}" data-project="{_esc(project)}" data-title="{_esc(title.lower())}" data-kind="html" '
            f'data-mtime="{mtime:.3f}" data-size="{size}" data-search="{search}">\n'
            f'      <td class="col-title">\n        <a class="item-link" href="{_esc(href)}">{_esc(title)}</a>\n'
            f'        <div class="item-sub">{_esc(desc)} · <code>{_esc(href)}</code></div>\n      </td>{proj_cell}\n'
            f'      <td class="col-kind"><span class="badge kind-html">HTML</span></td>\n'
            f'      <td class="col-meta">{when}<br><span class="muted">{kb}</span></td>\n'
            f'      <td class="col-act">\n        <a class="mini-btn primary" href="{_esc(href)}">Open</a>\n'
            f'        <a class="mini-btn" href="{_esc(folder)}">Dir</a>\n      </td>\n    </tr>')


def _drop_rows(text, href):
    """Removes every row that opens href; returns the new text."""
    pat = re.compile(r'<tr class="report-row"[^>]*>(?:(?!</tr>).)*?class="item-link" href="' + re.escape(_esc(href)) + r'"(?:(?!</tr>).)*</tr>\s*', re.S)
    return pat.sub("", text)


def _section_bounds(text, project):
    m = re.search(r'<section class="proj-section" id="proj-' + re.escape(project) + r'"', text)
    if not m:
        return None
    end = text.index("</section>", m.start()) + len("</section>")
    return m.start(), end


def _new_section(text, project, name, order):
    """A section for a new project, made from an existing one with its rows removed."""
    m = re.search(r'<section class="proj-section" id="proj-[^"]+"[\s\S]*?</section>', text)
    sec = m.group(0)
    sec = re.sub(r'id="proj-[^"]+"', f'id="proj-{project}"', sec, count=1)
    sec = re.sub(r'data-order="\d+"', f'data-order="{order}"', sec, count=1)
    sec = re.sub(r'data-project="[^"]*"', f'data-project="{_esc(project)}"', sec, count=1)
    sec = re.sub(r'data-title="[^"]*"', f'data-title="{_esc(name.lower())}"', sec, count=1)
    sec = re.sub(r'<h2>.*?</h2>', f'<h2>{_esc(name)}</h2>', sec, count=1, flags=re.S)
    sec = re.sub(r'<a class="dir-link" href="[^"]*">[^<]*</a>', f'<a class="dir-link" href="{_esc(project)}/">/{_esc(project)}/ →</a>', sec, count=1)
    sec = re.sub(r'<p class="proj-desc">.*?</p>', '<p class="proj-desc">Reports copied here by the board when an agent finished them.</p>', sec, count=1, flags=re.S)
    sec = re.sub(r'(<tbody>).*?(</tbody>)', r'\1\n\2', sec, count=1, flags=re.S)
    return sec


def _recount(text):
    """Sets every count, tile, pill and date from what is on the page."""
    ms = re.search(r'<main id="projectsContainer">', text)
    me = text.index("</main>", ms.end())
    main = text[ms.end():me]
    secs = list(re.finditer(r'<section class="proj-section" id="proj-([^"]+)"[\s\S]*?</section>', main))
    total, latest, slugs = 0, 0.0, []
    for m in secs:
        slug, body = m.group(1), m.group(0)
        n = len(re.findall(r'class="report-row"', body))
        mt = max([float(x) for x in re.findall(r'data-mtime="([\d.]+)"', body)] or [0])
        slugs.append((slug, n, mt))
        total += n
        latest = max(latest, mt)
        new = re.sub(r'(<span class="sec-visible-count">)\d+(</span>)', rf'\g<1>{n}\g<2>', body, count=1)
        text = text.replace(body, new, 1) if new != body else text
        day = datetime.fromtimestamp(mt).strftime("%Y-%m-%d") if mt else ""
        text = re.sub(r'(data-jump="' + re.escape(slug) + r'"[\s\S]*?<span class="proj-count">)\d+(</span>[\s\S]*?<div class="proj-meta">Updated )[\d-]*(</div>)',
                      lambda mm: f"{mm.group(1)}{n}{mm.group(2)}{day}{mm.group(3)}", text, count=1)
        text = re.sub(r'(data-filter="' + re.escape(slug) + r'">[^<]*<span class="pill-n">)\d+(</span>)', rf'\g<1>{n}\g<2>', text, count=1)
    text = re.sub(r'(<strong>)\d+(</strong> Project Deliverables)', rf'\g<1>{total}\g<2>', text, count=1)
    text = re.sub(r'(<strong>)\d+(</strong> Project Folders)', rf'\g<1>{len(secs)}\g<2>', text, count=1)
    text = re.sub(r'(Showing )\d+( project reports)', rf'\g<1>{total}\g<2>', text, count=1)
    text = re.sub(r'(<span id="flatVisibleCount">)\d+(</span>)', rf'\g<1>{total}\g<2>', text, count=1)
    text = re.sub(r'(Updated <strong>)[\d: -]+(</strong>)', lambda mm: mm.group(1) + time.strftime("%Y-%m-%d %H:%M") + mm.group(2), text, count=1)
    return text


def add_entries(text, entries):
    """entries: dicts with project, title, href, mtime, size, desc. Returns the new hub text, or the old text when the page does not have
    the structure this expects."""
    if ('<main id="projectsContainer">' not in text or 'id="flatTable"' not in text or '<section class="proj-grid"' not in text
            or 'id="filterPills"' not in text):
        return text
    for e in sorted(entries, key=lambda e: e["mtime"]):   # oldest first, so the newest ends up on top
        project, href = e["project"], e["href"]
        name = e.get("project_name") or project.replace("-", " ").replace("_", " ").title()
        have = re.search(r'<tr class="report-row"[^>]*data-mtime="([\d.]+)" data-size="(\d+)"[^>]*>(?:(?!</tr>).)*?class="item-link" href="' + re.escape(_esc(href)) + r'">([^<]*)<', text, re.S)
        if have and abs(float(have.group(1)) - e["mtime"]) < 0.01 and int(have.group(2)) == e["size"] and html.unescape(have.group(3)) == e["title"]:
            continue   # already listed as it is
        text = _drop_rows(text, href)
        if not _section_bounds(text, project):
            order = len(re.findall(r'<section class="proj-section" id="proj-', text))
            sec = _new_section(text, project, name, order)
            at = text.index("</main>")
            text = text[:at] + "\n" + sec + "\n    " + text[at:]
            tile = (f'<button class="proj-card" type="button" data-jump="{_esc(project)}">\n              <div class="proj-card-top">\n'
                    f'                <span class="proj-slug">{_esc(project)}</span>\n                <span class="proj-count">0</span>\n              </div>\n'
                    f'              <div class="proj-name">{_esc(name)}</div>\n              <div class="proj-meta">Updated </div>\n            </button>\n')
            g = text.index('<section class="proj-grid"')
            text = text[:text.index("</section>", g)] + tile + text[text.index("</section>", g):]
            pill = f'<button class="pill" type="button" data-filter="{_esc(project)}">{_esc(project)} <span class="pill-n">0</span></button>'
            f = text.index('id="filterPills"')
            fe = text.index("</div>", f)
            text = text[:fe] + pill + text[fe:]
        b = _section_bounds(text, project)
        sec = text[b[0]:b[1]]
        row = _row(project, name, e["title"], href, e["mtime"], e["size"], e["desc"], flat=False)
        sec2 = sec.replace("<tbody>", "<tbody>\n                    " + row, 1)
        text = text[:b[0]] + sec2 + text[b[1]:]
        ft = text.index('id="flatTable"')
        tb = text.index("<tbody>", ft) + len("<tbody>")
        text = text[:tb] + "\n            " + _row(project, name, e["title"], href, e["mtime"], e["size"], e["desc"], flat=True) + text[tb:]
    return _recount(text)
