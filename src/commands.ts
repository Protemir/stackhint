// Command implementations. The CLI parses arguments and calls these; tests call them directly.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostId, RegistryEntry } from './types.ts';
import { HOST_IDS } from './types.ts';
import { openSession, runRecommend, type Session } from './app.ts';
import { checkConfig } from './engine/check.ts';
import { hostLabel } from './hosts/inventory.ts';
import { applyPlan, listBackups, rollback, type Runner } from './install/apply.ts';
import { planInstall, type Scope } from './install/plan.ts';
import { claudeServerJson, codexServerTable, resolveSpec, tryCommand, SpecError, type Access } from './install/spec.ts';
import { findEntry, isLegacy, searchRegistry, suggestIds } from './registry/registry.ts';
import { searchRemote } from './registry/remote.ts';
import {
  recommendationJson,
  renderApply,
  renderExplain,
  renderFindings,
  renderPlan,
  renderRecommendations,
  renderScan,
  renderStatus,
  style,
  type Format,
} from './render/render.ts';
import { CONFIG_KEYS, Store } from './state/store.ts';
import { parseDuration } from './util/duration.ts';
import { run, which } from './util/exec.ts';
import { readText, writeAtomic } from './util/fsx.ts';
import { displayPath, type Env } from './util/paths.ts';
import { redactDeep } from './util/redact.ts';
import { sanitizeLine } from './util/text.ts';
import { tomlTable } from './util/toml.ts';
import { VERSION } from './version.ts';

export interface IO {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Asks a yes/no question on the terminal. Must resolve false when there is no terminal. */
  confirm: (question: string) => Promise<boolean>;
  interactive: boolean;
  color: boolean;
  env: Env;
  platform: NodeJS.Platform;
  cwd: string;
  now: () => number;
  runner?: Runner;
  which?: (name: string) => string | undefined;
}

export class UsageError extends Error {}

function fmt(f: string | undefined): Format {
  if (f === undefined) return 'text';
  if (f === 'text' || f === 'md' || f === 'json') return f;
  throw new UsageError(`--format must be text, md or json`);
}

function hostOpt(h: string | undefined): HostId | 'all' | undefined {
  if (h === undefined) return undefined;
  if (h === 'claude' || h === 'codex' || h === 'all') return h;
  throw new UsageError('--host must be claude, codex or all');
}

async function session(io: IO, root: string | undefined, extra: { task?: string; host?: string; skipScan?: boolean } = {}): Promise<Session> {
  const host = hostOpt(extra.host);
  return openSession({
    root: path.resolve(io.cwd, root ?? '.'),
    env: io.env,
    platform: io.platform,
    now: io.now,
    ...(extra.task ? { task: extra.task } : {}),
    ...(host ? { host } : {}),
    ...(extra.skipScan ? { skipScan: true } : {}),
    ...(io.which ? { which: io.which } : {}),
  });
}

function json(io: IO, value: unknown): void {
  io.out(JSON.stringify(value, null, 2));
}

function warn(io: IO, s: Session, format: Format): void {
  if (format === 'json') return;
  for (const w of s.warnings.slice(0, 8)) io.err(`warning: ${sanitizeLine(w, 300)}`);
}

// ---------------- scan / recommend / explain ----------------

export async function cmdScan(io: IO, o: { path?: string; format?: string; task?: string }): Promise<number> {
  const format = fmt(o.format);
  const s = await session(io, o.path, o.task ? { task: o.task } : {});
  if (format === 'json') {
    json(io, { root: s.root, stats: s.ctx.stats, git: { ...s.ctx.git, recentSubjects: s.ctx.git.recentSubjects.length }, signals: s.ctx.signals, warnings: s.warnings });
    return 0;
  }
  warn(io, s, format);
  io.out(renderScan(style(format, io.color), s.ctx));
  return 0;
}

