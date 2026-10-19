import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { DEMO, diffSnapshots, REPO, sandbox, snapshot, writeFiles, type Sandbox } from './helpers.ts';

const CLI = path.join(REPO, 'src', 'cli.ts');
const boxes: Sandbox[] = [];
after(() => boxes.forEach((b) => b.cleanup()));

function box(files: Record<string, string> = {}): Sandbox {
  const b = sandbox(files);
  boxes.push(b);
  return b;
}

function cli(b: Sandbox, args: string[], input?: string): { code: number; out: string; err: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: b.project,
    env: { ...b.env, PATH: process.env['PATH'], NO_COLOR: '1' } as NodeJS.ProcessEnv,
    input: input ?? '',
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: res.status ?? -1, out: res.stdout, err: res.stderr };
}

describe('CLI basics', () => {
  it('prints help and version', () => {
    const b = box();
    assert.match(cli(b, ['--help']).out, /Usage: stackhint <command>/);
    assert.match(cli(b, ['--version']).out, /^\d+\.\d+\.\d+/);
    assert.equal(cli(b, []).code, 2);
  });
  it('rejects unknown commands and options with exit code 2', () => {
    const b = box();
    assert.equal(cli(b, ['frobnicate']).code, 2);
    assert.equal(cli(b, ['recommend', '--bogus']).code, 2);
    const r = cli(b, ['scan', '--yes']);
    assert.equal(r.code, 2);
    assert.match(r.err, /--yes not valid for "scan"/);
    assert.equal(cli(b, ['recommend', '--format', 'xml']).code, 2);
    assert.equal(cli(b, ['explain']).code, 2);
  });
});

