import path from 'node:path';
import { matchGlob, toPosix } from './utils.js';

export const READ_ONLY_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'BashOutput',
  'KillShell',
  'AskUserQuestion',
  'Skill',
  'Memory',
  'ExitPlanMode',
  'Task',
]);

export const WRITE_TOOLS = new Set(['Write', 'Edit']);

export function isMcpTool(name) {
  return String(name).startsWith('mcp__');
}

export function parseRule(rule) {
  const str = String(rule || '').trim();
  const open = str.indexOf('(');
  if (open === -1) return { tool: str, pattern: null };
  const close = str.lastIndexOf(')');
  return {
    tool: str.slice(0, open).trim(),
    pattern: str.slice(open + 1, close === -1 ? str.length : close).trim(),
  };
}

function normalizeCommand(command) {
  return String(command || '')
    .trim()
    .replace(/\s+/g, ' ');
}

export function ruleMatches(rule, toolName, input, cwd) {
  const { tool, pattern } = parseRule(rule);
  if (tool !== '*' && tool !== toolName) return false;
  if (!pattern) return true;

  if (toolName === 'Bash') {
    const command = normalizeCommand(input?.command);
    let expected = pattern;
    let prefix = false;
    if (expected.endsWith(':*')) {
      expected = expected.slice(0, -2);
      prefix = true;
    } else if (expected.endsWith('*')) {
      expected = expected.slice(0, -1);
      prefix = true;
    }
    const normalized = normalizeCommand(expected);
    return prefix ? command.startsWith(normalized) : command === normalized;
  }

  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') {
    const target = path.resolve(cwd, input?.file_path || '');
    const relative = path.relative(cwd, target);
    if (matchGlob(toPosix(target), pattern)) return true;
    if (matchGlob(toPosix(relative), pattern)) return true;
    if (!pattern.includes('/') && matchGlob(path.basename(target), pattern)) return true;
    return false;
  }

  if (toolName === 'WebFetch') {
    if (pattern.startsWith('domain:')) {
      const domain = pattern.slice(7).trim().toLowerCase();
      try {
        const host = new URL(input?.url).hostname.toLowerCase();
        return host === domain || host.endsWith(`.${domain}`);
      } catch {
        return false;
      }
    }
    return matchGlob(input?.url || '', pattern);
  }

  const target = input?.file_path || input?.url || input?.command || input?.pattern || input?.query || '';
  if (!target) return true;
  return matchGlob(String(target), pattern) || String(target) === pattern;
}

export function evaluatePermission({ toolName, input, config, session, cwd, autoApprove = false }) {
  const allowRules = [...(config.permissions?.allow || []), ...(session?.allowRules || [])];
  const denyRules = [...(config.permissions?.deny || []), ...(session?.denyRules || [])];

  for (const rule of denyRules) {
    if (ruleMatches(rule, toolName, input, cwd)) {
      return { decision: 'deny', reason: `Denied by rule: ${rule}` };
    }
  }
  for (const rule of allowRules) {
    if (ruleMatches(rule, toolName, input, cwd)) return { decision: 'allow' };
  }

  const mode = session?.mode || config.permissions?.mode || 'default';
  if (mode === 'bypassPermissions') return { decision: 'allow' };
  if (autoApprove) return { decision: 'allow' };

  if (mode === 'plan') {
    if (READ_ONLY_TOOLS.has(toolName)) return { decision: 'allow' };
    if (isMcpTool(toolName)) {
      return { decision: 'deny', reason: 'Plan mode blocks MCP tools because they may modify state.' };
    }
    return {
      decision: 'deny',
      reason: 'Plan mode is read-only. Finish planning and call ExitPlanMode before making changes.',
    };
  }

  if (READ_ONLY_TOOLS.has(toolName)) return { decision: 'allow' };
  if (isMcpTool(toolName)) return { decision: 'ask' };

  if (WRITE_TOOLS.has(toolName)) {
    if (mode === 'acceptEdits') return { decision: 'allow' };
    return { decision: 'ask' };
  }

  if (toolName === 'Bash') return { decision: 'ask' };
  return { decision: 'ask' };
}

export function buildAllowRule(toolName, input, cwd) {
  if (toolName === 'Bash') {
    const command = normalizeCommand(input?.command).slice(0, 200);
    return command ? `Bash(${command}:*)` : 'Bash';
  }
  if (WRITE_TOOLS.has(toolName) || toolName === 'Read') {
    if (input?.file_path) {
      return `${toolName}(${toPosix(path.resolve(cwd, input.file_path))})`;
    }
    return toolName;
  }
  if (toolName === 'WebFetch' && input?.url) {
    try {
      return `WebFetch(domain:${new URL(input.url).hostname})`;
    } catch {
      return 'WebFetch';
    }
  }
  return toolName;
}

export function accessSummary(toolName, input, cwd) {
  if (!input) return toolName;
  if (input.command) return normalizeCommand(input.command);
  if (input.file_path) {
    const relative = path.relative(cwd, path.resolve(cwd, input.file_path));
    return relative.startsWith('..') ? input.file_path : relative;
  }
  if (input.url) return input.url;
  if (input.pattern) return input.pattern;
  if (input.query) return input.query;
  if (input.description) return input.description;
  if (input.skill) return input.skill;
  return '';
}
