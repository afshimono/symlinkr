import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'symlinkr.js');

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

function makeRepo({ gitignore = '**/vendor/bundle\n', tracked = {} } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'symlinkr-ruby-'));
  const main = path.join(parent, 'main');
  const wt = path.join(parent, 'wt');
  fs.mkdirSync(main);
  runGit(main, ['init']);
  runGit(main, ['config', 'user.email', 'test@example.com']);
  runGit(main, ['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(main, '.gitignore'), gitignore);
  for (const [rel, content] of Object.entries(tracked)) writeRel(main, rel, content);
  runGit(main, ['add', '.gitignore']);
  for (const rel of Object.keys(tracked)) runGit(main, ['add', '-f', rel]);
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

test('links gitignored vendor/bundle beside a root Gemfile', () => {
  const repo = makeRepo({ tracked: { Gemfile: "source 'https://rubygems.org'\n" } });
  try {
    writeRel(repo.main, 'vendor/bundle/.keep', '');
    const result = runSymlinkr(['--dest', repo.wt]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'link vendor/bundle\n');
    assert.equal(fs.lstatSync(path.join(repo.wt, 'vendor')).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(path.join(repo.wt, 'vendor')).isDirectory(), true);
    assertRelativeLink(
      path.join(repo.wt, 'vendor/bundle'),
      path.join(repo.main, 'vendor/bundle'),
    );
  } finally {
    repo.cleanup();
  }
});

test('leaves an existing vendor/other file in the destination untouched', () => {
  const repo = makeRepo({ tracked: { Gemfile: "source 'https://rubygems.org'\n" } });
  try {
    writeRel(repo.main, 'vendor/bundle/.keep', '');
    writeRel(repo.wt, 'vendor/other', 'stay\n');
    const result = runSymlinkr(['--dest', repo.wt]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'link vendor/bundle\n');
    assert.equal(fs.lstatSync(path.join(repo.wt, 'vendor/other')).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(repo.wt, 'vendor/other'), 'utf8'), 'stay\n');
    assertRelativeLink(
      path.join(repo.wt, 'vendor/bundle'),
      path.join(repo.main, 'vendor/bundle'),
    );
  } finally {
    repo.cleanup();
  }
});

test('links nested vendor/bundle beside gems/client/Gemfile', () => {
  const repo = makeRepo({
    tracked: {
      'gems/client/Gemfile': "source 'https://rubygems.org'\n",
    },
  });
  try {
    writeRel(repo.main, 'gems/client/vendor/bundle/.keep', '');
    const result = runSymlinkr(['--dest', repo.wt]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'link gems/client/vendor/bundle\n');
    assertRelativeLink(
      path.join(repo.wt, 'gems/client/vendor/bundle'),
      path.join(repo.main, 'gems/client/vendor/bundle'),
    );
  } finally {
    repo.cleanup();
  }
});

test('skips tracked vendor/bundle with not-ignored', () => {
  const repo = makeRepo({
    tracked: {
      Gemfile: "source 'https://rubygems.org'\n",
      'vendor/bundle/installed': 'gem\n',
    },
  });
  try {
    const result = runSymlinkr(['--dest', repo.wt]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'skip vendor/bundle not-ignored\n');
    assert.equal(fs.lstatSync(path.join(repo.wt, 'vendor/bundle')).isSymbolicLink(), false);
  } finally {
    repo.cleanup();
  }
});

test('a second run reports unchanged for vendor/bundle', () => {
  const repo = makeRepo({ tracked: { Gemfile: "source 'https://rubygems.org'\n" } });
  try {
    writeRel(repo.main, 'vendor/bundle/.keep', '');
    const first = runSymlinkr(['--dest', repo.wt]);
    assert.equal(first.stdout, 'link vendor/bundle\n');
    const before = fs.lstatSync(path.join(repo.wt, 'vendor/bundle'));
    const second = runSymlinkr(['--dest', repo.wt]);
    assert.equal(second.status, 0);
    assert.equal(second.stdout, 'skip vendor/bundle unchanged\n');
    const after = fs.lstatSync(path.join(repo.wt, 'vendor/bundle'));
    assert.equal(after.ino, before.ino);
    assertRelativeLink(
      path.join(repo.wt, 'vendor/bundle'),
      path.join(repo.main, 'vendor/bundle'),
    );
  } finally {
    repo.cleanup();
  }
});
