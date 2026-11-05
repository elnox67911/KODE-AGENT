import { spawn } from 'node:child_process';
import { firstLine, formatDuration, stripAnsi, truncateText } from '../utils.js';
import { fail, ok } from './common.js';

const MAX_BUFFER = 2 * 1024 * 1024;
const jobs = new Map();
let nextShell = 1;

process.once('exit', () => {
  for (const job of jobs.values()) {
    if (job.status === 'running') killTree(job.child, 'SIGKILL');
  }
});

function childEnv(ctx) {
  return {
    ...process.env,
    KODE_AGENT: 'kode',
    KODE_SESSION_ID: ctx.session?.id || '',
    KODE_CWD: ctx.cwd,
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: process.env.KODE_KEEP_COLOR ? process.env.NO_COLOR : '1',
  };
}

function killTree(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

function combinedOutput(stdout, stderr) {
  let output = stripAnsi(stdout);
  const err = stripAnsi(stderr);
  if (err) output += `${output ? '\n' : ''}[stderr]\n${err}`;
  return output;
}

function runForeground(command, timeout, ctx) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(command, {
        shell: true,
        cwd: ctx.cwd,
        env: childEnv(ctx),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      resolve(fail(`Failed to start command: ${err.message}`));
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), 2000).unref?.();
    }, timeout);
    timer.unref?.();

    const onAbort = () => {
      aborted = true;
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), 1000).unref?.();
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code, extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      const elapsed = formatDuration(Date.now() - startedAt);
      let output = combinedOutput(stdout, stderr);
      if (extra) output = `${output}${output ? '\n' : ''}${extra}`;
      if (!output.trim()) output = '(no output)';
      output = truncateText(output, 30000);
      if (timedOut) output = `${output}\n\n[command timed out after ${timeout}ms]`;
      else if (aborted) output = `${output}\n\n[command interrupted]`;
      else if (code !== 0) output = `${output}\n\n[exit code: ${code}]`;

      const summary = timedOut
        ? `timed out after ${elapsed}`
        : aborted
          ? 'interrupted'
          : code === 0
            ? `${firstLine(output, 90) || 'completed'} · ${elapsed}`
            : `exit ${code}${firstLine(output, 60) ? ` · ${firstLine(output, 60)}` : ''}`;

      resolve({
        output,
        isError: timedOut || aborted || code !== 0,
        meta: { summary, preview: truncateText(output, 5000) },
      });
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      stderr += `\n${err.message}`;
      finish(1);
    });
    child.on('close', (code, signal) => finish(code ?? (signal ? 1 : 0)));
  });
}

function startBackground(command, ctx) {
  const id = `bash_${nextShell++}`;
  let child;
  try {
    child = spawn(command, {
      shell: true,
      cwd: ctx.cwd,
      env: childEnv(ctx),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
  } catch (err) {
    return fail(`Failed to start command: ${err.message}`);
  }
  const job = {
    id,
    command,
    child,
    output: '',
    cursor: 0,
    status: 'running',
    exitCode: null,
    startedAt: Date.now(),
  };
  jobs.set(id, job);
  const append = (chunk) => {
    job.output += stripAnsi(chunk);
    const overflow = job.output.length - MAX_BUFFER;
    if (overflow > 0) {
      job.output = job.output.slice(overflow);
      job.cursor = Math.max(0, job.cursor - overflow);
    }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', (err) => {
    append(`\n${err.message}\n`);
    job.status = 'error';
    job.exitCode = 1;
  });
  child.on('close', (code, signal) => {
    job.status = signal ? 'killed' : 'exited';
    job.exitCode = code;
    job.endedAt = Date.now();
  });
  return ok(
    `Started background shell ${id} (pid ${child.pid}).\nUse BashOutput with shell_id="${id}" to read output, and KillShell to stop it.`,
    { summary: `${id} running` }
  );
}

export const bashTool = {
  name: 'Bash',
  description:
    'Run a shell command in the working directory. Use for git, tests, builds, package managers. Prefer Read/Write/Edit/Glob/Grep for file operations. Interactive commands are not supported. Captures stdout and stderr, kills on timeout, and strips ANSI colors. Set run_in_background=true for long-running processes (dev servers, watchers), then use BashOutput and KillShell.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute.' },
      description: { type: 'string', description: 'Short description of what the command does.' },
      timeout: { type: 'integer', description: 'Timeout in milliseconds (default 120000, max 600000).' },
      run_in_background: { type: 'boolean', description: 'Start a background shell and return immediately.' },
    },
    required: ['command'],
  },
  async run(input, ctx) {
    const command = String(input?.command || '').trim();
    if (!command) return fail('Bash requires "command".');
    if (input.run_in_background) return startBackground(command, ctx);
    const timeout = Math.min(Math.max(1000, Number(input.timeout) || 120000), 600000);
    return runForeground(command, timeout, ctx);
  },
};

export const bashOutputTool = {
  name: 'BashOutput',
  description: 'Read new output from a background shell started with Bash run_in_background=true.',
  inputSchema: {
    type: 'object',
    properties: {
      shell_id: { type: 'string', description: 'Background shell id, e.g. "bash_1".' },
    },
    required: ['shell_id'],
  },
  async run(input) {
    const job = jobs.get(String(input?.shell_id || ''));
    if (!job) return fail(`Unknown background shell: ${input?.shell_id || '(missing)'}`);
    const newOutput = job.output.slice(job.cursor);
    job.cursor = job.output.length;
    const status =
      job.status === 'running'
        ? 'running'
        : `${job.status}${job.exitCode != null ? ` (exit ${job.exitCode})` : ''}`;
    const output = newOutput || '(no new output)';
    return ok(`${output}\n\n[status: ${status}]`, {
      summary: `${job.id} · ${status}`,
      preview: truncateText(newOutput, 5000),
    });
  },
};

export const killShellTool = {
  name: 'KillShell',
  description: 'Stop a background shell started with Bash run_in_background=true.',
  inputSchema: {
    type: 'object',
    properties: {
      shell_id: { type: 'string', description: 'Background shell id, e.g. "bash_1".' },
    },
    required: ['shell_id'],
  },
  async run(input) {
    const job = jobs.get(String(input?.shell_id || ''));
    if (!job) return fail(`Unknown background shell: ${input?.shell_id || '(missing)'}`);
    if (job.status !== 'running') return ok(`Shell ${job.id} is already ${job.status}.`, { summary: job.status });
    killTree(job.child, 'SIGTERM');
    job.status = 'killed';
    return ok(`Killed background shell ${job.id}.`, { summary: 'killed' });
  },
};

export const listBackgroundShells = () => [...jobs.values()];
