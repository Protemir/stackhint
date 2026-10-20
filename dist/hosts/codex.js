import path from 'node:path';

import { exists, readText } from '../util/fsx.js';
import { codexHome, comparablePath, homeDir,          } from '../util/paths.js';
import { parseToml, TomlError } from '../util/toml.js';
import { listSkills, newestSubdir, normalizeServer, pluginServers } from './common.js';



function isObj(v         )           {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}













export function readToml(p        )           {
  if (!exists(p)) return { ok: false, missing: true, error: 'missing' };
  const text = readText(p, 4 * 1024 * 1024);
  if (text === undefined) return { ok: false, missing: false, error: 'unreadable or too large' };
  try {
    return { ok: true, value: parseToml(text), text };
  } catch (e) {
    return { ok: false, missing: false, error: e instanceof TomlError ? `invalid TOML: ${e.message}` : String(e) };
  }
}

export function codexUserConfigPath(env      = process.env)         {
  return path.join(codexHome(env), 'config.toml');
}

export function readCodexInventory(projectRoot        , env      = process.env, platform                  = process.platform)                 {
  const home = codexHome(env);
  const files                    = [];
  const servers                     = [];
  const plugins                    = [];
  const skills                   = [];
  const warnings           = [];

  const userConfig = path.join(home, 'config.toml');
  const user = readToml(userConfig);
  files.push({ host: 'codex', kind: 'user config.toml', path: userConfig, exists: user.ok || !user.missing, ...(user.ok || user.missing ? {} : { error: user.error }) });

  let projectTrusted                     ;
  if (user.ok) {
    collect(user.value, userConfig, 'user', servers, plugins);
    const projects = user.value['projects'];
    if (isObj(projects)) {
      const root = comparablePath(projectRoot, platform);
      for (const [key, value] of Object.entries(projects)) {
        if (comparablePath(key, platform) === root && isObj(value) && typeof value['trust_level'] === 'string') {
          projectTrusted = value['trust_level'] === 'trusted';
        }
      }
    }
  }

  const projectConfig = path.join(projectRoot, '.codex', 'config.toml');
  const proj = readToml(projectConfig);
  files.push({ host: 'codex', kind: 'project .codex/config.toml', path: projectConfig, exists: proj.ok || !proj.missing, ...(proj.ok || proj.missing ? {} : { error: proj.error }) });
  if (proj.ok) {
    const before = servers.length;
    collect(proj.value, projectConfig, 'project', servers, plugins);
    if (projectTrusted !== true) {
      // Codex only reads project config in trusted projects.
      for (const s of servers.slice(before)) {
        s.enabled = false;
        s.inactiveReason = 'Codex reads .codex/config.toml only in trusted projects: open this project in Codex and trust it';
      }
      warnings.push('project .codex/config.toml is ignored by Codex until the project is trusted');
    }
  }

  // MCP servers bundled with enabled plugins.
  const cacheDir = path.join(home, 'plugins', 'cache');
  for (const p of plugins) {
    if (!p.enabled) continue;
    const at = p.id.lastIndexOf('@');
    if (at <= 0) continue;
    const plugin = p.id.slice(0, at);
    const market = p.id.slice(at + 1);
    if (/[\\/]|\.\./.test(plugin + market)) continue;
    const dir = newestSubdir(path.join(cacheDir, market, plugin));
    if (dir) servers.push(...pluginServers('codex', dir, p.id, 'plugin'));
  }

  skills.push(...listSkills('codex', path.join(homeDir(env), '.agents', 'skills'), 'user'));
  skills.push(...listSkills('codex', path.join(home, 'skills'), 'user'));
  skills.push(...listSkills('codex', path.join(projectRoot, '.agents', 'skills'), 'project'));
  skills.push(...listSkills('codex', path.join(projectRoot, '.codex', 'skills'), 'project'));

  return { detected: exists(home), servers, plugins, skills, files, projectTrusted, warnings };
}

function collect(cfg     , source        , scope                    , servers                    , plugins                   )       {
  const ms = cfg['mcp_servers'];
  if (isObj(ms)) {
    for (const [name, def] of Object.entries(ms)) {
      const s = normalizeServer('codex', name, def, scope, source);
      if (s) servers.push(s);
    }
  }
  const ps = cfg['plugins'];
  if (isObj(ps)) {
    for (const [id, def] of Object.entries(ps)) {
      const enabled = isObj(def) ? def['enabled'] !== false : true;
      plugins.push({ host: 'codex', id, scope, enabled, source });
    }
  }
}
