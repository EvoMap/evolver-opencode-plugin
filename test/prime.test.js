import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hubGene, promptTextOf } from '../src/prime.js';

function stubProxy(recalled) {
  const calls = [];
  const proxyFetch = async (method, path, body, signal) => {
    calls.push({ method, path, body, signal });
    if (recalled instanceof Error) throw recalled;
    return recalled === undefined ? { ok: false, error: 'nope' } : { ok: true, data: recalled };
  };
  return { proxyFetch, calls };
}

const ASSET = {
  asset_id: 'sha256:abc',
  asset_type: 'Gene',
  summary: 'Retry the upload with backoff.',
  strategy: ['  Measure the failure rate first.  ', 'Add jittered backoff.', 'Cap the retries.', 'Alert on the cap.', ''],
  validation: ['npm test'],
};

test('the prompt text is what the person typed, not OpenCode\'s synthetic parts', () => {
  const text = promptTextOf([
    { type: 'text', text: '  add a retry to the uploader  ' },
    { type: 'text', text: 'Called the Read tool with the following input: {"filePath":"a.js"}', synthetic: true },
    { type: 'file', url: 'file:///a.js', mime: 'text/plain' },
    { type: 'text', text: '   ' },
  ]);

  assert.equal(text, 'add a retry to the uploader');
});

test('keys and tokens in the prompt never leave the machine', () => {
  const text = promptTextOf([
    { type: 'text', text: 'deploy with api_key=sk-live-abcdefghijklmnop1234 and Bearer abcdefghijklmnopqrstuvwxyz' },
  ]);
  assert.doesNotMatch(text, /abcdefghijklmnop1234|abcdefghijklmnopqrstuvwxyz/);
  assert.match(text, /^deploy with /);
});

test('one call recalls by text and injects that asset\'s strategy alone', async () => {
  const { proxyFetch, calls } = stubProxy({ assets: [ASSET] });
  const controller = new AbortController();
  const { ids, text } = await hubGene(proxyFetch, 'add a retry to the uploader', { signal: controller.signal });

  assert.deepEqual(calls.map((call) => call.path), ['/asset/fetch']);
  assert.deepEqual(calls[0].body, { text: 'add a retry to the uploader' }, 'no limit: the Hub default decides');
  assert.ok(!('asset_ids' in calls[0].body), 'ids would turn the recall back into a lookup');
  assert.equal(calls[0].signal, controller.signal);
  assert.deepEqual(ids, ['sha256:abc']);
  assert.match(text, /\[Evolution Memory\] Retry the upload with backoff\. \(EvoMap network\)/);
  assert.match(text, /\n\nApply them where they fit\.$/);
  assert.doesNotMatch(text, /sha256:|evolver_|search or fetch/, 'nothing that sends the agent to a tool');
  assert.match(text, /^1\. Measure the failure rate first\.$/m);
  assert.match(text, /^4\. Alert on the cap\.$/m);
  assert.doesNotMatch(text, /npm test/);
});

test('a bounded prompt reaches the Hub, and a trivial one never does', async () => {
  const long = stubProxy({ assets: [] });
  await hubGene(long.proxyFetch, 'x'.repeat(5_000));
  assert.ok(long.calls[0].body.text.length <= 5_000);
  assert.equal('limit' in long.calls[0].body, false);

  const trivial = stubProxy({ assets: [ASSET] });
  assert.deepEqual(await hubGene(trivial.proxyFetch, 'hi'), { ids: [], text: '' });
  assert.equal(trivial.calls.length, 0);
});

test('an asset already injected this session is passed over', async () => {
  const { proxyFetch } = stubProxy({
    assets: [ASSET, { asset_id: 'sha256:next', asset_type: 'Capsule', payload: { strategy: ['Drain the queue first.', 'Replay the dead letters.', 'Re-enable the consumer.', 'Watch the depth.'] } }],
  });

  const { ids, text } = await hubGene(proxyFetch, 'add a retry to the uploader', {
    listedIds: new Set(['sha256:abc']),
  });

  assert.deepEqual(ids, ['sha256:next']);
  assert.doesNotMatch(text, /sha256:abc|Measure the failure rate/);
  assert.match(text, /\[Evolution Memory\] Capsule \(EvoMap network\)/);
  assert.match(text, /^1\. Drain the queue first\.$/m);
});

