import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createReportQueue } from '../src/report-queue.js';
import { readState, statePath } from '../src/state-file.js';
import { freshHome } from './support/host.js';

const reportOf = (taskId) => ({ task_id: taskId, asset_id: 'sha256:a', outcome: 'success', reason: 'r', evidence: { tier: 'none', applied: 'used', stage: 'immediate' } });

test('a report is in the outbox as soon as it is handed over, while an earlier delivery still runs', async (t) => {
  t.after(freshHome('evolver-queue-'));
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const proxyFetch = async () => {
    calls += 1;
    if (calls === 1) await held;
    return { ok: true, data: { recorded: true } };
  };
  const deliver = createReportQueue({ proxyFetch, recordLocally: async () => {}, onSettled: () => {} });
  const first = deliver([{ report: reportOf('opencode:s:1'), sessionId: 's' }]);
  deliver([{ report: reportOf('opencode:s:2'), sessionId: 's' }]);

  const outbox = readState(statePath('opencode-reports-outbox.json'), {});
  assert.deepEqual(Object.values(outbox).map((entry) => entry.report.task_id).sort(), ['opencode:s:1', 'opencode:s:2']);
  release();
  await first;
  assert.equal(calls, 2);
});
