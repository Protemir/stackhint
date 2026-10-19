import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { DEFAULT_CONFIG, Store } from '../src/state/store.ts';
import { sandbox, writeFiles, type Sandbox } from './helpers.ts';

const boxes: Sandbox[] = [];
after(() => boxes.forEach((b) => b.cleanup()));
function store(now = () => Date.parse('2026-10-20T00:00:00Z')): { s: Store; b: Sandbox } {
  const b = sandbox();
  boxes.push(b);
  return { s: new Store(b.env, now), b };
}

describe('config', () => {
  it('defaults are safe: balanced hints, no network', () => {
    const { s } = store();
    const { config, warnings } = s.loadConfig();
    assert.deepEqual(config, DEFAULT_CONFIG);
    assert.equal(config.network, false);
    assert.deepEqual(warnings, []);
  });
  it('bad values fall back to defaults with a warning', () => {
    const { s, b } = store();
    writeFiles(b.stackhome, { 'config.json': JSON.stringify({ mode: 'loud', minScore: -5, network: 'yes', hookMinScore: { balanced: 70 }, extra: 1 }) });
    const { config, warnings } = s.loadConfig();
    assert.equal(config.mode, 'balanced');
    assert.equal(config.minScore, DEFAULT_CONFIG.minScore);
    assert.equal(config.network, false);
    assert.equal(config.hookMinScore.balanced, 70);
    assert.equal(warnings.length, 4);
  });
  it('corrupt config is ignored, not fatal', () => {
    const { s, b } = store();
    writeFiles(b.stackhome, { 'config.json': '{nope' });
    assert.deepEqual(s.loadConfig().config, DEFAULT_CONFIG);
  });
  it('set validates and persists', () => {
    const { s } = store();
    assert.equal(s.setConfig('hookMaxItems.proactive', '5').hookMaxItems.proactive, 5);
    assert.throws(() => s.setConfig('hookMaxItems.proactive', '50'));
    assert.throws(() => s.setConfig('network', 'maybe'));
    assert.throws(() => s.setConfig('unknown', '1'));
  });
});

describe('state and audit', () => {
  it('project keys are stable and do not store the path', () => {
    const { s } = store();
    const k = s.projectKey(path.join('C:', 'Work', 'App'));
    assert.match(k, /^[0-9a-f]{16}$/);
    if (process.platform === 'win32') assert.equal(k, s.projectKey(path.join('c:', 'work', 'app')));
  });
  it('survives a corrupt state file', () => {
    const { s, b } = store();
    writeFiles(b.stackhome, { 'state.json': '[1,2' });
    assert.deepEqual(s.loadState(), { version: 1, dismissed: {}, projects: {} });
    s.dismiss('github', {});
    assert.ok(s.isDismissed(s.loadState(), 'github', 'p'));
  });
  it('the audit log never contains secrets', () => {
    const { s, b } = store();
    s.audit('install', { entry: 'x', env: { GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, url: 'postgres://u:hunter2@h/db' });
    const text = fs.readFileSync(path.join(b.stackhome, 'audit.log'), 'utf8');
    assert.ok(!text.includes('ghp_abc'));
    assert.ok(!text.includes('hunter2'));
    assert.equal(s.readAudit().length, 1);
  });
});
