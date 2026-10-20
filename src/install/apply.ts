// Applying an approved plan, with backup, validation and rollback.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { HostId } from '../types.ts';
import { readClaudeInventory } from '../hosts/claude.ts';
import { decodeConfig, readBytes, readJson, sha256, writeAtomic } from '../util/fsx.ts';
import { run, which, type RunResult } from '../util/exec.ts';
import { displayPath, samePath, type Env } from '../util/paths.ts';
import { redactString } from '../util/redact.ts';
import { parseToml } from '../util/toml.ts';
import type { Store } from '../state/store.ts';
import { targetBytes, type InstallPlan } from './plan.ts';

export type Runner = (exe: string, argv: string[], opts: { cwd?: string; env?: Env }) => Promise<RunResult>;

export interface ApplyContext {
  store: Store;
  projectRoot: string;
  /** Must return true only after an explicit user approval. */
  approve: (plan: InstallPlan) => Promise<boolean>;
  dryRun?: boolean;
  /** Run read-only verification with the host CLI when available. */
  verify?: boolean;
  runner?: Runner;
  env?: Env;
  platform?: NodeJS.Platform;
  now?: () => number;
}

export type ApplyStatus = 'dry-run' | 'declined' | 'applied' | 'failed' | 'blocked' | 'guided';

export interface ApplyResult {
  status: ApplyStatus;
  message: string;
  backupId?: string;
  verification: string[];
  rollback?: string;
}

export interface BackupManifest {
  id: string;
  at: string;
  entryId: string;
  host: HostId;
  scope: string;
  method: 'file' | 'cli';
  serverName: string;
  target?: string;
  existedBefore?: boolean;
  beforeHash?: string;
  afterHash?: string;
  /** Folders the install created for the target file; rollback removes them again if empty. */
  createdDirs?: string[];
  /** For CLI installs: the command that undoes it, and where it must run. */
  undoArgv?: string[];
  undoExe?: string;
  projectRoot?: string;
  rolledBack?: string;
}

const defaultRunner: Runner = (exe, argv, opts) => run(exe, argv, { timeoutMs: 120_000, ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.env ? { env: opts.env } : {}) });

function newBackupId(now: number, entryId: string, host: string): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `${stamp}-${entryId}-${host}-${randomBytes(2).toString('hex')}`;
}

export async function applyPlan(plan: InstallPlan, ctx: ApplyContext): Promise<ApplyResult> {
  const now = ctx.now ?? Date.now;
  if (plan.blocked) return { status: 'blocked', message: plan.blocked, verification: [] };
  if (plan.method === 'guided') {
    return { status: 'guided', message: 'Nothing to apply automatically for this entry; follow the steps shown.', verification: [] };
  }
  if (ctx.dryRun) return { status: 'dry-run', message: 'Dry run: nothing was changed.', verification: [] };

  const approved = await ctx.approve(plan);
  if (!approved) {
    ctx.store.audit('install-declined', { entry: plan.entryId, host: plan.host, scope: plan.scope });
    return { status: 'declined', message: 'Not approved; nothing was changed.', verification: [] };
  }

  if (plan.method === 'file') return applyFile(plan, ctx, now());
  return applyCli(plan, ctx, now());
}

