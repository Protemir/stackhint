// Building an install plan: what would change, where, with which permissions. Reads only.

import fs from 'node:fs';
import path from 'node:path';
import type { HostId, Inventory, RegistryEntry } from '../types.ts';
import { availabilityFor, hostLabel } from '../hosts/inventory.ts';
import { codexUserConfigPath } from '../hosts/codex.ts';
import { lineDiff } from '../util/diff.ts';
import { decodeConfig, detectStyle, encodeConfig, exists, readBytes, sha256 } from '../util/fsx.ts';
import { shellQuote } from '../util/exec.ts';
import { displayPath, type Env } from '../util/paths.ts';
import { redactString } from '../util/redact.ts';
import { parseToml, tomlTable, TomlError, type TomlWritable } from '../util/toml.ts';
import { claudeAddArgv, claudeServerJson, codexServerTable, resolveSpec, SpecError, type Access, type ResolvedSpec } from './spec.ts';

export type Scope = 'user' | 'project' | 'local';
export type Method = 'file' | 'cli' | 'guided';

export interface PlanRequest {
  entry: RegistryEntry;
  host: HostId;
  projectRoot: string;
  inventory: Inventory;
  scope?: Scope;
  access?: Access;
  params?: Record<string, string>;
  name?: string;
  force?: boolean;
  env?: Env;
  platform?: NodeJS.Platform;
  /** Fixed clock for reproducible output in tests. */
  now?: number;
  /** Spec built in code by stackhint itself (setup), not from a registry file. */
  trusted?: boolean;
  /** All registry entries, so a configured server is attributed to the entry it really belongs to. */
  entries?: RegistryEntry[];
}

export interface PlanTarget {
  path: string;
  format: 'json' | 'toml';
  existed: boolean;
  /** sha256 of the file's bytes when the plan was made. */
  beforeHash: string;
  before: string;
  after: string;
  /** The file starts with a UTF-8 BOM; it is kept. */
  bom: boolean;
}

/** Read a config file for editing, or a reason why it must not be rewritten. */
export function readConfigForEdit(file: string, env?: Env): { existed: boolean; text: string; bom: boolean; hash: string } | string {
  if (!exists(file)) return { existed: false, text: '', bom: false, hash: sha256('') };
  const bytes = readBytes(file, 4 * 1024 * 1024);
  if (bytes === undefined) return `${displayPath(file, env)} exists but cannot be read (or is larger than 4 MB)`;
  const decoded = decodeConfig(bytes);
  if (!decoded) return `${displayPath(file, env)} is not valid UTF-8 text; stackhint will not rewrite it (save it as UTF-8 first)`;
  return { existed: true, text: decoded.text, bom: decoded.bom, hash: sha256(bytes) };
}

/** What the target file will hold after the change, byte for byte. */
export function targetBytes(t: PlanTarget): Buffer {
  return encodeConfig(t.after, t.bom);
}

export interface InstallPlan {
  entryId: string;
  entryName: string;
  host: HostId;
  scope: Scope;
  method: Method;
  serverName: string;
  access: Access | 'n/a';
  target?: PlanTarget;
  diff?: string;
  /** For method "cli": the program (resolved path) and its argv. */
  exe?: string;
  argv?: string[];
  /** What runs or the equivalent command, for display. */
  command?: string;
  officialCommand?: string;
  plugin?: string;
  guide: string[];
  source: { vendor: string; official: boolean; docs: string; repo?: string; verifiedAt: string };
  permissions: string;
  auth: string;
  network: string;
  sideEffects: string[];
  envNeeded: Array<{ name: string; set: boolean; optional: boolean }>;
  prerequisites: Array<{ name: string; found: boolean }>;
  warnings: string[];
  blocked?: string;
  rollback: string;
  nextSteps: string[];
  resolved?: ResolvedSpec;
}

