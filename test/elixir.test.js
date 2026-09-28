import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'symlinkr.js');

const elixirGitignore = [
  '.env',
  '.env.*',
  '.envrc',
  'secrets/',
  'deps',
  '_build',
  'cover',
  '.elixir_ls',
].join('\n') + '\n';

const mixProject = [
  'defmodule App.MixProject do',
  '  use Mix.Project',
  'end',
  '',
].join('\n');

function runGit(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  }
}

function writeRel(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function makeRepo({ gitignore = elixirGitignore, tracked = {} } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'symlinkr-'));
  const main = path.join(parent, 'main');
  const wt = path.join(parent, 'wt');
  fs.mkdirSync(main);
  runGit(main, ['init']);
  runGit(main, ['config', 'user.email', 'test@example.com']);
  runGit(main, ['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(main, '.gitignore'), gitignore);
  for (const [rel, content] of Object.entries(tracked)) writeRel(main, rel, content);
  runGit(main, ['add', '.gitignore', ...Object.keys(tracked)]);
  runGit(main, ['commit', '-m', 'init']);
  runGit(main, ['worktree', 'add', wt, '-b', 'feature']);
  return {
    parent,
    main,
    wt,
    cleanup() {
      fs.rmSync(parent, { recursive: true, force: true });
    },
  };
}

function runSymlinkr(args = [], env = {}) {
  const cleaned = { ...process.env, ...env };
  delete cleaned.HERDR_PLUGIN_EVENT;
  delete cleaned.HERDR_PLUGIN_EVENT_JSON;
  delete cleaned.HERDR_PLUGIN_CONTEXT_JSON;
  delete cleaned.HERDR_PLUGIN_ACTION_ID;
  Object.assign(cleaned, env);
  const result = spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: cleaned,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function assertRelativeLink(destPath, sourcePath) {
  const stat = fs.lstatSync(destPath);
  assert.equal(stat.isSymbolicLink(), true);
  const target = fs.readlinkSync(destPath);
  assert.equal(path.isAbsolute(target), false);
  assert.equal(fs.realpathSync(destPath), fs.realpathSync(sourcePath));
}

test('a gitignored root deps next to mix.exs becomes a relative symlink', () => {
  const repo = makeRepo({ tracked: { 'mix.exs': mixProject } });
  try {
    writeRel(repo.main, 'deps/phoenix', 'dep\n');
    const result = runSymlinkr(['--dest', repo.wt]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'link deps\n');
    assertRelativeLink(path.join(repo.wt, 'deps'), path.join(repo.main, 'deps'));
    assert.equal(fs.readFileSync(path.join(repo.wt, 'deps/phoenix'), 'utf8'), 'dep\n');
  } finally {
    repo.cleanup();
  }
});

test('a nested apps/auth/mix.exs with a gitignored deps is linked', () => {
  const repo = makeRepo({ tracked: { 'apps/auth/mix.exs': mixProject } });
  try {
    writeRel(repo.main, 'apps/auth/deps/jose', 'dep\n');
    const result = runSymlinkr(['--dest', repo.wt]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'link apps/auth/deps\n');
    assertRelativeLink(
      path.join(repo.wt, 'apps/auth/deps'),
      path.join(repo.main, 'apps/auth/deps'),
    );
    assert.equal(fs.readFileSync(path.join(repo.wt, 'apps/auth/deps/jose'), 'utf8'), 'dep\n');
  } finally {
    repo.cleanup();
  }
});

test('a gitignored _build stays a normal directory', () => {
  const repo = makeRepo({ tracked: { 'mix.exs': mixProject } });
  try {
    writeRel(repo.main, 'deps/ok', 'dep\n');
    writeRel(repo.wt, '_build/dev/lib/app/ebin/app.beam', '\0');
    const result = runSymlinkr(['--dest', repo.wt]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'link deps\n');
    const build = path.join(repo.wt, '_build');
    assert.equal(fs.lstatSync(build).isDirectory(), true);
    assert.equal(fs.lstatSync(build).isSymbolicLink(), false);
  } finally {
    repo.cleanup();
  }
});

test('a tracked deps is skipped not-ignored', () => {
  const repo = makeRepo({
    gitignore: [
      '.env',
      '.env.*',
      '.envrc',
      'secrets/',
      '_build',
      'cover',
      '.elixir_ls',
    ].join('\n') + '\n',
    tracked: {
      'mix.exs': mixProject,
      'deps/phoenix/priv/static/.keep': 'ok\n',
    },
  });
  try {
    const result = runSymlinkr(['--dest', repo.wt]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'skip deps not-ignored\n');
    assert.equal(fs.lstatSync(path.join(repo.wt, 'deps')).isSymbolicLink(), false);
  } finally {
    repo.cleanup();
  }
});

test('a second run reports unchanged', () => {
  const repo = makeRepo({ tracked: { 'mix.exs': mixProject } });
  try {
    writeRel(repo.main, 'deps/phoenix', 'dep\n');
    const first = runSymlinkr(['--dest', repo.wt]);
    assert.equal(first.stdout, 'link deps\n');
    const before = fs.lstatSync(path.join(repo.wt, 'deps'));
    const second = runSymlinkr(['--dest', repo.wt]);
    assert.equal(second.status, 0);
    assert.equal(second.stdout, 'skip deps unchanged\n');
    const after = fs.lstatSync(path.join(repo.wt, 'deps'));
    assert.equal(after.ino, before.ino);
    assertRelativeLink(path.join(repo.wt, 'deps'), path.join(repo.main, 'deps'));
  } finally {
    repo.cleanup();
  }
});
