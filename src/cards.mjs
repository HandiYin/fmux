// Feishu card JSON 2.0 builders. Every builder is pure: state in, card object out.
//
// Look: a header is colored only when the session needs a glance (green: running,
// orange: waiting for the owner, red: error). Everything else is plain. A card carries
// only the buttons that make sense in its state.
import { compactScreen } from './screen.mjs';
import { fmtClock, fmtDuration, oneLine, shortPath, truncate, truncateHead } from './util.mjs';

export const KIND_LABEL = { claude: 'Claude', codex: 'Codex', pi: 'pi', shell: 'shell' };

// Tokens from Feishu's icon library (open.feishu.cn: feishu-cards/enumerations-for-icons).
export const ICON = {
  attach: 'connect_outlined',
  detach: 'logout_outlined',
  peek: 'visible_outlined',
  terminal: 'computer_outlined',
  refresh: 'refresh_outlined',
  add: 'add_outlined',
  concierge: 'robot_outlined',
  help: 'info_outlined',
  sessions: 'list_outlined',
  stop: 'stop_outlined',
  kill: 'delete-trash_outlined',
  send: 'send_outlined',
  done: 'done_outlined',
  blocked: 'maybe_outlined',
  agent: 'code_outlined',
};

// ---- status light ----

// How long something has been going on. Minutes only: the cards refresh about once a minute.
export function fmtElapsed(ms) {
  const min = Math.floor(Math.max(0, ms) / 60000);
  if (min < 1) return '不到 1 分钟';
  if (min < 60) return `${min} 分钟`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
}

// The light of a session: lit green while it runs, off when it ended, orange when it waits for you.
export function light(s, now = Date.now()) {
  if (s.status === 'working') return { dot: '🟢', label: '运行中', color: 'green', detail: `已 ${fmtElapsed(now - s.statusSince)}` };
  if (s.status === 'blocked') return { dot: '🟠', label: '等待确认', color: 'orange', detail: s.note || '' };
  if (s.status === 'shell') {
    return s.note
      ? { dot: '🟢', label: '运行中', color: 'green', detail: s.note }
      : { dot: '⚪', label: '空闲', color: 'neutral', detail: '' };
  }
  // An agent that has not been asked anything yet did not "end" anything.
  if (!s.lastText && !s.lastPrompt) return { dot: '⚪', label: '空闲', color: 'neutral', detail: s.note || '' };
  return { dot: '⚪', label: '已结束', color: 'neutral', detail: [`${fmtClock(s.statusSince)} 结束`, s.note].filter(Boolean).join(' · ') };
}

export function statusText(s, now = Date.now()) {
  const l = light(s, now);
  return [l.label, l.detail].filter(Boolean).join(' · ');
}

const TONE = { green: 'green', orange: 'orange', neutral: 'default' };
const tone = (session, now) => TONE[light(session, now).color];

// ---- elements ----

const md = (content) => ({ tag: 'markdown', content });
const note = (content) => ({ tag: 'markdown', content, text_size: 'notation' });
const plain = (content) => ({ tag: 'plain_text', content });
const icon = (token) => ({ tag: 'standard_icon', token });
const tag = (content, color = 'neutral') => ({ tag: 'text_tag', text: plain(content), color });
const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);

function btn(label, value, { type = 'default', confirm, icon: token, size } = {}) {
  const button = { tag: 'button', text: plain(label), type, behaviors: [{ type: 'callback', value }] };
  if (token) button.icon = icon(token);
  if (size) button.size = size;
  if (confirm) button.confirm = { title: plain(confirm.title), text: plain(confirm.text) };
  return button;
}

function row(buttons) {
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: 'small',
    columns: buttons.filter(Boolean).map((b) => ({ tag: 'column', width: 'auto', elements: [b] })),
  };
}

function fold(title, elements, { textSize } = {}) {
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: md(`**${title}**`),
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
      icon_position: 'follow_text',
      icon_expanded_angle: -180,
    },
    border: { color: 'grey', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: textSize ? elements.map((e) => ({ ...e, text_size: textSize })) : elements,
  };
}

