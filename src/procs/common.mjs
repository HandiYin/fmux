const JS_RUNTIMES = new Set(['node', 'MainThread', 'bun', 'deno']);
const AGENTS = new Set(['claude', 'codex', 'pi', 'agy', 'dsh']);
const SCRIPT_SUBCOMMANDS = {
  codex: ['app-server', 'exec', 'mcp-server', 'mcp', 'proto'],
  agy: ['acp', 'agent', 'agents', 'changelog', 'help', 'install', 'mcp', 'mic-serve', 'models', 'plugin', 'plugins', 'remote-control', 'update'],
  dsh: ['headless', 'run', 'cli', 'doctor', 'plugin', 'update', 'version', 'help', 'migrate'],
};
const SCRIPT_FLAGS = {
  claude: ['-p', '--print'],
  pi: ['-p', '--print'],
  agy: ['-p', '--print', '--prompt'],
  dsh: ['-p', '--dump-config', '--dump-config-schema', '--dump-default-config'],
};

// The first word of a command line. On Windows it can be a quoted path with spaces.
function firstWord(args) {
  const quoted = /^"([^"]*)"/.exec(args);
  return quoted ? quoted[1] : args.split(/\s+/)[0] || '';
}

// "claude" from "/usr/bin/claude", "-zsh" (a login shell) or "C:\Users\me\.local\bin\claude.exe".
export function baseName(word) {
  return (word || '').split(/[/\\]/).pop().replace(/^-/, '').replace(/\.(exe|cmd|bat)$/i, '');
}

// The kind of agent a process is, or null. `comm` is the short process name, `args` the command
// line as one string. macOS names a process after the file it runs, and for Claude Code that
// file is named after its version, so the first word of the command line counts too.
export function classify(comm, args = '') {
  const line = args.replace(/\\/g, '/');
  const first = firstWord(line);
  const name = baseName(first);
  comm = baseName(comm);
  if (AGENTS.has(comm)) return comm;
  if (AGENTS.has(name)) return name;
  if (comm === 'antigravity' || name === 'antigravity') return 'agy';
  if (comm === 'dsh-tui' || name === 'dsh-tui' || comm === 'dst' || name === 'dst') return 'dsh';
  if (first.includes('/claude/versions/')) return 'claude';
  if (JS_RUNTIMES.has(comm) || JS_RUNTIMES.has(name)) {
    if (/pi-coding-agent|\/bin\/pi(["\s]|$)/.test(line)) return 'pi';
    if (/@openai\/codex|\/bin\/codex(["\s]|$)/.test(line)) return 'codex';
    if (/claude-code|\/bin\/claude(["\s]|$)/.test(line)) return 'claude';
    if (/antigravity-cli|\/bin\/agy(["\s]|$)/.test(line)) return 'agy';
    if (/@deepseek-ai\/dsh|deepseek-harness|dsh-tui|\/bin\/dst(["\s]|$)/.test(line)) return 'dsh';
  }
  return null;
}

// Is this agent run by a program and not by a person at the terminal? Windows cannot tell what
// a process reads from, so there the command line has to say it: a subcommand such as
// `codex app-server`, or a flag such as `claude -p`, before the first plain word.
export function drivenByScript(kind, args = '') {
  const words = (args.match(/"[^"]*"|\S+/g) || []).map((w) => w.replace(/"/g, ''));
  let i = 1;
  if (JS_RUNTIMES.has(baseName(words[0]).toLowerCase())) {
    while (i < words.length && words[i].startsWith('-')) i++;
    i++;
  }
  const flags = [];
  for (; i < words.length && words[i].startsWith('-'); i++) flags.push(words[i].split('=')[0]);
  if (SCRIPT_SUBCOMMANDS[kind]?.includes(words[i])) return true;
  if (flags.some((flag) => SCRIPT_FLAGS[kind]?.includes(flag))) return true;
  return kind === 'pi' && /\s--mode[\s=]+(rpc|json)(\s|$)/.test(args);
}

export function indexProcs(procs) {
  const children = new Map();
  for (const [pid, proc] of procs) {
    if (!children.has(proc.ppid)) children.set(proc.ppid, []);
    children.get(proc.ppid).push(pid);
  }
  return { procs, children };
}