async function applyFile(plan: InstallPlan, ctx: ApplyContext, nowMs: number): Promise<ApplyResult> {
  const target = plan.target;
  if (!target) return { status: 'failed', message: 'plan has no target file', verification: [] };
  const current = readBytes(target.path, 4 * 1024 * 1024) ?? Buffer.alloc(0);
  const existsNow = fs.existsSync(target.path);
  if (sha256(current) !== target.beforeHash || existsNow !== target.existed) {
    return { status: 'failed', message: `${displayPath(target.path)} changed after the plan was made; run the command again to see a fresh plan.`, verification: [] };
  }

  const afterBytes = targetBytes(target);
  const createdDirs = missingDirs(path.dirname(target.path));
  const id = newBackupId(nowMs, plan.entryId, plan.host);
  const dir = path.join(ctx.store.backupsDir, id);
  const manifest: BackupManifest = {
    id,
    at: new Date(nowMs).toISOString(),
    entryId: plan.entryId,
    host: plan.host,
    scope: plan.scope,
    method: 'file',
    serverName: plan.serverName,
    target: target.path,
    existedBefore: target.existed,
    beforeHash: target.beforeHash,
    afterHash: sha256(afterBytes),
    ...(createdDirs.length ? { createdDirs } : {}),
  };
  // Config files can hold tokens: keep backups private to the user.
  privateDir(ctx.store.backupsDir);
  privateDir(dir);
  // The backup keeps the exact bytes, so rollback restores the file byte for byte.
  if (target.existed) fs.writeFileSync(path.join(dir, 'original'), current, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  const dropBackup = (): void => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  try {
    writeAtomic(target.path, afterBytes);
  } catch (e) {
    dropBackup();
    removeEmptyDirs(createdDirs);
    return { status: 'failed', message: `could not write ${displayPath(target.path)}: ${(e as Error).message}`, verification: [] };
  }

  const verification: string[] = [];
  const problem = validateWritten(plan, target.path, afterBytes);
  if (problem) {
    restore(target.path, target.existed, current);
    removeEmptyDirs(createdDirs);
    dropBackup();
    ctx.store.audit('install-failed', { entry: plan.entryId, host: plan.host, target: target.path, reason: problem });
    return { status: 'failed', message: `validation failed, the original file was restored: ${problem}`, verification };
  }
  verification.push(`${displayPath(target.path)} parses and contains "${plan.serverName}"`);

  const runner = ctx.runner ?? defaultRunner;
  if (plan.host === 'codex' && plan.scope === 'user') {
    const exe = findHostCli('codex', ctx);
    if (exe) {
      const res = await runner(exe, ['mcp', 'get', plan.serverName, '--json'], { env: ctx.env ?? process.env });
      if (res.code === 0 && /"name"\s*:\s*"/.test(res.stdout)) verification.push('`codex mcp get` reads the new server');
      else verification.push(`\`codex mcp get\` could not confirm it (exit ${res.code}): ${redactString(res.stderr || res.error || '').slice(0, 200)}`);
    }
  }
  if (plan.host === 'claude' && ctx.verify) {
    const exe = findHostCli('claude', ctx);
    if (exe) {
      const res = await runner(exe, ['mcp', 'get', plan.serverName], { cwd: ctx.projectRoot, env: ctx.env ?? process.env });
      verification.push(res.code === 0 ? '`claude mcp get` lists the server' : `\`claude mcp get\` exit ${res.code}: ${redactString(res.stderr).slice(0, 200)}`);
    }
  }

  ctx.store.audit('install', { entry: plan.entryId, host: plan.host, scope: plan.scope, method: 'file', target: target.path, backup: id, server: plan.serverName, access: plan.access });
  return { status: 'applied', message: `Added "${plan.serverName}" to ${displayPath(target.path)}.`, backupId: id, verification, rollback: `stackhint rollback ${id}` };
}

function findHostCli(host: HostId, ctx: ApplyContext): string | undefined {
  return which(host, ctx.env ?? process.env, ctx.platform ?? process.platform);
}

function validateWritten(plan: InstallPlan, file: string, expected: Buffer): string | undefined {
  const bytes = readBytes(file, 4 * 1024 * 1024);
  if (bytes === undefined) return 'file cannot be read back';
  if (sha256(bytes) !== sha256(expected)) return 'file content differs from the plan';
  const text = decodeConfig(bytes)?.text;
  if (text === undefined) return 'file is not valid UTF-8 after the write';
  try {
    if (plan.target?.format === 'json') {
      const doc = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
      if (!doc.mcpServers || !doc.mcpServers[plan.serverName]) return 'server missing after write';
    } else {
      const doc = parseToml(text) as { mcp_servers?: Record<string, unknown> };
      if (!doc.mcp_servers || !doc.mcp_servers[plan.serverName]) return 'server missing after write';
    }
  } catch (e) {
    return (e as Error).message;
  }
  return undefined;
}

function restore(file: string, existed: boolean, content: Buffer): void {
  if (existed) writeAtomic(file, content);
  else fs.rmSync(file, { force: true });
}

/** Ancestors of `dir` that do not exist yet, deepest first. */
function missingDirs(dir: string): string[] {
  const out: string[] = [];
  let p = dir;
  while (!fs.existsSync(p) && path.dirname(p) !== p) {
    out.push(p);
    p = path.dirname(p);
  }
  return out;
}

/** Remove folders an install created, deepest first, but only while they are empty. */
function removeEmptyDirs(dirs: string[]): void {
  for (const d of dirs) {
    try {
      fs.rmdirSync(d);
    } catch {
      return;
    }
  }
}

async function applyCli(plan: InstallPlan, ctx: ApplyContext, nowMs: number): Promise<ApplyResult> {
  if (!plan.exe || !plan.argv) return { status: 'failed', message: 'plan has no command', verification: [] };
  const runner = ctx.runner ?? defaultRunner;
  const res = await runner(plan.exe, plan.argv, { cwd: ctx.projectRoot, env: ctx.env ?? process.env });
  if (res.code !== 0) {
    ctx.store.audit('install-failed', { entry: plan.entryId, host: plan.host, method: 'cli', code: res.code });
    return { status: 'failed', message: `the host CLI failed (exit ${res.code}): ${redactString((res.stderr || res.stdout || res.error || '').trim()).slice(0, 500)}`, verification: [] };
  }
  const verification: string[] = [];
  if (plan.host === 'claude' && plan.argv[0] === 'mcp') {
    const inv = readClaudeInventory(ctx.projectRoot, ctx.env ?? process.env, ctx.platform ?? process.platform);
    const found = inv.servers.find((s) => s.name === plan.serverName && s.scope === plan.scope);
    verification.push(found ? `~/.claude.json now has "${plan.serverName}" in ${plan.scope} scope` : `could not find "${plan.serverName}" in ~/.claude.json after the command; check \`claude mcp list\``);
  } else {
    verification.push(`\`${path.basename(plan.exe)} ${plan.argv.slice(0, 3).join(' ')}\` exited 0`);
  }
  const id = newBackupId(nowMs, plan.entryId, plan.host);
  const undoArgv = plan.argv[0] === 'mcp' ? ['mcp', 'remove', plan.serverName, '--scope', plan.scope] : plan.argv[0] === 'plugin' ? ['plugin', 'uninstall', plan.argv[2] as string, '--scope', plan.scope] : undefined;
  const manifest: BackupManifest = {
    id,
    at: new Date(nowMs).toISOString(),
    entryId: plan.entryId,
    host: plan.host,
    scope: plan.scope,
    method: 'cli',
    serverName: plan.serverName,
    ...(undoArgv ? { undoArgv, undoExe: plan.exe } : {}),
    projectRoot: ctx.projectRoot,
  };
  const dir = path.join(ctx.store.backupsDir, id);
  privateDir(ctx.store.backupsDir);
  privateDir(dir);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  ctx.store.audit('install', { entry: plan.entryId, host: plan.host, scope: plan.scope, method: 'cli', backup: id, server: plan.serverName, access: plan.access });
  return { status: 'applied', message: `Installed ${plan.entryName} for ${plan.host === 'claude' ? 'Claude Code' : 'Codex'}.`, backupId: id, verification, rollback: `stackhint rollback ${id}` };
}

// ---------------- rollback ----------------

export function listBackups(store: Store): BackupManifest[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(store.backupsDir);
  } catch {
    return [];
  }
  const out: BackupManifest[] = [];
  for (const n of names.sort().reverse()) {
    const res = readJson<BackupManifest>(path.join(store.backupsDir, n, 'manifest.json'));
    if (res.ok && res.value && typeof res.value === 'object' && res.value.id === n) out.push(res.value);
  }
  return out;
}

export interface RollbackContext {
  store: Store;
  approve: (description: string) => Promise<boolean>;
  force?: boolean;
  runner?: Runner;
  env?: Env;
}

export async function rollback(id: string, ctx: RollbackContext): Promise<{ status: 'done' | 'declined' | 'failed' | 'not-found'; message: string }> {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return { status: 'not-found', message: 'invalid backup id' };
  const dir = path.join(ctx.store.backupsDir, id);
  const res = readJson<BackupManifest>(path.join(dir, 'manifest.json'));
  if (!res.ok || res.value.id !== id) return { status: 'not-found', message: `no backup "${id}" (see \`stackhint rollback\` for the list)` };
  const m = res.value;
  if (m.rolledBack) return { status: 'failed', message: `already rolled back on ${m.rolledBack}` };

  if (m.method === 'file') {
    if (!m.target) return { status: 'failed', message: 'backup has no target' };
    const currentHash = sha256(readBytes(m.target, 4 * 1024 * 1024) ?? '');
    // Later installs into the same file start from this install's result: restoring this
    // backup would silently drop them (and undoing them later would bring this one back).
    const target = m.target;
    const later = listBackups(ctx.store).filter((b) => b.id !== m.id && b.method === 'file' && !b.rolledBack && b.target !== undefined && samePath(b.target, target) && b.at > m.at);
    if (currentHash !== m.afterHash && !ctx.force) {
      if (later.length) {
        return { status: 'failed', message: `${displayPath(m.target)} was changed again by later installs; roll those back first, newest first: ${[...later].sort((x, y) => y.at.localeCompare(x.at)).map((b) => `stackhint rollback ${b.id}`).join(', then ')}` };
      }
      return { status: 'failed', message: `${displayPath(m.target)} changed after the install; rollback would discard those edits. Re-run with --force to restore the backup anyway.` };
    }
    const description = m.existedBefore ? `Restore ${displayPath(m.target)} to its state before ${m.at}` : `Delete ${displayPath(m.target)} (it did not exist before ${m.at})`;
    if (!(await ctx.approve(description))) return { status: 'declined', message: 'Not approved; nothing was changed.' };
    if (m.existedBefore) {
      const original = readBytes(path.join(dir, 'original'), 8 * 1024 * 1024);
      if (original === undefined) return { status: 'failed', message: 'backup copy is missing' };
      writeAtomic(m.target, original);
    } else {
      fs.rmSync(m.target, { force: true });
      // A folder the install created (say ~/.codex) would otherwise make the host look installed.
      removeEmptyDirs((m.createdDirs ?? []).filter((d) => typeof d === 'string' && path.isAbsolute(d)));
    }
    // The file is now as it was before this install, so the later installs are gone too.
    for (const b of later) {
      b.rolledBack = `${new Date().toISOString()} (undone together with ${m.id})`;
      fs.writeFileSync(path.join(ctx.store.backupsDir, b.id, 'manifest.json'), JSON.stringify(b, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    }
  } else {
    if (!m.undoArgv || !m.undoExe) return { status: 'failed', message: 'this install has no automatic undo; remove it with the host CLI' };
    const cwd = m.projectRoot && fs.existsSync(m.projectRoot) ? m.projectRoot : undefined;
    if (m.undoArgv[0] === 'mcp' && m.host === 'claude') {
      // Remove the server we added, in the project where we added it, and only if it is still there.
      if (m.scope === 'local' && !cwd) return { status: 'failed', message: 'the project folder of this install no longer exists; remove the server with claude mcp remove' };
      const inv = readClaudeInventory(cwd ?? process.cwd(), ctx.env ?? process.env);
      if (!inv.servers.some((s) => s.name === m.serverName && s.scope === m.scope)) {
        return { status: 'failed', message: `"${m.serverName}" is no longer in Claude Code's ${m.scope} scope; nothing to undo` };
      }
    }
    const description = `Run in ${displayPath(cwd ?? process.cwd())}: ${path.basename(m.undoExe)} ${m.undoArgv.join(' ')}`;
    if (!(await ctx.approve(description))) return { status: 'declined', message: 'Not approved; nothing was changed.' };
    const r = await (ctx.runner ?? defaultRunner)(m.undoExe, m.undoArgv, { env: ctx.env ?? process.env, ...(cwd ? { cwd } : {}) });
    if (r.code !== 0) return { status: 'failed', message: `undo command failed (exit ${r.code}): ${redactString(r.stderr).slice(0, 300)}` };
  }
  m.rolledBack = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  ctx.store.audit('rollback', { backup: id, entry: m.entryId, host: m.host });
  return { status: 'done', message: `Rolled back ${m.entryId} (${m.host}).` };
}

function privateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* best effort */
    }
  }
}