export function planInstall(req: PlanRequest): InstallPlan {
  const { entry, host, inventory } = req;
  const env = req.env ?? process.env;
  const platform = req.platform ?? process.platform;
  const hostInfo = entry.hosts[host];
  const plan: InstallPlan = {
    entryId: entry.id,
    entryName: entry.name,
    host,
    scope: req.scope ?? 'user',
    method: 'guided',
    serverName: entry.install?.serverName ?? entry.id,
    access: 'n/a',
    guide: entry.guide ?? [],
    source: { vendor: entry.vendor, official: entry.official, docs: entry.docs, ...(entry.repo ? { repo: entry.repo } : {}), verifiedAt: entry.verifiedAt },
    permissions: entry.access.summary || entry.access.level,
    auth: entry.auth.detail || entry.auth.type,
    network: entry.network,
    sideEffects: [],
    envNeeded: [],
    prerequisites: [],
    warnings: [],
    rollback: '',
    nextSteps: [],
    ...(hostInfo.officialCommand ? { officialCommand: hostInfo.officialCommand } : {}),
    ...(hostInfo.plugin ? { plugin: hostInfo.plugin } : {}),
  };

  if (hostInfo.support === 'no') {
    plan.blocked = `${entry.name} is not available for ${hostLabel(host)}${hostInfo.notes ? ` (${hostInfo.notes})` : ''}`;
    return plan;
  }
  if (entry.status === 'archived' || entry.status === 'removed' || entry.status === 'deprecated') {
    plan.blocked = `${entry.name} is ${entry.status}${entry.successor ? `; use ${entry.successor} instead` : ''}`;
    return plan;
  }
  if (hostInfo.support === 'unknown') plan.warnings.push(`Compatibility with ${hostLabel(host)} is not verified.`);

  const avail = availabilityFor(entry, inventory, host, req.entries);
  if (avail.state === 'configured' && !req.force) {
    plan.blocked = entry.kind === 'cli' ? `already available: ${avail.detail}; nothing to install.` : `already set up for ${hostLabel(host)}: ${avail.detail}. Use --force to add another copy.`;
    return plan;
  }
  if (avail.state === 'disabled' && !req.force) {
    plan.blocked = `already in the ${hostLabel(host)} config but not active (${avail.detail}). Enable it there; --force adds another copy instead.`;
    return plan;
  }

  // Plugins: Claude Code can install them with its own CLI.
  if (entry.kind === 'plugin') {
    if (host === 'claude' && hostInfo.plugin && inventory.hostCli.claude) {
      const scope = req.scope ?? 'user';
      plan.method = 'cli';
      plan.scope = scope;
      plan.exe = inventory.hostCli.claude;
      plan.argv = ['plugin', 'install', hostInfo.plugin, '--scope', scope];
      plan.command = `claude ${shellQuote(plan.argv)}`;
      plan.sideEffects.push(`Claude Code downloads the plugin and enables it in your ${scope} settings.`);
      plan.rollback = `claude plugin uninstall ${hostInfo.plugin}`;
    } else {
      plan.method = 'guided';
      plan.nextSteps.push(...plan.guide);
    }
    addPrereqNotes(plan, entry);
    return plan;
  }
  if (entry.kind !== 'mcp' || !entry.install) {
    plan.method = 'guided';
    plan.nextSteps.push(...plan.guide);
    if (hostInfo.officialCommand) plan.nextSteps.push(`Vendor command: ${hostInfo.officialCommand}`);
    addPrereqNotes(plan, entry);
    return plan;
  }

  let resolved: ResolvedSpec;
  try {
    resolved = resolveSpec(entry, host, {
      ...(req.access ? { access: req.access } : {}),
      ...(req.params ? { params: req.params } : {}),
      ...(req.name ? { name: req.name } : {}),
      ...(req.trusted ? { trusted: true } : {}),
    });
  } catch (e) {
    plan.blocked = e instanceof SpecError ? e.message : String(e);
    return plan;
  }
  plan.resolved = resolved;
  plan.serverName = resolved.serverName;
  plan.access = resolved.access;
  if (resolved.access === 'write' && entry.access.readOnlyAvailable) plan.warnings.push('You chose write access although a read-only mode exists.');
  if (resolved.access === 'read' && entry.install.write) plan.sideEffects.push('Configured in read-only mode. Re-run with --access write for full access.');

  for (const name of resolved.requiredEnv) plan.envNeeded.push({ name, set: Boolean(env[name]), optional: false });
  for (const name of resolved.optionalEnv) plan.envNeeded.push({ name, set: Boolean(env[name]), optional: true });
  for (const req2 of entry.install.requires ?? []) plan.prerequisites.push({ name: req2, found: Boolean(inventory.executables[req2]) });
  addPrereqNotes(plan, entry);
  if (resolved.spec.transport === 'http') plan.sideEffects.push(`The agent will connect to ${hostOf(resolved.spec.url ?? '')} when the server is used.`);
  else plan.sideEffects.push(`${hostLabel(host)} will start \`${resolved.spec.command}\` locally when a session starts${/^(npx|uvx|uv|docker|dnx)$/.test(resolved.spec.command ?? '') ? ' (it downloads the package on first run)' : ''}.`);
  if (resolved.spec.transport === 'http' && entry.auth.type === 'oauth') plan.nextSteps.push(host === 'codex' ? `Sign in when asked, or run: codex mcp login ${resolved.serverName}` : 'Sign in when Claude Code asks (or run /mcp in a session).');
  for (const e of plan.envNeeded.filter((x) => !x.set && !x.optional)) plan.nextSteps.push(`Set ${e.name} in your environment before starting ${hostLabel(host)} (stackhint never writes its value).`);
  if (hostInfo.notes) plan.nextSteps.push(hostInfo.notes);

  if (host === 'claude') planClaude(plan, req, resolved, platform);
  else planCodex(plan, req, resolved, env, platform);
  return plan;
}

