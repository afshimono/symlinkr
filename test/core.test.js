import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { linkWorktree } from '../lib/link.js';
import { loadRules } from '../lib/rules.js';

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

function makeRepo({ gitignore = '.env\n.env.*\n.envrc\nsecrets/\n', tracked = {} } = {}) {
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

test('links gitignored .env and .env.local as relative symlinks', () => {
  const repo = makeRepo();
  try {
    writeRel(repo.main, '.env', 'FROM_MAIN_ENV=1\n');
    writeRel(repo.main, '.env.local', 'FROM_MAIN_LOCAL=1\n');
    const result = runSymlinkr(['--dest', repo.wt]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'link .env\nlink .env.local\n');
    assertRelativeLink(path.join(repo.wt, '.env'), path.join(repo.main, '.env'));
    assertRelativeLink(path.join(repo.wt, '.env.local'), path.join(repo.main, '.env.local'));
    assert.equal(fs.readFileSync(path.join(repo.wt, '.env'), 'utf8'), 'FROM_MAIN_ENV=1\n');
  } finally {
    repo.cleanup();
  }
});

test('links .env.development.local and skips .env.development and .envrc', () => {
  const repo = makeRepo();
  try {
    writeRel(repo.main, '.env.development.local', 'DEV_LOCAL=1\n');
    writeRel(repo.main, '.env.development', 'DEV=1\n');
    writeRel(repo.main, '.envrc', 'echo no\n');
    const result = runSymlinkr(['--dest', repo.wt]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'link .env.development.local\n');
    assertRelativeLink(
      path.join(repo.wt, '.env.development.local'),
      path.join(repo.main, '.env.development.local'),
    );
    assert.equal(fs.existsSync(path.join(repo.wt, '.env.development')), false);
    assert.equal(fs.existsSync(path.join(repo.wt, '.envrc')), false);
  } finally {
    repo.cleanup();
  }
});

test('a second run reports unchanged and keeps the symlink', () => {
  const repo = makeRepo();
  try {
    writeRel(repo.main, '.env', 'A=1\n');
    const first = runSymlinkr(['--dest', repo.wt]);
    assert.equal(first.stdout, 'link .env\n');
    const before = fs.lstatSync(path.join(repo.wt, '.env'));
    const second = runSymlinkr(['--dest', repo.wt]);
    assert.equal(second.status, 0);
    assert.equal(second.stdout, 'skip .env unchanged\n');
    const after = fs.lstatSync(path.join(repo.wt, '.env'));
    assert.equal(after.ino, before.ino);
    assertRelativeLink(path.join(repo.wt, '.env'), path.join(repo.main, '.env'));
  } finally {
    repo.cleanup();
  }
});

test('skips real files, foreign symlinks, tracked paths, and missing sources', () => {
  const repo = makeRepo({
    gitignore: '.env\n.env.local\nabsent.dat\n',
    tracked: { '.env.production.local': 'TRACKED=1\n' },
  });
  try {
    writeRel(repo.main, '.env', 'MAIN=1\n');
    writeRel(repo.main, '.env.local', 'LOCAL=1\n');
    writeRel(repo.wt, '.env', 'REAL=1\n');
    writeRel(repo.wt, 'elsewhere.txt', 'other\n');
    fs.symlinkSync('elsewhere.txt', path.join(repo.wt, '.env.local'));
    writeRel(repo.main, '.symlinkr.toml', 'extra = ["absent.dat"]\n');
    const result = runSymlinkr(['--dest', repo.wt]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(
      result.stdout,
      [
        'skip .env exists',
        'skip .env.local wrong-target',
        'skip .env.production.local not-ignored',
        'skip absent.dat missing-source',
      ].join('\n') + '\n',
    );
    assert.equal(fs.lstatSync(path.join(repo.wt, '.env')).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(repo.wt, '.env'), 'utf8'), 'REAL=1\n');
    assert.equal(fs.readlinkSync(path.join(repo.wt, '.env.local')), 'elsewhere.txt');
    assert.equal(fs.lstatSync(path.join(repo.wt, '.env.production.local')).isSymbolicLink(), false);
    assert.equal(fs.existsSync(path.join(repo.wt, 'absent.dat')), false);
  } finally {
    repo.cleanup();
  }
});

test('running against the main worktree prints skip . self', () => {
  const repo = makeRepo();
  try {
    writeRel(repo.main, '.env', 'A=1\n');
    const result = runSymlinkr(['--dest', repo.main]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'skip . self\n');
    assert.equal(fs.lstatSync(path.join(repo.main, '.env')).isSymbolicLink(), false);
  } finally {
    repo.cleanup();
  }
});

test('enabled = false prints only skip . disabled', () => {
  const repo = makeRepo();
  try {
    writeRel(repo.main, '.env', 'A=1\n');
    writeRel(repo.main, '.symlinkr.toml', '# leave this worktree alone\nenabled = false\n');
    const result = runSymlinkr(['--dest', repo.wt]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'skip . disabled\n');
    assert.equal(result.stderr, '');
    assert.equal(fs.existsSync(path.join(repo.wt, '.env')), false);
  } finally {
    repo.cleanup();
  }
});

test('exclude skips the exact relative path', () => {
  const repo = makeRepo();
  try {
    writeRel(repo.main, '.env', 'A=1\n');
    writeRel(repo.main, '.env.local', 'B=1\n');
    writeRel(repo.main, '.symlinkr.toml', 'exclude = [".env"]\n');
    const result = runSymlinkr(['--dest', repo.wt]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'skip .env excluded\nlink .env.local\n');
    assert.equal(fs.existsSync(path.join(repo.wt, '.env')), false);
    assertRelativeLink(path.join(repo.wt, '.env.local'), path.join(repo.main, '.env.local'));
  } finally {
    repo.cleanup();
  }
});

test('extra links a gitignored root-relative file that is not an env file', () => {
  const repo = makeRepo();
  try {
    writeRel(repo.main, 'secrets/local.json', '{"token":"SECRET"}\n');
    writeRel(repo.main, '.symlinkr.toml', 'extra = ["secrets/local.json"]\n');
    const result = runSymlinkr(['--dest', repo.wt]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'link secrets/local.json\n');
    assert.equal(result.stdout.includes('SECRET'), false);
    assertRelativeLink(
      path.join(repo.wt, 'secrets/local.json'),
      path.join(repo.main, 'secrets/local.json'),
    );
    assert.equal(fs.lstatSync(path.join(repo.wt, 'secrets')).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(path.join(repo.wt, 'secrets')).isDirectory(), true);
  } finally {
    repo.cleanup();
  }
});

test('links a nested env file beside a marker and ignores one without a marker', async () => {
  const repo = makeRepo({ gitignore: '.env\nlink-me\n' });
  try {
    writeRel(repo.main, 'app/MARKER', '');
    writeRel(repo.main, 'app/.env', 'APP=1\n');
    writeRel(repo.main, 'app/link-me', 'dep\n');
    writeRel(repo.main, 'via-fn/flag.me', '');
    writeRel(repo.main, 'via-fn/.env', 'FN=1\n');
    writeRel(repo.main, 'plain/.env', 'PLAIN=1\n');
    const logs = [];
    await linkWorktree(repo.wt, {
      rules: [
        {
          id: 'fixture',
          markers: ['MARKER'],
          linkPaths: ['link-me'],
        },
        {
          id: 'flag',
          markers: [],
          linkPaths: [],
          matchesMarker(name) {
            return name === 'flag.me';
          },
        },
      ],
      stdout: { write(chunk) { logs.push(chunk); } },
    });
    assert.equal(logs.join(''), 'link app/.env\nlink app/link-me\nlink via-fn/.env\n');
    assertRelativeLink(path.join(repo.wt, 'app/.env'), path.join(repo.main, 'app/.env'));
    assertRelativeLink(path.join(repo.wt, 'app/link-me'), path.join(repo.main, 'app/link-me'));
    assert.equal(fs.existsSync(path.join(repo.wt, 'plain/.env')), false);
  } finally {
    repo.cleanup();
  }
});

test('the walker does not descend into node_modules', async () => {
  const repo = makeRepo({ gitignore: '.env\n' });
  try {
    writeRel(repo.main, 'pkg/MARKER', '');
    writeRel(repo.main, 'pkg/.env', 'PKG=1\n');
    writeRel(repo.main, 'pkg/node_modules/MARKER', '');
    writeRel(repo.main, 'pkg/node_modules/.env', 'HIDDEN=1\n');
    const logs = [];
    await linkWorktree(repo.wt, {
      rules: [{
        id: 'fixture',
        markers: ['MARKER'],
        linkPaths: [],
      }],
      stdout: { write(chunk) { logs.push(chunk); } },
    });
    assert.equal(logs.join(''), 'link pkg/.env\n');
    assert.equal(logs.join('').includes('node_modules'), false);
    assert.equal(fs.existsSync(path.join(repo.wt, 'pkg/node_modules/.env')), false);
  } finally {
    repo.cleanup();
  }
});

test('invalid TOML exits 1', () => {
  const bodies = [
    'enabled = 1\n',
    '[nested]\nenabled = true\n',
    'extra = { a = "b" }\n',
    'exclude = ["../x"]\n',
    'extra = ["/tmp/x"]\n',
    'extra = [""]\n',
    'unknown = true\n',
  ];
  for (const body of bodies) {
    const repo = makeRepo();
    try {
      writeRel(repo.main, '.env', 'A=1\n');
      writeRel(repo.main, '.symlinkr.toml', body);
      const result = runSymlinkr(['--dest', repo.wt]);
      assert.equal(result.status, 1, body);
      assert.equal(result.stdout, '', body);
      assert.match(result.stderr, /invalid \.symlinkr\.toml/, body);
      assert.equal(fs.existsSync(path.join(repo.wt, '.env')), false, body);
    } finally {
      repo.cleanup();
    }
  }
});

test('herdr-plugin.toml registers symlinkr on linux and macos', () => {
  const text = fs.readFileSync(path.join(root, 'herdr-plugin.toml'), 'utf8');
  assert.match(text, /^id = "symlinkr"$/m);
  assert.match(text, /^platforms = \["linux", "macos"\]$/m);
  assert.match(text, /^on = "worktree.created"$/m);
  assert.match(text, /^on = "worktree.opened"$/m);
  assert.match(text, /^id = "link"$/m);
  assert.match(text, /^contexts = \["workspace"\]$/m);
  const commands = text.match(/^command = \["node", "bin\/symlinkr\.js"\]$/gm);
  assert.equal(commands?.length, 3);
  assert.doesNotMatch(text, /\[\[build\]\]/);
  assert.doesNotMatch(text, /windows/);
});

test('package.json is a private module without dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, '>=20');
  assert.equal(pkg.scripts.test, 'node --test');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});

