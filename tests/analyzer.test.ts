import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  analyzeProject,
  cargoDeps,
  classifyConnectionString,
  detectGit,
  goModules,
  jvmCoordinates,
  migrationGroup,
  nugetPackages,
  pythonManifestNames,
  pythonRequirements,
} from '../src/context/analyzer.ts';
import { readGit } from '../src/context/git.ts';
import { SignalSet } from '../src/context/signals.ts';
import { classifyTask } from '../src/context/task.ts';
import { which } from '../src/util/exec.ts';
import { DEMO, NO_GIT, tmp, writeFiles } from './helpers.ts';

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const d = tmp('sh-proj-');
  dirs.push(d);
  writeFiles(d, files);
  return d;
}
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const has = (ctx: { signals: Record<string, { strength: number }> }, id: string, min = 0.01): boolean => (ctx.signals[id]?.strength ?? 0) >= min;

describe('analyzer: .NET demo project', () => {
  it('detects the stack from evidence', async () => {
    const ctx = await analyzeProject(DEMO, { git: NO_GIT });
    for (const id of ['tech:dotnet', 'lang:csharp', 'tech:aspnetcore', 'db:postgres', 'db:redis', 'orm:efcore', 'infra:docker', 'ci:github-actions', 'api:openapi', 'api:http-files', 'test:unit', 'tracker:jira']) {
      assert.ok(has(ctx, id, 0.5), `${id} missing: ${JSON.stringify(Object.keys(ctx.signals))}`);
    }
    assert.ok(has(ctx, 'workflow:migrations'), 'EF Core migrations should be counted');
    assert.ok(has(ctx, 'workflow:scaffolding'), 'controllers with the same shape should be counted');
    // Evidence points at files, never at values.
    const pg = ctx.signals['db:postgres'];
    assert.ok(pg?.evidence.some((e) => e.source === 'docker-compose.yml'));
    const all = JSON.stringify(ctx);
    assert.ok(!all.includes('dev-only'), 'connection string password leaked into the context');
    assert.ok(!has(ctx, 'infra:kubernetes'), 'no Kubernetes in this project');
    assert.ok(!has(ctx, 'cloud:aws'));
  });
});

