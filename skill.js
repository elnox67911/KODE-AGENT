import { findSkill } from '../skills.js';
import { fail, ok } from './common.js';

export const skillTool = {
  name: 'Skill',
  description:
    'Load a skill by name to get its detailed instructions and workflow. Skills are discovered from .kode/skills and ~/.kode/skills. Use the skill body as instructions for the current task.',
  inputSchema: {
    type: 'object',
    properties: {
      skill: { type: 'string', description: 'Skill name exactly as listed in the system prompt.' },
      args: { type: 'string', description: 'Optional arguments or context to pass to the skill.' },
    },
    required: ['skill'],
  },
  async run(input, ctx) {
    const name = String(input?.skill || '').trim();
    if (!name) return fail('Skill requires "skill".');
    const skills = ctx.skills || [];
    const skill = findSkill(skills, name);
    if (!skill) {
      return fail(`Unknown skill "${name}". Available skills: ${skills.map((entry) => entry.name).join(', ') || '(none)'}`);
    }
    const body = `<skill name="${skill.name}">\n${skill.body}\n</skill>${
      input.args ? `\n\nArguments for this skill:\n${input.args}` : ''
    }`;
    return ok(body, { summary: `loaded ${skill.name}`, preview: skill.description });
  },
};
