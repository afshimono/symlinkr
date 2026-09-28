import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'symlinkr.js');

const pythonGitignore = [
  '.env',
  '.env.*',
  '.envrc',
  'secrets/',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
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
  if (content === null) {
    fs.mkdirSync(full, { recursive: true });
    return;
  }
  fs.writeFileSync(full, content);
}

function makeRepo({ gitignore = pythonGitignore, tracked = {} } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'symlinkr-python-'));
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

function runSymlinkr(dest, args = []) {
  const cleaned = { ...process.env };
  delete cleaned.HERDR_PLUGIN_EVENT;
  delete cleaned.HERDR_PLUGIN_EVENT_JSON;
  delete cleaned.HERDR_PLUGIN_CONTEXT_JSON;
  delete cleaned.HERDR_PLUGIN_ACTION_ID;
  const result = spawnSync(process.execPath, [bin, '--dest', dest, ...args], {
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

test('links a gitignored root .venv beside pyproject.toml as a relative symlink', () => {
  const repo = makeRepo();
  try {
    writeRel(repo.main, 'pyproject.toml', '[project]\nname = "app"\n');
    writeRel(repo.main, '.venv/bin/python', '#!/bin/sh\n');
    const result = runSymlinkr(repo.wt);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'link .venv\nskip venv missing-source\n');
    assertRelativeLink(path.join(repo.wt, '.venv'), path.join(repo.main, '.venv'));
  } finally {
    repo.cleanup();
  }
});

test('links a nested venv beside requirements.txt and leaves root without a virtualenv', () => {
  const repo = makeRepo();
  try {
    writeRel(repo.main, 'pyproject.toml', '[project]\nname = "root"\n');
    writeRel(repo.main, 'services/api/requirements.txt', 'flask\n');
    writeRel(repo.main, 'services/api/venv/lib/python3.12/site-packages', null);
    const result = runSymlinkr(repo.wt);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(
      result.stdout,
      [
        'skip .venv missing-source',
        'skip services/api/.venv missing-source',
        'link services/api/venv',
        'skip venv missing-source',
      ].join('\n') + '\n',
    );
    assertRelativeLink(
      path.join(repo.wt, 'services/api/venv'),
      path.join(repo.main, 'services/api/venv'),
    );
    assert.equal(fs.existsSync(path.join(repo.wt, '.venv')), false);
    assert.equal(fs.existsSync(path.join(repo.wt, 'venv')), false);
  } finally {
    repo.cleanup();
  }
});

test('links both .venv and venv when each exists and is gitignored', () => {
  const repo = makeRepo();
  try {
    writeRel(repo.main, 'pyproject.toml', '[project]\nname = "both"\n');
    writeRel(repo.main, '.venv/pyvenv.cfg', 'home = .\n');
    writeRel(repo.main, 'venv/pyvenv.cfg', 'home = .\n');
    const result = runSymlinkr(repo.wt);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'link .venv\nlink venv\n');
    assertRelativeLink(path.join(repo.wt, '.venv'), path.join(repo.main, '.venv'));
    assertRelativeLink(path.join(repo.wt, 'venv'), path.join(repo.main, 'venv'));
  } finally {
    repo.cleanup();
  }
});

test('skips a tracked venv with not-ignored', () => {
  const gitignore = [
    '.env',
    '.env.*',
    '.envrc',
    'secrets/',
    '.venv',
    '__pycache__',
    '.pytest_cache',
  ].join('\n') + '\n';
  const repo = makeRepo({
    gitignore,
    tracked: {
      'requirements.txt': 'pkg\n',
      'venv/pyvenv.cfg': 'home = .\n',
    },
  });
  try {
    const result = runSymlinkr(repo.wt);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'skip .venv missing-source\nskip venv not-ignored\n');
    assert.equal(fs.lstatSync(path.join(repo.wt, 'venv')).isSymbolicLink(), false);
  } finally {
    repo.cleanup();
  }
});

test('does not link __pycache__ or .pytest_cache', () => {
  const repo = makeRepo();
  try {
    writeRel(repo.main, 'pyproject.toml', '[project]\nname = "caches"\n');
    writeRel(repo.main, '__pycache__/mod.cpython-312.pyc', 'bytecode\n');
    writeRel(repo.main, '.pytest_cache/README.md', 'cache\n');
    const result = runSymlinkr(repo.wt);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'skip .venv missing-source\nskip venv missing-source\n');
    assert.equal(fs.existsSync(path.join(repo.wt, '__pycache__')), false);
    assert.equal(fs.existsSync(path.join(repo.wt, '.pytest_cache')), false);
  } finally {
    repo.cleanup();
  }
});

test('a second run reports unchanged for linked virtualenvs', () => {
  const repo = makeRepo();
  try {
    writeRel(repo.main, 'pyproject.toml', '[project]\nname = "again"\n');
    writeRel(repo.main, '.venv/pyvenv.cfg', 'home = .\n');
    const first = runSymlinkr(repo.wt);
    assert.equal(first.stdout, 'link .venv\nskip venv missing-source\n');
    const before = fs.lstatSync(path.join(repo.wt, '.venv'));
    const second = runSymlinkr(repo.wt);
    assert.equal(second.status, 0);
    assert.equal(second.stdout, 'skip .venv unchanged\nskip venv missing-source\n');
    const after = fs.lstatSync(path.join(repo.wt, '.venv'));
    assert.equal(after.ino, before.ino);
    assertRelativeLink(path.join(repo.wt, '.venv'), path.join(repo.main, '.venv'));
  } finally {
    repo.cleanup();
  }
});
