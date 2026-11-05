import { fail, ok } from './common.js';

export const exitPlanModeTool = {
  name: 'ExitPlanMode',
  description:
    'Present your implementation plan and ask the user for approval. Only available in plan mode. On approval, plan mode ends and you may start making changes.',
  inputSchema: {
    type: 'object',
    properties: {
      plan: { type: 'string', description: 'The complete plan (markdown).' },
    },
    required: ['plan'],
  },
  async run(input, ctx) {
    const plan = String(input?.plan || '').trim();
    if (!plan) return fail('ExitPlanMode requires "plan".');
    if (ctx.session.mode !== 'plan') {
      return fail('ExitPlanMode can only be used in plan mode.');
    }
    if (!ctx.prompter) return fail('Plan approval is unavailable in non-interactive mode.');
    const result = await ctx.prompter.confirmPlan(plan);
    if (result.approved) {
      ctx.session.mode = ctx.session.prePlanMode || 'default';
      ctx.session.prePlanMode = null;
      return ok(
        `Plan approved. Plan mode is off; permission mode is now "${ctx.session.mode}". Start implementing and keep the user updated.`,
        { summary: 'plan approved' }
      );
    }
    if (result.feedback) {
      return ok(`Plan rejected. User feedback: ${result.feedback}\nContinue planning and address the feedback.`, {
        summary: 'plan rejected · feedback',
      });
    }
    return ok('Plan rejected by the user. Continue researching or ask clarifying questions.', {
      summary: 'plan rejected',
    });
  },
};
