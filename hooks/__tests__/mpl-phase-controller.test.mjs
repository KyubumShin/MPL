import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import { checkPlanStatus, checkGateResults } from '../mpl-phase-controller.mjs';

const HOOK_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'mpl-phase-controller.mjs');

function runStopHook(cwd, state, { skipPhase0Seed = false } = {}) {
  mkdirSync(join(cwd, '.mpl'), { recursive: true });
  writeFileSync(join(cwd, '.mpl', 'state.json'), JSON.stringify(state));
  // Exp22 R11 / #210: phase-controller's transition writes now check
  // Phase 0 artifacts. Seed them by default so existing transition tests
  // don't accidentally exercise the I13 block. Tests that explicitly
  // want to test the I13 path can pass `{ skipPhase0Seed: true }`.
  if (!skipPhase0Seed) {
    mkdirSync(join(cwd, '.mpl', 'mpl', 'phase0'), { recursive: true });
    if (!existsSync(join(cwd, '.mpl', 'mpl', 'phase0', 'raw-scan.md'))) {
      writeFileSync(join(cwd, '.mpl', 'mpl', 'phase0', 'raw-scan.md'), '# raw scan');
    }
    if (!existsSync(join(cwd, '.mpl', 'mpl', 'phase0', 'design-intent.yaml'))) {
      writeFileSync(join(cwd, '.mpl', 'mpl', 'phase0', 'design-intent.yaml'), 'goal: test\n');
    }
    mkdirSync(join(cwd, '.mpl', 'contracts'), { recursive: true });
    if (!existsSync(join(cwd, '.mpl', 'contracts', '_no-boundaries.json'))) {
      writeFileSync(join(cwd, '.mpl', 'contracts', '_no-boundaries.json'),
        JSON.stringify({ boundary_id: '_no-boundaries' }));
    }
  }
  const stdin = JSON.stringify({ cwd });
  const out = execFileSync('node', [HOOK_PATH], { input: stdin, encoding: 'utf-8' });
  return JSON.parse(out);
}

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

describe('phase3-gate Stop hook integration (PR #119 review #5 follow-up)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'mpl-phase3-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  const ent = (exit_code) => ({
    command: 'npm test', exit_code, stdout_tail: '', timestamp: '2026-05-04T00:00:00Z',
  });
  const baseState = (gate_results, extra = {}) => ({
    current_phase: 'phase3-gate',
    gate_results,
    ...extra,
  });

  it('A · structured 3 PASS → Phase 5 transition, source=structured', () => {
    const out = runStopHook(tmpDir, baseState({
      hard1_baseline: ent(0), hard2_coverage: ent(0), hard3_resilience: ent(0),
    }));
    assert.match(out.stopReason, /All Quality Gates passed \(source=structured\)/);
    assert.match(out.stopReason, /Phase 5: Finalize/);
  });

  it('B · fake-gate (legacy 3 true + structured 1 nonzero) MUST NOT pass', () => {
    const out = runStopHook(tmpDir, baseState({
      hard1_passed: true, hard2_passed: true, hard3_passed: true,
      hard1_baseline: ent(1),
    }));
    assert.match(out.stopReason, /Quality Gate failed \(source=structured\)/);
    assert.match(out.stopReason, /H1=false/);
    assert.match(out.stopReason, /Phase 4: Fix Loop/);
  });

  it('C · zero structured + legacy 3 true (non-strict) → pass + ⚠ legacy fallback warn', () => {
    const out = runStopHook(tmpDir, baseState({
      hard1_passed: true, hard2_passed: true, hard3_passed: true,
    }));
    assert.match(out.stopReason, /All Quality Gates passed \(source=legacy\)/);
    assert.match(out.stopReason, /⚠ Using legacy gate boolean fallback/);
    assert.match(out.stopReason, /exp16 strict mode will block this transition/);
  });

  it('D · zero structured + legacy 3 true + strict → BLOCKED with explicit missing list', () => {
    const out = runStopHook(tmpDir, baseState({
      hard1_passed: true, hard2_passed: true, hard3_passed: true,
    }, { enforcement: { strict: true } }));
    assert.match(out.stopReason, /⛔ BLOCKED/);
    assert.match(out.stopReason, /missing structured gate evidence \(hard1_baseline, hard2_coverage, hard3_resilience\)/);
    assert.match(out.stopReason, /Self-reported booleans are not accepted/);
  });

  it('E · partial structured (2/3 pass) + legacy true (non-strict) → in-progress with explicit missing list', () => {
    // PR #119 follow-up: previously this branch surfaced a generic "Phase 3: Quality Gate
    // in progress" without telling the orchestrator which gate was missing. Now the missing
    // list is surfaced even in non-strict mode (issue #102 "missing → false" UX completion).
    const out = runStopHook(tmpDir, baseState({
      hard1_passed: true, hard2_passed: true, hard3_passed: true,
      hard1_baseline: ent(0), hard2_coverage: ent(0),
    }));
    assert.match(out.stopReason, /Phase 3 in progress/);
    assert.match(out.stopReason, /missing structured gate evidence \(hard3_resilience\)/);
    assert.match(out.stopReason, /loop will continue once all 3 remaining are recorded/);
    assert.doesNotMatch(out.stopReason, /⛔ BLOCKED/);
  });

  it('E-strict · partial structured (2/3 pass) + strict → BLOCKED with explicit missing list', () => {
    const out = runStopHook(tmpDir, baseState({
      hard1_baseline: ent(0), hard2_coverage: ent(0),
    }, { enforcement: { strict: true } }));
    assert.match(out.stopReason, /⛔ BLOCKED/);
    assert.match(out.stopReason, /missing structured gate evidence \(hard3_resilience\)/);
  });

  it('F · zero structured + zero legacy → generic "in progress" with legacy-fallback warn', () => {
    const out = runStopHook(tmpDir, baseState({}));
    assert.match(out.stopReason, /Phase 3: Quality Gate in progress\. Run all 3 gates before proceeding/);
    // source=='none' here, so the legacy fallback warn does NOT prepend (warn is for source=='legacy')
    assert.doesNotMatch(out.stopReason, /⚠ Using legacy gate boolean fallback/);
  });
});

