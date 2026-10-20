import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Mode } from '../types.ts';
import { readJson, writeAtomic } from '../util/fsx.ts';
import { redactDeep } from '../util/redact.ts';
import { comparablePath, stackhintHome, type Env } from '../util/paths.ts';

export interface Config {
  mode: Mode;
  /** Minimum score shown by `recommend` (explicit requests). */
  minScore: number;
  /** Minimum score for hook suggestions, per mode. */
  hookMinScore: { balanced: number; proactive: number };
  hookMaxItems: { balanced: number; proactive: number };
  /** Do not show the same suggestion again within this many days. */
  itemCooldownDays: number;
  /** At most one hook suggestion batch per project in this window. */
  projectCooldownHours: number;
  /** Allow network access (remote registry search). Off by default. */
  network: boolean;
  /** Read recent commit subjects with `git log` (local only). */
  gitHistory: boolean;
}

export const DEFAULT_CONFIG: Config = {
  mode: 'balanced',
  minScore: 30,
  hookMinScore: { balanced: 50, proactive: 40 },
  hookMaxItems: { balanced: 2, proactive: 3 },
  itemCooldownDays: 14,
  projectCooldownHours: 24,
  network: false,
  gitHistory: true,
};

export const CONFIG_KEYS: Record<string, 'mode' | 'number' | 'boolean'> = {
  mode: 'mode',
  minScore: 'number',
  'hookMinScore.balanced': 'number',
  'hookMinScore.proactive': 'number',
  'hookMaxItems.balanced': 'number',
  'hookMaxItems.proactive': 'number',
  itemCooldownDays: 'number',
  projectCooldownHours: 'number',
  network: 'boolean',
  gitHistory: 'boolean',
};

export interface Dismissal {
  /** ISO time until which the item is hidden; absent = forever. */
  until?: string;
  /** Project key, or absent for all projects. */
  project?: string;
  /**
   * Every key the same project can show up under: the folder the command ran in, its git root
   * and the folder a Claude Code session was opened in. Hooks and the CLI may see any of them.
   */
  projects?: string[];
  at: string;
  reason?: string;
}

export interface ProjectState {
  lastHookAt?: string;
  shown: Record<string, string>;
  signals: string[];
  /** Signal strengths from the last full scan, used by the prompt hook. */
  strengths?: Record<string, number>;
  /** Task categories seen by the prompt hook in the current session. */
  sessionTasks?: { session: string; tasks: string[] };
}

export interface State {
  version: 1;
  dismissed: Record<string, Dismissal[]>;
  projects: Record<string, ProjectState>;
}

export class Store {
  readonly home: string;
  private readonly now: () => number;

  constructor(env: Env = process.env, now: () => number = Date.now) {
    this.home = stackhintHome(env);
    this.now = now;
  }

  get configPath(): string {
    return path.join(this.home, 'config.json');
  }
  get statePath(): string {
    return path.join(this.home, 'state.json');
  }
  get auditPath(): string {
    return path.join(this.home, 'audit.log');
  }
  get backupsDir(): string {
    return path.join(this.home, 'backups');
  }
  get cacheDir(): string {
    return path.join(this.home, 'cache');
  }

  // ---------- config ----------