function addPrereqNotes(plan: InstallPlan, entry: RegistryEntry): void {
  for (const p of entry.setup.prerequisites ?? []) if (!plan.warnings.includes(`Prerequisite: ${p}`)) plan.warnings.push(`Prerequisite: ${p}`);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function planClaude(plan: InstallPlan, req: PlanRequest, r: ResolvedSpec, platform: NodeJS.Platform): void {
  if (req.inventory.managedMcp) {
    plan.blocked = 'an administrator-managed MCP config is active, so Claude Code ignores user and project MCP changes';
    return;
  }
  const cli = req.inventory.hostCli.claude;
  const scope: Scope = req.scope ?? (cli ? 'local' : 'project');
  plan.scope = scope;
  const argv = claudeAddArgv(r, scope, platform);
  plan.command = `claude ${shellQuote(argv)}`;

  if (scope === 'project') {
    const target = path.join(req.projectRoot, '.mcp.json');
    const escape = leavesProject(req.projectRoot, target);
    if (escape) {
      plan.blocked = escape;
      return;
    }
    const cur = readConfigForEdit(target);
    if (typeof cur === 'string') {
      plan.blocked = cur;
      return;
    }
    const server = claudeServerJson(r, platform);
    let after: string;
    try {
      after = mergeMcpJson(cur.text, r.serverName, server);
    } catch (e) {
      plan.blocked = (e as Error).message;
      return;
    }
    plan.method = 'file';
    plan.target = { path: target, format: 'json', existed: cur.existed, beforeHash: cur.hash, before: cur.text, after, bom: cur.bom };
    plan.diff = redactString(lineDiff(cur.text, after));
    if (server['command'] === 'cmd' && r.spec.command !== 'cmd') plan.warnings.push(crossPlatformWarning('.mcp.json', r.spec.command as string, 'local'));
    plan.sideEffects.push('.mcp.json is usually committed, so teammates get this server too; Claude Code asks each person to approve project servers.');
    plan.rollback = 'stackhint rollback (the backup id is printed after the change)';
    return;
  }
  // user/local scope live in ~/.claude.json, which Claude Code rewrites constantly: use its own CLI.
  const existing = req.inventory.servers.find((s) => s.host === 'claude' && s.name === r.serverName && s.scope === scope);
  if (existing && !req.force) {
    plan.blocked = `a Claude Code server named "${r.serverName}" already exists in ${scope} scope; pick another name with --name`;
    return;
  }
  if (!cli) {
    plan.blocked = `Claude Code CLI not found on PATH. Use --scope project, or run this yourself:\n  ${plan.command}`;
    return;
  }
  plan.method = 'cli';
  plan.exe = cli;
  plan.argv = argv;
  plan.sideEffects.push(`Runs \`claude mcp add\`, which stores the server in ~/.claude.json (${scope} scope${scope === 'local' ? ', only you, only this project' : ', all your projects'}).`);
  plan.rollback = `claude mcp remove ${r.serverName} --scope ${scope}`;
}

function planCodex(plan: InstallPlan, req: PlanRequest, r: ResolvedSpec, env: Env, platform: NodeJS.Platform): void {
  const scope: Scope = req.scope ?? 'user';
  if (scope === 'local') {
    plan.blocked = 'Codex has no "local" scope; use --scope user (~/.codex/config.toml) or --scope project (.codex/config.toml)';
    return;
  }
  plan.scope = scope;
  const target = scope === 'user' ? codexUserConfigPath(env) : path.join(req.projectRoot, '.codex', 'config.toml');
  const escape = scope === 'project' ? leavesProject(req.projectRoot, target) : undefined;
  if (escape) {
    plan.blocked = escape;
    return;
  }
  const cur = readConfigForEdit(target, env);
  if (typeof cur === 'string') {
    plan.blocked = cur;
    return;
  }
  const table = codexServerTable(r, platform);
  let after: string;
  try {
    after = appendCodexServer(cur.text, r.serverName, table, `${plan.entryName} (stackhint ${new Date(req.now ?? Date.now()).toISOString().slice(0, 10)})`);
  } catch (e) {
    plan.blocked = (e as Error).message;
    return;
  }
  plan.method = 'file';
  plan.target = { path: target, format: 'toml', existed: cur.existed, beforeHash: cur.hash, before: cur.text, after, bom: cur.bom };
  plan.diff = redactString(lineDiff(cur.text, after));
  plan.command = `stackhint writes the [mcp_servers.${r.serverName}] table shown below`;
  const link = linkTarget(target);
  if (link) plan.sideEffects.push(`${displayPath(target, env)} is a symbolic link; the change goes to ${displayPath(link, env)}.`);
  if (scope === 'project') {
    plan.sideEffects.push('Codex reads .codex/config.toml only in trusted projects.');
    if (table['command'] === 'cmd' && r.spec.command !== 'cmd') plan.warnings.push(crossPlatformWarning('.codex/config.toml', r.spec.command as string, 'user'));
  }
  plan.sideEffects.push('Appends one table; the rest of the file is left byte-for-byte as it is.');
  plan.rollback = 'stackhint rollback (the backup id is printed after the change)';
}

function crossPlatformWarning(file: string, command: string, privateScope: string): string {
  return `${file} gets \`cmd /c ${command}\` so the server starts on Windows; teammates on macOS or Linux need plain \`${command}\`. For a mixed team, use --scope ${privateScope} instead.`;
}

/** The real file behind a symbolic link, if the path is one. */
function linkTarget(file: string): string | undefined {
  try {
    return fs.lstatSync(file).isSymbolicLink() ? fs.realpathSync(file) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A project-scope file must really live in the project: a symlinked .codex folder or .mcp.json
 * pointing elsewhere (for example at ~/.codex) would turn a "project" install into a user one.
 */
export function leavesProject(projectRoot: string, target: string): string | undefined {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(projectRoot);
  } catch {
    return `project folder ${displayPath(projectRoot)} does not exist`;
  }
  let p = path.dirname(target);
  // Walk up to the deepest existing ancestor of the target and resolve it.
  while (!fs.existsSync(p) && path.dirname(p) !== p) p = path.dirname(p);
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) return `${displayPath(target)} is a symbolic link; refusing to write through it`;
  } catch {
    /* does not exist yet: fine */
  }
  let realDir: string;
  try {
    realDir = fs.realpathSync(p);
  } catch {
    return `cannot resolve ${displayPath(p)}`;
  }
  const rel = path.relative(realRoot, realDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return `${displayPath(target)} resolves outside the project (symbolic link?); refusing to write there`;
  return undefined;
}

// ---------------- config editing (pure) ----------------

export class ConflictError extends Error {}

export function mergeMcpJson(before: string, name: string, server: Record<string, unknown>): string {
  if (before.trim() === '') return JSON.stringify({ mcpServers: { [name]: server } }, null, 2) + '\n';
  let doc: unknown;
  try {
    doc = JSON.parse(before);
  } catch (e) {
    throw new Error(`.mcp.json is not valid JSON (${(e as Error).message}); fix it first, stackhint will not rewrite a file it cannot parse`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('.mcp.json must contain a JSON object');
  const obj = doc as Record<string, unknown>;
  const servers = obj['mcpServers'];
  if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) throw new Error('"mcpServers" in .mcp.json is not an object');
  if (servers && Object.prototype.hasOwnProperty.call(servers, name)) throw new ConflictError(`.mcp.json already has a server named "${name}"; pick another name with --name`);

  // Insert into the text instead of re-serializing, so everything else stays byte for byte
  // (big numbers, key order, "__proto__" keys, spacing).
  const style = detectStyle(before);
  const top = jsonObjectAt(before, before.search(/\S/));
  const lastTop = [...top.members].reverse().find((m) => m.key === 'mcpServers');
  let after: string;
  if (lastTop && before[lastTop.valueStart] === '{') {
    const inner = jsonObjectAt(before, lastTop.valueStart);
    after = insertMember(before, inner, lastTop, name, server, style);
  } else {
    after = insertMember(before, top, undefined, 'mcpServers', { [name]: server }, style);
  }
  // The edit must parse, add exactly our server, and leave every other value as it was.
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(after) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`internal check failed: the edited .mcp.json does not parse (${(e as Error).message})`);
  }
  const added = (parsed['mcpServers'] as Record<string, unknown> | undefined)?.[name];
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  const restBefore = { ...(servers as Record<string, unknown> | undefined) };
  const restAfter = { ...(parsed['mcpServers'] as Record<string, unknown>) };
  delete restAfter[name];
  const othersSame = Object.keys(obj).every((k) => k === 'mcpServers' || same(obj[k], parsed[k])) && Object.keys(parsed).every((k) => k === 'mcpServers' || k in obj);
  if (!same(added, server) || !same(restBefore, restAfter) || !othersSame) throw new Error('internal check failed: could not add the server to .mcp.json without changing other values');
  return after;
}

