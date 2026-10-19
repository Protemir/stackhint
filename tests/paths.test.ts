import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { shellQuote, which } from '../src/util/exec.ts';
import { lineDiff } from '../src/util/diff.ts';
import { parseDuration } from '../src/util/duration.ts';
import { claudeStateFile, comparablePath, displayPath, relPath, samePath } from '../src/util/paths.ts';
import { tmp } from './helpers.ts';

describe('paths', () => {
  it('compares Windows paths case-insensitively and slash-agnostic', () => {
    assert.ok(samePath('E:\\PS\\Demo\\', 'e:/ps/demo', 'win32'));
    assert.ok(samePath('E:/SL/Projects/bi-back', 'E:\\SL\\Projects\\bi-back', 'win32'));
    assert.ok(!samePath('/home/a/Proj', '/home/a/proj', 'linux'));
    assert.ok(samePath('/home/a/proj/', '/home/a/proj', 'linux'));
    assert.equal(comparablePath('C:\\X\\', 'linux'), 'c:/x');
  });
  it('shortens home paths for display', () => {
    const env = { STACKHINT_TEST_HOME: path.join(path.sep, 'home', 'me') };
    assert.equal(displayPath(path.join(path.sep, 'home', 'me', '.codex', 'config.toml'), env), '~/.codex/config.toml');
    assert.equal(displayPath(path.join(path.sep, 'opt', 'x'), env), path.join(path.sep, 'opt', 'x'));
  });
  it('makes project-relative evidence paths with forward slashes', () => {
    assert.equal(relPath(path.join('a', 'b'), path.join('a', 'b', 'c', 'd.txt')), 'c/d.txt');
    assert.equal(relPath('a', 'a'), '.');
  });
  it('puts ~/.claude.json inside CLAUDE_CONFIG_DIR when that is set', () => {
    assert.equal(claudeStateFile({ CLAUDE_CONFIG_DIR: path.join('x', 'cfg') }), path.join('x', 'cfg', '.claude.json'));
    assert.equal(claudeStateFile({ STACKHINT_TEST_HOME: path.join('h') }), path.join('h', '.claude.json'));
  });
});

describe('which', () => {
  it('finds executables on a fake PATH without running them', () => {
    const dir = tmp();
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(dir, 'tool.cmd'), '@echo off');
      fs.writeFileSync(path.join(dir, 'other.exe'), '');
      fs.writeFileSync(path.join(dir, 'plain'), '');
    } else {
      fs.writeFileSync(path.join(dir, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
      fs.writeFileSync(path.join(dir, 'plain'), '', { mode: 0o644 });
    }
    const env = { PATH: dir, PATHEXT: '.EXE;.CMD' };
    assert.ok(which('tool', env)?.startsWith(dir));
    assert.equal(which('plain', env), undefined);
    assert.equal(which('missing', env), undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('quotes display commands', () => {
    assert.equal(shellQuote(['claude', 'mcp', 'add', 'x', 'https://a/b']), 'claude mcp add x https://a/b');
    assert.equal(shellQuote(['--header', 'Authorization: Bearer ${T}']), "--header 'Authorization: Bearer ${T}'");
    assert.equal(shellQuote(["it's"]), '"it\'s"');
  });
});

describe('diff and durations', () => {
  it('shows added lines with context', () => {
    const d = lineDiff('a\nb\nc\n', 'a\nb\nX\nc\n');
    assert.match(d, /\+ X/);
    assert.doesNotMatch(d, /- /);
    assert.match(lineDiff('', 'new\n'), /^\+ new$/);
  });
  it('parses durations', () => {
    assert.equal(parseDuration('30m'), 1_800_000);
    assert.equal(parseDuration('14d'), 14 * 86_400_000);
    assert.equal(parseDuration('2w'), 14 * 86_400_000);
    assert.equal(parseDuration('0d'), undefined);
    assert.equal(parseDuration('soon'), undefined);
  });
});
