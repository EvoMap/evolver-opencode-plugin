// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { ownerIsGone } from './process-owner.js';
import { withoutSecrets } from './redact.js';
import { readState, statePath, updateState } from './state-file.js';

// Distillation runs once a session, at its end, and outside the agent's conversation: each turn that
// finished verified only leaves a candidate on disk, the latest one wins, and the session end (or, after an
// OpenCode process that exited or was killed, the next session start) turns it into a Gene with one model call
// over a digest of the turn — never the whole history, which cost ten times as much for fewer usable Genes in
// the benchmark. A candidate leaves the disk only once distilled or given up after MAX_ATTEMPTS failed tries; a
// try that failed is claimed again by the next session that starts. Each host keeps its own file: a candidate
// names the model of the host that wrote it, which no other host can call.

const PROMPT_MAX_CHARS = 6_000;
const ANSWER_MAX_CHARS = 3_000;
const COMMAND_MAX_CHARS = 300;
const MAX_COMMANDS = 40;
const LIST_FIELDS = ['strategy', 'validation', 'signals', 'preconditions'];
const ARGUMENT_FIELDS = ['title', 'summary', ...LIST_FIELDS];
const ITEM_NUMBER = /^\s*(?:\d+[.)]|[-*•])\s+/;
const MAX_ATTEMPTS = 3;

const pendingPath = () => statePath('opencode-distill-pending.json');

/**
 * Why a finished turn leaves no candidate, or null when it does. A chat reply without a single command has no
 * method to keep. A turn that reused an injected strategy is distilled too: the engine's intake drops a Gene
 * that repeats one it already has.
 */
export function skipReason(reasonKind, record) {
  if (reasonKind !== 'completed') return 'not_completed';
  if (!record.answer) return 'no_answer';
  if (record.checks.at(-1)?.failed) return 'failed_check';
  if (record.commands.length === 0 && record.edits.length === 0) return 'no_tool_use';
  return null;
}

/** The provider and model behind the session's latest assistant message: the distillation runs on it. */
export function modelOf(assistant) {
  return assistant?.providerID && assistant?.modelID ? { providerID: assistant.providerID, modelID: assistant.modelID } : null;
}

// Keys and tokens are stripped before anything is written to disk or sent to a model or the Proxy.
export function candidateOf({ prompt, record, model, turn, pid = process.pid, now = Date.now() }) {
  return {
    prompt: withoutSecrets(String(prompt ?? '')).slice(0, PROMPT_MAX_CHARS),
    commands: record.commands.slice(-MAX_COMMANDS).map((command) => withoutSecrets(command).slice(0, COMMAND_MAX_CHARS)),
    paths: [...new Set(record.paths)].map((path) => withoutSecrets(path)),
    checks: record.checks.map(({ command, failed }) => ({ command: withoutSecrets(command), failed })),
    answer: withoutSecrets(record.answer).slice(0, ANSWER_MAX_CHARS),
    model,
    turn,
    pid,
    attempts: 0,
    at: now,
  };
}

export function rememberCandidate(sessionId, candidate) {
  if (!sessionId) return;
  updateState(pendingPath(), {}, (pending) => ({ ...pending, [sessionId]: candidate }));
}

export function dropCandidate(sessionId) {
  if (!sessionId) return;
  updateState(pendingPath(), {}, (pending) => {
    if (!(sessionId in pending)) return undefined;
    const { [sessionId]: dropped, ...rest } = pending;
    return rest;
  });
}

/** Whether this is still the session's candidate on disk: not dropped by a correction, nor replaced by a newer one. */
export function isCurrentCandidate(sessionId, candidate) {
  return readState(pendingPath(), {})[sessionId]?.at === candidate.at;
}

/** A session that ended keeps its candidate due, so a distillation that failed at its end is tried again. */
export function closeCandidate(sessionId) {
  if (!sessionId) return;
  updateState(pendingPath(), {}, (pending) => (pending[sessionId]
    ? { ...pending, [sessionId]: { ...pending[sessionId], closed: true } }
    : undefined));
}

// A candidate is up for distillation again once its session is over and no live process is working on it.
function leftover(candidate, isGone) {
  const over = Boolean(candidate?.closed) || isGone(candidate?.pid);
  return over && (!candidate?.claimedBy || isGone(candidate.claimedBy));
}

/** This session's own candidate, if it has one. Left on disk until settled. */
export function dueCandidates({ sessionId }) {
  const candidate = readState(pendingPath(), {})[sessionId];
  return candidate ? [{ sessionId, candidate }] : [];
}

/**
 * The candidates of sessions that are over — ended, or killed with their process — claimed for this process
 * under the state lock, so two hosts starting at once cannot distill the same one twice. An idle session
 * whose process still runs keeps its candidate however long it waits.
 */
