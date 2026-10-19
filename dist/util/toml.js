// A small TOML 1.0 reader and a writer for the narrow shapes stackhint appends to
// Codex's config.toml. The reader is strict about the things that matter for safe
// merging (duplicate keys, table redefinition, extending inline tables) and returns
// dates/times as strings.

export class TomlError extends Error {
           line        ;
  constructor(message        , line        ) {
    super(`${message} (line ${line})`);
    this.name = 'TomlError';
    this.line = line;
  }
}



// Tables we created via [header] or dotted keys, and those that are frozen (inline / values).
const DEFINED = Symbol('defined');
const IMPLICIT = Symbol('implicit');
const FROZEN = Symbol('frozen');
const ARRAY_OF_TABLES = Symbol('aot');
const HEADER = Symbol('header');








function newTable()            {
  return Object.create(null)             ;
}

function isTable(v         )                 {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function meta(t           )       {
  return t                   ;
}

class Parser {
                   src        ;
          pos = 0;
          line = 1;
                   root            = newTable();
          current           ;

  constructor(src        ) {
    this.src = src.replace(/^﻿/, '');
    this.current = this.root;
  }

  parse()            {
    while (this.pos < this.src.length) {
      this.skipWsCommentsNewlines();
      if (this.pos >= this.src.length) break;
      const c = this.src[this.pos];
      if (c === '[') {
        if (this.src[this.pos + 1] === '[') this.parseArrayTableHeader();
        else this.parseTableHeader();
      } else {
        this.parseKeyValue(this.current);
      }
      this.expectLineEnd();
    }
    return toPlain(this.root)             ;
  }

          err(msg        )        {
    throw new TomlError(msg, this.line);
  }

          peek(offset = 0)         {
    return this.src[this.pos + offset] ?? '';
  }

          skipWs()       {
    while (this.peek() === ' ' || this.peek() === '\t') this.pos++;
  }

          skipComment()       {
    if (this.peek() === '#') {
      while (this.pos < this.src.length && this.peek() !== '\n') {
        const ch = this.peek();
        const code = ch.charCodeAt(0);
        if ((code < 0x20 && ch !== '\t' && ch !== '\r') || code === 0x7f) this.err('control character in comment');
        this.pos++;
      }
    }
  }

          skipNewline()          {
    if (this.peek() === '\n') {
      this.pos++;
      this.line++;
      return true;
    }
    if (this.peek() === '\r' && this.peek(1) === '\n') {
      this.pos += 2;
      this.line++;
      return true;
    }
    return false;
  }

          skipWsCommentsNewlines()       {
    for (;;) {
      this.skipWs();
      this.skipComment();
      if (!this.skipNewline()) break;
    }
  }

          expectLineEnd()       {
    this.skipWs();
    this.skipComment();
    if (this.pos >= this.src.length) return;
    if (!this.skipNewline()) this.err(`unexpected character '${this.peek()}'`);
  }

  // ----- keys -----

          parseKey()           {
    const parts           = [];
    for (;;) {
      this.skipWs();
      parts.push(this.parseSimpleKey());
      this.skipWs();
      if (this.peek() === '.') {
        this.pos++;
        continue;
      }
      return parts;
    }
  }

          parseSimpleKey()         {
    const c = this.peek();
    if (c === '"') return this.parseBasicString();
    if (c === "'") return this.parseLiteralString();
    const start = this.pos;
    while (/[A-Za-z0-9_-]/.test(this.peek())) this.pos++;
    if (start === this.pos) this.err('expected a key');
    return this.src.slice(start, this.pos);
  }

  // ----- headers -----

          parseTableHeader()       {
    this.pos++; // [
    const key = this.parseKey();
    if (this.peek() !== ']') this.err("expected ']'");
    this.pos++;
    let t = this.root;
    key.forEach((k, i) => {
      const last = i === key.length - 1;
      let next = t[k];
      if (next === undefined) {
        next = newTable();
        if (!last) meta(next             )[IMPLICIT] = true;
        t[k] = next;
      } else if (Array.isArray(next) && (next                                              )[ARRAY_OF_TABLES]) {
        if (last) this.err(`cannot redefine array of tables '${key.join('.')}' as a table`);
        next = next[next.length - 1];
      } else if (!isTable(next)) {
        this.err(`key '${k}' is already a value`);
      }
      const nt = next             ;
      if (meta(nt)[FROZEN]) this.err(`cannot extend inline table '${key.slice(0, i + 1).join('.')}'`);
      if (last) {
        if (meta(nt)[DEFINED]) this.err(`table '${key.join('.')}' defined twice`);
        meta(nt)[DEFINED] = true;
        meta(nt)[HEADER] = true;
        meta(nt)[IMPLICIT] = false;
      }
      t = nt;
    });
    this.current = t;
  }

          parseArrayTableHeader()       {
    this.pos += 2; // [[
    const key = this.parseKey();
    if (this.peek() !== ']' || this.peek(1) !== ']') this.err("expected ']]'");
    this.pos += 2;
    let t = this.root;
    key.forEach((k, i) => {
      const last = i === key.length - 1;
      let next = t[k];
      if (last) {
        if (next === undefined) {
          const arr            = [];
          (arr                                             )[ARRAY_OF_TABLES] = true;
          t[k] = arr;
          next = arr;
        } else if (!Array.isArray(next) || !(next                                              )[ARRAY_OF_TABLES]) {
          this.err(`'${key.join('.')}' is not an array of tables`);
        }
        const tbl = newTable();
        meta(tbl)[DEFINED] = true;
        meta(tbl)[HEADER] = true;
        (next             ).push(tbl);
        t = tbl;
        return;
      }
      if (next === undefined) {
        next = newTable();
        meta(next             )[IMPLICIT] = true;
        t[k] = next;
      } else if (Array.isArray(next) && (next                                              )[ARRAY_OF_TABLES]) {
        next = next[next.length - 1];
      } else if (!isTable(next)) {
        this.err(`key '${k}' is already a value`);
      }
      if (meta(next             )[FROZEN]) this.err(`cannot extend inline table '${k}'`);
      t = next             ;
    });
    this.current = t;
  }

  // ----- key/value -----

          parseKeyValue(target           , inline = false)       {
    const key = this.parseKey();
    this.skipWs();
    if (this.peek() !== '=') this.err("expected '=' after key");
    this.pos++;
    this.skipWs();
    const value = this.parseValue();
    let t = target;
    for (let i = 0; i < key.length - 1; i++) {
      const k = key[i]          ;
      let next = t[k];
      if (next === undefined) {
        next = newTable();
        // Dotted keys define the intermediate tables; a later [header] for them is an error.
        meta(next             )[DEFINED] = true;
        t[k] = next;
      } else if (!isTable(next)) {
        this.err(`key '${k}' is already a value`);
      } else if (meta(next)[FROZEN]) {
        this.err(`cannot extend inline table '${k}'`);
      } else if (!inline && meta(next)[HEADER]) {
        this.err(`cannot add dotted key into table '${k}' defined by a header`);
      }
      t = next             ;
    }
    const last = key[key.length - 1]          ;
    if (Object.prototype.hasOwnProperty.call(t, last)) this.err(`duplicate key '${key.join('.')}'`);
    t[last] = value;
  }

          parseValue()          {
    const c = this.peek();
    if (c === '"') {
      if (this.src.startsWith('"""', this.pos)) return this.parseMultilineBasicString();
      return this.parseBasicString();
    }
    if (c === "'") {
      if (this.src.startsWith("'''", this.pos)) return this.parseMultilineLiteralString();
      return this.parseLiteralString();
    }
    if (c === '[') return this.parseArray();
    if (c === '{') return this.parseInlineTable();
    if (this.src.startsWith('true', this.pos) && !/[A-Za-z0-9_-]/.test(this.peek(4))) {
      this.pos += 4;
      return true;
    }
    if (this.src.startsWith('false', this.pos) && !/[A-Za-z0-9_-]/.test(this.peek(5))) {
      this.pos += 5;
      return false;
    }
    return this.parseNumberOrDate();
  }

          parseBasicString()         {
    this.pos++; // "
    let out = '';
    for (;;) {
      const c = this.peek();
      if (c === '') this.err('unterminated string');
      if (c === '\n' || c === '\r') this.err('newline in basic string');
      if (c === '"') {
        this.pos++;
        return out;
      }
      if (c === '\\') {
        out += this.parseEscape();
        continue;
      }
      const code = c.charCodeAt(0);
      if ((code < 0x20 && c !== '\t') || code === 0x7f) this.err('control character in string');
      out += c;
      this.pos++;
    }
  }

          parseEscape()         {
    this.pos++; // backslash
    const c = this.peek();
    this.pos++;
    switch (c) {
      case 'b':
        return '\b';
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'f':
        return '\f';
      case 'r':
        return '\r';
      case 'e':
        return '\u001b';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case 'u':
      case 'U': {
        const len = c === 'u' ? 4 : 8;
        const hex = this.src.slice(this.pos, this.pos + len);
        if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) this.err('invalid unicode escape');
        this.pos += len;
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) this.err('invalid unicode scalar');
        return String.fromCodePoint(cp);
      }
      default:
        return this.err(`invalid escape '\\${c}'`);
    }
  }

          parseMultilineBasicString()         {
    this.pos += 3;
    this.skipNewline();
    let out = '';
    for (;;) {
      if (this.pos >= this.src.length) this.err('unterminated multi-line string');
      if (this.src.startsWith('"""', this.pos)) {
        // Up to two extra quotes may belong to the content.
        let extra = 0;
        while (this.peek(3 + extra) === '"' && extra < 2) extra++;
        out += '"'.repeat(extra);
        this.pos += 3 + extra;
        return out;
      }
      const c = this.peek();
      if (c === '\\') {
        // Line-ending backslash trims following whitespace and newlines.
        let j = this.pos + 1;
        while (this.src[j] === ' ' || this.src[j] === '\t') j++;
        if (this.src[j] === '\n' || (this.src[j] === '\r' && this.src[j + 1] === '\n')) {
          this.pos = j;
          while (this.peek() === ' ' || this.peek() === '\t' || this.peek() === '\n' || this.peek() === '\r') {
            if (this.peek() === '\n') this.line++;
            this.pos++;
          }
          continue;
        }
        out += this.parseEscape();
        continue;
      }
      if (c === '\n') this.line++;
      const code = c.charCodeAt(0);
      if ((code < 0x20 && c !== '\t' && c !== '\n' && c !== '\r') || code === 0x7f) this.err('control character in string');
      out += c;
      this.pos++;
    }
  }

          parseLiteralString()         {
    this.pos++;
    const start = this.pos;
    for (;;) {
      const c = this.peek();
      if (c === '') this.err('unterminated literal string');
      if (c === '\n' || c === '\r') this.err('newline in literal string');
      if (c === "'") break;
      const code = c.charCodeAt(0);
      if ((code < 0x20 && c !== '\t') || code === 0x7f) this.err('control character in string');
      this.pos++;
    }
    const s = this.src.slice(start, this.pos);
    this.pos++;
    return s;
  }

          parseMultilineLiteralString()         {
    this.pos += 3;
    this.skipNewline();
    const start = this.pos;
    for (;;) {
      if (this.pos >= this.src.length) this.err('unterminated multi-line literal string');
      if (this.src.startsWith("'''", this.pos)) {
        let extra = 0;
        while (this.peek(3 + extra) === "'" && extra < 2) extra++;
        const s = this.src.slice(start, this.pos + extra);
        this.pos += 3 + extra;
        return s;
      }
      if (this.peek() === '\n') this.line++;
      this.pos++;
    }
  }

          parseArray()            {
    this.pos++; // [
    const out            = [];
    for (;;) {
      this.skipWsCommentsNewlines();
      if (this.peek() === ']') {
        this.pos++;
        return out;
      }
      out.push(this.parseValue());
      this.skipWsCommentsNewlines();
      if (this.peek() === ',') {
        this.pos++;
        continue;
      }
      if (this.peek() === ']') {
        this.pos++;
        return out;
      }
      this.err("expected ',' or ']' in array");
    }
  }

          parseInlineTable()            {
    this.pos++; // {
    const t = newTable();
    this.skipWsCommentsNewlines();
    if (this.peek() === '}') {
      this.pos++;
      meta(t)[FROZEN] = true;
      return t;
    }
    for (;;) {
      this.skipWsCommentsNewlines();
      this.parseKeyValue(t, true);
      this.skipWsCommentsNewlines();
      if (this.peek() === ',') {
        this.pos++;
        this.skipWsCommentsNewlines();
        if (this.peek() === '}') {
          // Trailing comma (TOML 1.1). Accepted for leniency.
          this.pos++;
          break;
        }
        continue;
      }
      if (this.peek() === '}') {
        this.pos++;
        break;
      }
      this.err("expected ',' or '}' in inline table");
    }
    freeze(t);
    return t;
  }

          parseNumberOrDate()          {
    const start = this.pos;
    while (this.pos < this.src.length && /[0-9A-Za-z_+\-.:]/.test(this.peek())) this.pos++;
    // Dates may contain a single space between date and time.
    if (/^\d{4}-\d{2}-\d{2}$/.test(this.src.slice(start, this.pos)) && this.peek() === ' ' && /\d/.test(this.peek(1))) {
      this.pos++;
      while (this.pos < this.src.length && /[0-9A-Za-z_+\-.:]/.test(this.peek())) this.pos++;
    }
    const raw = this.src.slice(start, this.pos);
    if (raw === '') this.err('expected a value');
    if (/^[+-]?(inf|nan)$/.test(raw)) return raw.includes('nan') ? NaN : raw.startsWith('-') ? -Infinity : Infinity;
    if (/^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?([Zz]|[+-]\d{2}:\d{2})?$/.test(raw) || /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(raw)) {
      return raw;
    }
    if (/^0x[0-9A-Fa-f](_?[0-9A-Fa-f])*$/.test(raw)) return parseInt(raw.slice(2).replace(/_/g, ''), 16);
    if (/^0o[0-7](_?[0-7])*$/.test(raw)) return parseInt(raw.slice(2).replace(/_/g, ''), 8);
    if (/^0b[01](_?[01])*$/.test(raw)) return parseInt(raw.slice(2).replace(/_/g, ''), 2);
    if (/^[+-]?(0|[1-9](_?\d)*)$/.test(raw)) return Number(raw.replace(/_/g, ''));
    if (/^[+-]?(0|[1-9](_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/.test(raw)) return Number(raw.replace(/_/g, ''));
    return this.err(`invalid value '${raw}'`);
  }
}

function freeze(t           )       {
  meta(t)[FROZEN] = true;
  for (const v of Object.values(t)) {
    if (isTable(v)) freeze(v);
    else if (Array.isArray(v)) v.forEach((x) => isTable(x) && freeze(x));
  }
}

/** Convert parser tables (null-prototype, with symbol markers) into plain objects. */
function toPlain(v         )          {
  if (Array.isArray(v)) return v.map(toPlain);
  if (isTable(v)) {
    const out                          = {};
    for (const [k, x] of Object.entries(v)) out[k] = toPlain(x);
    return out;
  }
  return v;
}

export function parseToml(src        )                          {
  return new Parser(src).parse();
}

// ----- writer -----

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

export function tomlKey(k        )         {
  return BARE_KEY.test(k) ? k : tomlString(k);
}

export function tomlString(s        )         {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}




export function tomlValue(v              )         {
  if (typeof v === 'string') return tomlString(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('cannot write non-finite number');
    return String(v);
  }
  if (Array.isArray(v)) return '[' + v.map((x) => tomlValue(x)).join(', ') + ']';
  const entries = Object.entries(v);
  if (entries.length === 0) return '{}';
  return '{ ' + entries.map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`).join(', ') + ' }';
}

/** Render a [a.b] table with simple values. Keys keep insertion order. */
export function tomlTable(path          , values                                          )         {
  const lines = [`[${path.map(tomlKey).join('.')}]`];
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    lines.push(`${tomlKey(k)} = ${tomlValue(v)}`);
  }
  return lines.join('\n');
}
