#!/usr/bin/env node
import { loadConfig } from '../src/config.mjs';
import { callControl } from '../src/control.mjs';

const USAGE = `fmuxctl — control the running fmux

  fmuxctl ls [--json]                     list tmux sessions and their state
  fmuxctl status                          hub health
  fmuxctl peek <session> [-n LINES]       print the session's screen
  fmuxctl send <session> <text…>          type text into the session and press Enter
  fmuxctl keys <session> <key…>           send keys: enter esc up down tab c-c y n 1..9
  fmuxctl handoff <from> <to> [comment…]  send <from>'s last reply into <to>, with your comment on top
               [--turns N]                 the last N replies instead of one
               [--whole]                   every text block of the turn, not only the final one
               [--screen] [--lines N]      the end of <from>'s terminal instead (a shell always uses this)
  fmuxctl attach <session>                route the Feishu chat to the session
  fmuxctl detach                          route the Feishu chat back to the concierge
  fmuxctl new <name> [--agent claude|codex|agy|dsh|pi|shell] [--cwd DIR] [--prompt TEXT] [--no-attach]
               [--continue]                resume the latest conversation of that agent in DIR
               [--resume ID|TITLE]         resume a past conversation (agent and DIR come from it)
               [--no-yolo]                 start without auto-approve flags
  fmuxctl new                             post the new-session form to the chat, for the owner to fill in
  fmuxctl history [--json]                past Claude Code, Codex and agy conversations that can be resumed
  fmuxctl tasks <session> [-n LINES] [--task ID] [--json]
                                          show background tasks and task logs of a session (agy)
  fmuxctl gpu ls [--json]                 show live local/gongji GPUs and all registered leases by cluster
  fmuxctl gpu register --cluster local|gongji|volc --gpus 0|1|8 --session NAME --task DESC [--job-id ID] [--model NAME] [--host HOST] [--ttl 240]
  fmuxctl gpu release <lease-id> | --job-id ID | --session NAME [--cluster C]
  fmuxctl rename <session> [new-tmux-name] [--title TITLE]
                                          rename the tmux session and/or inner agent conversation (/rename)
  fmuxctl kill <session> --yes            end the tmux session
  fmuxctl notify <text…> [--title T]      send a card to the owner's chat
  fmuxctl dashboard                       post a fresh session dashboard card
  fmuxctl show <session> [--terminal|--tasks]
                                          post the session's card to the chat: reply, terminal, or tasks

<session> is the number shown by "ls", or a loose name: part of the tmux name, of the
agent's title or of the directory. A name that fits several sessions is refused with the list.`;

function take(args, flag) {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
}

