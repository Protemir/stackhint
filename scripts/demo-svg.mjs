// Renders a terminal-style SVG of real `stackhint recommend` output on examples/dotnet-shop.
// node scripts/demo-svg.mjs  ->  docs/demo.svg
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demo = path.join(root, 'examples', 'dotnet-shop');
// A clean machine: no personal config, no tools on PATH, so the output is the same everywhere.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-demo-'));
const env = {
  ...process.env,
  PATH: path.dirname(process.execPath),
  STACKHINT_HOME: path.join(home, 'state'),
  STACKHINT_TEST_HOME: home,
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  CODEX_HOME: path.join(home, '.codex'),
  NO_COLOR: '1',
};
const task = 'orders query is slow';
const raw = execFileSync(process.execPath, [path.join(root, 'src', 'cli.ts'), 'recommend', '--task', task, '--host', 'claude', '--limit', '3'], { cwd: demo, env, encoding: 'utf8' });
fs.rmSync(home, { recursive: true, force: true });

// The header and three recommendations: why, what it may access and how to install for the
// first one, only the headline and the reason for the others.
const lines = [];
let rec = 0;
let section = '';
for (const l of raw.replace(/\r/g, '').split('\n')) {
  if (/^\d+\. /.test(l)) rec++;
  if (/^(Scores are heuristic|Already set up)/.test(l)) break;
  const head = /^([A-Z][A-Za-z ]+):/.exec(l)?.[1];
  if (head) section = head;
  const keep =
    !rec ||
    /^\d+\. /.test(l) ||
    l.startsWith('Why now:') ||
    l.trim() === '' ||
    (rec === 1 && (section === 'Permissions' || (section === 'Actions' && (l === 'Actions:' || / - stackhint (install|try) /.test(l)))));
  if (keep) lines.push(l.replace(demo, '~/src/dotnet-shop').replace(/\\/g, '/'));
}
while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
const shown = [`$ npx -y github:Protemir/stackhint recommend --task "${task}"`, ...lines];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const wrap = (s, n) => {
  const out = [];
  let rest = s;
  while (rest.length > n) {
    let cut = rest.lastIndexOf(' ', n);
    if (cut < n * 0.6) cut = n;
    out.push(rest.slice(0, cut));
    rest = '    ' + rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out;
};
const COLS = 96;
const rows = shown.flatMap((l) => wrap(l, COLS).map((t) => ({ t, src: l })));
const lineH = 19;
const top = 46;
const width = 940;
const height = top + rows.length * lineH + 22;
const color = (src, t) => {
  if (src.startsWith('$ ')) return '#e6edf3';
  if (/^\d+\. /.test(src)) return t === src || src.startsWith(t) ? '#79c0ff' : '#79c0ff';
  if (src.startsWith('Why now:')) return '#d2a8ff';
  if (/^(Detected|Hosts|stackhint:)/.test(src)) return '#8b949e';
  if (src.startsWith('  - stackhint')) return '#7ee787';
  return '#c9d1d9';
};
const text = rows
  .map((r, i) => `  <text x="22" y="${top + i * lineH}" fill="${color(r.src, r.t)}" xml:space="preserve">${esc(r.t)}</text>`)
  .join('\n');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="stackhint recommend output on a sample .NET project">
  <rect width="${width}" height="${height}" rx="10" fill="#0d1117"/>
  <circle cx="22" cy="18" r="6" fill="#ff5f57"/><circle cx="42" cy="18" r="6" fill="#febc2e"/><circle cx="62" cy="18" r="6" fill="#28c840"/>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" font-size="13.5">
${text}
  </g>
</svg>
`;
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs', 'demo.svg'), svg);
console.log(`docs/demo.svg: ${rows.length} lines, ${width}x${height}`);
