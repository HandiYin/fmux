// Feishu card JSON 2.0 builders. Every builder is pure: state in, card object out.
import { compactScreen } from './screen.mjs';
import { fmtClock, fmtDuration, oneLine, shortPath, truncate, truncateHead } from './util.mjs';

export const KIND_LABEL = { claude: 'Claude', codex: 'Codex', pi: 'pi', shell: 'shell' };

// Tokens from Feishu's icon library (open.feishu.cn: feishu-cards/enumerations-for-icons).
export const ICON = {
  attach: 'connect_outlined',
  detach: 'logout_outlined',
  peek: 'visible_outlined',
  screen: 'computer_outlined',
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

// How long something has been going on. Minutes only: the cards refresh every 15 to 30 seconds.
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
  return { dot: '⚪', label: '已结束', color: 'neutral', detail: [`${fmtClock(s.statusSince)} 结束`, s.note].filter(Boolean).join(' · ') };
}

export function statusText(s, now = Date.now()) {
  const l = light(s, now);
  return [l.label, l.detail].filter(Boolean).join(' · ');
}

// ---- elements ----

const md = (content) => ({ tag: 'markdown', content });
const note = (content) => ({ tag: 'markdown', content, text_size: 'notation' });
const hr = () => ({ tag: 'hr' });
const plain = (content) => ({ tag: 'plain_text', content });
const icon = (token) => ({ tag: 'standard_icon', token });
const tag = (content, color = 'neutral') => ({ tag: 'text_tag', text: plain(content), color });

function btn(label, value, { type = 'default', confirm, icon: token } = {}) {
  const button = { tag: 'button', text: plain(label), type, behaviors: [{ type: 'callback', value }] };
  if (token) button.icon = icon(token);
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

function card({ title, subtitle, template = 'blue', summary, elements, tags = [], icon: token }) {
  const header = { title: plain(title), template };
  if (subtitle) header.subtitle = plain(subtitle);
  if (tags.length) header.text_tag_list = tags.slice(0, 3);
  if (token) header.icon = icon(token);
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: truncate(summary || title, 60) } },
    header,
    body: { elements },
  };
}

// Header tags of a session card: its light, then the kind of agent.
function sessionTags(session, now) {
  const l = light(session, now);
  return [tag(l.label, l.color), tag(KIND_LABEL[session.kind])];
}

