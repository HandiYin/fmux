# fmux 使用指引

fmux 把一个飞书机器人接到你电脑上的 tmux 会话。你在手机飞书里给机器人发消息，消息进入你选中的
tmux 会话；会话里的 Claude Code、Codex 或 pi 的回复以卡片发回来。

这份指引讲四件事：安装、配置飞书机器人、配置 Agent、排错。

配置飞书机器人有三种方式，选一种：扫码新建（A）、在开发者后台手工新建（B）、用已有的机器人（C）。

## 1. 准备

| 需要 | 说明 |
|---|---|
| Linux、macOS 或 Windows | 见下面「各系统的差别」。Windows 上用 psmux 代替 tmux，或者装在 WSL 里 |
| Node.js 20.12 以上 | `node --version` |
| tmux | `tmux -V`。Windows 上装 psmux，它提供 `tmux` 命令 |
| Claude Code 或 Codex | 命令 `claude`、`codex`，各自先在终端里登录好 |
| pi（可选） | 管家用。不装就在配置里关掉管家 |
| 飞书账号 | 能创建企业自建应用 |

### 各系统的差别

| | Linux | macOS | Windows（psmux） | Windows（WSL 2） |
|---|---|---|---|---|
| 装在哪里 | 本机 | 本机 | Windows 本身。Agent 也装在 Windows 上 | WSL 里。fmux、tmux、`claude`、`codex` 都装在 WSL 里 |
| 装依赖 | 发行版的包管理器 | `brew install tmux node` | `winget install psmux`，再装 Node.js | 在 Windows 里运行 `wsl --install`，然后在 WSL 里按 Linux 来 |
| 服务由谁托管 | systemd 用户服务 | launchd | 一个 psmux 会话，登录时自动拉起 | WSL 开了 systemd 就用 systemd，否则用一个 tmux 会话 |
| 验证情况 | 日常在用 | 进程识别的代码在 Linux 上通过了端到端测试，还没有在 Mac 上跑过 | 按 psmux 的文档写的，解析部分有单测，还没有在 Windows 上跑过 | 无 systemd 的情况在容器里通过了端到端测试，还没有在 WSL 上跑过 |

#### Windows（psmux）

