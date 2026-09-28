import { linkWorktree } from '../lib/link.js';

function resolveDestination(argv, env) {
  const destIndex = argv.indexOf('--dest');
  if (destIndex !== -1) {
    const value = argv[destIndex + 1];
    if (!value || value.startsWith('--')) throw new Error('missing destination');
    return { dest: value };
  }
  if (env.HERDR_PLUGIN_EVENT === 'worktree.removed') return { skip: true };
  if (env.HERDR_PLUGIN_EVENT_JSON) {
    let parsed;
    try {
      parsed = JSON.parse(env.HERDR_PLUGIN_EVENT_JSON);
    } catch {
      throw new Error('unreadable event JSON');
    }
    const dest = parsed?.data?.worktree?.path || parsed?.data?.workspace?.worktree?.checkout_path;
    if (typeof dest !== 'string' || dest === '') throw new Error('missing destination');
    return { dest };
  }
  if (env.HERDR_PLUGIN_CONTEXT_JSON) {
    let parsed;
    try {
      parsed = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON);
    } catch {
      throw new Error('unreadable event JSON');
    }
    const dest = parsed?.worktree?.checkout_path || parsed?.workspace_cwd;
    if (typeof dest !== 'string' || dest === '') throw new Error('missing destination');
    return { dest };
  }
  throw new Error('missing destination');
}

try {
  const resolved = resolveDestination(process.argv.slice(2), process.env);
  if (!resolved.skip) await linkWorktree(resolved.dest);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
