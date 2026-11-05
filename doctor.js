import fs from 'node:fs';
import path from 'node:path';
import { maskSecret, formatBytes } from './utils.js';
import { fetchJSON } from './providers/http.js';
import { CONFIG_PATH, KODE_HOME, VERSION, projectPaths } from './config.js';
import { listSessions } from './session.js';
import { discoverSkills } from './skills.js';
import { discoverCommands } from './custom-commands.js';
import { discoverInstructionFiles } from './memory.js';

function check(ok, label, detail = '') {
  return { ok, label, detail };
}

async function checkEndpoint(provider, timeoutMs) {
  if (!provider.baseURL) return check(false, 'Endpoint', 'base URL is not set');
  const headers = { ...provider.headers };
  let url = `${provider.baseURL}/models`;
  if (provider.type === 'anthropic') {
    url = `${provider.baseURL}/v1/models`;
    headers['x-api-key'] = provider.apiKey || '';
    headers['anthropic-version'] = '2023-06-01';
  } else if (provider.type === 'google') {
    headers['x-goog-api-key'] = provider.apiKey || '';
  } else {
    headers.authorization = `Bearer ${provider.apiKey || ''}`;
  }
  try {
    const json = await fetchJSON(url, { headers, timeoutMs });
    const count = Array.isArray(json?.data)
      ? json.data.length
      : Array.isArray(json?.models)
        ? json.models.length
        : null;
    return check(true, 'Endpoint reachable', `${url}${count != null ? ` · ${count} models` : ''}`);
  } catch (err) {
    return check(false, 'Endpoint check', `${url} — ${err.message}${err.status ? ` (HTTP ${err.status})` : ''}`);
  }
}

export async function runDoctor({ config, provider, cwd, network = true, timeoutMs = 8000 }) {
  const results = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  results.push(check(nodeMajor >= 18, 'Node.js', `v${process.versions.node}${nodeMajor >= 18 ? '' : ' (need >= 18)'}`));
  results.push(check(fs.existsSync(CONFIG_PATH), 'Config file', CONFIG_PATH));
  try {
    const stat = fs.statSync(CONFIG_PATH);
    const mode = (stat.mode & 0o777).toString(8);
    results.push(check((stat.mode & 0o077) === 0, 'Config permissions', `${mode}${(stat.mode & 0o077) === 0 ? '' : ' (expected 600)'}`));
  } catch {
    results.push(check(false, 'Config permissions', 'config file is missing'));
  }
  results.push(check(Boolean(provider?.name), 'Provider', provider ? `${provider.name} (${provider.label})` : 'not resolved'));
  results.push(
    check(
      Boolean(provider?.baseURL),
      'Base URL',
      provider?.baseURL || 'not set (custom providers need baseURL)'
    )
  );
  const keyOk = provider?.needsKey === false || Boolean(provider?.apiKey);
  results.push(check(keyOk, 'API key', provider?.apiKey ? maskSecret(provider.apiKey) : provider?.needsKey === false ? 'not required' : 'missing — run kode setup'));
  results.push(check(Boolean(config.model), 'Model', config.model || 'not set'));

  try {
    fs.accessSync(cwd, fs.constants.W_OK);
    results.push(check(true, 'Working directory', `${cwd} (writable)`));
  } catch {
    results.push(check(false, 'Working directory', `${cwd} is not writable`));
  }

  if (network && provider?.baseURL) {
    results.push(await checkEndpoint(provider, timeoutMs));
  }

  const homeOk = fs.existsSync(KODE_HOME);
  results.push(check(homeOk, 'kode home', KODE_HOME));

  let mcpCount = 0;
  try {
    mcpCount = Object.keys(config.mcpServers || {}).length;
  } catch {}
  results.push(check(true, 'MCP servers', mcpCount ? `${mcpCount} configured` : 'none configured'));

  const skills = discoverSkills(cwd);
  results.push(check(true, 'Skills', skills.length ? skills.map((skill) => skill.name).join(', ') : 'none'));
  const commands = discoverCommands(cwd);
  results.push(check(true, 'Custom commands', commands.length ? commands.map((command) => `/${command.name}`).join(', ') : 'none'));
  const instructions = discoverInstructionFiles(cwd);
  results.push(check(true, 'Instruction files', instructions.length ? instructions.join(', ') : 'none'));

  let sessions = [];
  try {
    sessions = listSessions(cwd, 1);
  } catch {}
  let sessionSize = 0;
  try {
    sessionSize = fs.readdirSync(projectPaths(cwd).sessions).reduce((sum, name) => {
      try {
        return sum + fs.statSync(path.join(projectPaths(cwd).sessions, name)).size;
      } catch {
        return sum;
      }
    }, 0);
  } catch {}
  results.push(check(true, 'Sessions', `${sessions.length ? '1+' : '0'} recent · ${formatBytes(sessionSize)} on disk`));

  const webProvider = config.webSearch?.provider || 'auto';
  const brave = process.env.BRAVE_API_KEY;
  results.push(
    check(
      true,
      'Web search',
      brave ? `Brave (BRAVE_API_KEY set)` : config.webSearch?.searxngBaseURL ? `SearXNG ${config.webSearch.searxngBaseURL}` : `${webProvider} · DuckDuckGo fallback (set BRAVE_API_KEY for reliability)`
    )
  );

  const fatal = results.filter(
    (result) => !result.ok && ['API key', 'Provider', 'Base URL', 'Model', 'Node.js'].includes(result.label)
  );
  return {
    version: VERSION,
    results,
    ok: fatal.length === 0,
    fatal,
  };
}

export function formatDoctor(report) {
  const lines = [`kode doctor · v${report.version}`, ''];
  for (const result of report.results) {
    const mark = result.ok ? '✓' : '✗';
    const detail = result.detail ? `  ${result.detail}` : '';
    lines.push(`${mark} ${result.label}${detail}`);
  }
  lines.push('');
  lines.push(report.ok ? 'Configuration looks usable.' : 'Fix the failing items above, then run kode setup or edit the config file.');
  return lines.join('\n');
}
