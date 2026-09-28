import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'symlinkr.js');

const erlangGitignore = [
  '.env',
  '.env.*',
  '.envrc',
  'secrets/',
  'deps',
  '_build',
].join('\n') + '\n';

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

function makeRepo({ gitignore = erlangGitignore, tracked = {} } = {}) {
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

test('rebar.config plus a gitignored deps becomes a relative symlink', () => {
  const repo = makeRepo({ tracked: { 'rebar.config': '{}\n' } });
  try {
    writeRel(repo.main, 'deps/cowboy', 'dep\n');
    const result = runSymlinkr(['--dest', repo.wt]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'link deps\n');
    assertRelativeLink(path.join(repo.wt, 'deps'), path.join(repo.main, 'deps'));
    assert.equal(fs.readFileSync(path.join(repo.wt, 'deps/cowboy'), 'utf8'), 'dep\n');
  } finally {
    repo.cleanup();
  }
});

test('erlang.mk plus a gitignored deps in apps/core becomes a relative symlink', () => {
  const repo = makeRepo({ tracked: { 'apps/core/erlang.mk': 'PROJECT = core.\n' } });
  try {
    writeRel(repo.main, 'apps/core/deps/lager', 'dep\n');
    const result = runSymlinkr(['--dest', repo.wt]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'link apps/core/deps\n');
    assertRelativeLink(
      path.join(repo.wt, 'apps/core/deps'),
      path.join(repo.main, 'apps/core/deps'),
    );
    assert.equal(fs.readFileSync(path.join(repo.wt, 'apps/core/deps/lager'), 'utf8'), 'dep\n');
  } finally {
    repo.cleanup();
  }
});

test('rebar.config with no deps records missing-source and does not create a directory', () => {
  const repo = makeRepo({ tracked: { 'rebar.config': '{}\n' } });
  try {
    const result = runSymlinkr(['--dest', repo.wt]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'skip deps missing-source\n');
    assert.equal(fs.existsSync(path.join(repo.wt, 'deps')), false);
  } finally {
    repo.cleanup();
  }
});

test('a gitignored _build stays a normal directory', () => {
  const repo = makeRepo({ tracked: { 'rebar.config': '{}\n' } });
  try {
    writeRel(repo.main, 'deps/ok', 'dep\n');
    writeRel(repo.wt, '_build/default/lib/app/ebin/app.beam', '\0');
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
      '_build/',
    ].join('\n') + '\n',
    tracked: {
      'rebar.config': '{}\n',
      'deps/cowboy/ebin/cowboy.app': 'ok\n',
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
  const repo = makeRepo({ tracked: { 'rebar.config': '{}\n' } });
  try {
    writeRel(repo.main, 'deps/cowboy', 'dep\n');
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
