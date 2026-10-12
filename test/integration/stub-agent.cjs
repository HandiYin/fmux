#!/usr/bin/env node
// A stand-in for an agent CLI, for the integration test: it keeps the files the real one keeps
// (status file, transcript) and answers each line with "echo: <line>". No model, no network.
// The kind is the name it is started under (claude, codex, pi), the package directory it is in
// (the test on Windows copies it into an npm-style tree), or STUB_KIND.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const script = (process.argv[1] || '').replace(/\\/g, '/');
const invoked = path.basename(script);
const packaged = /claude-code/.test(script) ? 'claude' : /@openai\/codex/.test(script) ? 'codex' : /pi-coding-agent/.test(script) ? 'pi' : '';
const kind = ['claude', 'codex', 'pi'].includes(invoked) ? invoked : packaged || process.env.STUB_KIND || 'claude';
const home = os.homedir();
const cwd = process.cwd();
const id = crypto.randomUUID();
const startedAt = Date.now();
const BUSY_MS = Number(process.env.STUB_BUSY_MS || 1500);

function ensure(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

const agents = {
  claude() {
    const statusFile = ensure(path.join(home, '.claude', 'sessions', `${process.pid}.json`));
    const transcript = ensure(path.join(home, '.claude', 'projects', '-stub', `${id}.jsonl`));
    const add = (line) => fs.appendFileSync(transcript, `${JSON.stringify({ sessionId: id, cwd, ...line })}\n`);
    const status = (value) => {
      const meta = { pid: process.pid, sessionId: id, cwd, startedAt, kind: 'interactive', entrypoint: 'cli', status: value, statusUpdatedAt: Date.now() };
      fs.writeFileSync(`${statusFile}.tmp`, JSON.stringify(meta));
      fs.renameSync(`${statusFile}.tmp`, statusFile);
    };
    fs.writeFileSync(transcript, '');
    status('idle');
    process.on('exit', () => fs.rmSync(statusFile, { force: true }));
    return {
      begin(text) {
        status('busy');
        add({ type: 'user', message: { role: 'user', content: text } });
      },
      end(reply) {
        add({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
        add({ type: 'system', subtype: 'turn_duration', durationMs: BUSY_MS });
        status('idle');
      },
    };
  },

  // Codex keeps its rollout file open. That is how fmux finds it.
  codex() {
    const now = new Date();
    const day = [String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')];
    const fd = fs.openSync(ensure(path.join(home, '.codex', 'sessions', ...day, `rollout-${now.toISOString().replace(/[:.]/g, '-')}-${id}.jsonl`)), 'a');
    const add = (line) => fs.writeSync(fd, `${JSON.stringify(line)}\n`);
    add({ type: 'session_meta', payload: { id, cwd, originator: 'codex-tui' } });
    return {
      begin(text) {
        add({ type: 'event_msg', payload: { type: 'user_message', message: text } });
      },
      end(reply) {
        add({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] } });
        add({ type: 'event_msg', payload: { type: 'task_complete', duration_ms: BUSY_MS } });
      },
    };
  },

  // pi names the session directory after the working directory.
  pi() {
    const dir = path.join(home, '.pi', 'agent', 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
    const transcript = ensure(path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${id}.jsonl`));
    const add = (line) => fs.appendFileSync(transcript, `${JSON.stringify(line)}\n`);
    add({ type: 'session', id, cwd });
    return {
      begin(text) {
        add({ type: 'message', message: { role: 'user', content: text } });
      },
      end(reply) {
        add({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: reply }], stopReason: 'stop' } });
      },
    };
  },
};

const agent = agents[kind]();
const prompt = () => process.stdout.write(`\x1b[2J\x1b[H${kind} stub ${process.pid}\n> `);
prompt();
let queue = Promise.resolve();
readline.createInterface({ input: process.stdin, terminal: false }).on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  queue = queue.then(async () => {
    agent.begin(text);
    process.stdout.write('\n⠹ Working (esc to interrupt)\n');
    await new Promise((resolve) => setTimeout(resolve, BUSY_MS));
    agent.end(`echo: ${text}`);
    prompt();
    process.stdout.write(`\necho: ${text}\n> `);
  });
});
// Stay up when stdin is a pipe that never closes, or closes at once.
setInterval(() => {}, 1 << 30);
