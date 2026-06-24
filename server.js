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

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_HOOKS_DIR = path.join(__dirname, 'hooks');
const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'multi_edit']);

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
  try {
    const result = spawnSync('node', [path.join(resolveHooksDir(), scriptName)], {
      cwd,
      input: JSON.stringify(payload || {}),
      encoding: 'utf8',
      timeout: timeoutMs,
      env: {
        ...process.env,
        OPENCODE_PROJECT_DIR: cwd,
      },
    });
    if (!result || !result.stdout) return {};
    try {
      return JSON.parse(result.stdout);
    } catch (_err) {
      return {};
    }
  } catch (_err) {
    return {};
  }
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

async function Evolver(ctx = {}) {
  return {
    event: async ({ event } = {}) => {
      if (!event || typeof event.type !== 'string') return;
      if (event.type === 'session.created') {
        runHook(
          'session-start.js',
          { session_id: sessionIdFromEvent(event), source: 'opencode' },
          3000,
          ctx
        );
        return;
      }
      if (event.type === 'session.idle') {
        runHook(
          'session-end.js',
          { session_id: sessionIdFromEvent(event), source: 'opencode' },
          8000,
          ctx
        );
      }
    },

    'tool.execute.after': async (input, output) => {
      if (!WRITE_TOOLS.has(normalizeToolName(input))) return;
      runHook(
        'signal-detect.js',
        {
          source: 'opencode',
          tool_input: toolArgs(input, output),
          tool_response: toolResult(output),
        },
        2000,
        ctx
      );
    },
  };
}

module.exports = { Evolver };
module.exports.default = Evolver;
module.exports._private = {
  resolveHooksDir,
  resolveWorkingDir,
  runHook,
  normalizeToolName,
  toolArgs,
  toolResult,
  WRITE_TOOLS,
};
