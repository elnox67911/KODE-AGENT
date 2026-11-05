import fs from 'node:fs';
import path from 'node:path';
import {
  diffLines,
  diffStats,
  expandHome,
  formatBytes,
  isProbablyBinary,
  listFilesRecursive,
  matchGlob,
  toPosix,
  truncateText,
} from '../utils.js';
import { fail, ok } from './common.js';

const IMAGE_MEDIA = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

const DEFAULT_SKIP_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  'target',
  '.idea',
  '.turbo',
];

function resolvePath(cwd, input) {
  return path.resolve(cwd, expandHome(String(input || '')));
}

function requireReadEnabled(config) {
  return config?.security?.requireReadBeforeWrite !== false;
}

export const readTool = {
  name: 'Read',
  description:
    'Read a file from the local filesystem. Returns numbered lines. Images (png/jpg/gif/webp) are returned as image content for vision models. Use offset and limit for large files. Read a file before editing it.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file.' },
      offset: { type: 'integer', description: '1-based line number to start from (default 1).' },
      limit: { type: 'integer', description: 'Maximum number of lines to return (default 2000).' },
    },
    required: ['file_path'],
  },
  async run(input, ctx) {
    if (!input?.file_path) return fail('Read requires "file_path".');
    const filePath = resolvePath(ctx.cwd, input.file_path);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return fail(`File not found: ${filePath}`);
    }
    if (stat.isDirectory()) {
      return fail(`Path is a directory, not a file: ${filePath}. Use Glob to list files.`);
    }
    const ext = path.extname(filePath).toLowerCase();
    if (IMAGE_MEDIA[ext]) {
      if (stat.size > 5 * 1024 * 1024) {
        return fail(`Image is too large (${formatBytes(stat.size)}). Limit is 5 MB.`);
      }
      const buffer = fs.readFileSync(filePath);
      ctx.session.recordFileRead(filePath, stat);
      return ok(
        [
          { type: 'text', text: `Image: ${filePath} (${formatBytes(stat.size)})` },
          { type: 'image', source: { type: 'base64', media_type: IMAGE_MEDIA[ext], data: buffer.toString('base64') } },
        ],
        { summary: `image · ${formatBytes(stat.size)}` }
      );
    }
    if (ext === '.pdf') {
      return fail('PDF files are not supported by Read. Use a PDF-to-text tool (e.g. pdftotext) via Bash.');
    }
    if (stat.size > 10 * 1024 * 1024) {
      return fail(`File is too large (${formatBytes(stat.size)}). Limit is 10 MB. Use Bash with head/sed to read parts.`);
    }
    const buffer = fs.readFileSync(filePath);
    if (isProbablyBinary(buffer)) {
      return fail(`File appears to be binary: ${filePath}`);
    }
    const content = buffer.toString('utf8');
    const lines = content.split('\n');
    const offset = Math.max(1, Number(input.offset) || 1);
    const limit = Math.min(Math.max(1, Number(input.limit) || 2000), 5000);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    if (!slice.length) {
      return ok(`${filePath} has ${lines.length} lines; offset ${offset} is past the end.`, {
        summary: `0 lines · file has ${lines.length}`,
      });
    }
    const numbered = slice
      .map((line, index) => {
        const shown = line.length > 2000 ? `${line.slice(0, 2000)}…` : line;
        return `${String(offset + index).padStart(6, ' ')}→${shown}`;
      })
      .join('\n');
    const shownEnd = offset + slice.length - 1;
    const remaining = lines.length - shownEnd;
    const header = `${filePath} (${lines.length} lines)`;
    const footer =
      remaining > 0
        ? `\n\n... (${remaining} more lines; continue with offset=${shownEnd + 1})`
        : offset > 1
          ? `\n\n(showing lines ${offset}-${shownEnd} of ${lines.length})`
          : '';
    ctx.session.recordFileRead(filePath, stat);
    return ok(truncateText(`${header}\n${numbered}${footer}`, 180000), {
      summary: `${lines.length} lines · ${formatBytes(stat.size)}`,
    });
  },
};

