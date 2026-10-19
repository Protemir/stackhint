import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isEnvReference, looksLikeLiteralSecret, redactArgs, redactDeep, redactString, redactValue } from '../src/util/redact.ts';
import { mdEscape, sanitize, sanitizeLine } from '../src/util/text.ts';

describe('redaction', () => {
  const secrets = [
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
    'glpat-abcdefghijklmnopqrst',
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
    'sk_live_51Habcdefghijklmnop',
    'xoxb-1234567890-abcdefghij',
    'AKIAIOSFODNN7EXAMPLE',
    'AIzaSyA1234567890abcdefghijklmnopqrstuv',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'npm_abcdefghijklmnopqrstuvwxyz0123456789',
  ];
  for (const s of secrets) {
    it(`removes ${s.slice(0, 8)}…`, () => {
      const out = redactString(`token is ${s} ok`);
      assert.ok(!out.includes(s), out);
    });
  }

  it('redacts passwords in URLs and connection strings', () => {
    assert.equal(redactString('postgres://shop:hunter2@db:5432/shop'), 'postgres://shop:***@db:5432/shop');
    assert.equal(redactString('Host=db;Username=u;Password=hunter2;Database=x'), 'Host=db;Username=u;Password=***;Database=x');
    assert.equal(redactString('https://x/api?token=abc123&q=1'), 'https://x/api?token=***&q=1');
    assert.equal(redactString('Authorization: Bearer abcdef123456'), 'Authorization: Bearer ***');
    assert.match(redactString('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'), /\*\*\*PRIVATE KEY\*\*\*/);
  });

  it('keeps env references visible', () => {
    for (const v of ['${GITHUB_PAT}', '${X:-}', '${X:-default}', '$TOKEN', '%TOKEN%', '']) assert.ok(isEnvReference(v), v);
    assert.equal(redactValue('Authorization', 'Bearer ${GITHUB_PAT}'), 'Bearer ${GITHUB_PAT}');
    assert.equal(redactValue('API_KEY', '${API_KEY}'), '${API_KEY}');
    assert.equal(redactValue('API_KEY', 'plain-value-123'), '***');
    assert.equal(redactValue('MODE', 'read-only'), 'read-only');
  });

  it('detects literal secrets but not flags, numbers or placeholders', () => {
    assert.ok(looksLikeLiteralSecret('GITHUB_TOKEN', 'abcdefgh12345678'));
    assert.ok(looksLikeLiteralSecret('Authorization', 'Bearer abcdefgh1234'));
    assert.ok(looksLikeLiteralSecret('', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
    assert.ok(!looksLikeLiteralSecret('READ_ONLY_TOKEN_MODE', 'true'));
    assert.ok(!looksLikeLiteralSecret('API_KEY', '<YOUR_KEY>'));
    assert.ok(!looksLikeLiteralSecret('API_KEY', '${API_KEY}'));
    assert.ok(!looksLikeLiteralSecret('Authorization', 'Bearer ${GITHUB_PAT}'));
    assert.ok(!looksLikeLiteralSecret('PORT', '5432'));
    assert.ok(!looksLikeLiteralSecret('X-MCP-Readonly', 'true'));
  });

  it('redacts argv flags carrying secrets', () => {
    assert.deepEqual(redactArgs(['--api-key=sekretvalue1', '--token', 'sekretvalue2', '--dsn', 'postgres://u:p@h/d', '-e', 'GITHUB_TOKEN']), [
      '--api-key=***',
      '--token',
      '***',
      '--dsn',
      '***',
      '-e',
      'GITHUB_TOKEN',
    ]);
  });

  it('deep-redacts objects by key', () => {
    const out = redactDeep({ env: { GITHUB_TOKEN: 'abcdefghijkl', MODE: 'x' }, url: 'https://u:pw@host/mcp' }) as any;
    assert.equal(out.env.GITHUB_TOKEN, '***');
    assert.equal(out.env.MODE, 'x');
    assert.equal(out.url, 'https://u:***@host/mcp');
  });
});

describe('text sanitizing', () => {
  it('strips terminal escapes, control and bidi characters', () => {
    const evil = 'ok\u001b[31mRED\u001b[0m \u001b]8;;http://evil\u0007link\u001b]8;;\u0007 ‮evil\u0000';
    const out = sanitize(evil);
    assert.ok(!/[\u001b\u0000‮\u0007]/.test(out), JSON.stringify(out));
    assert.ok(out.includes('RED'));
  });
  it('caps length', () => {
    assert.equal(sanitize('x'.repeat(1000), 10).length, 10);
    assert.ok(!sanitizeLine('a\nb\nc').includes('\n'));
  });
  it('escapes markdown control characters', () => {
    assert.equal(mdEscape('[a](b) `c` <d>'), '\\[a\\](b) \\`c\\` \\<d\\>');
  });
});
