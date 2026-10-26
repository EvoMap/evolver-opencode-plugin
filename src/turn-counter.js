// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { statePath, updateState } from './state-file.js';

const COUNTER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const countersPath = () => statePath('opencode-turns.json');

const fresh = (counters, now) =>
  Object.fromEntries(Object.entries(counters).filter(([, counter]) => now - Number(counter?.atMs) <= COUNTER_TTL_MS));

/**
 * The next turn number of a session. OpenCode resumes a session under its own id in a later process, so the
 * counter outlives the process: restarting at 1 would repeat a task id the Hub already holds, which it drops
 * as a duplicate report. A counter goes a month after its session's last turn.
 */
export function nextTurn(sessionId, now = Date.now()) {
  let turn = 0;
  updateState(countersPath(), {}, (counters) => {
    turn = (Number(counters[sessionId]?.turn) || 0) + 1;
    return { ...fresh(counters, now), [sessionId]: { turn, atMs: now } };
  });
  return turn;
}
