import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  argumentsOf, candidateOf, claimLeftoverCandidates, closeCandidate, distillCandidate, distillPrompt, dueCandidates,
  isCurrentCandidate, rememberCandidate, settleCandidate, skipReason,
} from '../src/session-distill.js';
import { deadPid, freshHome } from './support/host.js';

const MODEL = { providerID: 'gateway', modelID: 'deepseek-flash' };
const GENE = { title: 'Retry uploads', summary: 'Retry a flaky upload with backoff.', strategy: '1. Measure. 2. Back off.', signals: ['retry'] };

function record(overrides = {}) {
  return { checks: [], commands: ['npm test'], paths: ['src/up.js'], edits: [], answer: 'Done: retries added.', ...overrides };
}

function fakeComplete(fixed = JSON.stringify(GENE), calls = []) {
  const complete = async (request) => {
    calls.push(request);
    await complete.hold;
    request.signal?.throwIfAborted();
    return { answer: complete.answer ?? fixed, usage: { input: 900, output: 120 } };
  };
  complete.calls = calls;
  return complete;
}

test('only a verified, completed turn that used tools and reused no strategy becomes a candidate', () => {
  assert.equal(skipReason('completed', record()), null);
  assert.equal(skipReason('aborted', record()), 'not_completed');
  assert.equal(skipReason('completed', record({ answer: '' })), 'no_answer');
  assert.equal(skipReason('completed', record({ checks: [{ command: 'npm test', failed: true }] })), 'failed_check');
  assert.equal(skipReason('completed', record({ commands: [] })), 'no_tool_use');
  assert.equal(skipReason('completed', record(), { reusedAsset: true }), 'asset_reused');
});

