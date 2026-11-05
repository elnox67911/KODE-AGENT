# kode

A terminal coding agent with the full harness — tools, streaming, subagents, sessions, context compaction, MCP, skills, memory, hooks, permissions, and plan mode — with **BYOK** (bring your own API key). No account, no subscription, no telemetry. Zero runtime dependencies: Node.js 18+ and the global `fetch`.

```
npm install -g kode        # or: npm link  (from this directory)
kode setup
kode "explain this repo and suggest three improvements"
```

---

## Why kode

- **BYOK across providers.** Use one config and switch between Anthropic, OpenAI, Gemini, OpenRouter, Groq, DeepSeek, xAI, Mistral, Together, local Ollama/LM Studio, or any OpenAI-compatible endpoint.
- **A real agent loop.** Streaming responses, tool calls, tool results, retries, max turns, abort handling, and per-request cost accounting.
- **Everything local.** Keys, sessions, memory, and checkpoints live under `~/.kode` (mode 0600). Nothing is sent anywhere except the provider you choose (plus web tools you invoke).
- **Hackable.** Plain ESM modules, no build step, no transpiler, no framework.

---

## Install

Requirements: Node.js **18 or newer** (Node 20+ recommended).

```bash
cd kode
npm link          # makes `kode` available on your PATH
# or run directly:
node bin/kode.js
```

Then configure:

```bash
kode setup
```

The wizard asks for a provider, model, and API key. The key is written to `~/.kode/config.json` with `0600` permissions and is never printed back in full.

### Keys from environment variables

If you'd rather not store keys on disk, export the provider's env var and run `kode setup` (choose "keep existing") or just start kode — it resolves keys from the environment at runtime:

| Provider | Environment variable(s) |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google Gemini | `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Groq | `GROQ_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| xAI | `XAI_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| Together AI | `TOGETHER_API_KEY` |
| Ollama / LM Studio | (no key needed) |
| Custom endpoint | `KODE_CUSTOM_API_KEY` |

`--api-key <key>` overrides the key for a single run without saving it.

---

## Usage

```bash
kode                              # interactive REPL
kode "fix the failing test"       # one prompt, then interactive
kode -p "summarize README.md"     # one-shot print mode (no REPL)
kode -c                           # continue the most recent session
kode -r <id|latest>               # resume a specific session
kode -m openai/gpt-5              # switch provider and model in one flag
kode --permission-mode plan       # read-only planning
kode -p "do it" --output-format json
```

Useful flags:

| Flag | Purpose |
| --- | --- |
| `-m, --model <ref>` | Model id or `provider/model` |
| `--provider <name>` | Switch provider (picks its default model if `-m` is absent) |
| `--api-key`, `--base-url` | One-run overrides, never saved |
| `--permission-mode <mode>` | `default`, `acceptEdits`, `plan`, `bypassPermissions` |
| `-y, --yes` | Auto-approve everything for this run |
| `--allowed-tools <list>` | Comma-separated allow rules, e.g. `"Bash(npm test:*),Read"` |
| `--max-turns <n>` | Cap agent iterations per request |
| `--system-prompt`, `--append-system-prompt` | Add instructions for this run |
| `--output-format text\|json` | JSON prints a single result object |
| `--no-mcp`, `--no-color`, `--no-spinner`, `--verbose`, `--repl` | Runtime toggles |

Inside the REPL:

- `@path/to/file` attaches a file (images become vision blocks, text is capped).
- `!command` runs a shell command without involving the model.
- A trailing `\` continues input on the next line.
- `Ctrl+C` aborts the current turn; `Ctrl+D` or `/exit` quits.

### Subcommands

```bash
kode setup      # interactive provider/model/key wizard
kode doctor     # checks config permissions, key presence, endpoint reachability, tools, MCP, sessions
kode config     # print the effective configuration (add `json` for a masked dump)
kode sessions   # list sessions for the current project
kode models     # list known models; `--refresh` queries the provider's /models endpoint
```

---

## Configuration

Config lives at `~/.kode/config.json` (set `KODE_HOME` to move it). A minimal file:

```json
{
  "provider": "openai",
  "model": "gpt-5",
  "maxTokens": 8192,
  "maxTurns": 60,
  "providers": {
    "openai": { "apiKey": "sk-...", "defaultModel": "gpt-5" }
  },
  "permissions": {
    "mode": "default",
    "allow": ["Read", "Glob", "Grep", "Bash(npm test:*)"],
    "deny": ["Bash(rm -rf:*)"]
  },
  "context": {
    "autoCompact": true,
    "compactAt": 0.8,
    "reserveTokens": 16000,
    "keepRecentTokens": 24000
  },
  "tools": { "only": null, "deny": [] },
  "mcpServers": {},
  "hooks": {}
}
```

- `providers.<name>` may set `apiKey`, `baseURL`, `defaultModel`, `models`, and extra `headers`.
- Custom providers not in the preset list are treated as OpenAI-compatible; set `baseURL`.
- `tools.only` restricts the exposed tool set; `tools.deny` removes specific tools.
- Override pricing with `"pricing": { "openai:gpt-5": { "input": 1.25, "output": 10 } }` (USD per million tokens; omit the provider prefix to apply to all).
- Env overrides: `KODE_PROVIDER`, `KODE_MODEL`, `KODE_PERMISSION_MODE`, `KODE_MAX_TURNS`.

---

## Permissions

Four modes:

| Mode | Behavior |
| --- | --- |
| `default` | Read-only tools run; writes, Bash, and MCP tools prompt |
| `acceptEdits` | File edits are auto-approved; Bash and MCP still prompt |
| `plan` | Read-only only; writes, Bash, and MCP are denied until `ExitPlanMode` |
| `bypassPermissions` | Everything is approved |

When prompted you can choose **y** (once), **a** (always for this session), **A** (always and persist to config), or **n** (deny).

Rules use `Tool(pattern)` syntax:

```
Read                     # any read
Bash(npm test:*)         # commands starting with "npm test"
Bash(git status)         # exact command
Edit(src/**/*.ts)        # glob relative to the project
Write(/abs/path/file)    # absolute path
WebFetch(domain:example.com)
mcp__github__create_issue
```

Deny rules always win. Session rules are layered on top of config rules.

---

## Slash commands

`/help` lists everything, including custom commands and skills.

| Command | Purpose |
| --- | --- |
| `/status` | Provider, model, mode, session, context usage |
| `/setup` | Re-run the configuration wizard |
| `/model [provider/]model` | Show or switch model |
| `/provider [name]` | Show or switch provider |
| `/permissions [mode]`, `/plan` | Change permission mode |
| `/config [json]` | Effective configuration |
| `/system` | Print the full system prompt |
| `/compact [focus]`, `/context` | Compact older context / show usage |
| `/clear`, `/name <title>` | Clear conversation / rename session |
| `/sessions`, `/resume [id]` | Session management |
| `/undo` | Restore files from the last checkpoint |
| `/cost` | Token usage and estimated cost |
| `/todos` | Current todo list |
| `/memory`, `/init [force]` | Show instruction files / generate `KODE.md` |
| `/tools`, `/skills`, `/mcp [restart]`, `/hooks` | Inspect runtime features |
| `/doctor`, `/verbose`, `/version`, `/exit` | Utilities |

---

## Tools

Built in:

`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `BashOutput`, `KillShell`, `WebFetch`, `WebSearch`, `TodoWrite`, `Task`, `AskUserQuestion`, `Skill`, `Memory`, `ExitPlanMode`.

