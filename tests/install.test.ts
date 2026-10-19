import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { applyPlan, listBackups, rollback, type Runner } from '../src/install/apply.ts';
import { appendCodexServer, ConflictError, mergeMcpJson, planInstall, type InstallPlan, type PlanRequest } from '../src/install/plan.ts';
import { claudeAddArgv, claudeServerJson, codexServerTable, needsCmdWrapper, resolveSpec, SpecError } from '../src/install/spec.ts';
import { readInventory } from '../src/hosts/inventory.ts';
import { findEntry, loadRegistry } from '../src/registry/registry.ts';
import { Store } from '../src/state/store.ts';
import type { RegistryEntry } from '../src/types.ts';
import { parseToml } from '../src/util/toml.ts';
import { diffSnapshots, fakeWhich, sandbox, snapshot, type Sandbox } from './helpers.ts';

const registry = loadRegistry();
const entry = (id: string): RegistryEntry => findEntry(registry, id) as RegistryEntry;
const boxes: Sandbox[] = [];
function box(files: Record<string, string> = {}): Sandbox {
  const b = sandbox(files);
  boxes.push(b);
  return b;
}
after(() => boxes.forEach((b) => b.cleanup()));

function plan(b: Sandbox, id: string, extra: Partial<PlanRequest> = {}, exes: Record<string, string> = {}): InstallPlan {
  const inventory = readInventory(b.project, { env: b.env, which: fakeWhich(exes) });
  return planInstall({ entry: entry(id), host: 'claude', projectRoot: b.project, inventory, env: b.env, platform: 'linux', now: Date.parse('2026-10-20T00:00:00Z'), ...extra });
}

const yes = async (): Promise<boolean> => true;
const no = async (): Promise<boolean> => false;

describe('editing .mcp.json', () => {
  it('creates a new file', () => {
    const out = mergeMcpJson('', 'ctx', { type: 'http', url: 'https://x/mcp' });
    assert.deepEqual(JSON.parse(out), { mcpServers: { ctx: { type: 'http', url: 'https://x/mcp' } } });
    assert.ok(out.endsWith('\n'));
  });
  it('keeps other servers, other keys, key order, indentation and line endings', () => {
    const before = '{\r\n    "$schema": "x",\r\n    "mcpServers": {\r\n        "a": { "command": "x" }\r\n    },\r\n    "other": true\r\n}';
    const out = mergeMcpJson(before, 'b', { type: 'stdio', command: 'y', args: [] });
    const doc = JSON.parse(out);
    assert.deepEqual(Object.keys(doc), ['$schema', 'mcpServers', 'other']);
    assert.deepEqual(Object.keys(doc.mcpServers), ['a', 'b']);
    assert.ok(out.includes('\r\n        "a"'), 'indentation and CRLF kept');
    assert.ok(!out.endsWith('\n'), 'no newline added when the original had none');
  });
  it('refuses conflicts and broken files', () => {
    assert.throws(() => mergeMcpJson('{"mcpServers":{"a":{}}}', 'a', {}), ConflictError);
    assert.throws(() => mergeMcpJson('{"mcpServers": [', 'a', {}), /not valid JSON/);
    assert.throws(() => mergeMcpJson('[]', 'a', {}), /JSON object/);
    assert.throws(() => mergeMcpJson('{"mcpServers": []}', 'a', {}), /not an object/);
  });
});

