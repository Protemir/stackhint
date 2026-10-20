import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readJson, writeAtomic } from '../util/fsx.js';
import { redactDeep } from '../util/redact.js';
import { comparablePath, stackhintHome,          } from '../util/paths.js';


















export const DEFAULT_CONFIG         = {
  mode: 'balanced',
  minScore: 30,
  hookMinScore: { balanced: 50, proactive: 40 },
  hookMaxItems: { balanced: 2, proactive: 3 },
  itemCooldownDays: 14,
  projectCooldownHours: 24,
  network: false,
  gitHistory: true,
};

export const CONFIG_KEYS                                                = {
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































export class Store {
           home        ;
                   now              ;

  constructor(env      = process.env, now               = Date.now) {
    this.home = stackhintHome(env);
    this.now = now;
  }

  get configPath()         {
    return path.join(this.home, 'config.json');
  }
  get statePath()         {
    return path.join(this.home, 'state.json');
  }
  get auditPath()         {
    return path.join(this.home, 'audit.log');
  }
  get backupsDir()         {
    return path.join(this.home, 'backups');
  }
  get cacheDir()         {
    return path.join(this.home, 'cache');
  }

  // ---------- config ----------

  loadConfig()                                         {
    const warnings           = [];
    const res = readJson                         (this.configPath);
    const config         = structuredClone(DEFAULT_CONFIG);
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
      else setPath(config                                      , key, value);
    }
    for (const key of Object.keys(raw)) {
      if (!Object.keys(CONFIG_KEYS).some((k) => k === key || k.startsWith(key + '.'))) warnings.push(`config: unknown key "${key}" ignored`);
    }
    return { config, warnings };
  }

  setConfig(key        , rawValue        )         {
    const type = CONFIG_KEYS[key];
    if (!type) throw new Error(`unknown config key "${key}". Known: ${Object.keys(CONFIG_KEYS).join(', ')}`);
    let value          = rawValue;
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
    const res = readJson                         (this.configPath);
    // Never replace a config file we cannot read: the user would lose the other settings.
    if (!res.ok && !res.missing) throw new Error(`${this.configPath}: ${res.error}; fix or delete it first`);
    if (res.ok && (!res.value || typeof res.value !== 'object' || Array.isArray(res.value))) throw new Error(`${this.configPath} must hold a JSON object; fix or delete it first`);
    const current = res.ok ? res.value : {};
    setPath(current, key, value);
    writeAtomic(this.configPath, JSON.stringify(current, null, 2) + '\n');
    return this.loadConfig().config;
  }

  // ---------- state ----------

  loadState()        {
    const res = readJson       (this.statePath);
    if (res.ok && res.value && typeof res.value === 'object' && res.value.version === 1) return normalizeState(res.value);
    return { version: 1, dismissed: {}, projects: {} };
  }

  saveState(state       )       {
    writeAtomic(this.statePath, JSON.stringify(state, null, 2) + '\n');
  }

  /**
   * Read, change and write the state under a lock file, so hooks of parallel sessions and a
   * `dismiss` in another terminal do not overwrite each other's changes.
   */
  updateState(change                        )        {
    fs.mkdirSync(this.home, { recursive: true });
    const lock = `${this.statePath}.lock`;
    const deadline = Date.now() + 3000;
    let fd                    ;
    for (;;) {
      try {
        fd = fs.openSync(lock, 'wx');
        break;
      } catch (e) {
        // On Windows a lock file that another process is deleting gives EPERM or EACCES: busy, not broken.
        const code = (e                         ).code;
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
      const res = readJson       (this.statePath);
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

  projectKey(root        )         {
    return createHash('sha256').update(comparablePath(root)).digest('hex').slice(0, 16);
  }

  isDismissed(state       , id        , projectKey        )                        {
    const now = this.now();
    const forProject = (d           )          => (!d.project && !d.projects?.length) || d.project === projectKey || Boolean(d.projects?.includes(projectKey));
    return (state.dismissed[id] ?? []).find((d) => forProject(d) && (!d.until || Date.parse(d.until) > now));
  }

  dismiss(id        , opts                                                                                  )            {
    const d            = { at: new Date(this.now()).toISOString() };
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

  undismiss(id        )          {
    let had = false;
    this.updateState((state) => {
      had = Boolean(state.dismissed[id]?.length);
      delete state.dismissed[id];
    });
    if (had) this.audit('undismiss', { id });
    return had;
  }

  project(state       , key        )               {
    const p = state.projects[key] ?? { shown: {}, signals: [] };
    if (!p.shown || typeof p.shown !== 'object') p.shown = {};
    if (!Array.isArray(p.signals)) p.signals = [];
    state.projects[key] = p;
    return p;
  }

  // ---------- audit ----------

  audit(event        , details                         )       {
    try {
      fs.mkdirSync(this.home, { recursive: true });
      const line = JSON.stringify({ ...(redactDeep(details)                           ), at: new Date(this.now()).toISOString(), event });
      fs.appendFileSync(this.auditPath, line + '\n', 'utf8');
    } catch {
      /* auditing must never break the command */
    }
  }

  readAudit(limit = 50)                                 {
    try {
      const lines = fs.readFileSync(this.auditPath, 'utf8').split(/\r?\n/).filter(Boolean);
      return lines
        .slice(-limit)
        .map((l) => {
          try {
            return JSON.parse(l)                           ;
          } catch {
            return undefined;
          }
        })
        .filter((x)                               => Boolean(x));
    } catch {
      return [];
    }
  }
}

/** A state file someone edited by hand: keep what has the right shape, drop the rest. */
function normalizeState(raw       )        {
  const obj = (v         )                               => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  const str = (v         )          => v === undefined || typeof v === 'string';
  const dismissed                     = {};
  if (obj(raw.dismissed)) {
    for (const [id, list] of Object.entries(raw.dismissed)) {
      if (!Array.isArray(list)) continue;
      const keys = (v         )          => v === undefined || (Array.isArray(v) && v.every((k) => typeof k === 'string'));
      const ok = list.filter((d)                 => obj(d) && typeof d['at'] === 'string' && str(d['until']) && str(d['project']) && str(d['reason']) && keys(d['projects']));
      if (ok.length) dismissed[id] = ok;
    }
  }
  const projects                    = {};
  if (obj(raw.projects)) for (const [k, p] of Object.entries(raw.projects)) if (obj(p)) projects[k] = p                           ;
  return { version: 1, dismissed, projects };
}

function getPath(obj                         , key        )          {
  let cur          = obj;
  for (const part of key.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur                           )[part];
  }
  return cur;
}

function setPath(obj                         , key        , value         )       {
  const parts = key.split('.');
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    if (!cur[part] || typeof cur[part] !== 'object') cur[part] = {};
    cur = cur[part]                           ;
  }
  cur[parts[parts.length - 1]          ] = value;
}

function validateConfigValue(key        , value         )                     {
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
