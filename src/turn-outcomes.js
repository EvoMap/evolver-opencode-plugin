// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

const TURN_OUTCOMES = {
  completed: 'success',
  'max-tokens': 'failed',
  aborted: 'failed',
  blocked: 'failed',
  error: 'failed',
};

export function outcomeOfReason(reasonKind) {
  return TURN_OUTCOMES[reasonKind] ?? null;
}
