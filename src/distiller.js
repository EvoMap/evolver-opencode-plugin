// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import {
  claimLeftoverCandidates, distillCandidate, dropCandidate, dueCandidates, isCurrentCandidate, settleCandidate,
} from './session-distill.js';

const DISTILL_TIMEOUT_MS = 120_000;

// The session's own model runs the distillation; a candidate stays on disk until distilled (or given up), and
// one whose session is over — ended with a failed try, or killed with its process — is claimed and retried by
// the next session that starts.
export function createDistiller({ proxyFetch, complete }) {
  const run = async ({ sessionId, candidate }, focus, cancel) => {
    const isCurrent = () => isCurrentCandidate(sessionId, candidate);
    const outcome = await distillCandidate({ proxyFetch, complete, candidate, focus, timeoutMs: DISTILL_TIMEOUT_MS, cancel, isCurrent });
    settleCandidate(sessionId, candidate, { sent: outcome.status === 'sent' });
    return outcome;
  };
  // One distillation per session at a time: a second request while the first runs shares its outcome.
  const inFlight = new Map();
  const once = (due, focus) => {
    if (!inFlight.has(due.sessionId)) {
      const controller = new AbortController();
      const outcome = run(due, focus, controller.signal).finally(() => inFlight.delete(due.sessionId));
      inFlight.set(due.sessionId, { outcome, controller });
    }
    return inFlight.get(due.sessionId).outcome;
  };
  return {
    async distillSession(sessionId, focus = '') {
      const [own] = dueCandidates({ sessionId });
      return own ? once(own, focus) : { status: 'nothing' };
    },
    distillLeftovers() {
      for (const due of claimLeftoverCandidates()) once(due).catch(() => {});
    },
    /** The session's turn no longer deserves a Gene: its candidate goes, and a distillation already running stops. */
    forget(sessionId) {
      dropCandidate(sessionId);
      inFlight.get(sessionId)?.controller.abort();
    },
  };
}
