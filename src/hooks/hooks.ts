// SessionStart and UserPromptSubmit hooks for Claude Code and Codex.
// Hooks must be quiet, fast and never fail the host: every error ends in "no output".

import fs from 'node:fs';
import path from 'node:path';
import type { HostId, ProjectContext, Recommendation, Signal } from '../types.ts';
import { openSession, runRecommend, type Session } from '../app.ts';
import { findWorkTree } from '../context/git.ts';
import { classifyTask } from '../context/task.ts';
import { SignalSet } from '../context/signals.ts';
import { recommend } from '../engine/recommend.ts';
import { Store } from '../state/store.ts';
import { homeDir, samePath, type Env } from '../util/paths.ts';
import { sanitizeLine } from '../util/text.ts';

export interface HookInput {
  cwd?: string;
  session_id?: string;
  source?: string;
  prompt?: string;
  hook_event_name?: string;
  transcript_path?: string;
}

export interface HookDeps {
  env?: Env;
  platform?: NodeJS.Platform;
  now?: () => number;
  host?: HostId;
  which?: (name: string) => string | undefined;
}

/**
 * The project the session belongs to. Claude Code passes CLAUDE_PROJECT_DIR; otherwise use the git
 * root above the working directory, so a cd into a subfolder does not look like another project.
 */
export function projectRootFor(input: HookInput, env: Env): string {
  if (env['CLAUDE_PROJECT_DIR']) return env['CLAUDE_PROJECT_DIR'];
  const cwd = input.cwd || process.cwd();
  const tree = findWorkTree(cwd);
  // A dotfiles repository in the home folder is not "the project".
  if (tree && !samePath(tree, homeDir(env))) return tree;
  return cwd;
}

export function detectHost(input: HookInput, env: Env): HostId | undefined {
  if (env['CLAUDE_PROJECT_DIR'] || env['CLAUDECODE']) return 'claude';
  const tp = (input.transcript_path ?? '').replace(/\\/g, '/');
  if (tp.includes('/.claude/')) return 'claude';
  if (tp.includes('/.codex/') || env['CODEX_THREAD_ID'] || env['CODEX_SESSION_ID']) return 'codex';
  return undefined;
}

function logError(store: Store, e: unknown): void {
  try {
    fs.mkdirSync(store.home, { recursive: true });
    fs.appendFileSync(path.join(store.home, 'hook-errors.log'), `${new Date().toISOString()} ${sanitizeLine(String((e as Error)?.stack ?? e), 2000)}\n`);
  } catch {
    /* nothing else to do */
  }
}

function contextText(recs: Recommendation[], event: 'SessionStart' | 'UserPromptSubmit'): string {
  const lines = [
    event === 'SessionStart'
      ? 'stackhint (a local tool advisor the user installed) found integrations that fit this project and are not set up yet:'
      : "stackhint (a local tool advisor the user installed) noticed the user's request could use an integration that is not set up:",
  ];
  for (const r of recs) {
    lines.push(`- ${r.entry.name} (fit ${r.score}/100, ${r.confidence} confidence): ${sanitizeLine(r.whyNow, 260)} Details: \`stackhint explain ${r.id}\`.`);
  }
  lines.push(
    'Mention this to the user only if it is relevant to what they are asking, and at most once. Do not install anything yourself: installing needs the user to run `stackhint install <id>` and confirm the change. They can hide a suggestion with `stackhint dismiss <id>` or turn these hints off with `stackhint config set mode manual`.',
  );
  return lines.join('\n');
}

function output(event: 'SessionStart' | 'UserPromptSubmit', recs: Recommendation[], visible: boolean): string {
  const payload: Record<string, unknown> = { hookSpecificOutput: { hookEventName: event, additionalContext: contextText(recs, event) } };
  if (visible) payload['systemMessage'] = `stackhint: ${recs.map((r) => r.entry.name).join(', ')} may help here. Run \`stackhint recommend\` for details.`;
  return JSON.stringify(payload);
}

