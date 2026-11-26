# agentboard

A local kanban board for working with **Claude Code**, **Codex**, **DeepSeek** and **Antigravity** agents, and for your own to-dos.

> An independent project, not affiliated with or endorsed by Anthropic or OpenAI. "Claude Code" and "Codex" are their products' names, used here only to say what this works with.

Put everything you need to do on one board. Agents pick up their cards and finish them. Cards that need
you, like a review, a question or a permission prompt, come back to you. Mostly click and drag, very little typing.

- One Python file (stdlib only) plus one HTML page. No dependencies, no build step, works offline.
- Binds to `127.0.0.1` only. Use an SSH tunnel to reach it from another computer.
- Linux. Needs Python 3 (developed on 3.14), `tmux`, plus any of the `claude` CLI, the `codex` CLI, the `agy` command (Antigravity) and the `dst` command (DeepSeek, with your key in `data/deepseek.env`).
- Everything stays on your machine, with one optional exception. The board reads your local Claude and Codex session files (`~/.claude`, `~/.codex`) to list and show conversations, and calls the `claude` / `codex` CLIs you already have (the agent runs you start, and small calls for triage, short titles and highlights, on DeepSeek or Codex). It makes no other network requests. **The board's own small calls go to DeepSeek if you put a key in `data/deepseek.env`, which sends the text of agent messages and card titles to DeepSeek's servers; otherwise they go to Codex.** The board never uses Claude for its own work, only for the Claude cards you run. Set `"quick_backend"` in `data/config.json` to `deepseek` or `codex` to force one.

![From a to-do list to merged code](docs/flow.svg)

## Screenshots

*All cards, sessions and code below are made-up sample data.*

**The board.** Columns are categories and cards are tasks. Colour shows status, 🔥 marks urgent and important, 🙋 cards are yours, and the strip at the top is what is waiting on you.

![The board](docs/board.png)

**A card's conversation.** Open a card to read what the agent did, reply, approve or retry.