interface JsonMember {
  key: string;
  keyStart: number;
  keyEnd: number;
  valueStart: number;
  valueEnd: number;
}

/** Members of the JSON object whose `{` is at `open`. The text is already known to be valid JSON. */
function jsonObjectAt(src: string, open: number): { open: number; close: number; members: JsonMember[] } {
  const members: JsonMember[] = [];
  let i = open + 1;
  for (;;) {
    while (/\s|,/.test(src[i] ?? '')) i++;
    if (src[i] === '}' || i >= src.length) return { open, close: i, members };
    const keyStart = i;
    const keyEnd = jsonValueEnd(src, i);
    const key = JSON.parse(src.slice(keyStart, keyEnd)) as string;
    i = keyEnd;
    while (/\s/.test(src[i] ?? '')) i++;
    i++; // ':'
    while (/\s/.test(src[i] ?? '')) i++;
    const valueStart = i;
    const valueEnd = jsonValueEnd(src, i);
    members.push({ key, keyStart, keyEnd, valueStart, valueEnd });
    i = valueEnd;
  }
}

/** Index just past the JSON value that starts at `i`. */
function jsonValueEnd(src: string, i: number): number {
  const c = src[i];
  if (c === '"') {
    let j = i + 1;
    while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
    return j + 1;
  }
  if (c === '{' || c === '[') {
    let depth = 0;
    let j = i;
    while (j < src.length) {
      const d = src[j];
      if (d === '"') {
        j = jsonValueEnd(src, j);
        continue;
      }
      if (d === '{' || d === '[') depth++;
      else if (d === '}' || d === ']') {
        depth--;
        if (depth === 0) return j + 1;
      }
      j++;
    }
    return j;
  }
  let j = i;
  while (j < src.length && !/[\s,}\]]/.test(src[j] as string)) j++;
  return j;
}

