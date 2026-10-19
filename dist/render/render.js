// Rendering for terminal text and Markdown (for agents). Both share one builder with a style switch.


import { hostLabel } from '../hosts/inventory.js';


import { displayPath } from '../util/paths.js';
import { redactArgs, redactString } from '../util/redact.js';
import { colors, sanitize, sanitizeLine,             } from '../util/text.js';








export function style(format        , color         )        {
  return { md: format === 'md', c: colors(format === 'text' && color) };
}

/** Escape free text for Markdown: no raw HTML, no link/image syntax injection. */
function t(s       , value        , max = 600)         {
  const v = sanitize(value, max);
  return s.md ? v.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/!\[/g, '!\\[') : v;
}

function code(s       , value        )         {
  if (!s.md) return s.c.cyan(value);
  const ticks = value.includes('`') ? '``' : '`';
  return `${ticks}${value}${ticks}`;
}

function heading(s       , text        , level = 2)         {
  return s.md ? `${'#'.repeat(level)} ${text}` : s.c.bold(text);
}

const SIGNAL_LABELS                         = {
  'tech:dotnet': '.NET', 'lang:csharp': 'C#', 'lang:typescript': 'TypeScript', 'lang:javascript': 'JavaScript', 'lang:python': 'Python',
  'lang:go': 'Go', 'lang:rust': 'Rust', 'lang:java': 'Java', 'lang:kotlin': 'Kotlin', 'lang:php': 'PHP', 'lang:ruby': 'Ruby',
  'tech:aspnetcore': 'ASP.NET Core', 'tech:node': 'Node.js', 'tech:frontend': 'frontend', 'tech:nextjs': 'Next.js',
  'db:postgres': 'PostgreSQL', 'db:mysql': 'MySQL', 'db:sqlserver': 'SQL Server', 'db:sqlite': 'SQLite', 'db:mongodb': 'MongoDB',
  'db:redis': 'Redis', 'db:clickhouse': 'ClickHouse', 'db:elasticsearch': 'Elasticsearch', 'db:supabase': 'Supabase', 'db:neon': 'Neon',
  'db:firebase': 'Firebase', 'orm:efcore': 'EF Core', 'orm:prisma': 'Prisma', 'infra:docker': 'Docker', 'infra:kubernetes': 'Kubernetes',
  'infra:helm': 'Helm', 'infra:terraform': 'Terraform', 'infra:argocd': 'Argo CD', 'infra:flux': 'Flux', 'cloud:aws': 'AWS',
  'cloud:azure': 'Azure', 'cloud:gcp': 'Google Cloud', 'cloud:cloudflare': 'Cloudflare', 'cloud:vercel': 'Vercel', 'vcs:github': 'GitHub',
  'vcs:gitlab': 'GitLab', 'vcs:azure-repos': 'Azure Repos', 'vcs:bitbucket': 'Bitbucket', 'ci:github-actions': 'GitHub Actions',
  'ci:gitlab-ci': 'GitLab CI', 'ci:azure-pipelines': 'Azure Pipelines', 'ci:circleci': 'CircleCI', 'ci:jenkins': 'Jenkins',
  'ci:buildkite': 'Buildkite', 'tracker:jira': 'Jira', 'tracker:confluence': 'Confluence', 'tracker:linear': 'Linear',
  'api:openapi': 'OpenAPI', 'api:graphql': 'GraphQL', 'api:grpc': 'gRPC', 'api:postman': 'Postman', 'test:e2e': 'E2E tests',
  'test:unit': 'unit tests', 'obs:sentry': 'Sentry', 'obs:grafana': 'Grafana', 'obs:prometheus': 'Prometheus',
  'quality:sonar': 'SonarQube', 'quality:semgrep': 'Semgrep', 'quality:snyk': 'Snyk', 'payments:stripe': 'Stripe', 'design:figma': 'Figma',
  'docs:notion': 'Notion',
};

