// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { execFile } from 'node:child_process';

import { MIN_EVOLVER_VERSION, isOlderThan } from './engine-version.js';

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const START_TIMEOUT_MS = 60 * 1000;
const ERROR_MAX_CHARS = 300;
const INSTALL_ARGS = ['install', '-g', '@evomap/evolver@latest'];

export function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true },
      (error, stdout, stderr) => resolve({ ok: !error, error: error ? String(stderr || error.message).trim().slice(-ERROR_MAX_CHARS) : null }));
  });
}

async function installLatest({ probeVersion, run }, previous) {
  const installed = await run('npm', INSTALL_ARGS, INSTALL_TIMEOUT_MS);
  const version = installed.ok ? await probeVersion() : null;
  if (!version || isOlderThan(version, MIN_EVOLVER_VERSION)) {
    return { status: 'install_failed', previous, version, error: installed.error ?? `npm installed ${version ?? 'no evolver on PATH'}` };
  }
  const started = await run('evolver', ['lifecycle', previous ? 'restart' : 'start'], START_TIMEOUT_MS);
  return { status: previous ? 'upgraded' : 'installed', previous, version, ...(!started.ok && { startError: started.error }) };
}

export async function prepareEngine({ probeVersion, isProxyReachable, run = runCommand }) {
  const version = await probeVersion();
  if (!version || isOlderThan(version, MIN_EVOLVER_VERSION)) return installLatest({ probeVersion, run }, version);
  if (await isProxyReachable()) return { status: 'ready', version };
  const started = await run('evolver', ['lifecycle', 'start'], START_TIMEOUT_MS);
  return started.ok ? { status: 'started', version } : { status: 'start_failed', version, error: started.error };
}

const MANUAL_INSTALL = 'Run `npm install -g @evomap/evolver@latest`, then `evolver lifecycle start`.';

function startPhrase(outcome, verb) {
  return outcome.startError
    ? `, but its Proxy did not start (${outcome.startError}); run \`evolver lifecycle start\`.`
    : ` and ${verb} its Proxy.`;
}

export function setupNoticeText(outcome) {
  switch (outcome.status) {
    case 'installed':
      return `[Evolver] Evolver was not installed, so this plugin installed ${outcome.version}${startPhrase(outcome, 'started')}`;
    case 'upgraded':
      return `[Evolver] Evolver ${outcome.previous} is older than the ${MIN_EVOLVER_VERSION} network recall needs, so this plugin `
        + `upgraded it to ${outcome.version}${startPhrase(outcome, 'restarted')}`;
    case 'started':
      return `[Evolver] The Evolver Proxy was not running, so this plugin started it (Evolver ${outcome.version}).`;
    case 'install_failed':
      return `[Evolver] ${outcome.previous ? `Evolver ${outcome.previous} is older than ${MIN_EVOLVER_VERSION}` : 'Evolver is not installed'} `
        + `and installing the latest release failed (${outcome.error}). ${MANUAL_INSTALL} Local memory keeps working meanwhile.`;
    case 'start_failed':
      return `[Evolver] The Evolver Proxy is not running and \`evolver lifecycle start\` failed (${outcome.error}). `
        + 'Network recall and reuse reports wait until it runs.';
    default:
      return null;
  }
}
