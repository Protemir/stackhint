import fs from 'node:fs';
import path from 'node:path';
import type { GitInfo, ProjectContext } from '../types.ts';
import { readText } from '../util/fsx.ts';
import { relPath } from '../util/paths.ts';
import { readGit } from './git.ts';
import { CARGO, COMPOSER, GEMS, GO, IMAGES, MAVEN, NPM, NUGET, PYPI, matchPackage, type PackageRule } from './packages.ts';
import { SignalSet } from './signals.ts';
import { classifyTask } from './task.ts';

export interface AnalyzeOptions {
  task?: string;
  gitHistory?: boolean;
  maxFiles?: number;
  maxDepth?: number;
  timeBudgetMs?: number;
  /** For tests: inject git info instead of reading .git. */
  git?: GitInfo;
}

interface FileInfo {
  abs: string;
  rel: string;
  name: string;
  lower: string;
  ext: string;
  dir: string;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'bin', 'obj', 'dist', 'build', 'out', 'target', 'vendor',
  '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.svelte-kit', '.angular', 'coverage', '.idea',
  '.vs', '.vscode', '.cursor', '.gradle', '.terraform', '.tox', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', '.cache', '.turbo', '.parcel-cache', 'Pods', 'DerivedData', '.dart_tool',
  'bower_components', 'jspm_packages', '.yarn', '.pnpm-store', '.claude', '.codex', '.agents',
  '.stackhint', 'TestResults', 'artifacts', '.serverless', '.aws-sam', '.vercel', '.wrangler',
]);

/** Never read these, even if they match a detector. */
function isSecretFile(name: string): boolean {
  const n = name.toLowerCase();
  if (n === '.env') return true;
  if (n.startsWith('.env.') && !/\.(example|sample|template|dist|defaults)$/.test(n)) return true;
  if (/\.(pem|key|pfx|p12|jks|keystore|kdbx|ppk)$/.test(n)) return true;
  if (/^(id_rsa|id_ed25519|id_ecdsa|credentials|secrets?\.(json|ya?ml|toml))$/.test(n)) return true;
  if (/^appsettings\..*secret/.test(n) || n === 'secrets.json' || n === 'usersecrets.json') return true;
  return false;
}

