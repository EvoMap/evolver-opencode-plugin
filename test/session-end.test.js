import assert from 'node:assert/strict';
import { test } from 'node:test';

import { distillPrompt, rememberCandidate } from '../src/session-distill.js';
import { hashedName, readState, statePath, writeState } from '../src/state-file.js';
import {
  STRATEGY, deadPid, fakeClient, freshHome, host, loadServer, proxyAnswer, requestsTo, startProxy, until,
} from './support/host.js';

const ASSET = { asset_id: 'sha256:retry', short_title: 'Retry flaky uploads', strategy: STRATEGY, similarity: 0.8 };
const GENE = JSON.stringify({ title: 'Accept trailing commas', summary: 'Let a parser accept trailing commas.', strategy: ['Find the list rule.', 'Allow an optional comma.'] });

const pending = () => readState(statePath('opencode-distill-pending.json'), {});
const outbox = () => Object.values(readState(statePath('opencode-reports-outbox.json'), {}));
const distills = (proxy) => requestsTo(proxy, '/conversation/distill');
const reportsOf = (proxy) => requestsTo(proxy, '/asset/reuse-result').map((request) => request.body);
const callsNamed = (client, name) => client.calls.filter((call) => call.name === name);

const retryOnly = (path, body) => (path === '/asset/fetch' ? { assets: /retry/.test(body?.text) ? [ASSET] : [] } : { recorded: true });

async function harness(t, { assets = [], answer = GENE, proxyAnswers = proxyAnswer(assets) } = {}) {
  t.after(freshHome('evolver-session-end-'));
  const proxy = await startProxy(proxyAnswers);
  t.after(() => proxy.close());
  const client = fakeClient({ answer });
  const loaded = await loadServer({ client, options: { proxyPort: proxy.port, assetPrimeWaitMs: 2_000 } });
  return { ...loaded, proxy, oc: host(loaded.hooks) };
}

async function verifiedTurn(oc, sessionID) {
  await oc.prompt(sessionID, 'make the parser accept trailing commas');
  await oc.bash(sessionID, 'npm test', { exit: 0, output: 'ℹ pass 9' });
  await oc.answer(sessionID, 'The parser accepts trailing commas.');
  await oc.idle(sessionID);
}

const deleted = (oc, sessionID) => oc.event('session.deleted', { sessionID, info: { id: sessionID } });

test('a verified turn is distilled once its session is deleted, in a tool-less helper session on its model', async (t) => {
  const { oc, proxy, client } = await harness(t);
  await verifiedTurn(oc, 'ses_d');
  assert.deepEqual(callsNamed(client, 'prompt'), [], 'nothing runs at turn end');
  const candidate = pending().ses_d;

  await deleted(oc, 'ses_d');
  await until(() => distills(proxy).length === 1, 'the distillation');
  await until(() => pending().ses_d === undefined, 'the candidate to settle');

  const [create] = callsNamed(client, 'create');
  assert.deepEqual(create.options.body.metadata, { evolver: 'distill' });
  assert.deepEqual(create.options.body.permission, [{ permission: '*', action: 'deny', pattern: '*' }]);
  const [archive] = callsNamed(client, 'update');
  assert.equal(typeof archive.options.body.time.archived, 'number');
  const [prompt] = callsNamed(client, 'prompt');
  assert.deepEqual(prompt.options.body.model, { providerID: 'anthropic', modelID: 'claude-sonnet' });
  assert.deepEqual(prompt.options.body.parts, [{ type: 'text', text: distillPrompt(candidate) }]);
  await until(() => callsNamed(client, 'delete').length === 1, 'the helper session to go');

  const [{ body }] = distills(proxy);
  assert.equal(body.platform, 'opencode');
  assert.equal(body.trigger, 'session_end');
  assert.equal(body.user_prompt, 'make the parser accept trailing commas');
  assert.deepEqual(body.execution, { trace: [{ command: 'npm test', exit: 0 }] });
  assert.deepEqual(body.distill_usage, { input: 900, output: 120 });
});