export async function cmdRecommend(io: IO, o: { path?: string; task?: string; host?: string; format?: string; limit?: string; minScore?: string; all?: boolean }): Promise<number> {
  const format = fmt(o.format);
  const s = await session(io, o.path, { ...(o.task ? { task: o.task } : {}), ...(o.host ? { host: o.host } : {}) });
  const limit = o.limit ? Number(o.limit) : 8;
  const minScore = o.minScore !== undefined ? Number(o.minScore) : o.all ? 0 : undefined;
  if (!Number.isFinite(limit) || limit < 1) throw new UsageError('--limit must be a positive number');
  if (minScore !== undefined && (!Number.isFinite(minScore) || minScore < 0 || minScore > 100)) throw new UsageError('--min-score must be 0..100');
  const r = runRecommend(s, { limit, ...(minScore !== undefined ? { minScore } : {}), includeDismissed: Boolean(o.all) });
  if (format === 'json') {
    json(io, {
      version: VERSION,
      root: s.root,
      hosts: s.hosts,
      task: s.ctx.task ?? null,
      recommendations: r.recommendations.map(recommendationJson),
      alreadyAvailable: r.alreadyAvailable.map(recommendationJson),
      suppressed: r.suppressed,
      warnings: s.warnings,
      note: 'Scores are heuristic, not measurements.',
    });
    return 0;
  }
  warn(io, s, format);
  io.out(renderRecommendations(style(format, io.color), s.ctx, s.hosts, r.recommendations, r.alreadyAvailable));
  return 0;
}

export function explainPreviews(entry: RegistryEntry, hosts: HostId[], platform: NodeJS.Platform): Partial<Record<HostId, string>> {
  const out: Partial<Record<HostId, string>> = {};
  if (entry.kind !== 'mcp' || !entry.install) return out;
  for (const h of hosts) {
    if (entry.hosts[h].support === 'no') continue;
    try {
      const r = resolveSpec(entry, h, {});
      out[h] =
        h === 'claude'
          ? JSON.stringify({ [r.serverName]: claudeServerJson(r, platform) }, null, 2)
          : tomlTable(['mcp_servers', r.serverName], codexServerTable(r, platform));
    } catch (e) {
      if (e instanceof SpecError) out[h] = `(needs input: ${e.message})`;
    }
  }
  return out;
}

export async function cmdExplain(io: IO, o: { id: string; path?: string; host?: string; format?: string; task?: string }): Promise<number> {
  const format = fmt(o.format);
  const s = await session(io, o.path, { ...(o.host ? { host: o.host } : {}), ...(o.task ? { task: o.task } : {}) });
  const entry = findEntry(s.registry, o.id);
  if (!entry) {
    const near = [...new Set([...suggestIds(s.registry, o.id), ...searchRegistry(s.registry, o.id).slice(0, 2).map((h) => h.entry.id)])].slice(0, 3);
    io.err(`No registry entry "${sanitizeLine(o.id, 60)}".${near.length ? ` Did you mean: ${near.join(', ')}?` : ''}`);
    return 1;
  }
  const r = runRecommend(s, { minScore: 0, limit: 500, includeDismissed: true });
  const rec = [...r.recommendations, ...r.alreadyAvailable].find((x) => x.id === entry.id);
  if (format === 'json') {
    json(io, { entry: redactDeep(entry), recommendation: rec ? recommendationJson(rec) : null, previews: explainPreviews(entry, s.hosts, s.platform) });
    return 0;
  }
  io.out(renderExplain(style(format, io.color), rec, entry, s.hosts, explainPreviews(entry, s.hosts, s.platform), s.ctx));
  return 0;
}

// ---------------- registry ----------------

