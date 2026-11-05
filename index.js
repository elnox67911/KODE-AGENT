import { readTool, writeTool, editTool, globTool, grepTool } from './fs.js';
import { bashTool, bashOutputTool, killShellTool } from './bash.js';
import { webFetchTool, webSearchTool } from './web.js';
import { todoTool } from './todo.js';
import { memoryTool } from './memory.js';
import { skillTool } from './skill.js';
import { taskTool } from './task.js';
import { askTool } from './ask.js';
import { exitPlanModeTool } from './plan.js';

export const BUILTIN_TOOLS = [
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  bashTool,
  bashOutputTool,
  killShellTool,
  webFetchTool,
  webSearchTool,
  todoTool,
  memoryTool,
  skillTool,
  taskTool,
  askTool,
  exitPlanModeTool,
];

const READ_ONLY_AGENT_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'Skill', 'AskUserQuestion']);
const PLAN_MODE_BLOCKED = new Set(['Write', 'Edit', 'Bash', 'KillShell']);

export function selectTools({ config, mode, agentType = null, mcpTools = [] }) {
  let tools = [...BUILTIN_TOOLS, ...(agentType ? [] : mcpTools)];

  if (agentType) {
    tools = tools.filter((tool) => !['Task', 'ExitPlanMode', 'AskUserQuestion'].includes(tool.name));
    if (agentType === 'explore' || agentType === 'plan') {
      tools = tools.filter((tool) => READ_ONLY_AGENT_TOOLS.has(tool.name));
    }
  }

  if (mode === 'plan') {
    tools = tools.filter((tool) => !PLAN_MODE_BLOCKED.has(tool.name));
  }

  if (Array.isArray(config.tools?.only) && config.tools.only.length) {
    const allowed = new Set(config.tools.only);
    tools = tools.filter((tool) => allowed.has(tool.name) || tool.name.startsWith('mcp__'));
  }
  if (Array.isArray(config.tools?.deny) && config.tools.deny.length) {
    const denied = new Set(config.tools.deny);
    tools = tools.filter((tool) => !denied.has(tool.name));
  }
  return tools;
}

export function toolDefinitions(tools) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export function findTool(tools, name) {
  return tools.find((tool) => tool.name === name);
}
