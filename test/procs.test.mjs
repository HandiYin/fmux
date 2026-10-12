import assert from 'node:assert/strict';
import test from 'node:test';
import { alive, classify, drivenByScript, finder, parseEtime, parseLsof, parsePs, parseWinProcs } from '../src/procs.mjs';

// `ps -A -ww -o pid=,ppid=,tty=,args=` on macOS.
const MAC_PS = `
    1     0 ??       /sbin/launchd
  610     1 ??       tmux new -s work
  700   610 ttys003  -zsh
  720   700 ttys003  claude -d --permission-mode auto
  800   610 ttys004  -zsh
  810   800 ttys004  node /Users/me/handibot/main.js
  811   810 ttys004  /opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex app-server
  900   610 ttys005  -zsh
  910   900 ttys005  node /opt/homebrew/bin/codex --yolo
  911   910 ttys005  /opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex --yolo
  950   610 ttys006  -zsh
  960   950 ttys006  vim /Users/me/notes/claude-code tips.md
`;

// The same columns from procps on Linux.
const LINUX_PS = `
      1       0 ?        /sbin/init splash
   8696    8601 pts/3    claude -d -r
   9001    8601 pts/9    node /home/u/.npm-global/bin/pi
`;

test('ps output is read into processes with a terminal and a name', () => {
  const procs = parsePs(MAC_PS);
  assert.equal(procs.size, 12);
  assert.deepEqual(procs.get(720), { ppid: 700, comm: 'claude', args: 'claude -d --permission-mode auto', tty: '/dev/ttys003' });
  assert.equal(procs.get(1).tty, '', 'no terminal');
  assert.equal(procs.get(960).args, 'vim /Users/me/notes/claude-code tips.md', 'spaces in the command line are kept');
  assert.equal(procs.get(700).comm, 'zsh', 'a login shell');
  const linux = parsePs(LINUX_PS);
  assert.equal(linux.get(8696).tty, '/dev/pts/3');
  assert.equal(linux.get(1).tty, '');
  assert.equal(linux.get(9001).comm, 'node');
});

test('the running time of a process is read in each of its three forms', () => {
  assert.equal(parseEtime('   00:07\n'), 7);
  assert.equal(parseEtime('01:02:03'), 3723);
  assert.equal(parseEtime('2-01:02:03'), 2 * 86400 + 3723);
  assert.equal(parseEtime('garbage'), null);
});

test('lsof output is read into descriptor and name pairs', () => {
  assert.deepEqual(parseLsof('p720\nfcwd\nn/Users/me/proj\nf0\nn/dev/ttys003\nf12\nn/Users/me/.codex/sessions/2026/10/12/rollout-a.jsonl\n'), [
    { fd: 'cwd', name: '/Users/me/proj' },
    { fd: '0', name: '/dev/ttys003' },
    { fd: '12', name: '/Users/me/.codex/sessions/2026/10/12/rollout-a.jsonl' },
  ]);
  assert.deepEqual(parseLsof(''), []);
});

