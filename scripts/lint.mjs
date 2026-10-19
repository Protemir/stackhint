// Small dependency-free lint: formatting basics and a few project rules.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

function walk(dir, exts) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return ['node_modules', 'dist', '.git'].includes(e.name) ? [] : walk(p, exts);
    return exts.some((x) => e.name.endsWith(x)) ? [p] : [];
  });
}

const rel = (p) => path.relative(root, p).split(path.sep).join('/');

for (const file of [...walk(path.join(root, 'src'), ['.ts']), ...walk(path.join(root, 'tests'), ['.ts', '.mjs']), ...walk(path.join(root, 'scripts'), ['.mjs'])]) {
  const text = fs.readFileSync(file, 'utf8');
  const r = rel(file);
  if (text.includes('\r\n')) problems.push(`${r}: CRLF line endings`);
  if (!text.endsWith('\n')) problems.push(`${r}: missing final newline`);
  text.split('\n').forEach((line, i) => {
    if (/[ \t]+$/.test(line)) problems.push(`${r}:${i + 1}: trailing whitespace`);
    if (/^\t/.test(line)) problems.push(`${r}:${i + 1}: tab indentation`);
  });
  if (r.startsWith('src/')) {
    if (/\bconsole\.(log|debug)\(/.test(text)) problems.push(`${r}: console.log in src (use the IO helpers)`);
    if (/:\s*any\b|as any\b/.test(text)) problems.push(`${r}: "any" in src`);
    for (const m of text.matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
      if (!m[1].endsWith('.ts')) problems.push(`${r}: relative import without .ts extension: ${m[1]}`);
    }
    if (/\benum\s+\w+|\bnamespace\s+\w+/.test(text)) problems.push(`${r}: non-erasable TypeScript syntax (enum/namespace)`);
  }
  if (r.startsWith('tests/') && /\b(it|describe|test)\.only\(/.test(text)) problems.push(`${r}: .only left in a test`);
}

for (const file of ['package.json', 'tsconfig.json', 'registry/registry.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json', 'hooks/hooks.json']) {
  try {
    JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  } catch (e) {
    problems.push(`${file}: ${e.message}`);
  }
}

// Versions must agree.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const plugin = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8'));
const market = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/marketplace.json'), 'utf8'));
const versionTs = fs.readFileSync(path.join(root, 'src/version.ts'), 'utf8');
if (plugin.version !== pkg.version) problems.push(`plugin.json version ${plugin.version} != package.json ${pkg.version}`);
if (market.plugins[0].version !== pkg.version) problems.push(`marketplace.json version ${market.plugins[0].version} != package.json ${pkg.version}`);
if (!versionTs.includes(`'${pkg.version}'`)) problems.push(`src/version.ts does not match package.json ${pkg.version}`);

if (problems.length) {
  for (const p of problems) console.error(p);
  console.error(`${problems.length} lint problem${problems.length === 1 ? '' : 's'}`);
  process.exit(1);
}
console.log('lint ok');
