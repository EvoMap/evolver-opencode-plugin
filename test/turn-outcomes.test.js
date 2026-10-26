import assert from 'node:assert/strict';
import { test } from 'node:test';

import { outcomeOfReason } from '../src/turn-outcomes.js';

test('every live turn ending has an outcome, but a synthesized one does not', () => {
  assert.equal(outcomeOfReason('completed'), 'success');
  for (const kind of ['error', 'aborted', 'blocked', 'max-tokens']) assert.equal(outcomeOfReason(kind), 'failed', kind);
  assert.equal(outcomeOfReason('interrupted'), null);
});