export async function cmdRegistrySearch(io: IO, o: { query: string; kind?: string; remote?: boolean; format?: string; legacy?: boolean }): Promise<number> {
  const format = fmt(o.format);
  const s = await session(io, undefined, { skipScan: true });
  const kind = o.kind as RegistryEntry['kind'] | undefined;
  if (kind && !['mcp', 'plugin', 'skill', 'cli'].includes(kind)) throw new UsageError('--kind must be mcp, plugin, skill or cli');
  const hits = searchRegistry(s.registry, o.query, { ...(kind ? { kind } : {}), includeLegacy: Boolean(o.legacy) }).slice(0, 25);
  let remote: Awaited<ReturnType<typeof searchRemote>> | undefined;
  if (o.remote) {
    if (!s.config.network) {
      io.err('Remote search sends your query to registry.modelcontextprotocol.io. Allow it once with `stackhint config set network true`.');
      return 3;
    }
    remote = await searchRemote(o.query, { cacheDir: s.store.cacheDir, now: s.now() });
  }
  if (format === 'json') {
    json(io, { results: hits.map((h) => ({ id: h.entry.id, name: h.entry.name, kind: h.entry.kind, official: h.entry.official, status: h.entry.status, score: h.score })), remote: remote ?? null });
    return 0;
  }
  const st = style(format, io.color);
  if (hits.length === 0) io.out('No matches in the local registry.');
  for (const h of hits) {
    const e = h.entry;
    io.out(`${st.c.bold(e.id.padEnd(22))} ${e.name} ${st.c.dim(`[${e.kind}, ${e.official ? 'official' : 'community'}${e.status !== 'active' ? `, ${e.status}` : ''}]`)}`);
    io.out(`${' '.repeat(23)}${st.c.dim(sanitizeLine(e.description, 110))}`);
  }
  if (remote) {
    io.out('');
    io.out(st.c.bold('Official MCP Registry (unverified listings, not curated, cannot be installed with stackhint):'));
    if (!remote.ok) io.out(st.c.yellow(`  unavailable: ${remote.error ?? 'unknown error'}; local results above still apply`));
    if (remote.stale) io.out(st.c.yellow(`  network failed (${remote.error}); showing cached results from ${remote.fetchedAt}`));
    for (const l of remote.listings.slice(0, 15)) {
      io.out(`  ${l.name}${l.version ? ` ${l.version}` : ''}${l.status && l.status !== 'active' ? ` (${l.status})` : ''}`);
      if (l.description) io.out(`    ${st.c.dim(sanitizeLine(l.description, 140))}`);
      if (l.repository) io.out(`    ${st.c.dim(l.repository)}`);
    }
  }
  return 0;
}

export async function cmdRegistryList(io: IO, o: { kind?: string; format?: string; legacy?: boolean }): Promise<number> {
  return cmdRegistrySearch(io, { query: '', ...(o.kind ? { kind: o.kind } : {}), ...(o.format ? { format: o.format } : {}), ...(o.legacy ? { legacy: true } : {}) });
}

// ---------------- check / status ----------------

export async function cmdCheck(io: IO, o: { path?: string; host?: string; format?: string; strict?: boolean }): Promise<number> {
  const format = fmt(o.format);
  const s = await session(io, o.path, { ...(o.host ? { host: o.host } : {}), skipScan: true });
  const findings = checkConfig(s.registry, s.inventory, s.hosts);
  const failing = findings.filter((f) => f.severity === 'high' || f.severity === 'medium').length;
  if (format === 'json') {
    json(io, { hosts: s.hosts, findings, registryWarnings: s.registry.warnings });
  } else {
    warn(io, s, format);
    const st = style(format, io.color);
    io.out(`Hosts checked: ${s.hosts.map(hostLabel).join(', ')}. Registry: ${s.registry.entries.length} entries (updated ${s.registry.updated}).`);
    io.out(renderFindings(st, findings));
  }
  return o.strict && failing > 0 ? 1 : 0;
}

