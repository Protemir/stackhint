import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Read a UTF-8 text file. Returns undefined if missing, too big or binary. */
export function readText(p: string, maxBytes = 512 * 1024): string | undefined {
  let fd: number | undefined;
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > maxBytes) return undefined;
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = fs.readSync(fd, buf, read, st.size - read, read);
      if (n <= 0) break;
      read += n;
    }
    const slice = buf.subarray(0, read);
    if (slice.includes(0)) return undefined;
    let text = slice.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export type JsonResult<T> = { ok: true; value: T } | { ok: false; error: string; missing: boolean };

export function readJson<T = unknown>(p: string, maxBytes = 8 * 1024 * 1024): JsonResult<T> {
  if (!exists(p)) return { ok: false, error: 'missing', missing: true };
  const text = readText(p, maxBytes);
  if (text === undefined) return { ok: false, error: 'unreadable or too large', missing: false };
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}`, missing: false };
  }
}

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Write a file atomically: write a temp file next to it, then rename over the target. */
export function writeAtomic(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    let mode: number | undefined;
    try {
      mode = fs.statSync(p).mode & 0o777;
    } catch {
      mode = undefined;
    }
    fs.writeFileSync(tmp, content, mode === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', mode });
    renameWithRetry(tmp, p);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/** Windows can briefly lock a file that an editor or antivirus has open. */
function renameWithRetry(from: string, to: string): void {
  let lastError: unknown;
  for (let i = 0; i < 6; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      lastError = e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') break;
      const until = Date.now() + 40 * (i + 1);
      while (Date.now() < until) {
        /* short spin; this only runs on rare lock contention */
      }
    }
  }
  throw lastError;
}

/** Detect indentation and line endings so rewritten JSON keeps the file's style. */
export function detectStyle(text: string): { indent: string; eol: string; finalNewline: boolean } {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const m = /\n([ \t]+)\S/.exec(text);
  const indent = m && m[1] ? m[1] : '  ';
  return { indent, eol, finalNewline: text.length === 0 || /\n$/.test(text) };
}
