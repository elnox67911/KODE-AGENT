import { fail, ok } from './common.js';

export const askTool = {
  name: 'AskUserQuestion',
  description:
    'Ask the user one to four multiple-choice questions when a decision is genuinely theirs and you cannot resolve it from the code or sensible defaults. Not for trivial confirmations.',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: 'Questions to ask (1-4).',
        items: {
          type: 'object',
          properties: {
            header: { type: 'string', description: 'Very short label (max 12 chars).' },
            question: { type: 'string', description: 'The complete question.' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  description: { type: 'string' },
                },
                required: ['label'],
              },
            },
            multiSelect: { type: 'boolean' },
          },
          required: ['question', 'options'],
        },
      },
    },
    required: ['questions'],
  },
  async run(input, ctx) {
    const questions = Array.isArray(input?.questions) ? input.questions : [];
    if (!questions.length || questions.length > 4) {
      return fail('AskUserQuestion requires 1-4 questions.');
    }
    for (const question of questions) {
      if (!question?.question) return fail('Every question needs "question".');
      if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 4) {
        return fail('Every question needs 2-4 options.');
      }
    }
    if (!ctx.prompter) return fail('AskUserQuestion is not available in this mode.');
    try {
      const answers = await ctx.prompter.askQuestions(questions);
      if (!answers.length) return ok('The user did not answer.', { summary: 'no answer' });
      const text = answers.map((answer) => `${answer.header || answer.question}: ${answer.answers.join(', ')}`).join('\n');
      return ok(text, { summary: `${answers.length} answer${answers.length === 1 ? '' : 's'}` });
    } catch (err) {
      return fail(err.message);
    }
  },
};