  loadConfig(): { config: Config; warnings: string[] } {
    const warnings: string[] = [];
    const res = readJson<Record<string, unknown>>(this.configPath);
    const config: Config = structuredClone(DEFAULT_CONFIG);
    if (!res.ok) {
      if (!res.missing) warnings.push(`config.json ignored (${res.error}); using defaults`);
      return { config, warnings };
    }
    const raw = res.value;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      warnings.push('config.json is not an object; using defaults');
      return { config, warnings };
    }
    for (const key of Object.keys(CONFIG_KEYS)) {
      const value = getPath(raw, key);
      if (value === undefined) continue;
      const err = validateConfigValue(key, value);
      if (err) warnings.push(`config ${key}: ${err}; using default`);
      else setPath(config as unknown as Record<string, unknown>, key, value);
    }
    for (const key of Object.keys(raw)) {
      if (!Object.keys(CONFIG_KEYS).some((k) => k === key || k.startsWith(key + '.'))) warnings.push(`config: unknown key "${key}" ignored`);
    }
    return { config, warnings };
  }

  setConfig(key: string, rawValue: string): Config {
    const type = CONFIG_KEYS[key];
    if (!type) throw new Error(`unknown config key "${key}". Known: ${Object.keys(CONFIG_KEYS).join(', ')}`);
    let value: unknown = rawValue;
    if (type === 'number') {
      // Number("") is 0: an empty or half-typed value must not silently become zero.
      if (!/^\s*\d+(\.\d+)?\s*$/.test(rawValue)) throw new Error(`${key} must be a number`);
      value = Number(rawValue);
    }
    if (type === 'boolean') {
      if (!/^(true|false)$/.test(rawValue)) throw new Error(`${key} must be true or false`);
      value = rawValue === 'true';
    }
    const err = validateConfigValue(key, value);
    if (err) throw new Error(`${key}: ${err}`);
    const res = readJson<Record<string, unknown>>(this.configPath);
    // Never replace a config file we cannot read: the user would lose the other settings.
    if (!res.ok && !res.missing) throw new Error(`${this.configPath}: ${res.error}; fix or delete it first`);
    if (res.ok && (!res.value || typeof res.value !== 'object' || Array.isArray(res.value))) throw new Error(`${this.configPath} must hold a JSON object; fix or delete it first`);
    const current = res.ok ? res.value : {};
    setPath(current, key, value);
    writeAtomic(this.configPath, JSON.stringify(current, null, 2) + '\n');
    return this.loadConfig().config;
  }

  // ---------- state ----------

  loadState(): State {
    const res = readJson<State>(this.statePath);
    if (res.ok && res.value && typeof res.value === 'object' && res.value.version === 1) return normalizeState(res.value);
    return { version: 1, dismissed: {}, projects: {} };
  }

  saveState(state: State): void {
    writeAtomic(this.statePath, JSON.stringify(state, null, 2) + '\n');
  }

  /**
   * Read, change and write the state under a lock file, so hooks of parallel sessions and a
   * `dismiss` in another terminal do not overwrite each other's changes.
   */
  updateState(change: (state: State) => void): State {
    fs.mkdirSync(this.home, { recursive: true });
    const lock = `${this.statePath}.lock`;
    const deadline = Date.now() + 3000;
    let fd: number | undefined;
    for (;;) {
      try {
        fd = fs.openSync(lock, 'wx');
        break;
      } catch (e) {
        // On Windows a lock file that another process is deleting gives EPERM or EACCES: busy, not broken.
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') break; // cannot lock here: carry on without
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.rmSync(lock, { force: true }); // left by a killed process
        } catch {
          /* gone already */
        }
        if (Date.now() > deadline) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
      }
    }
    try {
      const res = readJson<State>(this.statePath);
      // Keep a copy of a state file we cannot parse instead of silently dropping its dismissals.
      if (!res.ok && !res.missing) {
        try {
          fs.copyFileSync(this.statePath, `${this.statePath}.corrupt`);
        } catch {
          /* best effort */
        }
      }
      const state = this.loadState();
      change(state);
      this.saveState(state);
      return state;
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
        fs.rmSync(lock, { force: true });
      }
    }
  }

  projectKey(root: string): string {
    // The real path: on macOS /var is a link to /private/var, and a session opened through a
    // linked folder must get the same key as a shell whose cwd is already resolved.
    let real = root;
    try {
      real = fs.realpathSync.native(root);
    } catch {
      /* missing folder: use the path as given */
    }
    return createHash('sha256').update(comparablePath(real)).digest('hex').slice(0, 16);
  }

  isDismissed(state: State, id: string, projectKey: string): Dismissal | undefined {
    const now = this.now();
    const forProject = (d: Dismissal): boolean => (!d.project && !d.projects?.length) || d.project === projectKey || Boolean(d.projects?.includes(projectKey));
    return (state.dismissed[id] ?? []).find((d) => forProject(d) && (!d.until || Date.parse(d.until) > now));
  }

  dismiss(id: string, opts: { forMs?: number; projectKey?: string; projectKeys?: string[]; reason?: string }): Dismissal {
    const d: Dismissal = { at: new Date(this.now()).toISOString() };
    if (opts.forMs) d.until = new Date(this.now() + opts.forMs).toISOString();
    if (opts.projectKey) d.project = opts.projectKey;
    const keys = [...new Set([...(opts.projectKey ? [opts.projectKey] : []), ...(opts.projectKeys ?? [])])];
    if (keys.length > 1) d.projects = keys;
    if (opts.reason) d.reason = opts.reason.slice(0, 200);
    this.updateState((state) => {
      const list = (state.dismissed[id] ?? []).filter((x) => (x.project ?? '') !== (d.project ?? ''));
      list.push(d);
      state.dismissed[id] = list;
    });
    this.audit('dismiss', { id, ...d });
    return d;
  }

  undismiss(id: string): boolean {
    let had = false;
    this.updateState((state) => {
      had = Boolean(state.dismissed[id]?.length);
      delete state.dismissed[id];
    });
    if (had) this.audit('undismiss', { id });
    return had;
  }

  project(state: State, key: string): ProjectState {
    const p = state.projects[key] ?? { shown: {}, signals: [] };
    if (!p.shown || typeof p.shown !== 'object') p.shown = {};
    if (!Array.isArray(p.signals)) p.signals = [];
    state.projects[key] = p;
    return p;
  }

  // ---------- audit ----------

  audit(event: string, details: Record<string, unknown>): void {
    try {
      fs.mkdirSync(this.home, { recursive: true });
      const line = JSON.stringify({ ...(redactDeep(details) as Record<string, unknown>), at: new Date(this.now()).toISOString(), event });
      fs.appendFileSync(this.auditPath, line + '\n', 'utf8');
    } catch {
      /* auditing must never break the command */
    }
  }

  readAudit(limit = 50): Array<Record<string, unknown>> {
    try {
      const lines = fs.readFileSync(this.auditPath, 'utf8').split(/\r?\n/).filter(Boolean);
      return lines
        .slice(-limit)
        .map((l) => {
          try {
            return JSON.parse(l) as Record<string, unknown>;
          } catch {
            return undefined;
          }
        })
        .filter((x): x is Record<string, unknown> => Boolean(x));
    } catch {
      return [];
    }
  }
}

