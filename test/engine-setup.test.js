import assert from 'node:assert/strict';
import { test } from 'node:test';

import { prepareEngine, setupNoticeText } from '../src/engine-setup.js';

function machine({ versions, reachable = false, failing = [] }) {
  const calls = [];
  const left = [...versions];
  return {
    calls,
    probeVersion: async () => left.shift() ?? null,
    isProxyReachable: async () => reachable,
    run: async (command, args) => {
      const line = [command, ...args].join(' ');
      calls.push(line);
      return failing.some((prefix) => line.startsWith(prefix)) ? { ok: false, error: `${command} failed` } : { ok: true, error: null };
    },
  };
}

test('a current Evolver with its Proxy serving needs nothing', async () => {
  const host = machine({ versions: ['2.0.39'], reachable: true });
  assert.deepEqual(await prepareEngine(host), { status: 'ready', version: '2.0.39' });
  assert.deepEqual(host.calls, []);
  assert.equal(setupNoticeText({ status: 'ready' }), null);
});

test('a current Evolver whose Proxy is down is started', async () => {
  const host = machine({ versions: ['2.0.42'] });
  assert.deepEqual(await prepareEngine(host), { status: 'started', version: '2.0.42' });
  assert.deepEqual(host.calls, ['evolver lifecycle start']);
});

test('a start that fails is reported', async () => {
  const host = machine({ versions: ['2.0.42'], failing: ['evolver lifecycle'] });
  const outcome = await prepareEngine(host);
  assert.deepEqual(outcome, { status: 'start_failed', version: '2.0.42', error: 'evolver failed' });
  assert.match(setupNoticeText(outcome), /`evolver lifecycle start` failed \(evolver failed\)/);
});

test('an old Evolver is upgraded and restarted; a missing one is installed and started', async () => {
  const old = machine({ versions: ['2.0.38', '2.0.42'], reachable: true });
  assert.deepEqual(await prepareEngine(old), { status: 'upgraded', previous: '2.0.38', version: '2.0.42' });
  assert.deepEqual(old.calls, ['npm install -g @evomap/evolver@latest', 'evolver lifecycle restart']);

  const missing = machine({ versions: [null, '2.0.42'] });
  assert.deepEqual(await prepareEngine(missing), { status: 'installed', previous: null, version: '2.0.42' });
  assert.deepEqual(missing.calls, ['npm install -g @evomap/evolver@latest', 'evolver lifecycle start']);
});

test('an install that fails, or leaves an old evolver first on PATH, is reported with the manual steps', async () => {
  const denied = await prepareEngine(machine({ versions: [null], failing: ['npm'] }));
  assert.deepEqual(denied, { status: 'install_failed', previous: null, version: null, error: 'npm failed' });
  assert.match(setupNoticeText(denied), /Evolver is not installed and installing the latest release failed \(npm failed\)\. Run `npm install -g @evomap\/evolver@latest`, then `evolver lifecycle start`\./);

  const shadowed = await prepareEngine(machine({ versions: ['2.0.30', '2.0.30'] }));
  assert.equal(shadowed.status, 'install_failed');
  assert.equal(shadowed.error, 'npm installed 2.0.30');
});

test('an upgrade whose Proxy did not restart says so', async () => {
  const outcome = await prepareEngine(machine({ versions: ['2.0.38', '2.0.42'], failing: ['evolver lifecycle'] }));
  assert.equal(outcome.startError, 'evolver failed');
  assert.match(setupNoticeText(outcome), /upgraded it to 2\.0\.42, but its Proxy did not start \(evolver failed\); run `evolver lifecycle start`\./);
});