function codeBlock(text) {
  return md('```\n' + String(text).replace(/```/g, "'''") + '\n```');
}

// Preview text sits inside a <font> tag, so markup characters are dropped.
function plainPreview(text, max) {
  return oneLine(String(text).replace(/[*`<>[\]#|]|~~/g, ''), max);
}

function toolNote(count, lastTool) {
  return note(`🔧 ${count} 次工具调用${lastTool ? ` · \`${oneLine(lastTool.replace(/`/g, "'"), 70)}\`` : ''}`);
}

// The last line of a card that is kept current after it was sent.
function liveNote(live, now) {
  const clock = new Date(now).toTimeString().slice(0, 8);
  if (live === 'on') return note(`🔄 自动刷新中 · 更新于 ${clock}`);
  if (live === 'off') return note(`⏸ 自动刷新已停止（更新于 ${clock}）。点「刷新」继续。`);
  return note(`更新于 ${clock}`);
}

const ref = (s) => ({ s: s.key, n: s.name });
const sessionsButton = () => btn('会话', { a: 'dash.new' }, { icon: ICON.sessions });
const screenButton = (session) => btn('屏幕', { a: 'peek', ...ref(session) }, { icon: ICON.screen });
const attachButton = (session, extra = {}) => btn('接入', { a: 'attach', ...extra, ...ref(session) }, { type: 'primary', icon: ICON.attach });

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

export function dashboardCard({ sessions, attachedKey, quiet = false, now = Date.now(), stale = false }) {
  const elements = [];
  if (stale) elements.push(note('⏸ 这张面板已停止更新。点「刷新」重新启用。'));
  if (!sessions.length) elements.push(md('当前没有 tmux 会话。点「新建」开一个。'));
  sessions.slice(0, 16).forEach((s, i) => {
    const attached = s.key === attachedKey;
    const l = light(s, now);
    let line = `${l.dot} **${i + 1}. ${s.name}** <text_tag color='${l.color}'>${l.label}</text_tag>`;
    if (attached) line += " <text_tag color='blue'>已接入</text_tag>";
    line += `\n${[KIND_LABEL[s.kind], l.detail].filter(Boolean).join(' · ')}`;
    const preview = plainPreview(s.lastText || s.title || shortPath(s.cwd), 72);
    if (preview) line += `\n<font color='grey'>${preview}</font>`;
    elements.push(md(line));
    elements.push(row([
      attached ? btn('断开', { a: 'detach', from: 'dash' }, { icon: ICON.detach }) : attachButton(s, { from: 'dash' }),
      btn('查看', { a: 'peek', ...ref(s) }, { icon: ICON.peek }),
    ]));
  });
  if (sessions.length > 16) elements.push(note(`还有 ${sessions.length - 16} 个会话未显示，用 //a <名字> 接入。`));
  elements.push(hr());
  elements.push(row([
    btn('刷新', { a: 'dash' }, { icon: ICON.refresh }),
    btn('新建', { a: 'new.form' }, { icon: ICON.add }),
    btn('Pi 管家', { a: 'detach', from: 'dash' }, { icon: ICON.concierge }),
    btn('帮助', { a: 'help' }, { icon: ICON.help }),
  ]));
  const attachedName = sessions.find((s) => s.key === attachedKey)?.name;
  const target = `消息发往 **${attachedName || 'Pi 管家'}**`;
  elements.push(note(`${target}${quiet ? ' · 本机键盘在用，通知暂停' : ''}`));
  if (!stale) elements.push(liveNote('on', now));
  const busy = sessions.filter((s) => light(s, now).color === 'green').length;
  const blocked = sessions.filter((s) => s.status === 'blocked').length;
  return card({
    title: '会话面板',
    subtitle: `${sessions.length} 个会话 · ${busy} 个运行中${blocked ? ` · ${blocked} 个等待确认` : ''}`,
    template: stale ? 'grey' : blocked ? 'orange' : 'blue',
    summary: `会话面板：${busy} 个运行中${blocked ? `，${blocked} 个等待确认` : ''}`,
    icon: ICON.sessions,
    elements,
  });
}

function turnBody(texts, state) {
  const elements = [];
  if (!texts.length) {
    elements.push(note(state === 'working' ? '正在处理…' : '（这一轮没有文字回复，点「屏幕」看终端）'));
    return elements;
  }
  if (state === 'working') {
    elements.push(md(truncateHead(texts.join('\n\n'), 3500)));
    return elements;
  }
  const final = texts[texts.length - 1];
  const earlier = texts.slice(0, -1);
  if (earlier.length) {
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: md(`**过程（${earlier.length} 段）**`),
        vertical_align: 'center',
        icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
        icon_position: 'follow_text',
        icon_expanded_angle: -180,
      },
      border: { color: 'grey', corner_radius: '5px' },
      vertical_spacing: '8px',
      padding: '8px 8px 8px 8px',
      elements: [{ tag: 'markdown', content: truncateHead(earlier.join('\n\n'), 3000), text_size: 'notation' }],
    });
  }
  elements.push(md(truncate(final, 7000, '\n\n…（已截断，完整内容在终端）')));
  return elements;
}

// The live card for a turn of a followed session.
export function turnCard({ session, state, texts, tools, lastTool, startedAt, endedAt, now = Date.now() }) {
  const kind = KIND_LABEL[session.kind];
  const done = state === 'done';
  const elements = turnBody(texts, state);
  if (tools) elements.push(toolNote(tools, done ? null : lastTool));
  elements.push(row([
    done ? null : btn('中断', { a: 'key', k: 'esc', ...ref(session) }, { type: 'danger', icon: ICON.stop }),
    screenButton(session),
    sessionsButton(),
  ]));
  if (!done) elements.push(liveNote('on', now));
  return card({
    title: session.name,
    subtitle: done ? `用时 ${fmtDuration((endedAt - startedAt) / 1000)}` : `已 ${fmtElapsed(now - startedAt)} · ${fmtClock(startedAt)} 开始`,
    tags: [done ? tag('已结束') : tag('运行中', 'green'), tag(kind)],
    template: done ? 'blue' : 'green',
    summary: done ? `${session.name}：${oneLine(texts[texts.length - 1] || '已结束', 50)}` : `${session.name} 运行中`,
    icon: ICON.agent,
    elements,
  });
}

// A session nobody is attached to finished a turn.
export function finishedCard({ session, turn, replied }) {
  const text = turn.texts[turn.texts.length - 1] || session.lastText || '';
  const elements = [
    text ? md(truncate(text, 2200, '\n\n…（已截断）')) : note('（没有文字回复）'),
    replied ? note(`已回复：${plainPreview(replied, 90)}`) : null,
    replyForm(session, `回复 ${session.name}…`),
    row([attachButton(session), screenButton(session)]),
  ].filter(Boolean);
  return card({
    title: session.name,
    subtitle: `用时 ${fmtDuration((turn.endedAt - turn.startedAt) / 1000)}${turn.tools ? ` · ${turn.tools} 次工具调用` : ''}`,
    tags: [tag('已结束'), tag(KIND_LABEL[session.kind])],
    template: 'blue',
    summary: `${session.name} 已结束：${oneLine(text, 50)}`,
    icon: ICON.done,
    elements,
  });
}

