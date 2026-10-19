import path from 'node:path';
import type { ConfigFileState, ConfiguredServer, InstalledPlugin, InstalledSkill } from '../types.ts';
import { exists, readJson } from '../util/fsx.ts';
import { claudeConfigDir, claudeStateFile, comparablePath, homeDir, type Env } from '../util/paths.ts';
import { listCommands, listSkills, newestSubdir, normalizeServer, pluginServers } from './common.ts';

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function claudeManagedMcpPath(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env['STACKHINT_CLAUDE_MANAGED_DIR']) return path.join(env['STACKHINT_CLAUDE_MANAGED_DIR'], 'managed-mcp.json');
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-mcp.json';
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-mcp.json';
  return '/etc/claude-code/managed-mcp.json';
}

export interface ClaudeInventory {
  detected: boolean;
  servers: ConfiguredServer[];
  plugins: InstalledPlugin[];
  skills: InstalledSkill[];
  files: ConfigFileState[];
  managedMcp?: string;
  warnings: string[];
}

export function readClaudeInventory(projectRoot: string, env: Env = process.env, platform: NodeJS.Platform = process.platform): ClaudeInventory {
  const configDir = claudeConfigDir(env);
  const stateFile = claudeStateFile(env);
  const files: ConfigFileState[] = [];
  const servers: ConfiguredServer[] = [];
  const plugins: InstalledPlugin[] = [];
  const skills: InstalledSkill[] = [];
  const warnings: string[] = [];
  const root = comparablePath(projectRoot, platform);

  const note = (kind: string, p: string, res: { ok: boolean; error?: string; missing?: boolean }): void => {
    files.push({ host: 'claude', kind, path: p, exists: res.ok || res.missing === false, ...(res.ok || res.missing ? {} : { error: res.error ?? 'unreadable' }) });
  };

  // ~/.claude.json: user-scope servers at top level, local-scope servers per project.
  const state = readJson<Obj>(stateFile, 64 * 1024 * 1024);
  note('state (~/.claude.json)', stateFile, state.ok ? { ok: true } : state);
  let projectEntry: Obj | undefined;
  if (state.ok && isObj(state.value)) {
    const top = state.value['mcpServers'];
    if (isObj(top)) {
      for (const [name, def] of Object.entries(top)) {
        const s = normalizeServer('claude', name, def, 'user', stateFile);
        if (s) servers.push(s);
      }
    }
    const projects = state.value['projects'];
    if (isObj(projects)) {
      for (const [key, value] of Object.entries(projects)) {
        if (comparablePath(key, platform) !== root || !isObj(value)) continue;
        projectEntry = value;
        const m = value['mcpServers'];
        if (isObj(m)) {
          for (const [name, def] of Object.entries(m)) {
            const s = normalizeServer('claude', name, def, 'local', `${stateFile} (projects["${key}"])`);
            if (s) servers.push(s);
          }
        }
      }
    }
  }

  // Settings files: approvals for .mcp.json servers and enabled plugins.
  const settingsFiles: Array<[string, string]> = [
    ['user settings', path.join(configDir, 'settings.json')],
    ['project settings', path.join(projectRoot, '.claude', 'settings.json')],
    ['local settings', path.join(projectRoot, '.claude', 'settings.local.json')],
  ];
  const enabledPlugins = new Map<string, { enabled: boolean; scope: InstalledPlugin['scope']; source: string }>();
  const disabledMcpjson = new Set<string>();
  const enabledMcpjson = new Set<string>();
  let enableAll = false;
  for (const [kind, p] of settingsFiles) {
    const res = readJson<Obj>(p);
    note(kind, p, res.ok ? { ok: true } : res);
    if (!res.ok || !isObj(res.value)) continue;
    const scope: InstalledPlugin['scope'] = kind.startsWith('user') ? 'user' : kind.startsWith('project') ? 'project' : 'local';
    const ep = res.value['enabledPlugins'];
    if (isObj(ep)) for (const [id, v] of Object.entries(ep)) enabledPlugins.set(id, { enabled: v === true, scope, source: p });
    if (Array.isArray(res.value['disabledMcpjsonServers'])) for (const n of res.value['disabledMcpjsonServers']) if (typeof n === 'string') disabledMcpjson.add(n);
    if (Array.isArray(res.value['enabledMcpjsonServers'])) for (const n of res.value['enabledMcpjsonServers']) if (typeof n === 'string') enabledMcpjson.add(n);
    if (res.value['enableAllProjectMcpServers'] === true) enableAll = true;
  }
  if (projectEntry) {
    if (Array.isArray(projectEntry['disabledMcpjsonServers'])) for (const n of projectEntry['disabledMcpjsonServers']) if (typeof n === 'string') disabledMcpjson.add(n);
    if (Array.isArray(projectEntry['enabledMcpjsonServers'])) for (const n of projectEntry['enabledMcpjsonServers']) if (typeof n === 'string') enabledMcpjson.add(n);
  }

  // Project .mcp.json
  const mcpJson = path.join(projectRoot, '.mcp.json');
  const pj = readJson<Obj>(mcpJson);
  note('project .mcp.json', mcpJson, pj.ok ? { ok: true } : pj);
  if (pj.ok && isObj(pj.value) && isObj(pj.value['mcpServers'])) {
    for (const [name, def] of Object.entries(pj.value['mcpServers'] as Obj)) {
      const s = normalizeServer('claude', name, def, 'project', mcpJson);
      if (!s) continue;
      if (disabledMcpjson.has(name)) s.enabled = false;
      servers.push(s);
    }
  } else if (pj.ok) {
    warnings.push('.mcp.json has no "mcpServers" object');
  }
  void enableAll;
  void enabledMcpjson;

  // Managed (admin) MCP config takes exclusive control when present.
  const managed = claudeManagedMcpPath(env, platform);
  const mm = readJson<Obj>(managed);
  let managedMcp: string | undefined;
  if (mm.ok || !mm.missing) {
    managedMcp = managed;
    note('managed-mcp.json', managed, mm.ok ? { ok: true } : mm);
    if (mm.ok && isObj(mm.value) && isObj(mm.value['mcpServers'])) {
      for (const [name, def] of Object.entries(mm.value['mcpServers'] as Obj)) {
        const s = normalizeServer('claude', name, def, 'managed', managed);
        if (s) servers.push(s);
      }
    }
  }

  // Plugins and the MCP servers they bundle.
  const pluginsDir = env['CLAUDE_CODE_PLUGIN_CACHE_DIR'] ?? path.join(configDir, 'plugins');
  const installed = readJson<unknown>(path.join(pluginsDir, 'installed_plugins.json'));
  const installPaths = installed.ok ? collectInstallPaths(installed.value) : new Map<string, string>();
  const marketplaces = readJson<Obj>(path.join(pluginsDir, 'known_marketplaces.json'));
  for (const [id, info] of enabledPlugins) {
    plugins.push({ host: 'claude', id, scope: info.scope, enabled: info.enabled, source: info.source });
    if (!info.enabled) continue;
    const dir = locatePluginDir(id, pluginsDir, installPaths, marketplaces.ok ? marketplaces.value : undefined);
    if (dir) servers.push(...pluginServers('claude', dir, id, 'plugin'));
  }
  // Plugins installed but not listed in any settings file.
  for (const id of installPaths.keys()) {
    if (!enabledPlugins.has(id)) plugins.push({ host: 'claude', id, scope: 'user', enabled: false, source: path.join(pluginsDir, 'installed_plugins.json') });
  }

  // Skills and legacy commands.
  skills.push(...listSkills('claude', path.join(configDir, 'skills'), 'user'));
  skills.push(...listSkills('claude', path.join(projectRoot, '.claude', 'skills'), 'project'));
  skills.push(...listCommands('claude', path.join(configDir, 'commands'), 'user'));
  skills.push(...listCommands('claude', path.join(projectRoot, '.claude', 'commands'), 'project'));

  const detected = exists(configDir) || exists(stateFile);
  void homeDir;
  return { detected, servers, plugins, skills, files, ...(managedMcp ? { managedMcp } : {}), warnings };
}

