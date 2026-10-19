import fs from 'node:fs';
import path from 'node:path';
import type { ConfiguredServer, HostId, InstalledSkill, ItemScope } from '../types.ts';
import { readJson, readText } from '../util/fsx.ts';
import { looksLikeLiteralSecret, redactValue } from '../util/redact.ts';

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Turn one raw server definition (Claude JSON or Codex TOML table) into a ConfiguredServer. */
export function normalizeServer(host: HostId, name: string, def: unknown, scope: ItemScope, source: string, viaPlugin?: string): ConfiguredServer | undefined {
  if (!isObj(def)) return undefined;
  const type = typeof def['type'] === 'string' ? (def['type'] as string).toLowerCase() : undefined;
  const url = typeof def['url'] === 'string' ? def['url'] : undefined;
  const command = typeof def['command'] === 'string' ? def['command'] : undefined;
  const args = Array.isArray(def['args']) ? (def['args'] as unknown[]).filter((a): a is string => typeof a === 'string') : [];
  let transport: ConfiguredServer['transport'] = 'unknown';
  if (type === 'http' || type === 'streamable-http' || type === 'streamable_http') transport = 'http';
  else if (type === 'sse') transport = 'sse';
  else if (type === 'stdio' || command) transport = 'stdio';
  else if (url) transport = /\/sse\/?$/.test(url) ? 'sse' : 'http';

  const inlineSecrets: string[] = [];
  const settings: Record<string, string> = {};
  for (const key of ['headers', 'http_headers', 'env']) {
    const m = def[key];
    if (!isObj(m)) continue;
    const prefix = key === 'env' ? 'env' : 'header';
    for (const [k, v] of Object.entries(m)) {
      if (typeof v !== 'string') continue;
      if (looksLikeLiteralSecret(k, v)) inlineSecrets.push(`${key}.${k}`);
      settings[`${prefix}.${k}`] = looksLikeLiteralSecret(k, v) ? '***' : redactValue(k, v).slice(0, 80);
    }
  }
  // Codex: secrets passed by name.
  if (typeof def['bearer_token_env_var'] === 'string') settings['bearer_token_env_var'] = def['bearer_token_env_var'];
  if (Array.isArray(def['env_vars'])) settings['env_vars'] = (def['env_vars'] as unknown[]).filter((x) => typeof x === 'string').join(',');
  args.forEach((a, i) => {
    const prev = i > 0 ? (args[i - 1] ?? '') : '';
    const eq = /^--?([A-Za-z0-9_-]+)=(.*)$/.exec(a);
    if (eq && eq[1] && eq[2] !== undefined && looksLikeLiteralSecret(eq[1], eq[2])) inlineSecrets.push(`args[${i}]`);
    else if (/^--?[A-Za-z0-9_-]+$/.test(prev) && looksLikeLiteralSecret(prev, a)) inlineSecrets.push(`args[${i}]`);
    else if (looksLikeLiteralSecret('', a)) inlineSecrets.push(`args[${i}]`);
  });
  if (url && looksLikeLiteralSecret('', url)) inlineSecrets.push('url');

  const enabled = def['enabled'] !== false && def['disabled'] !== true;
  return {
    host,
    name,
    scope,
    source,
    transport,
    ...(url ? { url } : {}),
    ...(command ? { command } : {}),
    args,
    enabled,
    ...(viaPlugin ? { viaPlugin } : {}),
    inlineSecrets,
    settings,
  };
}

/** Read MCP servers bundled with an installed plugin directory (.mcp.json, mcp.json, manifest mcpServers). */
export function pluginServers(host: HostId, pluginDir: string, pluginId: string, scope: ItemScope): ConfiguredServer[] {
  const out: ConfiguredServer[] = [];
  const addFrom = (obj: unknown, source: string): void => {
    if (!isObj(obj)) return;
    const map = isObj(obj['mcpServers']) ? (obj['mcpServers'] as Obj) : obj;
    for (const [name, def] of Object.entries(map)) {
      const s = normalizeServer(host, name, def, 'plugin', source, pluginId);
      if (s) out.push({ ...s, scope });
    }
  };
  for (const f of ['.mcp.json', 'mcp.json']) {
    const p = path.join(pluginDir, f);
    const res = readJson(p);
    if (res.ok) addFrom(res.value, p);
  }
  for (const manifest of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'plugin.json']) {
    const p = path.join(pluginDir, manifest);
    const res = readJson<Obj>(p);
    if (!res.ok || !isObj(res.value)) continue;
    const m = res.value['mcpServers'];
    if (isObj(m)) addFrom({ mcpServers: m }, p);
    else if (typeof m === 'string' && !m.includes('..')) {
      const ref = readJson(path.join(pluginDir, m));
      if (ref.ok) addFrom(ref.value, path.join(pluginDir, m));
    }
  }
  // Deduplicate servers declared in more than one file.
  const seen = new Set<string>();
  return out.filter((s) => {
    const key = `${s.name}|${s.url ?? ''}|${s.command ?? ''}|${s.args.join(' ')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Most recently modified subdirectory, used to pick the current version in a plugin cache. */
export function newestSubdir(dir: string): string | undefined {
  let best: { p: string; t: number } | undefined;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      const t = fs.statSync(p).mtimeMs;
      if (!best || t > best.t) best = { p, t };
    }
  } catch {
    return undefined;
  }
  return best?.p;
}

/** Skills are folders containing SKILL.md. Name comes from frontmatter when present. */
export function listSkills(host: HostId, dir: string, scope: ItemScope): InstalledSkill[] {
  const out: InstalledSkill[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const file = path.join(dir, e.name, 'SKILL.md');
    const text = readText(file, 256 * 1024);
    if (text === undefined) continue;
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const nameLine = fm && fm[1] ? /^name:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(fm[1]) : null;
    out.push({ host, name: (nameLine && nameLine[1] ? nameLine[1].trim() : e.name).slice(0, 64), scope, source: file });
  }
  return out;
}

/** Legacy custom commands (*.md) behave like skills in Claude Code. */
export function listCommands(host: HostId, dir: string, scope: ItemScope): InstalledSkill[] {
  const out: InstalledSkill[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.md')) out.push({ host, name: e.name.slice(0, -3), scope, source: path.join(dir, e.name) });
    }
  } catch {
    /* none */
  }
  return out;
}
