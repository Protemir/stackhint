import fs from 'node:fs';
import path from 'node:path';

import { readText } from '../util/fsx.js';
import { relPath } from '../util/paths.js';
import { redactString } from '../util/redact.js';
import { safeName } from '../util/text.js';
import { readGit } from './git.js';
import { CARGO, COMPOSER, GEMS, GO, IMAGES, MAVEN, NPM, NUGET, PYPI, matchPackage,                  } from './packages.js';
import { SignalSet } from './signals.js';
import { classifyTask } from './task.js';




















const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'bin', 'obj', 'dist', 'build', 'out', 'target', 'vendor',
  '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.svelte-kit', '.angular', 'coverage', '.idea',
  '.vs', '.vscode', '.cursor', '.gradle', '.terraform', '.tox', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', '.cache', '.turbo', '.parcel-cache', 'Pods', 'DerivedData', '.dart_tool',
  'bower_components', 'jspm_packages', '.yarn', '.pnpm-store', '.claude', '.codex', '.agents',
  '.stackhint', 'TestResults', 'artifacts', '.serverless', '.aws-sam', '.vercel', '.wrangler',
  'Intermediate', 'DerivedDataCache', '.netlify', 'htmlcov', '_site',
]);

/** Media, fonts, archives and binaries: no detector reads them, so they do not count against the file limit. */
const ASSET_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.icns', '.tif', '.tiff', '.psd', '.xcf', '.blend', '.fbx',
  '.glb', '.gltf', '.obj', '.mtl', '.ktx2', '.hdr', '.exr', '.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus', '.mp4',
  '.webm', '.mov', '.avi', '.mkv', '.ttf', '.otf', '.woff', '.woff2', '.eot', '.zip', '.gz', '.tgz', '.7z', '.rar', '.tar',
  '.exe', '.dll', '.so', '.dylib', '.pdb', '.class', '.jar', '.pyc', '.wasm', '.bin', '.dat', '.pdf', '.unity3d', '.asset',
]);

/** Never read these, even if they match a detector. */
function isSecretFile(name        )          {
  const n = name.toLowerCase();
  if (n === '.env') return true;
  if (n.startsWith('.env.') && !/\.(example|sample|template|dist|defaults)$/.test(n)) return true;
  if (/\.(pem|key|pfx|p12|jks|keystore|kdbx|ppk)$/.test(n)) return true;
  if (/^(id_rsa|id_ed25519|id_ecdsa|credentials|secrets?\.(json|ya?ml|toml))$/.test(n)) return true;
  if (/^appsettings\..*secret/.test(n) || n === 'secrets.json' || n === 'usersecrets.json') return true;
  return false;
}

