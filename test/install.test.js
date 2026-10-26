import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { TUI_ENTRY, install, paths, uninstall, verify } from '../scripts/install.js';

function configRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-opencode-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a local install writes the server delegate and lists the TUI plugin, and verifies', async (t) => {
  const dir = configRoot(t);
  const report = install({ configRoot: dir, force: false });
  assert.equal(report.ok, true);

  const p = paths(dir);
  const { default: plugin } = await import(p.pluginPath);
  assert.equal(plugin.id, 'evomap.evolver');
  assert.equal(typeof plugin.server, 'function');
  assert.deepEqual(JSON.parse(fs.readFileSync(p.tuiConfigPath, 'utf8')).plugin, [TUI_ENTRY]);

  const verified = await verify({ configRoot: dir });
  assert.equal(verified.ok, true, JSON.stringify(verified, null, 2));
});

test('installing twice lists the TUI plugin once and keeps the rest of tui.json', (t) => {
  const dir = configRoot(t);
  const p = paths(dir);
  fs.mkdirSync(path.dirname(p.tuiConfigPath), { recursive: true });
  fs.writeFileSync(p.tuiConfigPath, JSON.stringify({ theme: 'opencode', plugin: ['other-plugin'] }));
  install({ configRoot: dir, force: false });
  install({ configRoot: dir, force: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(p.tuiConfigPath, 'utf8')), { theme: 'opencode', plugin: ['other-plugin', TUI_ENTRY] });
});

test('a user-owned plugin file is not overwritten without --force', (t) => {
  const dir = configRoot(t);
  const p = paths(dir);
  fs.mkdirSync(path.dirname(p.pluginPath), { recursive: true });
  fs.writeFileSync(p.pluginPath, 'export default {};\n');
  assert.equal(install({ configRoot: dir, force: false }).ok, false);
  assert.equal(install({ configRoot: dir, force: true }).ok, true);
});

test('the Evolver section an older install wrote into AGENTS.md is removed', (t) => {
  const dir = configRoot(t);
  const p = paths(dir);
  fs.writeFileSync(p.agentsMdPath, '# Project\n\n<!-- evolver-opencode-evolution-memory -->\nCall evolver_status.\n<!-- /evolver-opencode-evolution-memory -->\n');
  install({ configRoot: dir, force: false });
  assert.equal(fs.readFileSync(p.agentsMdPath, 'utf8'), '# Project\n');
});

test('uninstall removes only what the installer owns', (t) => {
  const dir = configRoot(t);
  const p = paths(dir);
  install({ configRoot: dir, force: false });
  fs.writeFileSync(p.tuiConfigPath, JSON.stringify({ plugin: ['other-plugin', TUI_ENTRY] }));
  assert.equal(uninstall({ configRoot: dir }).removed, true);
  assert.equal(fs.existsSync(p.pluginPath), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.tuiConfigPath, 'utf8')).plugin, ['other-plugin']);
});

test('an old Evolver section without its end marker is left alone, with what follows it', (t) => {
  const dir = configRoot(t);
  const p = paths(dir);
  const content = '# Project\n\n<!-- evolver-opencode-evolution-memory -->\nCall evolver_status.\n\n## Build\nnpm test\n';
  fs.writeFileSync(p.agentsMdPath, content);
  install({ configRoot: dir, force: false });
  assert.equal(fs.readFileSync(p.agentsMdPath, 'utf8'), content);
});

test('a tui.json whose top level is not an object is reported and left as it is', (t) => {
  const dir = configRoot(t);
  const p = paths(dir);
  fs.mkdirSync(path.dirname(p.tuiConfigPath), { recursive: true });
  fs.writeFileSync(p.tuiConfigPath, 'null');
  const report = install({ configRoot: dir, force: false });
  assert.equal(report.ok, true);
  assert.match(report.warning, /not changed/);
  assert.equal(fs.readFileSync(p.tuiConfigPath, 'utf8'), 'null');
  assert.equal(uninstall({ configRoot: dir }).removed, true);
});
