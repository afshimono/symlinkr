import fs from 'node:fs';
import path from 'node:path';

const ALLOWED_KEYS = new Set(['enabled', 'extra', 'exclude']);
const ESCAPES = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
};

function invalid() {
  return new Error('invalid .symlinkr.toml');
}

function stripComment(line) {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function parseStringArray(raw) {
  if (!(raw.startsWith('[') && raw.endsWith(']'))) throw invalid();
  const inner = raw.slice(1, -1);
  const values = [];
  let i = 0;
  const skipSpace = () => {
    while (i < inner.length && (inner[i] === ' ' || inner[i] === '\t')) i += 1;
  };
  skipSpace();
  if (i >= inner.length) return values;
  for (;;) {
    if (inner[i] !== '"') throw invalid();
    i += 1;
    let value = '';
    let closed = false;
    while (i < inner.length) {
      const ch = inner[i];
      if (ch === '\\') {
        const mapped = ESCAPES[inner[i + 1]];
        if (mapped === undefined) throw invalid();
        value += mapped;
        i += 2;
        continue;
      }
      if (ch === '"') {
        closed = true;
        i += 1;
        break;
      }
      value += ch;
      i += 1;
    }
    if (!closed) throw invalid();
    values.push(value);
    skipSpace();
    if (i >= inner.length) return values;
    if (inner[i] !== ',') throw invalid();
    i += 1;
    skipSpace();
    if (i >= inner.length) throw invalid();
  }
}

export function normalizeRel(input) {
  const norm = String(input).replaceAll('\\', '/');
  if (
    norm === ''
    || path.posix.isAbsolute(norm)
    || path.win32.isAbsolute(input)
    || path.win32.isAbsolute(norm)
  ) {
    throw invalid();
  }
  const segments = norm.split('/');
  if (segments.some((segment) => segment === '' || segment === '..')) throw invalid();
  return segments.join('/');
}

export function parseSymlinkrToml(text) {
  const config = { enabled: true, extra: [], exclude: [] };
  const seen = new Set();
  for (const original of text.split(/\r?\n/)) {
    const line = stripComment(original).trim();
    if (line === '') continue;
    if (line.startsWith('[') || line.startsWith('{')) throw invalid();
    const eq = line.indexOf('=');
    if (eq === -1) throw invalid();
    const key = line.slice(0, eq).trim();
    const rawValue = line.slice(eq + 1).trim();
    if (!ALLOWED_KEYS.has(key) || seen.has(key)) throw invalid();
    seen.add(key);
    if (key === 'enabled') {
      if (rawValue === 'true') config.enabled = true;
      else if (rawValue === 'false') config.enabled = false;
      else throw invalid();
    } else {
      config[key] = parseStringArray(rawValue).map(normalizeRel);
    }
  }
  return config;
}

export function loadConfig(mainRoot) {
  const file = path.join(mainRoot, '.symlinkr.toml');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { enabled: true, extra: [], exclude: [] };
    throw error;
  }
  return parseSymlinkrToml(text);
}