/** Add `"key": value` as the last member of `obj`, in the style the file already uses. */
function insertMember(src: string, obj: { open: number; close: number; members: JsonMember[] }, owner: JsonMember | undefined, key: string, value: unknown, style: { indent: string; eol: string }): string {
  const lineIndent = (pos: number): string | undefined => {
    const lineStart = src.lastIndexOf('\n', pos - 1) + 1;
    const prefix = src.slice(lineStart, pos);
    return /^[ \t]*$/.test(prefix) ? prefix : undefined;
  };
  const multiline = src.slice(obj.open, obj.close).includes('\n') || (obj.members.length === 0 && src.includes('\n'));
  const block = (v: unknown, base: string): string => (multiline ? JSON.stringify(v, null, style.indent).replace(/\n/g, style.eol + base) : JSON.stringify(v));
  const last = obj.members[obj.members.length - 1];
  if (last) {
    const sep = src.slice(last.keyEnd, last.valueStart);
    const indent = lineIndent(last.keyStart);
    const text = indent !== undefined && multiline ? `,${style.eol}${indent}${JSON.stringify(key)}${sep}${block(value, indent)}` : `, ${JSON.stringify(key)}${sep}${JSON.stringify(value)}`;
    return src.slice(0, last.valueEnd) + text + src.slice(last.valueEnd);
  }
  // Empty object: lay it out one level deeper than the line that holds it.
  const outer = owner ? (lineIndent(owner.keyStart) ?? '') : '';
  const inner = outer + style.indent;
  const body = multiline ? `{${style.eol}${inner}${JSON.stringify(key)}: ${block(value, inner)}${style.eol}${outer}}` : `{ ${JSON.stringify(key)}: ${JSON.stringify(value)} }`;
  return src.slice(0, obj.open) + body + src.slice(obj.close + 1);
}

