import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { checkConfig } from '../src/engine/check.ts';
import { readClaudeInventory } from '../src/hosts/claude.ts';
import { readCodexInventory } from '../src/hosts/codex.ts';
import { availabilityFor, primaryEntryFor, readInventory, serverMatchScore } from '../src/hosts/inventory.ts';
import { findEntry, loadRegistry } from '../src/registry/registry.ts';
import type { ConfiguredServer, RegistryEntry } from '../src/types.ts';
import { fakeWhich, sandbox, writeFiles, type Sandbox } from './helpers.ts';

const registry = loadRegistry();
const entry = (id: string): RegistryEntry => findEntry(registry, id) as RegistryEntry;
const boxes: Sandbox[] = [];
function box(files: Record<string, string> = {}): Sandbox {
  const b = sandbox(files);
  boxes.push(b);
  return b;
}
after(() => boxes.forEach((b) => b.cleanup()));

function claudeState(b: Sandbox, value: unknown): void {
  fs.writeFileSync(path.join(b.claudeDir, '.claude.json'), JSON.stringify(value, null, 2));
}

describe('Claude Code inventory', () => {
  it('reads user, local, project, plugin and managed servers', () => {
    const b = box({
      '.mcp.json': JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { 'X-MCP-Readonly': 'true' } }, old: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgres://localhost/db'] } } }),
      '.claude/settings.json': JSON.stringify({ disabledMcpjsonServers: ['old'] }),
    });
    // Windows-style key with forward slashes and different case must still match the project.
    const projectKey = process.platform === 'win32' ? b.project.replace(/\\/g, '/').toUpperCase() : b.project;
    claudeState(b, {
      numStartups: 3,
      oauthAccount: { emailAddress: 'someone@example.com' },
      mcpServers: { context7: { type: 'http', url: 'https://mcp.context7.com/mcp' } },
      projects: { [projectKey]: { mcpServers: { pg: { type: 'stdio', command: 'uvx', args: ['postgres-mcp@0.3.0', '--access-mode=restricted'], env: { DATABASE_URI: 'postgres://app:hunter2@db/app' } } } }, '/other/project': { mcpServers: { nope: { command: 'x' } } } },
    });
    // An enabled plugin whose MCP server sits in the plugin cache.
    fs.writeFileSync(path.join(b.claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'linear@claude-plugins-official': true, 'sentry@claude-plugins-official': false } }));
    writeFiles(path.join(b.claudeDir, 'plugins', 'cache', 'claude-plugins-official', 'linear', '1.0.0'), { '.mcp.json': JSON.stringify({ linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } }) });
    writeFiles(b.root, { 'managed/managed-mcp.json': JSON.stringify({ mcpServers: { corp: { type: 'http', url: 'https://mcp.corp.example/mcp' } } }) });
    writeFiles(b.claudeDir, { 'skills/release/SKILL.md': '---\nname: release-notes\ndescription: x\n---\nbody', 'commands/deploy.md': '# deploy' });

    const inv = readClaudeInventory(b.project, b.env);
    const by = (n: string): ConfiguredServer | undefined => inv.servers.find((s) => s.name === n);
    assert.equal(by('context7')?.scope, 'user');
    assert.equal(by('pg')?.scope, 'local');
    assert.equal(by('nope'), undefined, 'servers of other projects are not ours');
    assert.equal(by('github')?.scope, 'project');
    assert.equal(by('old')?.enabled, false, 'disabledMcpjsonServers respected');
    assert.equal(by('linear')?.viaPlugin, 'linear@claude-plugins-official');
    assert.equal(by('corp')?.scope, 'managed');
    assert.ok(inv.managedMcp);
    assert.deepEqual(by('pg')?.inlineSecrets, ['env.DATABASE_URI']);
    assert.equal(by('pg')?.settings['env.DATABASE_URI'], '***');
    assert.equal(by('github')?.settings['header.X-MCP-Readonly'], 'true');
    assert.ok(inv.plugins.some((p) => p.id === 'sentry@claude-plugins-official' && !p.enabled));
    assert.deepEqual(inv.skills.map((s) => s.name).sort(), ['deploy', 'release-notes']);
    assert.ok(!JSON.stringify(inv).includes('someone@example.com'), 'account data must not be copied');
    assert.ok(!JSON.stringify(inv).includes('hunter2'), 'secret values must not be kept');
  });

  it('finds plugin servers in a cloned marketplace and reads both .mcp.json shapes', () => {
    const b = box();
    fs.writeFileSync(path.join(b.claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'context7@claude-plugins-official': true } }));
    const mk = path.join(b.claudeDir, 'plugins', 'marketplaces', 'claude-plugins-official');
    writeFiles(mk, {
      '.claude-plugin/marketplace.json': JSON.stringify({ name: 'claude-plugins-official', plugins: [{ name: 'context7', source: './external_plugins/context7' }] }),
      'external_plugins/context7/.mcp.json': JSON.stringify({ mcpServers: { context7: { type: 'http', url: 'https://mcp.context7.com/mcp?client=claude-code-plugin' } } }),
    });
    const inv = readClaudeInventory(b.project, b.env);
    const s = inv.servers.find((x) => x.name === 'context7');
    assert.equal(s?.viaPlugin, 'context7@claude-plugins-official');
  });

  it('reports unreadable files instead of crashing', () => {
    const b = box({ '.mcp.json': '{ "mcpServers": { broken' });
    fs.writeFileSync(path.join(b.claudeDir, '.claude.json'), 'not json at all');
    const inv = readClaudeInventory(b.project, b.env);
    assert.equal(inv.servers.length, 0);
    assert.ok(inv.files.some((f) => f.kind.includes('.mcp.json') && f.error?.includes('invalid JSON')));
    assert.ok(inv.files.some((f) => f.kind.includes('state') && f.error));
  });
});

