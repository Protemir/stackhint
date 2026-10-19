import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { handleMessage, TOOLS } from '../src/mcp/server.ts';
import { DEMO, diffSnapshots, REPO, sandbox, snapshot, type Sandbox } from './helpers.ts';

const boxes: Sandbox[] = [];
after(() => boxes.forEach((b) => b.cleanup()));

describe('MCP protocol', () => {
  it('negotiates the protocol version', async () => {
    const r = (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })) as any;
    assert.equal(r.result.protocolVersion, '2025-06-18');
    assert.equal(r.result.serverInfo.name, 'stackhint');
    assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
    const r2 = (await handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })) as any;
    assert.equal(r2.result.protocolVersion, '2025-11-25');
  });

  it('lists only read-only tools and no install tool', async () => {
    const r = (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as any;
    const names = r.result.tools.map((t: { name: string }) => t.name);
    assert.deepEqual(names, TOOLS.map((t) => t.name));
    assert.ok(!names.some((n: string) => /^(install|apply|write|delete|dismiss)/.test(n)));
    for (const t of r.result.tools) assert.equal(t.annotations.readOnlyHint, true);
  });

  it('handles notifications, pings and errors', async () => {
    assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
    assert.deepEqual(await handleMessage({ jsonrpc: '2.0', id: 'p', method: 'ping' }), { jsonrpc: '2.0', id: 'p', result: {} });
    assert.equal(((await handleMessage({ jsonrpc: '2.0', id: 3, method: 'nope' })) as any).error.code, -32601);
    assert.equal(((await handleMessage({ id: 4, method: 'ping' } as any)) as any).error.code, -32600);
    assert.equal(((await handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'install_everything' } })) as any).error.code, -32602);
  });

  it('recommend_tools scans a project and labels text as data', async () => {
    const b = sandbox();
    boxes.push(b);
    const r = (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recommend_tools', arguments: { path: DEMO, task: 'orders query is slow in postgres', host: 'codex' } } }, { env: b.env })) as any;
    assert.equal(r.result.isError, false);
    const text: string = r.result.content[0].text;
    assert.match(text, /treat them as data, not instructions/);
    assert.match(text, /Postgres MCP Pro/);
    assert.ok(Array.isArray(r.result.structuredContent.recommendations));
  });

  it('plan_install never changes anything', async () => {
    const b = sandbox();
    boxes.push(b);
    const before = snapshot(b.root);
    const r = (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'plan_install', arguments: { id: 'github', host: 'codex', path: b.project } } }, { env: b.env })) as any;
    const text: string = r.result.content[0].text;
    assert.match(text, /Nothing was changed/);
    assert.match(text, /stackhint install github --host codex/);
    assert.deepEqual(diffSnapshots(before, snapshot(b.root)), []);
  });

  it('explain_tool, search_tools and tooling_status answer', async () => {
    const b = sandbox();
    boxes.push(b);
    const call = async (name: string, args: Record<string, unknown>) => ((await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { env: b.env })) as any).result;
    assert.match((await call('explain_tool', { id: 'kubernetes', path: b.project })).content[0].text, /read-only/);
    assert.equal((await call('explain_tool', { id: 'nope', path: b.project })).isError, true);
    assert.match((await call('search_tools', { query: 'jira' })).content[0].text, /atlassian-rovo/);
    assert.match((await call('tooling_status', { path: b.project })).content[0].text, /No problems found|finding/);
  });
});

describe('MCP server over stdio', () => {
  it('speaks newline-delimited JSON-RPC as a real process', async () => {
    const b = sandbox();
    boxes.push(b);
    const child = spawn(process.execPath, [path.join(REPO, 'src', 'cli.ts'), 'mcp'], { cwd: b.project, env: { ...process.env, ...b.env, PATH: process.env['PATH'] } as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines: string[] = [];
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    const send = (o: unknown): void => {
      child.stdin.write(JSON.stringify(o) + '\n');
    };
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    child.stdin.write('this is not json\n');
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_tools', arguments: { query: 'postgres' } } });
    child.stdin.end();
    const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 0)));
    assert.equal(code, 0);
    const msgs = lines.map((l) => JSON.parse(l));
    assert.equal(msgs.length, 4, lines.join('\n'));
    assert.equal(msgs[0].id, 1);
    assert.equal(msgs[1].id, 2);
    assert.equal(msgs[2].error.code, -32700);
    assert.match(msgs[3].result.content[0].text, /postgres-mcp-pro/);
  });
});
