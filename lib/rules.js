import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const defaultDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'rules');

function normalizeRule(mod, file) {
  if (typeof mod.id !== 'string' || mod.id === '') {
    throw new Error(`invalid rule module ${file}`);
  }
  if (!Array.isArray(mod.markers) || !Array.isArray(mod.linkPaths)) {
    throw new Error(`invalid rule module ${file}`);
  }
  return {
    id: mod.id,
    markers: mod.markers,
    linkPaths: mod.linkPaths,
    matchesMarker: mod.matchesMarker,
  };
}

export async function loadRules(dir = defaultDir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const rules = [];
  const seen = new Set();
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(dir, file)).href);
    const rule = normalizeRule(mod, file);
    if (seen.has(rule.id)) throw new Error(`duplicate rule id ${rule.id}`);
    seen.add(rule.id);
    rules.push(rule);
  }
  return rules;
}
