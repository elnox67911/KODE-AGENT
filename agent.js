import { chatStream } from '../providers/index.js';
import { ProviderError, friendlyProviderError } from '../providers/http.js';
import { AGENTS } from '../agents.js';
import { Session } from '../session.js';
import { estimateCost, saveConfig } from '../config.js';
import { evaluatePermission, buildAllowRule, accessSummary } from '../permissions.js';
import { runHooks, collectHookContext, preToolBlock, preToolAllow } from '../hooks.js';
import { selectTools, toolDefinitions, findTool } from '../tools/index.js';
import { buildSystemPrompt } from './prompt.js';
import { compactConversation, compactLimit, estimateContext } from './context.js';
import { summarizeArgs } from '../ui/render.js';
import { truncateText } from '../utils.js';

const MAX_SUBAGENT_DEPTH = 3;
const MAX_TOOL_RESULT = 100000;

export function abortedError() {
  const err = new Error('Interrupted by user');
  err.name = 'AbortError';
  return err;
}

function messageText(message) {
  return (message?.content || [])
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function isContextError(err) {
  if (!(err instanceof ProviderError)) return false;
  if (err.status && err.status !== 400 && err.status !== 413) return false;
  return /context|too many tokens|maximum context|prompt is too long|context_length_exceeded|token limit/i.test(
    `${err.message} ${err.body || ''}`
  );
}

function toolResultBlock(toolUse, result) {
  const block = {
    type: 'tool_result',
    tool_use_id: toolUse.id,
    content: typeof result.output === 'string' ? truncateText(result.output, MAX_TOOL_RESULT) : result.output,
  };
  if (result.isError) block.is_error = true;
  return block;
}

function failedResult(toolUse, message) {
  return {
    output: message,
    isError: true,
    meta: { summary: truncateText(message, 110) },
  };
}

export class Agent {
  constructor({
    config,
    provider,
    modelInfo,
    session,
    ui,
    prompter = null,
    mcp = null,
    memory = null,
    skills = [],
    cwd,
    depth = 0,
    autoApprove = false,
    maxTurns = null,
  }) {
    this.config = config;
    this.provider = provider;
    this.modelInfo = modelInfo;
    this.session = session;
    this.ui = ui;
    this.prompter = prompter;
    this.mcp = mcp;
    this.memory = memory;
    this.skills = skills;
    this.cwd = cwd || session.cwd;
    this.depth = depth;
    this.autoApprove = autoApprove;
    this.maxTurns = maxTurns || config.maxTurns || 60;
    this.signal = null;
    this.tools = [];
  }

  toolContext(signal) {
    return {
      cwd: this.cwd,
      config: this.config,
      session: this.session,
      signal,
      ui: this.ui,
      prompter: this.prompter,
      mcp: this.mcp,
      skills: this.skills,
      agents: AGENTS,
      runSubagent: (options) => this.runSubagent(options),
    };
  }

  async compact(signal, tokensBefore = null) {
    return compactConversation({
      config: this.config,
      provider: this.provider,
      modelInfo: this.modelInfo,
      session: this.session,
      ui: this.ui,
      signal,
      tokensBefore,
    });
  }

  async runTurn(message, { signal = this.signal, agentType = null, maxTurns = this.maxTurns } = {}) {
    if (signal?.aborted) throw abortedError();
    if (typeof message === 'string' && message.trim()) {
      this.session.messages.push({ role: 'user', content: [{ type: 'text', text: message }] });
      this.session.touchTitle(message);
    }

    const turnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: true };
    let turns = 0;
    let lastText = '';
    let stopHookRetries = 0;
    let compactionNoticeShown = false;

    for (let turn = 0; turn < maxTurns; turn++) {
      if (signal?.aborted) throw abortedError();
      turns++;

      const tools = selectTools({
        config: this.config,
        mode: this.session.mode,
        agentType,
        mcpTools: agentType ? [] : this.mcp?.getTools() || [],
      });
      this.tools = tools;
      let system = buildSystemPrompt({
        config: this.config,
        session: this.session,
        provider: this.provider,
        modelInfo: this.modelInfo,
        tools,
        memory: this.memory,
        skills: this.skills,
        mcp: agentType || !this.mcp ? null : { servers: this.mcp.summary(), tools: this.mcp.getTools() },
        agentType,
      });

      if (this.config.context?.autoCompact !== false) {
        const limit = compactLimit(this.config, this.modelInfo);
        const before = estimateContext(system, this.session.messages);
        if (before > limit) {
          const result = await this.compact(signal, before);
          if (result) {
            this.ui.compacted(result);
            system = buildSystemPrompt({
              config: this.config,
              session: this.session,
              provider: this.provider,
              modelInfo: this.modelInfo,
              tools,
              memory: this.memory,
              skills: this.skills,
              mcp: agentType || !this.mcp ? null : { servers: this.mcp.summary(), tools: this.mcp.getTools() },
              agentType,
            });
            compactionNoticeShown = true;
          } else if (!compactionNoticeShown) {
            this.ui.warn('Context is close to the model limit but nothing can be compacted yet.');
            compactionNoticeShown = true;
          }
        }
      }

      const response = await this.requestModel({
        system,
        tools,
        signal,
        agentType,
        onContextOverflow: async () => {
          const result = await this.compact(signal);
          if (result) {
            this.ui.compacted(result);
            return true;
          }
          return false;
        },
      });

      if (response.usage) {
        const cost = estimateCost(this.config, this.provider.name, this.modelInfo.id, response.usage);
        this.session.addUsage(response.usage, cost);
        turnUsage.input += response.usage.input || 0;
        turnUsage.output += response.usage.output || 0;
        turnUsage.cacheRead += response.usage.cacheRead || 0;
        turnUsage.cacheWrite += response.usage.cacheWrite || 0;
        if (cost === null) turnUsage.costKnown = false;
        else turnUsage.cost += cost;
      }

      const content = Array.isArray(response.message?.content) ? response.message.content : [];
      if (!content.length) {
        content.push({ type: 'text', text: lastText || '(The model returned an empty response.)' });
      }
      const assistantMessage = { role: 'assistant', content };
      this.session.messages.push(assistantMessage);
      const text = messageText(assistantMessage);
      if (text) lastText = text;

      const toolUses = content.filter((block) => block.type === 'tool_use');
      if (!toolUses.length) {
        if (!agentType) {
          const stopResults = await runHooks(
            'Stop',
            {
              session_id: this.session.id,
              cwd: this.cwd,
              model: this.modelInfo.id,
              stop_hook_active: stopHookRetries > 0,
            },
            this.config,
            { signal }
          );
          const block = stopResults.find((result) => result.blocked);
          const context = collectHookContext(stopResults);
          if (stopHookRetries < 1 && (block || context)) {
            stopHookRetries++;
            const text = block ? `Stop hook: ${block.reason || 'continue working.'}` : context;
            this.session.messages.push({
              role: 'user',
              content: [{ type: 'text', text: `[Hook]\n${text}` }],
            });
            continue;
          }
        }
        if (this.ui.mode === 'interactive' && turnUsage.input + turnUsage.output > 0) {
          this.ui.usageLine({
            input: turnUsage.input,
            output: turnUsage.output,
            cacheRead: turnUsage.cacheRead,
            cost: turnUsage.costKnown ? turnUsage.cost : null,
          });
        }
        return { text: lastText, usage: turnUsage, turns };
      }

      const results = [];
      for (let index = 0; index < toolUses.length; index++) {
        const toolUse = toolUses[index];
        if (signal?.aborted) {
          for (const pending of toolUses.slice(index)) {
            results.push(
              toolResultBlock(pending, failedResult(pending, 'Interrupted by user before this tool ran.'))
            );
          }
          this.session.messages.push({ role: 'user', content: results });
          throw abortedError();
        }
        results.push(await this.executeTool(toolUse, tools, signal, agentType));
      }
      this.session.messages.push({ role: 'user', content: results });
    }

    throw new Error(
      `Reached the maximum of ${maxTurns} turns without finishing. Raise maxTurns in config.json or ask me to continue.`
    );
  }

  async requestModel({ system, tools, signal, agentType, onContextOverflow }) {
    let contextRetries = 0;
    let lastError = null;
    for (;;) {
      if (signal?.aborted) throw abortedError();
      let message = null;
      let usage = null;
      let stopReason = null;
      let started = false;
      try {
        const stream = chatStream({
          config: this.config,
          provider: this.provider,
          modelInfo: this.modelInfo,
          system,
          messages: this.session.messages,
          tools: toolDefinitions(tools),
          signal,
        });
        started = true;
        this.ui.beginAssistant();
        for await (const evt of stream) {
          if (evt.type === 'text_delta') {
            this.ui.assistantText(evt.text);
          } else if (evt.type === 'reasoning_delta') {
            this.ui.reasoningText(evt.text);
          } else if (evt.type === 'done') {
            message = evt.message;
            usage = evt.usage;
            stopReason = evt.stopReason;
          }
        }
        this.ui.endAssistant();
        if (!message) {
          throw new ProviderError('The model stream ended without a completion message.');
        }
        if (stopReason === 'max_tokens') {
          this.ui.warn('The response hit the output token limit and may be truncated. Raise maxTokens in config.json.');
        }
        return { message, usage, stopReason };
      } catch (err) {
        if (started) this.ui.endAssistant();
        if (err?.name === 'AbortError' || signal?.aborted) throw abortedError();
        lastError = err;
        if (isContextError(err) && contextRetries < 2) {
          contextRetries++;
          this.ui.warn('The model rejected the context size; compacting and retrying.');
          const compacted = await onContextOverflow();
          if (compacted) continue;
        }
        if (err instanceof ProviderError) {
          throw new Error(friendlyProviderError(err, this.provider));
        }
        throw err;
      }
    }
    throw lastError;
  }

  async executeTool(toolUse, tools, signal, agentType) {
    const name = String(toolUse.name || '');
    const input = toolUse.input && typeof toolUse.input === 'object' ? toolUse.input : {};
    const summary = summarizeArgs(name, input);

    if (toolUse._invalid) {
      this.ui.toolStart(name, summary);
      const result = failedResult(
        toolUse,
        `The model produced invalid JSON arguments for ${name}. Re-issue the call with valid JSON.`
      );
      this.ui.toolResult({ name, isError: true, summary: result.meta.summary });
      return toolResultBlock(toolUse, result);
    }

    const isMcp = name.startsWith('mcp__');
    const tool = isMcp ? null : findTool(tools, name);
    if (!isMcp && !tool) {
      const available = tools.map((entry) => entry.name).join(', ');
      const result = failedResult(toolUse, `Unknown tool "${name}". Available tools: ${available}`);
      this.ui.toolStart(name, summary);
      this.ui.toolResult({ name, isError: true, summary: result.meta.summary });
      return toolResultBlock(toolUse, result);
    }

    this.ui.toolStart(name, summary || accessSummary(name, input, this.cwd));

    const payload = {
      session_id: this.session.id,
      cwd: this.cwd,
      model: this.modelInfo.id,
      permission_mode: this.session.mode,
      tool_name: name,
      tool_input: input,
    };

    let hookContext = '';
    try {
      const preResults = await runHooks('PreToolUse', payload, this.config, { signal });
      const blocked = preToolBlock(preResults);
      if (blocked) {
        const result = failedResult(toolUse, `Blocked by PreToolUse hook: ${blocked}`);
        this.ui.toolResult({ name, isError: true, summary: 'blocked by hook' });
        return toolResultBlock(toolUse, result);
      }
      hookContext = collectHookContext(preResults);

      const decision = evaluatePermission({
        toolName: name,
        input,
        config: this.config,
        session: this.session,
        cwd: this.cwd,
        autoApprove:
          this.autoApprove ||
          preToolAllow(preResults) ||
          (isMcp && this.mcp?.isAutoApproved(name)) ||
          false,
      });

      if (decision.decision === 'deny') {
        const result = failedResult(toolUse, `Permission denied: ${decision.reason || 'not allowed'}`);
        this.ui.toolResult({ name, isError: true, summary: 'permission denied' });
        return toolResultBlock(toolUse, result);
      }

      if (decision.decision === 'ask' && !this.autoApprove) {
        if (!this.prompter) {
          const result = failedResult(
            toolUse,
            `Permission is required for ${name} but this mode is non-interactive. Re-run with --yes or an allow rule.`
          );
          this.ui.toolResult({ name, isError: true, summary: 'permission required' });
          return toolResultBlock(toolUse, result);
        }
        const previousSilent = this.ui.silentDepth;
        if (previousSilent > 0) this.ui.silentDepth = 0;
        let answer;
        try {
          answer = await this.prompter.askPermission({
            toolName: name,
            summary: summary || accessSummary(name, input, this.cwd),
          });
        } finally {
          this.ui.silentDepth = previousSilent;
        }
        if (answer.decision === 'always' || answer.decision === 'always-save') {
          const rule = buildAllowRule(name, input, this.cwd);
          this.session.addAllowRule(rule);
          if (answer.decision === 'always-save') {
            this.config.permissions = this.config.permissions || {};
            this.config.permissions.allow = this.config.permissions.allow || [];
            if (!this.config.permissions.allow.includes(rule)) this.config.permissions.allow.push(rule);
            try {
              saveConfig(this.config);
              this.ui.success(`Saved allow rule: ${rule}`);
            } catch (err) {
              this.ui.warn(`Could not save rule to config: ${err.message}`);
            }
          } else {
            this.ui.success(`Allowed for this session: ${rule}`);
          }
        } else if (answer.decision !== 'allow') {
          const result = failedResult(
            toolUse,
            `Permission denied by the user${answer.reason ? ` (${answer.reason})` : ''}. Do not retry this exact action; ask what to do instead.`
          );
          this.ui.toolResult({ name, isError: true, summary: 'permission denied' });
          return toolResultBlock(toolUse, result);
        }
      }
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) throw abortedError();
      const result = failedResult(toolUse, `Permission or hook error: ${err.message}`);
      this.ui.toolResult({ name, isError: true, summary: 'blocked' });
      return toolResultBlock(toolUse, result);
    }

    let result;
    try {
      if (isMcp) {
        if (!this.mcp) throw new Error('MCP is not enabled for this turn.');
        result = await this.mcp.callTool(name, input);
      } else {
        result = await tool.run(input, this.toolContext(signal));
      }
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) throw abortedError();
      result = failedResult(toolUse, err?.message || String(err));
    }

    if (!result || typeof result !== 'object') result = failedResult(toolUse, 'Tool returned no result.');
    if (result.output === undefined) result.output = result.isError ? 'Tool failed.' : '(no output)';

    try {
      const postPayload = {
        ...payload,
        tool_output: typeof result.output === 'string' ? truncateText(result.output, 20000) : '[structured content]',
        tool_error: Boolean(result.isError),
      };
      const postResults = await runHooks('PostToolUse', postPayload, this.config, { signal });
      const extra = collectHookContext(postResults);
      if (extra) {
        hookContext = hookContext ? `${hookContext}\n\n${extra}` : extra;
      }
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) throw abortedError();
      this.ui.warn(`PostToolUse hook failed: ${err.message}`);
    }

    if (hookContext) {
      if (Array.isArray(result.output)) {
        result.output.push({ type: 'text', text: `[Hook output]\n${hookContext}` });
      } else {
        result.output = `${result.output}\n\n[Hook output]\n${hookContext}`;
      }
    }

    this.ui.toolResult({
      name,
      isError: Boolean(result.isError),
      summary: result.meta?.summary,
      preview: result.meta?.preview,
      diff: result.meta?.diff,
      stats: result.meta?.stats,
    });

    return toolResultBlock(toolUse, result);
  }

  async runSubagent({ agentType = 'general', description = '', prompt }) {
    if (this.depth >= MAX_SUBAGENT_DEPTH) {
      return { error: `Maximum subagent depth (${MAX_SUBAGENT_DEPTH}) reached.`, text: '', usage: null };
    }
    if (!AGENTS[agentType]) {
      return { error: `Unknown subagent type "${agentType}".`, text: '', usage: null };
    }
    if (!prompt?.trim()) {
      return { error: 'Subagent prompt is empty.', text: '', usage: null };
    }

    const subSession = new Session({
      cwd: this.cwd,
      provider: this.provider.name,
      model: this.modelInfo.id,
      mode: this.session.mode,
    });
    subSession.title = `Subagent: ${description || agentType}`;

    const subAgent = new Agent({
      config: this.config,
      provider: this.provider,
      modelInfo: this.modelInfo,
      session: subSession,
      ui: this.ui,
      prompter: this.prompter,
      mcp: null,
      memory: null,
      skills: this.skills,
      cwd: this.cwd,
      depth: this.depth + 1,
      autoApprove: this.autoApprove,
      maxTurns: Math.min(this.maxTurns, 30),
    });

    const previousSilent = this.ui.silentDepth;
    this.ui.silentDepth += 1;
    try {
      const result = await subAgent.runTurn(prompt, { agentType });
      const u = subSession.usage;
      this.session.usage.input += u.input;
      this.session.usage.output += u.output;
      this.session.usage.cacheRead += u.cacheRead;
      this.session.usage.cacheWrite += u.cacheWrite;
      this.session.usage.cost += u.cost;
      this.session.usage.requests += u.requests;
      if (!u.costKnown) this.session.usage.costKnown = false;
      return {
        text: result.text,
        usage: {
          ...u,
          turns: result.turns,
          input: u.input,
          output: u.output,
          total: u.input + u.output,
        },
      };
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      return { error: err.message, text: '', usage: null };
    } finally {
      this.ui.silentDepth = previousSilent;
    }
  }
}

export function createAgent(options) {
  return new Agent(options);
}