describe('analyzer: privacy and safety', () => {
  it('never reads .env, private keys or secret files', async () => {
    const root = project({
      '.env': 'STRIPE_SECRET_KEY=sk_live_should_never_be_read\nDATABASE_URL=postgres://u:p@prod/db\n',
      '.env.local': 'SENTRY_DSN=https://secret@sentry.io/1',
      'id_rsa': 'PRIVATE',
      'server.pem': 'PRIVATE',
      'secrets.json': '{"jira": "x"}',
      'package.json': '{"dependencies": {"express": "4"}}',
    });
    const ctx = await analyzeProject(root, { git: NO_GIT });
    assert.ok(!has(ctx, 'payments:stripe'), '.env must not be read');
    assert.ok(!has(ctx, 'obs:sentry'), '.env.local must not be read');
    assert.ok(!has(ctx, 'db:postgres'));
    assert.ok(!JSON.stringify(ctx).includes('sk_live'));
    assert.ok(has(ctx, 'api:rest'));
  });

  it('skips secret settings files even when a detector would match them', async () => {
    const root = project({
      'appsettings.Secrets.json': JSON.stringify({ Stripe: { SecretKey: 'sk_live_x' }, ConnectionStrings: { Db: 'Host=prod;Database=x;Username=u;Password=p' } }),
      'appsettings.json': JSON.stringify({ Logging: {} }),
    });
    const ctx = await analyzeProject(root, { git: NO_GIT });
    assert.ok(!has(ctx, 'payments:stripe'), 'appsettings.Secrets.json must not be read');
    assert.ok(!has(ctx, 'db:postgres'));
    assert.ok(has(ctx, 'tech:dotnet'), 'the plain appsettings.json is still read');
  });

  it('reads key names from .env.example but never stores values', async () => {
    const root = project({
      '.env.example': 'export DATABASE_URL="postgres://user:pa55word@localhost:5432/app"\nSTRIPE_SECRET_KEY=sk_test_123\nNEXT_PUBLIC_SUPABASE_URL=https://abc.supabase.co\nJIRA_BASE_URL=https://acme.atlassian.net\n',
    });
    const ctx = await analyzeProject(root, { git: NO_GIT });
    assert.ok(has(ctx, 'db:postgres', 0.6));
    assert.ok(has(ctx, 'payments:stripe', 0.6));
    assert.ok(has(ctx, 'db:supabase', 0.8));
    assert.ok(has(ctx, 'tracker:jira', 0.7));
    const text = JSON.stringify(ctx);
    for (const leaked of ['pa55word', 'sk_test_123', 'abc.supabase.co', 'acme.atlassian.net']) assert.ok(!text.includes(leaked), `${leaked} leaked`);
  });

  it('skips binary and oversized files and stays inside the project', async () => {
    const root = project({ 'package.json': JSON.stringify({ dependencies: { pg: '8' } }) });
    fs.writeFileSync(path.join(root, 'blob.json'), Buffer.from([0, 1, 2, 3, 0, 0]));
    fs.writeFileSync(path.join(root, 'docker-compose.yml'), 'services:\n  db:\n    image: mysql:8\n' + '#'.repeat(600 * 1024));
    const ctx = await analyzeProject(root, { git: NO_GIT });
    assert.ok(has(ctx, 'db:postgres'));
    assert.ok(!has(ctx, 'db:mysql'), 'oversized compose file should be skipped');
  });

  it('does not follow symlinks (no loops, no escaping the project)', async (t) => {
    const outside = project({ 'package.json': JSON.stringify({ dependencies: { mongodb: '6' } }) });
    const root = project({ 'package.json': '{}' });
    try {
      fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
      fs.symlinkSync(root, path.join(root, 'loop'), 'junction');
    } catch {
      t.skip('cannot create symlinks here');
      return;
    }
    const ctx = await analyzeProject(root, { git: NO_GIT });
    assert.ok(!has(ctx, 'db:mongodb'), 'followed a symlink out of the project');
  });

  it('stops at the file budget and says so', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i++) files[`src/f${i}.ts`] = 'export {}';
    const root = project(files);
    const ctx = await analyzeProject(root, { git: NO_GIT, maxFiles: 20 });
    assert.equal(ctx.stats.truncated, true);
    assert.ok(ctx.warnings.some((w) => w.includes('stopped early')));
  });

  it('handles empty and missing directories', async () => {
    const empty = project({});
    const ctx = await analyzeProject(empty, { git: NO_GIT });
    assert.deepEqual(Object.keys(ctx.signals), []);
    const missing = await analyzeProject(path.join(empty, 'nope'), { git: NO_GIT });
    assert.ok(missing.warnings[0]?.includes('not a directory'));
  });

  it('ignores dependency folders and build output', async () => {
    const root = project({
      'node_modules/pg/package.json': JSON.stringify({ dependencies: { pg: '1' } }),
      'bin/Debug/x.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="MongoDB.Driver" /></ItemGroup></Project>',
      'package.json': '{"name":"x"}',
    });
    const ctx = await analyzeProject(root, { git: NO_GIT });
    assert.ok(!has(ctx, 'db:postgres'));
    assert.ok(!has(ctx, 'db:mongodb'));
  });
});