describe('Codex inventory', () => {
  it('reads servers, plugins and skills from config.toml', () => {
    const b = box({ '.codex/config.toml': '[mcp_servers.team]\ncommand = "npx"\nargs = ["-y", "mongodb-mcp-server@3.1.0", "--readOnly"]\n', '.agents/skills/repo-skill/SKILL.md': '---\nname: repo-skill\n---' });
    fs.writeFileSync(
      path.join(b.codexHome, 'config.toml'),
      `model = "x"
[projects.${JSON.stringify(b.project)}]
trust_level = "untrusted"

[mcp_servers.github]
url = "https://api.githubcopilot.com/mcp/"
bearer_token_env_var = "GITHUB_PAT"

[mcp_servers.old-pg]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-postgres"]
enabled = false

[plugins."figma@openai-curated"]
enabled = true
`,
    );
    writeFiles(path.join(b.codexHome, 'plugins', 'cache', 'openai-curated', 'figma', '2.0.0'), { '.mcp.json': JSON.stringify({ mcpServers: { figma: { type: 'streamable-http', url: 'https://mcp.figma.com/mcp' } } }) });
    writeFiles(b.home, { '.agents/skills/my-skill/SKILL.md': '---\nname: my-skill\n---' });
    const inv = readCodexInventory(b.project, b.env);
    const by = (n: string): ConfiguredServer | undefined => inv.servers.find((s) => s.name === n);
    assert.equal(by('github')?.transport, 'http');
    assert.equal(by('github')?.settings['bearer_token_env_var'], 'GITHUB_PAT');
    assert.equal(by('old-pg')?.enabled, false);
    assert.equal(by('figma')?.viaPlugin, 'figma@openai-curated');
    assert.equal(by('team')?.enabled, false, 'project config is ignored in untrusted projects');
    assert.equal(inv.projectTrusted, false);
    assert.ok(inv.warnings.some((w) => w.includes('trusted')));
    assert.deepEqual(inv.skills.map((s) => s.name).sort(), ['my-skill', 'repo-skill']);
  });

  it('reports invalid TOML', () => {
    const b = box();
    fs.writeFileSync(path.join(b.codexHome, 'config.toml'), '[mcp_servers.x\ncommand = 1');
    const inv = readCodexInventory(b.project, b.env);
    assert.ok(inv.files[0]?.error?.startsWith('invalid TOML'));
    assert.equal(inv.servers.length, 0);
  });
});