test('HERDR event JSON selects data.worktree.path and --dest wins', () => {
  const repo = makeRepo();
  try {
    writeRel(repo.main, '.env', 'A=1\n');
    const fromEvent = runSymlinkr([], {
      HERDR_PLUGIN_EVENT: 'worktree.created',
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        event: 'worktree_created',
        data: {
          workspace: { worktree: { repo_root: repo.main, checkout_path: repo.main } },
          worktree: { path: repo.wt },
        },
      }),
    });
    assert.equal(fromEvent.status, 0);
    assert.equal(fromEvent.stdout, 'link .env\n');
    assertRelativeLink(path.join(repo.wt, '.env'), path.join(repo.main, '.env'));
    fs.rmSync(path.join(repo.wt, '.env'));
    const destWins = runSymlinkr(['--dest', repo.wt], {
      HERDR_PLUGIN_EVENT: 'worktree.removed',
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ data: { worktree: { path: repo.main } } }),
    });
    assert.equal(destWins.status, 0);
    assert.equal(destWins.stdout, 'link .env\n');
    assertRelativeLink(path.join(repo.wt, '.env'), path.join(repo.main, '.env'));
  } finally {
    repo.cleanup();
  }
});

test('event JSON falls back to checkout_path and context JSON supplies the destination', () => {
  const repo = makeRepo();
  try {
    writeRel(repo.main, '.env', 'A=1\n');
    const fallback = runSymlinkr([], {
      HERDR_PLUGIN_EVENT: 'worktree.opened',
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        data: { workspace: { worktree: { checkout_path: repo.wt } } },
      }),
    });
    assert.equal(fallback.status, 0);
    assert.equal(fallback.stdout, 'link .env\n');
    fs.rmSync(path.join(repo.wt, '.env'));
    const context = runSymlinkr([], {
      HERDR_PLUGIN_ACTION_ID: 'link',
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        worktree: { checkout_path: repo.wt },
        workspace_cwd: repo.main,
      }),
    });
    assert.equal(context.status, 0);
    assert.equal(context.stdout, 'link .env\n');
  } finally {
    repo.cleanup();
  }
});

