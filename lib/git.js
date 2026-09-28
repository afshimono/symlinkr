import { spawn } from 'node:child_process';

function gitEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

export function git(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], {
      shell: false,
      env: gitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

export function parseWorktreeList(text) {
  const records = [];
  let current = {};
  for (const part of text.split('\0')) {
    if (part === '') {
      if (current.worktree) records.push(current);
      current = {};
      continue;
    }
    const space = part.indexOf(' ');
    if (space === -1) current[part] = true;
    else current[part.slice(0, space)] = part.slice(space + 1);
  }
  if (current.worktree) records.push(current);
  return records;
}

export async function assertInsideWorktree(dest) {
  const inside = await git(dest, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    throw new Error('destination is not inside a Git worktree');
  }
}

export async function mainWorktreePath(dest) {
  const listed = await git(dest, ['worktree', 'list', '--porcelain', '-z']);
  if (listed.code !== 0) {
    throw new Error(listed.stderr.trim() || 'git worktree list failed');
  }
  const main = parseWorktreeList(listed.stdout)[0]?.worktree;
  if (!main) throw new Error('git worktree list failed');
  return main;
}
