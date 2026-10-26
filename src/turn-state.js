// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

const ABORTED = 'MessageAbortedError';
const UNFINISHED = new Set(['tool-calls', 'unknown']);

/**
 * How a turn ended, in dsh's terms. OpenCode goes idle after every turn — finished, interrupted or failed —
 * so the reason is read off what came before: `session.error` and the latest assistant message's `error`
 * and `finish`. A turn with no assistant message was stopped before the model answered, and one whose last
 * step still wanted its tool calls answered was stopped by a denied permission.
 */
export function turnEndReason({ error, lastAssistant }) {
  const failure = error ?? lastAssistant?.error;
  if (failure) return failure.name === ABORTED ? 'aborted' : 'error';
  if (!lastAssistant) return 'aborted';
  if (lastAssistant.finish === 'length') return 'max-tokens';
  if (!lastAssistant.finish || UNFINISHED.has(lastAssistant.finish)) return 'blocked';
  return 'completed';
}

// A turn opens with the person's prompt and closes the first time its session goes idle. A context overflow
// publishes `session.error` and then compacts and carries on in a new assistant message, so an error only
// stands while no later assistant message has started.
export function createOpenTurns() {
  const open = new Map();
  const busy = new Set();
  return {
    open(sessionId, turn) {
      open.set(sessionId, { turn, error: null, errorDuring: null, lastAssistant: null });
    },
    has: (sessionId) => open.has(sessionId),
    get: (sessionId) => open.get(sessionId),
    isBusy: (sessionId) => busy.has(sessionId),
    noteStatus(sessionId, status) {
      if (status?.type === 'idle') busy.delete(sessionId);
      else busy.add(sessionId);
    },
    noteAssistant(sessionId, info) {
      const state = open.get(sessionId);
      if (!state) return;
      if (state.error && info.id !== state.errorDuring) state.error = null;
      state.lastAssistant = info;
    },
    noteError(sessionId, error) {
      const state = open.get(sessionId);
      if (!state || !error) return;
      state.error = error;
      state.errorDuring = state.lastAssistant?.id ?? null;
    },
    close(sessionId) {
      const state = open.get(sessionId);
      open.delete(sessionId);
      return state ? { turn: state.turn, reasonKind: turnEndReason(state), lastAssistant: state.lastAssistant } : null;
    },
  };
}