![A card's conversation](docs/card-chat.png)

<table><tr>
<td width="38%" valign="top"><b>Card details.</b> Pick the agent, size, exact model and effort, where it runs (background or a terminal), and its access level.<br><br><img src="docs/card-details.png" alt="Card details"></td>
<td valign="top"><b>Live terminal.</b> The Screen view is the agent's real terminal, with colours and a cursor. Click it and type as you would in tmux.<br><br><img src="docs/terminal.png" alt="Live terminal"></td>
</tr></table>

## Quick start

```bash
git clone <repository URL> agentboard && cd agentboard   # the URL shown on this repo's GitHub page
./ab start          # runs the server in a detached tmux session "agentboard"
# open http://127.0.0.1:8789
./ab logs | ./ab restart | ./ab stop
```

Your data lives in `data/` (git-ignored): the board, settings, session names and notifications.

## The board

- **Columns are categories**: color, default repo, default agent, WIP limit. Drag to reorder, click a folded column to unfold it.
- **Recent first**: in each column, the most recently used cards (last edit, message or run) sit at the top. The **⬆ Recent** chip in the header turns it off. Dropping a card puts it where the blue line was, among the others.
- **Phone**: the page is a home-screen app. Open the board's address in Safari on a phone, tap Share → Add to Home Screen, and it opens full-screen with its own icon. On a narrow screen the columns swipe sideways one at a time, the detail panel takes the whole screen and inputs don't zoom. The phone must be able to reach the board's address (same network, a VPN or a tunnel). There is no login, so don't expose it to the internet.
- **Restart**: the ↻ button offers *Wait for the agents, then restart* (the board restarts by itself once no agent is mid-work; the button shows ⏳ and the number still working, and the page reloads when it is back) or *Restart now*.
- **Theme**: ⚙ Settings → Theme has Auto (follows your device), Light and Dark; the ◐ button in the header flips between light and dark. The choice is kept per browser.
- **Reports**: when a card's agent names an HTML report in its final answer (a file written during that run, under your home or /tmp, up to 1.5 MB), the board copies it to `reports/<project>/` and adds an English / Chinese switch version of it (EN | 中 at the top right; the board's own translation call, never Claude). If the agent revises the report later, the copy is updated at the same address (even when its answer does not name the file again). The original stays where the agent wrote it and the card's Detail tab links the copy. A report the agent names by the address of a plain web server (`http://host:port/…/report.html`) is found too, and the images and other files it shows beside it are copied into a folder of its own (files over 8 MB, such as videos, keep pointing to where they are served). The hub page gets the same EN | 中 switch (its plain version is kept in `data/hub-source.html`). It also lists each copy in the reports hub page (`reports/index.html`: its project section, tile, filter and counts, recounted from the page; a backup is kept as `index.html.bak-board`) and in `reports/latest.html`. `reports/` is served by a small web server you run yourself and is not part of this repo. Turn it off in ⚙ Settings → Auto reports.
- **Today list**: a bar above the columns for things you do yourself, no agent. Type an item and press Enter; check it off. A new item is a **one-off**: it is gone the day after you check it. ⚙ switches ↻ on to make it repeat, sets which weekdays it repeats on (all lit = every day) and can turn it into a card. An item you did not check stays on the list as overdue (`+2d` = two days missed) until you do. The day changes at 4 am (`day_start_hour` in `data/config.json`), not at midnight. Kept in `data/board.json`.
- **Cancel a sent message**: a message goes out at once, and its bubble has a ✕ Cancel until the agent has taken it: while it is queued because the agent is busy, or while a fresh run has not yet started on it (Codex, DeepSeek, Antigravity). Cancel puts the text back in the box; once the agent has it, Cancel says it is too late. A Claude card that is running gets messages straight into its input, so those can't be taken back.
- **Usage bar**: the header chips show each plan's limits (Claude, Codex, Antigravity, DeepSeek balance). Hover a chip (or tap it on a phone) for the same numbers as coloured bars with when each limit resets. On narrower windows the small bars in the chips are hidden to save room, and the hover card still has them.
- **Voice input**: the 🎤 button next to Send (or Alt+V in the message box) dictates into the box using the browser's built-in speech recognition (Chrome, Edge, Safari; needs localhost or https). The small 中/EN button switches the language. Nothing is sent until you press Send. Chrome sends the audio to its own speech service.
- **Quick-add**: type in a column and press Enter. `!` urgent, `*` important, `@me` human task, `#S` `#M` `#L` `#XL` size,
  `codex:` or `claude:` agent. Example: `codex: fix the CSV parser #M !`
- **Short titles**: if you type a whole sentence as a task, a fast model writes a short title in the same language and your full text moves into the card's notes (nothing is lost; titles you edit yourself are never touched).
- **Triage**: every new card is sized by a fast model (Haiku, low effort). It sets the tier, agent, human-or-agent,
  acceptance criteria, and whether **an existing session looks related**. If one does, the card asks: **↪ Continue there** keeps that session's context, and **▶ Run** starts a new agent. Nothing goes to an existing session unless you say so.
  Click the pills on a card to override the size or agent, or pick the exact **model and effort** for that card in its details (any model id can be typed). What each size S/M/L/XL maps to, and the model used for triage, is editable in ⚙ Settings.
