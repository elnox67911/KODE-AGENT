import fs from 'node:fs';
import path from 'node:path';
import { USER_COMMANDS_DIR } from './config.js';
import { parseFrontmatter, truncateText } from './utils.js';

export function splitArgs(text) {
  const args = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(String(text || '')))) {
    args.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return args;
}

export function discoverCommands(cwd) {
  const dirs = [path.join(cwd, '.kode', 'commands'), USER_COMMANDS_DIR];
  const byName = new Map();
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const file = path.join(dir, entry.name);
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const { data, body } = parseFrontmatter(raw);
        const name = path.basename(entry.name, '.md');
        if (byName.has(name)) continue;
        byName.set(name, {
          name,
          description: String(data.description || '').trim(),
          argumentHint: String(data.argument_hint || data['argument-hint'] || '').trim(),
          body: truncateText(body, 60000),
          file,
        });
      } catch {}
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function expandCommand(command, argumentText) {
  const args = splitArgs(argumentText);
  let body = command.body;
  body = body.replace(/\$ARGUMENTS/g, argumentText || '');
  body = body.replace(/\$(\d)/g, (_, digit) => args[Number(digit) - 1] || '');
  if (!/\$ARGUMENTS|\$\d/.test(command.body) && argumentText?.trim()) {
    body = `${body.trimEnd()}\n\n${argumentText}`;
  }
  return body;
}
