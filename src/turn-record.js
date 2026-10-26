// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import path from 'node:path';

import { editedContent, touchedPaths } from './edited-content.js';
import { contentHashOf } from './retention-pending.js';
import { checkCommandOf, verificationFailed, verificationInterrupted } from './verification.js';

const TURN_EDITED_MAX_CHARS = 200_000;
const CHECK_COMMAND_MAX_CHARS = 200;

function freshTurnRecord() {
  return { checks: [], commands: [], paths: [], edits: [], editedChars: 0, editedBefore: new Map(), answer: '', answerMessageId: null, answerText: '' };
}

export function createTurnRecords() {
  const records = new Map();
  return {
    of(sessionKey) {
      let record = records.get(sessionKey);
      if (!record) {
        record = freshTurnRecord();
        records.set(sessionKey, record);
      }
      return record;
    },
    take(sessionKey) {
      const record = records.get(sessionKey) ?? freshTurnRecord();
      records.delete(sessionKey);
      return record;
    },
    forget(sessionKey) {
      records.delete(sessionKey);
    },
  };
}

export function noteFileBeforeEdit(record, projectDir, args) {
  for (const edited of touchedPaths(args)) {
    const file = path.resolve(projectDir, edited);
    if (!record.editedBefore.has(file)) record.editedBefore.set(file, contentHashOf(file));
  }
}

function noteEditedContent(record, args) {
  const kept = editedContent(args).slice(0, TURN_EDITED_MAX_CHARS - record.editedChars);
  if (!kept) return;
  record.edits.push(kept);
  record.editedChars += kept.length;
}

// `tool.execute.after` fires only for a call that ran to its end: one the person denied, or that threw, never
// reaches here, so a check that was not allowed to run is not taken for a failed one.
export function noteToolResult(record, exec, result, { isEdit }) {
  const args = exec.arguments ?? {};
  if (typeof args.command === 'string') record.commands.push(args.command);
  record.paths.push(...touchedPaths(args));
  const check = checkCommandOf(exec);
  if (check && !verificationInterrupted(result)) record.checks.push({ command: check.slice(0, CHECK_COMMAND_MAX_CHARS), failed: verificationFailed(result) });
  if (isEdit) noteEditedContent(record, args);
}

/** The turn's answer is the text of its latest assistant message that wrote any. */
export function noteAnswer(record, messageId, text) {
  if (record.answerMessageId !== messageId) {
    record.answerMessageId = messageId;
    record.answerText = '';
  }
  record.answerText += text ?? '';
  if (record.answerText.trim()) record.answer = record.answerText.trim();
}