export function stackSummary(ctx                )         {
  const labels = Object.values(ctx.signals)
    .filter((s) => SIGNAL_LABELS[s.id] && s.strength >= 0.6 && !s.evidence.every((e) => e.source === 'task'))
    .sort((a, b) => b.strength - a.strength)
    .map((s) => SIGNAL_LABELS[s.id]          );
  return [...new Set(labels)].slice(0, 14).join(', ') || 'nothing specific';
}

function availabilityLine(a                          )         {
  if (!a) return 'unknown';
  const map                                        = {
    configured: 'set up',
    disabled: 'installed, not enabled',
    'cli-available': 'CLI available',
    'not-configured': 'not configured',
    incompatible: 'not available',
    unknown: 'unknown',
  };
  return a.detail && a.state !== 'not-configured' ? `${map[a.state]} (${a.detail})` : map[a.state];
}

function list(s       , items          , indent = '  ')         {
  return items.map((i) => (s.md ? `- ${i}` : `${indent}- ${i}`)).join('\n');
}

function actionsFor(r                , hosts          , s       )           {
  const e = r.entry;
  const lines           = [];
  const missing = hosts.filter((h) => r.availability[h]?.state !== 'configured' && r.availability[h]?.state !== 'incompatible');
  const host = missing[0] ?? hosts[0] ?? 'claude';
  const hostFlag = missing.length === 1 || hosts.length === 1 ? ` --host ${host}` : ' --host <claude|codex>';
  if (e.kind === 'mcp' && e.install) {
    lines.push(`${code(s, `stackhint install ${e.id}${hostFlag}`)} - shows the exact change and asks before writing`);
    lines.push(`${code(s, `stackhint try ${e.id}${hostFlag}`)} - one session without installing`);
  } else if (e.kind === 'plugin' && e.hosts.claude.plugin) {
    lines.push(`${code(s, `stackhint install ${e.id} --host claude`)} - runs \`claude plugin install ${e.hosts.claude.plugin}\` after you confirm`);
  } else {
    lines.push(`${code(s, `stackhint explain ${e.id}`)} - setup steps`);
  }
  if (e.kind === 'mcp' || e.kind === 'plugin') lines.push(`${code(s, `stackhint explain ${e.id}`)} - details, permissions, config preview`);
  lines.push(`${code(s, `stackhint dismiss ${e.id} --for 14d`)} - remind me later`);
  lines.push(`${code(s, `stackhint dismiss ${e.id}`)} - never suggest again`);
  return lines;
}