/** A state file someone edited by hand: keep what has the right shape, drop the rest. */
function normalizeState(raw: State): State {
  const obj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  const str = (v: unknown): boolean => v === undefined || typeof v === 'string';
  const dismissed: State['dismissed'] = {};
  if (obj(raw.dismissed)) {
    for (const [id, list] of Object.entries(raw.dismissed)) {
      if (!Array.isArray(list)) continue;
      const keys = (v: unknown): boolean => v === undefined || (Array.isArray(v) && v.every((k) => typeof k === 'string'));
      const ok = list.filter((d): d is Dismissal => obj(d) && typeof d['at'] === 'string' && str(d['until']) && str(d['project']) && str(d['reason']) && keys(d['projects']));
      if (ok.length) dismissed[id] = ok;
    }
  }
  const projects: State['projects'] = {};
  if (obj(raw.projects)) for (const [k, p] of Object.entries(raw.projects)) if (obj(p)) projects[k] = p as unknown as ProjectState;
  return { version: 1, dismissed, projects };
}

function getPath(obj: Record<string, unknown>, key: string): unknown {
  let cur: unknown = obj;
  for (const part of key.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    if (!cur[part] || typeof cur[part] !== 'object') cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1] as string] = value;
}

function validateConfigValue(key: string, value: unknown): string | undefined {
  const type = CONFIG_KEYS[key];
  if (type === 'mode') return value === 'manual' || value === 'balanced' || value === 'proactive' ? undefined : 'must be manual, balanced or proactive';
  if (type === 'boolean') return typeof value === 'boolean' ? undefined : 'must be true or false';
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'must be a non-negative number';
    if (key.toLowerCase().includes('score') && value > 100) return 'must be 0..100';
    if (key.startsWith('hookMaxItems') && value > 10) return 'must be 0..10';
    return undefined;
  }
  return 'unknown key';
}
