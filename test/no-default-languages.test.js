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

function writeRel(dir, rel, content = '') {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  if (content === '' && !rel.includes('.')) {
    fs.mkdirSync(full, { recursive: true });
    return;
  }
  fs.writeFileSync(full, content);
}

function makeRepo({ gitignore, tracked = {} } = {}) {
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

function runSymlinkr(dest) {
  const cleaned = { ...process.env };
  delete cleaned.HERDR_PLUGIN_EVENT;
  delete cleaned.HERDR_PLUGIN_EVENT_JSON;
  delete cleaned.HERDR_PLUGIN_CONTEXT_JSON;
  delete cleaned.HERDR_PLUGIN_ACTION_ID;
  const result = spawnSync(process.execPath, [bin, '--dest', dest], {
    encoding: 'utf8',
    env: cleaned,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function assertRealDirectory(dirPath) {
  assert.equal(fs.existsSync(dirPath), true);
  const stat = fs.lstatSync(dirPath);
  assert.equal(stat.isDirectory(), true);
  assert.equal(stat.isSymbolicLink(), false);
}

function assertNoLinkLines(stdout) {
  assert.equal(stdout.includes('link '), false, stdout);
}

function seedBuildDirs(main, wt, dirs) {
  for (const rel of dirs) {
    writeRel(main, path.join(rel, 'artifact'), 'from-main\n');
    writeRel(wt, path.join(rel, 'artifact'), 'from-wt\n');
  }
}

test('Java marker links no build directories', () => {
  const repo = makeRepo({
    gitignore: 'target/\nbuild/\n.gradle/\n',
    tracked: { 'pom.xml': '<project/>\n' },
  });
  try {
    seedBuildDirs(repo.main, repo.wt, ['target', 'build', '.gradle']);
    const result = runSymlinkr(repo.wt);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assertNoLinkLines(result.stdout);
    assertRealDirectory(path.join(repo.wt, 'target'));
    assertRealDirectory(path.join(repo.wt, 'build'));
    assertRealDirectory(path.join(repo.wt, '.gradle'));
  } finally {
    repo.cleanup();
  }
});

test('C# marker links no build directories', () => {
  const repo = makeRepo({
    gitignore: 'bin/\nobj/\n',
    tracked: { 'App.csproj': '<Project/>\n' },
  });
  try {
    seedBuildDirs(repo.main, repo.wt, ['bin', 'obj']);
    const result = runSymlinkr(repo.wt);
    assert.equal(result.status, 0);
    assertNoLinkLines(result.stdout);
    assertRealDirectory(path.join(repo.wt, 'bin'));
    assertRealDirectory(path.join(repo.wt, 'obj'));
  } finally {
    repo.cleanup();
  }
});

test('Rust marker links no target directory', () => {
  const repo = makeRepo({
    gitignore: 'target/\n',
    tracked: { 'Cargo.toml': '[package]\nname = "app"\n' },
  });
  try {
    seedBuildDirs(repo.main, repo.wt, ['target']);
    const result = runSymlinkr(repo.wt);
    assert.equal(result.status, 0);
    assertNoLinkLines(result.stdout);
    assertRealDirectory(path.join(repo.wt, 'target'));
  } finally {
    repo.cleanup();
  }
});

test('C++ marker links no build directories', () => {
  const repo = makeRepo({
    gitignore: 'build/\ncmake-build-debug/\n',
    tracked: { 'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.0)\n' },
  });
  try {
    seedBuildDirs(repo.main, repo.wt, ['build', 'cmake-build-debug']);
    const result = runSymlinkr(repo.wt);
    assert.equal(result.status, 0);
    assertNoLinkLines(result.stdout);
    assertRealDirectory(path.join(repo.wt, 'build'));
    assertRealDirectory(path.join(repo.wt, 'cmake-build-debug'));
  } finally {
    repo.cleanup();
  }
});

test('Haskell marker links no build directories', () => {
  const repo = makeRepo({
    gitignore: 'dist-newstyle/\n.stack-work/\n',
    tracked: { 'app.cabal': 'name: app\n' },
  });
  try {
    seedBuildDirs(repo.main, repo.wt, ['dist-newstyle', '.stack-work']);
    const result = runSymlinkr(repo.wt);
    assert.equal(result.status, 0);
    assertNoLinkLines(result.stdout);
    assertRealDirectory(path.join(repo.wt, 'dist-newstyle'));
    assertRealDirectory(path.join(repo.wt, '.stack-work'));
  } finally {
    repo.cleanup();
  }
});

test('Lua marker links no lua_modules directory', () => {
  const repo = makeRepo({
    gitignore: 'lua_modules/\n',
    tracked: { 'app-1.0.0-1.rockspec': 'rockspec_format = "3.0"\n' },
  });
  try {
    seedBuildDirs(repo.main, repo.wt, ['lua_modules']);
    const result = runSymlinkr(repo.wt);
    assert.equal(result.status, 0);
    assertNoLinkLines(result.stdout);
    assertRealDirectory(path.join(repo.wt, 'lua_modules'));
  } finally {
    repo.cleanup();
  }
});

test('nested Rust crate does not link crates/core/target', () => {
  const repo = makeRepo({
    gitignore: 'target/\ncrates/core/target/\n',
    tracked: {
      'Cargo.toml': '[workspace]\nmembers = ["crates/core"]\n',
      'crates/core/Cargo.toml': '[package]\nname = "core"\n',
    },
  });
  try {
    seedBuildDirs(repo.main, repo.wt, ['target', 'crates/core/target']);
    const result = runSymlinkr(repo.wt);
    assert.equal(result.status, 0);
    assertNoLinkLines(result.stdout);
    assertRealDirectory(path.join(repo.wt, 'crates/core/target'));
  } finally {
    repo.cleanup();
  }
});

test('extra still links a gitignored target when requested', () => {
  const repo = makeRepo({
    gitignore: 'target\n',
    tracked: {
      'Cargo.toml': '[package]\nname = "app"\n',
      '.symlinkr.toml': 'extra = ["target"]\n',
    },
  });
  try {
    writeRel(repo.main, 'target/artifact', 'from-main\n');
    const result = runSymlinkr(repo.wt);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'link target\n');
    const dest = path.join(repo.wt, 'target');
    assert.equal(fs.lstatSync(dest).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(dest), fs.realpathSync(path.join(repo.main, 'target')));
  } finally {
    repo.cleanup();
  }
});
