import assert from 'node:assert/strict';
import { test } from 'node:test';

import { unreportedOf, withInjected, withReported } from '../src/injected-assets.js';

const DAY = 24 * 60 * 60 * 1000;

test('an injection keeps its turn and strategy until reported', () => {
  const ledger = withInjected({}, 'sha256:a', { turn: 2, strategyText: '1. Step', sessionId: 'session-a' }, 0);
  assert.deepEqual(unreportedOf(ledger, 2), [{ assetId: 'sha256:a', strategyText: '1. Step', turn: 2, sessionId: 'session-a' }]);
  assert.deepEqual(unreportedOf(withReported(ledger, ['sha256:a'], 1), 2), []);
});

test('an asset is recorded once per session', () => {
  const first = withInjected({}, 'sha256:a', { turn: 1, strategyText: 'one' }, 0);
  assert.equal(withInjected(first, 'sha256:a', { turn: 3, strategyText: 'two' }, 1)['sha256:a'].turn, 1);
});

test('an entry written before this version is stamped with the live owner, so an orphan scan can claim it', () => {
  const legacy = { 'sha256:old': { turn: 1, injectedAt: 0, strategyText: 'one' } };
  const ledger = withInjected(legacy, 'sha256:new', { turn: 2, strategyText: 'two', sessionId: 'session-a', pid: 42 }, 1);
  assert.deepEqual(ledger['sha256:old'], { turn: 1, injectedAt: 0, strategyText: 'one', sessionId: 'session-a', pid: 42 });
});

test('a session that resumed in another process owns the entries it already had', () => {
  const first = withInjected({}, 'sha256:a', { turn: 1, strategyText: 'one', sessionId: 'session-a', pid: 1 }, 0);
  assert.equal(withInjected(first, 'sha256:a', { turn: 3, strategyText: 'two', sessionId: 'session-a', pid: 2 }, 1)['sha256:a'].pid, 2);
});

test('a strategy that lands after its turn ended is reported at the next turn end', () => {
  const ledger = withInjected({}, 'sha256:a', { turn: 2, strategyText: '' }, 0);
  assert.deepEqual(unreportedOf(ledger, 1), []);
  assert.equal(unreportedOf(ledger, 3).length, 1);
});

test('entries older than a week are pruned', () => {
  const ledger = withInjected({}, 'sha256:old', { turn: 1, strategyText: '' }, 0);
  assert.deepEqual(Object.keys(withInjected(ledger, 'sha256:new', { turn: 2, strategyText: '' }, 8 * DAY)), ['sha256:new']);
});
