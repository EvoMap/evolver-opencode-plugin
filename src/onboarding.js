// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATE_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

function claimFilePath() {
  return process.env.EVOLVER_CLAIM_URL_PATH || path.join(os.homedir(), '.evomap', 'claim_url');
}

function stateFilePath() {
  const base = process.env.EVOLVER_SESSION_STATE_DIR || path.join(os.homedir(), '.evolver');
  return path.join(base, 'opencode-start-state.json');
}

export function pendingClaimUrl() {
  try {
    const value = fs.readFileSync(claimFilePath(), 'utf8').trim();
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:') return null;
    if (host !== 'evomap.ai' && !host.endsWith('.evomap.ai')) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function noticeKey(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// The state file is shared by every throttled notice, so callers pass a
// namespaced value; only its hash is persisted, never the value itself (a
// claim url carries a secret).
export function noticeDue(value, ttlMs, now = Date.now()) {
  const statePath = stateFilePath();
  let state = {};
  try {
    const stat = fs.lstatSync(statePath);
    if (!stat.isSymbolicLink() && stat.isFile()) {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) state = parsed;
    }
  } catch {
  }

  const key = noticeKey(value);
  const previous = state[key];
  if (typeof previous === 'number' && now - previous < ttlMs) return false;

  state[key] = now;
  for (const [existing, timestamp] of Object.entries(state)) {
    if (typeof timestamp !== 'number' || now - timestamp > STATE_PRUNE_MS) delete state[existing];
  }

  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    const temporary = `${statePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    try {
      fs.renameSync(temporary, statePath);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      fs.rmSync(statePath, { force: true });
      fs.renameSync(temporary, statePath);
    }
  } catch {
  }
  return true;
}
