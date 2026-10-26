import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withQueued } from '../src/report-outbox.js';
import {
  correctionReportOf,
  deliverPending,
  deliveryOf,
  immediateReportOf,
  reportedReuseOf,
  retentionReportOf,
} from '../src/reuse.js';

const ASSET = { assetId: 'sha256:a', strategyText: '' };
const NOW = 1_800_000_000_000;

function ledgers({ hub = { ok: true, data: {} }, local = true } = {}) {
  const posts = [];
  const locals = [];
  const settled = [];
  return {
    posts,
    locals,
    proxyFetch: async (method, path, body) => {
      posts.push({ method, path, body });
      if (hub instanceof Error) throw hub;
      return hub;
    },
    get rejections() { return settled.filter((settlement) => settlement.verdict === 'rejected'); },
    settled,
    onSettled: (settlement) => { settled.push(settlement); },
    recordLocally: async (request) => {
      locals.push(request);
      if (local instanceof Error) throw local;
      return local;
    },
  };
}

const immediate = (overrides = {}) => immediateReportOf({ asset: ASSET, sessionId: 's1', turn: 4, reasonKind: 'completed', checks: [], applied: 'used', ...overrides });

test('a turn that ran no check still reports its injection, as tier none', () => {
  assert.deepEqual(immediate(), {
    asset_id: 'sha256:a',
    outcome: 'success',
    task_id: 'opencode:s1:4',
    reason: 'Injected by Evolver into OpenCode turn 4; applied: used; no check ran.',
    evidence: { tier: 'none', applied: 'used', aborted: false, stage: 'immediate' },
  });
  assert.equal(immediate({ reasonKind: 'error' }).outcome, 'failed');
});

test('a check the turn ran makes the report L1 and decides its outcome', () => {
  const passed = immediate({ checks: [{ command: 'npm test', failed: false }] });
  assert.equal(passed.outcome, 'success');
  assert.deepEqual(passed.evidence.check, { kind: 'test', passed: true, fail_then_pass: false });
  assert.equal(passed.evidence.tier, 'L1');

  const failed = immediate({ checks: [{ command: 'npx tsc -p .', failed: true }], applied: 'partial' });
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.evidence.check, { kind: 'typecheck', passed: false, fail_then_pass: false });
  assert.equal(failed.evidence.applied, 'partial');
});

test('the same check failing and then passing is recorded as such', () => {
  const report = immediate({
    checks: [{ command: 'npm test', failed: true }, { command: 'npm run lint', failed: false }, { command: 'npm test', failed: false }],
  });
  assert.deepEqual(report.evidence.check, { kind: 'test', passed: true, fail_then_pass: true });
  assert.match(report.reason, /last test passed after failing earlier/);
});

test('an interrupted turn says so', () => {
  const report = immediate({ reasonKind: 'aborted' });
  assert.equal(report.evidence.aborted, true);
  assert.equal(report.outcome, 'failed');
});

test('a report reveals no command, prompt or code', () => {
  const report = immediate({ checks: [{ command: 'API_KEY=hunter22 npm test -- secret/path.js', failed: false }] });
  assert.doesNotMatch(JSON.stringify(report), /hunter22|secret\/path|npm test/);
});

test('a correction or approval follow-up is L3 under the turn task id plus :correction', () => {
  const reuse = reportedReuseOf(immediate());
  assert.deepEqual(correctionReportOf(reuse, 'correction'), {
    asset_id: 'sha256:a',
    outcome: 'failed',
    task_id: 'opencode:s1:4:correction',
    reason: "The person's next prompt read as correction of the turn that reused this strategy.",
    evidence: { tier: 'L3', applied: 'used', stage: 'correction' },
  });
  assert.equal(correctionReportOf(reuse, 'praise').outcome, 'success');
  assert.equal(correctionReportOf(reuse, null), null);
});

