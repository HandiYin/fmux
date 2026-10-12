#!/usr/bin/env node
// End-to-end check on a real tmux: stub agents in panes, the hub in --fake mode (Feishu replaced
// by a recorder), and fmuxctl as the owner. It runs in a scratch HOME with a tmux server of its
// own, so it touches no real session, no real agent state and no network.
//
//   node test/integration/run.mjs                 the checks
//   node test/integration/run.mjs --service=tmux  also: the hub kept running in a tmux session
//   node test/integration/run.mjs --service=native  also: systemd or launchd (CI only, uses the real HOME)
//   --real=claude   also start the real CLI of that name in a pane and check that it is recognized
//                   (it starts in the scratch HOME, so it shows its first-run screen; nothing is sent to it)
//   --keep   leave the scratch directory and the tmux server for a look
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STUB = path.join(ROOT, 'test', 'integration', 'stub-agent.cjs');
const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const service = argv.find((a) => a.startsWith('--service='))?.slice('--service='.length) || '';
const real = argv.filter((a) => a.startsWith('--real=')).map((a) => a.slice('--real='.length));

// On Windows the multiplexer is psmux, and what differs from here on is marked WINDOWS.
const WINDOWS = process.platform === 'win32';

// /tmp and not os.tmpdir(): a socket path is limited to about 100 bytes, and macOS has a long TMPDIR.
const tmp = fs.realpathSync(fs.mkdtempSync(WINDOWS ? path.join(os.tmpdir(), 'fmux-it-') : '/tmp/fmux-it-'));
const dirs = { home: 'home', tmux: 'tmux', bin: 'bin', native: 'native/bin', versions: 'native/share/claude/versions', work: 'work', state: 'state', appdata: 'appdata', npm: 'npm/node_modules' };
for (const [name, rel] of Object.entries(dirs)) {
  dirs[name] = path.join(tmp, rel);
  fs.mkdirSync(dirs[name], { recursive: true });
}