describe('editing Codex config.toml', () => {
  const table = { url: 'https://x/mcp', bearer_token_env_var: 'TOKEN', http_headers: { 'X-MCP-Readonly': 'true' } };
  it('appends without touching existing bytes', () => {
    const before = '# my config\nmodel = "gpt-5.5"  # keep this comment\n\n[mcp_servers.other]\ncommand = "x"\n';
    const out = appendCodexServer(before, 'gh', table, 'GitHub');
    assert.ok(out.startsWith(before), 'existing content must be a byte-for-byte prefix');
    const doc = parseToml(out) as Record<string, any>;
    assert.deepEqual(doc.mcp_servers.gh, table);
    assert.equal(doc.mcp_servers.other.command, 'x');
    assert.equal(doc.model, 'gpt-5.5');
  });
  it('handles empty files, missing final newline and CRLF', () => {
    assert.deepEqual((parseToml(appendCodexServer('', 'a', table, 'x')) as any).mcp_servers.a, table);
    const noNl = appendCodexServer('model = "m"', 'a', table, 'x');
    assert.ok(noNl.startsWith('model = "m"\n'));
    const crlf = appendCodexServer('model = "m"\r\n', 'a', table, 'x');
    assert.ok(!/[^\r]\n/.test(crlf), 'all line endings stay CRLF');
  });
  it('refuses conflicts, invalid TOML and inline-table mcp_servers', () => {
    assert.throws(() => appendCodexServer('[mcp_servers.a]\ncommand = "x"\n', 'a', table, 'x'), ConflictError);
    assert.throws(() => appendCodexServer('[mcp_servers\n', 'a', table, 'x'), /not valid TOML/);
    assert.throws(() => appendCodexServer('mcp_servers = { b = { command = "x" } }\n', 'a', table, 'x'), /cannot append safely/);
    assert.throws(() => appendCodexServer('mcp_servers = 3\n', 'a', table, 'x'), /not a table/);
  });
  it('a label cannot inject TOML', () => {
    const out = appendCodexServer('', 'a', table, 'evil\n[mcp_servers.pwned]\ncommand = "rm"');
    const doc = parseToml(out) as Record<string, any>;
    assert.deepEqual(Object.keys(doc.mcp_servers), ['a']);
  });
});