test('kept or reverted edits are an L2 follow-up under :retention; anything else sends nothing', () => {
  const reuse = reportedReuseOf(immediate({ applied: 'partial' }));
  const kept = retentionReportOf(reuse, 'kept');
  assert.equal(kept.task_id, 'opencode:s1:4:retention');
  assert.equal(kept.outcome, 'success');
  assert.deepEqual(kept.evidence, { tier: 'L2', applied: 'partial', stage: 'retention' });
  assert.equal(retentionReportOf(reuse, 'reverted').outcome, 'failed');
  assert.equal(retentionReportOf(reuse, 'rewritten'), null);
  assert.equal(retentionReportOf(reuse, 'no_change'), null);
});

test('queued reports go to the Hub until one is taken, then never again', async () => {
  const report = immediate({ checks: [{ command: 'npm test', failed: false }] });
  const down = ledgers({ hub: { ok: false, error: 'down' } });
  const outbox = withQueued({}, [{ report, sessionId: 's1' }], NOW);
  const retried = await deliverPending(down, outbox, NOW);
  assert.equal(down.posts[0].path, '/asset/reuse-result');
  assert.deepEqual(down.posts[0].body, report);
  assert.equal(Object.values(retried)[0].sentAt, undefined);

  const up = ledgers();
  const sent = await deliverPending(up, withQueued(retried, [{ report, sessionId: 's1' }], NOW + 1), NOW + 1);
  assert.equal(up.posts.length, 1);
  assert.equal(Object.values(sent)[0].sentAt, NOW + 1);

  const after = ledgers();
  await deliverPending(after, sent, NOW + 2);
  assert.equal(after.posts.length, 0);
});

test('a Proxy that answers without recording does not count as delivered', async () => {
  const sinks = ledgers({ hub: { ok: true, data: { recorded: false } } });
  const outbox = await deliverPending(sinks, withQueued({}, [{ report: immediate(), sessionId: 's1' }], NOW), NOW);
  assert.equal(Object.values(outbox)[0].sentAt, undefined);
  assert.equal(Object.values(outbox)[0].attempts, 1);
});

test('evidence-bearing reports are recorded locally once; tier none never is', async () => {
  const sinks = ledgers({ hub: new Error('down') });
  const verified = immediate({ checks: [{ command: 'npm test', failed: true }] });
  const outbox = withQueued({}, [{ report: verified, sessionId: 's1' }, { report: immediate({ turn: 5 }), sessionId: 's1' }], NOW);
  await deliverPending(sinks, await deliverPending(sinks, outbox, NOW), NOW);
  assert.deepEqual(sinks.locals, [{ assetId: 'sha256:a', outcome: 'failed', sessionId: 's1' }]);
  assert.equal(sinks.posts.length, 4);
});

test('a report the Hub already holds counts as delivered and is not retried', async () => {
  const sinks = ledgers({ hub: { ok: true, data: { recorded: false, reason: 'duplicate_report' } } });
  const outbox = await deliverPending(sinks, withQueued({}, [{ report: immediate(), sessionId: 's1' }], NOW), NOW);
  assert.equal(Object.values(outbox)[0].sentAt, NOW);
});

for (const reason of ['daily_cap', 'same_owner', 'no_delivery_proof']) {
  test(`a report the Hub judged ineligible (${reason}) is delivered and not retried`, async () => {
    const sinks = ledgers({ hub: { ok: true, data: { recorded: true, eligible: false, reason } } });
    const outbox = await deliverPending(sinks, withQueued({}, [{ report: immediate(), sessionId: 's1' }], NOW), NOW);
    assert.equal(Object.values(outbox)[0].sentAt, NOW);
    await deliverPending(sinks, outbox, NOW + 1);
    assert.equal(sinks.posts.length, 1);
  });
}

const queuedOne = (report) => withQueued({}, [{ report, sessionId: 's1' }], NOW);
const verified = () => immediate({ checks: [{ command: 'npm test', failed: false }] });