test('the prompt is a digest of the turn, never its whole history, and asks for no answer values', () => {
  const candidate = candidateOf({ prompt: 'add a retry to the uploader', record: record({ checks: [{ command: 'npm test', failed: false }] }), model: MODEL, turn: 1 });
  const prompt = distillPrompt(candidate, 'the backoff');
  assert.match(prompt, /## Task\nadd a retry to the uploader/);
  assert.match(prompt, /- npm test/);
  assert.match(prompt, /- passed: npm test/);
  assert.match(prompt, /Focus on: the backoff/);
  assert.match(prompt, /Do not include the answer itself/);
});

test('a list the model wrote as one numbered paragraph becomes steps', () => {
  assert.deepEqual(argumentsOf(JSON.stringify(GENE)).strategy, ['Measure.', 'Back off.']);
  assert.equal(argumentsOf('no json here'), null);
  assert.equal(argumentsOf('{"title":"no summary"}'), null);
});

test('a candidate is distilled through the session model and sent to the Proxy with its own cost', async () => {
  const sent = [];
  const proxyFetch = async (method, path, body) => { sent.push({ path, body }); return { ok: true, data: { id: 'gene_x' } }; };
  const candidate = candidateOf({ prompt: 'add a retry', record: record(), model: MODEL, turn: 1 });
  const complete = fakeComplete();
  const outcome = await distillCandidate({ proxyFetch, complete, candidate, timeoutMs: 1_000 });

  assert.equal(outcome.status, 'sent');
  assert.deepEqual(complete.calls[0].model, MODEL);
  assert.equal(complete.calls[0].text, distillPrompt(candidate));
  assert.equal(sent[0].path, '/conversation/distill');
  assert.equal(sent[0].body.trigger, 'session_end');
  assert.equal(sent[0].body.persist, true);
  assert.equal(sent[0].body.publish, false);
  assert.equal(sent[0].body.platform, 'opencode');
  assert.deepEqual(sent[0].body.distill_usage, { input: 900, output: 120 });
  assert.equal((await distillCandidate({ proxyFetch, complete, candidate: { ...candidate, model: null }, timeoutMs: 1_000 })).status, 'no_model');
  assert.equal((await distillCandidate({ proxyFetch, candidate, timeoutMs: 1_000 })).status, 'no_model');
});

test('a candidate dropped or cancelled while the model answers is never sent to the Proxy', async (t) => {
  t.after(freshHome('evolver-distill-dropped-'));
  const sent = [];
  const proxyFetch = async (method, path) => { sent.push(path); return { ok: true }; };
  const candidate = candidateOf({ prompt: 'add a retry', record: record(), model: MODEL, turn: 1 });
  rememberCandidate('s', candidate);
  assert.equal(isCurrentCandidate('s', candidate), true);
  rememberCandidate('s', { ...candidate, at: candidate.at + 1 });
  assert.equal(isCurrentCandidate('s', candidate), false);

  const replaced = await distillCandidate({ proxyFetch, complete: fakeComplete(), candidate, timeoutMs: 1_000, isCurrent: () => isCurrentCandidate('s', candidate) });
  const controller = new AbortController();
  const complete = fakeComplete();
  complete.hold = new Promise((resolve) => setTimeout(resolve, 20));
  const cancelled = distillCandidate({ proxyFetch, complete, candidate, timeoutMs: 1_000, cancel: controller.signal });
  controller.abort();

  assert.equal(replaced.status, 'dropped');
  assert.equal((await cancelled).status, 'dropped');
  assert.deepEqual(sent, []);
});

test("a session's candidate is due to it; another session's only once that session is over", (t) => {
  t.after(freshHome('evolver-candidates-'));
  rememberCandidate('live', { pid: 111, at: 1 });
  rememberCandidate('killed', { pid: 222, at: 2 });
  rememberCandidate('ended', { pid: 111, at: 3 });
  closeCandidate('ended');
  const isGone = (pid) => pid === 222;
  assert.deepEqual(dueCandidates({ sessionId: 'live' }).map((due) => due.sessionId), ['live']);
  assert.deepEqual(claimLeftoverCandidates({ isGone, pid: 7 }).map((due) => due.sessionId), ['killed', 'ended']);
});

test('a leftover candidate is claimed by one process only, and again once the claim dies', (t) => {
  t.after(freshHome('evolver-claim-'));
  const isGone = (pid) => pid !== 111;
  rememberCandidate('killed', { pid: 222, at: 1 });

  assert.deepEqual(claimLeftoverCandidates({ isGone, pid: 111 }).map((due) => due.sessionId), ['killed']);
  assert.deepEqual(claimLeftoverCandidates({ isGone, pid: 333 }), [], 'a live claim is left alone');
  settleCandidate('killed', { at: 1 }, { sent: false });
  assert.deepEqual(claimLeftoverCandidates({ isGone, pid: 333 }).map((due) => due.candidate.attempts), [1], 'a failed try is claimable again');
});

test('a candidate leaves the disk only once distilled, or after three failed tries', (t) => {
  t.after(freshHome('evolver-settle-'));
  const candidate = { pid: process.pid, at: 5, attempts: 0 };
  rememberCandidate('s', candidate);
  settleCandidate('s', candidate, { sent: false });
  settleCandidate('s', candidate, { sent: false });
  assert.equal(dueCandidates({ sessionId: 's' })[0].candidate.attempts, 2, 'kept for a retry');
  settleCandidate('s', candidate, { sent: false });
  assert.deepEqual(dueCandidates({ sessionId: 's' }), [], 'given up');

  rememberCandidate('s', candidate);
  rememberCandidate('s', { ...candidate, at: 9 });
  settleCandidate('s', candidate, { sent: true });
  assert.equal(dueCandidates({ sessionId: 's' })[0].candidate.at, 9, 'a newer candidate written meanwhile stays');
});

test('keys and tokens never reach the candidate, nor the prompt a manual focus writes', () => {
  const secret = 'sk-evomap-0123456789abcdef0123456789abcdef';
  const candidate = candidateOf({
    prompt: `use ${secret}`, model: MODEL, turn: 1,
    record: record({ commands: [`curl -H "Authorization: Bearer ${secret}" x`], answer: `done with ${secret}`, paths: [`keys/${secret}.pem`] }),
  });
  assert.doesNotMatch(JSON.stringify(candidate), new RegExp(secret));
  assert.doesNotMatch(distillPrompt(candidate, `Authorization: Bearer ${secret}`), new RegExp(secret));
});


test('an idle session keeps its open strategies: only a gone process counts as killed', async (t) => {
  t.after(freshHome('evolver-idle-'));
  const { takeOrphanedUnreported } = await import('../src/injected-assets.js');
  const { statePath, writeState, hashedName } = await import('../src/state-file.js');
  writeState(statePath(hashedName('opencode-injected', 'idle')), { 'sha256:a': { turn: 1, injectedAt: 0, strategyText: '', sessionId: 'idle', pid: process.pid } });
  writeState(statePath(hashedName('opencode-injected', 'old')), { 'sha256:b': { turn: 1, injectedAt: 0, strategyText: '', sessionId: 'old' } });
  assert.deepEqual(takeOrphanedUnreported(), []);
  writeState(statePath(hashedName('opencode-injected', 'gone')), { 'sha256:c': { turn: 2, injectedAt: 0, strategyText: '', sessionId: 'gone', pid: deadPid() } });
  assert.deepEqual(takeOrphanedUnreported().map((asset) => asset.assetId), ['sha256:c']);
  assert.deepEqual(takeOrphanedUnreported(), [], 'reported once');
});
