# fmux

One Feishu chat for every tmux session on your machine: Claude Code, Codex, pi and plain shells.
fmux connects a Feishu bot to the tmux sessions of the computer it runs on.
It runs on Linux and macOS, and on Windows with psmux or inside WSL.

**Setup guide (中文): [docs/setup.zh.md](docs/setup.zh.md)**

- The chat **attaches** to one tmux session at a time, like `tmux attach`. Your messages go into
  that session. The session's replies come back as cards.
- A **dashboard card** lists every session with a status light (🟢 running, ⚪ ended, 🟠 waiting for you).
  One tap attaches, another shows the screen.
- Sessions you are not attached to send a card when a turn finishes or when a dialog waits for you.
- While nothing is attached, a **pi agent** (the concierge) answers. It can switch, inspect and
  start sessions for you in plain language.

## How it works

```
Feishu app  ⇄  @larksuite/channel (WebSocket)  ⇄  Router ──► tmux send-keys / paste-buffer
                                                    ▲   └──► pi --mode rpc   (concierge)
                                                    │
                              Registry: polls tmux every 2 s, reads agent state
                              ├─ processes:   /proc (Linux, WSL), ps + lsof (macOS), PowerShell (Windows)
                              ├─ Claude Code: ~/.claude/sessions/<pid>.json + transcript JSONL
                              ├─ Codex:       screen markers + rollout JSONL
                              ├─ pi:          screen markers + session JSONL
                              └─ shell:       screen only
```

- **Input** goes through a tmux paste buffer followed by Enter. Several lines for Claude Code are
  sent key by key with Ctrl+J between them, so it reads them as typed and not as a paste. Nothing is
  installed in the sessions.
- **Output** comes from the agent's transcript file, not from scraping the screen. A shell has no
  transcript, so a shell gets a screen snapshot when the screen stops changing.
- **State** (`working`, `idle`, `blocked`, `shell`) comes from Claude Code's status file where there is
  one, and from screen markers for the other agents.
- A session already running in tmux needs no change. Start sessions the way you do today.

## Use it from the phone

| You do | Result |
|---|---|
| Send `面板` | A dashboard card: every tmux session with its light |
| Tap **接入** | The chat is attached. Messages now go to that session. One card shows where the session is |
| Send text while attached | The text is typed into the session. One card streams the work and then holds the reply |
| Send an image or file | It is saved under `~/.local/state/fmux/inbox/` and its path is sent to the session |
| Quote-reply a card of some session | The reply goes to that session without switching |
| Tell the concierge "把 A 的最后一条回复发给 B，让它照着改" | Handoff: B gets your comment as typed text and A's last reply as a pasted block. B's reply comes back as a card |
| Type in the box of a "finished" card | Same: a reply without switching |
| Tap **查看** | The session's card: state, last prompt, last reply. A shell shows its terminal |
| Tap **终端** | The terminal, cut for a phone: the last 18 lines, four keys, more keys behind a fold, an input box |
| Tap an option on a **等待确认** card | The matching key is sent to the dialog |
| Tap **断开**, or send `//d` | Back to the concierge |
| Tap **新建会话** | A form: new or past conversation, agent type, with or without `-d` / `--yolo`, directory, name (optional), first message |

Voice messages are not forwarded. Dictate with the phone keyboard and send the text.

### What the cards look like

A header has a color only when the session needs a glance: green while it runs, orange while it
waits for you. Everything else is plain. A card carries only the buttons that fit its state.

| Card | Stays current | Until |
|---|---|---|
| Dashboard | When a session changes, once a minute while an agent runs, every 5 minutes otherwise | A newer dashboard is sent. The old one shrinks to one line |
| Session card (查看, 接入) | State and buttons. The last reply too, while you are not attached | 10 minutes (`live.peekMinutes`), or a newer card for the same session |
| Terminal card | Every 3 s, if the screen changed | 10 minutes after the last tap on it |
| Turn card | With each output of the agent | The turn ends. The card then holds the reply |

A turn that ran longer than `notify.minWorkSec` ends with one short text line that quotes its card.
The line rings the phone; an edited card does not. A refresh redraws the whole card, so text typed
into a terminal card's input box is lost if the screen changes before you send it.