export async function analyzeProject(rootInput: string, opts: AnalyzeOptions = {}): Promise<ProjectContext> {
  const started = Date.now();
  const root = path.resolve(rootInput);
  const set = new SignalSet();
  const warnings: string[] = [];
  const maxFiles = opts.maxFiles ?? 25_000;
  const maxDepth = opts.maxDepth ?? 10;
  const budget = opts.timeBudgetMs ?? 4_000;

  let st: fs.Stats | undefined;
  try {
    st = fs.statSync(root);
  } catch {
    st = undefined;
  }
  if (!st || !st.isDirectory()) {
    return {
      root,
      signals: {},
      git: { isRepo: false, remotes: [], branches: [], recentSubjects: [] },
      stats: { filesSeen: 0, filesRead: 0, truncated: false, elapsedMs: 0 },
      warnings: [`not a directory: ${root}`],
    };
  }

  // ---- walk ----
  const files: FileInfo[] = [];
  let truncated = false;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop() as { dir: string; depth: number };
    if (files.length >= maxFiles || Date.now() - started > budget) {
      truncated = true;
      break;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // avoid loops and leaving the project
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (e.name === 'env' && fs.existsSync(path.join(abs, 'pyvenv.cfg'))) continue;
        if (depth + 1 <= maxDepth) stack.push({ dir: abs, depth: depth + 1 });
        else truncated = true;
        continue;
      }
      if (!e.isFile()) continue;
      const lower = e.name.toLowerCase();
      files.push({ abs, rel: relPath(root, abs), name: e.name, lower, ext: path.extname(lower), dir });
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
    }
  }
  if (truncated) warnings.push('project is large; the scan stopped early and may miss some signals');

  // ---- reading with budget ----
  let filesRead = 0;
  let bytesRead = 0;
  const READ_FILES = 1500;
  const READ_BYTES = 24 * 1024 * 1024;
  const read = (f: FileInfo, max = 256 * 1024): string | undefined => {
    if (isSecretFile(f.name)) return undefined;
    if (filesRead >= READ_FILES || bytesRead >= READ_BYTES) return undefined;
    const t = readText(f.abs, max);
    if (t === undefined) return undefined;
    filesRead++;
    bytesRead += t.length;
    // Repository files are untrusted: cap line length so no detector regex can run long.
    if (t.length <= 2000) return t;
    const lines = t.split('\n');
    return lines.some((l) => l.length > 2000) ? lines.map((l) => (l.length > 2000 ? l.slice(0, 2000) : l)).join('\n') : t;
  };
  const ev = (f: FileInfo, detail: string) => ({ source: f.rel, detail });

  // ---- language by extension (sample and fixture folders do not count) ----
  const extCount = new Map<string, number>();
  for (const f of files) if (!isSampleDir(f.rel)) extCount.set(f.ext, (extCount.get(f.ext) ?? 0) + 1);
  const LANGS: Array<[string, string[]]> = [
    ['lang:csharp', ['.cs']],
    ['lang:fsharp', ['.fs']],
    ['lang:typescript', ['.ts', '.tsx', '.mts', '.cts']],
    ['lang:javascript', ['.js', '.jsx', '.mjs', '.cjs']],
    ['lang:python', ['.py']],
    ['lang:go', ['.go']],
    ['lang:rust', ['.rs']],
    ['lang:java', ['.java']],
    ['lang:kotlin', ['.kt', '.kts']],
    ['lang:php', ['.php']],
    ['lang:ruby', ['.rb']],
    ['lang:swift', ['.swift']],
    ['lang:cpp', ['.c', '.cc', '.cpp', '.h', '.hpp']],
  ];
  for (const [id, exts] of LANGS) {
    const n = exts.reduce((acc, e) => acc + (extCount.get(e) ?? 0), 0);
    if (n === 0) continue;
    const strength = n >= 20 ? 0.95 : n >= 5 ? 0.8 : 0.5;
    set.atLeast(id, strength, { source: '.', detail: `${n} ${exts.join('/')} file${n === 1 ? '' : 's'}` });
  }
  const uiFiles = ['.tsx', '.jsx', '.vue', '.svelte'].reduce((acc, e) => acc + (extCount.get(e) ?? 0), 0);
  if (uiFiles >= 5) set.add('tech:frontend', 0.7, { source: '.', detail: `${uiFiles} UI component files` });
  // Plain static sites: HTML pages with CSS or scripts.
  const htmlFiles = (extCount.get('.html') ?? 0) + (extCount.get('.htm') ?? 0);
  const styleOrScript = ['.css', '.scss', '.js', '.mjs'].reduce((acc, e) => acc + (extCount.get(e) ?? 0), 0);
  if (htmlFiles >= 3 && styleOrScript >= 1) set.add('tech:frontend', 0.6, { source: '.', detail: `${htmlFiles} HTML pages` });

  const applyPackages = (target: SignalSink, f: FileInfo, rules: PackageRule[], names: Iterable<string>, kind: string): void => {
    for (const name of names) {
      for (const [id, strength] of matchPackage(rules, name)) target.add(id, strength, ev(f, `${kind} ${name}`));
    }
  };
  // Sample/fixture folders collect into their own set; it is merged with a hard cap below.
  const sampleSet = new SignalSet();
  const sampleView: SignalSink = sampleSet;

  // ---- per-file detectors ----
  let k8sYamlChecked = 0;
  let mdChecked = 0;
  const migrationDirs = new Map<string, number>();
  const scaffold = new Map<string, number>();

  for (const f of files) {
    const sample = isSampleDir(f.rel);
    const target: SignalSink = sample ? sampleView : set;
    const n = f.lower;
    const relLower = f.rel.toLowerCase();
    const migrationDir = sample ? undefined : migrationGroup(f.rel);
    if (migrationDir) bump(migrationDirs, migrationDir);

    // .NET
    if (f.ext === '.csproj' || f.ext === '.fsproj' || f.ext === '.vbproj') {
      target.add('tech:dotnet', 0.95, ev(f, 'project file'));
      if (f.ext === '.csproj') target.add('lang:csharp', 0.9, ev(f, 'C# project'));
      const t = read(f);
      if (t) {
        if (/Sdk\s*=\s*"Microsoft\.NET\.Sdk\.Web"/i.test(t)) {
          target.add('tech:aspnetcore', 0.9, ev(f, 'ASP.NET Core web SDK'));
          target.add('api:rest', 0.6, ev(f, 'ASP.NET Core web SDK'));
        }
        if (/Sdk\s*=\s*"Aspire\.AppHost\.Sdk/i.test(t)) target.add('tech:aspire', 0.9, ev(f, '.NET Aspire app host'));
        applyPackages(target, f, NUGET, nugetPackages(t), 'package');
        if (/\.tests?\.(cs|fs)proj$/i.test(f.name) || /<IsTestProject>\s*true/i.test(t)) target.add('test:unit', 0.8, ev(f, 'test project'));
      }
      continue;
    }
    if (f.ext === '.sln' || f.ext === '.slnx') {
      target.add('tech:dotnet', 0.9, ev(f, 'solution file'));
      continue;
    }
    if (n === 'directory.packages.props' || n === 'directory.build.props' || n === 'packages.config') {
      target.add('tech:dotnet', 0.6, ev(f, f.name));
      const t = read(f);
      if (t) applyPackages(target, f, NUGET, nugetPackages(t), 'package');
      continue;
    }
    if (n === 'global.json' || n === 'nuget.config' || n === 'dotnet-tools.json') {
      target.add('tech:dotnet', 0.6, ev(f, f.name));
      continue;
    }
    if (/^appsettings(\.[a-z0-9_-]+)?\.json$/.test(n)) {
      target.add('tech:dotnet', 0.4, ev(f, f.name));
      const t = read(f);
      if (t) detectAppSettings(f, t, target);
      continue;
    }
    if (f.ext === '.cs') {
      const m = /^[A-Za-z0-9]+(Controller|Handler|Command|Query|Endpoint|Validator)\.cs$/.exec(f.name);
      if (m && m[1] && !sample) bump(scaffold, `*${m[1]}.cs`);
      continue;
    }

    // Node
    if (n === 'package.json') {
      const t = read(f);
      if (!t) continue;
      target.add('tech:node', 0.9, ev(f, 'package.json'));
      try {
        const pkg = JSON.parse(t) as Record<string, unknown>;
        const names = new Set<string>();
        for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
          const deps = pkg[key];
          if (deps && typeof deps === 'object') for (const d of Object.keys(deps as object)) names.add(d);
        }
        applyPackages(target, f, NPM, names, 'dependency');
      } catch {
        warnings.push(`could not parse ${f.rel}`);
      }
      continue;
    }
    if (n === 'schema.prisma') {
      target.add('orm:prisma', 0.9, ev(f, 'Prisma schema'));
      const t = read(f);
      const m = t ? /provider\s*=\s*"(postgresql|postgres|mysql|sqlserver|sqlite|mongodb|cockroachdb)"/.exec(t) : null;
      if (m && m[1]) {
        const map: Record<string, string> = {
          postgresql: 'db:postgres', postgres: 'db:postgres', cockroachdb: 'db:postgres', mysql: 'db:mysql',
          sqlserver: 'db:sqlserver', sqlite: 'db:sqlite', mongodb: 'db:mongodb',
        };
        const id = map[m[1]];
        if (id) target.add(id, 0.85, ev(f, `Prisma datasource ${m[1]}`));
      }
      continue;
    }
    if (/^(playwright)\.config\.(ts|js|mjs|cjs|mts)$/.test(n)) {
      target.add('test:e2e', 0.95, ev(f, 'Playwright config'));
      target.add('tool:playwright', 0.95, ev(f, 'Playwright config'));
      continue;
    }
    if (/^cypress\.config\.(ts|js|mjs|cjs)$/.test(n) || n === 'cypress.json') {
      target.add('test:e2e', 0.9, ev(f, 'Cypress config'));
      continue;
    }
    if (/^(jest|vitest)\.config\.(ts|js|mjs|cjs|mts|json)$/.test(n)) {
      target.add('test:unit', 0.85, ev(f, f.name));
      continue;
    }

    // Python
    if (/^requirements[\w.-]*\.txt$/.test(n) || n === 'constraints.txt') {
      target.add('lang:python', 0.85, ev(f, f.name));
      const t = read(f);
      if (t) applyPackages(target, f, PYPI, pythonRequirements(t), 'requirement');
      continue;
    }
    if (n === 'pyproject.toml' || n === 'pipfile' || n === 'setup.py' || n === 'setup.cfg' || n === 'environment.yml') {
      target.add('lang:python', 0.85, ev(f, f.name));
      const t = read(f);
      if (t) applyPackages(target, f, PYPI, pythonManifestNames(t, f.name), 'dependency');
      continue;
    }
    if (n === 'pytest.ini' || n === 'conftest.py' || n === 'tox.ini') {
      target.add('test:unit', 0.8, ev(f, f.name));
      continue;
    }
    if (n === 'alembic.ini') target.add('db:sql', 0.4, ev(f, 'Alembic migrations'));

    // Go / Rust / JVM / PHP / Ruby
    if (n === 'go.mod') {
      target.add('lang:go', 0.95, ev(f, 'go.mod'));
      const t = read(f);
      if (t) applyPackages(target, f, GO, goModules(t), 'module');
      continue;
    }
    if (n === 'cargo.toml') {
      target.add('lang:rust', 0.95, ev(f, 'Cargo.toml'));
      const t = read(f);
      if (t) applyPackages(target, f, CARGO, cargoDeps(t), 'crate');
      continue;
    }
    if (n === 'pom.xml' || n === 'build.gradle' || n === 'build.gradle.kts') {
      target.add(n.endsWith('.kts') ? 'lang:kotlin' : 'lang:java', 0.85, ev(f, f.name));
      const t = read(f);
      if (t) applyPackages(target, f, MAVEN, jvmCoordinates(t), 'artifact');
      continue;
    }
    if (n === 'composer.json') {
      target.add('lang:php', 0.9, ev(f, 'composer.json'));
      const t = read(f);
      if (t) {
        try {
          const c = JSON.parse(t) as Record<string, unknown>;
          const names = [...Object.keys((c['require'] as object) ?? {}), ...Object.keys((c['require-dev'] as object) ?? {})];
          applyPackages(target, f, COMPOSER, names, 'package');
        } catch {
          /* ignore */
        }
      }
      continue;
    }
    if (n === 'gemfile') {
      target.add('lang:ruby', 0.9, ev(f, 'Gemfile'));
      const t = read(f);
      if (t) applyPackages(target, f, GEMS, [...t.matchAll(/^[ \t]*gem[ \t]+['"]([^'"\n]{1,100})['"]/gm)].map((m) => m[1] as string), 'gem');
      continue;
    }
    // Containers
    if (n === 'dockerfile' || n.endsWith('.dockerfile') || n.startsWith('dockerfile.') || n === 'containerfile') {
      target.add('infra:docker', 0.9, ev(f, 'Dockerfile'));
      continue;
    }
    if (n === '.dockerignore') {
      target.add('infra:docker', 0.5, ev(f, '.dockerignore'));
      continue;
    }
    if (/^(docker-)?compose([.-][\w.-]+)?\.ya?ml$/.test(n)) {
      target.add('infra:docker', 0.9, ev(f, 'Compose file'));
      target.add('infra:compose', 0.9, ev(f, 'Compose file'));
      const t = read(f);
      if (t) {
        for (const m of t.matchAll(/^[ \t]*image:[ \t]*["']?([^\s"'#]{1,200})/gm)) {
          const image = (m[1] as string).toLowerCase();
          const bare = image.replace(/[:@].*$/, '');
          for (const [re, sigs] of IMAGES) {
            if (re.test(bare)) for (const [id, s] of sigs) target.add(id, s, ev(f, `service image ${image}`));
          }
        }
      }
      continue;
    }
    if (n === 'chart.yaml') {
      target.add('infra:helm', 0.9, ev(f, 'Helm chart'));
      target.add('infra:kubernetes', 0.7, ev(f, 'Helm chart'));
      continue;
    }
    if (n === 'kustomization.yaml' || n === 'kustomization.yml' || n === 'skaffold.yaml' || n === 'tiltfile') {
      target.add('infra:kubernetes', 0.8, ev(f, f.name));
      // fallthrough to YAML checks for Flux kustomizations
    }

    // CI
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(relLower)) {
      target.add('ci:github-actions', 0.95, ev(f, 'GitHub Actions workflow'));
      target.add('vcs:github', 0.6, ev(f, 'GitHub Actions workflow'));
      const t = read(f);
      if (t) detectCiContent(f, t, target);
      continue;
    }
    if (/^\.github\/(pull_request_template\.md|codeowners|dependabot\.ya?ml|issue_template\/.+)$/.test(relLower)) {
      target.add('vcs:github', 0.5, ev(f, f.name));
      if (relLower.includes('pull_request_template')) {
        const t = read(f, 64 * 1024);
        if (t) detectTrackerLinks(f, t, target, 0.7);
      }
      continue;
    }
    if (n === '.gitlab-ci.yml' || relLower.startsWith('.gitlab/')) {
      target.add('ci:gitlab-ci', n === '.gitlab-ci.yml' ? 0.95 : 0.5, ev(f, f.name));
      target.add('vcs:gitlab', 0.6, ev(f, f.name));
      const t = n === '.gitlab-ci.yml' ? read(f) : undefined;
      if (t) detectCiContent(f, t, target);
      continue;
    }
    if (n === 'azure-pipelines.yml' || n === 'azure-pipelines.yaml' || /^\.azure-?pipelines\//.test(relLower) || relLower.startsWith('.azuredevops/')) {
      target.add('ci:azure-pipelines', 0.95, ev(f, f.name));
      target.add('vcs:azure-repos', 0.4, ev(f, f.name));
      const t = read(f);
      if (t) detectCiContent(f, t, target);
      continue;
    }
    if (/^\.circleci\/config\.ya?ml$/.test(relLower)) {
      target.add('ci:circleci', 0.95, ev(f, 'CircleCI config'));
      continue;
    }
    if (n === 'jenkinsfile' || n.endsWith('.jenkinsfile')) {
      target.add('ci:jenkins', 0.95, ev(f, 'Jenkinsfile'));
      continue;
    }
    if (/^\.buildkite\/.+\.ya?ml$/.test(relLower) || n === 'buildkite.yml' || n === 'buildkite.yaml') {
      target.add('ci:buildkite', 0.95, ev(f, 'Buildkite pipeline'));
      continue;
    }
    if (n === 'bitbucket-pipelines.yml') {
      target.add('ci:bitbucket', 0.95, ev(f, 'Bitbucket Pipelines'));
      target.add('vcs:bitbucket', 0.6, ev(f, 'Bitbucket Pipelines'));
      continue;
    }

    // IaC and clouds
    if (f.ext === '.tf' || f.ext === '.tfvars' || n === 'terragrunt.hcl') {
      target.add('infra:terraform', 0.9, ev(f, 'Terraform'));
      if (f.ext === '.tf') {
        const t = read(f, 128 * 1024);
        if (t) detectTerraformProviders(f, t, target);
      }
      continue;
    }
    if (f.ext === '.bicep' || n === 'azure.yaml') {
      target.add('cloud:azure', 0.9, ev(f, f.name));
      continue;
    }
    if (n === 'cdk.json') {
      target.add('cloud:aws', 0.85, ev(f, 'AWS CDK'));
      continue;
    }
    if (n === 'serverless.yml' || n === 'serverless.yaml') {
      target.add('cloud:aws', 0.6, ev(f, 'Serverless Framework'));
      continue;
    }
    if (n === 'samconfig.toml') {
      target.add('cloud:aws', 0.85, ev(f, 'AWS SAM'));
      continue;
    }
    if (n === 'cloudbuild.yaml' || n === 'cloudbuild.yml') {
      target.add('cloud:gcp', 0.8, ev(f, 'Cloud Build'));
      continue;
    }
    if (n === 'firebase.json' || n === '.firebaserc') {
      target.add('db:firebase', 0.9, ev(f, f.name));
      target.add('cloud:gcp', 0.4, ev(f, f.name));
      continue;
    }
    if (/^wrangler\.(toml|json|jsonc)$/.test(n)) {
      target.add('cloud:cloudflare', 0.95, ev(f, f.name));
      continue;
    }
    if (n === 'vercel.json') {
      target.add('cloud:vercel', 0.9, ev(f, 'vercel.json'));
      continue;
    }
    if (relLower === 'supabase/config.toml') {
      target.add('db:supabase', 0.95, ev(f, 'Supabase project'));
      target.add('db:postgres', 0.5, ev(f, 'Supabase project'));
      continue;
    }

    // API
    if (/^(openapi|swagger)([.-][\w.-]*)?\.(ya?ml|json)$/.test(n) || /(^|\/)openapi\/[^/]+\.(ya?ml|json)$/.test(relLower)) {
      target.add('api:openapi', 0.9, ev(f, 'OpenAPI document'));
      target.add('api:rest', 0.6, ev(f, 'OpenAPI document'));
      continue;
    }
    if (f.ext === '.http' || f.ext === '.rest') {
      target.add('api:http-files', 0.8, ev(f, 'HTTP request file'));
      target.add('api:rest', 0.6, ev(f, 'HTTP request file'));
      continue;
    }
    if (n.endsWith('.postman_collection.json') || n.endsWith('.postman_environment.json') || relLower.startsWith('postman/') || relLower.startsWith('.postman/')) {
      target.add('api:postman', 0.9, ev(f, 'Postman collection'));
      continue;
    }
    if (f.ext === '.proto') {
      target.add('api:grpc', 0.85, ev(f, 'protobuf'));
      continue;
    }
    if (f.ext === '.graphql' || f.ext === '.gql') {
      target.add('api:graphql', 0.85, ev(f, 'GraphQL schema'));
      continue;
    }

    // Quality, observability
    if (n === 'sonar-project.properties' || n === '.sonarcloud.properties') {
      target.add('quality:sonar', 0.95, ev(f, f.name));
      continue;
    }
    if (n === '.semgrep.yml' || n === '.semgrep.yaml' || n === '.semgrepignore' || relLower.startsWith('.semgrep/')) {
      target.add('quality:semgrep', 0.9, ev(f, f.name));
      continue;
    }
    if (n === '.snyk') {
      target.add('quality:snyk', 0.95, ev(f, '.snyk policy'));
      continue;
    }
    if (n === 'sentry.properties' || n === '.sentryclirc' || /^sentry\.(client|server|edge)\.config\.(ts|js|mjs)$/.test(n)) {
      target.add('obs:sentry', 0.9, ev(f, f.name));
      continue;
    }
    if (n === 'prometheus.yml' || n === 'prometheus.yaml') {
      target.add('obs:prometheus', 0.8, ev(f, f.name));
      continue;
    }
    if (/(^|\/)grafana\/(provisioning|dashboards)\//.test(relLower)) {
      target.add('obs:grafana', 0.8, ev(f, 'Grafana provisioning'));
      continue;
    }

    // Env examples: key names and URL schemes only, never values.
    if (/^\.env\.(example|sample|template|dist|defaults)$/.test(n) || n === 'env.example' || n === 'example.env') {
      const t = read(f, 64 * 1024);
      if (t) detectEnvExample(f, t, target);
      continue;
    }

    // Named files that the generic YAML/Markdown branches below would otherwise swallow.
    if (n === 'mkdocs.yml' || /^docusaurus\.config\.(js|ts|mjs)$/.test(n) || n === 'docfx.json') {
      target.add('docs:site', 0.8, ev(f, f.name));
      continue;
    }
    if (n === 'claude.md' || n === 'agents.md') {
      target.add(n === 'claude.md' ? 'agent:claude-md' : 'agent:agents-md', 0.9, ev(f, f.name));
    }

    // YAML manifests: Kubernetes, Argo CD, Flux
    if ((f.ext === '.yaml' || f.ext === '.yml') && k8sYamlChecked < 400) {
      k8sYamlChecked++;
      const t = read(f, 128 * 1024);
      if (t && /^apiVersion:\s*\S+/m.test(t) && /^kind:\s*\S+/m.test(t)) {
        if (/argoproj\.io\//.test(t)) target.add('infra:argocd', 0.9, ev(f, 'Argo CD manifest'));
        if (/toolkit\.fluxcd\.io\//.test(t)) target.add('infra:flux', 0.9, ev(f, 'Flux manifest'));
        if (/^kind:\s*(Deployment|StatefulSet|DaemonSet|Service|Ingress|CronJob|Job|Pod|ConfigMap|Namespace|HorizontalPodAutoscaler|NetworkPolicy|HelmRelease|Kustomization|Application|ServiceAccount|Role|RoleBinding|PersistentVolumeClaim)\b/m.test(t)) {
          target.add('infra:kubernetes', 0.85, ev(f, 'Kubernetes manifest'));
        }
      }
      continue;
    }

    // Docs: tracker / design / docs links
    if ((f.ext === '.md' || f.ext === '.mdx' || f.ext === '.rst') && mdChecked < 60) {
      const top = /^(readme|contributing|development|onboarding|docs\/)/.test(relLower) || f.rel.split('/').length <= 2;
      if (!top) continue;
      mdChecked++;
      const t = read(f, 128 * 1024);
      if (t) detectTrackerLinks(f, t, target, relLower.startsWith('contributing') ? 0.6 : 0.5);
      continue;
    }
  }

  // Examples describe other projects: however many files they have, they stay weak evidence.
  for (const sig of Object.values(sampleSet.toRecord())) {
    const first = sig.evidence[0];
    if (first) set.atLeast(sig.id, Math.min(0.3, sig.strength * 0.35), { source: first.source, detail: `${first.detail} (in an example or fixture folder)` });
  }

  // ---- aggregate detectors ----
  for (const [dir, count] of migrationDirs) {
    if (count >= 8) {
      set.add('workflow:migrations', count >= 20 ? 0.7 : 0.55, { source: dir, detail: `${count} database migrations` });
    }
  }
  for (const [pattern, count] of scaffold) {
    if (count >= 10) {
      set.add('workflow:scaffolding', count >= 25 ? 0.65 : 0.5, { source: '.', detail: `${count} ${pattern} files with the same shape` });
    }
  }

  // ---- other MCP clients configured in the repo ----
  detectOtherClientConfigs(root, set);

  // ---- git ----
  const git = opts.git ?? (await readGit(root, { history: opts.gitHistory ?? true }));
  detectGit(git, set);

  // ---- explicit task ----
  let task: ProjectContext['task'];
  if (opts.task && opts.task.trim()) {
    const signals = classifyTask(opts.task, set);
    task = { text: opts.task.trim().slice(0, 500), signals };
  }

  // Derived: one SQL signal for "any relational database".
  for (const id of ['db:postgres', 'db:mysql', 'db:sqlserver', 'db:sqlite']) {
    const s = set.get(id);
    if (s) set.atLeast('db:sql', s.strength * 0.9, { source: s.evidence[0]?.source ?? '.', detail: `${id.slice(3)} detected` });
  }
  if (!set.has('lang:typescript') && set.has('tech:node')) {
    set.atLeast('lang:javascript', 0.6, { source: 'package.json', detail: 'Node project' });
  }

  return {
    root,
    signals: set.toRecord(),
    ...(task ? { task } : {}),
    git,
    stats: { filesSeen: files.length, filesRead, truncated, elapsedMs: Date.now() - started },
    warnings,
  };
}

/** Where detectors write signals. SignalSet implements it; sample folders get a scaled view. */
export interface SignalSink {
  add(id: string, strength: number, evidence: { source: string; detail: string }): void;
  atLeast(id: string, strength: number, evidence: { source: string; detail: string }): void;
}

/** Examples, samples and test fixtures describe other projects, not this one. */
export function isSampleDir(rel: string): boolean {
  const dir = rel.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  return /(^|\/)(examples?|samples?|fixtures?|__fixtures__|testdata|test-data|demos?)(\/|$)/i.test(dir);
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Directory that groups a database migration file, or undefined if the file is not one. */
export function migrationGroup(rel: string): string | undefined {
  const r = rel.replace(/\\/g, '/');
  const dir = path.posix.dirname(r);
  const name = path.posix.basename(r);
  // EF Core: 20240101123456_Name.cs (Designer files excluded)
  if (/^\d{14}_[A-Za-z0-9_]+\.cs$/.test(name)) return dir;
  // Rails
  if (/(^|\/)db\/migrate$/.test(dir) && /^\d+_[^/]+\.rb$/.test(name)) return dir;
  // Prisma: prisma/migrations/<stamp>_name/migration.sql
  if (name === 'migration.sql' && /(^|\/)migrations\/[^/]+$/.test(dir)) return path.posix.dirname(dir);
  // Plain SQL migrations and Alembic/Django-style version folders
  if (/(^|\/)migrations$/.test(dir) && /\.sql$/.test(name)) return dir;
  if (/(^|\/)(alembic|migrations)\/versions$/.test(dir) && /\.py$/.test(name)) return dir;
  if (/(^|\/)migrations$/.test(dir) && /^\d{4}_[a-z0-9_]+\.py$/.test(name)) return dir;
  return undefined;
}

// ---------- manifest parsers ----------

export function nugetPackages(xml: string): string[] {
  const out = new Set<string>();
  for (const m of xml.matchAll(/<Package(?:Reference|Version)\b[^>]{0,300}?\bInclude\s{0,5}=\s{0,5}"([^"]{1,200})"/gi)) out.add(m[1] as string);
  for (const m of xml.matchAll(/<package\b[^>]{0,300}?\bid\s{0,5}=\s{0,5}"([^"]{1,200})"/gi)) out.add(m[1] as string);
  return [...out];
}

export function pythonRequirements(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line || line.startsWith('-')) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
    if (m && m[1]) out.push(normalizePy(m[1]));
  }
  return out;
}

/** Requirement names from a quoted list like ["fastapi>=0.1", "psycopg[binary]"]. */
function quotedRequirements(list: string): string[] {
  const out: string[] = [];
  for (const m of list.matchAll(/["'] ?([A-Za-z0-9][A-Za-z0-9._-]{0,100}) ?(?:\[[^\]]{0,100}\])? ?(?:[<>=!~;@ ]|["'])/g)) out.push(normalizePy(m[1] as string));
  return out;
}

/** Collapse runs of spaces and tabs so that adjacent \s* in the patterns below cannot backtrack. */
function squeeze(text: string): string {
  return text.replace(/[ \t]+/g, ' ');
}

/**
 * Dependency names from pyproject.toml, Pipfile, setup.py, setup.cfg or environment.yml.
 * Only dependency sections are read, so a description that mentions "redis" is not a dependency.
 */
export function pythonManifestNames(rawText: string, fileName = 'pyproject.toml'): string[] {
  const out = new Set<string>();
  const name = fileName.toLowerCase();
  const text = squeeze(rawText);
  if (name === 'setup.py') {
    for (const m of text.matchAll(/(install_requires|requires|extras_require) ?= ?([[{][\s\S]{0,5000}?[\]}]) ?[,)]/g)) {
      for (const r of quotedRequirements(m[2] as string)) out.add(r);
    }
    return [...out];
  }
  if (name === 'setup.cfg') {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((l) => /^install_requires ?=/.test(l));
    for (let i = start + 1; start >= 0 && i < lines.length; i++) {
      const line = lines[i] as string;
      if (!/^[ \t]/.test(line) || !line.trim()) break;
      const r = /^ ?([A-Za-z0-9][A-Za-z0-9._-]{0,100})/.exec(line);
      if (r && r[1]) out.add(normalizePy(r[1]));
    }
    return [...out];
  }
  if (name === 'environment.yml') {
    const idx = text.search(/^dependencies:/m);
    if (idx >= 0) for (const m of text.slice(idx).matchAll(/^ ?- ?([A-Za-z0-9][A-Za-z0-9._-]{0,100})/gm)) out.add(normalizePy(m[1] as string));
    return [...out];
  }
  // TOML-shaped files: pyproject.toml and Pipfile.
  let section = '';
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] as string;
    const hash = line.search(/\s#/);
    if (hash >= 0) line = line.slice(0, hash);
    const header = /^ ?\[+ ?([^\]]{1,200}?) ?\]+ ?$/.exec(line);
    if (header && header[1]) {
      section = header[1].toLowerCase();
      continue;
    }
    const isDepTable =
      /(^|\.)(dependencies|dev-dependencies|optional-dependencies)$/.test(section) ||
      section === 'packages' ||
      section === 'dev-packages' ||
      section === 'dependency-groups' ||
      /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section);
    const kv = /^ ?([A-Za-z0-9][A-Za-z0-9._-]{0,100}|"[^"]{1,100}") ?= ?(.*)$/.exec(line);
    if (!kv || kv[1] === undefined) continue;
    const key = kv[1].replace(/"/g, '');
    let value = kv[2] ?? '';
    // Collect a multi-line array value.
    if (value.trimStart().startsWith('[') && !balanced(value)) {
      // Drop comments on continuation lines: an apostrophe in "# don't pin" would open a quote.
      while (i + 1 < lines.length && !balanced(value)) value += '\n' + stripTomlComment(lines[++i] as string);
    }
    if (section === 'project' && (key === 'dependencies' || key === 'optional-dependencies')) {
      for (const r of quotedRequirements(value)) out.add(r);
    } else if (section === 'project.optional-dependencies' || section === 'dependency-groups') {
      for (const r of quotedRequirements(value)) out.add(r);
    } else if (isDepTable && key !== 'python') {
      out.add(normalizePy(key));
    }
  }
  return [...out];
}

/** Remove a # comment that is not inside a quoted string. */
function stripTomlComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

function balanced(s: string): boolean {
  let depth = 0;
  let quote = '';
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
  }
  return depth <= 0;
}

