import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';



















import { HOST_IDS } from '../types.js';
import { readJson } from '../util/fsx.js';
import { looksLikeLiteralSecret } from '../util/redact.js';
import { CONTAINER_CLIS, parseRunArgs } from '../util/docker.js';
import { sanitize, sanitizeLine } from '../util/text.js';

const KINDS              = ['mcp', 'plugin', 'skill', 'cli'];
const STATUSES                = ['active', 'preview', 'deprecated', 'archived', 'removed', 'unknown'];
const LEVELS                = ['read', 'write', 'admin', 'exec'];
const AUTHS             = ['none', 'oauth', 'token', 'connection', 'cloud', 'local-app', 'unknown'];
const EFFORTS           = ['low', 'medium', 'high'];
const FREQS              = ['daily', 'weekly', 'occasional'];
const SUPPORTS            = ['yes', 'no', 'unknown'];
const PLATFORMS             = ['windows', 'macos', 'linux'];

const ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SIGNAL = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9:.-]*$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const EXECUTABLE = /^[A-Za-z0-9._-]{1,64}$/;
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

/** Shell metacharacters and quoting we never allow in commands or arguments. */
const SHELL_META = /[;&|`$<>\\"'%^!\r\n\u0000]/;

/** Control, zero-width and bidi characters: they can disguise what a command really says. */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]|\udb40[\udc00-\udc7f]/;

/** Literal header and env values: plain words only, no quotes, no $ (no ${VAR} expansion tricks). */
const SAFE_VALUE = /^[A-Za-z0-9 ._:/=,+@*?~-]{0,200}$/;

/** Programs that would let a registry entry run arbitrary code or fetch-and-execute. */
const DENIED_COMMANDS = new Set([
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'cmd', 'powershell', 'pwsh', 'wsl', 'busybox',
  'curl', 'wget', 'iex', 'invoke-expression', 'python', 'python2', 'python3', 'py', 'pythonw', 'node', 'nodejs', 'deno',
  'bun', 'perl', 'ruby', 'php', 'lua', 'tclsh', 'eval', 'exec', 'env', 'xargs', 'nohup', 'timeout', 'nice', 'start',
  'sudo', 'su', 'doas', 'runas', 'rm', 'del', 'rmdir', 'mv', 'cp', 'dd', 'chmod', 'chown', 'osascript', 'open',
  'mshta', 'rundll32', 'regsvr32', 'certutil', 'bitsadmin', 'wscript', 'cscript', 'ssh', 'scp', 'nc', 'ncat', 'socat',
  'git', 'make', 'awk', 'sed', 'find',
]);

/** Text that tries to instruct an agent rather than describe a tool. Checked after normalization. */
const INSTRUCTION_LIKE =
  /(ignore (all |any )?(the )?(previous|prior|above|earlier|preceding) (instructions|messages|rules)|disregard (the|your|all|any) (instructions|rules)|forget (all |your )?(previous )?instructions|you are now|system prompt|developer message|<\/?(system|assistant|tool|user)>|run (this|the following) command|(curl|wget|iwr|irm|invoke-webrequest) [^\n]{0,200}\| ?(ba|z)?sh|\| ?iex|rm -rf|exfiltrat|send (the|your|all) (token|secret|key|password|credential)s?)/i;

/** Normalize text before looking for instructions: NFKC, no invisible characters, single spaces. */
function normalizeForScan(s        )         {
  return s
    .normalize('NFKC')
    // Unicode tag characters (U+E0020-E007E) can smuggle invisible ASCII text: read them as ASCII.
    .replace(/\udb40([\udc20-\udc7e])/g, (_m, lo        ) => String.fromCharCode(lo.charCodeAt(0) - 0xdc00))
    .replace(/\s+/g, ' ') // tabs and newlines become spaces, so words are not glued together
    .replace(new RegExp(INVISIBLE.source, 'g'), '')
    .replace(/ {2,}/g, ' ')
    .toLowerCase();
}

/** Strip a Windows executable extension and lowercase, so "node.exe" is checked as "node". */
function commandBase(c        )         {
  return c
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com|ps1)$/, '')
    .replace(/-(preview|beta|nightly|dev|canary)$/, '')
    .replace(/[-_.]?\d[\d._-]*$/, ''); // python3.12, node22, pwsh7 -> python, node, pwsh
}

/** Interpreters and shells under any versioned name. */
const INTERPRETER_PREFIX = /^(python|pythonw|pyw|py|pypy|ipython|jython|node|nodejs|pwsh|powershell|perl|ruby|php|bash|zsh|ksh|lua|deno|bun|tclsh|rscript)([\d._]|-\d|-(preview|beta|nightly|dev|canary)|$)/;








export function builtinRegistryPath()         {
  // Works from src/registry/*.ts and dist/registry/*.js alike.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'registry', 'registry.json');
}

export function loadRegistry(opts              = {})           {
  const warnings           = [];
  const entries = new Map                       ();
  const file = opts.builtinFile ?? builtinRegistryPath();
  let version = 0;
  let updated = '';

  const ingest = (filePath        , origin                      )       => {
    const res = readJson                         (filePath);
    if (!res.ok) {
      warnings.push(`registry ${path.basename(filePath)}: ${res.error}`);
      return;
    }
    const doc = res.value;
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc['entries'])) {
      warnings.push(`registry ${path.basename(filePath)}: expected an object with an "entries" array`);
      return;
    }
    const docUpdated = typeof doc['updated'] === 'string' && DATE.test(doc['updated']) ? (doc['updated']          ) : '';
    if (origin === 'builtin') {
      version = typeof doc['version'] === 'number' ? (doc['version']          ) : 0;
      updated = docUpdated;
    }
    for (const raw of doc['entries']             ) {
      const { entry, errors } = validateEntry(raw, { origin, defaultVerifiedAt: docUpdated });
      const label = raw && typeof raw === 'object' && typeof (raw                           )['id'] === 'string' ? (raw                          )['id'] : '?';
      if (!entry) {
        warnings.push(`registry entry "${sanitizeLine(label, 64)}" skipped: ${errors.join('; ')}`);
        continue;
      }
      if (errors.length) warnings.push(`registry entry "${entry.id}": ${errors.join('; ')}`);
      if (entries.has(entry.id)) {
        if (origin === 'custom') warnings.push(`custom registry entry "${entry.id}" overrides the built-in one`);
        else {
          warnings.push(`duplicate registry id "${entry.id}" ignored`);
          continue;
        }
      }
      entries.set(entry.id, entry);
    }
  };

  ingest(file, 'builtin');
  for (const extra of opts.extraFiles ?? []) ingest(extra, 'custom');

  // Cross-references.
  for (const e of entries.values()) {
    if (e.successor && !entries.has(e.successor)) warnings.push(`registry entry "${e.id}": successor "${e.successor}" not found`);
    e.alternatives = (e.alternatives ?? []).filter((a) => entries.has(a) && a !== e.id);
  }
  return { version, updated, entries: [...entries.values()], warnings };
}

/** Custom registry files: ~/.stackhint/registry.d/*.json plus $STACKHINT_REGISTRY. */
export function customRegistryFiles(home        , env                    = process.env)           {
  const files           = [];
  const dir = path.join(home, 'registry.d');
  try {
    for (const name of fs.readdirSync(dir).sort()) if (name.endsWith('.json')) files.push(path.join(dir, name));
  } catch {
    /* none */
  }
  const fromEnv = env['STACKHINT_REGISTRY'];
  if (fromEnv) for (const p of fromEnv.split(path.delimiter).filter(Boolean)) files.push(p);
  return files;
}

// ---------------- validation ----------------








function isObj(v         )           {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v         )                     {
  return typeof v === 'string' ? v : undefined;
}

function strArray(v         , max = 200)           {
  if (!Array.isArray(v)) return [];
  return v.filter((x)              => typeof x === 'string').map((x) => sanitize(x, max)).filter(Boolean);
}

function oneOf                  (v         , allowed              , fallback   )    {
  return typeof v === 'string' && (allowed                     ).includes(v) ? (v     ) : fallback;
}

export function isSafeUrl(url        )          {
  if (url.length > 500 || /\s|["'`<>\\$]/.test(url) || INVISIBLE.test(url)) return false;
  if (/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[^\s]*)?$/.test(url)) return true;
  return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?(\/[^\s]*)?$/.test(url);
}

