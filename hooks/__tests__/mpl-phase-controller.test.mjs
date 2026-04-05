import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { checkPlanStatus, checkGateResults } from '../mpl-phase-controller.mjs';

describe('checkPlanStatus', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mpl-plan-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return null when no PLAN.md exists', () => {
    const result = checkPlanStatus(tmpDir);
    assert.strictEqual(result, null);
  });

  it('should detect all checked items', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'PLAN.md'), `
### [x] Task 1
### [X] Task 2
### [x] Task 3
`);
    const result = checkPlanStatus(tmpDir);
    assert.strictEqual(result.total, 3);
    assert.strictEqual(result.completed, 3);
    assert.strictEqual(result.failed, 0);
  });

  it('should detect partially checked items', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'PLAN.md'), `
### [x] Task 1
### [ ] Task 2
### [FAILED] Task 3
`);
    const result = checkPlanStatus(tmpDir);
    assert.strictEqual(result.total, 3);
    assert.strictEqual(result.completed, 1);
    assert.strictEqual(result.failed, 1);
  });

  it('should detect no checked items', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'PLAN.md'), `
### [ ] Task 1
### [ ] Task 2
`);
    const result = checkPlanStatus(tmpDir);
    assert.strictEqual(result.total, 2);
    assert.strictEqual(result.completed, 0);
    assert.strictEqual(result.failed, 0);
  });

  it('should return total=0 for empty PLAN.md', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'PLAN.md'), '# My Plan\nSome notes');
    const result = checkPlanStatus(tmpDir);
    assert.strictEqual(result.total, 0);
    assert.strictEqual(result.completed, 0);
  });

  it('should also check root-level PLAN.md', () => {
    writeFileSync(join(tmpDir, 'PLAN.md'), `
### [x] Task 1
### [ ] Task 2
`);
    const result = checkPlanStatus(tmpDir);
    assert.strictEqual(result.total, 2);
    assert.strictEqual(result.completed, 1);
  });
});

describe('checkGateResults', () => {
  it('should report all passed when all gates true', () => {
    const result = checkGateResults({
      gate_results: { hard1_passed: true, hard2_passed: true, hard3_passed: true }
    });
    assert.strictEqual(result.allPassed, true);
    assert.strictEqual(result.anyFailed, false);
  });

  it('should report partial pass', () => {
    const result = checkGateResults({
      gate_results: { hard1_passed: true, hard2_passed: false, hard3_passed: null }
    });
    assert.strictEqual(result.allPassed, false);
    assert.strictEqual(result.anyFailed, true);
  });

  it('should report no evaluation when all null', () => {
    const result = checkGateResults({
      gate_results: { hard1_passed: null, hard2_passed: null, hard3_passed: null }
    });
    assert.strictEqual(result.allPassed, false);
    assert.strictEqual(result.anyFailed, false);
  });

  it('should handle only hard1 present', () => {
    const result = checkGateResults({
      gate_results: { hard1_passed: true, hard2_passed: null, hard3_passed: null }
    });
    assert.strictEqual(result.allPassed, true);
    assert.strictEqual(result.anyFailed, false);
  });

  it('should handle missing gate_results gracefully', () => {
    const result = checkGateResults({});
    assert.strictEqual(result.allPassed, false);
    assert.strictEqual(result.anyFailed, false);
  });
});
