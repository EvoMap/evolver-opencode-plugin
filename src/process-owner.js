// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

/**
 * Whether the OpenCode process that wrote a state entry has exited. Signal 0 only probes: ESRCH means no such
 * process; EPERM means it exists under another user. An entry without a pid (written by an older version)
 * is never taken for a dead owner's.
 */
export function ownerIsGone(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}
