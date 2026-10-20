// Turning a registry install spec into concrete host configuration.

import type { HostId, RegistryEntry, ServerSpec } from '../types.ts';
import { isSafeUrl, paramValueOk, validateServerSpec } from '../registry/registry.ts';
import { which } from '../util/exec.ts';
import { tomlValue, type TomlWritable } from '../util/toml.ts';

export type Access = 'read' | 'write';

export interface ResolvedSpec {
  spec: ServerSpec;
  access: Access;
  serverName: string;
  /** Env vars the user must have set (without the optional ones). */
  requiredEnv: string[];
  optionalEnv: string[];
}

export class SpecError extends Error {}

export function resolveSpec(
  entry: RegistryEntry,
  host: HostId,
  opts: { access?: Access; params?: Record<string, string>; name?: string; /** Internal specs built in code (stackhint setup). */ trusted?: boolean },
): ResolvedSpec {
  const install = entry.install;
  if (!install) throw new SpecError(`${entry.name} has no automatic install; follow the guide instead`);
  let access: Access;
  let base: ServerSpec | undefined;
  if (opts.access === 'write') {
    base = install.write ?? install.readOnly;
    access = install.write ? 'write' : 'read';
  } else if (opts.access === 'read') {
    if (!install.readOnly) throw new SpecError(`${entry.name} has no read-only mode; use --access write if you accept write access`);
    base = install.readOnly;
    access = 'read';
  } else {
    base = install.readOnly ?? install.write;
    access = install.readOnly ? 'read' : 'write';
  }
  if (!base) throw new SpecError('no server spec');
  const override = install.overrides?.[host] ?? {};
  const merged: ServerSpec = { ...base, ...override };

  // Parameters
  const values: Record<string, string> = {};
  for (const p of install.params ?? []) {
    const v = opts.params?.[p.name] ?? p.default;
    if (v === undefined) throw new SpecError(`missing parameter ${p.name} (${p.description}), e.g. --param ${p.name}=${p.example}`);
    if (!paramValueOk(p, v)) throw new SpecError(`invalid value for ${p.name}: ${JSON.stringify(v)}`);
    values[p.name] = v;
  }
  for (const k of Object.keys(opts.params ?? {})) {
    if (!(install.params ?? []).some((p) => p.name === k)) throw new SpecError(`unknown parameter ${k}`);
  }
  const fill = (s: string): string => s.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (m, name: string) => values[name] ?? m);
  const spec: ServerSpec = {
    transport: merged.transport,
    ...(merged.url ? { url: fill(merged.url) } : {}),
    ...(merged.headers ? { headers: { ...merged.headers } } : {}),
    ...(merged.bearerTokenEnv ? { bearerTokenEnv: merged.bearerTokenEnv } : {}),
    ...(merged.envHeaders ? { envHeaders: { ...merged.envHeaders } } : {}),
    ...(merged.command ? { command: merged.command } : {}),
    ...(merged.args ? { args: merged.args.map(fill) } : {}),
    ...(merged.env ? { env: { ...merged.env } } : {}),
    ...(merged.passEnv ? { passEnv: [...merged.passEnv] } : {}),
  };
  // The final spec (after host overrides and parameters) must pass the same checks as a registry entry.
  const check = opts.trusted ? {} : validateServerSpec(spec, [], false);
  if (check.error) throw new SpecError(`invalid server spec after applying parameters: ${check.error}`);
  if (!opts.trusted && spec.url && !isSafeUrl(spec.url)) throw new SpecError('the URL is not a safe https URL after applying parameters');
  const name = opts.name ?? install.serverName;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new SpecError('server name may only contain letters, digits, - and _');
  const requiredEnv: string[] = [];
  const optionalEnv: string[] = [];
  for (const v of spec.passEnv ?? []) (v.endsWith('?') ? optionalEnv : requiredEnv).push(v.replace(/\?$/, ''));
  if (spec.bearerTokenEnv) requiredEnv.push(spec.bearerTokenEnv);
  for (const v of Object.values(spec.envHeaders ?? {})) requiredEnv.push(v);
  return { spec, access, serverName: name, requiredEnv: [...new Set(requiredEnv)], optionalEnv };
}

/** Batch shims like npx.cmd cannot be spawned directly by Claude Code or Codex on native Windows. */
export function needsCmdWrapper(command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform !== 'win32') return false;
  if (/^(npx|npm|pnpm|pnpx|yarn|bunx)$/i.test(command)) return true;
  const found = which(command, env, platform);
  return Boolean(found && /\.(cmd|bat)$/i.test(found));
}

