
import { HOST_IDS } from '../types.js';
import { CONTAINER_CLIS, imageIndex } from '../util/docker.js';
import { whichMany } from '../util/exec.js';

import { safeName } from '../util/text.js';
import { readClaudeInventory } from './claude.js';
import { readCodexInventory } from './codex.js';

export const WATCHED_EXECUTABLES = [
  'claude', 'codex', 'git', 'gh', 'glab', 'az', 'aws', 'gcloud', 'kubectl', 'helm', 'docker', 'psql', 'node', 'npx',
  'uvx', 'uv', 'dnx', 'dotnet', 'semgrep', 'snyk', 'flux-operator-mcp', 'csharp-ls', 'typescript-language-server',
  'pyright-langserver', 'gopls', 'heroku', 'fly', 'dart', 'xcrun',
];








export function readInventory(projectRoot        , opts                   = {})            {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const claude = readClaudeInventory(projectRoot, env, platform);
  const codex = readCodexInventory(projectRoot, env, platform);
  let executables                         = {};
  if (opts.which) {
    for (const name of WATCHED_EXECUTABLES) {
      const p = opts.which(name);
      if (p) executables[name] = p;
    }
  } else executables = whichMany(WATCHED_EXECUTABLES, env, platform);
  const hostCli                                  = {};
  if (executables['claude']) hostCli.claude = executables['claude'];
  if (executables['codex']) hostCli.codex = executables['codex'];
  return {
    servers: [...claude.servers, ...codex.servers],
    plugins: [...claude.plugins, ...codex.plugins],
    skills: [...claude.skills, ...codex.skills],
    executables,
    files: [...claude.files, ...codex.files],
    hostsDetected: { claude: claude.detected || Boolean(hostCli.claude), codex: codex.detected || Boolean(hostCli.codex) },
    hostCli,
    ...(claude.managedMcp ? { managedMcp: claude.managedMcp } : {}),
    warnings: [...claude.warnings, ...codex.warnings],
  };
}

/** How strongly a configured server matches an entry: 0 = no, 10 = same name only, 100+ = URL/package/plugin. */
export function serverMatchScore(entry               , s                  )         {
  let best = 0;
  const launched = launchedProgram(s.command, s.args);
  // URLs count in a remote server's url, and in the arguments only of known stdio bridges
  // (npx mcp-remote https://mcp.sentry.dev/mcp); any other program may take any URL as input.
  const bridge = BRIDGES.has(stripVersion(launched[0] ?? '')) ? launched.slice(1).join(' ') : '';
  for (const u of entry.match.urls ?? []) if (urlPatternIn(s.url ?? '', u) || urlPatternIn(bridge, u)) best = Math.max(best, 100 + u.length);
  for (const p of entry.match.packages ?? []) if (packageIn(s.command, s.args, p)) best = Math.max(best, 100 + p.length);
  if (s.viaPlugin && (entry.match.plugins ?? []).some((p) => samePlugin(p, s.viaPlugin          ))) best = Math.max(best, 100);
  if (best === 0 && (entry.match.names ?? []).some((n) => n.toLowerCase() === s.name.toLowerCase())) best = 10;
  return best;
}

/** Stdio-to-HTTP bridges whose URL argument is the server they stand for. */
const BRIDGES = new Set(['mcp-remote', 'supergateway', 'mcp-proxy']);

/**
 * A registry URL pattern in the URLs found in text. Every URL is parsed: "mcp.sentry.dev" must be
 * the whole host (not "docs.mcp.sentry.dev", "mcp.sentry.dev.evil.example" or a path segment),
 * a pattern starting with "." is a host suffix, one starting with "/" a path on any host, and a
 * path after the host must match whole segments.
 */
