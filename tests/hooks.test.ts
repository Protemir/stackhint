import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { detectHost, sessionStartHook, userPromptHook } from '../src/hooks/hooks.ts';
import { Store } from '../src/state/store.ts';
import { fakeWhich, sandbox, writeFiles, type Sandbox } from './helpers.ts';

const boxes: Sandbox[] = [];
after(() => boxes.forEach((b) => b.cleanup()));

const JIRA_PROJECT = { 'README.md': 'Board: https://acme.atlassian.net/browse/SHOP-1', 'src/App.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>', 'src/a.cs': 'x' };

function setup(mode: 'manual' | 'balanced' | 'proactive', files: Record<string, string> = JIRA_PROJECT): { b: Sandbox; clock: { now: number } } {
  const b = sandbox(files);
  boxes.push(b);
  writeFiles(b.stackhome, { 'config.json': JSON.stringify({ mode }) });
  return { b, clock: { now: Date.parse('2026-10-20T09:00:00Z') } };
}

function deps(b: Sandbox, clock: { now: number }) {
  return { env: b.env, now: () => clock.now, host: 'claude' as const, which: fakeWhich({}) };
}

describe('SessionStart hook', () => {
  it('stays silent in manual mode and writes nothing', async () => {
    const { b, clock } = setup('manual');
    const out = await sessionStartHook({ cwd: b.project }, deps(b, clock));
    assert.equal(out, undefined);
    assert.equal(fs.existsSync(path.join(b.stackhome, 'state.json')), false);
  });

  it('balanced mode: emits a short additionalContext for high-value items, then respects cooldowns', async () => {
    const { b, clock } = setup('balanced');
    const out = await sessionStartHook({ cwd: b.project, source: 'startup' }, deps(b, clock));
    assert.ok(out, 'expected a suggestion');
    const json = JSON.parse(out);
    assert.equal(json.hookSpecificOutput.hookEventName, 'SessionStart');
    const text: string = json.hookSpecificOutput.additionalContext;
    assert.match(text, /Atlassian/);
    assert.match(text, /Do not install anything yourself/);
    assert.equal(json.systemMessage, undefined, 'balanced mode does not show a visible message');
    assert.ok(text.split('\n').filter((l) => l.startsWith('- ')).length <= 2);

    clock.now += 3_600_000; // an hour later
    assert.equal(await sessionStartHook({ cwd: b.project }, deps(b, clock)), undefined, 'project cooldown');
    clock.now += 2 * 86_400_000; // two days later
    assert.equal(await sessionStartHook({ cwd: b.project }, deps(b, clock)), undefined, 'item cooldown (14 days)');
    clock.now += 13 * 86_400_000;
    assert.ok(await sessionStartHook({ cwd: b.project }, deps(b, clock)), 'shown again after the item cooldown');
  });

  it('a new dependency breaks through the project cooldown', async () => {
    const { b, clock } = setup('balanced');
    assert.ok(await sessionStartHook({ cwd: b.project }, deps(b, clock)));
    clock.now += 3_600_000;
    writeFiles(b.project, { 'docker-compose.yml': 'services:\n  ch:\n    image: clickhouse/clickhouse-server:24\n', 'pkg/requirements.txt': 'clickhouse-connect\n' });
    const out = await sessionStartHook({ cwd: b.project }, deps(b, clock));
    assert.ok(out, 'new ClickHouse dependency should be suggested');
    assert.match(out, /ClickHouse/);
  });

  it('never suggests dismissed tools', async () => {
    const { b, clock } = setup('balanced');
    new Store(b.env, () => clock.now).dismiss('atlassian-rovo', {});
    new Store(b.env, () => clock.now).dismiss('microsoft-learn', {});
    const out = await sessionStartHook({ cwd: b.project }, deps(b, clock));
    assert.ok(!out || !/Atlassian|Microsoft Learn/.test(out), out);
  });

  it('proactive mode adds a visible one-line message', async () => {
    const { b, clock } = setup('proactive');
    const out = await sessionStartHook({ cwd: b.project }, deps(b, clock));
    assert.ok(out);
    assert.match(JSON.parse(out).systemMessage, /^stackhint: /);
  });

  it('never throws, even with corrupt state and config', async () => {
    const { b, clock } = setup('balanced');
    writeFiles(b.stackhome, { 'state.json': '{{{', 'config.json': '{"mode": 42}' });
    const out = await sessionStartHook({ cwd: path.join(b.project, 'missing-dir') }, deps(b, clock));
    assert.equal(out, undefined);
  });
});

describe('UserPromptSubmit hook', () => {
  it('only runs in proactive mode', async () => {
    const { b, clock } = setup('balanced');
    assert.equal(await userPromptHook({ cwd: b.project, prompt: 'review the PR', session_id: 's1' }, deps(b, clock)), undefined);
  });

  it('suggests a tool for the task once per session and never stores the prompt', async () => {
    const files = { '.github/workflows/ci.yml': 'on: push', 'README.md': 'x' };
    const { b, clock } = setup('proactive', files);
    // A full scan first (the prompt hook uses the cached project signals).
    await sessionStartHook({ cwd: b.project }, deps(b, clock));
    const prompt = 'please review PR #42 with the secret word PINEAPPLE';
    const out = await userPromptHook({ cwd: b.project, prompt, session_id: 's1' }, deps(b, clock));
    assert.ok(out, 'expected a task-driven suggestion');
    const json = JSON.parse(out);
    assert.equal(json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(json.hookSpecificOutput.additionalContext, /review|GitHub/i);
    assert.equal(await userPromptHook({ cwd: b.project, prompt: 'another PR review', session_id: 's1' }, deps(b, clock)), undefined, 'same task category, same session');
    const stored = fs.readdirSync(b.stackhome).map((f) => (fs.statSync(path.join(b.stackhome, f)).isFile() ? fs.readFileSync(path.join(b.stackhome, f), 'utf8') : '')).join('\n');
    assert.ok(!stored.includes('PINEAPPLE'), 'prompt text must never be written to disk');
  });

  it('ignores prompts without a task signal', async () => {
    const { b, clock } = setup('proactive');
    assert.equal(await userPromptHook({ cwd: b.project, prompt: 'thanks!', session_id: 's2' }, deps(b, clock)), undefined);
  });
});

describe('host detection', () => {
  it('detects Claude Code and Codex from the environment and transcript path', () => {
    assert.equal(detectHost({}, { CLAUDE_PROJECT_DIR: '/x' }), 'claude');
    assert.equal(detectHost({ transcript_path: 'C:\\Users\\me\\.claude\\projects\\x.jsonl' }, {}), 'claude');
    assert.equal(detectHost({ transcript_path: '/home/me/.codex/sessions/x.jsonl' }, {}), 'codex');
    assert.equal(detectHost({}, {}), undefined);
  });
});
