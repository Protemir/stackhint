import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { analyzeProject } from '../src/context/analyzer.ts';
import { recommend, relevance, type RecommendOptions } from '../src/engine/recommend.ts';
import { readInventory } from '../src/hosts/inventory.ts';
import { findEntry, loadRegistry, validateEntry } from '../src/registry/registry.ts';
import { Store } from '../src/state/store.ts';
import type { GitInfo, Inventory, ProjectContext, Registry } from '../src/types.ts';
import { DEMO, fakeWhich, NO_GIT, sandbox, writeFiles, type Sandbox } from './helpers.ts';

const registry = loadRegistry();
const boxes: Sandbox[] = [];
after(() => boxes.forEach((b) => b.cleanup()));

interface Run {
  ctx: ProjectContext;
  inv: Inventory;
  ids: string[];
  result: ReturnType<typeof recommend>;
  box: Sandbox;
}

async function run(
  files: Record<string, string>,
  opts: { task?: string; git?: GitInfo; mcpJson?: unknown; codexToml?: string; which?: Record<string, string>; reg?: Registry; rec?: Partial<RecommendOptions> } = {},
): Promise<Run> {
  const box = sandbox(files);
  boxes.push(box);
  if (opts.mcpJson) fs.writeFileSync(path.join(box.project, '.mcp.json'), JSON.stringify(opts.mcpJson));
  if (opts.codexToml) fs.writeFileSync(path.join(box.codexHome, 'config.toml'), opts.codexToml);
  const ctx = await analyzeProject(box.project, { git: opts.git ?? NO_GIT, ...(opts.task ? { task: opts.task } : {}) });
  const inv = readInventory(box.project, { env: box.env, which: fakeWhich(opts.which ?? {}) });
  const result = recommend(ctx, opts.reg ?? registry, inv, { hosts: ['claude', 'codex'], minScore: 30, limit: 20, platform: 'linux', now: Date.parse('2026-10-20T00:00:00Z'), ...opts.rec });
  return { ctx, inv, ids: result.recommendations.map((r) => r.id), result, box };
}

const githubGit: GitInfo = { isRepo: true, remotes: [{ name: 'origin', host: 'github.com', url: 'https://github.com/acme/app.git' }], branches: ['main'], recentSubjects: [] };

