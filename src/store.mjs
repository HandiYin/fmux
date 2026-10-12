import fs from 'node:fs';
import path from 'node:path';

const MAX_MESSAGES = 400;

// Small persistent state: which session the chat is attached to, the live dashboard
// message, and which session each card we sent belongs to.
export class Store {
  constructor(file) {
    this.file = file;
    this.data = { chatId: '', attached: null, dash: null, messages: [] };
    if (file && fs.existsSync(file)) {
      try {
        this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch {
        // A damaged state file only loses the attachment; start clean.
      }
    }
    this.byMessage = new Map(this.data.messages);
    this.timer = null;
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  rememberMessage(messageId, sessionKey) {
    if (!messageId) return;
    this.byMessage.set(messageId, sessionKey);
    while (this.byMessage.size > MAX_MESSAGES) this.byMessage.delete(this.byMessage.keys().next().value);
    this.save();
  }

  sessionKeyFor(messageId) {
    return this.byMessage.get(messageId) || null;
  }

  save() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 300);
  }

  flush() {
    if (!this.file) return;
    this.data.messages = [...this.byMessage];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
