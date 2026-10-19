import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseToml, TomlError, tomlString, tomlTable, tomlValue } from '../src/util/toml.ts';

describe('TOML reader', () => {
  it('reads a realistic Codex config', () => {
    const doc = parseToml(`# Codex config
model = "gpt-5.5"
approval_policy = "on-request"

[projects."E:\\\\PS\\\\demo"]
trust_level = "trusted"

[mcp_servers.github]
url = "https://api.githubcopilot.com/mcp/"
bearer_token_env_var = "GITHUB_PAT"
http_headers = { "X-MCP-Readonly" = "true" }

[mcp_servers.context7]
command = "npx"
args = [
  "-y",          # comment inside array
  "@upstash/context7-mcp",
]
env = { A = "1", B = 'literal\\no-escape' }
startup_timeout_sec = 20
enabled = false

[plugins."figma@openai-curated"]
enabled = true

[[skills.config]]
path = "/x/SKILL.md"
enabled = false
[[skills.config]]
path = "/y/SKILL.md"
`) as Record<string, any>;
    assert.equal(doc.model, 'gpt-5.5');
    assert.equal(doc.projects['E:\\PS\\demo'].trust_level, 'trusted');
    assert.equal(doc.mcp_servers.github.http_headers['X-MCP-Readonly'], 'true');
    assert.deepEqual(doc.mcp_servers.context7.args, ['-y', '@upstash/context7-mcp']);
    assert.equal(doc.mcp_servers.context7.env.B, 'literal\\no-escape');
    assert.equal(doc.mcp_servers.context7.startup_timeout_sec, 20);
    assert.equal(doc.mcp_servers.context7.enabled, false);
    assert.equal(doc.plugins['figma@openai-curated'].enabled, true);
    assert.equal(doc.skills.config.length, 2);
  });

  it('handles strings, escapes and multi-line strings', () => {
    const doc = parseToml(`a = "tab\\tnew\\nquote\\" uni\\u00e9 \\U0001F600"
b = 'C:\\Users\\x'
c = """
line1
line2 \\
   continued"""
d = '''
raw \\n text'''
e = """"quoted" inside"""
`) as Record<string, string>;
    assert.equal(doc.a, 'tab\tnew\nquote" unié 😀');
    assert.equal(doc.b, 'C:\\Users\\x');
    assert.equal(doc.c, 'line1\nline2 continued');
    assert.equal(doc.d, 'raw \\n text');
    assert.equal(doc.e, '"quoted" inside');
  });

  it('handles numbers, booleans and dates', () => {
    const doc = parseToml(`i = 1_000
h = 0xff
o = 0o17
b = 0b101
f = 3.14
x = -2e3
inf1 = inf
d = 1979-05-27T07:32:00Z
ld = 1979-05-27
t = true`) as Record<string, unknown>;
    assert.equal(doc.i, 1000);
    assert.equal(doc.h, 255);
    assert.equal(doc.o, 15);
    assert.equal(doc.b, 5);
    assert.equal(doc.f, 3.14);
    assert.equal(doc.x, -2000);
    assert.equal(doc.inf1, Infinity);
    assert.equal(doc.d, '1979-05-27T07:32:00Z');
    assert.equal(doc.ld, '1979-05-27');
    assert.equal(doc.t, true);
  });

  it('supports dotted keys and sub-tables per the spec', () => {
    const doc = parseToml(`[fruit]
apple.color = "red"
apple.taste.sweet = true
[fruit.apple.texture]
smooth = true`) as Record<string, any>;
    assert.equal(doc.fruit.apple.color, 'red');
    assert.equal(doc.fruit.apple.texture.smooth, true);
  });

  it('accepts CRLF line endings and a BOM', () => {
    const doc = parseToml('\uFEFFa = 1\r\n[t]\r\nb = "x"\r\n') as Record<string, any>;
    assert.equal(doc.a, 1);
    assert.equal(doc.t.b, 'x');
  });

  const invalid: Array<[string, string]> = [
    ['duplicate key', 'a = 1\na = 2'],
    ['table defined twice', '[a]\nx = 1\n[a]\ny = 2'],
    ['table over dotted key', '[fruit]\napple.color = "red"\n[fruit.apple]\nx = 1'],
    ['extending an inline table', 'a = { b = 1 }\n[a.c]\nd = 2'],
    ['dotted key into inline table', 'a = { b = 1 }\na.c = 2'],
    ['unterminated string', 'a = "oops'],
    ['newline in basic string', 'a = "line\nnext"'],
    ['invalid escape', 'a = "\\q"'],
    ['missing value', 'a = '],
    ['bare word value', 'a = hello'],
    ['garbage after value', 'a = 1 2'],
    ['unclosed array', 'a = [1, 2'],
    ['unclosed table header', '[a\nb = 1'],
    ['dotted key into header table', '[a.b]\nx = 1\n[a]\nb.y = 2'],
    ['array of tables over table', '[a]\n[[a]]'],
    ['control character', 'a = "x\u0001"'],
  ];
  for (const [name, src] of invalid) {
    it(`rejects ${name}`, () => {
      assert.throws(() => parseToml(src), TomlError);
    });
  }

  it('never throws anything but TomlError on mutated input (fuzz)', () => {
    const base = `[mcp_servers.a]\ncommand = "npx"\nargs = ["-y", "x"]\nenv = { K = "v" }\n[mcp_servers.b]\nurl = "https://x/mcp"\n`;
    const alphabet = ['[', ']', '"', "'", '=', '\n', '{', '}', ',', '.', '#', '\\', ' ', 'a', '1', '\r', '\t', '"""', "'''"];
    let seed = 12345;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 2000; i++) {
      let s = base;
      const edits = 1 + rand(4);
      for (let k = 0; k < edits; k++) {
        const pos = rand(s.length + 1);
        const op = rand(3);
        const piece = alphabet[rand(alphabet.length)] as string;
        if (op === 0) s = s.slice(0, pos) + piece + s.slice(pos);
        else if (op === 1) s = s.slice(0, pos) + s.slice(pos + 1);
        else s = s.slice(0, pos) + piece + s.slice(pos + 1);
      }
      try {
        parseToml(s);
      } catch (e) {
        assert.ok(e instanceof TomlError, `unexpected ${String(e)} for input ${JSON.stringify(s)}`);
      }
    }
  });
});

describe('TOML writer', () => {
  it('escapes strings so they read back exactly', () => {
    const tricky = ['plain', 'with "quotes"', 'back\\slash', 'new\nline', 'tab\t', 'ctrl\u0001', 'C:\\Program Files\\nodejs\\node.exe', 'ünï 😀'];
    for (const s of tricky) {
      const doc = parseToml(`k = ${tomlString(s)}`) as Record<string, string>;
      assert.equal(doc.k, s);
    }
  });

  it('writes tables that round-trip', () => {
    const values = {
      command: 'cmd',
      args: ['/c', 'npx', '-y', '@scope/pkg@1.2.3'],
      env: { 'READ_ONLY': 'true', 'weird key': 'v"' },
      env_vars: ['DATABASE_URI'],
      startup_timeout_sec: 60,
      enabled: true,
    };
    const text = tomlTable(['mcp_servers', 'my-server'], values);
    const doc = parseToml(text) as Record<string, any>;
    assert.deepEqual(doc.mcp_servers['my-server'], values);
    assert.match(tomlTable(['mcp_servers', 'has.dot'], { url: 'https://x' }), /^\[mcp_servers\."has\.dot"\]/);
  });

  it('refuses non-finite numbers', () => {
    assert.throws(() => tomlValue(Infinity));
  });
});
