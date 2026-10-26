import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after } from 'node:test';

process.env.EVOLVER_CLAIM_URL_PATH = join(mkdtempSync(join(tmpdir(), 'evolver-claim-')), 'missing');
process.env.EVOLVER_SESSION_STATE_DIR = mkdtempSync(join(tmpdir(), 'evolver-notice-state-'));
const originalPath = process.env.PATH;

// The engine setup probes `evolver --version` and starts its Proxy, and the local ledger asks `npm root -g`;
// both reach these stand-ins instead of the machine's own.
export function evolverOnPath(version) {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-bin-'));
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  writeFileSync(join(dir, 'evolver'), [
    '#!/bin/sh',
    `echo "evolver $*" >> "${log}"`,
    `[ "$1" = "--version" ] && echo "${version}"`,
    'exit 0',
  ].join('\n'));
  writeFileSync(join(dir, 'npm'), ['#!/bin/sh', `echo "npm $*" >> "${log}"`, 'exit 1'].join('\n'));
  chmodSync(join(dir, 'evolver'), 0o755);
  chmodSync(join(dir, 'npm'), 0o755);
  process.env.PATH = `${dir}${delimiter}${originalPath}`;
  return () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
}

evolverOnPath('2.0.39');
after(() => {
  delete process.env.EVOLVER_CLAIM_URL_PATH;
  delete process.env.EVOLVER_SESSION_STATE_DIR;
  process.env.PATH = originalPath;
});

export function freshHome(prefix) {
  const keys = ['HOME', 'USERPROFILE'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const home = mkdtempSync(join(tmpdir(), prefix));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  };
}

export function projectDirectory(prefix = 'evolver-project-') {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

export async function startProxy(answer = () => ({ recorded: true }), { delayMs = () => 0 } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = body ? JSON.parse(body) : undefined;
      requests.push({ path: request.url, body: parsed });
      setTimeout(() => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(answer(request.url, parsed, requests)));
      }, delayMs(request.url));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { requests, port: server.address().port, close: () => server.close() };
}

export const requestsTo = (proxy, path) => proxy.requests.filter((request) => request.path === path);

export async function until(condition, what, deadlineMs = 15_000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > deadlineMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

export const STRATEGY = ['Run `npm test` to see the failure.', 'Open `src/upload.js` and find the call.', 'Wrap it in a `backoff` retry.', 'Run `npm test` again.'];
export const proxyAnswer = (assets = []) => (path) => (path === '/asset/fetch' ? { assets } : { recorded: true });

/**
 * The SDK client a server plugin is handed (`@opencode-ai/sdk` v1 call shapes), answering the session calls a
 * distillation makes. `sessions` holds what `session.get` knows; `answer` is what the model writes.
 */
export function fakeClient({ sessions = {}, answer = '{}' } = {}) {
  const calls = [];
  const record = (name) => async (options) => {
    calls.push({ name, options });
    return { data: {} };
  };
  const client = {
    calls,
    answer,
    hold: undefined,
    session: {
      get: async ({ path }) => ({ data: sessions[path.id] ?? { id: path.id } }),
      create: async (options) => {
        calls.push({ name: 'create', options });
        return { data: { id: `ses_helper${calls.length}`, ...options.body } };
      },
      update: record('update'),
      abort: record('abort'),
      delete: record('delete'),
      prompt: async (options) => {
        calls.push({ name: 'prompt', options });
        await client.hold;
        return { data: { info: { role: 'assistant', tokens: { input: 900, output: 120 } }, parts: [{ type: 'text', text: client.answer }] } };
      },
    },
    tui: { showToast: async (options) => { calls.push({ name: 'toast', options }); return { data: true }; } },
  };
  return client;
}

export async function loadServer({ client = fakeClient(), directory = projectDirectory(), options = {} } = {}) {
  const { default: plugin } = await import('../../src/server.js');
  const hooks = await plugin.server({ client, directory, worktree: directory, project: {} }, options);
  return { hooks, client, directory };
}

let nextMessage = 0;

/** A host stand-in that drives the hooks the way OpenCode's prompt loop fires them. */
export function host(hooks) {
  const event = (type, properties) => hooks.event({ event: { type, properties } });
  return {
    event,
    async prompt(sessionID, text) {
      nextMessage += 1;
      const output = { message: { id: `msg_${String(nextMessage).padStart(4, '0')}`, role: 'user', sessionID }, parts: [{ id: 'prt_0', type: 'text', text }] };
      await hooks['chat.message']({ sessionID }, output);
      await event('session.status', { sessionID, status: { type: 'busy' } });
      return output;
    },
    async tool(sessionID, tool, args, result = { title: '', output: '', metadata: {} }) {
      await hooks['tool.execute.before']({ tool, sessionID, callID: 'call' }, { args });
      await hooks['tool.execute.after']({ tool, sessionID, callID: 'call', args }, result);
    },
    bash(sessionID, command, { exit = 0, output = '' } = {}) {
      return this.tool(sessionID, 'bash', { command }, { title: command, output, metadata: { exit, output } });
    },
    async answer(sessionID, text, { messageID = `msg_a${nextMessage}`, finish = 'stop', error } = {}) {
      const info = { id: messageID, sessionID, role: 'assistant', providerID: 'anthropic', modelID: 'claude-sonnet', finish, ...(error && { error }) };
      await event('message.updated', { sessionID, info: { ...info, finish: undefined } });
      if (text) await hooks['experimental.text.complete']({ sessionID, messageID, partID: 'prt_t' }, { text });
      await event('message.updated', { sessionID, info });
    },
    async idle(sessionID) {
      await event('session.status', { sessionID, status: { type: 'idle' } });
      await event('session.idle', { sessionID });
    },
  };
}
