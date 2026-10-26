// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { detectSignals } from './signals.js';

const VERIFICATION_COMMANDS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|type-check|check)\b/,
  /\bnode\s+--test\b/,
  /\b(?:jest|vitest|mocha|pytest|rspec|phpunit|tsc|eslint|ruff|mypy)\b/,
  /\bgo\s+(?:test|build|vet)\b/,
  /\bcargo\s+(?:test|build|check|clippy)\b/,
  /\bdotnet\s+(?:test|build)\b/,
  /\b(?:mvn|gradle|gradlew)\b/,
  /\bmake\b/,
];

const FAILURE_SIGNALS = new Set(['test_failure', 'log_error']);

// Summaries of a passing run still name failures by count ("0 failed",
// "failures: 0"); only those counts are dropped, so "1 failed, 0 errors"
// still reads as a failure.
const ZERO_COUNT = /\b0\s+(?:failed|failures?|errors?)\b|\b(?:failed|failures?|errors?)\s*[:=]\s*0\b/gi;

const SHELL_TOOL_NAMES = ['bash'];

export function isVerificationCommand(command) {
  return typeof command === 'string' && VERIFICATION_COMMANDS.some((pattern) => pattern.test(command));
}

const USER_ABORTED = 'User aborted the command';

/** A check the person interrupted never finished: it is not a failed one. */
export function verificationInterrupted(result) {
  return result?.metadata?.exit === null && String(result?.output ?? '').includes(USER_ABORTED);
}

// OpenCode's bash tool reports the command's own exit code (null once it was killed), but a failing command
// piped through `tail` exits zero, so a zero exit code still has its output read.
export function verificationFailed(result) {
  const exit = result?.metadata?.exit;
  if (exit === null || (typeof exit === 'number' && exit !== 0)) return true;
  const evidence = String(result?.output ?? '').replace(ZERO_COUNT, '');
  return detectSignals(evidence).some((signal) => FAILURE_SIGNALS.has(signal));
}

export function checkCommandOf(exec) {
  if (!SHELL_TOOL_NAMES.includes(exec?.name)) return null;
  const command = exec.arguments?.command;
  return isVerificationCommand(command) ? command : null;
}
