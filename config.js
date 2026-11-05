import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  deepMerge,
  ensureDir,
  expandHome,
  maskSecret,
  safeJsonParse,
  sha1,
  writeFileAtomic,
} from './utils.js';

export const VERSION = '0.1.0';

export const KODE_HOME = process.env.KODE_HOME
  ? path.resolve(expandHome(process.env.KODE_HOME))
  : path.join(os.homedir(), '.kode');

export const CONFIG_PATH = path.join(KODE_HOME, 'config.json');
export const USER_MEMORY_DIR = path.join(KODE_HOME, 'memory');
export const USER_SKILLS_DIR = path.join(KODE_HOME, 'skills');
export const USER_COMMANDS_DIR = path.join(KODE_HOME, 'commands');

const model = (id, contextWindow, maxOutput, input, output, extra = {}) => ({
  id,
  contextWindow,
  maxOutput,
  ...(input != null ? { pricing: { input, output } } : {}),
  ...extra,
});

export const PROVIDER_PRESETS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    type: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    env: ['ANTHROPIC_API_KEY'],
    defaultModel: 'claude-sonnet-4-5',
    models: [
      model('claude-sonnet-4-5', 200000, 32000, 3, 15),
      model('claude-opus-4-1', 200000, 32000, 15, 75),
      model('claude-haiku-4-5', 200000, 32000, 0.8, 4),
      model('claude-sonnet-4-0', 200000, 16000, 3, 15),
      model('claude-3-7-sonnet-latest', 200000, 16000, 3, 15),
    ],
  },
  openai: {
    label: 'OpenAI',
    type: 'openai',
    baseURL: 'https://api.openai.com/v1',
    env: ['OPENAI_API_KEY'],
    defaultModel: 'gpt-5',
    models: [
      model('gpt-5', 400000, 128000, 1.25, 10),
      model('gpt-5-mini', 400000, 128000, 0.25, 2),
      model('gpt-5-codex', 400000, 128000, 1.25, 10),
      model('gpt-4.1', 1047576, 32768, 2, 8),
      model('gpt-4o', 128000, 16384, 2.5, 10),
      model('o4-mini', 200000, 100000, 1.1, 4.4),
    ],
  },
  google: {
    label: 'Google Gemini',
    type: 'google',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    defaultModel: 'gemini-2.5-pro',
    models: [
      model('gemini-2.5-pro', 1048576, 65536, 1.25, 10),
      model('gemini-2.5-flash', 1048576, 65536, 0.3, 2.5),
      model('gemini-2.0-flash', 1048576, 8192, 0.1, 0.4),
    ],
  },
  openrouter: {
    label: 'OpenRouter',
    type: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
    env: ['OPENROUTER_API_KEY'],
    defaultModel: 'anthropic/claude-sonnet-4.5',
    headers: { 'HTTP-Referer': 'https://github.com/kode-agent/kode', 'X-Title': 'kode' },
    models: [
      model('anthropic/claude-sonnet-4.5', 200000, 64000),
      model('openai/gpt-5', 400000, 128000),
      model('google/gemini-2.5-pro', 1048576, 65536),
      model('x-ai/grok-4', 256000, 32000),
      model('deepseek/deepseek-chat-v3.1', 128000, 8192),
      model('qwen/qwen3-coder', 262144, 32768),
      model('meta-llama/llama-3.3-70b-instruct', 131072, 32768),
    ],
  },
  groq: {
    label: 'Groq',
    type: 'openai',
    baseURL: 'https://api.groq.com/openai/v1',
    env: ['GROQ_API_KEY'],
    defaultModel: 'llama-3.3-70b-versatile',
    models: [
      model('llama-3.3-70b-versatile', 131072, 32768, 0.59, 0.79),
      model('openai/gpt-oss-120b', 131072, 32768, 0.15, 0.75),
      model('qwen/qwen3-32b', 131072, 32768, 0.29, 0.59),
      model('moonshotai/kimi-k2-instruct', 131072, 32768, 1, 3),
    ],
  },
  deepseek: {
    label: 'DeepSeek',
    type: 'openai',
    baseURL: 'https://api.deepseek.com/v1',
    env: ['DEEPSEEK_API_KEY'],
    defaultModel: 'deepseek-chat',
    models: [
      model('deepseek-chat', 128000, 8192, 0.27, 1.1),
      model('deepseek-reasoner', 128000, 65536, 0.55, 2.19),
    ],
  },
  xai: {
    label: 'xAI (Grok)',
    type: 'openai',
    baseURL: 'https://api.x.ai/v1',
    env: ['XAI_API_KEY'],
    defaultModel: 'grok-4',
    models: [
      model('grok-4', 256000, 32000, 3, 15),
      model('grok-3', 131072, 32000, 3, 15),
      model('grok-code-fast-1', 256000, 32000, 0.2, 1.5),
    ],
  },
  mistral: {
    label: 'Mistral',
    type: 'openai',
    baseURL: 'https://api.mistral.ai/v1',
    env: ['MISTRAL_API_KEY'],
    defaultModel: 'devstral-medium-latest',
    models: [
      model('devstral-medium-latest', 128000, 32000, 0.4, 2),
      model('mistral-large-latest', 128000, 32000, 2, 6),
      model('codestral-latest', 256000, 32000, 0.3, 0.9),
      model('magistral-medium-latest', 128000, 32000, 2, 5),
    ],
  },
  together: {
    label: 'Together AI',
    type: 'openai',
    baseURL: 'https://api.together.xyz/v1',
    env: ['TOGETHER_API_KEY'],
    defaultModel: 'Qwen/Qwen3-Coder-480B-A35B-Instruct',
    models: [
      model('Qwen/Qwen3-Coder-480B-A35B-Instruct', 262144, 32768, 2, 2),
      model('meta-llama/Llama-3.3-70B-Instruct-Turbo', 131072, 32768, 0.88, 0.88),
      model('deepseek-ai/DeepSeek-R1', 131072, 32768, 3, 7),
    ],
  },
  ollama: {
    label: 'Ollama (local)',
    type: 'openai',
    baseURL: 'http://localhost:11434/v1',
    env: [],
    needsKey: false,
    defaultKey: 'ollama',
    defaultModel: 'qwen2.5-coder:14b',
    models: [
      model('qwen2.5-coder:14b', 131072, 8192),
      model('qwen3-coder:30b', 262144, 16384),
      model('gpt-oss:20b', 131072, 16384),
      model('llama3.2', 131072, 8192),
      model('deepseek-r1:8b', 131072, 8192),
    ],
  },
  lmstudio: {
    label: 'LM Studio (local)',
    type: 'openai',
    baseURL: 'http://localhost:1234/v1',
    env: [],
    needsKey: false,
    defaultKey: 'lm-studio',
    defaultModel: 'local-model',
    models: [model('local-model', 131072, 8192)],
  },
  custom: {
    label: 'Custom OpenAI-compatible',
    type: 'openai',
    baseURL: '',
    env: ['KODE_CUSTOM_API_KEY'],
    defaultModel: '',
    models: [],
  },
};

