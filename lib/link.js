import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { assertInsideWorktree, git, mainWorktreePath } from './git.js';
import { loadRules } from './rules.js';
import { collectCandidates } from './walk.js';

function writeLine(stdout, line) {
  stdout.write(`${line}\n`);
}

function isSafeRel(rel) {
  if (typeof rel !== 'string' || rel === '') return false;
  if (rel.includes('\\') || path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)) return false;
  return rel.split('/').every((segment) => segment !== '' && segment !== '..');
}

function ensureParents(destRoot, rel) {
  const parts = rel.split('/');
  let current = destRoot;
  for (let i = 0; i < parts.length - 1; i += 1) {
    current = path.join(current, parts[i]);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(current);
    }
  }
  return true;
}

function sameRealpath(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
}

async function outcomeFor(main, dest, rel, exclude) {
  if (!isSafeRel(rel)) return 'invalid-path';
  if (exclude.has(rel)) return 'excluded';
  const source = path.join(main, ...rel.split('/'));
  try {
    fs.lstatSync(source);
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing-source';
    throw error;
  }
  const ignored = await git(dest, ['check-ignore', '-q', '--', rel]);
  if (ignored.code === 1) return 'not-ignored';
  if (ignored.code !== 0) {
    throw new Error(ignored.stderr.trim() || `git check-ignore failed (${ignored.code})`);
  }
  if (!ensureParents(dest, rel)) return 'invalid-path';
  const destPath = path.join(dest, ...rel.split('/'));
  try {
    const stat = fs.lstatSync(destPath);
    if (stat.isSymbolicLink()) {
      return sameRealpath(destPath, source) ? 'unchanged' : 'wrong-target';
    }
    return 'exists';
  } catch (error) {
    if (error.code === 'ENOENT') return 'link';
    throw error;
  }
}

export async function linkWorktree(destInput, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const rules = options.rules ?? await loadRules();
  let dest;
  try {
    dest = fs.realpathSync(path.resolve(destInput));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('destination is not inside a Git worktree');
    throw error;
  }
  await assertInsideWorktree(dest);
  const main = fs.realpathSync(await mainWorktreePath(dest));
  if (main === dest) {
    writeLine(stdout, 'skip . self');
    return;
  }
  const config = loadConfig(main);
  if (!config.enabled) {
    writeLine(stdout, 'skip . disabled');
    return;
  }
  const exclude = new Set(config.exclude);
  const candidates = await collectCandidates(main, rules);
  for (const extra of config.extra) candidates.add(extra);
  const ordered = [...candidates].sort((a, b) => a.localeCompare(b));
  for (const rel of ordered) {
    const outcome = await outcomeFor(main, dest, rel, exclude);
    if (outcome === 'link') {
      const source = path.join(main, ...rel.split('/'));
      const destPath = path.join(dest, ...rel.split('/'));
      fs.symlinkSync(path.relative(path.dirname(destPath), source), destPath);
      writeLine(stdout, `link ${rel}`);
    } else {
      writeLine(stdout, `skip ${rel} ${outcome}`);
    }
  }
}