export function renderRecommendations(
  s       ,
  ctx                ,
  hosts          ,
  recs                  ,
  available                  ,
  opts                                                     = {},
)         {
  const out           = [];
  out.push(heading(s, `stackhint: tools for ${sanitizeLine(displayPath(ctx.root), 120)}`, 2));
  out.push(`Detected: ${stackSummary(ctx)}${ctx.task ? ` | task: "${t(s, ctx.task.text, 120)}"` : ''}`);
  out.push(`Hosts: ${hosts.map(hostLabel).join(', ')} | ${ctx.stats.filesSeen} files scanned in ${ctx.stats.elapsedMs} ms${ctx.stats.truncated ? ' (stopped early)' : ''}`);
  out.push('');
  if (recs.length === 0) {
    out.push(s.md ? '_No new recommendations for this project right now._' : s.c.dim('No new recommendations for this project right now.'));
  }
  recs.forEach((r, i) => {
    const e = r.entry;
    const label = r.action === 'replace' ? 'Replace with' : e.kind === 'skill' ? 'Consider' : 'Recommendation';
    const head = `${label}: ${e.name}`;
    const meta = `fit ${r.score}/100, confidence ${r.confidence}`;
    out.push(s.md ? `### ${i + 1}. ${t(s, head)} (${meta})` : `${s.c.bold(`${i + 1}. ${head}`)}  ${s.c.dim(meta)}`);
    out.push(`${s.md ? '**Why now:**' : 'Why now:'} ${t(s, r.whyNow, 500)}`);
    if (e.benefits.length) {
      out.push(s.md ? '**Benefits:**' : 'Benefits:');
      out.push(list(s, e.benefits.slice(0, 3).map((b) => t(s, b, 200))));
    }
    out.push(`${s.md ? '**Permissions:**' : 'Permissions:'} ${t(s, e.access.summary || e.access.level, 300)}`);
    out.push(`${s.md ? '**Setup:**' : 'Setup:'} ~${e.setup.minutes} min, ${e.setup.effort} effort; auth: ${t(s, e.auth.type)}${e.official ? '; official vendor tool' : '; community project'}`);
    out.push(`${s.md ? '**Status:**' : 'Status:'} ${hosts.map((h) => `${hostLabel(h)}: ${availabilityLine(r.availability[h])}`).join(' | ')}`);
    if (r.uncertainty.length) out.push(`${s.md ? '**Uncertain:**' : 'Uncertain:'} ${t(s, r.uncertainty.join('; '), 400)}`);
    if (r.alternatives.length) out.push(`${s.md ? '**Alternatives:**' : 'Alternatives:'} ${r.alternatives.join(', ')}`);
    out.push(s.md ? '**Actions:**' : 'Actions:');
    out.push(list(s, actionsFor(r, hosts, s)));
    out.push('');
  });
  if (opts.showAvailable !== false && available.length) {
    out.push(heading(s, 'Already set up or covered', 3));
    out.push(list(s, available.slice(0, 8).map((r) => `${t(s, r.entry.name)}: ${hosts.map((h) => `${hostLabel(h)} ${availabilityLine(r.availability[h])}`).join('; ')}${r.whyNow.includes('already have') ? ` (${t(s, r.whyNow.slice(r.whyNow.indexOf('You already have')), 160)})` : ''}`)));
    out.push('');
  }
  out.push(s.md ? '_Scores are heuristic (relevance, value, setup cost, risk), not measurements. Nothing is installed without your confirmation._' : s.c.dim('Scores are heuristic (relevance, value, setup cost, risk), not measurements. Nothing is installed without your confirmation.'));
  if (opts.registryNote) out.push(s.md ? `_${opts.registryNote}_` : s.c.dim(opts.registryNote));
  return out.join('\n');
}

export function renderScan(s       , ctx                )         {
  const out           = [];
  out.push(heading(s, `Project scan: ${sanitizeLine(displayPath(ctx.root), 120)}`));
  out.push(`${ctx.stats.filesSeen} files seen, ${ctx.stats.filesRead} read, ${ctx.stats.elapsedMs} ms${ctx.stats.truncated ? ', stopped early' : ''}`);
  if (ctx.git.isRepo) out.push(`git: ${ctx.git.branch ?? '(detached)'}; remotes: ${ctx.git.remotes.map((r) => `${r.name} ${r.host}`).join(', ') || 'none'}`);
  out.push('');
  const signals = Object.values(ctx.signals).sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id));
  for (const sig of signals) {
    const ev = sig.evidence.slice(0, 2).map((e) => `${e.detail}${e.source !== '.' && e.source !== 'git' && e.source !== 'task' ? ` [${e.source}]` : ''}`).join('; ');
    const id = sig.id.startsWith('team-mcp:') ? 'team-mcp' : sig.id;
    out.push(s.md ? `- \`${id}\` ${sig.strength.toFixed(2)}: ${t(s, ev, 300)}` : `  ${s.c.cyan(id.padEnd(24))} ${sig.strength.toFixed(2)}  ${s.c.dim(sanitizeLine(ev, 160))}`);
  }
  if (signals.length === 0) out.push('  (no signals)');
  for (const w of ctx.warnings) out.push(s.c.yellow(`warning: ${sanitizeLine(w, 200)}`));
  return out.join('\n');
}

