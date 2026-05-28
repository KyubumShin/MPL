import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

async function loadModule() {
  const url = new URL(`../dist/lib/state-manager.js?t=${Date.now()}-${Math.random()}`, import.meta.url);
  return import(url.href);
}

describe('state-manager ring buffer (P1-3a)', () => {
  let tmpDir;
  let originalStderrWrite;
  let stderrCaptured;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mpl-state-mgr-test-'));
    stderrCaptured = '';
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      stderrCaptured += chunk;
      return true;
    };
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exports MAX_AMBIGUITY_HISTORY equal to hooks-side value', async () => {
    const mod = await loadModule();
    assert.strictEqual(mod.MAX_AMBIGUITY_HISTORY, 10);
  });

  it('caps ambiguity_history at MAX_AMBIGUITY_HISTORY and logs truncation', async () => {
    const mod = await loadModule();
    const overflow = mod.MAX_AMBIGUITY_HISTORY + 4;
    const entries = Array.from({ length: overflow }, (_, i) => ({
      round: i + 1,
      score: 0.4,
      weakest_dimension: 'pp_conformance',
      ts: `t-${i}`,
    }));
    mod.writeState(tmpDir, { current_phase: 'mpl-ambiguity-resolve', ambiguity_history: entries });
    const raw = JSON.parse(readFileSync(join(tmpDir, '.mpl', 'state.json'), 'utf-8'));
    assert.strictEqual(raw.ambiguity_history.length, mod.MAX_AMBIGUITY_HISTORY);
    assert.strictEqual(raw.ambiguity_history[0].round, overflow - mod.MAX_AMBIGUITY_HISTORY + 1);
    assert.strictEqual(raw.ambiguity_history.at(-1).round, overflow);
    assert.match(stderrCaptured, /ambiguity_history ring-buffer truncated 4 oldest entries/);
  });

  it('leaves ambiguity_history untouched when at or below cap', async () => {
    const mod = await loadModule();
    const entries = Array.from({ length: mod.MAX_AMBIGUITY_HISTORY }, (_, i) => ({
      round: i + 1, score: 0.2, weakest_dimension: 'spec_completeness', ts: `t-${i}`,
    }));
    mod.writeState(tmpDir, { current_phase: 'mpl-ambiguity-resolve', ambiguity_history: entries });
    const raw = JSON.parse(readFileSync(join(tmpDir, '.mpl', 'state.json'), 'utf-8'));
    assert.strictEqual(raw.ambiguity_history.length, mod.MAX_AMBIGUITY_HISTORY);
    assert.strictEqual(stderrCaptured, '');
  });
});

describe('writeState Phase 0 artifact invariant (#223)', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mpl-state-mgr-i13-'));
  });
  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupPhase0(dir, { rawScan = true, designIntent = true, contracts = true } = {}) {
    const phase0 = join(dir, '.mpl', 'mpl', 'phase0');
    mkdirSync(phase0, { recursive: true });
    if (rawScan) writeFileSync(join(phase0, 'raw-scan.md'), '# raw-scan');
    if (designIntent) writeFileSync(join(phase0, 'design-intent.yaml'), 'invariants: []');
    if (contracts) {
      mkdirSync(join(dir, '.mpl', 'contracts'), { recursive: true });
      writeFileSync(join(dir, '.mpl', 'contracts', '_no-boundaries.json'), '{}');
    }
  }

  it('rejects a state-write proposing a protected current_phase when Phase 0 artifacts are missing', async () => {
    const mod = await loadModule();
    // No Phase 0 artifacts at all.
    const result = mod.writeState(tmpDir, { current_phase: 'phase2-sprint' });
    assert.strictEqual(result.success, false);
    assert.deepEqual(result.updated_keys, []);
    assert.match(result.reason, /\[MPL I13\]/);
    assert.match(result.reason, /phase2-sprint/);
    assert.match(result.reason, /raw-scan\.md/);
    // CRITICAL: no .mpl/state.json should have been written.
    assert.strictEqual(existsSync(join(tmpDir, '.mpl', 'state.json')), false);
  });

  for (const phase of ['phase3-gate', 'phase4-fix', 'phase5-finalize', 'release-gate', 'release-finalize', 'completed']) {
    it(`rejects transition to ${phase} when artifacts missing`, async () => {
      const mod = await loadModule();
      const result = mod.writeState(tmpDir, { current_phase: phase });
      assert.strictEqual(result.success, false);
      assert.match(result.reason, new RegExp(phase));
    });
  }

  it('allows transition to a protected phase when Phase 0 artifacts are present', async () => {
    const mod = await loadModule();
    setupPhase0(tmpDir);
    const result = mod.writeState(tmpDir, { current_phase: 'phase2-sprint' });
    assert.strictEqual(result.success, true);
    assert.deepEqual(result.updated_keys, ['current_phase']);
    const raw = JSON.parse(readFileSync(join(tmpDir, '.mpl', 'state.json'), 'utf-8'));
    assert.strictEqual(raw.current_phase, 'phase2-sprint');
  });

  it('allows transition to an EXEMPT phase (phase1b-plan) with no Phase 0 artifacts', async () => {
    const mod = await loadModule();
    // No setupPhase0 — chicken-and-egg, phase1b-plan is where artifacts get made.
    const result = mod.writeState(tmpDir, { current_phase: 'phase1b-plan' });
    assert.strictEqual(result.success, true);
  });

  it('rejects when contracts directory exists but contains no .json (only e.g. README)', async () => {
    const mod = await loadModule();
    setupPhase0(tmpDir, { contracts: false });
    mkdirSync(join(tmpDir, '.mpl', 'contracts'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'contracts', 'README.md'), '# placeholder');
    const result = mod.writeState(tmpDir, { current_phase: 'phase2-sprint' });
    assert.strictEqual(result.success, false);
    assert.match(result.reason, /contracts/);
  });

  it('non-current_phase patches pass through without Phase 0 check', async () => {
    const mod = await loadModule();
    // No Phase 0 artifacts. Patch is unrelated to current_phase.
    const result = mod.writeState(tmpDir, { run_mode: 'auto' });
    assert.strictEqual(result.success, true);
    assert.deepEqual(result.updated_keys, ['run_mode']);
  });
});
