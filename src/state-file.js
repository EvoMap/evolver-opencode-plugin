// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ownerIsGone } from './process-owner.js';

export function statePath(name) {
  return path.join(os.homedir(), '.evolver', 'state', name);
}

export function hashedName(prefix, key) {
  return `${prefix}-${crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16)}.json`;
}

export function readState(target, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    return parsed && typeof parsed === 'object' && Array.isArray(parsed) === Array.isArray(fallback) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function writeState(target, value) {
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    try {
      fs.renameSync(temporary, target);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      fs.rmSync(target, { force: true });
      fs.renameSync(temporary, target);
    }
  } catch {
  }
}

const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 20;

// Atomics.wait is the only sleep that holds a synchronous read-modify-write together.
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function contentOf(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// A lock holds its owner's pid and a token unique to that acquisition, so a lock is told apart from a newer one
// the same process, or another, took after it.
const ownerPidOf = (token) => Number(token.split(':')[0]);

// Another process may reclaim the same dead lock and a third take a fresh one before this removal happens, so the
// lock is first moved aside, and only what was inspected as dead is deleted; anything else is put back.
function reclaim(lockPath, deadToken) {
  const aside = `${lockPath}.${crypto.randomBytes(6).toString('hex')}.reclaimed`;
  try {
    fs.renameSync(lockPath, aside);
  } catch {
    return;
  }
  if (contentOf(aside) !== deadToken) {
    try {
      fs.linkSync(aside, lockPath);
    } catch {
    }
  }
  removeState(aside);
}

function acquire(lockPath, deadline) {
  const token = `${process.pid}:${crypto.randomBytes(8).toString('hex')}`;
  for (;;) {
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(lockPath, token, { mode: 0o600, flag: 'wx' });
      return token;
    } catch (error) {
      if (error?.code !== 'EEXIST') return null;
      const held = contentOf(lockPath);
      if (held !== null && ownerIsGone(ownerPidOf(held))) reclaim(lockPath, held);
      else if (Date.now() >= deadline) return null;
      else pause(LOCK_RETRY_MS);
    }
  }
}

function release(lockPath, token) {
  if (contentOf(lockPath) === token) removeState(lockPath);
}

/**
 * Reads a state file, applies `mutate` and writes the result back while holding an exclusive lock, so two
 * OpenCode processes sharing `~/.evolver/state` cannot overwrite each other's entries. A lock whose owner died is
 * taken over; a lock that cannot be had within LOCK_WAIT_MS is given up on and the update runs unguarded,
 * which is still the behaviour of an unlocked write and never blocks a session.
 */
export function updateState(target, fallback, mutate) {
  const lockPath = `${target}.lock`;
  const token = acquire(lockPath, Date.now() + LOCK_WAIT_MS);
  try {
    const next = mutate(readState(target, fallback));
    if (next !== undefined) writeState(target, next);
    return next;
  } finally {
    if (token) release(lockPath, token);
  }
}

export function removeState(target) {
  try {
    fs.rmSync(target, { force: true });
  } catch {
  }
}