test('worktree.removed exits 0 without linking', () => {
  const repo = makeRepo();
  try {
    writeRel(repo.main, '.env', 'A=1\n');
    const result = runSymlinkr([], {
      HERDR_PLUGIN_EVENT: 'worktree.removed',
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ data: { worktree: { path: repo.wt } } }),
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(path.join(repo.wt, '.env')), false);
  } finally {
    repo.cleanup();
  }
});

test('missing destination, a non-worktree, and unreadable event JSON exit 1', () => {
  const missing = runSymlinkr([]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /missing destination/);

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'symlinkr-notgit-'));
  try {
    const notGit = runSymlinkr(['--dest', parent], { GIT_CEILING_DIRECTORIES: parent });
    assert.equal(notGit.status, 1);
    assert.match(notGit.stderr, /not inside a Git worktree/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }

  const bad = runSymlinkr([], { HERDR_PLUGIN_EVENT_JSON: '{' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unreadable event JSON/);
  assert.equal(bad.stdout, '');
});

test('loads rule modules in filename order and rejects duplicate ids', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symlinkr-rules-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
    fs.writeFileSync(path.join(dir, 'note.txt'), 'ignore\n');
    fs.writeFileSync(
      path.join(dir, 'b.js'),
      'export const id = "first"\nexport const markers = []\nexport const linkPaths = ["dep"]\n',
    );
    fs.writeFileSync(
      path.join(dir, 'a.js'),
      'export const id = "second"\nexport const markers = ["MARKER"]\nexport const linkPaths = []\n',
    );
    const rules = await loadRules(dir);
    assert.deepEqual(rules.map((rule) => rule.id), ['second', 'first']);
    assert.deepEqual(rules[0].markers, ['MARKER']);
    fs.writeFileSync(
      path.join(dir, 'c.js'),
      'export const id = "second"\nexport const markers = []\nexport const linkPaths = []\n',
    );
    await assert.rejects(() => loadRules(dir), /duplicate rule id second/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