export function appendCodexServer(before: string, name: string, table: Record<string, TomlWritable>, label: string): string {
  let doc: Record<string, unknown> = {};
  if (before.trim() !== '') {
    try {
      doc = parseToml(before);
    } catch (e) {
      throw new Error(`config.toml is not valid TOML (${e instanceof TomlError ? e.message : String(e)}); fix it first, stackhint will not edit a file it cannot parse`);
    }
  }
  const servers = doc['mcp_servers'];
  if (servers !== undefined && (typeof servers !== 'object' || servers === null || Array.isArray(servers))) throw new Error('mcp_servers in config.toml is not a table');
  if (servers && Object.prototype.hasOwnProperty.call(servers, name)) throw new ConflictError(`config.toml already has [mcp_servers.${name}]; pick another name with --name`);
  const eol = /\r\n/.test(before) ? '\r\n' : '\n';
  const block = [`# Added by stackhint: ${label.replace(/[\r\n]/g, ' ')}. Delete this table to undo.`, tomlTable(['mcp_servers', name], table)].join('\n').replace(/\n/g, eol);
  let prefix = before;
  if (prefix !== '' && !/\n$/.test(prefix)) prefix += eol;
  if (prefix.trim() !== '') prefix += eol;
  const after = prefix + block + eol;
  // The result must parse and contain exactly what we meant to add.
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(after);
  } catch (e) {
    throw new Error(`cannot append safely to config.toml: ${e instanceof TomlError ? e.message : String(e)} (for example, mcp_servers is defined as an inline table)`);
  }
  const added = (parsed['mcp_servers'] as Record<string, unknown> | undefined)?.[name];
  if (JSON.stringify(added) !== JSON.stringify(table)) throw new Error('internal check failed: the appended TOML does not round-trip');
  return after;
}
