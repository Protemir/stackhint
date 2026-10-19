// Wiring shared by the CLI, the MCP server and the hooks.

import path from 'node:path';

import { analyzeProject } from './context/analyzer.js';
import { recommend,                      } from './engine/recommend.js';
import { hostsToConsider, readInventory } from './hosts/inventory.js';
import { customRegistryFiles, loadRegistry } from './registry/registry.js';
import { Store,             } from './state/store.js';






























export async function openSession(opts                )                   {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? Date.now;
  const root = path.resolve(opts.root);
  const store = new Store(env, now);
  const { config, warnings: configWarnings } = store.loadConfig();
  const registry = loadRegistry({ extraFiles: customRegistryFiles(store.home, env                     ) });
  const inventory = readInventory(root, { env, platform, ...(opts.which ? { which: opts.which } : {}) });
  const ctx                 = opts.skipScan
    ? { root, signals: {}, git: { isRepo: false, remotes: [], branches: [], recentSubjects: [] }, stats: { filesSeen: 0, filesRead: 0, truncated: false, elapsedMs: 0 }, warnings: [] }
    : await analyzeProject(root, {
        gitHistory: config.gitHistory,
        ...(opts.task ? { task: opts.task } : {}),
        ...(opts.timeBudgetMs ? { timeBudgetMs: opts.timeBudgetMs } : {}),
      });
  const hosts = hostsToConsider(inventory, opts.host);
  return {
    root,
    ctx,
    registry,
    inventory,
    store,
    config,
    hosts,
    projectKey: store.projectKey(root),
    warnings: [...configWarnings, ...registry.warnings, ...inventory.warnings, ...ctx.warnings],
    env,
    platform,
    now,
  };
}

export function runRecommend(
  s         ,
  opts                                                                                                = {},
)                  {
  const state = s.store.loadState();
  return recommend(s.ctx, s.registry, s.inventory, {
    hosts: s.hosts,
    minScore: opts.minScore ?? s.config.minScore,
    limit: opts.limit ?? 10,
    platform: s.platform,
    now: s.now(),
    includeDismissed: opts.includeDismissed ?? false,
    isDismissed: (id) => {
      const d = s.store.isDismissed(state, id, s.projectKey);
      if (!d) return undefined;
      return d.until ? `dismissed until ${d.until.slice(0, 10)}` : 'dismissed';
    },
    ...(opts.previousSignals ? { previousSignals: opts.previousSignals } : {}),
  });
}
