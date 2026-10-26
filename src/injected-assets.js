// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import fs from 'node:fs';
import path from 'node:path';

import { ownerIsGone } from './process-owner.js';
import { hashedName, readState, removeState, statePath, updateState } from './state-file.js';

const ENTRY_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

function pruned(ledger, now) {
  return Object.fromEntries(Object.entries(ledger ?? {}).filter(([, entry]) => {
    const at = Number(entry?.injectedAt);
    return Number.isFinite(at) && now - at <= ENTRY_PRUNE_MS;
  }));
}

/**
 * Every entry in a ledger belongs to the session it is named after, so each injection also stamps the
 * entries already there with the live owner: an entry written before this version, or by the process a
 * resumed session ran in, would otherwise read as an unclaimable or orphaned one.
 */
const owned = (ledger, sessionId, pid) =>
  Object.fromEntries(Object.entries(ledger).map(([id, entry]) => [id, { ...entry, sessionId, pid }]));

export function withInjected(ledger, assetId, { turn, strategyText, sessionId, pid }, now) {
  const kept = owned(pruned(ledger, now), sessionId, pid);
  if (kept[assetId]) return kept;
  return { ...kept, [assetId]: { turn, injectedAt: now, strategyText, sessionId, pid } };
}

export function unreportedOf(ledger, turn) {
  return Object.entries(ledger ?? {})
    .filter(([, entry]) => !entry?.reportedAt && Number(entry?.turn) <= turn)
    .map(([assetId, entry]) => ({ assetId, strategyText: entry.strategyText ?? '', turn: entry.turn, sessionId: entry.sessionId }));
}

export function withReported(ledger, assetIds, now) {
  const kept = pruned(ledger, now);
  for (const assetId of assetIds) if (kept[assetId]) kept[assetId] = { ...kept[assetId], reportedAt: now };
  return kept;
}

const LEDGER_PREFIX = 'opencode-injected';
const ledgerPath = (sessionKey) => statePath(hashedName(LEDGER_PREFIX, sessionKey));

export function rememberInjected(sessionKey, assetId, injection, now = Date.now()) {
  if (!sessionKey) return;
  updateState(ledgerPath(sessionKey), {}, (ledger) =>
    withInjected(ledger, assetId, { ...injection, sessionId: sessionKey, pid: process.pid }, now));
}

/** The assets a session was already handed, so a session resumed in a later process is not handed them again. */
export function listedAssets(sessionKey) {
  return sessionKey ? Object.keys(readState(ledgerPath(sessionKey), {})) : [];
}

export function takeUnreported(sessionKey, turn, now = Date.now()) {
  if (!sessionKey) return [];
  let due = [];
  updateState(ledgerPath(sessionKey), {}, (ledger) => {
    due = unreportedOf(ledger, turn);
    return due.length > 0 ? withReported(ledger, due.map((asset) => asset.assetId), now) : undefined;
  });
  return due;
}

/**
 * Injections no turn end ever reported, from sessions whose OpenCode process is gone: a process killed mid-turn (a
 * harness timeout, a closed terminal) leaves them behind. They are taken, marked reported and returned for an
 * aborted report. A session that is merely idle keeps its open injections.
 */
export function takeOrphanedUnreported({ isGone = ownerIsGone, now = Date.now() } = {}) {
  const dir = path.dirname(statePath('x'));
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((file) => file.startsWith(`${LEDGER_PREFIX}-`) && file.endsWith('.json'));
  } catch {
    return [];
  }
  const orphaned = [];
  for (const file of files) {
    updateState(path.join(dir, file), {}, (ledger) => {
      const due = Object.entries(ledger)
        .filter(([, entry]) => !entry?.reportedAt && entry?.sessionId && isGone(entry.pid))
        .map(([assetId, entry]) => ({ assetId, strategyText: entry.strategyText ?? '', turn: entry.turn, sessionId: entry.sessionId }));
      if (due.length === 0) return undefined;
      orphaned.push(...due);
      return withReported(ledger, due.map((asset) => asset.assetId), now);
    });
  }
  return orphaned;
}

export function forgetSession(sessionKey) {
  if (sessionKey) removeState(ledgerPath(sessionKey));
}
