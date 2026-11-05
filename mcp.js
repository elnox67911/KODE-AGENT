import { spawn } from 'node:child_process';
import { VERSION } from './config.js';
import { sha1, truncateText } from './utils.js';

const PROTOCOL_VERSION = '2024-11-05';

function sanitizeToolName(server, tool) {
  const raw = `mcp__${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (raw.length <= 64) return raw;
  return `${raw.slice(0, 55)}_${sha1(raw).slice(0, 8)}`;
}

export class McpManager {
  constructor({ config, ui } = {}) {
    this.config = config || {};
    this.ui = ui;
    this.servers = new Map();
    this.toolMap = new Map();
    this.toolList = [];
  }

  async start() {
    const entries = Object.entries(this.config.mcpServers || {});
    if (!entries.length) return this;
    await Promise.all(entries.map(([name, spec]) => this.connect(name, spec)));
    this.refreshTools();
    return this;
  }

  async connect(name, spec) {
    const record = {
      name,
      spec: spec || {},
      child: null,
      pending: new Map(),
      nextId: 1,
      buffer: '',
      stderr: '',
      tools: [],
      status: 'starting',
      error: null,
      initialized: false,
    };
    this.servers.set(name, record);
    if (!spec?.command) {
      record.status = 'error';
      record.error = 'Missing "command" (only stdio MCP servers are supported)';
      return;
    }
    if (spec.url || spec.type === 'http' || spec.type === 'sse') {
      record.status = 'error';
      record.error = 'HTTP/SSE MCP transports are not supported. Use a stdio server command.';
      return;
    }
    try {
      const child = spawn(spec.command, spec.args || [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(spec.env || {}) },
        cwd: spec.cwd || undefined,
      });
      record.child = child;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this.handleStdout(record, chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        record.stderr = truncateText(`${record.stderr}${chunk}`, 8000);
        if (this.ui?.verbose) process.stderr.write(`[mcp:${name}] ${chunk}`);
      });
      child.on('error', (err) => {
        record.status = 'error';
        record.error = err.message;
        this.rejectAll(record, err);
      });
      child.on('exit', (code, signal) => {
        if (record.status === 'ready') record.status = 'exited';
        record.exit = { code, signal };
        this.rejectAll(record, new Error(`MCP server ${name} exited (${code ?? signal})`));
      });

      const init = await this.request(
        record,
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'kode', version: VERSION },
        },
        spec.startupTimeout || 20000
      );
      record.serverInfo = init?.serverInfo || null;
      this.notify(record, 'notifications/initialized', {});
      record.initialized = true;

      let cursor;
      let guard = 0;
      do {
        const result = await this.request(record, 'tools/list', cursor ? { cursor } : {}, spec.timeout || 20000);
        if (Array.isArray(result?.tools)) record.tools.push(...result.tools);
        cursor = result?.nextCursor;
        guard++;
      } while (cursor && guard < 20);
      record.status = 'ready';
    } catch (err) {
      record.status = 'error';
      record.error = err.message;
      try {
        record.child?.kill('SIGTERM');
      } catch {}
    }
  }

  handleStdout(record, chunk) {
    record.buffer += chunk;
    let newline;
    while ((newline = record.buffer.indexOf('\n')) !== -1) {
      const line = record.buffer.slice(0, newline).replace(/\r$/, '').trim();
      record.buffer = record.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        if (this.ui?.verbose) process.stderr.write(`[mcp:${record.name}] non-JSON output: ${line.slice(0, 200)}\n`);
        continue;
      }
      if (message.id != null && (message.result !== undefined || message.error !== undefined)) {
        const pending = record.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        record.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || 'MCP request failed'));
        else pending.resolve(message.result);
        continue;
      }
      if (message.id != null && message.method) {
        // Server-to-client request we don't implement.
        this.write(record, {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Method not supported by kode: ${message.method}` },
        });
        continue;
      }
      if (this.ui?.verbose && message.method) {
        process.stderr.write(`[mcp:${record.name}] notification ${message.method}\n`);
      }
    }
  }

  write(record, message) {
    if (!record.child?.stdin?.writable) throw new Error(`MCP server ${record.name} is not running`);
    record.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(record, method, params, timeout = 20000) {
    const id = record.nextId++;
    return new Promise((resolve, reject) => {
      if (!record.child?.stdin?.writable) {
        reject(new Error(`MCP server ${record.name} is not running`));
        return;
      }
      const timer = setTimeout(() => {
        record.pending.delete(id);
        reject(new Error(`MCP ${record.name}.${method} timed out after ${timeout}ms`));
      }, timeout);
      timer.unref?.();
      record.pending.set(id, { resolve, reject, timer });
      try {
        this.write(record, { jsonrpc: '2.0', id, method, params: params ?? {} });
      } catch (err) {
        clearTimeout(timer);
        record.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(record, method, params) {
    try {
      this.write(record, { jsonrpc: '2.0', method, params: params ?? {} });
    } catch {}
  }

  rejectAll(record, error) {
    for (const [, pending] of record.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    record.pending.clear();
  }

  refreshTools() {
    this.toolMap.clear();
    this.toolList = [];
    for (const [serverName, record] of this.servers) {
      if (record.status !== 'ready') continue;
      for (const tool of record.tools) {
        if (!tool?.name) continue;
        const exposed = sanitizeToolName(serverName, tool.name);
        if (this.toolMap.has(exposed)) continue;
        const wrapper = {
          name: exposed,
          description: tool.description || `MCP tool "${tool.name}" from ${serverName}`,
          inputSchema: tool.inputSchema || { type: 'object', properties: {} },
          mcp: { server: serverName, tool: tool.name, autoApprove: Boolean(record.spec.autoApprove) },
        };
        this.toolMap.set(exposed, wrapper);
        this.toolList.push(wrapper);
      }
    }
    return this.toolList;
  }

  getTools() {
    return this.toolList;
  }

  isAutoApproved(toolName) {
    return Boolean(this.toolMap.get(toolName)?.mcp?.autoApprove);
  }

  async callTool(toolName, args) {
    const wrapper = this.toolMap.get(toolName);
    if (!wrapper) throw new Error(`Unknown MCP tool: ${toolName}`);
    const record = this.servers.get(wrapper.mcp.server);
    if (!record) throw new Error(`MCP server not connected: ${wrapper.mcp.server}`);
    if (record.status !== 'ready') throw new Error(`MCP server ${record.name} is not ready (${record.status})`);
    const result = await this.request(
      record,
      'tools/call',
      { name: wrapper.mcp.tool, arguments: args || {} },
      record.spec.timeout || 120000
    );
    const parts = [];
    if (Array.isArray(result?.content)) {
      for (const item of result.content) {
        if (item.type === 'text') parts.push(item.text);
        else if (item.type === 'image') parts.push(`[image: ${item.mimeType || 'image'}, ${String(item.data || '').length} base64 chars]`);
        else if (item.type === 'resource') {
          if (item.resource?.text) parts.push(item.resource.text);
          else parts.push(`[resource: ${item.resource?.uri || 'unknown'}]`);
        } else parts.push(JSON.stringify(item));
      }
    }
    if (!parts.length && result?.structuredContent) parts.push(JSON.stringify(result.structuredContent, null, 2));
    return {
      output: truncateText(parts.join('\n') || '(no output)', 60000),
      isError: Boolean(result?.isError),
      meta: {
        summary: result?.isError ? 'tool returned an error' : `${parts.join('\n').split('\n').length} lines`,
      },
    };
  }

  summary() {
    return [...this.servers.values()].map((record) => ({
      name: record.name,
      status: record.status,
      error: record.error,
      tools: record.tools.length,
      serverInfo: record.serverInfo,
    }));
  }

  close() {
    for (const [, record] of this.servers) {
      try {
        record.child?.kill('SIGTERM');
      } catch {}
    }
  }
}