test('an agent is known by its process name or by the first word of its command line', () => {
  assert.equal(classify('claude', ''), 'claude');
  assert.equal(classify('2.1.296', 'claude -d'), 'claude', 'macOS names the process after the version file');
  assert.equal(classify('2.1.296', '/Users/me/.local/share/claude/versions/2.1.296 --resume'), 'claude');
  assert.equal(classify('node', 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'), 'claude');
  assert.equal(classify('codex', '/x/vendor/codex/codex --yolo'), 'codex');
  assert.equal(classify('node', 'node /opt/homebrew/bin/codex --yolo'), 'codex');
  assert.equal(classify('MainThread', 'node /home/u/.npm-global/bin/pi'), 'pi');
  assert.equal(classify('node', 'node /home/u/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js'), 'pi');
  assert.equal(classify('zsh', '-zsh'), null);
  assert.equal(classify('vim', 'vim /Users/me/notes/claude-code tips.md'), null, 'a path that only mentions an agent');
  assert.equal(classify('node', 'node server.js'), null);
});

// Output of src/win/procs.ps1: pid, parent pid, start ms, name, command line.
const WIN_PROCS = [
  '4\t0\t0\tSystem\t',
  '5120\t880\t1791800000000\tpsmux.exe\t"C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\psmux.exe" server -s work',
  '6001\t5120\t1791800001000\tpwsh.exe\t"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo',
  '6100\t6001\t1791800060000\tclaude.exe\t"C:\\Users\\me\\.local\\bin\\claude.exe" -d --permission-mode auto',
  '6200\t5120\t1791800002000\tpwsh.exe\tpwsh.exe',
  '6210\t6200\t1791800070000\tcmd.exe\tC:\\WINDOWS\\system32\\cmd.exe /d /s /c "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd --yolo"',
  '6220\t6210\t1791800071000\tnode.exe\t"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js" --yolo',
  '6300\t5120\t1791800003000\tpwsh.exe\tpwsh.exe',
  '6310\t6300\t1791800080000\tnode.exe\tnode C:\\work\\handibot\\main.js',
  '6320\t6310\t1791800081000\tcodex.exe\tC:\\tools\\codex.exe app-server',
  '',
].join('\r\n');

test('the Windows process table is read into processes with a name and a start time', () => {
  const procs = parseWinProcs(WIN_PROCS);
  assert.equal(procs.size, 10);
  assert.deepEqual(procs.get(6100), {
    ppid: 6001, comm: 'claude', startMs: 1791800060000,
    args: '"C:\\Users\\me\\.local\\bin\\claude.exe" -d --permission-mode auto',
  });
  assert.equal(procs.get(4).args, '', 'a system process has no command line');
  assert.equal(procs.get(6001).comm, 'pwsh');
});

test('Windows command lines: quoted paths, backslashes and .exe are understood', () => {
  assert.equal(classify('claude', '"C:\\Users\\me\\.local\\bin\\claude.exe" -d'), 'claude');
  assert.equal(classify('node', '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js" --yolo'), 'codex');
  assert.equal(classify('node', 'node.exe C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'), 'claude');
  assert.equal(classify('node', '"C:\\Program Files\\nodejs\\node.exe" C:\\x\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js'), 'pi');
  assert.equal(classify('pwsh', '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo'), null);
  assert.equal(classify('cmd', 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd --yolo"'), null, 'the shim runner is not the agent');
});

test('an agent that a program drives is told from its command line', () => {
  assert.equal(drivenByScript('codex', 'C:\\tools\\codex.exe app-server'), true);
  assert.equal(drivenByScript('codex', 'codex --yolo exec "run the tests"'), true);
  assert.equal(drivenByScript('codex', 'codex --yolo'), false);
  assert.equal(drivenByScript('codex', 'codex "please exec the tests"'), false, 'a word of the prompt is not a subcommand');
  assert.equal(drivenByScript('codex', '"C:\\Program Files\\nodejs\\node.exe" "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js" app-server'), true);
  assert.equal(drivenByScript('claude', 'claude -p "summarize"'), true);
  assert.equal(drivenByScript('claude', '"C:\\Users\\me\\.local\\bin\\claude.exe" -d --permission-mode auto'), false);
  assert.equal(drivenByScript('claude', 'claude "what does -p do"'), false);
  assert.equal(drivenByScript('pi', 'node --no-warnings C:\\x\\pi-coding-agent\\dist\\cli.js --mode rpc --name hub'), true);
  assert.equal(drivenByScript('pi', 'pi -c'), false);
});

test('on Windows the agent of a pane is found through the process tree and the command line', async () => {
  const procs = parseWinProcs(WIN_PROCS);
  const children = new Map();
  for (const [pid, p] of procs) children.set(p.ppid, [...(children.get(p.ppid) || []), pid]);
  const find = finder({ args: (pid, entry) => entry.args, startMs: () => 0, reads: (pid, entry, tty, kind) => !drivenByScript(kind, entry.args) });
  assert.deepEqual(await find({ procs, children }, 6001, '/dev/pty1'), { kind: 'claude', pid: 6100 });
  assert.deepEqual(await find({ procs, children }, 6200, '/dev/pty2'), { kind: 'codex', pid: 6220 }, 'through the npm shim');
  assert.equal(await find({ procs, children }, 6300, '/dev/pty3'), null, 'codex app-server under another program');
});

function macFinder(stdin) {
  const procs = parsePs(MAC_PS);
  const children = new Map();
  for (const [pid, p] of procs) children.set(p.ppid, [...(children.get(p.ppid) || []), pid]);
  const asked = [];
  const find = finder({
    args: (pid, entry) => entry.args,
    startMs: () => 0,
    reads: (pid, entry, tty) => {
      asked.push(pid);
      return (stdin[pid] || '') === tty;
    },
  });
  return { find: (pid, tty) => find({ procs, children }, pid, tty), asked };
}

test('the agent of a pane is the nearest agent process that reads from the pane terminal', async () => {
  const { find, asked } = macFinder({ 720: '/dev/ttys003', 811: 'pipe', 910: '/dev/ttys005', 911: '/dev/ttys005' });
  assert.deepEqual(await find(700, '/dev/ttys003'), { kind: 'claude', pid: 720 });
  assert.equal(await find(800, '/dev/ttys004'), null, 'codex app-server is driven over a pipe');
  assert.deepEqual(await find(900, '/dev/ttys005'), { kind: 'codex', pid: 910 });
  assert.equal(await find(950, '/dev/ttys006'), null, 'an editor is a plain shell session');
  assert.deepEqual(asked, [720, 811, 910], 'only agent processes are asked for their stdin');
});

test('a process on another terminal is skipped without asking for its stdin', async () => {
  const { find, asked } = macFinder({ 720: '/dev/ttys003' });
  assert.equal(await find(700, '/dev/ttys099'), null);
  assert.deepEqual(asked, []);
});

test('alive tells a running process from a missing one', () => {
  assert.equal(alive(process.pid), true);
  assert.equal(alive(2 ** 22 + 12345), false);
});
