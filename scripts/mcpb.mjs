// MCPB bundle and MCP Registry metadata, used by .github/workflows/publish.yml.
//   node scripts/mcpb.mjs stage <outDir>               -> <outDir>/stage (bundle contents + manifest.json)
//   node scripts/mcpb.mjs server-json <outDir> <tag>   -> <outDir>/server.json for the .mcpb in that release
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const [cmd, outArg, tag] = process.argv.slice(2);
if (!cmd || !outArg) {
  console.error('usage: mcpb.mjs stage <outDir> | server-json <outDir> <tag>');
  process.exit(2);
}
const out = path.resolve(outArg);
const NAME = 'io.github.Protemir/stackhint';
const bundleName = `stackhint-${pkg.version}.mcpb`;
const DESCRIPTION = 'Recommends MCP servers, plugins and skills for a repo, from what is actually in it.';

if (cmd === 'stage') {
  const stage = path.join(out, 'stage');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const p of ['dist', 'registry', 'skills']) fs.cpSync(path.join(root, p), path.join(stage, p), { recursive: true });
  for (const f of ['package.json', 'LICENSE', 'README.md']) fs.copyFileSync(path.join(root, f), path.join(stage, f));
  const manifest = {
    manifest_version: '0.3',
    name: 'stackhint',
    display_name: 'stackhint',
    version: pkg.version,
    description: DESCRIPTION,
    long_description:
      'stackhint reads a project (package files, docker compose, CI, Terraform, git history) and what Claude Code and Codex already have configured, then recommends MCP servers, plugins and skills that fit, citing the file behind each suggestion. As an MCP server it is read-only: it never installs anything, and plan_install only shows the exact config change. Pass the project folder as `path` in the tool calls.',
    author: { name: 'Protemir', url: 'https://github.com/Protemir' },
    repository: { type: 'git', url: 'https://github.com/Protemir/stackhint.git' },
    homepage: 'https://protemir.github.io/stackhint/',
    documentation: 'https://github.com/Protemir/stackhint#readme',
    support: 'https://github.com/Protemir/stackhint/issues',
    server: {
      type: 'node',
      entry_point: 'dist/cli.js',
      mcp_config: { command: 'node', args: ['${__dirname}/dist/cli.js', 'mcp'] },
    },
    tools: [
      { name: 'recommend_tools', description: 'Recommend MCP servers, plugins and skills for a project, with the evidence behind each.' },
      { name: 'explain_tool', description: 'Why a tool fits, what it can access, how it is set up.' },
      { name: 'search_tools', description: 'Search the curated registry.' },
      { name: 'tooling_status', description: 'What is already configured for Claude Code and Codex, and problems with it.' },
      { name: 'plan_install', description: 'Show the exact config change an install would make. Changes nothing.' },
    ],
    keywords: ['mcp', 'claude-code', 'codex', 'developer-tools', 'recommendations'],
    license: 'MIT',
    compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: '>=20.0.0' } },
  };
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`staged ${stage} for ${bundleName}`);
} else if (cmd === 'server-json') {
  if (!tag) throw new Error('server-json needs the release tag');
  const bundle = path.join(out, bundleName);
  const sha = createHash('sha256').update(fs.readFileSync(bundle)).digest('hex');
  const server = {
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    name: NAME,
    title: 'stackhint',
    description: DESCRIPTION,
    repository: { url: 'https://github.com/Protemir/stackhint', source: 'github' },
    websiteUrl: 'https://protemir.github.io/stackhint/',
    version: pkg.version,
    packages: [
      {
        registryType: 'mcpb',
        identifier: `https://github.com/Protemir/stackhint/releases/download/${tag}/${bundleName}`,
        fileSha256: sha,
        transport: { type: 'stdio' },
      },
    ],
  };
  fs.writeFileSync(path.join(out, 'server.json'), JSON.stringify(server, null, 2) + '\n');
  console.log(`server.json for ${bundleName} (${sha})`);
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}
