import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function sha1(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

export function newId(prefix = 'id') {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Convert a glob (supports **, *, ?, {a,b}, [abc]) to an anchored RegExp.
export function globToRegExp(glob) {
  const s = String(glob).replace(/\\/g, '/');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '*') {
      if (s[i + 1] === '*') {
        if (s[i + 2] === '/') {
          out += '(?:[^/]+/)*';
          i += 3;
          continue;
        }
        out += '.*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (c === '{') {
      const close = s.indexOf('}', i);
      if (close > i) {
        const alts = s.slice(i + 1, close).split(',').map(escapeRegex);
        out += `(?:${alts.join('|')})`;
        i = close + 1;
        continue;
      }
    }
    if (c === '[') {
      const close = s.indexOf(']', i);
      if (close > i) {
        out += s.slice(i, close + 1);
        i = close + 1;
        continue;
      }
    }
    out += escapeRegex(c);
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

export function matchGlob(filePath, pattern) {
  const file = String(filePath).replace(/\\/g, '/');
  const pat = String(pattern).replace(/\\/g, '/');
  if (globToRegExp(pat).test(file)) return true;
  // Convenience: a pattern with no slash matches a basename anywhere.
  if (!pat.includes('/')) {
    return globToRegExp(`**/${pat}`).test(file) || globToRegExp(pat).test(path.basename(file));
  }
  return false;
}

export function isProbablyBinary(buffer) {
  const len = Math.min(buffer.length, 8192);
  let suspicious = 0;
  for (let i = 0; i < len; i++) {
    const byte = buffer[i];
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious++;
  }
  return suspicious / Math.max(1, len) > 0.1;
}

export function truncateText(text, max, headRatio = 0.65) {
  const str = String(text ?? '');
  if (str.length <= max) return str;
  const head = Math.floor(max * headRatio);
  const tail = Math.max(0, max - head);
  const omitted = str.length - head - tail;
  return `${str.slice(0, head)}\n\n... [${omitted} chars truncated] ...\n\n${tail ? str.slice(-tail) : ''}`;
}

export function firstLine(text, max = 120) {
  const line = String(text ?? '').trim().split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function formatTokens(n) {
  const value = Number(n) || 0;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e4) return `${(value / 1e3).toFixed(1)}k`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(2)}k`;
  return String(Math.round(value));
}

export function formatCost(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  if (n < 0.0001) return `<$0.0001`;
  return `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

export function formatBytes(n) {
  const value = Number(n) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60000);
  const sec = Math.round((ms % 60000) / 1000);
  return `${min}m ${sec}s`;
}

export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

export function relativeTo(cwd, p) {
  const rel = path.relative(cwd, p);
  return rel.startsWith('..') ? p : rel;
}

export function withinDir(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function parseFrontmatter(text) {
  const source = String(text ?? '');
  if (!source.startsWith('---')) return { data: {}, body: source };
  const end = source.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: source };
  const header = source.slice(3, end).trim();
  const body = source.slice(end + 4).replace(/^\r?\n/, '');
  const data = {};
  for (const rawLine of header.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
    } else if (value === 'true') {
      data[key] = true;
    } else if (value === 'false') {
      data[key] = false;
    } else if (/^-?\d+$/.test(value)) {
      data[key] = parseInt(value, 10);
    } else {
      data[key] = unquote(value);
    }
  }
  return { data, body };
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  bull: '•',
  deg: '°',
  euro: '€',
  pound: '£',
  yen: '¥',
};

export function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' '))
    .replace(/[ \t\f\v]+/g, ' ')
    .trim();
}

export function htmlToText(html) {
  let text = String(html ?? '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<(script|style|noscript|template|svg|iframe)[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<head[\s\S]*?<\/head>/gi, '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '- ');
  text = text.replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|pre|table|blockquote|ul|ol|dl|dt|dd)>/gi, '\n');
  text = text.replace(/<(h[1-6])[^>]*>/gi, '\n\n');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trimEnd())
    .join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

export function extractTitle(html) {
  const match = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripTags(match[1]) : '';
}

export function estimateChars(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.length;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimateChars(item), 0);
  if (typeof value === 'object') {
    if (value.type === 'image') return 6000; // ~1500 tokens, base64 excluded
    let total = 0;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'data' && typeof child === 'string') {
        total += 8;
        continue;
      }
      total += key.length + estimateChars(child);
    }
    return total;
  }
  return 0;
}

export function estimateTokens(value) {
  return Math.ceil(estimateChars(value) / 4);
}

export function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function diffLines(oldText, newText, { maxLines = 1000 } = {}) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  if (a.length > maxLines || b.length > maxLines) return null;
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', line: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ type: 'del', line: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'del', line: a[i++] });
  while (j < m) ops.push({ type: 'add', line: b[j++] });
  return ops;
}

export function diffStats(ops) {
  if (!ops) return null;
  let add = 0;
  let del = 0;
  for (const op of ops) {
    if (op.type === 'add') add++;
    if (op.type === 'del') del++;
  }
  return { add, del };
}

export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function deepGet(obj, dotted) {
  return String(dotted)
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

export function deepSet(obj, dotted, value) {
  const keys = String(dotted).split('.').filter(Boolean);
  let cursor = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (cursor[key] == null || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
  return obj;
}

export function deepMerge(base, extra) {
  if (extra === undefined) return base;
  if (Array.isArray(base) || Array.isArray(extra)) return extra;
  if (
    base &&
    extra &&
    typeof base === 'object' &&
    typeof extra === 'object' &&
    !Array.isArray(base) &&
    !Array.isArray(extra)
  ) {
    const result = { ...base };
    for (const [key, value] of Object.entries(extra)) {
      result[key] = deepMerge(base[key], value);
    }
    return result;
  }
  return extra;
}

export function maskSecret(value) {
  if (!value) return '(not set)';
  const str = String(value);
  if (str.length <= 8) return '*'.repeat(str.length);
  return `${str.slice(0, 4)}…${str.slice(-4)}`;
}

export function writeFileAtomic(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  if (mode) {
    try {
      fs.chmodSync(tmp, mode);
    } catch {}
  }
  fs.renameSync(tmp, filePath);
}

export function ensureDir(dir, mode) {
  fs.mkdirSync(dir, { recursive: true, ...(mode ? { mode } : {}) });
  return dir;
}

export function plural(count, singular, pluralForm) {
  return count === 1 ? singular : pluralForm || `${singular}s`;
}

export function indent(text, prefix) {
  return String(text)
    .split('\n')
    .map((line) => (line ? prefix + line : line))
    .join('\n');
}

export function uniqBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function listFilesRecursive(root, { skipDirs, maxFiles = 20000 } = {}) {
  const skip = new Set(skipDirs || []);
  const files = [];
  const stack = [root];
  while (stack.length && files.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.git') && entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        files.push(full);
        if (files.length >= maxFiles) break;
      }
    }
  }
  return files;
}