describe('server specs', () => {
  it('passes secrets by environment variable name, never by value', () => {
    const gh = resolveSpec(entry('github'), 'claude', {});
    assert.deepEqual(claudeServerJson(gh), { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { 'X-MCP-Readonly': 'true', Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' } });
    assert.deepEqual(codexServerTable(gh), { url: 'https://api.githubcopilot.com/mcp/', bearer_token_env_var: 'GITHUB_PERSONAL_ACCESS_TOKEN', http_headers: { 'X-MCP-Readonly': 'true' } });
    const pg = resolveSpec(entry('postgres-mcp-pro'), 'codex', {});
    assert.deepEqual(codexServerTable(pg, 'linux'), { command: 'uvx', args: ['postgres-mcp@0.3.0', '--access-mode=restricted'], env_vars: ['DATABASE_URI'], startup_timeout_sec: 60 });
    const redis = resolveSpec(entry('redis'), 'claude', {});
    assert.deepEqual((claudeServerJson(redis, 'linux') as any).env, { REDIS_HOST: '${REDIS_HOST}', REDIS_PORT: '${REDIS_PORT:-}', REDIS_PWD: '${REDIS_PWD:-}' });
  });
  it('wraps npx with cmd /c on native Windows only', () => {
    const r = resolveSpec(entry('playwright'), 'claude', {});
    assert.deepEqual((claudeServerJson(r, 'win32') as any).command, 'cmd');
    assert.deepEqual((claudeServerJson(r, 'win32') as any).args.slice(0, 2), ['/c', 'npx']);
    assert.equal((claudeServerJson(r, 'linux') as any).command, 'npx');
    assert.equal(needsCmdWrapper('docker', 'win32', { PATH: '' }), false);
  });
  it('validates parameters strictly', () => {
    const ado = entry('azure-devops');
    assert.throws(() => resolveSpec(ado, 'claude', {}), SpecError);
    assert.throws(() => resolveSpec(ado, 'claude', { params: { organization: 'acme & calc' } }), /invalid value/);
    assert.throws(() => resolveSpec(ado, 'claude', { params: { organization: 'acme', extra: '1' } }), /unknown parameter/);
    assert.deepEqual(resolveSpec(ado, 'claude', { params: { organization: 'acme' } }).spec.args, ['-y', '@azure-devops/mcp@2.10.0', 'acme']);
    assert.equal(resolveSpec(entry('gitlab'), 'claude', {}).spec.url, 'https://gitlab.com/api/v4/mcp', 'defaults apply');
    assert.throws(() => resolveSpec(entry('jenkins'), 'claude', { params: { jenkinsUrl: 'http://insecure' } }), /invalid value/);
  });
  it('honours read/write choices', () => {
    assert.equal(resolveSpec(entry('linear'), 'claude', {}).spec.url, 'https://mcp.linear.app/mcp/readonly');
    assert.equal(resolveSpec(entry('linear'), 'claude', { access: 'write' }).spec.url, 'https://mcp.linear.app/mcp');
    assert.throws(() => resolveSpec(entry('atlassian-rovo'), 'claude', { access: 'read' }), /no read-only mode/);
    assert.equal(resolveSpec(entry('aws-mcp'), 'codex', {}).spec.url, 'https://aws-mcp.us-east-1.api.aws/mcp?oauth=initialize', 'host override');
  });
  it('builds claude mcp add argv without JSON', () => {
    const argv = claudeAddArgv(resolveSpec(entry('github'), 'claude', {}), 'local', 'linux');
    // Variadic --header/--env must come before --transport, or they swallow the server name.
    assert.deepEqual(argv, ['mcp', 'add', '--header', 'X-MCP-Readonly: true', '--header', 'Authorization: Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}', '--transport', 'http', '--scope', 'local', 'github', 'https://api.githubcopilot.com/mcp/']);
    const s = claudeAddArgv(resolveSpec(entry('postgres-mcp-pro'), 'claude', {}), 'user', 'linux');
    assert.deepEqual(s, ['mcp', 'add', '--env', 'DATABASE_URI=${DATABASE_URI}', '--transport', 'stdio', '--scope', 'user', 'postgres', '--', 'uvx', 'postgres-mcp@0.3.0', '--access-mode=restricted']);
  });
});

describe('planning', () => {
  it('Claude project scope edits .mcp.json and shows a diff', () => {
    const b = box();
    const p = plan(b, 'context7', { scope: 'project' });
    assert.equal(p.method, 'file');
    assert.equal(p.target?.path, path.join(b.project, '.mcp.json'));
    assert.match(p.diff ?? '', /\+ .*"context7"/);
    assert.equal(p.access, 'read');
    assert.ok(p.sideEffects.some((s) => s.includes('committed')));
  });
  it('Claude local/user scope uses the claude CLI, or is blocked without it', () => {
    const b = box();
    const p = plan(b, 'context7', {}, { claude: '/bin/claude' });
    assert.equal(p.method, 'cli');
    assert.equal(p.scope, 'local');
    assert.equal(p.exe, '/bin/claude');
    assert.equal(plan(b, 'context7').scope, 'project', 'falls back to project scope without the CLI');
    const blocked = plan(b, 'context7', { scope: 'user' });
    assert.match(blocked.blocked ?? '', /CLI not found/);
    assert.match(blocked.blocked ?? '', /claude mcp add/);
  });
  it('Codex user and project scopes', () => {
    const b = box();
    const u = plan(b, 'github', { host: 'codex' });
    assert.equal(u.target?.path, path.join(b.codexHome, 'config.toml'));
    assert.equal(u.target?.existed, false);
    const pr = plan(b, 'github', { host: 'codex', scope: 'project' });
    assert.equal(pr.target?.path, path.join(b.project, '.codex', 'config.toml'));
    assert.ok(pr.sideEffects.some((s) => s.includes('trusted')));
    assert.match(plan(b, 'github', { host: 'codex', scope: 'local' }).blocked ?? '', /no "local" scope/);
  });
  it('blocks duplicates, legacy entries, managed configs and bad parameters', () => {
    const b = box({ '.mcp.json': JSON.stringify({ mcpServers: { context7: { type: 'http', url: 'https://mcp.context7.com/mcp' } } }) });
    assert.match(plan(b, 'context7', { scope: 'project' }).blocked ?? '', /already set up/);
    assert.match(plan(b, 'context7', { scope: 'project', force: true }).blocked ?? '', /already has a server named/);
    assert.equal(plan(b, 'context7', { scope: 'project', force: true, name: 'context7-2' }).blocked, undefined);
    assert.match(plan(b, 'legacy-server-postgres').blocked ?? '', /archived.*postgres-mcp-pro/);
    assert.match(plan(b, 'azure-devops', { scope: 'project' }).blocked ?? '', /missing parameter organization/);
    assert.match(plan(b, 'csharp-lsp', { host: 'codex' }).blocked ?? '', /not available for Codex/);
    fs.mkdirSync(path.join(b.root, 'managed'), { recursive: true });
    fs.writeFileSync(path.join(b.root, 'managed', 'managed-mcp.json'), '{"mcpServers":{}}');
    assert.match(plan(b, 'github', { scope: 'project' }).blocked ?? '', /administrator-managed/);
  });
  it('lists required env vars and whether they are set, without reading values', () => {
    const b = box();
    b.env['GITHUB_PERSONAL_ACCESS_TOKEN'] = 'ghp_realsecretvalue1234567890abcdefgh';
    const p = plan(b, 'github', { scope: 'project' });
    assert.deepEqual(p.envNeeded, [{ name: 'GITHUB_PERSONAL_ACCESS_TOKEN', set: true, optional: false }]);
    assert.ok(!JSON.stringify(p).includes('ghp_realsecret'), 'the secret value must never appear in a plan');
  });
  it('guided entries (CLIs, skills) never write anything', () => {
    const b = box();
    const p = plan(b, 'gh-cli');
    assert.equal(p.method, 'guided');
    assert.ok(p.nextSteps.length > 0);
  });
  it('Claude plugins install through the claude CLI when present', () => {
    const b = box();
    const p = plan(b, 'csharp-lsp', {}, { claude: '/bin/claude' });
    assert.equal(p.method, 'cli');
    assert.deepEqual(p.argv, ['plugin', 'install', 'csharp-lsp@claude-plugins-official', '--scope', 'user']);
    assert.equal(plan(b, 'csharp-lsp').method, 'guided');
  });
});

describe('applying with consent', () => {
  it('dry run changes nothing at all', async () => {
    const b = box({ '.mcp.json': '{"mcpServers":{}}\n' });
    const before = snapshot(b.root);
    const p = plan(b, 'context7', { scope: 'project' });
    let asked = false;
    const res = await applyPlan(p, { store: new Store(b.env), projectRoot: b.project, approve: async () => ((asked = true), true), dryRun: true });
    assert.equal(res.status, 'dry-run');
    assert.equal(asked, false, 'a dry run never asks');
    assert.deepEqual(diffSnapshots(before, snapshot(b.root)), []);
  });

  it('declining changes no config file', async () => {
    const b = box({ '.mcp.json': '{"mcpServers":{}}\n' });
    fs.writeFileSync(path.join(b.codexHome, 'config.toml'), 'model = "x"\n');
    const before = snapshot(b.root);
    for (const [id, host] of [['context7', 'claude'], ['github', 'codex']] as const) {
      const p = plan(b, id, { host, scope: host === 'claude' ? 'project' : 'user' });
      const res = await applyPlan(p, { store: new Store(b.env), projectRoot: b.project, approve: no });
      assert.equal(res.status, 'declined');
    }
    const changes = diffSnapshots(before, snapshot(b.root)).filter((c) => !c.includes('audit.log'));
    assert.deepEqual(changes, [], 'only the audit log may change');
  });

  it('applies, backs up, validates and rolls back byte-for-byte', async () => {
    const original = '{\n  "mcpServers": {\n    "keep": { "command": "x" }\n  }\n}\n';
    const b = box({ '.mcp.json': original });
    const store = new Store(b.env);
    const p = plan(b, 'context7', { scope: 'project' });
    const res = await applyPlan(p, { store, projectRoot: b.project, approve: yes });
    assert.equal(res.status, 'applied', res.message);
    assert.ok(res.backupId);
    const written = JSON.parse(fs.readFileSync(path.join(b.project, '.mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(written.mcpServers), ['keep', 'context7']);
    assert.ok(res.verification[0]?.includes('parses'));
    assert.equal(listBackups(store)[0]?.id, res.backupId);
    const rb = await rollback(res.backupId as string, { store, approve: yes });
    assert.equal(rb.status, 'done', rb.message);
    assert.equal(fs.readFileSync(path.join(b.project, '.mcp.json'), 'utf8'), original);
    assert.equal((await rollback(res.backupId as string, { store, approve: yes })).status, 'failed', 'no double rollback');
    const audit = store.readAudit();
    assert.deepEqual(audit.map((a) => a['event']), ['install', 'rollback']);
  });

  it('rollback deletes a file the install created and refuses after manual edits', async () => {
    const b = box();
    const store = new Store(b.env);
    const p = plan(b, 'github', { host: 'codex' });
    const res = await applyPlan(p, { store, projectRoot: b.project, approve: yes });
    assert.equal(res.status, 'applied');
    const file = path.join(b.codexHome, 'config.toml');
    fs.appendFileSync(file, '\n# my own edit\n');
    const refused = await rollback(res.backupId as string, { store, approve: yes });
    assert.equal(refused.status, 'failed');
    assert.match(refused.message, /changed after the install/);
    assert.ok(fs.existsSync(file));
    const forced = await rollback(res.backupId as string, { store, approve: yes, force: true });
    assert.equal(forced.status, 'done');
    assert.equal(fs.existsSync(file), false);
  });

  it('refuses when the file changed between plan and apply', async () => {
    const b = box({ '.mcp.json': '{"mcpServers":{}}\n' });
    const p = plan(b, 'context7', { scope: 'project' });
    fs.writeFileSync(path.join(b.project, '.mcp.json'), '{"mcpServers":{"someone":{}}}\n');
    const res = await applyPlan(p, { store: new Store(b.env), projectRoot: b.project, approve: yes });
    assert.equal(res.status, 'failed');
    assert.match(res.message, /changed after the plan/);
    assert.equal(fs.readFileSync(path.join(b.project, '.mcp.json'), 'utf8'), '{"mcpServers":{"someone":{}}}\n');
  });

  it('restores the original when post-write validation fails', async () => {
    const original = '{"mcpServers":{}}\n';
    const b = box({ '.mcp.json': original });
    const p = plan(b, 'context7', { scope: 'project' });
    assert.ok(p.target);
    p.target.after = '{"mcpServers":{}}\n'; // pretend the edit lost the server
    const res = await applyPlan(p, { store: new Store(b.env), projectRoot: b.project, approve: yes });
    assert.equal(res.status, 'failed');
    assert.match(res.message, /restored/);
    assert.equal(fs.readFileSync(path.join(b.project, '.mcp.json'), 'utf8'), original);
  });

  it('blocked and guided plans never ask and never write', async () => {
    const b = box();
    const before = snapshot(b.root);
    let asked = false;
    const ask = async (): Promise<boolean> => ((asked = true), true);
    assert.equal((await applyPlan(plan(b, 'legacy-server-github'), { store: new Store(b.env), projectRoot: b.project, approve: ask })).status, 'blocked');
    assert.equal((await applyPlan(plan(b, 'gh-cli'), { store: new Store(b.env), projectRoot: b.project, approve: ask })).status, 'guided');
    assert.equal(asked, false);
    assert.deepEqual(diffSnapshots(before, snapshot(b.root)), []);
  });

  it('CLI installs run only the planned argv, record an undo, and roll back through the CLI', async () => {
    const b = box();
    const store = new Store(b.env);
    const calls: Array<{ exe: string; argv: string[] }> = [];
    const runner: Runner = async (exe, argv) => {
      calls.push({ exe, argv });
      return { code: 0, stdout: '', stderr: '' };
    };
    const p = plan(b, 'context7', {}, { claude: '/bin/claude' });
    const res = await applyPlan(p, { store, projectRoot: b.project, approve: yes, runner });
    assert.equal(res.status, 'applied');
    assert.deepEqual(calls[0], { exe: '/bin/claude', argv: ['mcp', 'add', '--transport', 'http', '--scope', 'local', 'context7', 'https://mcp.context7.com/mcp'] });
    const rb = await rollback(res.backupId as string, { store, approve: yes, runner });
    assert.equal(rb.status, 'done');
    assert.deepEqual(calls[1], { exe: '/bin/claude', argv: ['mcp', 'remove', 'context7', '--scope', 'local'] });
  });

  it('a failing host CLI is reported with secrets redacted', async () => {
    const b = box();
    const runner: Runner = async () => ({ code: 1, stdout: '', stderr: 'error: bad token ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
    const res = await applyPlan(plan(b, 'context7', {}, { claude: '/bin/claude' }), { store: new Store(b.env), projectRoot: b.project, approve: yes, runner });
    assert.equal(res.status, 'failed');
    assert.ok(!res.message.includes('ghp_abcdef'));
  });

  it('rollback ids cannot escape the backups folder', async () => {
    const b = box();
    const res = await rollback('../../etc', { store: new Store(b.env), approve: yes });
    assert.equal(res.status, 'not-found');
  });
});