export const PROVIDER_ORDER = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'groq',
  'deepseek',
  'xai',
  'mistral',
  'together',
  'ollama',
  'lmstudio',
  'custom',
];

export const DEFAULT_CONFIG = {
  version: 1,
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  maxTokens: 8192,
  temperature: null,
  systemPromptAppend: '',
  maxTurns: 60,
  providers: {},
  permissions: {
    mode: 'default',
    allow: [],
    deny: [],
  },
  context: {
    autoCompact: true,
    compactAt: 0.8,
    reserveTokens: 16000,
    keepRecentTokens: 24000,
  },
  ui: {
    markdown: true,
    spinner: true,
    verbose: false,
  },
  tools: {
    only: null,
    deny: [],
  },
  webSearch: {
    provider: 'auto',
    searxngBaseURL: '',
  },
  mcpServers: {},
  hooks: {},
  pricing: {},
};

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

export function envName(name) {
  return String(name).toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

export function ensureHome() {
  ensureDir(KODE_HOME, 0o700);
  return KODE_HOME;
}

export function normalizeModels(models) {
  return (models || [])
    .map((entry) => (typeof entry === 'string' ? { id: entry } : { ...entry, id: entry?.id || entry?.name }))
    .filter((entry) => entry.id);
}

export function loadConfig() {
  ensureHome();
  let raw = {};
  if (fs.existsSync(CONFIG_PATH)) {
    const text = fs.readFileSync(CONFIG_PATH, 'utf8');
    raw = safeJsonParse(text, null);
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Invalid config JSON at ${CONFIG_PATH}. Fix or delete the file, then run "kode setup".`);
    }
  }
  const config = deepMerge(structuredClone(DEFAULT_CONFIG), raw);
  if (process.env.KODE_PROVIDER) config.provider = process.env.KODE_PROVIDER;
  if (process.env.KODE_MODEL) config.model = process.env.KODE_MODEL;
  if (process.env.KODE_PERMISSION_MODE) config.permissions.mode = process.env.KODE_PERMISSION_MODE;
  if (process.env.KODE_MAX_TURNS) config.maxTurns = Number(process.env.KODE_MAX_TURNS) || config.maxTurns;
  return config;
}

export function saveConfig(config) {
  ensureHome();
  const clone = structuredClone(config);
  delete clone.__runtime;
  writeFileAtomic(CONFIG_PATH, `${JSON.stringify(clone, null, 2)}\n`, 0o600);
  return CONFIG_PATH;
}

export function resolveSecret(value) {
  if (!value) return undefined;
  const str = String(value);
  if (str.startsWith('env:')) return process.env[str.slice(4)] || undefined;
  if (str.startsWith('$')) return process.env[str.slice(1)] || undefined;
  return str;
}

export function listProviderNames(config) {
  const names = new Set(PROVIDER_ORDER);
  for (const name of Object.keys(config.providers || {})) names.add(name);
  return [...names];
}

export function resolveProvider(config, name = config.provider, runtime = config.__runtime) {
  const user = config.providers?.[name] || {};
  const preset = PROVIDER_PRESETS[name];
  if (!preset && !user.baseURL) {
    throw new Error(
      `Unknown provider "${name}". Known providers: ${listProviderNames(config).join(', ')}. ` +
        'Define a custom provider under "providers" in config.json.'
    );
  }
  const type = user.type || preset?.type || 'openai';
  const baseURL =
    (runtime?.provider === name ? runtime.baseURL : undefined) ||
    process.env[`KODE_${envName(name)}_BASE_URL`] ||
    user.baseURL ||
    preset?.baseURL ||
    '';
  if (type !== 'google' && type !== 'anthropic' && type !== 'openai') {
    throw new Error(`Unsupported provider type "${type}" for "${name}". Use anthropic, openai, or google.`);
  }
  const envCandidates = preset?.env || [];
  let apiKey =
    (runtime?.provider === name ? runtime.apiKey : undefined) ||
    process.env[`KODE_${envName(name)}_API_KEY`] ||
    resolveSecret(user.apiKey) ||
    envCandidates.map((key) => process.env[key]).find(Boolean) ||
    preset?.defaultKey;
  if (!apiKey && (preset?.needsKey ?? true)) apiKey = undefined;
  const models = normalizeModels([...(preset?.models || []), ...normalizeModels(user.models)]);
  const defaultModel = user.defaultModel || preset?.defaultModel || models[0]?.id || '';
  const headers = { ...(preset?.headers || {}), ...(user.headers || {}) };
  return {
    name,
    label: user.label || preset?.label || name,
    type,
    baseURL: String(baseURL).replace(/\/+$/, ''),
    apiKey,
    needsKey: preset?.needsKey ?? true,
    models,
    defaultModel,
    headers,
    contextWindow: user.contextWindow || preset?.contextWindow || 128000,
  };
}

export function parseModelRef(config, modelString) {
  const str = String(modelString || '').trim();
  if (!str) return { provider: config.provider, model: config.model };
  const slash = str.indexOf('/');
  if (slash > 0) {
    const candidate = str.slice(0, slash);
    if (PROVIDER_PRESETS[candidate] || config.providers?.[candidate]) {
      return { provider: candidate, model: str.slice(slash + 1) };
    }
  }
  return { provider: config.provider, model: str };
}

export function getModelInfo(config, provider, modelId = config.model) {
  const info = provider.models.find((entry) => entry.id === modelId);
  if (info) {
    return {
      ...info,
      contextWindow: info.contextWindow || provider.contextWindow || 128000,
      maxOutput: info.maxOutput || 8192,
    };
  }
  const userModel = (config.providers?.[provider.name]?.models || [])
    .map((entry) => (typeof entry === 'string' ? { id: entry } : entry))
    .find((entry) => entry.id === modelId);
  if (userModel) {
    return {
      ...userModel,
      contextWindow: userModel.contextWindow || provider.contextWindow || 128000,
      maxOutput: userModel.maxOutput || 8192,
    };
  }
  return {
    id: modelId,
    contextWindow: provider.contextWindow || 128000,
    maxOutput: Math.max(config.maxTokens || 8192, 8192),
    pricing: null,
    known: false,
  };
}

export function getPricing(config, providerName, modelId) {
  const overrides = config.pricing || {};
  let bestOverride = null;
  for (const [key, value] of Object.entries(overrides)) {
    const idx = key.indexOf(':');
    const provider = idx === -1 ? '*' : key.slice(0, idx);
    const prefix = idx === -1 ? key : key.slice(idx + 1);
    if ((provider === providerName || provider === '*') && modelId.startsWith(prefix)) {
      if (!bestOverride || prefix.length > bestOverride.prefix.length) bestOverride = { prefix, value };
    }
  }
  if (bestOverride) return bestOverride.value;
  const preset = PROVIDER_PRESETS[providerName];
  const candidates = [...(preset?.models || []), ...normalizeModels(config.providers?.[providerName]?.models)];
  let best = null;
  for (const item of candidates) {
    if ((modelId === item.id || modelId.startsWith(item.id)) && item.pricing) {
      if (!best || item.id.length > best.id.length) best = item;
    }
  }
  return best?.pricing || null;
}

export function estimateCost(config, providerName, modelId, usage) {
  const pricing = getPricing(config, providerName, modelId);
  if (!pricing) return null;
  const input = usage.input || 0;
  const output = usage.output || 0;
  const cacheRead = usage.cacheRead || 0;
  const cacheWrite = usage.cacheWrite || 0;
  const inRate = Number(pricing.input) || 0;
  const outRate = Number(pricing.output) || 0;
  const cacheReadRate = Number(pricing.cacheRead ?? inRate * 0.1) || 0;
  const cacheWriteRate = Number(pricing.cacheWrite ?? inRate * 1.25) || 0;
  return (input * inRate + output * outRate + cacheRead * cacheReadRate + cacheWrite * cacheWriteRate) / 1e6;
}

export function projectPaths(cwd) {
  const root = path.join(KODE_HOME, 'projects', sha1(path.resolve(cwd)).slice(0, 16));
  const sessions = path.join(root, 'sessions');
  const memory = path.join(root, 'memory');
  ensureDir(root, 0o700);
  ensureDir(sessions, 0o700);
  ensureDir(memory, 0o700);
  return {
    root,
    sessions,
    memory,
    history: path.join(root, 'history'),
  };
}

export function maskConfig(config) {
  const clone = structuredClone(config);
  delete clone.__runtime;
  for (const provider of Object.values(clone.providers || {})) {
    if (provider && typeof provider === 'object' && provider.apiKey) {
      provider.apiKey = maskSecret(resolveSecret(provider.apiKey) || provider.apiKey);
    }
  }
  return clone;
}

export function configSummary(config) {
  let provider;
  try {
    provider = resolveProvider(config);
  } catch (err) {
    return [`provider: ${config.provider} (invalid: ${err.message})`];
  }
  return [
    `provider: ${provider.name} (${provider.label})`,
    `model:    ${config.model}`,
    `base URL: ${provider.baseURL || '(unset)'}`,
    `api key:  ${provider.apiKey ? maskSecret(provider.apiKey) : '(not set)'}`,
    `config:   ${CONFIG_PATH}`,
  ];
}
