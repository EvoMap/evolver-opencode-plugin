// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap
//
// OpenCode server plugin entrypoint.
//
// OpenCode loads npm server plugins from package `main` / `exports["./server"]`
// and invokes exported plugin functions with a context object. This module
// bridges OpenCode events to the same clean-room Evolver hook scripts used by
// the Claude Code and Cursor plugins.

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_HOOKS_DIR = path.join(__dirname, 'hooks');
const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'multi_edit']);
const sessionStartContext = new Map();

function timeoutMs(envName, fallback) {
  const raw = Number.parseInt(process.env[envName] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function resolveHooksDir() {
  const override = process.env.EVOLVER_OPENCODE_HOOKS_DIR;
  return override && path.isAbsolute(override) ? override : DEFAULT_HOOKS_DIR;
}

function resolveWorkingDir(ctx) {
  const candidates = [
    ctx && ctx.worktree,
    ctx && ctx.directory,
    ctx && ctx.project && ctx.project.path,
    ctx && ctx.project && ctx.project.directory,
    process.cwd(),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch (_err) {
      // try the next candidate
    }
  }
  return process.cwd();
}

function runHook(scriptName, payload, timeoutMs, ctx) {
  const cwd = resolveWorkingDir(ctx);
  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let settled = false;

    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value || {});
    };

    try {
      child = spawn('node', [path.join(resolveHooksDir(), scriptName)], {
        cwd,
        env: {
          ...process.env,
          OPENCODE_PROJECT_DIR: cwd,
        },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (_err) {
      settle({});
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch (_err) {
        // best effort
      }
      settle({});
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      settle({});
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (!stdout) {
        settle({});
        return;
      }
      try {
        settle(JSON.parse(stdout));
      } catch (_err) {
        settle({});
      }
    });
    try {
      child.stdin.end(JSON.stringify(payload || {}));
    } catch (_err) {
      clearTimeout(timer);
      settle({});
    }
  });
}

function sessionIdFromEvent(event) {
  if (!event || typeof event !== 'object') return undefined;
  const props = event.properties || {};
  return (
    props.sessionID ||
    props.sessionId ||
    props.session_id ||
    (props.info && props.info.id)
  );
}

function sessionIdFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return undefined;
  const props = payload.properties || {};
  const session = payload.session || {};
  return (
    payload.sessionID ||
    payload.sessionId ||
    payload.session_id ||
    session.id ||
    session.sessionID ||
    props.sessionID ||
    props.sessionId ||
    props.session_id ||
    (props.info && props.info.id)
  );
}

function normalizeToolName(input) {
  if (!input || typeof input !== 'object') return '';
  const raw = input.tool || input.name || input.toolName || '';
  return String(raw).toLowerCase();
}

function toolArgs(input, output) {
  if (output && typeof output.args === 'object') return output.args;
  if (input && typeof input.args === 'object') return input.args;
  if (input && typeof input.input === 'object') return input.input;
  if (input && typeof input.parameters === 'object') return input.parameters;
  return {};
}

function toolResult(output) {
  if (!output || typeof output !== 'object') return {};
  return output.output || output.result || output.response || {};
}

function additionalContextFromHook(result) {
  if (!result || typeof result !== 'object') return '';
  if (typeof result.additionalContext === 'string') {
    return result.additionalContext;
  }
  const hookSpecific = result.hookSpecificOutput;
  if (
    hookSpecific &&
    typeof hookSpecific === 'object' &&
    typeof hookSpecific.additionalContext === 'string'
  ) {
    return hookSpecific.additionalContext;
  }
  return '';
}

function rememberSessionContext(sessionId, context) {
  if (!sessionId || !context) return;
  sessionStartContext.set(sessionId, context);
  while (sessionStartContext.size > 50) {
    const first = sessionStartContext.keys().next().value;
    sessionStartContext.delete(first);
  }
}

async function recallContext(sessionId, ctx) {
  if (sessionId && sessionStartContext.has(sessionId)) {
    return sessionStartContext.get(sessionId);
  }
  const result = await runHook(
    'session-start.js',
    { session_id: sessionId, source: 'opencode' },
    timeoutMs('EVOLVER_OPENCODE_SESSION_START_TIMEOUT_MS', 3000),
    ctx
  );
  const context = additionalContextFromHook(result);
  rememberSessionContext(sessionId, context);
  return context;
}

async function Evolver(ctx = {}) {
  return {
    event: async ({ event } = {}) => {
      if (!event || typeof event.type !== 'string') return;
      if (event.type === 'session.created') {
        const sessionId = sessionIdFromEvent(event);
        const result = await runHook(
          'session-start.js',
          { session_id: sessionId, source: 'opencode' },
          timeoutMs('EVOLVER_OPENCODE_SESSION_START_TIMEOUT_MS', 3000),
          ctx
        );
        rememberSessionContext(sessionId, additionalContextFromHook(result));
        return;
      }
      if (event.type === 'session.deleted') {
        await runHook(
          'session-end.js',
          { session_id: sessionIdFromEvent(event), source: 'opencode' },
          timeoutMs('EVOLVER_OPENCODE_SESSION_END_TIMEOUT_MS', 8000),
          ctx
        );
      }
    },

    'tool.execute.after': async (input, output) => {
      if (!WRITE_TOOLS.has(normalizeToolName(input))) return;
      await runHook(
        'signal-detect.js',
        {
          source: 'opencode',
          tool_input: toolArgs(input, output),
          tool_response: toolResult(output),
        },
        timeoutMs('EVOLVER_OPENCODE_SIGNAL_TIMEOUT_MS', 2000),
        ctx
      );
    },

    'experimental.session.compacting': async (input, output) => {
      const context = await recallContext(sessionIdFromPayload(input), ctx);
      if (!context) return;
      if (!output || typeof output !== 'object') return;
      if (!Array.isArray(output.context)) {
        output.context = [];
      }
      output.context.push(`## Evolver Memory\n\n${context}`);
    },
  };
}

module.exports = { Evolver };
module.exports.default = Evolver;
module.exports._private = {
  resolveHooksDir,
  resolveWorkingDir,
  runHook,
  timeoutMs,
  normalizeToolName,
  toolArgs,
  toolResult,
  sessionIdFromPayload,
  additionalContextFromHook,
  WRITE_TOOLS,
};
