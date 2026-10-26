import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { noticeDue, pendingClaimUrl } from '../src/onboarding.js';

const previousClaimPath = process.env.EVOLVER_CLAIM_URL_PATH;
const previousStateDir = process.env.EVOLVER_SESSION_STATE_DIR;

afterEach(() => {
  if (previousClaimPath === undefined) delete process.env.EVOLVER_CLAIM_URL_PATH;
  else process.env.EVOLVER_CLAIM_URL_PATH = previousClaimPath;
  if (previousStateDir === undefined) delete process.env.EVOLVER_SESSION_STATE_DIR;
  else process.env.EVOLVER_SESSION_STATE_DIR = previousStateDir;
});

test('only accepts HTTPS EvoMap claim links', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-claim-'));
  const claimPath = join(dir, 'claim_url');
  process.env.EVOLVER_CLAIM_URL_PATH = claimPath;

  writeFileSync(claimPath, 'https://evomap.ai/claim/node?token=secret\n');
  assert.match(pendingClaimUrl(), /^https:\/\/evomap\.ai\//);

  writeFileSync(claimPath, 'https://attacker.example/claim?token=secret\n');
  assert.equal(pendingClaimUrl(), null);

  writeFileSync(claimPath, 'http://evomap.ai/claim?token=secret\n');
  assert.equal(pendingClaimUrl(), null);
});

test('notices are throttled per value without persisting a claim secret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-state-'));
  process.env.EVOLVER_SESSION_STATE_DIR = dir;
  const url = 'https://evomap.ai/claim/node?token=secret';

  assert.equal(noticeDue(url, 10_000, 1_000), true);
  assert.equal(noticeDue(url, 10_000, 2_000), false);
  assert.equal(noticeDue(url, 10_000, 12_000), true);

  assert.equal(noticeDue('nongit:/tmp/elsewhere', 10_000, 2_000), true);
  assert.equal(noticeDue('nongit:/tmp/elsewhere', 10_000, 3_000), false);

  const state = readFileSync(join(dir, 'opencode-start-state.json'), 'utf8');
  assert.doesNotMatch(state, /token=secret/);
  assert.doesNotMatch(state, /tmp\/elsewhere/);
});
