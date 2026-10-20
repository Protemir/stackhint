import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AccessLevel,
  AuthType,
  Effort,
  EntryKind,
  EntryStatus,
  Frequency,
  HostId,
  HostInfo,
  InstallSpec,
  MatchRule,
  Param,
  Platform,
  Registry,
  RegistryEntry,
  ServerSpec,
  Support,
  Trigger,
} from '../types.ts';
import { HOST_IDS } from '../types.ts';
import { readJson } from '../util/fsx.ts';
import { looksLikeLiteralSecret } from '../util/redact.ts';
import { sanitize, sanitizeLine } from '../util/text.ts';

const KINDS: EntryKind[] = ['mcp', 'plugin', 'skill', 'cli'];
const STATUSES: EntryStatus[] = ['active', 'preview', 'deprecated', 'archived', 'removed', 'unknown'];
const LEVELS: AccessLevel[] = ['read', 'write', 'admin', 'exec'];
const AUTHS: AuthType[] = ['none', 'oauth', 'token', 'connection', 'cloud', 'local-app', 'unknown'];
const EFFORTS: Effort[] = ['low', 'medium', 'high'];
const FREQS: Frequency[] = ['daily', 'weekly', 'occasional'];
const SUPPORTS: Support[] = ['yes', 'no', 'unknown'];
const PLATFORMS: Platform[] = ['windows', 'macos', 'linux'];

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
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/;

/** Literal header and env values: plain words only, no quotes, no $ (no ${VAR} expansion tricks). */
const SAFE_VALUE = /^[A-Za-z0-9 ._:/=,+@*-]{0,200}$/;

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
function normalizeForScan(s: string): string {
  return s
    .normalize('NFKC')
    .replace(new RegExp(INVISIBLE.source, 'g'), '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Strip a Windows executable extension and lowercase, so "node.exe" is checked as "node". */
function commandBase(c: string): string {
  return c.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '');
}

export interface LoadOptions {
  /** Extra registry files (JSON with an entries array), e.g. from ~/.stackhint/registry.d. */
  extraFiles?: string[];
  /** Replace the built-in registry file (tests). */
  builtinFile?: string;
}

export function builtinRegistryPath(): string {
  // Works from src/registry/*.ts and dist/registry/*.js alike.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'registry', 'registry.json');
}

export function loadRegistry(opts: LoadOptions = {}): Registry {
  const warnings: string[] = [];
  const entries = new Map<string, RegistryEntry>();
  const file = opts.builtinFile ?? builtinRegistryPath();
  let version = 0;
  let updated = '';

  const ingest = (filePath: string, origin: 'builtin' | 'custom'): void => {
    const res = readJson<Record<string, unknown>>(filePath);
    if (!res.ok) {
      warnings.push(`registry ${path.basename(filePath)}: ${res.error}`);
      return;
    }
    const doc = res.value;
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc['entries'])) {
      warnings.push(`registry ${path.basename(filePath)}: expected an object with an "entries" array`);
      return;
    }
    const docUpdated = typeof doc['updated'] === 'string' && DATE.test(doc['updated']) ? (doc['updated'] as string) : '';
    if (origin === 'builtin') {
      version = typeof doc['version'] === 'number' ? (doc['version'] as number) : 0;
      updated = docUpdated;
    }
    for (const raw of doc['entries'] as unknown[]) {
      const { entry, errors } = validateEntry(raw, { origin, defaultVerifiedAt: docUpdated });
      const label = raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>)['id'] === 'string' ? (raw as Record<string, string>)['id'] : '?';
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
export function customRegistryFiles(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const files: string[] = [];
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

interface ValidateContext {
  origin: 'builtin' | 'custom';
  defaultVerifiedAt: string;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function strArray(v: unknown, max = 200): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string').map((x) => sanitize(x, max)).filter(Boolean);
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function isSafeUrl(url: string): boolean {
  if (url.length > 500 || /\s|["'`<>\\$]/.test(url) || INVISIBLE.test(url)) return false;
  if (/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[^\s]*)?$/.test(url)) return true;
  return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?(\/[^\s]*)?$/.test(url);
}

/** Every string anywhere in the entry, keys included. */
function textFieldsOf(raw: Obj): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 8 || out.length > 2000) return;
    if (typeof v === 'string') out.push(v.slice(0, 5000));
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) {
        out.push(k.slice(0, 200));
        walk(x, depth + 1);
      }
    }
  };
  walk(raw, 0);
  return out;
}