function has(args, flag) {
  const i = args.indexOf(flag);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

const STATUS = { working: 'working', background: 'BG-TASK', idle: 'idle', blocked: 'BLOCKED', shell: 'shell' };

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.shift();
  const { socket } = loadConfig();
  const call = (method, params) => callControl(socket, method, params);
  switch (cmd) {
    case 'ls': {
      const json = has(args, '--json');
      const list = await call('ls');
      if (json) return console.log(JSON.stringify(list, null, 2));
      if (!list.length) return console.log('no tmux sessions');
      list.forEach((s, i) => {
        const since = new Date(s.since).toTimeString().slice(0, 5);
        console.log(`${String(i + 1).padStart(2)}. ${s.attached ? '*' : ' '} ${s.name.padEnd(20)} ${s.kind.padEnd(6)} ${STATUS[s.status].padEnd(8)} since ${since}${s.note ? `  (${s.note})` : ''}${s.title ? `  — ${s.title}` : ''}`);
      });
      return undefined;
    }
    case 'history': {
      const json = has(args, '--json');
      const list = await call('history');
      if (json) return console.log(JSON.stringify(list, null, 2));
      for (const c of list) {
        const when = new Date(c.updatedAt).toLocaleString('sv-SE').slice(5, 16);
        console.log(`${c.agent.padEnd(6)} ${c.id.slice(0, 8)}  ${when}  ${c.title.replace(/\s+/g, ' ').slice(0, 44).padEnd(44)}  ${c.cwd}`);
      }
      return undefined;
    }
    case 'status':
    case 'detach':
    case 'dashboard':
      return console.log(JSON.stringify(await call(cmd), null, 2));
    case 'peek': {
      const lines = Number(take(args, '-n') || 40);
      const r = await call('peek', { ref: args[0], lines });
      console.log(`# ${r.name} · ${r.kind} · ${r.status}${r.note ? ` (${r.note})` : ''}`);
      return console.log(r.screen);
    }
    case 'send':
      return console.log(JSON.stringify(await call('send', { ref: args[0], text: args.slice(1).join(' ') })));
    case 'keys':
      return console.log(JSON.stringify(await call('keys', { ref: args[0], keys: args.slice(1) })));
    case 'handoff': {
      const params = { turns: Number(take(args, '--turns') || 1), lines: Number(take(args, '--lines') || 40), whole: has(args, '--whole'), screen: has(args, '--screen') };
      const [from, to, ...comment] = args;
      if (!from || !to) throw new Error('usage: fmuxctl handoff <from> <to> [comment…]');
      return console.log(JSON.stringify(await call('handoff', { from, to, comment: comment.join(' '), ...params }), null, 2));
    }
    case 'attach':
      return console.log(JSON.stringify(await call('attach', { ref: args[0] })));
    case 'show':
      return console.log(JSON.stringify(await call('show', { terminal: has(args, '--terminal'), tasks: has(args, '--tasks'), ref: args[0] })));
    case 'tasks': {
      const json = has(args, '--json');
      const lines = Number(take(args, '-n') || 40);
      const taskId = take(args, '--task');
      const r = await call('tasks', { ref: args[0], taskId, lines });
      if (json) return console.log(JSON.stringify(r, null, 2));
      console.log(`# ${r.name} · ${r.kind} · ${r.status} (${r.runningTasks} running / ${r.tasks.length} total)`);
      for (const t of r.tasks) {
        console.log(`  [${t.status.padEnd(7)}] ${t.shortId.padEnd(10)} (${t.kind}) ${t.description}${t.summary ? ` — ${t.summary}` : ''}`);
      }
      if (r.log) console.log(`\n--- log (${r.selectedTaskId}) ---\n${r.log}`);
      return undefined;
    }
    case 'new': {
      if (!args.length) return console.log(JSON.stringify(await call('form')));
      const resume = take(args, '--resume') || (has(args, '--continue') ? 'last' : 'new');
      const params = { agent: take(args, '--agent') || 'claude', cwd: take(args, '--cwd') || '~', prompt: take(args, '--prompt') || '', attach: !has(args, '--no-attach'), yolo: !has(args, '--no-yolo'), resume };
      return console.log(JSON.stringify(await call('new', { name: args[0], ...params }), null, 2));
    }
    case 'rename': {
      const sessionTitle = take(args, '--title') || '';
      const tmuxName = take(args, '--tmux') || args[1] || '';
      if (!args[0] || (!tmuxName && !sessionTitle)) {
        throw new Error('usage: fmuxctl rename <session> [new-tmux-name] [--title "Conversation Title"]');
      }
      return console.log(JSON.stringify(await call('rename', { ref: args[0], tmuxName, sessionTitle }), null, 2));
    }
    case 'kill':
      if (!has(args, '--yes')) throw new Error('refusing to kill without --yes');
      return console.log(JSON.stringify(await call('kill', { ref: args[0] })));
    case 'notify': {
      const title = take(args, '--title');
      return console.log(JSON.stringify(await call('notify', { title, text: args.join(' ') })));
    }
    case 'gpu': {
      const sub = args.shift() || 'ls';
      if (sub === 'ls') {
        const json = has(args, '--json');
        const snap = await call('gpu.ls');
        if (json) return console.log(JSON.stringify(snap, null, 2));
        console.log(`=== 本机器 (local · ${snap.hostName}) ===`);
        for (const g of snap.localGpus) {
          console.log(`  GPU ${g.index} ${g.name} | ${g.utilization}% | ${g.memoryUsedMb}/${g.memoryTotalMb} MiB | ${g.temperatureC}C | ${g.powerW}W`);
        }
        for (const l of snap.clusters?.local?.leases || []) {
          console.log(`  [LEASE ${l.id}] GPU:${l.gpus.join(',')} session=${l.session || '-'} task=${l.task} (${l.expired ? 'EXPIRED' : l.status})`);
        }
        console.log(`=== 共绩集群 (gongji · ${snap.gongjiJobs?.length || 0} live) ===`);
        for (const j of snap.gongjiJobs || []) {
          console.log(`  [LIVE ${j.taskId}] ${j.own ? 'OUR' : 'TEAM'} ${j.status}/${j.jobStatus} ${j.subType} ${j.gpuCount}x${j.model} ¥${j.costYuan} — ${j.name}`);
        }
        for (const l of snap.clusters?.gongji?.leases || []) {
          console.log(`  [LEASE ${l.id}] job=${l.jobId || '-'} GPU:${l.gpus.join(',')} ${l.model || ''} session=${l.session || '-'} task=${l.task}`);
        }
        console.log(`=== 火山集群 (volc · ${snap.clusters?.volc?.leases?.length || 0} leases) ===`);
        for (const l of snap.clusters?.volc?.leases || []) {
          console.log(`  [LEASE ${l.id}] job=${l.jobId || '-'} GPU:${l.gpus.join(',')} ${l.model || ''} session=${l.session || '-'} task=${l.task} (${l.expired ? 'EXPIRED' : l.status})`);
        }
        return undefined;
      }
      if (sub === 'register') {
        const params = {
          cluster: take(args, '--cluster') || '',
          gpus: take(args, '--gpus') || '0',
          host: take(args, '--host') || '',
          jobId: take(args, '--job-id') || '',
          session: take(args, '--session') || '',
          task: take(args, '--task') || args.join(' '),
          model: take(args, '--model') || '',
          note: take(args, '--note') || '',
          status: take(args, '--status') || 'running',
          ttlMinutes: Number(take(args, '--ttl') || 240),
        };
        return console.log(JSON.stringify(await call('gpu.register', params), null, 2));
      }
      if (sub === 'heartbeat') {
        const id = take(args, '--id') || take(args, '--job-id') || args[0];
        const params = {
          id,
          status: take(args, '--status'),
          note: take(args, '--note'),
          ttlMinutes: take(args, '--ttl') ? Number(take(args, '--ttl')) : undefined,
        };
        return console.log(JSON.stringify(await call('gpu.heartbeat', params), null, 2));
      }
      if (sub === 'release') {
        const session = take(args, '--session');
        const jobId = take(args, '--job-id');
        const cluster = take(args, '--cluster');
        const id = take(args, '--id') || (!session && !jobId ? args[0] : undefined);
        return console.log(JSON.stringify(await call('gpu.release', { id, jobId, session, cluster }), null, 2));
      }
      throw new Error('usage: fmuxctl gpu ls|register|heartbeat|release');
    }
    case 'dev': {
      const sub = args.shift();
      if (sub === 'say') return console.log(JSON.stringify(await call('dev.say', { replyTo: take(args, '--reply-to'), text: args.join(' ') })));
      if (sub === 'click') return console.log(JSON.stringify(await call('dev.click', { messageId: take(args, '--message'), formValue: JSON.parse(take(args, '--form') || '{}'), value: JSON.parse(args[0]) }), null, 1));
      if (sub === 'outbox') return console.log(JSON.stringify(await call('dev.outbox', { last: Number(args[0] || 5) }), null, 1));
      throw new Error('dev say|click|outbox (only with fmux --fake)');
    }
    default:
      console.log(USAGE);
      return undefined;
  }
}

main().catch((err) => {
  console.error(`fmuxctl: ${err.message}`);
  process.exit(1);
});