export function renderExplain(s       , r                            , e               , hosts          , previews                                 , ctx                            )         {
  const out           = [];
  out.push(heading(s, `${e.name}${e.official ? ' (official)' : ''}`));
  out.push(t(s, e.description));
  out.push('');
  const facts           = [
    `Vendor: ${t(s, e.vendor)}${e.official ? '' : ' (community-maintained)'}`,
    `Docs: ${e.docs || 'unknown'}`,
    ...(e.repo ? [`Source: ${e.repo}`] : []),
    `License: ${e.license ?? 'not recorded'}`,
    `Status: ${e.status}${e.statusNote ? ` (${t(s, e.statusNote, 200)})` : ''}`,
    `Registry facts verified: ${e.verifiedAt || 'unknown'}${e.origin === 'custom' ? ' (custom registry entry)' : ''}`,
  ];
  out.push(list(s, facts));
  out.push('');
  if (e.problem) out.push(`${s.md ? '**Problem it solves:**' : 'Problem it solves:'} ${t(s, e.problem)}`);
  if (e.workflow) out.push(`${s.md ? '**Workflow:**' : 'Workflow:'} ${t(s, e.workflow)}`);
  if (r) {
    out.push(`${s.md ? '**Why now:**' : 'Why now:'} ${t(s, r.whyNow)}`);
    out.push(s.md ? '**Evidence:**' : 'Evidence:');
    out.push(list(s, r.reasons.slice(0, 6).map((x) => `${x.signal} (strength ${x.strength.toFixed(2)}, weight ${x.weight}): ${t(s, x.evidence.map((ev) => `${ev.detail}${ev.source !== '.' && ev.source !== 'git' && ev.source !== 'task' ? ` [${ev.source}]` : ''}`).slice(0, 2).join('; '), 240)}`)));
    const b = r.breakdown;
    out.push(`${s.md ? '**Score:**' : 'Score:'} ${r.score}/100, confidence ${r.confidence}. relevance ${b.relevance}, value ${b.value}, immediacy ${b.immediacy}, compatibility ${b.compatibility}, overlap ${b.overlap}, setup cost -${b.setupCost}, risk -${b.risk}. Heuristic, not a measurement.`);
    if (r.uncertainty.length) out.push(`${s.md ? '**Uncertain:**' : 'Uncertain:'} ${t(s, r.uncertainty.join('; '))}`);
  } else if (ctx) {
    out.push(`${s.md ? '**Why now:**' : 'Why now:'} no supporting evidence in this project; shown because you asked.`);
  }
  out.push('');
  out.push(heading(s, 'Permissions and risks', 3));
  const risks = [
    `Access: ${e.access.level}. ${t(s, e.access.summary)}`,
    `Auth: ${e.auth.type}. ${t(s, e.auth.detail)}`,
    `Network: ${t(s, e.network || 'not recorded')}`,
    ...e.securityNotes.map((n) => `Security: ${t(s, n)}`),
    ...e.limitations.map((n) => `Limitation: ${t(s, n)}`),
  ];
  out.push(list(s, risks));
  out.push('');
  out.push(heading(s, 'Setup', 3));
  out.push(list(s, [`About ${e.setup.minutes} minutes (${e.setup.effort})`, ...(e.setup.prerequisites ?? []).map((p) => `Needs: ${t(s, p)}`)]));
  out.push('');
  for (const h of hosts) {
    out.push(heading(s, hostLabel(h), 3));
    const info = e.hosts[h];
    const lines           = [`Support: ${info.support}${info.notes ? ` (${t(s, info.notes)})` : ''}`];
    if (r?.availability[h]) lines.push(`Here: ${availabilityLine(r.availability[h])}`);
    if (e.kind === 'mcp' && e.install && info.support !== 'no') lines.push(`Install: ${code(s, `stackhint install ${e.id} --host ${h}`)} (dry run first: add --dry-run)`);
    if (info.plugin) lines.push(`Official plugin: ${code(s, h === 'claude' ? `/plugin install ${info.plugin}` : `codex plugin add ${info.plugin}`)}`);
    if (info.officialCommand) lines.push(`Vendor's own command: ${code(s, info.officialCommand)}`);
    out.push(list(s, lines));
    const preview = previews[h];
    if (preview) {
      out.push(s.md ? `\n\`\`\`${h === 'claude' ? 'json' : 'toml'}\n${preview}\n\`\`\`` : s.c.dim(preview.split('\n').map((l) => '    ' + l).join('\n')));
    }
    out.push('');
  }
  if (e.guide?.length) {
    out.push(heading(s, 'Steps', 3));
    out.push(list(s, e.guide.map((g) => t(s, g))));
    out.push('');
  }
  if (r?.alternatives.length || e.alternatives?.length) out.push(`Alternatives: ${(r?.alternatives ?? e.alternatives ?? []).join(', ')}`);
  out.push(`Not now: ${code(s, `stackhint dismiss ${e.id} --for 14d`)} | never: ${code(s, `stackhint dismiss ${e.id}`)}`);
  return out.join('\n');
}