describe('analyzer: other stacks', () => {
  it('Node + Kubernetes + Helm + Terraform + Argo CD', async () => {
    const root = project({
      'package.json': JSON.stringify({ dependencies: { next: '15', react: '19', '@prisma/client': '6', stripe: '17' }, devDependencies: { '@playwright/test': '1', typescript: '5' } }),
      'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}',
      'deploy/api.yaml': 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n',
      'deploy/app.yaml': 'apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: api\n',
      'charts/api/Chart.yaml': 'apiVersion: v2\nname: api\n',
      'infra/main.tf': 'terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws" }\n  }\n}\nprovider "aws" {}',
      'Dockerfile': 'FROM node:22',
    });
    const ctx = await analyzeProject(root, { git: NO_GIT });
    for (const id of ['tech:frontend', 'tech:nextjs', 'orm:prisma', 'db:postgres', 'payments:stripe', 'test:e2e', 'tool:playwright', 'lang:typescript', 'infra:kubernetes', 'infra:argocd', 'infra:helm', 'infra:terraform', 'cloud:aws', 'infra:docker']) {
      assert.ok(has(ctx, id), `${id} missing`);
    }
  });

  it('Python with pyproject and ClickHouse', async () => {
    const root = project({
      'pyproject.toml': `[project]
name = "analytics"
description = "Mentions redis and kubernetes but does not depend on them"
dependencies = [
  "fastapi>=0.110",
  "clickhouse-connect>=0.7",
  "psycopg[binary]>=3.1",
]
[project.optional-dependencies]
test = ["pytest>=8"]
[tool.ruff]
line-length = 100
`,
      'app/main.py': 'print(1)',
    });
    const ctx = await analyzeProject(root, { git: NO_GIT });
    for (const id of ['lang:python', 'db:clickhouse', 'db:postgres', 'api:rest', 'api:openapi', 'test:unit']) assert.ok(has(ctx, id), `${id} missing`);
    assert.ok(!has(ctx, 'db:redis'), 'description text is not a dependency');
    assert.ok(!has(ctx, 'infra:kubernetes'));
  });

  it('Go, Rust, Java, CI providers and team MCP configs', async () => {
    const root = project({
      'go.mod': 'module x\n\ngo 1.23\n\nrequire (\n\tgithub.com/jackc/pgx/v5 v5.7.0\n\tgithub.com/getsentry/sentry-go v0.30.0\n)\n',
      'svc/Cargo.toml': '[package]\nname="s"\n[dependencies]\ntonic = "0.12"\nredis = { version = "0.27" }\n',
      'jvm/pom.xml': '<project><dependencies><dependency><groupId>com.microsoft.sqlserver</groupId><artifactId>mssql-jdbc</artifactId></dependency></dependencies></project>',
      '.gitlab-ci.yml': 'test:\n  script: [terraform plan]\n',
      'Jenkinsfile': 'pipeline {}',
      '.circleci/config.yml': 'version: 2.1',
      '.vscode/mcp.json': '{ // comment\n "servers": { "sentry": { "type": "http", "url": "https://mcp.sentry.dev/mcp" } } }',
    });
    const ctx = await analyzeProject(root, { git: NO_GIT });
    for (const id of ['lang:go', 'db:postgres', 'obs:sentry', 'lang:rust', 'api:grpc', 'db:redis', 'db:sqlserver', 'ci:gitlab-ci', 'vcs:gitlab', 'ci:jenkins', 'ci:circleci', 'infra:terraform']) {
      assert.ok(has(ctx, id), `${id} missing`);
    }
    assert.ok(Object.keys(ctx.signals).some((k) => k.startsWith('team-mcp:') && k.includes('mcp.sentry.dev')));
  });

  it('README mentions are weak evidence, links are strong', async () => {
    const weak = project({ 'README.md': 'We track work in Jira sometimes.' });
    const strong = project({ 'README.md': 'Board: https://acme.atlassian.net/browse/ABC-1 and specs https://acme.atlassian.net/wiki/spaces/X' });
    const selfHosted = project({ 'CONTRIBUTING.md': 'File tickets at https://jira.example.com/browse/ABC-1' });
    const w = await analyzeProject(weak, { git: NO_GIT });
    const s = await analyzeProject(strong, { git: NO_GIT });
    const h = await analyzeProject(selfHosted, { git: NO_GIT });
    assert.ok((w.signals['tracker:jira']?.strength ?? 0) < 0.5);
    assert.ok((s.signals['tracker:jira']?.strength ?? 0) >= 0.8);
    assert.ok(has(s, 'tracker:confluence', 0.8));
    assert.ok(has(h, 'tracker:jira-server', 0.8));
  });
});