/** Every string anywhere in the entry, keys included. */
function textFieldsOf(raw     )                       {
  const out           = [];
  let chars = 0;
  let tooBig = false;
  const walk = (v         , depth        )       => {
    if (tooBig) return;
    if (depth > 8 || out.length > 5000 || chars > 400_000) {
      tooBig = true;
      return;
    }
    if (typeof v === 'string') {
      out.push(v);
      chars += v.length;
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) {
        out.push(k);
        chars += k.length;
        walk(x, depth + 1);
      }
    }
    if (out.length > 5000 || chars > 400_000) tooBig = true;
  };
  walk(raw, 0);
  // An entry too large or too deep to scan completely is rejected rather than half-checked.
  return tooBig ? undefined : out;
}

export function validateEntry(raw         , ctx                  = { origin: 'custom', defaultVerifiedAt: '' })                                              {
  const errors           = [];
  const incomplete           = [];
  if (!isObj(raw)) return { errors: ['not an object'] };

  const id = str(raw['id']);
  if (!id || !ID.test(id)) return { errors: ['missing or invalid id'] };
  const name = sanitizeLine(raw['name'], 120);
  if (!name) return { errors: ['missing name'] };
  const kind = str(raw['kind']);
  if (!kind || !(KINDS            ).includes(kind)) return { errors: [`invalid kind "${sanitizeLine(kind, 20)}"`] };
  const description = sanitize(raw['description'], 600);
  if (!description) return { errors: ['missing description'] };

  const texts = textFieldsOf(raw);
  if (!texts) return { errors: ['entry is too large or too deeply nested to check'] };
  const suspicious = texts.find((t) => INSTRUCTION_LIKE.test(normalizeForScan(t)));
  if (suspicious) return { errors: ['text contains instruction-like content; entry rejected'] };

  const docs = str(raw['docs']) ?? '';
  if (!docs) incomplete.push('docs');
  else if (!isSafeUrl(docs)) return { errors: ['docs URL must be https'] };
  const repo = str(raw['repo']);
  if (repo !== undefined && !isSafeUrl(repo)) return { errors: ['repo URL must be https'] };

  const status = oneOf(raw['status'], STATUSES, 'unknown');
  if (raw['status'] === undefined) incomplete.push('status');
  let verifiedAt = str(raw['verifiedAt']) ?? ctx.defaultVerifiedAt;
  if (!DATE.test(verifiedAt)) {
    incomplete.push('verifiedAt');
    verifiedAt = '';
  }

  const triggers            = [];
  if (Array.isArray(raw['triggers'])) {
    for (const t of raw['triggers']) {
      if (!isObj(t) || typeof t['signal'] !== 'string' || !SIGNAL.test(t['signal']) || typeof t['weight'] !== 'number') {
        errors.push('invalid trigger ignored');
        continue;
      }
      triggers.push({ signal: t['signal'], weight: Math.max(0, Math.min(1, t['weight'])) });
    }
  }
  const requiresAny = Array.isArray(raw['requiresAny']) ? (raw['requiresAny']             ).filter((s)              => typeof s === 'string' && SIGNAL.test(s)) : undefined;

  const accessRaw = isObj(raw['access']) ? raw['access'] : {};
  if (!isObj(raw['access'])) incomplete.push('access');
  const authRaw = isObj(raw['auth']) ? raw['auth'] : {};
  if (!isObj(raw['auth'])) incomplete.push('auth');
  const setupRaw = isObj(raw['setup']) ? raw['setup'] : {};
  const valueRaw = isObj(raw['value']) ? raw['value'] : {};

  const hosts = {}                            ;
  const hostsRaw = isObj(raw['hosts']) ? raw['hosts'] : {};
  for (const h of HOST_IDS) {
    const hr = isObj(hostsRaw[h]) ? (hostsRaw[h]       ) : {};
    const info           = { support: oneOf(hr['support'], SUPPORTS, 'unknown') };
    if (hr['support'] === undefined) incomplete.push(`hosts.${h}`);
    const plugin = str(hr['plugin']);
    if (plugin !== undefined) {
      if (PLUGIN_ID.test(plugin)) info.plugin = plugin;
      else errors.push(`invalid plugin id for ${h} ignored`);
    }
    const oc = str(hr['officialCommand']);
    if (oc) info.officialCommand = sanitizeLine(oc, 400);
    const notes = str(hr['notes']);
    if (notes) info.notes = sanitize(notes, 300);
    hosts[h] = info;
  }

  let install                         ;
  if (raw['install'] !== undefined) {
    const res = validateInstall(raw['install'], ctx.origin);
    if (res.error) return { errors: [`install: ${res.error}`] };
    install = res.install;
    if (kind !== 'mcp') return { errors: ['install specs are only valid for kind "mcp"'] };
  }

  const matchRaw = isObj(raw['match']) ? raw['match'] : {};
  const match            = {};
  for (const key of ['urls', 'packages', 'names', 'plugins', 'executables', 'skills']         ) {
    const values = strArray(matchRaw[key], 200).map((v) => v.trim()).filter((v) => v.length >= 2);
    if (key === 'executables' && values.some((v) => !EXECUTABLE.test(v))) return { errors: ['invalid executable name in match'] };
    if (values.length) match[key] = values;
  }

  const platforms = Array.isArray(raw['platforms']) ? (raw['platforms']             ).filter((p)                => (PLATFORMS             ).includes(p)) : [...PLATFORMS];

  const timeSaved = valueRaw['timeSaved'];
  const entry                = {
    id,
    name,
    kind: kind             ,
    category: sanitizeLine(raw['category'], 40) || 'other',
    description,
    vendor: sanitizeLine(raw['vendor'], 80) || 'unknown',
    official: raw['official'] === true && ctx.origin === 'builtin',
    credibility: raw['official'] === true && ctx.origin === 'builtin' ? 'vendor' : 'community',
    ...(repo ? { repo } : {}),
    docs,
    ...(str(raw['license']) ? { license: sanitizeLine(raw['license'], 60) } : {}),
    status,
    ...(str(raw['statusNote']) ? { statusNote: sanitize(raw['statusNote'], 300) } : {}),
    ...(str(raw['successor']) && ID.test(str(raw['successor'])          ) ? { successor: str(raw['successor'])           } : {}),
    verifiedAt,
    platforms: platforms.length ? platforms : [...PLATFORMS],
    provides: strArray(raw['provides'], 60),
    triggers,
    ...(requiresAny && requiresAny.length ? { requiresAny } : {}),
    problem: sanitize(raw['problem'], 400),
    workflow: sanitize(raw['workflow'], 400),
    benefits: strArray(raw['benefits'], 200),
    access: {
      level: oneOf(accessRaw['level'], LEVELS, 'write'),
      summary: sanitize(accessRaw['summary'], 300),
      readOnlyAvailable: accessRaw['readOnlyAvailable'] === true,
    },
    auth: { type: oneOf(authRaw['type'], AUTHS, 'unknown'), detail: sanitize(authRaw['detail'], 300) },
    network: sanitize(raw['network'], 200),
    setup: {
      effort: oneOf(setupRaw['effort'], EFFORTS, 'medium'),
      minutes: typeof setupRaw['minutes'] === 'number' && setupRaw['minutes'] > 0 ? Math.min(600, setupRaw['minutes']) : 15,
      ...(Array.isArray(setupRaw['prerequisites']) ? { prerequisites: strArray(setupRaw['prerequisites'], 200) } : {}),
    },
    value: {
      timeSaved: timeSaved === 1 || timeSaved === 2 || timeSaved === 3 ? timeSaved : 1,
      frequency: oneOf(valueRaw['frequency'], FREQS, 'occasional'),
    },
    hosts,
    ...(install ? { install } : {}),
    ...(Array.isArray(raw['guide']) ? { guide: strArray(raw['guide'], 400) } : {}),
    match,
    limitations: strArray(raw['limitations'], 300),
    securityNotes: strArray(raw['securityNotes'], 300),
    ...(str(raw['group']) ? { group: sanitizeLine(raw['group'], 40) } : {}),
    alternatives: strArray(raw['alternatives'], 64).filter((a) => ID.test(a)),
    origin: ctx.origin,
    incomplete,
  };
  if (entry.access.level === 'read' && install?.write && !install.readOnly) {
    errors.push('access level "read" but no read-only install variant; treating as write');
    entry.access.level = 'write';
  }
  return { entry, errors };
}

