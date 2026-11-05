import { VERSION } from './config.js';

const SUBCOMMANDS = new Set(['setup', 'doctor', 'config', 'sessions', 'models']);

export function parseArgs(argv) {
  const args = argv.slice();
  let command = null;
  if (args.length && SUBCOMMANDS.has(args[0])) command = args.shift();

  const options = {
    print: false,
    continue: false,
    resume: null,
    model: null,
    provider: null,
    apiKey: null,
    baseUrl: null,
    permissionMode: null,
    yes: false,
    allowedTools: [],
    maxTurns: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    outputFormat: 'text',
    mcp: true,
    verbose: false,
    color: true,
    spinner: true,
    repl: false,
    refresh: false,
    help: false,
    version: false,
    configPath: null,
  };
  const promptParts = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      promptParts.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      promptParts.push(arg);
      continue;
    }

    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const value = () => {
      if (inline !== null) return inline;
      const next = args[i + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-')) {
        throw new Error(`${flag} requires a value`);
      }
      i++;
      return next;
    };

    switch (flag) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '-V':
      case '--version':
        options.version = true;
        break;
      case '-p':
      case '--print':
        options.print = true;
        break;
      case '-c':
      case '--continue':
        options.continue = true;
        break;
      case '-r':
      case '--resume':
        options.resume = inline !== null ? inline : 'latest';
        if (inline === null) {
          const next = args[i + 1];
          if (next !== undefined && !next.startsWith('-')) {
            options.resume = next;
            i++;
          }
        }
        break;
      case '--model':
      case '-m':
        options.model = value();
        break;
      case '--provider':
        options.provider = value();
        break;
      case '--api-key':
        options.apiKey = value();
        break;
      case '--base-url':
        options.baseUrl = value();
        break;
      case '--permission-mode':
        options.permissionMode = value();
        break;
      case '-y':
      case '--yes':
      case '--dangerously-skip-permissions':
        options.yes = true;
        break;
      case '--allowed-tools':
        options.allowedTools = value()
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
        break;
      case '--max-turns':
        options.maxTurns = Number(value());
        if (!Number.isFinite(options.maxTurns) || options.maxTurns <= 0) throw new Error('--max-turns must be a positive number');
        break;
      case '--system-prompt':
        options.systemPrompt = value();
        break;
      case '--append-system-prompt':
        options.appendSystemPrompt = value();
        break;
      case '--output-format':
        options.outputFormat = value();
        if (!['text', 'json'].includes(options.outputFormat)) {
          throw new Error('--output-format must be "text" or "json"');
        }
        break;
      case '--no-mcp':
        options.mcp = false;
        break;
      case '--no-color':
        options.color = false;
        break;
      case '--no-spinner':
        options.spinner = false;
        break;
      case '--repl':
        options.repl = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--refresh':
        options.refresh = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return {
    command,
    options,
    prompt: promptParts.join(' ').trim(),
    args: promptParts,
  };
}

export function helpText() {
  return `kode v${VERSION} — a BYOK terminal coding agent

Usage:
  kode [options] [prompt]        Start interactive mode, or run one prompt
  kode -p "prompt"               One-shot (print) mode
  kode -c                        Continue the most recent session
  kode -r [id]                   Resume a session (id prefix or "latest")

Commands:
  kode setup                     Configure provider, model and API key
  kode doctor                    Check config, key, endpoint and environment
  kode config                    Print the effective configuration
  kode sessions                  List saved sessions for this project
  kode models                    List models for the current provider

Options:
  -m, --model <ref>              Model id, or provider/model (e.g. openai/gpt-5)
      --provider <name>          anthropic | openai | google | openrouter | groq |
                                 deepseek | xai | mistral | together | ollama | lmstudio | custom
      --api-key <key>            Override the API key for this run (not saved)
      --base-url <url>           Override the provider base URL (not saved)
      --permission-mode <mode>   default | acceptEdits | plan | bypassPermissions
  -y, --yes                      Auto-approve tools (same as bypassPermissions for this run)
      --allowed-tools <list>     Comma-separated tool allow rules, e.g. "Bash(npm test:*),Read"
      --max-turns <n>            Maximum agent turns per request
      --system-prompt <text>     Add a system instruction for this run
      --append-system-prompt <t> Append to the configured system prompt
      --output-format <fmt>      text | json
      --no-mcp                   Do not start MCP servers
      --no-color                 Disable ANSI colors
      --no-spinner               Disable the spinner
      --verbose                  Verbose output
      --repl                     Force the interactive REPL even with a prompt
  -h, --help                     Show this help
  -v, --version                  Show the version

Inside the REPL:
  /help                          List commands
  @path/to/file                  Attach a file to your message
  !command                       Run a shell command
  \\ at end of line               Continue input on the next line

Config: ~/.kode/config.json (override the home with KODE_HOME)
Keys can also come from env vars: ANTHROPIC_API_KEY, OPENAI_API_KEY,
GEMINI_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY, DEEPSEEK_API_KEY, etc.`;
}

export function printHelp(stream = process.stdout) {
  stream.write(`${helpText()}\n`);
}
