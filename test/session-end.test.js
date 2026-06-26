const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const hookPath = path.resolve(__dirname, '..', 'hooks', 'session-end.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evomap-opencode-session-end-'));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_err) {
    // best effort
  }
}

function git(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test User'], dir);
}

function runHook(projectDir, stateDir, graphPath, payload = {}) {
  const result = spawnSync('node', [hookPath], {
    cwd: projectDir,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENCODE_PROJECT_DIR: projectDir,
      MEMORY_GRAPH_PATH: graphPath,
      EVOLVER_SESSION_STATE_DIR: stateDir,
      EVOLVER_SESSION_END_STDIN_WATCHDOG_MS: '100',
      EVOLVER_HOOK_LOG_DIR: path.join(stateDir, 'logs'),
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout ? JSON.parse(result.stdout) : {};
}

function readGraph(graphPath) {
  try {
    return fs.readFileSync(graphPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (_err) {
    return [];
  }
}

describe('session-end hook recording', () => {
  it('records a changed working tree once per session id', () => {
    const dir = tmpDir();
    try {
      const projectDir = path.join(dir, 'repo');
      const stateDir = path.join(dir, 'state');
      const graphPath = path.join(dir, 'memory.jsonl');
      initRepo(projectDir);
      fs.writeFileSync(path.join(projectDir, 'file.txt'), 'before\n', 'utf8');
      git(['add', 'file.txt'], projectDir);
      git(['commit', '-m', 'initial'], projectDir);
      fs.writeFileSync(path.join(projectDir, 'file.txt'), 'before\nafter\n', 'utf8');

      runHook(projectDir, stateDir, graphPath, { session_id: 'same-session' });
      runHook(projectDir, stateDir, graphPath, { session_id: 'same-session' });

      const rows = readGraph(graphPath);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].session_id, 'same-session');
      assert.equal(rows[0].diff_scope, 'working_tree');
      assert.match(rows[0].diff_hash, /^[a-f0-9]{64}$/);
    } finally {
      cleanup(dir);
    }
  });

  it('does not record prior committed changes when the working tree is clean', () => {
    const dir = tmpDir();
    try {
      const projectDir = path.join(dir, 'repo');
      const stateDir = path.join(dir, 'state');
      const graphPath = path.join(dir, 'memory.jsonl');
      initRepo(projectDir);
      fs.writeFileSync(path.join(projectDir, 'file.txt'), 'one\n', 'utf8');
      git(['add', 'file.txt'], projectDir);
      git(['commit', '-m', 'initial'], projectDir);
      fs.writeFileSync(path.join(projectDir, 'file.txt'), 'one\ntwo\n', 'utf8');
      git(['add', 'file.txt'], projectDir);
      git(['commit', '-m', 'second'], projectDir);

      runHook(projectDir, stateDir, graphPath, { session_id: 'clean-session' });

      assert.deepEqual(readGraph(graphPath), []);
    } finally {
      cleanup(dir);
    }
  });
});
