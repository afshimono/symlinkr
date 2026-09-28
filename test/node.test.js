import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'symlinkr.js');

const NODE_GITIGNORE = [
  'node_modules',
  '.pnp.cjs',
  '.pnp.js',
  '.yarn/cache',
  'dist/',
  '.next/',
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
  if (typeof content === 'string') {
    fs.writeFileSync(full, content);
  } else {
    fs.writeFileSync(full, content);
  }
}

function mkdirRel(dir, rel) {
  fs.mkdirSync(path.join(dir, rel), { recursive: true });
}

function makeRepo({
  gitignore = NODE_GITIGNORE,
  tracked = {},
  forceTracked = {},
  symlinkrToml,
} = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'symlinkr-node-'));
  const main = path.join(parent, 'main');
  const wt = path.join(parent, 'wt');
  fs.mkdirSync(main);
  runGit(main, ['init']);
  runGit(main, ['config', 'user.email', 'test@example.com']);
  runGit(main, ['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(main, '.gitignore'), gitignore);
  for (const [rel, content] of Object.entries(tracked)) writeRel(main, rel, content);
  for (const [rel, content] of Object.entries(forceTracked)) writeRel(main, rel, content);
  if (symlinkrToml) writeRel(main, '.symlinkr.toml', symlinkrToml);
  const toAdd = ['.gitignore', ...Object.keys(tracked)];
  if (symlinkrToml) toAdd.push('.symlinkr.toml');
  runGit(main, ['add', ...toAdd]);
  for (const rel of Object.keys(forceTracked)) runGit(main, ['add', '-f', rel]);
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

function assertOrdinaryDirectory(dirPath) {
  const stat = fs.lstatSync(dirPath);
  assert.equal(stat.isDirectory(), true);
  assert.equal(stat.isSymbolicLink(), false);
}

test('links gitignored node_modules at root and nested package.json locations', () => {
  const repo = makeRepo({
    tracked: {
      'package.json': '{"name":"root"}\n',
      'packages/web/package.json': '{"name":"web"}\n',
    },
  });
  try {
    mkdirRel(repo.main, 'node_modules/lodash');
    writeRel(repo.main, 'node_modules/lodash/index.js', 'module.exports = {};\n');
    mkdirRel(repo.main, 'packages/web/node_modules/react');
    writeRel(repo.main, 'packages/web/node_modules/react/index.js', 'export {};\n');
    const result = runSymlinkr(repo.wt);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /link node_modules\n/);
    assert.match(result.stdout, /link packages\/web\/node_modules\n/);
    assertRelativeLink(path.join(repo.wt, 'node_modules'), path.join(repo.main, 'node_modules'));
    assertRelativeLink(
      path.join(repo.wt, 'packages/web/node_modules'),
      path.join(repo.main, 'packages/web/node_modules'),
    );
    assert.equal(
      fs.readFileSync(path.join(repo.wt, 'node_modules/lodash/index.js'), 'utf8'),
      'module.exports = {};\n',
    );
  } finally {
    repo.cleanup();
  }
});

test('links gitignored pnp and yarn cache paths; package.json stays a tracked file', () => {
  const repo = makeRepo({
    tracked: { 'package.json': '{"name":"root"}\n' },
  });
  try {
    writeRel(repo.main, '.pnp.cjs', 'module.exports = {};\n');
    writeRel(repo.main, '.pnp.js', 'module.exports = {};\n');
    mkdirRel(repo.main, '.yarn/cache');
    writeRel(repo.main, '.yarn/cache/pkg-0.tgz', 'fake\n');
    const result = runSymlinkr(repo.wt);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /link \.pnp\.cjs\n/);
    assert.match(result.stdout, /link \.pnp\.js\n/);
    assert.match(result.stdout, /link \.yarn\/cache\n/);
    assertRelativeLink(path.join(repo.wt, '.pnp.cjs'), path.join(repo.main, '.pnp.cjs'));
    assertRelativeLink(path.join(repo.wt, '.pnp.js'), path.join(repo.main, '.pnp.js'));
    assertRelativeLink(path.join(repo.wt, '.yarn/cache'), path.join(repo.main, '.yarn/cache'));
    const pkgStat = fs.lstatSync(path.join(repo.wt, 'package.json'));
    assert.equal(pkgStat.isFile(), true);
    assert.equal(pkgStat.isSymbolicLink(), false);
  } finally {
    repo.cleanup();
  }
});