function card({ title, subtitle, template = 'default', summary, elements, tags = [], icon: token }) {
  const header = { title: plain(title), template };
  if (subtitle) header.subtitle = plain(subtitle);
  if (tags.length) header.text_tag_list = tags.slice(0, 3);
  if (token) header.icon = icon(token);
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: truncate(summary || title, 60) } },
    header,
    body: { elements: elements.filter(Boolean) },
  };
}

function sessionTags(session, now, attached = false) {
  const l = light(session, now);
  return [tag(l.label, l.color), tag(KIND_LABEL[session.kind]), attached ? tag('已接入', 'blue') : null].filter(Boolean);
}

function codeBlock(text) {
  return md('```\n' + String(text).replace(/```/g, "'''") + '\n```');
}

// Preview text sits inside a <font> tag, so markup characters are dropped.
function plainPreview(text, max) {
  return oneLine(String(text).replace(/[*`<>[\]#|]|~~/g, ''), max);
}

function toolNote(count, lastTool) {
  return note(`工具调用 ${count} 次${lastTool ? ` · \`${oneLine(lastTool.replace(/`/g, "'"), 70)}\`` : ''}`);
}

// The last line of a card that is kept current after it was sent.
function liveNote(live, now) {
  if (live === 'off') return note(`已停止刷新（${clock(now)}）`);
  return note(`更新于 ${clock(now)}`);
}

const ref = (s) => ({ s: s.key, n: s.name });
const terminalButton = (session) => btn('终端', { a: 'term', ...ref(session) }, { icon: ICON.terminal });
const attachButton = (session, extra = {}, options = {}) => btn('接入', { a: 'attach', ...extra, ...ref(session) }, { type: 'primary', icon: ICON.attach, ...options });
const detachButton = (extra = {}, options = {}) => btn('断开', { a: 'detach', ...extra }, { icon: ICON.detach, ...options });

function replyForm(session, placeholder, extra = {}) {
  return {
    tag: 'form',
    name: 'reply',
    elements: [
      { tag: 'input', name: 'text', placeholder: plain(placeholder), required: true },
      row([{
        tag: 'button',
        name: 'send',
        text: plain('发送'),
        icon: icon(ICON.send),
        type: 'primary',
        form_action_type: 'submit',
        behaviors: [{ type: 'callback', value: { a: 'reply', ...ref(session), ...extra } }],
      }]),
    ],
  };
}

// ---- cards ----

// One short card without a header: what is left of a card that no longer matters.
export function stubCard(text) {
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: truncate(text, 60) } },
    body: { elements: [note(truncate(text, 300))] },
  };
}

// Every tmux session: a light, the state, one line of what it said last.
export function dashboardCard({ sessions, attachedKey, quiet = false, now = Date.now() }) {
  const elements = [];
  if (!sessions.length) elements.push(md('现在没有 tmux 会话。'));
  sessions.slice(0, 16).forEach((s) => {
    const attached = s.key === attachedKey;
    const l = light(s, now);
    let line = `${l.dot} **${s.name}**　${[l.label, l.detail].filter(Boolean).join(' · ')}`;
    if (attached) line += "　<font color='blue'>已接入</font>";
    const preview = plainPreview(s.lastText || s.title || shortPath(s.cwd), 60);
    line += `\n<font color='grey'>${[KIND_LABEL[s.kind], preview].filter(Boolean).join(' · ')}</font>`;
    elements.push(md(line));
    elements.push(row([
      attached ? detachButton({ from: 'dash' }, { size: 'small' }) : attachButton(s, { from: 'dash' }, { size: 'small' }),
      btn('查看', { a: 'peek', ...ref(s) }, { icon: ICON.peek, size: 'small' }),
    ]));
  });
  if (sessions.length > 16) elements.push(note(`还有 ${sessions.length - 16} 个会话没有列出，用 //a <名字> 接入。`));
  elements.push({ tag: 'hr' });
  elements.push(row([btn('新建会话', { a: 'new.form' }, { icon: ICON.add, size: 'small' })]));
  elements.push(note(`更新于 ${fmtClock(now)}${quiet ? ' · 本机键盘在用，通知暂停' : ''}`));
  const attachedName = sessions.find((s) => s.key === attachedKey)?.name;
  const blocked = sessions.filter((s) => s.status === 'blocked').length;
  const busy = sessions.filter((s) => light(s, now).color === 'green').length;
  return card({
    title: '会话面板',
    subtitle: `消息发往 ${attachedName || 'Pi 管家'}`,
    template: blocked ? 'orange' : 'default',
    summary: `会话面板：${busy} 个运行中${blocked ? `，${blocked} 个等待确认` : ''}`,
    icon: ICON.sessions,
    elements,
  });
}

// Where a session is: its state, the last prompt and the last reply. Sent by 查看 and by 接入.
export function sessionCard({ session, attached = false, now = Date.now(), live = 'on' }) {
  const elements = [];
  if (session.lastPrompt) elements.push(note(`上一条输入：${plainPreview(session.lastPrompt, 90)}`));
  if (session.lastText) elements.push(md(truncate(session.lastText, 1200, '\n\n…（已截断）')));
  else elements.push(note('这个会话还没有回复。'));
  elements.push(row([
    attached ? detachButton() : attachButton(session),
    terminalButton(session),
    live === 'off' ? btn('刷新', { a: 'peek.refresh', ...ref(session) }, { icon: ICON.refresh }) : null,
  ]));
  elements.push(liveNote(live, now));
  return card({
    title: session.name,
    subtitle: [light(session, now).detail, session.title].filter(Boolean).join(' · '),
    tags: sessionTags(session, now, attached),
    template: tone(session, now),
    summary: `${session.name}：${statusText(session, now)}`,
    icon: ICON.agent,
    elements,
  });
}

// The terminal itself, for a shell or when an agent needs a key press. Trimmed for a phone.
export function terminalCard({ session, screen, attached = false, now = Date.now(), live = 'on' }) {
  const key = (label, k) => btn(label, { a: 'key', k, from: 'term', ...ref(session) });
  const elements = [
    codeBlock(compactScreen(screen, 18, 100) || '（屏幕是空的）'),
    row([key('⏎', 'enter'), key('Esc', 'esc'), key('↑', 'up'), key('↓', 'down')]),
    fold('更多按键', [
      row([key('Tab', 'tab'), key('⌃C', 'c-c'), key('1', '1'), key('2', '2'), key('3', '3'), key('y', 'y'), key('n', 'n')]),
      row([btn('结束这个会话', { a: 'kill', ...ref(session) }, {
        type: 'danger',
        icon: ICON.kill,
        confirm: { title: `结束 tmux 会话 ${session.tmuxSession}？`, text: '会话里正在运行的程序会被终止，无法恢复。' },
      })]),
    ]),
    replyForm(session, `输入一行，回车发到 ${session.name}`, { from: 'term' }),
    row([
      btn('刷新', { a: 'term.refresh', ...ref(session) }, { icon: ICON.refresh }),
      attached ? detachButton() : attachButton(session),
    ]),
    liveNote(live, now),
  ];
  return card({
    title: session.name,
    subtitle: '终端',
    tags: sessionTags(session, now, attached),
    template: tone(session, now),
    summary: `${session.name} 的终端`,
    icon: ICON.terminal,
    elements,
  });
}

function turnBody(texts, done) {
  if (!texts.length) return [note(done ? '这一轮没有文字回复。' : '正在处理…')];
  if (!done) return [md(truncateHead(texts.join('\n\n'), 3500))];
  const earlier = texts.slice(0, -1);
  return [
    earlier.length ? fold(`过程（${earlier.length} 段）`, [md(truncateHead(earlier.join('\n\n'), 3000))], { textSize: 'notation' }) : null,
    md(truncate(texts[texts.length - 1], 7000, '\n\n…（已截断，完整内容在终端）')),
  ];
}

// One turn of a followed session: streams while the agent works, then holds the reply.
export function turnCard({ session, state, texts, tools, lastTool, startedAt, endedAt, now = Date.now() }) {
  const done = state === 'done';
  const elements = turnBody(texts, done);
  if (done) {
    if (!texts.length) elements.push(row([terminalButton(session)]));
    return card({
      title: session.name,
      subtitle: `用时 ${fmtDuration((endedAt - startedAt) / 1000)}${tools ? ` · 工具调用 ${tools} 次` : ''}`,
      summary: `${session.name}：${oneLine(texts[texts.length - 1] || '已结束', 50)}`,
      icon: ICON.agent,
      elements,
    });
  }
  if (tools) elements.push(toolNote(tools, lastTool));
  elements.push(row([btn('中断', { a: 'key', k: 'esc', ...ref(session) }, { type: 'danger', icon: ICON.stop }), terminalButton(session)]));
  return card({
    title: session.name,
    subtitle: `已 ${fmtElapsed(now - startedAt)}`,
    tags: [tag('运行中', 'green'), tag(KIND_LABEL[session.kind])],
    template: 'green',
    summary: `${session.name} 运行中`,
    icon: ICON.agent,
    elements,
  });
}

// A session nobody follows finished a turn: the reply, and a box to answer without switching.
export function finishedCard({ session, turn, replied }) {
  const text = turn.texts[turn.texts.length - 1] || session.lastText || '';
  return card({
    title: session.name,
    subtitle: `用时 ${fmtDuration((turn.endedAt - turn.startedAt) / 1000)}${turn.tools ? ` · 工具调用 ${turn.tools} 次` : ''}`,
    tags: [tag('已结束'), tag(KIND_LABEL[session.kind])],
    summary: `${session.name} 已结束：${oneLine(text, 50)}`,
    icon: ICON.done,
    elements: [
      text ? md(truncate(text, 2200, '\n\n…（已截断）')) : note('这一轮没有文字回复。'),
      replied ? note(`已回复：${plainPreview(replied, 90)}`) : null,
      replyForm(session, `回复 ${session.name}`),
      row([attachButton(session)]),
    ],
  });
}

// A dialog is waiting. The screen excerpt comes first: for a permission prompt it holds the command to approve.
export function blockedCard({ session, dialog, screen, answered, hint }) {
  const elements = [];
  if (hint && !answered) elements.push(md(hint));
  elements.push(codeBlock(compactScreen(screen || '', 14, 100) || '（屏幕是空的）'));
  if (answered) {
    elements.push(note(`已处理：${answered}`));
  } else {
    if (dialog) {
      const options = dialog.options.slice(0, 6).map((o, i) =>
        btn(`${o.key ? `${o.key}. ` : ''}${truncate(o.label, 18)}`, { a: 'pick', i, l: o.label.slice(0, 24), ...ref(session) }));
      elements.push(row([...options, btn('Esc', { a: 'pick', i: -1, ...ref(session) })]));
    } else {
      elements.push(note('没认出选项，点「终端」用按键操作。'));
    }
    elements.push(row([terminalButton(session)]));
  }
  return card({
    title: session.name,
    subtitle: answered ? '' : session.note || '',
    tags: [answered ? tag('已处理') : tag('等待确认', 'orange'), tag(KIND_LABEL[session.kind])],
    template: answered ? 'default' : 'orange',
    summary: `${session.name} 等待确认`,
    icon: ICON.blocked,
    elements,
  });
}

function conversationLabel(c) {
  const d = new Date(c.updatedAt);
  const when = `${d.getMonth() + 1}-${d.getDate()} ${fmtClock(c.updatedAt)}`;
  return truncate(`${KIND_LABEL[c.agent]} · ${oneLine(c.title, 26)} · ${when} · ${shortPath(c.cwd)}`, 70);
}

// `conversations` are past Claude Code and Codex conversations that the new session can resume.
export function newSessionCard({ error, agents = ['claude', 'codex', 'pi', 'shell'], conversations = [] } = {}) {
  return card({
    title: '新建会话',
    icon: ICON.add,
    template: error ? 'red' : 'default',
    elements: [
      error ? md(`**没有建成**：${error}`) : null,
      {
        tag: 'form',
        name: 'new_session',
        elements: [
          {
            tag: 'select_static',
            name: 'resume',
            initial_option: 'new',
            options: [
              { text: plain('新对话'), value: 'new' },
              { text: plain('继续该目录最近一次对话'), value: 'last' },
              ...conversations.map((c) => ({ text: plain(`恢复：${conversationLabel(c)}`), value: `${c.agent}:${c.id}` })),
            ],
          },
          {
            tag: 'select_static',
            name: 'agent',
            initial_option: agents[0],
            options: agents.map((a) => ({ text: plain(`类型：${KIND_LABEL[a] || a}`), value: a })),
          },
          {
            tag: 'select_static',
            name: 'yolo',
            initial_option: 'yes',
            options: [
              { text: plain('免确认：是（claude -d 自动模式 / codex --yolo）'), value: 'yes' },
              { text: plain('免确认：否（不加参数）'), value: 'no' },
            ],
          },
          { tag: 'input', name: 'cwd', label: plain('目录'), placeholder: plain('默认 ~'), default_value: '~' },
          { tag: 'input', name: 'name', label: plain('会话名'), placeholder: plain('留空自动起名') },
          { tag: 'input', name: 'prompt', label: plain('第一条消息'), placeholder: plain('可以留空') },
          note('选「恢复」时，类型和目录按那次对话来。'),
          row([{
            tag: 'button',
            name: 'create',
            text: plain('创建并接入'),
            icon: icon(ICON.add),
            type: 'primary',
            form_action_type: 'submit',
            behaviors: [{ type: 'callback', value: { a: 'new.submit' } }],
          }]),
        ],
      },
    ],
  });
}

// The concierge (pi) reply card.
export function conciergeCard({ state, text, tools, lastTool, startedAt, endedAt, error, now = Date.now() }) {
  const working = state === 'working';
  const elements = [];
  if (text) elements.push(md(working ? truncateHead(text, 3500) : truncate(text, 7000, '\n\n…（已截断）')));
  else elements.push(note(working ? '正在处理…' : '没有文字回复。'));
  if (error) elements.push(md(`**出错**：${error}`));
  if (working && tools) elements.push(toolNote(tools, lastTool));
  if (working) elements.push(row([btn('停止', { a: 'pi.stop' }, { type: 'danger', icon: ICON.stop })]));
  return card({
    title: 'Pi 管家',
    subtitle: working ? `已 ${fmtElapsed(now - startedAt)}` : `用时 ${fmtDuration(((endedAt || now) - startedAt) / 1000)}${tools ? ` · 工具调用 ${tools} 次` : ''}`,
    tags: working ? [tag('运行中', 'green')] : [],
    template: error ? 'red' : working ? 'green' : 'default',
    summary: working ? 'Pi 管家处理中' : `Pi：${oneLine(text || '已结束', 50)}`,
    icon: ICON.concierge,
    elements,
  });
}

export function infoCard({ title, text, template = 'default', buttons = [] }) {
  return card({
    title,
    template,
    elements: [md(text), buttons.length ? row(buttons.map((b) => btn(b.label, b.value, { type: b.type, icon: b.icon }))) : null],
  });
}

export function helpCard() {
  return card({
    title: 'fmux 用法',
    icon: ICON.help,
    elements: [
      md([
        '**面板**：发「面板」两个字，列出所有 tmux 会话。🟢 运行中　⚪ 已结束　🟠 等待确认。',
        '**接入**：点「接入」后，你发的消息都进那个会话，回复以卡片发回来。',
        '**断开**：回到 Pi 管家。没接入时可以直接说话，让它切换、查看、新建会话。',
        '**引用回复**：引用某个会话的卡片再回复，消息进那个会话，不用切换。',
        '**终端**：会话卡在某个提示上时，点「终端」看屏幕、按键。',
        '',
        '文字命令（接入时用 `//` 开头）：',
        '`//ls` 面板　`//a <名字>` 接入　`//d` 断开　`//peek <名字>` 查看',
        '`//key <名字> esc|enter|1…` 按键　`//new` 新建　`//pi <消息>` 问管家',
      ].join('\n')),
    ],
  });
}