function normalizePy(name: string): string {
  return name.toLowerCase().replace(/[_.]+/g, '-');
}

export function goModules(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const parts = raw.trim().replace(/^require\s+/, '').split(/\s+/);
    const mod = parts[0] ?? '';
    if (mod.length <= 200 && /^[a-z0-9.-]{1,100}\.[a-z]{2,20}\/\S+$/i.test(mod) && /^v\d/.test(parts[1] ?? '')) out.push(mod);
  }
  return out;
}

export function cargoDeps(text: string): string[] {
  const out = new Set<string>();
  let inDeps = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec && sec[1]) {
      const name = sec[1];
      inDeps = /(^|\.)(dev-|build-)?dependencies$/.test(name);
      const sub = /(?:^|\.)(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/.exec(name);
      if (sub && sub[1]) out.add(sub[1]);
      continue;
    }
    if (!inDeps) continue;
    const m = /^([A-Za-z0-9_-]+)\s*=/.exec(line);
    if (m && m[1]) out.add(m[1]);
  }
  return [...out];
}

export function jvmCoordinates(text: string): string[] {
  const out = new Set<string>();
  // Maven
  const t = squeeze(text);
  for (const m of t.matchAll(/<groupId> ?([^<\s]{1,200}) ?<\/groupId>\s{0,20}<artifactId> ?([^<\s]{1,200}) ?<\/artifactId>/g)) {
    out.add(`${m[1]}:${m[2]}`);
  }
  // Gradle: "group:artifact:version" strings
  for (const m of t.matchAll(/["']([A-Za-z0-9_.-]{1,100}):([A-Za-z0-9_.-]{1,100})(?::[^"'\n]{0,100})?["']/g)) out.add(`${m[1]}:${m[2]}`);
  return [...out];
}

