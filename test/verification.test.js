import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkCommandOf, isVerificationCommand, verificationFailed, verificationInterrupted } from '../src/verification.js';

const output = (text, exit = 0) => ({ title: 'npm test', output: text, metadata: { exit, output: text } });

test('test, build, lint and type-check runs are verifications; other commands are not', () => {
  for (const command of ['npm test', 'pnpm run build', 'yarn lint', 'node --test test/*.test.js', 'npx vitest run', 'go test ./...',
    'cargo clippy', 'npx -p typescript tsc -p .', 'make', 'cd app && npm run typecheck']) {
    assert.equal(isVerificationCommand(command), true, command);
  }
  for (const command of ['ls -la', 'git status', 'cat package.json', 'npm install', 'echo test', 'node simulate.js']) {
    assert.equal(isVerificationCommand(command), false, command);
  }
});

test('a non-zero exit code fails the verification, and so does a run that was killed', () => {
  assert.equal(verificationFailed(output('', 1)), true);
  assert.equal(verificationFailed(output('', null)), true);
  assert.equal(verificationFailed(output('ℹ pass 3', 0)), false);
});

test('failure output fails it even when the exit code was zero, as through `| tail`', () => {
  assert.equal(verificationFailed(output('AssertionError: expected 1 to equal 2\n1 test failed')), true);
  assert.equal(verificationFailed(output('TypeError: cannot read properties of undefined')), true);
  assert.equal(verificationFailed(output("ℹ pass 0\nℹ fail 1\n\n✖ failing tests:\n\ntest at test:1:1\n✖ test (59.9ms)\n  'test failed'\n")), true);
});

test('a zero count beside a failure does not hide it', () => {
  assert.equal(verificationFailed(output('Tests: 1 failed, 0 errors')), true);
  assert.equal(verificationFailed(output('failures: 0, errors: 2 — test failed')), true);
});

test('a passing summary that counts zero failures passes', () => {
  assert.equal(verificationFailed(output('ℹ tests 78\nℹ pass 78\nℹ fail 0')), false);
  assert.equal(verificationFailed(output('Tests: 0 failed, 12 passed')), false);
  assert.equal(verificationFailed(output('failures: 0\nerrors: 0')), false);
  assert.equal(verificationFailed(output('✔ Validation passed')), false);
});

test('only a check run through bash counts', () => {
  assert.equal(checkCommandOf({ name: 'bash', arguments: { command: 'npm test' } }), 'npm test');
  assert.equal(checkCommandOf({ name: 'bash', arguments: { command: 'git status' } }), null);
  assert.equal(checkCommandOf({ name: 'read', arguments: { command: 'npm test' } }), null);
  assert.equal(checkCommandOf({ name: 'bash', arguments: {} }), null);
});

test('a check the person interrupted did not finish, while one killed by its timeout failed', () => {
  const interrupted = output('ℹ pass 2\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>', null);
  const timedOut = output('\n\n<shell_metadata>\nshell tool terminated command after exceeding timeout 120000 ms.\n</shell_metadata>', null);
  assert.equal(verificationInterrupted(interrupted), true);
  assert.equal(verificationInterrupted(timedOut), false);
  assert.equal(verificationFailed(timedOut), true);
  assert.equal(verificationInterrupted(output('User aborted the command', 1)), false);
});
