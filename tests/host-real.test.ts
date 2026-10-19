// End-to-end checks against the real Claude Code and Codex CLIs, in throwaway config dirs.
// They run when the CLIs are on PATH and STACKHINT_REAL_HOSTS=1 (CI sets it); otherwise skipped.
// Nothing here touches the real user configuration.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { which } from '../src/util/exec.ts';
import { REPO, tmp } from './helpers.ts';

const ENABLED = process.env['STACKHINT_REAL_HOSTS'] === '1';
const CLI = path.join(REPO, 'dist', 'cli.js');
const dirs: string[] = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function exe(name: string): string | undefined {
  return ENABLED ? which(name) : undefined;
}

function sh(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): { code: number; out: string; err: string } {
  const isBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  const r = isBatch
    ? spawnSync(`"${cmd}" ${args.map((a) => `"${a}"`).join(' ')}`, { env, cwd, encoding: 'utf8', timeout: 120_000, shell: true })
    : spawnSync(cmd, args, { env, cwd, encoding: 'utf8', timeout: 120_000 });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function world() {
  const root = tmp('sh-real-');
  dirs.push(root);
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    STACKHINT_HOME: path.join(home, '.stackhint'),
    STACKHINT_TEST_HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    NO_COLOR: '1',
  };
  const stackhint = (...args: string[]) => sh(process.execPath, [CLI, ...args], env, project);
  return { root, project, home, env, stackhint };
}

describe('real Claude Code', () => {
  const claude = exe('claude');

  it('validates the stackhint plugin and marketplace', { skip: !claude && 'claude not available' }, () => {
    const w = world();
    for (const target of [REPO, path.join(REPO, '.claude-plugin', 'plugin.json')]) {
      const r = sh(claude as string, ['plugin', 'validate', target, '--strict'], w.env, w.project);
      assert.equal(r.code, 0, r.out + r.err);
    }
  });

  it('installs to project, local and user scope and rolls back', { skip: !claude && 'claude not available' }, () => {
    const w = world();
    const steps: Array<[string[], string, RegExp]> = [
      [['install', 'github', '--host', 'claude', '--scope', 'project', '--yes'], 'github', /X-MCP-Readonly: true/],
      [['install', 'context7', '--host', 'claude', '--scope', 'user', '--yes'], 'context7', /mcp\.context7\.com/],
      [['install', 'kubernetes', '--host', 'claude', '--scope', 'local', '--yes'], 'kubernetes', /kubernetes-mcp-server@0\.0\.67/],
      [['install', 'linear', '--host', 'claude', '--scope', 'local', '--yes'], 'linear', /mcp\.linear\.app\/mcp\/readonly/],
    ];
    for (const [args, name, expected] of steps) {
      const r = w.stackhint(...args);
      assert.equal(r.code, 0, `${args.join(' ')}\n${r.out}\n${r.err}`);
      const get = sh(claude as string, ['mcp', 'get', name], w.env, w.project);
      assert.match(get.out + get.err, expected, `claude mcp get ${name}`);
    }
    const list = w.stackhint('rollback');
    const ids = [...list.out.matchAll(/^\s+(\d{8}-\d{6}-\S+)/gm)].map((m) => m[1] as string);
    assert.equal(ids.length, 4, list.out);
    for (const id of ids) assert.equal(w.stackhint('rollback', id, '--yes').code, 0);
    const after = sh(claude as string, ['mcp', 'list'], w.env, w.project);
    assert.match(after.out, /No MCP servers configured/);
  });
});

describe('real Codex', () => {
  const codex = exe('codex');

  it('reads every server shape stackhint writes', { skip: !codex && 'codex not available' }, () => {
    const w = world();
    const installs: string[][] = [
      ['install', 'github', '--host', 'codex', '--yes'],
      ['install', 'postgres-mcp-pro', '--host', 'codex', '--yes'],
      ['install', 'argocd', '--host', 'codex', '--yes'],
      ['install', 'azure-devops', '--host', 'codex', '--param', 'organization=acme', '--yes'],
      ['install', 'aws-mcp', '--host', 'codex', '--yes'],
      ['install', 'jenkins', '--host', 'codex', '--param', 'jenkinsUrl=https://ci.example.com', '--yes'],
    ];
    // A user config with existing content must survive untouched.
    const userCfg = path.join(w.home, '.codex', 'config.toml');
    fs.writeFileSync(userCfg, '# mine\nmodel = "gpt-5.5"\n\n[mcp_servers.existing]\ncommand = "echo"\nargs = ["hi"]\n');
    const original = fs.readFileSync(userCfg, 'utf8');
    for (const args of installs) {
      const r = w.stackhint(...args);
      assert.equal(r.code, 0, `${args.join(' ')}\n${r.out}\n${r.err}`);
    }
    assert.ok(fs.readFileSync(userCfg, 'utf8').startsWith(original));
    const list = sh(codex as string, ['mcp', 'list', '--json'], w.env, w.project);
    assert.equal(list.code, 0, list.err);
    const servers = JSON.parse(list.out) as Array<{ name: string; transport: { type: string } }>;
    const byName = new Map(servers.map((s) => [s.name, s]));
    for (const n of ['existing', 'github', 'postgres', 'argocd', 'azure-devops', 'aws-mcp', 'jenkins']) assert.ok(byName.has(n), `codex does not list ${n}: ${list.out}`);
    assert.equal(byName.get('github')?.transport.type, 'streamable_http');
    assert.equal(byName.get('postgres')?.transport.type, 'stdio');
    const gh = sh(codex as string, ['mcp', 'get', 'github', '--json'], w.env, w.project);
    assert.match(gh.out, /GITHUB_PERSONAL_ACCESS_TOKEN/);
    assert.match(gh.out, /X-MCP-Readonly/);
  });

  it('accepts the one-off `try` overrides', { skip: !codex && 'codex not available' }, () => {
    const w = world();
    const r = w.stackhint('try', 'linear', '--host', 'codex');
    const m = /codex (.+)$/m.exec(r.out);
    assert.ok(m, r.out);
    const args = [...(m[1] as string).matchAll(/-c '([^']+)'/g)].flatMap((x) => ['-c', x[1] as string]);
    const list = sh(codex as string, [...args, 'mcp', 'list', '--json'], w.env, w.project);
    assert.equal(list.code, 0, list.err);
    assert.ok((JSON.parse(list.out) as Array<{ name: string }>).some((s) => s.name === 'linear'), list.out);
  });

  it('adds the stackhint marketplace', { skip: !codex && 'codex not available' }, () => {
    const w = world();
    const add = sh(codex as string, ['plugin', 'marketplace', 'add', REPO], w.env, w.project);
    assert.equal(add.code, 0, add.out + add.err);
    const list = sh(codex as string, ['plugin', 'list', '--available', '--json'], w.env, w.project);
    assert.match(list.out + list.err, /stackhint/);
  });
});
