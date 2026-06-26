const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const plugin = require('../server');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evomap-opencode-plugin-'));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_err) {
    // best effort
  }
}

function writeHookScripts(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const recorder = `
const fs = require('node:fs');
const path = process.env.RECORD_FILE;
const raw = fs.readFileSync(0, 'utf8');
const payload = JSON.parse(raw || '{}');
const script = require('node:path').basename(__filename);
const row = { script, payload, cwd: process.cwd(), envProject: process.env.OPENCODE_PROJECT_DIR };
fs.appendFileSync(path, JSON.stringify(row) + '\\n');
if (script === 'session-start.js') {
  process.stdout.write(JSON.stringify({ additionalContext: 'memory for ' + payload.session_id }));
} else {
  process.stdout.write('{}');
}
`;
  for (const name of ['session-start.js', 'session-end.js', 'signal-detect.js']) {
    fs.writeFileSync(path.join(dir, name), recorder, 'utf8');
  }
}

function readRecords(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('OpenCode server plugin exports', () => {
  it('exports named and default Evolver functions', () => {
    assert.equal(typeof plugin.Evolver, 'function');
    assert.equal(plugin.default, plugin.Evolver);
  });

  it('creates an OpenCode hooks object', async () => {
    const hooks = await plugin.Evolver({});
    assert.equal(typeof hooks.event, 'function');
    assert.equal(typeof hooks['tool.execute.after'], 'function');
  });
});

describe('OpenCode event wiring', () => {
  it('maps session.created, write/edit tools, and session.deleted to hook scripts', async () => {
    const dir = tmpDir();
    const hooksDir = path.join(dir, 'hooks');
    const recordFile = path.join(dir, 'records.jsonl');
    const projectDir = path.join(dir, 'project');
    fs.mkdirSync(projectDir);
    writeHookScripts(hooksDir);

    const oldHooksDir = process.env.EVOLVER_OPENCODE_HOOKS_DIR;
    const oldRecord = process.env.RECORD_FILE;
    const oldSignalTimeout = process.env.EVOLVER_OPENCODE_SIGNAL_TIMEOUT_MS;
    try {
      process.env.EVOLVER_OPENCODE_HOOKS_DIR = hooksDir;
      process.env.RECORD_FILE = recordFile;
      process.env.EVOLVER_OPENCODE_SIGNAL_TIMEOUT_MS = '15000';
      const hooks = await plugin.Evolver({ directory: projectDir });

      await hooks.event({
        event: {
          type: 'session.created',
          properties: { info: { id: 's1' } },
        },
      });
      await hooks['tool.execute.after'](
        { tool: 'write', args: { file_path: 'a.js', content: 'TODO optimize' } },
        { output: { ok: true } }
      );
      await hooks['tool.execute.after'](
        { tool: 'read', args: { file_path: 'a.js' } },
        { output: 'ignored' }
      );
      await hooks.event({
        event: {
          type: 'session.deleted',
          properties: { sessionID: 's1' },
        },
      });

      const records = readRecords(recordFile);
      assert.deepEqual(records.map((r) => r.script), [
        'session-start.js',
        'signal-detect.js',
        'session-end.js',
      ]);
      assert.equal(records[0].payload.session_id, 's1');
      assert.equal(records[1].payload.tool_input.file_path, 'a.js');
      assert.equal(fs.realpathSync(records[0].cwd), fs.realpathSync(projectDir));
      assert.equal(fs.realpathSync(records[0].envProject), fs.realpathSync(projectDir));
    } finally {
      if (oldHooksDir === undefined) delete process.env.EVOLVER_OPENCODE_HOOKS_DIR;
      else process.env.EVOLVER_OPENCODE_HOOKS_DIR = oldHooksDir;
      if (oldRecord === undefined) delete process.env.RECORD_FILE;
      else process.env.RECORD_FILE = oldRecord;
      if (oldSignalTimeout === undefined) delete process.env.EVOLVER_OPENCODE_SIGNAL_TIMEOUT_MS;
      else process.env.EVOLVER_OPENCODE_SIGNAL_TIMEOUT_MS = oldSignalTimeout;
      cleanup(dir);
    }
  });

  it('injects recalled memory into OpenCode compaction context', async () => {
    const dir = tmpDir();
    const hooksDir = path.join(dir, 'hooks');
    const recordFile = path.join(dir, 'records.jsonl');
    const projectDir = path.join(dir, 'project');
    fs.mkdirSync(projectDir);
    writeHookScripts(hooksDir);

    const oldHooksDir = process.env.EVOLVER_OPENCODE_HOOKS_DIR;
    const oldRecord = process.env.RECORD_FILE;
    try {
      process.env.EVOLVER_OPENCODE_HOOKS_DIR = hooksDir;
      process.env.RECORD_FILE = recordFile;
      const hooks = await plugin.Evolver({ directory: projectDir });
      const output = { context: [] };

      await hooks.event({
        event: {
          type: 'session.created',
          properties: { info: { id: 's2' } },
        },
      });
      await hooks['experimental.session.compacting']({ session_id: 's2' }, output);

      assert.equal(output.context.length, 1);
      assert.match(output.context[0], /Evolver Memory/);
      assert.match(output.context[0], /memory for s2/);
    } finally {
      if (oldHooksDir === undefined) delete process.env.EVOLVER_OPENCODE_HOOKS_DIR;
      else process.env.EVOLVER_OPENCODE_HOOKS_DIR = oldHooksDir;
      if (oldRecord === undefined) delete process.env.RECORD_FILE;
      else process.env.RECORD_FILE = oldRecord;
      cleanup(dir);
    }
  });
});

describe('private helpers', () => {
  it('normalizes write tool names', () => {
    assert.equal(plugin._private.normalizeToolName({ tool: 'Write' }), 'write');
    assert.ok(plugin._private.WRITE_TOOLS.has('write'));
    assert.ok(plugin._private.WRITE_TOOLS.has('edit'));
  });
});
