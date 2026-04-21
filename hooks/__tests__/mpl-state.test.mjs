import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { deepMerge, readState, writeState, isMplActive, initState, checkConvergence } from '../lib/mpl-state.mjs';

describe('deepMerge', () => {
  it('should merge nested objects', () => {
    const target = { a: 1, b: { c: 2, d: 3 } };
    const source = { b: { c: 10 } };
    const result = deepMerge(target, source);
    assert.deepStrictEqual(result, { a: 1, b: { c: 10, d: 3 } });
  });

  it('should replace arrays instead of merging', () => {
    const target = { arr: [1, 2, 3] };
    const source = { arr: [4, 5] };
    const result = deepMerge(target, source);
    assert.deepStrictEqual(result, { arr: [4, 5] });
  });

  it('should handle null values in source', () => {
    const target = { a: 1, b: { c: 2 } };
    const source = { b: null };
    const result = deepMerge(target, source);
    assert.strictEqual(result.b, null);
  });

  it('should ignore __proto__ keys (prototype pollution guard)', () => {
    const target = { a: 1 };
    const source = JSON.parse('{"__proto__": {"polluted": true}}');
    const result = deepMerge(target, source);
    assert.strictEqual(result.polluted, undefined);
    assert.strictEqual(({}).polluted, undefined);
  });

  it('should ignore constructor keys (prototype pollution guard)', () => {
    const target = { a: 1 };
    const source = { constructor: { polluted: true } };
    const result = deepMerge(target, source);
    assert.strictEqual(result.constructor, target.constructor);
  });

  it('should ignore prototype keys (prototype pollution guard)', () => {
    const target = { a: 1 };
    const source = { prototype: { polluted: true } };
    const result = deepMerge(target, source);
    assert.strictEqual(result.prototype, undefined);
  });

  it('should not mutate original objects', () => {
    const target = { a: 1, b: { c: 2 } };
    const source = { b: { d: 3 } };
    deepMerge(target, source);
    assert.deepStrictEqual(target, { a: 1, b: { c: 2 } });
  });
});

describe('readState / writeState', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mpl-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return null when no state file exists', () => {
    const result = readState(tmpDir);
    assert.strictEqual(result, null);
  });

  it('should write and read state correctly', () => {
    writeState(tmpDir, { current_phase: 'phase2-sprint', fix_loop_count: 3 });
    const state = readState(tmpDir);
    assert.strictEqual(state.current_phase, 'phase2-sprint');
    assert.strictEqual(state.fix_loop_count, 3);
  });

  it('should merge with existing state on write', () => {
    writeState(tmpDir, { current_phase: 'phase1-plan', fix_loop_count: 0 });
    writeState(tmpDir, { fix_loop_count: 5 });
    const state = readState(tmpDir);
    assert.strictEqual(state.current_phase, 'phase1-plan');
    assert.strictEqual(state.fix_loop_count, 5);
  });

  it('should create .mpl directory if missing', () => {
    writeState(tmpDir, { current_phase: 'phase1-plan' });
    assert.ok(existsSync(join(tmpDir, '.mpl')));
  });

  it('should return null for corrupt JSON (M5 schema validation)', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'state.json'), 'not json{{{');
    const result = readState(tmpDir);
    assert.strictEqual(result, null);
  });

  it('should return null for valid JSON without current_phase (M5)', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'state.json'), JSON.stringify({ foo: 'bar' }));
    const result = readState(tmpDir);
    assert.strictEqual(result, null);
  });

  it('should return null for JSON array (M5)', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'state.json'), JSON.stringify([1, 2, 3]));
    const result = readState(tmpDir);
    assert.strictEqual(result, null);
  });

  it('should use atomic write (temp file + rename)', () => {
    // Write state, then verify the file exists and no temp files remain
    writeState(tmpDir, { current_phase: 'phase1-plan' });
    const stateDir = join(tmpDir, '.mpl');
    const files = readdirSync(stateDir);
    const tmpFiles = files.filter(f => f.endsWith('.tmp'));
    assert.strictEqual(tmpFiles.length, 0, 'No temp files should remain after write');
  });
});