- **▶ Run** a card, or switch on **Autopilot** so agents take 🤖 to-do cards in this order: 🔥 urgent+important, urgent, important, then column order.
- **Where agents work**:
  - **Git repo**: an isolated worktree on branch `ab/<id>`. The board commits the result, **Approve** merges it, and **Redo** re-applies it on the latest code after a merge conflict.
  - **Other folders**: the agent works in place.
  - **Run in a terminal** (per card, or the default in ⚙ Settings): instead of the background, the agent starts in a new tmux window you can watch and type into (the card's Screen view). It uses the card's access level, so the only prompt you may see is the one-time "trust this folder" question, which shows up as "needs permission". The card finishes when the agent goes idle, with the same worktree, diff and Approve flow. Feedback on a finished card is typed into the window if it is still open.
  - **Continued in an existing session** (you pick it on the card): the board types the card into the session's terminal once it's idle, or resumes it in the background if it isn't open.
- **Tokens per card**: the card panel shows how many tokens its conversations used (new input, cached input, output) and the cost of runs the board started, read from the Claude and Codex session files.
- **Talking to a card**: the card's Chat tab shows the conversation live and has a reply box. While a Claude agent works in the background, your message goes straight to it and it reads it between steps, without being interrupted (a Codex background run can't take input, so the message is queued until it finishes). In a terminal, messages are typed in and picked up the same way. **⚡ Interrupt & send** (Cmd/Ctrl+Enter in the message box) stops the current step first, and with an empty box it deals with what you already sent; a message the agent hadn't recorded yet goes along with yours. If the agent is compacting a long conversation (a few minutes, shown on the card), the interrupt waits for that to finish, because stopping it would only restart it.
- **Images and files**: drop them on a chat or paste them into the message box. They are saved in `data/uploads` and reaches Claude and Codex as a real image with your message (large ones are scaled to 2000 px first). In a terminal, which only takes text, the file's path is typed instead and the agent opens it from there.
  Other files (PDF, Word and so on, up to 200 MB) reach the agent as a path, and it opens them with its own tools. If LibreOffice is installed, a Word file also gets a PDF copy, so any agent can read it.
- **Highlights and TL;DR**: the agent's messages get their key points coloured and shaped: results, problems, what needs you and key facts. With the **TL;DR** switch on (off by default), replies over 800 characters also get a short summary attached at the top, and a card waiting on you shows its latest bottom line on the board (for long replies this runs when the card finishes, even if you never open it). Going back to a chat, a line marks what is **new since you last read** (kept per browser). A fast model does this when you first look at a message, and it is only read once. Only words that are really in the message are marked, and a summary with a number that isn't in the message is dropped, but a summary can still miss things, so the full text always stays below it. Switches above the chat turn each off, and **Fade the rest** dims what isn't highlighted. This needs the `claude` CLI; without it, messages just stay as they are.
- **Agents messaging each other (experimental)**: agents can find the board's chat API and message other cards. The board then says who sent it ("Message from the "X" agent") and passes the receiver's answer back to the sender as "Reply from the "Y" agent". It works out the sender by tracing the request to the agent's process, and a sender can't be faked in the request. An answer is passed back once and never triggers another automatic message, and one agent may send 5 messages per hour (`agent_msg_limit`). Turn it off with the Settings switch or `"agent_messaging": false`.
- **Translation**: a message that isn't in Chinese gets a Chinese translation in a box above it (the original stays below, and Copy still gives the original). A fast model translates it when you first look at it, once, with code, paths, commands and numbers left as they are. The Chinese box gets its own highlights (a separate read of the Chinese text, marks only). The **中文翻译** switch above the chat turns it off, and then each English message has a **中文** button to translate just that one. **Send in English** (on for every card by default; each card has its own **EN** button next to the 🎤 to turn it off or on, and the choice is kept on the card. The Display switch in ⚙ Settings is the default for cards without a choice) translates what you write in Chinese to English and puts it back in the box for you to read; nothing is sent until you send it again, and Esc brings your Chinese back. What you write is not stored by the board.
- **Questions**: if an agent ends its reply with a question (or a `NEEDS-HUMAN: <question>` line), the card moves to "Needs you".
- **📜 Rules**: global, per-column or per-agent instructions added to every prompt.
- **Your own tasks**: 🙋 cards with urgent/important flags (an Eisenhower view), due dates and checklists.

## Sessions

- **Live**: every running Claude Code session (from `~/.claude/sessions`) and every tmux pane running Codex.
  - Each shows a status (busy / idle / needs permission) and the end of its screen.
  - You can reply (the board types into the pane), answer permission prompts, or ⏻ End the session.
  - Click a session for a full-width view with a **Chat | Screen** switch. **Screen** is the live terminal with colours and a cursor: click it and everything you type (arrows, Enter, Esc, Ctrl+keys, paste, Chinese input) goes to the real terminal, so menus like `/statusline` work as they do in tmux.
