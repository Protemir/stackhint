#!/usr/bin/env node
// stackhint command-line entry point.

import fs from 'node:fs';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  cmdCheck,
  cmdConfig,
  cmdDismiss,
  cmdDismissed,
  cmdDoctor,
  cmdExplain,
  cmdInstall,
  cmdRecommend,
  cmdRegistryList,
  cmdRegistrySearch,
  cmdRollback,
  cmdScan,
  cmdSetup,
  cmdStatus,
  cmdTry,
  cmdUndismiss,
  hasHost,
  UsageError,
  type IO,
} from './commands.ts';
import { readStdinJson, sessionStartHook, userPromptHook } from './hooks/hooks.ts';
import { serveStdio } from './mcp/server.ts';
import { useColor } from './util/text.ts';
import { VERSION } from './version.ts';

const HELP = `stackhint ${VERSION}: tool recommendations for Claude Code and Codex, from your repo.

Usage: stackhint <command> [options]

  scan [path]                     Show what stackhint detects in the project
  recommend [path]                Ranked suggestions (--task "...", --host claude|codex, --all)
  explain <id> [path]             Why, permissions, setup and the exact config for one tool
  install <id> --host <h>         Show the change, ask, then apply it (--dry-run, --scope, --access, --param k=v)
  try <id> --host <h>             Use a server for one session without changing config
  status [path]                   MCP servers, plugins and skills already set up
  check [path]                    Review them: outdated servers, inline secrets, write access (--strict)
  registry search <words>         Search the local registry (--remote: also the official MCP Registry)
  registry list                   List registry entries (--kind, --legacy)
  dismiss <id>                    Never suggest again (--for 14d to snooze, --project for this repo only)
  undismiss <id> | dismissed      Undo / list dismissals
  rollback [id]                   List installs made by stackhint, or undo one
  config [show|get|set]           Settings (mode manual|balanced|proactive, network, ...)
  doctor [path]                   Diagnose the setup
  setup <claude|codex>            Register stackhint itself without the plugin
  mcp                             Run as a read-only MCP server over stdio
  hook <session-start|user-prompt>  Hook entry points used by the plugin

Common options: --format text|md|json, --no-color, --help, --version
Nothing is installed or changed without your confirmation (or an explicit --yes).
Docs: https://github.com/Protemir/stackhint`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  format: { type: 'string' },
  'no-color': { type: 'boolean' },
  task: { type: 'string', short: 't' },
  host: { type: 'string' },
  all: { type: 'boolean' },
  limit: { type: 'string' },
  'min-score': { type: 'string' },
  kind: { type: 'string' },
  remote: { type: 'boolean' },
  legacy: { type: 'boolean' },
  strict: { type: 'boolean' },
  scope: { type: 'string' },
  access: { type: 'string' },
  param: { type: 'string', multiple: true },
  name: { type: 'string' },
  'dry-run': { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  force: { type: 'boolean' },
  verify: { type: 'boolean' },
  for: { type: 'string' },
  project: { type: 'boolean' },
  reason: { type: 'string' },
} as const;

/** How many positional arguments each command takes after its name. */
const MAX_ARGS: Record<string, number> = {
  scan: 1, recommend: 1, explain: 2, install: 2, try: 2, status: 1, check: 1, registry: Infinity, dismiss: 1,
  undismiss: 1, dismissed: 0, rollback: 1, config: 3, doctor: 1, setup: 1, mcp: 0, hook: 1,
};

/** Which options each command accepts (besides help/format/no-color). */
const ALLOWED: Record<string, string[]> = {
  scan: ['task'],
  recommend: ['task', 'host', 'all', 'limit', 'min-score'],
  explain: ['host', 'task'],
  install: ['host', 'scope', 'access', 'param', 'name', 'dry-run', 'yes', 'force', 'verify'],
  try: ['host', 'param', 'access'],
  status: ['host'],
  check: ['host', 'strict'],
  registry: ['kind', 'remote', 'legacy'],
  dismiss: ['for', 'project', 'reason'],
  undismiss: [],
  dismissed: [],
  rollback: ['yes', 'force'],
  config: [],
  doctor: [],
  setup: ['dry-run', 'yes'],
  mcp: [],
  hook: ['host'],
};

