# YOFO: You Only Feishu Once

One Feishu chat for every tmux session on your machine: Claude Code, Codex, pi and plain shells.
The daemon in this repository is `robin-hub`, named after the bot it was built for.

robin-hub connects the Feishu bot **Robin** to the tmux sessions on this machine.

- The chat **attaches** to one tmux session at a time, like `tmux attach`. Your messages go into
  that session. The session's replies come back as cards.
- A **dashboard card** lists every session with a status light (🟢 running, ⚪ ended, 🟠 waiting for you).
  One tap attaches, another shows the screen.
- Sessions you are not attached to send a card when a turn finishes or when a dialog waits for you.
- While nothing is attached, a **pi agent** (the concierge) answers. It can switch, inspect and
  start sessions for you in plain language.

It replaces `lark-channel-bridge`, which bound the chat to a single Codex thread.

## How it works

```
Feishu app  ⇄  @larksuite/channel (WebSocket)  ⇄  Router ──► tmux send-keys / paste-buffer
                                                    ▲   └──► pi --mode rpc   (concierge)
                                                    │
                              Registry: polls tmux every 2 s, reads agent state
                              ├─ Claude Code: ~/.claude/sessions/<pid>.json + transcript JSONL
                              ├─ Codex:       screen markers + rollout JSONL
                              ├─ pi:          screen markers + session JSONL
                              └─ shell:       screen only
```

- **Input** goes through a tmux paste buffer followed by Enter. Nothing is installed in the sessions.
- **Output** comes from the agent's transcript file, not from scraping the screen. A shell has no
  transcript, so a shell gets a screen snapshot when the screen stops changing.
- **State** (`working`, `idle`, `blocked`, `shell`) comes from Claude Code's status file where there is
  one, and from screen markers for the other agents.
- A session already running in tmux needs no change. Start sessions the way you do today.

## Use it from the phone

| You do | Result |
|---|---|
| Send `面板`, or tap **会话** on any card | A new dashboard card |
| Tap **接入** on the dashboard | The chat is attached. Messages now go to that session |
| Send text while attached | The text is typed into the session. A live card shows tool calls and the reply |
| Send an image or file | It is saved under `~/.local/state/robin-hub/inbox/` and its path is sent to the session |
| Quote-reply a card of some session | The reply goes to that session without switching |
| Type in the box of a "finished" card | Same: a reply without switching |
| Tap **查看 / 屏幕** | A screen snapshot with keys (Enter, Esc, arrows, Tab, Ctrl-C, 1 2 3, y n) and an input box |
| Tap an option on a **等待确认** card | The matching key is sent to the dialog |
| Tap **断开** or **Pi 管家** | Back to the concierge |
| Tap **新建** | A form: name, agent type, with or without `-d` / `--yolo`, a new or a past conversation, directory, first message |

Voice messages are not forwarded. Dictate with the phone keyboard and send the text.

### Cards that refresh themselves

| Card | Refreshes | Until |
|---|---|---|
| Dashboard (the newest one) | When a session changes, once a minute while an agent runs, every 5 minutes otherwise | A newer dashboard is sent (13 days at most) |
| "已接入" card | When the session's state or last reply changes | You detach or switch |
| Screen card | Every 3 s, only if the screen changed | 10 minutes after the last tap on it (`live.peekMinutes`) |
| Turn card | With each output of the agent, and once a minute | The turn ends |

A card that stopped refreshing says so in its last line. Tapping **刷新** starts it again.
A refresh redraws the whole card, so text typed into a screen card's input box is lost if the
screen changes before you send it.

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

Session names are matched loosely everywhere (`//a proc`, `robinctl peek "gt proc"`): by part of
the tmux name, of the agent's title, of the directory, or by kind. A name that fits several
sessions gets a card with one button for each (in chat) or an error that lists them (`robinctl`).

### Notifications

A session that is not attached sends a card when a turn that ran for at least `notify.minWorkSec`
(20 s) ends, and when it waits on a dialog. These cards are skipped while a tmux client saw keyboard
input in the last `notify.quietIfLocalActiveSec` (180 s): at your desk the phone stays quiet.
Set that value to `0` to always notify.

## Run