export function validateEntry(raw: unknown, ctx: ValidateContext = { origin: 'custom', defaultVerifiedAt: '' }): { entry?: RegistryEntry; errors: string[] } {
  const errors: string[] = [];
  const incomplete: string[] = [];
  if (!isObj(raw)) return { errors: ['not an object'] };

  const id = str(raw['id']);
  if (!id || !ID.test(id)) return { errors: ['missing or invalid id'] };
  const name = sanitizeLine(raw['name'], 120);
  if (!name) return { errors: ['missing name'] };
  const kind = str(raw['kind']);
  if (!kind || !(KINDS as string[]).includes(kind)) return { errors: [`invalid kind "${sanitizeLine(kind, 20)}"`] };
  const description = sanitize(raw['description'], 600);
  if (!description) return { errors: ['missing description'] };

  const suspicious = textFieldsOf(raw).find((t) => INSTRUCTION_LIKE.test(normalizeForScan(t)));
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

  const triggers: Trigger[] = [];
  if (Array.isArray(raw['triggers'])) {
    for (const t of raw['triggers']) {
      if (!isObj(t) || typeof t['signal'] !== 'string' || !SIGNAL.test(t['signal']) || typeof t['weight'] !== 'number') {
        errors.push('invalid trigger ignored');
        continue;
      }
      triggers.push({ signal: t['signal'], weight: Math.max(0, Math.min(1, t['weight'])) });
    }
  }
  const requiresAny = Array.isArray(raw['requiresAny']) ? (raw['requiresAny'] as unknown[]).filter((s): s is string => typeof s === 'string' && SIGNAL.test(s)) : undefined;

  const accessRaw = isObj(raw['access']) ? raw['access'] : {};
  if (!isObj(raw['access'])) incomplete.push('access');
  const authRaw = isObj(raw['auth']) ? raw['auth'] : {};
  if (!isObj(raw['auth'])) incomplete.push('auth');
  const setupRaw = isObj(raw['setup']) ? raw['setup'] : {};
  const valueRaw = isObj(raw['value']) ? raw['value'] : {};

  const hosts = {} as Record<HostId, HostInfo>;
  const hostsRaw = isObj(raw['hosts']) ? raw['hosts'] : {};
  for (const h of HOST_IDS) {
    const hr = isObj(hostsRaw[h]) ? (hostsRaw[h] as Obj) : {};
    const info: HostInfo = { support: oneOf(hr['support'], SUPPORTS, 'unknown') };
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

  let install: InstallSpec | undefined;
  if (raw['install'] !== undefined) {
    const res = validateInstall(raw['install']);
    if (res.error) return { errors: [`install: ${res.error}`] };
    install = res.install;
    if (kind !== 'mcp') return { errors: ['install specs are only valid for kind "mcp"'] };
  }

  const matchRaw = isObj(raw['match']) ? raw['match'] : {};
  const match: MatchRule = {};
  for (const key of ['urls', 'packages', 'names', 'plugins', 'executables', 'skills'] as const) {
    const values = strArray(matchRaw[key], 200).map((v) => v.trim()).filter((v) => v.length >= 2);
    if (key === 'executables' && values.some((v) => !EXECUTABLE.test(v))) return { errors: ['invalid executable name in match'] };
    if (values.length) match[key] = values;
  }

  const platforms = Array.isArray(raw['platforms']) ? (raw['platforms'] as unknown[]).filter((p): p is Platform => (PLATFORMS as unknown[]).includes(p)) : [...PLATFORMS];

  const timeSaved = valueRaw['timeSaved'];
  const entry: RegistryEntry = {
    id,
    name,
    kind: kind as EntryKind,
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
    ...(str(raw['successor']) && ID.test(str(raw['successor']) as string) ? { successor: str(raw['successor']) as string } : {}),
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

export function validateServerSpec(raw: unknown, params: Param[], partial: boolean): { spec?: ServerSpec; error?: string } {
  if (!isObj(raw)) return { error: 'server spec must be an object' };
  const transport = raw['transport'];
  if (!partial && transport !== 'http' && transport !== 'stdio') return { error: 'transport must be http or stdio' };
  const spec: Partial<ServerSpec> = {};
  if (transport === 'http' || transport === 'stdio') spec.transport = transport;
  const paramNames = new Set(params.map((p) => p.name));
  const checkPlaceholders = (s: string): string | undefined => {
    for (const m of s.matchAll(/\{([^}]*)\}/g)) if (!paramNames.has(m[1] as string)) return `unknown placeholder {${m[1]}}`;
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
    const headers: Record<string, string> = {};
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
    const eh: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw['envHeaders'])) {
      if (!HEADER_NAME.test(k) || typeof v !== 'string' || !ENV_NAME.test(v)) return { error: `invalid envHeaders entry ${k}` };
      eh[k] = v;
    }
    spec.envHeaders = eh;
  }
  if (raw['command'] !== undefined) {
    const c = str(raw['command']);
    if (!c || !EXECUTABLE.test(c)) return { error: 'command must be a bare executable name' };
    if (DENIED_COMMANDS.has(commandBase(c))) return { error: `command "${c}" is not allowed` };
    spec.command = c;
  }
  if (raw['args'] !== undefined) {
    if (!Array.isArray(raw['args']) || raw['args'].some((a) => typeof a !== 'string')) return { error: 'args must be strings' };
    const args = raw['args'] as string[];
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string;
      if (SHELL_META.test(a) || INVISIBLE.test(a) || a.length > 300) return { error: `argument contains shell metacharacters or hidden characters: ${sanitizeLine(a, 40)}` };
      const bad = checkPlaceholders(a);
      if (bad) return { error: bad };
      if (looksLikeLiteralSecret(args[i - 1] ?? '', a) || /^--?[a-z-]*(token|key|secret|password)[a-z-]*=.+/i.test(a)) {
        return { error: 'arguments must not carry secrets; use passEnv' };
      }
    }
    if (typeof raw['command'] === 'string' && /^(docker|podman|nerdctl)$/.test(commandBase(raw['command']))) {
      for (let i = 0; i < args.length; i++) {
        const a = (args[i] as string).toLowerCase();
        const next = (args[i + 1] ?? '').toLowerCase();
        // Privileges, host namespaces and any mount are refused outright, in every spelling.
        if (/^--(privileged|cap-add|security-opt|device|volumes-from|group-add)(=|$)/.test(a)) return { error: `docker flag ${a} is not allowed` };
        if (/^--(pid|net|network|ipc|uts|userns|cgroupns)(=|$)/.test(a) && (a.endsWith('=host') || next === 'host')) return { error: `docker flag ${a} host is not allowed` };
        if (/^(-v|--volume|--mount|--tmpfs)(=|$)/.test(a) || /^-v./.test(a)) return { error: 'docker mounts are not allowed in the registry' };
      }
    }
    spec.args = args;
  }
  if (raw['env'] !== undefined) {
    if (!isObj(raw['env'])) return { error: 'env must be an object' };
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw['env'])) {
      if (!ENV_NAME.test(k) || typeof v !== 'string') return { error: `invalid env ${k}` };
      if (looksLikeLiteralSecret(k, v)) return { error: `env ${k} contains a literal secret; use passEnv` };
      if (!SAFE_VALUE.test(v)) return { error: `env ${k} has characters that are not allowed; use passEnv for values from the environment` };
      env[k] = v;
    }
    spec.env = env;
  }
  if (raw['passEnv'] !== undefined) {
    if (!Array.isArray(raw['passEnv']) || raw['passEnv'].some((v) => typeof v !== 'string' || !/^[A-Z_][A-Z0-9_]*\??$/.test(v))) {
      return { error: 'passEnv must be env var names' };
    }
    spec.passEnv = raw['passEnv'] as string[];
  }
  if (!partial) {
    if (spec.transport === 'http' && !spec.url) return { error: 'http transport needs a url' };
    if (spec.transport === 'stdio' && !spec.command) return { error: 'stdio transport needs a command' };
    if (spec.transport === 'http' && (spec.command || spec.args)) return { error: 'http transport cannot have command/args' };
    if (spec.transport === 'stdio' && (spec.url || spec.headers || spec.bearerTokenEnv || spec.envHeaders)) {
      return { error: 'stdio transport cannot have url/headers' };
    }
  }
  return { spec: spec as ServerSpec };
}