test('a failing Proxy, an empty recall, and a strategy-less asset inject nothing', async () => {
  const down = stubProxy(undefined);
  assert.deepEqual(await hubGene(down.proxyFetch, 'add a retry to the uploader'), { ids: [], text: '' });

  const throwing = stubProxy(new Error('socket hang up'));
  assert.deepEqual(await hubGene(throwing.proxyFetch, 'add a retry to the uploader'), { ids: [], text: '' });

  const empty = stubProxy({ assets: [] });
  assert.deepEqual(await hubGene(empty.proxyFetch, 'add a retry to the uploader'), { ids: [], text: '' });

  const hollow = stubProxy({ assets: [{ asset_id: 'sha256:abc', summary: 'only prose' }] });
  assert.deepEqual(await hubGene(hollow.proxyFetch, 'add a retry to the uploader'), { ids: [], text: '' });
});

test('an asset with no strategy gives way to the next one in the same answer', async () => {
  const { proxyFetch, calls } = stubProxy({
    assets: [
      { asset_id: 'sha256:prose', asset_type: 'Gene', similarity: 0.98, summary: 'Nothing to reuse here.' },
      { asset_id: 'sha256:usable', asset_type: 'Gene', similarity: 0.71, strategy: ['Use the one that carries steps.', 'Then the next.', 'Then the next.', 'Then the last.'] },
    ],
  });

  const { ids, text } = await hubGene(proxyFetch, 'add a retry to the uploader');
  assert.equal(calls.length, 1, 'the fallback costs no second round trip');
  assert.deepEqual(ids, ['sha256:usable']);
  assert.match(text, /^1\. Use the one that carries steps\.$/m);
  assert.doesNotMatch(text, /sha256:prose/);
});

test('a topical but low-similarity asset is dropped', async () => {
  const { proxyFetch } = stubProxy({
    assets: [{ asset_id: 'sha256:loose', similarity: 0.22, short_title: '小红书内容创作工作流', strategy: ['先定选题。', '再写标题。', '再写正文。', '最后配图。'] }],
  });

  assert.deepEqual(await hubGene(proxyFetch, 'add a retry to the uploader'), { ids: [], text: '' });
});

test('the similarity line is configurable, and a Proxy that omits the score still answers', async () => {
  const scored = stubProxy({ assets: [{ ...ASSET, similarity: 0.35 }] });
  const { ids } = await hubGene(scored.proxyFetch, 'add a retry to the uploader', { minSimilarity: 0.3 });
  assert.deepEqual(ids, ['sha256:abc']);

  const unscored = stubProxy({ assets: [ASSET] });
  assert.deepEqual((await hubGene(unscored.proxyFetch, 'add a retry to the uploader')).ids, ['sha256:abc']);
});

test('the best-scoring asset wins, whatever order the Hub listed them in', async () => {
  const { proxyFetch } = stubProxy({
    assets: [
      { asset_id: 'sha256:middling', asset_type: 'Gene', similarity: 0.62, strategy: ['Middling.', 'Middling.', 'Middling.', 'Middling.'] },
      { asset_id: 'sha256:closest', asset_type: 'Gene', similarity: 0.94, strategy: ['Take the closest match.', 'Then the next.', 'Then the next.', 'Then the last.'] },
      { asset_id: 'sha256:weak', asset_type: 'Gene', similarity: 0.51, strategy: ['Weak.', 'Weak.', 'Weak.', 'Weak.'] },
    ],
  });

  const { ids, text } = await hubGene(proxyFetch, 'add a retry to the uploader');
  assert.deepEqual(ids, ['sha256:closest']);
  assert.match(text, /^1\. Take the closest match\.$/m);
});