describe('manifest parsers', () => {
  it('reads NuGet references including central package management', () => {
    assert.deepEqual(nugetPackages('<PackageReference Include="Npgsql" Version="8" /><PackageVersion Include="Dapper" Version="2"/><package id="NUnit" version="3" />').sort(), ['Dapper', 'NUnit', 'Npgsql']);
  });
  it('reads requirements.txt', () => {
    assert.deepEqual(pythonRequirements('# c\nDjango==5.0\npsycopg2-binary>=2 ; python_version>"3"\n-r other.txt\n\nredis[hiredis]\n'), ['django', 'psycopg2-binary', 'redis']);
  });
  it('reads Poetry, Pipfile, setup.py and setup.cfg dependency sections only', () => {
    assert.deepEqual(pythonManifestNames('[tool.poetry]\nname="x"\n[tool.poetry.dependencies]\npython = "^3.12"\nfastapi = "^0.1"\n[tool.poetry.group.dev.dependencies]\npytest = "*"\n').sort(), ['fastapi', 'pytest']);
    assert.deepEqual(pythonManifestNames('[packages]\nflask = "*"\n[dev-packages]\npytest = "*"\n', 'Pipfile').sort(), ['flask', 'pytest']);
    assert.deepEqual(pythonManifestNames('setup(name="x", description="uses redis", install_requires=["boto3>=1", "pymongo"],)', 'setup.py').sort(), ['boto3', 'pymongo']);
    assert.deepEqual(pythonManifestNames('[options]\ninstall_requires =\n    sqlalchemy>=2\n    asyncpg\n', 'setup.cfg').sort(), ['asyncpg', 'sqlalchemy']);
  });
  it('reads go.mod, Cargo.toml and JVM builds', () => {
    assert.deepEqual(goModules('module a\nrequire github.com/lib/pq v1.10.9\nrequire (\n\tk8s.io/client-go v0.31.0 // indirect\n)'), ['github.com/lib/pq', 'k8s.io/client-go']);
    assert.deepEqual(cargoDeps('[dependencies]\nserde = "1"\n[dev-dependencies]\nmockall = "0.13"\n[dependencies.sqlx]\nversion = "0.8"\n').sort(), ['mockall', 'serde', 'sqlx']);
    assert.ok(jvmCoordinates("implementation 'org.postgresql:postgresql:42.7.4'").includes('org.postgresql:postgresql'));
  });
  it('classifies connection strings without keeping them', () => {
    assert.equal(classifyConnectionString('Host=db;Database=x;Username=u;Password=p')?.signal, 'db:postgres');
    assert.equal(classifyConnectionString('Server=.;Initial Catalog=Shop;Trusted_Connection=True')?.signal, 'db:sqlserver');
    assert.equal(classifyConnectionString('Server=db;Database=x;Uid=u;Pwd=p')?.signal, 'db:mysql');
    assert.equal(classifyConnectionString('mongodb+srv://u:p@c/db')?.signal, 'db:mongodb');
    assert.equal(classifyConnectionString('localhost:6379,abortConnect=false')?.signal, 'db:redis');
    assert.equal(classifyConnectionString('Data Source=app.db')?.signal, 'db:sqlite');
    assert.equal(classifyConnectionString('hello'), undefined);
  });
  it('groups migration files', () => {
    assert.equal(migrationGroup('src/Api/Migrations/20240101120000_Init.cs'), 'src/Api/Migrations');
    assert.equal(migrationGroup('src/Api/Migrations/20240101120000_Init.Designer.cs'), undefined);
    assert.equal(migrationGroup('prisma/migrations/20240101_init/migration.sql'), 'prisma/migrations');
    assert.equal(migrationGroup('db/migrate/20240101_add_users.rb'), 'db/migrate');
    assert.equal(migrationGroup('alembic/versions/abc_add.py'), 'alembic/versions');
    assert.equal(migrationGroup('src/main.cs'), undefined);
  });
});

