import os from 'node:os';
import path from 'node:path';





export function homeDir(env      = process.env)         {
  // Tests and sandboxes can point HOME/USERPROFILE elsewhere; os.homedir() honours both.
  return env['STACKHINT_TEST_HOME'] ?? os.homedir();
}

/** Where stackhint keeps its own config, state, backups and audit log. */
export function stackhintHome(env      = process.env)         {
  return env['STACKHINT_HOME'] ?? path.join(homeDir(env), '.stackhint');
}

/** Claude Code's config directory (~/.claude or $CLAUDE_CONFIG_DIR). */
export function claudeConfigDir(env      = process.env)         {
  return env['CLAUDE_CONFIG_DIR'] ?? path.join(homeDir(env), '.claude');
}

/** Claude Code's main state file. With CLAUDE_CONFIG_DIR set it lives inside that directory. */
export function claudeStateFile(env      = process.env)         {
  const dir = env['CLAUDE_CONFIG_DIR'];
  return dir ? path.join(dir, '.claude.json') : path.join(homeDir(env), '.claude.json');
}

export function codexHome(env      = process.env)         {
  return env['CODEX_HOME'] ?? path.join(homeDir(env), '.codex');
}

/** Normalize a path for comparisons: forward slashes, no trailing slash, case-folded on Windows. */
export function comparablePath(p        , platform                  = process.platform)         {
  let s = p.replace(/\\/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  if (platform === 'win32' || /^[A-Za-z]:\//.test(s)) s = s.toLowerCase();
  return s;
}

export function samePath(a        , b        , platform                  = process.platform)          {
  return comparablePath(a, platform) === comparablePath(b, platform);
}

/** Shorten paths under the home directory to ~ for display. */
export function displayPath(p        , env      = process.env)         {
  const home = homeDir(env);
  if (home && comparablePath(p).startsWith(comparablePath(home) + '/')) {
    return '~' + p.slice(home.length).replace(/\\/g, '/');
  }
  if (home && samePath(p, home)) return '~';
  return p;
}

/** Project-relative path with forward slashes, for evidence. */
export function relPath(root        , p        )         {
  const r = path.relative(root, p).replace(/\\/g, '/');
  return r || '.';
}

export function platformName(platform                  = process.platform)                                {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'linux';
}
