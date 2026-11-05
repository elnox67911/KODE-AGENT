import { fail, ok } from './common.js';

export const taskTool = {
  name: 'Task',
  description:
    'Launch a subagent to research or execute a scoped task autonomously in a fresh context. Types: "general" (all tools), "explore" (read-only research), "plan" (architect, read-only). Provide a detailed, self-contained prompt. Returns the subagent final report.',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short (3-6 word) description of the task.' },
      prompt: { type: 'string', description: 'Detailed, self-contained instructions for the subagent.' },
      subagent_type: {
        type: 'string',
        enum: ['general', 'explore', 'plan'],
        description: 'Subagent type (default general).',
      },
    },
    required: ['description', 'prompt'],
  },
  async run(input, ctx) {
    const description = String(input?.description || '').trim();
    const prompt = String(input?.prompt || '').trim();
    const type = String(input?.subagent_type || 'general');
    if (!prompt) return fail('Task requires a "prompt".');
    const agent = ctx.agents?.[type];
    if (!agent) {
      return fail(`Unknown subagent_type "${type}". Use one of: ${Object.keys(ctx.agents || {}).join(', ')}`);
    }
    if (!ctx.runSubagent) return fail('Subagents are not available in this context.');
    const result = await ctx.runSubagent({
      agentType: type,
      description: description || prompt.slice(0, 60),
      prompt,
    });
    if (result.error) return fail(`Subagent failed: ${result.error}`);
    const text = result.text?.trim() || '(subagent returned no output)';
    return ok(text, {
      summary: `${type} · ${description || 'subagent'} · ${result.usage?.turns || 0} turns`,
      preview: text,
    });
  },
};