Text commands. Use `//` while attached, because a single `/` belongs to the session
(`/compact`, `/model`). While detached a single `/` works too.

```
//ls                    dashboard            //peek [session]        screen
//a <number|name>       attach               //key [session] esc 1   send keys
//d                     detach               //new [name agent dir]  new session
//pi <message>          ask the concierge without detaching
//stop                  send Esc to the attached session
```

### New sessions

| Choice | Claude Code | Codex |
|---|---|---|
| With `-d` / `--yolo` (default) | `claude -d --permission-mode auto` | `codex --yolo` |
| Without | `claude` | `codex` |
| New conversation | `… -n <session name>` | |
| Latest conversation of the directory | `… -c` | `… resume --last` |
| A past conversation | `… -r <id>`, in that conversation's directory | `… resume <id>`, in that conversation's directory |

`claude -d` is Claude Code's debug mode. What skips the permission prompts is the auto permission
mode. The form lists the 10 newest Claude Code and 5 newest Codex conversations that are not open
in a running Claude Code and whose directory still exists.

Session names are matched loosely everywhere (`//a proc`, `fmuxctl peek "gt proc"`): by part of
the tmux name, of the agent's title, of the directory, or by kind. A name that fits several
sessions gets a card with one button for each (in chat) or an error that lists them (`fmuxctl`).

### Notifications

A session that is not attached sends a card when a turn that ran for at least `notify.minWorkSec`
(20 s) ends, and when it waits on a dialog. These cards are skipped while a tmux client saw keyboard
input in the last `notify.quietIfLocalActiveSec` (180 s): at your desk the phone stays quiet.
Set that value to `0` to always notify.

## Install and run

Needs Node.js 20.12 or newer and tmux. The agents (`claude`, `codex`, `pi`) are optional.