export async function cmdStatus(io: IO, o: { path?: string; host?: string; format?: string }): Promise<number> {
  const format = fmt(o.format);
  const s = await session(io, o.path, { ...(o.host ? { host: o.host } : {}), skipScan: true });
  if (format === 'json') {
    json(io, {
      hosts: s.hosts,
      hostsDetected: s.inventory.hostsDetected,
      servers: s.inventory.servers.map((x) => redactDeep({ ...x, args: x.args })),
      plugins: s.inventory.plugins,
      skills: s.inventory.skills,
      executables: Object.keys(s.inventory.executables),
      files: s.inventory.files,
      note: 'Configured servers are not verified as running.',
    });
    return 0;
  }
  warn(io, s, format);
  io.out(renderStatus(style(format, io.color), s.inventory, s.hosts, s.root));
  return 0;
}

// ---------------- install / try ----------------

function parseParams(list: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of list ?? []) {
    const m = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(p);
    if (!m || m[1] === undefined || m[2] === undefined) throw new UsageError(`--param expects name=value, got "${sanitizeLine(p, 60)}"`);
    out[m[1]] = m[2];
  }
  return out;
}

function pickHost(s: Session, requested: string | undefined, entry: RegistryEntry): HostId {
  if (requested === 'claude' || requested === 'codex') return requested;
  if (requested !== undefined) throw new UsageError('--host must be claude or codex for install');
  const candidates = HOST_IDS.filter((h) => s.inventory.hostsDetected[h] && entry.hosts[h].support !== 'no');
  if (candidates.length === 1) return candidates[0] as HostId;
  throw new UsageError(`pass --host claude or --host codex${candidates.length > 1 ? ' (both are set up on this machine)' : ''}`);
}

export async function cmdInstall(
  io: IO,
  o: { id: string; path?: string; host?: string; scope?: string; access?: string; param?: string[]; name?: string; dryRun?: boolean; yes?: boolean; force?: boolean; verify?: boolean; format?: string },
): Promise<number> {
  const format = fmt(o.format);
  const s = await session(io, o.path, { skipScan: true, ...(o.host === 'claude' || o.host === 'codex' ? { host: o.host } : {}) });
  const entry = findEntry(s.registry, o.id);
  if (!entry) {
    io.err(`No registry entry "${sanitizeLine(o.id, 60)}".${hint(s, o.id)} Search with: stackhint registry search <words>`);
    return 1;
  }
  const host = pickHost(s, o.host, entry);
  if (o.scope !== undefined && !['user', 'project', 'local'].includes(o.scope)) throw new UsageError('--scope must be user, project or local');
  if (o.access !== undefined && o.access !== 'read' && o.access !== 'write') throw new UsageError('--access must be read or write');
  const plan = planInstall({
    entry,
    host,
    projectRoot: s.root,
    inventory: s.inventory,
    env: s.env,
    platform: s.platform,
    now: s.now(),
    params: parseParams(o.param),
    ...(o.scope ? { scope: o.scope as Scope } : {}),
    ...(o.access ? { access: o.access as Access } : {}),
    ...(o.name ? { name: o.name } : {}),
    ...(o.force ? { force: true } : {}),
  });
  const st = style(format, io.color);
  if (format !== 'json') io.out(renderPlan(st, plan));

  const approve = async (): Promise<boolean> => {
    if (o.yes) return true;
    if (!io.interactive) {
      io.err('\nNo terminal to confirm in. Re-run in a terminal, or pass --yes to approve this exact change.');
      return false;
    }
    return io.confirm(`\nApply this change to ${plan.method === 'file' ? displayPath(plan.target?.path ?? '') : `${hostLabel(host)} via its CLI`}? [y/N] `);
  };
  const result = await applyPlan(plan, {
    store: s.store,
    projectRoot: s.root,
    approve,
    env: s.env,
    platform: s.platform,
    now: s.now,
    ...(o.dryRun ? { dryRun: true } : {}),
    ...(o.verify ? { verify: true } : {}),
    ...(io.runner ? { runner: io.runner } : {}),
  });
  if (format === 'json') {
    json(io, { plan: { ...plan, resolved: undefined, target: plan.target ? { path: plan.target.path, existed: plan.target.existed } : undefined }, result });
  } else {
    io.out('');
    io.out(renderApply(st, plan, result));
  }
  switch (result.status) {
    case 'applied':
    case 'dry-run':
    case 'guided':
      return 0;
    case 'declined':
      return 3;
    case 'blocked':
      return 4;
    default:
      return 1;
  }
}

