import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'symlinkr.js');

const defaultGitignore = [
  '.env',
  '.env.*',
  '.envrc',
  'secrets/',
  'vendor',
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

function makeRepo({ gitignore = defaultGitignore, tracked = {} } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'symlinkr-go-'));
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

test('links a gitignored root vendor next to go.mod as a relative symlink', () => {
  const repo = makeRepo({ tracked: { 'go.mod': 'module example.com/root\n\ngo 1.22\n' } });
  try {
    writeRel(repo.main, 'vendor/mod.txt', 'vendored\n');
    const result = runSymlinkr(['--dest', repo.wt]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'link vendor\n');
    assertRelativeLink(path.join(repo.wt, 'vendor'), path.join(repo.main, 'vendor'));
    assert.equal(fs.readFileSync(path.join(repo.wt, 'vendor/mod.txt'), 'utf8'), 'vendored\n');
  } finally {
    repo.cleanup();
  }
});

test('links a gitignored vendor beside a nested go.mod', () => {
  const repo = makeRepo({
    tracked: { 'services/api/go.mod': 'module example.com/api\n\ngo 1.22\n' },
  });
  try {
    writeRel(repo.main, 'services/api/vendor/nested.txt', 'nested\n');
    const result = runSymlinkr(['--dest', repo.wt]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'link services/api/vendor\n');
    assertRelativeLink(
      path.join(repo.wt, 'services/api/vendor'),
      path.join(repo.main, 'services/api/vendor'),
    );
  } finally {
    repo.cleanup();
  }
});

test('skips a committed vendor as not-ignored and leaves a real directory', () => {
  const repo = makeRepo({
    gitignore: '.env\n.env.*\n.envrc\nsecrets/\n',
    tracked: {
      'go.mod': 'module example.com/root\n\ngo 1.22\n',
      'vendor/tracked.txt': 'committed\n',
    },
  });
  try {
    const result = runSymlinkr(['--dest', repo.wt]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'skip vendor not-ignored\n');
    const vendorPath = path.join(repo.wt, 'vendor');
    assert.equal(fs.existsSync(vendorPath), true);
    assert.equal(fs.lstatSync(vendorPath).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(vendorPath).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(vendorPath, 'tracked.txt'), 'utf8'), 'committed\n');
  } finally {
    repo.cleanup();
  }
});

test('records missing-source when vendor is absent and creates nothing', () => {
  const repo = makeRepo({ tracked: { 'go.mod': 'module example.com/root\n\ngo 1.22\n' } });
  try {
    const result = runSymlinkr(['--dest', repo.wt]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'skip vendor missing-source\n');
    assert.equal(fs.existsSync(path.join(repo.wt, 'vendor')), false);
  } finally {
    repo.cleanup();
  }
});

test('a second run on gitignored vendor reports unchanged', () => {
  const repo = makeRepo({ tracked: { 'go.mod': 'module example.com/root\n\ngo 1.22\n' } });
  try {
    writeRel(repo.main, 'vendor/mod.txt', 'vendored\n');
    const first = runSymlinkr(['--dest', repo.wt]);
    assert.equal(first.stdout, 'link vendor\n');
    const before = fs.lstatSync(path.join(repo.wt, 'vendor'));
    const second = runSymlinkr(['--dest', repo.wt]);
    assert.equal(second.status, 0);
    assert.equal(second.stdout, 'skip vendor unchanged\n');
    const after = fs.lstatSync(path.join(repo.wt, 'vendor'));
    assert.equal(after.ino, before.ino);
    assertRelativeLink(path.join(repo.wt, 'vendor'), path.join(repo.main, 'vendor'));
  } finally {
    repo.cleanup();
  }
});
