import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { log, oneLine } from './util.mjs';

// The pi agent that answers when the chat is not attached to a session.
// It runs as `pi --mode rpc` and manages sessions through the robinctl CLI.
// Emits: start, text(delta), tool({name, summary}), end({error}).
export class Concierge extends EventEmitter {
  constructor({ bin, cwd, sessionDir, promptFile, model, thinking, env }) {
    super();
    this.opts = { bin, cwd, sessionDir, promptFile, model, thinking, env };
    this.child = null;
    this.busy = false;
    this.buffer = '';
    this.error = null;
  }

  ensure() {
    if (this.child) return;
    const { bin, cwd, sessionDir, promptFile, model, thinking, env } = this.opts;
    fs.mkdirSync(sessionDir, { recursive: true });
    const args = ['--mode', 'rpc', '--name', 'Robin 管家', '--session-dir', sessionDir, '--continue', '--no-context-files', '--append-system-prompt', promptFile];
    if (model) args.push('--model', model);
    if (thinking) args.push('--thinking', thinking);
    const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.buffer = '';
    log('info', 'concierge.spawn', { pid: child.pid });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => log('warn', 'concierge.stderr', { text: oneLine(chunk, 300) }));
    child.on('error', (err) => this.onExit(child, `无法启动 pi：${err.message}`));
    child.on('exit', (code, signal) => this.onExit(child, this.busy ? `pi 进程退出（${signal || code}）` : null));
  }

  onExit(child, error) {
    if (this.child !== child) return;
    this.child = null;
    log('info', 'concierge.exit', { error });
    if (this.busy || error) {
      this.busy = false;
      this.emit('end', { error });
    }
  }

  // RPC frames are separated by LF only; U+2028 may appear inside JSON strings.
  onData(chunk) {
    this.buffer += chunk;
    let cut;
    while ((cut = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, cut).replace(/\r$/, '');
      this.buffer = this.buffer.slice(cut + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      this.onEvent(event);
    }
  }

  onEvent(e) {
    switch (e.type) {
      case 'response':
        if (e.success === false && e.command === 'prompt') {
          this.busy = false;
          this.emit('end', { error: e.error || 'pi 拒绝了这条消息' });
        }
        break;
      case 'agent_start':
        this.busy = true;
        this.error = null;
        this.emit('start');
        break;
      case 'message_start':
        if (e.message?.role === 'assistant') this.emit('text', '\n\n');
        break;
      case 'message_update':
        if (e.assistantMessageEvent?.type === 'text_delta') this.emit('text', e.assistantMessageEvent.delta);
        break;
      case 'message_end':
        if (e.message?.role === 'assistant' && e.message.stopReason === 'error') this.error = e.message.errorMessage || '模型调用出错';
        break;
      case 'tool_execution_start': {
        const args = e.args || {};
        this.emit('tool', { name: e.toolName, summary: oneLine(args.command || args.path || args.file_path || '', 90) });
        break;
      }
      case 'agent_settled':
        this.busy = false;
        this.emit('end', { error: this.error });
        break;
      default:
        break;
    }
  }

  send(command) {
    this.ensure();
    this.child.stdin.write(JSON.stringify(command) + '\n');
  }

  // A message that arrives during a run is steered into it instead of being rejected.
  prompt(message) {
    this.ensure();
    const running = this.busy;
    this.busy = true;
    this.send(running ? { type: 'prompt', message, streamingBehavior: 'steer' } : { type: 'prompt', message });
  }

  abort() {
    if (this.child && this.busy) this.send({ type: 'abort' });
  }

  newSession() {
    this.send({ type: 'new_session' });
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (child) child.kill('SIGTERM');
  }
}
