// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import fs from 'node:fs';

function isDirectory(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function realPath(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

/** The project an OpenCode instance serves, resolved through symlinks so two spellings of it compare equal. */
export function projectDirOf(directory) {
  return realPath(isDirectory(directory) ? directory : process.cwd());
}
