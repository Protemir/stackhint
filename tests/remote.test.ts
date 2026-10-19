import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { cmdRegistrySearch } from '../src/commands.ts';
import { parseListings, searchRemote, type FetchLike } from '../src/registry/remote.ts';
import { Store } from '../src/state/store.ts';
import { captureIO, sandbox, tmp, type Sandbox } from './helpers.ts';

const dirs: string[] = [];
const boxes: Sandbox[] = [];
after(() => {
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  boxes.forEach((b) => b.cleanup());
});

const BODY = {
  servers: [
    {
      server: {
        name: 'io.github.example/weather',
        title: 'Weather',
        description: 'Forecasts\u001b[31m with ANSI\u0007 and <b>html</b>',
        version: '1.2.0',
        repository: { url: 'https://github.com/example/weather', source: 'github' },
        websiteUrl: 'javascript:alert(1)',
        remotes: [{ type: 'streamable-http', url: 'https://weather.example.com/mcp' }, { type: 'sse', url: 'http://evil.example.com/sse' }],
        packages: [{ registryType: 'npm', identifier: '@example/weather', transport: { type: 'stdio' } }],
      },
      _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
    },
    { server: { description: 'no name, skipped' } },
  ],
  metadata: { count: 2 },
};

function okFetch(body: unknown, calls: string[]): FetchLike {
  return async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => body };
  };
}

describe('official MCP Registry search (opt-in)', () => {
  it('parses and sanitizes listings', () => {
    const l = parseListings(BODY);
    assert.equal(l.length, 1);
    const w = l[0]!;
    assert.equal(w.name, 'io.github.example/weather');
    assert.ok(!/[\u001b\u0007]/.test(w.description));
    assert.equal(w.website, undefined, 'javascript: URLs dropped');
    assert.equal(w.repository, 'https://github.com/example/weather');
    assert.deepEqual(w.remotes, ['streamable-http https://weather.example.com/mcp', 'sse (url hidden)']);
    assert.throws(() => parseListings({ nope: true }), /unexpected response/);
  });

  it('caches results and serves them offline', async () => {
    const cacheDir = tmp();
    dirs.push(cacheDir);
    const calls: string[] = [];
    const t0 = Date.parse('2026-10-20T00:00:00Z');
    const first = await searchRemote('weather', { cacheDir, fetchImpl: okFetch(BODY, calls), now: t0 });
    assert.equal(first.ok, true);
    assert.equal(first.fromCache, false);
    assert.match(calls[0] ?? '', /\/v0\.1\/servers\?search=weather&limit=20&version=latest$/);
    const second = await searchRemote('weather', { cacheDir, fetchImpl: okFetch(BODY, calls), now: t0 + 3_600_000 });
    assert.equal(second.fromCache, true);
    assert.equal(calls.length, 1, 'served from cache without a request');
    const failing: FetchLike = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    const stale = await searchRemote('weather', { cacheDir, fetchImpl: failing, now: t0 + 48 * 3_600_000 });
    assert.equal(stale.ok, true);
    assert.equal(stale.stale, true);
    assert.match(stale.error ?? '', /ENOTFOUND/);
  });

  it('fails gracefully without cache, on HTTP errors and on timeouts', async () => {
    const cacheDir = tmp();
    dirs.push(cacheDir);
    const down = await searchRemote('x', { cacheDir, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
    assert.equal(down.ok, false);
    assert.match(down.error ?? '', /503/);
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    const slow = await searchRemote('y', { cacheDir, fetchImpl: hang, timeoutMs: 50 });
    assert.equal(slow.ok, false);
    assert.equal(slow.error, 'timed out');
    const garbage = await searchRemote('z', { cacheDir, fetchImpl: okFetch('not an object', []) });
    assert.equal(garbage.ok, false);
  });

  it('the CLI never touches the network unless the user allowed it', async () => {
    const b = sandbox();
    boxes.push(b);
    const original = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      throw new Error('network used');
    }) as typeof fetch;
    try {
      const io = captureIO(b.env, b.project);
      assert.equal(await cmdRegistrySearch(io, { query: 'github', remote: true }), 3);
      assert.equal(called, 0);
      assert.equal(await cmdRegistrySearch(io, { query: 'github' }), 0);
      assert.equal(called, 0, 'local search is offline');
      new Store(b.env).setConfig('network', 'true');
      const io2 = captureIO(b.env, b.project);
      assert.equal(await cmdRegistrySearch(io2, { query: 'github', remote: true }), 0);
      assert.equal(called, 1);
      assert.match(io2.text(), /unavailable: network used/);
      assert.ok(fs.existsSync(path.join(b.stackhome, 'config.json')));
    } finally {
      globalThis.fetch = original;
    }
  });
});