| System | What fmux uses | Service | Tested |
|---|---|---|---|
| Linux | tmux, `/proc` | systemd user service | In daily use. Unit tests and the end-to-end test |
| macOS | tmux, `ps` and `lsof` (macOS has them) | launchd agent | The `ps` and `lsof` code passes the end-to-end test on Linux. Not run on a Mac yet |
| Windows | [psmux](https://github.com/psmux/psmux) as `tmux`, PowerShell for the process table | A psmux session, started at logon | Written from the psmux documentation. Unit tests for the parsing. Not run on Windows yet |
| Windows, WSL 2 | The Linux code. fmux, tmux and the agents all run inside WSL | systemd if WSL has it, else a tmux session | The end-to-end test passes in a container without systemd. Not run on a WSL yet |

See [Platforms](#platforms) for what differs on each system.

```bash
git clone https://github.com/Primatix-Intelligence/fmux.git ~/fmux
cd ~/fmux && npm install
ln -s ~/fmux/bin/fmux ~/fmux/bin/fmuxctl ~/.local/bin/    # Windows: npm link

fmux doctor             # what is in place, what is missing
```

Connect a Feishu bot. Pick the row that fits you:

| You have | Do this | Guide |
|---|---|---|
| No bot yet | `fmux setup`. Scan the QR code with the Feishu app. It creates the bot with the permissions fmux needs | 方式 A |
| No bot yet, and you want to make the app by hand | Create the app in the developer console, write the config, run `fmux pair` | 方式 B |
| A bot used with `lark-channel-bridge` | Stop the bridge, then `fmux setup --app-id cli_xxx --from-lark-channel-bridge`. No new app is needed | 方式 C1 |
| A bot used with another program, or one you made earlier | Stop that program, then `fmux setup --app-id cli_xxx` and paste the App Secret. While it waits, set events and callbacks to long connection in the developer console and add the missing permissions | 方式 C2 |

Each way ends the same: send the bot one message, and its sender becomes the owner.

```bash
fmux install-service    # systemd on Linux, launchd on macOS, else a tmux session
```

Then send `面板` to the bot. The guide also covers the agent settings and troubleshooting.
`fmux doctor` shows if the hub runs and what keeps it running.

One Feishu app delivers each event to one connection only. Do not connect another program
(`lark-channel-bridge`, another fmux) to the same app.

### Platforms

`fmux install-service` picks the service manager of the machine. It gives the service the `PATH`
of the shell that runs it, so run it where `tmux`, `claude` and `codex` are found.

| | Linux with systemd | macOS | No systemd (some WSL, containers), or `--tmux` |
|---|---|---|---|
| Runs as | `~/.config/systemd/user/fmux.service` | `~/Library/LaunchAgents/com.primatix.fmux.plist` | tmux session `fmux-hub`, hidden from the dashboard |
| Starts | At boot, after `loginctl enable-linger $USER` | At login | By hand. The command prints a line for `~/.profile` |
| Status | `systemctl --user status fmux` | `launchctl print gui/$(id -u)/com.primatix.fmux` | `tmux has-session -t =fmux-hub` |
| Logs | `journalctl --user -u fmux -f` | `tail -f ~/Library/Logs/fmux.log` | `tmux attach -t fmux-hub` |
| Restart | `systemctl --user restart fmux` | `launchctl kickstart -k gui/$(id -u)/com.primatix.fmux` | `fmux install-service --tmux` |
| Stop | `systemctl --user stop fmux` | `launchctl bootout gui/$(id -u)/com.primatix.fmux` | `tmux kill-session -t =fmux-hub` |
| Control socket | `$XDG_RUNTIME_DIR/fmux.sock` | `~/.local/state/fmux/fmux.sock` | As on that system |

- **macOS.** `brew install tmux node`. A Mac that you use only over SSH has no launchd `gui` domain:
  use `fmux install-service --tmux`. The hub is offline while the Mac sleeps.
- **Windows with psmux.** tmux does not run on Windows. psmux is a tmux for Windows: it takes the
  same commands and installs a `tmux` command. The agents run on Windows itself.

  ```powershell
  winget install psmux
  git clone https://github.com/Primatix-Intelligence/fmux.git $HOME\fmux
  cd $HOME\fmux; npm install; npm link        # npm link puts fmux and fmuxctl on the PATH
  fmux doctor
  ```

  Start your sessions with `tmux new -s name`, as on Linux. What is different:
  - The hub runs in a psmux session named `fmux-hub`. `fmux install-service` also writes `fmux.cmd`
    to your Startup folder, which starts the hub at logon. Delete that file to undo it. The control
    channel is the named pipe `\\.\pipe\fmux-<user>`.
  - Sessions end when you log off or restart Windows.
  - Windows does not say what a process reads from. An agent that a program drives is known from
    its command line (`codex app-server`, `claude -p`, `pi --mode rpc`).
  - psmux does not report when a client last had input, so `notify.quietIfLocalActiveSec` has no
    effect: a finished turn always notifies.
  - Several lines go in as a paste. The first message of a new session is quoted for PowerShell.
  - The concierge needs `pi`, and pi needs Git Bash on Windows. Set `concierge.enabled` to `false`
    to do without it. `fmux setup --from-lark-channel-bridge` is not available.
- **Windows with WSL 2.** Install WSL (`wsl --install`), then follow the Linux steps inside WSL.
  Install `tmux`, Node.js and the agents inside WSL, and keep the checkout in the Linux file system
  (`~/fmux`), not under `/mnt/c`. A `claude` or `codex` installed on the Windows side is not in
  that tmux. To get systemd, put `[boot]` and `systemd=true` in `/etc/wsl.conf` and run
  `wsl --shutdown` in Windows. A systemd service does not keep WSL up: leave a WSL window open.

### Config

`~/.config/fmux/config.json` (defaults are in `src/config.mjs`):

| Key | Meaning |
|---|---|
| `app.id`, `app.secret` | The Feishu app. The secret is a reference, never the value: `{"source":"file","path":…}`, `{"source":"env","name":…}`, or `{"source":"exec","command":…,"id":…}` for a secret provider |
| `app.tenant` | `feishu` (default) or `lark` |
| `owner.openId` | The only user whose messages and clicks are accepted |
| `owner.chatId` | The chat that receives the cards |
| `notify.*` | See Notifications |
| `live.peekMinutes` | How long a screen card refreshes itself (default 10) |
| `tmux.hide` | tmux session names to leave out |
| `agents.<type>` | How `新建` starts each type: `command` (new conversation), `continue` (latest one of the directory), `resume` (a chosen one), and `flags`, which fill `{flags}` unless the session is created without `-d` / `--yolo` |
| `agents.claude.autoTrust` | Answer Claude Code's "trust this folder" prompt for a session the hub created (default on) |
| `concierge.enabled`, `.model`, `.thinking` | The pi concierge. Default model: `openai-codex/gpt-6.1-sol` (ChatGPT sign-in in pi). Set another `provider/model-id` to override it; an explicit empty string uses pi's default or the resumed session's model |

Restart the service after a change.

### `fmuxctl`

`bin/fmuxctl` talks to the running hub over a Unix socket (see Platforms for its path).
The concierge uses it, and so can any script or agent on this machine:

```bash
fmuxctl ls                       # sessions and state
fmuxctl peek gt_process -n 60    # screen
fmuxctl send gt_process "继续"    # type into a session
fmuxctl handoff proc coll "照这个结论改"   # gt_process's last reply into gt_collection, under your comment
fmuxctl attach proc               # loose names work: this finds gt_process
fmuxctl history                  # past Claude Code and Codex conversations
fmuxctl new fig --resume 魔方     # new tmux session that resumes the conversation with that title
fmuxctl new fix --agent codex --cwd ~/proj --no-yolo
fmuxctl show gt_process          # post the session's card to the chat (--terminal for the terminal)
fmuxctl notify "渲染跑完了"        # push a card to the phone
```

## Security

- Only `owner.openId` can send messages or click cards. Group chats are closed.
- A click can send only the keys in `KEYS` (`src/tmux.mjs`). Text is pasted as data.
- The hub runs as your user. Anyone who controls your Feishu account can type into your terminals
  through the bot. That is the purpose of the tool. Protect the Feishu account accordingly.
- New Claude Code sessions start in the auto permission mode and new Codex sessions with `--yolo`,
  unless you choose otherwise in the form. Change the defaults in `agents.<type>.flags`.
- The control socket has mode 600.

## Develop

```bash
npm test                                   # unit tests, no network, no tmux
npm run test:integration                   # real tmux, stub agents, scratch HOME, Feishu replaced
FMUX_PROCS=ps npm run test:integration     # the same with the macOS way to look at processes
fmux --fake                                # real tmux, Feishu replaced by a recorder
fmuxctl dev say "//ls"                    # act as the owner
fmuxctl dev click '{"a":"attach","n":"gt_process"}'
fmuxctl dev outbox 3                      # cards the hub would have sent
```

Point `FMUX_CONFIG` and `FMUX_SOCK` at scratch paths for a fake run, so it does not share
the state and socket of the service.

| File | Role |
|---|---|
| `src/registry.mjs` | Poll tmux, classify panes, track state and turns, emit events |
| `src/procs.mjs`, `src/win/procs.ps1` | Find the agent process of a pane: `/proc`, `ps` and `lsof`, or the Windows process table |
| `src/transcript.mjs` | Find and follow the transcript of Claude Code, Codex and pi |
| `src/screen.mjs` | Read dialogs and "working" markers from a captured screen |
| `src/router.mjs` | Route messages and clicks, turn registry events into cards |
| `src/cards.mjs` | Card JSON 2.0 builders |
| `src/concierge.mjs` | The pi RPC client |
| `src/feishu.mjs` | Feishu channel wrapper, card update throttle, fake channel |
| `src/control.mjs`, `bin/fmuxctl.mjs` | Control socket and its CLI |
| `src/setup.mjs`, `bin/fmux.mjs` | `fmux setup`, `pair`, `install-service`, `doctor` |
| `src/service.mjs` | The service: systemd unit, launchd job, or a tmux session (psmux on Windows) |
| `test/integration/` | End-to-end test with stub agents on a tmux server of its own |
| `src/history.mjs`, `src/match.mjs` | Past conversations to resume; loose name matching |
| `agent/CONCIERGE.md` | Instructions for the pi concierge |

## Limits

- Dialog detection reads the screen. A dialog layout it does not know shows as a screen excerpt
  with the key pad, without option buttons.
- Card edits do not ring the phone. A turn longer than `notify.minWorkSec` therefore ends with a
  short text line.
- A card holds about 30 KB. Longer replies are cut, and the full text stays in the terminal.
- State is polled every 2 s. The end of a turn shows 2 to 4 s late.
