import { spawn } from 'node:child_process';
import { safeJsonParse, truncateText } from './utils.js';

function runHook(hook, event, payload, signal) {
  return new Promise((resolve) => {
    const command = typeof hook === 'string' ? hook : hook?.command;
    if (!command) {
      resolve({ code: 0, stdout: '', stderr: '', skipped: true });
      return;
    }
    const timeout = (typeof hook === 'object' && hook.timeout) || 20000;
    let child;
    try {
      child = spawn(command, {
        shell: true,
        env: {
          ...process.env,
          KODE_HOOK_EVENT: event,
          KODE_TOOL_NAME: payload.tool_name || '',
          KODE_CWD: payload.cwd || process.cwd(),
          KODE_SESSION_ID: payload.session_id || '',
          KODE_MODEL: payload.model || '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: 1, stdout: '', stderr: err.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {}
      finish(124);
    }, timeout);
    timer.unref?.();

    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {}
      finish(130);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    function finish(code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const out = truncateText(stdout, 20000);
      const err = truncateText(stderr, 10000);
      const json = out.trim().startsWith('{') ? safeJsonParse(out.trim(), null) : null;
      resolve({
        code,
        stdout: out,
        stderr: err,
        json,
        blocked: code === 2 || json?.decision === 'block' || json?.decision === 'deny',
        reason: json?.reason || err.trim() || '',
        allow: json?.decision === 'allow',
      });
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      stderr += String(err.message || err);
      finish(1);
    });
    child.on('close', (code) => finish(code ?? 0));
    try {
      child.stdin.end(JSON.stringify(payload));
    } catch {
      finish(1);
    }
  });
}

export async function runHooks(event, payload, config, { signal } = {}) {
  const groups = config.hooks?.[event];
  if (!Array.isArray(groups) || !groups.length) return [];
  const results = [];
  for (const hook of groups) {
    if (typeof hook === 'object' && hook?.matcher && payload.tool_name) {
      try {
        if (!new RegExp(hook.matcher).test(payload.tool_name)) continue;
      } catch {}
    }
    const result = await runHook(hook, event, payload, signal);
    results.push({ hook, ...result });
    if (result.blocked && (event === 'PreToolUse' || event === 'UserPromptSubmit')) break;
  }
  return results;
}

export function collectHookContext(results, cap = 12000) {
  const parts = [];
  for (const result of results) {
    if (result.skipped) continue;
    if (result.stdout?.trim()) parts.push(result.stdout.trim());
  }
  return truncateText(parts.join('\n\n'), cap);
}

export function preToolBlock(results) {
  const blocking = results.find((result) => result.blocked);
  if (!blocking) return null;
  return blocking.reason || 'Blocked by PreToolUse hook.';
}

export function preToolAllow(results) {
  return results.some((result) => result.allow);
}