export function claimLeftoverCandidates({ isGone = ownerIsGone, pid = process.pid } = {}) {
  const claimed = [];
  updateState(pendingPath(), {}, (pending) => {
    const next = { ...pending };
    for (const [sessionId, candidate] of Object.entries(pending)) {
      if (!leftover(candidate, isGone) || candidate.claimedBy === pid) continue;
      next[sessionId] = { ...candidate, claimedBy: pid };
      claimed.push({ sessionId, candidate: next[sessionId] });
    }
    return claimed.length > 0 ? next : undefined;
  });
  return claimed;
}

/**
 * Removes a candidate once it was distilled, or counts a failed try and gives up after MAX_ATTEMPTS. A
 * newer candidate the session wrote meanwhile is left alone.
 */
export function settleCandidate(sessionId, candidate, { sent }) {
  updateState(pendingPath(), {}, (pending) => {
    const current = pending[sessionId];
    if (!current || current.at !== candidate.at) return undefined;
    const attempts = (current.attempts ?? 0) + 1;
    if (sent || attempts >= MAX_ATTEMPTS) {
      const { [sessionId]: settled, ...rest } = pending;
      return rest;
    }
    // The claim is released, so the next session start can try this candidate again.
    return { ...pending, [sessionId]: { ...current, attempts, claimedBy: null } };
  });
}

export function distillPrompt(candidate, focus = '') {
  const lines = (items, render) => items.map(render).join('\n') || '(none)';
  const focusText = withoutSecrets(String(focus ?? ''));
  return [
    'Below is the record of a task an agent has just finished and verified. Turn it into one reusable Gene:',
    'a method another agent could follow on a similar task, written for the kind of data or system involved,',
    'not for these files, names or values. Do not include the answer itself.',
    ...(focusText ? [`Focus on: ${focusText}`] : []),
    'Answer with a JSON object only, with these fields:',
    '  title: short capability name',
    '  summary: what was solved and under which conditions',
    '  strategy: ordered, reproducible steps',
    '  validation: checks that proved the result',
    '  signals: keywords of the problem this generalizes to',
    '  preconditions: when the method applies',
    '',
    '## Task',
    candidate.prompt,
    '',
    '## Commands run',
    lines(candidate.commands, (command) => `- ${command}`),
    '',
    '## Files read or written',
    lines(candidate.paths, (path) => `- ${path}`),
    '',
    '## Checks',
    lines(candidate.checks, (check) => `- ${check.failed ? 'FAILED' : 'passed'}: ${check.command}`),
    '',
    '## Final answer',
    candidate.answer,
  ].join('\n');
}

// Models sometimes write a list field as one numbered paragraph ("1. … 2. …"), which the core reads as one step.
function listOf(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;
  return value.split(/\n+|(?<=\.)\s+(?=\d+[.)]\s)/).map((item) => item.replace(ITEM_NUMBER, '').trim()).filter(Boolean);
}

export function argumentsOf(text) {
  const match = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed?.summary !== 'string' || !parsed.summary.trim()) return null;
    for (const field of LIST_FIELDS) if (field in parsed) parsed[field] = listOf(parsed[field]);
    return Object.fromEntries(ARGUMENT_FIELDS.filter((field) => parsed[field] !== undefined).map((field) => [field, parsed[field]]));
  } catch {
    return null;
  }
}

export function distillBody(candidate, args, usage) {
  return {
    platform: 'opencode',
    trigger: 'session_end',
    user_prompt: candidate.prompt,
    // The core rejects a Gene that repeats this answer's values (answer_leak).
    final_answer: candidate.answer,
    ...args,
    execution: { trace: candidate.checks.map((check) => ({ command: check.command, exit: check.failed ? 1 : 0 })) },
    persist: true,
    publish: false,
    // What this distillation itself cost, kept apart from the agent's own tokens.
    ...(usage ? { distill_usage: usage } : {}),
  };
}

/**
 * Distill one candidate through the session's own model (`complete` asks it in a session of its own). `cancel`
 * stops it and `isCurrent` is asked once more before anything is persisted, since the candidate may have been
 * dropped while the model answered. Resolves to what happened; never throws.
 */
export async function distillCandidate({ proxyFetch, complete, candidate, focus, timeoutMs, cancel, isCurrent = () => true }) {
  if (!complete || !candidate?.model) return { status: 'no_model' };
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(cancel ? [cancel] : [])]);
  try {
    const { answer, usage } = await complete({ model: candidate.model, text: distillPrompt(candidate, focus), signal });
    const args = argumentsOf(answer);
    if (!args) return { status: 'unparsed', usage };
    if (cancel?.aborted || !isCurrent()) return { status: 'dropped', usage };
    const result = await proxyFetch('POST', '/conversation/distill', distillBody(candidate, args, usage), signal);
    return result?.ok ? { status: 'sent', usage, data: result.data } : { status: 'failed', error: String(result?.error) };
  } catch (error) {
    if (cancel?.aborted) return { status: 'dropped' };
    return { status: 'failed', error: String(error?.message ?? error) };
  }
}