export function urlPatternIn(text        , pattern        )          {
  let p = pattern.toLowerCase();
  if (!text || !p) return false;
  // A path on any host (self-hosted products): also in values without a scheme,
  // such as an env-var placeholder followed by /mcp-server/mcp.
  if (p.startsWith('/') && !p.startsWith('//')) return text.toLowerCase().includes(p);
  if (p.startsWith('//')) p = p.slice(2);
  const slash = p.indexOf('/');
  const hostPart = slash < 0 ? p : p.slice(0, slash);
  const pathPart = slash < 0 ? '' : p.slice(slash);
  for (const raw of text.match(/[a-z][a-z0-9+.-]{0,20}:\/\/[^\s"'<>]{1,2000}/gi) ?? []) {
    let u     ;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    const pathname = u.pathname.toLowerCase();
    let hostOk         ;
    if (/^\d+$/.test(hostPart)) hostOk = (u.port || (u.protocol === 'https:' ? '443' : '80')) === hostPart; // a local port, e.g. 6006/mcp
    else if (hostPart.startsWith('.')) hostOk = u.hostname.toLowerCase().endsWith(hostPart);
    else if (hostPart.includes(':')) hostOk = u.host.toLowerCase() === hostPart;
    else hostOk = u.hostname.toLowerCase() === hostPart;
    if (!hostOk) continue;
    if (!pathPart || (pathname.startsWith(pathPart) && /^(\/|$)/.test(pathname.slice(pathPart.length)))) return true;
  }
  return false;
}

/** "@playwright/mcp@0.0.83" -> "@playwright/mcp", "pkg==1.2" -> "pkg" (a scope's @ stays). */
function stripVersion(t        )         {
  return t.replace(/==.*$/, '').replace(/(.)@[^/@]*$/, '$1');
}

const NPX_LIKE = /^(npx|bunx|pnpx|dnx|uvx)$/;
/** Launcher flags that take a value (the value is not the package). */
const VALUE_FLAGS = new Set(['--from', '--python', '-c', '--call', '--cache', '--registry', '--with', '--index-url', '--extra-index-url', '--source', '--version']);

/**
 * The words that start with the program a server runs: the package after npx/uvx/dnx (or
 * -p/--package), the image after docker run, the script after node, otherwise the command itself.
 * A cmd /c wrapper is skipped. The first word is lowercased, without folders or a Windows extension.
 */
export function launchedProgram(command                    , args                   )           {
  const cmd = (command ?? '').trim();
  // A whole command line in command ("npx -y pkg"), unless it is a path with spaces in it.
  const firstSpace = cmd.search(/\s/);
  const head = firstSpace > 0 && !/[\\/]/.test(cmd.slice(0, firstSpace)) ? cmd.split(/\s+/) : cmd ? [cmd] : [];
  let words = [...head, ...args].map((w) => w.trim()).filter(Boolean);
  const base = (w                    )         => (w ?? '').replace(/\\/g, '/').replace(/^.*\//, '').toLowerCase().replace(/\.(exe|cmd|bat|ps1|com)$/, '');
  if (base(words[0]) === 'cmd' && /^\/[ck]$/i.test(words[1] ?? '')) words = words.slice(2);
  const b = base(words[0]);
  const scan = (from        )           => {
    for (let i = from; i < words.length; i++) {
      const w = words[i]          ;
      if (w === '-p' || w === '--package') return words.slice(i + 1);
      if (/^(--package|-p)=/.test(w)) return [w.replace(/^(--package|-p)=/, ''), ...words.slice(i + 1)];
      if (VALUE_FLAGS.has(w)) {
        i++;
        continue;
      }
      if (w.startsWith('-')) continue;
      return words.slice(i);
    }
    return [];
  };
  let out          ;
  if (NPX_LIKE.test(b)) out = scan(1);
  else if ((b === 'pnpm' || b === 'yarn') && /^(dlx|exec)$/.test(words[1] ?? '')) out = scan(2);
  else if (b === 'pipx' && words[1] === 'run') out = scan(2);
  else if (b === 'uv' && words[1] === 'tool' && words[2] === 'run') out = scan(3);
  else if (b === 'uv' && words[1] === 'run') out = scan(2); // uv run --with pkg==1.0 --python 3.12 program
  else if (b === 'xcrun') out = scan(1); // xcrun mcpbridge
  else if (b === 'php' && words[1] === 'artisan') out = words.slice(2);
  else if (b === 'dotnet' && words[1] === 'run') {
    // dotnet run --project .../MssqlMcp/MssqlMcp.csproj: the project is the program.
    const at = words.indexOf('--project');
    const project = at >= 0 ? words[at + 1] : undefined;
    return project ? [project.toLowerCase().replace(/\\/g, '/')] : [];
  }
  else if (CONTAINER_CLIS.test(b) && words[1] === 'run') {
    const at = imageIndex(words.slice(1));
    out = at >= 0 ? words.slice(at + 1) : [];
    if (out[0]) out[0] = out[0].toLowerCase().replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, '');
    return out.map((w) => w.toLowerCase());
  } else if (/^(node|nodejs|bun|deno)$/.test(b)) {
    out = scan(1);
    return out.map((w) => w.toLowerCase().replace(/\\/g, '/'));
  } else out = [b, ...words.slice(1)];
  return out.map((w, i) => (i === 0 ? w.toLowerCase().replace(/\\/g, '/').replace(/^.*\/(?=[^/]+$)/, (m) => (w.startsWith('@') ? m : '')).replace(/\.(exe|cmd|bat|ps1|com)$/, '') : w.toLowerCase()));
}

/**
 * A registry package pattern for the program a server launches (see launchedProgram): the
 * package, image or binary itself with an optional @version, :tag or ==version, a script inside
 * node_modules/<package>/, or several words in a row ("heroku mcp:start"). Arguments to some other
 * program never count, so "npx evil-pkg @playwright/mcp" is not Playwright.
 */
export function packageIn(command                    , args                   , pattern        )          {
  const p = pattern.toLowerCase();
  if (!p) return false;
  const launched = launchedProgram(command, args);
  const first = launched[0] ?? '';
  if (!first) return false;
  if (p.includes(' ')) return (' ' + [stripVersion(first), ...launched.slice(1)].join(' ') + ' ').includes(' ' + p + ' ');
  if (p.endsWith('@')) return first.startsWith(p);
  if (first === p || stripVersion(first) === p || first.startsWith(p + ':')) return true;
  // node .../node_modules/@playwright/mcp/cli.js
  if (first.includes('/node_modules/' + p + '/')) return true;
  // dotnet run --project .../MssqlMcp/MssqlMcp.csproj
  return /\.(cs|fs|vb)proj$/.test(first) && first.split('/').includes(p);
}

export function samePlugin(pattern        , id        )          {
  const a = pattern.toLowerCase();
  const b = id.toLowerCase();
  if (a === b) return true;
  // A bare plugin name matches it from any marketplace.
  return !a.includes('@') && b.split('@')[0] === a;
}

/** The single best registry entry for each configured server (most specific match wins). */
export function primaryEntryFor(entries                 , s                  )                                                      {
  let best                                                     ;
  for (const e of entries) {
    const score = serverMatchScore(e, s);
    // On a tie a server belongs to the MCP entry, not to a plugin that bundles the same server.
    const better = !best || score > best.score || (score === best.score && e.kind === 'mcp' && best.entry.kind !== 'mcp');
    if (score > 0 && better) best = { entry: e, score };
  }
  return best;
}

export function availabilityFor(entry               , inv           , host        , entries                  )               {
  const support = entry.hosts[host].support;
  const empty               = { state: 'not-configured', detail: '', servers: [], plugins: [], skills: [], executables: [] };
  if (support === 'no') return { ...empty, state: 'incompatible', detail: entry.hosts[host].notes ?? `not available for ${hostLabel(host)}` };

  const servers = inv.servers.filter((s) => {
    if (s.host !== host) return false;
    const score = serverMatchScore(entry, s);
    if (score === 0) return false;
    // If another entry matches this server more specifically, it is not ours (e.g. a legacy package).
    if (entries) {
      const primary = primaryEntryFor(entries, s);
      if (primary && primary.entry.id !== entry.id && primary.score > score) return false;
    }
    return true;
  });
  const plugins                    = inv.plugins.filter((p) => p.host === host && (entry.match.plugins ?? []).some((m) => samePlugin(m, p.id)));
  // "Write a project skill" is done once the project has skills of its own.
  const projectSkills = entry.provides.includes('skill:custom') ? inv.skills.filter((k) => k.host === host && k.scope === 'project') : [];
  const skills = [...projectSkills, ...inv.skills.filter((k) => k.host === host && (entry.match.skills ?? []).some((m) => m.toLowerCase() === k.name.toLowerCase()))];
  const executables = (entry.match.executables ?? []).filter((x) => inv.executables[x]);

  const enabledServers = servers.filter((s) => s.enabled);
  const strong = enabledServers.filter((s) => serverMatchScore(entry, s) >= 100);
  if (strong.length > 0) {
    const s = strong[0]                    ;
    const where = s.viaPlugin ? `via plugin ${s.viaPlugin}` : `${s.scope} scope`;
    const note = s.pendingApproval ? 'waiting for your approval in Claude Code' : 'not verified as running';
    return { state: 'configured', detail: `configured as "${safeName(s.name, 40)}" (${where}); ${note}`, servers, plugins, skills, executables };
  }
  const enabledPlugin = plugins.find((p) => p.enabled);
  if (enabledPlugin) return { state: 'configured', detail: `plugin ${safeName(enabledPlugin.id, 60)} is enabled`, servers, plugins, skills, executables };
  if (projectSkills.length > 0) return { state: 'configured', detail: `the project already has skills: ${[...new Set(projectSkills.map((k) => safeName(k.name, 40)))].slice(0, 3).join(', ')}`, servers, plugins, skills, executables };
  if (skills.length > 0) return { state: 'configured', detail: `skill "${safeName((skills[0]                    ).name, 40)}" is installed`, servers, plugins, skills, executables };
  if (enabledServers.length > 0) {
    const s = enabledServers[0]                    ;
    return { state: 'configured', detail: `a server named "${safeName(s.name, 40)}" is configured (${s.scope}); probably this one, not verified`, servers, plugins, skills, executables };
  }
  if (entry.kind === 'cli' && executables.length > 0) {
    return { state: 'configured', detail: `${executables.join(', ')} found on PATH`, servers, plugins, skills, executables };
  }
  if (servers.length > 0 || plugins.length > 0) {
    const why = servers.find((s) => s.inactiveReason)?.inactiveReason;
    return { state: 'disabled', detail: why ? `in the config, but not active: ${why}` : 'installed but disabled or not approved', servers, plugins, skills, executables };
  }
  const unreadable = inv.files.find((f) => f.host === host && f.error);
  if (unreadable) {
    return { ...empty, state: 'unknown', detail: `could not read ${unreadable.kind}: ${unreadable.error ?? ''}`, executables };
  }
  if (support === 'unknown') return { ...empty, state: 'unknown', detail: `compatibility with ${hostLabel(host)} is not verified`, executables };
  return { ...empty, state: 'not-configured', detail: 'not configured', executables };
}

export function hostLabel(h        )         {
  return h === 'claude' ? 'Claude Code' : 'Codex';
}

export function hostsToConsider(inv           , requested                 )           {
  if (requested && requested !== 'all') return [requested];
  const detected = HOST_IDS.filter((h) => inv.hostsDetected[h]);
  return detected.length > 0 ? detected : [...HOST_IDS];
}