describe('matching configured servers to registry entries', () => {
  const server = (over: Partial<ConfiguredServer>): ConfiguredServer => ({ host: 'claude', name: 'x', scope: 'user', source: 's', transport: 'stdio', args: [], enabled: true, inlineSecrets: [], settings: {}, ...over });

  it('matches by URL, package and plugin, and weakly by name', () => {
    assert.ok(serverMatchScore(entry('github'), server({ url: 'https://api.githubcopilot.com/mcp/readonly', transport: 'http' })) >= 100);
    assert.ok(serverMatchScore(entry('kubernetes'), server({ command: 'npx', args: ['-y', 'kubernetes-mcp-server@latest'] })) >= 100);
    assert.equal(serverMatchScore(entry('github'), server({ name: 'GitHub', command: 'my-own-thing' })), 10);
    assert.equal(serverMatchScore(entry('github'), server({ name: 'notes', command: 'x' })), 0);
  });

  it('picks the most specific entry (legacy package beats the generic name)', () => {
    const legacy = server({ name: 'postgres', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgres://x'] });
    assert.equal(primaryEntryFor(registry.entries, legacy)?.entry.id, 'legacy-server-postgres');
    const pro = server({ name: 'postgres', command: 'uvx', args: ['postgres-mcp@0.3.0'] });
    assert.equal(primaryEntryFor(registry.entries, pro)?.entry.id, 'postgres-mcp-pro');
    const neonSse = server({ name: 'neon', transport: 'sse', url: 'https://mcp.neon.tech/sse' });
    assert.equal(primaryEntryFor(registry.entries, neonSse)?.entry.id, 'legacy-neon-local');
  });

  it('reports availability states per host', () => {
    const b = box({ '.mcp.json': JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' } } }) });
    fs.writeFileSync(path.join(b.claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'csharp-lsp@claude-plugins-official': false } }));
    const inv = readInventory(b.project, { env: b.env, which: fakeWhich({ gh: '/usr/bin/gh' }) });
    assert.equal(availabilityFor(entry('github'), inv, 'claude').state, 'configured');
    assert.equal(availabilityFor(entry('github'), inv, 'codex').state, 'not-configured');
    assert.equal(availabilityFor(entry('csharp-lsp'), inv, 'claude').state, 'disabled');
    assert.equal(availabilityFor(entry('csharp-lsp'), inv, 'codex').state, 'incompatible');
    assert.equal(availabilityFor(entry('gh-cli'), inv, 'codex').state, 'configured');
    // An unreadable config means "unknown", never "not configured".
    fs.writeFileSync(path.join(b.codexHome, 'config.toml'), '[[[');
    const inv2 = readInventory(b.project, { env: b.env, which: fakeWhich({}) });
    assert.equal(availabilityFor(entry('context7'), inv2, 'codex').state, 'unknown');
  });
});

describe('configuration review (check)', () => {
  it('flags archived servers, inline secrets, SSE, write access, duplicates and shadowing', () => {
    const b = box({
      '.mcp.json': JSON.stringify({
        mcpServers: {
          db: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'], env: { PGPASSWORD: 'supersecretpw1' } },
          github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789' } },
          gh2: { command: 'docker', args: ['run', '-i', '--rm', 'ghcr.io/github/github-mcp-server'] },
          linear: { type: 'sse', url: 'https://mcp.linear.app/sse' },
        },
      }),
    });
    claudeState(b, { mcpServers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { 'X-MCP-Readonly': 'true' } } } });
    const inv = readInventory(b.project, { env: b.env, which: fakeWhich({}) });
    const findings = checkConfig(registry, inv, ['claude', 'codex']);
    const codes = findings.map((f) => f.code);
    assert.ok(codes.includes('server-archived'));
    assert.ok(findings.some((f) => f.code === 'server-archived' && f.fix?.includes('postgres-mcp-pro')));
    assert.ok(codes.includes('security-note'), 'the read-only bypass is called out');
    const secrets = findings.filter((f) => f.code === 'inline-secret');
    assert.equal(secrets.length, 2);
    assert.ok(secrets.every((f) => f.severity === 'high'), 'project files are committed, so high severity');
    assert.ok(codes.includes('sse-transport'));
    assert.ok(findings.some((f) => f.code === 'write-access' && f.server === 'gh2'));
    assert.ok(!findings.some((f) => f.code === 'write-access' && f.server === 'github' && f.source?.endsWith('.claude.json')), 'read-only header recognised');
    assert.ok(codes.includes('duplicate-capability'));
    assert.ok(codes.includes('shadowed-server'));
    assert.equal(findings[0]?.severity, 'high', 'sorted by severity');
    assert.ok(!JSON.stringify(findings).includes('supersecretpw1'));
    assert.ok(!JSON.stringify(findings).includes('ghp_abcdefghijklmnop'));
  });

  it('a clean setup has no findings', () => {
    const b = box({ '.mcp.json': JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { 'X-MCP-Readonly': 'true', Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' } } } }) });
    const inv = readInventory(b.project, { env: b.env, which: fakeWhich({}) });
    assert.deepEqual(checkConfig(registry, inv, ['claude']), []);
  });
});