// Sent right after attaching and kept current while attached: where the session is, and its last reply.
export function attachedCard({ session, now = Date.now(), live = 'on', detached = false }) {
  const elements = [];
  if (session.lastPrompt) elements.push(note(`上一条输入：${plainPreview(session.lastPrompt, 90)}`));
  if (session.lastText) elements.push(md(truncate(session.lastText, 1500, '\n\n…（已截断）')));
  else if (session.kind === 'shell') elements.push(note(`目录 ${shortPath(session.cwd)}。发来的每条消息会作为一行命令执行。`));
  elements.push(note(detached ? '已断开。这个会话还在 tmux 里。' : '现在发的消息都会进这个会话。发「面板」回到会话面板。'));
  elements.push(row([
    screenButton(session),
    detached ? attachButton(session) : btn('断开', { a: 'detach' }, { icon: ICON.detach }),
    sessionsButton(),
  ]));
  elements.push(liveNote(detached ? 'done' : live, now));
  const l = light(session, now);
  return card({
    title: detached ? `已断开 ${session.name}` : `已接入 ${session.name}`,
    subtitle: [l.detail, session.title].filter(Boolean).join(' · '),
    tags: sessionTags(session, now),
    template: detached ? 'grey' : session.status === 'blocked' ? 'orange' : l.color === 'green' ? 'green' : 'blue',
    summary: `已接入 ${session.name}`,
    icon: detached ? ICON.detach : ICON.attach,
    elements,
  });
}

// A dialog is waiting. The screen excerpt comes first: for a permission prompt it holds the command to approve.
export function blockedCard({ session, dialog, screen, answered, hint }) {
  const elements = [];
  if (hint && !answered) elements.push(md(hint));
  elements.push(codeBlock(compactScreen(screen || '', 22) || '（屏幕为空）'));
  if (answered) {
    elements.push(note(`已处理：${answered}`));
  } else if (dialog) {
    const options = dialog.options.slice(0, 6).map((o, i) =>
      btn(`${o.key ? `${o.key}. ` : ''}${truncate(o.label, 18)}`, { a: 'pick', i, l: o.label.slice(0, 24), ...ref(session) }));
    elements.push(row([...options, btn('Esc 取消', { a: 'pick', i: -1, ...ref(session) })]));
  } else {
    elements.push(note('没认出选项，点「屏幕」用按键操作。'));
  }
  elements.push(row([screenButton(session), attachButton(session)]));
  return card({
    title: session.name,
    subtitle: session.note || '',
    tags: [answered ? tag('已处理') : tag('等待确认', 'orange'), tag(KIND_LABEL[session.kind])],
    template: answered ? 'grey' : 'orange',
    summary: `${session.name} 等待确认`,
    icon: ICON.blocked,
    elements,
  });
}