export const writeTool = {
  name: 'Write',
  description:
    'Write content to a file, overwriting it (creates parent directories). Prefer Edit for partial changes. You must Read an existing file before overwriting it.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to write.' },
      content: { type: 'string', description: 'Full file content.' },
    },
    required: ['file_path', 'content'],
  },
  async run(input, ctx) {
    if (!input?.file_path) return fail('Write requires "file_path".');
    if (typeof input.content !== 'string') return fail('Write requires "content" as a string.');
    const filePath = resolvePath(ctx.cwd, input.file_path);
    let existed = false;
    let previous = null;
    let stat = null;
    try {
      stat = fs.statSync(filePath);
      existed = true;
    } catch {}
    if (existed && stat.isDirectory()) return fail(`Cannot write: ${filePath} is a directory.`);

    if (existed) {
      if (requireReadEnabled(ctx.config)) {
        const check = ctx.session.checkFileRead(filePath);
        if (!check.ok) {
          const reason =
            check.reason === 'not-read'
              ? 'You must Read this file before writing to it.'
              : check.reason === 'modified'
                ? 'The file changed on disk since you read it. Read it again before writing.'
                : 'The file no longer exists on disk. Read or create it again.';
          return fail(`${reason}\n${filePath}`);
        }
      }
      const buffer = fs.readFileSync(filePath);
      if (isProbablyBinary(buffer)) return fail(`Refusing to overwrite binary file: ${filePath}`);
      previous = buffer.toString('utf8');
    }

    const ops = existed ? diffLines(previous, input.content) : null;
    const stats = ops ? diffStats(ops) : null;
    ctx.session.checkpoint([{ path: filePath, existed, previous }]);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, input.content);
    ctx.session.recordFileRead(filePath, fs.statSync(filePath));

    const lineCount = input.content.split('\n').length;
    const output = existed
      ? `Updated ${filePath} (${lineCount} lines${stats ? `, +${stats.add} -${stats.del}` : ''}).`
      : `Created ${filePath} (${lineCount} lines).`;
    return ok(output, {
      summary: existed ? `updated · +${stats?.add ?? 0} -${stats?.del ?? 0}` : `created · ${lineCount} lines`,
      diff: ops,
      stats,
    });
  },
};

export const editTool = {
  name: 'Edit',
  description:
    'Replace an exact string in a file. old_string must match exactly (including whitespace) and must be unique unless replace_all is true. Use the edits array for multiple replacements. You must Read the file first.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to edit.' },
      old_string: { type: 'string', description: 'Exact text to replace.' },
      new_string: { type: 'string', description: 'Replacement text (can be empty).' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
      edits: {
        type: 'array',
        description: 'Optional batch of edits applied in order.',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string' },
            new_string: { type: 'string' },
            replace_all: { type: 'boolean' },
          },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['file_path'],
  },
  async run(input, ctx) {
    if (!input?.file_path) return fail('Edit requires "file_path".');
    const edits = Array.isArray(input.edits) && input.edits.length
      ? input.edits
      : [{ old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all }];
    for (const edit of edits) {
      if (typeof edit.old_string !== 'string' || !edit.old_string) {
        return fail('Each edit requires a non-empty "old_string".');
      }
      if (typeof edit.new_string !== 'string') {
        return fail('Each edit requires "new_string" (use an empty string to delete).');
      }
    }
    const filePath = resolvePath(ctx.cwd, input.file_path);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return fail(`File not found: ${filePath}`);
    }
    if (stat.isDirectory()) return fail(`Cannot edit a directory: ${filePath}`);
    if (requireReadEnabled(ctx.config)) {
      const check = ctx.session.checkFileRead(filePath);
      if (!check.ok) {
        const reason =
          check.reason === 'not-read'
            ? 'You must Read this file before editing it.'
            : check.reason === 'modified'
              ? 'The file changed on disk since you read it. Read it again before editing.'
              : 'The file no longer exists on disk.';
        return fail(`${reason}\n${filePath}`);
      }
    }
    const buffer = fs.readFileSync(filePath);
    if (isProbablyBinary(buffer)) return fail(`Refusing to edit binary file: ${filePath}`);
    const original = buffer.toString('utf8');
    let updated = original;
    let replacements = 0;

    for (const edit of edits) {
      const occurrences = updated.split(edit.old_string).length - 1;
      if (occurrences === 0) {
        return fail(
          `old_string was not found in ${filePath}. Read the file and copy the exact text (including whitespace).`,
          {
            preview: `old_string:\n${truncateText(edit.old_string, 600)}`,
          }
        );
      }
      if (occurrences > 1 && !edit.replace_all) {
        return fail(
          `old_string appears ${occurrences} times in ${filePath}. Add surrounding context to make it unique, or set replace_all=true.`
        );
      }
      if (edit.replace_all) {
        updated = updated.split(edit.old_string).join(edit.new_string);
        replacements += occurrences;
      } else {
        const index = updated.indexOf(edit.old_string);
        updated = `${updated.slice(0, index)}${edit.new_string}${updated.slice(index + edit.old_string.length)}`;
        replacements += 1;
      }
    }

    if (updated === original) {
      return ok(`No changes made to ${filePath}.`, { summary: 'no changes' });
    }

    const ops = diffLines(original, updated);
    const stats = diffStats(ops);
    ctx.session.checkpoint([{ path: filePath, existed: true, previous: original }]);
    fs.writeFileSync(filePath, updated);
    ctx.session.recordFileRead(filePath, fs.statSync(filePath));
    return ok(`Edited ${filePath} (${replacements} replacement${replacements === 1 ? '' : 's'}, +${stats?.add ?? 0} -${stats?.del ?? 0}).`, {
      summary: `${replacements} replacement${replacements === 1 ? '' : 's'} · +${stats?.add ?? 0} -${stats?.del ?? 0}`,
      diff: ops,
      stats,
    });
  },
};

