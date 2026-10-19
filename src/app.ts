// Wiring shared by the CLI, the MCP server and the hooks.

import path from 'node:path';
import type { HostId, Inventory, ProjectContext, Registry } from './types.ts';
import { analyzeProject } from './context/analyzer.ts';
import { recommend, type RecommendResult } from './engine/recommend.ts';
import { hostsToConsider, readInventory } from './hosts/inventory.ts';
import { customRegistryFiles, loadRegistry } from './registry/registry.ts';
import { Store, type Config } from './state/store.ts';
import type { Env } from './util/paths.ts';

export interface SessionOptions {
  root: string;
  task?: string;
  host?: HostId | 'all';
  env?: Env;
  platform?: NodeJS.Platform;
  now?: () => number;
  which?: (name: string) => string | undefined;
  timeBudgetMs?: number;
  /** Skip the project scan (only registry, inventory and state are needed). */
  skipScan?: boolean;
}

export interface Session {
  root: string;
  ctx: ProjectContext;
  registry: Registry;
  inventory: Inventory;
  store: Store;
  config: Config;
  hosts: HostId[];
  projectKey: string;
  warnings: string[];
  env: Env;
  platform: NodeJS.Platform;
  now: () => number;
}

export async function openSession(opts: SessionOptions): Promise<Session> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? Date.now;
  const root = path.resolve(opts.root);
  const store = new Store(env, now);
  const { config, warnings: configWarnings } = store.loadConfig();
  const registry = loadRegistry({ extraFiles: customRegistryFiles(store.home, env as NodeJS.ProcessEnv) });
  const inventory = readInventory(root, { env, platform, ...(opts.which ? { which: opts.which } : {}) });
  const ctx: ProjectContext = opts.skipScan
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
  s: Session,
  opts: { minScore?: number; limit?: number; includeDismissed?: boolean; previousSignals?: string[] } = {},
): RecommendResult {
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