export function validateServerSpec(raw         , params         , partial         )                                        {
  if (!isObj(raw)) return { error: 'server spec must be an object' };
  const transport = raw['transport'];
  if (!partial && transport !== 'http' && transport !== 'stdio') return { error: 'transport must be http or stdio' };
  const spec                      = {};
  if (transport === 'http' || transport === 'stdio') spec.transport = transport;
  const paramNames = new Set(params.map((p) => p.name));
  const checkPlaceholders = (s        )                     => {
    for (const m of s.matchAll(/\{([^}]*)\}/g)) if (!paramNames.has(m[1]          )) return `unknown placeholder {${m[1]}}`;
    return undefined;
  };

  if (raw['url'] !== undefined) {
    const url = str(raw['url']);
    if (!url) return { error: 'url must be a string' };
    const bad = checkPlaceholders(url);
    if (bad) return { error: bad };
    const sample = url.replace(/\{[^}]+\}/g, (m) => {
      const p = params.find((x) => `{${x.name}}` === m);
      return p?.default ?? p?.example ?? 'x';
    });
    if (!isSafeUrl(sample)) return { error: 'url must be https (or http on localhost)' };
    spec.url = url;
  }
  if (raw['headers'] !== undefined) {
    if (!isObj(raw['headers'])) return { error: 'headers must be an object' };
    const headers                         = {};
    for (const [k, v] of Object.entries(raw['headers'])) {
      if (!HEADER_NAME.test(k) || typeof v !== 'string') return { error: `invalid header ${k}` };
      if (looksLikeLiteralSecret(k, v)) return { error: `header ${k} contains a literal secret; use bearerTokenEnv or envHeaders` };
      // No quotes, no $ (Claude Code expands ${VAR} in headers, which could send any env var to the server).
      if (!SAFE_VALUE.test(v)) return { error: `header ${k} has characters that are not allowed; use envHeaders for values from the environment` };
      headers[k] = v;
    }
    spec.headers = headers;
  }
  if (raw['bearerTokenEnv'] !== undefined) {
    const v = str(raw['bearerTokenEnv']);
    if (!v || !ENV_NAME.test(v)) return { error: 'bearerTokenEnv must be an env var name' };
    spec.bearerTokenEnv = v;
  }
  if (raw['envHeaders'] !== undefined) {
    if (!isObj(raw['envHeaders'])) return { error: 'envHeaders must be an object' };
    const eh                         = {};
    for (const [k, v] of Object.entries(raw['envHeaders'])) {
      if (!HEADER_NAME.test(k) || typeof v !== 'string' || !ENV_NAME.test(v)) return { error: `invalid envHeaders entry ${k}` };
      eh[k] = v;
    }
    spec.envHeaders = eh;
  }
  if (raw['command'] !== undefined) {
    const c = str(raw['command']);
    if (!c || !EXECUTABLE.test(c)) return { error: 'command must be a bare executable name' };
    if (DENIED_COMMANDS.has(commandBase(c)) || INTERPRETER_PREFIX.test(c.toLowerCase())) return { error: `command "${c}" is not allowed` };
    spec.command = c;
  }
  if (raw['args'] !== undefined) {
    if (!Array.isArray(raw['args']) || raw['args'].some((a) => typeof a !== 'string')) return { error: 'args must be strings' };
    const args = raw['args']            ;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]          ;
      if (SHELL_META.test(a) || INVISIBLE.test(a) || a.length > 300) return { error: `argument contains shell metacharacters or hidden characters: ${sanitizeLine(a, 40)}` };
      const bad = checkPlaceholders(a);
      if (bad) return { error: bad };
      if (looksLikeLiteralSecret(args[i - 1] ?? '', a) || /^--?[a-z-]*(token|key|secret|password)[a-z-]*=.+/i.test(a)) {
        return { error: 'arguments must not carry secrets; use passEnv' };
      }
    }
    // Container CLIs: only `run` with allowlisted flags before the image (no mounts, privileges,
    // host namespaces, other daemons). Arguments after the image belong to the server.
    if (typeof raw['command'] === 'string' && CONTAINER_CLIS.test(commandBase(raw['command']))) {
      const parsed = parseRunArgs(args);
      if (!parsed.ok) return { error: parsed.error ?? 'container arguments not allowed' };
    }
    spec.args = args;
  }
  if (raw['env'] !== undefined) {
    if (!isObj(raw['env'])) return { error: 'env must be an object' };
    const env                         = {};
    for (const [k, v] of Object.entries(raw['env'])) {
      if (!ENV_NAME.test(k) || typeof v !== 'string') return { error: `invalid env ${k}` };
      if (looksLikeLiteralSecret(k, v)) return { error: `env ${k} contains a literal secret; use passEnv` };
      if (!SAFE_VALUE.test(v)) return { error: `env ${k} has characters that are not allowed; use passEnv for values from the environment` };
      // These would point a container CLI at another daemon.
      if (/^(DOCKER_|CONTAINER_HOST$|CONTAINER_CONNECTION$|PODMAN_|NERDCTL_)/.test(k)) return { error: `env ${k} is not allowed` };
      env[k] = v;
    }
    spec.env = env;
  }
  if (raw['passEnv'] !== undefined) {
    if (!Array.isArray(raw['passEnv']) || raw['passEnv'].some((v) => typeof v !== 'string' || !/^[A-Z_][A-Z0-9_]*\??$/.test(v))) {
      return { error: 'passEnv must be env var names' };
    }
    spec.passEnv = raw['passEnv']            ;
  }
  if (!partial) {
    if (spec.transport === 'http' && !spec.url) return { error: 'http transport needs a url' };
    if (spec.transport === 'stdio' && !spec.command) return { error: 'stdio transport needs a command' };
    if (spec.transport === 'http' && (spec.command || spec.args)) return { error: 'http transport cannot have command/args' };
    if (spec.transport === 'stdio' && (spec.url || spec.headers || spec.bearerTokenEnv || spec.envHeaders)) {
      return { error: 'stdio transport cannot have url/headers' };
    }
  }
  return { spec: spec               };
}

