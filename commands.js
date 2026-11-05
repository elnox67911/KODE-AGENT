import fs from 'node:fs';
import path from 'node:path';
import {
  CONFIG_PATH,
  PERMISSION_MODES,
  PROVIDER_PRESETS,
  VERSION,
  configSummary,
  listProviderNames,
  maskConfig,
  parseModelRef,
  resolveProvider,
  saveConfig,
} from './config.js';
import { selectTools } from './tools/index.js';
import { buildSystemPrompt } from './agent/prompt.js';
import { compactLimit } from './agent/context.js';
import { buildMemoryContext, listMemoryFiles } from './memory.js';
import { discoverSkills } from './skills.js';
import { expandCommand } from './custom-commands.js';
import { listSessions } from './session.js';
import { formatCost, formatTokens, estimateTokens, stripAnsi, truncateText } from './utils.js';
import { runSetup } from './setup.js';
import { formatDoctor, runDoctor } from './doctor.js';

function out(ui, text = '') {
  if (ui.mode === 'json') return;
  if (ui.mode === 'interactive') ui.line(text);
  else process.stdout.write(`${stripAnsi(String(text))}\n`);
}

function heading(ui, text) {
  out(ui, ui.bold(text));
}

function bullet(ui, items) {
  for (const item of items) out(ui, `  ${item}`);
}

function modeText(session) {
  return session.mode;
}

async function persistModel(ctx) {
  try {
    saveConfig(ctx.config);
  } catch (err) {
    ctx.ui.warn(`Could not save model choice: ${err.message}`);
  }
}

function helpText(ctx) {
  const builtins = [
    ['/help', 'Show this help'],
    ['/status', 'Provider, model, mode, session and context usage'],
    ['/setup', 'Configure provider, model and API key'],
    ['/model [provider/]model', 'Show or switch the model'],
    ['/provider [name]', 'Show or switch the provider'],
    ['/permissions [mode]', 'Show or set the permission mode'],
    ['/plan', 'Toggle plan mode (read-only)'],
    ['/config [json]', 'Show the effective configuration'],
    ['/system', 'Print the full system prompt'],
    ['/compact [focus]', 'Summarize older context to free tokens'],
    ['/context', 'Context usage estimate'],
    ['/clear', 'Clear the current conversation'],
    ['/name <title>', 'Rename the current session'],
    ['/sessions', 'List recent sessions for this project'],
    ['/resume [id]', 'Resume a session (default: most recent)'],
    ['/undo', 'Restore files from the last file checkpoint'],
    ['/cost', 'Token usage and estimated cost'],
    ['/todos', 'Show the current todo list'],
    ['/memory', 'Show instruction files and memory'],
    ['/init [force]', 'Ask the model to write a KODE.md'],
    ['/tools', 'List tools available in this mode'],
    ['/skills', 'List discovered skills'],
    ['/mcp [restart]', 'Show MCP servers or reconnect'],
    ['/hooks', 'Show configured hooks'],
    ['/doctor', 'Check configuration and connectivity'],
    ['/verbose', 'Toggle verbose output'],
    ['/version', 'Print the kode version'],
    ['/exit', 'Quit kode'],
  ];
  const lines = ['', ctx.ui.bold('Commands'), ''];
  for (const [name, description] of builtins) {
    lines.push(`  ${name.padEnd(30)} ${ctx.ui.dim(description)}`);
  }
  if (ctx.commands?.length) {
    lines.push('', ctx.ui.bold('Custom commands'));
    for (const command of ctx.commands) {
      const hint = command.argumentHint ? ` ${command.argumentHint}` : '';
      lines.push(`  ${`/${command.name}${hint}`.padEnd(30)} ${ctx.ui.dim(command.description || command.file)}`);
    }
  }
  if (ctx.skills?.length) {
    lines.push('', ctx.ui.bold('Skills'), ctx.ui.dim('  Invoke with /<skill-name> [args], or let the model use the Skill tool.'));
    for (const skill of ctx.skills) {
      lines.push(`  ${skill.name.padEnd(30)} ${ctx.ui.dim(skill.description || skill.file)}`);
    }
  }
  lines.push(
    '',
    ctx.ui.dim('Input tips: @path attaches a file, !command runs a shell command, \\ at line end continues.'),
    ctx.ui.dim('Permissions: [y] once, [a] always this session, [A] always and save to config, [n] no.'),
    ''
  );
  return lines.join('\n');
}

