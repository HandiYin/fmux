import fs from 'node:fs';

// Read a UTF-8 byte range from a file without loading the entire file into memory.
export function readFileSlice(file, start, length) {
  if (length <= 0) return '';
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

// Read up to the last `maxBytes` of a line-oriented file, discarding a partial leading line.
// Returns null if the file cannot be read.
export function readTailSlice(file, maxBytes) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }
  const start = Math.max(0, size - maxBytes);
  let text = readFileSlice(file, start, size - start);
  if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  return text;
}

// Parse complete JSON objects from newline-delimited text, skipping blank or partial lines.
export function parseJsonLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // ignore partial or malformed lines
    }
  }
  return out;
}

// Read and parse only the first JSONL line of a file.
export function readFirstJsonLine(file, maxBytes = 64 * 1024) {
  try {
    const head = readFileSlice(file, 0, maxBytes);
    const first = head.split('\n')[0];
    return first ? JSON.parse(first) : null;
  } catch {
    return null;
  }
}