function validateInstall(raw: unknown): { install?: InstallSpec; error?: string } {
  if (!isObj(raw)) return { error: 'must be an object' };
  const serverName = str(raw['serverName']);
  if (!serverName || !SERVER_NAME.test(serverName)) return { error: 'serverName must match [A-Za-z0-9_-]' };
  const params: Param[] = [];
  if (raw['params'] !== undefined) {
    if (!Array.isArray(raw['params'])) return { error: 'params must be an array' };
    for (const p of raw['params']) {
      if (!isObj(p) || typeof p['name'] !== 'string' || !PARAM_NAME.test(p['name'])) return { error: 'invalid param' };
      const param: Param = {
        name: p['name'],
        description: sanitizeLine(p['description'], 120),
        example: sanitizeLine(p['example'], 120),
      };
      if (typeof p['pattern'] === 'string') {
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
      if (typeof p['default'] === 'string') {
        if (!paramValueOk(param, p['default'])) return { error: `param ${param.name}: default does not match its pattern` };
        param.default = p['default'];
      }
      params.push(param);
    }
  }
  const install: InstallSpec = { serverName, ...(params.length ? { params } : {}) };
  for (const key of ['readOnly', 'write'] as const) {
    if (raw[key] === undefined) continue;
    const res = validateServerSpec(raw[key], params, false);
    if (res.error) return { error: `${key}: ${res.error}` };
    install[key] = res.spec as ServerSpec;
  }
  if (!install.readOnly && !install.write) return { error: 'needs a readOnly or write server spec' };
  if (raw['requires'] !== undefined) {
    if (!Array.isArray(raw['requires']) || raw['requires'].some((r) => typeof r !== 'string' || !EXECUTABLE.test(r))) return { error: 'requires must be executable names' };
    install.requires = raw['requires'] as string[];
  }
  if (raw['overrides'] !== undefined) {
    if (!isObj(raw['overrides'])) return { error: 'overrides must be an object' };
    const overrides: Partial<Record<HostId, Partial<ServerSpec>>> = {};
    for (const [h, o] of Object.entries(raw['overrides'])) {
      if (!(HOST_IDS as readonly string[]).includes(h)) return { error: `unknown host ${h} in overrides` };
      const res = validateServerSpec(o, params, true);
      if (res.error) return { error: `overrides.${h}: ${res.error}` };
      overrides[h as HostId] = res.spec as Partial<ServerSpec>;
    }
    install.overrides = overrides;
  }
  if (raw['notes'] !== undefined) install.notes = strArray(raw['notes'], 300);
  return { install };
}

const DEFAULT_PARAM = /^[A-Za-z0-9._:-]{1,100}$/;

export function paramValueOk(param: Param, value: string): boolean {
  if (value.length > 200 || /[\s"'`$;&|<>\\%^!#?]/.test(value) || INVISIBLE.test(value)) return false;
  const re = param.pattern ? new RegExp(param.pattern) : DEFAULT_PARAM;
  return re.test(value);
}

// ---------------- search ----------------

export function findEntry(registry: Registry, id: string): RegistryEntry | undefined {
  const needle = id.trim().toLowerCase();
  return registry.entries.find((e) => e.id === needle) ?? registry.entries.find((e) => e.name.toLowerCase() === needle);
}

export interface SearchHit {
  entry: RegistryEntry;
  score: number;
}

export function searchRegistry(registry: Registry, query: string, opts: { kind?: EntryKind; includeLegacy?: boolean } = {}): SearchHit[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9.#+-]+/)
    .filter((t) => t.length >= 2);
  const hits: SearchHit[] = [];
  for (const e of registry.entries) {
    if (opts.kind && e.kind !== opts.kind) continue;
    if (!opts.includeLegacy && isLegacy(e)) continue;
    if (terms.length === 0) {
      hits.push({ entry: e, score: 1 });
      continue;
    }
    let score = 0;
    const fields: Array<[string, number]> = [
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
export function suggestIds(registry: Registry, typo: string, max = 3): string[] {
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

export function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 8) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] as number;
      prev[j] = Math.min((prev[j] as number) + 1, (prev[j - 1] as number) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length] as number;
}

/** No longer maintained: deprecated, archived or removed. */
export function isRetired(e: RegistryEntry): boolean {
  return e.status === 'deprecated' || e.status === 'archived' || e.status === 'removed';
}

export function isLegacy(e: RegistryEntry): boolean {
  return e.status === 'deprecated' || e.status === 'archived' || e.status === 'removed' || (e.triggers.length === 0 && Boolean(e.successor));
}