function contextReport(ctx) {
  const tokens = estimateTokens(ctx.session.messages);
  const limit = compactLimit(ctx.config, ctx.modelInfo);
  const window = ctx.modelInfo?.contextWindow || 128000;
  const pct = limit ? Math.round((tokens / limit) * 100) : 0;
  return {
    tokens,
    limit,
    window,
    pct,
    messages: ctx.session.messages.length,
    compactAt: ctx.config.context?.compactAt ?? 0.8,
  };
}

export async function handleCommand(raw, ctx) {
  const text = String(raw || '').trim();
  if (!text.startsWith('/')) return { type: 'not-command' };
  const match = text.slice(1).match(/^(\S+)\s*([\s\S]*)$/);
  if (!match) return { type: 'handled' };
  const name = match[1].toLowerCase();
  const args = (match[2] || '').trim();
  const ui = ctx.ui;

  switch (name) {
    case 'help':
    case '?':
      out(ui, helpText(ctx));
      return { type: 'handled' };

    case 'exit':
    case 'quit':
    case 'q':
      return { type: 'exit' };

    case 'version':
      out(ui, `kode ${VERSION}`);
      return { type: 'handled' };

    case 'status': {
      const report = contextReport(ctx);
      heading(ui, 'Status');
      bullet(ui, [
        `provider: ${ctx.provider.name} (${ctx.provider.label})`,
        `model:    ${ctx.modelInfo.id} · context ${report.window.toLocaleString()}`,
        `mode:     ${modeText(ctx.session)}`,
        `session:  ${ctx.session.id} · ${ctx.session.title}`,
        `cwd:      ${ctx.cwd}`,
        `context:  ~${formatTokens(report.tokens)} / ~${formatTokens(report.limit)} (${report.pct}%)`,
        `messages: ${report.messages}`,
      ]);
      return { type: 'handled' };
    }

    case 'setup': {
      if (!ctx.prompter || ui.mode !== 'interactive') {
        out(ui, 'Setup needs an interactive terminal. Run: kode setup');
        return { type: 'handled' };
      }
      try {
        await runSetup({ ui, prompter: ctx.prompter, config: ctx.config });
        ctx.reconfigure();
      } catch (err) {
        out(ui, ui.red(`Setup failed: ${err.message}`));
        return { type: 'handled' };
      }
      ctx.session.provider = ctx.provider.name;
      ctx.session.model = ctx.modelInfo.id;
      ctx.session.save();
      out(ui, ui.success(`Now using ${ctx.provider.label} / ${ctx.modelInfo.id}`));
      return { type: 'handled' };
    }

    case 'model': {
      if (!args) {
        heading(ui, `Model · ${ctx.provider.name}`);
        const active = ctx.provider.models.find((entry) => entry.id === ctx.config.model);
        bullet(
          ui,
          ctx.provider.models.length
            ? ctx.provider.models.map((entry) => {
                const mark = entry.id === ctx.modelInfo.id ? ui.cyan('›') : ' ';
                const ctxText = entry.contextWindow ? ui.dim(` · ${entry.contextWindow.toLocaleString()} ctx`) : '';
                return `${mark} ${entry.id}${ctxText}`;
              })
            : ['(no built-in model list; pass a model id)']
        );
        if (!active) out(ui, ui.dim(`  current: ${ctx.config.model} (custom)`));
        out(ui, ui.dim('Switch with /model <id> or /model <provider>/<id>.'));
        return { type: 'handled' };
      }
      const ref = parseModelRef(ctx.config, args);
      const previousProvider = ctx.config.provider;
      const previousModel = ctx.config.model;
      try {
        ctx.config.provider = ref.provider;
        ctx.config.model = ref.model;
        ctx.reconfigure();
      } catch (err) {
        ctx.config.provider = previousProvider;
        ctx.config.model = previousModel;
        out(ui, ui.red(`Could not switch model: ${err.message}`));
        return { type: 'handled' };
      }
      await persistModel(ctx);
      ctx.session.provider = ctx.provider.name;
      ctx.session.model = ctx.modelInfo.id;
      ctx.session.save();
      out(ui, ui.success(`Model: ${ctx.provider.name}/${ctx.modelInfo.id}`));
      return { type: 'handled' };
    }

    case 'provider': {
      if (!args) {
        heading(ui, 'Providers');
        for (const providerName of listProviderNames(ctx.config)) {
          let detail = '';
          try {
            const resolved = resolveProvider(ctx.config, providerName, ctx.config.__runtime);
            detail = resolved.apiKey ? ui.dim(' · key configured') : ui.dim(' · no key');
          } catch {}
          const mark = providerName === ctx.config.provider ? ui.cyan('›') : ' ';
          const label = PROVIDER_PRESETS[providerName]?.label || providerName;
          out(ui, `  ${mark} ${providerName.padEnd(16)} ${label}${detail}`);
        }
        return { type: 'handled' };
      }
      const providerName = args.trim();
      if (!PROVIDER_PRESETS[providerName] && !ctx.config.providers?.[providerName]) {
        out(ui, ui.red(`Unknown provider "${providerName}". Known: ${listProviderNames(ctx.config).join(', ')}`));
        return { type: 'handled' };
      }
      const previousProvider = ctx.config.provider;
      const previousModel = ctx.config.model;
      try {
        ctx.config.provider = providerName;
        const provider = resolveProvider(ctx.config, providerName, ctx.config.__runtime);
        ctx.config.model = provider.defaultModel || provider.models[0]?.id || ctx.config.model;
        ctx.reconfigure();
      } catch (err) {
        ctx.config.provider = previousProvider;
        ctx.config.model = previousModel;
        out(ui, ui.red(`Could not switch provider: ${err.message}`));
        return { type: 'handled' };
      }
      await persistModel(ctx);
      ctx.session.provider = ctx.provider.name;
      ctx.session.model = ctx.modelInfo.id;
      ctx.session.save();
      out(ui, ui.success(`Provider: ${ctx.provider.label} · model ${ctx.modelInfo.id}`));
      return { type: 'handled' };
    }

    case 'permissions':
    case 'permission':
    case 'mode': {
      if (!args) {
        heading(ui, 'Permissions');
        bullet(ui, [
          `mode:  ${ctx.session.mode}${ui.mode === 'interactive' ? '' : ''}`,
          `allow: ${[...(ctx.config.permissions?.allow || []), ...(ctx.session.allowRules || [])].join(' | ') || '(none)'}`,
          `deny:  ${[...(ctx.config.permissions?.deny || []), ...(ctx.session.denyRules || [])].join(' | ') || '(none)'}`,
        ]);
        out(ui, '');
        out(ui, ui.dim('Modes: default, acceptEdits, plan, bypassPermissions'));
        out(ui, ui.dim('Rules: Bash(npm test:*), Edit(src/**), Read(/abs/path), WebFetch(domain:example.com)'));
        return { type: 'handled' };
      }
      const mode = args.trim();
      if (!PERMISSION_MODES.includes(mode)) {
        out(ui, ui.red(`Unknown mode "${mode}". Use one of: ${PERMISSION_MODES.join(', ')}`));
        return { type: 'handled' };
      }
      if (mode === 'plan') ctx.session.prePlanMode = ctx.session.mode === 'plan' ? ctx.session.prePlanMode : ctx.session.mode;
      else ctx.session.prePlanMode = null;
      ctx.session.mode = mode;
      ctx.config.permissions = ctx.config.permissions || {};
      ctx.config.permissions.mode = mode;
      try {
        saveConfig(ctx.config);
      } catch (err) {
        ui.warn(`Could not save permission mode: ${err.message}`);
      }
      ctx.session.save();
      out(ui, ui.success(`Permission mode: ${mode}`));
      if (mode === 'bypassPermissions') {
        out(ui, ui.yellow('Warning: all tool calls are auto-approved in bypassPermissions mode.'));
      }
      return { type: 'handled' };
    }

    case 'plan': {
      if (ctx.session.mode === 'plan') {
        ctx.session.mode = ctx.session.prePlanMode || 'default';
        ctx.session.prePlanMode = null;
        out(ui, ui.success(`Plan mode off · permission mode ${ctx.session.mode}`));
      } else {
        ctx.session.prePlanMode = ctx.session.mode;
        ctx.session.mode = 'plan';
        out(ui, ui.success('Plan mode on · read-only research, then ExitPlanMode presents a plan.'));
      }
      ctx.session.save();
      return { type: 'handled' };
    }

    case 'config': {
      if (args === 'json') {
        out(ui, JSON.stringify(maskConfig(ctx.config), null, 2));
      } else {
        heading(ui, 'Configuration');
        bullet(ui, configSummary(ctx.config));
        out(ui, '');
        out(ui, ui.dim(`Use /config json to print the full masked config. Edit ${CONFIG_PATH} for advanced options.`));
      }
      return { type: 'handled' };
    }

    case 'system': {
      const tools = selectTools({
        config: ctx.config,
        mode: ctx.session.mode,
        mcpTools: ctx.agent?.mcp?.getTools() || [],
      });
      const system = buildSystemPrompt({
        config: ctx.config,
        session: ctx.session,
        provider: ctx.provider,
        modelInfo: ctx.modelInfo,
        tools,
        memory: ctx.memory,
        skills: ctx.skills,
        mcp: ctx.agent?.mcp
          ? { servers: ctx.agent.mcp.summary(), tools: ctx.agent.mcp.getTools() }
          : null,
      });
      out(ui, system);
      return { type: 'handled' };
    }

    case 'compact': {
      if (!ctx.agent) {
        out(ui, ui.red('No active agent.'));
        return { type: 'handled' };
      }
      out(ui, ui.dim('Compacting context…'));
      try {
        const report = await ctx.agent.compact(undefined, estimateTokens(ctx.session.messages));
        if (!report) {
          out(ui, 'Nothing to compact (need older user turns).');
        } else {
          out(ui, ui.success(`Compacted ${report.before} → ${report.after} messages (~${formatTokens(report.tokensBefore)} → ~${formatTokens(report.tokensAfter)} tokens).`));
        }
      } catch (err) {
        out(ui, ui.red(`Compaction failed: ${err.message}`));
      }
      ctx.session.save();
      return { type: 'handled' };
    }

    case 'context': {
      const report = contextReport(ctx);
      heading(ui, 'Context');
      bullet(ui, [
        `estimated tokens: ~${formatTokens(report.tokens)}`,
        `compaction limit: ~${formatTokens(report.limit)} (${Math.round(report.compactAt * 100)}% of ${formatTokens(report.window)})`,
        `usage:            ${report.pct}%`,
        `messages:         ${report.messages}`,
      ]);
      return { type: 'handled' };
    }

    case 'clear': {
      ctx.session.messages = [];
      ctx.session.title = 'Untitled session';
      ctx.session.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: true, requests: 0 };
      ctx.session.todos = [];
      ctx.session.checkpoints = [];
      ctx.session.allowRules = [];
      ctx.session.fileReads = {};
      ctx.session.save();
      out(ui, ui.success('Conversation cleared.'));
      return { type: 'handled' };
    }

    case 'name': {
      if (!args) {
        out(ui, `Session title: ${ctx.session.title}`);
        return { type: 'handled' };
      }
      ctx.session.title = truncateText(args.replace(/\s+/g, ' '), 72);
      ctx.session.save();
      out(ui, ui.success(`Session renamed: ${ctx.session.title}`));
      return { type: 'handled' };
    }

    case 'sessions':
    case 'session': {
      const sessions = listSessions(ctx.cwd, 20);
      if (!sessions.length) {
        out(ui, 'No saved sessions for this project.');
        return { type: 'handled' };
      }
      heading(ui, 'Recent sessions');
      for (const item of sessions) {
        const current = item.id === ctx.session.id ? ui.cyan('›') : ' ';
        const when = new Date(item.updatedAt || item.mtime).toLocaleString();
        out(ui, `  ${current} ${item.id}  ${item.title}`);
        out(ui, `    ${ui.dim(`${when} · ${item.messageCount} messages · ${item.provider || '?'}/${item.model || '?'}`)}`);
      }
      out(ui, ui.dim('Resume with /resume <id> (prefixes work).'));
      return { type: 'handled' };
    }

    case 'resume': {
      let selector = args;
      if (!selector) {
        const sessions = listSessions(ctx.cwd, 20);
        if (!sessions.length) {
          out(ui, 'No saved sessions to resume.');
          return { type: 'handled' };
        }
        if (!ctx.prompter || ui.mode !== 'interactive') {
          selector = 'latest';
        } else {
          const options = sessions.map((item) => ({
            label: `${item.title} · ${item.id}`,
            description: `${item.messageCount} messages · ${item.provider || '?'}/${item.model || '?'}`,
            value: item.id,
          }));
          const choice = await ctx.prompter.choose('Resume which session?', options, { allowCustom: true });
          if (choice === null) return { type: 'handled' };
          selector = typeof choice === 'object' ? choice.value : choice;
        }
      }
      let loaded;
      try {
        loaded = ctx.resumeSession(selector);
      } catch (err) {
        out(ui, ui.red(`Could not resume: ${err.message}`));
        return { type: 'handled' };
      }
      if (!loaded) {
        out(ui, ui.red(`Session not found: ${selector}`));
        return { type: 'handled' };
      }
      out(ui, ui.success(`Resumed ${loaded.id} · ${loaded.title} (${loaded.messages.length} messages)`));
      out(ui, ui.dim(`Provider/model: ${ctx.provider.name}/${ctx.modelInfo.id} · mode ${loaded.mode}`));
      return { type: 'handled' };
    }

    case 'undo': {
      const undo = ctx.session.undoLastCheckpoint();
      if (!undo) {
        out(ui, 'No checkpoints to undo.');
        return { type: 'handled' };
      }
      out(ui, ui.success(`Restored ${undo.restored.length} file(s) from checkpoint ${undo.entry.id}.`));
      for (const entry of undo.restored) {
        const relative = path.relative(ctx.cwd, entry.path);
        out(ui, `  ${entry.action}: ${relative.startsWith('..') ? entry.path : relative}`);
      }
      ctx.session.save();
      return { type: 'handled' };
    }

    case 'cost':
    case 'usage': {
      const usage = ctx.session.usage;
      const report = contextReport(ctx);
      heading(ui, 'Usage');
      bullet(ui, [
        `requests: ${usage.requests}`,
        `input:    ${formatTokens(usage.input)}`,
        `output:   ${formatTokens(usage.output)}`,
        `cache:    ${formatTokens(usage.cacheRead)} read · ${formatTokens(usage.cacheWrite)} write`,
        `cost:     ${usage.costKnown ? formatCost(usage.cost) : 'unknown (no pricing for this model)'}`,
        `context:  ${report.pct}% of compaction limit`,
      ]);
      return { type: 'handled' };
    }

    case 'todos': {
      if (!ctx.session.todos.length) {
        out(ui, 'No todos.');
        return { type: 'handled' };
      }
      const marks = { pending: '☐', in_progress: '→', completed: '✔' };
      heading(ui, 'Todos');
      for (const todo of ctx.session.todos) {
        out(ui, `  ${marks[todo.status] || '•'} ${todo.content}${todo.status === 'in_progress' && todo.activeForm ? ui.dim(` (${todo.activeForm})`) : ''}`);
      }
      return { type: 'handled' };
    }

    case 'memory': {
      const memory = buildMemoryContext(ctx.cwd);
      heading(ui, 'Instruction files');
      if (memory.instructionFiles.length) bullet(ui, memory.instructionFiles);
      else out(ui, '  (none — use /init)');
      heading(ui, 'Memory directories');
      const projectFiles = listMemoryFiles(memory.projectMemory);
      const userFiles = listMemoryFiles(memory.userMemory);
      out(ui, `  project: ${memory.projectMemory} (${projectFiles.length} files)`);
      for (const file of projectFiles.slice(0, 12)) out(ui, ui.dim(`    ${path.relative(memory.projectMemory, file.path)}`));
      out(ui, `  user:    ${memory.userMemory} (${userFiles.length} files)`);
      for (const file of userFiles.slice(0, 12)) out(ui, ui.dim(`    ${path.relative(memory.userMemory, file.path)}`));
      return { type: 'handled' };
    }

    case 'init': {
      const target = path.join(ctx.cwd, 'KODE.md');
      if (fs.existsSync(target) && args !== 'force') {
        out(ui, `KODE.md already exists at ${target}. Use /init force to have the model update it.`);
        return { type: 'handled' };
      }
      return {
        type: 'prompt',
        text: [
          fs.existsSync(target) ? 'Update the existing KODE.md for this repository.' : 'Create a KODE.md instruction file for this repository.',
          'Explore the codebase first (package files, README, directory layout, existing conventions, CI and test commands).',
          'Write a concise KODE.md at the repository root containing: project purpose, architecture/module map, setup and test commands, code style and conventions,',
          'important constraints or gotchas, and how to verify changes. Keep it under ~120 lines. Use the Write tool.',
          'Do not invent facts; only document what you verified in the repo.',
        ].join(' '),
      };
    }

    case 'tools': {
      const tools = selectTools({
        config: ctx.config,
        mode: ctx.session.mode,
        mcpTools: ctx.agent?.mcp?.getTools() || [],
      });
      heading(ui, `Tools · mode ${ctx.session.mode}`);
      for (const tool of tools) {
        out(ui, `  ${tool.name.padEnd(24)} ${ui.dim(truncateText(tool.description || '', 100))}`);
      }
      return { type: 'handled' };
    }

    case 'skills': {
      const skills = discoverSkills(ctx.cwd);
      if (!skills.length) {
        out(ui, 'No skills found. Add .kode/skills/<name>/SKILL.md or ~/.kode/skills/<name>/SKILL.md.');
        return { type: 'handled' };
      }
      heading(ui, 'Skills');
      for (const skill of skills) {
        out(ui, `  ${skill.name.padEnd(24)} ${ui.dim(`${skill.source} · ${skill.description || skill.file}`)}`);
      }
      return { type: 'handled' };
    }

    case 'mcp': {
      if (args === 'restart' || args === 'reconnect') {
        if (!ctx.restartMcp) {
          out(ui, 'MCP management is unavailable.');
          return { type: 'handled' };
        }
        out(ui, ui.dim('Restarting MCP servers…'));
        await ctx.restartMcp();
        const servers = ctx.agent?.mcp?.summary() || [];
        if (!servers.length) out(ui, 'No MCP servers configured.');
        else for (const server of servers) out(ui, `  ${server.name}: ${server.status}${server.error ? ` — ${server.error}` : ''}`);
        return { type: 'handled' };
      }
      const servers = ctx.agent?.mcp?.summary() || [];
      if (!servers.length) {
        out(ui, 'No MCP servers configured. Add "mcpServers" to config.json (stdio transport).');
      } else {
        heading(ui, 'MCP servers');
        for (const server of servers) {
          out(ui, `  ${server.name}: ${server.status}${server.error ? ` — ${server.error}` : ''}${server.tools ? ` · ${server.tools} tools` : ''}`);
        }
      }
      return { type: 'handled' };
    }

    case 'hooks': {
      const hooks = ctx.config.hooks || {};
      const events = Object.keys(hooks);
      if (!events.length) {
        out(ui, 'No hooks configured. Hooks live under "hooks" in config.json (UserPromptSubmit, PreToolUse, PostToolUse, Stop).');
        return { type: 'handled' };
      }
      heading(ui, 'Hooks');
      for (const event of events) out(ui, `  ${event}: ${JSON.stringify(hooks[event])}`);
      return { type: 'handled' };
    }

    case 'doctor': {
      const report = await (ctx.runDoctor ? ctx.runDoctor() : runDoctor({ config: ctx.config, provider: ctx.provider, cwd: ctx.cwd }));
      out(ui, formatDoctor(report));
      return { type: 'handled' };
    }

    case 'verbose': {
      ui.verbose = !ui.verbose;
      ctx.config.ui = ctx.config.ui || {};
      ctx.config.ui.verbose = ui.verbose;
      out(ui, ui.success(`Verbose ${ui.verbose ? 'on' : 'off'}.`));
      return { type: 'handled' };
    }

    default:
      break;
  }

  const custom = (ctx.commands || []).find((command) => command.name === match[1]);
  if (custom) {
    return { type: 'prompt', text: expandCommand(custom, args), command: custom.name };
  }
  const skill = (ctx.skills || []).find((entry) => entry.name.toLowerCase() === name);
  if (skill) {
    const body = `<skill name="${skill.name}">\n${skill.body}\n</skill>`;
    return {
      type: 'prompt',
      text: args ? `${body}\n\nArguments for this skill:\n${args}` : body,
      command: `skill:${skill.name}`,
    };
  }

  out(ui, ui.red(`Unknown command: /${match[1]}`));
  out(ui, ui.dim('Run /help to see available commands.'));
  return { type: 'handled' };
}