export function renderPlan(s       , p             )         {
  const out           = [];
  out.push(heading(s, `Install plan: ${p.entryName} for ${hostLabel(p.host)}`));
  if (p.blocked) {
    out.push(s.c.red(`Blocked: ${p.blocked}`));
    return out.join('\n');
  }
  const src = p.source;
  out.push(list(s, [
    `Source: ${src.vendor}${src.official ? ' (official)' : ' (community)'}; docs ${src.docs || 'n/a'}${src.repo ? `; repo ${src.repo}` : ''}; facts verified ${src.verifiedAt || 'unknown'}`,
    `Method: ${p.method === 'file' ? `edit ${displayPath(p.target?.path ?? '')}` : p.method === 'cli' ? `run the host's own CLI` : 'manual steps'}; scope: ${p.scope}${p.access !== 'n/a' ? `; access: ${p.access}` : ''}`,
    `Permissions: ${t(s, p.permissions)}`,
    `Auth: ${t(s, p.auth)}`,
    ...(p.network ? [`Network: ${t(s, p.network)}`] : []),
  ]));
  if (p.method === 'cli' && p.argv) {
    out.push('');
    out.push('Command:');
    out.push(s.md ? '```\n' + redactString(`claude ${redactArgs(p.argv).join(' ')}`) + '\n```' : '  ' + s.c.cyan(redactString(p.command ?? '')));
  }
  if (p.diff) {
    out.push('');
    out.push(`Change to ${displayPath(p.target?.path ?? '')}${p.target?.existed ? '' : ' (new file)'}:`);
    out.push(s.md ? '```diff\n' + p.diff + '\n```' : p.diff.split('\n').map((l) => (l.startsWith('+') ? s.c.green(l) : l.startsWith('-') ? s.c.red(l) : s.c.dim(l))).map((l) => '  ' + l).join('\n'));
  }
  if (p.envNeeded.length) {
    out.push('');
    out.push('Environment variables (referenced by name, values are never written):');
    out.push(list(s, p.envNeeded.map((e) => `${e.name}${e.optional ? ' (optional)' : ''}: ${e.set ? 'set in this shell' : 'not set'}`)));
  }
  if (p.prerequisites.length) {
    out.push('');
    out.push('Prerequisites:');
    out.push(list(s, p.prerequisites.map((x) => `${x.name}: ${x.found ? 'found' : 'not found on PATH'}`)));
  }
  if (p.sideEffects.length) {
    out.push('');
    out.push('Side effects:');
    out.push(list(s, p.sideEffects.map((x) => t(s, x))));
  }
  if (p.warnings.length) {
    out.push('');
    out.push(list(s, p.warnings.map((w) => s.c.yellow(t(s, w)))));
  }
  if (p.method === 'guided') {
    out.push('');
    out.push('Steps:');
    out.push(list(s, (p.nextSteps.length ? p.nextSteps : p.guide).map((x) => t(s, x))));
  }
  if (p.rollback) {
    out.push('');
    out.push(`Undo: ${p.rollback}`);
  }
  return out.join('\n');
}

export function renderApply(s       , p             , r             )         {
  const out           = [];
  const colorize = r.status === 'applied' ? s.c.green : r.status === 'failed' || r.status === 'blocked' ? s.c.red : s.c.yellow;
  out.push(colorize(r.message));
  for (const v of r.verification) out.push(`  - ${v}`);
  if (r.status === 'applied') {
    if (r.rollback) out.push(`Undo: ${r.rollback}`);
    if (p.nextSteps.length) {
      out.push('Next:');
      out.push(list(s, p.nextSteps.map((x) => t(s, x))));
    }
  }
  return out.join('\n');
}

