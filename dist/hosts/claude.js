import path from 'node:path';

import { exists, readJson } from '../util/fsx.js';
import { claudeConfigDir, claudeStateFile, comparablePath, homeDir,          } from '../util/paths.js';
import { listCommands, listSkills, newestSubdir, normalizeServer, pluginServers } from './common.js';



function isObj(v         )           {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function claudeManagedMcpPath(env      = process.env, platform                  = process.platform)         {
  if (env['STACKHINT_CLAUDE_MANAGED_DIR']) return path.join(env['STACKHINT_CLAUDE_MANAGED_DIR'], 'managed-mcp.json');
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-mcp.json';
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-mcp.json';
  return '/etc/claude-code/managed-mcp.json';
}











export function readClaudeInventory(projectRoot        , env      = process.env, platform                  = process.platform)                  {
  const configDir = claudeConfigDir(env);
  const stateFile = claudeStateFile(env);
  const files                    = [];
  const servers                     = [];
  const plugins                    = [];
  const skills                   = [];
  const warnings           = [];
  const root = comparablePath(projectRoot, platform);

  const note = (kind        , p        , res                                                    )       => {
    files.push({ host: 'claude', kind, path: p, exists: res.ok || res.missing === false, ...(res.ok || res.missing ? {} : { error: res.error ?? 'unreadable' }) });
  };

  // ~/.claude.json: user-scope servers at top level, local-scope servers per project.
  const state = readJson     (stateFile, 64 * 1024 * 1024);
  note('state (~/.claude.json)', stateFile, state.ok ? { ok: true } : state);
  let projectEntry                 ;
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
  const settingsFiles                          = [
    ['user settings', path.join(configDir, 'settings.json')],
    ['project settings', path.join(projectRoot, '.claude', 'settings.json')],
    ['local settings', path.join(projectRoot, '.claude', 'settings.local.json')],
  ];
  const enabledPlugins = new Map                                                                               ();
  const disabledMcpjson = new Set        ();
  const enabledMcpjson = new Set        ();
  let enableAll = false;
  for (const [kind, p] of settingsFiles) {
    const res = readJson     (p);
    note(kind, p, res.ok ? { ok: true } : res);
    if (!res.ok || !isObj(res.value)) continue;
    const scope                           = kind.startsWith('user') ? 'user' : kind.startsWith('project') ? 'project' : 'local';
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
  const pj = readJson     (mcpJson);
  note('project .mcp.json', mcpJson, pj.ok ? { ok: true } : pj);
  if (pj.ok && isObj(pj.value) && isObj(pj.value['mcpServers'])) {
    for (const [name, def] of Object.entries(pj.value['mcpServers']       )) {
      const s = normalizeServer('claude', name, def, 'project', mcpJson);
      if (!s) continue;
      if (disabledMcpjson.has(name)) s.enabled = false;
      // Claude Code asks each person to approve project servers before using them.
      else if (!enableAll && !enabledMcpjson.has(name)) s.pendingApproval = true;
      servers.push(s);
    }
  } else if (pj.ok) {
    warnings.push('.mcp.json has no "mcpServers" object');
  }

  // Managed (admin) MCP config takes exclusive control when present.
  const managed = claudeManagedMcpPath(env, platform);
  const mm = readJson     (managed);
  let managedMcp                    ;
  if (mm.ok || !mm.missing) {
    managedMcp = managed;
    note('managed-mcp.json', managed, mm.ok ? { ok: true } : mm);
    if (mm.ok && isObj(mm.value) && isObj(mm.value['mcpServers'])) {
      for (const [name, def] of Object.entries(mm.value['mcpServers']       )) {
        const s = normalizeServer('claude', name, def, 'managed', managed);
        if (s) servers.push(s);
      }
    }
  }

  // Plugins and the MCP servers they bundle.
  const pluginsDir = env['CLAUDE_CODE_PLUGIN_CACHE_DIR'] ?? path.join(configDir, 'plugins');
  const installed = readJson         (path.join(pluginsDir, 'installed_plugins.json'));
  const installPaths = installed.ok ? collectInstallPaths(installed.value) : new Map                ();
  const marketplaces = readJson     (path.join(pluginsDir, 'known_marketplaces.json'));
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
function collectInstallPaths(value         )                      {
  const out = new Map                ();
  const walk = (v         , key                    , depth        )       => {
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

function locatePluginDir(id        , pluginsDir        , installPaths                     , marketplaces                 )                     {
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
  const mk = marketplaces && isObj(marketplaces[market]) ? (marketplaces[market]       ) : undefined;
  const location = mk && typeof mk['installLocation'] === 'string' ? (mk['installLocation']          ) : path.join(pluginsDir, 'marketplaces', market);
  const manifest = readJson     (path.join(location, '.claude-plugin', 'marketplace.json'));
  if (!manifest.ok || !Array.isArray(manifest.value['plugins'])) return undefined;
  const entry = (manifest.value['plugins']             ).find((p) => isObj(p) && p['name'] === plugin)                   ;
  const src = entry ? entry['source'] : undefined;
  if (typeof src === 'string' && src.startsWith('./') && !src.includes('..')) return path.join(location, src);
  return undefined;
}