/** installed_plugins.json is not a documented API; find "installPath" values defensively. */
function collectInstallPaths(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (v: unknown, key: string | undefined, depth: number): void => {
    if (depth > 6) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, key, depth + 1);
      return;
    }
    if (!isObj(v)) return;
    if (typeof v['installPath'] === 'string' && key && key.includes('@')) {
      if (!out.has(key)) out.set(key, v['installPath']);
      return;
    }
    for (const [k, x] of Object.entries(v)) walk(x, k.includes('@') ? k : key, depth + 1);
  };
  walk(value, undefined, 0);
  return out;
}

function locatePluginDir(id: string, pluginsDir: string, installPaths: Map<string, string>, marketplaces: Obj | undefined): string | undefined {
  const known = installPaths.get(id);
  if (known && exists(known)) return known;
  const at = id.lastIndexOf('@');
  if (at <= 0) return undefined;
  const plugin = id.slice(0, at);
  const market = id.slice(at + 1);
  if (/[\\/]|\.\./.test(plugin) || /[\\/]|\.\./.test(market)) return undefined;
  const cached = newestSubdir(path.join(pluginsDir, 'cache', market, plugin));
  if (cached) return cached;
  // Relative-path plugins inside a cloned marketplace.
  const mk = marketplaces && isObj(marketplaces[market]) ? (marketplaces[market] as Obj) : undefined;
  const location = mk && typeof mk['installLocation'] === 'string' ? (mk['installLocation'] as string) : path.join(pluginsDir, 'marketplaces', market);
  const manifest = readJson<Obj>(path.join(location, '.claude-plugin', 'marketplace.json'));
  if (!manifest.ok || !Array.isArray(manifest.value['plugins'])) return undefined;
  const entry = (manifest.value['plugins'] as unknown[]).find((p) => isObj(p) && p['name'] === plugin) as Obj | undefined;
  const src = entry ? entry['source'] : undefined;
  if (typeof src === 'string' && src.startsWith('./') && !src.includes('..')) return path.join(location, src);
  return undefined;
}
