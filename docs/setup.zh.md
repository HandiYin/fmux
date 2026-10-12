# fmux 使用指引

fmux 把一个飞书机器人接到你电脑上的 tmux 会话。你在手机飞书里给机器人发消息，消息进入你选中的
tmux 会话；会话里的 Claude Code、Codex 或 pi 的回复以卡片发回来。

这份指引讲四件事：安装、配置飞书机器人、配置 Agent、排错。

配置飞书机器人有三种方式，选一种：扫码新建（A）、在开发者后台手工新建（B）、用已有的机器人（C）。

## 1. 准备

| 需要 | 说明 |
|---|---|
| Linux | fmux 读 `/proc` 和 tmux，只支持 Linux |
| Node.js 20.12 以上 | `node --version` |
| tmux | `tmux -V` |
| Claude Code 或 Codex | 命令 `claude`、`codex`，各自先在终端里登录好 |
| pi（可选） | 管家用。不装就在配置里关掉管家 |
| 飞书账号 | 能创建企业自建应用 |

## 2. 安装

```bash
git clone https://github.com/Primatix-Intelligence/fmux.git ~/fmux
cd ~/fmux && npm install
mkdir -p ~/.local/bin && ln -s ~/fmux/bin/fmux ~/fmux/bin/fmuxctl ~/.local/bin/
fmux doctor
```

`fmux doctor` 列出已就绪和缺少的东西。

## 3. 配置飞书机器人

一个机器人只接一台电脑。每个人、每台电脑用自己的机器人。

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

```bash
systemctl --user disable --now fmux
```

然后启动原来的程序。C2 里改过订阅方式的，在开发者后台把事件和回调的订阅方式改回去。

## 4. 启动

```bash
fmux install-service
loginctl enable-linger $USER    # 注销后继续运行，开机自启
```

在飞书里给机器人发「面板」。出现会话面板就成功了。

| 操作 | 命令 |
|---|---|
| 看状态 | `systemctl --user status fmux` |
| 看日志 | `journalctl --user -u fmux -f` |
| 改配置后重启 | `systemctl --user restart fmux` |
| 换主人 | `systemctl --user stop fmux`，`fmux pair`，`systemctl --user start fmux` |

## 5. 怎么用

| 你做什么 | 结果 |
|---|---|
| 发「面板」 | 会话面板：每个 tmux 会话一行，带状态灯 |
| 点「接入」 | 之后你发的消息都进这个会话 |
| 点「查看」 | 终端截屏和一排按键，10 分钟内自动刷新 |
| 点「新建」 | 填表新开一个 tmux 会话，可以恢复以前的对话 |
| 点「断开」 | 回到管家。没接入时消息由管家处理 |
| 引用某张卡片回复 | 消息进那张卡片所属的会话，不用切换 |

状态灯：🟢 运行中，⚪ 已结束，🟠 等待确认。

已经在 tmux 里跑着的会话不用做任何改动，fmux 会自动发现它们。其余用法见 [README](../README.md)。

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

1. 先在终端里运行一次 `pi`，登录好模型。
2. 管家用 pi 的默认模型。要指定模型，在配置里写：

   ```json
   { "concierge": { "model": "provider/model-id", "thinking": "low" } }
   ```

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
| 发消息没有任何反应 | 服务没在运行 | `systemctl --user status fmux`，看日志 |
| 发消息没有任何反应 | 你不是主人 | 日志里有 `feishu.reject`。重新 `fmux pair` |
| 消息时灵时不灵 | 另一个程序连着同一个应用 | 一个应用只留一个连接。停掉另一个程序 |
| 点按钮提示出错 | 没有配置卡片回调 | 方式 B 第 7 步 |
| `fmux pair` 等不到消息 | 应用没发布，或没订阅「接收消息」，或订阅方式不是长连接 | 方式 B 第 6、8 步；已有的机器人看方式 C2 第 3 步 |
| 卡片发不出来，日志里有 `99991672` | 缺权限。这条报错会列出缺的权限名 | 在「权限管理」里开通，发布新版本 |
| 管家不回话 | pi 没装或没登录 | 在终端运行 `pi` 检查。或关掉管家 |
| 新建会话后没有 Agent | 命令不在服务的 PATH 里 | 在装好 `claude`、`codex` 的终端里重新运行 `fmux install-service` |
| 会话在面板上是 shell | Agent 不是直接在这个 tmux 窗格的终端里运行 | 在窗格里直接运行 `claude` 或 `codex` |

## 8. 安全

- 机器人以你的 Linux 用户身份操作终端。谁能用你的飞书账号给机器人发消息，谁就能在你的电脑上执行命令。
- 只有主人的 open_id 被接受。群聊一律不响应。
- App Secret 只存在 `~/.config/fmux/app-secret`，不要提交到仓库。
- 默认的启动参数让 Agent 不逐条询问权限。不想这样，把 `agents.<类型>.flags` 设为空。
