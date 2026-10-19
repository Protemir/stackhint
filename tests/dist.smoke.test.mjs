// Runs the built JavaScript (no TypeScript stripping), so it also works on Node 20.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'cli.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-dist-'));
const env = { ...process.env, STACKHINT_HOME: path.join(home, 'sh'), STACKHINT_TEST_HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'), NO_COLOR: '1' };

function run(args, input = '') {
  const r = spawnSync(process.execPath, [cli, ...args], { env, input, encoding: 'utf8', timeout: 60_000, cwd: home });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('dist build', () => {
  it('runs and reports its version', () => {
    const r = run(['--version']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
  });

  it('recommends for the demo project', () => {
    const r = run(['recommend', path.join(root, 'examples', 'dotnet-shop'), '--format', 'json', '--task', 'orders query is slow in postgres']);
    assert.equal(r.code, 0, r.err);
    const j = JSON.parse(r.out);
    assert.equal(j.recommendations[0].id, 'postgres-mcp-pro');
  });

  it('loads the registry next to dist', () => {
    const r = run(['registry', 'search', 'jira']);
    assert.match(r.out, /atlassian-rovo/);
  });

  it('serves MCP over stdio', async () => {
    const child = spawn(process.execPath, [cli, 'mcp'], { env, cwd: home, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    child.stdin.end();
    await new Promise((r) => child.on('close', r));
    const lines = out.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].result.serverInfo.name, 'stackhint');
    assert.ok(lines[1].result.tools.length >= 5);
  });
});