describe('I13 phase0 artifacts gate the controller transition (Exp22 R11 / #210)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'mpl-i13-ctrl-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('phase1a-research → phase1b-plan transition is EXEMPT from the Phase 0 guard (codex r7)', () => {
    // codex r7 on PR #222 [contract-break]: phase1b-plan is the
    // planning preparation phase that PRODUCES contracts via the
    // decomposer. Gating phase1b-plan on contracts being already
    // present is a chicken-and-egg block — removed from
    // REQUIRES_PHASE0_ARTIFACTS. The transition lands even when
    // artifacts haven't yet been produced.
    const out = runStopHook(tmpDir, {
      current_phase: 'phase1a-research',
      research: { status: 'skipped' },
    }, { skipPhase0Seed: true });
    assert.doesNotMatch(out.stopReason, /\[MPL I13\]/,
      'phase1b-plan transition must not invoke the Phase 0 guard');
    const state = JSON.parse(readFileSync(join(tmpDir, '.mpl', 'state.json'), 'utf-8'));
    assert.equal(state.current_phase, 'phase1b-plan');
  });

  it('phase2-sprint → phase3-gate (variable nextPhase) is blocked when artifacts missing (codex r2 [data-integrity])', () => {
    // codex r2 on PR #222: variable nextPhase transitions need the same
    // guard. Phase 2 with all TODOs done normally advances to phase3-gate
    // via `const nextPhase = ...; writeState(...)`.
    // Plant a PLAN.md showing 1/1 completed so the controller takes the
    // "all TODOs done → next phase" branch.
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'PLAN.md'), '### [x] phase-1 done\n');
    const out = runStopHook(tmpDir, { current_phase: 'phase2-sprint' },
      { skipPhase0Seed: true });
    assert.match(out.stopReason, /\[MPL I13\] Cannot transition to phase3-gate/);
    const state = JSON.parse(readFileSync(join(tmpDir, '.mpl', 'state.json'), 'utf-8'));
    assert.equal(state.current_phase, 'phase2-sprint',
      'controller MUST NOT advance to phase3-gate when artifacts are missing');
  });

  it('small-pipeline completion is EXEMPT from Phase 0 artifact guard (codex r2 [contract-break])', () => {
    // codex r2 on PR #222: small-plan / small-sprint / small-verify is
    // a separate lightweight flow that intentionally skips Phase 0.
    // small-verify → completed must NOT be blocked by I13.
    const out = runStopHook(tmpDir, {
      current_phase: 'small-verify',
      gate_results: { hard2_passed: true },
    }, { skipPhase0Seed: true });
    assert.match(out.stopReason, /MPL-Small.*Verification passed/);
    const state = JSON.parse(readFileSync(join(tmpDir, '.mpl', 'state.json'), 'utf-8'));
    assert.equal(state.current_phase, 'completed',
      'small-pipeline completion must land without Phase 0 artifacts');
  });

  it('small-pipeline fix-loop completion is also EXEMPT', () => {
    const out = runStopHook(tmpDir, {
      current_phase: 'small-verify',
      gate_results: { hard2_passed: false },
      fix_loop_count: 3,
      max_fix_loops: 3,
    }, { skipPhase0Seed: true });
    assert.match(out.stopReason, /MPL-Small.*Fix loop limit reached/);
    const state = JSON.parse(readFileSync(join(tmpDir, '.mpl', 'state.json'), 'utf-8'));
    assert.equal(state.current_phase, 'completed');
  });

  it('phase3-gate FAIL → phase4-fix is blocked when artifacts missing (codex r3 [data-integrity])', () => {
    // codex r3 on PR #222: the gate-failure composite writeState writes
    // current_phase: 'phase4-fix' along with clearing gate_results. If
    // artifacts are missing, the guard must short-circuit BEFORE the
    // gate-evidence reset — otherwise failed evidence gets wiped.
    const ent = (e) => ({ command: 'npm test', exit_code: e, stdout_tail: '', timestamp: 'now' });
    const out = runStopHook(tmpDir, {
      current_phase: 'phase3-gate',
      gate_results: {
        hard1_baseline: ent(0), hard2_coverage: ent(1), hard3_resilience: ent(0),
      },
    }, { skipPhase0Seed: true });
    assert.match(out.stopReason, /\[MPL I13\] Cannot transition to phase4-fix/);
    const state = JSON.parse(readFileSync(join(tmpDir, '.mpl', 'state.json'), 'utf-8'));
    assert.equal(state.current_phase, 'phase3-gate',
      'controller MUST NOT advance to phase4-fix when Phase 0 artifacts are missing');
    // Failure evidence MUST be preserved — guard short-circuits before the reset.
    assert.equal(state.gate_results.hard2_coverage.exit_code, 1,
      'recorded failure evidence MUST be preserved when transition is blocked');
  });

  it('release-finalize blocks BEFORE creating any release artifacts when Phase 0 missing (codex r5 [data-integrity])', () => {
    // codex r5 on PR #222: the release-finalize case writes
    // release-manifest.json + evidence-summary.md + gate-results.json
    // + snapshot ref BEFORE the final state writeState. Without the
    // guard at the top, missing Phase 0 artifacts would leave a
    // shipped-looking manifest + ref on disk while state.release stays
    // un-appended (drift).
    const out = runStopHook(tmpDir, {
      current_phase: 'release-finalize',
      release: {
        current_cut_id: 'mvp',
        completed_cut_ids: [],
        fix_loop_count: 0,
        pending_artifact: null,
        gate_results: {
          hard1_passed: true, hard2_passed: true, hard3_passed: true,
          hard1_baseline: { command: 'npm run build', exit_code: 0 },
          hard2_coverage: { command: 'npm test', exit_code: 0 },
          hard3_resilience: { command: 'npx playwright test', exit_code: 0 },
        },
        max_fix_loops: 3,
      },
    }, { skipPhase0Seed: true });
    assert.match(out.stopReason, /\[MPL I13\] Cannot transition to release-finalize/);
    // No release artifact directory should exist — guard fired before
    // any disk writes in this case.
    const releasesDir = join(tmpDir, '.mpl', 'mpl', 'releases');
    assert.equal(existsSync(releasesDir), false,
      'release artifact directory MUST NOT be created when guard blocks');
  });

  it('phase1a-research → phase1b-plan transition lands when Phase 0 artifacts are present', () => {
    const out = runStopHook(tmpDir, {
      current_phase: 'phase1a-research',
      research: { status: 'completed', stages_completed: ['s1', 's2', 's3'], findings_count: 5, sources_count: 10 },
    });
    // runStopHook seeds Phase 0 artifacts by default.
    assert.match(out.stopReason, /Transitioning to Phase 1-B/);
    const state = JSON.parse(readFileSync(join(tmpDir, '.mpl', 'state.json'), 'utf-8'));
    assert.equal(state.current_phase, 'phase1b-plan');
  });
});

