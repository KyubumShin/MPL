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
  // Helper to build a structured gate entry with given exit code
  const ent = (exit_code) => ({
    command: 'npm test',
    exit_code,
    stdout_tail: '',
    timestamp: '2026-05-04T00:00:00Z',
  });

  describe('legacy boolean fallback (transitional, non-strict)', () => {
    it('should report all passed when all gates true', () => {
      const result = checkGateResults({
        gate_results: { hard1_passed: true, hard2_passed: true, hard3_passed: true }
      });
      assert.strictEqual(result.allPassed, true);
      assert.strictEqual(result.anyFailed, false);
      assert.strictEqual(result.source, 'legacy');
    });

    it('should report partial pass', () => {
      const result = checkGateResults({
        gate_results: { hard1_passed: true, hard2_passed: false, hard3_passed: null }
      });
      assert.strictEqual(result.allPassed, false);
      assert.strictEqual(result.anyFailed, true);
      assert.strictEqual(result.source, 'legacy');
    });

    it('should report no evaluation when all null', () => {
      const result = checkGateResults({
        gate_results: { hard1_passed: null, hard2_passed: null, hard3_passed: null }
      });
      assert.strictEqual(result.allPassed, false);
      assert.strictEqual(result.anyFailed, false);
      assert.strictEqual(result.source, 'none');
    });

    it('should handle only hard1 present', () => {
      const result = checkGateResults({
        gate_results: { hard1_passed: true, hard2_passed: null, hard3_passed: null }
      });
      assert.strictEqual(result.allPassed, true);
      assert.strictEqual(result.anyFailed, false);
      assert.strictEqual(result.source, 'legacy');
    });

    it('should handle missing gate_results gracefully', () => {
      const result = checkGateResults({});
      assert.strictEqual(result.allPassed, false);
      assert.strictEqual(result.anyFailed, false);
      assert.strictEqual(result.source, 'none');
    });
  });

  describe('structured evidence (canonical, AD-0006)', () => {
    it('all 3 structured entries with exit_code 0 → allPassed=true', () => {
      const result = checkGateResults({
        gate_results: {
          hard1_baseline: ent(0),
          hard2_coverage: ent(0),
          hard3_resilience: ent(0),
        }
      });
      assert.strictEqual(result.allPassed, true);
      assert.strictEqual(result.anyFailed, false);
      assert.strictEqual(result.source, 'structured');
      assert.deepStrictEqual(result.missingEvidence, []);
    });

    it('one structured entry with nonzero exit_code → anyFailed=true', () => {
      const result = checkGateResults({
        gate_results: {
          hard1_baseline: ent(0),
          hard2_coverage: ent(1),
          hard3_resilience: ent(0),
        }
      });
      assert.strictEqual(result.allPassed, false);
      assert.strictEqual(result.anyFailed, true);
      assert.strictEqual(result.source, 'structured');
      assert.strictEqual(result.details.hard2, false);
    });

    it('structured wins over conflicting legacy boolean (exp15 fake-gate scenario)', () => {
      // Phase-runner self-reports legacy=true, but real exit codes say otherwise.
      // checkGateResults must trust structured evidence.
      const result = checkGateResults({
        gate_results: {
          hard1_passed: true, hard2_passed: true, hard3_passed: true,
          hard1_baseline: ent(0),
          hard2_coverage: ent(1),
          hard3_resilience: ent(0),
        }
      });
      assert.strictEqual(result.source, 'structured');
      assert.strictEqual(result.anyFailed, true);
      assert.strictEqual(result.allPassed, false);
    });

    it('partial structured (2/3) + non-strict → blocks even with legacy true (issue #102 spec)', () => {
      // PR #119 review fix: once gate-recorder produces any structured entry, the
      // remaining gates are required. Legacy fallback would otherwise let phase-runner
      // skip a gate by self-reporting only.
      const result = checkGateResults({
        gate_results: {
          hard1_baseline: ent(0),
          hard2_coverage: ent(0),
          hard1_passed: true, hard2_passed: true, hard3_passed: true,
        }
      });
      assert.strictEqual(result.source, 'structured');
      assert.strictEqual(result.allPassed, false);
      assert.strictEqual(result.anyFailed, false);
      assert.deepStrictEqual(result.missingEvidence, ['hard3_resilience']);
    });

    it('PR #119 blocking repro — partial structured nonzero + legacy all true must not pass', () => {
      // Reviewer's exact repro:
      //   checkGateResults({ gate_results: {
      //     hard1_passed: true, hard2_passed: true, hard3_passed: true,
      //     hard1_baseline: { exit_code: 1 }
      //   }})
      // Pre-fix: returned { allPassed: true, source: 'legacy' } — masking the failure.
      const result = checkGateResults({
        gate_results: {
          hard1_passed: true, hard2_passed: true, hard3_passed: true,
          hard1_baseline: { command: 'npm test', exit_code: 1, stdout_tail: '', timestamp: 'now' },
        }
      });
      assert.strictEqual(result.allPassed, false);
      assert.strictEqual(result.anyFailed, true);
      assert.strictEqual(result.source, 'structured');
      assert.strictEqual(result.details.hard1, false);
    });

    it('single structured nonzero + no legacy → anyFailed wins immediately', () => {
      const result = checkGateResults({
        gate_results: {
          hard1_baseline: ent(1),
        }
      });
      assert.strictEqual(result.allPassed, false);
      assert.strictEqual(result.anyFailed, true);
      assert.strictEqual(result.source, 'structured');
      assert.deepStrictEqual(result.missingEvidence, ['hard2_coverage', 'hard3_resilience']);
    });

    it('single structured pass (1/3) + legacy true → blocks (issue #102 spec)', () => {
      const result = checkGateResults({
        gate_results: {
          hard1_baseline: ent(0),
          hard1_passed: true, hard2_passed: true, hard3_passed: true,
        }
      });
      assert.strictEqual(result.source, 'structured');
      assert.strictEqual(result.allPassed, false);
      assert.strictEqual(result.anyFailed, false);
      assert.deepStrictEqual(result.missingEvidence, ['hard2_coverage', 'hard3_resilience']);
    });
  });

  describe('strict mode (exp16-target enforcement)', () => {
    it('all structured PASS in strict → allPassed=true', () => {
      const result = checkGateResults({
        gate_results: {
          hard1_baseline: ent(0),
          hard2_coverage: ent(0),
          hard3_resilience: ent(0),
        }
      }, { strict: true });
      assert.strictEqual(result.allPassed, true);
      assert.strictEqual(result.source, 'structured');
    });

    it('legacy-only state in strict → blocked (allPassed=false, anyFailed=false, missingEvidence set)', () => {
      const result = checkGateResults({
        gate_results: { hard1_passed: true, hard2_passed: true, hard3_passed: true }
      }, { strict: true });
      assert.strictEqual(result.allPassed, false);
      assert.strictEqual(result.anyFailed, false);
      assert.strictEqual(result.source, 'structured');
      assert.deepStrictEqual(result.missingEvidence,
        ['hard1_baseline', 'hard2_coverage', 'hard3_resilience']);
    });

    it('partial structured (2/3) in strict → not allPassed, missing surfaced', () => {
      const result = checkGateResults({
        gate_results: {
          hard1_baseline: ent(0),
          hard2_coverage: ent(0),
          // hard3_resilience missing
        }
      }, { strict: true });
      assert.strictEqual(result.allPassed, false);
      assert.strictEqual(result.anyFailed, false);
      assert.strictEqual(result.source, 'structured');
      assert.deepStrictEqual(result.missingEvidence, ['hard3_resilience']);
      assert.strictEqual(result.details.hard1, true);
      assert.strictEqual(result.details.hard3, null);
    });

    it('partial structured + 1 nonzero in strict → anyFailed=true (failure dominates missing)', () => {
      // PR #119 review fix: machine-recorded failure dominates. Step 1 fires before
      // Step 3 (missing-evidence), so even in strict mode a present nonzero exit_code
      // surfaces as anyFailed=true rather than waiting for the missing gate to be filled.
      const result = checkGateResults({
        gate_results: {
          hard1_baseline: ent(1),
          hard2_coverage: ent(0),
        }
      }, { strict: true });
      assert.strictEqual(result.allPassed, false);
      assert.strictEqual(result.anyFailed, true);
      assert.strictEqual(result.source, 'structured');
      assert.deepStrictEqual(result.missingEvidence, ['hard3_resilience']);
    });
  });

  describe('schema robustness', () => {
    it('rejects malformed structured entry without exit_code', () => {
      const result = checkGateResults({
        gate_results: {
          hard1_baseline: { command: 'npm test', timestamp: 'now' },  // no exit_code
          hard2_coverage: ent(0),
          hard3_resilience: ent(0),
        }
      });
      // hard1 lacks exit_code → not counted as structured → 2/3 partial → fall to legacy.
      // Legacy is empty so allPassed must be false; the malformed entry is surfaced
      // via missingEvidence so the caller can warn.
      assert.strictEqual(result.allPassed, false);
      assert.strictEqual(result.anyFailed, false);
      assert.ok(result.missingEvidence.includes('hard1_baseline'));
    });

    it('rejects malformed structured entry in strict mode', () => {
      const result = checkGateResults({
        gate_results: {
          hard1_baseline: { command: 'npm test', timestamp: 'now' },  // no exit_code
          hard2_coverage: ent(0),
          hard3_resilience: ent(0),
        }
      }, { strict: true });
      assert.strictEqual(result.allPassed, false);
      assert.deepStrictEqual(result.missingEvidence, ['hard1_baseline']);
    });

    it('handles null state', () => {
      const result = checkGateResults(null);
      assert.strictEqual(result.allPassed, false);
      assert.strictEqual(result.anyFailed, false);
      assert.strictEqual(result.source, 'none');
    });
  });
});
