import os from 'node:os';
import path from 'node:path';

export interface Env {
  [key: string]: string | undefined;
}

export function homeDir(env: Env = process.env): string {
  // Tests and sandboxes can point HOME/USERPROFILE elsewhere; os.homedir() honours both.
  return env['STACKHINT_TEST_HOME'] ?? os.homedir();
}

/** Where stackhint keeps its own config, state, backups and audit log. */
export function stackhintHome(env: Env = process.env): string {
  return env['STACKHINT_HOME'] ?? path.join(homeDir(env), '.stackhint');
}

/** Claude Code's config directory (~/.claude or $CLAUDE_CONFIG_DIR). */
export function claudeConfigDir(env: Env = process.env): string {
  return env['CLAUDE_CONFIG_DIR'] ?? path.join(homeDir(env), '.claude');
}

/** Claude Code's main state file. With CLAUDE_CONFIG_DIR set it lives inside that directory. */
export function claudeStateFile(env: Env = process.env): string {
  const dir = env['CLAUDE_CONFIG_DIR'];
  return dir ? path.join(dir, '.claude.json') : path.join(homeDir(env), '.claude.json');
}

export function codexHome(env: Env = process.env): string {
  return env['CODEX_HOME'] ?? path.join(homeDir(env), '.codex');
}

/** Normalize a path for comparisons: forward slashes, no trailing slash, case-folded on Windows. */
export function comparablePath(p: string, platform: NodeJS.Platform = process.platform): string {
  let s = p.replace(/\\/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  if (platform === 'win32' || /^[A-Za-z]:\//.test(s)) s = s.toLowerCase();
  return s;
}

export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return comparablePath(a, platform) === comparablePath(b, platform);
}

/** Shorten paths under the home directory to ~ for display. */
export function displayPath(p: string, env: Env = process.env): string {
  const home = homeDir(env);
  if (home && comparablePath(p).startsWith(comparablePath(home) + '/')) {
    return '~' + p.slice(home.length).replace(/\\/g, '/');
  }
  if (home && samePath(p, home)) return '~';
  return p;
}

/** Project-relative path with forward slashes, for evidence. */
export function relPath(root: string, p: string): string {
  const r = path.relative(root, p).replace(/\\/g, '/');
  return r || '.';
}

export function platformName(platform: NodeJS.Platform = process.platform): 'windows' | 'macos' | 'linux' {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'linux';
}