export async function cmdTry(io: IO, o: { id: string; path?: string; host?: string; param?: string[]; access?: string }): Promise<number> {
  const s = await session(io, o.path, { skipScan: true });
  const entry = findEntry(s.registry, o.id);
  if (!entry) {
    io.err(`No registry entry "${sanitizeLine(o.id, 60)}".${hint(s, o.id)}`);
    return 1;
  }
  const host = pickHost(s, o.host, entry);
  if (entry.kind !== 'mcp' || !entry.install) {
    io.out(`${entry.name} is not an MCP server, so there is no one-off mode. Steps: stackhint explain ${entry.id}`);
    return 0;
  }
  let r;
  try {
    r = resolveSpec(entry, host, { params: parseParams(o.param), ...(o.access === 'write' || o.access === 'read' ? { access: o.access } : {}) });
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  }
  if (host === 'claude') {
    const file = path.join(s.store.home, 'try', `${entry.id}.mcp.json`);
    writeAtomic(file, JSON.stringify({ mcpServers: { [r.serverName]: claudeServerJson(r, s.platform) } }, null, 2) + '\n');
    io.out(`Wrote a temporary MCP config to ${displayPath(file)} (your Claude Code config is not changed).`);
    io.out('Start one session with it:');
    io.out(`  ${tryCommand('claude', r, file, s.platform)}`);
  } else {
    io.out('Start one Codex session with the server (config.toml is not changed):');
    io.out(`  ${tryCommand('codex', r, '', s.platform)}`);
  }
  if (r.requiredEnv.length) io.out(`It needs ${r.requiredEnv.join(', ')} set in that shell.`);
  return 0;
}

// ---------------- dismiss / rollback ----------------

export async function cmdDismiss(io: IO, o: { id: string; for?: string; project?: boolean; reason?: string; path?: string }): Promise<number> {
  const s = await session(io, o.path, { skipScan: true });
  const entry = findEntry(s.registry, o.id);
  if (!entry) {
    io.err(`No registry entry "${sanitizeLine(o.id, 60)}".${hint(s, o.id)}`);
    return 1;
  }
  let forMs: number | undefined;
  if (o.for !== undefined) {
    forMs = parseDuration(o.for);
    if (!forMs) throw new UsageError('--for expects a duration like 30m, 12h, 14d or 2w');
  }
  const d = s.store.dismiss(entry.id, { ...(forMs ? { forMs } : {}), ...(o.project ? { projectKey: s.projectKey } : {}), ...(o.reason ? { reason: o.reason } : {}) });
  io.out(`${entry.name}: hidden ${d.until ? `until ${d.until.slice(0, 16).replace('T', ' ')}` : 'for good'}${d.project ? ' in this project' : ''}. Undo with: stackhint undismiss ${entry.id}`);
  return 0;
}

export async function cmdUndismiss(io: IO, o: { id: string }): Promise<number> {
  const store = new Store(io.env, io.now);
  const had = store.undismiss(o.id.toLowerCase());
  io.out(had ? `${o.id} can be suggested again.` : `${o.id} was not dismissed.`);
  return 0;
}

export async function cmdDismissed(io: IO): Promise<number> {
  const store = new Store(io.env, io.now);
  const state = store.loadState();
  const ids = Object.keys(state.dismissed).filter((id) => (state.dismissed[id] ?? []).length);
  if (!ids.length) io.out('Nothing dismissed.');
  for (const id of ids) {
    for (const d of state.dismissed[id] ?? []) io.out(`${id}: ${d.until ? `until ${d.until.slice(0, 10)}` : 'forever'}${d.project ? ' (one project)' : ''}${d.reason ? ` - ${sanitizeLine(d.reason, 80)}` : ''}`);
  }
  return 0;
}

