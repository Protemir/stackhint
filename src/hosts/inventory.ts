import type { Availability, ConfiguredServer, HostId, InstalledPlugin, Inventory, RegistryEntry } from '../types.ts';
import { HOST_IDS } from '../types.ts';
import { which } from '../util/exec.ts';
import type { Env } from '../util/paths.ts';
import { readClaudeInventory } from './claude.ts';
import { readCodexInventory } from './codex.ts';

export const WATCHED_EXECUTABLES = [
  'claude', 'codex', 'git', 'gh', 'glab', 'az', 'aws', 'gcloud', 'kubectl', 'helm', 'docker', 'psql', 'node', 'npx',
  'uvx', 'uv', 'dnx', 'dotnet', 'semgrep', 'snyk', 'flux-operator-mcp', 'csharp-ls', 'typescript-language-server',
  'pyright-langserver', 'gopls',
];

export interface InventoryOptions {
  env?: Env;
  platform?: NodeJS.Platform;
  /** Override PATH lookups (tests). */
  which?: (name: string) => string | undefined;
}

export function readInventory(projectRoot: string, opts: InventoryOptions = {}): Inventory {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const find = opts.which ?? ((n: string) => which(n, env, platform));
  const claude = readClaudeInventory(projectRoot, env, platform);
  const codex = readCodexInventory(projectRoot, env, platform);
  const executables: Record<string, string> = {};
  for (const name of WATCHED_EXECUTABLES) {
    const p = find(name);
    if (p) executables[name] = p;
  }
  const hostCli: Partial<Record<HostId, string>> = {};
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
export function serverMatchScore(entry: RegistryEntry, s: ConfiguredServer): number {
  let best = 0;
  const url = (s.url ?? '').toLowerCase();
  const cmd = [s.command ?? '', ...s.args].join(' ').toLowerCase();
  for (const u of entry.match.urls ?? []) if (url && url.includes(u.toLowerCase())) best = Math.max(best, 100 + u.length);
  for (const p of entry.match.packages ?? []) if (cmd && cmd.includes(p.toLowerCase())) best = Math.max(best, 100 + p.length);
  if (s.viaPlugin && (entry.match.plugins ?? []).some((p) => samePlugin(p, s.viaPlugin as string))) best = Math.max(best, 100);
  if (best === 0 && (entry.match.names ?? []).some((n) => n.toLowerCase() === s.name.toLowerCase())) best = 10;
  return best;
}

export function samePlugin(pattern: string, id: string): boolean {
  const a = pattern.toLowerCase();
  const b = id.toLowerCase();
  if (a === b) return true;
  // A bare plugin name matches it from any marketplace.
  return !a.includes('@') && b.split('@')[0] === a;
}

/** The single best registry entry for each configured server (most specific match wins). */
export function primaryEntryFor(entries: RegistryEntry[], s: ConfiguredServer): { entry: RegistryEntry; score: number } | undefined {
  let best: { entry: RegistryEntry; score: number } | undefined;
  for (const e of entries) {
    const score = serverMatchScore(e, s);
    if (score > 0 && (!best || score > best.score)) best = { entry: e, score };
  }
  return best;
}

export function availabilityFor(entry: RegistryEntry, inv: Inventory, host: HostId, entries?: RegistryEntry[]): Availability {
  const support = entry.hosts[host].support;
  const empty: Availability = { state: 'not-configured', detail: '', servers: [], plugins: [], skills: [], executables: [] };
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
  const plugins: InstalledPlugin[] = inv.plugins.filter((p) => p.host === host && (entry.match.plugins ?? []).some((m) => samePlugin(m, p.id)));
  const skills = inv.skills.filter((k) => k.host === host && (entry.match.skills ?? []).some((m) => m.toLowerCase() === k.name.toLowerCase()));
  const executables = (entry.match.executables ?? []).filter((x) => inv.executables[x]);

  const enabledServers = servers.filter((s) => s.enabled);
  const strong = enabledServers.filter((s) => serverMatchScore(entry, s) >= 100);
  if (strong.length > 0) {
    const s = strong[0] as ConfiguredServer;
    const where = s.viaPlugin ? `via plugin ${s.viaPlugin}` : `${s.scope} scope`;
    const note = s.pendingApproval ? 'waiting for your approval in Claude Code' : 'not verified as running';
    return { state: 'configured', detail: `configured as "${s.name}" (${where}); ${note}`, servers, plugins, skills, executables };
  }
  const enabledPlugin = plugins.find((p) => p.enabled);
  if (enabledPlugin) return { state: 'configured', detail: `plugin ${enabledPlugin.id} is enabled`, servers, plugins, skills, executables };
  if (skills.length > 0) return { state: 'configured', detail: `skill "${(skills[0] as { name: string }).name}" is installed`, servers, plugins, skills, executables };
  if (enabledServers.length > 0) {
    const s = enabledServers[0] as ConfiguredServer;
    return { state: 'configured', detail: `a server named "${s.name}" is configured (${s.scope}); probably this one, not verified`, servers, plugins, skills, executables };
  }
  if (entry.kind === 'cli' && executables.length > 0) {
    return { state: 'configured', detail: `${executables.join(', ')} found on PATH`, servers, plugins, skills, executables };
  }
  if (servers.length > 0 || plugins.length > 0) {
    return { state: 'disabled', detail: 'installed but disabled or not approved', servers, plugins, skills, executables };
  }
  const unreadable = inv.files.find((f) => f.host === host && f.error);
  if (unreadable) {
    return { ...empty, state: 'unknown', detail: `could not read ${unreadable.kind}: ${unreadable.error ?? ''}`, executables };
  }
  if (support === 'unknown') return { ...empty, state: 'unknown', detail: `compatibility with ${hostLabel(host)} is not verified`, executables };
  return { ...empty, state: 'not-configured', detail: 'not configured', executables };
}

export function hostLabel(h: HostId): string {
  return h === 'claude' ? 'Claude Code' : 'Codex';
}

export function hostsToConsider(inv: Inventory, requested?: HostId | 'all'): HostId[] {
  if (requested && requested !== 'all') return [requested];
  const detected = HOST_IDS.filter((h) => inv.hostsDetected[h]);
  return detected.length > 0 ? detected : [...HOST_IDS];
}
