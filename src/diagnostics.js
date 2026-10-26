// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { readFileSync } from 'node:fs';
import os from 'node:os';

import { MIN_EVOLVER_VERSION, isOlderThan } from './engine-version.js';
import { STRATEGY_MAX_CHARS } from './prime.js';
import { describeProxyEndpoint } from './proxy.js';
import { REJECTED } from './report-outbox.js';
import { readState, statePath, updateState } from './state-file.js';

const PLUGIN_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const MAX_LOGGED_REPORTS = 10;

// The server plugin recalls and reports; the TUI plugin, which runs /evolver-status, may live in another
// thread or process, so what happened recently is kept in a state file rather than in memory.
const recentPath = () => statePath('opencode-recent.json');

export function createRecallLog(settings, now = () => Date.now()) {
  return {
    record(outcome, startedAt) {
      updateState(recentPath(), {}, (recent) => {
        const counts = { ...recent.recall?.counts };
        counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
        const last = { ...outcome, at: new Date(now()).toISOString(), duration_ms: now() - startedAt };
        return { ...recent, recall: { ...settings, last, counts } };
      });
    },
  };
}

const keepLast = (list, entry) => [...(list ?? []), entry].slice(-MAX_LOGGED_REPORTS);

export function createReportLog(now = () => Date.now()) {
  return {
    record({ verdict, taskId, assetId, receipt, reason, status }) {
      const entry = { at: new Date(now()).toISOString(), task_id: taskId, asset_id: assetId };
      updateState(recentPath(), {}, (recent) => {
        const reports = { delivered: recent.reuse_reports?.delivered ?? [], rejected: recent.reuse_reports?.rejected ?? [] };
        if (verdict === REJECTED) reports.rejected = keepLast(reports.rejected, { ...entry, reason, status });
        else reports.delivered = keepLast(reports.delivered, { ...entry, ...receipt });
        return { ...recent, reuse_reports: reports };
      });
    },
  };
}

export function recallSettingsOf(config) {
  return {
    enabled: config.assetPrimeEnabled !== false,
    wait_ms: config.assetPrimeWaitMs,
    timeout_ms: config.assetPrimeTimeoutMs,
    min_similarity: config.assetPrimeMinSimilarity,
    max_strategy_chars: STRATEGY_MAX_CHARS,
  };
}

function engineReport(pathVersion, runningVersion) {
  const effective = runningVersion ?? pathVersion;
  return {
    path_version: pathVersion,
    running_version: runningVersion,
    minimum_version: MIN_EVOLVER_VERSION,
    meets_minimum: effective ? !isOlderThan(effective, MIN_EVOLVER_VERSION) : null,
    path_differs_from_running: Boolean(pathVersion && runningVersion && pathVersion !== runningVersion),
  };
}

export async function pluginDiagnostics({ engineVersion, port }) {
  const endpoint = describeProxyEndpoint(port);
  const runningVersion = typeof endpoint.running_version === 'string' ? endpoint.running_version : null;
  const recent = readState(recentPath(), {});
  return {
    plugin: { name: 'evolver-opencode-plugin', version: PLUGIN_VERSION },
    runtime: { platform: process.platform, arch: process.arch, node: process.version, os_release: os.release() },
    proxy_endpoint: endpoint,
    engine: engineReport(await engineVersion(), runningVersion),
    recall: recent.recall ?? null,
    reuse_reports: recent.reuse_reports ?? { delivered: [], rejected: [] },
  };
}
