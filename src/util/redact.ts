// Secret redaction. Used for every config value we print, log or return over MCP.

const SECRET_KEY =
  /(token|secret|passw(or)?d|pwd|api[-_]?key|apikey|auth|bearer|credential|private|session|cookie|dsn|connection[-_]?string|database[-_]?ur[il]|signature|(^|[^a-z])pat($|[^a-z]))/i;

/** A ${VAR} / ${VAR:-default} / $VAR reference, or an empty value: safe to show. */
const ENV_REFERENCE = /^(\$\{[A-Za-z_][A-Za-z0-9_]{0,100}(:-[^}]{0,200})?\}|\$[A-Za-z_][A-Za-z0-9_]{0,100}|%[A-Za-z_][A-Za-z0-9_]{0,100}%)?$/;

const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '***PRIVATE KEY***'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, '***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***'],
  [/\bglpat-[A-Za-z0-9_-]{16,}\b/g, '***'],
  [/\bsk-(ant-)?[A-Za-z0-9_-]{16,}\b/g, '***'],
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}\b/g, '***'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '***'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '***'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '***'],
  [/\bnpm_[A-Za-z0-9]{30,}\b/g, '***'],
  [/\bey[A-Za-z0-9_-]{8,2000}\.ey[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{8,4000}\b/g, '***JWT***'],
  // scheme://user:password@host -> scheme://user:***@host (bounded, so long junk stays linear)
  [/\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{0,200}):[^\s@/]{1,500}@/gi, '$1:***@'],
  // Authorization header values
  [/\b(Bearer|Basic|Token)\s+(?!\$\{)[A-Za-z0-9._~+/=-]{6,}/g, '$1 ***'],
  // key=value pairs in connection strings and query strings
  [
    /\b(password|pwd|passwd|secret|token|api[_-]?key|apikey|access[_-]?token|auth|sig|signature|client[_-]?secret)=([^;&\s"']+)/gi,
    '$1=***',
  ],
];

/** Redact known secret shapes anywhere inside a string. */
export function redactString(input: string): string {
  // Values come from untrusted files; cap the length so no pattern can take long.
  let s = input.length > 8000 ? input.slice(0, 8000) + '…' : input;
  for (const [re, repl] of PATTERNS) s = s.replace(re, repl);
  return s;
}

export function isSecretKey(key: string): boolean {
  return key.length <= 200 && SECRET_KEY.test(key);
}

export function isEnvReference(value: string): boolean {
  const v = value.trim();
  return v.length <= 320 && ENV_REFERENCE.test(v);
}

/** Redact a value given the key it is stored under. Env references stay visible. */
export function redactValue(key: string, value: string): string {
  if (isEnvReference(value)) return value;
  if (isSecretKey(key)) {
    // Keep a scheme-style prefix such as "Bearer ${X}" readable.
    const m = /^(Bearer|Basic|Token)\s+(.*)$/i.exec(value.slice(0, 4000));
    if (m && m[2] !== undefined && isEnvReference(m[2])) return value;
    return '***';
  }
  return redactString(value);
}

/** Does this key/value pair look like a literal secret written into a config file? */
export function looksLikeLiteralSecret(key: string, value: string): boolean {
  if (!value || isEnvReference(value)) return false;
  const m = /^(Bearer|Basic|Token)\s+(.*)$/i.exec(value.slice(0, 4000));
  if (m && m[2] !== undefined) return !isEnvReference(m[2]) && m[2].length >= 6;
  if (redactString(value) !== value) return true;
  if (isSecretKey(key)) {
    // Booleans, small numbers and obvious placeholders are not secrets.
    if (/^(true|false|yes|no|on|off|\d{1,6})$/i.test(value)) return false;
    if (/^<.*>$|^your[-_ ]|^xxx|^changeme$/i.test(value)) return false;
    return value.length >= 8;
  }
  return false;
}

/** Deep-redact any JSON-like structure, using keys as hints. */
export function redactDeep(value: unknown, keyHint = ''): unknown {
  if (typeof value === 'string') return redactValue(keyHint, value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, keyHint));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, k);
    return out;
  }
  return value;
}

/** Redact a command line given as argv. Flags like --api-key=X and "--token X" are covered. */
export function redactArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    const prev = i > 0 ? (args[i - 1] ?? '') : '';
    const eq = /^(--?[A-Za-z0-9-_]+)=(.*)$/.exec(a);
    if (eq && eq[1] !== undefined && eq[2] !== undefined) {
      out.push(`${eq[1]}=${redactValue(eq[1], eq[2])}`);
    } else if (/^--?[A-Za-z0-9-_]+$/.test(prev) && isSecretKey(prev) && !a.startsWith('-')) {
      out.push(redactValue(prev, a));
    } else {
      out.push(redactString(a));
    }
  }
  return out;
}
