import fs from 'node:fs';
import path from 'node:path';
import { USER_SKILLS_DIR } from './config.js';
import { parseFrontmatter, truncateText } from './utils.js';

function loadSkillFile(file, source) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const { data, body } = parseFrontmatter(raw);
    const name = String(data.name || path.basename(path.dirname(file)) || path.basename(file, '.md')).trim();
    if (!name) return null;
    return {
      name,
      description: String(data.description || '').trim(),
      whenToUse: String(data.when_to_use || data.whenToUse || '').trim(),
      allowedTools: Array.isArray(data.allowed_tools) ? data.allowed_tools : [],
      body: truncateText(body, 100000),
      dir: path.dirname(file),
      file,
      source,
    };
  } catch {
    return null;
  }
}

export function discoverSkills(cwd) {
  const sources = [
    { dir: path.join(cwd, '.kode', 'skills'), source: 'project' },
    { dir: USER_SKILLS_DIR, source: 'user' },
  ];
  const byName = new Map();
  for (const { dir, source } of sources) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const skillFile = path.join(full, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;
        const skill = loadSkillFile(skillFile, source);
        if (skill && !byName.has(skill.name.toLowerCase())) byName.set(skill.name.toLowerCase(), skill);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const skill = loadSkillFile(full, source);
        if (skill && !byName.has(skill.name.toLowerCase())) byName.set(skill.name.toLowerCase(), skill);
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findSkill(skills, name) {
  const needle = String(name || '').toLowerCase();
  return skills.find((skill) => skill.name.toLowerCase() === needle);
}

export function formatSkillsForPrompt(skills) {
  if (!skills.length) return '';
  return skills
    .map((skill) => {
      const extras = [skill.description, skill.whenToUse ? `When: ${skill.whenToUse}` : ''].filter(Boolean).join(' ');
      return `- ${skill.name}: ${extras || '(no description)'}`;
    })
    .join('\n');
}
