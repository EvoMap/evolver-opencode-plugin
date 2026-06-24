const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const installer = require('../scripts/install');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evomap-opencode-install-'));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_err) {
    // best effort
  }
}

describe('local-file installer', () => {
  it('installs a managed delegate plugin and verifies it', () => {
    const dir = tmpDir();
    try {
      const report = installer.install({ configRoot: dir, force: false });
      assert.equal(report.ok, true);

      const p = installer.paths(dir);
      assert.ok(fs.existsSync(p.pluginPath));
      assert.ok(fs.readFileSync(p.pluginPath, 'utf8').includes('_evolver_managed: true'));
      assert.ok(fs.readFileSync(p.agentsMdPath, 'utf8').includes(installer.EVOLVER_MARKER));

      const mod = require(p.pluginPath);
      assert.equal(typeof mod.Evolver, 'function');

      const verify = installer.verify({ configRoot: dir });
      assert.equal(verify.ok, true, JSON.stringify(verify, null, 2));
    } finally {
      cleanup(dir);
    }
  });

  it('refuses to overwrite a user-owned plugin without force', () => {
    const dir = tmpDir();
    try {
      const p = installer.paths(dir);
      fs.mkdirSync(path.dirname(p.pluginPath), { recursive: true });
      fs.writeFileSync(p.pluginPath, 'module.exports = {};\n', 'utf8');
      const report = installer.install({ configRoot: dir, force: false });
      assert.equal(report.ok, false);
      assert.match(report.error, /refusing to overwrite/);
    } finally {
      cleanup(dir);
    }
  });

  it('uninstalls only managed files and AGENTS.md section', () => {
    const dir = tmpDir();
    try {
      installer.install({ configRoot: dir, force: false });
      const p = installer.paths(dir);
      const report = installer.uninstall({ configRoot: dir });
      assert.equal(report.ok, true);
      assert.equal(report.removed, true);
      assert.ok(!fs.existsSync(p.pluginPath));
      assert.ok(!fs.readFileSync(p.agentsMdPath, 'utf8').includes(installer.EVOLVER_MARKER));
    } finally {
      cleanup(dir);
    }
  });

  it('reports verify failure before install', () => {
    const dir = tmpDir();
    try {
      const report = installer.verify({ configRoot: dir });
      assert.equal(report.ok, false);
      const failed = report.checks.filter((check) => !check.ok).map((check) => check.id);
      assert.ok(failed.includes('plugin_file_present'));
      assert.ok(failed.includes('plugin_loadable'));
    } finally {
      cleanup(dir);
    }
  });
});