test('an unscored asset is still usable, but never outranks a scored one', async () => {
  const { proxyFetch } = stubProxy({
    assets: [
      { asset_id: 'sha256:unscored', asset_type: 'Gene', strategy: ['Unmeasured.', 'Unmeasured.', 'Unmeasured.', 'Unmeasured.'] },
      { asset_id: 'sha256:scored', asset_type: 'Gene', similarity: 0.55, strategy: ['Prefer the measured match.', 'Then the next.', 'Then the next.', 'Then the last.'] },
    ],
  });

  assert.deepEqual((await hubGene(proxyFetch, 'add a retry to the uploader')).ids, ['sha256:scored']);
});

test('a named gene is announced by its name, and its hash only where it gets used', async () => {
  const { proxyFetch } = stubProxy({
    assets: [{
      asset_id: 'sha256:named', asset_type: 'Gene', similarity: 0.9,
      short_title: 'Chinese Social Media Writing Template',
      nl_summary: 'A long explanation that has no business being in front of the model on every turn.'.repeat(3),
      summary: 'Also long, also not the header.',
      strategy: ['Draft it.', 'Edit it.', 'Check it.', 'Ship it.'],
    }],
  });

  const { text } = await hubGene(proxyFetch, 'add a retry to the uploader');

  assert.match(text, /^\[Evolution Memory\] Chinese Social Media Writing Template \(EvoMap network\):$/m);
  assert.doesNotMatch(text.split('\n')[0], /sha256:/, 'the hash is not what the header is for');
  assert.doesNotMatch(text, /no business being in front of the model|Also long/);
});

test('an asset with neither a name nor a description falls back to its type', async () => {
  const { proxyFetch } = stubProxy({
    assets: [{ asset_id: 'sha256:plain', asset_type: 'Capsule', similarity: 0.9, strategy: ['Do it.', 'Do it.', 'Do it.', 'Do it.'] }],
  });

  const { text } = await hubGene(proxyFetch, 'add a retry to the uploader');
  assert.match(text, /^\[Evolution Memory\] Capsule \(EvoMap network\):$/m);
});

test('a one-word title is a truncation, not a name, so the summary stands in', async () => {
  const { proxyFetch } = stubProxy({
    assets: [{
      asset_id: 'sha256:fragment', asset_type: 'Gene', similarity: 0.9,
      short_title: 'Object',
      nl_summary: 'A generic object pool for reusing expensive resources such as database connections, so they are not rebuilt per request.',
      strategy: ['Initialize the pool.', 'Size it.', 'Lend from it.', 'Return to it.'],
    }],
  });

  const { text } = await hubGene(proxyFetch, 'reuse database connections');
  const header = text.split('\n')[0];

  assert.doesNotMatch(header, /\] Object \(/, 'Object is what got truncated, not what the gene is');
  assert.match(header, /A generic object pool for reusing expensive resources/);
  assert.ok(header.length <= 120, 'the stand-in is a name-length excerpt, not the whole summary');
});

test('a short CJK title is a name, and is not mistaken for a fragment', async () => {
  const { proxyFetch } = stubProxy({
    assets: [{
      asset_id: 'sha256:cjk', asset_type: 'Gene', similarity: 0.9,
      short_title: '智能缓存优化',
      nl_summary: '这个基因用于优化缓存命中率。',
      strategy: ['预热缓存。', '设置淘汰策略。', '监控命中率。', '定期复查。'],
    }],
  });

  const { text } = await hubGene(proxyFetch, '这个服务的缓存命中率太低了，帮我优化一下');
  assert.match(text.split('\n')[0], /^\[Evolution Memory\] 智能缓存优化 \(EvoMap network\):$/);
});