// A snapshot of the terminal with a small key pad: the phone-sized stand-in for `tmux attach`.
export function peekCard({ session, screen, attached = false, now = Date.now(), live = 'on' }) {
  const key = (label, k) => btn(label, { a: 'key', k, from: 'peek', ...ref(session) });
  const l = light(session, now);
  const elements = [
    codeBlock(compactScreen(screen) || '（屏幕为空）'),
    row([key('⏎', 'enter'), key('Esc', 'esc'), key('↑', 'up'), key('↓', 'down'), key('Tab', 'tab'), key('⌃C', 'c-c')]),
    row([key('1', '1'), key('2', '2'), key('3', '3'), key('y', 'y'), key('n', 'n')]),
    replyForm(session, `输入并回车到 ${session.name}…`, { from: 'peek' }),
    row([
      btn('刷新', { a: 'peek.refresh', ...ref(session) }, { icon: ICON.refresh }),
      attached ? null : attachButton(session),
      sessionsButton(),
      btn('结束', { a: 'kill', ...ref(session) }, {
        type: 'danger',
        icon: ICON.kill,
        confirm: { title: `结束 tmux 会话 ${session.tmuxSession}？`, text: '会话里正在运行的程序会被终止，无法恢复。' },
      }),
    ]),
    liveNote(live, now),
  ];
  return card({
    title: session.name,
    subtitle: ['屏幕', l.detail].filter(Boolean).join(' · '),
    tags: sessionTags(session, now),
    template: session.status === 'blocked' ? 'orange' : l.color === 'green' ? 'green' : 'grey',
    summary: `${session.name} 的屏幕`,
    icon: ICON.screen,
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
  const elements = [];
  if (error) elements.push(md(`❌ ${error}`));
  elements.push({
    tag: 'form',
    name: 'new_session',
    elements: [
      { tag: 'input', name: 'name', label: plain('会话名'), placeholder: plain('字母数字，例如 paper_fig'), required: true },
      md('**类型**'),
      {
        tag: 'select_static',
        name: 'agent',
        initial_option: agents[0],
        options: agents.map((a) => ({ text: plain(KIND_LABEL[a] || a), value: a })),
      },
      md('**免确认**'),
      {
        tag: 'select_static',
        name: 'yolo',
        initial_option: 'yes',
        options: [
          { text: plain('是：claude -d（自动模式）/ codex --yolo'), value: 'yes' },
          { text: plain('否：不加参数，按各自的默认设置'), value: 'no' },
        ],
      },
      md('**对话**'),
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
      note('选「恢复」时，类型和目录按那次对话来。'),
      { tag: 'input', name: 'cwd', label: plain('工作目录'), placeholder: plain('默认 ~'), default_value: '~' },
      { tag: 'input', name: 'prompt', label: plain('第一条消息（可选）'), placeholder: plain('留空则只启动') },
      row([
        {
          tag: 'button',
          name: 'create',
          text: plain('创建并接入'),
          icon: icon(ICON.add),
          type: 'primary',
          form_action_type: 'submit',
          behaviors: [{ type: 'callback', value: { a: 'new.submit' } }],
        },
        btn('取消', { a: 'dash' }),
      ]),
    ],
  });
  return card({ title: '新建会话', template: 'turquoise', icon: ICON.add, elements });
}

// The concierge (pi) reply card.
export function conciergeCard({ state, text, tools, lastTool, startedAt, endedAt, error, now = Date.now() }) {
  const working = state === 'working';
  const elements = [];
  if (text) elements.push(md(working ? truncateHead(text, 3500) : truncate(text, 7000, '\n\n…（已截断）')));
  else elements.push(note(working ? '正在处理…' : '（没有文字回复）'));
  if (error) elements.push(md(`❌ ${error}`));
  if (tools) elements.push(toolNote(tools, working ? lastTool : null));
  elements.push(row([
    working ? btn('停止', { a: 'pi.stop' }, { type: 'danger', icon: ICON.stop }) : null,
    sessionsButton(),
  ]));
  return card({
    title: 'Pi 管家',
    subtitle: working ? `已 ${fmtElapsed(now - startedAt)}` : `用时 ${fmtDuration(((endedAt || now) - startedAt) / 1000)}`,
    tags: [error ? tag('出错', 'red') : working ? tag('运行中', 'green') : tag('已结束')],
    template: error ? 'red' : working ? 'green' : 'indigo',
    summary: working ? 'Pi 管家处理中' : `Pi：${oneLine(text || '已结束', 50)}`,
    icon: ICON.concierge,
    elements,
  });
}

export function infoCard({ title, text, template = 'grey', buttons = [] }) {
  const elements = [md(text)];
  if (buttons.length) elements.push(row(buttons.map((b) => btn(b.label, b.value, { type: b.type, icon: b.icon }))));
  return card({ title, template, elements });
}

export function helpCard() {
  return card({
    title: 'fmux 用法',
    template: 'grey',
    icon: ICON.help,
    elements: [
      md([
        '**接入**：点会话面板上的「接入」，之后你发的消息都进那个 tmux 会话，它的回复以卡片发回来。',
        '**断开**：回到 Pi 管家。不接入任何会话时，消息由 Pi 管家处理，可以用自然语言让它切换、查看、新建会话。',
        '**面板**：任何时候发「面板」两个字，或点卡片上的「会话」，就出会话面板。',
        '**引用回复**：引用某个会话发来的卡片再回复，消息直接进那个会话，不用切换。',
        '**状态灯**：🟢 运行中　⚪ 已结束　🟠 等待确认。面板、接入卡片和屏幕卡片会自动刷新。',
        '**通知**：没接入的会话跑完一轮（超过设定秒数）或在等确认时会单独发卡片；本机键盘在用时不打扰。',
        '',
        '**文字命令**（接入时用 `//` 开头，避免和会话自己的 `/` 命令冲突）：',
        '`//ls` 会话面板　`//a <序号或名字>` 接入　`//d` 断开',
        '`//peek [名字]` 看屏幕　`//key <名字> esc|enter|1|c-c…` 发按键',
        '`//new` 新建会话　`//pi <消息>` 接入时临时问管家　`//help` 本帮助',
      ].join('\n')),
      row([sessionsButton()]),
    ],
  });
}