export async function cmdRollback(io: IO, o: { id?: string; yes?: boolean; force?: boolean }): Promise<number> {
  const store = new Store(io.env, io.now);
  if (!o.id) {
    const list = listBackups(store);
    if (!list.length) {
      io.out('No installs to roll back.');
      return 0;
    }
    io.out('Installs made by stackhint (newest first):');
    for (const m of list.slice(0, 20)) {
      io.out(`  ${m.id}  ${m.entryId} -> ${hostLabel(m.host)} ${m.scope}${m.target ? ` (${displayPath(m.target, io.env)})` : ''}${m.rolledBack ? '  [rolled back]' : ''}`);
    }
    io.out('Roll one back with: stackhint rollback <id>');
    return 0;
  }
  const res = await rollback(o.id, {
    store,
    ...(o.force ? { force: true } : {}),
    env: io.env,
    ...(io.runner ? { runner: io.runner } : {}),
    approve: async (description) => {
      io.out(description);
      if (o.yes) return true;
      if (!io.interactive) {
        io.err('No terminal to confirm in; pass --yes to approve.');
        return false;
      }
      return io.confirm('Proceed? [y/N] ');
    },
  });
  (res.status === 'done' ? io.out : io.err)(res.message);
  return res.status === 'done' ? 0 : res.status === 'declined' ? 3 : 1;
}

// ---------------- config / doctor ----------------

export async function cmdConfig(io: IO, o: { action?: string; key?: string; value?: string }): Promise<number> {
  const store = new Store(io.env, io.now);
  const action = o.action ?? 'show';
  if (action === 'show' || action === 'get') {
    const { config, warnings } = store.loadConfig();
    for (const w of warnings) io.err(`warning: ${w}`);
    if (action === 'get' && o.key) {
      const v = o.key.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), config);
      if (v === undefined) throw new UsageError(`unknown config key "${o.key}"`);
      io.out(typeof v === 'object' ? JSON.stringify(v) : String(v));
      return 0;
    }
    io.out(JSON.stringify(config, null, 2));
    io.out(`(file: ${displayPath(store.configPath, io.env)})`);
    return 0;
  }
  if (action === 'set') {
    if (!o.key || o.value === undefined) throw new UsageError('usage: stackhint config set <key> <value>');
    try {
      store.setConfig(o.key, o.value);
    } catch (e) {
      io.err((e as Error).message);
      return 2;
    }
    io.out(`${o.key} = ${o.value}`);
    return 0;
  }
  throw new UsageError(`config ${action}: use show, get <key> or set <key> <value>. Keys: ${Object.keys(CONFIG_KEYS).join(', ')}`);
}

