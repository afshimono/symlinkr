import fs from 'node:fs/promises';
import path from 'node:path';

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  'vendor',
  'deps',
  'target',
  'build',
  'dist',
  'bin',
  'obj',
  '_build',
  '.gradle',
  'dist-newstyle',
  '.stack-work',
  'cmake-build-debug',
  '.yarn',
  '.next',
  '.turbo',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
]);

function isEnvCandidate(name) {
  return name === '.env' || name === '.env.local' || /^\.env\..+\.local$/.test(name);
}

function activates(rule, name) {
  if (Array.isArray(rule.markers) && rule.markers.includes(name)) return true;
  return typeof rule.matchesMarker === 'function' && Boolean(rule.matchesMarker(name));
}

function joinRel(dirRel, child) {
  const normalized = String(child).replaceAll('\\', '/');
  return dirRel ? `${dirRel}/${normalized}` : normalized;
}

export async function collectCandidates(root, rules) {
  const found = new Set();

  async function walk(dir, rel) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const active = rules.filter((rule) => entries.some((entry) => activates(rule, entry.name)));
    if (rel === '' || active.length > 0) {
      for (const entry of entries) {
        if (isEnvCandidate(entry.name)) found.add(joinRel(rel, entry.name));
      }
    }
    for (const rule of active) {
      for (const linkPath of rule.linkPaths ?? []) found.add(joinRel(rel, linkPath));
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(path.join(dir, entry.name), joinRel(rel, entry.name));
    }
  }

  await walk(root, '');
  return found;
}
