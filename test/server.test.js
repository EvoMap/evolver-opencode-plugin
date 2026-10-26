import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readState, statePath } from '../src/state-file.js';
import {
  STRATEGY, fakeClient, freshHome, host, loadServer, proxyAnswer, requestsTo, startProxy, until,
} from './support/host.js';

const ASSET = { asset_id: 'sha256:retry', short_title: 'Retry flaky uploads', strategy: STRATEGY, similarity: 0.8 };

async function harness(t, { assets = [ASSET], options = {}, client } = {}) {
  t.after(freshHome('evolver-server-'));
  const proxy = await startProxy(proxyAnswer(assets));
  t.after(() => proxy.close());
  const loaded = await loadServer({ client, options: { proxyPort: proxy.port, assetPrimeWaitMs: 2_000, ...options } });
  return { ...loaded, proxy, oc: host(loaded.hooks) };
}

const reportsOf = (proxy) => requestsTo(proxy, '/asset/reuse-result').map((request) => request.body);
const pending = () => readState(statePath('opencode-distill-pending.json'), {});

test('the plugin registers no tool, and the evolve prompt command and the skill only through config', async (t) => {
  const { hooks } = await harness(t);
  assert.equal(hooks.tool, undefined);

  const cfg = {};
  await hooks.config(cfg);
  assert.deepEqual(Object.keys(cfg.command), ['evolver-evolve']);
  assert.doesNotMatch(cfg.command['evolver-evolve'].template, /evolver_[a-z_]+/, 'no tool the agent does not have');
  assert.equal(cfg.skills, undefined, 'no skill by default');

  const on = await loadServer({ options: { skillEnabled: true } });
  const enabled = {};
  await on.hooks.config(enabled);
  assert.match(enabled.skills.paths[0], /assets[/\\]skills[/\\]$/);
});