test('gitignored dist and .next in main are not linker candidates', () => {
  const repo = makeRepo({
    tracked: { 'package.json': '{"name":"root"}\n' },
  });
  try {
    mkdirRel(repo.main, 'dist');
    writeRel(repo.main, 'dist/out.js', 'console.log(1);\n');
    mkdirRel(repo.main, '.next');
    writeRel(repo.main, '.next/build-manifest.json', '{}');
    const result = runSymlinkr(repo.wt);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.split('\n').some((line) => line.includes('dist')), false);
    assert.equal(result.stdout.split('\n').some((line) => line.includes('.next')), false);
    assert.equal(fs.existsSync(path.join(repo.wt, 'dist')), false);
    assert.equal(fs.existsSync(path.join(repo.wt, '.next')), false);
  } finally {
    repo.cleanup();
  }
});

test('an existing dist directory in the worktree is not replaced', () => {
  const repo = makeRepo({
    tracked: { 'package.json': '{"name":"root"}\n' },
  });
  try {
    mkdirRel(repo.main, 'dist');
    writeRel(repo.main, 'dist/out.js', 'console.log(1);\n');
    mkdirRel(repo.wt, 'dist');
    writeRel(repo.wt, 'dist/local-only.js', 'local\n');
    const result = runSymlinkr(repo.wt);
    assert.equal(result.status, 0);
    assertOrdinaryDirectory(path.join(repo.wt, 'dist'));
    assert.equal(fs.readFileSync(path.join(repo.wt, 'dist/local-only.js'), 'utf8'), 'local\n');
  } finally {
    repo.cleanup();
  }
});

test('committed node_modules is not replaced', () => {
  const repo = makeRepo({
    tracked: { 'package.json': '{"name":"root"}\n' },
    forceTracked: { 'node_modules/committed/pkg.json': '{"v":1}\n' },
  });
  try {
    const result = runSymlinkr(repo.wt);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /skip node_modules not-ignored\n/);
    assert.equal(fs.existsSync(path.join(repo.wt, 'node_modules')), true);
    assertOrdinaryDirectory(path.join(repo.wt, 'node_modules'));
    assert.equal(
      fs.readFileSync(path.join(repo.wt, 'node_modules/committed/pkg.json'), 'utf8'),
      '{"v":1}\n',
    );
  } finally {
    repo.cleanup();
  }
});

test('a second run reports unchanged for linked node_modules', () => {
  const repo = makeRepo({
    tracked: { 'package.json': '{"name":"root"}\n' },
  });
  try {
    mkdirRel(repo.main, 'node_modules/pkg');
    const first = runSymlinkr(repo.wt);
    assert.match(first.stdout, /link node_modules\n/);
    const before = fs.lstatSync(path.join(repo.wt, 'node_modules'));
    const second = runSymlinkr(repo.wt);
    assert.equal(second.status, 0);
    assert.match(second.stdout, /skip node_modules unchanged\n/);
    const after = fs.lstatSync(path.join(repo.wt, 'node_modules'));
    assert.equal(after.ino, before.ino);
    assertRelativeLink(path.join(repo.wt, 'node_modules'), path.join(repo.main, 'node_modules'));
  } finally {
    repo.cleanup();
  }
});

test('exclude skips nested node_modules but still links the root', () => {
  const repo = makeRepo({
    tracked: {
      'package.json': '{"name":"root"}\n',
      'packages/web/package.json': '{"name":"web"}\n',
    },
    symlinkrToml: 'exclude = ["packages/web/node_modules"]\n',
  });
  try {
    mkdirRel(repo.main, 'node_modules/root-dep');
    mkdirRel(repo.main, 'packages/web/node_modules/nested-dep');
    const result = runSymlinkr(repo.wt);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /link node_modules\n/);
    assert.match(result.stdout, /skip packages\/web\/node_modules excluded\n/);
    assertRelativeLink(path.join(repo.wt, 'node_modules'), path.join(repo.main, 'node_modules'));
    assert.equal(fs.existsSync(path.join(repo.wt, 'packages/web/node_modules')), false);
  } finally {
    repo.cleanup();
  }
});

test('tsconfig.json alone does not activate the node rule', () => {
  const repo = makeRepo({
    tracked: { 'tsconfig.json': '{}\n' },
  });
  try {
    mkdirRel(repo.main, 'node_modules/orphan');
    const result = runSymlinkr(repo.wt);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.includes('node_modules'), false);
    assert.equal(fs.existsSync(path.join(repo.wt, 'node_modules')), false);
  } finally {
    repo.cleanup();
  }
});