describe('CLI commands', () => {
  it('scan and recommend produce valid JSON', () => {
    const b = box();
    const scan = cli(b, ['scan', DEMO, '--format', 'json']);
    assert.equal(scan.code, 0, scan.err);
    const s = JSON.parse(scan.out);
    assert.ok(s.signals['db:postgres']);
    const rec = cli(b, ['recommend', DEMO, '--format', 'json', '--host', 'codex', '--task', 'slow postgres query']);
    assert.equal(rec.code, 0, rec.err);
    const r = JSON.parse(rec.out);
    assert.deepEqual(r.hosts, ['codex']);
    assert.equal(r.recommendations[0].id, 'postgres-mcp-pro');
    assert.match(r.note, /heuristic/);
  });

  it('recommend --format md is Markdown and explain shows the exact config', () => {
    const b = box();
    const md = cli(b, ['recommend', DEMO, '--format', 'md']);
    assert.match(md.out, /^## stackhint: tools for/m);
    assert.match(md.out, /\*\*Why now:\*\*/);
    const ex = cli(b, ['explain', 'github', '--host', 'codex']);
    assert.equal(ex.code, 0, ex.err);
    assert.match(ex.out, /\[mcp_servers\.github\]/);
    assert.match(ex.out, /bearer_token_env_var = "GITHUB_PERSONAL_ACCESS_TOKEN"/);
    const unknown = cli(b, ['explain', 'githb']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /Did you mean: .*github/);
  });

  it('registry search and list', () => {
    const b = box();
    assert.match(cli(b, ['registry', 'search', 'kubernetes']).out, /kubernetes/);
    const list = cli(b, ['registry', 'list', '--kind', 'plugin']);
    assert.match(list.out, /csharp-lsp/);
    assert.doesNotMatch(list.out, /postgres-mcp-pro/);
    assert.match(cli(b, ['registry', 'search', 'puppeteer', '--legacy']).out, /legacy-server-puppeteer/);
  });

  it('remote search refuses without network consent', () => {
    const b = box();
    const r = cli(b, ['registry', 'search', 'github', '--remote']);
    assert.equal(r.code, 3);
    assert.match(r.err, /config set network true/);
  });

  it('install without a terminal and without --yes changes nothing', () => {
    const b = box();
    const before = snapshot(b.root);
    const r = cli(b, ['install', 'context7', '--host', 'claude', '--scope', 'project']);
    assert.equal(r.code, 3, r.out + r.err);
    assert.match(r.out, /Install plan: Context7/);
    assert.match(r.err, /No terminal to confirm/);
    const changes = diffSnapshots(before, snapshot(b.root)).filter((c) => !c.includes('audit.log'));
    assert.deepEqual(changes, []);
  });

  it('install --dry-run shows the diff and changes nothing', () => {
    const b = box();
    const before = snapshot(b.root);
    const r = cli(b, ['install', 'github', '--host', 'codex', '--dry-run']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\+ \[mcp_servers\.github\]/);
    assert.match(r.out, /Dry run: nothing was changed/);
    assert.deepEqual(diffSnapshots(before, snapshot(b.root)), []);
  });

  it('install --yes applies, rollback undoes', () => {
    const b = box();
    const r = cli(b, ['install', 'kubernetes', '--host', 'codex', '--yes']);
    assert.equal(r.code, 0, r.out + r.err);
    const cfg = fs.readFileSync(path.join(b.codexHome, 'config.toml'), 'utf8');
    assert.match(cfg, /kubernetes-mcp-server@0\.0\.67/);
    assert.match(cfg, /--read-only/);
    const id = [...r.out.matchAll(/stackhint rollback (\d{8}-\S+)/g)].pop()?.[1];
    assert.ok(id, r.out);
    assert.match(cli(b, ['rollback']).out, new RegExp(id));
    const rb = cli(b, ['rollback', id, '--yes']);
    assert.equal(rb.code, 0, rb.err);
    assert.equal(fs.existsSync(path.join(b.codexHome, 'config.toml')), false);
  });

  it('install of a blocked entry exits 4', () => {
    const b = box();
    const r = cli(b, ['install', 'legacy-server-postgres', '--host', 'claude', '--scope', 'project', '--yes']);
    assert.equal(r.code, 4);
    assert.match(r.out, /Blocked/);
  });

  it('try writes only a temp file in stackhint home', () => {
    const b = box();
    const before = snapshot(b.project);
    const r = cli(b, ['try', 'context7', '--host', 'claude']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /claude --mcp-config/);
    assert.ok(fs.existsSync(path.join(b.stackhome, 'try', 'context7.mcp.json')));
    assert.deepEqual(diffSnapshots(before, snapshot(b.project)), []);
    const c = cli(b, ['try', 'linear', '--host', 'codex']);
    assert.match(c.out, /codex -c 'mcp_servers\.linear\.url="https:\/\/mcp\.linear\.app\/mcp\/readonly"'/);
  });

  it('dismiss, dismissed, undismiss', () => {
    const b = box();
    assert.match(cli(b, ['dismiss', 'github', '--for', '14d']).out, /hidden until/);
    assert.match(cli(b, ['dismissed']).out, /github: until/);
    assert.equal(cli(b, ['dismiss', 'github', '--for', 'soon']).code, 2);
    assert.match(cli(b, ['undismiss', 'github']).out, /can be suggested again/);
    assert.equal(cli(b, ['dismiss', 'not-a-tool']).code, 1);
  });

  it('config show/set validates values', () => {
    const b = box();
    assert.equal(cli(b, ['config', 'set', 'mode', 'proactive']).code, 0);
    assert.equal(cli(b, ['config', 'get', 'mode']).out.trim(), 'proactive');
    assert.equal(cli(b, ['config', 'set', 'mode', 'loud']).code, 2);
    assert.equal(cli(b, ['config', 'set', 'minScore', '500']).code, 2);
    assert.equal(cli(b, ['config', 'set', 'nope', '1']).code, 2);
    assert.match(cli(b, ['config']).out, /"mode": "proactive"/);
  });

  it('status and check --strict', () => {
    const b = box({ '.mcp.json': JSON.stringify({ mcpServers: { pg: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] } } }) });
    const st = cli(b, ['status', '--host', 'claude']);
    assert.match(st.out, /pg \[project\] stdio/);
    const ok = cli(b, ['check']);
    assert.equal(ok.code, 0);
    assert.match(ok.out, /HIGH/);
    assert.equal(cli(b, ['check', '--strict']).code, 1);
    const json = JSON.parse(cli(b, ['check', '--format', 'json']).out);
    assert.ok(json.findings.some((f: { code: string }) => f.code === 'server-archived'));
  });

  it('doctor reports problems', () => {
    const b = box();
    writeFiles(b.codexHome, { 'config.toml': '[broken' });
    const r = cli(b, ['doctor']);
    assert.equal(r.code, 1);
    assert.match(r.out, /FIX .*config\.toml/);
  });

  it('hook command reads stdin JSON and stays quiet in manual mode', () => {
    const b = box({ 'README.md': 'https://acme.atlassian.net/browse/A-1' });
    writeFiles(b.stackhome, { 'config.json': '{"mode":"manual"}' });
    const quiet = cli(b, ['hook', 'session-start'], JSON.stringify({ cwd: b.project, source: 'startup' }));
    assert.equal(quiet.code, 0);
    assert.equal(quiet.out, '');
    writeFiles(b.stackhome, { 'config.json': '{"mode":"balanced"}' });
    const loud = cli(b, ['hook', 'session-start', '--host', 'codex'], JSON.stringify({ cwd: b.project }));
    assert.equal(loud.code, 0);
    assert.equal(JSON.parse(loud.out).hookSpecificOutput.hookEventName, 'SessionStart');
  });
});