export const globTool = {
  name: 'Glob',
  description:
    'Find files by glob pattern. Supports **, *, ?, [abc], and {a,b}. Results are sorted by modification time (newest first) and limited to 200 by default. Skips node_modules, .git, build outputs, and virtualenvs.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts" or "**/*.md".' },
      path: { type: 'string', description: 'Directory to search (defaults to cwd).' },
      limit: { type: 'integer', description: 'Maximum results (default 200, max 2000).' },
    },
    required: ['pattern'],
  },
  async run(input, ctx) {
    const pattern = String(input?.pattern || '').trim();
    if (!pattern) return fail('Glob requires "pattern".');
    const root = resolvePath(ctx.cwd, input.path || '.');
    let rootStat;
    try {
      rootStat = fs.statSync(root);
    } catch {
      return fail(`Search path not found: ${root}`);
    }
    const limit = Math.min(Math.max(1, Number(input.limit) || 200), 2000);
    if (rootStat.isFile()) {
      return ok(toPosix(path.relative(ctx.cwd, root)), { summary: '1 file' });
    }
    const skip = DEFAULT_SKIP_DIRS.filter((dir) => !pattern.includes(dir));
    const files = listFilesRecursive(root, { skipDirs: skip, maxFiles: 50000 });
    const matches = [];
    for (const file of files) {
      const relative = toPosix(path.relative(root, file));
      const matchesPattern =
        matchGlob(relative, pattern) ||
        (path.isAbsolute(pattern) && matchGlob(toPosix(file), pattern));
      if (!matchesPattern) continue;
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      matches.push({ file, relative, mtime: stat.mtimeMs });
    }
    matches.sort((a, b) => b.mtime - a.mtime);
    const shown = matches.slice(0, limit);
    if (!shown.length) return ok('No files matched.', { summary: '0 files' });
    const lines = shown.map((item) => toPosix(path.relative(ctx.cwd, item.file)));
    const suffix = matches.length > shown.length ? `\n\n... (${matches.length - shown.length} more matches)` : '';
    return ok(`${lines.join('\n')}${suffix}`, {
      summary: `${matches.length} file${matches.length === 1 ? '' : 's'}`,
    });
  },
};

