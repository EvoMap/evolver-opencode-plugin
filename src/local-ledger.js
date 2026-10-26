// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HIT_EVENT = 'value.reuse_hit';
const OUTCOME_EVENT = 'value.reuse_outcome';
const MAX_TITLE_CHARS = 80;

// Keyed by path, not a single instance: the log lives under the home directory,
// and a process that sees a different one must not keep writing to the first.
const byPath = new Map();

const NPM_ROOT_TIMEOUT_MS = 5_000;

function globalNpmRoot() {
  return new Promise((resolve) => {
    execFile('npm', ['root', '-g'], { timeout: NPM_ROOT_TIMEOUT_MS, encoding: 'utf8', shell: process.platform === 'win32' },
      (error, stdout) => resolve(error ? null : stdout.trim() || null));
  });
}

// This plugin does not depend on evolver-core, whose native FFI module OpenCode
// would have to build at install. The evolver CLI that runs the Proxy ships it,
// and a reuse report only exists once that Proxy answered a recall, so the
// CLI's copy is the fallback.
async function importEvolverCore() {
  try {
    return await import('@evomap/evolver-core');
  } catch {
  }
  const npmRoot = await globalNpmRoot();
  if (!npmRoot) throw new Error('evolver-core not found');
  const fromCli = createRequire(join(npmRoot, '@evomap', 'evolver', 'package.json'));
  return import(pathToFileURL(fromCli.resolve('@evomap/evolver-core')).href);
}

function loadIngestor() {
  return importEvolverCore()
    .then(({ events }) => {
      const path = events.rootEventsPath();
      let ingestor = byPath.get(path);
      if (!ingestor) {
        ingestor = new events.Ingestor({ path });
        byPath.set(path, ingestor);
      }
      return ingestor;
    })
    .catch(() => null);
}

function cycleIdOf(sessionId) {
  return `opencode:${sessionId || 'unknown'}`;
}

// The verdict has to become a root_event to be worth anything: the actuator
// that re-orders candidates reads root_events, not the Hub, and a Hub without
// the route records nothing at all. Success and the negative verdicts ride
// different events by design -- the ledger derives savings from one and the
// keep/prune signal from the other.
export async function recordReuseLocally({ assetId, outcome, sessionId }) {
  if (!assetId || !outcome) return false;
  const ingestor = await loadIngestor();
  if (!ingestor) return false;

  const cycleId = cycleIdOf(sessionId);
  const success = outcome === 'success';
  try {
    await ingestor.ingest({
      type: success ? HIT_EVENT : OUTCOME_EVENT,
      human: {
        title: `opencode reuse ${outcome}`.slice(0, MAX_TITLE_CHARS),
        detail: `cycle ${cycleId}`,
      },
      payload: success ? { assetId, cycleId } : { assetId, cycleId, outcome },
    });
    return true;
  } catch {
    return false;
  }
}