describe('G4 hang detection (#109) Stop hook integration', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'mpl-g4-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  function readState() {
    return JSON.parse(readFileSync(join(tmpDir, '.mpl', 'state.json'), 'utf-8'));
  }

  it('no last_tool_at → falls through to phase routing (no hang marking)', () => {
    const out = runStopHook(tmpDir, { current_phase: 'phase2-sprint' });
    // Whatever phase2-sprint emits is fine; we just want NOT to see the hang banner.
    assert.doesNotMatch(out.stopReason || '', /\[MPL G4\] ⚠ Verification appears hung/);
    assert.notStrictEqual(readState().session_status, 'verification_hang');
  });

  it('last_tool_at within 15min → falls through (no hang marking)', () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    const out = runStopHook(tmpDir, {
      current_phase: 'phase2-sprint',
      last_tool_at: recent,
    });
    assert.doesNotMatch(out.stopReason || '', /Verification appears hung/);
    assert.notStrictEqual(readState().session_status, 'verification_hang');
  });

  it('last_tool_at older than 15min → marks verification_hang and surfaces banner', () => {
    const stale = new Date(Date.now() - 30 * 60_000).toISOString();
    const out = runStopHook(tmpDir, {
      current_phase: 'phase2-sprint',
      last_tool_at: stale,
    });
    assert.match(out.stopReason, /\[MPL G4\] ⚠ Verification appears hung/);
    assert.match(out.stopReason, /threshold 15min/);
    assert.strictEqual(readState().session_status, 'verification_hang');
  });

  it('paused_budget pre-mark → never flagged as hang (intentional pause)', () => {
    const stale = new Date(Date.now() - 60 * 60_000).toISOString();
    const out = runStopHook(tmpDir, {
      current_phase: 'phase2-sprint',
      last_tool_at: stale,
      session_status: 'paused_budget',
    });
    assert.doesNotMatch(out.stopReason || '', /Verification appears hung/);
    assert.strictEqual(readState().session_status, 'paused_budget');
  });

  it('verification_hang pre-mark → not re-marked, alarm banner suppressed', () => {
    // Already-marked sessions: alarm banner is replaced with a softer triage
    // pointer (so the user is told to resume rather than re-shown the alarm
    // every Stop tick). Marker itself persists.
    const stale = new Date(Date.now() - 5 * 60 * 60_000).toISOString();
    const out = runStopHook(tmpDir, {
      current_phase: 'phase2-sprint',
      last_tool_at: stale,
      session_status: 'verification_hang',
    });
    assert.doesNotMatch(out.stopReason || '', /⚠ Verification appears hung/);
    assert.match(out.stopReason, /Session is currently marked verification_hang/);
    assert.match(out.stopReason, /\/mpl:mpl-resume/);
    assert.strictEqual(readState().session_status, 'verification_hang');
  });

  it('verification_hang pre-mark on phase3-gate PASS → blocks Phase 5 transition (PR #126 review)', () => {
    // Reproduction of the high-severity finding: previously the exempt branch
    // fell through to phase switch, allowing checkGateResults → Phase 5
    // writeState even though the user had not triaged the hang. Marker must
    // gate every transition.
    const ent = (exit_code) => ({
      command: 'npm test', exit_code, stdout_tail: '', timestamp: '2026-05-04T00:00:00Z',
    });
    const stale = new Date(Date.now() - 30 * 60_000).toISOString();
    const out = runStopHook(tmpDir, {
      current_phase: 'phase3-gate',
      last_tool_at: stale,
      session_status: 'verification_hang',
      gate_results: {
        hard1_baseline: ent(0),
        hard2_coverage: ent(0),
        hard3_resilience: ent(0),
      },
    });
    assert.match(out.stopReason, /Session is currently marked verification_hang/);
    // Phase routing must NOT have advanced.
    assert.doesNotMatch(out.stopReason, /Transitioning to Phase 5/);
    assert.doesNotMatch(out.stopReason, /All Quality Gates passed/);
    const state = readState();
    assert.strictEqual(state.current_phase, 'phase3-gate', 'phase must NOT transition');
    assert.strictEqual(state.session_status, 'verification_hang');
  });

  it('D-Q7: blocks small-plan entry when goal_contract.mvp_scope is declared', () => {
    // RFC §10 D-Q7: small-pipeline and mvp_scope are mutually exclusive.
    // When the contract declares an MVP, small-plan must refuse to enter
    // rather than silently downgrading away from the Stage A release path.
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    // Minimal valid contract with mvp_scope.
    writeFileSync(join(tmpDir, '.mpl', 'goal-contract.yaml'), `
source:
  runtime_goal: "x"
  user_request_hash: "abc"
mission:
  goal: "g"
  project_pivot: "pp"
  must_ship_outcomes:
    - "ship"
ontology:
  entities:
    - foo
variation_axes:
  - id: AX-1
    name: ax
acceptance_criteria:
  - id: AC-1
    statement: "ac"
e2e_policy:
  real_runtime_required: true
  mock_allowed: false
  placeholder_assertions_allowed: false
security_policy:
  required: false
completion_evidence:
  required_artifacts:
    - .mpl/mpl/audit-report.json
  require_commit: false
  require_finalize_timestamps: true
mvp_scope:
  acceptance_criteria: [AC-1]
  variation_axes: [AX-1]
  artifact: draft_pr
`);
    const out = runStopHook(tmpDir, { current_phase: 'small-plan' });
    assert.strictEqual(out.continue, false);
    assert.strictEqual(out.decision, 'block');
    assert.match(out.reason, /small-pipeline is not available when goal_contract\.mvp_scope is declared/);
  });

  it('D-Q7: allows small-plan entry when goal_contract.mvp_scope is absent', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    // No goal-contract file → mvp_scope is absent → small-plan must proceed.
    const out = runStopHook(tmpDir, { current_phase: 'small-plan' });
    assert.strictEqual(out.continue, true);
    assert.match(out.stopReason, /Small Plan in progress/);
  });

  it('D-Q7: allows small-plan when goal_contract exists but mvp_scope is absent (transitional case)', () => {
    // Most projects during Stage A rollout have a goal-contract.yaml from
    // prior runs but never declared mvp_scope. The guard's optional-chain
    // (`gc.contract?.mvp_scope`) must yield undefined → falsy → no block.
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'goal-contract.yaml'), `
source:
  runtime_goal: "x"
  user_request_hash: "abc"
mission:
  goal: "g"
  project_pivot: "pp"
  must_ship_outcomes:
    - "ship"
ontology:
  entities:
    - foo
variation_axes:
  - id: AX-1
    name: ax
acceptance_criteria:
  - id: AC-1
    statement: "ac"
e2e_policy:
  real_runtime_required: true
  mock_allowed: false
  placeholder_assertions_allowed: false
security_policy:
  required: false
completion_evidence:
  required_artifacts:
    - .mpl/mpl/audit-report.json
  require_commit: false
  require_finalize_timestamps: true
`);
    const out = runStopHook(tmpDir, { current_phase: 'small-plan' });
    assert.strictEqual(out.continue, true);
    assert.match(out.stopReason, /Small Plan in progress/);
  });

  // ── Stage A Phase 1.6b: release-path state handlers + lifecycle writer ──

  function writeGoalContractWithMvp(dir) {
    writeFileSync(join(dir, '.mpl', 'goal-contract.yaml'), `
source:
  runtime_goal: "x"
  user_request_hash: "abc"
mission:
  goal: "g"
  project_pivot: "pp"
  must_ship_outcomes:
    - "ship"
ontology:
  entities:
    - foo
variation_axes:
  - id: AX-1
    name: ax
acceptance_criteria:
  - id: AC-1
    statement: "ac"
e2e_policy:
  real_runtime_required: true
  mock_allowed: false
  placeholder_assertions_allowed: false
security_policy:
  required: false
completion_evidence:
  required_artifacts:
    - .mpl/mpl/audit-report.json
  require_commit: false
  require_finalize_timestamps: true
mvp_scope:
  acceptance_criteria: [AC-1]
  variation_axes: [AX-1]
  artifact: draft_pr
`);
  }

  it('1.6b: phase2-sprint lazy-initializes current_cut_id="mvp" when mvp_scope declared', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeGoalContractWithMvp(tmpDir);
    // Sprint with no PLAN.md → just touches the lifecycle init, then exits
    // with "no TODOs defined" message. We verify the init wrote current_cut_id.
    runStopHook(tmpDir, {
      current_phase: 'phase2-sprint',
      release: { current_cut_id: null, completed_cut_ids: [], fix_loop_count: 0, pending_artifact: null },
    });
    const state = readState();
    assert.strictEqual(state.release.current_cut_id, 'mvp');
  });

  it('1.6b: phase2-sprint without mvp_scope leaves current_cut_id null (backward compat)', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    // No goal-contract file → mvp_scope absent → no cohort init
    runStopHook(tmpDir, {
      current_phase: 'phase2-sprint',
      release: { current_cut_id: null, completed_cut_ids: [], fix_loop_count: 0, pending_artifact: null },
    });
    const state = readState();
    assert.strictEqual(state.release.current_cut_id, null);
  });

  it('1.6b: phase2-sprint completion with current_cut_id=mvp routes to release-gate', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'PLAN.md'), `### [x] Task 1\n### [x] Task 2\n`);
    writeGoalContractWithMvp(tmpDir);
    const out = runStopHook(tmpDir, {
      current_phase: 'phase2-sprint',
      release: { current_cut_id: 'mvp', completed_cut_ids: [], fix_loop_count: 0, pending_artifact: null },
    });
    const state = readState();
    assert.strictEqual(state.current_phase, 'release-gate');
    assert.match(out.stopReason, /Transitioning to release-gate\(mvp\)/);
  });

  it('1.6b: phase2-sprint completion with current_cut_id=null routes to phase3-gate (existing behavior)', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'PLAN.md'), `### [x] Task 1\n### [x] Task 2\n`);
    // No goal-contract → init does not set cohort → current_cut_id stays null
    const out = runStopHook(tmpDir, {
      current_phase: 'phase2-sprint',
      release: { current_cut_id: null, completed_cut_ids: [], fix_loop_count: 0, pending_artifact: null },
    });
    const state = readState();
    assert.strictEqual(state.current_phase, 'phase3-gate');
    assert.match(out.stopReason, /Phase 3: Quality Gate/);
  });

  it('1.6c-i: release-gate with no scoped evidence stays at release-gate (no pass-through)', () => {
    // Pre-1.6c-i, the release-gate handler was a stub that passed through
    // unconditionally to release-finalize. After 1.6c-i, the handler reads
    // state.release.gate_results and routes on PASS/FAIL/MISSING. Without
    // any scoped evidence (the migration backfills the defaults to null),
    // the path is MISSING — stay at release-gate and surface guidance.
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    const out = runStopHook(tmpDir, {
      current_phase: 'release-gate',
      release: { current_cut_id: 'mvp', completed_cut_ids: [], fix_loop_count: 0, pending_artifact: null },
    });
    const state = readState();
    assert.strictEqual(state.current_phase, 'release-gate');
    assert.match(out.stopReason, /release-gate\(mvp\).*missing scoped Hard 1\/2\/3 evidence/);
  });

  it('1.6b: release-gate with no active cohort routes defensively to phase3-gate', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    const out = runStopHook(tmpDir, {
      current_phase: 'release-gate',
      release: { current_cut_id: null, completed_cut_ids: [], fix_loop_count: 0, pending_artifact: null },
    });
    const state = readState();
    assert.strictEqual(state.current_phase, 'phase3-gate');
    assert.match(out.stopReason, /no active cohort/);
  });

  it('1.6b: release-finalize appends current cohort to completed_cut_ids and clears current_cut_id', () => {
    // After 1.6c-ii, release-finalize requires goal-contract + decomposition
    // to build the release-manifest before advancing the lifecycle. After
    // 1.6c-iii, it also requires a git repo so snapshot ref creation
    // succeeds (RFC §5.4 §232). All helpers are hoisted function
    // declarations in this describe block.
    initGitFixture(tmpDir);
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeGoalContractWithMvp(tmpDir);
    writeDecompositionWithMvp(tmpDir);
    const out = runStopHook(tmpDir, {
      current_phase: 'release-finalize',
      release: {
        current_cut_id: 'mvp', completed_cut_ids: [], fix_loop_count: 0, pending_artifact: null,
        max_fix_loops: 3,
        gate_results: {
          hard1_baseline: { exit_code: 0 }, hard2_coverage: { exit_code: 0 }, hard3_resilience: { exit_code: 0 },
        },
      },
    });
    const state = readState();
    assert.deepStrictEqual(state.release.completed_cut_ids, ['mvp']);
    assert.strictEqual(state.release.current_cut_id, null);
    assert.strictEqual(state.release.fix_loop_count, 0);
    assert.strictEqual(state.current_phase, 'phase3-gate');
    assert.match(out.stopReason, /release-finalize\(mvp\).*whole-pipeline phase3-gate/);
  });

  it('1.6b: phase2-sprint init does NOT re-enter mvp cohort after it is in completed_cut_ids (RFC §4.5)', () => {
    // Claude review on PR #185: the init guard previously only checked
    // `current_cut_id == null` and re-set "mvp" on every phase2-sprint entry
    // when mvp_scope was still in the contract. This violated RFC §4.5
    // "Never re-entered for the same cut_id within a single pipeline run"
    // on the phase3-gate → phase4-fix → recompose → phase2-sprint loop.
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeGoalContractWithMvp(tmpDir);
    runStopHook(tmpDir, {
      current_phase: 'phase2-sprint',
      release: { current_cut_id: null, completed_cut_ids: ['mvp'], fix_loop_count: 0, pending_artifact: null },
    });
    const state = readState();
    assert.strictEqual(
      state.release.current_cut_id,
      null,
      'init must not re-enter mvp cohort once it is in completed_cut_ids',
    );
  });

  it('1.6b: sprint with FAILED TODOs in active cohort stays in phase2-sprint (does not route to phase3-gate)', () => {
    // Codex review on PR #185 (round 2): the original fix routed to
    // phase3-gate, but with existing all-PASS gate_results that would advance
    // to phase5-finalize and skip release-finalize entirely. The corrected
    // fix stays in phase2-sprint so the user/agent clears FAILED TODOs and
    // re-enters the sprint cleanly, at which point the release path resumes.
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'PLAN.md'), `### [x] Task 1\n### [FAILED] Task 2\n`);
    writeGoalContractWithMvp(tmpDir);
    const out = runStopHook(tmpDir, {
      current_phase: 'phase2-sprint',
      release: { current_cut_id: 'mvp', completed_cut_ids: [], fix_loop_count: 0, pending_artifact: null },
    });
    const state = readState();
    // Must STAY in phase2-sprint — neither release-gate nor phase3-gate.
    assert.strictEqual(state.current_phase, 'phase2-sprint');
    assert.strictEqual(state.release.current_cut_id, 'mvp');
    assert.deepStrictEqual(state.release.completed_cut_ids, []);
    assert.match(out.stopReason, /Staying in phase2-sprint/);
    assert.match(out.stopReason, /Clear the FAILED TODOs/);
  });

  it('1.6b: phase3-gate emits advisory stopReason on active cohort, does NOT auto-revert (#241 B2 / #248)', () => {
    // The original codex round-2 defense-in-depth FORCE-REVERTED to
    // phase2-sprint whenever `state.release.current_cut_id` was set.
    // #241 B2 (delivered via #248) flagged this as over-blocking the
    // legitimate case where the operator has PASS gate evidence but
    // current_cut_id is stale.
    //
    // New behavior: emit an advisory stopReason recommending mpl-recover,
    // but do NOT mutate current_phase. The gate evidence check below
    // remains the actual gate — when all 3 hards are PASS, the
    // controller proceeds to phase5-finalize the same way it would
    // without a cohort marker. When gates are missing, the
    // missing-evidence branches still block.
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    const out = runStopHook(tmpDir, {
      current_phase: 'phase3-gate',
      release: { current_cut_id: 'mvp', completed_cut_ids: [], fix_loop_count: 0, pending_artifact: null },
      gate_results: {
        hard1_baseline: { exit_code: 0 },
        hard2_coverage: { exit_code: 0 },
        hard3_resilience: { exit_code: 0 },
      },
    });
    const state = readState();
    // Auto-revert must NOT happen.
    assert.notStrictEqual(
      state.current_phase,
      'phase2-sprint',
      '#241 B2: must NOT auto-revert to phase2-sprint',
    );
    // current_cut_id is preserved (not cleared by the controller).
    assert.strictEqual(state.release.current_cut_id, 'mvp');
    // All-PASS evidence → controller routed forward to phase5-finalize.
    assert.strictEqual(state.current_phase, 'phase5-finalize');
    // The terminal stopReason describes the PASS transition.
    assert.match(out.stopReason, /Quality Gates passed|Transitioning to Phase 5/);
  });

  it('1.6b: release-finalize is idempotent — re-entering with cohort already in completed_cut_ids does not double-append', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    runStopHook(tmpDir, {
      current_phase: 'release-finalize',
      release: { current_cut_id: 'mvp', completed_cut_ids: ['mvp'], fix_loop_count: 0, pending_artifact: null },
    });
    const state = readState();
    assert.deepStrictEqual(state.release.completed_cut_ids, ['mvp']); // not ['mvp', 'mvp']
  });

  it('1.6b: release-finalize with no active cohort routes defensively to phase3-gate', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    const out = runStopHook(tmpDir, {
      current_phase: 'release-finalize',
      release: { current_cut_id: null, completed_cut_ids: [], fix_loop_count: 0, pending_artifact: null },
    });
    const state = readState();
    assert.strictEqual(state.current_phase, 'phase3-gate');
    assert.match(out.stopReason, /no active cohort/);
  });

  it('blocked_hook pre-mark on phase2 complete → blocks Phase 3 transition', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'PLAN.md'), `
### [x] Task 1
`);
    const out = runStopHook(tmpDir, {
      current_phase: 'phase2-sprint',
      session_status: 'blocked_hook',
      blocked_by_hook: 'mpl-require-test-agent',
      blocked_phase: 'phase-1',
      block_reason: 'missing test-agent',
      resume_instruction: 'Dispatch mpl-test-agent for phase-1',
      blocked_at: '2026-05-18T00:00:00Z',
    });
    assert.match(out.stopReason, /Phase routing is paused by mpl-require-test-agent/);
    assert.doesNotMatch(out.stopReason, /Transitioning to Phase 3/);
    const state = readState();
    assert.strictEqual(state.current_phase, 'phase2-sprint');
    assert.strictEqual(state.session_status, 'blocked_hook');
  });

  // ── Stage A Phase 1.6c-i: release-gate scoped Hard 1/2/3 evidence routing ──

  function releaseStateWith(gateResults, opts = {}) {
    return {
      current_phase: 'release-gate',
      release: {
        current_cut_id: opts.cohort ?? 'mvp',
        completed_cut_ids: opts.completed ?? [],
        fix_loop_count: opts.fixCount ?? 0,
        pending_artifact: null,
        gate_results: gateResults,
        max_fix_loops: opts.maxFix ?? 3,
      },
    };
  }

  it('1.6c-i: release-gate PASS (all 3 structured exit_code=0) → transitions to release-finalize', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    const out = runStopHook(tmpDir, releaseStateWith({
      hard1_baseline: { exit_code: 0, command: 'build' },
      hard2_coverage: { exit_code: 0, command: 'test' },
      hard3_resilience: { exit_code: 0, command: 'contract' },
    }));
    const state = readState();
    assert.strictEqual(state.current_phase, 'release-finalize');
    assert.match(out.stopReason, /release-gate\(mvp\).*passed.*source=structured/);
    // Cohort preserved across transition.
    assert.strictEqual(state.release.current_cut_id, 'mvp');
  });

  it('1.6c-i: release-gate FAIL within budget → routes back to phase2-sprint, increments fix_loop_count, preserves cohort', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    const out = runStopHook(tmpDir, releaseStateWith({
      hard1_baseline: { exit_code: 0, command: 'build' },
      hard2_coverage: { exit_code: 1, command: 'test', stdout_tail: 'failure detected' },
      hard3_resilience: { exit_code: 0, command: 'contract' },
    }, { fixCount: 0, maxFix: 3 }));
    const state = readState();
    assert.strictEqual(state.current_phase, 'phase2-sprint');
    assert.strictEqual(state.release.current_cut_id, 'mvp', 'cohort must be preserved across FAIL→sprint');
    assert.strictEqual(state.release.fix_loop_count, 1);
    // Scoped evidence reset so next attempt starts clean.
    assert.strictEqual(state.release.gate_results.hard1_baseline, null);
    assert.strictEqual(state.release.gate_results.hard2_coverage, null);
    assert.strictEqual(state.release.gate_results.hard3_resilience, null);
    // Top-level state.gate_results isolation is covered by the dedicated
    // "RFC §5.5 isolation" test below, which seeds the top-level subtree
    // explicitly so the assertion has a real before/after to compare.
    assert.match(out.stopReason, /release-gate\(mvp\) FAILED/);
    assert.match(out.stopReason, /Scoped fix loop 1\/3/);
    assert.match(out.stopReason, /Returning to phase2-sprint/);
  });

  it('1.6c-i: release-gate FAIL at threshold → circuit-break: stay at release-gate, pin cohort, surface ⛔', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    const out = runStopHook(tmpDir, releaseStateWith({
      hard1_baseline: { exit_code: 0 },
      hard2_coverage: { exit_code: 2 },
      hard3_resilience: { exit_code: 0 },
    }, { fixCount: 2, maxFix: 3 }));
    const state = readState();
    // Pin: stay at release-gate, no phase transition.
    assert.strictEqual(state.current_phase, 'release-gate');
    assert.strictEqual(state.release.current_cut_id, 'mvp', 'cohort must remain pinned');
    assert.strictEqual(state.release.fix_loop_count, 3, 'count reaches threshold');
    // Evidence NOT reset at circuit-break — user needs the failure record.
    assert.deepStrictEqual(state.release.gate_results.hard2_coverage, { exit_code: 2 });
    assert.match(out.stopReason, /⛔/);
    assert.match(out.stopReason, /circuit-break/);
    assert.match(out.stopReason, /3\/3/);
    assert.match(out.stopReason, /User intervention required/);
  });

  it('1.6c-i: release-gate pinned re-entry does NOT double-increment fix_loop_count past max', () => {
    // Already at threshold (count=3, max=3). Re-entering release-gate (e.g.
    // user re-triggered the loop without mutating state) must not grow the
    // counter past the cap.
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    const out = runStopHook(tmpDir, releaseStateWith({
      hard1_baseline: { exit_code: 0 },
      hard2_coverage: { exit_code: 2 },
      hard3_resilience: { exit_code: 0 },
    }, { fixCount: 3, maxFix: 3 }));
    const state = readState();
    assert.strictEqual(state.current_phase, 'release-gate');
    assert.strictEqual(state.release.fix_loop_count, 3, 'pinned counter must not grow');
    assert.match(out.stopReason, /⛔/);
    assert.match(out.stopReason, /3\/3/);
  });

  it('1.6c-i: release-gate MISSING (zero structured evidence) → continue with stopReason guiding production', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    const out = runStopHook(tmpDir, releaseStateWith({
      hard1_baseline: null,
      hard2_coverage: null,
      hard3_resilience: null,
    }));
    const state = readState();
    // No transition.
    assert.strictEqual(state.current_phase, 'release-gate');
    assert.strictEqual(state.release.fix_loop_count, 0, 'MISSING must not consume fix budget');
    assert.match(out.stopReason, /release-gate\(mvp\)/);
    assert.match(out.stopReason, /missing scoped Hard 1\/2\/3 evidence/);
    assert.match(out.stopReason, /state\.release\.gate_results/);
  });

  it('1.6c-i: release-gate MISSING (partial — 1 of 3 structured) → continue, lists missing keys', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    const out = runStopHook(tmpDir, releaseStateWith({
      hard1_baseline: { exit_code: 0 },
      hard2_coverage: null,
      hard3_resilience: null,
    }));
    const state = readState();
    assert.strictEqual(state.current_phase, 'release-gate');
    assert.match(out.stopReason, /missing scoped Hard 1\/2\/3 evidence/);
    assert.match(out.stopReason, /hard2_coverage/);
    assert.match(out.stopReason, /hard3_resilience/);
    assert.doesNotMatch(out.stopReason, /hard1_baseline/);
  });

  it('1.6c-i: release-gate FAIL does NOT touch top-level state.gate_results (RFC §5.5 isolation)', () => {
    // Defense for the RFC §5.5 invariant: scoped release evidence must
    // never pollute the whole-pipeline gate subtree reserved for the final
    // phase3-gate. Pre-seed top-level gate_results with PASS values and
    // verify they survive a release-gate FAIL untouched.
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    runStopHook(tmpDir, {
      ...releaseStateWith({
        hard1_baseline: { exit_code: 0 },
        hard2_coverage: { exit_code: 1 },
        hard3_resilience: { exit_code: 0 },
      }),
      gate_results: {
        hard1_baseline: { exit_code: 0, command: 'prior whole-pipeline' },
        hard2_coverage: { exit_code: 0, command: 'prior whole-pipeline' },
        hard3_resilience: { exit_code: 0, command: 'prior whole-pipeline' },
      },
    });
    const state = readState();
    // Top-level evidence preserved verbatim.
    assert.deepStrictEqual(state.gate_results.hard1_baseline, {
      exit_code: 0, command: 'prior whole-pipeline',
    });
    assert.deepStrictEqual(state.gate_results.hard2_coverage, {
      exit_code: 0, command: 'prior whole-pipeline',
    });
    // Release-scoped subtree was reset on FAIL→sprint.
    assert.strictEqual(state.release.gate_results.hard2_coverage, null);
  });

  it('1.6c-i: release-gate honors workspace strict mode for missing_gate_evidence', () => {
    // Strict mode (.mpl/config.json enforcement.missing_gate_evidence:
    // "block") changes the MISSING surface wording to ⛔ BLOCKED, matching
    // phase3-gate's behavior so the two gate paths feel consistent.
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'config.json'), JSON.stringify({
      enforcement: { missing_gate_evidence: 'block' },
    }));
    const out = runStopHook(tmpDir, releaseStateWith({
      hard1_baseline: null,
      hard2_coverage: null,
      hard3_resilience: null,
    }));
    assert.match(out.stopReason, /⛔ BLOCKED/);
    assert.match(out.stopReason, /Strict enforcement/);
  });

  it('1.6c-i (PR #186 review): release-gate ALWAYS structured-only — legacy hard1_passed=true alone does NOT pass', () => {
    // Codex/claude High #2 on PR #186: release subtree had no historical
    // legacy evidence so the AD-0006 zero-structured legacy boolean
    // fallback would let a single self-reported `release.gate_results.
    // hard1_passed=true` bypass the structured-only contract and reach
    // release-finalize. The adapter now hard-codes strict:true regardless
    // of workspace `missing_gate_evidence` policy. Verifies the gate
    // refuses to advance under the legacy-only shape.
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    const out = runStopHook(tmpDir, releaseStateWith({
      // Legacy booleans only — would have triggered source=legacy PASS
      // pre-fix because checkGateResults' legacy fallback path returns
      // allPassed when at least one boolean is true and zero are false.
      hard1_passed: true,
      hard2_passed: null,
      hard3_passed: null,
      hard1_baseline: null,
      hard2_coverage: null,
      hard3_resilience: null,
    }));
    const state = readState();
    // Must STAY at release-gate (no PASS transition).
    assert.strictEqual(state.current_phase, 'release-gate');
    assert.match(out.stopReason, /missing scoped Hard 1\/2\/3 evidence/);
    // No bypass to release-finalize.
    assert.doesNotMatch(out.stopReason, /Transitioning to release-finalize/);
  });

  it('1.6c-i (PR #186 review): release-gate strict overrides workspace policy=off (cannot opt-out of structured-only)', () => {
    // Even when the workspace explicitly turns OFF the missing_gate_evidence
    // rule, the release-gate must still reject zero-structured + legacy-
    // boolean evidence. The workspace policy only affects MISSING message
    // wording for parity with phase3-gate; the structured contract is
    // non-negotiable on the release path.
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'config.json'), JSON.stringify({
      enforcement: { missing_gate_evidence: 'off' },
    }));
    const out = runStopHook(tmpDir, releaseStateWith({
      hard1_passed: true,
      hard2_passed: true,
      hard3_passed: true,  // three legacy booleans — pre-fix would have PASSed
      hard1_baseline: null,
      hard2_coverage: null,
      hard3_resilience: null,
    }));
    const state = readState();
    assert.strictEqual(state.current_phase, 'release-gate');
    assert.match(out.stopReason, /missing scoped Hard 1\/2\/3 evidence/);
  });

  // ── Stage A Phase 1.6c-ii: release-finalize writes manifest + evidence + gate-results ──

  function writeDecompositionWithMvp(dir, { phases = ['phase-1', 'phase-2'], artifact = 'draft_pr' } = {}) {
    mkdirSync(join(dir, '.mpl', 'mpl'), { recursive: true });
    writeFileSync(join(dir, '.mpl', 'mpl', 'decomposition.yaml'), `
graph_version: "1.0"
generated_by: mpl-decomposer
recompose_count: 0
completed_phase_policy: immutable
execution_tiers:
  - tier: 1
    phases: [${phases.join(', ')}]
mvp:
  phases: [${phases.join(', ')}]
  execution_mode: sequential
  artifact: ${artifact}
  derived_from: mvp_scope
release_cuts: []
`);
  }

  it('1.6c-ii: release-finalize writes release-manifest.json + evidence-summary.md + gate-results.json under .mpl/mpl/releases/{cut_id}/', () => {
    // 1.6c-iii: snapshot ref creation requires a git repo (RFC §5.4 §232).
    initGitFixture(tmpDir);
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeGoalContractWithMvp(tmpDir);
    writeDecompositionWithMvp(tmpDir);
    runStopHook(tmpDir, {
      current_phase: 'release-finalize',
      pipeline_id: 'mpl-20260524-mvp-fixture',
      release: {
        current_cut_id: 'mvp',
        completed_cut_ids: [],
        fix_loop_count: 0,
        pending_artifact: null,
        max_fix_loops: 3,
        gate_results: {
          hard1_baseline: { exit_code: 0, command: 'npm run build' },
          hard2_coverage: { exit_code: 0, command: 'npm test' },
          hard3_resilience: { exit_code: 0, command: 'contract' },
        },
      },
    });
    const releaseDir = join(tmpDir, '.mpl', 'mpl', 'releases', 'mvp');
    const manifestPath = join(releaseDir, 'release-manifest.json');
    const summaryPath = join(releaseDir, 'evidence-summary.md');
    const gatePath = join(releaseDir, 'gate-results.json');

    assert.ok(existsSync(manifestPath), 'release-manifest.json must exist');
    assert.ok(existsSync(summaryPath), 'evidence-summary.md must exist');
    assert.ok(existsSync(gatePath), 'gate-results.json must exist');

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    assert.equal(manifest.cut_id, 'mvp');
    assert.deepEqual(manifest.phases, ['phase-1', 'phase-2']);
    assert.deepEqual(manifest.goal_trace.acceptance_criteria, ['AC-1']);
    assert.deepEqual(manifest.goal_trace.variation_axes, ['AX-1']);
    assert.equal(manifest.artifact, 'draft_pr');
    assert.equal(manifest.pipeline_id, 'mpl-20260524-mvp-fixture');
    // 1.6c-iii populates snapshot identifiers from git rev-parse.
    assert.match(manifest.commit_sha, /^[0-9a-f]{40}$/);
    assert.match(manifest.tree_sha, /^[0-9a-f]{40}$/);
    assert.equal(manifest.snapshot_ref, 'refs/mpl/releases/mvp');
    assert.deepEqual(manifest.gate_results_summary, { hard1: true, hard2: true, hard3: true });

    const summary = readFileSync(summaryPath, 'utf-8');
    assert.match(summary, /# Release evidence — `mvp`/);
    assert.match(summary, /Artifact:\*\* draft_pr/);
    assert.match(summary, /`phase-1`/);

    const gate = JSON.parse(readFileSync(gatePath, 'utf-8'));
    assert.ok(gate.archived_at);
    assert.equal(gate.gate_results.hard1_baseline.exit_code, 0);
  });

  it('1.6c-ii: release-finalize advances lifecycle (appends completed_cut_ids, clears current, routes to phase3-gate) AFTER write succeeds', () => {
    initGitFixture(tmpDir);
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeGoalContractWithMvp(tmpDir);
    writeDecompositionWithMvp(tmpDir);
    const out = runStopHook(tmpDir, {
      current_phase: 'release-finalize',
      release: {
        current_cut_id: 'mvp',
        completed_cut_ids: [],
        fix_loop_count: 0,
        pending_artifact: null,
        max_fix_loops: 3,
        gate_results: {
          hard1_baseline: { exit_code: 0 }, hard2_coverage: { exit_code: 0 }, hard3_resilience: { exit_code: 0 },
        },
      },
    });
    const state = readState();
    assert.deepStrictEqual(state.release.completed_cut_ids, ['mvp']);
    assert.strictEqual(state.release.current_cut_id, null);
    assert.strictEqual(state.current_phase, 'phase3-gate');
    assert.match(out.stopReason, /Manifest written to \.mpl\/mpl\/releases\/mvp\//);
  });

  it('1.6c-ii: release-finalize MUST NOT set finalize_done or transition to completed (RFC §5.5)', () => {
    initGitFixture(tmpDir);
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeGoalContractWithMvp(tmpDir);
    writeDecompositionWithMvp(tmpDir);
    runStopHook(tmpDir, {
      current_phase: 'release-finalize',
      release: {
        current_cut_id: 'mvp',
        completed_cut_ids: [],
        fix_loop_count: 0,
        pending_artifact: null,
        max_fix_loops: 3,
        gate_results: {
          hard1_baseline: { exit_code: 0 }, hard2_coverage: { exit_code: 0 }, hard3_resilience: { exit_code: 0 },
        },
      },
    });
    const state = readState();
    assert.notStrictEqual(state.finalize_done, true, 'finalize_done is exclusive to phase5-finalize');
    assert.notStrictEqual(state.current_phase, 'completed', 'release path never routes to completed');
  });

  it('1.6c-ii: release-finalize refuses to advance when contract/decomposition lack cohort descriptor', () => {
    // No goal-contract, no decomposition → descriptor missing → manifest
    // would be degraded. Refuse to write, stay at release-finalize,
    // surface actionable message.
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    const out = runStopHook(tmpDir, {
      current_phase: 'release-finalize',
      release: {
        current_cut_id: 'mvp',
        completed_cut_ids: [],
        fix_loop_count: 0,
        pending_artifact: null,
        max_fix_loops: 3,
        gate_results: {
          hard1_baseline: { exit_code: 0 }, hard2_coverage: { exit_code: 0 }, hard3_resilience: { exit_code: 0 },
        },
      },
    });
    const state = readState();
    // No lifecycle advancement.
    assert.strictEqual(state.current_phase, 'release-finalize');
    assert.strictEqual(state.release.current_cut_id, 'mvp');
    assert.deepStrictEqual(state.release.completed_cut_ids, []);
    assert.match(out.stopReason, /cohort descriptor missing/);
    // No file created.
    assert.equal(existsSync(join(tmpDir, '.mpl', 'mpl', 'releases', 'mvp', 'release-manifest.json')), false);
  });

  // PR #187 codex High regression: strict-both-required for resolveCutDescriptor.
  it('1.6c-ii (PR #187 codex review): release-finalize refuses to advance when contract present but decomposition missing', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeGoalContractWithMvp(tmpDir);  // contract only — no decomposition
    const out = runStopHook(tmpDir, {
      current_phase: 'release-finalize',
      release: {
        current_cut_id: 'mvp', completed_cut_ids: [], fix_loop_count: 0,
        pending_artifact: null, max_fix_loops: 3,
        gate_results: {
          hard1_baseline: { exit_code: 0 }, hard2_coverage: { exit_code: 0 }, hard3_resilience: { exit_code: 0 },
        },
      },
    });
    const state = readState();
    assert.strictEqual(state.current_phase, 'release-finalize');
    assert.strictEqual(state.release.current_cut_id, 'mvp');
    assert.deepStrictEqual(state.release.completed_cut_ids, []);
    assert.match(out.stopReason, /cohort descriptor missing/);
    assert.equal(existsSync(join(tmpDir, '.mpl', 'mpl', 'releases', 'mvp', 'release-manifest.json')), false);
  });

  it('1.6c-ii (PR #187 codex review): release-finalize refuses to advance when decomposition present but contract missing', () => {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeDecompositionWithMvp(tmpDir);  // decomposition only — no contract
    const out = runStopHook(tmpDir, {
      current_phase: 'release-finalize',
      release: {
        current_cut_id: 'mvp', completed_cut_ids: [], fix_loop_count: 0,
        pending_artifact: null, max_fix_loops: 3,
        gate_results: {
          hard1_baseline: { exit_code: 0 }, hard2_coverage: { exit_code: 0 }, hard3_resilience: { exit_code: 0 },
        },
      },
    });
    const state = readState();
    assert.strictEqual(state.current_phase, 'release-finalize');
    assert.deepStrictEqual(state.release.completed_cut_ids, []);
    assert.match(out.stopReason, /cohort descriptor missing/);
  });

  // PR #187 round-2 (codex + claude): bail on invalid goal-contract.
  it('1.6c-ii (PR #187 round-2 codex+claude): release-finalize bails when contract.mvp_scope has neither AC nor AX (codex reproducer)', () => {
    // Codex reproducer: `mvp_scope: { artifact: draft_pr }` only — the
    // validator flags `mvp_scope.acceptance_criteria_or_variation_axes`
    // so gcRead.valid=false. Pre-fix the handler ignored gcRead.valid
    // and shipped a manifest with empty goal_trace, flipping D-Q6
    // immutability for a cohort with no acceptance criteria.
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'goal-contract.yaml'), `
source:
  runtime_goal: "x"
  user_request_hash: "abc"
mission:
  goal: "g"
  project_pivot: "pp"
  must_ship_outcomes:
    - "ship"
ontology:
  entities:
    - foo
variation_axes:
  - id: AX-1
    name: ax
acceptance_criteria:
  - id: AC-1
    statement: "ac"
e2e_policy:
  real_runtime_required: true
  mock_allowed: false
  placeholder_assertions_allowed: false
security_policy:
  required: false
completion_evidence:
  required_artifacts:
    - .mpl/mpl/audit-report.json
  require_commit: false
  require_finalize_timestamps: true
mvp_scope:
  artifact: draft_pr
`);
    writeDecompositionWithMvp(tmpDir);
    const out = runStopHook(tmpDir, {
      current_phase: 'release-finalize',
      release: {
        current_cut_id: 'mvp', completed_cut_ids: [], fix_loop_count: 0,
        pending_artifact: null, max_fix_loops: 3,
        gate_results: {
          hard1_baseline: { exit_code: 0 }, hard2_coverage: { exit_code: 0 }, hard3_resilience: { exit_code: 0 },
        },
      },
    });
    const state = readState();
    // No advancement.
    assert.strictEqual(state.current_phase, 'release-finalize');
    assert.strictEqual(state.release.current_cut_id, 'mvp');
    assert.deepStrictEqual(state.release.completed_cut_ids, []);
    assert.match(out.stopReason, /goal-contract is invalid/);
    assert.match(out.stopReason, /mvp_scope\.acceptance_criteria_or_variation_axes/);
    // No file written.
    assert.equal(existsSync(join(tmpDir, '.mpl', 'mpl', 'releases', 'mvp', 'release-manifest.json')), false);
  });

  it('1.6c-ii (PR #187 round-2 codex+claude): release-finalize bails when contract validator flags any structural failure (defense-in-depth)', () => {
    // Any contract validity failure must block release-finalize — even
    // unrelated-looking ones (e.g., unknown AC id) — because a broken
    // contract at release-time means goal_trace cannot be trusted.
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'goal-contract.yaml'), `
source:
  runtime_goal: "x"
  user_request_hash: "abc"
mission:
  goal: "g"
  project_pivot: "pp"
  must_ship_outcomes:
    - "ship"
ontology:
  entities:
    - foo
variation_axes:
  - id: AX-1
    name: ax
acceptance_criteria:
  - id: AC-1
    statement: "ac"
e2e_policy:
  real_runtime_required: true
  mock_allowed: false
  placeholder_assertions_allowed: false
security_policy:
  required: false
completion_evidence:
  required_artifacts:
    - .mpl/mpl/audit-report.json
  require_commit: false
  require_finalize_timestamps: true
mvp_scope:
  acceptance_criteria: [AC-DOES-NOT-EXIST]
  variation_axes: [AX-1]
  artifact: draft_pr
`);
    writeDecompositionWithMvp(tmpDir);
    const out = runStopHook(tmpDir, {
      current_phase: 'release-finalize',
      release: {
        current_cut_id: 'mvp', completed_cut_ids: [], fix_loop_count: 0,
        pending_artifact: null, max_fix_loops: 3,
        gate_results: {
          hard1_baseline: { exit_code: 0 }, hard2_coverage: { exit_code: 0 }, hard3_resilience: { exit_code: 0 },
        },
      },
    });
    const state = readState();
    assert.strictEqual(state.current_phase, 'release-finalize');
    assert.deepStrictEqual(state.release.completed_cut_ids, []);
    assert.match(out.stopReason, /goal-contract is invalid/);
  });

  it('1.6c-ii (PR #187 codex review): release-finalize refuses to advance when graph.mvp.phases is empty', () => {
    // Decomposer wrote `mvp:` block but `phases: []` (mechanical mapping
    // yielded no membership). Manifest would assert "released" with no
    // work — refuse.
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeGoalContractWithMvp(tmpDir);
    writeDecompositionWithMvp(tmpDir, { phases: [] });
    const out = runStopHook(tmpDir, {
      current_phase: 'release-finalize',
      release: {
        current_cut_id: 'mvp', completed_cut_ids: [], fix_loop_count: 0,
        pending_artifact: null, max_fix_loops: 3,
        gate_results: {
          hard1_baseline: { exit_code: 0 }, hard2_coverage: { exit_code: 0 }, hard3_resilience: { exit_code: 0 },
        },
      },
    });
    const state = readState();
    assert.strictEqual(state.current_phase, 'release-finalize');
    assert.deepStrictEqual(state.release.completed_cut_ids, []);
    assert.match(out.stopReason, /cohort descriptor missing/);
  });

  it('1.6c-ii (PR #187 claude review): release artifacts written with 0o644 mode (consumer-friendly)', () => {
    // Skip on Windows where POSIX file modes do not apply.
    if (process.platform === 'win32') return;
    initGitFixture(tmpDir);
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeGoalContractWithMvp(tmpDir);
    writeDecompositionWithMvp(tmpDir);
    runStopHook(tmpDir, {
      current_phase: 'release-finalize',
      release: {
        current_cut_id: 'mvp', completed_cut_ids: [], fix_loop_count: 0,
        pending_artifact: null, max_fix_loops: 3,
        gate_results: {
          hard1_baseline: { exit_code: 0 }, hard2_coverage: { exit_code: 0 }, hard3_resilience: { exit_code: 0 },
        },
      },
    });
    const releaseDir = join(tmpDir, '.mpl', 'mpl', 'releases', 'mvp');
    for (const f of ['release-manifest.json', 'evidence-summary.md', 'gate-results.json']) {
      const mode = statSync(join(releaseDir, f)).mode & 0o777;
      assert.equal(mode, 0o644, `${f} should have mode 0o644 (got ${mode.toString(8)})`);
    }
  });

  it('1.6c-ii: release-finalize re-entry with cohort already in completed_cut_ids overwrites the manifest (idempotent re-write)', () => {
    // PR #185 idempotency: re-entering release-finalize with a cohort
    // already in completed_cut_ids did not double-append. 1.6c-ii adds
    // a file write — re-entry should overwrite the manifest cleanly
    // (no append, no stale read). 1.6c-iii requires a git fixture so
    // snapshot ref creation succeeds (otherwise the bail path fires
    // before the file write).
    initGitFixture(tmpDir);
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeGoalContractWithMvp(tmpDir);
    writeDecompositionWithMvp(tmpDir);
    const releaseDir = join(tmpDir, '.mpl', 'mpl', 'releases', 'mvp');
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, 'release-manifest.json'), JSON.stringify({ stale: true }));
    runStopHook(tmpDir, {
      current_phase: 'release-finalize',
      release: {
        current_cut_id: 'mvp',
        completed_cut_ids: ['mvp'],
        fix_loop_count: 0,
        pending_artifact: null,
        max_fix_loops: 3,
        gate_results: {
          hard1_baseline: { exit_code: 0 }, hard2_coverage: { exit_code: 0 }, hard3_resilience: { exit_code: 0 },
        },
      },
    });
    const state = readState();
    assert.deepStrictEqual(state.release.completed_cut_ids, ['mvp'], 'idempotent: no double-append');
    const manifest = JSON.parse(readFileSync(join(releaseDir, 'release-manifest.json'), 'utf-8'));
    assert.equal(manifest.cut_id, 'mvp', 'stale manifest overwritten');
    assert.equal(manifest.stale, undefined, 'stale field gone');
  });

  // ── Stage A Phase 1.6c-iii: snapshot ref + artifact creation ──

  function initGitFixture(dir) {
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir, encoding: 'utf-8' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    execFileSync('git', ['config', 'tag.gpgSign', 'false'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), '# fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
  }

  function readManifest(dir) {
    return JSON.parse(readFileSync(
      join(dir, '.mpl', 'mpl', 'releases', 'mvp', 'release-manifest.json'),
      'utf-8'
    ));
  }

  it('1.6c-iii: release-finalize populates manifest.commit_sha / tree_sha / snapshot_ref from git rev-parse', () => {
    initGitFixture(tmpDir);
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeGoalContractWithMvp(tmpDir);
    writeDecompositionWithMvp(tmpDir);
    runStopHook(tmpDir, {
      current_phase: 'release-finalize',
      release: {
        current_cut_id: 'mvp', completed_cut_ids: [], fix_loop_count: 0,
        pending_artifact: null, max_fix_loops: 3,
        gate_results: {
          hard1_baseline: { exit_code: 0 }, hard2_coverage: { exit_code: 0 }, hard3_resilience: { exit_code: 0 },
        },
      },
    });
    const manifest = readManifest(tmpDir);
    assert.match(manifest.commit_sha, /^[0-9a-f]{40}$/, 'commit_sha populated');
    assert.match(manifest.tree_sha, /^[0-9a-f]{40}$/, 'tree_sha populated');
    assert.equal(manifest.snapshot_ref, 'refs/mpl/releases/mvp');
    // refs/mpl/releases/mvp actually points at HEAD.
    const refTarget = execFileSync('git', ['rev-parse', 'refs/mpl/releases/mvp'],
      { cwd: tmpDir, encoding: 'utf-8' }).trim();
    assert.equal(refTarget, manifest.commit_sha);
  });

  it('1.6c-iii (PR #188 codex review High): release-finalize bails when snapshot ref creation fails — no manifest written, no append', () => {
    // RFC §5.4 §232: append completed_cut_ids only when gate PASS +
    // manifest write + snapshot ref creation ALL succeed. The snapshot
    // ref is the immutability anchor — without it, the manifest pins
    // nothing. Pre-fix the handler ignored snapshot failure and
    // advanced the lifecycle with null commit_sha/tree_sha/snapshot_ref.
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeGoalContractWithMvp(tmpDir);
    writeDecompositionWithMvp(tmpDir);
    const out = runStopHook(tmpDir, {
      current_phase: 'release-finalize',
      release: {
        current_cut_id: 'mvp', completed_cut_ids: [], fix_loop_count: 0,
        pending_artifact: null, max_fix_loops: 3,
        gate_results: {
          hard1_baseline: { exit_code: 0 }, hard2_coverage: { exit_code: 0 }, hard3_resilience: { exit_code: 0 },
        },
      },
    });
    // No advancement.
    const state = readState();
    assert.strictEqual(state.current_phase, 'release-finalize');
    assert.strictEqual(state.release.current_cut_id, 'mvp');
    assert.deepStrictEqual(state.release.completed_cut_ids, []);
    assert.match(out.stopReason, /snapshot ref creation failed/);
    assert.match(out.stopReason, /Cohort NOT appended to completed_cut_ids per RFC/);
    // No manifest file written (bail happens before file write).
    assert.equal(existsSync(join(tmpDir, '.mpl', 'mpl', 'releases', 'mvp', 'release-manifest.json')), false);
  });

  it('1.6c-iii: release-finalize records artifact_creation_failed.tag when no remote (artifact best-effort)', () => {
    // Git repo set up, snapshot ref succeeds, but no remote so tag push
    // fails. Per RFC §5.4 ("artifact creation depends on external tools
    // out of MPL's control"), lifecycle still advances and the failure
    // is recorded in the manifest.
    initGitFixture(tmpDir);
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    // Goal-contract artifact = tag (override the default draft_pr).
    writeFileSync(join(tmpDir, '.mpl', 'goal-contract.yaml'), `
source:
  runtime_goal: "x"
  user_request_hash: "abc"
mission:
  goal: "g"
  project_pivot: "pp"
  must_ship_outcomes:
    - "ship"
ontology:
  entities:
    - foo
variation_axes:
  - id: AX-1
    name: ax
acceptance_criteria:
  - id: AC-1
    statement: "ac"
e2e_policy:
  real_runtime_required: true
  mock_allowed: false
  placeholder_assertions_allowed: false
security_policy:
  required: false
completion_evidence:
  required_artifacts:
    - .mpl/mpl/audit-report.json
  require_commit: false
  require_finalize_timestamps: true
mvp_scope:
  acceptance_criteria: [AC-1]
  variation_axes: [AX-1]
  artifact: tag
`);
    writeDecompositionWithMvp(tmpDir, { artifact: 'tag' });
    const out = runStopHook(tmpDir, {
      current_phase: 'release-finalize',
      release: {
        current_cut_id: 'mvp', completed_cut_ids: [], fix_loop_count: 0,
        pending_artifact: null, max_fix_loops: 3,
        gate_results: {
          hard1_baseline: { exit_code: 0 }, hard2_coverage: { exit_code: 0 }, hard3_resilience: { exit_code: 0 },
        },
      },
    });
    const manifest = readManifest(tmpDir);
    // Snapshot succeeded.
    assert.match(manifest.commit_sha, /^[0-9a-f]{40}$/);
    // Tag failure recorded.
    assert.equal(manifest.artifact_creation_failed.type, 'tag');
    assert.match(manifest.artifact_creation_failed.reason, /push failed/);
    // Lifecycle advances regardless (RFC §5.4 best-effort).
    const state = readState();
    assert.strictEqual(state.current_phase, 'phase3-gate');
    assert.deepStrictEqual(state.release.completed_cut_ids, ['mvp']);
    assert.match(out.stopReason, /artifact=tag FAILED/);
    // Local tag exists (push failed but local creation succeeded).
    const localTag = execFileSync('git', ['rev-parse', 'refs/tags/mpl-release-mvp'],
      { cwd: tmpDir, encoding: 'utf-8' }).trim();
    assert.equal(localTag, manifest.commit_sha);
  });

  it('1.6c-iii: release-finalize with artifact=release_manifest emits snapshot + manifest only, artifact_creation_failed=null', () => {
    initGitFixture(tmpDir);
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'goal-contract.yaml'), `
source:
  runtime_goal: "x"
  user_request_hash: "abc"
mission:
  goal: "g"
  project_pivot: "pp"
  must_ship_outcomes:
    - "ship"
ontology:
  entities:
    - foo
variation_axes:
  - id: AX-1
    name: ax
acceptance_criteria:
  - id: AC-1
    statement: "ac"
e2e_policy:
  real_runtime_required: true
  mock_allowed: false
  placeholder_assertions_allowed: false
security_policy:
  required: false
completion_evidence:
  required_artifacts:
    - .mpl/mpl/audit-report.json
  require_commit: false
  require_finalize_timestamps: true
mvp_scope:
  acceptance_criteria: [AC-1]
  variation_axes: [AX-1]
  artifact: release_manifest
`);
    writeDecompositionWithMvp(tmpDir, { artifact: 'release_manifest' });
    const out = runStopHook(tmpDir, {
      current_phase: 'release-finalize',
      release: {
        current_cut_id: 'mvp', completed_cut_ids: [], fix_loop_count: 0,
        pending_artifact: null, max_fix_loops: 3,
        gate_results: {
          hard1_baseline: { exit_code: 0 }, hard2_coverage: { exit_code: 0 }, hard3_resilience: { exit_code: 0 },
        },
      },
    });
    const manifest = readManifest(tmpDir);
    assert.match(manifest.commit_sha, /^[0-9a-f]{40}$/);
    assert.equal(manifest.artifact, 'release_manifest');
    assert.equal(manifest.artifact_creation_failed, null);
    // No tag / branch should have been created.
    assert.throws(() => execFileSync('git', ['rev-parse', 'refs/tags/mpl-release-mvp'],
      { cwd: tmpDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }));
    assert.match(out.stopReason, /artifact=release_manifest \(no external push\)/);
  });

  it('1.6c-iii (PR #188 claude #1): release-finalize re-run with artifact=tag does NOT surface spurious "tag already exists"', () => {
    initGitFixture(tmpDir);
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'goal-contract.yaml'), `
source:
  runtime_goal: "x"
  user_request_hash: "abc"
mission:
  goal: "g"
  project_pivot: "pp"
  must_ship_outcomes:
    - "ship"
ontology:
  entities:
    - foo
variation_axes:
  - id: AX-1
    name: ax
acceptance_criteria:
  - id: AC-1
    statement: "ac"
e2e_policy:
  real_runtime_required: true
  mock_allowed: false
  placeholder_assertions_allowed: false
security_policy:
  required: false
completion_evidence:
  required_artifacts:
    - .mpl/mpl/audit-report.json
  require_commit: false
  require_finalize_timestamps: true
mvp_scope:
  acceptance_criteria: [AC-1]
  variation_axes: [AX-1]
  artifact: tag
`);
    writeDecompositionWithMvp(tmpDir, { artifact: 'tag' });
    // First run: local tag created, push fails (no remote), advances lifecycle.
    runStopHook(tmpDir, {
      current_phase: 'release-finalize',
      release: {
        current_cut_id: 'mvp', completed_cut_ids: [], fix_loop_count: 0,
        pending_artifact: null, max_fix_loops: 3,
        gate_results: {
          hard1_baseline: { exit_code: 0 }, hard2_coverage: { exit_code: 0 }, hard3_resilience: { exit_code: 0 },
        },
      },
    });
    // Second run on the same cohort (e.g., recompose loop re-entry).
    const out = runStopHook(tmpDir, {
      current_phase: 'release-finalize',
      release: {
        current_cut_id: 'mvp', completed_cut_ids: ['mvp'], fix_loop_count: 0,
        pending_artifact: null, max_fix_loops: 3,
        gate_results: {
          hard1_baseline: { exit_code: 0 }, hard2_coverage: { exit_code: 0 }, hard3_resilience: { exit_code: 0 },
        },
      },
    });
    // The re-run must NOT surface "tag already exists" — that was the
    // spurious failure mode pre-fix. The push still soft-fails (no
    // remote), but the reason now describes the idempotent "exists
    // locally at same commit" path.
    assert.doesNotMatch(out.stopReason, /tag already exists/i);
    const manifest = readManifest(tmpDir);
    if (manifest.artifact_creation_failed) {
      assert.equal(manifest.artifact_creation_failed.type, 'tag');
      assert.match(
        manifest.artifact_creation_failed.reason,
        /exists locally at same commit/,
        `expected idempotent "exists locally" surface, got: ${manifest.artifact_creation_failed.reason}`,
      );
    }
  });

  it('1.6c-iii: atomic write leaves no .tmp residue on success', () => {
    initGitFixture(tmpDir);
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeGoalContractWithMvp(tmpDir);
    writeDecompositionWithMvp(tmpDir);
    runStopHook(tmpDir, {
      current_phase: 'release-finalize',
      release: {
        current_cut_id: 'mvp', completed_cut_ids: [], fix_loop_count: 0,
        pending_artifact: null, max_fix_loops: 3,
        gate_results: {
          hard1_baseline: { exit_code: 0 }, hard2_coverage: { exit_code: 0 }, hard3_resilience: { exit_code: 0 },
        },
      },
    });
    const releaseDir = join(tmpDir, '.mpl', 'mpl', 'releases', 'mvp');
    const entries = readdirSync(releaseDir);
    assert.ok(!entries.some((f) => f.endsWith('.tmp')),
      `no .tmp residue expected, got: ${entries.join(', ')}`);
    // Three release artifacts are present at the final paths.
    assert.ok(entries.includes('release-manifest.json'));
    assert.ok(entries.includes('evidence-summary.md'));
    assert.ok(entries.includes('gate-results.json'));
  });
});