describe('isMplActive', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mpl-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return false when no state file exists', () => {
    assert.strictEqual(isMplActive(tmpDir), false);
  });

  it('should return true for active phase', () => {
    writeState(tmpDir, { current_phase: 'phase2-sprint' });
    assert.strictEqual(isMplActive(tmpDir), true);
  });

  it('should return false for completed phase', () => {
    writeState(tmpDir, { current_phase: 'completed' });
    assert.strictEqual(isMplActive(tmpDir), false);
  });

  it('should return false for cancelled phase', () => {
    writeState(tmpDir, { current_phase: 'cancelled' });
    assert.strictEqual(isMplActive(tmpDir), false);
  });

  it('should return true for corrupt state file (M6 fail-closed)', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'state.json'), 'corrupt data!!!');
    assert.strictEqual(isMplActive(tmpDir), true);
  });
});

describe('initState', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mpl-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should create state file with correct defaults (full mode)', () => {
    const state = initState(tmpDir, 'test-feature', 'full');
    assert.ok(state.pipeline_id.startsWith('mpl-'));
    assert.ok(state.pipeline_id.includes('test-feature'));
    assert.strictEqual(state.run_mode, 'full');
    assert.strictEqual(state.current_phase, 'phase1a-research');
    assert.ok(state.started_at);
  });

  it('should pass through non-auto run_mode verbatim', () => {
    const state = initState(tmpDir, 'quick-fix', 'full');
    assert.strictEqual(state.run_mode, 'full');
    assert.strictEqual(state.current_phase, 'phase1a-research');
  });

  it('should support Korean feature names (M1)', () => {
    const state = initState(tmpDir, '로그인 기능 추가', 'full');
    assert.ok(state.pipeline_id.includes('로그인'));
  });

  it('should persist state file to disk', () => {
    initState(tmpDir, 'disk-check', 'full');
    assert.ok(existsSync(join(tmpDir, '.mpl', 'state.json')));
    const raw = JSON.parse(readFileSync(join(tmpDir, '.mpl', 'state.json'), 'utf-8'));
    assert.ok(raw.pipeline_id);
  });
});

describe('checkConvergence', () => {
  it('should return insufficient_data when no convergence info', () => {
    const result = checkConvergence({});
    assert.strictEqual(result.status, 'insufficient_data');
  });

  it('should return insufficient_data with less than 2 history entries', () => {
    const result = checkConvergence({ convergence: { pass_rate_history: [0.5] } });
    assert.strictEqual(result.status, 'insufficient_data');
  });

  it('should detect improving trend', () => {
    const result = checkConvergence({
      convergence: {
        pass_rate_history: [0.3, 0.5, 0.8],
        stagnation_window: 3,
        min_improvement: 0.05,
        regression_threshold: -0.1
      }
    });
    assert.strictEqual(result.status, 'improving');
    assert.ok(result.delta > 0);
  });

  it('should detect stagnation', () => {
    const result = checkConvergence({
      convergence: {
        pass_rate_history: [0.5, 0.51, 0.52],
        stagnation_window: 3,
        min_improvement: 0.05,
        regression_threshold: -0.1
      }
    });
    assert.strictEqual(result.status, 'stagnating');
  });

  it('should detect regression', () => {
    const result = checkConvergence({
      convergence: {
        pass_rate_history: [0.8, 0.6, 0.5],
        stagnation_window: 3,
        min_improvement: 0.05,
        regression_threshold: -0.1
      }
    });
    assert.strictEqual(result.status, 'regressing');
    assert.ok(result.delta < -0.1);
  });

  it('should return insufficient_data for empty history array', () => {
    const result = checkConvergence({ convergence: { pass_rate_history: [] } });
    assert.strictEqual(result.status, 'insufficient_data');
  });

  it('should return insufficient_data for null state', () => {
    const result = checkConvergence(null);
    assert.strictEqual(result.status, 'insufficient_data');
  });
});