describe('scenarios from the brief', () => {
  it('1. Jira: recommends the Atlassian integration when the project links to Jira', async () => {
    const r = await run({ 'README.md': 'Tickets: https://acme.atlassian.net/browse/APP-1' });
    assert.ok(r.ids.includes('atlassian-rovo'), r.ids.join(','));
    const rec = r.result.recommendations.find((x) => x.id === 'atlassian-rovo');
    assert.match(rec?.whyNow ?? '', /atlassian\.net/);
    assert.ok(rec?.alternatives.includes('mcp-atlassian'));
  });

  it('1b. Self-hosted Jira gets the server/DC-capable integration first', async () => {
    const r = await run({ 'CONTRIBUTING.md': 'Open issues at https://jira.corp.example.com/browse/APP-1' });
    assert.equal(r.ids.filter((i) => i === 'mcp-atlassian' || i === 'atlassian-rovo')[0], 'mcp-atlassian', r.ids.join(','));
  });

  it('2. PostgreSQL debugging: recommends a database MCP with read-only access', async () => {
    const files = { 'docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n', 'package.json': JSON.stringify({ dependencies: { pg: '8' } }) };
    const withTask = await run(files, { task: 'debug a slow PostgreSQL query', which: { uvx: '/bin/uvx' } });
    const without = await run(files, { which: { uvx: '/bin/uvx' } });
    const a = withTask.result.recommendations.find((x) => x.id === 'postgres-mcp-pro');
    const b = without.result.recommendations.find((x) => x.id === 'postgres-mcp-pro');
    assert.ok(a, withTask.ids.join(','));
    assert.ok(!withTask.ids.includes('dbhub'), 'only one SQL server per group');
    assert.match(a.entry.access.summary, /restricted/);
    assert.equal(a.entry.install?.readOnly?.args?.includes('--access-mode=restricted'), true);
    assert.ok(!b || a.score > b.score, 'an explicit task raises the score');
    assert.equal(withTask.ids[0], 'postgres-mcp-pro', `task-matched tool should rank first: ${withTask.ids.join(',')}`);
  });

  it('3. REST API work: suggests documentation lookup', async () => {
    const r = await run({ 'package.json': JSON.stringify({ dependencies: { express: '5', '@nestjs/swagger': '8' } }), 'openapi.yaml': 'openapi: 3.1.0\n' }, { task: 'implement a new REST endpoint and check the docs for the latest NestJS API' });
    assert.ok(r.ids.includes('context7'), r.ids.join(','));
  });

  it('4. Pull request investigation: GitHub MCP and the code review plugin', async () => {
    const r = await run({ '.github/workflows/ci.yml': 'on: push' }, { git: githubGit, task: 'investigate PR #212, why the review asks for changes' });
    assert.ok(r.ids.includes('github'), r.ids.join(','));
    assert.ok(r.ids.includes('code-review-plugin'), r.ids.join(','));
    const gh = r.result.recommendations.find((x) => x.id === 'github');
    assert.equal(gh?.confidence, 'high');
  });

  it('5. Repetitive boilerplate: suggests a project skill', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 14; i++) files[`src/Api/Controllers/Thing${i}Controller.cs`] = 'class X {}';
    const r = await run(files, { task: 'I write the same boilerplate controller every time' });
    assert.ok(r.ids.includes('project-skill'), r.ids.join(','));
    assert.match(r.result.recommendations.find((x) => x.id === 'project-skill')?.whyNow ?? '', /Controller/);
  });

  it('6. Docker + Kubernetes: Kubernetes MCP, nothing for tools the project does not use', async () => {
    const r = await run({ 'Dockerfile': 'FROM alpine', 'k8s/deploy.yaml': 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: x\n', 'charts/x/Chart.yaml': 'name: x' }, { task: 'pods keep restarting in the cluster' });
    assert.ok(r.ids.includes('kubernetes'), r.ids.join(','));
    for (const absent of ['terraform', 'aws-mcp', 'azure-mcp', 'argocd', 'atlassian-rovo', 'stripe']) assert.ok(!r.ids.includes(absent), `${absent} without evidence`);
    assert.match(r.result.recommendations.find((x) => x.id === 'kubernetes')?.entry.install?.readOnly?.args?.join(' ') ?? '', /--read-only/);
  });

  it('7. Already configured: no duplicate install suggestion', async () => {
    const r = await run({ '.github/workflows/ci.yml': 'on: push' }, {
      git: githubGit,
      task: 'review this PR',
      mcpJson: { mcpServers: { gh: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' } } },
      codexToml: '[mcp_servers.github]\nurl = "https://api.githubcopilot.com/mcp/"\n',
    });
    assert.ok(!r.ids.includes('github'), r.ids.join(','));
    const existing = r.result.alreadyAvailable.find((x) => x.id === 'github');
    assert.equal(existing?.action, 'use-existing');
    assert.equal(existing?.availability.claude?.state, 'configured');
  });

  it('7b. Configured for one host only: recommends adding it to the other', async () => {
    const r = await run({}, { git: githubGit, task: 'review this PR', mcpJson: { mcpServers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' } } } });
    const gh = r.result.recommendations.find((x) => x.id === 'github');
    assert.ok(gh, r.ids.join(','));
    assert.equal(gh.availability.claude?.state, 'configured');
    assert.equal(gh.availability.codex?.state, 'not-configured');
  });

  it('7c. An equivalent server counts as a duplicate', async () => {
    const r = await run({ 'docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n' }, { task: 'slow postgres query', mcpJson: { mcpServers: { sql: { command: 'npx', args: ['-y', '@bytebase/dbhub@1.5.0'] } } }, codexToml: '[mcp_servers.sql]\ncommand = "npx"\nargs = ["@bytebase/dbhub"]\n' });
    assert.ok(!r.ids.includes('postgres-mcp-pro'), r.ids.join(','));
    assert.ok(r.result.alreadyAvailable.some((x) => x.id === 'postgres-mcp-pro' && x.whyNow.includes('DBHub as "sql" (Claude Code, Codex)')));
  });
});

describe('engine rules', () => {
  it('suggests the successor of an archived server that is still configured', async () => {
    const r = await run({}, { mcpJson: { mcpServers: { pg: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgres://localhost/x'] } } } });
    const rec = r.result.recommendations.find((x) => x.id === 'postgres-mcp-pro');
    assert.equal(rec?.action, 'replace');
    assert.ok((rec?.score ?? 0) >= 70);
    assert.match(rec?.whyNow ?? '', /no longer maintained/);
    assert.equal(r.ids[0], 'postgres-mcp-pro', 'replacements are listed first');
  });

  it('a mention in prose is not enough', async () => {
    const r = await run({ 'README.md': 'One day we may try Kubernetes, Terraform, Stripe or Sentry.' });
    assert.deepEqual(r.ids, []);
  });

  it('respects dismissals, snoozes and project scope', async () => {
    const files = { 'README.md': 'https://acme.atlassian.net/browse/A-1' };
    const box = sandbox(files);
    boxes.push(box);
    let now = Date.parse('2026-10-20T00:00:00Z');
    const store = new Store(box.env, () => now);
    const ctx = await analyzeProject(box.project, { git: NO_GIT });
    const inv = readInventory(box.project, { env: box.env, which: fakeWhich({}) });
    const key = store.projectKey(box.project);
    const go = () =>
      recommend(ctx, registry, inv, {
        hosts: ['claude'],
        platform: 'linux',
        now,
        isDismissed: (id) => (store.isDismissed(store.loadState(), id, key) ? 'dismissed' : undefined),
      });
    assert.ok(go().recommendations.some((x) => x.id === 'atlassian-rovo'));
    store.dismiss('atlassian-rovo', { forMs: 7 * 86_400_000 });
    assert.ok(!go().recommendations.some((x) => x.id === 'atlassian-rovo'));
    assert.ok(go().suppressed.some((s) => s.id === 'atlassian-rovo' && s.reason === 'dismissed'));
    now += 8 * 86_400_000;
    assert.ok(go().recommendations.some((x) => x.id === 'atlassian-rovo'), 'snooze expired');
    store.dismiss('atlassian-rovo', { projectKey: 'some-other-project' });
    assert.ok(go().recommendations.some((x) => x.id === 'atlassian-rovo'), 'dismissal for another project does not apply');
    store.dismiss('atlassian-rovo', {});
    assert.ok(!go().recommendations.some((x) => x.id === 'atlassian-rovo'));
    assert.ok(store.undismiss('atlassian-rovo'));
    assert.ok(go().recommendations.some((x) => x.id === 'atlassian-rovo'));
  });

  it('skips tools not available for the selected host', async () => {
    const files = { 'src/a.cs': 'x', 'src/b.cs': 'x', 'src/c.cs': 'x', 'src/d.cs': 'x', 'src/e.cs': 'x', 'App.csproj': '<Project Sdk="Microsoft.NET.Sdk"/>' };
    const claude = await run(files, { rec: { hosts: ['claude'] } });
    const codex = await run(files, { rec: { hosts: ['codex'] } });
    assert.ok(claude.ids.includes('csharp-lsp'), claude.ids.join(','));
    assert.ok(!codex.ids.includes('csharp-lsp'));
    assert.ok(codex.result.suppressed.some((s) => s.id === 'csharp-lsp' && /not available/.test(s.reason)));
  });

  it('lowers confidence for unverified compatibility and incomplete metadata', async () => {
    const custom = validateEntry(
      { id: 'mystery-db', name: 'Mystery DB tool', kind: 'mcp', description: 'Unknown tool for Postgres.', triggers: [{ signal: 'db:postgres', weight: 0.9 }], benefits: ['x'] },
      { origin: 'custom', defaultVerifiedAt: '' },
    ).entry;
    assert.ok(custom);
    const reg: Registry = { ...registry, entries: [...registry.entries, custom] };
    const r = await run({ 'docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n' }, { reg, rec: { minScore: 0 } });
    const rec = r.result.recommendations.find((x) => x.id === 'mystery-db') ?? r.result.alreadyAvailable.find((x) => x.id === 'mystery-db');
    assert.ok(rec, 'custom entry evaluated');
    assert.notEqual(rec.confidence, 'high');
    assert.ok(rec.uncertainty.some((u) => /not verified/.test(u)));
    assert.ok(rec.uncertainty.some((u) => /incomplete/.test(u)));
    const pro = r.result.recommendations.find((x) => x.id === 'postgres-mcp-pro');
    assert.ok(!pro || pro.score >= rec.score, 'verified entries outrank unknown ones with the same evidence');
  });

  it('scores are bounded, deterministic and explained', async () => {
    const a = await run({}, { git: githubGit, task: 'review PR' });
    const b = await run({}, { git: githubGit, task: 'review PR' });
    assert.deepEqual(a.ids, b.ids);
    for (const r of a.result.recommendations) {
      assert.ok(r.score >= 0 && r.score <= 100);
      assert.ok(r.whyNow.length > 10);
      assert.ok(r.reasons.length > 0);
      for (const v of Object.values(r.breakdown)) assert.ok(Number.isFinite(v));
    }
  });

  it('requiresAny gates entries that need specific evidence', () => {
    const ctx: ProjectContext = { root: '.', signals: { 'task:pr-review': { id: 'task:pr-review', strength: 0.9, evidence: [{ source: 'task', detail: 'x' }] } }, git: NO_GIT, stats: { filesSeen: 0, filesRead: 0, truncated: false, elapsedMs: 0 }, warnings: [] };
    assert.equal(relevance(findEntry(registry, 'gitlab')!, ctx).gated, true, 'GitLab needs GitLab evidence');
    assert.equal(relevance(findEntry(registry, 'code-review-plugin')!, ctx).gated, false);
  });

  it('a team MCP config for another client is strong evidence', async () => {
    const r = await run({ '.cursor/mcp.json': JSON.stringify({ mcpServers: { sentry: { url: 'https://mcp.sentry.dev/mcp' } } }) });
    const rec = r.result.recommendations.find((x) => x.id === 'sentry');
    assert.ok(rec, r.ids.join(','));
    assert.ok(rec.reasons.some((x) => x.signal === 'team:other-client'));
  });
});

describe('the .NET demo, end to end (nothing installed)', () => {
  it('recommends .NET docs and the Jira integration, and suggests nothing irrelevant', async () => {
    const box = sandbox();
    boxes.push(box);
    const ctx = await analyzeProject(DEMO, { git: NO_GIT });
    const inv = readInventory(DEMO, { env: box.env, which: fakeWhich({}) });
    const r = recommend(ctx, registry, inv, { hosts: ['claude', 'codex'], platform: 'linux' });
    const ids = r.recommendations.map((x) => x.id);
    assert.ok(ids.includes('microsoft-learn'), ids.join(','));
    assert.ok(ids.includes('atlassian-rovo'), ids.join(','));
    for (const absent of ['kubernetes', 'terraform', 'stripe', 'vercel', 'figma']) assert.ok(!ids.includes(absent), absent);
    const withTask = recommend(await analyzeProject(DEMO, { git: NO_GIT, task: 'orders query is slow in postgres' }), registry, inv, { hosts: ['claude'], platform: 'linux' });
    assert.equal(withTask.recommendations[0]?.id, 'postgres-mcp-pro');
    assert.equal(fs.existsSync(path.join(DEMO, '.mcp.json')), false, 'the demo must not be modified');
    writeFiles(box.root, {});
  });
});
