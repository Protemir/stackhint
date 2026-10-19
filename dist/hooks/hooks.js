// SessionStart and UserPromptSubmit hooks for Claude Code and Codex.
// Hooks must be quiet, fast and never fail the host: every error ends in "no output".

import fs from 'node:fs';
import path from 'node:path';

import { openSession, runRecommend,              } from '../app.js';
import { classifyTask } from '../context/task.js';
import { SignalSet } from '../context/signals.js';
import { recommend } from '../engine/recommend.js';
import { Store } from '../state/store.js';

import { sanitizeLine } from '../util/text.js';


















export function detectHost(input           , env     )                     {
  if (env['CLAUDE_PROJECT_DIR'] || env['CLAUDECODE']) return 'claude';
  const tp = (input.transcript_path ?? '').replace(/\\/g, '/');
  if (tp.includes('/.claude/')) return 'claude';
  if (tp.includes('/.codex/') || env['CODEX_THREAD_ID'] || env['CODEX_SESSION_ID']) return 'codex';
  return undefined;
}

function logError(store       , e         )       {
  try {
    fs.mkdirSync(store.home, { recursive: true });
    fs.appendFileSync(path.join(store.home, 'hook-errors.log'), `${new Date().toISOString()} ${sanitizeLine(String((e         )?.stack ?? e), 2000)}\n`);
  } catch {
    /* nothing else to do */
  }
}

function contextText(recs                  , event                                     )         {
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

function output(event                                     , recs                  , visible         )         {
  const payload                          = { hookSpecificOutput: { hookEventName: event, additionalContext: contextText(recs, event) } };
  if (visible) payload['systemMessage'] = `stackhint: ${recs.map((r) => r.entry.name).join(', ')} may help here. Run \`stackhint recommend\` for details.`;
  return JSON.stringify(payload);
}

export async function sessionStartHook(input           , deps           = {})                              {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const store = new Store(env, now);
  try {
    const { config } = store.loadConfig();
    if (config.mode === 'manual') return undefined;
    const root = input.cwd || env['CLAUDE_PROJECT_DIR'] || process.cwd();
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

    project.signals = Object.keys(session.ctx.signals).filter((s) => !s.startsWith('task:') && !s.startsWith('team-mcp:'));
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
export async function userPromptHook(input           , deps           = {})                              {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const store = new Store(env, now);
  try {
    const { config } = store.loadConfig();
    if (config.mode !== 'proactive' || !input.prompt) return undefined;
    const root = input.cwd || env['CLAUDE_PROJECT_DIR'] || process.cwd();
    const host = deps.host ?? detectHost(input, env);
    const session          = await openSession({
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
    for (const id of project.signals) set.add(id, 0.8, { source: '.', detail: 'from the last project scan' });
    const tasks = classifyTask(input.prompt, set);
    if (!tasks.some((t) => t.startsWith('task:'))) return undefined;
    const signals                         = set.toRecord();
    const ctx                 = { ...session.ctx, signals, task: { text: '(prompt)', signals: tasks } };

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
      .filter((r) => !project.shown[r.id] || nowMs - Date.parse(project.shown[r.id]          ) >= cooldownMs)
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
export function readStdinJson(timeoutMs = 1500)                     {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve({});
      return;
    }
    let data = '';
    const done = ()       => {
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.pause();
      try {
        const v = JSON.parse(data || '{}')           ;
        resolve(v && typeof v === 'object' ? (v             ) : {});
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c        ) => {
      data += c;
      if (data.length > 1_000_000) done();
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}
