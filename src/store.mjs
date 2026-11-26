import fs from 'node:fs';
import path from 'node:path';

const MAX_MESSAGES = 400;
const DEFAULTS = { chatId: '', attached: null, live: [], messages: [], transcripts: {} };

// Small persistent state: owner chat, attached session, live cards, card->session map,
// and confirmed Codex transcript offsets. Unknown legacy keys from older branches are ignored.
export class Store {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS, live: [], messages: [], transcripts: {} };
    if (file && fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const key of Object.keys(DEFAULTS)) {
          if (parsed[key] !== undefined) this.data[key] = parsed[key];
        }
      } catch {
        // A damaged state file only loses the attachment; start clean.
      }
    }
    this.byMessage = new Map(Array.isArray(this.data.messages) ? this.data.messages : []);
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
