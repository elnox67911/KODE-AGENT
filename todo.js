import { fail, ok } from './common.js';

const STATUSES = new Set(['pending', 'in_progress', 'completed']);
const MARKS = { pending: '☐', in_progress: '→', completed: '✔' };

export const todoTool = {
  name: 'TodoWrite',
  description:
    'Create or update the task list for complex multi-step work. Pass the full updated list on every call (it replaces the previous list). Use status pending, in_progress, or completed. Keep one item in_progress at a time.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete todo list.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Task description (imperative).' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            activeForm: { type: 'string', description: 'Present continuous form for display.' },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  async run(input, ctx) {
    if (!Array.isArray(input?.todos)) return fail('TodoWrite requires "todos" as an array.');
    if (input.todos.length > 100) return fail('Too many todos (max 100).');
    const todos = [];
    for (const item of input.todos) {
      const content = String(item?.content || '').trim();
      const status = String(item?.status || 'pending');
      if (!content) return fail('Every todo needs non-empty "content".');
      if (!STATUSES.has(status)) return fail(`Invalid todo status "${status}". Use pending, in_progress, or completed.`);
      todos.push({
        content,
        status,
        ...(item.activeForm ? { activeForm: String(item.activeForm) } : {}),
      });
    }
    ctx.session.todos = todos;
    const rendered = todos
      .map((item) => `${MARKS[item.status]} ${item.content}${item.status === 'in_progress' && item.activeForm ? ` (${item.activeForm})` : ''}`)
      .join('\n');
    return ok(`Todo list updated (${todos.length} item${todos.length === 1 ? '' : 's'}):\n${rendered || '(empty)'}`, {
      summary: `${todos.length} todo${todos.length === 1 ? '' : 's'}`,
      todos,
    });
  },
};