- **History**: all past Claude and Codex conversations, searchable. Open one to read it or continue it, rename, pin, hide, or drag it onto the board.
- **Waiting on you**: a strip at the top collects what needs you; press `]` to jump to the next one. You get pop-ups for permission prompts, questions and reviews. A session that has finished just waits in the strip, and you get a desktop notification if the tab is in the background.

## Progress

A GitHub-style matrix of the last year: cards worked on, cards finished (first reached Review) or tokens per day. Click a day to see what moved, or list everything by day or week. The tiles on top show today, this week and how many cards are waiting on you.

## Access levels

Set a default per agent in ⚙ Settings. Each card can override it.

| | Claude | Codex | DeepSeek | Antigravity |
|---|---|---|---|---|
| Read only | read and search only | `read-only` sandbox | `read-only` | `--mode plan` (writes a plan, changes nothing) |
| Standard | no prompts (plus any tools you list in `claude_disallowed`) | `workspace-write` sandbox | `workspace-write` | `--dangerously-skip-permissions` (headless agy cannot ask, and it has no deny-list or working sandbox) |
| Full | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `danger-full-access` | `--dangerously-skip-permissions` |

A **DeepSeek card** runs through `dst` in the background (not in a terminal). Its thinking level is set per size (S off, M and L low, XL high), because left on by default it can spend a whole answer thinking. Like Codex, it can't take a message while it works: Send queues it and ⚡ Interrupt & send stops the step first. The chat and token counts are read from `dst`'s own session files, so cards started elsewhere are not listed.

An **Antigravity card** runs `agy -p` in the background (not in a terminal) and, like Codex and DeepSeek, takes a message only between turns (⚡ interrupts). The model id carries its level (for example `gemini-3.8-flash-high`; `agy models` lists them), so there is no separate effort. The board keeps its own transcript of each conversation in `data/agy/` for the Chat tab. The header shows its limits (Gemini and Claude/GPT, 5-hour and weekly) as read from `agy -p /usage`, which makes no model call.

## Remote access

The server only listens on localhost. From another machine, tunnel it. This version reconnects by itself:

```bash
while true; do ssh -N -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
  -L 8789:127.0.0.1:8789 you@your-linux-box; sleep 3; done
```

Then open `http://localhost:8789`. Set `ssh_hint` in `data/config.json` and the Help page shows your exact command.

## Configuration (`data/config.json`)

| key | what it does |
|---|---|
| `port` | HTTP port (default 8789) |
| `host` | address to listen on (default `127.0.0.1`). Anything else exposes the board, which has no login, to your network |
| `tiers` | model and effort per size (S/M/L/XL) for each agent (also editable in ⚙ Settings) |
| `models` / `efforts` | the model ids and effort levels offered in the pickers, per agent |
| `triage` | model and effort used for sizing new cards |
| `access` | default access level per agent |
| `claude_disallowed` | optional tool patterns blocked for Claude in Standard mode, e.g. `["Bash(git push:*)"]`. Empty by default |
| `daily_cap` | runs per agent per day; cards set to "auto" switch to the other agent when one is capped |
| `max_parallel` | agent runs at the same time, default 7 (background and terminal runs both count; also the ⚡ − / + in the header) |
| `run_mode` | `background` (default) or `terminal`: where card agents run (a card can choose) |
| `quick_backend` | who answers the board's own small calls: `auto` (DeepSeek when a key is set and working, otherwise Codex), `deepseek` or `codex`. `quick_model` picks the DeepSeek model (default `deepseek-flash`, always with thinking off) |
| `tmux_session` | where Resume / New session open windows (default: the session holding most agent panes) |
| `ssh_hint` | `user@host` shown in the Help page's tunnel command |

## Safety notes

- There is no login. Anyone who can reach the port can start agents, so keep it on localhost and use a tunnel.
- The board adds no rules or instructions of its own: an agent is sent the card (title, notes, checklist) and the rules you add in 📜 Rules, nothing else.
- The board never pushes. It merges only when you click Approve.
- An agent's work is only as safe as its access level. Full access means no limits at all.

## Use at your own risk

Agents can edit files and run commands, and the board can type into your terminals. Read the Access levels above before enabling Full access, and keep the board on localhost. The software is provided as is, without warranty (see the license).

## License

MIT
