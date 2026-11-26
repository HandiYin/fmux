#!/usr/bin/env python3
"""agentboard — local kanban for Claude Code + Codex agents and human tasks.

Stdlib only. Serves static/index.html and a JSON API on 127.0.0.1.
State lives in data/*.json; agent runs log to runs/<task>/<run>/.
"""
import base64
import socket
import gzip
import hashlib
import html
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import threading
import time
import uuid
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import urllib.request
from urllib.parse import parse_qs, quote, unquote, urlparse

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
RUNS = ROOT / "runs"
WORKTREES = ROOT / "worktrees"
STATIC = ROOT / "static"
HOME = Path.home()
CLAUDE_SESSIONS = HOME / ".claude" / "sessions"
CLAUDE_PROJECTS = HOME / ".claude" / "projects"
CODEX_SESSIONS = HOME / ".codex" / "sessions"
CODEX_INDEX = HOME / ".codex" / "session_index.jsonl"

DEFAULT_CONFIG = {
    "host": "127.0.0.1",
    "port": 8789,
    "ssh_hint": "you@your-linux-box",  # shown in Help as the SSH tunnel target for remote access
    "tmux_session": "",  # where Resume/New open windows; "" = session holding most agent panes
    "autopilot": False,
    "max_parallel": 7,
    "daily_cap": {"claude": 40, "codex": 40, "deepseek": 200, "antigravity": 100},
    "cross_review": False,
    "day_start_hour": 4,  # the Today list changes day at this hour (4 = 4 am), not at midnight
    "auto_reports": True,  # an HTML report an agent names in its final answer is copied to reports/<project>/ as an English/Chinese switch version
    "agent_messaging": True,  # experimental: a message one agent sends to another card is labelled, and the answer goes back to the sender
    "agent_msg_limit": 5,  # messages one agent may send to other cards per hour
    "auto_escalate": True,
    "tiers": {
        "S": {"claude": {"model": "haiku", "effort": "low"}, "codex": {"model": "gpt-6-luna", "effort": "low"}, "deepseek": {"model": "deepseek-flash", "effort": "off"}, "antigravity": {"model": "gemini-3.8-flash-low", "effort": "default"}},
        "M": {"claude": {"model": "sonnet", "effort": "medium"}, "codex": {"model": "gpt-6.1-sol", "effort": "medium"}, "deepseek": {"model": "deepseek-flash", "effort": "low"}, "antigravity": {"model": "gemini-3.8-flash-high", "effort": "default"}},
        "L": {"claude": {"model": "opus", "effort": "high"}, "codex": {"model": "gpt-6.1-sol", "effort": "high"}, "deepseek": {"model": "deepseek-flash", "effort": "low"}, "antigravity": {"model": "gemini-4-argon-medium", "effort": "default"}},
        "XL": {"claude": {"model": "fable", "effort": "high"}, "codex": {"model": "gpt-6-astra", "effort": "xhigh"}, "deepseek": {"model": "deepseek-v4-pro", "effort": "high"}, "antigravity": {"model": "gemini-4-argon-high", "effort": "default"}},
    },
    "triage": {"model": "haiku", "effort": "low"},
    # choices offered in the UI (any other model id can still be typed in)
    "models": {"claude": ["haiku", "sonnet", "opus", "fable"], "codex": ["gpt-6-luna", "gpt-6.1-sol", "gpt-6.2-sol", "gpt-6-astra", "gpt-6.2-astra", "gpt-6.1-terra", "gpt-6-sol"], "deepseek": ["deepseek-flash", "deepseek-v4-pro"],
               "antigravity": ["gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high", "gemini-4-neon-low", "gemini-4-neon-medium", "gemini-4-neon-high", "gemini-4-neon-xhigh", "gemini-4-argon-low", "gemini-4-argon-medium", "gemini-4-argon-high", "gemini-4-hydrogen-high", "claude-sonnet-5-5-medium", "claude-opus-5-5-medium"]},
    "efforts": {"claude": ["low", "medium", "high", "xhigh", "max"], "codex": ["low", "medium", "high", "xhigh", "max", "ultra"], "deepseek": ["off", "low", "high", "max"], "antigravity": ["default"]},
    "claude_flags": ["--permission-mode", "bypassPermissions"],
    "claude_disallowed": [],  # optional tool patterns to block for Claude runs, e.g. ["Bash(git push:*)"]
    "codex_sandbox": "workspace-write",
    "default_agent": "antigravity",  # default agent for new cards ("auto" = triage picks)
    "run_mode": "background",  # where agents for cards run: "background" (no terminal) or "terminal" (a tmux window you can watch and type into)
    "access": {"claude": "standard", "codex": "standard", "deepseek": "standard", "antigravity": "standard"},  # read | standard | full; a card can override
    "resume_cmd": {"claude": "claude --resume {id}", "codex": "codex resume {id}", "deepseek": "dst --resume {id}", "antigravity": "agy --conversation {id}"},
    "new_cmd": {"claude": "claude", "codex": "codex", "deepseek": "dst", "antigravity": "agy"},
    "repo_scan_depth": 4,
}

PALETTE = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444", "#06b6d4", "#ec4899", "#84cc16"]

DEFAULT_BOARD = {
    "categories": [
        {"id": "inbox", "name": "Inbox", "color": "#64748b", "repo": "", "agent": "auto", "wip": 0},
        {"id": "code", "name": "Code", "color": "#3b82f6", "repo": "", "agent": "auto", "wip": 0},
        {"id": "research", "name": "Research", "color": "#8b5cf6", "repo": "", "agent": "auto", "wip": 0},
        {"id": "ops", "name": "Ops / infra", "color": "#10b981", "repo": "", "agent": "auto", "wip": 0},
        {"id": "admin", "name": "Admin", "color": "#ec4899", "repo": "", "agent": "auto", "wip": 0},
    ],
    "tasks": [],
    "rules": [],  # only rules the user adds
}

LOCK = threading.RLock()
PROCS = {}  # task_id -> Popen
TRIAGING = set()


# ---------------------------------------------------------------- storage

def load_json(path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return json.loads(json.dumps(default))


def save_json(path, obj):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1))
    tmp.replace(path)


DATA.mkdir(exist_ok=True)
RUNS.mkdir(exist_ok=True)
WORKTREES.mkdir(exist_ok=True)
CONFIG = DEFAULT_CONFIG | load_json(DATA / "config.json", {})
if "access" not in load_json(DATA / "config.json", {}):  # carry over the older Codex-only setting
    CONFIG["access"] = {"claude": "standard", "codex": {"read-only": "read", "danger-full-access": "full"}.get(CONFIG["codex_sandbox"], "standard")}
for _k in ("daily_cap", "models", "efforts", "access", "resume_cmd", "new_cmd"):  # a config saved before DeepSeek lacks its entries
    CONFIG[_k] = {**DEFAULT_CONFIG[_k], **CONFIG.get(_k, {})}
for _tier, _per in DEFAULT_CONFIG["tiers"].items():
    CONFIG["tiers"].setdefault(_tier, {})
    for _ag, _m in _per.items():
        CONFIG["tiers"][_tier].setdefault(_ag, dict(_m))
if not (DATA / "config.json").exists():
    save_json(DATA / "config.json", CONFIG)
AGENT_KINDS = ("claude", "codex", "deepseek", "antigravity")
AGY_DIR = DATA / "agy"   # the board keeps its own transcript of each Antigravity conversation: <id>.jsonl
AGY_PROMPT = {}          # run id -> the prompt it was started with
DSH_SESSIONS = HOME / ".dsh" / "sessions"
BOARD = load_json(DATA / "board.json", DEFAULT_BOARD)
BOARD.setdefault("rules", [])
BOARD.setdefault("daily", [])   # the Today list: things you do yourself, repeating; unchecked ones roll over
SMETA = load_json(DATA / "sessions_meta.json", {})  # key -> {label, pinned, hidden, task}
ATTN = load_json(DATA / "attention.json", {})  # key -> {since, reason, title}


def stamp_progress():
    """Dates for the Progress view, kept on the card because the activity log gets trimmed."""
    for t in BOARD["tasks"]:
        if t["status"] == "review" and not t.get("finished_at"):
            t["finished_at"] = now()
        if t["status"] == "done":
            t.setdefault("done_at", now())
        else:
            t.pop("done_at", None)


def backfill_progress():
    """Cards from before those dates were kept: work them out from their history. Run once, before anything is saved."""
    for t in BOARD["tasks"]:
        if not t.get("finished_at"):
            first = next((r["end"] for r in t["runs"] if r.get("exit") == 0 and r.get("end")), None)
            if first or t["status"] == "review":
                t["finished_at"] = first or t["updated"]
        if t["status"] == "done" and not t.get("done_at"):
            closed = [a["t"] for a in t["activity"] if a["msg"] in ("approve", "keep", "done")]
            t["done_at"] = closed[-1] if closed else t["updated"]


def save_board():
    stamp_progress()
    save_json(DATA / "board.json", BOARD)


def save_config():
    save_json(DATA / "config.json", CONFIG)


def now():
    return time.time()


def task_by_id(tid):
    for t in BOARD["tasks"]:
        if t["id"] == tid:
            return t
    return None


def cat_by_id(cid):
    for c in BOARD["categories"]:
        if c["id"] == cid:
            return c
    return None


def log_activity(t, msg):
    t.setdefault("activity", []).append({"t": now(), "msg": msg})
    t["activity"] = t["activity"][-60:]
    t["updated"] = now()


def new_task(cat, title, **kw):
    t = {
        "id": uuid.uuid4().hex[:8], "cat": cat, "order": now(), "title": title.strip(),
        "desc": "", "checklist": [], "owner": "agent", "agent": "auto", "tier": "auto",
        "urgent": False, "important": False, "due": "", "labels": [],
        "status": "todo", "created": now(), "updated": now(),
        "triage": None, "runs": [], "session": None, "review": None, "activity": [], "archived": False,
        "repo": "",
    }
    t.update(kw)
    log_activity(t, "created")
    return t


# ---------------------------------------------------------------- shell helpers

def sh(args, cwd=None, timeout=30, check=False):
    try:
        r = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout,
                           stdin=subprocess.DEVNULL)
    except Exception as e:
        return 1, "", str(e)
    if check and r.returncode:
        raise RuntimeError((r.stderr or r.stdout).strip()[:400])
    return r.returncode, r.stdout, r.stderr


def deepseek_key():
    """The key from data/deepseek.env, read each time so filling it in needs no restart. Never logged or sent anywhere else."""
    try:
        for line in (DATA / "deepseek.env").read_text().splitlines():
            k, _, v = line.partition("=")
            if k.strip() == "DEEPSEEK_API_KEY" and v.strip().strip("\"'"):
                return v.strip().strip("\"'")
    except OSError:
        pass
    return ""