export async function analyzeProject(rootInput        , opts                 = {})                          {
  const started = Date.now();
  const root = path.resolve(rootInput);
  const set = new SignalSet();
  const warnings           = [];
  const maxFiles = opts.maxFiles ?? 25_000;
  const maxDepth = opts.maxDepth ?? 14;
  const budget = opts.timeBudgetMs ?? 4_000;

  let st                      ;
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
  // Breadth first, so a huge asset folder cannot crowd out the project files near the root.
  const files             = [];
  let truncated = false;
  let tooDeep = false;
  const queue                                        = [{ dir: root, depth: 0 }];
  for (let qi = 0; qi < queue.length; qi++) {
    const { dir, depth } = queue[qi]                                  ;
    if (files.length >= maxFiles || Date.now() - started > budget) {
      truncated = true;
      break;
    }
    let entries             ;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // A Python virtual environment, whatever it is called.
    if (depth > 0 && entries.some((e) => e.name === 'pyvenv.cfg' && e.isFile())) continue;
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // avoid loops and leaving the project
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        // Unity regenerates Library, Temp and Logs next to ProjectSettings; they hold huge caches.
        if ((e.name === 'Library' || e.name === 'Temp' || e.name === 'Logs') && entries.some((x) => x.name === 'ProjectSettings' && x.isDirectory())) continue;
        if (depth + 1 <= maxDepth) queue.push({ dir: abs, depth: depth + 1 });
        else tooDeep = true;
        continue;
      }
      if (!e.isFile()) continue;
      const lower = e.name.toLowerCase();
      const ext = path.extname(lower);
      if (ASSET_EXTS.has(ext)) continue; // no detector reads media or binaries
      files.push({ abs, rel: relPath(root, abs), name: e.name, lower, ext, dir });
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
    }
  }
  if (truncated) warnings.push('project is large; the scan stopped early and may miss some signals');
  else if (tooDeep) warnings.push(`folders deeper than ${maxDepth} levels were not scanned`);

  // ---- reading with budget ----
  let filesRead = 0;
  let bytesRead = 0;
  const READ_FILES = 1500;
  const READ_BYTES = 24 * 1024 * 1024;
  // Reading gets the rest of the time budget plus half of it again, then stops: hooks must stay fast.
  const readDeadline = started + budget * 1.5;
  let readCut = false;
  const read = (f          , max = 256 * 1024)                     => {
    if (isSecretFile(f.name)) return undefined;
    if (filesRead >= READ_FILES || bytesRead >= READ_BYTES) return undefined;
    if (Date.now() > readDeadline) {
      readCut = true;
      return undefined;
    }
    const t = readText(f.abs, max);
    if (t === undefined) return undefined;
    filesRead++;
    bytesRead += t.length;
    // Repository files are untrusted: cap line length so no detector regex can run long.
    if (t.length <= 2000) return t;
    const lines = t.split('\n');
    return lines.some((l) => l.length > 2000) ? lines.map((l) => (l.length > 2000 ? l.slice(0, 2000) : l)).join('\n') : t;
  };
  // A file name used as the detail is the project's text: shown as a name (see safeName).
  const ev = (f          , detail        ) => ({ source: f.rel, detail: detail === f.name ? safeName(detail, 60) : detail });

  // ---- language by extension (sample and fixture folders do not count) ----
  const extCount = new Map                ();
  for (const f of files) {
    if (isSampleDir(f.rel) || f.lower.endsWith('.gradle.kts')) continue; // build scripts are not Kotlin code
    extCount.set(f.ext, (extCount.get(f.ext) ?? 0) + 1);
  }
  const LANGS                            = [
    ['lang:csharp', ['.cs']],
    ['lang:fsharp', ['.fs']],
    ['lang:typescript', ['.ts', '.tsx', '.mts', '.cts']],
    ['lang:javascript', ['.js', '.jsx', '.mjs', '.cjs']],
    ['lang:python', ['.py', '.pyi']],
    ['lang:go', ['.go']],
    ['lang:rust', ['.rs']],
    ['lang:java', ['.java']],
    ['lang:kotlin', ['.kt', '.kts']],
    ['lang:php', ['.php']],
    ['lang:ruby', ['.rb', '.rake', '.gemspec', '.ru', '.erb']],
    ['lang:swift', ['.swift']],
    ['lang:cpp', ['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.hxx']],
    ['lang:dart', ['.dart']],
    ['lang:lua', ['.lua']],
    ['lang:liquid', ['.liquid']],
  ];
  const langCount = (exts          )         => exts.reduce((acc, e) => acc + (extCount.get(e) ?? 0), 0);
  const codeTotal = LANGS.reduce((acc, [, exts]) => acc + langCount(exts), 0);
  for (const [id, exts] of LANGS) {
    const n = langCount(exts);
    if (n === 0) continue;
    // One stray file (a Homebrew formula, an editor config in Lua) is not the project's language.
    let strength = n >= 100 ? 0.95 : n >= 20 ? 0.85 : n >= 5 ? 0.7 : n >= 2 ? 0.45 : 0.3;
    // A handful of files next to a large codebase in another language is a side script.
    if (n < 50 && n / Math.max(1, codeTotal) < 0.05) strength = Math.min(strength, 0.45);
    set.atLeast(id, strength, { source: '.', detail: `${n} ${exts.join('/')} file${n === 1 ? '' : 's'}` });
  }
  /** Whether the project has source files with these extensions (outside example folders). */
  const hasCode = (...exts          )          => langCount(exts) > 0;
  const uiFiles = ['.tsx', '.jsx', '.vue', '.svelte'].reduce((acc, e) => acc + (extCount.get(e) ?? 0), 0);
  if (uiFiles >= 5) set.add('tech:frontend', 0.7, { source: '.', detail: `${uiFiles} UI component files` });
  // Plain static sites: HTML pages with CSS or scripts.
  const templates = files.filter((x) => /\.component\.html$/.test(x.lower) && !isSampleDir(x.rel)).length;
  const htmlFiles = (extCount.get('.html') ?? 0) + (extCount.get('.htm') ?? 0) - templates;
  const styleOrScript = ['.css', '.scss', '.js', '.mjs'].reduce((acc, e) => acc + (extCount.get(e) ?? 0), 0);
  if (htmlFiles >= 3 && styleOrScript >= 1) set.add('tech:frontend', 0.6, { source: '.', detail: `${htmlFiles} HTML pages` });
  // Component files of frameworks that have their own MCP servers.
  const svelteFiles = extCount.get('.svelte') ?? 0;
  if (svelteFiles >= 3) set.add('tech:svelte', 0.7, { source: '.', detail: String(svelteFiles) + ' .svelte files' });
  const astroFiles = extCount.get('.astro') ?? 0;
  if (astroFiles >= 3) set.add('tech:astro', 0.7, { source: '.', detail: String(astroFiles) + ' .astro files' });
  const unityFiles = (extCount.get('.unity') ?? 0) + (extCount.get('.asmdef') ?? 0);
  if (unityFiles >= 1) set.add('tech:unity', 0.7, { source: '.', detail: String(unityFiles) + ' Unity scenes or assembly definitions' });

  const applyPackages = (target            , f          , rules               , names                  , kind        )       => {
    for (const name of names) {
      for (const [id, strength] of matchPackage(rules, name)) target.add(id, strength, ev(f, `${kind} ${safeName(name, 60)}`));
    }
  };
  // Sample/fixture folders collect into their own set; it is merged with a hard cap below.
  const sampleSet = new SignalSet();
  const sampleView             = sampleSet;

  // ---- per-file detectors ----
  let k8sYamlChecked = 0;
  let mdChecked = 0;
  const migrationDirs = new Map                ();
  const scaffold = new Map                ();

  for (const f of files) {
    const sample = isSampleDir(f.rel);
    const target             = sample ? sampleView : set;
    const n = f.lower;
    const relLower = f.rel.toLowerCase();
    const migrationDir = sample ? undefined : migrationGroup(f.rel);
    if (migrationDir) bump(migrationDirs, migrationDir);
    // Additive and first, so the early `continue`s below (.cs, manifest.json...) cannot skip it.
    detectPlatformFiles(f, n, relLower, target, read);

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
      if (hasCode('.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts')) target.add('tech:node', 0.9, ev(f, 'package.json'));
      else target.atLeast('tech:node', 0.5, ev(f, 'package.json (tooling only, no JavaScript files)'));
      try {
        const pkg = JSON.parse(t)                           ;
        const names = new Set        ();
        for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
          const deps = pkg[key];
          if (deps && typeof deps === 'object') for (const d of Object.keys(deps          )) names.add(d);
        }
        applyPackages(target, f, NPM, names, 'dependency');
        const scripts = pkg['scripts'];
        const testScript = scripts && typeof scripts === 'object' ? (scripts                           )['test'] : undefined;
        if (typeof testScript === 'string' && /\b(node|bun|deno) (--test|test)\b|\btsx --test\b/.test(testScript)) target.add('test:unit', 0.8, ev(f, 'test script runs node --test'));
      } catch {
        warnings.push(`could not parse ${f.rel}`);
      }
      continue;
    }
    // A page that loads scripts near the root: a static site or a browser game without a bundler.
    // Only where a site's entry page lives: generated reports (htmlcov/index.html) are not a frontend.
    if (n === 'index.html' && /^((public|src|static|www|web|app|client|frontend)\/)?index\.html$/.test(relLower)) {
      const t = read(f, 256 * 1024);
      if (t && /<script\b/i.test(t)) target.add('tech:frontend', 0.6, ev(f, 'page with scripts'));
      continue;
    }
    // Browser extension manifest (Chrome, Edge, Firefox).
    if (n === 'manifest.json' && f.rel.split('/').length <= 3) {
      const t = read(f, 256 * 1024);
      if (t && /"manifest_version"\s*:\s*[23]\b/.test(t) && /"(background|content_scripts|action|browser_action|permissions)"/.test(t)) {
        target.add('tech:browser-extension', 0.9, ev(f, 'browser extension manifest'));
        target.add('tech:frontend', 0.6, ev(f, 'browser extension manifest'));
      }
      continue;
    }
    if (n === 'schema.prisma') {
      target.add('orm:prisma', 0.9, ev(f, 'Prisma schema'));
      const t = read(f);
      const m = t ? /provider\s*=\s*"(postgresql|postgres|mysql|sqlserver|sqlite|mongodb|cockroachdb)"/.exec(t) : null;
      if (m && m[1]) {
        const map                         = {
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
    if (/^requirements[\w.-]*\.txt$/.test(n) || n === 'constraints.txt' || (f.ext === '.txt' && /(^|\/)requirements\/[^/]+$/.test(relLower))) {
      if (hasCode('.py', '.pyi')) target.add('lang:python', 0.85, ev(f, f.name));
      else target.atLeast('lang:python', 0.3, ev(f, safeName(f.name, 60) + ' (no Python files)'));
      const t = read(f);
      if (t) applyPackages(target, f, PYPI, pythonRequirements(t), 'requirement');
      continue;
    }
    if (n === 'pyproject.toml' || n === 'pipfile' || n === 'setup.py' || n === 'setup.cfg' || n === 'environment.yml') {
      if (hasCode('.py', '.pyi')) target.add('lang:python', 0.85, ev(f, f.name));
      else target.atLeast('lang:python', 0.3, ev(f, safeName(f.name, 60) + ' (no Python files)'));
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
    if (n === 'pom.xml' || n === 'build.gradle' || n === 'build.gradle.kts' || n === 'libs.versions.toml') {
      // The Kotlin DSL is common in Java projects too: the source files decide the language.
      if ((n === 'pom.xml' || n === 'build.gradle') && hasCode('.java')) target.add('lang:java', 0.85, ev(f, f.name));
      const t = read(f);
      if (t) applyPackages(target, f, MAVEN, jvmCoordinates(t), 'artifact');
      continue;
    }
    if (n === 'composer.json') {
      if (hasCode('.php')) target.add('lang:php', 0.9, ev(f, 'composer.json'));
      else target.atLeast('lang:php', 0.3, ev(f, 'composer.json (no PHP files)'));
      const t = read(f);
      if (t) {
        try {
          const c = JSON.parse(t)                           ;
          const names = [...Object.keys((c['require']          ) ?? {}), ...Object.keys((c['require-dev']          ) ?? {})];
          applyPackages(target, f, COMPOSER, names, 'package');
        } catch {
          /* ignore */
        }
      }
      continue;
    }
    if (n === 'gemfile') {
      if (hasCode('.rb', '.rake')) target.add('lang:ruby', 0.9, ev(f, 'Gemfile'));
      else target.atLeast('lang:ruby', 0.3, ev(f, 'Gemfile (no Ruby files)'));
      const t = read(f);
      if (t) applyPackages(target, f, GEMS, [...t.matchAll(/^[ \t]*gem[ \t]+['"]([^'"\n]{1,100})['"]/gm)].map((m) => m[1]          ), 'gem');
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
          // ${REDIS_IMAGE:-redis:7} -> redis:7
          const image = (m[1]          ).toLowerCase().replace(/^\$\{[a-z0-9_]{1,80}:?-([^}]{1,150})\}$/, '$1');
          const bare = image.replace(/[:@].*$/, '');
          for (const [re, sigs] of IMAGES) {
            if (re.test(bare)) for (const [id, s] of sigs) target.add(id, s, ev(f, `service image ${safeName(image, 80)}`));
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
    if (/^\.env(\.[\w-]{1,30})?\.(example|sample|template|dist|defaults)$/.test(n) || n === 'env.example' || n === 'example.env') {
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

  if (readCut) warnings.push('the scan ran out of time and did not read every config file');

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
  let task                        ;
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





/** Examples, samples and test fixtures describe other projects, not this one. */
export function isSampleDir(rel        )          {
  const dir = rel.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  // Exact folder names only, plus "example-apps"-style containers: "sample-tracker" or
  // "demo-data-loader" can be the product itself.
  return /(^|\/)(examples?|samples?|demos?|fixtures?|__fixtures__|testdata|test-data|playgrounds?|(examples?|samples?|demos?)[-_](apps?|projects?))(\/|$)/i.test(dir);
}

function bump(map                     , key        )       {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Directory that groups a database migration file, or undefined if the file is not one. */
export function migrationGroup(rel        )                     {
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

export function nugetPackages(rawXml        )           {
  const out = new Set        ();
  const xml = rawXml.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const m of xml.matchAll(/<Package(?:Reference|Version)\b[^>]{0,300}?\bInclude\s{0,5}=\s{0,5}"([^"]{1,200})"/gi)) out.add(m[1]          );
  for (const m of xml.matchAll(/<package\b[^>]{0,300}?\bid\s{0,5}=\s{0,5}"([^"]{1,200})"/gi)) out.add(m[1]          );
  return [...out];
}

export function pythonRequirements(text        )           {
  const out           = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line || line.startsWith('-')) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
    if (m && m[1]) out.push(normalizePy(m[1]));
  }
  return out;
}

/** Requirement names from a quoted list like ["fastapi>=0.1", "psycopg[binary]"]. */
function quotedRequirements(list        )           {
  const out           = [];
  for (const m of list.matchAll(/["'] ?([A-Za-z0-9][A-Za-z0-9._-]{0,100}) ?(?:\[[^\]]{0,100}\])? ?(?:[<>=!~;@ ]|["'])/g)) out.push(normalizePy(m[1]          ));
  return out;
}

/** Collapse runs of spaces and tabs so that adjacent \s* in the patterns below cannot backtrack. */
function squeeze(text        )         {
  return text.replace(/[ \t]+/g, ' ');
}

/**
 * Dependency names from pyproject.toml, Pipfile, setup.py, setup.cfg or environment.yml.
 * Only dependency sections are read, so a description that mentions "redis" is not a dependency.
 */
export function pythonManifestNames(rawText        , fileName = 'pyproject.toml')           {
  const out = new Set        ();
  const name = fileName.toLowerCase();
  const text = squeeze(rawText);
  if (name === 'setup.py') {
    for (const m of text.matchAll(/(install_requires|requires|extras_require) ?= ?([[{][\s\S]{0,5000}?[\]}]) ?[,)]/g)) {
      for (const r of quotedRequirements(m[2]          )) out.add(r);
    }
    return [...out];
  }
  if (name === 'setup.cfg') {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((l) => /^install_requires ?=/.test(l));
    for (let i = start + 1; start >= 0 && i < lines.length; i++) {
      const line = lines[i]          ;
      if (!/^[ \t]/.test(line) || !line.trim()) break;
      const r = /^ ?([A-Za-z0-9][A-Za-z0-9._-]{0,100})/.exec(line);
      if (r && r[1]) out.add(normalizePy(r[1]));
    }
    return [...out];
  }
  if (name === 'environment.yml') {
    const idx = text.search(/^dependencies:/m);
    if (idx >= 0) for (const m of text.slice(idx).matchAll(/^ ?- ?([A-Za-z0-9][A-Za-z0-9._-]{0,100})/gm)) out.add(normalizePy(m[1]          ));
    return [...out];
  }
  // TOML-shaped files: pyproject.toml and Pipfile.
  let section = '';
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]          ;
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
    if (value.trimStart().startsWith('[')) {
      // Track brackets incrementally (re-scanning the growing value made this quadratic on a
      // file with thousands of blank lines) and stop after 64 KB or 2000 lines.
      const brackets = bracketTracker();
      brackets.feed(value);
      for (let n = 0; i + 1 < lines.length && !brackets.closed() && value.length < 65_536 && n < 2000; n++) {
        // Drop comments on continuation lines: an apostrophe in "# don't pin" would open a quote.
        const next = '\n' + stripTomlComment(lines[++i]          );
        value += next;
        brackets.feed(next);
      }
    }
    if (section === 'project' && (key === 'dependencies' || key === 'optional-dependencies')) {
      for (const r of quotedRequirements(value)) out.add(r);
    } else if (section === 'project.optional-dependencies' || section === 'dependency-groups') {
      for (const r of quotedRequirements(value)) out.add(r);
    } else if (/^tool\.(uv|rye)$/.test(section) && key === 'dev-dependencies') {
      for (const r of quotedRequirements(value)) out.add(r);
    } else if (isDepTable && value.trimStart().startsWith('[') && !value.includes('{')) {
      // A named group of requirements ([tool.pdm.dev-dependencies] lint = ["ruff"]): the key is the group.
      // Poetry's multiple constraints (django = [{version = "<4"}, ...]) have tables and fall through.
      for (const r of quotedRequirements(value)) out.add(r);
    } else if (isDepTable && key !== 'python') {
      out.add(normalizePy(key));
    }
  }
  return [...out];
}

/** Remove a # comment that is not inside a quoted string. */
function stripTomlComment(line        )         {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]          ;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

/** Bracket depth of a TOML array value fed piece by piece; quotes hide brackets. */
function bracketTracker()                                               {
  let depth = 0;
  let quote = '';
  return {
    feed(s        )       {
      for (const c of s) {
        if (quote) {
          if (c === quote) quote = '';
          continue;
        }
        if (c === '"' || c === "'") quote = c;
        else if (c === '[') depth++;
        else if (c === ']') depth--;
      }
    },
    closed: () => depth <= 0,
  };
}

function normalizePy(name        )         {
  return name.toLowerCase().replace(/[_.]+/g, '-');
}

export function goModules(text        )           {
  const out           = [];
  for (const raw of text.split(/\r?\n/)) {
    // Indirect requirements are other modules' dependencies, not this project's choices.
    if (/\/\/\s*indirect\b/.test(raw)) continue;
    const parts = raw.trim().replace(/^require\s+/, '').split(/\s+/);
    const mod = parts[0] ?? '';
    if (mod.length <= 200 && /^[a-z0-9.-]{1,100}\.[a-z]{2,20}\/\S+$/i.test(mod) && /^v\d/.test(parts[1] ?? '')) out.push(mod);
  }
  return out;
}

export function cargoDeps(text        )           {
  const out = new Set        ();
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

export function jvmCoordinates(text        )           {
  const out = new Set        ();
  // Maven
  const t = squeeze(text);
  for (const m of t.matchAll(/<groupId> ?([^<\s]{1,200}) ?<\/groupId>\s{0,20}<artifactId> ?([^<\s]{1,200}) ?<\/artifactId>/g)) {
    out.add(`${m[1]}:${m[2]}`);
  }
  // Gradle: "group:artifact:version" strings (also `module = "g:a"` in libs.versions.toml)
  for (const m of t.matchAll(/["']([A-Za-z0-9_.-]{1,100}):([A-Za-z0-9_.-]{1,100})(?::[^"'\n]{0,100})?["']/g)) out.add(`${m[1]}:${m[2]}`);
  // Version catalogs: { group = "g", name = "a" }
  for (const m of t.matchAll(/\bgroup ?= ?"([A-Za-z0-9_.-]{1,100})" ?, ?name ?= ?"([A-Za-z0-9_.-]{1,100})"/g)) out.add(`${m[1]}:${m[2]}`);
  return [...out];
}

// ---------- content detectors ----------

function detectAppSettings(f          , text        , set            )       {
  let json         ;
  try {
    json = JSON.parse(stripJsonComments(text));
  } catch {
    return;
  }
  if (!json || typeof json !== 'object') return;
  const obj = json                           ;
  const cs = obj['ConnectionStrings'];
  if (cs && typeof cs === 'object') {
    for (const [name, value] of Object.entries(cs                           )) {
      if (typeof value !== 'string') continue;
      const kind = classifyConnectionString(value);
      if (kind) set.add(kind.signal, 0.75, { source: f.rel, detail: `ConnectionStrings:${safeName(name, 40)} looks like ${kind.label}` });
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

export function classifyConnectionString(value        )                                                {
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

function stripJsonComments(text        )         {
  // appsettings.json allows comments and trailing commas.
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]          ;
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

/**
 * Config files of hosting platforms, frameworks and engines. Additive: other detectors still
 * see the file. Files are read only when the name alone is not enough.
 */
function detectPlatformFiles(f          , n        , relLower        , set            , read                                                   )       {
  const add = (id        , strength        , detail        )       => set.add(id, strength, { source: f.rel, detail });
  const atRoot = !relLower.includes('/');
  // Observability agents
  if (n === 'datadog.yaml' || n === 'datadog-ci.json') add('obs:datadog', 0.8, 'Datadog config');
  if (/^newrelic\.(js|cjs|ini|yml|yaml)$/.test(n)) add('obs:newrelic', 0.85, 'New Relic agent config');
  // Hosting platforms
  if (n === 'netlify.toml') add('cloud:netlify', 0.95, 'Netlify config');
  if (/(^|\/)netlify\/(edge-)?functions\//.test(relLower)) add('cloud:netlify', 0.85, 'Netlify functions');
  if (n === 'heroku.yml') add('cloud:heroku', 0.95, 'Heroku build manifest');
  if (n === 'procfile' && atRoot) add('cloud:heroku', 0.4, 'Procfile');
  if ((n === 'render.yaml' || n === 'render.yml') && atRoot) add('cloud:render', 0.95, 'Render Blueprint');
  if (n === 'railway.json' || n === 'railway.toml') add('cloud:railway', 0.95, 'Railway config');
  if (n === 'fly.toml') add('cloud:fly', 0.95, 'Fly.io app config');
  if (n === 'pulumi.yaml' || n === 'pulumi.yml') add('infra:pulumi', 0.95, 'Pulumi project');
  else if (/^pulumi\.[\w-]{1,60}\.ya?ml$/.test(n)) add('infra:pulumi', 0.9, 'Pulumi stack config');
  if (/(^|\/)\.do\/(app|deploy\.template)\.yaml$/.test(relLower)) add('cloud:digitalocean', 0.95, 'DigitalOcean App Platform spec');
  if (n === '.pscale.yml') add('db:planetscale', 0.9, 'PlanetScale CLI config');
  // Content, chat and frameworks
  if (/^sanity\.(config|cli)\.(ts|js|tsx|jsx|mjs)$/.test(n)) add('tech:sanity', 0.95, 'Sanity Studio config');
  if (n === 'slack.json' && atRoot) add('tool:slack', 0.6, 'Slack CLI app');
  if (n === 'angular.json') add('tech:angular', 0.95, 'Angular workspace');
  if (/^svelte\.config\.(js|ts|mjs|cjs)$/.test(n)) add('tech:svelte', 0.9, 'Svelte config');
  if (n === 'nx.json') add('tool:nx', 0.95, 'Nx workspace');
  if (/^shopify\.app(\.[\w-]{1,60})?\.toml$/.test(n)) add('tech:shopify', 0.95, 'Shopify app config');
  if (n === 'shopify.extension.toml') add('tech:shopify', 0.9, 'Shopify app extension');
  if (/(^|\/)layout\/theme\.liquid$/.test(relLower)) {
    add('tech:shopify', 0.95, 'Shopify theme');
    add('lang:liquid', 0.9, 'Shopify theme');
  }
  if (n === 'eas.json') add('tech:expo', 0.9, 'Expo Application Services config');
  if (relLower === 'artisan') add('tech:laravel', 0.85, 'Laravel artisan');
  if (/(^|\/)\.storybook\/main\.(ts|js|mjs|cjs|mts)$/.test(relLower)) add('tool:storybook', 0.95, 'Storybook config');
  if (/^astro\.config\.(mjs|js|ts|mts|cjs)$/.test(n)) add('tech:astro', 0.95, 'Astro config');
  if (/^nuxt\.config\.(ts|js|mjs)$/.test(n)) add('tech:nuxt', 0.95, 'Nuxt config');
  if (/(^|\/)\.claude-plugin\/(plugin|marketplace)\.json$/.test(relLower)) add('tech:claude-plugin', 0.9, 'Claude Code plugin manifest');
  // Mobile, desktop and game engines
  if (n === 'pubspec.yaml') {
    add('lang:dart', 0.95, 'pubspec.yaml');
    const t = read(f, 128 * 1024);
    if (t && /^[ \t]*flutter:[ \t]*\r?\n[ \t]+sdk:[ \t]*flutter\b/m.test(t)) add('tech:flutter', 0.95, 'Flutter app');
  }
  if (n === 'project.pbxproj' && /\.xcodeproj$/i.test(f.dir)) add('tech:xcode', 0.95, 'Xcode project');
  if (n === 'contents.xcworkspacedata' && /\.xcworkspace$/i.test(f.dir)) add('tech:xcode', 0.9, 'Xcode workspace');
  if (n === 'package.swift') {
    add('lang:swift', 0.9, 'Swift package');
    add('tech:xcode', 0.4, 'Swift package');
  }
  if (/(^|\/)projectsettings\/projectversion\.txt$/.test(relLower)) add('tech:unity', 0.95, 'Unity project');
  if (/(^|\/)packages\/manifest\.json$/.test(relLower)) {
    const t = read(f, 256 * 1024);
    if (t && t.includes('"com.unity.')) add('tech:unity', 0.9, 'Unity package manifest');
  }
  if (f.ext === '.uproject') add('tech:unreal', 0.95, 'Unreal project');
  if (/\.(build|target)\.cs$/.test(n)) add('tech:unreal', 0.85, 'Unreal build rules');
  if (f.ext === '.uplugin') add('tech:unreal', 0.8, 'Unreal plugin');
  // Build tooling
  if (n === 'settings.gradle' || n === 'settings.gradle.kts') {
    const t = read(f, 128 * 1024);
    if (t && /com\.gradle\.(develocity|enterprise)/.test(t)) add('tool:develocity', 0.95, 'Develocity plugin');
  }
  if (/(^|\/)\.mvn\/extensions\.xml$/.test(relLower)) {
    const t = read(f, 128 * 1024);
    if (t && /(develocity|gradle-enterprise)-maven-extension/.test(t)) add('tool:develocity', 0.95, 'Develocity Maven extension');
  }
  if (n === 'components.json') {
    const t = read(f, 64 * 1024);
    if (t && t.includes('ui.shadcn.com/schema')) add('tool:shadcn', 0.95, 'shadcn/ui config');
    else if (t && /"aliases"/.test(t) && /"tailwind"/.test(t)) add('tool:shadcn', 0.8, 'shadcn/ui config');
  }
  if (n === 'app.json' && relLower.split('/').length <= 2) {
    const t = read(f, 128 * 1024);
    if (t && /^\s*\{\s*"expo"\s*:/.test(t)) add('tech:expo', 0.85, 'Expo app config');
    if (t && /"buildpacks"\s*:/.test(t)) add('cloud:heroku', 0.7, 'Heroku app.json');
  }
}

function detectEnvExample(f          , text        , set            )       {
  const KEYS                                  = [
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
    [/^CLOUDFLARE_(?!TURNSTILE)|^CF_API_TOKEN/, 'cloud:cloudflare', 0.6],
    [/^VERCEL_/, 'cloud:vercel', 0.5],
    [/^(NEXT_PUBLIC_)?FIREBASE_/, 'db:firebase', 0.7],
    [/^FIGMA_/, 'design:figma', 0.6],
    [/^NOTION_/, 'docs:notion', 0.6],
    [/^GRAFANA_/, 'obs:grafana', 0.6],
    [/^POSTMAN_/, 'api:postman', 0.6],
    [/^SONAR/, 'quality:sonar', 0.6],
    [/^ARGOCD_/, 'infra:argocd', 0.6],
    [/^DD_(API_KEY|APP_KEY|APPLICATION_KEY|SITE)$/, 'obs:datadog', 0.6],
    [/^NEW_RELIC_/, 'obs:newrelic', 0.65],
    [/^HONEYCOMB_/, 'obs:honeycomb', 0.7],
    [/^PAGERDUTY_/, 'obs:pagerduty', 0.6],
    [/^(DYNATRACE_|DT_API_TOKEN$|DT_ENVIRONMENT$|DT_PLATFORM_TOKEN$)/, 'obs:dynatrace', 0.6],
    [/^(NEXT_PUBLIC_|VITE_)?POSTHOG_/, 'obs:posthog', 0.75],
    [/^NETLIFY_/, 'cloud:netlify', 0.6],
    [/^HEROKU_/, 'cloud:heroku', 0.6],
    [/^RENDER_(API_KEY|SERVICE_ID)$/, 'cloud:render', 0.6],
    [/^RAILWAY_/, 'cloud:railway', 0.6],
    [/^FLY_(API|ACCESS)_TOKEN$/, 'cloud:fly', 0.6],
    [/^PULUMI_/, 'infra:pulumi', 0.6],
    [/^(DIGITALOCEAN_|DO_API_TOKEN$)/, 'cloud:digitalocean', 0.6],
    [/^PLANETSCALE_/, 'db:planetscale', 0.75],
    [/^TURSO_/, 'db:turso', 0.8],
    [/^UPSTASH_/, 'db:upstash', 0.8],
    [/^(NEXT_PUBLIC_|VITE_)?ALGOLIA_/, 'db:algolia', 0.75],
    [/^(NEXT_PUBLIC_)?CONTENTFUL_/, 'tech:contentful', 0.75],
    [/^(NEXT_PUBLIC_|SANITY_STUDIO_)?SANITY_/, 'tech:sanity', 0.75],
    [/^SLACK_/, 'tool:slack', 0.55],
    [/^(NEXT_PUBLIC_)?AUTH0_/, 'tech:auth0', 0.8],
    [/^(NEXT_PUBLIC_|VITE_)?CLERK_/, 'tech:clerk', 0.8],
    [/^TWILIO_/, 'api:twilio', 0.75],
    [/^RESEND_/, 'api:resend', 0.75],
    [/^ASANA_/, 'tracker:asana', 0.6],
    [/^MONDAY_/, 'tracker:monday', 0.5],
    [/^CLICKUP_/, 'tracker:clickup', 0.6],
    [/^(HF_TOKEN|HUGGING_?FACE_)/, 'ml:huggingface', 0.6],
  ];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]{0,100})[ \t]*=[ \t]*(.*)$/.exec(raw.slice(0, 2000));
    if (!m || !m[1]) continue;
    const key = m[1].toUpperCase();
    const value = (m[2] ?? '').trim().replace(/^["']|["']$/g, '');
    for (const [re, id, s] of KEYS) if (re.test(key)) set.add(id, s, { source: f.rel, detail: `env key ${safeName(key, 40)}` });
    if (key === 'DB_CONNECTION') {
      const DRIVERS                         = { mysql: 'db:mysql', mariadb: 'db:mysql', pgsql: 'db:postgres', postgres: 'db:postgres', postgresql: 'db:postgres', sqlite: 'db:sqlite', sqlsrv: 'db:sqlserver' };
      const id = DRIVERS[value.toLowerCase()];
      // Laravel 11+ ships DB_CONNECTION=sqlite as the default: weaker than a deliberate choice.
      if (id) set.add(id, id === 'db:sqlite' ? 0.5 : 0.7, { source: f.rel, detail: 'DB_CONNECTION=' + value.toLowerCase() });
    }
    if (/^(DATABASE_URL|DB_URL|DATABASE_URI|DB_CONNECTION)$/.test(key) || /_URL$|_URI$|CONNECTION/.test(key)) {
      const kind = classifyConnectionString(value);
      if (kind) set.add(kind.signal, 0.7, { source: f.rel, detail: `${safeName(key, 40)} uses a ${kind.label} URL` });
      if (/^prisma\+postgres:\/\//i.test(value)) set.add('db:prisma-postgres', 0.85, { source: f.rel, detail: `${safeName(key, 40)} uses Prisma Postgres` });
    }
    // Host suffixes only; the value itself is never stored.
    if (/\.supabase\.co\b/i.test(value)) set.add('db:supabase', 0.85, { source: f.rel, detail: `${safeName(key, 40)} points at Supabase` });
    if (/\bneon\.tech\b/i.test(value)) set.add('db:neon', 0.85, { source: f.rel, detail: `${safeName(key, 40)} points at Neon` });
    if (/\bclickhouse\.cloud\b/i.test(value)) set.add('db:clickhouse-cloud', 0.85, { source: f.rel, detail: `${safeName(key, 40)} points at ClickHouse Cloud` });
    if (/\batlassian\.net\b/i.test(value)) set.add('tracker:jira', 0.75, { source: f.rel, detail: `${safeName(key, 40)} points at Atlassian Cloud` });
    const HOSTS                                          = [
      [/\bdatadoghq\.(com|eu)\b/i, 'obs:datadog', 0.8, 'Datadog'],
      [/\bhoneycomb\.io\b/i, 'obs:honeycomb', 0.85, 'Honeycomb'],
      [/\.(live|apps)\.dynatrace\.com\b/i, 'obs:dynatrace', 0.85, 'Dynatrace'],
      [/\bposthog\.com\b/i, 'obs:posthog', 0.8, 'PostHog'],
      [/\bpsdb\.cloud\b/i, 'db:planetscale', 0.85, 'PlanetScale'],
      [/^libsql:\/\/[^\s]{1,200}\.turso\.io\b/i, 'db:turso', 0.9, 'Turso'],
      [/\bupstash\.io\b/i, 'db:upstash', 0.85, 'Upstash'],
      [/\.auth0\.com\b/i, 'tech:auth0', 0.85, 'Auth0'],
    ];
    for (const [re, id, strength, label] of HOSTS) if (re.test(value)) set.add(id, strength, { source: f.rel, detail: key + ' points at ' + label });
  }
}

function detectTrackerLinks(f          , text        , set            , base        )       {
  const once = (re        , id        , strength        , detail                                )       => {
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
  once(/\bapp\.asana\.com\/0\//i, 'tracker:asana', 0.8, () => 'links to Asana tasks');
  once(/\b[a-z0-9-]{1,63}\.monday\.com\/boards\//i, 'tracker:monday', 0.8, () => 'links to monday.com boards');
  once(/\bapp\.clickup\.com\/t\//i, 'tracker:clickup', 0.8, () => 'links to ClickUp tasks');
}

function detectCiContent(f          , text        , set            )       {
  const t = text;
  const add = (re        , id        , s        , detail        )       => {
    if (re.test(t)) set.add(id, s, { source: f.rel, detail });
  };
  add(/docker\/(build-push-action|login-action)|\bdocker (build|push)\b/, 'infra:docker', 0.6, 'CI builds containers');
  add(/\bkubectl\b|azure\/k8s-deploy|google-github-actions\/get-gke-credentials/, 'infra:kubernetes', 0.6, 'CI deploys to Kubernetes');
  add(/\bhelm (upgrade|install)\b|azure\/setup-helm/, 'infra:helm', 0.6, 'CI uses Helm');
  add(/hashicorp\/setup-terraform|\bterraform (plan|apply)\b/, 'infra:terraform', 0.6, 'CI runs Terraform');
  add(/aws-actions\/configure-aws-credentials|\baws (s3|ecs|lambda|cloudformation|ecr)\b/, 'cloud:aws', 0.6, 'CI talks to AWS');
  add(/azure\/login|AzureCLI@|AzureWebApp@|\baz (webapp|aks|acr|login)\b/, 'cloud:azure', 0.45, 'CI talks to Azure');
  add(/google-github-actions\/auth|\bgcloud (run|builds|container)\b/, 'cloud:gcp', 0.6, 'CI talks to Google Cloud');
  add(/cloudflare\/wrangler-action|\bwrangler deploy\b/, 'cloud:cloudflare', 0.7, 'CI deploys to Cloudflare');
  add(/sonarsource\/|SonarCloud|sonarqube|SonarQubePrepare@/i, 'quality:sonar', 0.8, 'CI runs Sonar');
  add(/(?<![\w-])semgrep\b/i, 'quality:semgrep', 0.75, 'CI runs Semgrep');
  add(/snyk\//i, 'quality:snyk', 0.75, 'CI runs Snyk');
  add(/\bdotnet (test|build|publish)\b|actions\/setup-dotnet|UseDotNet@/, 'tech:dotnet', 0.6, 'CI builds .NET');
  add(/getsentry\/action-release|sentry-cli/, 'obs:sentry', 0.7, 'CI creates Sentry releases');
  add(/playwright (test|install)/, 'test:e2e', 0.8, 'CI runs Playwright');
  add(/\bDataDog\/|\bdatadog-ci\b/, 'obs:datadog', 0.7, 'CI reports to Datadog');
  add(/newrelic\/deployment-marker-action/, 'obs:newrelic', 0.75, 'CI marks New Relic deployments');
  add(/\bnetlify deploy\b|nwtgck\/actions-netlify/, 'cloud:netlify', 0.75, 'CI deploys to Netlify');
  add(/heroku container:|git push heroku|akhileshns\/heroku-deploy/, 'cloud:heroku', 0.75, 'CI deploys to Heroku');
  add(/api\.render\.com\/deploy\/srv-/, 'cloud:render', 0.75, 'CI triggers a Render deploy');
  add(/\brailway (up|deploy)\b|railwayapp\/cli/, 'cloud:railway', 0.75, 'CI deploys to Railway');
  add(/superfly\/flyctl-actions|\bfly(ctl)? deploy\b/, 'cloud:fly', 0.8, 'CI deploys to Fly.io');
  add(/pulumi\/actions|\bpulumi (up|preview)\b/, 'infra:pulumi', 0.8, 'CI runs Pulumi');
  add(/digitalocean\/action-doctl|\bdoctl apps\b/, 'cloud:digitalocean', 0.8, 'CI deploys to DigitalOcean');
  add(/\bpscale deploy-request\b|planetscale\/[\w-]{1,60}-action/, 'db:planetscale', 0.8, 'CI uses PlanetScale');
  add(/slackapi\/slack-github-action|8398a7\/action-slack/, 'tool:slack', 0.6, 'CI posts to Slack');
}

function detectTerraformProviders(f          , text        , set            )       {
  const P                                  = [
    [/(provider\s+"aws"|hashicorp\/aws)/, 'cloud:aws', 0.85],
    [/(provider\s+"azurerm"|hashicorp\/azurerm|provider\s+"azuread")/, 'cloud:azure', 0.85],
    [/(provider\s+"google"|hashicorp\/google)/, 'cloud:gcp', 0.85],
    [/(provider\s+"cloudflare"|cloudflare\/cloudflare)/, 'cloud:cloudflare', 0.85],
    [/(provider\s+"kubernetes"|hashicorp\/kubernetes)/, 'infra:kubernetes', 0.5],
    [/(provider\s+"helm"|hashicorp\/helm)/, 'infra:helm', 0.5],
    [/vercel\/vercel/, 'cloud:vercel', 0.8],
    [/(provider\s+"grafana"|grafana\/grafana)/, 'obs:grafana', 0.6],
    [/datadog\/datadog/i, 'obs:datadog', 0.85],
    [/newrelic\/newrelic/i, 'obs:newrelic', 0.85],
    [/honeycombio\/honeycombio/i, 'obs:honeycomb', 0.85],
    [/pagerduty\/pagerduty/i, 'obs:pagerduty', 0.85],
    [/dynatrace-oss\/dynatrace/i, 'obs:dynatrace', 0.85],
    [/netlify\/netlify/i, 'cloud:netlify', 0.85],
    [/heroku\/heroku/i, 'cloud:heroku', 0.85],
    [/render-oss\/render/i, 'cloud:render', 0.85],
    [/digitalocean\/digitalocean/i, 'cloud:digitalocean', 0.85],
    [/planetscale\/planetscale/i, 'db:planetscale', 0.85],
    [/upstash\/upstash/i, 'db:upstash', 0.85],
    [/auth0\/auth0/i, 'tech:auth0', 0.85],
  ];
  for (const [re, id, s] of P) if (re.test(text)) set.add(id, s, { source: f.rel, detail: 'Terraform provider' });
}

/** MCP servers the team configured for other clients (VS Code, Cursor) in this repo. */
function detectOtherClientConfigs(root        , set           )       {
  const candidates                          = [
    ['.vscode/mcp.json', 'servers'],
    ['.cursor/mcp.json', 'mcpServers'],
  ];
  for (const [rel, key] of candidates) {
    const text = readText(path.join(root, rel), 256 * 1024);
    if (!text) continue;
    let json         ;
    try {
      json = JSON.parse(stripJsonComments(text));
    } catch {
      continue;
    }
    const servers = json && typeof json === 'object' ? (json                           )[key] : undefined;
    if (!servers || typeof servers !== 'object') continue;
    for (const [name, def] of Object.entries(servers                           )) {
      if (!def || typeof def !== 'object') continue;
      const d = def                           ;
      const fingerprint = [name, d['url'], d['command'], ...(Array.isArray(d['args']) ? d['args'] : [])]
        .filter((x)              => typeof x === 'string')
        .map(fingerprintToken)
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      set.add('team-mcp:' + fingerprintKey(fingerprint), 0.8, { source: rel, detail: `team configured MCP server "${safeName(name, 40)}" for another client` });
    }
  }
}

/**
 * Only what registry patterns can match goes into a fingerprint: a URL's host and path, and
 * package-like words. Passwords in connection strings, tokens in query strings and flag values
 * stay out, because signal ids are printed by `scan --format json`.
 */
function fingerprintToken(raw        )         {
  const t = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      // Scheme, host and path: enough for URL patterns, without user info or query strings.
      return /^https?:$/.test(u.protocol) ? `${u.protocol}//${u.host}${u.pathname}` : '';
    } catch {
      return '';
    }
  }
  // Package names and image refs (an optional :tag); long unbroken runs look like keys, not names.
  if (!/^[@a-z0-9][\w.@/-]{0,120}(:[\w.-]{1,64})?$/i.test(t) || /[A-Za-z0-9_]{24,}/.test(t)) return '';
  return redactString(t) === t ? t : '';
}

/** Compact, comparable key used by the engine to match team-configured servers to registry entries. */
export function fingerprintKey(s        )         {
  return s.replace(/\s+/g, ' ').slice(0, 300);
}

const ISSUE_KEY_STOP = new Set([
  'UTF', 'ISO', 'SHA', 'CVE', 'RFC', 'COVID', 'GPT', 'HTTP', 'TLS', 'SSL', 'MD', 'AES', 'RSA', 'ECMA', 'ES',
  'PEP', 'JSR', 'KB', 'MS', 'X', 'H', 'V', 'IPV', 'WIN', 'NET', 'CSS', 'HTML', 'ARM', 'GHSA', 'PR', 'MR', 'P', 'Q',
  'NUGET', 'NPM', 'ID', 'API', 'UI', 'OS', 'VS', 'SQL', 'JDK', 'K', 'S', 'R', 'PY', 'NODE', 'LTS', 'BUG', 'T', 'TASK',
  'GH', 'GHE', 'ISSUE', 'FIX', 'FEAT', 'TICKET', 'STORY', 'RELEASE', 'TLS', 'HTTP2', 'PHP', 'JS', 'TS', 'CS',
  // Words people number in commit messages that are not tracker projects.
  'STEP', 'PHASE', 'PART', 'STAGE', 'LEVEL', 'CHAPTER', 'SPRINT', 'WEEK', 'DAY', 'VER', 'VERSION', 'BUILD', 'ITEM',
  'TEST', 'CASE', 'LAB', 'EX', 'PAGE', 'SEC', 'REV', 'NO', 'NUM', 'ERR', 'ERROR', 'CODE', 'MILESTONE', 'ROUND', 'PASS',
]);

export function detectGit(git         , set           )       {
  if (!git.isRepo) return;
  set.add('vcs:git', 0.95, { source: 'git', detail: 'git repository' });
  for (const r of git.remotes) {
    // SSH config aliases for several accounts: git@github.com-work:org/repo.git
    const h = r.host.replace(/^(github\.com|gitlab\.com|bitbucket\.org)[-_][\w.-]{1,60}$/, '$1');
    if (h === 'github.com' || h.endsWith('.ghe.com')) set.add('vcs:github', 0.95, { source: 'git', detail: `remote ${safeName(r.name, 40)} on ${safeName(h, 80)}` });
    else if (h === 'gitlab.com' || h.includes('gitlab')) set.add('vcs:gitlab', 0.9, { source: 'git', detail: `remote ${safeName(r.name, 40)} on ${safeName(h, 80)}` });
    else if (h === 'dev.azure.com' || h.endsWith('.visualstudio.com') || h === 'ssh.dev.azure.com') {
      set.add('vcs:azure-repos', 0.95, { source: 'git', detail: `remote ${safeName(r.name, 40)} on Azure DevOps` });
    } else if (h === 'bitbucket.org' || h.includes('bitbucket')) set.add('vcs:bitbucket', 0.9, { source: 'git', detail: `remote ${safeName(r.name, 40)} on ${safeName(h, 80)}` });
  }

  // Issue keys (PROJ-123) in branch names and commit subjects.
  const keys = new Map                     ();
  const texts = [...git.branches, ...(git.branch ? [git.branch] : []), ...git.recentSubjects];
  for (const full of texts) {
    const t = full.slice(0, 300);
    for (const m of t.matchAll(/(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,9})-(\d{1,6})(?![A-Za-z0-9])/g)) {
      const prefix = m[1]          ;
      if (ISSUE_KEY_STOP.has(prefix)) continue;
      if (!keys.has(prefix)) keys.set(prefix, new Set());
      (keys.get(prefix)               ).add(m[2]          );
    }
  }
  const strong = [...keys.entries()].filter(([, nums]) => nums.size >= 3).sort((a, b) => b[1].size - a[1].size);
  if (strong.length > 0) {
    const [prefix, nums] = strong[0]                         ;
    set.add('tracker:issue-keys', 0.8, { source: 'git', detail: `${nums.size} issue keys like ${prefix}-${[...nums][0]} in branches/commits` });
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
  const shapes = new Map                ();
  // Dependency bots (Dependabot, Renovate) write most "bump" commits; they are not a release habit.
  const BOT = /^(bump (the \S+ group|\S+ from \S+ to )|(chore|build|fix)\(deps(-dev)?\)|update dependency |\[snyk\])/i;
  for (const s of git.recentSubjects) {
    if (BOT.test(s)) continue;
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
      detail: `${count} recent commits start with "${safeName(shape, 40)}"`,
    });
  }
}