for (const data of [
  { recorded: false, terminal: true, reason: 'evidence.tier: Invalid input', status: 400 },
  { recorded: false, reason: 'hub 400' },
  { recorded: false, reason: 'hub 422: unprocessable' },
]) {
  test(`a report the Hub refuses (${data.reason}) is settled, logged and never written locally`, async () => {
    const sinks = ledgers({ hub: { ok: true, data } });
    const outbox = await deliverPending(sinks, queuedOne(verified()), NOW);
    const [entry] = Object.values(outbox);
    assert.equal(entry.rejectedAt, NOW);
    assert.equal(entry.sentAt, undefined);
    assert.equal(entry.rejection.reason, data.reason);
    assert.deepEqual(sinks.locals, []);
    assert.deepEqual(sinks.rejections.map(({ taskId, assetId, reason }) => ({ taskId, assetId, reason })), [
      { taskId: 'opencode:s1:4', assetId: 'sha256:a', reason: data.reason },
    ]);

    await deliverPending(sinks, outbox, NOW + 1);
    assert.equal(sinks.posts.length, 1);
    assert.equal(sinks.rejections.length, 1);
  });
}

for (const hub of [
  { ok: true, data: { recorded: false, reason: 'hub 404' } },
  { ok: true, data: { recorded: false, reason: 'hub 500' } },
  { ok: true, data: { recorded: false, reason: 'hub 503' } },
  { ok: true, data: { recorded: false, reason: 'hub 429', status: 429 } },
  { ok: true, data: { recorded: false, reason: 'hub 401' } },
  { ok: false, error: 'timed out' },
  new Error('ECONNREFUSED'),
]) {
  test(`a failure that may pass later (${hub.data?.reason ?? hub.error ?? hub.message}) is retried`, async () => {
    const sinks = ledgers({ hub });
    const outbox = await deliverPending(sinks, queuedOne(verified()), NOW);
    assert.equal(Object.values(outbox)[0].rejectedAt, undefined);
    assert.equal(Object.values(outbox)[0].sentAt, undefined);
    await deliverPending(sinks, outbox, NOW + 1);
    assert.equal(sinks.posts.length, 2);
    assert.deepEqual(sinks.rejections, []);
  });
}

test('the status a newer Proxy passes through is kept with the rejection', () => {
  assert.deepEqual(deliveryOf({ ok: true, data: { recorded: false, terminal: true, reason: 'bad evidence', status: 400 } }), {
    verdict: 'rejected', reason: 'bad evidence', status: 400,
  });
  assert.deepEqual(deliveryOf({ ok: true, data: { recorded: true, eligible: false, reason: 'daily_cap' } }), {
    verdict: 'sent', receipt: { eligible: false, reason: 'daily_cap' },
  });
});

test('a reuse that cannot be judged is exposure only, without the unused penalty', () => {
  const report = immediate({ applied: 'unknown' });
  assert.deepEqual(report.evidence, { tier: 'none', applied: 'partial', aborted: false, stage: 'immediate' });
  assert.match(report.reason, /applied: unknown/);
  assert.equal(immediate({ applied: 'unknown', checks: [{ command: 'npm test', failed: false }] }).evidence.tier, 'none');
});

test('the Hub verdict on a delivered report is kept with it and passed on', async () => {
  const sinks = ledgers({ hub: { ok: true, data: { recorded: true, eligible: true, counted: true, weight: 0.6, asset_id: 'sha256:a', reuse_stats: {} } } });
  const outbox = await deliverPending(sinks, queuedOne(verified()), NOW);
  assert.deepEqual(Object.values(outbox)[0].receipt, { eligible: true, counted: true, weight: 0.6 });
  assert.deepEqual(sinks.settled, [{ taskId: 'opencode:s1:4', assetId: 'sha256:a', verdict: 'sent', receipt: { eligible: true, counted: true, weight: 0.6 } }]);
});

test('every report body holds exactly the fields the Hub contract names', () => {
  const reuse = reportedReuseOf(verified());
  for (const report of [verified(), correctionReportOf(reuse, 'correction'), retentionReportOf(reuse, 'kept')]) {
    assert.deepEqual(Object.keys(report).sort(), ['asset_id', 'evidence', 'outcome', 'reason', 'task_id']);
    assert.ok(Object.keys(report.evidence).every((key) => ['tier', 'applied', 'check', 'aborted', 'stage'].includes(key)));
  }
  assert.deepEqual(Object.keys(verified().evidence.check).sort(), ['fail_then_pass', 'kind', 'passed']);
});