```bash
~/robin-hub/scripts/cutover.sh     # stop the old bridge, install and start the service, post the dashboard
~/robin-hub/scripts/rollback.sh    # put the old bridge back

systemctl --user status robin-hub
journalctl --user -u robin-hub -f
```

One Feishu app delivers each event to one connection only. Do not run robin-hub and
`lark-channel-bridge --profile codex-second` at the same time.

### Config

`~/.config/robin-hub/config.json` (defaults are in `src/config.mjs`):

| Key | Meaning |
|---|---|
| `app.id`, `app.secret` | The Feishu app. The secret is a reference (`exec`, `env` or `file`), never the value. The default reads it from the lark-channel-bridge keystore |
| `owner.openId` | The only user whose messages and clicks are accepted |
| `owner.chatId` | The chat that receives the cards |
| `notify.*` | See Notifications |
| `live.peekMinutes` | How long a screen card refreshes itself (default 10) |
| `tmux.hide` | tmux session names to leave out |
| `agents.<type>` | How `新建` starts each type: `command` (new conversation), `continue` (latest one of the directory), `resume` (a chosen one), and `flags`, which fill `{flags}` unless the session is created without `-d` / `--yolo` |
| `agents.claude.autoTrust` | Answer Claude Code's "trust this folder" prompt for a session the hub created (default on) |
| `concierge.enabled`, `.model`, `.thinking` | The pi concierge. Empty model means pi's default |

Restart the service after a change.

### `robinctl`

`bin/robinctl` talks to the running hub over a Unix socket (`$XDG_RUNTIME_DIR/robin-hub.sock`).
The concierge uses it, and so can any script or agent on this machine:

```bash
robinctl ls                       # sessions and state
robinctl peek gt_process -n 60    # screen
robinctl send gt_process "继续"    # type into a session
robinctl attach proc               # loose names work: this finds gt_process
robinctl history                  # past Claude Code and Codex conversations
robinctl new fig --resume 魔方     # new tmux session that resumes the conversation with that title
robinctl new fix --agent codex --cwd ~/proj --no-yolo
robinctl show gt_process          # post the session's screen card to the chat
robinctl notify "渲染跑完了"        # push a card to the phone
```

## Security

- Only `owner.openId` can send messages or click cards. Group chats are closed.
- A click can send only the keys in `KEYS` (`src/tmux.mjs`). Text is pasted as data.
- The hub runs as your user. Anyone who controls the Robin chat on your Feishu account can type
  into your terminals. That is the purpose of the tool, and the same trust the old bridge had.
- The control socket has mode 600.

## Develop

```bash
npm test                                   # unit tests, no network, no tmux
node bin/robin-hub.mjs --fake              # real tmux, Feishu replaced by a recorder
robinctl dev say "//ls"                    # act as the owner
robinctl dev click '{"a":"attach","n":"gt_process"}'
robinctl dev outbox 3                      # cards the hub would have sent
```

Point `ROBIN_HUB_CONFIG` and `ROBIN_HUB_SOCK` at scratch paths for a fake run, so it does not share
the state and socket of the service.

| File | Role |
|---|---|
| `src/registry.mjs` | Poll tmux, classify panes, track state and turns, emit events |
| `src/transcript.mjs` | Find and follow the transcript of Claude Code, Codex and pi |
| `src/screen.mjs` | Read dialogs and "working" markers from a captured screen |
| `src/router.mjs` | Route messages and clicks, turn registry events into cards |
| `src/cards.mjs` | Card JSON 2.0 builders |
| `src/concierge.mjs` | The pi RPC client |
| `src/feishu.mjs` | Feishu channel wrapper, card update throttle, fake channel |
| `src/control.mjs`, `bin/robinctl.mjs` | Control socket and its CLI |
| `agent/CONCIERGE.md` | Instructions for the pi concierge |

## Limits

- Dialog detection reads the screen. A dialog layout it does not know shows as a screen excerpt
  with the key pad, without option buttons.
- Card edits do not ring the phone. A turn longer than `notify.minWorkSec` therefore ends with a
  new card.
- A card holds about 30 KB. Longer replies are cut, and the full text stays in the terminal.
- State is polled every 2 s. The end of a turn shows 2 to 4 s late.