test('a truncated CJK title gives way to the summary as well', async () => {
  const { proxyFetch } = stubProxy({
    assets: [{
      asset_id: 'sha256:cut', asset_type: 'Gene', similarity: 0.9,
      short_title: '自动化小',
      nl_summary: '这个基因能自动帮你创作小红书笔记并一键发布。',
      strategy: ['先定选题。', '再写标题。', '再写正文。', '最后配图。'],
    }],
  });

  const { text } = await hubGene(proxyFetch, '帮我写一篇小红书的种草笔记');
  assert.match(text.split('\n')[0], /这个基因能自动帮你创作小红书笔记/);
});

test('the Hub\'s own envelope shapes are all read', async () => {
  const nested = stubProxy({ payload: { results: [ASSET] } });
  assert.deepEqual((await hubGene(nested.proxyFetch, 'add a retry to the uploader')).ids, ['sha256:abc']);

  const results = stubProxy({ results: [ASSET] });
  assert.deepEqual((await hubGene(results.proxyFetch, 'add a retry to the uploader')).ids, ['sha256:abc']);
});

test('a strategy too thin or too long to reuse gives way to one that fits', async () => {
  const fits = ['Read the plan.', 'Apply it.', 'Check it.', 'Record it.'];
  const { proxyFetch, calls } = stubProxy({
    assets: [
      { asset_id: 'sha256:thin', asset_type: 'Gene', similarity: 0.99, strategy: ['Try harder.', 'Ship it.', 'Hope.'] },
      { asset_id: 'sha256:transcript', asset_type: 'Capsule', similarity: 0.95, strategy: Array.from({ length: 21 }, (step, index) => `Pipeline step ${index}. ${'x'.repeat(240)}`) },
      { asset_id: 'sha256:fits', asset_type: 'Gene', similarity: 0.5, strategy: fits },
    ],
  });

  const { ids, text } = await hubGene(proxyFetch, 'add a retry to the uploader');
  assert.equal(calls.length, 1, 'both rejections are read off the one answer');
  assert.deepEqual(ids, ['sha256:fits']);
  assert.match(text, /^4\. Record it\.$/m);
  assert.doesNotMatch(text, /Pipeline step|Try harder/);
});

test('the bounds are inclusive at both ends', async () => {
  const four = stubProxy({ assets: [{ asset_id: 'sha256:four', asset_type: 'Gene', strategy: ['a.', 'b.', 'c.', 'd.'] }] });
  assert.deepEqual((await hubGene(four.proxyFetch, 'add a retry to the uploader')).ids, ['sha256:four']);

  const atBudget = Array.from({ length: 10 }, () => 'y'.repeat(400));
  const full = stubProxy({ assets: [{ asset_id: 'sha256:full', asset_type: 'Gene', strategy: atBudget }] });
  assert.deepEqual((await hubGene(full.proxyFetch, 'add a retry to the uploader')).ids, ['sha256:full']);

  const over = stubProxy({ assets: [{ asset_id: 'sha256:over', asset_type: 'Gene', strategy: [...atBudget, 'z'] }] });
  assert.deepEqual((await hubGene(over.proxyFetch, 'add a retry to the uploader')).ids, []);
});

test('a broad prompt whose genes all run past eight steps still gets one injected', async () => {
  const fifteen = Array.from({ length: 15 }, (step, index) => `Step ${index}: write, shoot, edit and post one part of the note.`);
  const { proxyFetch } = stubProxy({
    assets: [
      { asset_id: 'sha256:twenty-two', asset_type: 'Gene', strategy: Array.from({ length: 22 }, (step, index) => `Stage ${index}. ${'w'.repeat(300)}`) },
      { asset_id: 'sha256:fifteen', asset_type: 'Gene', strategy: fifteen },
    ],
  });

  const { ids, text } = await hubGene(proxyFetch, '我想在小红书种草，文案、修图、拍视频、讲故事都要教我');
  assert.deepEqual(ids, ['sha256:fifteen']);
  assert.match(text, /^15\. Step 14: /m);
});