test('the recalled strategy is the only thing added to the prompt, behind it, as synthetic text', async (t) => {
  const { oc, proxy } = await harness(t);
  const output = await oc.prompt('ses_a', 'add a retry to the uploader');

  assert.equal(output.parts.length, 2);
  const [, part] = output.parts;
  assert.equal(part.synthetic, true);
  assert.equal(part.messageID, output.message.id);
  assert.match(part.id, /^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.match(part.text, /^\[Evolution Memory\] Retry flaky uploads \(EvoMap network\):\n1\. Run `npm test`/);
  assert.match(part.text, /\n\nApply them where they fit\.$/);
  assert.deepEqual(requestsTo(proxy, '/asset/fetch')[0].body, { text: 'add a retry to the uploader' });
});

test('a recall slower than the wait joins the prompt at the next step, while its turn runs', async (t) => {
  t.after(freshHome('evolver-late-'));
  const proxy = await startProxy(proxyAnswer([ASSET]), { delayMs: (path) => (path === '/asset/fetch' ? 150 : 0) });
  t.after(() => proxy.close());
  const { hooks } = await loadServer({ options: { proxyPort: proxy.port, assetPrimeWaitMs: 1 } });
  const oc = host(hooks);

  const output = await oc.prompt('ses_late', 'add a retry to the uploader');
  assert.equal(output.parts.length, 1, 'nothing inline');
  const messages = [{ info: { id: output.message.id }, parts: [...output.parts] }];
  await until(() => {
    hooks['experimental.chat.messages.transform']({}, { messages });
    return messages[0].parts.length === 2;
  }, 'the late strategy');
  hooks['experimental.chat.messages.transform']({}, { messages });
  assert.equal(messages[0].parts.length, 2, 'joined once');
  assert.match(messages[0].parts[1].text, /Apply them where they fit\.$/);
});

test('a completed turn reports its strategy as used with the last check, and still becomes the session candidate', async (t) => {
  const { oc, proxy } = await harness(t);
  await oc.prompt('ses_ok', 'add a retry to the uploader');
  await oc.tool('ses_ok', 'edit', { filePath: 'src/upload.js', oldString: 'a', newString: 'retry with backoff' });
  await oc.bash('ses_ok', 'npm test 2>&1 | tail -5', { exit: 0, output: 'ℹ pass 4\nℹ fail 0' });
  await oc.answer('ses_ok', 'Added a retry.');
  await oc.idle('ses_ok');
  await until(() => reportsOf(proxy).length === 1, 'the turn-end report');

  const [report] = reportsOf(proxy);
  assert.equal(report.task_id, 'opencode:ses_ok:1');
  assert.equal(report.outcome, 'success');
  assert.deepEqual(report.evidence.check, { kind: 'test', passed: true, fail_then_pass: false });
  assert.equal(report.evidence.aborted, false);
  assert.equal(report.reason, 'Injected by Evolver into OpenCode turn 1; last test passed.');
  assert.equal(report.evidence.applied, 'used');
  assert.equal(report.evidence.tier, 'L1');
  assert.equal(pending().ses_ok?.prompt, 'add a retry to the uploader', 'a turn that reused an injected strategy is distilled too');
});

test('an injected strategy is reported as used, whatever the turn did with it', async (t) => {
  const { oc, proxy } = await harness(t);
  await oc.prompt('ses_any', 'add a retry to the uploader');
  await oc.bash('ses_any', 'ls', { exit: 0, output: 'README.md' });
  await oc.answer('ses_any', 'Renamed the heading.');
  await oc.idle('ses_any');
  await until(() => reportsOf(proxy).length === 1, 'the report');
  assert.deepEqual(reportsOf(proxy)[0].evidence, { tier: 'none', applied: 'used', aborted: false, stage: 'immediate' });
});

test('a verified turn is the candidate, on the session model; a correction drops it', async (t) => {
  const { oc } = await harness(t, { assets: [] });
  await oc.prompt('ses_c', 'make the parser accept trailing commas');
  await oc.bash('ses_c', 'npm test', { exit: 0, output: 'ℹ pass 9' });
  await oc.answer('ses_c', 'The parser accepts trailing commas.');
  await oc.idle('ses_c');

  const candidate = pending().ses_c;
  assert.deepEqual(candidate.model, { providerID: 'anthropic', modelID: 'claude-sonnet' });
  assert.equal(candidate.prompt, 'make the parser accept trailing commas');
  assert.deepEqual(candidate.checks, [{ command: 'npm test', failed: false }]);
  assert.equal(candidate.pid, process.pid);

  await oc.prompt('ses_c', '不对，还是报错');
  assert.equal(pending().ses_c, undefined);
});

test('a question or praise in the next prompt keeps the candidate', async (t) => {
  const { oc } = await harness(t, { assets: [] });
  await oc.prompt('ses_q', 'make the parser accept trailing commas');
  await oc.bash('ses_q', 'npm test', { exit: 0 });
  await oc.answer('ses_q', 'Done.');
  await oc.idle('ses_q');
  await oc.prompt('ses_q', '这样不对吧？');
  assert.ok(pending().ses_q);
});

test('a turn leaves no candidate when its check failed, it ran nothing, or it did not complete', async (t) => {
  const { oc } = await harness(t, { assets: [] });
  await oc.prompt('ses_f', 'fix the build');
  await oc.bash('ses_f', 'npm run build', { exit: 2, output: 'error TS2304' });
  await oc.answer('ses_f', 'Tried.');
  await oc.idle('ses_f');
  await oc.prompt('ses_n', 'what does this repo do?');
  await oc.answer('ses_n', 'It parses JSON.');
  await oc.idle('ses_n');
  await oc.prompt('ses_x', 'fix the build');
  await oc.bash('ses_x', 'npm run build', { exit: 0 });
  await oc.answer('ses_x', 'Stopped.', { error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } });
  await oc.idle('ses_x');
  assert.deepEqual(Object.keys(pending()), []);
});

test('an interrupted turn is reported aborted, an errored one failed, both from how OpenCode ended it', async (t) => {
  const { oc, proxy } = await harness(t);
  await oc.prompt('ses_ab', 'add a retry to the uploader');
  await oc.event('session.error', { sessionID: 'ses_ab', error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } });
  await oc.idle('ses_ab');
  await oc.prompt('ses_er', 'add a retry to the uploader');
  await oc.answer('ses_er', '');
  await oc.event('session.error', { sessionID: 'ses_er', error: { name: 'APIError', data: { message: 'overloaded' } } });
  await oc.idle('ses_er');
  await oc.idle('ses_er');
  await until(() => reportsOf(proxy).length === 2, 'both reports');

  const [aborted, errored] = reportsOf(proxy);
  assert.equal(aborted.task_id, 'opencode:ses_ab:1');
  assert.equal(aborted.outcome, 'failed');
  assert.equal(aborted.evidence.aborted, true);
  assert.equal(errored.evidence.aborted, false);
  assert.equal(errored.outcome, 'failed');
});

