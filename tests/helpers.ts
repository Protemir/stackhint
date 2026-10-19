import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IO } from '../src/commands.ts';
import type { GitInfo } from '../src/types.ts';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEMO = path.join(REPO, 'examples', 'dotnet-shop');
export const NO_GIT: GitInfo = { isRepo: false, remotes: [], branches: [], recentSubjects: [] };

export function tmp(prefix = 'sh-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

export interface Sandbox {
  root: string;
  home: string;
  project: string;
  stackhome: string;
  claudeDir: string;
  codexHome: string;
  env: Record<string, string | undefined>;
  cleanup(): void;
}

/** An isolated machine: fake home, Claude/Codex config dirs, stackhint home and a project dir. */
export function sandbox(projectFiles: Record<string, string> = {}): Sandbox {
  const root = tmp('sh-sbx-');
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const stackhome = path.join(root, 'stackhint-home');
  const claudeDir = path.join(home, '.claude');
  const codexHome = path.join(home, '.codex');
  for (const d of [home, project, claudeDir, codexHome]) fs.mkdirSync(d, { recursive: true });
  writeFiles(project, projectFiles);
  const env: Record<string, string | undefined> = {
    PATH: path.join(root, 'bin'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    STACKHINT_HOME: stackhome,
    STACKHINT_TEST_HOME: home,
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: codexHome,
    STACKHINT_CLAUDE_MANAGED_DIR: path.join(root, 'managed'),
    SystemRoot: process.env['SystemRoot'],
  };
  return { root, home, project, stackhome, claudeDir, codexHome, env, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Hash of every file under a directory, for "nothing changed" assertions. */
export function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.set(path.relative(dir, p), createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}

export function diffSnapshots(a: Map<string, string>, b: Map<string, string>): string[] {
  const changes: string[] = [];
  for (const [k, v] of a) if (b.get(k) !== v) changes.push(b.has(k) ? `changed ${k}` : `deleted ${k}`);
  for (const k of b.keys()) if (!a.has(k)) changes.push(`added ${k}`);
  return changes;
}

export interface CapturedIO extends IO {
  stdout: string[];
  stderr: string[];
  asked: string[];
  text(): string;
}

export function captureIO(env: Record<string, string | undefined>, cwd: string, opts: { interactive?: boolean; answer?: boolean; which?: (n: string) => string | undefined; now?: () => number } = {}): CapturedIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const asked: string[] = [];
  return {
    stdout,
    stderr,
    asked,
    text: () => stdout.join('\n'),
    out: (s) => stdout.push(s),
    err: (s) => stderr.push(s),
    confirm: async (q) => {
      asked.push(q);
      return opts.answer ?? false;
    },
    interactive: opts.interactive ?? false,
    color: false,
    env,
    platform: process.platform,
    cwd,
    now: opts.now ?? Date.now,
    which: opts.which ?? (() => undefined),
  };
}

/** A `which` that only knows the given executables. */
export function fakeWhich(found: Record<string, string>): (n: string) => string | undefined {
  return (n) => found[n];
}