def ask_deepseek(prompt, timeout):
    """One question to DeepSeek's API with thinking switched off: with it on, the model can spend its whole token budget
    reasoning on a long answer and never reply (30 to 120 seconds, or nothing). Returns the answer, or "" if it can't."""
    key = deepseek_key()
    if not key:
        return ""
    body = {"model": CONFIG.get("quick_model", "deepseek-flash"), "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 4000, "thinking": {"type": "disabled"}}
    req = urllib.request.Request("https://api.deepseek.com/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=min(timeout, 60)) as r:
            return (json.load(r)["choices"][0]["message"].get("content") or "").strip()
    except Exception as e:
        print("deepseek call failed:", type(e).__name__, getattr(e, "code", ""))
        return ""


def ask_codex(prompt, timeout):
    """One question to Codex, read-only and not kept in its history. Returns the answer, or "" if it can't."""
    cfg = CONFIG["tiers"]["S"]["codex"]
    out = RUNS / f".quick-{uuid.uuid4().hex[:10]}.txt"
    try:
        subprocess.run(["codex", "exec", "--ephemeral", "-s", "read-only", "--skip-git-repo-check", "-C", str(RUNS), "-m", cfg["model"],
                        "-c", f'model_reasoning_effort="{cfg["effort"]}"', "-o", str(out), "-"],
                       input=prompt, capture_output=True, text=True, timeout=timeout + 60, cwd=str(RUNS))
        return out.read_text().strip() if out.exists() else ""
    except Exception as e:
        print("codex quick call failed:", type(e).__name__)
        return ""
    finally:
        out.unlink(missing_ok=True)


def quick_llm(prompt, timeout=90):
    """The board's own small calls (sizing cards, short titles, highlights and summaries, reviews): DeepSeek when a key is
    set and working, then Codex. Claude is never used for the board's own work, only for the cards you run on it.
    `quick_backend` in config can force "deepseek" or "codex". QUICK.who says who answered. Returns "" on failure."""
    mode = CONFIG.get("quick_backend", "auto")
    QUICK.who = ""
    if mode != "codex":
        t = ask_deepseek(prompt, timeout)
        if t:
            QUICK.who = "deepseek"
            return t
        if mode == "deepseek":
            return ""
    t = ask_codex(prompt, timeout)
    QUICK.who = "codex" if t else ""
    return t


QUICK = threading.local()  # per thread: who answered this thread's last quick_llm call


def git_ident(wd):
    """-c flags so board commits work even without a configured git identity."""
    rc, out, _ = sh(["git", "-C", wd, "config", "user.email"])
    return [] if out.strip() else ["-c", "user.name=agentboard", "-c", "user.email=agentboard@localhost"]


def git_top(path):
    if not path:
        return None
    rc, out, _ = sh(["git", "-C", path, "rev-parse", "--show-toplevel"])
    top = out.strip()
    if rc or not top or Path(top) == HOME:  # never worktree the whole home dir
        return None
    rc, _, _ = sh(["git", "-C", top, "rev-parse", "--verify", "HEAD"])
    return top if rc == 0 else None


_REPO_CACHE = {"t": 0, "list": []}


def list_repos():
    if now() - _REPO_CACHE["t"] < 300:
        return _REPO_CACHE["list"]
    found = []
    depth = CONFIG.get("repo_scan_depth", 4)
    skip = {".cache", ".local", "node_modules", ".npm", ".cargo", ".rustup", "snap", ".vscode-server",
            "agentboard", ".codex", ".claude", "miniconda3", "anaconda3", ".conda"}
    for dirpath, dirnames, _ in os.walk(HOME):
        rel = Path(dirpath).relative_to(HOME)
        if len(rel.parts) >= depth:
            dirnames[:] = []
        dirnames[:] = [d for d in dirnames if d not in skip and not (d.startswith(".") and d != ".git")]
        if ".git" in dirnames and Path(dirpath) != HOME:
            found.append(dirpath)
            dirnames[:] = []
    _REPO_CACHE.update(t=now(), list=sorted(found))
    return _REPO_CACHE["list"]


# ---------------------------------------------------------------- tmux / live sessions

def tmux_panes():
    rc, out, _ = sh(["tmux", "list-panes", "-a", "-F",
                     "#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{session_name}:#{window_index}.#{pane_index}"
                     "\t#{window_name}\t#{pane_current_path}\t#{session_name}"])
    panes = []
    if rc:
        return panes
    for line in out.splitlines():
        p = line.split("\t")
        if len(p) >= 7:
            panes.append({"pane": p[0], "pid": int(p[1]), "cmd": p[2], "where": p[3], "window": p[4],
                          "cwd": p[5], "session": p[6]})
    return panes


def proc_env(pid, key):
    try:
        for kv in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0"):
            if kv.startswith(key.encode() + b"="):
                return kv.split(b"=", 1)[1].decode()
    except Exception:
        pass
    return None


def agent_pids(pid, depth=4):
    """PIDs of claude/codex processes at or under pid."""
    out = []
    try:
        cmd = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
        if any(Path(c.decode(errors="ignore")).name in ("claude", "codex") or b"codex" in c or b"claude" in c for c in cmd[:2]):
            out.append(pid)
        kids = Path(f"/proc/{pid}/task/{pid}/children").read_text().split()
    except Exception:
        return out
    if depth > 1:
        for k in kids:
            out += agent_pids(int(k), depth - 1)
    return out


def end_session(s):
    """Quit an interactive agent the polite way (/exit), then Ctrl-C, then SIGTERM. The transcript stays on disk."""
    pids = agent_pids(s["pid"])
    alive = lambda: [p for p in pids if Path(f"/proc/{p}").exists()]
    if s["pane"]:
        steps = [lambda: sh(["tmux", "send-keys", "-t", s["pane"], "Escape"]),
                 lambda: paste_to_pane(s["pane"], "/exit" if s["kind"] == "claude" else "/quit"),
                 lambda: sh(["tmux", "send-keys", "-t", s["pane"], "C-c"]),
                 lambda: sh(["tmux", "send-keys", "-t", s["pane"], "C-c"])]
        for step in steps:
            step()
            time.sleep(1.5)
            if not alive():
                return
    for p in alive():
        try:
            os.kill(p, signal.SIGTERM)
        except Exception:
            pass


def proc_children_cmds(pid, depth=3):
    """Names of descendant processes (to spot codex under a shell)."""
    names = []
    try:
        kids = Path(f"/proc/{pid}/task/{pid}/children").read_text().split()
    except Exception:
        return names
    for k in kids:
        try:
            names.append(Path(f"/proc/{k}/comm").read_text().strip())
        except Exception:
            continue
        if depth > 1:
            names += proc_children_cmds(int(k), depth - 1)
    return names


ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")


def capture(pane, lines=60):
    rc, out, _ = sh(["tmux", "capture-pane", "-p", "-J", "-t", pane, "-S", f"-{lines}"], timeout=5)
    return ANSI.sub("", out) if rc == 0 else ""


def pane_view(pane, lines=150):
    """The terminal as the user sees it: colours kept, wrapped lines not joined, plus the cursor and pane size."""
    rc, out, _ = sh(["tmux", "capture-pane", "-p", "-e", "-t", pane, "-S", f"-{lines}"], timeout=5)
    if rc:
        return {"ansi": "", "cx": 0, "cy": 0, "w": 80, "h": 24, "rows": 0}
    rc2, geo, _ = sh(["tmux", "display-message", "-p", "-t", pane, "#{cursor_x} #{cursor_y} #{pane_height} #{pane_width}"], timeout=5)
    try:
        cx, cy, h, w = (int(x) for x in geo.split())
    except Exception:
        cx, cy, h, w = 0, 0, 24, 80
    body = out[:-1] if out.endswith("\n") else out
    rows = body.count("\n") + 1
    return {"ansi": body, "cx": cx, "cy": cy + max(0, rows - h), "w": w, "h": h, "rows": rows}


TERM_KEY_RE = re.compile(r"(?:[CMS]-){0,3}(?:[A-Za-z0-9]|Enter|Escape|Tab|BTab|BSpace|DC|IC|Up|Down|Left|Right|Home|End|PageUp|PageDown|Space|F(?:[1-9]|1[0-2]))")


def not_board_pane(pane):
    """True for the pane the board server itself runs in (typing there reaches no agent)."""
    if pane == SELF_PANE:
        return True
    return any(p["pane"] == pane and p.get("session") == "agentboard" for p in tmux_panes())


def paste_raw(pane, text):
    """Insert text exactly as typed (no Enter added); bracketed paste keeps multi-line text as one paste."""
    if "\n" in text:
        subprocess.run(["tmux", "load-buffer", "-b", "agentboard", "-"], input=text, text=True, capture_output=True)
        sh(["tmux", "paste-buffer", "-p", "-d", "-b", "agentboard", "-t", pane])
    elif text:
        sh(["tmux", "send-keys", "-t", pane, "-l", "--", text])


BUSY_RE = re.compile(r"esc to interrupt|Esc to interrupt|Working \(|ctrl\+c to interrupt", re.I)
PERM_RE = re.compile(r"Do you want to (proceed|make this edit|create|allow)|Allow (this|once)|"
                     r"❯ 1\. Yes|Would you like to run|approve this|\[y/N\]|Press enter to confirm|"
                     r"trust (the files in )?this folder|Do you trust|Trust and continue", re.I)

LIVE = {"list": [], "t": 0}
_PANE_HASH = {}  # pane -> (hash, changed_at)


SELF_PANE = os.environ.get("TMUX_PANE")


def is_board_run(pid):
    """A headless `claude -p … stream-json` run started by this board (it has no terminal of its own)."""
    try:
        cmd = Path(f"/proc/{pid}/cmdline").read_bytes()
    except Exception:
        return False
    return b"stream-json" in cmd and (b"-p\0" in cmd or b"--print" in cmd)


def scan_live():
    """Live interactive sessions: Claude registry + any tmux pane running codex."""
    panes = {p["pane"]: p for p in tmux_panes()}
    out = []
    seen_panes = set()
    for f in CLAUDE_SESSIONS.glob("*.json"):
        try:
            d = json.loads(f.read_text())
            pid = int(d["pid"])
        except Exception:
            continue
        if not Path(f"/proc/{pid}").exists():
            continue
        try:
            if b"bg-spare" in Path(f"/proc/{pid}/cmdline").read_bytes():
                continue  # pre-warmed spare process, not a conversation
        except Exception:
            continue
        if d.get("cwd") == str(RUNS):
            continue  # the board's own quick model calls (triage, titles, highlights) run here; card runs have their own folders
        pane = proc_env(pid, "TMUX_PANE")
        p = panes.get(pane) if pane else None
        if p and (pane == SELF_PANE or p.get("session") == "agentboard" or is_board_run(pid)):
            pane, p = None, None  # the board's own terminal, or an agent it started in the background
        sid = d.get("sessionId", "")
        name = d.get("name") or ""
        info = claude_info(sid)
        if info and (not name or d.get("nameSource") == "auto" or re.fullmatch(r"[\w.-]+-[0-9a-f]{2}", name)):
            name = info.get("title") or name
        out.append({
            "key": f"claude:{sid}", "kind": "claude", "id": sid, "pid": pid, "status": d.get("status", "?"),
            "name": name or sid[:8], "last_prompt": (info or {}).get("last_prompt", ""), "cwd": d.get("cwd", ""), "pane": pane if p else None,
            "where": p["where"] if p else "", "bg": d.get("kind") == "bg",
            "updated": (d.get("statusUpdatedAt") or d.get("updatedAt") or 0) / 1000,
        })
        if pane:
            seen_panes.add(pane)
    for pid_pane, p in panes.items():
        if pid_pane in seen_panes or pid_pane == SELF_PANE or p.get("session") == "agentboard":
            continue  # the board's own terminal looks like it runs codex while a background card does
        cmds = [p["cmd"]] + proc_children_cmds(p["pid"])
        if not any(c.startswith("codex") for c in cmds):
            continue
        out.append({
            "key": f"pane:{pid_pane}", "kind": "codex", "id": "", "pid": p["pid"], "status": "?",
            "name": p["window"] if not re.fullmatch(r"bash|zsh|codex|node|tmux:\d+", p["window"]) else f"codex @{p['where'].split(':')[1].split('.')[0]}",
            "last_prompt": "",
            "cwd": p["cwd"], "pane": pid_pane, "where": p["where"], "bg": False, "updated": 0,
        })
    # screen-based state: permission prompts for everyone, busy/idle for codex panes
    for s in out:
        if not s["pane"]:
            s["screen_tail"] = ""
            continue
        scr = capture(s["pane"], 40)
        tail = "\n".join([l for l in scr.splitlines() if l.strip()][-14:])
        s["screen_tail"] = tail
        if s["kind"] == "claude" and not claude_info(s["id"]):
            # a terminal that only shows a background agent (its name sits in the prompt border)
            m = re.findall(r"─ ([\w.-]{3,}) ─+\s*$", scr, re.M)
            if m:
                s["name"] = f"terminal → {m[-1]}"
                s["viewer_of"] = m[-1]
        h = hashlib.md5(scr.encode()).hexdigest()
        prev = _PANE_HASH.get(s["pane"])
        if not prev:
            _PANE_HASH[s["pane"]] = (h, 0)  # first sight: don't treat as "just changed"
        elif prev[0] != h:
            _PANE_HASH[s["pane"]] = (h, now())
        changed_ago = now() - _PANE_HASH[s["pane"]][1]
        if PERM_RE.search(tail):
            s["status"] = "permission"
        elif s["kind"] == "codex":
            ready = re.search(r"· Ready\b|Ask Codex to do anything", "\n".join(tail.splitlines()[-4:]))
            s["status"] = "busy" if (BUSY_RE.search(tail) or (changed_ago < 4 and not ready)) else "idle"
            m = re.findall(r"^› (?!Ask Codex)(.+)$", scr, re.M)
            if m:
                s["last_prompt"] = m[-1].strip()[:200]
                hit = codex_match(s["last_prompt"])
                if hit:
                    s["id"] = hit["id"]
                    s["key"] = f"codex:{hit['id']}"
                    s["name"] = hit["title"] or s["name"]
            if s["name"].startswith("codex @") and s["last_prompt"]:
                s["name"] = s["last_prompt"][:48]
            s["updated"] = _PANE_HASH[s["pane"]][1]
    update_attention(out)
    for s in out:
        m = SMETA.get(s["key"], {})
        s["label"] = m.get("label", "")
        s["pinned"] = m.get("pinned", False)
        s["task"] = m.get("task")
        s["attention"] = ATTN.get(s["key"])
    PANE_IDS.clear()
    PANE_IDS.update(panes)
    for t in BOARD["tasks"]:  # a card's terminal: name it by the card's conversation even before the screen shows the prompt
        L = t.get("live"); sess = t.get("session") or {}
        if L and L.get("terminal") and sess.get("id"):
            for s in out:
                if s["pane"] == L["pane"] and not s["id"]:
                    s["id"], s["key"] = sess["id"], f"{sess['kind']}:{sess['id']}"
                    s["label"] = s["label"] or ""
    LIVE.update(list=out, t=now())
    track_handoffs(out)
    return out


# ---------------------------------------------------------------- hand a card to an existing session

def paste_to_pane(pane, text):
    """Type text into a pane and submit; bracketed paste keeps multi-line text as one message."""
    if "\n" in text:
        subprocess.run(["tmux", "load-buffer", "-b", "agentboard", "-"], input=text, text=True, capture_output=True)
        sh(["tmux", "paste-buffer", "-p", "-d", "-b", "agentboard", "-t", pane])
        time.sleep(0.4)
    elif text:
        sh(["tmux", "send-keys", "-t", pane, "-l", text])
        time.sleep(0.15)
    sh(["tmux", "send-keys", "-t", pane, "Enter"])


def live_for(h):
    for s in LIVE["list"]:
        if s["key"] == h.get("key") or (h.get("id") and s["id"] == h["id"]):
            return s
    for s in LIVE["list"]:
        if h.get("pane") and s["pane"] == h["pane"] and s["kind"] == h["kind"]:
            return s
    return None


def handoff_prompt(t):
    rules = user_rules(t, t["handoff"]["kind"])
    checklist = "".join(f"\n- {c['t']}" for c in t["checklist"] if not c["done"])
    return (f"Task: {t['title']}"
            + (f"\n\n{t['desc']}" if t.get("desc") else "")
            + (f"\n\nDone when:{checklist}" if checklist else "")
            + (f"\n\nRules:{rules}" if rules else ""))


def dispatch_handoffs():
    """Queued cards handed to a session: type into it when idle, or resume it headless when it isn't open."""
    resume = []
    for t in BOARD["tasks"]:
        h = t.get("handoff")
        if not h or t["archived"] or t["owner"] != "agent" or t["id"] in PROCS:
            continue
        if not (t["status"] == "queued" or (CONFIG["autopilot"] and t["status"] == "todo")):
            continue
        s = live_for(h)
        if s:
            busy = [x for x in BOARD["tasks"] if x is not t and x["status"] == "running" and (x.get("live") or {}).get("key") == s["key"]]
            if not s["pane"] or s["status"] != "idle" or busy:
                if h.get("wait") != s["status"]:
                    h["wait"] = s["status"] if s["pane"] else "no terminal"
                    save_board()
                continue
            paste_to_pane(s["pane"], handoff_prompt(t))
            h.pop("wait", None)
            t["status"] = "running"
            t["session"] = {"kind": s["kind"], "id": s["id"] or h.get("id", "")}
            t["live"] = {"pane": s["pane"], "key": s["key"], "sent": now(), "busy": False}
            t["runs"].append({"id": f"r{len(t['runs']) + 1}", "agent": s["kind"], "tier": "-", "model": "live session",
                              "effort": "", "start": now(), "end": None, "exit": None, "session": t["session"]["id"],
                              "mode": "live", "workdir": s["cwd"], "branch": None, "base": None, "repo": None,
                              "result": "", "dir": "", "cost": None})
            ATTN.pop(s["key"], None)
            log_activity(t, f"↪ typed into live session {s.get('label') or s['name']} ({s['where']})")
            save_board()
        elif h.get("id"):
            resume.append(t["id"])
    return resume


PANE_IDS = set()


def codex_session_for(run):
    """A Codex terminal run's conversation: the newest rollout file started in its directory after the run began."""
    files = sorted(CODEX_SESSIONS.glob("*/*/*/*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)[:25]
    for f in files:
        if f.stat().st_mtime < run["start"] - 5:
            break
        try:
            e = parse_codex(f)
        except Exception:
            continue
        if e.get("cwd") == run["workdir"]:
            return e["id"]
    return ""


def track_handoffs(live):
    """Cards whose agent works in a terminal (a hand-off typed into an open session, or a 'run in a terminal' card):
    note the conversation id, and finish the card when the agent goes idle after working."""
    by_pane = {s["pane"]: s for s in live if s["pane"]}
    for t in BOARD["tasks"]:
        L = t.get("live")
        if not L or t["status"] != "running":
            continue
        s = by_pane.get(L["pane"])
        run = t["runs"][-1]
        sid = s["id"] if s else ""
        if not sid and L.get("terminal") and run["agent"] == "codex" and not run.get("session") and now() - L.get("lookup", 0) > 6:
            L["lookup"] = now()
            sid = codex_session_for(run)
        if sid and (t.get("session") or {}).get("id") != sid:
            t["session"] = {"kind": run["agent"] if L.get("terminal") else s["kind"], "id": sid}
            run["session"] = sid
            save_board()
        if s:
            L["key"] = s["key"]
        elif L.get("terminal") and not L["busy"] and L["pane"] in PANE_IDS:
            if PERM_RE.search("\n".join([l for l in capture(L["pane"], 40).splitlines() if l.strip()][-14:])):
                if not L.get("trust"):  # the first-run "do you trust this folder?" question: wait for the user, however long
                    L["trust"] = True
                    ATTN[f"task:{t['id']}"] = {"since": now(), "reason": "needs permission", "title": t["title"]}
                    save_json(DATA / "attention.json", ATTN)
                    save_board()
                continue
            if now() - L["sent"] < 90:
                continue  # the agent in the new window is still starting
        if L.pop("trust", None) and not (s and s["status"] == "permission"):
            ATTN.pop(f"task:{t['id']}", None)
        if s and s["status"] in ("busy", "permission"):
            if not L["busy"]:
                L["busy"] = True
                save_board()
            L.pop("idle_since", None)
            continue
        if s and not L["busy"] and now() - L["sent"] < (600 if L.get("terminal") else 120):
            continue  # not picked up yet (a new window may be waiting on the folder-trust question)
        if s and L["busy"]:
            L.setdefault("idle_since", now())
            if now() - L["idle_since"] < 4:
                continue  # a pause between steps, not the end
        finish_live(t, s)


def finish_live(t, s):
    L = t.pop("live")
    run = t["runs"][-1]
    if s and s["id"]:
        t["session"] = {"kind": s["kind"], "id": s["id"]}
        run["session"] = s["id"]
    reply = ""
    if t["session"] and t["session"]["id"]:
        msgs = conversation_all(t["session"]["kind"], t["session"]["id"])
        reply = next((m["text"] for m in reversed(msgs) if m["role"] == "assistant"), "")
    run.update(end=now(), exit=0 if s else None, result=reply[-6000:])
    commit_worktree(t, run)
    needs = question_in(reply)
    if not s and L.get("terminal") and not L["busy"]:
        t["status"], t["question"] = "failed", ""
        run["result"] = "The agent never started in the terminal window (it was closed, or the command failed)."
        log_activity(t, "✗ the terminal window closed before the agent started")
        save_board()
        return
    if needs:
        t["status"], t["question"] = "needs_me", needs
        why = "question"
        log_activity(t, f"? {t['question'][:120]}")
    else:
        t["status"], t["question"] = "review", ""
        why = "review"
        log_activity(t, "✓ session finished" if s else "session closed")
        if CONFIG.get("cross_review") and run["mode"] == "worktree":
            threading.Thread(target=cross_review, args=(t["id"],), daemon=True).start()
    ATTN.pop(L["key"], None)
    if s:
        ATTN.pop(s["key"], None)
    ATTN[f"task:{t['id']}"] = {"since": now(), "reason": why, "title": t["title"]}
    save_json(DATA / "attention.json", ATTN)
    save_board()


_STOP = set("the and for with from this that into your you are was were have has not but all any can will "
            "use using add make new fix get set run task please also more some what when then than just".split())


def _tokens(text):
    text = (text or "").lower()
    toks = {w for w in re.findall(r"[a-z][a-z0-9_]{2,}", text) if w not in _STOP}
    for run in re.findall(r"[\u4e00-\u9fff]+", text):
        toks |= {run[i:i + 2] for i in range(len(run) - 1)} or {run}
    return toks


def suggest_sessions(t, n=6, pool=False):
    """Sessions most related to a card, by word overlap with titles and prompts."""
    want = _tokens(" ".join([t["title"], t.get("desc", ""), " ".join(c["t"] for c in t["checklist"])]))
    repo = t.get("repo") or (cat_by_id(t["cat"]) or {}).get("repo") or ""
    hist = {e["key"]: e for e in history(limit=250, board_runs=True)}  # work done on another card is worth offering too
    cands = {}
    for s in LIVE["list"]:
        e = hist.get(s["key"], {})
        cands[s["key"]] = {"key": s["key"], "kind": s["kind"], "id": s["id"], "cwd": s["cwd"], "pane": s["pane"],
                           "title": s.get("label") or s["name"], "name": e.get("title") or s["name"], "live": True, "status": s["status"], "where": s["where"],
                           "updated": s["updated"] or e.get("mtime", 0),
                           "text": " ".join([s["name"], s.get("label", ""), s.get("last_prompt", ""), e.get("title", ""), e.get("first", "")])}
    for k, e in hist.items():
        if k in cands or e["hidden"] or not e["id"]:
            continue
        cands[k] = {"key": k, "kind": e["kind"], "id": e["id"], "cwd": e["cwd"], "pane": None,
                    "title": e["label"] or e["title"], "name": e["title"], "live": False, "status": "", "where": "",
                    "updated": e.get("mtime", 0), "text": " ".join([e["title"], e["label"], e["first"], e["last_prompt"]])}
    out = []
    for c in cands.values():
        text = c.pop("text")
        shared = want & _tokens(text + " " + Path(c["cwd"] or "/").name)
        if not shared and not pool:
            continue
        if pool:
            c["desc"] = re.sub(r"\s+", " ", text)[:260]
        score = len(shared) + (0.5 if c["live"] else 0) + (1 if repo and c["cwd"].startswith(repo) else 0) \
            + (0.5 if now() - (c["updated"] or 0) < 3 * 86400 else 0)
        c.update(score=round(score, 1), why=" ".join(sorted(shared, key=len, reverse=True)[:4]))
        out.append(c)
    out.sort(key=lambda c: (-c["score"], -(c["updated"] or 0)))
    return out[:n]


_PREV_STATUS = {}


def visible_panes():
    """Panes on screen right now: active pane of the active window of an attached tmux session."""
    rc, out, _ = sh(["tmux", "list-panes", "-a", "-F", "#{pane_id} #{pane_active}#{window_active}#{session_attached}"])
    return {l.split()[0] for l in out.splitlines() if rc == 0 and l.split()[1].startswith("11") and l.split()[1][2:] != "0"}


_BUSY_SINCE = {}


def update_attention(live):
    changed = False
    seen = visible_panes()
    watched = {s["viewer_of"] for s in live if s.get("viewer_of") and s["pane"] in seen}
    for s in live:
        k, st = s["key"], s["status"]
        prev = _PREV_STATUS.get(k)
        _PREV_STATUS[k] = st
        if st in ("busy", "permission"):
            _BUSY_SINCE.setdefault(k, now())
        worked = now() - _BUSY_SINCE.pop(k, now()) if st not in ("busy", "permission") else 0
        title = s.get("label") or SMETA.get(k, {}).get("label") or s["name"]
        if st == "permission":
            if ATTN.get(k, {}).get("reason") != "permission":
                ATTN[k] = {"since": now(), "reason": "permission", "title": title}
                changed = True
        elif st == "busy":
            if k in ATTN:
                del ATTN[k]
                changed = True
        elif prev in ("busy", "permission") and st != prev:
            # only real turns, and not what you're already looking at (or a terminal mirroring another agent)
            if worked >= 30 and s["pane"] not in seen and s["name"] not in watched and not s.get("viewer_of"):
                ATTN[k] = {"since": now(), "reason": "finished", "title": title}
                changed = True
    gone = [k for k in ATTN if k.startswith(("claude:", "pane:")) and k not in {s["key"] for s in live}]
    for k in gone:
        del ATTN[k]
        changed = True
    if changed:
        save_json(DATA / "attention.json", ATTN)


def live_loop():
    n = 0
    while True:
        try:
            with LOCK:
                scan_live()
            if n % 15 == 0:  # every ~30 s
                refresh_usage()
            if n % 5 == 0:  # every ~10 s, outside the lock (big transcripts are read once, then only new lines)
                refresh_card_tokens()
        except Exception as e:
            print("live scan error:", e)
        n += 1
        time.sleep(2)


# ---------------------------------------------------------------- plan usage (rate-limit windows)

USAGE = {"claude": None, "codex": None, "deepseek": None, "antigravity": None}
_PROBING = set()


def claude_usage_from(d):
    """A Claude stream-json rate_limit_event → {"windows": [...], "at": t}."""
    info = d.get("rate_limit_info") or {}
    wins = info.get("unifiedWindows") or {}
    out = [{"name": {"five_hour": "5h", "seven_day": "7d"}.get(k, k), "pct": round(100 * (v.get("utilization") or 0)),
            "resets": v.get("resetsAt")} for k, v in wins.items() if isinstance(v, dict)]
    return {"windows": out, "at": now(), "status": info.get("status")} if out else None


def claude_usage_from_logs():
    """Claude's latest usage report, read from the logs of the Claude cards that ran on this board, so the chip shows
    something right after a restart without the board having to ask Claude. Windows that have since reset are dropped."""
    files = sorted(RUNS.glob("*/*/log.jsonl"), key=lambda f: f.stat().st_mtime, reverse=True)[:25]
    for f in files:
        try:
            with open(f, "rb") as fh:
                fh.seek(max(0, f.stat().st_size - 400_000))
                tail = fh.read().decode(errors="ignore")
            for line in reversed(tail.splitlines()):
                if '"rate_limit_event"' in line:
                    u = claude_usage_from(json.loads(line))
                    if u:
                        u["at"] = f.stat().st_mtime
                        u["windows"] = [w for w in u["windows"] if not w.get("resets") or w["resets"] > now()]
                        return u if u["windows"] else None
        except Exception:
            continue
    return None


def codex_usage():
    """Latest rate_limits from Codex session logs (written by every Codex session, interactive or not)."""
    files = sorted(CODEX_SESSIONS.glob("*/*/*/*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)[:6]
    best = None
    for f in files:
        with open(f, "rb") as fh:
            fh.seek(max(0, f.stat().st_size - 400_000))
            tail = fh.read().decode(errors="ignore")
        for line in reversed(tail.splitlines()):
            if '"rate_limits"' not in line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            rl = (d.get("payload") or {}).get("rate_limits") or {}
            wins = []
            for k in ("primary", "secondary"):
                w = rl.get(k)
                if w:
                    m = w.get("window_minutes") or 0
                    wins.append({"name": "5h" if m == 300 else "7d" if m == 10080 else f"{m // 60}h",
                                 "pct": round(w.get("used_percent") or 0), "resets": w.get("resets_at")})
            if wins:
                t = f.stat().st_mtime
                if not best or t > best["at"]:
                    best = {"windows": wins, "at": t, "plan": rl.get("plan_type")}
                break
    return best


def deepseek_balance():
    """What is left on the DeepSeek account. One small read-only request to DeepSeek, only when a key is set."""
    req = urllib.request.Request("https://api.deepseek.com/user/balance", headers={"Authorization": "Bearer " + deepseek_key()})
    with urllib.request.urlopen(req, timeout=10) as r:
        j = json.load(r)
    return {"balances": [{"currency": b.get("currency", ""), "total": b.get("total_balance", "")} for b in j.get("balance_infos") or []],
            "available": bool(j.get("is_available", True)), "at": now()}


def agy_usage():
    """Antigravity's own limits, as its `/usage` command prints them (no model call). One row per limit."""
    r = subprocess.run(["agy", "-p", "/usage", "--output-format", "text"], capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL)
    rows = []
    for line in r.stdout.splitlines():
        parts = line.split("\t")
        m = re.fullmatch(r"(\d+)%", parts[2].strip()) if len(parts) >= 4 else None
        if m:
            rows.append({"group": parts[0].strip(), "limit": parts[1].strip(), "left": int(m.group(1)), "reset": parts[3].strip()})
    if not rows:
        raise ValueError("no usage rows")
    return {"rows": rows, "at": now()}


def refresh_usage():
    try:
        USAGE["codex"] = codex_usage() or USAGE["codex"]
    except Exception as e:
        print("codex usage error:", e)
    # Claude's usage is only learned from the Claude cards you run: the board makes no Claude calls of its own
    c = USAGE["claude"]
    if not c or now() - c["at"] > 120:
        USAGE["claude"] = claude_usage_from_logs() or c
    a = USAGE["antigravity"]
    if shutil.which("agy") and (not a or now() - a["at"] > 300):
        try:
            USAGE["antigravity"] = agy_usage()
        except Exception as e:
            print("antigravity usage error:", type(e).__name__)
            USAGE["antigravity"] = {**(a or {"rows": []}), "at": now() - 240}
    d = USAGE["deepseek"]
    if deepseek_key() and (not d or now() - d["at"] > 300):
        try:
            USAGE["deepseek"] = deepseek_balance()
        except Exception as e:
            print("deepseek balance error:", type(e).__name__)
            USAGE["deepseek"] = {**(d or {"balances": []}), "at": now() - 240}  # try again in a minute


def default_tmux_session():
    if CONFIG.get("tmux_session"):
        return CONFIG["tmux_session"]
    counts = {}
    for s in LIVE["list"]:
        if s.get("where"):
            n = s["where"].split(":")[0]
            counts[n] = counts.get(n, 0) + 1
    counts.pop("agentboard", None)  # the board's own session: agents in it could not be typed into
    if counts:
        return max(counts, key=counts.get)
    panes = [p for p in tmux_panes() if p["session"] != "agentboard"]
    return panes[0]["session"] if panes else None  # none: a session called "agents" is created


def tmux_new_window(cmd, cwd, name):
    target = default_tmux_session()
    cwd = cwd if cwd and Path(cwd).is_dir() else str(HOME)
    if target:
        args = ["tmux", "new-window", "-t", f"{target}:", "-n", name[:24], "-c", cwd, cmd]
    else:
        args = ["tmux", "new-session", "-d", "-s", "agents", "-n", name[:24], "-c", cwd, cmd]
    rc, out, err = sh(args)
    if rc:
        raise RuntimeError(err.strip() or "tmux failed")
    return target or "agents"


def tmux_focus(pane):
    sh(["tmux", "select-window", "-t", pane])
    sh(["tmux", "select-pane", "-t", pane])
    sh(["tmux", "switch-client", "-t", pane])


# ---------------------------------------------------------------- history (past sessions)

_HIST_CACHE = {}  # path -> (mtime, entry)


def _tail_lines(path, nbytes=400_000):
    size = path.stat().st_size
    with path.open("rb") as f:
        if size > nbytes:
            f.seek(size - nbytes)
            f.readline()
        return f.read().decode("utf-8", "replace").splitlines()


def _head_lines(path, n=40):
    out = []
    with path.open("rb") as f:
        for _ in range(n):
            l = f.readline()
            if not l:
                break
            out.append(l.decode("utf-8", "replace"))
    return out


def _text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")
    return ""


def parse_claude(path):
    entry = {"kind": "claude", "id": path.stem, "path": str(path), "mtime": path.stat().st_mtime,
             "size": path.stat().st_size, "title": "", "cwd": "", "first": "", "last_prompt": "",
             "last_reply": "", "model": "", "cost": None}
    for l in _head_lines(path, 60):
        try:
            d = json.loads(l)
        except Exception:
            continue
        entry["cwd"] = entry["cwd"] or d.get("cwd", "")
        if d.get("type") == "user" and not entry["first"] and not d.get("isMeta"):
            txt = _text_of(d.get("message", {}).get("content"))
            if txt and not txt.startswith("<"):
                entry["first"] = txt[:200]
    for l in _tail_lines(path):
        try:
            d = json.loads(l)
        except Exception:
            continue
        t = d.get("type")
        if t in ("ai-title", "custom-title"):
            entry["title"] = d.get("customTitle") or d.get("aiTitle") or entry["title"]
        elif t == "last-prompt":
            entry["last_prompt"] = (d.get("lastPrompt") or "")[:200]
        elif t == "assistant":
            m = d.get("message", {})
            txt = _text_of(m.get("content"))
            if txt.strip():
                entry["last_reply"] = txt[-300:]
            entry["model"] = m.get("model", entry["model"])
        elif t == "cost-state":
            entry["cost"] = d.get("totalCostUSD")
    entry["title"] = entry["title"] or entry["first"][:60] or entry["id"][:8]
    return entry


_CODEX_NAMES = {"t": 0, "map": {}}


def codex_names():
    if CODEX_INDEX.exists() and CODEX_INDEX.stat().st_mtime != _CODEX_NAMES["t"]:
        m = {}
        for l in CODEX_INDEX.read_text().splitlines():
            try:
                d = json.loads(l)
                m[d["id"]] = d.get("thread_name", "")
            except Exception:
                pass
        _CODEX_NAMES.update(t=CODEX_INDEX.stat().st_mtime, map=m)
    return _CODEX_NAMES["map"]


def parse_codex(path):
    entry = {"kind": "codex", "id": "", "path": str(path), "mtime": path.stat().st_mtime,
             "size": path.stat().st_size, "title": "", "cwd": "", "first": "", "last_prompt": "",
             "last_reply": "", "model": "", "cost": None}
    for l in _head_lines(path, 5):
        try:
            d = json.loads(l)
        except Exception:
            continue
        if d.get("type") == "session_meta":
            p = d["payload"]
            entry["id"] = p.get("id", "")
            entry["cwd"] = p.get("cwd", "")
            break
    if not entry["id"]:
        m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", path.name)
        entry["id"] = m.group(1) if m else path.stem
    for l in _tail_lines(path):
        try:
            d = json.loads(l)
        except Exception:
            continue
        p = d.get("payload") or {}
        if d.get("type") == "event_msg" and p.get("type") == "task_complete":
            entry["last_reply"] = (p.get("last_agent_message") or "")[-300:]
        elif d.get("type") == "event_msg" and p.get("type") == "item_completed":
            it = p.get("item", {})
            if it.get("type") == "UserMessage":
                entry["last_prompt"] = _text_of(it.get("content"))[:200]
        elif d.get("type") == "turn_context":
            entry["model"] = p.get("model", entry["model"])
    entry["title"] = codex_names().get(entry["id"]) or entry["last_prompt"][:60] or entry["id"][:8]
    return entry


_CODEX_RECENT = {"t": 0, "list": []}


def codex_match(prompt):
    """Find the Codex rollout whose last user prompt matches what a live pane shows."""
    if now() - _CODEX_RECENT["t"] > 20:
        files = sorted(CODEX_SESSIONS.glob("*/*/*/*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)[:60]
        lst = []
        for p in files:
            mt = p.stat().st_mtime
            c = _HIST_CACHE.get(str(p))
            if not c or c[0] != mt:
                try:
                    _HIST_CACHE[str(p)] = (mt, parse_codex(p))
                except Exception:
                    continue
            lst.append(_HIST_CACHE[str(p)][1])
        _CODEX_RECENT.update(t=now(), list=lst)
    key = re.sub(r"\s+", " ", prompt)[:40]
    for e in _CODEX_RECENT["list"]:
        if key and re.sub(r"\s+", " ", e.get("last_prompt", ""))[:40] == key:
            return e
    return None


def claude_info(sid):
    """Cached title/last prompt for a Claude session id (used to name live sessions)."""
    if not sid:
        return None
    for p in CLAUDE_PROJECTS.glob(f"*/{sid}.jsonl"):
        mt = p.stat().st_mtime
        c = _HIST_CACHE.get(str(p))
        if not c or c[0] != mt:
            try:
                _HIST_CACHE[str(p)] = (mt, parse_claude(p))
            except Exception:
                return None
        return _HIST_CACHE[str(p)][1]
    return None


def session_file(kind, sid):
    if kind == "antigravity":
        f = AGY_DIR / f"{sid}.jsonl" if re.fullmatch(r"[\w-]+", sid or "") else None
        return f if f and f.is_file() else None
    if kind == "deepseek":
        return next(iter(DSH_SESSIONS.glob(f"*/{sid}/session.v4.jsonl.zstd")), None) if re.fullmatch(r"[\w-]+", sid or "") else None
    if kind == "claude":
        return next(iter(CLAUDE_PROJECTS.glob(f"*/{sid}.jsonl")), None)
    return next(iter(CODEX_SESSIONS.glob(f"*/*/*/*{sid}.jsonl")), None)


def _block_text(c):
    """The text of a Claude message: a plain string, or blocks when it carries an image."""
    return c if isinstance(c, str) else "\n".join(b.get("text", "") for b in c or [] if isinstance(b, dict) and b.get("type") == "text")


def _conv_entries(kind, d):
    """Turn one session-log record into transcript messages."""
    out = []
    if kind == "claude":
        if d.get("isMeta") or d.get("isSidechain"):
            return out
        if d.get("type") == "attachment" and (d.get("attachment") or {}).get("type") == "queued_command":
            txt = _block_text(d["attachment"].get("prompt"))
            if txt.strip() and not txt.startswith("<"):
                out.append({"role": "user", "text": txt, "note": "delivered while it was working"})
            return out
        m = d.get("message") or {}
        c = m.get("content")
        if d.get("type") == "user":
            if isinstance(c, str):
                if not c.startswith("<"):
                    out.append({"role": "user", "text": c})
                return out
            for b in c or []:
                if b.get("type") == "text" and not b.get("text", "").startswith("<"):
                    out.append({"role": "user", "text": b["text"]})
                elif b.get("type") == "tool_result" and b.get("is_error"):
                    msg = b.get("content")
                    msg = msg if isinstance(msg, str) else json.dumps(msg, ensure_ascii=False)
                    if msg.startswith("Permission to use"):
                        out.append({"role": "blocked", "text": msg.replace("Permission to use ", "", 1).replace(" has been denied.", "")[:300]})
        elif d.get("type") == "assistant":
            for b in c or []:
                if b.get("type") == "text" and b.get("text", "").strip():
                    out.append({"role": "assistant", "text": b["text"]})
                elif b.get("type") == "tool_use":
                    inp = b.get("input") or {}
                    arg = inp.get("command") or inp.get("file_path") or inp.get("description") or json.dumps(inp, ensure_ascii=False)
                    out.append({"role": "tool", "text": f"{b.get('name')}: {str(arg)[:300]}"})
    else:
        p = d.get("payload") or {}
        if d.get("type") != "response_item":
            return out
        if p.get("type") == "message" and p.get("role") in ("user", "assistant"):
            txt = " ".join(x.get("text", "") for x in p.get("content", []) if isinstance(x, dict) and x.get("text") and not re.match(r"</?image\b", x["text"]))  # Codex wraps images in tags
            if txt.strip() and not txt.lstrip().startswith("<"):
                out.append({"role": p["role"], "text": txt})
        elif p.get("type") in ("function_call", "custom_tool_call"):
            arg = p.get("input") or p.get("arguments") or ""
            out.append({"role": "tool", "text": f"{p.get('name')}: {str(arg)[:300]}"})
    return out


_CONV = {}  # path -> {"pos": bytes parsed, "msgs": [...]}
_SFILE = {}


def dsh_events(f):
    """The events of a DeepSeek session. Its log is compressed whole, so it is read again whenever the file changes."""
    from compression import zstd
    out = []
    for line in zstd.decompress(f.read_bytes()).decode(errors="ignore").splitlines():
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def dsh_conversation(f):
    msgs, seen, model = [], set(), ""
    for e in dsh_events(f):
        d, typ = e.get("data") or {}, e.get("type")
        if typ == "request/header":
            c = ((d.get("header") or {}).get("config")) or {}
            model = " · ".join(x for x in (c.get("model"), c.get("reasoningEffort")) if x) or model
        elif typ == "user/message" and (d.get("source") or {}).get("kind") == "user" and d.get("id") not in seen:
            seen.add(d.get("id"))
            txt = "\n".join(b.get("text", "") for b in d.get("content") or [] if isinstance(b, dict) and b.get("type") == "text")
            if txt.strip():
                msgs.append({"role": "user", "text": txt})
        elif typ == "assistant/message":
            for b in (d.get("message") or {}).get("content") or []:
                if b.get("type") == "text" and (b.get("text") or "").strip():
                    msgs.append({"role": "assistant", "text": b["text"]})
                elif b.get("type") == "tool-call":
                    try:
                        a = json.loads(b.get("arguments") or "{}")
                    except Exception:
                        a = {}
                    msgs.append({"role": "tool", "text": f"{b.get('name')}: {str(a.get('command') or a.get('file_path') or a.get('description') or a or '')[:300]}"})
    return msgs, model


def agy_records(f):
    out = []
    for line in f.read_text(errors="ignore").splitlines():
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def conversation_all(kind, sid):
    """All transcript messages of a session; only newly appended bytes are parsed."""
    if kind == "antigravity":
        f = session_file(kind, sid)
        if not f:
            return []
        return [{"role": r["role"], "text": r.get("text", "")} for r in agy_records(f) if r.get("role") in ("user", "assistant", "tool") and r.get("text", "").strip()]
    if kind == "deepseek":
        f = session_file(kind, sid)
        if not f:
            return []
        _SFILE[(kind, sid)] = f
        stamp = (f.stat().st_mtime_ns, f.stat().st_size)
        c = _CONV.get(str(f))
        if not c or c.get("stamp") != stamp:
            msgs, model = dsh_conversation(f)
            c = _CONV[str(f)] = {"pos": stamp[1], "stamp": stamp, "msgs": msgs, "model": model, "queue": []}
        return c["msgs"]
    f = _SFILE.get((kind, sid))
    if not f or not f.exists():
        f = session_file(kind, sid)
        if not f:
            return []
        _SFILE[(kind, sid)] = f
    size = f.stat().st_size
    c = _CONV.get(str(f))
    if not c or size < c["pos"]:
        c = _CONV[str(f)] = {"pos": 0, "msgs": []}
    if size > c["pos"]:
        with f.open("rb") as fh:
            fh.seek(c["pos"])
            data = fh.read(size - c["pos"])
        cut = data.rfind(b"\n")
        if cut >= 0:
            for line in data[:cut].split(b"\n"):
                try:
                    d = json.loads(line)
                    c["msgs"] += _conv_entries(kind, d)
                    if kind == "claude":  # messages sent while the agent works wait in Claude's queue until a step ends
                        q = c.setdefault("queue", [])  # [(time, text)]
                        gone = None
                        if d.get("type") == "queue-operation":
                            if d.get("operation") == "enqueue":
                                q.append((iso_ts(d.get("timestamp")), d.get("content") or ""))
                            elif d.get("operation") == "remove":
                                gone = d.get("content") or ""
                        elif d.get("type") == "attachment" and (d.get("attachment") or {}).get("type") == "queued_command":
                            gone = _block_text(d["attachment"].get("prompt"))
                        elif d.get("type") == "user":
                            gone = _block_text((d.get("message") or {}).get("content"))
                        if gone and d.get("type") != "queue-operation":  # the agent has it
                            c.setdefault("given", []).append((iso_ts(d.get("timestamp")), gone))
                        if gone:
                            for x in q:
                                if x[1] == gone:
                                    q.remove(x)
                                    break
                    if kind == "claude" and d.get("type") == "assistant":  # model actually in use
                        c["model"] = (d.get("message") or {}).get("model") or c.get("model")
                    elif kind == "codex" and d.get("type") == "turn_context":
                        p = d.get("payload") or {}
                        c["model"] = " · ".join(x for x in (p.get("model"), p.get("effort")) if x) or c.get("model")
                except Exception:
                    pass
            c["pos"] += cut + 1
    return c["msgs"]


_USAGE = {}   # path -> {"pos": bytes read, "ids": {message id: usage}, "codex": last total}
TOKENS = {}   # task id -> {"in", "cached", "out", "total", "sessions", "cost"}


def session_tokens(kind, sid):
    """Token totals of one conversation, read incrementally (only the usage lines are parsed).
    in = new input (incl. cache writes), cached = input read from cache, out = output."""
    f = _SFILE.get((kind, sid))
    if not f or not f.exists():
        f = session_file(kind, sid)
        if not f:
            return None
        _SFILE[(kind, sid)] = f
    size = f.stat().st_size
    if kind == "antigravity":
        u = [r for r in agy_records(f) if r.get("role") == "usage"]
        return {"in": sum(x.get("input_tokens") or 0 for x in u), "cached": sum(x.get("cache_read_tokens") or 0 for x in u), "out": sum((x.get("output_tokens") or 0) + (x.get("thinking_tokens") or 0) for x in u)}
    if kind == "deepseek":  # every reply carries its own usage
        c = _USAGE.get(str(f))
        if not c or c.get("pos") != size:
            ids = {}
            for e in dsh_events(f):
                u = (e.get("data") or {}).get("usage")
                if e.get("type") == "assistant/message" and isinstance(u, dict):
                    ids[e.get("seq")] = {"at": (e.get("time") or 0) / 1000, "input_tokens": u.get("inputTokens") or 0, "cache_creation_input_tokens": u.get("cacheWriteTokens") or 0,
                                         "cache_read_input_tokens": u.get("cacheReadTokens") or 0, "output_tokens": u.get("outputTokens") or 0}
            c = _USAGE[str(f)] = {"pos": size, "ids": ids, "codex": None, "days": []}
    c = _USAGE.get(str(f))
    if not c or size < c["pos"]:
        c = _USAGE[str(f)] = {"pos": 0, "ids": {}, "codex": None, "days": []}
    if size > c["pos"]:
        with f.open("rb") as fh:
            fh.seek(c["pos"])
            data = fh.read(size - c["pos"])
        cut = data.rfind(b"\n")
        if cut >= 0:
            for line in data[:cut].split(b"\n"):
                if kind == "claude" and b'"usage"' in line:
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    m = d.get("message") or {}
                    if m.get("usage"):  # a reply is split over several lines that repeat the same usage: count it once
                        c["ids"][m.get("id") or len(c["ids"])] = {"at": iso_ts(d.get("timestamp"))} | {k: m["usage"].get(k) or 0 for k in
                            ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")}
                elif kind == "codex" and b'"token_count"' in line:
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    info = (d.get("payload") or {}).get("info") or {}
                    if info.get("total_token_usage"):
                        u, was = info["total_token_usage"], c["codex"] or {}
                        grew = {k: max(0, (u.get(k) or 0) - (was.get(k) or 0)) for k in ("input_tokens", "cached_input_tokens", "output_tokens")}
                        c["days"].append((iso_ts(d.get("timestamp")), grew))
                        c["codex"] = u
            c["pos"] += cut + 1
    if kind in ("claude", "deepseek"):
        u = c["ids"].values()
        t = {"in": sum(x["input_tokens"] + x["cache_creation_input_tokens"] for x in u),
             "cached": sum(x["cache_read_input_tokens"] for x in u), "out": sum(x["output_tokens"] for x in u)}
    else:
        u = c["codex"] or {}
        t = {"in": (u.get("input_tokens") or 0) - (u.get("cached_input_tokens") or 0),
             "cached": u.get("cached_input_tokens") or 0, "out": u.get("output_tokens") or 0}
    return t


def progress_data():
    """Per day: cards worked on, first reaching Review, marked done and added, and the tokens of their conversations."""
    days, cards, sessions = {}, {}, set()
    def day(ts):
        return days.setdefault(date.fromtimestamp(ts).isoformat(), {"worked": {}, "finished": [], "done": [], "new": [], "tok": {"in": 0, "cached": 0, "out": 0}})
    with LOCK:
        for t in BOARD["tasks"]:
            tid = t["id"]
            cards[tid] = {"title": t["title"], "status": t["status"], "archived": t["archived"], "owner": t["owner"]}
            if t.get("created"):
                day(t["created"])["new"].append(tid)
            for r in t["runs"]:
                w = day(r["start"])["worked"]
                w[tid] = w.get(tid, 0) + 1
                if r.get("end"):
                    day(r["end"])["worked"].setdefault(tid, 0)
                if r.get("session") and r.get("agent") in AGENT_KINDS:
                    sessions.add((r["agent"], r["session"]))
            if (t.get("session") or {}).get("id"):
                sessions.add((t["session"]["kind"], t["session"]["id"]))
            for a in t["activity"]:
                if a["msg"] == "chat":
                    day(a["t"])["worked"].setdefault(tid, 0)
            if t.get("finished_at"):
                day(t["finished_at"])["finished"].append(tid)
            if t.get("done_at"):
                day(t["done_at"])["done"].append(tid)
    for s in sessions:
        c = _USAGE.get(str(_SFILE.get(s)))
        if not c:
            continue
        for at, grew in list(c["days"]):
            b = day(at)["tok"]
            b["in"] += max(0, grew["input_tokens"] - grew["cached_input_tokens"])
            b["cached"] += grew["cached_input_tokens"]
            b["out"] += grew["output_tokens"]
        for x in list(c["ids"].values()):
            b = day(x["at"])["tok"]
            b["in"] += x["input_tokens"] + x["cache_creation_input_tokens"]
            b["cached"] += x["cache_read_input_tokens"]
            b["out"] += x["output_tokens"]
    return {"days": days, "cards": cards, "today": date.today().isoformat()}


def refresh_card_tokens():
    """Per card: sum over the conversations its runs used (a linked older session counts in full)."""
    with LOCK:
        work = []
        for t in BOARD["tasks"]:
            sess = {(r["agent"], r["session"]) for r in t["runs"] if r.get("session") and r.get("agent") in AGENT_KINDS}
            if (t.get("session") or {}).get("id"):
                sess.add((t["session"]["kind"], t["session"]["id"]))
            by = {}   # Claude reports the whole conversation's cost so far on every run: a conversation counts once, at its latest value
            for r in t["runs"]:
                if r.get("cost"):
                    k = r.get("session") or r["id"]
                    by[k] = max(by.get(k, 0), r["cost"])
            cost = sum(by.values())
            work.append((t["id"], sess, cost))
    out = {}
    for tid, sess, cost in work:
        tot = {"in": 0, "cached": 0, "out": 0}
        n = 0
        for kind, sid in sess:
            try:
                u = session_tokens(kind, sid)
            except Exception:
                u = None
            if u:
                n += 1
                for k in tot:
                    tot[k] += u[k]
        if n or cost:
            out[tid] = {**tot, "total": tot["in"] + tot["cached"] + tot["out"], "sessions": n, "cost": round(cost, 4)}
    TOKENS.clear()
    TOKENS.update(out)


def conversation(kind, sid, limit=400):
    return conversation_all(kind, sid)[-limit:]


def iso_ts(x):
    try:
        return datetime.fromisoformat((x or "").replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0


def pending_queue(kind, sid, since=None):
    """Messages the user sent during the current board run that are still waiting in Claude's queue (not yet given
    to the agent). Without `since`, the start of the board run that is working on this conversation right now."""
    if kind != "claude" or not sid:
        return []
    run = next((t["runs"][-1] for t in BOARD["tasks"] if t["id"] in PROCS and t["runs"] and t["runs"][-1].get("session") == sid), None)
    if since is None:
        if not run:
            return []
        since = run["start"]
    conversation_all(kind, sid)
    f = _SFILE.get((kind, sid))
    q = (_CONV.get(str(f)) or {}).get("queue") or [] if f else []
    out = [x[1] for x in q if x[0] >= since and x[1].strip() and not x[1].startswith(("<", "/"))]  # a "/command" is never recorded as text
    if run:  # Claude's queue has no text for a message with an image: go by what the board sent
        given = claude_given(sid, since)
        out += [m for m in run.get("sent") or [] if IMAGE_RE.search(m) and m not in out and " ".join(m.split())[:19000] not in given]
    return out


def codex_took_message(tid, run, sid):
    """Has this Codex run recorded the message it was started with? It does so within a second or two, or only after
    compacting the conversation if it needs to. Reads just the end of the transcript, which can be very large."""
    if STARTED.get(tid) == run["id"]:
        return True
    f = _SFILE.get(("codex", sid)) or session_file("codex", sid)
    if not f:
        return False
    _SFILE[("codex", sid)] = f
    try:
        with open(f, "rb") as fh:
            fh.seek(max(0, f.stat().st_size - 262144))
            tail = fh.read().split(b"\n")
    except OSError:
        return False
    for line in tail:
        if b'"response_item"' not in line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get("type") == "response_item" and iso_ts(d.get("timestamp")) >= run["start"]:
            STARTED[tid] = run["id"]
            return True
    return False


def clear_queue(kind, sid):
    conversation_all(kind, sid)  # first take in what the ended run wrote last, or a copy of it looks like it's waiting in the next run
    f = _SFILE.get((kind, sid))
    if f and str(f) in _CONV:
        _CONV[str(f)]["queue"] = []


def conversation_page(kind, sid, q):
    """tail=N → last N; after=i → messages from index i; before=i&n=N → older page. Plus the model in use,
    and messages still waiting for the agent's current step to end."""
    r = _conversation_page(kind, sid, q)
    f = _SFILE.get((kind, sid))
    r["model"] = (_CONV.get(str(f)) or {}).get("model", "") if f else ""
    r["pending"] = pending_queue(kind, sid)
    return r


def _conversation_page(kind, sid, q):
    msgs = conversation_all(kind, sid)
    total = len(msgs)
    if "after" in q:
        a = int(q["after"][0])
        if a > total:
            return {"reset": True, "total": total}
        return {"total": total, "start": a, "messages": msgs[a:]}
    if "before" in q:
        b = min(int(q["before"][0]), total)
        n = int(q.get("n", ["200"])[0])
        return {"total": total, "start": max(0, b - n), "messages": msgs[max(0, b - n):b]}
    n = int(q.get("tail", ["150"])[0])
    return {"total": total, "start": max(0, total - n), "messages": msgs[-n:]}


def history(q="", limit=400, board_runs=False):
    files = [(p, "claude") for p in CLAUDE_PROJECTS.glob("*/*.jsonl")]
    files += [(p, "codex") for p in CODEX_SESSIONS.glob("*/*/*/*.jsonl")]
    files.sort(key=lambda x: x[0].stat().st_mtime, reverse=True)
    out = []
    for p, kind in files[:limit]:
        mt = p.stat().st_mtime
        c = _HIST_CACHE.get(str(p))
        if not c or c[0] != mt:
            try:
                e = parse_claude(p) if kind == "claude" else parse_codex(p)
            except Exception:
                continue
            _HIST_CACHE[str(p)] = (mt, e)
        e = dict(_HIST_CACHE[str(p)][1])
        key = f"{kind}:{e['id']}"
        m = SMETA.get(key, {})
        e.update(key=key, label=m.get("label", ""), pinned=m.get("pinned", False),
                 hidden=m.get("hidden", False), task=m.get("task"))
        if kind == "codex":
            e["title"] = codex_names().get(e["id"]) or e["title"]
        out.append(e)
    if not board_runs:
        out = [e for e in out if not e["cwd"].startswith((str(WORKTREES), str(RUNS)))]  # board runs live on their cards
    live_ids = {s["key"] for s in LIVE["list"]}
    for e in out:
        e["live"] = e["key"] in live_ids
    if q:
        ql = q.lower()
        out = [e for e in out if ql in " ".join([e["title"], e["label"], e["cwd"], e["first"],
                                                  e["last_prompt"], e["last_reply"]]).lower()]
    return out


# ---------------------------------------------------------------- triage (pick tier + agent)

TRIAGE_PROMPT = """You are a dispatcher. Classify one task for coding agents. Reply with ONLY a JSON object:
{{"tier":"S|M|L|XL","agent":"claude|codex","owner":"agent|me","reason":"<=15 words","session":0,"session_why":""}}
tier: S = trivial/mechanical (rename, small doc edit, one-line fix); M = normal single-feature or bug;
L = multi-file change, debugging, careful analysis; XL = research, architecture, math-heavy or ambiguous.
agent: codex for focused, well-specified code edits with tests; claude for research, writing, analysis,
multi-step investigation, or work needing broad context. owner: "me" if a person has to do it: a physical
action, a meeting, a purchase, or a human decision; else "agent".
session: pick the existing agent session below that should continue this task because it already did closely
related work (same project, files or topic) and its context would help; 0 = start a fresh agent.
Pick a session only when it is clearly related. If several fit, pick the most recently active one. session_why: <=12 words.
Sessions:
{sessions}
Category: {cat}
Task: {title}
Details: {desc}"""

HEUR = [
    (r"\b(rename|typo|readme|comment|format|lint|bump)\b", "S"),
    (r"\b(research|design|architecture|survey|compare|investigate|why|paper|derive)\b", "XL"),
    (r"\b(debug|refactor|optimi[sz]e|pipeline|integrat|migrat)\b", "L"),
]
HUMAN_RE = re.compile(r"\b(meet|call|email|interview|buy|order|review with|sign)\b|会|面试|采购|开会", re.I)


def heuristic_triage(t):
    text = f"{t['title']} {t.get('desc', '')}".lower()
    tier = "M"
    for pat, tr in HEUR:
        if re.search(pat, text):
            tier = tr
            break
    agent = "codex" if re.search(r"\b(test|fix|bug|function|script|cli|api)\b", text) else "claude"
    owner = "me" if HUMAN_RE.search(text) else "agent"
    return {"tier": tier, "agent": agent, "owner": owner, "checklist": [], "reason": "keyword heuristic",
            "by": "heuristic"}


def best_candidate(cands, pick, agent):
    """The session the triage suggests. Of several with the same name, the most recent: an old copy is rarely the one you mean."""
    if not 1 <= pick <= len(cands):
        return None
    c = cands[pick - 1]
    names = lambda x: {x["title"].strip(), x.get("name", x["title"]).strip()}
    c = max((x for x in cands if x["kind"] == c["kind"] and names(x) & names(c)), key=lambda x: x.get("updated") or 0)
    return c if agent in ("auto", c["kind"]) else None  # a card set to one agent doesn't get offered a session of the other


def triage_task(tid):
    with LOCK:
        t = task_by_id(tid)
        if not t:
            return
        cat = cat_by_id(t["cat"])
        cands = []
        if t["owner"] == "agent" and not (t.get("handoff") and not t["handoff"].get("auto")) and not t.get("fresh"):
            try:
                cands = suggest_sessions(t, 12, pool=True)
            except Exception as e:
                print("candidates error:", e)
        lines = "\n".join(f"{i}. [{c['kind']}{', open now' if c['live'] else ''}, {int((now() - (c['updated'] or 0)) / 86400)}d ago, "
                          f"dir {Path(c['cwd'] or '/').name}] {c['desc']}" for i, c in enumerate(cands, 1)) or "(none)"
        prompt = TRIAGE_PROMPT.format(cat=cat["name"] if cat else "", title=t["title"], desc=t.get("desc", "")[:1500], sessions=lines)
    res = None
    cfg = CONFIG["triage"]
    try:
        txt = quick_llm(prompt, 90)
        m = re.search(r"\{.*\}", txt, re.S)
        res = json.loads(m.group(0))
        assert res.get("tier") in ("S", "M", "L", "XL")
        res["by"] = getattr(QUICK, "who", "") or "?"
    except Exception:
        res = heuristic_triage(t)
    with LOCK:
        TRIAGING.discard(tid)
        t = task_by_id(tid)
        if not t:
            return
        t["triage"] = res
        if res.get("owner") == "me" and not t.get("owner_set"):
            t["owner"] = "me"
        pick = res.get("session") if "by" in res and res["by"] != "heuristic" else None
        if pick is None and cands and cands[0]["score"] >= 4:  # LLM unavailable: strong word overlap only
            pick, res["session_why"] = 1, "shares " + cands[0]["why"]
        if cands and isinstance(pick, int) and not t["runs"] and not t.get("handoff"):
            c = best_candidate(cands, pick, t["agent"])
            if c:  # only an offer: Run starts a new agent, and the card asks whether to continue this session instead
                t["suggested"] = {"key": c["key"], "kind": c["kind"], "id": c["id"], "cwd": c["cwd"], "pane": c["pane"], "title": c["title"],
                                  "updated": c.get("updated") or 0, "live": c.get("live"), "why": res.get("session_why", "")}
        log_activity(t, f"triage → {res['tier']} · {res.get('agent')} · {res.get('owner')} ({res.get('by')}): {res.get('reason', '')}")
        save_board()


def question_in(reply):
    """A question the agent left for the user: an explicit NEEDS-HUMAN line, or a final line that ends with a question mark."""
    m = re.search(r"NEEDS-HUMAN:\s*(.+)", reply or "")
    if m:
        return m.group(1).strip()
    lines = [l.strip() for l in (reply or "").strip().splitlines() if l.strip()]
    if lines and len(lines[-1]) < 400 and re.search(r"[?？][\s)\]」』”\"'*_`]*$", lines[-1]):
        return lines[-1].strip("*_` ")
    return ""


def wlen(text):
    """Visual length: CJK characters count double."""
    return sum(2 if "\u2e80" <= c <= "\u9fff" or "\uac00" <= c <= "\ud7a3" or "\uff00" <= c <= "\uffef" else 1 for c in text)


TITLE_PROMPT = """Write a short title for this to-do item: at most 40 characters (about 20 for Chinese), no trailing punctuation, no quotes. {lang} Reply with ONLY the title.

Text: {text}"""
TITLE_LANG = {"en": "Write the title in ENGLISH, because the text is English; never Chinese.",
              "zh": "Write the title in Chinese, because the text is Chinese."}


def shorten_title(tid):
    """A long title (someone typed a whole sentence) becomes a short one; the original text moves to the notes."""
    with LOCK:
        t = task_by_id(tid)
        if not t or t.get("title_edited") or wlen(t["title"]) <= 60:
            return
        full = t["title"]
    new = ""
    cjk, lat = _cjk_latin(full)
    zh = cjk > 0 and cjk / (cjk + lat) >= .15   # the title follows the language of the text, whatever the model feels like
    try:
        for _ in range(2):
            new = quick_llm(TITLE_PROMPT.format(text=full[:2000], lang=TITLE_LANG["zh" if zh else "en"]), 60).strip().strip("\"'“”「」").splitlines()[0].strip()[:60]
            if zh or not re.search(r"[\u4e00-\u9fff]", new):
                break
            new = ""   # an English text got a Chinese title: ask once more, then fall back to the first clause
    except Exception:
        pass
    if not new:  # model unavailable: cut at the first clause
        new = re.split(r"[。！？.!?\n，,：:;；]", full)[0].strip()[:40]
    if not new or new == full:
        return
    with LOCK:
        t = task_by_id(tid)
        if not t or t.get("title_edited") or t["title"] != full:
            return
        t["desc"] = full + ("\n\n" + t["desc"] if t.get("desc") else "")
        t["title"] = new
        log_activity(t, "title shortened; the full text is in the notes")
        save_board()


def start_triage(tid):
    TRIAGING.add(tid)
    threading.Thread(target=triage_task, args=(tid,), daemon=True).start()


# ---------------------------------------------------------------- running agents

TIERS = ["S", "M", "L", "XL"]


def agent_of_model(model):
    """Which CLI runs a model id: Codex for the listed Codex models and GPT-style ids, otherwise Claude."""
    m = (model or "").strip()
    if m in CONFIG["models"].get("deepseek", []) or m.startswith("deepseek"):
        return "deepseek"
    if m in CONFIG["models"].get("antigravity", []) or m.startswith("gemini-"):
        return "antigravity"
    return "codex" if m in CONFIG["models"].get("codex", []) or re.match(r"(gpt|o\d|codex)", m) else "claude"


def model_for(t, agent, tier):
    """Model and effort for a run: what the user picked on the card, else what the size (tier) maps to."""
    m = CONFIG["tiers"][tier][agent]
    pick = (t.get("model") or "").strip()
    model = pick if pick and agent_of_model(pick) == agent else m["model"]
    effort = (t.get("effort") or "").strip()
    if effort not in CONFIG["efforts"].get(agent, [effort]):  # one picked for the other agent doesn't apply here
        effort = ""
    return model, effort or m["effort"]


def effective(t):
    tri = t.get("triage") or {}
    tier = t["tier"] if t["tier"] != "auto" else tri.get("tier", "M")
    agent = t["agent"]
    if agent == "auto":
        cat = cat_by_id(t["cat"]) or {}
        default_ag = CONFIG.get("default_agent", "auto")
        if cat.get("agent", "auto") != "auto":
            agent = cat["agent"]
        elif not t.get("runs") and default_ag in AGENT_KINDS:
            agent = default_ag
        else:
            agent = tri.get("agent", default_ag if default_ag in AGENT_KINDS else "antigravity")
    # respect daily caps by swapping agents
    used = runs_today()
    cap = CONFIG["daily_cap"]
    other = "codex" if agent == "claude" else "claude"
    if t.get("model") and t["agent"] == "auto":  # a picked model decides the agent when none is set, and is never swapped away
        agent = agent_of_model(t["model"])
    elif used.get(agent, 0) >= cap.get(agent, 1e9) and used.get(other, 0) < cap.get(other, 1e9) and t["agent"] == "auto":
        agent = other
    model, effort = model_for(t, agent, tier)
    return tier, agent, model, effort


def runs_today():
    today = date.today().isoformat()
    used = {}
    for t in BOARD["tasks"]:
        for r in t["runs"]:
            if datetime.fromtimestamp(r["start"]).date().isoformat() == today:
                used[r["agent"]] = used.get(r["agent"], 0) + 1
    return used


def active_rules(t, agent):
    return [r["text"] for r in BOARD.get("rules", [])
            if r.get("on") and r.get("scope", "all") in ("all", t["cat"]) and r.get("agent", "any") in ("any", agent)]


ACCESS = ("read", "standard", "full")


def access_of(t, agent):
    a = t.get("access") or ""
    return a if a in ACCESS else CONFIG["access"].get(agent, "standard")


def access_flags(agent, level, resume=False, interactive=False):
    """Command-line flags for an access level.
    read: look but don't change anything. standard: Claude skips prompts (plus any `claude_disallowed` patterns you
    set); Codex may write only in its folder, no network. full: no limits at all."""
    if agent == "claude":
        if level == "read":
            return ["--permission-mode", "plan"] if interactive else \
                ["--permission-mode", "dontAsk", "--allowedTools", "Read", "Glob", "Grep", "LS", "WebSearch"]
        if level == "full":
            return ["--dangerously-skip-permissions"]
        if interactive:
            return []  # normal prompts: you approve each risky step
        return [*CONFIG["claude_flags"], *(["--disallowedTools", *CONFIG["claude_disallowed"]] if CONFIG["claude_disallowed"] else [])]
    if level == "full":
        return ["--dangerously-bypass-approvals-and-sandbox"]
    if interactive and level == "standard":
        return []
    sb = "read-only" if level == "read" else "workspace-write"
    return ["-c", f'sandbox_mode="{sb}"'] if resume else ["-s", sb]


def sender_card(addr):
    """Which card's agent made a request, if any: trace the connection back to its process and up to a run the board started.
    A browser, or anything else, is not an agent, so it gets None."""
    try:
        ip, port = addr[0], int(addr[1])
        key = f"{socket.inet_aton(ip)[::-1].hex().upper()}:{port:04X}"  # how /proc/net/tcp writes the client's own end
        inode = next((f[9] for f in (ln.split() for ln in Path("/proc/net/tcp").read_text().splitlines()[1:]) if f[1] == key), None)
        if not inode:
            return None
        target, pid = f"socket:[{inode}]", None
        for d in os.listdir("/proc"):
            if not d.isdigit():
                continue
            try:
                if any(os.readlink(f"/proc/{d}/fd/{fd}") == target for fd in os.listdir(f"/proc/{d}/fd")):
                    pid = int(d)
                    break
            except OSError:
                continue
        runs = {p.pid: tid for tid, p in list(PROCS.items())}
        for _ in range(60):  # up the process tree to the agent the board started
            if pid in runs:
                return runs[pid]
            if not pid or pid <= 1:
                return None
            pid = int(Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[1])
    except Exception:
        return None
    return None


def forward_reply(tid, to):
    """The answer an agent gave to another agent's message goes back to that agent. Not itself a reason to forward again."""
    with LOCK:
        t, src = task_by_id(tid), task_by_id(to)
        if not t or not src:
            return
        text = ((t["runs"][-1].get("result") if t["runs"] else "") or "").strip() or "(it finished without a written answer)"
        title = t["title"]
    try:
        handle_post(f"/api/task/{to}/action", {"action": "chat", "text": f'Reply from the "{title}" agent:\n\n{text[-6000:]}'})
    except Exception as e:
        print("could not pass an agent's reply back:", e)


def user_rules(t, agent):
    """Only rules the user wrote (📜 Rules)."""
    return "".join(f"\n- {r}" for r in active_rules(t, agent))


def rules_update(t, text):
    """Rules are handed to an agent with the card's first prompt. A rule added, changed or removed later never reached a card that was
    already talking, so the next message carries the difference (and the card remembers what its agent has been told)."""
    agent = (t.get("session") or {}).get("kind") or (t.get("agent") if t.get("agent") in AGENT_KINDS else "claude")
    now_rules, told = active_rules(t, agent), t.get("rules_sent")
    t["rules_sent"] = now_rules
    new = [r for r in now_rules if r not in (told or [])]
    gone = [r for r in (told or []) if r not in now_rules]
    if not new and not gone:
        return text
    head = ""
    if new:
        head += "The user has added or changed rules. Follow them from now on, in addition to the earlier ones:" + "".join(f"\n- {r}" for r in new) + "\n"
    if gone:
        head += "These rules no longer apply:" + "".join(f"\n- {r}" for r in gone) + "\n"
    return head + "\n" + text


def dsh_command(rdir, workdir, model, effort, access, resume_sid, prompt):
    """A card's run on DeepSeek through dst. Thinking is set per run (the default can spend a whole answer thinking), and
    the model goes in a small patch file next to the run's log."""
    (rdir / "dst.yml").write_text(f"- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: {model}\n    reasoningEffort: \"{effort}\"\n")
    mode = {"read": "read-only", "full": "danger-full-access"}.get(access, "workspace-write")
    cmd = ["dst", "run", "--cwd", workdir, "--permission-mode", mode, "--output-format", "stream-json", "--timeout", "0", "--patch", str(rdir / "dst.yml")]
    if resume_sid:
        cmd += ["--session-id", resume_sid]
    return cmd + ["--", prompt]


def agy_command(workdir, model, access, resume_sid, prompt):
    """A card's run on Antigravity (agy). Headless mode cannot ask for permission, so anything but read-only runs with permissions
    skipped: agy has no deny-list and its sandbox flag did not stop writes outside the folder, so "standard" is as open as "full"."""
    cmd = ["agy", "-p", prompt, "--model", model, "--output-format", "stream-json"]
    cmd += ["--mode", "plan"] if access == "read" else ["--dangerously-skip-permissions"]
    if resume_sid:
        cmd += ["--conversation", resume_sid]
    return cmd


def agy_log(sid, rec):
    """Append one line to the board's transcript of an Antigravity conversation."""
    AGY_DIR.mkdir(parents=True, exist_ok=True)
    with open(AGY_DIR / f"{sid}.jsonl", "a") as f:
        f.write(json.dumps({"at": now(), **rec}, ensure_ascii=False) + "\n")


def build_prompt(t, mode, feedback=None, agent="claude"):
    rules = user_rules(t, agent)
    t["rules_sent"] = active_rules(t, agent)
    if feedback is not None:
        return (feedback or "Please try again.") + (f"\n\nRules:{rules}" if rules else "")
    checklist = "\n".join(f"- [{'x' if c['done'] else ' '}] {c['t']}" for c in t["checklist"])
    return (f"Task: {t['title']}"
            + (f"\n\n{t['desc']}" if t.get("desc") else "")
            + (f"\n\nDone when:\n{checklist}" if checklist else "")
            + (f"\n\nRules:{rules}" if rules else ""))


def takeover_prompt(t, prev, feedback, agent):
    """First message for an agent that takes over a card from a different agent (it cannot resume that conversation):
    the card, what the earlier agent ended with, and the new request."""
    checklist = "\n".join(f"- [{'x' if c['done'] else ' '}] {c['t']}" for c in t["checklist"])
    rules = user_rules(t, agent)
    t["rules_sent"] = active_rules(t, agent)
    prev_res = (prev.get("result") or "").strip()[-2000:]
    return (f"Task: {t['title']}"
            + (f"\n\n{t['desc']}" if t.get("desc") else "")
            + (f"\n\nDone when:\n{checklist}" if checklist else "")
            + (f"\n\nEarlier work on this task ({prev['agent']}) ended with:\n{prev_res}" if prev_res else "")
            + (f"\n\n{feedback}" if feedback else "")
            + (f"\n\nRules:{rules}" if rules else ""))


def start_run(tid, feedback=None, tier_override=None, chat=False, handoff=False):
    with LOCK:
        t = task_by_id(tid)
        if not t or tid in PROCS:
            return
        tier, agent, model, effort = effective(t)
        if agent == "antigravity" and not shutil.which("agy"):
            log_activity(t, "✗ Antigravity needs the agy command")
            return
        if agent == "deepseek" and not (deepseek_key() and shutil.which("dst")):
            t["status"] = "failed"
            log_activity(t, "✗ DeepSeek needs your key in data/deepseek.env and the dst command")
            save_board()
            return
        if tier_override:
            tier = tier_override
            model, effort = model_for(t, agent, tier)
        prev = t["runs"][-1] if t["runs"] else None
        if (feedback is not None and not handoff and prev and prev.get("session") and prev.get("agent") in AGENT_KINDS
                and prev["agent"] != agent and t.get("agent_set_at", 0) <= prev["start"]):
            agent = prev["agent"]  # a message continues its conversation; only choosing another agent since then moves it
            model, effort = model_for(t, agent, tier)
            if t["agent"] != "auto":
                t["agent"] = agent  # the card shows who it is really talking to, so picking the other one is a real switch
        resume = feedback is not None and prev and prev.get("session") and prev["agent"] == agent
        if handoff:  # continue the chosen session in its own directory
            h = t["handoff"]
            agent = h["kind"]
            if t["agent"] != "auto":
                t["agent"] = agent
            model, effort = model_for(t, agent, tier)
            prev = {"session": h["id"], "agent": agent, "workdir": h.get("cwd") or str(HOME), "mode": "direct"}
            resume, feedback = True, None
        repo = t.get("repo") or (cat_by_id(t["cat"]) or {}).get("repo") or ""
        top = git_top(repo)
        run_id = f"r{len(t['runs']) + 1}"
        rdir = RUNS / tid / run_id
        rdir.mkdir(parents=True, exist_ok=True)
        if handoff:
            mode, workdir, branch, base = "direct", prev["workdir"], None, None
        elif prev and prev.get("workdir") and not prev.get("workdir_abandon") and Path(prev["workdir"]).is_dir() and (feedback is not None or prev.get("mode") == "worktree"):
            mode, workdir, branch, base = prev["mode"], prev["workdir"], prev.get("branch"), prev.get("base")
        elif top:
            mode = "worktree"
            branch = f"ab/{tid}"
            workdir = str(WORKTREES / tid)
            _, base, _ = sh(["git", "-C", top, "rev-parse", "HEAD"])
            base = base.strip()
            rc, _, err = sh(["git", "-C", top, "worktree", "add", "-B", branch, workdir, base])
            if rc:
                log_activity(t, f"worktree failed: {err.strip()[:200]}")
                t["status"] = "failed"
                save_board()
                return
        else:
            mode, branch, base = "direct", None, None
            workdir = repo if repo and Path(repo).is_dir() else str(rdir)
        takeover = (feedback is not None and not resume and not handoff and prev
                    and prev.get("agent") not in (None, agent))
        prompt = (takeover_prompt(t, prev, feedback, agent) if takeover
                  else feedback if chat else handoff_prompt(t) if handoff else build_prompt(t, mode, feedback, agent))
        if agent == "claude":
            # streaming input: the first message and any later ones go in on stdin, so the user can talk to it while it works
            cmd = ["claude", "-p", "--input-format", "stream-json", "--model", model, "--effort", effort, "--output-format", "stream-json",
                   "--verbose", "-n", f"ab: {t['title'][:40]}", *access_flags("claude", access_of(t, "claude"))]
            if resume:
                cmd += ["--resume", prev["session"]]
            if mode == "worktree" and top:
                cmd += ["--add-dir", workdir]
        elif agent == "antigravity":
            cmd = agy_command(workdir, model, access_of(t, "antigravity"), prev["session"] if resume else None, prompt)
            AGY_PROMPT[run_id] = prompt
        elif agent == "deepseek":
            cmd = dsh_command(rdir, workdir, model, effort, access_of(t, "deepseek"), prev["session"] if resume else None, prompt)
        else:
            base_cmd = ["codex", "exec"]
            if resume:
                base_cmd += ["resume", prev["session"]]
            cmd = base_cmd + ["--json", "-m", model, "-c", f'model_reasoning_effort="{effort}"',
                              "-o", str(rdir / "last.txt"), "--skip-git-repo-check"]
            cmd += access_flags("codex", access_of(t, "codex"), resume=bool(resume))
            if not resume:
                cmd += ["-C", workdir]
            cmd += [f"--image={f}" for f in message_images(prompt)]
            cmd += [prompt]
        if resume and agent == "claude" and not Path(workdir).exists():
            Path(workdir).mkdir(parents=True)
        run = {"id": run_id, "chat": chat, "agent": agent, "tier": tier, "model": model, "effort": effort, "start": now(),
               "end": None, "exit": None, "session": prev["session"] if resume else None, "mode": mode,
               "workdir": workdir, "branch": branch, "base": base, "repo": top, "result": "", "cost": None,
               "dir": str(rdir), "feedback": feedback, "access": access_of(t, agent),
               "prev_status": t.pop("chat_prev_status", None) if chat else None}
        t["runs"].append(run)
        t["status"] = "running"
        if not handoff and effective_run_mode(t) == "terminal" and agent not in ("deepseek", "antigravity"):  # these have no terminal mode here
            try:
                launch_terminal(t, run, agent, model, effort, prompt, workdir, prev["session"] if resume else None, rdir, mode, top)
            except Exception as e:
                run.update(end=now(), exit=1, result=f"could not open a terminal window: {e}")
                t["status"] = "failed"
                log_activity(t, f"✗ terminal: {e}")
                save_board()
            return
        log_activity(t, f"▶ {agent} {model}/{effort} ({tier}) {'resume' if resume else mode}")
        save_board()
        (rdir / "cmd.txt").write_text(shlex.join(cmd) + ("\n# first message, sent on stdin:\n" + prompt if agent == "claude" else ""))
        logf = open(rdir / "log.jsonl", "w")
        env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE")}  # a background run is not a terminal session
        if agent == "deepseek":
            env["DEEPSEEK_API_KEY"] = deepseek_key()  # in the environment only, never on the command line
        p = subprocess.Popen(cmd, cwd=workdir, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env,
                             stdin=subprocess.PIPE if agent == "claude" else subprocess.DEVNULL, start_new_session=True, bufsize=1)
        PROCS[tid] = p
        if agent == "claude":
            INPUTS[tid] = {"stdin": p.stdin, "last_write": 0, "last_event": now(), "closed": False, "pid": p.pid,
                              "phase": "working", "bg": "", "answered": 0}
            send_input(tid, prompt)
        run["pid"] = p.pid
        save_board()
    threading.Thread(target=_pump, args=(tid, run_id, p, logf, agent), daemon=True).start()


def effective_run_mode(t):
    return t.get("run_mode") if t.get("run_mode") in ("background", "terminal") else CONFIG.get("run_mode", "background")


def slots_used():
    """Agents running now: background processes plus agents working in a terminal window."""
    return len(PROCS) + sum(1 for t in BOARD["tasks"] if t.get("live") and t["status"] == "running")


def tmux_window_pane(cmd, cwd, name):
    """Open a new tmux window (without switching to it) running cmd; returns its pane id."""
    target = default_tmux_session()
    cwd = cwd if cwd and Path(cwd).is_dir() else str(HOME)
    if target:
        args = ["tmux", "new-window", "-d", "-P", "-F", "#{pane_id}", "-t", f"{target}:", "-n", name[:24], "-c", cwd, cmd]
    else:
        args = ["tmux", "new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "agents", "-n", name[:24], "-c", cwd, cmd]
    rc, out, err = sh(args)
    if rc or not out.strip():
        raise RuntimeError(err.strip() or "tmux failed")
    return out.strip()


def terminal_cmd(agent, model, effort, lvl, prompt, workdir, resume_sid, title, add_dir):
    """The interactive command for a card run. Same access level as a background run, so there are no permission prompts
    except the one-time 'trust this folder' question."""
    if agent == "claude":
        args = ["claude", prompt, "--model", model, "--effort", effort, "-n", f"ab: {title[:40]}", *access_flags("claude", lvl)]
        if resume_sid:
            args += ["--resume", resume_sid]
        if add_dir:
            args += ["--add-dir", workdir]
    else:
        flags = ["-m", model, "-c", f'model_reasoning_effort="{effort}"']
        if lvl == "full":
            flags += ["--dangerously-bypass-approvals-and-sandbox"]
        else:
            flags += ["-c", f'sandbox_mode="{"read-only" if lvl == "read" else "workspace-write"}"', "-c", 'approval_policy="never"']
        args = ["codex", "resume", resume_sid, *flags, prompt] if resume_sid else ["codex", *flags, "-C", workdir, prompt]
    return shlex.join(args) + '; echo; echo "[agent exited: this window stays open]"; exec "${SHELL:-bash}"'


def launch_terminal(t, run, agent, model, effort, prompt, workdir, resume_sid, rdir, mode, top):
    """Start (or continue) a card's agent in a tmux window instead of the background."""
    live = next((x for x in LIVE["list"] if resume_sid and x["id"] == resume_sid and x["kind"] == agent and x["pane"]), None)
    if live:  # that conversation is already open in a terminal: type the message into it
        paste_to_pane(live["pane"], prompt)
        pane, how = live["pane"], f"typed into the open terminal ({live['where']})"
    else:
        cmd = terminal_cmd(agent, model, effort, access_of(t, agent), prompt, workdir, resume_sid, t["title"], mode == "worktree" and bool(top))
        (rdir / "cmd.txt").write_text(cmd)
        pane = tmux_window_pane(cmd, workdir, f"ab:{t['title']}")
        how = "in a new terminal window"
    run.update(terminal=True, pane=pane)
    t["live"] = {"pane": pane, "key": None, "sent": now(), "busy": False, "terminal": True}
    log_activity(t, f"▶ {agent} {model}/{effort} {how}")
    save_board()


def commit_worktree(t, run):
    """Commit whatever the agent left in the card's worktree and record the diffstat."""
    if run["mode"] == "worktree":
        wd = run["workdir"]
        _, st, _ = sh(["git", "-C", wd, "status", "--porcelain"])
        if st.strip():
            sh(["git", "-C", wd, "add", "-A"])
            sh(["git", "-C", wd, *git_ident(wd), "commit", "-q", "-m", f"agentboard: {t['title'][:60]}"])
        _, stat, _ = sh(["git", "-C", wd, "diff", "--shortstat", f"{run['base']}..HEAD"])
        run["diffstat"] = stat.strip()


INPUTS = {}  # task id -> open stdin of a running Claude background run
STARTED = {}  # task id -> id of its Codex run that has begun working on its message
COMPACT_WAIT = 600  # longest an interrupt waits for compaction before stopping the run anyway (seconds)


UPLOADS = (DATA / "uploads").resolve()
IMAGE_RE = re.compile(r"\[Image: (/[^\]\n]+)\]")  # how a message refers to an image; plain text, so it survives queues and terminals
IMAGE_MIME = {"png": "image/png", "jpg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}
UPLOAD_MAX = 25 * 1024 * 1024
FILE_MAX = 200 * 1024 * 1024
INLINE_MAX = 3_700_000  # Claude's limit is 5 MB of base64; a bigger image is left for the agent to open from its path


def save_upload(data):
    kind = ("png" if data[:8] == b"\x89PNG\r\n\x1a\n" else "jpg" if data[:3] == b"\xff\xd8\xff" else "gif" if data[:4] == b"GIF8"
            else "webp" if data[:4] == b"RIFF" and data[8:12] == b"WEBP" else None)
    if not kind:
        raise ValueError("only PNG, JPEG, GIF and WebP images are supported")
    UPLOADS.mkdir(parents=True, exist_ok=True)
    f = UPLOADS / f"{hashlib.sha256(data).hexdigest()[:20]}.{kind}"
    f.write_bytes(data)
    return {"path": str(f), "name": f.name}


def clean_filename(name):
    """Keep the name the file came with (agents and people go by it), minus what would break a path or a message."""
    name = Path(re.sub(r"[\x00-\x1f\x7f/\\\[\]`*]", "_", name or "")).name.strip(" .") or "file"
    stem, ext = Path(name).stem, Path(name).suffix[:20]
    return stem.encode()[:200].decode(errors="ignore").rstrip() + ext


SOFFICE_LOCK = threading.Lock()


def word_to_pdf(f):
    """A PDF copy of a Word file, if LibreOffice is there: every agent can read a PDF, not every one can read Word."""
    pdf = f.with_suffix(".pdf")
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if f.suffix.lower() not in (".doc", ".docx") or not soffice:
        return None
    with SOFFICE_LOCK:  # its own profile, so it never touches a LibreOffice you have open
        if not pdf.exists():
            try:
                subprocess.run([soffice, "--headless", f"-env:UserInstallation=file://{UPLOADS}/.libreoffice", "--convert-to", "pdf", "--outdir", str(f.parent), str(f)],
                               capture_output=True, timeout=90)
            except Exception as e:
                print("could not make a PDF copy:", f.name, e)
    return pdf if pdf.exists() else None


def save_file(stream, n, name):
    """Any other file: kept under its own name, in a folder named after its content. The agent opens it from that path."""
    if not n:
        raise ValueError("the file is empty")
    UPLOADS.mkdir(parents=True, exist_ok=True)
    tmp, h, left = UPLOADS / f".up-{uuid.uuid4().hex}", hashlib.sha256(), n
    try:
        with open(tmp, "wb") as fh:
            while left:
                chunk = stream.read(min(1 << 20, left))
                if not chunk:
                    raise ValueError("the upload was cut off")
                h.update(chunk)
                fh.write(chunk)
                left -= len(chunk)
        d = UPLOADS / h.hexdigest()[:20]
        d.mkdir(exist_ok=True)
        f = d / clean_filename(name)
        os.replace(tmp, f)
    finally:
        tmp.unlink(missing_ok=True)
    pdf = word_to_pdf(f)
    return {"path": str(f), "name": f.name, "pdf": str(pdf) if pdf else ""}


def message_images(text):
    """The uploaded images a message refers to. Anything outside the uploads folder is just text."""
    found = (Path(x) for x in IMAGE_RE.findall(text or ""))
    return list(dict.fromkeys(f for f in found if f.parent == UPLOADS and f.suffix[1:] in IMAGE_MIME and f.is_file()))


def message_content(text):
    """What goes to Claude: the text as it is (with the image's path, so tools can use the file) plus the images themselves."""
    blocks = [{"type": "image", "source": {"type": "base64", "media_type": IMAGE_MIME[f.suffix[1:]], "data": base64.b64encode(f.read_bytes()).decode()}}
              for f in message_images(text) if f.stat().st_size <= INLINE_MAX]
    return [{"type": "text", "text": text}, *blocks] if blocks else text


def send_input(tid, text):
    """Hand a message to a running Claude background run; it reads it between steps, no interruption."""
    i = INPUTS.get(tid)
    if not i or i["closed"]:
        return False
    try:
        i["stdin"].write(json.dumps({"type": "user", "message": {"role": "user", "content": message_content(text)}}) + "\n")
        i["stdin"].flush()
        i["last_write"] = now()
        if i["phase"] != "compacting":
            i["phase"] = "working"
        t = task_by_id(tid)
        if t and t["runs"]:
            t["runs"][-1].setdefault("sent", []).append(text)
        return True
    except Exception:
        i["closed"] = True
        return False


def has_children(pid):
    try:
        return bool(pid and Path(f"/proc/{pid}/task/{pid}/children").read_text().split())
    except Exception:
        return False


def close_input_if_idle(tid, result_at):
    """After an answer: if nothing new was sent and nothing happened since, end the input so the run finishes."""
    with LOCK:
        i = INPUTS.get(tid)
        t = task_by_id(tid)
        sid = ((t or {}).get("runs") or [{}])[-1].get("session") or ((t or {}).get("session") or {}).get("id")
        # a message Claude still holds keeps the run open, but only while something is happening (never hang on it)
        waiting = bool(i and sid and now() - i["last_event"] < 60 and pending_queue("claude", sid, since=t["runs"][-1]["start"]))
        if i and t and not i["closed"] and i.get("phase") == "answered" and i.get("answered") != i.get("result_at") and has_children(i.get("pid")):
            i["answered"] = i.get("result_at")  # once per answer, so a dismissed alert stays dismissed
            ATTN[f"task:{tid}"] = {"since": now(), "reason": "replied", "title": t["title"]}
            save_json(DATA / "attention.json", ATTN)
        if i and not i["closed"] and (has_children(i.get("pid")) or waiting):  # a background command, or a message not yet handed to the agent
            threading.Timer(10.0, close_input_if_idle, args=(tid, now())).start()
            return
        if i and not i["closed"] and i["last_write"] <= result_at and i["last_event"] <= result_at + 0.01:
            i["closed"] = True
            try:
                i["stdin"].close()
            except Exception:
                pass


def link_session(tid, run_id, agent, sid):
    """Point the card at its conversation as soon as the id is known, so the chat shows progress live."""
    with LOCK:
        t = task_by_id(tid)
        run = t and next((r for r in t["runs"] if r["id"] == run_id), None)
        if run and sid:
            run["session"] = sid
            t["session"] = {"kind": agent, "id": sid}
            save_board()


def _pump(tid, run_id, p, logf, agent):
    """Follow a background run's output. Never dies early: a failed log write (e.g. disk full) or any other error
    still ends with finish_run, so the card can't get stuck in Running."""
    result, session, cost = "", None, None
    linked = False
    denied = []
    st = {"result": result, "session": session, "cost": cost, "denied": denied, "linked": linked}
    try:
        _pump_lines(tid, run_id, p, logf, agent, st)
    except Exception as e:
        print("run output reader error:", tid, e)
        st["result"] = st["result"] or f"(the board lost track of this run's output: {e})"
    finally:
        result, session, cost, denied = st["result"], st["session"], st["cost"], st["denied"]
        try:
            p.stdout.close()
        except Exception:
            pass
        code = p.wait()
        try:
            logf.close()
        except Exception:
            pass
        INPUTS.pop(tid, None)
        if denied:
            with LOCK:
                t = task_by_id(tid)
                run = t and next((r for r in t["runs"] if r["id"] == run_id), None)
                if run:
                    run["denied"] = denied[:12]
        finish_run(tid, run_id, code, result, session, cost)


def _pump_lines(tid, run_id, p, logf, agent, st):
    result, session, cost, denied, linked = st["result"], st["session"], st["cost"], st["denied"], st["linked"]
    log_ok = True
    for line in p.stdout:
        if log_ok:
            try:
                logf.write(line)
                logf.flush()
            except OSError as e:  # e.g. disk full: keep following the run, just stop writing the log
                log_ok = False
                print("run log write failed, continuing without it:", tid, e)
        try:
            d = json.loads(line)
        except Exception:
            continue
        typ = d.get("type")
        info = INPUTS.get(tid)
        if info and typ != "result":
            info["last_event"] = now()
            if typ in ("assistant", "user") or d.get("subtype") == "thinking_tokens":
                info["phase"] = "working"
            if typ == "system" and d.get("subtype") == "status":
                if d.get("status") == "compacting":
                    info["phase"] = "compacting"
                elif info["phase"] == "compacting":
                    info["phase"] = "working"
            if typ == "assistant":
                for b in (d.get("message") or {}).get("content") or []:
                    if isinstance(b, dict) and b.get("type") == "tool_use" and (b.get("input") or {}).get("run_in_background"):
                        info["bg"] = str(b["input"].get("description") or b["input"].get("command") or "")[:120]
        if agent == "antigravity":
            ev = d.get("event")
            if ev == "init":
                session = d.get("conversation_id") or session
                if session:
                    agy_log(session, {"role": "user", "text": AGY_PROMPT.pop(run_id, "")})
            elif ev == "step_update":
                su = d.get("step_update") or {}
                sid = su.get("conversation_id") or session
                if su.get("step_type") in ("agent_response", "tool"):
                    STARTED[tid] = run_id
                if su.get("step_type") == "agent_response":
                    k = su.get("step_index")
                    st.setdefault("agy_text", {})[k] = st.setdefault("agy_text", {}).get(k, "") + (su.get("text_delta") or "")
                    if su.get("state") == "DONE":
                        txt = st["agy_text"].pop(k, "").strip()
                        if txt and sid:
                            agy_log(sid, {"role": "assistant", "text": txt})
                        if sid and su.get("usage"):
                            agy_log(sid, {"role": "usage", **su["usage"]})
                elif su.get("step_type") == "tool" and su.get("state") == "DONE" and sid:
                    ti = su.get("tool_info") or {}
                    pa = ti.get("parameters") or {}
                    agy_log(sid, {"role": "tool", "text": f"{su.get('tool_name')}: {str(next(iter(pa.values()), '') if pa else '')[:300]}"})
            elif ev == "result":
                r = d.get("result") or {}
                result = r.get("response") or result
                session = r.get("conversation_id") or session
                if r.get("status") not in (None, "SUCCESS") and not result:
                    result = "Antigravity could not finish this: " + str(r.get("status"))
        elif agent == "deepseek":
            if typ == "session":
                session = d.get("sessionId")
            elif typ in ("thinking", "text", "tool_call", "tool_result"):
                STARTED[tid] = run_id
            elif typ == "result":
                result = d.get("text") or result
                session = d.get("sessionId") or session
                if d.get("ok") is False and not result:
                    result = "DeepSeek could not finish this: " + str((d.get("error") or {}).get("message") or "unknown error")
            elif typ == "error":
                result = result or f"DeepSeek stopped: {d.get('code')}: {d.get('message')}"
        elif typ == "system" and d.get("session_id"):
            session = d["session_id"]
        elif typ == "thread.started":
            session = d.get("thread_id")
        elif typ in ("item.started", "item.completed"):
            STARTED[tid] = run_id
        elif typ == "result":
            result = d.get("result") or result
            for pd in d.get("permission_denials") or []:
                ti = pd.get("tool_input") or {}
                denied.append(f"{pd.get('tool_name')}: {str(ti.get('command') or ti.get('file_path') or ti)[:160]}")
            cost = d.get("total_cost_usd")
            session = d.get("session_id") or session
            if tid in INPUTS:  # finish unless the user sends something within 2 s
                at = now()
                INPUTS[tid]["last_event"] = at
                INPUTS[tid]["phase"] = "answered"
                INPUTS[tid]["result_at"] = at
                threading.Timer(2.0, close_input_if_idle, args=(tid, at)).start()
        elif typ == "item.completed" and d.get("item", {}).get("type") == "agent_message":
            result = d["item"].get("text", result)
        if typ == "rate_limit_event" and agent == "claude":
            USAGE["claude"] = claude_usage_from(d) or USAGE["claude"]
        if session and not linked:
            link_session(tid, run_id, agent, session)
            linked = True
    st.update(result=result, session=session, cost=cost, linked=linked)


def _switch_note(same_agent, carry_on):
    if carry_on:
        if same_agent:
            return "Continue from where the previous run was stopped."
        return "You are taking over this task from an earlier run that was stopped before it finished; look at the work so far and carry on."
    if same_agent:
        return "The user just switched this conversation to your model/effort. Briefly confirm you are ready and wait for the user's next instruction without making changes."
    return "The user just switched this card to you. Review the task context and earlier work above, briefly confirm you are ready, and wait for the user's next instruction without making changes."


def finish_run(tid, run_id, code, result, session, cost):
    with LOCK:
        PROCS.pop(tid, None)
        t = task_by_id(tid)
        if not t:
            return
        t.pop("interrupt_held", None)
        run = next((r for r in t["runs"] if r["id"] == run_id), None)
        if not run:
            return
        if run.get("cancelled"):   # the message was taken back before the agent started on it
            t["runs"].remove(run)
            t["status"] = run.get("prev_status") or "review"
            log_activity(t, "✕ message cancelled before the agent started")
            save_board()
            return
        last = Path(run["dir"]) / "last.txt"
        if last.exists() and last.read_text().strip():
            result = last.read_text()
        run.update(end=now(), exit=code, result=result[-6000:], cost=cost)
        run["session"] = session or run["session"]
        if run["session"] and run["agent"] == "claude":
            clear_queue("claude", run["session"])
        if run["session"]:
            t["session"] = {"kind": run["agent"], "id": run["session"]}
        commit_worktree(t, run)
        switch_now = t.pop("switch_now", False)
        send_now = t.pop("send_now", False)
        if t["status"] == "stopped" and not send_now and not switch_now:
            log_activity(t, "■ stopped")
            save_board()
            return
        if send_now or switch_now:
            carry_undelivered(t)
            if send_now and not switch_now and not t.get("queued_msgs") and last_user_message(run):  # it already had them all: the next run needs something to act on
                t["queued_msgs"] = [last_user_message(run)]
        if switch_now:
            _, ag, _, _ = effective(t)
            queued = t.pop("queued_msgs", None) or []
            same_agent = (run.get("agent") == ag)
            t["status"] = "running"
            if same_agent and run.get("session"):
                text = "\n\n".join(queued) if queued else _switch_note(True, True)
                log_activity(t, "⇄ continuing on new model/effort")
                save_board()
                threading.Thread(target=start_run, args=(tid, text), kwargs={"chat": True}, daemon=True).start()
            elif same_agent:
                log_activity(t, "⇄ restarting on new model/effort")
                save_board()
                if queued:
                    text = build_prompt(t, "direct", None, ag) + "\n\n" + "\n\n".join(queued)
                    threading.Thread(target=start_run, args=(tid, text), kwargs={"chat": True}, daemon=True).start()
                else:
                    threading.Thread(target=start_run, args=(tid,), daemon=True).start()
            else:
                note = _switch_note(False, True)
                text = (note + "\n\n" + "\n\n".join(queued)) if queued else note
                log_activity(t, f"⇄ switching to {ag}")
                save_board()
                threading.Thread(target=start_run, args=(tid, text), kwargs={"chat": True}, daemon=True).start()
            return
        if t.get("queued_msgs") and run["session"]:
            text = "\n\n".join(t.pop("queued_msgs"))
            log_activity(t, "↪ sending queued message")
            save_board()
            threading.Thread(target=start_run, args=(tid, text), kwargs={"chat": True}, daemon=True).start()
            return
        needs = question_in(result)
        if code != 0 and not result:
            t["status"] = "failed"
            log_activity(t, f"✗ exit {code}")
            if CONFIG.get("auto_escalate") and not run.get("chat") and run["tier"] != "XL" and not run.get("escalated") and not t.get("model"):
                nxt = TIERS[TIERS.index(run["tier"]) + 1]
                log_activity(t, f"↑ auto-escalate to {nxt}")
                save_board()
                threading.Thread(target=lambda: (time.sleep(1), start_run(tid, tier_override=nxt)), daemon=True).start()
                t["runs"][-1]["escalated"] = True
                return
        elif needs:
            t["status"] = "needs_me"
            t["question"] = needs
            log_activity(t, f"? {t['question'][:120]}")
            ATTN[f"task:{tid}"] = {"since": now(), "reason": "question", "title": t["title"]}
        else:
            t["status"] = "review"
            t["question"] = ""
            log_activity(t, f"✓ finished · {run.get('diffstat') or 'no diff'}")
            ATTN[f"task:{tid}"] = {"since": now(), "reason": "replied" if run.get("chat") else "review", "title": t["title"]}
        save_json(DATA / "attention.json", ATTN)
        save_board()
    if t["status"] in ("review", "needs_me") and CONFIG.get("auto_reports", True) and (".htm" in (result or "").lower() or t.get("reports")):
        threading.Thread(target=auto_publish_reports, args=(tid, run_id, result), daemon=True).start()
    if t["status"] in ("review", "needs_me") and t.get("reply_to"):
        with LOCK:
            back = t.pop("reply_to", None)
            save_board()
        threading.Thread(target=forward_reply, args=(tid, back), daemon=True).start()
    if t["status"] == "review" and CONFIG.get("cross_review") and run["mode"] == "worktree":
        threading.Thread(target=cross_review, args=(tid,), daemon=True).start()


REPORTS = ROOT / "reports"           # what the reports web page serves; one folder per project
REPORT_MAP = DATA / "reports.json"   # source path -> where its copy went, so a later run of the same report replaces it


def report_project(t, run):
    """The project folder a report goes to: the repository or work directory of the run, else the card's column."""
    base = Path(run.get("repo") or run.get("workdir") or "")
    name = base.name
    if not name or base == HOME or str(base).startswith(str(RUNS)) or str(base).startswith(str(ROOT)):
        name = t["title"]   # a card with no project directory: the card itself is the project
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return "-".join(slug.split("-")[:6]) or "misc"


def served_dir(port):
    """The folder a plain web server (python -m http.server --directory X) on this port serves, or None."""
    try:
        out = subprocess.run(["ss", "-ltnp"], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return None
    for line in out.splitlines():
        if re.search(rf":{port}\s", line):
            m = re.search(r"pid=(\d+)", line)
            if not m:
                continue
            try:
                args = Path(f"/proc/{m.group(1)}/cmdline").read_bytes().split(b"\0")
                cwd = os.readlink(f"/proc/{m.group(1)}/cwd")
            except OSError:
                continue
            if b"http.server" in args:
                a = [x.decode() for x in args]
                return Path(a[a.index("--directory") + 1] if "--directory" in a else a[a.index("-d") + 1] if "-d" in a else cwd)
    return None


def report_candidates(result, since, workdir=""):
    """HTML files the agent named in its final answer that exist, are modest in size and were written during this run.
    A card with no project directory works in the board's own run folder: a report written there counts too."""
    found, out, origin = [], [], {}
    for m in re.finditer(r"https?://[\w.-]+:(\d+)(/[^\s`'\"<>()\[\]|]+?\.html?)(?=[\s`'\"<>()\[\]|,;:]|$)", result or "", re.I):
        root = served_dir(m.group(1)) if m.group(1) != "8810" else None   # 8810 is the reports page itself
        if root:
            cand = (root / unquote(m.group(2)).lstrip("/")).resolve()
            if root.resolve() in cand.parents:
                found.append(str(cand))
                origin[str(cand)] = m.group(0).rsplit("/", 1)[0]   # where its neighbours are served, for files too large to copy
    for m in re.finditer(r"(?<![:\w/])(?:file://)?(/[^\s`'\"<>()\[\]|]+?\.html?)(?=[\s`'\"<>()\[\]|,;:]|$)", result or "", re.I):
        found.append(m.group(1))
    for raw in dict.fromkeys(found):
        try:
            f = Path(unquote(raw)).resolve(strict=True)
        except Exception:
            continue
        if origin.get(raw):
            ORIGIN_OF[str(f)] = origin[raw]
        under = lambda base: f == base or base in f.parents
        own = bool(workdir) and under(Path(workdir).resolve()) and under(RUNS)   # inside this card's own run folder
        rel = f.relative_to(Path(workdir).resolve()).parts if own else f.parts[1:]
        if (not f.is_file() or f.stat().st_size > 1_500_000 or f.stat().st_mtime < since - 5
                or not (own or under(HOME) or under(Path("/tmp"))) or under(REPORTS) or (under(ROOT) and not own)
                or any(x.startswith(".") or x in ("node_modules", "site-packages", "worktrees") or (x == "runs" and not own) for x in rel)):
            continue
        out.append(f)
    return out[:3]


ORIGIN_OF = {}   # report path -> the web address its folder is served at, when the agent named the report by that address


ASSET_MAX, ASSET_TOTAL = 8_000_000, 60_000_000


def report_assets(text, f):
    """Files a report shows by relative address (images, a video poster, a stylesheet) that sit beside it: [(relative path, file)],
    and the ones too large to copy, which keep pointing to where they are served."""
    keep, big, total, base = [], [], 0, f.parent.resolve()
    for m in re.finditer(r"""(?:src|href|poster)\s*=\s*["']([^"'#?]+?)(?:[?#][^"']*)?["']""", text, re.I):
        ref = m.group(1).strip()
        if not ref or re.match(r"[a-z][a-z0-9+.-]*:|/|#", ref, re.I) or ref.lower().endswith((".html", ".htm")):
            continue
        try:
            g = (base / unquote(ref)).resolve(strict=True)
        except Exception:
            continue
        if not g.is_file() or base not in g.parents or any(x.startswith(".") for x in g.relative_to(base).parts):
            continue
        rel = unquote(ref)
        if any(r == rel for r, _ in keep) or rel in big:
            continue
        sz = g.stat().st_size
        if sz > ASSET_MAX or total + sz > ASSET_TOTAL or len(keep) >= 80:
            big.append(rel)
        else:
            keep.append((rel, g))
            total += sz
    return keep, big


def publish_report(f, project):
    """Copy one report into reports/<project>/ as an English/Chinese switch version (as it is when that is not possible). A report that
    shows files beside it goes into a folder of its own with those files; returns (copy, switched, path under reports/)."""
    import bilingual
    text = f.read_text(errors="replace")
    keep, big = report_assets(text, f)
    origin = ORIGIN_OF.get(str(f))
    if keep or (big and origin):
        folder = REPORTS / project / re.sub(r"[^A-Za-z0-9._-]+", "-", f.stem).strip("-")
    else:
        folder = REPORTS / project
    folder.mkdir(parents=True, exist_ok=True)
    for rel, g in keep:
        d = folder / rel
        d.parent.mkdir(parents=True, exist_ok=True)
        if not d.exists() or (d.stat().st_size, int(d.stat().st_mtime)) != (g.stat().st_size, int(g.stat().st_mtime)):
            shutil.copy2(g, d)
    if origin:   # too large to copy: open them where they are served
        for rel in big:
            text = re.sub(r"""((?:src|href|poster)\s*=\s*["'])""" + re.escape(rel) + r"""(["'])""", lambda m: m.group(1) + origin + "/" + quote(rel) + m.group(2), text)
    dest = folder / f.name
    try:
        bilingual.ASK = lambda txt, to: (lambda d: "" if d.get("same") else d.get("text") or "")(translate_request({"text": txt, "to": to}))
        out = bilingual.make_bilingual(text, BL_CACHE)
        save_json(DATA / "bl_cache.json", BL_CACHE)
    except Exception as e:
        print("report translation failed:", type(e).__name__, e)
        out = None
    tmp = folder / f".publish-{uuid.uuid4().hex[:6]}"
    tmp.write_text(out or text)
    os.replace(tmp, dest)
    return dest, bool(out), dest.relative_to(REPORTS).as_posix()


BL_CACHE = load_json(DATA / "bl_cache.json", {})   # "to\0text" -> its translation, for report pieces already paid for


def write_reports_index():
    """reports/latest.html: every report the board has copied, newest first, always current. (The old hub page is built by hand
    from time to time and does not know about new folders, so this page is the one that lists them as they arrive.)"""
    rows = []
    with LOCK:
        for t in BOARD["tasks"]:
            for r in t.get("reports", []):
                rows.append((r.get("at") or 0, r.get("project") or unquote(urlparse(r["url"]).path).strip("/").split("/")[0], r["name"], r["url"], t["title"], bool(r.get("switch"))))
    rows.sort(reverse=True)
    body = "".join(
        f'<tr><td class="t">{datetime.fromtimestamp(at).strftime("%m-%d %H:%M")}</td><td>{html.escape(proj)}</td>'
        f'<td><a href="{html.escape(urlparse(url).path)}">{html.escape(name)}</a>{" <span class=sw>EN/中</span>" if sw else ""}</td><td class="c">{html.escape(card)}</td></tr>'
        for at, proj, name, url, card, sw in rows)
    page = ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Latest reports</title><style>"
            ":root{color-scheme:light dark}body{font:14px/1.5 system-ui,-apple-system,sans-serif;margin:0;padding:24px 20px;max-width:1100px;margin:auto}"
            "h1{font-size:20px;margin:0 0 4px}p{color:#667;margin:0 0 16px}table{width:100%;border-collapse:collapse}td,th{padding:7px 8px;border-bottom:1px solid #8884;text-align:left;vertical-align:top}"
            ".t{white-space:nowrap;color:#667}.c{color:#667}.sw{font-size:11px;border:1px solid #4f46e5;color:#4f46e5;border-radius:4px;padding:0 4px}a{color:#4f46e5}"
            "</style></head><body><h1>Latest reports</h1><p>Copied here by the board when an agent finishes a report, newest first. "
            "<a href=\"/\">All reports</a></p><table><tr><th>When</th><th>Project</th><th>Report</th><th>Card</th></tr>" + body + "</table></body></html>")
    tmp = REPORTS / f".latest-{uuid.uuid4().hex[:6]}"
    tmp.write_text(page)
    os.replace(tmp, REPORTS / "latest.html")
    sync_hub(rows)


HUB_LOCK = threading.Lock()
HUB_SOURCE = DATA / "hub-source.html"   # the hub page before the English/Chinese switch is added to it


def sync_hub(rows):
    """Register board-copied reports into the Reports Hub manifest (:8810 / reports_manifest.json)."""
    import reports_manifest
    for at, proj, name, url, card, sw in rows:
        rel = unquote(urlparse(url).path).lstrip("/")
        f = REPORTS / rel
        if not f.is_file():
            continue
        try:
            m = re.search(r"<title>(.*?)</title>", f.read_text(errors="replace")[:20000], re.S | re.I)
        except OSError:
            continue
        title = html.unescape(re.sub(r"\s+", " ", m.group(1)).strip()) if m and m.group(1).strip() else name
        try:
            reports_manifest.upsert_report({
                "project": proj,
                "title": title[:120],
                "href": rel,
                "desc": f"Copied by the board from card “{card[:60]}”",
                "kind": "HTML",
                "switched": bool(sw),
            })
        except Exception as e:
            print("manifest sync failed:", type(e).__name__, e)


def auto_publish_reports(tid, run_id, result):
    """After a run: copy the reports it wrote to the reports page (switch version), note them on the card. A report this card
    published before is copied again whenever its original has changed since, even if the agent does not name it this time."""
    try:
        with LOCK:
            t = task_by_id(tid)
            run = t and next((r for r in t["runs"] if r["id"] == run_id), None)
            if not run or not CONFIG.get("auto_reports", True):
                return
            project = report_project(t, run)
            jobs = {str(f): (f, project) for f in report_candidates(result, run["start"], run.get("workdir") or "")}
            for old in t.get("reports", []):   # revised since it was last copied?
                f = Path(old["src"])
                try:
                    st = f.stat()
                except OSError:
                    continue
                if (st.st_mtime, st.st_size) != (old.get("mtime"), old.get("size")) and st.st_size <= 1_500_000 and str(f) not in jobs:
                    ORIGIN_OF.setdefault(str(f), old.get("origin"))
                    jobs[str(f)] = (f, old.get("project") or project)
        base = f"http://{CONFIG['host']}:8810/"
        for f, proj in jobs.values():
            st = f.stat()
            dest, switched, rel = publish_report(f, proj)
            url = base + quote(rel)
            with LOCK:
                t = task_by_id(tid)
                if t is None:
                    return
                again = any(x["url"] == url for x in t.get("reports", []))
                t["reports"] = [x for x in t.get("reports", []) if x["url"] != url] + [
                    {"url": url, "name": f.name, "src": str(f), "project": proj, "switch": switched, "at": now(), "mtime": st.st_mtime, "size": st.st_size,
                     "origin": ORIGIN_OF.get(str(f))}]
                log_activity(t, f"📄 report {'updated on' if again else 'copied to'} the reports page{' (EN/中)' if switched else ''}: {rel}")
                save_board()
            write_reports_index()
    except Exception as e:
        print("auto report error:", type(e).__name__, e)


def cross_review(tid):
    with LOCK:
        t = task_by_id(tid)
        run = t["runs"][-1]
        reviewer = "codex" if run["agent"] == "claude" else "claude"
        diff = task_diff(t, 60000)
        checklist = "\n".join(f"- {c['t']}" for c in t["checklist"])
    m = CONFIG["tiers"]["M"][reviewer]
    prompt = (f"Review this diff for the task '{t['title']}'. Acceptance criteria:\n{checklist}\n\n"
              f"First line must be exactly PASS or FAIL. Then up to 6 short bullet points.\n\n```diff\n{diff}\n```")
    if reviewer == "claude":  # not Claude: the board's own work goes to DeepSeek or Codex
        txt = quick_llm(prompt, 600)
        reviewer = getattr(QUICK, "who", "") or "deepseek"
    else:
        lastf = RUNS / tid / "review.txt"
        sh(["codex", "exec", "-m", m["model"], "-c", f'model_reasoning_effort="{m["effort"]}"', "-s", "read-only",
            "--skip-git-repo-check", "-o", str(lastf), prompt], cwd=str(RUNS), timeout=600)
        txt = lastf.read_text() if lastf.exists() else ""
    with LOCK:
        t = task_by_id(tid)
        if not t:
            return
        verdict = "PASS" if txt.strip().upper().startswith("PASS") else ("FAIL" if txt.strip() else "?")
        t["review"] = {"by": reviewer, "verdict": verdict, "text": txt[-3000:], "t": now()}
        log_activity(t, f"review by {reviewer}: {verdict}")
        save_board()


def task_diff(t, limit=200_000):
    runs = [r for r in t["runs"] if r.get("mode") == "worktree"]
    if not runs:
        return ""
    r = runs[-1]
    if not Path(r["workdir"]).is_dir():
        return "(worktree removed)"
    _, out, _ = sh(["git", "-C", r["workdir"], "diff", f"{r['base']}..HEAD"], timeout=30)
    return out[:limit]


def drop_worktree(t):
    runs = [r for r in t["runs"] if r.get("mode") == "worktree"]
    if not runs:
        return
    r = runs[-1]
    if r.get("repo"):
        sh(["git", "-C", r["repo"], "worktree", "remove", "--force", r["workdir"]])
        sh(["git", "-C", r["repo"], "branch", "-D", r["branch"]])
    for x in t["runs"]:
        x["workdir_abandon"] = True


def compacting(tid, t):
    """Is this run compacting the conversation, so it can't work on anything yet? Claude says so. Codex says nothing:
    it just doesn't record the message it was started with until that is done."""
    if tid not in PROCS or not t["runs"]:
        return False
    if tid in INPUTS:
        return INPUTS[tid]["phase"] == "compacting"
    run = t["runs"][-1]
    sid = run.get("session")
    return run["agent"] == "codex" and bool(sid) and now() - run["start"] >= 5 and not codex_took_message(tid, run, sid)


def claude_given(sid, since):
    """Everything the Claude transcript shows the agent was given since `since`, whitespace-normalized."""
    conversation_all("claude", sid)
    f = _SFILE.get(("claude", sid))
    given = (_CONV.get(str(f)) or {}).get("given") or [] if f else []
    return " ".join(" ".join(x[1].split()) for x in given if x[0] >= since)


def carry_undelivered(t):
    """After a run was stopped: whatever it was sent but never took goes first in the next run. Only reliable once the
    process is dead, because a message sent just before the interrupt reaches the transcript late or not at all."""
    run = t["runs"][-1] if t["runs"] else None
    sid = run and (run.get("session") or (t.get("session") or {}).get("id"))
    if not sid:
        return
    waiting = []
    if run["agent"] == "claude":
        given = claude_given(sid, run["start"])
        waiting = [m for m in run.get("sent") or [] if not m.startswith(("/", "<", RESTART_NOTE)) and " ".join(m.split())[:19000] not in given]
    elif run.get("feedback") and not run["feedback"].startswith(RESTART_NOTE) and not codex_took_message(t["id"], run, sid):
        waiting = [run["feedback"]]
    queued = t.get("queued_msgs") or []
    if waiting or queued:
        t["queued_msgs"] = [w for w in waiting if w not in queued] + queued


def last_user_message(run):
    """The newest message the user sent this run. The first thing a task's own run is sent is the card, not a message."""
    sent = run.get("sent") or ([run["feedback"]] if run.get("feedback") else [])
    sent = [m for m in (sent if run.get("chat") else sent[1:]) if not m.startswith(("/", "<", RESTART_NOTE))]
    return sent[-1] if sent else None


def stop_to_send(t, tid, note="⚡ interrupted to send a message"):
    t.pop("interrupt_held", None)
    t["send_now"] = True
    t["status"] = "stopped"
    stop_run(tid)
    log_activity(t, note)
    save_board()
    return {"interrupted": True}


def interrupt_to_send(t, tid):
    """Stop the run so the waiting messages go next. Not during compaction: the next run would have to start it again
    from zero, so stopping can't bring an answer sooner. The interrupt then fires as soon as compaction is done."""
    if not compacting(tid, t):
        return stop_to_send(t, tid)
    if not t.get("interrupt_held"):
        t["interrupt_held"] = now()
        log_activity(t, "⚡ interrupt waits until compaction is done")
        threading.Thread(target=hold_interrupt, args=(tid, t["runs"][-1]["id"]), daemon=True).start()
    save_board()
    return {"held": True}


def hold_interrupt(tid, run_id):
    deadline = now() + COMPACT_WAIT
    while True:
        time.sleep(1)
        with LOCK:
            t = task_by_id(tid)
            if not t or tid not in PROCS or not t["runs"] or t["runs"][-1]["id"] != run_id or not t.get("interrupt_held"):
                return
            if now() >= deadline:  # something else is holding it up: stop it after all
                stop_to_send(t, tid, "⚡ interrupted to send a message (still not started after waiting)")
                return
            if not compacting(tid, t):
                stop_to_send(t, tid)
                return


RESTART_PENDING = {}   # set while the board waits for its agents to finish before restarting itself


def busy_cards():
    """Titles of the cards whose agent is still working. A run that has given its final answer, has no command still running and has
    been quiet for 20 s does not count (it only waits to be talked to)."""
    with LOCK:
        snap = [(t["title"][:30], (t["runs"][-1] if t["runs"] else {})) for t in BOARD["tasks"]
                if t["status"] == "running" and not t.get("archived") and not t.get("live")]
    out = []
    for title, r in snap:
        pid, log, last, idle = r.get("pid"), os.path.join(r.get("dir") or "", "log.jsonl"), None, 0
        kids = has_children(pid)
        try:
            with open(log, errors="ignore") as f:
                f.seek(max(0, os.path.getsize(log) - 2_000_000))
                for line in f:
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    if d.get("type") in ("assistant", "user", "result"):
                        last = d["type"]
            idle = now() - os.path.getmtime(log)
        except Exception:
            pass
        if not (last == "result" and not kids and idle > 20):
            out.append(title)
    return out


def restart_when_quiet():
    quiet, end = 0, now() + 12 * 3600
    while RESTART_PENDING and now() < end:
        b = busy_cards()
        RESTART_PENDING["busy"] = b
        quiet = quiet + 1 if not b else 0
        if quiet >= 2:  # quiet for two checks in a row
            RESTART_PENDING.clear()
            subprocess.Popen(["sh", "-c", f"sleep 1; exec '{ROOT / 'ab'}' restart"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
            return
        time.sleep(5)
    RESTART_PENDING.clear()


def daily_today():
    """The day the Today list is on. It changes at day_start_hour (default 4 am), not at midnight, so what you check off at 1 am
    still counts for the day you are in."""
    return (datetime.now() - timedelta(hours=CONFIG.get("day_start_hour", 4))).date()


def daily_view():
    """The Today list as of now. An item is open from the first day it was due after it was last done, and stays open (counting the days
    missed) until it is checked: nothing quietly resets. Repeating items (once = false): days = weekdays it repeats on (0 = Monday),
    empty = every day. A one-off item (once = true) is gone the day after you check it."""
    today, out = daily_today(), []
    for it in BOARD.get("daily", []):
        days = it.get("days") or []
        once = bool(it.get("once"))
        try:
            last = date.fromisoformat(it.get("last_done") or "")
        except ValueError:
            last = None
        made = (datetime.fromtimestamp(it.get("created") or now()) - timedelta(hours=CONFIG.get("day_start_hour", 4))).date()
        if once:   # due once: from the day it was made until it is checked
            due = 0 if last else max(1, (today - made).days + 1)
            sched = True
            out.append({"id": it["id"], "text": it["text"], "days": [], "once": True, "done_today": last == today, "open": due > 0,
                        "missed": max(0, due - 1), "sched_today": True, "last_done": it.get("last_done") or ""})
            continue
        start = max((last or made - timedelta(days=1)) + timedelta(days=1), today - timedelta(days=400))
        due, d = 0, start
        while d <= today:
            if not days or d.weekday() in days:
                due += 1
            d += timedelta(days=1)
        sched = not days or today.weekday() in days
        out.append({"id": it["id"], "text": it["text"], "days": days, "once": False, "done_today": last == today, "open": due > 0,
                    "missed": max(0, due - (1 if sched else 0)), "sched_today": sched, "last_done": it.get("last_done") or ""})
    return out


def daily_action(body):
    a, items = body.get("action"), BOARD["daily"]
    it = next((x for x in items if x["id"] == body.get("id")), None)
    if a == "add":
        text = str(body.get("text") or "").strip()[:200]
        if not text:
            raise ValueError("empty item")
        days = sorted({int(d) for d in body.get("days") or [] if str(d).isdigit() and 0 <= int(d) <= 6})
        items.append({"id": uuid.uuid4().hex[:6], "text": text, "days": [] if len(days) == 7 else days, "created": now(), "last_done": "", "prev_done": "",
                      "once": not body.get("repeat")})   # a new item is a one-off unless you say it repeats
    elif it is None:
        raise ValueError("no such item")
    elif a == "done":
        if it.get("last_done") != daily_today().isoformat():
            it["prev_done"] = it.get("last_done") or ""
        it["last_done"] = daily_today().isoformat()
    elif a == "undo":   # un-check: back to how it was before (so a rolled-over item is open again)
        it["last_done"], it["prev_done"] = it.get("prev_done") or "", ""
    elif a == "patch":
        if "text" in body and str(body["text"]).strip():
            it["text"] = str(body["text"]).strip()[:200]
        if "days" in body:
            days = sorted({int(d) for d in body["days"] or [] if str(d).isdigit() and 0 <= int(d) <= 6})
            it["days"] = [] if len(days) == 7 else days
        if "repeat" in body:
            it["once"] = not body["repeat"]
    elif a == "delete":
        items.remove(it)
    else:
        raise ValueError("bad action")
    save_board()


def cancel_message(t, tid, text):
    norm = lambda v: re.sub(r"\s+", " ", v or "").strip()
    want, q = norm(text), t.get("queued_msgs") or []
    for i, m in enumerate(q):
        if want and norm(m).endswith(want):
            q.pop(i)
            if norm(m) != want:
                t.pop("rules_sent", None)   # a rules note went along with it: send it with the next message
            if not q:
                t.pop("queued_msgs", None)
            log_activity(t, "✕ queued message cancelled")
            return
    run = t["runs"][-1] if t["runs"] else None
    if (want and run and tid in PROCS and run.get("chat") and not run.get("end") and run["agent"] != "claude"
            and norm(run.get("feedback")).endswith(want) and STARTED.get(tid) != run["id"]):
        run["cancelled"] = True   # finish_run drops this run and puts the card back as it was
        stop_run(tid)
        return
    raise ValueError("it was already sent")


def stop_run(tid):
    p = PROCS.get(tid)
    if p:
        try:
            os.killpg(p.pid, signal.SIGTERM)
        except Exception:
            pass


def approve(t, merge=True):
    runs = [r for r in t["runs"] if r.get("mode") == "worktree"]
    if runs and merge:
        r = runs[-1]
        top, wd, br = r["repo"], r["workdir"], r["branch"]
        rc, out, err = sh(["git", "-C", top, *git_ident(top), "merge", "--no-ff", "-m", f"agentboard: {t['title'][:60]}", br])
        if rc:
            sh(["git", "-C", top, "merge", "--abort"])
            msg = (err or out).strip()[:300]
            t["merge_error"] = msg
            log_activity(t, "merge conflict: " + msg[:120])
            save_board()
            raise RuntimeError("merge failed (branch kept): " + msg)
        t["merge_error"] = ""
        sh(["git", "-C", top, "worktree", "remove", "--force", wd])
        sh(["git", "-C", top, "branch", "-d", br])
        log_activity(t, f"merged {br} into {Path(top).name}")
    elif runs:
        log_activity(t, f"done; branch {runs[-1]['branch']} kept")
    t["status"] = "done"
    t["done_at"] = now()
    ATTN.pop(f"task:{t['id']}", None)
    save_json(DATA / "attention.json", ATTN)


def runner_loop():
    while True:
        time.sleep(3)
        try:
            with LOCK:
                resume = dispatch_handoffs()
                running = slots_used()
                free = max(0, CONFIG["max_parallel"] - running)
                for tid in resume[:free]:
                    task_by_id(tid)["handoff"].pop("wait", None)
                    start_run(tid, handoff=True)
                for tid in resume[free:]:  # say why it hasn't started
                    h = task_by_id(tid)["handoff"]
                    if h.get("wait") != "slot":
                        h["wait"] = "slot"
                        save_board()
                running = slots_used()
                if running >= CONFIG["max_parallel"]:
                    continue
                cats = [c["id"] for c in BOARD["categories"]]
                busy_per_cat = {}
                for t in BOARD["tasks"]:
                    if t["status"] in ("running", "review") and not t["archived"]:
                        busy_per_cat[t["cat"]] = busy_per_cat.get(t["cat"], 0) + 1
                cand = []
                for t in BOARD["tasks"]:
                    if t["archived"] or t["owner"] != "agent" or t["id"] in TRIAGING or t.get("handoff"):
                        continue
                    queued = t["status"] == "queued"
                    if not (queued or (CONFIG["autopilot"] and t["status"] == "todo")):
                        continue
                    c = cat_by_id(t["cat"]) or {}
                    if c.get("wip") and busy_per_cat.get(t["cat"], 0) >= c["wip"]:
                        continue
                    cand.append(t)
                cand.sort(key=lambda t: (t["status"] != "queued", not (t["urgent"] and t["important"]),
                                         not t["urgent"], not t["important"],
                                         cats.index(t["cat"]) if t["cat"] in cats else 99, t["order"]))
                picks = [t["id"] for t in cand[:CONFIG["max_parallel"] - running]]
            for tid in picks:
                start_run(tid)
        except Exception as e:
            print("runner error:", e)


def answered_result(run):
    """The final answer, if this run's log ends with one (the agent was done, only its process was still open)."""
    try:
        with open(Path(run["dir"]) / "log.jsonl", errors="ignore") as f:
            f.seek(max(0, os.path.getsize(f.name) - 2_000_000))
            last = None
            for line in f:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if d.get("type") in ("assistant", "user"):
                    last = None
                elif d.get("type") == "result":
                    last = d.get("result") or ""
        return last
    except Exception:
        return None


RESTART_NOTE = "(The board restarted and stopped your last step. Please continue where you left off.)"


def recover_on_boot():
    resend = []
    for t in BOARD["tasks"]:
        if t["status"] != "running" or t.get("live"):
            continue
        run = t["runs"][-1] if t["runs"] else {}
        pid = run.get("pid")
        try:  # an agent left over from the previous server has no one reading its output: stop it
            if pid and any(x in Path(f"/proc/{pid}/cmdline").read_bytes() for x in (b"claude", b"codex", b"dst\x00run", b"agy\x00")):
                os.killpg(pid, signal.SIGTERM)
        except Exception:
            pass
        sid = run.get("session") or (t.get("session") or {}).get("id")
        t.pop("interrupt_held", None)
        carry_undelivered(t)
        done = answered_result(run) if run.get("dir") and not t.get("queued_msgs") else None
        if done is not None:  # it had already answered: nothing to continue
            run.update(end=now(), exit=0, result=done[-6000:])
            needs = question_in(done)
            t["status"], t["question"] = ("needs_me", needs) if needs else ("review", "")
            ATTN[f"task:{t['id']}"] = {"since": now(), "reason": "question" if needs else "review", "title": t["title"]}
            log_activity(t, "✓ finished (board restarted after the answer)")
        elif sid:  # continue the same conversation: with the queued message if there is one, otherwise just carry on
            run["session"] = sid
            resend.append(t["id"])
            log_activity(t, "board restarted; sending your queued message" if t.get("queued_msgs") else "board restarted; continuing the agent")
        else:
            t["status"] = "failed"
            log_activity(t, "board restarted while running")
    save_board()
    save_json(DATA / "attention.json", ATTN)
    for tid in resend:
        t = task_by_id(tid)
        text = "\n\n".join(t.pop("queued_msgs", None) or []) or RESTART_NOTE
        threading.Thread(target=lambda tid=tid, text=text: (time.sleep(2), start_run(tid, text, chat=True)), daemon=True).start()


# ---------------------------------------------------------------- HTTP

def past_sessions(t):
    """Conversations this card used before its current one, newest first. They stay readable from the card's chat."""
    current, seen, out = (t.get("session") or {}).get("id"), set(), []
    for r in reversed(t["runs"]):
        sid = r.get("session")
        if sid and sid != current and sid not in seen and r.get("agent") in AGENT_KINDS:
            seen.add(sid)
            h = t.get("handoff") or {}
            out.append({"kind": r["agent"], "id": sid, "cwd": r.get("workdir") or "", "title": h.get("title", "") if h.get("id") == sid else ""})
    return out


def public_state():
    with LOCK:
        tasks = []
        for t in BOARD["tasks"]:
            if t["archived"] and now() - t["updated"] > 7 * 86400:
                continue
            d = dict(t)
            d["activity"] = t.get("activity", [])[-12:]
            d["runs"] = [{k: v for k, v in r.items() if k not in ("result", "sent")} | {"result": (r.get("result") or "")[-1500:]}
                         for r in t["runs"][-5:]]
            d["triaging"] = t["id"] in TRIAGING
            d["tokens"] = TOKENS.get(t["id"])
            d["past_sessions"] = past_sessions(t)
            d["live_input"] = t["id"] in INPUTS and not INPUTS[t["id"]]["closed"]
            i = INPUTS.get(t["id"])
            d["run_info"] = {"phase": i["phase"], "bg": i["bg"], "last": int(i["last_event"] / 5) * 5} if i else None
            d["compacting"] = compacting(t["id"], t)
            tier, agent, model, effort = effective(t)
            d["eff"] = {"tier": tier, "agent": agent, "model": model, "effort": effort, "custom": bool(t.get("model") or t.get("effort")), "run_mode": effective_run_mode(t)}
            tasks.append(d)
        return {
            "categories": BOARD["categories"], "tasks": tasks, "rules": BOARD["rules"], "daily": daily_view(), "live": LIVE["list"], "attention": ATTN,
            "settings": {k: CONFIG[k] for k in ("autopilot", "max_parallel", "cross_review", "auto_escalate", "agent_messaging", "auto_reports", "access", "ssh_hint", "port",
                                                 "daily_cap", "tiers", "triage", "models", "efforts", "default_agent", "run_mode")},
            "running": len(PROCS), "restart_pending": dict(RESTART_PENDING) or None, "slots": slots_used(), "today": runs_today(), "palette": PALETTE, "usage": USAGE,
        }


HL_MARKS = """"marks": a list of {"q": "...", "k": "..."} highlighting the message so a busy reader can get its important points from the highlights alone.
q: words copied character for character from the message, in its own language, without ** or ` marks. Only the key words of the point: at most 12 words, or 25 characters in Chinese. Never a whole sentence if part of it says enough.
k is one of:
- "result": a conclusion, or what was found, done or fixed
- "problem": a failure, risk, limit, warning, consequence for someone, or something not verified or not done
- "action": something the reader (not the writer) must decide, answer or do
- "fact": a value the reader may need later: a key number, name, version, date, file path, URL or command
Mark every problem and every action, even small ones. Mark the main results. Mark a fact only if the reader would come back for it.
Aim for about one mark per two sentences, in every part of the message and not only its start and end, so the highlights together are about a quarter of it. A summary does not replace them. In a very short message mark just the one key part. A note about what the writer is doing or about to do, with no finding in it, gets an empty list. Do not mark greetings, background, or explanations of how something works. Use each sentence once. Do not change any words.
"""
HL_TLDR = """"tldr": the message's bottom line in at most 3 short "- " lines, in the message's own language: what happened or the answer, the main problem if there is one, and what the reader must do if anything. Use only what the message says. Copy numbers and names exactly. No heading, no preamble.
"""
HL_V = 2  # marks saved by an older version are read again when next looked at
HL_MIN = 40  # characters; "ok" and the like have nothing to mark
TLDR_MIN = 800  # a message this long also gets a summary above it
HIGHLIGHTS = load_json(DATA / "highlights.json", {})  # hash of the message -> its marks and summary, so a message is only ever paid for once
HL_BUSY = {}  # hash -> started, or failed: not tried again for a while
HL_SLOTS = threading.Semaphore(3)


def _hl_plain(s):
    return re.sub(r"\s+", " ", s.replace("**", "").replace("`", "")).strip()


def clean_tldr(tldr, text):
    """A summary is only shown if every number in it is in the message too. It sits above the full text and never replaces it."""
    tldr = tldr.strip() if isinstance(tldr, str) else ""
    nums = lambda x: re.findall(r"\d+(?:\.\d+)?", x)
    return tldr[:800] if tldr and set(nums(tldr)) <= set(nums(text)) else ""


def clean_marks(marks, text):
    """Only words that are really in the message. If too much is marked, nothing stands out: facts go first, then results."""
    plain = _hl_plain(text)
    limit = max(.35, min(.6, 120 / max(1, len(plain))))  # a short message can be mostly its point
    keep, seen = [], set()
    for m in marks if isinstance(marks, list) else []:
        q = _hl_plain(str(m.get("q") or "")) if isinstance(m, dict) else ""
        if q and q not in seen and q in plain and m.get("k") in ("result", "problem", "action", "fact"):
            seen.add(q)
            keep.append({"q": q, "k": m["k"]})
    for k in ("fact", "result"):
        while sum(len(x["q"]) for x in keep) > limit * len(plain) and any(x["k"] == k for x in keep):
            keep.remove(max((x for x in keep if x["k"] == k), key=lambda x: len(x["q"])))
    return keep


def mark_message(key, text, marks_only=False):
    long = len(text) >= TLDR_MIN and not marks_only
    enough = len(text) // 300 if long else 0  # how many marks falls far short: the model sometimes barely marks a long reply
    ask = 'Reply with JSON only: ' + ('{"tldr": "...", "marks": [...]}\n' + HL_TLDR if long else '{"marks": [...]}\n') + HL_MARKS + "\nMESSAGE:\n"
    best = None
    with HL_SLOTS:
        for _ in range(2 if long else 1):
            try:  # no tools: whatever the message says, this call can only answer
                answer = quick_llm(ask + text, 150)
                got = json.loads(re.search(r"\{.*\}", answer, re.S).group(0))
                result = {"marks": clean_marks(got.get("marks"), text), "tldr": clean_tldr(got.get("tldr"), text) if long else "", "v": HL_V}
            except Exception as e:
                print("could not highlight a message:", e)
                continue
            if not best or len(result["marks"]) > len(best["marks"]):
                result["tldr"] = result["tldr"] or (best or {}).get("tldr", "")
                best = result
            if len(best["marks"]) >= enough and best["tldr"] or not long:
                break
    with LOCK:
        if not best:
            HL_BUSY[key] = now() + 600
            return
        HIGHLIGHTS[key] = best
        HL_BUSY.pop(key, None)
        save_json(DATA / "highlights.json", HIGHLIGHTS)


def highlight_request(text, marks_only=False):
    """Marks for a message, or pending while the fast model reads it. Failing just leaves the message as it is. marks_only: no summary
    (used for the Chinese translation of a message, which gets its own marks)."""
    key = hashlib.sha256((text + ("|marks" if marks_only else "")).encode()).hexdigest()[:20]
    saved = HIGHLIGHTS.get(key)
    if isinstance(saved, dict) and saved.get("v") == HL_V:
        return saved
    until = HL_BUSY.get(key)  # 0 while it runs, or the time a failed one may be tried again
    if len(text) < HL_MIN or (until and until > now()):
        return {"marks": []}
    if until != 0:
        HL_BUSY[key] = 0
        threading.Thread(target=mark_message, args=(key, text, marks_only), daemon=True).start()
    return {"pending": True}


TRANSLATIONS = load_json(DATA / "translations.json", {})  # hash of the English text -> its Chinese translation, so each is paid for once
TR_SLOTS = threading.Semaphore(3)
TR_PROMPT = {
    "zh": "Translate the message below into Simplified Chinese. Keep the markdown formatting, code blocks, file paths, commands, URLs, "
          "numbers, units and names of tools and people exactly as they are. Reply with the translation only, no preface.\n\nMESSAGE:\n",
    "en": "Translate the message below into clear, natural English for a coding agent that will act on it. Keep code blocks, file paths, "
          "commands, URLs, numbers, units and names exactly as they are, and do not add or drop any instruction. Reply with the translation "
          "only, no preface.\n\nMESSAGE:\n",
}


def _cjk_latin(text):
    t = re.sub(r"```.*?```", "", text, flags=re.S)
    t = re.sub(r"`[^`\n]+`", "", t)
    t = re.sub(r"\[([^\]\n]+)\]\([^)\n]+\)", r"\1", t)
    t = re.sub(r"(?:https?|file)://\S+", "", t)
    t = re.sub(r"(?:^|[\s(\['\"])(?:/[\w.\-]+){2,}", " ", t)
    return len(re.findall(r"[\u4e00-\u9fff]", t)), len(re.findall(r"[A-Za-z]", t))


def translate_request(body):
    """Chinese for a message that isn't, or English for one you wrote in Chinese. Only text that really needs it goes to the model."""
    text, to = str(body.get("text") or "")[:40000], body.get("to")
    cjk, lat = _cjk_latin(text)
    if to == "zh" and not (lat >= 25 and cjk / (cjk + lat) < .12):
        return {"text": "", "same": True}
    if to == "en" and not cjk >= 1:  # any Chinese at all, however short or buried in a long English message: "你试试" is a command
        return {"text": "", "same": True}
    if to not in ("zh", "en"):
        raise ValueError("bad language")
    key = hashlib.sha256(f"{to}\0{text}".encode()).hexdigest()[:20]
    if key in TRANSLATIONS:
        return {"text": TRANSLATIONS[key]}
    parts, cur = [], ""
    for para in text.split("\n\n"):  # long messages go in pieces so nothing is cut off or skipped
        if cur and len(cur) + len(para) > 3000: parts.append(cur); cur = ""
        cur = cur + "\n\n" + para if cur else para
    parts.append(cur)
    outs = []
    for part in parts:
        if not part.strip() or (to == "en" and not _cjk_latin(part)[0]):
            outs.append(part); continue  # a piece with no Chinese stays as it is
        with TR_SLOTS:
            o = quick_llm(TR_PROMPT[to] + part, 120)
        if not o:
            raise ValueError("could not translate right now")
        outs.append(o)
    out = "\n\n".join(outs)
    if to == "zh":  # your own outgoing text is not kept
        with LOCK:
            TRANSLATIONS[key] = out
            save_json(DATA / "translations.json", TRANSLATIONS)
    return {"text": out}


def card_summaries():
    """The bottom line of cards waiting for you, so you can decide without opening them. A short final reply is its own
    summary and costs nothing; a long one goes through the same call as the highlights, so opening it later is free."""
    while True:
        time.sleep(10)
        try:
            with LOCK:
                work = [(t["id"], t["runs"][-1]["id"], t["session"]) for t in BOARD["tasks"] if t["status"] in ("review", "needs_me") and not t["archived"]
                        and t["owner"] == "agent" and t["runs"] and (t.get("session") or {}).get("id") and t.get("tldr_run") != t["runs"][-1]["id"]]
            for tid, run_id, sess in work[:4]:
                text = next((m["text"] for m in reversed(conversation_all(sess["kind"], sess["id"])) if m["role"] == "assistant"), "")
                with LOCK:
                    t = task_by_id(tid)
                    if not t or not t["runs"] or t["runs"][-1]["id"] != run_id:
                        continue
                    if len(text) < TLDR_MIN:
                        line = re.sub(r"[*`#]", "", text).strip()[:300]
                    else:
                        r = highlight_request(text)
                        if r.get("pending"):
                            continue
                        line = r.get("tldr") or ""
                    t["tldr"], t["tldr_run"] = line, run_id
                    save_board()
        except Exception as e:
            print("card summary error:", e)


def handle_post(path, body):
    with LOCK:
        if path == "/api/restart" and body.get("cancel"):
            RESTART_PENDING.clear()
            return {"cancelled": True}
        if path == "/api/restart" and body.get("when_quiet"):
            if not RESTART_PENDING:
                RESTART_PENDING.update(since=now(), busy=[])
                threading.Thread(target=restart_when_quiet, daemon=True).start()
            return {"waiting": True, "busy": RESTART_PENDING.get("busy", [])}
        if path == "/api/restart":
            # ab stop kills the tmux session this server runs in, so it is started in a session of its own, a moment later
            subprocess.Popen(["sh", "-c", f"sleep 1; exec '{ROOT / 'ab'}' restart"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
            return {"restarting": True, "running": len(PROCS)}
        if path == "/api/highlight":
            return highlight_request(str(body.get("text") or ""), bool(body.get("marks_only")))
        if path == "/api/task":
            cat = body.get("cat") or BOARD["categories"][0]["id"]
            title = (body.get("title") or "").strip()
            if not title:
                raise ValueError("empty title")
            owner = body.get("owner")
            fields = {k: body[k] for k in ("urgent", "important", "due", "desc") if k in body}
            # quick-add syntax: "!" urgent, "*" important, "@me" human, "#S..#XL" tier, "codex:"/"claude:" agent
            if title.startswith("!") or " !" in title:
                fields["urgent"] = True
            if "*" in title.split()[0:1] or title.endswith(" *"):
                fields["important"] = True
            m = re.search(r"\s#(S|M|L|XL)\b", " " + title)
            if m:
                fields["tier"] = m.group(1)
            m2 = re.match(r"(codex|claude|deepseek|antigravity|agy):\s*", title, re.I)
            if m2:
                ag = m2.group(1).lower()
                fields["agent"] = "antigravity" if ag == "agy" else ag
            if re.search(r"(^|\s)@me\b", title):
                owner = "me"
            title = re.sub(r"(^|\s)(@me|#(S|M|L|XL)|!|\*)(?=\s|$)", " ", title)
            title = re.sub(r"^(codex|claude|deepseek|antigravity|agy):\s*", "", title, flags=re.I).strip() or "untitled"
            if "agent" not in fields:
                cat_obj = cat_by_id(cat) or {}
                default_ag = CONFIG.get("default_agent", "auto")
                if cat_obj.get("agent", "auto") == "auto" and default_ag in AGENT_KINDS:
                    fields["agent"] = default_ag
            t = new_task(cat, title, **fields)
            if owner:
                t["owner"] = owner
                t["owner_set"] = True
            orders = [x["order"] for x in BOARD["tasks"] if x["cat"] == cat and not x["archived"]]
            t["order"] = (min(orders) - 1) if orders else now()
            BOARD["tasks"].append(t)
            save_board()
            if t["owner"] == "agent" or not t.get("owner_set"):
                start_triage(t["id"])
            if wlen(t["title"]) > 60:
                threading.Thread(target=shorten_title, args=(t["id"],), daemon=True).start()
            return {"id": t["id"]}

        m = re.fullmatch(r"/api/task/(\w+)", path)
        if m:
            t = task_by_id(m.group(1))
            if not t:
                raise ValueError("no task")
            old_agent = t["agent"]
            for k in ("title", "desc", "checklist", "owner", "agent", "tier", "urgent", "important", "due",
                      "labels", "repo", "status", "access", "model", "effort", "run_mode", "send_en"):
                if k in body:
                    if k == "send_en":
                        body[k] = bool(body[k])   # "Send in English" for this card
                    if k == "run_mode" and body[k] not in ("", "background", "terminal"):
                        raise ValueError("bad run mode")
                    if k in ("model", "effort"):
                        v = str(body[k] or "").strip()
                        if v and not re.fullmatch(r"[A-Za-z0-9][\w.:/\-]{0,80}", v):
                            raise ValueError(f"bad {k}")
                        body[k] = v
                        if k == "model" and v:
                            t["agent"] = agent_of_model(v)
                    if k == "owner":
                        t["owner_set"] = True
                    if k == "title":
                        t["title_edited"] = True
                    t[k] = body[k]
            if t["agent"] != old_agent:
                t["agent_set_at"] = now()  # a real switch (via agent or model pick): the next run may move to the other agent
                if (t.get("suggested") or {}).get("kind") != t["agent"] and t["agent"] != "auto":
                    t.pop("suggested", None)
                if (t.get("handoff") or {}).get("auto") and t["agent"] not in ("auto", t["handoff"]["kind"]) and t["status"] != "running":
                    t.pop("handoff")
            if ("agent" in body or t["agent"] != old_agent) and t["agent"] in AGENT_KINDS:  # a pick that belongs to the other agent no longer applies
                if "model" not in body and t.get("model") and agent_of_model(t["model"]) != t["agent"]:
                    t["model"] = ""
                if "effort" not in body and t.get("effort") and t["effort"] not in CONFIG["efforts"].get(t["agent"], []):
                    t["effort"] = ""
            log_activity(t, "edited " + ",".join(k for k in body))
            save_board()
            return {}

        m = re.fullmatch(r"/api/task/(\w+)/action", path)
        if m:
            tid = m.group(1)
            t = task_by_id(tid)
            if not t:
                raise ValueError("no task")
            a = body.get("action")
            if a == "usesug":
                h = t.pop("suggested", None)
                if not h:
                    raise ValueError("no suggested session")
                t.pop("fresh", None)
                t.update(handoff={k: h.get(k) for k in ("key", "kind", "id", "cwd", "pane", "title")}, owner="agent", status="queued")
                log_activity(t, f"continuing in session {h['title']}")
            elif a == "nosug":
                t.pop("suggested", None)
            elif a == "run":
                t.pop("suggested", None)
                sess = t.get("session")
                if sess and sess.get("id") and not t.get("handoff") and not t.get("fresh") and t["owner"] == "agent":
                    # a card that came from a session continues that session instead of starting from zero
                    k = f"{sess['kind']}:{sess['id']}"
                    l = next((x for x in LIVE["list"] if x["key"] == k), None)
                    wd = next((r.get("workdir") for r in reversed(t["runs"]) if r.get("workdir")), "")
                    t["handoff"] = {"key": k, "kind": sess["kind"], "id": sess["id"], "cwd": (l or {}).get("cwd") or wd,
                                    "pane": (l or {}).get("pane"), "title": (l or {}).get("label") or (l or {}).get("name") or t["title"]}
                t["status"] = "queued"
                log_activity(t, "queued")
            elif a == "stop":
                t["status"] = "stopped"
                stop_run(tid)
                if t.get("live"):
                    sh(["tmux", "send-keys", "-t", t.pop("live")["pane"], "Escape"])
            elif a == "switch_now":  # apply a new agent/model/effort immediately
                _, ag, model, effort = effective(t)
                if ag == "antigravity" and not shutil.which("agy"):
                    raise ValueError("Antigravity needs the agy command")
                if ag == "deepseek" and not (deepseek_key() and shutil.which("dst")):
                    raise ValueError("DeepSeek needs your key in data/deepseek.env and the dst command")
                t["agent_set_at"] = now()
                if t.get("handoff") and t["handoff"].get("kind") != ag:
                    t.pop("handoff", None)
                if tid in PROCS:
                    t["switch_now"] = True
                    stop_to_send(t, tid, f"⇄ switching to {ag} {model}/{effort} now")
                    return {"switching": True}
                sess = t.get("session")
                live_s = next((x for x in LIVE["list"] if sess and x["kind"] == sess.get("kind") and x["id"] == sess.get("id") and x.get("pane")), None)
                prev = t["runs"][-1] if t["runs"] else None
                prev_status = t["status"]
                if live_s:
                    was_busy = live_s.get("status") == "busy"
                    same_agent = (live_s["kind"] == ag)
                    note = _switch_note(same_agent, was_busy)
                    t["chat_prev_status"] = prev_status
                    t["status"] = "running"
                    t.pop("live", None)
                    log_activity(t, f"⇄ closing live session and switching to {ag} {model}/{effort}")
                    save_board()
                    ATTN.pop(f"task:{tid}", None)
                    save_json(DATA / "attention.json", ATTN)
                    def _switch_live(ls=dict(live_s), tid=tid, note=note):
                        end_session(ls)
                        start_run(tid, note, chat=True)
                    threading.Thread(target=_switch_live, daemon=True).start()
                    return {"switching": True}
                if prev:
                    was_interrupted = prev_status in ("running", "stopped", "failed")
                    same_agent = (prev.get("agent") == ag)
                    note = _switch_note(same_agent, was_interrupted)
                    t["chat_prev_status"] = prev_status
                    t["status"] = "running"
                    log_activity(t, f"⇄ switching to {ag} {model}/{effort} now")
                    save_board()
                    ATTN.pop(f"task:{tid}", None)
                    save_json(DATA / "attention.json", ATTN)
                    if same_agent and not prev.get("session"):
                        threading.Thread(target=start_run, args=(tid,), daemon=True).start()
                    else:
                        threading.Thread(target=start_run, args=(tid, note), kwargs={"chat": True}, daemon=True).start()
                    return {"switching": True}
                raise ValueError("this card hasn't run yet; click Run to start it with the new model")
            elif a == "cancelmsg":   # take a message back: out of the queue, or stop the run that has not started on it yet
                cancel_message(t, tid, str(body.get("text") or ""))
            elif a == "sendnow":  # interrupt the run; finish_run then sends the queued messages
                if not t.get("queued_msgs"):
                    raise ValueError("nothing queued")
                if tid in PROCS:
                    interrupt_to_send(t, tid)
            elif a == "allow":
                t["access"] = "full"
                what = "; ".join((t["runs"][-1].get("denied") or [])[:5]) if t["runs"] else ""
                t["status"] = "running"
                log_activity(t, "🔓 allowed: full access, continuing")
                save_board()
                note = ("Permission granted by the user: this task now has full access, nothing is blocked any more"
                        + (f" (you were blocked on: {what})" if what else "") + ". Continue the task.")
                threading.Thread(target=start_run, args=(tid, note), kwargs={"chat": True}, daemon=True).start()
                ATTN.pop(f"task:{tid}", None)
            elif a == "interrupt":  # ⚡ with nothing typed: stop this step and deal with what was already sent
                if tid not in PROCS:
                    raise ValueError("the agent isn't running in the background")
                if not t.get("queued_msgs") and not last_user_message(t["runs"][-1]):
                    raise ValueError("nothing to send: type a message first")
                return interrupt_to_send(t, tid)
            elif a == "unqueue":
                t.pop("queued_msgs", None)
                t.pop("interrupt_held", None)
            elif a == "handoff":
                h = {k: body.get(k) for k in ("key", "kind", "id", "cwd", "pane", "title")}
                if h["kind"] not in ("claude", "codex"):
                    raise ValueError("bad session")
                t.pop("fresh", None)
                t.pop("suggested", None)
                t.update(handoff=h, owner="agent", status="queued" if body.get("run", True) else t["status"])
                log_activity(t, f"handed to session {h['title'] or h['key']}")
            elif a == "unhandoff":
                t.pop("handoff", None)
                t["fresh"] = True
                if t["status"] == "queued":
                    t["status"] = "todo"
            elif a in ("retry", "reject"):
                t["status"] = "running"
                save_board()
                threading.Thread(target=start_run, args=(tid, body.get("note", "")), daemon=True).start()
                ATTN.pop(f"task:{tid}", None)
            elif a == "chat":
                text = (body.get("text") or "").strip()
                if not text:
                    raise ValueError("empty message")
                src = task_by_id(body.get("from_card") or "")
                if src and src is not t and CONFIG.get("agent_messaging", True):  # sent by another card's agent
                    limit = CONFIG.get("agent_msg_limit", 5)
                    recent = [x for x in src.get("agent_sent", []) if now() - x < 3600]
                    if len(recent) >= limit:
                        raise ValueError(f"limit reached: an agent can send {limit} messages to other agents per hour")
                    src["agent_sent"] = recent + [now()]
                    text = f'Message from the "{src["title"]}" agent:\n\n{text}'
                    t["reply_to"] = src["id"]
                    log_activity(t, f'✉ from the "{src["title"][:40]}" agent')
                text = rules_update(t, text)
                if tid in PROCS and not body.get("now") and send_input(tid, text):
                    ATTN.pop(f"task:{tid}", None)
                    save_json(DATA / "attention.json", ATTN)
                    log_activity(t, "✉ message sent to the running agent")
                    save_board()
                    return {"delivered": True}
                if tid in PROCS or t["status"] == "running":
                    t.setdefault("queued_msgs", []).append(text)  # delivered as the next turn when this run ends
                    if body.get("now") and tid in PROCS:  # or right away: interrupt the run
                        return interrupt_to_send(t, tid)
                    log_activity(t, "message queued")
                    save_board()
                    return {"queued": len(t["queued_msgs"])}
                t["chat_prev_status"] = t["status"]
                t["status"] = "running"
                save_board()
                threading.Thread(target=start_run, args=(tid, text), kwargs={"chat": True}, daemon=True).start()
                ATTN.pop(f"task:{tid}", None)
            elif a in ("fresh", "redo"):
                drop_worktree(t)
                t["merge_error"] = ""
                if a == "fresh":
                    t["status"] = "queued"
                else:
                    t["status"] = "running"
                    save_board()
                    threading.Thread(target=start_run, args=(tid, "Your previous change could not be merged because the "
                                     "code changed underneath it. This directory now holds the latest code; re-apply "
                                     "your change on top of it."), daemon=True).start()
                ATTN.pop(f"task:{tid}", None)
            elif a == "escalate":
                cur = effective(t)[0]
                t["tier"] = TIERS[min(TIERS.index(cur) + 1, 3)]
                log_activity(t, f"tier → {t['tier']}")
            elif a == "approve":
                approve(t, merge=True)
            elif a == "keep":
                approve(t, merge=False)
            elif a == "done":
                t["status"] = "done"
                t["done_at"] = now()
                ATTN.pop(f"task:{tid}", None)
            elif a == "reopen":  # an agent card with finished work goes back to Review, so it isn't taken for unstarted work
                t["status"] = "review" if t["owner"] == "agent" and any(r.get("result") for r in t["runs"]) else "todo"
            elif a == "archive":
                t["archived"] = True
                ATTN.pop(f"task:{tid}", None)
            elif a == "unarchive":
                t["archived"] = False
            elif a == "triage":
                start_triage(tid)
            elif a == "doing":
                t["status"] = "doing"
            log_activity(t, a)
            save_board()
            save_json(DATA / "attention.json", ATTN)
            return {}

        if path == "/api/move":
            t = task_by_id(body["id"])
            cat = body["cat"]
            siblings = sorted([x for x in BOARD["tasks"] if x["cat"] == cat and not x["archived"] and x["id"] != t["id"]],
                              key=lambda x: x["order"])
            i = max(0, min(int(body.get("index", len(siblings))), len(siblings)))
            if siblings:
                if i == 0:
                    t["order"] = siblings[0]["order"] - 1
                elif i >= len(siblings):
                    t["order"] = siblings[-1]["order"] + 1
                else:
                    t["order"] = (siblings[i - 1]["order"] + siblings[i]["order"]) / 2
            if t["cat"] != cat:
                log_activity(t, f"moved to {cat}")
            t["cat"] = cat
            save_board()
            return {}

        if path == "/api/category":
            a = body.get("action")
            if a == "add":
                cid = uuid.uuid4().hex[:6]
                color = PALETTE[len(BOARD["categories"]) % len(PALETTE)]
                BOARD["categories"].append({"id": cid, "name": body.get("name") or "New", "color": color,
                                            "repo": "", "agent": "auto", "wip": 0})
            elif a == "patch":
                c = cat_by_id(body["id"])
                for k in ("name", "color", "repo", "agent", "wip", "collapsed"):
                    if k in body:
                        c[k] = body[k]
            elif a == "delete":
                if any(t["cat"] == body["id"] and not t["archived"] for t in BOARD["tasks"]):
                    raise ValueError("column not empty")
                BOARD["categories"] = [c for c in BOARD["categories"] if c["id"] != body["id"]]
            elif a == "move":
                cs = BOARD["categories"]
                c = cat_by_id(body["id"])
                cs.remove(c)
                cs.insert(max(0, min(int(body["index"]), len(cs))), c)
            save_board()
            return {}

        if path == "/api/daily":
            daily_action(body if isinstance(body, dict) else {})
            return {}
        if path == "/api/rules":
            a, rules = body.get("action"), BOARD["rules"]
            if a == "add":
                rules.append({"id": uuid.uuid4().hex[:6], "text": body.get("text", "").strip() or "new rule",
                              "on": True, "scope": body.get("scope", "all"), "agent": body.get("agent", "any")})
            elif a == "patch":
                r = next(r for r in rules if r["id"] == body["id"])
                for k in ("text", "on", "scope", "agent"):
                    if k in body:
                        r[k] = body[k]
            elif a == "delete":
                BOARD["rules"] = [r for r in rules if r["id"] != body["id"]]
            save_board()
            return {}

        if path == "/api/settings":
            if "access" in body:
                ag, lvl = body["access"].get("agent"), body["access"].get("level")
                if ag not in AGENT_KINDS or lvl not in ACCESS:
                    raise ValueError("bad access")
                CONFIG["access"] = {**CONFIG["access"], ag: lvl}
            for k in ("autopilot", "max_parallel", "cross_review", "auto_escalate", "agent_messaging", "auto_reports"):
                if k in body:
                    CONFIG[k] = body[k]
            if body.get("default_agent") in ("auto", *AGENT_KINDS):
                CONFIG["default_agent"] = body["default_agent"]
            if body.get("run_mode") in ("background", "terminal"):
                CONFIG["run_mode"] = body["run_mode"]
            ok = lambda v: isinstance(v, str) and re.fullmatch(r"[A-Za-z0-9][\w.:/\-]{0,80}", v)
            for tier, per in (body.get("tiers") or {}).items():
                for ag, m in (per or {}).items():
                    if tier in CONFIG["tiers"] and ag in AGENT_KINDS and ok(m.get("model")) and ok(m.get("effort")):
                        CONFIG["tiers"][tier][ag] = {"model": m["model"], "effort": m["effort"]}
            tr = body.get("triage")
            if tr and ok(tr.get("model")) and ok(tr.get("effort")):
                CONFIG["triage"] = {"model": tr["model"], "effort": tr["effort"]}
            save_config()
            return {}

        if path == "/api/attention/ack":
            ATTN.pop(body["key"], None)
            save_json(DATA / "attention.json", ATTN)
            return {}

        if path == "/api/session":
            a, key = body.get("action"), body.get("key", "")
            meta = SMETA.setdefault(key, {}) if key else {}
            if a == "end":
                s = next((x for x in LIVE["list"] if x["key"] == key), None)
                if not s:
                    raise ValueError("session is not running")
                threading.Thread(target=end_session, args=(dict(s),), daemon=True).start()
                ATTN.pop(key, None)
            elif a == "focus":
                tmux_focus(body["pane"])
                ATTN.pop(key, None)
            elif a == "send":
                if not_board_pane(body["pane"]):
                    raise ValueError("that pane is the board's own terminal, not an agent")
                if body.get("interrupt"):  # Esc stops the agent's current turn in Claude Code and Codex
                    sh(["tmux", "send-keys", "-t", body["pane"], "Escape"])
                    time.sleep(1.0)
                paste_to_pane(body["pane"], body.get("text", ""))  # with no text this just presses Enter
                ATTN.pop(key, None)
            elif a == "term":  # keystrokes from the browser's live terminal
                pane = body.get("pane", "")
                if not re.fullmatch(r"%\d+", pane) or pane not in {p["pane"] for p in tmux_panes()} or not_board_pane(pane):
                    raise ValueError("no such pane")
                for it in (body.get("items") or [])[:300]:
                    if isinstance(it.get("t"), str):
                        paste_raw(pane, it["t"][:20000])
                    elif isinstance(it.get("k"), str) and TERM_KEY_RE.fullmatch(it["k"]):
                        sh(["tmux", "send-keys", "-t", pane, it["k"]])
                ATTN.pop(key, None)
            elif a == "keys":
                if not_board_pane(body["pane"]):
                    raise ValueError("that pane is the board's own terminal, not an agent")
                k = body["k"]
                if k not in ("1", "2", "3", "y", "n", "Escape", "Enter", "Up", "Down", "Tab", "BTab"):
                    raise ValueError("key not allowed")
                sh(["tmux", "send-keys", "-t", body["pane"], k])
            elif a == "resume":
                kind, sid = body["kind"], body["id"]
                cwd = body.get("cwd") or ""
                # Claude finds sessions by the directory they ran in; recreate a removed board worktree path
                if cwd and cwd.startswith((str(WORKTREES), str(RUNS))) and not Path(cwd).exists():
                    Path(cwd).mkdir(parents=True)
                cmd = CONFIG["resume_cmd"][kind].format(id=shlex.quote(sid))
                lvl = body.get("access") if body.get("access") in ACCESS else "standard"
                cmd += "".join(" " + shlex.quote(f) for f in access_flags(kind, lvl, interactive=True))
                where = tmux_new_window(cmd, body.get("cwd"), (meta.get("label") or body.get("title") or sid)[:20])
                return {"where": where}
            elif a == "new":
                kind = body["kind"]
                cmd = CONFIG["new_cmd"][kind]
                lvl = body.get("access") if body.get("access") in ACCESS else "standard"
                cmd += "".join(" " + shlex.quote(f) for f in access_flags(kind, lvl, interactive=True))
                if body.get("prompt"):
                    cmd += " " + shlex.quote(body["prompt"])
                where = tmux_new_window(cmd, body.get("cwd"), body.get("name") or kind)
                return {"where": where}
            elif a in ("label", "pin", "hide"):
                field = {"label": "label", "pin": "pinned", "hide": "hidden"}[a]
                meta[field] = body.get("value")
            elif a == "ack":
                ATTN.pop(key, None)
            elif a == "totask":
                kind = body.get("kind")
                if body.get("id"):  # a session gets one card: reuse the one that already tracks it
                    have = next((x for x in BOARD["tasks"] if not x["archived"] and (x.get("session") or {}).get("id") == body["id"]
                                 and x["session"].get("kind") == kind), None)
                    if have:
                        meta["task"] = have["id"]
                        save_json(DATA / "sessions_meta.json", SMETA)
                        return {"id": have["id"], "existing": True}
                t = new_task(body.get("cat") or BOARD["categories"][0]["id"],
                             body.get("title") or "session follow-up", agent=kind if kind in AGENT_KINDS else "auto")
                if body.get("id"):
                    t["session"] = {"kind": kind, "id": body["id"]}
                    t["runs"].append({"id": "r0", "agent": kind, "tier": "M", "model": "", "effort": "", "start": now(),
                                      "end": now(), "exit": 0, "session": body["id"], "mode": "direct",
                                      "workdir": body.get("cwd") or str(HOME), "branch": None, "base": None,
                                      "repo": None, "result": "(linked existing session)", "dir": "", "cost": None})
                t["repo"] = body.get("cwd", "")
                t["owner"] = "me" if body.get("pane") else "agent"
                orders = [x["order"] for x in BOARD["tasks"] if x["cat"] == t["cat"]]
                t["order"] = (min(orders) - 1) if orders else now()
                BOARD["tasks"].append(t)
                meta["task"] = t["id"]
                save_board()
                save_json(DATA / "sessions_meta.json", SMETA)
                return {"id": t["id"]}
            save_json(DATA / "sessions_meta.json", SMETA)
            save_json(DATA / "attention.json", ATTN)
            return {}
    raise ValueError("unknown endpoint")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, b, ctype, code=200):
        if len(b) > 1400 and "gzip" in (self.headers.get("Accept-Encoding") or ""):
            b = gzip.compress(b, 5)
            gz = True
        else:
            gz = False
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        if gz:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def _send_upload(self, f):
        """Downloads, never pages: a dropped .html must not run as part of the board. A PDF may open in the browser's viewer."""
        pdf = f.suffix.lower() == ".pdf"
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf" if pdf else "application/octet-stream")
        self.send_header("Content-Length", str(f.stat().st_size))
        self.send_header("Content-Disposition", f"{'inline' if pdf else 'attachment'}; filename*=UTF-8''{quote(f.name)}")
        self.send_header("X-Content-Type-Options", "nosniff")
        if not pdf:
            self.send_header("Content-Security-Policy", "sandbox")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with f.open("rb") as fh:
            shutil.copyfileobj(fh, self.wfile, 1 << 20)

    def _json(self, obj, code=200):
        self._send(json.dumps(obj, ensure_ascii=False).encode(), "application/json; charset=utf-8", code)

    def _host_ok(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost", CONFIG["host"])

    def do_GET(self):
        if not self._host_ok():
            return self._json({"error": "bad host"}, 403)
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path in ("/", "/index.html"):
                self._send((STATIC / "index.html").read_bytes(), "text/html; charset=utf-8")
            elif u.path in ("/manifest.webmanifest", "/icon-180.png", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"):  # installable on a phone's home screen
                self._send((STATIC / u.path[1:]).read_bytes(), "application/manifest+json" if u.path.endswith("webmanifest") else "image/png")
            elif re.fullmatch(r"/api/upload/[0-9a-f]{20}\.(png|jpg|gif|webp)", u.path):
                f = UPLOADS / u.path.rsplit("/", 1)[1]
                if not f.is_file():
                    return self._json({"error": "not found"}, 404)
                self._send(f.read_bytes(), IMAGE_MIME[f.suffix[1:]])
            elif m := re.fullmatch(r"/api/upload/([0-9a-f]{20})/([^/]+)", u.path):
                f = UPLOADS / m.group(1) / unquote(m.group(2))
                if f.parent != UPLOADS / m.group(1) or not f.is_file():
                    return self._json({"error": "not found"}, 404)
                self._send_upload(f)
            elif u.path == "/api/progress":
                self._json(progress_data())
            elif u.path == "/api/state":
                st = public_state()
                b = json.dumps(st, ensure_ascii=False, sort_keys=True).encode()
                sig = hashlib.md5(b).hexdigest()[:12]
                if q.get("sig", [""])[0] == sig:
                    return self._json({"same": True, "sig": sig})
                st["sig"] = sig
                self._json(st)
            elif u.path == "/api/history":
                with LOCK:
                    h = history(q.get("q", [""])[0])
                if not q.get("hidden"):
                    h = [e for e in h if not e["hidden"]]
                self._json(h[:300])
            elif u.path == "/api/repos":
                self._json(list_repos())
            elif m := re.fullmatch(r"/api/pane/(%\d+)", unquote(u.path)):
                n = max(5, min(int(q.get("n", ["120"])[0]), 1000))
                self._json(pane_view(m.group(1), n) if q.get("ansi") else {"text": capture(m.group(1), n)})
            elif m := re.fullmatch(r"/api/task/(\w+)/suggest", u.path):
                with LOCK:
                    t = task_by_id(m.group(1))
                    self._json(suggest_sessions(t) if t else [])
            elif m := re.fullmatch(r"/api/task/(\w+)/diff", u.path):
                with LOCK:
                    t = task_by_id(m.group(1))
                self._json({"diff": task_diff(t) if t else ""})
            elif u.path == "/api/conversation":
                kind, sid = q.get("kind", [""])[0], q.get("id", [""])[0]
                if kind not in AGENT_KINDS or not sid:
                    return self._json({"total": 0, "start": 0, "messages": []})
                self._json(conversation_page(kind, sid, q))
            elif m := re.fullmatch(r"/api/task/(\w+)/conversation", u.path):
                with LOCK:
                    t = task_by_id(m.group(1))
                    sess = (t or {}).get("session")
                self._json({"session": sess, "messages": conversation(sess["kind"], sess["id"]) if sess else []})
            elif m := re.fullmatch(r"/api/task/(\w+)/log", u.path):
                with LOCK:
                    t = task_by_id(m.group(1))
                    r = t["runs"][-1] if t and t["runs"] else None
                self._json({"log": render_log(r) if r else ""})
            else:
                self._json({"error": "not found"}, 404)
        except Exception as e:
            self._json({"error": str(e)}, 500)

    def do_POST(self):
        if not self._host_ok():
            return self._json({"error": "bad host"}, 403)
        n = int(self.headers.get("Content-Length") or 0)
        try:
            if urlparse(self.path).path == "/api/upload" and "name" in parse_qs(urlparse(self.path).query):
                if n > FILE_MAX:
                    self.close_connection = True
                    raise ValueError("the file is over the 200 MB limit")
                try:
                    return self._json(save_file(self.rfile, n, parse_qs(urlparse(self.path).query)["name"][0]))
                except OSError as e:
                    self.close_connection = True
                    raise ValueError(f"could not save the file: {e.strerror}")
            if urlparse(self.path).path == "/api/upload":
                if n > UPLOAD_MAX:
                    self.close_connection = True
                    raise ValueError("image too large")
                return self._json(save_upload(self.rfile.read(n)))
            body = json.loads(self.rfile.read(n) or b"{}")
            path = urlparse(self.path).path
            if path == "/api/translate":  # not under the board lock: a translation can take seconds
                return self._json(translate_request(body if isinstance(body, dict) else {}))
            if isinstance(body, dict) and re.fullmatch(r"/api/task/\w+/action", path) and body.get("action") == "chat":
                body.pop("from_card", None)  # only the board says who sent it, never the sender
                src = sender_card(self.client_address)
                if src:
                    body["from_card"] = src
            self._json(handle_post(path, body) or {})
        except Exception as e:
            self._json({"error": str(e)}, 400)


def render_log(r):
    """Human-readable tail of a run's JSONL event log."""
    if not r.get("dir"):
        return r.get("result", "")
    f = Path(r["dir"]) / "log.jsonl"
    if not f.exists():
        return "This run is in a terminal window. Use the Chat tab's Screen view to watch it and type into it." if r.get("terminal") else ""
    out = []
    for line in _tail_lines(f, 300_000):
        try:
            d = json.loads(line)
        except Exception:
            out.append(line)
            continue
        typ = d.get("type")
        if typ == "assistant":
            for c in d.get("message", {}).get("content", []):
                if c.get("type") == "text":
                    out.append("💬 " + c["text"])
                elif c.get("type") == "tool_use":
                    inp = c.get("input", {})
                    out.append(f"🔧 {c.get('name')}: " + str(inp.get("command") or inp.get("file_path") or inp)[:200])
        elif typ == "result":
            out.append(f"🏁 done · ${d.get('total_cost_usd', 0):.3f}")
        elif typ == "item.completed":
            it = d.get("item", {})
            if it.get("type") == "agent_message":
                out.append("💬 " + it.get("text", ""))
            elif it.get("type") == "command_execution":
                out.append(f"🔧 {it.get('command', '')[:200]} → {it.get('exit_code')}")
            elif it.get("type") == "file_change":
                out.append("📝 " + ", ".join(c.get("path", "") for c in it.get("changes", [])))
        elif typ in ("error", "turn.failed"):
            out.append("❌ " + json.dumps(d)[:300])
    return "\n".join(out[-200:])


def main():
    backfill_progress()
    recover_on_boot()
    threading.Thread(target=live_loop, daemon=True).start()
    threading.Thread(target=runner_loop, daemon=True).start()
    threading.Thread(target=card_summaries, daemon=True).start()
    srv = ThreadingHTTPServer((CONFIG["host"], CONFIG["port"]), Handler)
    print(f"agentboard on http://{CONFIG['host']}:{CONFIG['port']}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
