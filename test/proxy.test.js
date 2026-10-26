import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createProxyClient, isLoopbackUrl } from '../src/proxy.js';

test('only a loopback HTTP url without credentials is trusted with the bearer token', () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:19820'), true);
  assert.equal(isLoopbackUrl('http://localhost:19820'), true);
  assert.equal(isLoopbackUrl('https://worker.localhost:19820'), true);
  assert.equal(isLoopbackUrl('http://[::1]:19820'), true);
  assert.equal(isLoopbackUrl('https://collector.example.com'), false);
  assert.equal(isLoopbackUrl('http://127.0.0.1.evil.example'), false);
  assert.equal(isLoopbackUrl('ftp://127.0.0.1/resource'), false);
  assert.equal(isLoopbackUrl('http://user:secret@127.0.0.1:19820'), false);
  assert.equal(isLoopbackUrl('not a url'), false);
});

test('a cancelled call aborts the request instead of reporting the Proxy down', async () => {
  const original = globalThis.fetch;
  const rejectOnAbort = (signal) =>
    new Promise((_resolve, reject) => {
      const fail = () => reject(new DOMException('aborted', 'AbortError'));
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail);
    });
  globalThis.fetch = (_url, options) => rejectOnAbort(options.signal);

  try {
    const proxyFetch = createProxyClient({ port: '19820' });
    const result = await proxyFetch('GET', '/proxy/status', undefined, AbortSignal.abort());
    assert.deepEqual(result, { ok: false, error: 'Proxy request cancelled.' });
  } finally {
    globalThis.fetch = original;
  }
});
