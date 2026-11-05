import { chatStream } from '../providers/index.js';
import { estimateCost } from '../config.js';
import { estimateTokens, truncateText } from '../utils.js';

export function compactLimit(config, modelInfo) {
  const window = modelInfo?.contextWindow || 128000;
  const compactAt = config.context?.compactAt ?? 0.8;
  const reserve = config.context?.reserveTokens ?? 16000;
  return Math.max(4000, Math.min(window * compactAt, window - reserve));
}

export function estimateContext(system, messages) {
  return estimateTokens(system || '') + estimateTokens(messages || []);
}

function isPlainUserMessage(message) {
  if (message?.role !== 'user' || !Array.isArray(message.content)) return false;
  const hasText = message.content.some((block) => block.type === 'text' && block.text?.trim());
  const hasToolResult = message.content.some((block) => block.type === 'tool_result');
  return hasText && !hasToolResult;
}

function blockToText(block) {
  if (block.type === 'text') return block.text || '';
  if (block.type === 'image') return '[image]';
  if (block.type === 'tool_use') {
    let input = '';
    try {
      input = JSON.stringify(block.input);
    } catch {
      input = '{}';
    }
    return `[tool call ${block.name}] ${truncateText(input, 1200)}`;
  }
  if (block.type === 'tool_result') {
    let text = '';
    if (typeof block.content === 'string') text = block.content;
    else if (Array.isArray(block.content)) {
      text = block.content.map((part) => (part.type === 'text' ? part.text : part.type === 'image' ? '[image]' : '')).join('\n');
    }
    return `[tool result${block.is_error ? ' (error)' : ''}] ${truncateText(text, 2200)}`;
  }
  return '';
}

export function serializeForSummary(messages, budget = 60000) {
  const parts = [];
  let total = 0;
  for (const message of messages) {
    const chunks = (message.content || []).map(blockToText).filter(Boolean);
    if (!chunks.length) continue;
    const entry = `${message.role === 'assistant' ? 'ASSISTANT' : 'USER'}:\n${chunks.join('\n')}`;
    if (total + entry.length > budget) {
      parts.push(truncateText(entry, Math.max(2000, budget - total)));
      break;
    }
    parts.push(entry);
    total += entry.length;
  }
  return parts.join('\n\n');
}

function fallbackSummary({ before, session }) {
  const todos = (session.todos || []).map((todo) => `- [${todo.status}] ${todo.content}`).join('\n');
  return [
    `Earlier conversation context was removed to fit the model context window (${before} messages).`,
    'Continue from the most recent messages and the current todo list.',
    todos ? `Current todos:\n${todos}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function compactConversation({
  config,
  provider,
  modelInfo,
  session,
  ui,
  signal,
  instructions = '',
  tokensBefore = null,
}) {
  const messages = session.messages;
  if (messages.length <= 2) return null;

  const keepTokens = config.context?.keepRecentTokens ?? 24000;
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isPlainUserMessage(messages[i])) {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex <= 0) return null;

  let boundary = messages.length;
  let running = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = estimateTokens(messages[i]);
    if (running + tokens > keepTokens && boundary !== messages.length) break;
    running += tokens;
    if (isPlainUserMessage(messages[i])) boundary = i;
  }
  if (boundary === messages.length || boundary > lastUserIndex) boundary = lastUserIndex;
  if (boundary <= 0) return null;

  const oldMessages = messages.slice(0, boundary);
  const kept = messages.slice(boundary);
  const serialized = serializeForSummary(oldMessages);
  const before = messages.length;

  let summary = '';
  let usage = null;
  try {
    const userPrompt = [
      'Summarize the conversation segment below for another agent that will continue the work.',
      'Preserve: user goals and preferences, explicit decisions, files read or modified, commands run and important results,',
      'errors and fixes, unresolved issues, and the next steps. Be dense and factual. Use short bullets.',
      instructions ? `Extra focus requested: ${instructions}` : '',
      '',
      '<conversation>',
      serialized,
      '</conversation>',
      '',
      'Output only the summary.',
    ]
      .filter((line) => line !== null)
      .join('\n');

    for await (const evt of chatStream({
      config,
      provider,
      modelInfo,
      system:
        'You compact conversations for a coding agent. Write a factual, dense summary. Do not invent information or add commentary.',
      messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
      tools: [],
      signal,
    })) {
      if (evt.type === 'text_delta') summary += evt.text;
      else if (evt.type === 'done') usage = evt.usage;
    }
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    ui?.warn?.(`Compaction summarization failed (${err.message}); dropping old messages instead.`);
    summary = '';
  }

  if (usage) {
    session.addUsage(usage, estimateCost(config, provider.name, modelInfo.id, usage));
  }
  if (!summary.trim()) summary = fallbackSummary({ before, session });

  const summaryText = `[Context compacted — summary of earlier conversation]\n\n${summary.trim()}`;
  const first = kept[0];
  if (first && first.role === 'user' && Array.isArray(first.content)) {
    const existing = first.content.findIndex(
      (block) => block.type === 'text' && block.text?.startsWith('[Context compacted')
    );
    if (existing !== -1) first.content.splice(existing, 1);
    first.content = [{ type: 'text', text: summaryText }, ...first.content];
  } else {
    kept.unshift({ role: 'user', content: [{ type: 'text', text: summaryText }] });
  }

  session.messages = kept;
  return {
    before,
    after: kept.length,
    tokensBefore: tokensBefore || estimateTokens(messages),
    tokensAfter: estimateTokens(kept),
  };
}

export { chatStream };