function validateInstall(raw         , origin                       = 'custom')                                            {
  if (!isObj(raw)) return { error: 'must be an object' };
  const serverName = str(raw['serverName']);
  if (!serverName || !SERVER_NAME.test(serverName)) return { error: 'serverName must match [A-Za-z0-9_-]' };
  const params          = [];
  if (raw['params'] !== undefined) {
    if (!Array.isArray(raw['params'])) return { error: 'params must be an array' };
    for (const p of raw['params']) {
      if (!isObj(p) || typeof p['name'] !== 'string' || !PARAM_NAME.test(p['name'])) return { error: 'invalid param' };
      const param        = {
        name: p['name'],
        description: sanitizeLine(p['description'], 120),
        example: sanitizeLine(p['example'], 120),
      };
      // Regexes from registry files are only run for the built-in registry; custom entries use the fixed charset.
      if (typeof p['pattern'] === 'string' && origin === 'builtin') {
        const pattern = p['pattern'];
        // Patterns come from registry files; refuse nested quantifiers that could backtrack for minutes.
        if (pattern.length > 200 || /\([^)]*[+*}][^)]*\)\s*[+*{]/.test(pattern) || /\\[1-9]/.test(pattern)) {
          return { error: `param ${param.name}: pattern is too complex` };
        }
        try {
          new RegExp(pattern);
        } catch {
          return { error: `param ${param.name}: invalid pattern` };
        }
        param.pattern = pattern;
      }
      if (Array.isArray(p['values'])) {
        const values = (p['values']             ).filter((v)              => typeof v === 'string' && DEFAULT_PARAM.test(v)).slice(0, 100);
        if (values.length) param.values = values;
      }
      if (typeof p['default'] === 'string') {
        if (!paramValueOk(param, p['default'])) return { error: `param ${param.name}: default "${sanitizeLine(p['default'], 60)}" is not an allowed value` };
        param.default = p['default'];
      }
      params.push(param);
    }
  }
  const install              = { serverName, ...(params.length ? { params } : {}) };
  for (const key of ['readOnly', 'write']         ) {
    if (raw[key] === undefined) continue;
    const res = validateServerSpec(raw[key], params, false);
    if (res.error) return { error: `${key}: ${res.error}` };
    install[key] = res.spec              ;
  }
  if (!install.readOnly && !install.write) return { error: 'needs a readOnly or write server spec' };
  if (raw['requires'] !== undefined) {
    if (!Array.isArray(raw['requires']) || raw['requires'].some((r) => typeof r !== 'string' || !EXECUTABLE.test(r))) return { error: 'requires must be executable names' };
    install.requires = raw['requires']            ;
  }
  if (raw['overrides'] !== undefined) {
    if (!isObj(raw['overrides'])) return { error: 'overrides must be an object' };
    const overrides                                               = {};
    for (const [h, o] of Object.entries(raw['overrides'])) {
      if (!(HOST_IDS                     ).includes(h)) return { error: `unknown host ${h} in overrides` };
      const res = validateServerSpec(o, params, true);
      if (res.error) return { error: `overrides.${h}: ${res.error}` };
      overrides[h          ] = res.spec                       ;
    }
    install.overrides = overrides;
  }
  if (raw['notes'] !== undefined) install.notes = strArray(raw['notes'], 300);
  return { install };
}