// How each stub agent is started in a pane.
const start = {};
if (WINDOWS) {
  // An npm install: the runtime runs a script inside the package directory.
  const packaged = { claude: '@anthropic-ai/claude-code/cli.js', codex: '@openai/codex/bin/codex.js', pi: '@earendil-works/pi-coding-agent/dist/cli.js' };
  for (const [name, rel] of Object.entries(packaged)) {
    const file = path.join(dirs.npm, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(STUB, file);
    start[name] = ['--', process.execPath, file];
  }
} else {
  // Script installs: `claude` is a script that a JS runtime runs ("node …/bin/claude").
  for (const name of ['claude', 'codex', 'pi']) {
    fs.symlinkSync(STUB, path.join(dirs.bin, name));
    start[name] = [name];
  }
  // Native install of Claude Code: `claude` is a link to a binary named after its version.
  fs.symlinkSync(process.execPath, path.join(dirs.versions, '9.9.9'));
  fs.symlinkSync(path.join(dirs.versions, '9.9.9'), path.join(dirs.native, 'claude'));
}

const config = path.join(tmp, 'config.json');
fs.writeFileSync(config, JSON.stringify({
  app: { id: 'cli_integration', secret: { source: 'env', name: 'FMUX_NO_SECRET' } },
  owner: { openId: 'ou_integration', chatId: 'oc_integration' },
  stateDir: dirs.state,
  poll: { intervalMs: 500 },
  notify: { quietIfLocalActiveSec: 0 },
  concierge: { enabled: false },
}));

const env = {
  ...process.env,
  HOME: dirs.home,
  TMUX_TMPDIR: dirs.tmux,
  SHELL: '/bin/sh',
  PATH: [dirs.bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
  FMUX_CONFIG: config,
  FMUX_SOCK: path.join(tmp, 'fmux.sock'),
  LANG: 'en_US.UTF-8',
};
if (WINDOWS) {
  // The home of a Windows user, the directory of psmux's sessions, and the Startup folder: all scratch.
  Object.assign(env, { USERPROFILE: dirs.home, PSMUX_DATA_DIR: dirs.tmux, APPDATA: dirs.appdata, FMUX_SOCK: `\\\\.\\pipe\\fmux-it-${path.basename(tmp)}` });
  delete env.SHELL;
}
for (const name of ['TMUX', 'TMUX_PANE', 'LC_ALL', 'LC_CTYPE', 'FMUX_FAKE']) delete env[name];
// The hub runs without a locale, the way launchd starts a service.
const bare = { ...env };
delete bare.LANG;

function run(cmd, args, { env: runEnv = env, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: runEnv, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { message: `${cmd} ${args.join(' ')}: ${String(stderr || err.message).trim()}` }));
      else resolve(String(stdout));
    });
  });
}
const tmux = async (...args) => (await run('tmux', WINDOWS ? args : ['-u', ...args])).replace(/\r\n/g, '\n');
const ctl = (...args) => run(process.execPath, [path.join(ROOT, 'bin', 'fmuxctl.mjs'), ...args], { env: bare });
const fmux = (args, runEnv = bare) => run(process.execPath, [path.join(ROOT, 'bin', 'fmux.mjs'), ...args], { env: runEnv, timeout: 90000 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sessions = async () => Object.fromEntries(JSON.parse(await ctl('ls', '--json')).map((s) => [s.name, s]));

async function until(what, probe, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await probe();
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    if (Date.now() > deadline) throw new Error(`timed out: ${what} (last: ${JSON.stringify(last)?.slice(0, 600)})`);
    await sleep(250);
  }
}

const results = [];
async function check(name, fn) {
  const started = Date.now();
  try {
    const note = await fn();
    results.push(true);
    console.log(`✓ ${name}${note ? `  — ${note}` : ''}  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  } catch (err) {
    results.push(false);
    console.log(`✗ ${name}\n    ${err.message}`);
  }
}

let hub = null;
function startHub() {
  const logFile = fs.openSync(path.join(tmp, 'hub.log'), 'a');
  hub = spawn(process.execPath, [path.join(ROOT, 'bin', 'fmux.mjs'), '--fake'], { env: bare, stdio: ['ignore', logFile, logFile] });
  hub.on('exit', () => { hub = null; });
}
async function stopHub() {
  if (!hub) return;
  const child = hub;
  child.kill('SIGTERM');
  await until('the hub exits', () => hub === null, 10000).catch(() => child.kill('SIGKILL'));
}

// One turn through fmuxctl: the text goes in, the stub's reply comes back through the transcript.
async function turn(name, text) {
  await ctl('send', name, text);
  let sawWorking = false;
  await until(`${name} answers`, async () => {
    const s = (await sessions())[name];
    if (s.status === 'working') sawWorking = true;
    return s.lastText === `echo: ${text}` && s.status === 'idle' && s.lastPrompt === text;
  });
  if (!sawWorking) throw new Error(`${name} answered, but never showed as working`);
}

async function serviceCheck(kind) {
  const serviceEnv = { ...bare, FMUX_FAKE: '1' };
  if (kind === 'native') {
    if (process.env.CI !== 'true') throw new Error('--service=native installs a real service with the real HOME. It runs in CI only.');
    serviceEnv.HOME = os.homedir();
  }
  const { serviceCommands, serviceKind } = await import(path.join(ROOT, 'src', 'service.mjs'));
  const used = kind === 'tmux' ? 'tmux' : await serviceKind();
  const shell = (command) => (WINDOWS ? run('cmd.exe', ['/d', '/c', command], { env: serviceEnv }) : run('sh', ['-c', command], { env: serviceEnv }));
  try {
    await check(`install-service (${used}) starts the hub`, async () => {
      const out = await fmux(['install-service', ...(kind === 'tmux' ? ['--tmux'] : [])], serviceEnv);
      await until('the service answers', () => ctl('status'));
      return out.trim().split('\n')[0];
    });
    await check(`the service (${used}) starts the hub again after it dies`, async () => {
      const before = JSON.parse(await ctl('status'));
      process.kill(before.pid, 'SIGKILL');
      const after = await until('another hub process answers', async () => {
        const status = JSON.parse(await ctl('status'));
        return status.pid !== before.pid && status;
      }, 40000);
      return `pid ${before.pid} → ${after.pid}`;
    });
    if (used === 'tmux') {
      await check('the hub does not list its own tmux session', async () => {
        const list = await sessions();
        if (list['fmux-hub']) throw new Error('fmux-hub is in the list');
        if (!(await tmux('list-sessions', '-F', '#{session_name}')).includes('fmux-hub')) throw new Error('no fmux-hub session in tmux');
      });
    }
  } finally {
    await check(`the service (${used}) stops with its stop command`, async () => {
      await shell(serviceCommands(used).stop);
      await until('the hub is gone', async () => !(await ctl('status').catch(() => '')), 15000);
      return serviceCommands(used).stop;
    });
    if (kind === 'native') {
      await shell('systemctl --user disable fmux.service 2>/dev/null; rm -f ~/.config/systemd/user/fmux.service ~/Library/LaunchAgents/com.primatix.fmux.plist; true');
    }
  }
}

async function main() {
  console.log(`fmux integration test · ${process.platform} ${os.release()} · node ${process.versions.node} · ${(await tmux('-V')).trim()}`);
  console.log(`scratch ${tmp}\n`);
  console.log((await fmux(['doctor']).catch((err) => err.message)).trim().replace(/^/gm, '  '), '\n');

  const size = ['-x', '120', '-y', '30', '-c', dirs.work];
  await tmux('new-session', '-d', '-s', 'it_shell', ...size);
  await tmux('new-session', '-d', '-s', 'it_claude', ...size, ...start.claude);
  await tmux('new-session', '-d', '-s', 'it_codex', ...size, ...start.codex);
  await tmux('new-session', '-d', '-s', 'it_pi', ...size, ...start.pi);
  if (WINDOWS) {
    // Windows cannot say what a process reads from. An agent that a program drives is known by its command line.
    await tmux('new-session', '-d', '-s', 'it_piped', ...size, ...start.claude, '-p', 'summarize');
  } else {
    await tmux('new-session', '-d', '-s', 'it_native', ...size, 'env', `PATH=${dirs.native}:${env.PATH}`, 'STUB_KIND=claude', 'claude', STUB);
    await tmux('new-session', '-d', '-s', 'it_piped', ...size, 'tail -f /dev/null | claude');
  }
  for (const name of real) {
    if (WINDOWS) {
      const file = (await run('where.exe', [name], { env: process.env })).split(/\r?\n/)[0].trim();
      await tmux('new-session', '-d', '-s', `it_real_${name}`, ...size, '--', file);
    } else {
      const file = (await run('sh', ['-c', `command -v ${name}`], { env: process.env })).trim();
      await tmux('new-session', '-d', '-s', `it_real_${name}`, ...size, 'env', `PATH=${path.dirname(file)}:${env.PATH}`, name);
    }
  }
  startHub();

  await check('the hub starts and answers on its socket', async () => {
    const status = await until('status', async () => JSON.parse(await ctl('status')));
    return `${status.sessions} sessions`;
  });

  const expected = { it_shell: 'shell', it_claude: 'claude', it_codex: 'codex', it_pi: 'pi', it_piped: 'shell', ...(WINDOWS ? {} : { it_native: 'claude' }) };
  await check('each pane is recognized: script agents, a native-style agent, a piped agent, a shell', async () => {
    let seen = {};
    try {
      await until('kinds', async () => {
        const list = await sessions();
        seen = Object.fromEntries(Object.keys(expected).sort().map((name) => [name, list[name]?.kind]));
        return Object.keys(expected).every((name) => seen[name] === expected[name]);
      }, 15000);
    } catch {
      const table = WINDOWS
        ? await run('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name) $($_.CommandLine)" }']).catch((err) => err.message)
        : await run('ps', ['-A', '-ww', '-o', 'pid=,ppid=,tty=,args='], { env: { ...env, LC_ALL: 'C' } });
      const panes = await tmux('list-panes', '-a', '-F', '#{session_name} #{pane_pid} #{pane_tty} #{pane_current_command}').catch((err) => err.message);
      throw new Error(`expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(seen)}\n${panes}\n${table.split(/\r?\n/).filter((l) => /stub-agent|node_modules|\/bin\/(claude|codex|pi)|tail -f|psmux|pwsh|powershell/.test(l)).join('\n')}`);
    }
    return Object.entries(seen).map(([name, kind]) => `${name.slice(3)}=${kind}`).join(' ');
  });

  if (!WINDOWS) await check('how the system names a native-style agent process', async () => {
    const pid = (await tmux('list-panes', '-t', 'it_native', '-F', '#{pane_pid}')).trim();
    const tree = await run('ps', ['-A', '-ww', '-o', 'pid=,ppid=,ucomm=,args='], { env: { ...env, LC_ALL: 'C' } });
    const line = tree.split('\n').find((l) => l.includes(STUB) && (l.trim().startsWith(`${pid} `) || l.includes(` ${pid} `)));
    return line ? line.trim().replace(/\s+/g, ' ') : 'not found';
  });

  for (const name of real) {
    await check(`the real ${name} CLI in a pane is recognized as ${name}`, async () => {
      const session = `it_real_${name}`;
      const pid = (await tmux('list-panes', '-t', session, '-F', '#{pane_pid}')).trim();
      const tree = WINDOWS ? [] : (await run('ps', ['-A', '-ww', '-o', 'pid=,ppid=,ucomm=,args='], { env: { ...env, LC_ALL: 'C' } })).split('\n').map((l) => l.trim().replace(/\s+/g, ' '));
      const family = tree.filter((l) => l.startsWith(`${pid} `) || l.split(' ')[1] === pid);
      try {
        const s = await until(`${session} is ${name}`, async () => {
          const found = (await sessions())[session];
          return found?.kind === name && found;
        }, 40000);
        return `status ${s.status}; processes: ${family.join(' | ')}`;
      } catch (err) {
        const screen = await tmux('capture-pane', '-p', '-t', session).catch(() => '');
        throw new Error(`${err.message}\n    processes: ${family.join(' | ')}\n    screen:\n${screen.trim().split('\n').slice(0, 15).join('\n')}`);
      }
    });
  }

  await check('Claude Code: text in, working, reply out (status file and transcript)', () => turn('it_claude', '你好 fmux'));
  if (WINDOWS) await check('a text that ends with a semicolon arrives whole', () => turn('it_claude', 'second message; with a semicolon;'));
  else await check('Claude Code, native-style process name: the same', () => turn('it_native', 'second agent; with a semicolon;'));
  await check('Codex: reply found through the rollout file the process holds open', () => turn('it_codex', 'ping codex'));
  await check('pi: reply found through the working directory of the process', () => turn('it_pi', 'ping pi'));

  await check('shell: a command goes in and its non-ASCII output is read back from the screen', async () => {
    // The shell of a pane is PowerShell on Windows and sh elsewhere.
    await ctl('send', 'it_shell', WINDOWS ? 'echo "结果-$(6*7)"' : 'echo 结果-$((6*7))');
    await until('the output is on the screen', async () => (await ctl('peek', 'it_shell')).includes('结果-42'));
  });

  if (WINDOWS) {
    await check('a multi-line text arrives whole (paste buffer loaded from a file)', async () => {
      const file = path.join(dirs.work, 'pasted.txt');
      await ctl('send', 'it_shell', `$a = "行一"\n$b = "行二"\nSet-Content -Encoding utf8 -Path '${file}' -Value "$a-$b-done"`);
      await until('the file has the text', () => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('行一-行二-done'));
    });
  } else {
    await check('a long multi-line text arrives whole (tmux paste buffer)', async () => {
      const file = path.join(dirs.work, 'pasted.txt');
      const body = Array.from({ length: 60 }, (_, i) => `行 ${i + 1} ${'x'.repeat(40)}`).join('\n');
      await ctl('send', 'it_shell', `cat > ${file} <<'FMUX_EOF'\n${body}\nFMUX_EOF`);
      await until('the file has the text', () => fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() === body);
    });
  }

  await check('new session and kill session through the hub', async () => {
    await ctl('new', 'it_new', '--agent', 'shell', '--cwd', dirs.work, '--no-attach', '--prompt', 'echo created-$(1+1)');
    await until('it_new is listed', async () => (await sessions()).it_new?.kind === 'shell');
    // The typed line starts with the prompt of the shell, so a line that starts with "created-" is the output.
    await until('the first command ran in the new pane', async () => /^created-/m.test(await ctl('peek', 'it_new')));
    await ctl('kill', 'it_new', '--yes');
    await until('it_new is gone', async () => !(await sessions()).it_new);
  });

  await check('chat: attach, send a message, get the reply as a card', async () => {
    await ctl('dev', 'say', '//a it_claude');
    await ctl('dev', 'say', '第二句');
    await until('a card holds the reply', async () => (await ctl('dev', 'outbox', '12')).includes('echo: 第二句'));
    await ctl('dev', 'say', '//d');
  });

  await check('past conversations are listed without an error', async () => {
    const list = JSON.parse(await ctl('history', '--json'));
    return `${list.length} found`;
  });

  await stopHub();
  if (service) await serviceCheck(service);
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  console.log(`✗ ${err.stack || err.message}`);
} finally {
  await stopHub();
  if (results.includes(false) || failed) {
    const log = path.join(tmp, 'hub.log');
    if (fs.existsSync(log)) console.log(`\n--- hub log (last lines) ---\n${fs.readFileSync(log, 'utf8').split('\n').slice(-40).join('\n')}`);
  }
  if (keep) {
    console.log(`\nkept: ${tmp}  (tmux: TMUX_TMPDIR=${dirs.tmux} tmux ls)`);
  } else {
    await tmux('kill-server').catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
const bad = results.filter((ok) => !ok).length + (failed ? 1 : 0);
console.log(`\n${results.length - results.filter((ok) => !ok).length} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
