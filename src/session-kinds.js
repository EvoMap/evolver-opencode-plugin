// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { isHelperSession } from './helper-session.js';

export const PERSON = 'person';
export const SUBAGENT = 'subagent';
export const HELPER = 'helper';

export function kindOfSession(info) {
  if (isHelperSession(info)) return HELPER;
  return info?.parentID ? SUBAGENT : PERSON;
}

/**
 * Whose session a hook fired for: the person's, a subagent's (a task tool's child session), or a distillation
 * helper's. Only the person's sessions are recalled for and reported. A session created in this process is
 * known from its `session.created` event; a resumed one is looked up once.
 */
export function createSessionKinds(lookup) {
  const kinds = new Map();
  return {
    note(info) {
      if (info?.id) kinds.set(info.id, kindOfSession(info));
    },
    async of(sessionId) {
      if (!kinds.has(sessionId)) kinds.set(sessionId, kindOfSession(await lookup(sessionId).catch(() => null)));
      return kinds.get(sessionId);
    },
  };
}