- **Read/Write/Edit** are line-aware and tracked; edits produce diffs and create checkpoints for `/undo`.
- **Grep** uses ripgrep when available, with a JS fallback; supports glob and type filters.
- **Bash** runs in the project cwd with a timeout, output caps, and background job support.
- **WebSearch** uses Brave (`BRAVE_API_KEY`), a SearXNG base URL, or DuckDuckGo as a fallback.
- **Task** spawns a subagent (see below). **AskUserQuestion** prompts you mid-turn.
- **Memory** lets the model read and write durable notes in the project memory directory.

### Subagents

The `Task` tool runs a fresh, isolated agent with its own session and a restricted tool set (no `Task`, `ExitPlanMode`, or `AskUserQuestion`). Three types are supported:

- `general` — full implementation work
- `explore` — read-only codebase search
- `plan` — architecture and implementation planning

Subagent sessions are not saved to project history; their token usage rolls up into the parent's `/cost`.

---

## Sessions & checkpoints

- Conversations are saved per project under `~/.kode/projects/<hash>/sessions/`.
- `kode -c`, `/resume`, and `kode -r <prefix>` restore a transcript, including the provider/model it used.
- File edits record checkpoints; `/undo` restores the last one.
- Usage (requests, input/output tokens, estimated cost) is persisted with each session.

---

## Context management

When the estimated context exceeds `context.compactAt` of the model window (minus `reserveTokens`), kode:

1. Finds a boundary at a plain user message.
2. Keeps roughly `keepRecentTokens` of recent turns.
3. Asks the model to summarize the older portion (with a deterministic fallback if the summary call fails).
4. Replaces the older messages with the summary, preserving tool-call integrity.

Context overflow errors from the provider trigger compaction and a retry.

---

## MCP servers

