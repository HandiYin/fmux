// Heuristics over a captured pane. Used for agents that expose no status file, and to read
// the options of a dialog that is blocking an agent.

const CURSOR = '[❯›▶→]';
const NUMBERED_RE = new RegExp(`^\\s*(${CURSOR})?\\s*(\\d)[.)]\\s+(\\S.*)$`);
const CURSOR_RE = new RegExp(`^(\\s*)(${CURSOR})\\s+(\\S.*)$`);
const MENU_HINT_RE = /Enter to (confirm|select|continue|submit)|Esc to (cancel|exit|go back)|to navigate|to select|↑\s*\/?\s*↓/i;

// Remove the side borders of a boxed dialog but keep the indentation inside it.
function stripBorder(line) {
  return line.replace(/^\s*[│┃|]\s?/, '').replace(/\s*[│┃|]\s*$/, '');
}

function questionAbove(lines, first) {
  return lines.slice(Math.max(0, first - 6), first).map((l) => l.trim()).filter((l) => l && !/^[─━═]+$/.test(l)).slice(-3).join('\n');
}

// A numbered choice list with a cursor on one option:
//   Do you want to proceed?
//   ❯ 1. Yes
//     2. Yes, and don't ask again
//     3. No
function findNumbered(lines) {
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i].match(NUMBERED_RE);
    if (!first || first[2] !== '1') continue;
    const options = [];
    let j = i;
    let expected = 1;
    let hasCursor = false;
    while (j < lines.length) {
      const m = lines[j].match(NUMBERED_RE);
      if (m && Number(m[2]) === expected) {
        options.push({ key: m[2], label: m[3].trim(), selected: Boolean(m[1]) });
        hasCursor ||= Boolean(m[1]);
        expected++;
      } else if (lines[j].trim() === '' || /^\s{3,}\S/.test(lines[j]) || /^[\s─━]+$/.test(lines[j])) {
        // blank line, a rule, or an indented description under the previous option
      } else {
        break;
      }
      j++;
    }
    if (options.length >= 2 && hasCursor) best = { numbered: true, question: questionAbove(lines, i), options };
  }
  return best;
}

// A cursor menu without numbers, moved with the arrow keys:
//   ❯ No, exit
//     Yes, I trust this folder
//   Enter to confirm · Esc to cancel
// The hint line is required: an agent's own input box also starts with a cursor.
function findMenu(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(CURSOR_RE);
    if (!m) continue;
    const col = lines[i].indexOf(m[3], m[1].length + m[2].length);
    const isOption = (line) => line.length > col && line.slice(0, col).trim() === '' && /\S/.test(line[col]);
    let start = i;
    while (start > 0 && isOption(lines[start - 1])) start--;
    let end = i;
    while (end < lines.length - 1 && isOption(lines[end + 1])) end++;
    if (end === start) continue;
    if (!MENU_HINT_RE.test(lines.slice(end + 1, end + 6).join('\n'))) continue;
    const options = lines.slice(start, end + 1).map((line, idx) => ({ label: line.slice(col).trim(), selected: start + idx === i }));
    return { numbered: false, question: questionAbove(lines, start), options };
  }
  return null;
}

export function findDialog(screen, window = 24) {
  const lines = screen.split('\n').slice(-window).map(stripBorder);
  return findNumbered(lines) || findMenu(lines);
}

// Keys that choose option `index`: its digit, or cursor moves from the selected option plus Enter.
export function keysFor(dialog, index) {
  const option = dialog.options[index];
  if (!option) throw new Error('no such option');
  if (dialog.numbered) return [option.key];
  const selected = Math.max(0, dialog.options.findIndex((o) => o.selected));
  const delta = index - selected;
  return [...Array(Math.abs(delta)).fill(delta > 0 ? 'down' : 'up'), 'enter'];
}

// Claude and Codex print "esc to interrupt" while they run; pi shows a braille spinner before "Working".
export function looksWorking(screen) {
  const bottom = screen.split('\n').slice(-10).join('\n');
  return /esc to interrupt|ctrl\+c to interrupt|[\u2801-\u28ff]\s*(Working|Thinking|Compacting|Retrying)/i.test(bottom);
}

// Trim a capture for a phone: drop blank runs, shorten rules, keep the last `maxLines`.
export function compactScreen(screen, maxLines = 34, maxCols = 110) {
  const out = [];
  let blank = 0;
  for (let line of screen.split('\n')) {
    line = line.replace(/[─━═]{12,}/g, '────────').replace(/\s+$/, '');
    if (!line.trim()) {
      if (++blank > 1) continue;
    } else {
      blank = 0;
    }
    const cps = Array.from(line);
    out.push(cps.length > maxCols ? cps.slice(0, maxCols).join('') + '…' : line);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.slice(-maxLines).join('\n');
}
