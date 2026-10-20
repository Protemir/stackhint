// Text helpers. Anything that came from a registry, a config file or the network
// goes through sanitize() before it reaches a terminal or a model.

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]|\udb40[\udc00-\udc7f]/g;

/** Strip terminal escapes, control and bidi characters, collapse whitespace, cap length. */
export function sanitize(value: unknown, max = 600): string {
  if (value === undefined || value === null) return '';
  let s = String(value).replace(ANSI, '').replace(/\r\n?/g, '\n').replace(CONTROL, '');
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + '…';
  return s;
}

/** Single-line variant for table cells and list items. */
export function sanitizeLine(value: unknown, max = 200): string {
  return sanitize(value, max).replace(/\s*\n\s*/g, ' ');
}

/** Escape text for inclusion in Markdown so it cannot open links, HTML or code fences. */
export function mdEscape(value: string): string {
  return value.replace(/[\\`*_[\]<>|#]/g, (c) => '\\' + c);
}

export interface Colors {
  bold(s: string): string;
  dim(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  red(s: string): string;
  cyan(s: string): string;
}

function wrapAnsi(code: number, reset: number): (s: string) => string {
  return (s) => `\u001b[${code}m${s}\u001b[${reset}m`;
}

const plain = (s: string): string => s;

export function colors(enabled: boolean): Colors {
  if (!enabled) return { bold: plain, dim: plain, green: plain, yellow: plain, red: plain, cyan: plain };
  return {
    bold: wrapAnsi(1, 22),
    dim: wrapAnsi(2, 22),
    green: wrapAnsi(32, 39),
    yellow: wrapAnsi(33, 39),
    red: wrapAnsi(31, 39),
    cyan: wrapAnsi(36, 39),
  };
}

export function useColor(stream: NodeJS.WriteStream, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return false;
  if (env['FORCE_COLOR'] !== undefined && env['FORCE_COLOR'] !== '0') return true;
  return Boolean(stream.isTTY);
}

/**
 * A path or word as a shell argument that works the same in PowerShell, cmd.exe and bash:
 * plain when safe, otherwise in double quotes (backslashes stay literal in all three).
 */
export function shellArg(value: string): string {
  if (/^[\w./:@=+-]+$/.test(value)) return value;
  return /["$`]/.test(value) ? JSON.stringify(value) : `"${value}"`;
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

export function indent(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map((l) => (l ? prefix + l : l))
    .join('\n');
}
