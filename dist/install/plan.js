// Building an install plan: what would change, where, with which permissions. Reads only.

import fs from 'node:fs';
import path from 'node:path';

import { availabilityFor, hostLabel } from '../hosts/inventory.js';
import { codexUserConfigPath } from '../hosts/codex.js';
import { lineDiff } from '../util/diff.js';
import { exists, readText, sha256, detectStyle } from '../util/fsx.js';
import { shellQuote } from '../util/exec.js';
import { displayPath,          } from '../util/paths.js';
import { redactString } from '../util/redact.js';
import { parseToml, tomlTable, TomlError,                   } from '../util/toml.js';
import { claudeAddArgv, claudeServerJson, codexServerTable, resolveSpec, SpecError,                                } from './spec.js';































































export function planInstall(req             )              {
  const { entry, host, inventory } = req;
  const env = req.env ?? process.env;
  const platform = req.platform ?? process.platform;
  const hostInfo = entry.hosts[host];
  const plan              = {
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

  const avail = availabilityFor(entry, inventory, host);
  if (avail.state === 'configured' && !req.force) {
    plan.blocked = `already set up for ${hostLabel(host)}: ${avail.detail}. Use --force to add another copy.`;
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

  let resolved              ;
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

function addPrereqNotes(plan             , entry               )       {
  for (const p of entry.setup.prerequisites ?? []) if (!plan.warnings.includes(`Prerequisite: ${p}`)) plan.warnings.push(`Prerequisite: ${p}`);
}

function hostOf(url        )         {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function planClaude(plan             , req             , r              , platform                 )       {
  if (req.inventory.managedMcp) {
    plan.blocked = 'an administrator-managed MCP config is active, so Claude Code ignores user and project MCP changes';
    return;
  }
  const cli = req.inventory.hostCli.claude;
  const scope        = req.scope ?? (cli ? 'local' : 'project');
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
    const before = readText(target, 4 * 1024 * 1024);
    const existed = exists(target);
    if (existed && before === undefined) {
      plan.blocked = `${displayPath(target)} exists but cannot be read`;
      return;
    }
    let after        ;
    try {
      after = mergeMcpJson(before ?? '', r.serverName, claudeServerJson(r, platform));
    } catch (e) {
      plan.blocked = (e         ).message;
      return;
    }
    plan.method = 'file';
    plan.target = { path: target, format: 'json', existed, beforeHash: sha256(before ?? ''), before: before ?? '', after };
    plan.diff = redactString(lineDiff(before ?? '', after));
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

function planCodex(plan             , req             , r              , env     , platform                 )       {
  const scope        = req.scope ?? 'user';
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
  const existed = exists(target);
  const before = readText(target, 4 * 1024 * 1024);
  if (existed && before === undefined) {
    plan.blocked = `${displayPath(target, env)} exists but cannot be read`;
    return;
  }
  const table = codexServerTable(r, platform);
  let after        ;
  try {
    after = appendCodexServer(before ?? '', r.serverName, table, `${plan.entryName} (stackhint ${new Date(req.now ?? Date.now()).toISOString().slice(0, 10)})`);
  } catch (e) {
    plan.blocked = (e         ).message;
    return;
  }
  plan.method = 'file';
  plan.target = { path: target, format: 'toml', existed, beforeHash: sha256(before ?? ''), before: before ?? '', after };
  plan.diff = redactString(lineDiff(before ?? '', after));
  plan.command = `stackhint writes the [mcp_servers.${r.serverName}] table shown below`;
  if (scope === 'project') plan.sideEffects.push('Codex reads .codex/config.toml only in trusted projects.');
  plan.sideEffects.push('Appends one table; the rest of the file is left byte-for-byte as it is.');
  plan.rollback = 'stackhint rollback (the backup id is printed after the change)';
}

/**
 * A project-scope file must really live in the project: a symlinked .codex folder or .mcp.json
 * pointing elsewhere (for example at ~/.codex) would turn a "project" install into a user one.
 */
export function leavesProject(projectRoot        , target        )                     {
  let realRoot        ;
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
  let realDir        ;
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

export function mergeMcpJson(before        , name        , server                         )         {
  if (before.trim() === '') return JSON.stringify({ mcpServers: { [name]: server } }, null, 2) + '\n';
  let doc         ;
  try {
    doc = JSON.parse(before);
  } catch (e) {
    throw new Error(`.mcp.json is not valid JSON (${(e         ).message}); fix it first, stackhint will not rewrite a file it cannot parse`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('.mcp.json must contain a JSON object');
  const obj = doc                           ;
  const servers = obj['mcpServers'];
  if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) throw new Error('"mcpServers" in .mcp.json is not an object');
  if (servers && Object.prototype.hasOwnProperty.call(servers, name)) throw new ConflictError(`.mcp.json already has a server named "${name}"; pick another name with --name`);
  const out                          = {};
  let placed = false;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'mcpServers') {
      out[k] = { ...(v                           ), [name]: server };
      placed = true;
    } else out[k] = v;
  }
  if (!placed) out['mcpServers'] = { [name]: server };
  const style = detectStyle(before);
  let text = JSON.stringify(out, null, style.indent);
  if (style.eol !== '\n') text = text.replace(/\n/g, style.eol);
  return text + (style.finalNewline ? style.eol : '');
}

export function appendCodexServer(before        , name        , table                              , label        )         {
  let doc                          = {};
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
  let parsed                         ;
  try {
    parsed = parseToml(after);
  } catch (e) {
    throw new Error(`cannot append safely to config.toml: ${e instanceof TomlError ? e.message : String(e)} (for example, mcp_servers is defined as an inline table)`);
  }
  const added = (parsed['mcp_servers']                                       )?.[name];
  if (JSON.stringify(added) !== JSON.stringify(table)) throw new Error('internal check failed: the appended TOML does not round-trip');
  return after;
}
