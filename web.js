import { resolveSecret } from '../config.js';
import { decodeEntities, extractTitle, htmlToText, stripTags, truncateText } from '../utils.js';
import { fail, ok } from './common.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) kode/0.1 Safari/537.36';
const cache = new Map();
const CACHE_TTL = 15 * 60 * 1000;

function withTimeout(signal, ms) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

export const webFetchTool = {
  name: 'WebFetch',
  description:
    'Fetch a URL and return readable text (HTML is converted to plain text). Useful for documentation and reference pages. Results are cached for 15 minutes. Only http(s) URLs are supported.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch.' },
    },
    required: ['url'],
  },
  async run(input, ctx) {
    const url = String(input?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return fail('WebFetch requires an http(s) URL.');
    const cached = cache.get(url);
    if (cached && Date.now() - cached.at < CACHE_TTL) {
      return ok(cached.text, { summary: `cached · ${cached.label}` });
    }
    const { signal, cleanup } = withTimeout(ctx.signal, 30000);
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain,application/json,*/*' },
        signal,
        redirect: 'follow',
      });
      if (!res.ok) return fail(`HTTP ${res.status} ${res.statusText} for ${url}`);
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('application/pdf')) {
        return fail('PDF responses are not supported. Download the file and convert it with a local tool.');
      }
      const contentLength = Number(res.headers.get('content-length') || 0);
      if (contentLength > 8 * 1024 * 1024) {
        return fail(`Response is too large (${Math.round(contentLength / 1024 / 1024)} MB).`);
      }
      const raw = await res.text();
      const title = contentType.includes('html') ? extractTitle(raw) : '';
      let text = contentType.includes('html') ? htmlToText(raw) : raw;
      if (!text.trim()) text = '(empty response)';
      text = truncateText(text, 120000);
      const header = `${url}${title ? `\nTitle: ${title}` : ''}\n\n`;
      const output = header + text;
      const label = title || `${Math.round(raw.length / 1024)} KB`;
      cache.set(url, { at: Date.now(), text: output, label });
      if (cache.size > 100) cache.delete(cache.keys().next().value);
      return ok(output, { summary: `${title || 'fetched'} · ${raw.length} bytes` });
    } catch (err) {
      if (err.name === 'AbortError') return fail('Request was interrupted or timed out.');
      return fail(`Fetch failed: ${err.message}`);
    } finally {
      cleanup();
    }
  },
};

async function braveSearch(query, key, signal) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`;
  const res = await fetch(url, {
    headers: { 'x-subscription-token': key, accept: 'application/json', 'user-agent': USER_AGENT },
    signal,
  });
  if (!res.ok) throw new Error(`Brave search HTTP ${res.status}`);
  const json = await res.json();
  const results = (json.web?.results || []).map((item) => ({
    title: stripTags(item.title || ''),
    url: item.url,
    snippet: stripTags(item.description || ''),
  }));
  return { provider: 'Brave', results };
}

async function searxngSearch(query, baseURL, signal) {
  const url = `${baseURL.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const json = await res.json();
  const results = (json.results || []).slice(0, 8).map((item) => ({
    title: stripTags(item.title || ''),
    url: item.url,
    snippet: stripTags(item.content || ''),
  }));
  return { provider: 'SearXNG', results };
}

function decodeDuckDuckGoUrl(href) {
  try {
    const url = href.startsWith('//') ? `https:${href}` : href;
    const parsed = new URL(url);
    const target = parsed.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : url;
  } catch {
    return href;
  }
}

async function duckDuckGoSearch(query, signal) {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.8',
    },
    signal,
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const html = await res.text();
  const results = [];
  const anchorRe = /<a\s([^>]*class="[^"]*result__a[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(html)) && results.length < 10) {
    const attrs = match[1];
    const href = attrs.match(/href="([^"]+)"/i)?.[1];
    if (!href) continue;
    results.push({
      title: stripTags(match[2]),
      url: decodeDuckDuckGoUrl(decodeEntities(href)),
      snippet: '',
    });
  }
  const snippetRe = /<(?:a|div)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/gi;
  let index = 0;
  while ((match = snippetRe.exec(html)) && index < results.length) {
    results[index].snippet = stripTags(match[1]);
    index++;
  }
  return { provider: 'DuckDuckGo', results: results.filter((item) => item.url) };
}

export const webSearchTool = {
  name: 'WebSearch',
  description:
    'Search the web for current information. Returns titles, URLs, and snippets. Use WebFetch to read a promising result. Supports Brave (BRAVE_API_KEY), SearXNG (webSearch.searxngBaseURL), or DuckDuckGo by default.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query.' },
    },
    required: ['query'],
  },
  async run(input, ctx) {
    const query = String(input?.query || '').trim();
    if (!query) return fail('WebSearch requires "query".');
    const settings = ctx.config?.webSearch || {};
    const provider = (settings.provider || 'auto').toLowerCase();
    const braveKey = resolveSecret(settings.braveApiKey) || process.env.BRAVE_API_KEY;
    const { signal, cleanup } = withTimeout(ctx.signal, 25000);
    try {
      let payload;
      if ((provider === 'brave' || provider === 'auto') && braveKey) {
        payload = await braveSearch(query, braveKey, signal);
      } else if (settings.searxngBaseURL && (provider === 'searxng' || provider === 'auto')) {
        payload = await searxngSearch(query, settings.searxngBaseURL, signal);
      } else if (provider === 'brave' && !braveKey) {
        return fail('Brave search is selected but no API key is configured. Set BRAVE_API_KEY or webSearch.braveApiKey.');
      } else {
        payload = await duckDuckGoSearch(query, signal);
      }
      if (!payload.results.length) {
        return fail(
          `No results from ${payload.provider}. The provider may be rate limiting. Configure Brave (BRAVE_API_KEY) or SearXNG for reliable search.`
        );
      }
      const text = payload.results
        .map(
          (item, index) =>
            `${index + 1}. ${item.title}\n   ${item.url}${item.snippet ? `\n   ${truncateText(item.snippet, 280)}` : ''}`
        )
        .join('\n\n');
      return ok(`Search: ${query}\nProvider: ${payload.provider}\n\n${truncateText(text, 30000)}`, {
        summary: `${payload.results.length} results · ${payload.provider}`,
        preview: text,
      });
    } catch (err) {
      if (err.name === 'AbortError') return fail('Search was interrupted or timed out.');
      return fail(`Search failed: ${err.message}`);
    } finally {
      cleanup();
    }
  },
};
