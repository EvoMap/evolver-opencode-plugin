// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MIN_EVOLVER_VERSION } from './engine-version.js';
import { splitFrontmatter } from './frontmatter.js';

// Commands are how a person reaches Evolver, so nothing about them sits in the model's context: each one
// runs in the plugin and answers in the UI. Only /evolver-evolve hands the agent a one-off instruction,
// because reflecting on the current work is the agent's job; OpenCode runs it as a prompt command.

const NAME_PREFIX = 'evolver-';
const OUTPUT_MAX_CHARS = 4_000;
const CLI_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 5_000;
// The fallback runs whatever npm resolves, so it is held to the range this plugin is built against.
const CLI_PACKAGE = `@evomap/evolver@^${MIN_EVOLVER_VERSION}`;
const EVOLVE_PATH = fileURLToPath(new URL('../assets/commands/evolve.md', import.meta.url));

const success = (text) => ({ kind: 'success', text });
const failure = (text) => ({ kind: 'error', text });

function shown(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > OUTPUT_MAX_CHARS ? `${text.slice(0, OUTPUT_MAX_CHARS)}\n…` : text;
}

/**
 * Quotes group words the way a shell would (`--summary="two words"` stays one argument) and a backslash
 * escapes the character after it, so a quote can be part of a value; nothing else is expanded.
 */
export function argumentsOf(rawInput) {
  const args = [];
  let current = '';
  let quote = null;
  let started = false;
  let escaped = false;
  for (const char of rawInput) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\' && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

// The CLI starts the Proxy and workers of its own, so a cancelled or timed-out run takes down the whole
// process group it leads rather than only the process this plugin started. Windows has no group to signal.
const grouped = process.platform !== 'win32';

function endTree(child) {
  const target = grouped ? -child.pid : child.pid;
  const signalTree = (name) => {
    try {
      process.kill(target, name);
    } catch {
    }
  };
  signalTree('SIGTERM');
  setTimeout(() => signalTree('SIGKILL'), KILL_GRACE_MS).unref?.();
}

function execute(file, args, signal, cwd) {
  return new Promise((resolve) => {
    let timer = null;
    const child = execFile(file, args, { cwd, maxBuffer: 16 * 1024 * 1024, detached: grouped }, (error, stdout, stderr) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ error, output: `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.trim() });
    });
    function onAbort() {
      endTree(child);
    }
    if (!child.pid) return;
    timer = setTimeout(onAbort, CLI_TIMEOUT_MS);
    timer.unref?.();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// The installed `evolver` when there is one, else the published package through npx.
export async function runEvolverCli(args, { signal, cwd, run = execute } = {}) {
  let { error, output } = await run('evolver', args, signal, cwd);
  if (error?.code === 'ENOENT') ({ error, output } = await run('npx', ['-y', CLI_PACKAGE, ...args], signal, cwd));
  return error ? failure(shown(output || String(error.message))) : success(shown(output || 'done'));
}

function cliCommand(subcommand, description, hint, runCli) {
  return {
    name: `${NAME_PREFIX}${subcommand}`,
    description,
    input: { hint },
    handler: ({ rawInput, signal, cwd }) => runCli([subcommand, ...argumentsOf(rawInput)], { signal, cwd }),
  };
}

/** /evolver-evolve as an OpenCode prompt command: its template is the instruction the agent is handed. */
export function evolveCommand() {
  const { fields, body } = splitFrontmatter(readFileSync(EVOLVE_PATH, 'utf8'));
  return { name: `${NAME_PREFIX}evolve`, description: fields.description, template: body };
}

export function evolvePromptOf(template, rawInput) {
  const focus = rawInput.trim();
  return focus ? `${template}\n\nFocus: ${focus}` : template;
}

/**
 * `status` and `search` answer from the Proxy, `distill` distills the session's latest verified turn now,
 * and the engine commands run the `evolver` executable.
 */
export function evolverCommands({ status, search, distillNow, runCli = runEvolverCli }) {
  return [
    {
      name: `${NAME_PREFIX}status`,
      description: 'Show Evolver health: the Proxy, Hub auth, recent recalls and reuse reports.',
      handler: async ({ signal }) => success(shown(await status(signal))),
    },
    {
      name: `${NAME_PREFIX}search`,
      description: 'Search the EvoMap network for reusable assets.',
      input: { hint: '<task description or error text>' },
      handler: async ({ rawInput, signal }) => {
        const text = rawInput.trim();
        if (!text) return failure(`Usage: /${NAME_PREFIX}search <task description or error text>`);
        const result = await search(text, signal);
        return result.ok ? success(shown(result.data)) : failure(String(result.error));
      },
    },
    {
      name: `${NAME_PREFIX}distill`,
      description: "Distill this session's latest verified turn into a reusable Gene now, instead of at session end.",
      input: { hint: 'optional focus' },
      handler: async ({ sessionId, rawInput }) => {
        if (!sessionId) return failure(`Open a session first: /${NAME_PREFIX}distill distills that session's latest verified turn.`);
        const outcome = await distillNow(sessionId, rawInput.trim());
        if (outcome.status === 'nothing') return failure('Nothing to distill yet: no turn of this session finished verified.');
        return outcome.status === 'sent' ? success(shown(outcome.data ?? 'distilled')) : failure(`Distillation ${outcome.status}: ${outcome.error ?? ''}`.trim());
      },
    },
    cliCommand('sync', 'Sync assets between the local store and the EvoMap Hub (evolver sync).', '[--scope=…] [--type=…] [--dry-run]', runCli),
    cliCommand('review', "Review Evolver's pending evolved changes, then approve or reject them (evolver review).", '[--approve | --reject]', runCli),
    cliCommand('run', 'Run one Evolver self-evolution cycle on this repository (evolver run).', '[--loop] [--dry-run] [--strategy=…]', runCli),
    cliCommand('solidify', 'Solidify the working changes into a durable Gene or Capsule (evolver solidify).', '[--dry-run] [--intent=…] [--summary=…]', runCli),
  ];
}
