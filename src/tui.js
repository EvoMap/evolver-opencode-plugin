// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { evolverCommands } from './commands.js';
import { configOf } from './config.js';
import { pluginDiagnostics } from './diagnostics.js';
import { createDistiller } from './distiller.js';
import { installedEvolverVersion } from './engine-version.js';
import { helperCompletion, tuiSessions } from './helper-session.js';
import { createProxyClient } from './proxy.js';

// OpenCode's own slash commands are prompt templates the model answers. Only a TUI plugin can register a
// command that runs code of its own, so the /evolver-* commands live here and answer in a dialog; a command
// that takes text asks for it in a prompt dialog first, since a TUI command receives no arguments.

async function statusOf(proxyFetch, port, signal) {
  const [result, plugin] = await Promise.all([
    proxyFetch('GET', '/proxy/status', undefined, signal),
    pluginDiagnostics({ engineVersion: installedEvolverVersion, port }),
  ]);
  const proxy = result.ok ? { reachable: true, ...result.data } : { reachable: false, error: result.error };
  return { proxy, ...plugin };
}

async function searchOf(proxyFetch, text, signal) {
  const result = await proxyFetch('POST', '/asset/search', { text, limit: 5 }, signal);
  return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error };
}

function currentSessionId(api) {
  const route = api.route.current;
  return route?.name === 'session' ? route.params?.sessionID : undefined;
}

function showResult(api, command, { kind, text }) {
  const title = kind === 'error' ? `/${command.name} failed` : `/${command.name}`;
  api.ui.dialog.replace(() => api.ui.DialogAlert({ title, message: text, onConfirm: () => api.ui.dialog.clear() }));
}

async function runCommand(api, command, rawInput) {
  api.ui.toast({ variant: 'info', message: `Running /${command.name}…` });
  const context = { rawInput, sessionId: currentSessionId(api), cwd: api.state.path.directory, signal: api.lifecycle.signal };
  const result = await command.handler(context).catch((error) => ({ kind: 'error', text: String(error?.message ?? error) }));
  showResult(api, command, result);
}

function askThenRun(api, command) {
  api.ui.dialog.replace(() => api.ui.DialogPrompt({
    title: `/${command.name}`,
    placeholder: command.input.hint,
    onConfirm: (value) => {
      api.ui.dialog.clear();
      runCommand(api, command, value ?? '');
    },
    onCancel: () => api.ui.dialog.clear(),
  }));
}

export function paletteCommandOf(api, command) {
  return {
    name: `evomap.${command.name}`,
    title: `/${command.name}`,
    desc: command.description,
    category: 'Evolver',
    namespace: 'palette',
    slashName: command.name,
    run: () => (command.input ? askThenRun(api, command) : runCommand(api, command, '')),
  };
}

async function tui(api, options) {
  const config = configOf(options);
  const proxyFetch = createProxyClient({ port: config.proxyPort, timeoutMs: config.proxyTimeoutMs });
  const distiller = createDistiller({ proxyFetch, complete: helperCompletion(tuiSessions(api.client)) });
  const commands = evolverCommands({
    status: (signal) => statusOf(proxyFetch, config.proxyPort, signal),
    search: (text, signal) => searchOf(proxyFetch, text, signal),
    distillNow: (sessionId, focus) => distiller.distillSession(sessionId, focus),
  });
  api.keymap.registerLayer({ commands: commands.map((command) => paletteCommandOf(api, command)) });
}

export default { id: 'evomap.evolver', tui };