export async function cmdDoctor(io: IO, o: { path?: string }): Promise<number> {
  const s = await session(io, o.path, { skipScan: true });
  const ok = (m: string): void => io.out(`  ok    ${m}`);
  const bad = (m: string): void => io.out(`  FIX   ${m}`);
  const note = (m: string): void => io.out(`  note  ${m}`);
  let problems = 0;
  io.out(`stackhint ${VERSION} on Node.js ${process.versions.node} (${s.platform})`);
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) ok('Node.js 20 or newer');
  else {
    bad('Node.js 20 or newer is required');
    problems++;
  }
  try {
    fs.mkdirSync(s.store.home, { recursive: true });
    fs.accessSync(s.store.home, fs.constants.W_OK);
    ok(`state directory writable: ${displayPath(s.store.home, io.env)}`);
  } catch {
    bad(`cannot write to ${displayPath(s.store.home, io.env)} (set STACKHINT_HOME to another folder)`);
    problems++;
  }
  ok(`registry: ${s.registry.entries.length} entries, updated ${s.registry.updated}`);
  for (const w of s.registry.warnings) {
    bad(`registry: ${sanitizeLine(w, 200)}`);
    problems++;
  }
  const { warnings: cw, config } = s.store.loadConfig();
  for (const w of cw) {
    bad(w);
    problems++;
  }
  note(`mode: ${config.mode}; network: ${config.network ? 'allowed' : 'off'}; git history: ${config.gitHistory ? 'read' : 'off'}`);
  for (const h of HOST_IDS) {
    const cli = s.inventory.hostCli[h];
    if (cli) {
      const r = await (io.runner ?? ((exe: string, argv: string[]) => run(exe, argv, { timeoutMs: 8000 })))(cli, ['--version'], {});
      ok(`${hostLabel(h)} CLI: ${displayPath(cli, io.env)}${r.code === 0 ? ` (${sanitizeLine(r.stdout.trim(), 60)})` : ''}`);
    } else if (s.inventory.hostsDetected[h]) note(`${hostLabel(h)} config found but its CLI is not on PATH (installs that need the CLI will be blocked)`);
    else note(`${hostLabel(h)} not found on this machine`);
  }
  for (const f of s.inventory.files) {
    if (f.error) {
      bad(`${hostLabel(f.host)} ${f.kind}: ${f.error} (${displayPath(f.path, io.env)})`);
      problems++;
    }
  }
  if (s.inventory.managedMcp) note(`managed MCP config present: ${s.inventory.managedMcp}`);
  for (const x of ['npx', 'uvx', 'docker', 'git']) {
    if (s.inventory.executables[x]) ok(`${x} on PATH`);
    else note(`${x} not on PATH (some servers need it)`);
  }
  const hooked = s.inventory.plugins.some((p) => p.id.startsWith('stackhint@') && p.enabled);
  note(hooked ? 'stackhint plugin is enabled in Claude Code (session hints active)' : 'stackhint plugin not enabled in Claude Code; hints only on request');
  for (const w of s.inventory.warnings) note(w);
  io.out(problems ? `${problems} problem${problems === 1 ? '' : 's'} found.` : 'No problems found.');
  return problems ? 1 : 0;
}

// ---------------- setup (stackhint itself, without the plugin) ----------------

export function cliPath(): string {
  // dist/commands.js -> dist/cli.js ; src/commands.ts -> src/cli.ts
  const here = path.dirname(fileURLToPath(import.meta.url));
  const js = path.join(here, 'cli.js');
  return fs.existsSync(js) ? js : path.join(here, 'cli.ts');
}

function selfEntry(nodePath: string, cli: string): RegistryEntry {
  return {
    id: 'stackhint',
    name: 'stackhint MCP server',
    kind: 'mcp',
    category: 'workflow',
    description: 'stackhint itself as a read-only MCP server.',
    vendor: 'stackhint',
    official: false,
    credibility: 'community',
    docs: 'https://github.com/Protemir/stackhint',
    status: 'active',
    verifiedAt: '',
    platforms: ['windows', 'macos', 'linux'],
    provides: ['stackhint'],
    triggers: [],
    problem: '',
    workflow: '',
    benefits: [],
    access: { level: 'read', summary: 'Reads project files and agent configs locally; never installs anything over MCP.', readOnlyAvailable: true },
    auth: { type: 'none', detail: 'None.' },
    network: 'None (local only).',
    setup: { effort: 'low', minutes: 1 },
    value: { timeSaved: 1, frequency: 'weekly' },
    hosts: { claude: { support: 'yes' }, codex: { support: 'yes' } },
    install: { serverName: 'stackhint', readOnly: { transport: 'stdio', command: nodePath, args: [cli, 'mcp'] } },
    match: { packages: ['stackhint'] },
    limitations: [],
    securityNotes: [],
    origin: 'builtin',
    incomplete: [],
  };
}

