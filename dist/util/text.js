// Text helpers. Anything that came from a registry, a config file or the network
// goes through sanitize() before it reaches a terminal or a model.

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]|\udb40[\udc00-\udc7f]/g;

/** Strip terminal escapes, control and bidi characters, collapse whitespace, cap length. */
export function sanitize(value         , max = 600)         {
  if (value === undefined || value === null) return '';
  let s = String(value).replace(ANSI, '').replace(/\r\n?/g, '\n').replace(CONTROL, '');
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + '…';
  return s;
}

/** Single-line variant for table cells and list items. */
export function sanitizeLine(value         , max = 200)         {
  return sanitize(value, max).replace(/\s*\n\s*/g, ' ');
}

/** Escape text for inclusion in Markdown so it cannot open links, HTML or code fences. */
export function mdEscape(value        )         {
  return value.replace(/[\\`*_[\]<>|#]/g, (c) => '\\' + c);
}










function wrapAnsi(code        , reset        )                        {
  return (s) => `\u001b[${code}m${s}\u001b[${reset}m`;
}

const plain = (s        )         => s;

export function colors(enabled         )         {
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

export function useColor(stream                    , env                    = process.env)          {
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return false;
  if (env['FORCE_COLOR'] !== undefined && env['FORCE_COLOR'] !== '0') return true;
  return Boolean(stream.isTTY);
}

export function plural(n        , one        , many = one + 's')         {
  return `${n} ${n === 1 ? one : many}`;
}

export function pad(s        , width        )         {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

export function indent(text        , prefix = '  ')         {
  return text
    .split('\n')
    .map((l) => (l ? prefix + l : l))
    .join('\n');
}