describe('git signals', () => {
  it('reads remotes, Jira keys, Linear branches and repeated commits', () => {
    const set = new SignalSet();
    detectGit(
      {
        isRepo: true,
        branch: 'feature/SHOP-120-cart',
        remotes: [{ name: 'origin', host: 'github.com', url: 'https://github.com/acme/shop.git' }],
        branches: ['feature/SHOP-101-x', 'bugfix/SHOP-102-y', 'ana/eng-12-thing', 'bob/eng-44-other', 'main'],
        recentSubjects: [
          'SHOP-103 fix totals',
          'Bump version to 1.2.3',
          ...Array.from({ length: 9 }, (_, i) => `Add migration AddTable${i}`),
          'Upgrade to UTF-8 and ISO-8601 and SHA-256',
        ],
      },
      set,
    );
    const r = set.toRecord();
    assert.ok((r['vcs:github']?.strength ?? 0) > 0.9);
    assert.ok(r['tracker:issue-keys']);
    assert.ok(r['tracker:jira']);
    assert.ok(r['tracker:linear']);
    assert.ok(r['workflow:repetitive-commits']?.evidence[0]?.detail.includes('add migration'));
  });

  it('ignores standards that look like issue keys', () => {
    const set = new SignalSet();
    detectGit({ isRepo: true, remotes: [], branches: [], recentSubjects: ['Support UTF-8', 'Use ISO-8601', 'SHA-256 hashes', 'CVE-2024-1 fix', 'RFC-7231', 'GPT-4 prompt'] }, set);
    assert.equal(set.get('tracker:issue-keys'), undefined);
  });

  it('reads a real repository without credentials in remote URLs', async (t) => {
    if (!which('git')) {
      t.skip('git not installed');
      return;
    }
    const root = project({ 'a.txt': '1' });
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    };
    git('init', '-q', '-b', 'feature/PAY-7-refunds');
    git('remote', 'add', 'origin', 'https://user:ghp_secret123456789012345@github.com/acme/pay.git');
    for (const k of ['PAY-1', 'PAY-2', 'PAY-3']) {
      fs.writeFileSync(path.join(root, 'a.txt'), k);
      git('add', '.');
      git('commit', '-q', '-m', `${k}: change`);
    }
    const info = await readGit(root, { history: true });
    assert.equal(info.branch, 'feature/PAY-7-refunds');
    assert.equal(info.remotes[0]?.host, 'github.com');
    assert.ok(!JSON.stringify(info).includes('ghp_secret'), 'credentials leaked from the remote URL');
    assert.equal(info.recentSubjects.length, 3);
    const ctx = await analyzeProject(root, {});
    assert.ok(has(ctx, 'tracker:jira'));
    assert.ok(has(ctx, 'vcs:github', 0.9));
  });
});

describe('task classification', () => {
  const cases: Array<[string, string[]]> = [
    ['Review PR #42 and check why CI is red', ['task:pr-review', 'task:ci']],
    ['debug slow PostgreSQL query on orders', ['task:db', 'db:postgres']],
    ['Implement a REST endpoint and update the OpenAPI spec', ['task:api']],
    ['I keep writing the same boilerplate controller every time', ['task:boilerplate']],
    ['pods crash-looping in the k8s cluster', ['task:containers', 'infra:kubernetes']],
    ['Сделай ревью пулл-реквеста и посмотри тикет в джире', ['task:pr-review', 'tracker:jira', 'task:issue-tracking']],
    ['почему медленный запрос к базе данных', ['task:db']],
    ['падает с ошибкой, посмотри логи', ['task:observability']],
  ];
  for (const [text, expected] of cases) {
    it(text, () => {
      const set = new SignalSet();
      const found = classifyTask(text, set);
      for (const e of expected) assert.ok(found.includes(e), `${e} not in ${found.join(',')}`);
      assert.ok(set.get(expected[0] as string)?.evidence[0]?.source === 'task');
    });
  }
  it('avoids false positives', () => {
    const set = new SignalSet();
    const found = classifyTask('fit a linear regression on the каталог data', set);
    assert.ok(!found.includes('tracker:linear'));
    assert.ok(!found.includes('task:observability'), 'каталог is not логи');
  });
});