test('a verified turn that reused an injected strategy is distilled too', async (t) => {
  const { oc, proxy } = await harness(t, { assets: [ASSET] });
  await oc.prompt('ses_reused', 'add a retry to the uploader');
  await oc.bash('ses_reused', 'npm test', { exit: 0, output: 'ℹ pass 4' });
  await oc.answer('ses_reused', 'Added a retry with backoff.');
  await oc.idle('ses_reused');
  await until(() => reportsOf(proxy).length === 1, 'the reuse report');

  await deleted(oc, 'ses_reused');
  await until(() => distills(proxy).length === 1, 'the distillation');
  assert.equal(distills(proxy)[0].body.user_prompt, 'add a retry to the uploader');
});

test('the helper session triggers none of this plugin\'s own work', async (t) => {
  const { oc, proxy, client, hooks } = await harness(t, { assets: [ASSET], proxyAnswers: retryOnly });
  await verifiedTurn(oc, 'ses_h');
  client.hold = new Promise(() => {});
  await deleted(oc, 'ses_h');
  await until(() => callsNamed(client, 'prompt').length === 1, 'the helper prompt');

  const [create] = callsNamed(client, 'create');
  const helper = { id: 'ses_helper1', ...create.options.body };
  await oc.event('session.created', { sessionID: helper.id, info: helper });
  const output = await oc.prompt(helper.id, callsNamed(client, 'prompt')[0].options.body.parts[0].text);
  await oc.bash(helper.id, 'npm test', { exit: 0 });
  await oc.answer(helper.id, GENE);
  await oc.idle(helper.id);
  await oc.event('session.deleted', { sessionID: helper.id, info: helper });
  await hooks.dispose();

  assert.equal(output.parts.length, 1, 'nothing recalled into the distillation prompt');
  assert.equal(requestsTo(proxy, '/asset/fetch').length, 1, 'only the person\'s prompt was recalled for');
  assert.deepEqual(Object.keys(pending()), ['ses_h']);
  assert.deepEqual(reportsOf(proxy), []);
});

test('a failed distillation keeps the candidate, and the next session start claims and retries it', async (t) => {
  const { oc, proxy, client } = await harness(t, { answer: 'not json' });
  await verifiedTurn(oc, 'ses_f');
  await deleted(oc, 'ses_f');
  await until(() => callsNamed(client, 'delete').length === 1, 'the failed try');
  await until(() => pending().ses_f?.attempts === 1, 'the try to be counted');
  assert.equal(pending().ses_f.closed, true);
  assert.equal(pending().ses_f.claimedBy, null);
  assert.deepEqual(distills(proxy), []);

  client.answer = GENE;
  await oc.prompt('ses_next', 'what does this repo do?');
  await until(() => distills(proxy).length === 1, 'the retry');
  await until(() => pending().ses_f === undefined, 'the candidate to settle');
});

test('a helper session that fails leaves the candidate for a later try and is removed', async (t) => {
  const { oc, proxy, client } = await harness(t);
  client.session.prompt = async (options) => {
    client.calls.push({ name: 'prompt', options });
    return { data: { info: { role: 'assistant', error: { name: 'ProviderAuthError', data: { message: 'no key' } } }, parts: [] } };
  };
  await verifiedTurn(oc, 'ses_auth');
  await deleted(oc, 'ses_auth');
  await until(() => pending().ses_auth?.attempts === 1, 'the failed try');
  assert.equal(callsNamed(client, 'delete').length, 1);
  assert.deepEqual(distills(proxy), []);
});

test('a strategy whose turn never ended is reported aborted when its session is deleted', async (t) => {
  const { oc, proxy } = await harness(t, { assets: [ASSET] });
  await oc.prompt('ses_cut', 'add a retry to the uploader');
  await deleted(oc, 'ses_cut');
  await until(() => reportsOf(proxy).length === 1, 'the aborted report');

  const [report] = reportsOf(proxy);
  assert.equal(report.task_id, 'opencode:ses_cut:1');
  assert.equal(report.outcome, 'failed');
  assert.deepEqual(
    { tier: report.evidence.tier, applied: report.evidence.applied, aborted: report.evidence.aborted, stage: report.evidence.stage },
    { tier: 'none', applied: 'used', aborted: true, stage: 'immediate' },
  );
});

