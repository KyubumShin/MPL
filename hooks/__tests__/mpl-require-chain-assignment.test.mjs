import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import {
  isChainSeedEnabled,
  chainAssignmentExists,
} from '../mpl-require-chain-assignment.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-require-chain-assignment.mjs');

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'mpl-req-chain-'));
  mkdirSync(join(dir, '.mpl'), { recursive: true });
  // Minimal active-state file so isMplActive returns true.
  writeFileSync(
    join(dir, '.mpl', 'state.json'),
    JSON.stringify({ current_phase: 'mpl-decompose', pipeline_id: 'mpl-test' }),
  );
  return dir;
}

function writeConfig(dir, cfg) {
  writeFileSync(join(dir, '.mpl', 'config.json'), JSON.stringify(cfg));
}

function writeChainAssignment(dir, body = 'chains: []\n') {
  mkdirSync(join(dir, '.mpl', 'mpl'), { recursive: true });
  writeFileSync(join(dir, '.mpl', 'mpl', 'chain-assignment.yaml'), body);
}

function runHook(cwd, payload) {
  const result = spawnSync('node', [HOOK_PATH], {
    cwd,
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    timeout: 5000,
  });
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    parsed: result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null,
  };
}

describe('isChainSeedEnabled', () => {
  let dir;
  beforeEach(() => { dir = makeProject(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns false when config.json is absent', () => {
    assert.strictEqual(isChainSeedEnabled(dir), false);
  });

  it('returns false when chain_seed key is missing', () => {
    writeConfig(dir, { max_fix_loops: 10 });
    assert.strictEqual(isChainSeedEnabled(dir), false);
  });

  it('returns false when chain_seed.enabled is false', () => {
    writeConfig(dir, { chain_seed: { enabled: false } });
    assert.strictEqual(isChainSeedEnabled(dir), false);
  });

  it('returns true when chain_seed.enabled is exactly true', () => {
    writeConfig(dir, { chain_seed: { enabled: true } });
    assert.strictEqual(isChainSeedEnabled(dir), true);
  });

  it('returns false on malformed config (graceful)', () => {
    writeFileSync(join(dir, '.mpl', 'config.json'), 'not json{{{');
    assert.strictEqual(isChainSeedEnabled(dir), false);
  });

  it('returns false when chain_seed.enabled is a truthy non-boolean (strict equality)', () => {
    writeConfig(dir, { chain_seed: { enabled: 1 } });
    assert.strictEqual(isChainSeedEnabled(dir), false);
  });
});

describe('chainAssignmentExists', () => {
  let dir;
  beforeEach(() => { dir = makeProject(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns false when the file is missing', () => {
    assert.strictEqual(chainAssignmentExists(dir), false);
  });

  it('returns true when the file exists', () => {
    writeChainAssignment(dir);
    assert.strictEqual(chainAssignmentExists(dir), true);
  });
});

describe('mpl-require-chain-assignment hook (AP-CHAIN-01 enforcement)', () => {
  let dir;
  beforeEach(() => { dir = makeProject(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('allows when chain_seed.enabled=false (inline mode, AP-SEED-01 exempt)', () => {
    writeConfig(dir, { chain_seed: { enabled: false } });
    const r = runHook(dir, {
      cwd: dir,
      tool_name: 'Task',
      tool_input: { subagent_type: 'mpl-seed-generator' },
    });
    assert.strictEqual(r.parsed.continue, true);
    assert.strictEqual(r.parsed.suppressOutput, true);
  });

  it('allows when chain_seed.enabled=true AND chain-assignment.yaml exists', () => {
    writeConfig(dir, { chain_seed: { enabled: true } });
    writeChainAssignment(dir);
    const r = runHook(dir, {
      cwd: dir,
      tool_name: 'Task',
      tool_input: { subagent_type: 'mpl-seed-generator' },
    });
    assert.strictEqual(r.parsed.continue, true);
  });

  it('denies when chain_seed.enabled=true AND chain-assignment.yaml missing', () => {
    writeConfig(dir, { chain_seed: { enabled: true } });
    const r = runHook(dir, {
      cwd: dir,
      tool_name: 'Task',
      tool_input: { subagent_type: 'mpl-seed-generator' },
    });
    assert.strictEqual(r.parsed.continue, false);
    assert.strictEqual(r.parsed.decision, 'block');
    assert.match(r.parsed.reason, /AP-CHAIN-01/);
    assert.match(r.parsed.reason, /chain-assignment\.yaml/);
    assert.match(r.parsed.reason, /Step 3-G/);
  });

  it('accepts the mpl:mpl-seed-generator plugin-prefixed subagent name', () => {
    writeConfig(dir, { chain_seed: { enabled: true } });
    const r = runHook(dir, {
      cwd: dir,
      tool_name: 'Task',
      tool_input: { subagent_type: 'mpl:mpl-seed-generator' },
    });
    assert.strictEqual(r.parsed.continue, false);
    assert.match(r.parsed.reason, /AP-CHAIN-01/);
  });

  it('ignores dispatches to other subagents', () => {
    writeConfig(dir, { chain_seed: { enabled: true } });
    // chain-assignment.yaml deliberately missing — would deny seed-generator,
    // but non-seed subagents must pass through unconditionally.
    const r = runHook(dir, {
      cwd: dir,
      tool_name: 'Task',
      tool_input: { subagent_type: 'mpl-decomposer' },
    });
    assert.strictEqual(r.parsed.continue, true);
  });

  it('ignores non-Task/Agent tool calls', () => {
    writeConfig(dir, { chain_seed: { enabled: true } });
    const r = runHook(dir, {
      cwd: dir,
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
    });
    assert.strictEqual(r.parsed.continue, true);
  });

  it('allows when MPL is inactive (no state.json)', () => {
    rmSync(join(dir, '.mpl', 'state.json'));
    writeConfig(dir, { chain_seed: { enabled: true } });
    const r = runHook(dir, {
      cwd: dir,
      tool_name: 'Task',
      tool_input: { subagent_type: 'mpl-seed-generator' },
    });
    assert.strictEqual(r.parsed.continue, true);
  });

  it('allows on empty stdin (defensive default)', () => {
    const result = spawnSync('node', [HOOK_PATH], {
      cwd: dir,
      input: '',
      encoding: 'utf-8',
      timeout: 5000,
    });
    const parsed = JSON.parse(result.stdout.trim());
    assert.strictEqual(parsed.continue, true);
  });

  it('allows on malformed stdin (never wedges the pipeline)', () => {
    const result = spawnSync('node', [HOOK_PATH], {
      cwd: dir,
      input: 'not json{{{',
      encoding: 'utf-8',
      timeout: 5000,
    });
    const parsed = JSON.parse(result.stdout.trim());
    assert.strictEqual(parsed.continue, true);
  });
});
