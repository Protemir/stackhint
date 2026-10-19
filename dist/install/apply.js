// Applying an approved plan, with backup, validation and rollback.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readClaudeInventory } from '../hosts/claude.js';
import { readJson, readText, sha256, writeAtomic } from '../util/fsx.js';
import { run, which,                } from '../util/exec.js';
import { displayPath,          } from '../util/paths.js';
import { redactString } from '../util/redact.js';
import { parseToml } from '../util/toml.js';















































const defaultRunner         = (exe, argv, opts) => run(exe, argv, { timeoutMs: 120_000, ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.env ? { env: opts.env } : {}) });

function newBackupId(now        , entryId        , host        )         {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `${stamp}-${entryId}-${host}-${randomBytes(2).toString('hex')}`;
}

export async function applyPlan(plan             , ctx              )                       {
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

async function applyFile(plan             , ctx              , nowMs        )                       {
  const target = plan.target;
  if (!target) return { status: 'failed', message: 'plan has no target file', verification: [] };
  const current = readText(target.path, 4 * 1024 * 1024) ?? '';
  const existsNow = fs.existsSync(target.path);
  if (sha256(current) !== target.beforeHash || existsNow !== target.existed) {
    return { status: 'failed', message: `${displayPath(target.path)} changed after the plan was made; run the command again to see a fresh plan.`, verification: [] };
  }

  const id = newBackupId(nowMs, plan.entryId, plan.host);
  const dir = path.join(ctx.store.backupsDir, id);
  const manifest                 = {
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
    afterHash: sha256(target.after),
  };
  fs.mkdirSync(dir, { recursive: true });
  if (target.existed) fs.writeFileSync(path.join(dir, 'original'), current, 'utf8');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  try {
    writeAtomic(target.path, target.after);
  } catch (e) {
    return { status: 'failed', message: `could not write ${displayPath(target.path)}: ${(e         ).message}`, verification: [] };
  }

  const verification           = [];
  const problem = validateWritten(plan, target.path);
  if (problem) {
    restore(target.path, target.existed, current);
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

function findHostCli(host        , ctx              )                     {
  return which(host, ctx.env ?? process.env, ctx.platform ?? process.platform);
}

function validateWritten(plan             , file        )                     {
  const text = readText(file, 4 * 1024 * 1024);
  if (text === undefined) return 'file cannot be read back';
  if (plan.target && sha256(text) !== sha256(plan.target.after)) return 'file content differs from the plan';
  try {
    if (plan.target?.format === 'json') {
      const doc = JSON.parse(text)                                            ;
      if (!doc.mcpServers || !doc.mcpServers[plan.serverName]) return 'server missing after write';
    } else {
      const doc = parseToml(text)                                             ;
      if (!doc.mcp_servers || !doc.mcp_servers[plan.serverName]) return 'server missing after write';
    }
  } catch (e) {
    return (e         ).message;
  }
  return undefined;
}

function restore(file        , existed         , content        )       {
  if (existed) writeAtomic(file, content);
  else fs.rmSync(file, { force: true });
}

async function applyCli(plan             , ctx              , nowMs        )                       {
  if (!plan.exe || !plan.argv) return { status: 'failed', message: 'plan has no command', verification: [] };
  const runner = ctx.runner ?? defaultRunner;
  const res = await runner(plan.exe, plan.argv, { cwd: ctx.projectRoot, env: ctx.env ?? process.env });
  if (res.code !== 0) {
    ctx.store.audit('install-failed', { entry: plan.entryId, host: plan.host, method: 'cli', code: res.code });
    return { status: 'failed', message: `the host CLI failed (exit ${res.code}): ${redactString((res.stderr || res.stdout || res.error || '').trim()).slice(0, 500)}`, verification: [] };
  }
  const verification           = [];
  if (plan.host === 'claude' && plan.argv[0] === 'mcp') {
    const inv = readClaudeInventory(ctx.projectRoot, ctx.env ?? process.env, ctx.platform ?? process.platform);
    const found = inv.servers.find((s) => s.name === plan.serverName && s.scope === plan.scope);
    verification.push(found ? `~/.claude.json now has "${plan.serverName}" in ${plan.scope} scope` : `could not find "${plan.serverName}" in ~/.claude.json after the command; check \`claude mcp list\``);
  } else {
    verification.push(`\`${path.basename(plan.exe)} ${plan.argv.slice(0, 3).join(' ')}\` exited 0`);
  }
  const id = newBackupId(nowMs, plan.entryId, plan.host);
  const undoArgv = plan.argv[0] === 'mcp' ? ['mcp', 'remove', plan.serverName, '--scope', plan.scope] : plan.argv[0] === 'plugin' ? ['plugin', 'uninstall', plan.argv[2]          ] : undefined;
  const manifest                 = {
    id,
    at: new Date(nowMs).toISOString(),
    entryId: plan.entryId,
    host: plan.host,
    scope: plan.scope,
    method: 'cli',
    serverName: plan.serverName,
    ...(undoArgv ? { undoArgv, undoExe: plan.exe } : {}),
  };
  const dir = path.join(ctx.store.backupsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  ctx.store.audit('install', { entry: plan.entryId, host: plan.host, scope: plan.scope, method: 'cli', backup: id, server: plan.serverName, access: plan.access });
  return { status: 'applied', message: `Installed ${plan.entryName} for ${plan.host === 'claude' ? 'Claude Code' : 'Codex'}.`, backupId: id, verification, rollback: `stackhint rollback ${id}` };
}

// ---------------- rollback ----------------

export function listBackups(store       )                   {
  let names           = [];
  try {
    names = fs.readdirSync(store.backupsDir);
  } catch {
    return [];
  }
  const out                   = [];
  for (const n of names.sort().reverse()) {
    const res = readJson                (path.join(store.backupsDir, n, 'manifest.json'));
    if (res.ok && res.value && typeof res.value === 'object' && res.value.id === n) out.push(res.value);
  }
  return out;
}









export async function rollback(id        , ctx                 )                                                                                     {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return { status: 'not-found', message: 'invalid backup id' };
  const dir = path.join(ctx.store.backupsDir, id);
  const res = readJson                (path.join(dir, 'manifest.json'));
  if (!res.ok || res.value.id !== id) return { status: 'not-found', message: `no backup "${id}" (see \`stackhint rollback\` for the list)` };
  const m = res.value;
  if (m.rolledBack) return { status: 'failed', message: `already rolled back on ${m.rolledBack}` };

  if (m.method === 'file') {
    if (!m.target) return { status: 'failed', message: 'backup has no target' };
    const current = readText(m.target, 4 * 1024 * 1024);
    const currentHash = sha256(current ?? '');
    if (currentHash !== m.afterHash && !ctx.force) {
      return { status: 'failed', message: `${displayPath(m.target)} changed after the install; rollback would discard those edits. Re-run with --force to restore the backup anyway.` };
    }
    const description = m.existedBefore ? `Restore ${displayPath(m.target)} to its state before ${m.at}` : `Delete ${displayPath(m.target)} (it did not exist before ${m.at})`;
    if (!(await ctx.approve(description))) return { status: 'declined', message: 'Not approved; nothing was changed.' };
    if (m.existedBefore) {
      const original = readText(path.join(dir, 'original'), 8 * 1024 * 1024);
      if (original === undefined) return { status: 'failed', message: 'backup copy is missing' };
      writeAtomic(m.target, original);
    } else {
      fs.rmSync(m.target, { force: true });
    }
  } else {
    if (!m.undoArgv || !m.undoExe) return { status: 'failed', message: 'this install has no automatic undo; remove it with the host CLI' };
    const description = `Run: ${path.basename(m.undoExe)} ${m.undoArgv.join(' ')}`;
    if (!(await ctx.approve(description))) return { status: 'declined', message: 'Not approved; nothing was changed.' };
    const r = await (ctx.runner ?? defaultRunner)(m.undoExe, m.undoArgv, { env: ctx.env ?? process.env });
    if (r.code !== 0) return { status: 'failed', message: `undo command failed (exit ${r.code}): ${redactString(r.stderr).slice(0, 300)}` };
  }
  m.rolledBack = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n', 'utf8');
  ctx.store.audit('rollback', { backup: id, entry: m.entryId, host: m.host });
  return { status: 'done', message: `Rolled back ${m.entryId} (${m.host}).` };
}