const DEFAULT_PARAM = /^[A-Za-z0-9._:-]{1,100}$/;

export function paramValueOk(param       , value        )          {
  if (value.length > 200 || /[\s"'`$;&|<>\\%^!#?]/.test(value) || INVISIBLE.test(value)) return false;
  if (param.values) return param.values.includes(value);
  if (param.pattern) return new RegExp(param.pattern).test(value);
  // Without a pattern: a plain token, or an https URL (checked by isSafeUrl, not by a regex from a file).
  return DEFAULT_PARAM.test(value) || (/^https:\/\//.test(value) && isSafeUrl(value));
}

// ---------------- search ----------------

export function findEntry(registry          , id        )                            {
  const needle = id.trim().toLowerCase();
  return registry.entries.find((e) => e.id === needle) ?? registry.entries.find((e) => e.name.toLowerCase() === needle);
}






export function searchRegistry(registry          , query        , opts                                                = {})              {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9.#+-]+/)
    .filter((t) => t.length >= 2);
  const hits              = [];
  for (const e of registry.entries) {
    if (opts.kind && e.kind !== opts.kind) continue;
    if (!opts.includeLegacy && isLegacy(e)) continue;
    if (terms.length === 0) {
      hits.push({ entry: e, score: 1 });
      continue;
    }
    let score = 0;
    const fields                          = [
      [e.id, 5],
      [e.name.toLowerCase(), 4],
      [e.provides.join(' ').toLowerCase(), 3],
      [e.category.toLowerCase(), 2],
      [e.vendor.toLowerCase(), 2],
      [e.description.toLowerCase(), 1],
      [e.triggers.map((t) => t.signal).join(' '), 1],
    ];
    for (const t of terms) {
      let best = 0;
      for (const [text, w] of fields) if (text.includes(t)) best = Math.max(best, w);
      score += best;
    }
    if (score > 0) hits.push({ entry: e, score });
  }
  return hits.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
}

/** Closest ids for a mistyped one (edit distance, then substring). */
export function suggestIds(registry          , typo        , max = 3)           {
  const t = typo.toLowerCase();
  const scored = registry.entries.map((e) => {
    const d = Math.min(editDistance(t, e.id), editDistance(t, e.name.toLowerCase()));
    const sub = e.id.includes(t) || t.includes(e.id) ? 0 : 1;
    return { id: e.id, d: Math.min(d, sub === 0 ? 1 : d) };
  });
  return scored
    .filter((x) => x.d <= Math.max(2, Math.floor(t.length / 4)))
    .sort((a, b) => a.d - b.d || a.id.localeCompare(b.id))
    .slice(0, max)
    .map((x) => x.id);
}

export function editDistance(a        , b        )         {
  if (Math.abs(a.length - b.length) > 8) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]          ;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]          ;
      prev[j] = Math.min((prev[j]          ) + 1, (prev[j - 1]          ) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]          ;
}

/** No longer maintained: deprecated, archived or removed. */
export function isRetired(e               )          {
  return e.status === 'deprecated' || e.status === 'archived' || e.status === 'removed';
}

export function isLegacy(e               )          {
  return e.status === 'deprecated' || e.status === 'archived' || e.status === 'removed' || (e.triggers.length === 0 && Boolean(e.successor));
}
