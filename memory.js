import fs from 'node:fs';
import path from 'node:path';
import { USER_MEMORY_DIR, projectPaths } from '../config.js';
import { ensureDir, truncateText, withinDir } from '../utils.js';
import { listMemoryFiles } from '../memory.js';
import { fail, ok } from './common.js';

function resolveMemoryPath(input, ctx, { mustExist = false } = {}) {
  const scope = input.scope === 'user' ? 'user' : 'project';
  const root = scope === 'user' ? USER_MEMORY_DIR : projectPaths(ctx.cwd).memory;
  let relative = String(input.path || '').trim();
  if (!relative) return { error: 'This command requires "path".' };
  if (path.isAbsolute(relative)) return { error: 'Use a path relative to the memory directory.' };
  if (!relative.endsWith('.md')) relative += '.md';
  const full = path.resolve(root, relative);
  if (!withinDir(full, root)) return { error: `Path escapes the memory directory: ${relative}` };
  if (mustExist && !fs.existsSync(full)) return { error: `Memory file not found: ${relative}` };
  return { root, scope, relative, full };
}

function readMemory(root) {
  const files = listMemoryFiles(root);
  const indexFile = path.join(root, 'MEMORY.md');
  let index = '';
  if (fs.existsSync(indexFile)) index = truncateText(fs.readFileSync(indexFile, 'utf8'), 15000);
  return { files, index, indexFile };
}

export const memoryTool = {
  name: 'Memory',
  description:
    'Read and write persistent memory files (markdown) for the project or the user. Use "view" to list or read memory, "create" to write a file, "str_replace" to edit, "insert" to add a line, and "delete" to remove one. Keep MEMORY.md as an index of other memory files.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        enum: ['view', 'create', 'str_replace', 'insert', 'delete'],
        description: 'Operation to perform.',
      },
      scope: { type: 'string', enum: ['project', 'user'], description: 'Memory scope (default project).' },
      path: { type: 'string', description: 'Relative path under the memory directory (e.g. "feedback/testing.md").' },
      content: { type: 'string', description: 'Content for create/insert.' },
      old_string: { type: 'string', description: 'Text to replace for str_replace.' },
      new_string: { type: 'string', description: 'Replacement text for str_replace.' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences for str_replace.' },
      insert_line: { type: 'integer', description: '1-based line to insert before for insert (default append).' },
    },
    required: ['command'],
  },
  async run(input, ctx) {
    const command = input?.command;
    if (command === 'view' && !input.path) {
      const scope = input.scope === 'user' ? 'user' : 'project';
      const root = scope === 'user' ? USER_MEMORY_DIR : projectPaths(ctx.cwd).memory;
      const { files, index, indexFile } = readMemory(root);
      const listing = files
        .map((file) => `- ${path.relative(root, file.path)} (${file.size} bytes)`)
        .join('\n');
      const body = [
        `Memory directory (${scope}): ${root}`,
        '',
        files.length ? listing : '(no memory files yet)',
        index ? `\n--- ${indexFile} ---\n${index}` : '',
      ].join('\n');
      return ok(body, { summary: `${files.length} memory files · ${scope}` });
    }

    if (command === 'view') {
      const resolved = resolveMemoryPath(input, ctx, { mustExist: true });
      if (resolved.error) return fail(resolved.error);
      const content = truncateText(fs.readFileSync(resolved.full, 'utf8'), 60000);
      return ok(`${resolved.full}\n\n${content}`, { summary: `${content.split('\n').length} lines` });
    }

    if (command === 'create') {
      if (typeof input.content !== 'string') return fail('create requires "content".');
      const resolved = resolveMemoryPath(input, ctx);
      if (resolved.error) return fail(resolved.error);
      ensureDir(path.dirname(resolved.full), 0o700);
      fs.writeFileSync(resolved.full, input.content);
      return ok(`Wrote memory file ${resolved.relative} (${input.content.length} chars).`, {
        summary: `wrote ${resolved.relative}`,
      });
    }

    if (command === 'str_replace') {
      if (typeof input.old_string !== 'string' || !input.old_string) {
        return fail('str_replace requires non-empty "old_string".');
      }
      if (typeof input.new_string !== 'string') return fail('str_replace requires "new_string".');
      const resolved = resolveMemoryPath(input, ctx, { mustExist: true });
      if (resolved.error) return fail(resolved.error);
      const original = fs.readFileSync(resolved.full, 'utf8');
      const occurrences = original.split(input.old_string).length - 1;
      if (!occurrences) return fail(`old_string was not found in ${resolved.relative}.`);
      if (occurrences > 1 && !input.replace_all) {
        return fail(`old_string appears ${occurrences} times; pass replace_all=true or add context.`);
      }
      const updated = input.replace_all
        ? original.split(input.old_string).join(input.new_string)
        : original.replace(input.old_string, input.new_string);
      fs.writeFileSync(resolved.full, updated);
      return ok(`Updated ${resolved.relative} (${occurrences} replacement${occurrences === 1 ? '' : 's'}).`, {
        summary: `updated ${resolved.relative}`,
      });
    }

    if (command === 'insert') {
      const resolved = resolveMemoryPath(input, ctx);
      if (resolved.error) return fail(resolved.error);
      if (typeof input.content !== 'string') return fail('insert requires "content".');
      const exists = fs.existsSync(resolved.full);
      const original = exists ? fs.readFileSync(resolved.full, 'utf8') : '';
      const lines = original.split('\n');
      const lineNo = Number(input.insert_line);
      const insertAt = Number.isInteger(lineNo) && lineNo >= 1 ? Math.min(lineNo - 1, lines.length) : lines.length;
      lines.splice(insertAt, 0, input.content);
      ensureDir(path.dirname(resolved.full), 0o700);
      fs.writeFileSync(resolved.full, lines.join('\n'));
      return ok(`Inserted into ${resolved.relative} at line ${insertAt + 1}.`, {
        summary: `inserted into ${resolved.relative}`,
      });
    }

    if (command === 'delete') {
      const resolved = resolveMemoryPath(input, ctx, { mustExist: true });
      if (resolved.error) return fail(resolved.error);
      if (fs.statSync(resolved.full).isDirectory()) return fail('Cannot delete a directory.');
      fs.rmSync(resolved.full);
      return ok(`Deleted memory file ${resolved.relative}.`, { summary: `deleted ${resolved.relative}` });
    }

    return fail(`Unknown memory command: ${command}`);
  },
};
