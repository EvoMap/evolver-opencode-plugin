// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { EDIT_TOOL_NAMES } from './edited-content.js';

const MAX_TIMER_MS = 2 ** 31 - 1;

const DEFAULTS = {
  proxyPort: undefined,
  editToolNames: [...EDIT_TOOL_NAMES],
  proxyTimeoutMs: 8_000,
  assetPrimeEnabled: true,
  assetPrimeMinSimilarity: 0.3,
  assetPrimeWaitMs: 6_000,
  assetPrimeTimeoutMs: 8_000,
  // Off by default: the skill's catalog line rides every turn and its body, once loaded, every later step.
  skillEnabled: false,
  claimNudgeEnabled: false,
  claimNudgeTtlMs: 12 * 60 * 60 * 1000,
};

const isTimer = (value) => Number.isInteger(value) && value >= 1 && value <= MAX_TIMER_MS;

const RULES = {
  proxyPort: (value) => Number.isInteger(value) && value >= 1 && value <= 65_535,
  editToolNames: (value) => Array.isArray(value) && value.every((name) => typeof name === 'string'),
  proxyTimeoutMs: isTimer,
  assetPrimeEnabled: (value) => typeof value === 'boolean',
  assetPrimeMinSimilarity: (value) => typeof value === 'number' && value >= 0 && value <= 1,
  assetPrimeWaitMs: isTimer,
  assetPrimeTimeoutMs: isTimer,
  skillEnabled: (value) => typeof value === 'boolean',
  claimNudgeEnabled: (value) => typeof value === 'boolean',
  claimNudgeTtlMs: isTimer,
};

/** The plugin options from `opencode.json` (`["evolver-opencode-plugin", { … }]`) over their defaults. */
export function configOf(options = {}) {
  const config = { ...DEFAULTS };
  for (const [key, value] of Object.entries(options ?? {})) {
    if (!(key in RULES) || value === undefined) continue;
    if (!RULES[key](value)) throw new Error(`Invalid Evolver option ${key}: ${JSON.stringify(value)}`);
    config[key] = value;
  }
  return config;
}
