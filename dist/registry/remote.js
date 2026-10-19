// Optional, opt-in search of the official MCP Registry. Results are untrusted listings:
// they are shown with a warning and are never installable through stackhint.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { readJson, writeAtomic } from '../util/fsx.js';
import { sanitize, sanitizeLine } from '../util/text.js';
import { isSafeUrl } from './registry.js';

export const OFFICIAL_REGISTRY = 'https://registry.modelcontextprotocol.io/v0.1/servers';

























const isObj = (v         )           => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseListings(body         )                  {
  if (!isObj(body) || !Array.isArray(body['servers'])) throw new Error('unexpected response shape');
  const out                  = [];
  for (const item of body['servers'].slice(0, 200)) {
    if (!isObj(item)) continue;
    const server = isObj(item['server']) ? item['server'] : item;
    const name = typeof server['name'] === 'string' ? sanitizeLine(server['name'], 120) : '';
    if (!name) continue;
    const repo = isObj(server['repository']) && typeof server['repository']['url'] === 'string' ? server['repository']['url'] : undefined;
    const website = typeof server['websiteUrl'] === 'string' ? server['websiteUrl'] : undefined;
    const remotes = Array.isArray(server['remotes'])
      ? server['remotes'].filter(isObj).map((r) => `${sanitizeLine(r['type'], 20)} ${typeof r['url'] === 'string' && isSafeUrl(r['url']) ? r['url'] : '(url hidden)'}`)
      : [];
    const packages = Array.isArray(server['packages'])
      ? server['packages'].filter(isObj).map((p) => `${sanitizeLine(p['registryType'], 12)}:${sanitizeLine(p['identifier'], 100)}`)
      : [];
    const meta = isObj(item['_meta']) ? item['_meta'] : {};
    const official = isObj(meta['io.modelcontextprotocol.registry/official']) ? meta['io.modelcontextprotocol.registry/official'] : {};
    out.push({
      name,
      ...(typeof server['title'] === 'string' ? { title: sanitizeLine(server['title'], 120) } : {}),
      description: sanitize(server['description'], 300),
      ...(typeof server['version'] === 'string' ? { version: sanitizeLine(server['version'], 40) } : {}),
      ...(repo && isSafeUrl(repo) ? { repository: repo } : {}),
      ...(website && isSafeUrl(website) ? { website } : {}),
      remotes: remotes.slice(0, 4),
      packages: packages.slice(0, 4),
      ...(typeof official['status'] === 'string' ? { status: sanitizeLine(official['status'], 20) } : {}),
    });
  }
  return out;
}

export async function searchRemote(
  query        ,
  opts                                                                                                                 ,
)                        {
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? 24 * 3_600_000;
  const key = createHash('sha256').update(query.trim().toLowerCase()).digest('hex').slice(0, 16);
  const cacheFile = path.join(opts.cacheDir, `remote-${key}.json`);
  const cached = readJson                                                  (cacheFile);
  const cachedOk = cached.ok && Array.isArray(cached.value.listings) && typeof cached.value.fetchedAt === 'string';
  if (cachedOk && now - Date.parse(cached.value.fetchedAt) < ttl) {
    return { ok: true, listings: cached.value.listings, fromCache: true, stale: false, fetchedAt: cached.value.fetchedAt };
  }
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch                                    );
  if (!fetchImpl) return { ok: false, listings: [], fromCache: false, stale: false, error: 'fetch is not available in this Node.js version' };
  const url = `${opts.baseUrl ?? OFFICIAL_REGISTRY}?search=${encodeURIComponent(query.trim().slice(0, 100))}&limit=20&version=latest`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json', 'user-agent': 'stackhint' } });
    if (!res.ok) throw new Error(`registry answered HTTP ${res.status}`);
    const listings = parseListings(await res.json());
    const fetchedAt = new Date(now).toISOString();
    try {
      writeAtomic(cacheFile, JSON.stringify({ fetchedAt, listings }) + '\n');
    } catch {
      /* cache is best effort */
    }
    return { ok: true, listings, fromCache: false, stale: false, fetchedAt };
  } catch (e) {
    const error = (e         ).name === 'AbortError' ? 'timed out' : (e         ).message;
    if (cachedOk) return { ok: true, listings: cached.value.listings, fromCache: true, stale: true, error, fetchedAt: cached.value.fetchedAt };
    return { ok: false, listings: [], fromCache: false, stale: false, error };
  } finally {
    clearTimeout(timer);
  }
}
