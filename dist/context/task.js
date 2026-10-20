import { SignalSet } from './signals.js';

// Keyword rules for an explicit task description (from --task, the MCP tool or a prompt hook).
// Each rule emits a task category and, when a product is named, the product signal itself.
// Russian keywords are included because the author's team writes tasks in Russian.



const RULES         = [
  // categories
  [/\b(pull request|pull-request|\bpr\b|prs\b|code review|review (the|this|my) (pr|change|diff)|merge request|\bmr\b)|пулл?[- ]?реквест|ревью|код[- ]?ревью/i, [['task:pr-review', 0.9]]],
  [/\b(ticket|issue|backlog|sprint|epic|user story|bug report)s?\b|тикет|бэклог|спринт|эпик/i, [['task:issue-tracking', 0.75]]],
  [/\b(sql|query|queries|database|db|explain analyze|deadlock|slow quer\w*|migrations?|schema|(add|adding|missing|create|drop|unused) (an? )?index(es)?)\b|запрос|баз[аеуы] данных|индекс|миграци/i, [['task:db', 0.8]]],
  [/\b(rest ?api|restful|endpoint|openapi|swagger|api|graphql|grpc|webhook)s?\b|эндпоинт|апи(?![а-яё])/i, [['task:api', 0.7]]],
  [/\b(test|tests|testing|e2e|end-to-end|flaky|coverage|unit test|integration test)\b|тест/i, [['task:testing', 0.75]]],
  [/\b(ci|cd|pipeline|github actions|workflow run|build (is )?(failing|broken|red)|deploy(ment)?|release)\b|пайплайн|деплой|сборк[аи] (пада|слома)/i, [['task:ci', 0.75]]],
  [/\b(docker|container|kubernetes|k8s|helm|pod|cluster|kubectl|compose)\b|контейнер|кубер/i, [['task:containers', 0.8]]],
  [/\b(docs|documentation|api reference|how (do|to)|latest version|deprecated api|sdk)\b|документаци/i, [['task:docs', 0.6]]],
  [/\b(boilerplate|scaffold|repetitive|template|generate (a|the|new)|again and again|every time|copy[- ]paste)\b|шаблон|бойлерплейт|каждый раз|рутин|однотипн/i, [['task:boilerplate', 0.75]]],
  [/\b(ui|css|layout|browser|frontend|front-end|page load|dom|devtools|screenshot|lighthouse|web vitals)\b|верстк|фронтенд|браузер/i, [['task:frontend', 0.75]]],
  [/\b(exception|stack ?trace|crash|error rate|sentry|logs?|metrics|grafana|alert|incident|outage|latency)\b|ошибк|исключени|падает|(?<![а-яё])лог[иа]?(?![а-яё])|метрик|инцидент/i, [['task:observability', 0.7]]],
  [/\b(aws|azure|gcp|google cloud|cloudflare|vercel|terraform|s3|lambda|iam)\b|облак/i, [['task:cloud', 0.75]]],
  [/\b(figma|design|mockup|wireframe)\b|макет|дизайн/i, [['task:design', 0.75]]],
  [/\b(stripe|payment|checkout|subscription|billing|invoice)s?\b|оплат|платеж|подписк/i, [['task:payments', 0.75]]],
  [/\b(security|vulnerab|cve|sast|secret scan|dependency audit)\w*\b|уязвим|безопасност/i, [['task:security', 0.75]]],
  [/\b(nuget|npm|package|dependenc(y|ies)|upgrade|outdated)\b|пакет|зависимост/i, [['task:dependencies', 0.6]]],

  // explicit products
  [/\bjira\b|джир/i, [['tracker:jira', 0.9], ['task:issue-tracking', 0.8]]],
  [/\bconfluence\b|конфлюенс/i, [['tracker:confluence', 0.9]]],
  // "linear" alone is too common (linear-gradient, linear regression): require tracker context.
  // Only phrases that clearly mean the tracker: "in/from/to/into Linear", "a Linear issue/board/...".
  [/\b(in|from|to|into|on) linear\b(?!-|\s+(time|scale|scaling|regression|algebra|search|scan|order|fashion|interpolation|combination|equation|model|programming|layout|motion|easing|growth|gradient|space|map|mode|form|function|probing|least))|(?<![\w-])linear (issues?|tickets?|boards?|cycles?|workspace|projects?|backlog|teams?|triage|inbox)\b/i, [['tracker:linear', 0.7]]],
  [/\bgithub\b|гитхаб/i, [['vcs:github', 0.9]]],
  [/\bgitlab\b|гитлаб/i, [['vcs:gitlab', 0.9]]],
  [/\bazure devops\b|\bado\b|azure boards|azure pipelines/i, [['vcs:azure-repos', 0.8], ['ci:azure-pipelines', 0.6]]],
  [/\bpostgres(ql)?\b|\bpsql\b|постгрес/i, [['db:postgres', 0.9]]],
  [/\bmysql\b|\bmariadb\b/i, [['db:mysql', 0.9]]],
  [/\bsql server\b|\bmssql\b|\bt-sql\b/i, [['db:sqlserver', 0.9]]],
  [/\bclickhouse\b|кликхаус/i, [['db:clickhouse', 0.9]]],
  [/\bmongo(db)?\b/i, [['db:mongodb', 0.9]]],
  [/\bredis\b/i, [['db:redis', 0.85]]],
  [/\belastic(search)?\b|\bkibana\b/i, [['db:elasticsearch', 0.85]]],
  [/\bsupabase\b/i, [['db:supabase', 0.9]]],
  // "neon" alone could be a colour; require database context.
  [/\bneon\b(?=.{0,40}\b(db|database|postgres\w*|branch\w*|serverless|sql)\b)|\b(db|database|postgres\w*|sql)\b.{0,40}\bneon\b/i, [['db:neon', 0.8]]],
  [/\bkubernetes\b|\bk8s\b|кубер/i, [['infra:kubernetes', 0.9]]],
  [/\bhelm\b/i, [['infra:helm', 0.85]]],
  [/\bargo ?cd\b/i, [['infra:argocd', 0.9]]],
  [/\bflux(cd)?\b/i, [['infra:flux', 0.6]]],
  [/\bterraform\b/i, [['infra:terraform', 0.9]]],
  [/\bdocker\b|докер/i, [['infra:docker', 0.85]]],
  [/\baws\b|amazon web services/i, [['cloud:aws', 0.85]]],
  [/\bazure\b/i, [['cloud:azure', 0.8]]],
  [/\bgcp\b|google cloud/i, [['cloud:gcp', 0.85]]],
  [/\bcloudflare\b|\bwrangler\b/i, [['cloud:cloudflare', 0.9]]],
  [/\bvercel\b/i, [['cloud:vercel', 0.9]]],
  [/\bfirebase\b/i, [['db:firebase', 0.9]]],
  [/\bsentry\b/i, [['obs:sentry', 0.9]]],
  [/\bgrafana\b|\bprometheus\b/i, [['obs:grafana', 0.8]]],
  [/\bfigma\b/i, [['design:figma', 0.9]]],
  [/\bnotion\b/i, [['docs:notion', 0.85]]],
  [/\bpostman\b/i, [['api:postman', 0.9]]],
  [/\bsonar(qube|cloud)?\b/i, [['quality:sonar', 0.9]]],
  [/\bsemgrep\b/i, [['quality:semgrep', 0.9]]],
  [/\bsnyk\b/i, [['quality:snyk', 0.9]]],
  [/\bplaywright\b/i, [['tool:playwright', 0.9], ['test:e2e', 0.7]]],
  [/\bstripe\b/i, [['payments:stripe', 0.9]]],
  [/\bcircle ?ci\b/i, [['ci:circleci', 0.9]]],
  [/\bbuildkite\b/i, [['ci:buildkite', 0.9]]],
  [/\bjenkins\b/i, [['ci:jenkins', 0.9]]],
  [/(?<![\w.])(\.net|c#|f#)(?![\w#])|\b(dotnet|csharp|asp\.net|ef core|entity framework|nuget)\b|дотнет/i, [['tech:dotnet', 0.85]]],
];

export function classifyTask(text        , set           )           {
  const found           = [];
  const clipped = text.slice(0, 4000);
  for (const [re, signals] of RULES) {
    if (!re.test(clipped)) continue;
    for (const [id, strength] of signals) {
      set.add(id, strength, { source: 'task', detail: `task mentions "${matchSnippet(re, clipped)}"` });
      if (!found.includes(id)) found.push(id);
    }
  }
  return found;
}

function matchSnippet(re        , text        )         {
  const m = re.exec(text);
  const s = m ? m[0] : '';
  return s.trim().slice(0, 40);
}
