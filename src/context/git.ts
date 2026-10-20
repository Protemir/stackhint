import fs from 'node:fs';
import path from 'node:path';
import type { GitInfo, GitRemote } from '../types.ts';
import { readText } from '../util/fsx.ts';
import { which, run } from '../util/exec.ts';

/** Find the .git directory (or worktree gitdir file) for a project. */
export function findGitDir(root: string): string | undefined {
  let dir = path.resolve(root);
  for (let i = 0; i < 40; i++) {
    const candidate = path.join(dir, '.git');
    try {
      const st = fs.statSync(candidate);
      if (st.isDirectory()) return candidate;
      if (st.isFile()) {
        const text = readText(candidate, 4096) ?? '';
        const m = /^gitdir:\s*(.+)$/m.exec(text);
        if (m && m[1]) return path.resolve(dir, m[1].trim());
      }
    } catch {
      /* keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Strip credentials from a remote URL. */
export function cleanRemoteUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
}

export function remoteHost(url: string): string {
  const scp = /^[^@\s]+@([^:\s]+):/.exec(url);
  if (scp && scp[1]) return scp[1].toLowerCase();
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function parseRemotes(configText: string): GitRemote[] {
  const remotes: GitRemote[] = [];
  let current: string | undefined;
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[remote\s+"([^"]+)"\]$/.exec(line);
    if (sec) {
      current = sec[1];
      continue;
    }
    if (line.startsWith('[')) {
      current = undefined;
      continue;
    }
    const kv = /^url\s*=\s*(.+)$/.exec(line);
    if (current && kv && kv[1]) {
      const url = cleanRemoteUrl(kv[1].trim());
      remotes.push({ name: current, host: remoteHost(url), url });
    }
  }
  return remotes;
}

function listBranches(gitDir: string, commonDir: string): string[] {
  const names = new Set<string>();
  const headsDir = path.join(commonDir, 'refs', 'heads');
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > 4 || names.size > 500) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${prefix}${e.name}/`, depth + 1);
      else if (e.isFile()) names.add(prefix + e.name);
    }
  };
  walk(headsDir, '', 0);
  const packed = readText(path.join(commonDir, 'packed-refs'), 2 * 1024 * 1024) ?? '';
  for (const line of packed.split(/\r?\n/)) {
    const m = /^[0-9a-f]{40}\s+refs\/heads\/(.+)$/.exec(line);
    if (m && m[1]) names.add(m[1]);
  }
  void gitDir;
  return [...names].slice(0, 500);
}

export interface GitOptions {
  /** Read recent commit subjects with `git log`. Local only, read-only. */
  history: boolean;
}

export async function readGit(root: string, opts: GitOptions): Promise<GitInfo> {
  const info: GitInfo = { isRepo: false, remotes: [], branches: [], recentSubjects: [] };
  const gitDir = findGitDir(root);
  if (!gitDir) return info;
  info.isRepo = true;
  // Worktrees keep shared refs and config in the common dir.
  let commonDir = gitDir;
  const common = readText(path.join(gitDir, 'commondir'), 4096);
  if (common) commonDir = path.resolve(gitDir, common.trim());

  const head = readText(path.join(gitDir, 'HEAD'), 4096) ?? '';
  const m = /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
  if (m && m[1]) info.branch = m[1].trim();

  info.remotes = parseRemotes(readText(path.join(commonDir, 'config'), 1024 * 1024) ?? '');
  info.branches = listBranches(gitDir, commonDir);

  if (opts.history) {
    const git = which('git');
    if (git) {
      // The scanned repository's .git/config is untrusted: switch off everything in it that could
      // run a program (signature checks via gpg.program, fsmonitor hooks, pagers, textconv).
      const res = await run(
        git,
        [
          '--no-pager',
          '-c', 'core.quotepath=off',
          '-c', 'log.showSignature=false',
          '-c', 'core.fsmonitor=false',
          '-c', 'core.untrackedCache=false',
          '-c', 'gpg.program=false',
          '-c', 'gpg.ssh.program=false',
          '-c', 'gpg.x509.program=false',
          '-c', 'diff.external=',
          'log', '-n', '200', '--no-merges', '--no-show-signature', '--no-textconv', '--no-ext-diff', '--no-color', '--format=%s',
        ],
        {
          cwd: root,
          timeoutMs: 2500,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', PAGER: 'cat', GIT_CONFIG_NOSYSTEM: '1' },
        },
      );
      if (res.code === 0) {
        info.recentSubjects = res.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 200);
      }
    }
  }
  return info;
}
