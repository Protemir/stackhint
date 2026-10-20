import fs from 'node:fs';
import path from 'node:path';

import { readText } from '../util/fsx.js';
import { which, run } from '../util/exec.js';

/**
 * Two leading slashes of any kind mean a network share on Windows. A repository must never send
 * us (or git) there: just opening \\host\share leaks the user's NTLM hash to that host.
 */
export function isNetworkPath(p        )          {
  return /^[\\/]{2}/.test(p.trim());
}

/** Find the .git directory (or worktree gitdir file) for a project. */
export function findGitDir(root        )                     {
  let dir = path.resolve(root);
  for (let i = 0; i < 40; i++) {
    const candidate = path.join(dir, '.git');
    try {
      const st = fs.statSync(candidate);
      if (st.isDirectory()) return candidate;
      if (st.isFile()) {
        const text = readText(candidate, 4096) ?? '';
        const m = /^gitdir:\s*(.+)$/m.exec(text);
        if (m && m[1]) {
          const target = m[1].trim();
          const resolved = path.resolve(dir, target);
          return isNetworkPath(target) || isNetworkPath(resolved) ? undefined : resolved;
        }
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

/** The working-tree root: the folder that contains .git (a directory, or a file in worktrees and submodules). */
export function findWorkTree(start        )                     {
  let dir = path.resolve(start);
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Strip credentials from a remote URL. */
export function cleanRemoteUrl(url        )         {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
}

export function remoteHost(url        )         {
  const scp = /^[^@\s]+@([^:\s]+):/.exec(url);
  if (scp && scp[1]) return scp[1].toLowerCase();
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function parseRemotes(configText        )              {
  const remotes              = [];
  let current                    ;
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

function listBranches(gitDir        , commonDir        )           {
  const names = new Set        ();
  const headsDir = path.join(commonDir, 'refs', 'heads');
  const walk = (dir        , prefix        , depth        )       => {
    if (depth > 4 || names.size > 500) return;
    let entries             ;
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






export async function readGit(root        , opts            )                   {
  const info          = { isRepo: false, remotes: [], branches: [], recentSubjects: [] };
  const gitDir = findGitDir(root);
  if (!gitDir) return info;
  info.isRepo = true;
  // Worktrees keep shared refs and config in the common dir.
  let commonDir = gitDir;
  const common = readText(path.join(gitDir, 'commondir'), 4096);
  if (common && isNetworkPath(common)) return { ...info, isRepo: false };
  if (common) commonDir = path.resolve(gitDir, common.trim());
  if (isNetworkPath(commonDir)) return { ...info, isRepo: false };

  const head = readText(path.join(gitDir, 'HEAD'), 4096) ?? '';
  const m = /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
  if (m && m[1]) info.branch = m[1].trim();

  const configText = readText(path.join(commonDir, 'config'), 1024 * 1024) ?? '';
  info.remotes = parseRemotes(configText);
  info.branches = listBranches(gitDir, commonDir);

  // git would follow config includes and object alternates wherever they point, network shares
  // included: such repositories get no history rather than a connection to someone's server.
  const alternates = readText(path.join(commonDir, 'objects', 'info', 'alternates'), 64 * 1024) ?? '';
  const risky = /\[\s*include/i.test(configText) || alternates.trim() !== '' || fs.existsSync(path.join(gitDir, 'config.worktree')) || fs.existsSync(path.join(commonDir, 'config.worktree'));
  if (opts.history && !risky) {
    const git = which('git');
    if (git) {
      // The scanned repository's .git/config is untrusted: switch off everything in it that could
      // run a program (signature checks via gpg.program, fsmonitor hooks, pagers, textconv), and
      // forbid any fetch: in a partial clone `git log` would otherwise fetch a missing commit
      // lazily and run the repository's core.sshCommand. Per-protocol settings beat
      // protocol.allow, so each one is set; GIT_ALLOW_PROTOCOL and GIT_NO_LAZY_FETCH back it up.
      // safe.bareRepository=explicit: a bare repository planted in a subfolder is not used. (No
      // --git-dir: passing it would skip git's safe.directory ownership check.)
      const noFetch = ['ssh', 'git', 'http', 'https', 'file', 'ext'].flatMap((p) => ['-c', `protocol.${p}.allow=never`]);
      const res = await run(
        git,
        [
          '--no-pager',
          '-c', 'safe.bareRepository=explicit',
          '-c', 'protocol.allow=never',
          ...noFetch,
          '-c', 'core.sshCommand=false',
          '-c', 'core.quotepath=off',
          '-c', 'log.showSignature=false',
          '-c', 'core.fsmonitor=false',
          '-c', 'core.untrackedCache=false',
          '-c', 'gpg.program=false',
          '-c', 'gpg.ssh.program=false',
          '-c', 'gpg.x509.program=false',
          '-c', 'diff.external=',
          'log', '--no-mailmap', '-n', '200', '--no-merges', '--no-show-signature', '--no-textconv', '--no-ext-diff', '--no-color', '--format=%s',
        ],
        {
          cwd: root,
          timeoutMs: 2500,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            GIT_OPTIONAL_LOCKS: '0',
            GIT_PAGER: 'cat',
            PAGER: 'cat',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_NO_LAZY_FETCH: '1',
            // Only this made-up protocol is allowed, so none of the real ones are.
            GIT_ALLOW_PROTOCOL: 'stackhint-none',
            GIT_SSH_COMMAND: 'false',
          },
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