export async function sessionStartHook(input: HookInput, deps: HookDeps = {}): Promise<string | undefined> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const store = new Store(env, now);
  try {
    const { config } = store.loadConfig();
    if (config.mode === 'manual') return undefined;
    const root = projectRootFor(input, env);
    const host = deps.host ?? detectHost(input, env);
    const session = await openSession({
      root,
      ...(host ? { host } : {}),
      env,
      ...(deps.platform ? { platform: deps.platform } : {}),
      now,
      timeBudgetMs: 1500,
      ...(deps.which ? { which: deps.which } : {}),
    });
    const state = store.loadState();
    const project = store.project(state, session.projectKey);
    const mode = config.mode;
    const result = runRecommend(session, { minScore: config.hookMinScore[mode], previousSignals: project.signals });
    const cooldownMs = config.itemCooldownDays * 86_400_000;
    const nowMs = now();
    const fresh = result.recommendations.filter((r) => {
      // Balanced mode only interrupts for well-supported suggestions.
      if (r.action === 'use-existing' || r.confidence === 'low' || (mode === 'balanced' && r.confidence !== 'high')) return false;
      const last = project.shown[r.id];
      return !last || nowMs - Date.parse(last) >= cooldownMs;
    });
    const inProjectCooldown = project.lastHookAt !== undefined && nowMs - Date.parse(project.lastHookAt) < config.projectCooldownHours * 3_600_000;
    const picked = (inProjectCooldown ? fresh.filter((r) => r.newSignals.length > 0) : fresh).slice(0, config.hookMaxItems[mode]);

    const kept = Object.values(session.ctx.signals).filter((s) => !s.id.startsWith('task:') && !s.id.startsWith('team-mcp:'));
    project.signals = kept.map((s) => s.id);
    project.strengths = Object.fromEntries(kept.map((s) => [s.id, s.strength]));
    if (picked.length > 0) {
      project.lastHookAt = new Date(nowMs).toISOString();
      for (const r of picked) project.shown[r.id] = new Date(nowMs).toISOString();
    }
    store.saveState(state);
    if (picked.length === 0) return undefined;
    store.audit('hook-suggested', { hook: 'SessionStart', ids: picked.map((r) => r.id), project: session.projectKey });
    return output('SessionStart', picked, mode === 'proactive');
  } catch (e) {
    logError(store, e);
    return undefined;
  }
}

/** Proactive mode only: look at the prompt (in memory only) for a task that needs a missing tool. */
export async function userPromptHook(input: HookInput, deps: HookDeps = {}): Promise<string | undefined> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const store = new Store(env, now);
  try {
    const { config } = store.loadConfig();
    if (config.mode !== 'proactive' || !input.prompt) return undefined;
    const root = projectRootFor(input, env);
    const host = deps.host ?? detectHost(input, env);
    const session: Session = await openSession({
      root,
      ...(host ? { host } : {}),
      env,
      ...(deps.platform ? { platform: deps.platform } : {}),
      now,
      skipScan: true,
      ...(deps.which ? { which: deps.which } : {}),
    });
    const state = store.loadState();
    const project = store.project(state, session.projectKey);

    // Project signals come from the last full scan (ids only); the prompt adds task signals.
    const set = new SignalSet();
    for (const id of project.signals) {
      const strength = project.strengths?.[id];
      set.add(id, typeof strength === 'number' ? Math.max(0, Math.min(1, strength)) : 0.5, { source: '.', detail: 'from the last project scan' });
    }
    const tasks = classifyTask(input.prompt, set);
    if (!tasks.some((t) => t.startsWith('task:'))) return undefined;
    const signals: Record<string, Signal> = set.toRecord();
    const ctx: ProjectContext = { ...session.ctx, signals, task: { text: '(prompt)', signals: tasks } };

    const sessionId = input.session_id ?? 'unknown';
    if (!project.sessionTasks || project.sessionTasks.session !== sessionId) project.sessionTasks = { session: sessionId, tasks: [] };
    const newTasks = tasks.filter((t) => t.startsWith('task:') && !(project.sessionTasks?.tasks ?? []).includes(t));
    if (newTasks.length === 0) return undefined;
    project.sessionTasks.tasks.push(...newTasks);

    const stateNow = store.loadState();
    const result = recommend(ctx, session.registry, session.inventory, {
      hosts: session.hosts,
      minScore: config.hookMinScore.proactive,
      limit: 5,
      platform: session.platform,
      now: now(),
      isDismissed: (id) => (store.isDismissed(stateNow, id, session.projectKey) ? 'dismissed' : undefined),
    });
    const nowMs = now();
    const cooldownMs = config.itemCooldownDays * 86_400_000;
    const picked = result.recommendations
      .filter((r) => r.confidence !== 'low' && r.reasons.some((x) => x.evidence.some((e) => e.source === 'task')))
      .filter((r) => !project.shown[r.id] || nowMs - Date.parse(project.shown[r.id] as string) >= cooldownMs)
      .slice(0, 1);
    for (const r of picked) project.shown[r.id] = new Date(nowMs).toISOString();
    store.saveState(state);
    if (picked.length === 0) return undefined;
    store.audit('hook-suggested', { hook: 'UserPromptSubmit', ids: picked.map((r) => r.id), project: session.projectKey, tasks: newTasks });
    return output('UserPromptSubmit', picked, false);
  } catch (e) {
    logError(store, e);
    return undefined;
  }
}

/** Read hook JSON from stdin without hanging when nothing is piped. */
export function readStdinJson(timeoutMs = 1500): Promise<HookInput> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve({});
      return;
    }
    let data = '';
    const done = (): void => {
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.pause();
      try {
        const v = JSON.parse(data || '{}') as unknown;
        resolve(v && typeof v === 'object' ? (v as HookInput) : {});
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c: string) => {
      data += c;
      if (data.length > 1_000_000) done();
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}
