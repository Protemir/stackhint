// One test per finding from the review after the first release (v0.1.0).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { analyzeProject, detectGit, nugetPackages, pythonManifestNames } from '../src/context/analyzer.ts';
import { classifyTask } from '../src/context/task.ts';
import { SignalSet } from '../src/context/signals.ts';
import { looksReadOnly } from '../src/engine/check.ts';
import { recommend } from '../src/engine/recommend.ts';
import { availabilityFor, readInventory, urlPatternIn } from '../src/hosts/inventory.ts';
import { applyPlan, listBackups, rollback } from '../src/install/apply.ts';
import { mergeMcpJson, planInstall } from '../src/install/plan.ts';
import { resolveSpec, tomlLiteralValue, tryCommand } from '../src/install/spec.ts';
import { handleMessage } from '../src/mcp/server.ts';
import { findEntry, loadRegistry } from '../src/registry/registry.ts';
import { Store } from '../src/state/store.ts';
import type { ConfiguredServer, Inventory, ProjectContext, RegistryEntry } from '../src/types.ts';
import { which, whichMany } from '../src/util/exec.ts';
import { shellArg } from '../src/util/text.ts';
import { parseToml } from '../src/util/toml.ts';
import { DEMO, fakeWhich, NO_GIT, REPO, sandbox, tmp, writeFiles, type Sandbox } from './helpers.ts';

const registry = loadRegistry();
const entry = (id: string): RegistryEntry => findEntry(registry, id) as RegistryEntry;
const boxes: Sandbox[] = [];
const dirs: string[] = [];
after(() => {
  boxes.forEach((b) => b.cleanup());
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});
function box(files: Record<string, string> = {}): Sandbox {
  const b = sandbox(files);
  boxes.push(b);
  return b;
}
const sha = (p: string): string => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const approve = async (): Promise<boolean> => true;

async function installCodex(b: Sandbox, id = 'context7') {
  const inventory = readInventory(b.project, { env: b.env, which: fakeWhich({}) });
  const plan = planInstall({ entry: entry(id), host: 'codex', scope: 'user', projectRoot: b.project, inventory, env: b.env, platform: 'linux' });
  const store = new Store(b.env);
  const res = await applyPlan(plan, { store, projectRoot: b.project, approve, env: b.env, platform: 'linux' });
  return { plan, res, store };
}

