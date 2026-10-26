// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { execFile } from 'node:child_process';

// 2.0.39 is the first Proxy whose `/asset/fetch` recalls by text; an older one
// answers every recall empty, so priming silently never injects anything.
export const MIN_EVOLVER_VERSION = '2.0.39';

const PROBE_TIMEOUT_MS = 5_000;

function versionParts(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''));
  return match ? match.slice(1, 4).map(Number) : null;
}

export function isOlderThan(version, minimum) {
  const have = versionParts(version);
  const need = versionParts(minimum);
  if (!have || !need) return false;
  for (let index = 0; index < 3; index += 1) {
    if (have[index] !== need[index]) return have[index] < need[index];
  }
  return false;
}

export function installedEvolverVersion() {
  return new Promise((resolve) => {
    execFile(
      'evolver',
      ['--version'],
      { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8', shell: process.platform === 'win32' },
      (error, stdout) => {
        const parts = error ? null : versionParts(stdout);
        resolve(parts ? parts.join('.') : null);
      },
    );
  });
}

