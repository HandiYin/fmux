# fmux

用一个飞书聊天窗口管理本机所有 tmux 会话，包括 Claude Code、Codex、pi 和普通 Shell。
fmux 将飞书机器人连接到它所在电脑的 tmux 会话，支持 Linux、macOS，以及通过 psmux 或 WSL 运行的 Windows 环境。

**详细安装指南：[docs/setup.zh.md](docs/setup.zh.md)**

- 聊天窗口每次**接入**一个 tmux 会话，类似 `tmux attach`。你发出的消息进入该会话，会话回复以飞书卡片返回。
- **会话面板**列出各个会话和状态：🟢 运行中、⚪ 已结束、🟠 等待确认。点击按钮即可接入或查看终端。
- 未接入的会话在一轮任务结束或需要确认时，也可以发送通知卡片。
- 未接入任何会话时，由 **pi 管家**回复。你可以用自然语言让它切换、查看或新建会话。

## 工作原理

```text
飞书应用 ⇄ @larksuite/channel（WebSocket）⇄ Router
                                          ├─► tmux send-keys / paste-buffer
                                          └─► pi --mode rpc（管家）
                                              ▲
                          Registry：每 2 秒轮询 tmux，读取会话状态
                          ├─ 进程：/proc（Linux、WSL）、ps + lsof（macOS）、PowerShell（Windows）
                          ├─ Claude Code：~/.claude/sessions/<pid>.json + 对话记录 JSONL
                          ├─ Codex：终端状态标记 + rollout JSONL
                          ├─ pi：终端状态标记 + 会话 JSONL
                          └─ Shell：终端画面
```

- **输入**通过 tmux 粘贴缓冲区发送，随后按 Enter 提交。Claude Code 的多行输入会逐键发送，行间使用 Ctrl+J，让它按键入内容处理。无需在已有会话中安装插件。
- **回复**从 Agent 的对话记录文件读取。普通 Shell 没有对话记录，因此在画面停止变化后返回终端截图式卡片。
- **状态**包括 `working`、`idle`、`blocked`、`shell`。Claude Code 优先读取状态文件，其他 Agent 根据终端画面中的标记判断。
- 已经在 tmux 中运行的会话可以直接接入，继续按原来的方式启动 Agent 即可。

对于使用共享 app-server 的 Codex，fmux 通过终端显示的对话名称查询会话索引，核对会话 ID 和目录后读取对应记录，恢复旧对话时也适用。已有唯一名称的对话无需重复改名；仅在尚未命名或名称重复时，使用 `/rename` 设置唯一名称，并保留 tmux 的自动窗格标题更新。

运行时的 `⠋` 等动画标记和结束时的 `●` 标记会被识别，不影响会话匹配。fmux 不会仅凭“同目录最近更新”来选择 Codex 的记录；无法确认会话身份时，会在卡片中说明，并提供终端查看入口。

## 在手机上使用

| 操作 | 结果 |
|---|---|
| 发送 `面板` | 显示各会话及其状态的面板卡片 |
| 点击可选菜单中的**会话面板** | 在聊天末尾发送新面板，保持当前接入 |
| 点击可选菜单中的**回到管家** | 断开当前接入并显示面板，tmux 任务继续运行 |
| 点击可选菜单中的**新建会话** | 打开新建会话表单，提交前不会创建会话 |
| 点击**接入** | 后续消息发送到该会话，并显示当前接入的会话卡片 |
| 接入后发送文字 | 将文字输入会话，回复卡片持续更新过程，结束后保留最终回复 |
| 发送图片或文件 | 保存到 `~/.local/state/fmux/inbox/`，并将文件路径发送到会话 |
| 引用回复某个会话的卡片 | 将回复发送到该会话，无需切换当前接入 |
| 对管家说“把 A 的最后一条回复发给 B，让它照着改” | 将你的说明作为输入、A 的最后一条回复作为粘贴内容交给 B，随后转发 B 的回复 |
| 在“已结束”卡片的输入框中回复 | 同样直接回复该会话，无需切换 |
| 点击**查看** | 显示状态、上一条输入和最后回复；普通 Shell 显示终端画面 |
| 点击**终端** | 显示适合手机阅读的最近 18 行、四个常用按键、折叠的更多按键和输入框 |
| 点击**等待确认**卡片中的选项 | 向终端对话框发送对应按键 |
| 点击**断开**，或发送 `//d` | 退出接入，回到管家 |
| 点击**新建会话** | 打开表单，选择新对话或历史对话、Agent 类型、是否启用 `-d` / `--yolo`、目录、可选名称和首条消息 |

