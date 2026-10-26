// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// OpenCode gives a plugin no model call of its own, only its SDK client, so a distillation asks the session's
// model in a session of its own: created with every tool denied, archived so it stays out of the session list,
// marked so this plugin's hooks leave it alone (the mark reaches every process through the session's metadata),
// and deleted once answered.

const HELPER_TITLE = 'Evolver distillation';
const HELPER_MARK = 'distill';
const NO_TOOLS = [{ permission: '*', action: 'deny', pattern: '*' }];

export function isHelperSession(info) {
  return info?.metadata?.evolver === HELPER_MARK;
}

function dataOf(result) {
  if (result?.error) throw new Error(`OpenCode answered ${JSON.stringify(result.error)}`);
  return result?.data;
}

/** The session calls of the SDK client a server plugin is handed (`@opencode-ai/sdk`, v1). */
export function serverSessions(client) {
  return {
    create: (body) => client.session.create({ body }),
    archive: (id, at) => client.session.update({ path: { id }, body: { time: { archived: at } } }),
    prompt: (id, body, signal) => client.session.prompt({ path: { id }, body, signal }),
    abort: (id) => client.session.abort({ path: { id } }),
    remove: (id) => client.session.delete({ path: { id } }),
  };
}

/** The same calls through the SDK client a TUI plugin is handed (`@opencode-ai/sdk/v2`). */
export function tuiSessions(client) {
  return {
    create: (body) => client.session.create(body),
    archive: (sessionID, at) => client.session.update({ sessionID, time: { archived: at } }),
    prompt: (sessionID, body, signal) => client.session.prompt({ sessionID, ...body }, { signal }),
    abort: (sessionID) => client.session.abort({ sessionID }),
    remove: (sessionID) => client.session.delete({ sessionID }),
  };
}

function answerTextOf(parts) {
  return (parts ?? []).filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('');
}

export function helperCompletion(sessions, now = () => Date.now()) {
  return async ({ model, text, signal }) => {
    const { id } = dataOf(await sessions.create({ title: HELPER_TITLE, metadata: { evolver: HELPER_MARK }, permission: NO_TOOLS }));
    const stop = () => sessions.abort(id).catch(() => {});
    signal?.addEventListener('abort', stop, { once: true });
    try {
      dataOf(await sessions.archive(id, now()));
      const answered = dataOf(await sessions.prompt(id, { model, parts: [{ type: 'text', text }] }, signal));
      if (answered?.info?.error) throw new Error(`the model answered ${JSON.stringify(answered.info.error)}`);
      return { answer: answerTextOf(answered?.parts), usage: answered?.info?.tokens ?? null };
    } finally {
      signal?.removeEventListener('abort', stop);
      await sessions.remove(id).catch(() => {});
    }
  };
}
