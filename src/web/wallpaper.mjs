import fs from 'node:fs';
import path from 'node:path';

// Optional custom backdrop wallpaper persisted in stateDir (shared across desktop/mobile browsers).
export function createWallpaperStore(stateDir) {
  const dir = stateDir && stateDir !== '/nonexistent' ? stateDir : '';
  const binFile = dir ? path.join(dir, 'wallpaper.bin') : '';
  const metaFile = dir ? path.join(dir, 'wallpaper.json') : '';
  let mem = null;

  function readMeta() {
    if (mem) return { mime: mem.mime, updatedAt: mem.updatedAt };
    if (metaFile && binFile && fs.existsSync(metaFile) && fs.existsSync(binFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        if (parsed?.mime && parsed?.updatedAt) return parsed;
      } catch {
        // ignore damaged metadata
      }
    }
    return null;
  }

  function read() {
    if (mem) return mem;
    const meta = readMeta();
    if (!meta || !binFile || !fs.existsSync(binFile)) return null;
    try {
      return { ...meta, buf: fs.readFileSync(binFile) };
    } catch {
      return null;
    }
  }

  function save(mime, buf) {
    const updatedAt = Date.now();
    mem = { mime, updatedAt, buf };
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      const tmpBin = `${binFile}.tmp`;
      const tmpMeta = `${metaFile}.tmp`;
      fs.writeFileSync(tmpBin, buf, { mode: 0o600 });
      fs.renameSync(tmpBin, binFile);
      fs.writeFileSync(tmpMeta, JSON.stringify({ mime, updatedAt }), { mode: 0o600 });
      fs.renameSync(tmpMeta, metaFile);
    }
    return updatedAt;
  }

  function clear() {
    mem = null;
    for (const f of [binFile, metaFile]) {
      if (f && fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch {}
      }
    }
  }

  return { readMeta, read, save, clear };
}