function makeIO(color: boolean): IO {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    out: (s) => process.stdout.write(s + '\n'),
    err: (s) => process.stderr.write(s + '\n'),
    interactive,
    color,
    env: process.env,
    platform: process.platform,
    cwd: process.cwd(),
    now: Date.now,
    confirm: async (question) => {
      if (!interactive) return false;
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = (await rl.question(question)).trim().toLowerCase();
        return answer === 'y' || answer === 'yes';
      } finally {
        rl.close();
      }
    },
  };
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\nRun stackhint --help for usage.\n`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  if (v.version) {
    process.stdout.write(VERSION + '\n');
    return 0;
  }
  const command = positionals[0];
  if (!command || v.help) {
    process.stdout.write(HELP + '\n');
    return command || v.help ? 0 : 2;
  }
  const allowed = ALLOWED[command];
  if (!allowed) {
    process.stderr.write(`Unknown command "${command}". Run stackhint --help.\n`);
    return 2;
  }
  const given = Object.keys(v).filter((k) => !['help', 'version', 'format', 'no-color'].includes(k) && v[k as keyof typeof v] !== undefined);
  const bad = given.filter((k) => !allowed.includes(k));
  if (bad.length) {
    process.stderr.write(`Option${bad.length > 1 ? 's' : ''} ${bad.map((b) => '--' + b).join(', ')} not valid for "${command}".\n`);
    return 2;
  }
  const io = makeIO(!v['no-color'] && useColor(process.stdout));
  const args = positionals.slice(1);
  if (v.format !== undefined && !['text', 'md', 'json'].includes(v.format)) {
    process.stderr.write('--format must be text, md or json\n');
    return 2;
  }
  if (args.length > (MAX_ARGS[command] ?? 0)) {
    process.stderr.write(`Unexpected argument "${args[MAX_ARGS[command] ?? 0]}" for "${command}". Run stackhint --help.\n`);
    return 2;
  }
  const format = v.format;
  const need = (n: number, usage: string): void => {
    if (args.length < n) throw new UsageError(`usage: stackhint ${usage}`);
  };

  try {
    switch (command) {
      case 'scan':
        return await cmdScan(io, { ...(args[0] ? { path: args[0] } : {}), ...(format ? { format } : {}), ...(v.task ? { task: v.task } : {}) });
      case 'recommend':
        return await cmdRecommend(io, {
          ...(args[0] ? { path: args[0] } : {}),
          ...(v.task ? { task: v.task } : {}),
          ...(v.host ? { host: v.host } : {}),
          ...(format ? { format } : {}),
          ...(v.limit ? { limit: v.limit } : {}),
          ...(v['min-score'] ? { minScore: v['min-score'] } : {}),
          ...(v.all ? { all: true } : {}),
        });
      case 'explain':
        need(1, 'explain <id> [path]');
        return await cmdExplain(io, { id: args[0] as string, ...(args[1] ? { path: args[1] } : {}), ...(v.host ? { host: v.host } : {}), ...(format ? { format } : {}), ...(v.task ? { task: v.task } : {}) });
      case 'install':
        need(1, 'install <id> --host <claude|codex> [path]');
        return await cmdInstall(io, {
          id: args[0] as string,
          ...(args[1] ? { path: args[1] } : {}),
          ...(v.host ? { host: v.host } : {}),
          ...(v.scope ? { scope: v.scope } : {}),
          ...(v.access ? { access: v.access } : {}),
          ...(v.param ? { param: v.param } : {}),
          ...(v.name ? { name: v.name } : {}),
          ...(v['dry-run'] ? { dryRun: true } : {}),
          ...(v.yes ? { yes: true } : {}),
          ...(v.force ? { force: true } : {}),
          ...(v.verify ? { verify: true } : {}),
          ...(format ? { format } : {}),
        });
      case 'try':
        need(1, 'try <id> --host <claude|codex> [path]');
        return await cmdTry(io, { id: args[0] as string, ...(args[1] ? { path: args[1] } : {}), ...(v.host ? { host: v.host } : {}), ...(v.param ? { param: v.param } : {}), ...(v.access ? { access: v.access } : {}), ...(format ? { format } : {}) });
      case 'status':
        return await cmdStatus(io, { ...(args[0] ? { path: args[0] } : {}), ...(v.host ? { host: v.host } : {}), ...(format ? { format } : {}) });
      case 'check':
        return await cmdCheck(io, { ...(args[0] ? { path: args[0] } : {}), ...(v.host ? { host: v.host } : {}), ...(format ? { format } : {}), ...(v.strict ? { strict: true } : {}) });
      case 'registry': {
        const sub = args[0];
        if (sub === 'search') {
          need(2, 'registry search <words>');
          return await cmdRegistrySearch(io, { query: args.slice(1).join(' '), ...(v.kind ? { kind: v.kind } : {}), ...(v.remote ? { remote: true } : {}), ...(format ? { format } : {}), ...(v.legacy ? { legacy: true } : {}) });
        }
        if ((sub === 'list' || sub === undefined) && v.remote) throw new UsageError('--remote works with registry search only');
        if (sub === 'list' || sub === undefined) return await cmdRegistryList(io, { ...(v.kind ? { kind: v.kind } : {}), ...(format ? { format } : {}), ...(v.legacy ? { legacy: true } : {}) });
        throw new UsageError('usage: stackhint registry search <words> | registry list');
      }
      case 'dismiss':
        need(1, 'dismiss <id> [--for 14d] [--project]');
        return await cmdDismiss(io, { id: args[0] as string, ...(v.for ? { for: v.for } : {}), ...(v.project ? { project: true } : {}), ...(v.reason ? { reason: v.reason } : {}), ...(format ? { format } : {}) });
      case 'undismiss':
        need(1, 'undismiss <id>');
        return await cmdUndismiss(io, { id: args[0] as string, ...(format ? { format } : {}) });
      case 'dismissed':
        return await cmdDismissed(io, format ? { format } : {});
      case 'rollback':
        return await cmdRollback(io, { ...(args[0] ? { id: args[0] } : {}), ...(v.yes ? { yes: true } : {}), ...(v.force ? { force: true } : {}), ...(format ? { format } : {}) });
      case 'config':
        return await cmdConfig(io, { ...(args[0] ? { action: args[0] } : {}), ...(args[1] ? { key: args[1] } : {}), ...(args[2] !== undefined ? { value: args[2] } : {}), ...(format ? { format } : {}) });
      case 'doctor':
        return await cmdDoctor(io, { ...(args[0] ? { path: args[0] } : {}), ...(format ? { format } : {}) });
      case 'setup':
        need(1, 'setup <claude|codex>');
        return await cmdSetup(io, { host: args[0] as string, ...(v['dry-run'] ? { dryRun: true } : {}), ...(v.yes ? { yes: true } : {}) });
      case 'mcp':
        await serveStdio({ cwd: process.cwd() });
        return 0;
      case 'hook': {
        const event = args[0];
        const input = await readStdinJson();
        const host = hasHost(v.host) ? v.host : undefined;
        const out = event === 'session-start' ? await sessionStartHook(input, host ? { host } : {}) : event === 'user-prompt' ? await userPromptHook(input, host ? { host } : {}) : undefined;
        if (event !== 'session-start' && event !== 'user-prompt') throw new UsageError('usage: stackhint hook <session-start|user-prompt>');
        if (out) process.stdout.write(out + '\n');
        return 0;
      }
      default:
        return 2;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n`);
      return 2;
    }
    process.stderr.write(`stackhint: ${(e as Error).message}\n`);
    if (process.env['STACKHINT_DEBUG']) process.stderr.write(String((e as Error).stack) + '\n');
    return 1;
  }
}

// Run when executed directly (not when imported by tests).
function isMain(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(invoked)).href;
  } catch {
    return false;
  }
}
if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`stackhint: ${(e as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}
