import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';


/** Find an executable on PATH without running anything. */
export function which(name        , env      = process.env, platform                  = process.platform)                     {
  const pathVar = env['PATH'] ?? env['Path'] ?? '';
  const dirs = pathVar.split(platform === 'win32' ? ';' : ':').filter(Boolean);
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








/** Characters we refuse to pass through cmd.exe, which re-parses its command line. */
const CMD_UNSAFE = /["%^&|<>!\r\n]/;

/**
 * Run a program with an argument array and no shell. Batch files (.cmd/.bat) cannot be
 * spawned without a shell on Windows, so for those we go through cmd.exe and only accept
 * arguments that cmd.exe cannot reinterpret.
 */
export function run(file        , args                   , opts                                                  = {})                     {
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
    const env = { ...((opts.env ?? process.env)                     ) };
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
        if (error && typeof (error                         ).code === 'string') {
          resolve({ code: -1, stdout: String(stdout), stderr: String(stderr), error: error.message });
          return;
        }
        const code = error ? ((error                     ).code ?? 1) : 0;
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
export function shellQuote(args                   )         {
  return args
    .map((a) => {
      if (a === '') return "''";
      if (/^[A-Za-z0-9_@+=:,./-]+$/.test(a)) return a;
      return `'${a.replace(/'/g, `'"'"'`)}'`;
    })
    .join(' ');
}