Add stdio MCP servers under `mcpServers`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "..." }
    }
  }
}
```

Tools are exposed as `mcp__<server>__<tool>`. `/mcp` lists connection state; `/mcp restart` reconnects. Start with `--no-mcp` to skip servers. HTTP/SSE transports are not supported — use a stdio bridge.

---

## Hooks

Hooks are shell commands that receive JSON on stdin. Configure them per event:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "command": "node ./scripts/check-prompt.js", "timeout": 10000 }
    ],
    "PreToolUse": [
      { "matcher": "^(Bash|Write)$", "command": "./scripts/guard.sh" }
    ],
    "PostToolUse": [
      "./scripts/format.sh"
    ],
    "Stop": [
      "./scripts/verify.sh"
    ]
  }
}
```

Events: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`. Payloads include `session_id`, `cwd`, `model`, and for tool events `tool_name`, `tool_input`, `permission_mode`. Environment variables `KODE_HOOK_EVENT`, `KODE_TOOL_NAME`, `KODE_CWD`, `KODE_SESSION_ID`, and `KODE_MODEL` are also set.

Control flow:

- Exit code `2`, or JSON `{"decision":"block","reason":"..."}` blocks a tool/prompt.
- JSON `{"decision":"allow"}` in `PreToolUse` bypasses the permission prompt.
- Any stdout is added to the model's context (capped).

---

## Skills

Skills are Markdown playbooks the model can load through the `Skill` tool, or you can invoke directly with `/<skill-name>`.

Locations (project wins on name collisions):

```
.kode/skills/<name>/SKILL.md
~/.kode/skills/<name>/SKILL.md
```

Format:

```markdown
---
name: release
description: Cut a release, update the changelog, and tag it.
when_to_use: The user asks to ship or publish a version.
allowed_tools: [Bash, Read, Edit]
---

1. Run the tests.
2. Bump the version.
3. Update CHANGELOG.md.
4. Commit and tag.
```

`/skills` lists discovered skills. Skills are also advertised in the system prompt.

---

## Custom commands

Markdown files in `.kode/commands/` or `~/.kode/commands/` become slash commands:

```markdown
---
description: Review the current diff
argument-hint: "[focus area]"
---

Review the staged diff. Focus on: $ARGUMENTS
Check correctness, error handling, and tests.
```

`$ARGUMENTS` is the full argument string; `$1`, `$2`, … are individual arguments. If no placeholder is present, arguments are appended. Both `.kode/commands` and skills appear in `/help`.

---

## Memory & instructions

Instruction files are discovered from the project root upward (`KODE.md`, `AGENTS.md`, `CLAUDE.md`, `.kode/KODE.md`) plus `~/.kode/KODE.md`, then injected into the system prompt. `/init` asks the model to write a `KODE.md` from the repo.

Persistent memory indices live in:

```
<project>/.kode/memory/MEMORY.md
~/.kode/memory/MEMORY.md
```

The agent can read and write memory files through the `Memory` tool; `/memory` shows what was loaded.

---

## Architecture

```
bin/kode.js              entry point
src/index.js             orchestration: CLI, REPL, sessions, MCP lifecycle
src/cli.js               argument parser + help
src/config.js            presets, config load/save, provider resolution
src/setup.js             interactive BYOK wizard
src/doctor.js            environment/connectivity diagnostics
src/agent/agent.js       agent loop, tool execution, permissions, hooks, subagents
src/agent/context.js     token estimation and compaction
src/agent/prompt.js      system prompt construction
src/providers/           Anthropic, OpenAI-compatible, Google adapters
src/tools/               built-in tool implementations
src/permissions.js       rule parsing and evaluation
src/session.js           transcripts, checkpoints, usage
src/mcp.js               stdio MCP client
src/skills.js            skill discovery
src/custom-commands.js   slash-command discovery and expansion
src/memory.js            instruction files and memory indices
src/hooks.js             hook execution
src/ui/                  terminal rendering and prompts
src/commands.js          slash command handlers
```

Message format is Anthropic-style blocks (`text`, `tool_use`, `tool_result`, `image`) internally; each provider adapter converts to and from its wire format. Streaming is SSE, with tool-call deltas accumulated until valid JSON arrives.

---

## Tests

```bash
npm test        # node --check every file + smoke tests
npm run check   # syntax + module/tool contract checks
```

The smoke suite spins up a mock OpenAI-compatible server and verifies streaming, a full tool round-trip, JSON output, session persistence, subagents with isolated context, and a piped REPL.

---

## Security notes

- Keys are stored in `~/.kode/config.json` with `0600`; `kode config` masks them.
- Prefer environment variables or `--api-key` on shared machines.
- `bypassPermissions` disables all confirmation. Use it only in sandboxed or disposable environments.
- Hooks run arbitrary shell commands — treat `.kode` config as code.
- Web tools and MCP servers make outbound requests to endpoints you configure.

## Limitations

- Stdio MCP only (no HTTP/SSE transport).
- Token counts for context management are estimates; providers report exact usage after each response.
- Pricing tables are best-effort and can drift; override them under `pricing` in config.
- Markdown rendering is terminal-oriented (headings, lists, code, emphasis), not a full CommonMark renderer.

## License

MIT
