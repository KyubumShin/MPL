import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
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