test('a prompt sent while the session is busy joins the running turn', async (t) => {
  const { oc, proxy } = await harness(t);
  await oc.prompt('ses_busy', 'add a retry to the uploader');
  await oc.prompt('ses_busy', 'also log each attempt please');
  assert.equal(requestsTo(proxy, '/asset/fetch').length, 1);
  await oc.answer('ses_busy', 'Done.');
  await oc.idle('ses_busy');
  await until(() => reportsOf(proxy).length === 1, 'one report');
  assert.equal(reportsOf(proxy)[0].task_id, 'opencode:ses_busy:1');
});

test('turn numbers continue in a resumed session, so its reports never repeat a task id', async (t) => {
  const { oc, proxy } = await harness(t, { assets: [ASSET, { ...ASSET, asset_id: 'sha256:other', similarity: 0.7 }] });
  await oc.prompt('ses_r', 'add a retry to the uploader');
  await oc.answer('ses_r', 'Done.');
  await oc.idle('ses_r');
  const outbox = () => Object.values(readState(statePath('opencode-reports-outbox.json'), {}));
  await until(() => outbox().some((entry) => entry.sentAt), 'the first report to settle');

  const resumed = host((await loadServer({ options: { proxyPort: proxy.port, assetPrimeWaitMs: 2_000 } })).hooks);
  await resumed.prompt('ses_r', 'now add a retry to the downloader too');
  await resumed.answer('ses_r', 'Done.');
  await resumed.idle('ses_r');
  await until(() => reportsOf(proxy).length === 2, 'both reports');
  assert.deepEqual(reportsOf(proxy).map((report) => [report.task_id, report.asset_id]), [['opencode:ses_r:1', 'sha256:retry'], ['opencode:ses_r:2', 'sha256:other']]);
  assert.deepEqual(readState(statePath('opencode-turns.json'), {}).ses_r.turn, 2);
});

test('subagent and distillation-helper sessions are neither recalled for nor recorded', async (t) => {
  const client = fakeClient({ sessions: { ses_child: { id: 'ses_child', parentID: 'ses_parent' } } });
  const { oc, proxy } = await harness(t, { client });
  await oc.event('session.created', { sessionID: 'ses_help', info: { id: 'ses_help', metadata: { evolver: 'distill' } } });
  const helper = await oc.prompt('ses_help', 'Below is the record of a task an agent has just finished and verified.');
  const child = await oc.prompt('ses_child', 'search the codebase for the upload client');
  await oc.bash('ses_help', 'npm test', { exit: 0 });
  await oc.answer('ses_help', '{"summary":"x"}');
  await oc.idle('ses_help');
  await oc.idle('ses_child');

  assert.equal(helper.parts.length, 1);
  assert.equal(child.parts.length, 1);
  assert.deepEqual(requestsTo(proxy, '/asset/fetch'), []);
  assert.deepEqual(pending(), {});
});

test('/evolver-evolve hands the agent the checkpoint with its focus, and recalls nothing for it', async (t) => {
  const { hooks, oc, proxy } = await harness(t);
  const cfg = {};
  await hooks.config(cfg);
  const parts = [{ type: 'text', text: `${cfg.command['evolver-evolve'].template}\n\nthe retry path` }];
  await hooks['command.execute.before']({ command: 'evolver-evolve', sessionID: 'ses_e', arguments: ' the retry path ' }, { parts });
  assert.match(parts[0].text, /^Take a deliberate evolution step[\s\S]*\n\nFocus: the retry path$/);

  await hooks['chat.message']({ sessionID: 'ses_e' }, { message: { id: 'msg_e' }, parts });
  assert.deepEqual(requestsTo(proxy, '/asset/fetch'), []);
  await oc.idle('ses_e');
});

test('a check the person interrupted is reported as no check, not a failed one', async (t) => {
  const { oc, proxy } = await harness(t);
  await oc.prompt('ses_int', 'add a retry to the uploader');
  await oc.bash('ses_int', 'npm test', { exit: null, output: 'ℹ pass 2\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>' });
  await oc.event('session.error', { sessionID: 'ses_int', error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } });
  await oc.idle('ses_int');
  await until(() => reportsOf(proxy).length === 1, 'the report');

  const [report] = reportsOf(proxy);
  assert.equal(report.evidence.check, undefined);
  assert.equal(report.evidence.aborted, true);
  assert.equal(report.evidence.tier, 'none');
});