function windowsCommand(spec: ServerSpec, platform: NodeJS.Platform): { command: string; args: string[] } {
  const command = spec.command as string;
  const args = spec.args ?? [];
  if (needsCmdWrapper(command, platform)) return { command: 'cmd', args: ['/c', command, ...args] };
  return { command, args };
}

/** Server definition in Claude Code's .mcp.json / ~/.claude.json shape. */
export function claudeServerJson(r: ResolvedSpec, platform: NodeJS.Platform = process.platform): Record<string, unknown> {
  const s = r.spec;
  if (s.transport === 'http') {
    const headers: Record<string, string> = { ...(s.headers ?? {}) };
    if (s.bearerTokenEnv) headers['Authorization'] = `Bearer \${${s.bearerTokenEnv}}`;
    for (const [h, v] of Object.entries(s.envHeaders ?? {})) headers[h] = `\${${v}}`;
    return { type: 'http', url: s.url as string, ...(Object.keys(headers).length ? { headers } : {}) };
  }
  const { command, args } = windowsCommand(s, platform);
  const env: Record<string, string> = { ...(s.env ?? {}) };
  for (const v of s.passEnv ?? []) {
    const name = v.replace(/\?$/, '');
    env[name] = v.endsWith('?') ? `\${${name}:-}` : `\${${name}}`;
  }
  return { type: 'stdio', command, args, ...(Object.keys(env).length ? { env } : {}) };
}

/** Values for a Codex [mcp_servers.<name>] table. */
export function codexServerTable(r: ResolvedSpec, platform: NodeJS.Platform = process.platform): Record<string, TomlWritable> {
  const s = r.spec;
  if (s.transport === 'http') {
    const out: Record<string, TomlWritable> = { url: s.url as string };
    if (s.bearerTokenEnv) out['bearer_token_env_var'] = s.bearerTokenEnv;
    if (s.headers && Object.keys(s.headers).length) out['http_headers'] = { ...s.headers };
    if (s.envHeaders && Object.keys(s.envHeaders).length) out['env_http_headers'] = { ...s.envHeaders };
    return out;
  }
  const { command, args } = windowsCommand(s, platform);
  const out: Record<string, TomlWritable> = { command, args };
  if (s.env && Object.keys(s.env).length) out['env'] = { ...s.env };
  const pass = (s.passEnv ?? []).map((v) => v.replace(/\?$/, ''));
  if (pass.length) out['env_vars'] = pass;
  if (s.command === 'npx' || s.command === 'uvx' || s.command === 'docker' || s.command === 'dnx' || s.command === 'uv') {
    // First start downloads the package or image; Codex's default startup timeout is 10s.
    out['startup_timeout_sec'] = 60;
  }
  return out;
}

/**
 * `claude mcp add` argv for user/local scope (no JSON, so it also works through cmd.exe shims).
 * --env and --header take several values, so they go first: the following --transport flag
 * ends the list. Placed right before the name, they would swallow the name (seen with 2.1.300).
 */
export function claudeAddArgv(r: ResolvedSpec, scope: 'user' | 'local' | 'project', platform: NodeJS.Platform = process.platform): string[] {
  const json = claudeServerJson(r, platform);
  if (json['type'] === 'http') {
    const headers = (json['headers'] ?? {}) as Record<string, string>;
    return ['mcp', 'add', ...Object.entries(headers).flatMap(([k, v]) => ['--header', `${k}: ${v}`]), '--transport', 'http', '--scope', scope, r.serverName, json['url'] as string];
  }
  const env = (json['env'] ?? {}) as Record<string, string>;
  return [
    'mcp', 'add',
    ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    '--transport', 'stdio', '--scope', scope,
    r.serverName, '--', json['command'] as string, ...((json['args'] as string[]) ?? []),
  ];
}

/** One-off session command that loads the server without changing any config ("try it"). */
export function tryCommand(host: HostId, r: ResolvedSpec, configFile: string, platform: NodeJS.Platform = process.platform): string {
  if (host === 'claude') return `claude --mcp-config "${configFile}"`;
  const t = codexServerTable(r, platform);
  const parts = Object.entries(t).map(([k, v]) => `-c ${singleQuote(`mcp_servers.${r.serverName}.${k}=${tomlValue(v)}`)}`);
  return `codex ${parts.join(' ')}`;
}

/** POSIX single quotes; values are validated to contain no quotes or $, so this is also literal in PowerShell. */
function singleQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}
