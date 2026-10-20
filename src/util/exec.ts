import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Env } from './paths.ts';

/** Find an executable on PATH without running anything. */
export function which(name: string, env: Env = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const pathVar = env['PATH'] ?? env['Path'] ?? '';
  // Windows allows quoted entries such as "C:\Program Files\nodejs"; cmd.exe strips the quotes too.
  const dirs = pathVar.split(platform === 'win32' ? ';' : ':').map((d) => (platform === 'win32' ? d.replace(/"/g, '') : d)).filter(Boolean);
  const exts =
    platform === 'win32'
      ? ['', ...(env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())]
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        const st = fs.statSync(candidate);
        if (!st.isFile()) continue;
        if (platform === 'win32') {
          // On Windows only files with a PATHEXT extension are runnable.
          if (ext === '' && !/\.(exe|cmd|bat|com)$/i.test(name)) continue;
          return candidate;
        }
        if (st.mode & 0o111) return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return undefined;
}

/**
 * which() for many names at once: each PATH folder is listed once instead of probing every
 * name and extension with stat (25 names x 40 folders x 5 extensions is slow on Windows).
 */
export function whichMany(names: readonly string[], env: Env = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const win = platform === 'win32';
  const pathVar = env['PATH'] ?? env['Path'] ?? '';
  const dirs = pathVar.split(win ? ';' : ':').map((d) => (win ? d.replace(/"/g, '') : d)).filter(Boolean);
  const exts = win ? ['', ...(env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())] : [''];
  const out: Record<string, string> = {};
  for (const dir of dirs) {
    let listing: string[];
    try {
      listing = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const present = new Set(win ? listing.map((f) => f.toLowerCase()) : listing);
    for (const name of names) {
      if (out[name] !== undefined) continue;
      for (const ext of exts) {
        if (!present.has(win ? (name + ext).toLowerCase() : name + ext)) continue;
        // Same rules as which(): a regular file, runnable by extension (Windows) or mode (POSIX).
        const found = which(name, { PATH: dir, PATHEXT: ext ? ext.toUpperCase() : '.EXE' }, platform);
        if (found) {
          out[name] = found;
          break;
        }
      }
    }
    if (Object.keys(out).length === names.length) break;
  }
  return out;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Characters we refuse to pass through cmd.exe, which re-parses its command line. */
const CMD_UNSAFE = /["%^&|<>!\r\n]/;

/**
 * Run a program with an argument array and no shell. Batch files (.cmd/.bat) cannot be
 * spawned without a shell on Windows, so for those we go through cmd.exe and only accept
 * arguments that cmd.exe cannot reinterpret.
 */
export function run(file: string, args: readonly string[], opts: { cwd?: string; timeoutMs?: number; env?: Env } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let exe = file;
    let argv = [...args];
    const isBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
    if (isBatch) {
      const bad = [file, ...args].find((a) => CMD_UNSAFE.test(a));
      if (bad !== undefined) {
        resolve({ code: -1, stdout: '', stderr: '', error: 'argument contains characters that are unsafe for cmd.exe' });
        return;
      }
      exe = process.env['ComSpec'] ?? 'cmd.exe';
      // Backslashes before a closing quote must be doubled, or they escape the quote.
      argv = ['/d', '/s', '/c', `"${[file, ...args].map((a) => `"${a.replace(/(\\+)$/, '$1$1')}"`).join(' ')}"`];
    }
    const env = { ...((opts.env ?? process.env) as NodeJS.ProcessEnv) };
    // Never let cmd.exe pick up a node.bat or similar from the scanned repository.
    if (isBatch) env['NoDefaultCurrentDirectoryInExePath'] = '1';
    execFile(
      exe,
      argv,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 20_000,
        windowsHide: true,
        windowsVerbatimArguments: isBatch,
        maxBuffer: 4 * 1024 * 1024,
        env,
      },
      (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code === 'string') {
          resolve({ code: -1, stdout: String(stdout), stderr: String(stderr), error: error.message });
          return;
        }
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ code: typeof code === 'number' ? code : 1, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/**
 * Quote argv for display. Display only, never executed by us. Single quotes are literal in
 * POSIX shells and in PowerShell; an embedded quote uses the POSIX '"'"' form (registry and
 * parameter validation already keep quotes and $ out of these values).
 */
export function shellQuote(args: readonly string[]): string {
  return args
    .map((a) => {
      if (a === '') return "''";
      if (/^[A-Za-z0-9_@+=:,./-]+$/.test(a)) return a;
      return `'${a.replace(/'/g, `'"'"'`)}'`;
    })
    .join(' ');
}
