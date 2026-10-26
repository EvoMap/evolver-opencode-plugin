// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

export const EDIT_TOOL_NAMES = ['write', 'edit', 'apply_patch'];

const CONTENT_KEYS = ['content', 'newString'];
const PATH_KEYS = ['filePath', 'path'];
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/;
const ADDED_LINE = /^\+(?!\+\+ )/;

function firstString(args, keys) {
  for (const key of keys) {
    if (typeof args?.[key] === 'string' && args[key].length > 0) return args[key];
  }
  return '';
}

function patchTextOf(args) {
  return typeof args?.patchText === 'string' ? args.patchText : null;
}

function patchedPaths(patch) {
  const paths = [];
  for (const line of patch.split('\n')) {
    const match = PATCH_FILE.exec(line.trimEnd());
    const file = (match?.[1] ?? match?.[2])?.trim();
    if (file && !paths.includes(file)) paths.push(file);
  }
  return paths;
}

// `apply_patch`, which OpenCode gives GPT models instead of edit and write, carries the whole hunk; only the
// lines it adds are code the edit wrote.
function addedLines(patch) {
  return patch.split('\n').filter((line) => ADDED_LINE.test(line)).map((line) => line.slice(1)).join('\n');
}

export function editedContent(args) {
  const patch = patchTextOf(args);
  return patch === null ? firstString(args, CONTENT_KEYS) : addedLines(patch);
}

/** The files a tool call names: the one it reads or writes, or every file a patch touches. */
export function touchedPaths(args) {
  const patch = patchTextOf(args);
  if (patch !== null) return patchedPaths(patch);
  return PATH_KEYS.filter((key) => typeof args?.[key] === 'string' && args[key]).map((key) => args[key]);
}