tmux 不能在 Windows 上运行。[psmux](https://github.com/psmux/psmux) 是 Windows 上的 tmux：命令相同，安装后就有 `tmux` 命令。
会话照常用 `tmux new -s 名字` 开。和 Linux 不同的地方：

- 安装时用 `npm link` 代替 `ln -s`，它把 `fmux` 和 `fmuxctl` 放进 PATH。
- 注销或重启 Windows 后，会话不保留。
- 「本机有键盘输入时不通知」不起作用：psmux 不报告这个时间，一轮结束总会通知。
- 多行消息以粘贴方式进入会话。新建会话时填的第一条消息按 PowerShell 的引号规则传入，窗格的 shell 要是 PowerShell。
- 由别的程序驱动的 Agent（`codex app-server`、`claude -p`、`pi --mode rpc`）按命令行识别，不算会话里的 Agent。
- 管家要用 pi，pi 在 Windows 上需要 Git Bash。不想装就把 `concierge.enabled` 设为 `false`。
- 没有 `fmux setup --from-lark-channel-bridge`。已有的机器人走方式 C2。

#### Windows（WSL 2）

- 代码放在 WSL 自己的文件系统里（`~/fmux`），不要放在 `/mnt/c` 下。
- 装在 Windows 一侧的 `claude`、`codex` 不在 WSL 的 tmux 里，fmux 管不到。在 WSL 里再装一份并登录。
- 想用 systemd：在 `/etc/wsl.conf` 里写 `[boot]` 和 `systemd=true` 两行，在 Windows 里运行 `wsl --shutdown`，再打开 WSL。

## 2. 安装

```bash
git clone https://github.com/Primatix-Intelligence/fmux.git ~/fmux
cd ~/fmux && npm install
mkdir -p ~/.local/bin && ln -s ~/fmux/bin/fmux ~/fmux/bin/fmuxctl ~/.local/bin/
fmux doctor
```

Windows（psmux）在 PowerShell 里：

```powershell
winget install psmux
git clone https://github.com/Primatix-Intelligence/fmux.git $HOME\fmux
cd $HOME\fmux; npm install; npm link
fmux doctor
```

`fmux doctor` 列出已就绪和缺少的东西。

## 3. 配置飞书机器人

一个机器人只接一台电脑。每个人、每台电脑用自己的机器人。

以下是基础配置，不包含菜单事件或应用管理权限。想让按钮常驻输入框上方，可在安装完成后选择
[机器人底部菜单](#机器人底部菜单)升级；不升级也能使用消息、卡片和文字命令。

### 方式 A：扫码创建

```bash
fmux setup
```

1. 终端显示二维码。用手机飞书扫码。
2. 在手机页面上给机器人起名字，确认创建。页面已经带上 fmux 需要的权限、事件和回调。
3. 终端显示「应用已创建」，接着显示「已连上飞书」。
4. 在飞书里搜索机器人的名字，给它发一条消息，内容随意。
5. 终端显示「已绑定」。机器人回你一条「已绑定」。

第 4 步的发送人成为机器人的主人。之后只有主人的消息和点击会被接受。

`fmux setup` 写两个文件：

| 文件 | 内容 |
|---|---|
| `~/.config/fmux/config.json` | 应用 ID、主人的 open_id |
| `~/.config/fmux/app-secret` | App Secret，权限 600 |

### 方式 B：在开发者后台手工创建

1. 打开 <https://open.feishu.cn/app>，创建企业自建应用。
2. 「添加应用能力」里添加「机器人」。
3. 「权限管理」里开通这四项：

   | 权限 | 用途 |
   |---|---|
   | `im:message.p2p_msg:readonly` | 接收你发给机器人的单聊消息 |
   | `im:message:send_as_bot` | 发卡片、更新卡片 |
   | `im:message:readonly` | 下载你发的图片和文件 |
   | `im:message.reactions:write_only` | 消息送达后加「OK」表情 |

4. 「凭证与基础信息」里复制 App ID 和 App Secret，写进配置：

   ```bash
   mkdir -p ~/.config/fmux && chmod 700 ~/.config/fmux
   cp ~/fmux/config.example.json ~/.config/fmux/config.json    # 把 app.id 改成你的 App ID
   printf '%s\n' '你的 App Secret' > ~/.config/fmux/app-secret
   chmod 600 ~/.config/fmux/app-secret
   ```

5. 运行 `fmux pair`，让它一直开着。它和飞书建立长连接。后台要求先有长连接，才能保存下面两步的设置。
6. 「事件与回调」→「事件配置」：订阅方式选「使用长连接接收事件」，添加事件「接收消息」
   （`im.message.receive_v1`）。
7. 「事件与回调」→「回调配置」：订阅方式选「使用长连接接收回调」，添加回调「卡片回传交互」
   （`card.action.trigger`）。
8. 「版本管理与发布」里创建版本，可用范围选你自己，发布。
9. 在飞书里给机器人发一条消息。`fmux pair` 显示「已绑定」后退出。

### 方式 C：用已有的机器人

已经有一个飞书机器人应用，就不用再申请。把它直接接到 fmux。应用本身不会被改动，随时可以换回去。

先确认两点：

- 这个机器人只有你一个人用。fmux 只听一个主人的私聊，不响应群聊。团队共用的机器人不要接过来，另建一个。
- 你能进这个应用的开发者后台，或者手里有它的 App ID 和 App Secret。

#### C1：机器人原来接在 lark-channel-bridge 上

这类应用是扫码创建的，权限、事件、回调都已经齐全，密钥在 lark-channel-bridge 的密钥库里。

1. 停掉它：`lark-channel-bridge stop --profile <你的 profile>`。
2. 运行：

   ```bash
   fmux setup --app-id cli_xxxxxxxx --from-lark-channel-bridge
   ```

3. 终端显示「已连上飞书」后，在飞书里给机器人发一条消息。终端显示「已绑定」。

#### C2：机器人原来接在别的程序上，或者是你自己建的

别的程序指 OpenClaw、自己写的机器人服务、各种 Agent 平台的本地端等。步骤多三件事：手工填密钥、
把收消息的方式改成长连接、补齐缺的权限。

1. 停掉原来的程序。一个应用只能有一个长连接，两个程序同时连会各收到一部分消息。
2. 在开发者后台的「凭证与基础信息」里复制 App ID 和 App Secret，然后运行：

   ```bash
   fmux setup --app-id cli_xxxxxxxx
   ```

   按提示粘贴 App Secret。输入不显示。Lark 国际版的应用加 `--lark`。
3. 终端显示「已连上飞书」。让它开着，最多等 10 分钟。这时去开发者后台核对下面五项，缺的补上：

   | 位置 | 要求 |
   |---|---|
   | 应用能力 | 有「机器人」 |
   | 权限管理 | 有方式 B 第 3 步的四项权限 |
   | 事件与回调 → 事件配置 | 订阅方式是「使用长连接接收事件」，已添加「接收消息」（`im.message.receive_v1`） |
   | 事件与回调 → 回调配置 | 订阅方式是「使用长连接接收回调」，已添加「卡片回传交互」（`card.action.trigger`） |
   | 版本管理与发布 | 改过权限、事件或回调后，创建新版本并发布 |

   原来的程序用「请求地址」收事件时，订阅方式是「将事件发送至开发者服务器」。把事件和回调两处都改成长连接。
   改完后原来的程序收不到事件，这是预期的。
4. 在飞书里给机器人发一条消息。终端显示「已绑定」。

第 3 步超时了就再运行一次 `fmux pair`，不用重填密钥。

#### 换回原来的程序

先停掉 fmux（命令见第 4 节的表，Linux 上是 `systemctl --user disable --now fmux`），然后启动原来的程序。C2 里改过订阅方式的，在开发者后台把事件和回调的订阅方式改回去。

## 4. 启动

```bash
fmux install-service
```

在装好 `tmux`、`claude`、`codex` 的终端里运行它：服务用的是这个终端的 `PATH`。
它按系统选托管方式，并打印用了哪一种。然后在飞书里给机器人发「面板」。出现会话面板就成功了。

| | Linux（有 systemd） | macOS | Windows（psmux）；没有 systemd 的 WSL；或加了 `--tmux` |
|---|---|---|---|
| 托管方式 | systemd 用户服务 | launchd | tmux 会话 `fmux-hub`，不出现在面板里 |
| 自动启动 | 开机。先运行 `loginctl enable-linger $USER` | 登录后 | Windows：登录后，靠启动文件夹里的 `fmux.cmd`，删掉它就不再自启。其他：不会，命令会打印一行，加到 `~/.profile` 后登录时拉起 |
| 看状态 | `systemctl --user status fmux` | `launchctl print gui/$(id -u)/com.primatix.fmux` | `tmux has-session -t =fmux-hub` |
| 看日志 | `journalctl --user -u fmux -f` | `tail -f ~/Library/Logs/fmux.log` | `tmux attach -t fmux-hub` |
| 改配置后重启 | `systemctl --user restart fmux` | `launchctl kickstart -k gui/$(id -u)/com.primatix.fmux` | `fmux install-service --tmux` |
| 停止 | `systemctl --user stop fmux` | `launchctl bootout gui/$(id -u)/com.primatix.fmux` | `tmux kill-session -t =fmux-hub` |

换主人：先停止，运行 `fmux pair`，再运行 `fmux install-service`。

- macOS：只通过 SSH 使用、没有登录桌面的 Mac，用 `fmux install-service --tmux`。Mac 睡眠时机器人不在线。
  项目在「文稿」「桌面」「下载」目录下时，macOS 可能弹窗问是否允许 `node` 访问，选允许。
- WSL：systemd 服务不能让 WSL 保持运行。关掉最后一个 WSL 窗口后 WSL 可能停止，fmux 和 tmux 会话随之停止。
  要长期运行，留一个 WSL 窗口开着，并且不要让 Windows 睡眠。

## 5. 怎么用

| 你做什么 | 结果 |
|---|---|
| 发「面板」 | 会话面板：每个 tmux 会话一行，带状态灯 |
| 点「接入」 | 之后你发的消息都进这个会话。回复在一张卡片里边做边更新 |
| 点「查看」 | 这个会话的状态、上一条输入、最新回复 |
| 点「终端」 | 终端最后 18 行和几个按键，用来处理卡住的提示 |
| 点「新建会话」 | 填表新开一个 tmux 会话，可以恢复以前的对话 |
| 点「断开」 | 回到管家。没接入时消息由管家处理 |
| 引用某张卡片回复 | 消息进那张卡片所属的会话，不用切换 |
| 对管家说「把 A 的最后一条回复发给 B，让它照着改」 | 转交：B 收到你的话和 A 的最新回复，B 的回复以卡片发回来 |

状态灯：🟢 运行中，⚪ 已结束，🟠 等待确认。

已经在 tmux 里跑着的会话不用做任何改动，fmux 会自动发现它们。其余用法见 [README](../README.md)。

### 机器人底部菜单

**可选升级。** 悬浮菜单的三个按钮常驻输入框上方，不会随聊天消息被翻走，适合接入 tmux 后的长对话。
fmux 直接处理菜单点击，不调用模型；Agent 正在工作或等待确认时也可打开面板。

默认安装只申请第 3 节的四项消息权限、消息事件和卡片回调，`fmux setup` 不会自动订阅菜单事件、
配置菜单或申请应用管理权限。不启用菜单时，发「面板」或 `//ls` 打开面板，发 `//d` 回到管家。

| 启用方式 | 需要额外申请 API 权限吗 | 适合谁 |
|---|---|---|
| 在飞书开发者后台手动配置（推荐） | 不需要 `application:application:patch` | 能管理自己机器人应用的用户 |
| 通过开放平台 API 配置和发布 | 需要为该应用开通 `application:application:patch` | 希望用脚本部署的应用开发者 |

菜单事件 `application.bot.menu_v6` 本身无需额外订阅权限。权限和菜单配置属于**飞书应用**，
每个独立应用配置一次；不需要每个 tmux 会话或 Agent 单独申请。应用发布仍按所在企业的审核规则处理。

#### 手动启用（推荐）

1. 在 fmux 的代码目录更新代码和依赖：

   ```bash
   git pull --ff-only
   npm ci
   ```

   按第 4 节对应平台的命令重启 fmux，并保持它在线。已有应用不需要重新运行 `fmux setup` 或重新绑定主人。
2. 在飞书开发者后台的「事件与回调 → 事件配置」中，保留已有事件，添加「机器人自定义菜单事件」
   （`application.bot.menu_v6`），继续使用长连接接收。
3. 在「应用能力 → 机器人」中开启「机器人自定义菜单」，展示样式选择「悬浮菜单」，添加以下三个一级菜单，响应动作均选「推送事件」：

   | 菜单名称 | 事件 Key | 点击结果 |
   |---|---|---|
   | 会话面板 | `fmux.dashboard` | 在聊天最新位置发送面板，保持当前接入 |
   | 回到管家 | `fmux.concierge` | 断开当前接入并发送面板，tmux 里的任务继续运行 |
   | 新建会话 | `fmux.new` | 打开新建会话表单，提交前不会创建会话 |

4. 保存菜单，创建新版本并发布。使用飞书 7.22 及以上版本，发布成功约 5 分钟后重新进入机器人单聊，在输入框上方查看三个菜单按钮。悬浮菜单无需切换输入框；群聊不支持机器人菜单。
5. 点击「会话面板」确认聊天末尾出现新面板；接入会话后点击「回到管家」，确认回到管家且原 tmux 任务继续运行。

菜单只接受配置中主人的点击，重复和过期事件会被忽略。菜单事件与消息共用 fmux 已有长连接，
不要为菜单再启动一个机器人进程。暂时看不到菜单时，可先使用上述文字命令，并核对客户端版本、
应用发布状态、菜单展示样式和菜单事件订阅。

#### API 配置和发布（可选）

选择 API 方式时，先为自己的飞书应用申请 `application:application:patch`，完成该权限的发布和审批后再部署。
该权限用于管理应用配置，fmux 的日常消息转发和菜单点击处理不依赖它。仍需先按上面的第 1 步更新并重启 fmux。

在代码目录生成菜单能力请求体（只输出 JSON，不调用飞书接口）：

```bash
node --input-type=module -e "import { botMenuConfig } from './src/bot-menu.mjs'; console.log(JSON.stringify(botMenuConfig(), null, 2))"
```

使用该应用的 `tenant_access_token`，按顺序调用以下接口；路径前缀均为 `https://open.feishu.cn/open-apis`：

| 操作 | 接口 | 请求内容 |
|---|---|---|
| 更新机器人能力 | `PATCH /application/v7/applications/:app_id/ability` | 生成的菜单配置，按需合并应用现有机器人配置 |
| 添加菜单事件 | `PATCH /application/v7/applications/:app_id/config` | `{"event":{"subscription_type":"websocket","add_events":["application.bot.menu_v6"]}}` |
| 发布应用 | `POST /application/v7/applications/:app_id/publish` | 新的 `version`、`remark`、`changelog`，以及应用现有的 `mobile_default_ability` 和 `pc_default_ability` |

生成的配置带有中文菜单名称（`default_name` 和 `i18n_name.zh_cn`）及悬浮样式（`bot_menu_display_strategy: 3`）。
保留应用其他能力、权限、事件、回调和可见范围；若应用已有自定义菜单，先合并需要保留的菜单。
只启用机器人的应用，发布请求中的两个默认能力值均为 `bot`；有其他能力的应用沿用当前设置。
提交成功后，核对线上版本、菜单配置和事件订阅已生效，再按手动启用的第 4、5 步验证。

不想继续使用菜单时，在开发者后台关闭「机器人自定义菜单」并发布即可；消息、卡片和文字命令仍可正常使用。

官方说明：[机器人自定义菜单](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/bot-v3/bot-customized-menu)、
[菜单点击事件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/application-v6/bot/events/menu)、
[更新应用能力](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/application-v7/application-v7/application-ability/patch)、
[发布应用](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/application-v7/application-v7/application-publish/create)。

## 6. 配置 Agent

### 新建会话时怎么启动

表单里「免确认」选「是」时，fmux 用下面的命令启动 Agent。选「否」时去掉 `flags` 那一段。

| 类型 | 默认命令 |
|---|---|
| Claude Code | `claude -d --permission-mode auto -n <会话名>` |
| Codex | `codex --yolo` |
| pi | `pi` |

`claude -d` 是调试模式。让 Claude Code 不逐条询问权限的是 `--permission-mode auto`。

在 `~/.config/fmux/config.json` 里改默认值。例子：Claude 不要调试模式，Codex 不要 `--yolo`。

```json
{
  "agents": {
    "claude": { "flags": "--permission-mode auto" },
    "codex": { "flags": "" }
  }
}
```

每种类型可以改的项：

| 项 | 含义 |
|---|---|
| `flags` | 「免确认」选「是」时加的参数 |
| `command` | 新对话的命令。`{flags}` 和 `{name}` 会被替换 |
| `continue` | 「继续该目录最近一次对话」的命令 |
| `resume` | 「恢复某个历史对话」的命令。`{id}` 是对话 ID |
| `autoTrust` | 只对 Claude Code：自动确认「是否信任此文件夹」。默认开 |

### 管家

管家是一个 pi 进程。没接入会话时，你发的话由它处理：列会话、切换、新建、恢复历史对话、转发你的话。

1. 先在终端里运行一次 `pi`，登录 OpenAI Codex（ChatGPT 账号）。用 `pi --list-models gpt-6.1` 确认能看到 `gpt-6.1-sol`。
2. 管家默认使用 `openai-codex/gpt-6.1-sol`，恢复旧管家会话时也会指定这个模型。要指定其他模型，在配置里写：

   ```json
   { "concierge": { "model": "openai-codex/gpt-6.1-sol", "thinking": "low" } }
   ```

   把 `model` 换成其他 `provider/model-id`，并在 pi 中登录对应服务即可。显式设为 `""` 会使用 pi 的默认模型或旧会话保存的模型。
   修改配置后重启 fmux 服务。

3. 不要管家：`{ "concierge": { "enabled": false } }`。这时用面板上的按钮操作。

管家的行为规则在 `agent/CONCIERGE.md`。

### 通知

| 项 | 默认 | 含义 |
|---|---|---|
| `notify.minWorkSec` | 20 | 没接入的会话，一轮运行超过这么多秒，结束时发卡片 |
| `notify.quietIfLocalActiveSec` | 180 | 这么多秒内本机 tmux 有键盘输入，就不发通知。设 0 总是通知 |

## 7. 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 发消息没有任何反应 | 服务没在运行 | `fmux doctor`。看日志的命令见第 4 节 |
| 发消息没有任何反应 | 你不是主人 | 日志里有 `feishu.reject`。重新 `fmux pair` |
| 消息时灵时不灵 | 另一个程序连着同一个应用 | 一个应用只留一个连接。停掉另一个程序 |
| 点按钮提示出错 | 没有配置卡片回调 | 方式 B 第 7 步 |
| `fmux pair` 等不到消息 | 应用没发布，或没订阅「接收消息」，或订阅方式不是长连接 | 方式 B 第 6、8 步；已有的机器人看方式 C2 第 3 步 |
| 卡片发不出来，日志里有 `99991672` | 缺权限。这条报错会列出缺的权限名 | 在「权限管理」里开通，发布新版本 |
| 管家不回话 | pi 没装或没登录 | 在终端运行 `pi` 检查。或关掉管家 |
| Codex 提示「未定位到回复记录」 | 共享 app-server 下会话没有唯一名称，或 tmux 标题没有跟随更新 | 在 Codex 中用 `/rename` 设置唯一会话名，保留 tmux 的自动窗格标题；暂时可点「终端」看回复。fmux 按名称核对会话 ID 和目录，不再读取同目录最近更新的其他对话 |
| 新建会话后没有 Agent | 命令不在服务的 PATH 里 | 在装好 `claude`、`codex` 的终端里重新运行 `fmux install-service` |
| 会话在面板上是 shell | Agent 不是直接在这个 tmux 窗格的终端里运行 | 在窗格里直接运行 `claude` 或 `codex` |
| macOS 上所有会话都是 shell | 找不到 `lsof`，或服务的 `PATH` 里没有它 | `fmux doctor` 会报。`lsof` 在 `/usr/sbin`，重新运行 `fmux install-service` |
| `fmux install-service` 报 launchctl bootstrap 失败 | 这台 Mac 没有登录桌面 | `fmux install-service --tmux` |

## 8. 安全

- 机器人以你的系统用户身份操作终端。谁能用你的飞书账号给机器人发消息，谁就能在你的电脑上执行命令。
- 只有主人的 open_id 被接受。群聊一律不响应。
- App Secret 只存在 `~/.config/fmux/app-secret`，不要提交到仓库。
- 默认的启动参数让 Agent 不逐条询问权限。不想这样，把 `agents.<类型>.flags` 设为空。