describe('install keeps config files intact', () => {
  it('refuses a config that is not valid UTF-8 instead of corrupting it', async () => {
    const b = box();
    const file = path.join(b.codexHome, 'config.toml');
    fs.writeFileSync(file, Buffer.concat([Buffer.from('# '), Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), Buffer.from(' cp1251\nmodel = "o3"\n')]));
    const before = sha(file);
    const { plan, res } = await installCodex(b);
    assert.match(plan.blocked ?? '', /not valid UTF-8/);
    assert.equal(res.status, 'blocked');
    assert.equal(sha(file), before);
  });

  it('keeps a BOM and CRLF, and rollback restores the exact bytes', async () => {
    const b = box();
    const file = path.join(b.codexHome, 'config.toml');
    fs.writeFileSync(file, Buffer.from('﻿model = "o3"\r\n# keep me\r\n', 'utf8'));
    const before = sha(file);
    const { res, store } = await installCodex(b);
    assert.equal(res.status, 'applied', res.message);
    const written = fs.readFileSync(file);
    assert.deepEqual([...written.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.ok(!/[^\r]\n/.test(written.toString('utf8')), 'line endings stay CRLF');
    assert.ok(parseToml(written.toString('utf8').slice(1))['mcp_servers']);
    const rb = await rollback(res.backupId as string, { store, approve });
    assert.equal(rb.status, 'done', rb.message);
    assert.equal(sha(file), before);
  });

  it('writes through a hard link instead of breaking it', async (t) => {
    const b = box();
    const dot = path.join(b.root, 'dotfiles-config.toml');
    fs.writeFileSync(dot, 'model = "o3"\n');
    try {
      fs.linkSync(dot, path.join(b.codexHome, 'config.toml'));
    } catch {
      t.skip('cannot create hard links here');
      return;
    }
    const { res } = await installCodex(b);
    assert.equal(res.status, 'applied', res.message);
    assert.match(fs.readFileSync(dot, 'utf8'), /\[mcp_servers\.context7\]/);
  });

  it('writes through a symbolic link and says so in the plan', async (t) => {
    const b = box();
    const dot = path.join(b.root, 'dotfiles-config.toml');
    fs.writeFileSync(dot, 'model = "o3"\n');
    try {
      fs.symlinkSync(dot, path.join(b.codexHome, 'config.toml'), 'file');
    } catch {
      t.skip('cannot create file symlinks here (Windows without developer mode)');
      return;
    }
    const { plan, res } = await installCodex(b);
    assert.ok(plan.sideEffects.some((s) => /symbolic link/.test(s)));
    assert.equal(res.status, 'applied', res.message);
    assert.ok(fs.lstatSync(path.join(b.codexHome, 'config.toml')).isSymbolicLink());
    assert.match(fs.readFileSync(dot, 'utf8'), /\[mcp_servers\.context7\]/);
  });

  it('a failed write leaves no backup behind', async (t) => {
    const b = box();
    const file = path.join(b.codexHome, 'config.toml');
    fs.writeFileSync(file, 'model = "o3"\n');
    const inventory = readInventory(b.project, { env: b.env, which: fakeWhich({}) });
    const plan = planInstall({ entry: entry('context7'), host: 'codex', scope: 'user', projectRoot: b.project, inventory, env: b.env, platform: 'linux' });
    const lock = process.platform === 'win32' ? file : b.codexHome;
    fs.chmodSync(lock, process.platform === 'win32' ? 0o444 : 0o555);
    try {
      if (process.platform !== 'win32' && process.getuid?.() === 0) {
        t.skip('root ignores folder permissions');
        return;
      }
      const store = new Store(b.env);
      const res = await applyPlan(plan, { store, projectRoot: b.project, approve });
      assert.equal(res.status, 'failed');
      assert.deepEqual(listBackups(store), []);
    } finally {
      fs.chmodSync(lock, process.platform === 'win32' ? 0o666 : 0o755);
    }
  });

  it('rollback removes the folder the install created', async () => {
    const b = box();
    fs.rmSync(b.codexHome, { recursive: true, force: true });
    const { res, store } = await installCodex(b);
    assert.equal(res.status, 'applied', res.message);
    assert.ok(fs.existsSync(b.codexHome));
    const rb = await rollback(res.backupId as string, { store, approve });
    assert.equal(rb.status, 'done', rb.message);
    assert.equal(fs.existsSync(b.codexHome), false);
  });

  it('.mcp.json edits leave every other byte alone', () => {
    const server = { type: 'stdio', command: 'npx', args: ['-y', 'x'] };
    const cases: Array<[string, RegExp]> = [
      ['{\r\n\t"big": 12345678901234567890,\r\n\t"__proto__": {"a": 1},\r\n\t"mcpServers": {\r\n\t\t"old": {"command": "x"}\r\n\t}\r\n}\r\n', /12345678901234567890[\s\S]*"__proto__"/],
      ['{"mcpServers":{"old":{"command":"x"}},"z":1.50}', /"z":1\.50/],
      ['{\n  "mcpServers": {}\n}\n', /"mcpServers": \{\n    "new": \{/],
      ['{\n  "other": [1, 2]\n}\n', /"other": \[1, 2\],\n  "mcpServers": \{\n    "new"/],
      ['{}', /^\{ "mcpServers"/],
      ['{\n  "mcpServers": {"a": {"command": "x"}}, "mcpServers": {\n    "b": {"command": "y"}\n  }\n}\n', /"b": \{"command": "y"\},\n    "new"/],
    ];
    for (const [before, shape] of cases) {
      const out = mergeMcpJson(before, 'new', server);
      assert.match(out, shape, out);
      const parsed = JSON.parse(out) as { mcpServers: Record<string, unknown> };
      assert.deepEqual(parsed.mcpServers['new'], server);
      // Removing our insertion gives back the original text.
      const inserted = out.length - before.length;
      assert.ok(inserted > 0);
    }
    const crlf = mergeMcpJson(cases[0]![0], 'new', server);
    assert.ok(crlf.startsWith('{\r\n\t"big": 12345678901234567890,\r\n\t"__proto__": {"a": 1},'));
    assert.ok(!/[^\r]\n/.test(crlf), 'CRLF kept');
  });

  it('warns when a shared project file gets the Windows-only cmd /c wrapper', () => {
    const b = box();
    const inventory = readInventory(b.project, { env: b.env, which: fakeWhich({}) });
    const plan = planInstall({ entry: entry('playwright'), host: 'claude', scope: 'project', projectRoot: b.project, inventory, env: b.env, platform: 'win32' });
    assert.ok(plan.warnings.some((w) => /cmd \/c npx.*macOS or Linux/.test(w)), plan.warnings.join('\n'));
    const codex = planInstall({ entry: entry('playwright'), host: 'codex', scope: 'project', projectRoot: b.project, inventory, env: b.env, platform: 'win32' });
    assert.ok(codex.warnings.some((w) => /cmd \/c npx/.test(w)));
    const linux = planInstall({ entry: entry('playwright'), host: 'claude', scope: 'project', projectRoot: b.project, inventory, env: b.env, platform: 'linux' });
    assert.ok(!linux.warnings.some((w) => /cmd \/c/.test(w)));
  });
});

describe('commands that print or find things', () => {
  it('try --host codex prints arguments that survive Windows PowerShell', () => {
    for (const id of ['playwright', 'linear', 'context7']) {
      const r = resolveSpec(entry(id), 'codex', {});
      const win = tryCommand('codex', r, 'unused', 'win32');
      assert.ok(!win.includes('"'), `no double quotes for PowerShell 5.1: ${win}`);
      // Undo PowerShell's single-quote escaping and check every value is valid TOML.
      for (const m of win.matchAll(/-c '((?:[^']|'')*)'/g)) {
        const assignment = (m[1] as string).replace(/''/g, "'");
        const eq = assignment.indexOf('=');
        assert.doesNotThrow(() => parseToml(`v = ${assignment.slice(eq + 1)}`), assignment);
      }
      const posix = tryCommand('codex', r, 'unused', 'linux');
      assert.match(posix, /^codex -c '/);
    }
    assert.equal(tomlLiteralValue({ READ_ONLY_MODE: 'true' }), "{ READ_ONLY_MODE = 'true' }");
    assert.equal(tomlLiteralValue("it's"), '"it\'s"');
  });

  it('quoted PATH entries on Windows are found', () => {
    const d = tmp('sh-path-');
    dirs.push(d);
    fs.writeFileSync(path.join(d, 'claude.cmd'), '@echo off\n');
    assert.equal(which('claude', { PATH: `"${d}"`, PATHEXT: '.CMD' }, 'win32'), path.join(d, 'claude.cmd'));
  });

  it('config set refuses to replace a config file it cannot parse', () => {
    const b = box();
    fs.mkdirSync(b.stackhome, { recursive: true });
    const file = path.join(b.stackhome, 'config.json');
    fs.writeFileSync(file, '{"mode": "manual", "minScore": 40,}\n');
    const store = new Store(b.env);
    assert.throws(() => store.setConfig('gitHistory', 'false'), /fix or delete it/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"mode": "manual", "minScore": 40,}\n');
  });
});

// ---------------- ranking ----------------

const server = (over: Partial<ConfiguredServer>): ConfiguredServer => ({
  host: 'claude', name: 'x', scope: 'user', source: 'test', transport: 'stdio', args: [], enabled: true, inlineSecrets: [], settings: {}, ...over,
});
const inventoryOf = (...servers: ConfiguredServer[]): Inventory => ({
  servers, plugins: [], skills: [], executables: {}, files: [], hostsDetected: { claude: true, codex: false }, hostCli: {}, warnings: [],
});
function userServers(b: Sandbox, servers: Record<string, unknown>): void {
  fs.writeFileSync(path.join(b.claudeDir, '.claude.json'), JSON.stringify({ mcpServers: servers }));
}
function project(files: Record<string, string | Buffer>): string {
  const d = tmp('sh-4th-');
  dirs.push(d);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(d, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return d;
}

describe('ranking', () => {
  it('replacements for two retired servers are both shown, not folded into one group', async () => {
    const b = box();
    userServers(b, {
      pg: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/shop'] },
      lite: { command: 'uvx', args: ['mcp-server-sqlite', '--db-path', 'app.db'] },
    });
    const ctx = await analyzeProject(DEMO, { git: NO_GIT });
    const r = recommend(ctx, registry, readInventory(DEMO, { env: b.env, which: fakeWhich({}) }), { hosts: ['claude'], platform: 'linux' });
    assert.deepEqual(r.recommendations.filter((x) => x.action === 'replace').map((x) => x.id).sort(), ['dbhub', 'postgres-mcp-pro']);
  });

  it('a group member folded into a better one can still be explained', async () => {
    const ctx = await analyzeProject(DEMO, { git: NO_GIT });
    const r = recommend(ctx, registry, readInventory(DEMO, { env: box().env, which: fakeWhich({}) }), { hosts: ['claude'], platform: 'linux', minScore: 0 });
    const dbhub = r.folded.find((x) => x.id === 'dbhub');
    assert.ok(dbhub, JSON.stringify(r.suppressed));
    assert.ok(dbhub.reasons.length > 0);
  });

  it('a hosted Neon server does not count as a local Postgres tool', async () => {
    const b = box();
    userServers(b, { neon: { type: 'http', url: 'https://mcp.neon.tech/mcp' } });
    const ctx = await analyzeProject(DEMO, { git: NO_GIT });
    const r = recommend(ctx, registry, readInventory(DEMO, { env: b.env, which: fakeWhich({}) }), { hosts: ['claude'], platform: 'linux' });
    const pg = [...r.recommendations, ...r.alreadyAvailable].find((x) => x.id === 'postgres-mcp-pro');
    assert.ok(pg);
    assert.notEqual(pg.action, 'use-existing');
  });

  it('URL patterns: bridges count, look-alike subdomains do not', () => {
    assert.ok(urlPatternIn('npx -y mcp-remote@latest https://mcp.sentry.dev/mcp', 'mcp.sentry.dev'));
    assert.ok(!urlPatternIn('https://docs.mcp.cloudflare.com/mcp', 'mcp.cloudflare.com/mcp'));
    assert.ok(urlPatternIn('https://mcp.cloudflare.com/mcp', 'mcp.cloudflare.com/mcp'));
    assert.ok(urlPatternIn('https://aws-mcp.us-east-1.api.aws/mcp', '.api.aws/mcp'));
    assert.ok(urlPatternIn('https://gitlab.example.com/api/v4/mcp', '/api/v4/mcp'));
    const viaBridge = server({ name: 'errors', command: 'npx', args: ['-y', 'mcp-remote@latest', 'https://mcp.sentry.dev/mcp'] });
    assert.equal(availabilityFor(entry('sentry'), inventoryOf(viaBridge), 'claude', registry.entries).state, 'configured');
    const docs = server({ name: 'cf-docs', transport: 'http', url: 'https://docs.mcp.cloudflare.com/mcp' });
    assert.notEqual(availabilityFor(entry('cloudflare'), inventoryOf(docs), 'claude', registry.entries).state, 'configured');
  });

  it('signals from example folders do not open a tool\'s gate', async () => {
    const ctx = await analyzeProject(REPO, { git: NO_GIT, task: 'update the docs for the scan command' });
    const r = recommend(ctx, registry, inventoryOf(), { hosts: ['claude'], platform: 'linux', minScore: 0 });
    assert.ok(![...r.recommendations, ...r.folded].some((x) => x.id === 'microsoft-learn'));
  });

  it('a strong signal with a small weight is not high confidence', () => {
    const set = new SignalSet();
    set.add('vcs:github', 1, { source: 'git', detail: 'remote origin on github.com' });
    const ctx: ProjectContext = { root: REPO, signals: set.toRecord(), git: NO_GIT, stats: { filesSeen: 0, filesRead: 0, truncated: false, elapsedMs: 0 }, warnings: [] };
    const r = recommend(ctx, registry, inventoryOf(), { hosts: ['claude'], platform: 'linux', minScore: 0 });
    const review = r.recommendations.find((x) => x.id === 'code-review-plugin');
    if (review) assert.notEqual(review.confidence, 'high');
    assert.equal(r.recommendations.find((x) => x.id === 'github')?.confidence, 'high');
  });

  it('a project that already has skills is not told to write one', async () => {
    const copy = tmp('sh-skills-');
    dirs.push(copy);
    fs.cpSync(DEMO, copy, { recursive: true });
    writeFiles(copy, { '.claude/skills/add-migration/SKILL.md': '---\nname: add-migration\ndescription: Add an EF Core migration\n---\nSteps.\n' });
    const ctx = await analyzeProject(copy, { git: NO_GIT });
    const r = recommend(ctx, registry, readInventory(copy, { env: box().env, which: fakeWhich({}) }), { hosts: ['claude'], platform: 'linux', minScore: 0 });
    assert.ok(!r.recommendations.some((x) => x.id === 'project-skill'));
    assert.ok(r.alreadyAvailable.some((x) => x.id === 'project-skill'));
  });

  it('why-now text keeps file names as they are', async () => {
    const d = project({ 'package.json': '{"dependencies":{"@supabase/supabase-js":"2"}}', 'wrangler.toml': 'name = "x"\n' });
    const ctx = await analyzeProject(d, { git: NO_GIT });
    const r = recommend(ctx, registry, inventoryOf(), { hosts: ['claude'], platform: 'linux', minScore: 0 });
    for (const rec of r.recommendations) {
      assert.doesNotMatch(rec.whyNow, /Package\.json|Wrangler\.toml|package\.json \(package\.json\)/, rec.whyNow);
    }
  });

  it('registry facts from the independent spot-check', () => {
    // monday-api-mcp 3.3.1 reads the value after --read-only; alone at the end it is ignored.
    const monday = resolveSpec(entry('monday'), 'claude', {});
    assert.deepEqual(monday.spec.args?.slice(-2), ['--read-only', 'true']);
    // Language servers that build the project run its code.
    for (const id of ['rust-analyzer-lsp', 'ruby-lsp', 'jdtls-lsp', 'kotlin-lsp', 'swift-lsp']) assert.equal(entry(id).access.level, 'exec', id);
  });

  it('check sees read-only settings passed to a container as env', () => {
    const ro = { transport: 'stdio', command: 'docker', args: ['run', '--read-only-flag-that-is-not-set'] } as unknown as Parameters<typeof looksReadOnly>[1];
    const rw = { transport: 'stdio', command: 'docker', args: ['run'] } as unknown as Parameters<typeof looksReadOnly>[2];
    const withEnv = server({ command: 'docker', args: ['run', '-i', '--rm', '-e', 'GITHUB_READ_ONLY=1', 'ghcr.io/github/github-mcp-server'] });
    const without = server({ command: 'docker', args: ['run', '-i', '--rm', 'ghcr.io/github/github-mcp-server'] });
    assert.equal(looksReadOnly(withEnv, ro, rw), true);
    assert.equal(looksReadOnly(without, ro, rw), false);
  });
});

// ---------------- detection ----------------

describe('detection', () => {
  it('team MCP configs never put secrets into signal ids', async () => {
    const d = project({
      '.vscode/mcp.json': JSON.stringify({
        servers: {
          // A fake key, assembled at runtime so secret scanners do not flag the test file.
          db: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://app:S3cr3tPassw0rd@db.internal:5432/shop', '--api-key', ['sk', 'live', 'FAKEFAKEFAKEFAKEFAKEFAKE'].join('_')] },
          docs: { type: 'http', url: 'https://mcp.context7.com/mcp?api_key=ctx7sk-9f8e7d6c5b4a' },
        },
      }),
    });
    const ctx = await analyzeProject(d, { git: NO_GIT });
    const ids = Object.keys(ctx.signals).join(' ');
    assert.doesNotMatch(ids, /S3cr3t|ctx7sk|sk_live|api_key/i);
    assert.match(ids, /team-mcp:.*mcp\.context7\.com/);
    assert.match(ids, /server-postgres/);
  });

  it('skips Python virtual environments whatever they are called', async () => {
    const files: Record<string, string> = { 'app.py': 'import flask\n', 'requirements.txt': 'flask\n', '.venv312/pyvenv.cfg': 'home = x\n', '.venv312/Lib/site-packages/pkg/package.json': '{"dependencies":{"react":"18"}}' };
    for (let i = 0; i < 25; i++) files[`.venv312/Lib/site-packages/pkg/f${i}.js`] = 'x';
    const ctx = await analyzeProject(project(files), { git: NO_GIT });
    assert.ok(!ctx.signals['lang:javascript']);
    assert.ok(!ctx.signals['tech:frontend']);
    assert.ok(ctx.signals['lang:python']);
  });

  it('a huge asset folder does not crowd out the project files', async () => {
    const files: Record<string, string> = { 'api/Api.csproj': '<Project><ItemGroup><PackageReference Include="Npgsql" Version="8" /></ItemGroup></Project>' };
    for (let i = 0; i < 300; i++) files[`web/public/icons/i${i}.png`] = 'x';
    for (let i = 0; i < 300; i++) files[`web/zz/deep/f${i}.txt`] = 'x';
    const ctx = await analyzeProject(project(files), { git: NO_GIT, maxFiles: 100 });
    assert.ok(ctx.signals['db:postgres'], JSON.stringify(Object.keys(ctx.signals)));
  });

  it('reads the layouts and files the review found missing', async () => {
    const javaFiles: Record<string, string> = {};
    for (let i = 0; i < 6; i++) javaFiles[`src/main/java/acme/A${i}.java`] = 'class A {}';
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('flask\r\npsycopg2\r\n', 'utf16le')]);
    const cases: Array<[string, Record<string, string | Buffer>, string[], string[]]> = [
      ['requirements folder', { 'requirements/base.txt': 'Django>=5\npsycopg2-binary\n' }, ['db:postgres', 'lang:python'], []],
      ['Gradle Kotlin DSL and a version catalog', { 'build.gradle.kts': 'plugins { java }\n', 'gradle/libs.versions.toml': '[libraries]\npg = { module = "org.postgresql:postgresql", version = "42" }\n', ...javaFiles }, ['lang:java', 'db:postgres'], ['lang:kotlin']],
      ['compose defaults and bitnami images', { 'docker-compose.yml': 'services:\n  cache:\n    image: ${REDIS_IMAGE:-redis:7}\n  db:\n    image: bitnami/postgresql:16\n' }, ['db:redis', 'db:postgres'], []],
      ['UTF-16 requirements.txt', { 'requirements.txt': utf16 }, ['db:postgres'], []],
      ['@vercel/ncc is only a bundler', { 'package.json': '{"devDependencies":{"@vercel/ncc":"0.38"}}' }, ['tech:node'], ['cloud:vercel']],
      ['.NET Aspire integrations', { 'App/App.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Aspire.Npgsql.EntityFrameworkCore.PostgreSQL" Version="9" /><PackageReference Include="Aspire.StackExchange.Redis" Version="9" /></ItemGroup></Project>' }, ['db:postgres', 'db:redis', 'orm:efcore'], []],
      ['commented-out package', { 'App/App.csproj': '<Project><ItemGroup><!-- <PackageReference Include="MongoDB.Driver" Version="3" /> --></ItemGroup></Project>' }, ['tech:dotnet'], ['db:mongodb']],
      ['three.js game on Vite', { 'package.json': '{"dependencies":{"three":"0.180.0"},"devDependencies":{"vite":"6.0.0"}}' }, ['tech:frontend'], []],
      ['plain page with scripts', { 'index.html': '<html><body><script type="module" src="js/main.js"></script></body></html>', 'js/main.js': '' }, ['tech:frontend'], []],
      ['browser extension', { 'manifest.json': '{"manifest_version": 3, "name": "x", "action": {}, "permissions": ["storage"]}' }, ['tech:browser-extension', 'tech:frontend'], []],
      ['node --test', { 'package.json': '{"scripts":{"test":"node --test tests/"}}' }, ['test:unit'], []],
    ];
    for (const [name, files, want, notWant] of cases) {
      const ctx = await analyzeProject(project(files), { git: NO_GIT });
      for (const id of want) assert.ok(ctx.signals[id], `${name}: expected ${id}, got ${Object.keys(ctx.signals).join(', ')}`);
      for (const id of notWant) assert.ok(!ctx.signals[id], `${name}: did not expect ${id}`);
    }
    assert.deepEqual(nugetPackages('<!-- <PackageReference Include="MongoDB.Driver" Version="3" /> -->'), []);
  });

  it('a browser extension gets the browser debugging tools', async () => {
    const d = project({ 'manifest.json': '{"manifest_version": 3, "name": "x", "action": {}, "permissions": ["storage"]}', 'src/popup.ts': 'export {}' });
    const ctx = await analyzeProject(d, { git: NO_GIT });
    const r = recommend(ctx, registry, inventoryOf(), { hosts: ['claude'], platform: 'linux', minScore: 0 });
    assert.ok([...r.recommendations, ...r.folded].some((x) => x.id === 'chrome-devtools'));
  });

  it('dependency bots, numbered steps and SSH aliases', () => {
    const set = new SignalSet();
    const bumps = Array.from({ length: 12 }, (_, i) => `Bump the npm_and_yarn group across 1 directory with ${i + 2} updates`);
    detectGit({ isRepo: true, remotes: [{ name: 'origin', host: 'github.com-work', url: 'git@github.com-work:acme/shop.git' }], branches: [], recentSubjects: [...bumps, 'STEP-1 setup', 'STEP-2 data', 'STEP-3 ui', 'STEP-4 ship'] }, set);
    const s = set.toRecord();
    assert.ok(s['vcs:github']);
    assert.ok(!s['workflow:releases']);
    assert.ok(!s['tracker:issue-keys']);
  });

  it('detects the platforms behind the new registry entries', async () => {
    const cases: Array<[string, Record<string, string>, string[]]> = [
      ['Netlify', { 'netlify.toml': '[build]\ncommand = "npm run build"\n' }, ['cloud:netlify']],
      ['Fly.io and Pulumi', { 'fly.toml': 'app = "x"\n', 'Pulumi.yaml': 'name: x\nruntime: nodejs\n' }, ['cloud:fly', 'infra:pulumi']],
      ['Heroku app.json', { 'app.json': '{"name": "x", "buildpacks": [{"url": "heroku/nodejs"}]}' }, ['cloud:heroku']],
      ['Expo app.json and EAS', { 'app.json': '{"expo": {"name": "x"}}', 'eas.json': '{}' }, ['tech:expo']],
      ['Flutter', { 'pubspec.yaml': 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n', 'lib/main.dart': 'void main() {}' }, ['lang:dart', 'tech:flutter']],
      ['Unity', { 'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 6000.0.1f1\n', 'Packages/manifest.json': '{"dependencies":{"com.unity.inputsystem":"1.7.0"}}' }, ['tech:unity']],
      ['Unreal', { 'Game.uproject': '{}', 'Source/Game/Game.Build.cs': 'class Game {}' }, ['tech:unreal']],
      ['Angular, Nx, Storybook', { 'angular.json': '{}', 'nx.json': '{}', '.storybook/main.ts': 'export default {}' }, ['tech:angular', 'tool:nx', 'tool:storybook']],
      ['Shopify theme', { 'layout/theme.liquid': '<html></html>' }, ['tech:shopify', 'lang:liquid']],
      ['shadcn', { 'components.json': '{"$schema": "https://ui.shadcn.com/schema.json"}' }, ['tool:shadcn']],
      ['Develocity', { 'settings.gradle.kts': 'plugins { id("com.gradle.develocity") version "4.0" }\n' }, ['tool:develocity']],
      ['Claude Code plugin', { '.claude-plugin/plugin.json': '{"name": "x"}' }, ['tech:claude-plugin']],
      ['env keys and hosts', { '.env.example': 'DD_API_KEY=\nPOSTHOG_KEY=\nTURSO_DATABASE_URL=libsql://db-acme.turso.io\nAUTH_DOMAIN=acme.eu.auth0.com\n' }, ['obs:datadog', 'obs:posthog', 'db:turso', 'tech:auth0']],
      ['CI steps', { '.github/workflows/deploy.yml': 'jobs:\n  d:\n    steps:\n      - uses: superfly/flyctl-actions/setup-flyctl@master\n      - run: pulumi up --yes\n' }, ['cloud:fly', 'infra:pulumi']],
      ['Terraform providers', { 'main.tf': 'terraform {\n  required_providers {\n    datadog = { source = "DataDog/datadog" }\n    netlify = { source = "netlify/netlify" }\n  }\n}\n' }, ['obs:datadog', 'cloud:netlify']],
      ['tracker links', { 'README.md': 'Tasks: https://app.asana.com/0/123/456 and https://acme.monday.com/boards/1\n' }, ['tracker:asana', 'tracker:monday']],
      ['service SDKs', { 'package.json': '{"dependencies":{"dd-trace":"5","@clerk/nextjs":"6","algoliasearch":"5","@upstash/redis":"1","@modelcontextprotocol/sdk":"1"}}' }, ['obs:datadog', 'tech:clerk', 'db:algolia', 'db:upstash', 'tech:mcp-server']],
      ['Hugging Face', { 'requirements.txt': 'transformers\nhuggingface_hub\n' }, ['ml:huggingface']],
    ];
    for (const [name, files, want] of cases) {
      const ctx = await analyzeProject(project(files), { git: NO_GIT });
      for (const id of want) assert.ok(ctx.signals[id], `${name}: expected ${id}, got ${Object.keys(ctx.signals).join(', ')}`);
    }
  });

  it('uv and PDM development dependencies are read, group names are not packages', () => {
    const names = pythonManifestNames('[tool.uv]\ndev-dependencies = ["pytest>=8", "ruff"]\n[tool.pdm.dev-dependencies]\nlint = ["mypy"]\n').sort();
    assert.deepEqual(names, ['mypy', 'pytest', 'ruff']);
  });
});

// ---------------- CLI, hooks and the MCP server ----------------

const CLI = path.join(REPO, 'src', 'cli.ts');
function cli(b: Sandbox, args: string[], opts: { input?: string; cwd?: string } = {}): { code: number; out: string; err: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? b.project,
    env: { ...b.env, PATH: process.env['PATH'], NO_COLOR: '1' } as NodeJS.ProcessEnv,
    input: opts.input ?? '',
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: res.status ?? -1, out: res.stdout, err: res.stderr };
}

describe('CLI, hooks and the MCP server', () => {
  it('the MCP server survives junk lines and answers batches with one array', async () => {
    assert.equal(((await handleMessage(null)) as { error: { code: number } }).error.code, -32600);
    assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'tools/list' }), undefined, 'a request sent as a notification is not answered');
    const b = box();
    const input = ['null', '[]', '[{"jsonrpc":"2.0","id":1,"method":"ping"}]', '{"jsonrpc":"2.0","method":"tools/list"}', '{"jsonrpc":"2.0","id":true,"method":"ping"}', '{"jsonrpc":"2.0","id":2,"method":"ping"}'].join('\n') + '\n';
    const r = cli(b, ['mcp'], { input });
    assert.equal(r.code, 0, r.err);
    const lines = r.out.trim().split('\n').map((l) => JSON.parse(l) as unknown);
    assert.equal(lines.length, 5, r.out);
    assert.equal((lines[0] as { error: { code: number } }).error.code, -32600);
    assert.equal((lines[1] as { error: { code: number } }).error.code, -32600);
    assert.ok(Array.isArray(lines[2]) && (lines[2] as Array<{ id: number }>)[0]?.id === 1);
    assert.equal((lines[3] as { error: { code: number } }).error.code, -32600);
    assert.equal((lines[4] as { id: number }).id, 2);
  });

  it('dismiss --project from a subfolder hides the tool for the whole repository', (t) => {
    if (!which('git')) {
      t.skip('git not installed');
      return;
    }
    const b = box({ 'src/Api/Program.cs': 'class P {}', 'README.md': '# shop\n' });
    spawnSync('git', ['init', '-q'], { cwd: b.project });
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/shop.git'], { cwd: b.project });
    const d = cli(b, ['dismiss', 'github', '--project'], { cwd: path.join(b.project, 'src', 'Api') });
    assert.equal(d.code, 0, d.err);
    // From the repository root (--all would show dismissed tools on purpose, so use --min-score).
    const r = cli(b, ['recommend', '--format', 'json', '--min-score', '0']);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out) as { recommendations: Array<{ id: string }>; suppressed: Array<{ id: string; reason: string }> };
    assert.ok(!out.recommendations.some((x) => x.id === 'github'));
    assert.ok(out.suppressed.some((x) => x.id === 'github' && /dismissed/.test(x.reason)));
  });

  it('every command honours --format json; bad formats, values and extra arguments fail', () => {
    const b = box();
    const runs: string[][] = [
      ['dismiss', 'github', '--for', '2d'], ['dismissed'], ['undismiss', 'GitHub MCP Server'], ['config', 'get', 'mode'], ['config'],
      ['config', 'set', 'mode', 'balanced'], ['rollback'], ['doctor'], ['try', 'context7', '--host', 'codex'],
    ];
    for (const args of runs) {
      const r = cli(b, [...args, '--format', 'json']);
      assert.ok(r.code === 0 || (args[0] === 'doctor' && r.code === 1), `${args.join(' ')}: ${r.err}`);
      assert.doesNotThrow(() => JSON.parse(r.out), `${args.join(' ')} printed: ${r.out}`);
    }
    assert.equal(cli(b, ['dismiss', 'github', '--format', 'bogus']).code, 2);
    assert.equal(cli(b, ['dismiss', 'redis', 'github']).code, 2);
    assert.equal(cli(b, ['registry', 'list', '--remote']).code, 2);
    assert.equal(cli(b, ['config', 'get', 'constructor']).code, 2);
    assert.equal(cli(b, ['config', 'set', 'minScore', '']).code, 2);
    assert.equal(cli(b, ['scan', './no-such-folder']).code, 2);
    assert.equal(cli(b, ['rollback', 'some-id', '--format', 'json']).code, 2, 'JSON rollback needs --yes');
  });

  it('a hand-edited state file does not break commands; expired snoozes are not listed', () => {
    const b = box();
    fs.mkdirSync(b.stackhome, { recursive: true });
    fs.writeFileSync(path.join(b.stackhome, 'state.json'), JSON.stringify({ version: 1, dismissed: { github: { until: 'x' }, redis: [{ at: '2026-01-01T00:00:00Z', until: '2026-01-02T00:00:00Z' }] }, projects: [] }));
    const r = cli(b, ['dismissed']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Nothing dismissed/);
    assert.equal(cli(b, ['recommend', '--format', 'json']).code, 0);
    const later = cli(b, ['dismiss', 'redis', '--for', '1d']);
    assert.match(later.out, /until \d{4}-\d\d-\d\d \d\d:\d\d \(UTC[+-]\d\d:\d\d\)/);
  });

  it('parallel state updates do not drop each other', async () => {
    const b = box();
    const script = path.join(b.root, 'writer.mjs');
    const storeUrl = new URL('file:///' + path.join(REPO, 'src', 'state', 'store.ts').replace(/\\/g, '/').replace(/^\/+/, '')).href;
    fs.writeFileSync(script, `import { Store } from ${JSON.stringify(storeUrl)};\nconst s = new Store(process.env);\nfor (let i = 0; i < 5; i++) s.updateState((st) => { st.projects[process.argv[2] + '-' + i] = { shown: {}, signals: [] }; });\n`);
    await Promise.all(
      Array.from({ length: 6 }, (_, k) => new Promise((resolve) => spawn(process.execPath, [script, `p${k}`], { env: { ...b.env, PATH: process.env['PATH'] } as NodeJS.ProcessEnv, stdio: 'ignore' }).on('exit', resolve))),
    );
    assert.equal(Object.keys(new Store(b.env).loadState().projects).length, 30);
  });

  it('recommend <path> prints install commands for that path', () => {
    const b = box();
    const r = cli(b, ['recommend', DEMO]);
    assert.equal(r.code, 0, r.err);
    const installs = r.out.split('\n').filter((l) => l.includes('stackhint install'));
    assert.ok(installs.length > 0);
    for (const l of installs) assert.ok(l.includes(DEMO), l);
  });

  it('finding many programs on PATH gives the same answer as one by one, faster', () => {
    const names = ['git', 'node', 'npx', 'claude', 'codex', 'definitely-not-installed-xyz'];
    const many = whichMany(names);
    for (const n of names) assert.equal(many[n], which(n), n);
  });
});

