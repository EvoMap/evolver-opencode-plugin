// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { withQueued } from './report-outbox.js';
import { deliverPending } from './reuse.js';
import { statePath, updateState } from './state-file.js';

const outboxPath = () => statePath('opencode-reports-outbox.json');

function attemptedEntries(before, after) {
  return Object.fromEntries(Object.entries(after).filter(([key, entry]) => before[key] !== entry));
}

/** Writes reports to the outbox without delivering them, for a moment too short to wait on the network. */
export function enqueueReports(queued, now = Date.now()) {
  return updateState(outboxPath(), {}, (outbox) => withQueued(outbox, queued, now));
}

// Reports reach the outbox when they are handed over, not when an earlier delivery has finished, so a
// process killed meanwhile loses none. Another OpenCode process may queue reports while this one is
// delivering, so the attempts are merged into the file as it stands afterwards, not over the snapshot
// that was delivered.
export function createReportQueue(ledgers, clock = () => Date.now()) {
  let work = Promise.resolve();
  return function deliver(queued = []) {
    enqueueReports(queued, clock());
    work = work.catch(() => {}).then(async () => {
      const now = clock();
      const outbox = enqueueReports([], now);
      const delivered = await deliverPending(ledgers, outbox, now);
      updateState(outboxPath(), {}, (latest) => ({ ...withQueued(latest, [], now), ...attemptedEntries(outbox, delivered) }));
    });
    return work;
  };
}
