import { saveConfig, resolveProvider, resolveSecret, getModelInfo, PROVIDER_PRESETS, PROVIDER_ORDER, CONFIG_PATH } from './config.js';
import { maskSecret } from './utils.js';

const KEY_HELP = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  google: 'https://aistudio.google.com/apikey',
  openrouter: 'https://openrouter.ai/keys',
  groq: 'https://console.groq.com/keys',
  deepseek: 'https://platform.deepseek.com/api_keys',
  xai: 'https://console.x.ai',
  mistral: 'https://console.mistral.ai/api-keys',
  together: 'https://api.together.ai/settings/api-keys',
};

function pickValue(choice) {
  if (choice == null) return null;
  return typeof choice === 'object' ? choice.value ?? choice.label : choice;
}

function isBlank(value) {
  return value == null || !String(value).trim();
}

export async function runSetup({ ui, prompter, config }) {
  if (!prompter || ui.mode !== 'interactive') {
    throw new Error('Setup needs an interactive terminal. You can also edit the config file directly.');
  }
  ui.line('');
  ui.line(ui.bold('kode setup'));
  ui.line(ui.dim('Bring your own key. Credentials are stored locally in your kode config (mode 600).'));
  ui.line('');

  const providerOptions = PROVIDER_ORDER.map((name) => {
    const preset = PROVIDER_PRESETS[name];
    const saved = config.providers?.[name]?.apiKey ? ' · key saved' : '';
    return {
      label: preset.label,
      description: `${name}${saved}${preset.needsKey === false ? ' · no key needed' : ''}`,
      value: name,
    };
  });

  const currentIndex = Math.max(
    0,
    providerOptions.findIndex((option) => option.value === config.provider)
  );
  const providerChoice = await prompter.choose('Choose a provider:', providerOptions, {
    defaultIndex: currentIndex,
    allowCustom: true,
  });
  if (providerChoice === null) throw new Error('Setup cancelled.');
  const providerName = String(pickValue(providerChoice) || '').trim();
  if (!providerName) throw new Error('No provider selected.');

  const preset = PROVIDER_PRESETS[providerName];
  const userEntry = config.providers?.[providerName] || {};
  let baseURL = userEntry.baseURL || preset?.baseURL || '';
  if (!preset) {
    ui.line('');
    ui.warn(`"${providerName}" is not a built-in provider. It will be treated as an OpenAI-compatible endpoint.`);
    const answer = await prompter.askLine('Base URL (e.g. https://api.example.com/v1): ');
    if (isBlank(answer)) throw new Error('A base URL is required for a custom provider.');
    baseURL = String(answer).trim();
  } else if (providerName === 'custom' || !baseURL) {
    const answer = await prompter.askLine(`Base URL [${baseURL || 'none'}]: `);
    if (!isBlank(answer)) baseURL = String(answer).trim();
    if (!baseURL) throw new Error('A base URL is required.');
  }

  const needsKey = preset?.needsKey ?? true;
  const existing =
    resolveSecret(config.providers?.[providerName]?.apiKey) ||
    (preset?.env || []).map((name) => process.env[name]).find(Boolean) ||
    preset?.defaultKey;
  let apiKey = existing;
  if (needsKey) {
    ui.line('');
    if (KEY_HELP[providerName]) ui.line(ui.dim(`Get a key: ${KEY_HELP[providerName]}`));
    if (existing) ui.line(ui.dim(`Current key: ${maskSecret(existing)} (from config or environment)`));
    const typed = await prompter.askSecret(
      existing ? 'API key (hidden, press Enter to keep current): ' : 'API key (hidden): '
    );
    if (!isBlank(typed)) apiKey = String(typed).trim();
    if (!apiKey) throw new Error('No API key provided.');
  } else {
    apiKey = apiKey || preset?.defaultKey;
    ui.line(ui.dim('This provider runs locally and does not require an API key.'));
  }

  const normalized = resolveProvider(
    {
      ...config,
      provider: providerName,
      providers: {
        ...(config.providers || {}),
        [providerName]: {
          ...(config.providers?.[providerName] || {}),
          ...(baseURL ? { baseURL } : {}),
          ...(apiKey ? { apiKey } : {}),
          ...(preset ? {} : { type: 'openai' }),
        },
      },
    },
    providerName
  );
  const models = normalized.models || [];
  let model = models.some((entry) => entry.id === config.model) && providerName === config.provider
    ? config.model
    : normalized.defaultModel || '';
  if (models.length) {
    const modelOptions = models.slice(0, 14).map((entry) => ({
      label: entry.id,
      description: entry.contextWindow ? `context ${entry.contextWindow.toLocaleString()}` : '',
      value: entry.id,
    }));
    const choice = await prompter.choose('Choose a default model:', modelOptions, {
      defaultIndex: Math.max(0, modelOptions.findIndex((option) => option.value === model)),
      allowCustom: true,
    });
    model = String(pickValue(choice) || model).trim();
  }
  if (!model) {
    const answer = await prompter.askLine('Model id: ');
    if (isBlank(answer)) throw new Error('A model id is required.');
    model = String(answer).trim();
  }

  config.provider = providerName;
  config.model = model;
  config.providers = config.providers || {};
  config.providers[providerName] = {
    ...(config.providers[providerName] || {}),
    ...(baseURL ? { baseURL } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(preset ? {} : { type: 'openai' }),
  };
  saveConfig(config);

  const modelInfo = getModelInfo(config, normalized, model);
  ui.line('');
  ui.success(`Saved: ${normalized.label} / ${model}`);
  ui.line(ui.dim(`Config: ${CONFIG_PATH} (chmod 600)`));
  ui.line(
    ui.dim(
      'Tip: instead of storing keys in the config file, set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.'
    )
  );
  ui.line('');
  return { provider: normalized, modelInfo };
}