// ---------------- review of the 0.2.0 diff ----------------

describe('regressions found in the 0.2.0 changes', () => {
  const cls = (t: string): string[] => classifyTask(t, new SignalSet()).filter((x) => !x.startsWith('task:'));

  it('product words that are also ordinary English need product context', () => {
    const ordinary = [
      'Fix the angular velocity clamping in the physics step', 'Add the new relic sword to the loot table', 'Draw a honeycomb grid for the hex map',
      'Add a sanity check for the schema migration', 'check clerk user permissions in the admin panel', 'why is the build scan slow',
      'Unity of style across the docs', 'Railway timetable parser is broken', 'Make the sidebar Slack-style', 'add a zebra stripe to rows',
      'resend the confirmation email', 'astro physics constants table', 'unreal performance numbers',
    ];
    for (const t of ordinary) assert.deepEqual(cls(t), [], t);
    const product: Array<[string, string]> = [
      ['integrate stripe for the shop', 'payments:stripe'], ['set up stripe', 'payments:stripe'], ['set up the Angular router', 'tech:angular'],
      ['ng generate component header', 'tech:angular'], ['send metrics to New Relic', 'obs:newrelic'], ['query honeycomb traces for the slow endpoint', 'obs:honeycomb'],
      ['update the Sanity studio schema', 'tech:sanity'], ['add Clerk sign-in to the app', 'tech:clerk'], ['deploy to Railway', 'cloud:railway'],
      ['expo export for web', 'tech:expo'], ['add an Astro island', 'tech:astro'], ['the Unity editor crashes on play', 'tech:unity'],
      ['port the game to Unreal Engine 5', 'tech:unreal'], ['post a message to the Slack channel', 'tool:slack'], ['enable develocity build scans', 'tool:develocity'],
    ];
    for (const [t, id] of product) assert.ok(cls(t).includes(id), `${t} -> ${cls(t).join(',')}`);
  });

  it('dismiss --project in a subfolder covers the folder, the git root and the Claude Code session folder', (t) => {
    if (!which('git')) {
      t.skip('git not installed');
      return;
    }
    const b = box({ 'app/Program.cs': 'class P {}' });
    spawnSync('git', ['init', '-q'], { cwd: b.project });
    const app = path.join(b.project, 'app');
    const r = cli(b, ['dismiss', 'postgres-mcp-pro', '--project'], { cwd: app });
    assert.equal(r.code, 0, r.err);
    const store = new Store(b.env);
    const state = store.loadState();
    for (const dir of [app, b.project]) assert.ok(store.isDismissed(state, 'postgres-mcp-pro', store.projectKey(dir)), dir);
    assert.ok(!store.isDismissed(state, 'postgres-mcp-pro', store.projectKey(b.root)), 'not other folders');
  });

  it('Poetry dependencies with several constraints keep their name', () => {
    const toml = '[tool.poetry.dependencies]\npython = "^3.11"\ndjango = [\n  {version = "<4", python = "<3.8"},\n  {version = ">=4", python = ">=3.8"}\n]\nredis = "^5"\nnumpy = [{version = "1.24", python = "<3.12"}, {version = "2.0", python = ">=3.12"}]\n';
    assert.deepEqual(pythonManifestNames(toml).sort(), ['django', 'numpy', 'redis']);
  });

  it('a generated coverage report is not a frontend; Unity and Unreal files behind early branches are seen', async () => {
    const py = await analyzeProject(project({ 'app.py': 'import flask\n', 'htmlcov/index.html': '<html><script src="coverage_html.js"></script></html>', 'reports/index.html': '<script></script>' }), { git: NO_GIT });
    assert.ok(!py.signals['tech:frontend']);
    const unity = await analyzeProject(project({ 'Packages/manifest.json': '{"dependencies":{"com.unity.render-pipelines.universal":"17.0.3"}}' }), { git: NO_GIT });
    assert.ok(unity.signals['tech:unity']);
    const unreal = await analyzeProject(project({ 'Source/Game/Game.Build.cs': 'public class Game : ModuleRules {}' }), { git: NO_GIT });
    assert.ok(unreal.signals['tech:unreal']);
  });

  it('printed paths survive PowerShell, cmd.exe and Git Bash', () => {
    assert.equal(shellArg('E:\\PS\\kassa'), '"E:\\PS\\kassa"');
    assert.equal(shellArg('/home/me/shop'), '/home/me/shop');
    assert.equal(shellArg('C:\\Users\\me\\My Shop'), '"C:\\Users\\me\\My Shop"');
    const r = resolveSpec(entry('playwright'), 'codex', {});
    assert.match(tryCommand('codex', r, '', 'win32', 'posix'), /args=\["\/c", "npx"/);
    assert.match(tryCommand('codex', r, '', 'win32'), /args=\[''\/c'', ''npx''/);
  });
});