暂不转发语音消息。可以使用手机键盘的语音输入功能，转成文字后发送。

**悬浮菜单是可选升级**：按钮常驻输入框上方，长对话中也能随时回到面板。默认安装不订阅菜单事件、
不申请应用管理权限，仍可用 `面板`、`//ls` 和 `//d` 操作。按[菜单升级指南](docs/setup.zh.md#机器人底部菜单)
在飞书开发者后台手动配置，无需额外 API 权限；选择 API 部署时，需为自己的飞书应用开通
`application:application:patch`。菜单点击由 fmux 直接处理，Agent 正在工作或等待确认时也可使用。

### 卡片显示与刷新

卡片标题仅在需要关注时显示颜色：运行中为绿色，等待确认时为橙色。每张卡片只展示当前状态需要的按钮。

| 卡片 | 刷新方式 | 停止刷新条件 |
|---|---|---|
| 会话面板 | 会话变化时更新；有 Agent 运行时每分钟更新，否则每 5 分钟更新 | 发送了新面板，旧面板缩为一行 |
| 会话卡片（查看、接入） | 更新状态和按钮；未接入时也更新最后回复 | 默认 10 分钟（`live.peekMinutes`），或同一会话出现更新的卡片 |
| 终端卡片 | 每 3 秒检查一次，画面变化时更新 | 距离最后一次点击超过 10 分钟 |
| 回复卡片 | 随 Agent 输出持续更新 | 本轮结束，卡片保留回复 |

运行超过 `notify.minWorkSec` 的一轮结束时，会额外发送一条引用回复卡片的简短文字，以触发手机通知；单纯编辑卡片不会触发通知。卡片刷新会重绘整张卡片，因此在终端卡片输入框中尚未发送的文字，可能因画面更新而丢失。

接入会话后，fmux 命令使用 `//` 前缀，单个 `/` 留给会话内的命令，例如 `/compact`、`/model`。未接入时，也可以用单个 `/` 操作 fmux。

```text
//ls                    会话面板             //peek [session]        查看终端
//a <number|name>       接入会话             //key [session] esc 1   发送按键
//d                     断开接入             //new [name agent dir]  新建会话
//pi <message>          不断开当前会话，直接询问管家
//stop                  向当前接入的会话发送 Esc
```

### 新建和恢复会话

| 选项 | Claude Code | Codex |
|---|---|---|
| 启用 `-d` / `--yolo`（默认） | `claude -d --permission-mode auto` | `codex --yolo` |
| 不启用 | `claude` | `codex` |
| 新对话 | `… -n <session name>` | 使用普通启动命令 |
| 继续该目录最近一次对话 | `… -c` | `… resume --last` |
| 恢复指定历史对话 | 在该对话的目录下运行 `… -r <id>` | 在该对话的目录下运行 `… resume <id>` |

`claude -d` 是 Claude Code 的调试模式；控制自动处理权限请求的是 `--permission-mode auto`。表单列出最近 10 条 Claude Code 和 5 条 Codex 历史对话，排除目录已不存在的记录，以及已经由运行中的 Claude Code 打开的对话。

选择会话时支持模糊匹配，例如 `//a proc`、`fmuxctl peek "gt proc"`，可以按 tmux 名称、Agent 标题、目录的一部分或 Agent 类型查找。匹配到多个会话时，飞书中会显示选择按钮，`fmuxctl` 会列出候选项并报错。

### 通知

未接入的会话在运行至少 `notify.minWorkSec`（默认 20 秒）的一轮结束时，或等待对话框确认时，发送通知卡片。

如果 tmux 客户端在最近 `notify.quietIfLocalActiveSec`（默认 180 秒）内收到过键盘输入，则跳过这些通知，避免你正在电脑前操作时手机重复提醒。将该值设为 `0` 可始终通知。

## 安装与运行

需要 Node.js 20.12 或更新版本，以及 tmux。各个 Agent（`claude`、`codex`、`pi`）按需安装。

| 系统 | 使用的组件 | 服务托管方式 | 验证情况 |
|---|---|---|---|
| Linux | tmux、`/proc` | systemd 用户服务 | 已用于日常使用，通过单元测试和端到端测试 |
| macOS | tmux、系统自带的 `ps` 和 `lsof` | launchd 用户服务 | `ps`、`lsof` 实现已在 Linux 上通过端到端测试，尚未在 Mac 上实测 |
| Windows | 通过 [psmux](https://github.com/psmux/psmux) 提供 `tmux`，通过 PowerShell 查询进程 | 登录时启动的 psmux 会话 | 根据 psmux 文档实现，解析逻辑有单元测试，尚未在 Windows 上实测 |
| Windows、WSL 2 | 使用 Linux 实现，fmux、tmux 和 Agent 均运行在 WSL 内 | 有 systemd 时使用 systemd，否则使用 tmux 会话 | 已在无 systemd 的容器内通过端到端测试，尚未在 WSL 上实测 |

各系统的差异见[平台说明](#平台说明)。

```bash
git clone https://github.com/Primatix-Intelligence/fmux.git ~/fmux
cd ~/fmux && npm install
ln -s ~/fmux/bin/fmux ~/fmux/bin/fmuxctl ~/.local/bin/    # Windows 使用 npm link

fmux doctor             # 检查环境、依赖和服务状态
```

根据现有情况连接飞书机器人：

| 当前情况 | 操作 | 安装指南中的章节 |
|---|---|---|
| 还没有机器人 | 运行 `fmux setup`，用飞书扫码，自动创建机器人并申请所需权限 | 方式 A |
| 还没有机器人，希望手动创建应用 | 在开发者后台创建应用，填写配置后运行 `fmux pair` | 方式 B |
| 已有机器人，之前由 `lark-channel-bridge` 使用 | 停止 bridge，运行 `fmux setup --app-id cli_xxx --from-lark-channel-bridge`，复用现有应用 | 方式 C1 |
| 已有机器人，之前由其他程序使用，或以前手动创建 | 停止原程序，运行 `fmux setup --app-id cli_xxx` 并填写 App Secret；等待期间在开发者后台将事件和回调设置为长连接，并补齐权限 | 方式 C2 |

各方式的最后一步相同：向机器人发送一条消息，将该消息的发送者绑定为主人。

```bash
fmux install-service    # Linux 使用 systemd，macOS 使用 launchd，其他情况使用 tmux 会话
```

随后向机器人发送 `面板` 即可开始使用。详细安装指南还包含 Agent 配置和排错步骤。
`fmux doctor` 可以查看主服务是否运行，以及由哪种方式托管。

一个飞书应用的每个事件只会交给一个连接处理。请避免让其他程序（例如 `lark-channel-bridge` 或另一个 fmux 实例）同时连接同一个应用。

### 平台说明

`fmux install-service` 会选择适合当前系统的服务管理方式，并继承执行安装命令时 Shell 的 `PATH`。请在能找到 `tmux`、`claude`、`codex` 等命令的终端中执行它。

| 项目 | 使用 systemd 的 Linux | macOS | 无 systemd（部分 WSL、容器），或指定 `--tmux` |
|---|---|---|---|
| 运行位置 | `~/.config/systemd/user/fmux.service` | `~/Library/LaunchAgents/com.primatix.fmux.plist` | tmux 会话 `fmux-hub`，在面板中隐藏 |
| 启动时机 | 执行 `loginctl enable-linger $USER` 后可随系统启动 | 用户登录时 | 手动启动；安装命令会输出可添加到 `~/.profile` 的启动命令 |
| 状态 | `systemctl --user status fmux` | `launchctl print gui/$(id -u)/com.primatix.fmux` | `tmux has-session -t =fmux-hub` |
| 日志 | `journalctl --user -u fmux -f` | `tail -f ~/Library/Logs/fmux.log` | `tmux attach -t fmux-hub` |
| 重启 | `systemctl --user restart fmux` | `launchctl kickstart -k gui/$(id -u)/com.primatix.fmux` | `fmux install-service --tmux` |
| 停止 | `systemctl --user stop fmux` | `launchctl bootout gui/$(id -u)/com.primatix.fmux` | `tmux kill-session -t =fmux-hub` |
| 控制套接字 | `$XDG_RUNTIME_DIR/fmux.sock` | `~/.local/state/fmux/fmux.sock` | 使用对应系统的路径 |

**macOS**

使用 `brew install tmux node` 安装依赖。仅通过 SSH 使用、没有登录桌面的 Mac 不具备 launchd 的 `gui` 域，请使用 `fmux install-service --tmux`。Mac 休眠期间主服务无法响应。

**Windows 与 psmux**

tmux 不能原生运行在 Windows 上。psmux 提供兼容的命令接口，并安装名为 `tmux` 的命令，让 Agent 直接运行在 Windows 环境中。

```powershell
winget install psmux
git clone https://github.com/Primatix-Intelligence/fmux.git $HOME\fmux
cd $HOME\fmux; npm install; npm link        # npm link 将 fmux 和 fmuxctl 加入 PATH
fmux doctor
```

与 Linux 一样，使用 `tmux new -s name` 启动会话。主要差异如下：

- 主服务运行在名为 `fmux-hub` 的 psmux 会话中。`fmux install-service` 还会向启动文件夹写入 `fmux.cmd`，让服务在登录时启动；删除该文件即可取消登录启动。控制通道为命名管道 `\\.\pipe\fmux-<user>`。
- 注销或重启 Windows 会结束会话。
- Windows 无法直接判断进程从哪里读取输入，因此根据命令行识别由程序驱动的 Agent，例如 `codex app-server`、`claude -p`、`pi --mode rpc`。
- psmux 不报告客户端最后一次输入时间，`notify.quietIfLocalActiveSec` 因此不生效，符合通知条件的结束事件会始终通知。
- 多行文字通过粘贴发送，新会话的首条消息按 PowerShell 规则转义。
- 管家需要 pi，而 pi 在 Windows 上需要 Git Bash。不使用管家时，将 `concierge.enabled` 设为 `false`。Windows 不支持 `fmux setup --from-lark-channel-bridge`。

**Windows 与 WSL 2**

安装 WSL（`wsl --install`）后，在 WSL 内按 Linux 步骤安装。tmux、Node.js 和 Agent 都需要安装在 WSL 内，代码目录也应放在 Linux 文件系统中，例如 `~/fmux`。安装在 Windows 一侧的 `claude` 或 `codex` 不属于 WSL 内的 tmux 会话。

如需启用 systemd，在 `/etc/wsl.conf` 中添加 `[boot]` 和 `systemd=true`，然后在 Windows 中执行 `wsl --shutdown`。systemd 服务本身不会让 WSL 持续运行，需要保留一个打开的 WSL 窗口。

### 配置

配置文件为 `~/.config/fmux/config.json`，默认值见 `src/config.mjs`。

| 配置项 | 含义 |
|---|---|
| `app.id`、`app.secret` | 飞书应用信息。Secret 通过引用读取，不直接写入配置：`{"source":"file","path":…}`、`{"source":"env","name":…}`，或密钥提供程序使用的 `{"source":"exec","command":…,"id":…}` |
| `app.tenant` | `feishu`（默认）或 `lark` |
| `owner.openId` | 唯一允许发送消息和点击卡片的用户 |
| `owner.chatId` | 接收卡片的聊天 |
| `notify.*` | 通知设置，见[通知](#通知) |
| `live.peekMinutes` | 会话查看卡片和终端卡片的自动刷新时长，默认 10 分钟 |
| `tmux.hide` | 面板中隐藏的 tmux 会话名称 |
| `agents.<type>` | 各类 Agent 的启动方式：`command` 新建对话，`continue` 继续目录最近一次对话，`resume` 恢复指定对话；`flags` 填入 `{flags}`，新建时不启用 `-d` / `--yolo` 则留空 |
| `agents.claude.autoTrust` | 自动确认由主服务创建的 Claude Code 会话中的“信任此文件夹”提示，默认开启 |
| `concierge.enabled`、`.model`、`.thinking` | pi 管家配置；模型为空时使用 pi 的默认设置 |

修改配置后重启服务。

### `fmuxctl` 命令行工具

`bin/fmuxctl` 通过 Unix 套接字或 Windows 命名管道与运行中的主服务通信，路径见[平台说明](#平台说明)。管家使用这个接口，本机的脚本或 Agent 也可以使用：

```bash
fmuxctl ls                       # 列出会话和状态
fmuxctl peek gt_process -n 60    # 查看终端最近 60 行
fmuxctl send gt_process "继续"    # 向会话输入文字
fmuxctl handoff proc coll "照这个结论改"   # 将 gt_process 的最后回复和你的说明交给 gt_collection
fmuxctl attach proc               # 支持模糊名称，这里匹配 gt_process
fmuxctl history                  # 查看 Claude Code 和 Codex 的历史对话
fmuxctl new fig --resume 魔方     # 新建 tmux 会话并恢复该标题的对话
fmuxctl new fix --agent codex --cwd ~/proj --no-yolo
fmuxctl show gt_process          # 向聊天发送会话卡片，添加 --terminal 可发送终端卡片
fmuxctl notify "渲染跑完了"        # 向手机发送通知卡片
```

## 安全说明

- 只接受 `owner.openId` 对应用户的消息和卡片操作，不响应群聊。
- 卡片点击只能发送 `KEYS`（`src/tmux.mjs`）中允许的按键；文字通过粘贴作为数据输入。
- 主服务以你的系统用户身份运行。控制你的飞书账号的人可以通过机器人向终端输入内容，因此应保护好飞书账号。
- 除非在表单中另行选择，新建 Claude Code 会话默认使用自动权限模式，Codex 默认使用 `--yolo`。可以通过 `agents.<type>.flags` 修改默认参数。
- Unix 控制套接字的权限为 `600`。

## 开发与测试

```bash
npm test                                   # 单元测试，不访问网络，不依赖 tmux
npm run test:integration                   # 独立 tmux、模拟 Agent、临时 HOME 和模拟飞书通道
FMUX_PROCS=ps npm run test:integration     # 使用 macOS 的进程查询方式运行相同测试
fmux --fake                                # 使用真实 tmux，将飞书替换为记录器
fmuxctl dev say "//ls"                    # 模拟主人发消息
fmuxctl dev click '{"a":"attach","n":"gt_process"}'
fmuxctl dev outbox 3                      # 查看主服务准备发送的卡片
```

运行模拟环境时，将 `FMUX_CONFIG` 和 `FMUX_SOCK` 指向临时路径，避免与已运行的服务共用状态和套接字。

| 文件 | 职责 |
|---|---|
| `src/registry.mjs` | 轮询 tmux，识别窗格类型，跟踪状态和对话轮次，发出事件 |
| `src/procs.mjs`、`src/win/procs.ps1` | 通过 `/proc`、`ps` 和 `lsof` 或 Windows 进程表定位窗格中的 Agent 进程 |
| `src/transcript.mjs` | 定位并跟踪 Claude Code、Codex 和 pi 的对话记录 |
| `src/codex-transcript.mjs` | 根据打开的文件或唯一会话名称定位 Codex 记录，识别标题中的运行和完成标记 |
| `src/screen.mjs` | 从终端画面识别对话框和运行状态标记 |
| `src/router.mjs` | 路由消息和点击事件，将会话事件转换成卡片 |
| `src/cards.mjs` | 生成 Card JSON 2.0 卡片 |
| `src/concierge.mjs` | pi RPC 客户端 |
| `src/feishu.mjs` | 飞书通道封装、卡片更新限流和模拟通道 |
| `src/control.mjs`、`bin/fmuxctl.mjs` | 本地控制接口及命令行工具 |
| `src/setup.mjs`、`bin/fmux.mjs` | 实现 `fmux setup`、`pair`、`install-service`、`doctor` |
| `src/service.mjs` | 服务托管：systemd、launchd 或 tmux 会话，Windows 使用 psmux |
| `test/integration/` | 在独立 tmux 服务中使用模拟 Agent 进行端到端测试 |
| `src/history.mjs`、`src/match.mjs` | 查询可恢复的历史对话，以及会话名称模糊匹配 |
| `agent/CONCIERGE.md` | pi 管家的行为规则 |

## 已知限制

- 对话框检测依赖终端画面。遇到尚未适配的布局时，会显示终端片段和按键区，不会生成对应的选项按钮。
- 编辑卡片不会触发手机通知，因此超过 `notify.minWorkSec` 的一轮结束时，会额外发送简短文字。
- 每张卡片的大小上限约为 30 KB。较长回复会被截断，完整内容仍保留在终端。
- 默认每 2 秒轮询状态，任务结束的显示通常有 2～4 秒延迟。