export function renderStatus(s       , inv           , hosts          , root        )         {
  const out           = [];
  out.push(heading(s, `Integrations for ${sanitizeLine(displayPath(root), 120)}`));
  for (const h of hosts) {
    out.push('');
    out.push(heading(s, `${hostLabel(h)}${inv.hostsDetected[h] ? '' : ' (not detected on this machine)'}`, 3));
    if (inv.hostCli[h]) out.push(`CLI: ${displayPath(inv.hostCli[h]          )}`);
    const servers = inv.servers.filter((x) => x.host === h);
    out.push(`MCP servers (configured, not verified as running): ${servers.length ? '' : 'none'}`);
    for (const x of servers) {
      const what = x.url ? redactString(x.url) : redactArgs([x.command ?? '', ...x.args]).join(' ');
      out.push(`  - ${x.name} [${x.viaPlugin ? `plugin ${x.viaPlugin}` : x.scope}${x.enabled ? '' : ', disabled'}] ${x.transport}: ${sanitizeLine(what, 140)}`);
    }
    const plugins = inv.plugins.filter((x) => x.host === h);
    if (plugins.length) out.push(`Plugins: ${plugins.map((p) => `${p.id}${p.enabled ? '' : ' (disabled)'}`).join(', ')}`);
    const skills = inv.skills.filter((x) => x.host === h);
    if (skills.length) out.push(`Skills/commands: ${skills.map((k) => `${k.name} (${k.scope})`).slice(0, 20).join(', ')}${skills.length > 20 ? ', …' : ''}`);
    for (const f of inv.files.filter((x) => x.host === h)) {
      if (f.error) out.push(s.c.red(`  ! ${f.kind}: ${f.error} (${displayPath(f.path)})`));
    }
  }
  const exes = Object.keys(inv.executables).filter((x) => x !== 'claude' && x !== 'codex');
  out.push('');
  out.push(`Tools on PATH: ${exes.join(', ') || 'none of the ones stackhint looks for'}`);
  if (inv.managedMcp) out.push(s.c.yellow(`Managed MCP config active: ${inv.managedMcp}`));
  return out.join('\n');
}

export function renderFindings(s       , findings           )         {
  if (findings.length === 0) return 'No problems found in the configured MCP servers.';
  const out           = [heading(s, `${findings.length} finding${findings.length === 1 ? '' : 's'}`)];
  for (const f of findings) {
    const tag = f.severity.toUpperCase();
    const col = f.severity === 'high' ? s.c.red : f.severity === 'medium' ? s.c.yellow : s.c.dim;
    out.push(s.md ? `- **${tag}** (${hostLabel(f.host)}) ${t(s, f.message)}${f.fix ? ` Fix: ${t(s, f.fix)}` : ''}` : `${col(tag.padEnd(6))} ${hostLabel(f.host)}: ${sanitizeLine(f.message, 400)}${f.fix ? `\n       fix: ${sanitizeLine(f.fix, 300)}` : ''}`);
  }
  return out.join('\n');
}

/** Compact JSON for --format json and the MCP server. */
export function recommendationJson(r                )                          {
  return {
    id: r.id,
    name: r.entry.name,
    kind: r.entry.kind,
    action: r.action,
    score: r.score,
    confidence: r.confidence,
    whyNow: r.whyNow,
    reasons: r.reasons.map((x) => ({ signal: x.signal, strength: x.strength, weight: x.weight, evidence: x.evidence.slice(0, 3) })),
    breakdown: r.breakdown,
    availability: Object.fromEntries(Object.entries(r.availability).map(([h, a]) => [h, { state: a?.state, detail: a?.detail }])),
    uncertainty: r.uncertainty,
    alternatives: r.alternatives,
    official: r.entry.official,
    docs: r.entry.docs,
    access: r.entry.access,
    auth: r.entry.auth,
    setup: r.entry.setup,
  };
}