function gatherFiles(root, globPattern) {
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    return [];
  }
  if (stat.isFile()) return [root];
  const skip = DEFAULT_SKIP_DIRS.filter((dir) => !globPattern?.includes(dir));
  let files = listFilesRecursive(root, { skipDirs: skip, maxFiles: 50000 });
  if (globPattern) {
    files = files.filter((file) => {
      const relative = toPosix(path.relative(root, file));
      return matchGlob(relative, globPattern) || matchGlob(path.basename(file), globPattern);
    });
  }
  return files.sort();
}

export const grepTool = {
  name: 'Grep',
  description:
    'Search file contents with a regular expression (ripgrep-like). Use output_mode "files_with_matches" for paths only, "count" for per-file counts, or "content" for matching lines. Filter with glob. Returns up to head_limit lines.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'File or directory to search (defaults to cwd).' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.js".' },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: 'Output format (default content).',
      },
      ignore_case: { type: 'boolean', description: 'Case-insensitive search.' },
      context: { type: 'integer', description: 'Lines of context around matches (content mode, default 0).' },
      head_limit: { type: 'integer', description: 'Maximum output lines (default 250).' },
    },
    required: ['pattern'],
  },
  async run(input, ctx) {
    const pattern = String(input?.pattern ?? '');
    if (!pattern) return fail('Grep requires "pattern".');
    let regex;
    try {
      regex = new RegExp(pattern, input.ignore_case ? 'i' : '');
    } catch (err) {
      return fail(`Invalid regular expression: ${err.message}`);
    }
    const root = resolvePath(ctx.cwd, input.path || '.');
    const mode = ['content', 'files_with_matches', 'count'].includes(input.output_mode)
      ? input.output_mode
      : 'content';
    const headLimit = Math.min(Math.max(1, Number(input.head_limit) || 250), 5000);
    const context = mode === 'content' ? Math.min(Math.max(0, Number(input.context) || 0), 10) : 0;
    const files = gatherFiles(root, input.glob);
    if (!files.length) return ok('No files found to search.', { summary: '0 files' });

    let totalMatches = 0;
    let filesWithMatches = 0;
    let outputLines = 0;
    const out = [];
    const limitHit = () => outputLines >= headLimit;

    for (const file of files) {
      if (limitHit()) break;
      let buffer;
      try {
        buffer = fs.readFileSync(file);
      } catch {
        continue;
      }
      if (buffer.length > 2 * 1024 * 1024 || isProbablyBinary(buffer)) continue;
      const lines = buffer.toString('utf8').split('\n');
      const relative = toPosix(path.relative(ctx.cwd, file));
      const matchIndices = [];
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) matchIndices.push(i);
      }
      if (!matchIndices.length) continue;
      filesWithMatches++;
      totalMatches += matchIndices.length;

      if (mode === 'files_with_matches') {
        out.push(relative);
        outputLines++;
        continue;
      }
      if (mode === 'count') {
        out.push(`${relative}:${matchIndices.length}`);
        outputLines++;
        continue;
      }

      const ranges = [];
      for (const index of matchIndices) {
        const start = Math.max(0, index - context);
        const end = Math.min(lines.length - 1, index + context);
        const last = ranges[ranges.length - 1];
        if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
        else ranges.push([start, end]);
      }
      const matched = new Set(matchIndices);
      outer: for (let r = 0; r < ranges.length; r++) {
        const [start, end] = ranges[r];
        if (r > 0) {
          if (limitHit()) break;
          out.push('--');
          outputLines++;
        }
        for (let i = start; i <= end; i++) {
          if (limitHit()) break outer;
          const separator = matched.has(i) ? ':' : '-';
          out.push(`${relative}${separator}${i + 1}${separator} ${lines[i].slice(0, 400)}`);
          outputLines++;
        }
      }
    }

    if (!out.length) return ok('No matches found.', { summary: '0 matches' });
    const suffix = limitHit() ? `\n\n... (output limited to ${headLimit} lines; ${totalMatches} total matches in ${filesWithMatches} files)` : '';
    return ok(`${out.join('\n')}${suffix}`, {
      summary: `${totalMatches} match${totalMatches === 1 ? '' : 'es'} in ${filesWithMatches} file${filesWithMatches === 1 ? '' : 's'}`,
    });
  },
};
