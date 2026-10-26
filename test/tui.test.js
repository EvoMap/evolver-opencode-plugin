import assert from 'node:assert/strict';
import { test } from 'node:test';

import { argumentsOf, runEvolverCli } from '../src/commands.js';
import { readState, statePath } from '../src/state-file.js';
import { rememberCandidate, candidateOf } from '../src/session-distill.js';
import { evolverOnPath, freshHome, projectDirectory, startProxy, until } from './support/host.js';

const GENE = JSON.stringify({ title: 'Accept trailing commas', summary: 'Let a parser accept trailing commas.', strategy: ['Find the list rule.', 'Allow a comma.'] });

function fakeTuiClient(answer = GENE) {
  const calls = [];
  const record = (name) => async (parameters) => {
    calls.push({ name, parameters });
    return { data: {} };
  };
  return {
    calls,
    session: {
      create: async (parameters) => {
        calls.push({ name: 'create', parameters });
        return { data: { id: 'ses_helper', ...parameters } };
      },
      update: record('update'),
      abort: record('abort'),
      delete: record('delete'),
      prompt: async (parameters) => {
        calls.push({ name: 'prompt', parameters });
        return { data: { info: { role: 'assistant', tokens: { input: 10, output: 5 } }, parts: [{ type: 'text', text: answer }] } };
      },
    },
  };
}

function fakeApi({ route = { name: 'home' }, directory = projectDirectory() } = {}) {
  const shown = [];
  const layers = [];
  const api = {
    shown,
    layers,
    client: fakeTuiClient(),
    route: { current: route },
    state: { path: { directory } },
    lifecycle: { signal: new AbortController().signal },
    keymap: { registerLayer: (layer) => { layers.push(layer); return () => {}; } },
    ui: {
      toast: () => {},
      DialogAlert: (props) => ({ kind: 'alert', ...props }),
      DialogPrompt: (props) => ({ kind: 'prompt', ...props }),
      dialog: { replace: (render) => shown.push(render()), clear: () => {} },
    },
  };
  return api;
}

async function loadTui(api, options = {}) {
  const { default: plugin } = await import('../src/tui.js');
  await plugin.tui(api, options);
  return Object.fromEntries(api.layers[0].commands.map((command) => [command.slashName, command]));
}

const lastAlert = (api) => api.shown.filter((dialog) => dialog.kind === 'alert').at(-1);

test('every /evolver-* command is a palette command with a slash name, and none reaches the model', async (t) => {
  t.after(freshHome('evolver-tui-'));
  const commands = await loadTui(fakeApi());
  assert.deepEqual(Object.keys(commands).sort(), [
    'evolver-distill', 'evolver-review', 'evolver-run', 'evolver-search', 'evolver-solidify', 'evolver-status', 'evolver-sync',
  ]);
  for (const command of Object.values(commands)) {
    assert.equal(command.namespace, 'palette');
    assert.equal(command.category, 'Evolver');
    assert.equal(command.title, `/${command.slashName}`);
    assert.equal(typeof command.desc, 'string');
  }
});

test('a command without input runs at once; one that takes text asks for it first', async (t) => {
  t.after(freshHome('evolver-tui-input-'));
  const proxy = await startProxy((path) => (path === '/asset/search' ? { assets: [{ asset_id: 'sha256:x' }] } : { ok: true }));
  t.after(() => proxy.close());
  const api = fakeApi();
  const commands = await loadTui(api, { proxyPort: proxy.port });

  commands['evolver-status'].run();
  await until(() => lastAlert(api), 'the status dialog');
  assert.equal(api.shown.some((dialog) => dialog.kind === 'prompt'), false);
  assert.match(lastAlert(api).message, /"reachable": true/);

  commands['evolver-search'].run();
  const ask = api.shown.at(-1);
  assert.equal(ask.kind, 'prompt');
  assert.equal(ask.placeholder, '<task description or error text>');
  ask.onConfirm('retry flaky uploads');
  await until(() => lastAlert(api)?.title === '/evolver-search', 'the search result');
  assert.match(lastAlert(api).message, /sha256:x/);
  assert.deepEqual(proxy.requests.find((request) => request.path === '/asset/search').body, { text: 'retry flaky uploads', limit: 5 });
});

test("/evolver-distill distills the open session's candidate now, and needs an open session", async (t) => {
  t.after(freshHome('evolver-tui-distill-'));
  const proxy = await startProxy(() => ({ id: 'gene_1' }));
  t.after(() => proxy.close());
  rememberCandidate('ses_open', candidateOf({
    prompt: 'make the parser accept trailing commas',
    record: { checks: [], commands: ['npm test'], paths: [], edits: [], answer: 'Done.' },
    model: { providerID: 'anthropic', modelID: 'claude-sonnet' },
    turn: 1,
  }));

  const home = fakeApi();
  (await loadTui(home, { proxyPort: proxy.port }))['evolver-distill'].run();
  home.shown.at(-1).onConfirm('');
  await until(() => lastAlert(home), 'the refusal');
  assert.match(lastAlert(home).message, /Open a session first/);

  const inSession = fakeApi({ route: { name: 'session', params: { sessionID: 'ses_open' } } });
  (await loadTui(inSession, { proxyPort: proxy.port }))['evolver-distill'].run();
  inSession.shown.at(-1).onConfirm('the comma rule');
  await until(() => lastAlert(inSession), 'the distillation');
  assert.equal(lastAlert(inSession).title, '/evolver-distill');
  const prompt = inSession.client.calls.find((call) => call.name === 'prompt').parameters;
  assert.equal(prompt.sessionID, 'ses_helper');
  assert.match(prompt.parts[0].text, /Focus on: the comma rule/);
  assert.deepEqual(readState(statePath('opencode-distill-pending.json'), {}), {});
});

test('the engine commands run the evolver CLI in the project with quoted arguments kept whole', async (t) => {
  t.after(freshHome('evolver-tui-cli-'));
  const calls = evolverOnPath('2.0.39');
  const api = fakeApi();
  const commands = await loadTui(api);
  commands['evolver-solidify'].run();
  api.shown.at(-1).onConfirm('--dry-run --summary="two words"');
  await until(() => lastAlert(api), 'the CLI result');
  assert.ok(calls().includes('evolver solidify --dry-run --summary=two words'));
  assert.deepEqual(argumentsOf(`--intent='a b' c\\ d "e\\"f"`), ['--intent=a b', 'c d', 'e"f']);
});

test('the published package runs through npx when no evolver is installed', async () => {
  const runs = [];
  const run = async (file, args) => {
    runs.push([file, ...args]);
    return file === 'evolver' ? { error: { code: 'ENOENT' }, output: '' } : { error: null, output: 'synced' };
  };
  const result = await runEvolverCli(['sync'], { run });
  assert.deepEqual(result, { kind: 'success', text: 'synced' });
  assert.match(runs[1].join(' '), /^npx -y @evomap\/evolver@\^\d+\.\d+\.\d+ sync$/);
});
