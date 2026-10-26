import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectSignals } from '../src/signals.js';

test('detects categories from prose', () => {
  assert.deepEqual(detectSignals('The request hit a timeout and the test failed'), [
    'log_error',
    'perf_bottleneck',
    'test_failure',
  ]);
});

test('skips comment and brace lines', () => {
  assert.deepEqual(detectSignals('// timeout\n# error:\n{ failed }'), []);
});

test('tolerates non-strings', () => {
  assert.deepEqual(detectSignals(undefined), []);
  assert.deepEqual(detectSignals(''), []);
});

test('frontmatter split yields a body with no leading blank line', async () => {
  const { splitFrontmatter } = await import('../src/frontmatter.js');
  const { fields, body } = splitFrontmatter('---\ndescription: hi\n---\n\nFirst line.\n\nSecond.\n');

  assert.equal(fields.description, 'hi');
  assert.equal(body, 'First line.\n\nSecond.');
});