test('shutting OpenCode down only writes; the next process delivers the aborted reports and distills the candidate', async (t) => {
  const { oc, proxy, hooks, client } = await harness(t, { proxyAnswers: retryOnly });
  await oc.prompt('ses_open', 'add a retry to the uploader');
  await verifiedTurn(oc, 'ses_done');

  await hooks.dispose();
  assert.deepEqual(reportsOf(proxy), [], 'nothing sent while shutting down');
  assert.deepEqual(callsNamed(client, 'prompt'), [], 'nothing distilled while shutting down');
  const queued = outbox().filter((entry) => !entry.sentAt);
  assert.deepEqual(queued.map((entry) => [entry.report.task_id, entry.report.evidence.aborted]), [['opencode:ses_open:1', true]]);
  assert.equal(pending().ses_done.closed, true);

  const next = await loadServer({ client, options: { proxyPort: proxy.port, assetPrimeWaitMs: 2_000 } });
  await host(next.hooks).prompt('ses_later', 'what does this repo do?');
  await until(() => reportsOf(proxy).length === 1, 'the queued aborted report');
  await until(() => distills(proxy).length === 1, 'the leftover distillation');
  assert.equal(reportsOf(proxy)[0].task_id, 'opencode:ses_open:1');
});

test("the next session reports a killed process's open strategies and distills its leftover candidate", async (t) => {
  const { oc, proxy, client } = await harness(t);
  const dead = deadPid();
  writeState(statePath(hashedName('opencode-injected', 'ses_killed')), {
    'sha256:orphan': { turn: 4, injectedAt: Date.now(), strategyText: '1. a.', sessionId: 'ses_killed', pid: dead },
  });
  writeState(statePath(hashedName('opencode-injected', 'ses_idle')), {
    'sha256:idle': { turn: 1, injectedAt: Date.now(), strategyText: '1. a.', sessionId: 'ses_idle', pid: process.pid },
  });
  rememberCandidate('ses_killed', { prompt: 'p', commands: ['npm test'], paths: [], checks: [], answer: 'a', model: { providerID: 'p', modelID: 'm' }, turn: 4, pid: dead, attempts: 0, at: 1 });

  await oc.prompt('ses_new', 'what does this repo do?');
  await until(() => reportsOf(proxy).length === 1, 'the orphaned report');
  await until(() => distills(proxy).length === 1, 'the leftover distillation');

  const [report] = reportsOf(proxy);
  assert.equal(report.asset_id, 'sha256:orphan');
  assert.equal(report.task_id, 'opencode:ses_killed:4');
  assert.equal(report.evidence.aborted, true);
  assert.deepEqual(callsNamed(client, 'prompt')[0].options.body.model, { providerID: 'p', modelID: 'm' });
});

test('injections and candidates of another host are never claimed', async (t) => {
  const { oc, proxy, client } = await harness(t);
  const dead = deadPid();
  writeState(statePath(hashedName('injected', 'dsh-session')), {
    'sha256:dsh': { turn: 1, injectedAt: Date.now(), strategyText: '', sessionId: 'dsh-session', pid: dead },
  });
  writeState(statePath('distill-pending.json'), { 'dsh-session': { pid: dead, at: 1, model: { provider: 'x', model: 'y' } } });

  await oc.prompt('ses_new', 'what does this repo do?');
  await oc.answer('ses_new', 'It parses JSON.');
  await oc.idle('ses_new');
  await new Promise((resolve) => { setTimeout(resolve, 100); });
  assert.deepEqual(reportsOf(proxy), []);
  assert.deepEqual(callsNamed(client, 'prompt'), []);
});
