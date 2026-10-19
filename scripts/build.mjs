// Zero-dependency build: strip TypeScript types with Node's built-in stripper and
// rewrite relative ".ts" imports to ".js". Output is deterministic, so CI can check
// that the committed dist/ matches the sources (`node scripts/build.mjs --check`).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nodeModule from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const out = path.join(root, 'dist');
const check = process.argv.includes('--check');

const strip = nodeModule.stripTypeScriptTypes;
if (typeof strip !== 'function') {
  console.error('This build needs Node.js 22.13+ (module.stripTypeScriptTypes).');
  process.exit(1);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

function compile(file) {
  const code = fs.readFileSync(file, 'utf8');
  let js = strip(code, { mode: 'strip' });
  // Relative imports: './x.ts' -> './x.js'
  js = js.replace(/(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+?)\.ts\2/g, '$1$2$3.js$2');
  // Strip leaves runs of spaces where types were; trim trailing whitespace for tidier output.
  js = js.replace(/[ \t]+$/gm, '');
  return js.replace(/\r\n/g, '\n');
}

const files = walk(src).sort();
const expected = new Map();
for (const f of files) {
  const rel = path.relative(src, f).replace(/\.ts$/, '.js');
  expected.set(rel.split(path.sep).join('/'), compile(f));
}

if (check) {
  let bad = 0;
  for (const [rel, js] of expected) {
    const p = path.join(out, rel);
    const current = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    if (current !== js) {
      console.error(`dist/${rel} is out of date`);
      bad++;
    }
  }
  const extra = fs.existsSync(out)
    ? walkJs(out).filter((p) => !expected.has(path.relative(out, p).split(path.sep).join('/')))
    : [];
  for (const p of extra) {
    console.error(`dist/${path.relative(out, p)} has no source`);
    bad++;
  }
  if (bad) {
    console.error('Run `npm run build` and commit dist/.');
    process.exit(1);
  }
  console.log(`dist/ is up to date (${expected.size} files).`);
} else {
  fs.rmSync(out, { recursive: true, force: true });
  for (const [rel, js] of expected) {
    const p = path.join(out, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, js);
  }
  if (process.platform !== 'win32') fs.chmodSync(path.join(out, 'cli.js'), 0o755);
  console.log(`built ${expected.size} files into dist/`);
}

function walkJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walkJs(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}
