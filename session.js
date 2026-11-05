import fs from 'node:fs';
import path from 'node:path';
import { projectPaths } from './config.js';
import { ensureDir, newId, safeJsonParse, truncateText, writeFileAtomic } from './utils.js';

const SESSION_VERSION = 1;

export class Session {
  constructor(data = {}) {
    this.version = SESSION_VERSION;
    this.id = data.id || newId('ses');
    this.title = data.title || 'Untitled session';
    this.cwd = data.cwd || process.cwd();
    this.provider = data.provider || '';
    this.model = data.model || '';
    this.mode = data.mode || 'default';
    this.createdAt = data.createdAt || new Date().toISOString();
    this.updatedAt = data.updatedAt || this.createdAt;
    this.messages = Array.isArray(data.messages) ? data.messages : [];
    this.usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      costKnown: true,
      requests: 0,
      ...(data.usage || {}),
    };
    this.todos = Array.isArray(data.todos) ? data.todos : [];
    this.checkpoints = Array.isArray(data.checkpoints) ? data.checkpoints : [];
    this.allowRules = Array.isArray(data.allowRules) ? data.allowRules : [];
    this.denyRules = Array.isArray(data.denyRules) ? data.denyRules : [];
    this.fileReads = data.fileReads && typeof data.fileReads === 'object' ? data.fileReads : {};
    this.savedAt = data.savedAt || null;
    this.filePath = data.filePath || null;
  }

  static create({ cwd, provider, model, mode = 'default' }) {
    return new Session({ cwd, provider, model, mode });
  }

  get directory() {
    return projectPaths(this.cwd).sessions;
  }

  get path() {
    return this.filePath || path.join(this.directory, `${this.id}.json`);
  }

  touchTitle(text) {
    if (this.title !== 'Untitled session') return;
    const line = String(text || '').replace(/\s+/g, ' ').trim();
    if (line) this.title = truncateText(line, 72);
  }

  addUsage(usage = {}, cost = null) {
    this.usage.input += usage.input || 0;
    this.usage.output += usage.output || 0;
    this.usage.cacheRead += usage.cacheRead || 0;
    this.usage.cacheWrite += usage.cacheWrite || 0;
    this.usage.requests += 1;
    if (cost === null) this.usage.costKnown = false;
    else this.usage.cost += cost;
  }

  addAllowRule(rule) {
    if (rule && !this.allowRules.includes(rule)) this.allowRules.push(rule);
  }

  addDenyRule(rule) {
    if (rule && !this.denyRules.includes(rule)) this.denyRules.push(rule);
  }

  checkpoint(files) {
    const seen = new Set();
    const entries = [];
    for (const file of files) {
      if (!file?.path || seen.has(file.path)) continue;
      seen.add(file.path);
      entries.push({
        path: file.path,
        existed: Boolean(file.existed),
        previous: typeof file.previous === 'string' && file.previous.length <= 5 * 1024 * 1024 ? file.previous : null,
        skipped: typeof file.previous === 'string' && file.previous.length > 5 * 1024 * 1024,
      });
    }
    if (!entries.length) return null;
    const entry = { id: newId('cp'), time: new Date().toISOString(), files: entries };
    this.checkpoints.push(entry);
    if (this.checkpoints.length > 50) this.checkpoints.shift();
    return entry;
  }

  undoLastCheckpoint() {
    const entry = this.checkpoints.pop();
    if (!entry) return null;
    const restored = [];
    for (const file of entry.files) {
      try {
        if (!file.existed) {
          fs.rmSync(file.path, { force: true });
          restored.push({ path: file.path, action: 'deleted' });
        } else if (file.skipped) {
          restored.push({ path: file.path, action: 'skipped (file too large)' });
        } else {
          ensureDir(path.dirname(file.path));
          writeFileAtomic(file.path, file.previous ?? '');
          restored.push({ path: file.path, action: 'restored' });
        }
      } catch (err) {
        restored.push({ path: file.path, action: `failed: ${err.message}` });
      }
    }
    return { entry, restored };
  }

  recordFileRead(filePath, stat) {
    this.fileReads[filePath] = { mtimeMs: stat.mtimeMs, size: stat.size, at: Date.now() };
  }

  checkFileRead(filePath) {
    const record = this.fileReads[filePath];
    if (!record) return { ok: false, reason: 'not-read' };
    try {
      const stat = fs.statSync(filePath);
      if (Math.abs(stat.mtimeMs - record.mtimeMs) > 1) return { ok: false, reason: 'modified' };
    } catch {
      return { ok: false, reason: 'missing' };
    }
    return { ok: true };
  }

  save() {
    this.updatedAt = new Date().toISOString();
    this.savedAt = this.updatedAt;
    ensureDir(this.directory, 0o700);
    writeFileAtomic(this.path, `${JSON.stringify(this.toJSON(), null, 2)}\n`, 0o600);
    return this.path;
  }

  toJSON() {
    return {
      version: SESSION_VERSION,
      id: this.id,
      title: this.title,
      cwd: this.cwd,
      provider: this.provider,
      model: this.model,
      mode: this.mode,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      savedAt: this.savedAt,
      messages: this.messages,
      usage: this.usage,
      todos: this.todos,
      checkpoints: this.checkpoints,
      allowRules: this.allowRules,
      denyRules: this.denyRules,
      fileReads: this.fileReads,
    };
  }
}

export function listSessions(cwd, limit = 30) {
  const { sessions } = projectPaths(cwd);
  let files = [];
  try {
    files = fs
      .readdirSync(sessions)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const filePath = path.join(sessions, name);
        try {
          return { filePath, mtime: fs.statSync(filePath).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  } catch {
    return [];
  }
  const out = [];
  for (const { filePath, mtime } of files) {
    const data = safeJsonParse(fs.readFileSync(filePath, 'utf8'), null);
    if (!data) continue;
    out.push({
      id: data.id,
      title: data.title || 'Untitled session',
      updatedAt: data.updatedAt,
      mtime,
      messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
      provider: data.provider,
      model: data.model,
      filePath,
    });
  }
  return out;
}

export function findSessionFile(cwd, selector) {
  if (!selector || selector === 'latest') {
    return listSessions(cwd, 1)[0]?.filePath || null;
  }
  const direct = fs.existsSync(selector) ? selector : null;
  if (direct) return direct;
  const matches = listSessions(cwd, 200).filter(
    (item) => item.id === selector || item.id.startsWith(selector)
  );
  return matches[0]?.filePath || null;
}

export function loadSession(cwd, selector) {
  const filePath = findSessionFile(cwd, selector);
  if (!filePath) return null;
  const data = safeJsonParse(fs.readFileSync(filePath, 'utf8'), null);
  if (!data) throw new Error(`Could not parse session file: ${filePath}`);
  return new Session({ ...data, filePath });
}

export function pruneSessions(cwd, keep = 50) {
  const items = listSessions(cwd, 200);
  for (const item of items.slice(keep)) {
    try {
      fs.rmSync(item.filePath, { force: true });
    } catch {}
  }
}
