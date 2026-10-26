// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import crypto from 'node:crypto';

import { listedAssets, rememberInjected } from './injected-assets.js';
import { hubGene } from './prime.js';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
let lastIdAt = 0;
let idCounter = 0;

// OpenCode orders a message's parts by id, so the strategy takes an id from OpenCode's own ascending scheme
// (`prt_`, twelve hex digits of time and counter, fourteen random characters) to land behind the prompt.
export function ascendingPartId(now = Date.now()) {
  idCounter = now === lastIdAt ? idCounter + 1 : 1;
  lastIdAt = now;
  const time = (BigInt(now) * 0x1000n + BigInt(idCounter)).toString(16).padStart(12, '0').slice(-12);
  const random = Array.from(crypto.getRandomValues(new Uint8Array(14)), (byte) => BASE62[byte % 62]).join('');
  return `prt_${time}${random}`;
}

// Synthetic text reaches the model with the prompt but is not drawn in the conversation.
export function strategyPart(sessionID, messageID, text) {
  return { id: ascendingPartId(), sessionID, messageID, type: 'text', text, synthetic: true };
}

function afterWait(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
}

// Reusable context must reach the model behind the prompt it was selected for, so the Hub is queried with each
// prompt — bounded by the ids already listed, since a repeat search adds nothing the model has seen. Search
// plus fetch against a cold Hub runs into seconds, too long to hold the turn for: the prompt waits only
// briefly, and a lookup that misses that budget keeps running and joins the prompt from the turn's next step,
// through the message transform, as long as that turn is still running.
export function createRecall({ config, primeFetch, recallLog, isTurnOpen }) {
  const listed = new Map();
  const lateParts = new Map();

  const listedFor = (sessionId) => {
    if (!listed.has(sessionId)) listed.set(sessionId, new Set(listedAssets(sessionId)));
    return listed.get(sessionId);
  };

  const strategyOf = (sessionId, messageId, turn, { ids, text }) => {
    for (const id of ids) rememberInjected(sessionId, id, { turn, strategyText: text });
    for (const id of ids) listedFor(sessionId).add(id);
    return text ? strategyPart(sessionId, messageId, text) : null;
  };

  return {
    async forPrompt({ sessionId, messageId, turn, text }) {
      if (config.assetPrimeEnabled === false) return null;
      const startedAt = Date.now();
      const search = hubGene(primeFetch, text, {
        listedIds: listedFor(sessionId),
        minSimilarity: config.assetPrimeMinSimilarity,
        onOutcome: (outcome) => recallLog.record(outcome, startedAt),
      });
      const inline = await Promise.race([search, afterWait(config.assetPrimeWaitMs)]);
      if (inline) return strategyOf(sessionId, messageId, turn, inline);

      search
        .then((late) => {
          if (!isTurnOpen(sessionId, turn)) return;
          const part = strategyOf(sessionId, messageId, turn, late);
          if (part) lateParts.set(messageId, { sessionId, part });
        })
        .catch(() => {});
      return null;
    },

    joinLate(messages) {
      for (const { info, parts } of messages ?? []) {
        const late = lateParts.get(info?.id);
        if (late && !parts.some((part) => part.id === late.part.id)) parts.push(late.part);
      }
    },

    forget(sessionId) {
      listed.delete(sessionId);
      for (const [messageId, late] of lateParts) if (late.sessionId === sessionId) lateParts.delete(messageId);
    },
  };
}