export async function cmdSetup(io: IO, o: { host?: string; dryRun?: boolean; yes?: boolean; path?: string }): Promise<number> {
  const host = o.host;
  if (host !== 'claude' && host !== 'codex') throw new UsageError('usage: stackhint setup <claude|codex> [--dry-run] [--yes]');
  const s = await session(io, o.path, { skipScan: true, host });
  const cli = cliPath();
  if (cli.endsWith('.ts')) {
    io.err('Run setup from the built package (dist/cli.js), not from the TypeScript sources.');
    return 1;
  }
  const nodeExe = process.execPath;
  io.out(`stackhint ${VERSION}: setting up ${hostLabel(host)} without the plugin.`);
  io.out(host === 'claude'
    ? 'Recommended instead: the plugin gives you the skill plus session hints.\n  /plugin marketplace add Protemir/stackhint\n  /plugin install stackhint@stackhint\n'
    : 'Recommended instead: codex plugin marketplace add Protemir/stackhint, then install "stackhint" from /plugins.\n');

  // 1) MCP server registration via the normal install flow.
  const entry = selfEntry(nodeExe, cli);
  const plan = planInstall({ entry, host, projectRoot: s.root, inventory: s.inventory, env: s.env, platform: s.platform, scope: 'user', now: s.now() });
  io.out(renderPlan(style('text', io.color), plan));

  // 2) Skill copy with the CLI path filled in.
  const skillSrc = path.resolve(path.dirname(cli), '..', 'skills', 'stackhint', 'SKILL.md');
  const skillText = readText(skillSrc);
  const skillDir = host === 'claude' ? path.join(io.env['CLAUDE_CONFIG_DIR'] ?? path.join(homeOf(io.env), '.claude'), 'skills', 'stackhint') : path.join(homeOf(io.env), '.agents', 'skills', 'stackhint');
  const skillTarget = path.join(skillDir, 'SKILL.md');
  const skillExists = fs.existsSync(skillTarget);
  if (skillText) io.out(`\nSkill: ${skillExists ? 'replace' : 'create'} ${displayPath(skillTarget, io.env)} (CLI path: ${displayPath(cli, io.env)})`);

  if (o.dryRun) {
    io.out('\nDry run: nothing was changed.');
    return 0;
  }
  const go = o.yes || (io.interactive && (await io.confirm('\nApply these changes? [y/N] ')));
  if (!go) {
    io.err(io.interactive ? 'Not approved; nothing was changed.' : 'No terminal to confirm in; pass --yes to approve.');
    return 3;
  }
  const result = await applyPlan(plan, { store: s.store, projectRoot: s.root, approve: async () => true, env: s.env, platform: s.platform, now: s.now, ...(io.runner ? { runner: io.runner } : {}) });
  io.out(renderApply(style('text', io.color), plan, result));
  if (skillText) {
    const filled = skillText.replace(/`stackhint` if it is on PATH\./, `\`node "${cli}"\` (installed by stackhint setup), or \`stackhint\` if it is on PATH.`);
    writeAtomic(skillTarget, filled);
    s.store.audit('setup-skill', { host, target: skillTarget });
    io.out(`Skill written to ${displayPath(skillTarget, io.env)}. Remove that folder to undo.`);
  }
  return result.status === 'applied' || result.status === 'blocked' ? 0 : 1;
}

function homeOf(env: Env): string {
  return env['STACKHINT_TEST_HOME'] ?? env['HOME'] ?? env['USERPROFILE'] ?? process.cwd();
}

// ---------------- helpers for the CLI ----------------

function hint(s: Session, id: string): string {
  const near = suggestIds(s.registry, id);
  return near.length ? ` Did you mean: ${near.join(', ')}?` : '';
}

export function hasHost(s: string | undefined): s is HostId {
  return s === 'claude' || s === 'codex';
}

export { isLegacy, which };