// ---------- content detectors ----------

function detectAppSettings(f: FileInfo, text: string, set: SignalSink): void {
  let json: unknown;
  try {
    json = JSON.parse(stripJsonComments(text));
  } catch {
    return;
  }
  if (!json || typeof json !== 'object') return;
  const obj = json as Record<string, unknown>;
  const cs = obj['ConnectionStrings'];
  if (cs && typeof cs === 'object') {
    for (const [name, value] of Object.entries(cs as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      const kind = classifyConnectionString(value);
      if (kind) set.add(kind.signal, 0.75, { source: f.rel, detail: `ConnectionStrings:${name} looks like ${kind.label}` });
    }
  }
  for (const key of Object.keys(obj)) {
    const k = key.toLowerCase();
    if (k === 'sentry') set.add('obs:sentry', 0.8, { source: f.rel, detail: 'Sentry section' });
    if (k === 'jira') set.add('tracker:jira', 0.6, { source: f.rel, detail: 'Jira section' });
    if (k === 'stripe') set.add('payments:stripe', 0.7, { source: f.rel, detail: 'Stripe section' });
    if (k === 'clickhouse') set.add('db:clickhouse', 0.7, { source: f.rel, detail: 'ClickHouse section' });
    if (k === 'redis') set.add('db:redis', 0.6, { source: f.rel, detail: 'Redis section' });
  }
}

export function classifyConnectionString(value: string): { signal: string; label: string } | undefined {
  const v = value.trim();
  if (/^postgres(ql)?:\/\//i.test(v)) return { signal: 'db:postgres', label: 'PostgreSQL' };
  if (/^mysql:\/\//i.test(v)) return { signal: 'db:mysql', label: 'MySQL' };
  if (/^mongodb(\+srv)?:\/\//i.test(v)) return { signal: 'db:mongodb', label: 'MongoDB' };
  if (/^rediss?:\/\//i.test(v)) return { signal: 'db:redis', label: 'Redis' };
  if (/^(clickhouse|ch):\/\//i.test(v)) return { signal: 'db:clickhouse', label: 'ClickHouse' };
  if (/^sqlserver:\/\//i.test(v)) return { signal: 'db:sqlserver', label: 'SQL Server' };
  const kv = v.toLowerCase();
  if (/(^|;)\s*host\s*=/.test(kv) && /(^|;)\s*(username|user id|database)\s*=/.test(kv) && !/initial catalog/.test(kv)) {
    return { signal: 'db:postgres', label: 'PostgreSQL (Npgsql)' };
  }
  if (/(^|;)\s*(server|data source)\s*=/.test(kv) && /(initial catalog|trusted_connection|integrated security|trustservercertificate|multipleactiveresultsets)/.test(kv)) {
    return { signal: 'db:sqlserver', label: 'SQL Server' };
  }
  if (/(^|;)\s*server\s*=/.test(kv) && /(^|;)\s*(uid|user)\s*=/.test(kv) && /(^|;)\s*database\s*=/.test(kv)) {
    return { signal: 'db:mysql', label: 'MySQL' };
  }
  if (/(^|;)\s*data source\s*=\s*[^;]+\.(db|sqlite3?)\b/.test(kv)) return { signal: 'db:sqlite', label: 'SQLite' };
  if (/:6379\b/.test(kv) || /^[^;=]+:\d+,(abortconnect|ssl|password)=/.test(kv)) return { signal: 'db:redis', label: 'Redis' };
  return undefined;
}

function stripJsonComments(text: string): string {
  // appsettings.json allows comments and trailing commas.
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i++;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s{0,200}[}\]])/g, '$1');
}

function detectEnvExample(f: FileInfo, text: string, set: SignalSink): void {
  const KEYS: Array<[RegExp, string, number]> = [
    [/^(POSTGRES_|PG(HOST|USER|DATABASE|PASSWORD|PORT)\b)/, 'db:postgres', 0.6],
    [/^MYSQL_/, 'db:mysql', 0.6],
    [/^(MSSQL_|SQLSERVER_)/, 'db:sqlserver', 0.6],
    [/^(MONGO|MDB_)/, 'db:mongodb', 0.65],
    [/^REDIS_/, 'db:redis', 0.55],
    [/^CLICKHOUSE_/, 'db:clickhouse', 0.75],
    [/^(ELASTIC|ES_URL|OPENSEARCH)/, 'db:elasticsearch', 0.55],
    [/^(NEXT_PUBLIC_)?SUPABASE_/, 'db:supabase', 0.8],
    [/^STRIPE_/, 'payments:stripe', 0.75],
    [/^(NEXT_PUBLIC_)?SENTRY_/, 'obs:sentry', 0.8],
    [/^JIRA_/, 'tracker:jira', 0.75],
    [/^CONFLUENCE_/, 'tracker:confluence', 0.7],
    [/^LINEAR_/, 'tracker:linear', 0.75],
    [/^AWS_/, 'cloud:aws', 0.55],
    [/^(AZURE_|ARM_)/, 'cloud:azure', 0.55],
    [/^(GOOGLE_CLOUD_|GCP_|GCLOUD_)/, 'cloud:gcp', 0.55],
    [/^CLOUDFLARE_|^CF_API_TOKEN/, 'cloud:cloudflare', 0.6],
    [/^VERCEL_/, 'cloud:vercel', 0.5],
    [/^(NEXT_PUBLIC_)?FIREBASE_/, 'db:firebase', 0.7],
    [/^FIGMA_/, 'design:figma', 0.6],
    [/^NOTION_/, 'docs:notion', 0.6],
    [/^GRAFANA_/, 'obs:grafana', 0.6],
    [/^POSTMAN_/, 'api:postman', 0.6],
    [/^SONAR/, 'quality:sonar', 0.6],
    [/^ARGOCD_/, 'infra:argocd', 0.6],
  ];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]{0,100})[ \t]*=[ \t]*(.*)$/.exec(raw.slice(0, 2000));
    if (!m || !m[1]) continue;
    const key = m[1].toUpperCase();
    const value = (m[2] ?? '').trim().replace(/^["']|["']$/g, '');
    for (const [re, id, s] of KEYS) if (re.test(key)) set.add(id, s, { source: f.rel, detail: `env key ${key}` });
    if (/^(DATABASE_URL|DB_URL|DATABASE_URI|DB_CONNECTION)$/.test(key) || /_URL$|_URI$|CONNECTION/.test(key)) {
      const kind = classifyConnectionString(value);
      if (kind) set.add(kind.signal, 0.7, { source: f.rel, detail: `${key} uses a ${kind.label} URL` });
      if (/^prisma\+postgres:\/\//i.test(value)) set.add('db:prisma-postgres', 0.85, { source: f.rel, detail: `${key} uses Prisma Postgres` });
    }
    // Host suffixes only; the value itself is never stored.
    if (/\.supabase\.co\b/i.test(value)) set.add('db:supabase', 0.85, { source: f.rel, detail: `${key} points at Supabase` });
    if (/\bneon\.tech\b/i.test(value)) set.add('db:neon', 0.85, { source: f.rel, detail: `${key} points at Neon` });
    if (/\bclickhouse\.cloud\b/i.test(value)) set.add('db:clickhouse-cloud', 0.85, { source: f.rel, detail: `${key} points at ClickHouse Cloud` });
    if (/\batlassian\.net\b/i.test(value)) set.add('tracker:jira', 0.75, { source: f.rel, detail: `${key} points at Atlassian Cloud` });
  }
}

function detectTrackerLinks(f: FileInfo, text: string, set: SignalSink, base: number): void {
  const once = (re: RegExp, id: string, strength: number, detail: (m: RegExpExecArray) => string): void => {
    const m = re.exec(text);
    if (m) set.add(id, strength, { source: f.rel, detail: detail(m) });
  };
  // Quantifiers are bounded (DNS labels are at most 63 characters) so long junk stays fast.
  once(/\b([a-z0-9-]{1,63})\.atlassian\.net\/(browse|jira|secure)\b/i, 'tracker:jira', 0.85, (m) => `links to ${m[1]}.atlassian.net Jira`);
  once(/\b([a-z0-9-]{1,63})\.atlassian\.net\/wiki\b/i, 'tracker:confluence', 0.85, (m) => `links to ${m[1]}.atlassian.net Confluence`);
  once(/\bhttps?:\/\/(jira\.[a-z0-9.-]{1,100}\.[a-z]{2,20})\//i, 'tracker:jira-server', 0.8, (m) => `links to self-hosted ${m[1]}`);
  once(/\bhttps?:\/\/(jira\.[a-z0-9.-]{1,100}\.[a-z]{2,20})\//i, 'tracker:jira', 0.75, (m) => `links to self-hosted ${m[1]}`);
  once(/\bhttps?:\/\/(confluence\.[a-z0-9.-]{1,100}\.[a-z]{2,20})\//i, 'tracker:confluence', 0.75, (m) => `links to self-hosted ${m[1]}`);
  once(/\bhttps?:\/\/(confluence\.[a-z0-9.-]{1,100}\.[a-z]{2,20})\//i, 'tracker:confluence-server', 0.8, (m) => `links to self-hosted ${m[1]}`);
  once(/\bjira\b/i, 'tracker:jira', base * 0.6, () => 'mentions Jira');
  once(/\blinear\.app\/[a-z0-9-]{1,64}\/(issue|project|team)\b/i, 'tracker:linear', 0.85, () => 'links to Linear issues');
  once(/\bfigma\.com\/(file|design|proto|board)\//i, 'design:figma', 0.8, () => 'links to Figma files');
  once(/\bnotion\.(so|site)\//i, 'docs:notion', 0.6, () => 'links to Notion');
  once(/\bdev\.azure\.com\//i, 'vcs:azure-repos', 0.5, () => 'links to Azure DevOps');
  once(/\bsentry\.io\/(organizations|issues)\//i, 'obs:sentry', 0.5, () => 'links to Sentry');
  once(/\b(app\.)?getpostman\.com\/|\bpostman\.com\/[a-z0-9-]{1,64}\/workspace\//i, 'api:postman', 0.6, () => 'links to Postman');
}

function detectCiContent(f: FileInfo, text: string, set: SignalSink): void {
  const t = text;
  const add = (re: RegExp, id: string, s: number, detail: string): void => {
    if (re.test(t)) set.add(id, s, { source: f.rel, detail });
  };
  add(/docker\/(build-push-action|login-action)|\bdocker (build|push)\b/, 'infra:docker', 0.6, 'CI builds containers');
  add(/\bkubectl\b|azure\/k8s-deploy|google-github-actions\/get-gke-credentials/, 'infra:kubernetes', 0.6, 'CI deploys to Kubernetes');
  add(/\bhelm (upgrade|install)\b|azure\/setup-helm/, 'infra:helm', 0.6, 'CI uses Helm');
  add(/hashicorp\/setup-terraform|\bterraform (plan|apply)\b/, 'infra:terraform', 0.6, 'CI runs Terraform');
  add(/aws-actions\/configure-aws-credentials|\baws (s3|ecs|lambda|cloudformation|ecr)\b/, 'cloud:aws', 0.6, 'CI talks to AWS');
  add(/azure\/login|AzureCLI@|AzureWebApp@|\baz (webapp|aks|acr|login)\b/, 'cloud:azure', 0.6, 'CI talks to Azure');
  add(/google-github-actions\/auth|\bgcloud (run|builds|container)\b/, 'cloud:gcp', 0.6, 'CI talks to Google Cloud');
  add(/cloudflare\/wrangler-action|\bwrangler deploy\b/, 'cloud:cloudflare', 0.7, 'CI deploys to Cloudflare');
  add(/sonarsource\/|SonarCloud|sonarqube|SonarQubePrepare@/i, 'quality:sonar', 0.8, 'CI runs Sonar');
  add(/semgrep/i, 'quality:semgrep', 0.75, 'CI runs Semgrep');
  add(/snyk\//i, 'quality:snyk', 0.75, 'CI runs Snyk');
  add(/\bdotnet (test|build|publish)\b|actions\/setup-dotnet|UseDotNet@/, 'tech:dotnet', 0.6, 'CI builds .NET');
  add(/getsentry\/action-release|sentry-cli/, 'obs:sentry', 0.7, 'CI creates Sentry releases');
  add(/playwright (test|install)/, 'test:e2e', 0.8, 'CI runs Playwright');
}

function detectTerraformProviders(f: FileInfo, text: string, set: SignalSink): void {
  const P: Array<[RegExp, string, number]> = [
    [/(provider\s+"aws"|hashicorp\/aws)/, 'cloud:aws', 0.85],
    [/(provider\s+"azurerm"|hashicorp\/azurerm|provider\s+"azuread")/, 'cloud:azure', 0.85],
    [/(provider\s+"google"|hashicorp\/google)/, 'cloud:gcp', 0.85],
    [/(provider\s+"cloudflare"|cloudflare\/cloudflare)/, 'cloud:cloudflare', 0.85],
    [/(provider\s+"kubernetes"|hashicorp\/kubernetes)/, 'infra:kubernetes', 0.5],
    [/(provider\s+"helm"|hashicorp\/helm)/, 'infra:helm', 0.5],
    [/vercel\/vercel/, 'cloud:vercel', 0.8],
    [/(provider\s+"grafana"|grafana\/grafana)/, 'obs:grafana', 0.6],
  ];
  for (const [re, id, s] of P) if (re.test(text)) set.add(id, s, { source: f.rel, detail: 'Terraform provider' });
}

/** MCP servers the team configured for other clients (VS Code, Cursor) in this repo. */
function detectOtherClientConfigs(root: string, set: SignalSet): void {
  const candidates: Array<[string, string]> = [
    ['.vscode/mcp.json', 'servers'],
    ['.cursor/mcp.json', 'mcpServers'],
  ];
  for (const [rel, key] of candidates) {
    const text = readText(path.join(root, rel), 256 * 1024);
    if (!text) continue;
    let json: unknown;
    try {
      json = JSON.parse(stripJsonComments(text));
    } catch {
      continue;
    }
    const servers = json && typeof json === 'object' ? (json as Record<string, unknown>)[key] : undefined;
    if (!servers || typeof servers !== 'object') continue;
    for (const [name, def] of Object.entries(servers as Record<string, unknown>)) {
      if (!def || typeof def !== 'object') continue;
      const d = def as Record<string, unknown>;
      const fingerprint = [name, d['url'], d['command'], ...(Array.isArray(d['args']) ? d['args'] : [])]
        .filter((x) => typeof x === 'string')
        .join(' ')
        .toLowerCase();
      set.add('team-mcp:' + fingerprintKey(fingerprint), 0.8, { source: rel, detail: `team configured MCP server "${name}" for another client` });
    }
  }
}

/** Compact, comparable key used by the engine to match team-configured servers to registry entries. */
export function fingerprintKey(s: string): string {
  return s.replace(/\s+/g, ' ').slice(0, 300);
}

const ISSUE_KEY_STOP = new Set([
  'UTF', 'ISO', 'SHA', 'CVE', 'RFC', 'COVID', 'GPT', 'HTTP', 'TLS', 'SSL', 'MD', 'AES', 'RSA', 'ECMA', 'ES',
  'PEP', 'JSR', 'KB', 'MS', 'X', 'H', 'V', 'IPV', 'WIN', 'NET', 'CSS', 'HTML', 'ARM', 'GHSA', 'PR', 'MR', 'P', 'Q',
  'NUGET', 'NPM', 'ID', 'API', 'UI', 'OS', 'VS', 'SQL', 'JDK', 'K', 'S', 'R', 'PY', 'NODE', 'LTS', 'BUG', 'T', 'TASK',
  'GH', 'GHE', 'ISSUE', 'FIX', 'FEAT', 'TICKET', 'STORY', 'RELEASE', 'TLS', 'HTTP2', 'PHP', 'JS', 'TS', 'CS',
]);

export function detectGit(git: GitInfo, set: SignalSet): void {
  if (!git.isRepo) return;
  set.add('vcs:git', 0.95, { source: 'git', detail: 'git repository' });
  for (const r of git.remotes) {
    const h = r.host;
    if (h === 'github.com' || h.endsWith('.ghe.com')) set.add('vcs:github', 0.95, { source: 'git', detail: `remote ${r.name} on ${h}` });
    else if (h === 'gitlab.com' || h.includes('gitlab')) set.add('vcs:gitlab', 0.9, { source: 'git', detail: `remote ${r.name} on ${h}` });
    else if (h === 'dev.azure.com' || h.endsWith('.visualstudio.com') || h === 'ssh.dev.azure.com') {
      set.add('vcs:azure-repos', 0.95, { source: 'git', detail: `remote ${r.name} on Azure DevOps` });
    } else if (h === 'bitbucket.org' || h.includes('bitbucket')) set.add('vcs:bitbucket', 0.9, { source: 'git', detail: `remote ${r.name} on ${h}` });
  }

  // Issue keys (PROJ-123) in branch names and commit subjects.
  const keys = new Map<string, Set<string>>();
  const texts = [...git.branches, ...(git.branch ? [git.branch] : []), ...git.recentSubjects];
  for (const full of texts) {
    const t = full.slice(0, 300);
    for (const m of t.matchAll(/(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,9})-(\d{1,6})(?![A-Za-z0-9])/g)) {
      const prefix = m[1] as string;
      if (ISSUE_KEY_STOP.has(prefix)) continue;
      if (!keys.has(prefix)) keys.set(prefix, new Set());
      (keys.get(prefix) as Set<string>).add(m[2] as string);
    }
  }
  const strong = [...keys.entries()].filter(([, nums]) => nums.size >= 3).sort((a, b) => b[1].size - a[1].size);
  if (strong.length > 0) {
    const [prefix, nums] = strong[0] as [string, Set<string>];
    set.add('tracker:issue-keys', 0.8, { source: 'git', detail: `${nums.size} issue keys like ${prefix}-${[...nums][0]} in branches/commits` });
    set.add('tracker:jira', 0.45, { source: 'git', detail: `issue keys like ${prefix}-${[...nums][0]} (Jira-style)` });
  }

  // Linear-style branch names: user/eng-123-title
  const NOT_LINEAR = /^(issue|issues|bug|bugs|gh|pr|fix|feat|feature|hotfix|task|ticket|story|release|v)$/;
  const linearBranches = git.branches.filter((b) => {
    const m = /^[a-z0-9._-]{1,60}\/([a-z]{2,6})-\d{1,6}(-|$)/.exec(b);
    return Boolean(m && m[1] && !NOT_LINEAR.test(m[1]));
  });
  if (linearBranches.length >= 2) {
    set.add('tracker:linear', 0.5, { source: 'git', detail: `${linearBranches.length} Linear-style branch names` });
  }

  // Repeated commit shapes suggest a workflow worth a skill or script.
  const shapes = new Map<string, number>();
  for (const s of git.recentSubjects) {
    // Unicode-aware, so Cyrillic or other non-Latin subjects keep their words.
    const parts = s
      .slice(0, 200)
      .toLowerCase()
      .replace(/\p{L}+-\d+/gu, 'key')
      .replace(/\d+(\.\d+)*/g, '#')
      .replace(/["'`][^"'`]{0,100}["'`]/g, 'x')
      .replace(/[^\p{L}#\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3);
    // A shape needs at least two real words; "# # #" or "fix #" says nothing about the workflow.
    if (parts.filter((w) => /\p{L}{2,}/u.test(w)).length < 2) continue;
    const shape = parts.join(' ');
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
  }
  for (const [shape, count] of shapes) {
    if (count < 8) continue;
    if (/^(merge (pull|branch|remote)|update readme|fix typo)/.test(shape)) continue;
    const isRelease = /^(bump|release|version|prepare release|chore release)\b/.test(shape);
    set.add(isRelease ? 'workflow:releases' : 'workflow:repetitive-commits', count >= 15 ? 0.65 : 0.5, {
      source: 'git',
      detail: `${count} recent commits start with "${shape}"`,
    });
  }
}
