import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import { checkPlanStatus, checkGateResults } from '../mpl-phase-controller.mjs';

const HOOK_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'mpl-phase-controller.mjs');

function runStopHook(cwd, state) {
  mkdirSync(join(cwd, '.mpl'), { recursive: true });
  writeFileSync(join(cwd, '.mpl', 'state.json'), JSON.stringify(state));
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
    // to build the release-manifest before advancing the lifecycle. Both
    // helpers (`writeGoalContractWithMvp`, `writeDecompositionWithMvp`) are
    // function declarations in this describe block — hoisted, so usable
    // here even though `writeDecompositionWithMvp` is defined further down.
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

  it('1.6b: phase3-gate defensively reverts to phase2-sprint when release cohort still active (codex round-2 high)', () => {
    // Defense-in-depth for codex round-2 catch: even if some unknown path
    // (hand-edited state, partial replay) lands at phase3-gate with an
    // active release cohort + all-PASS gate evidence, the guard must
    // refuse to advance to phase5-finalize and instead revert to sprint.
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
    assert.strictEqual(state.current_phase, 'phase2-sprint',
      'phase3-gate must revert to phase2-sprint when an active cohort exists');
    assert.strictEqual(state.release.current_cut_id, 'mvp',
      'current_cut_id must be preserved across the revert');
    assert.match(out.stopReason, /release cohort .* is still active/);
    assert.match(out.stopReason, /Reverting to phase2-sprint/);
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
    // 1.6c-iii placeholders.
    assert.equal(manifest.commit_sha, null);
    assert.equal(manifest.tree_sha, null);
    assert.equal(manifest.snapshot_ref, null);
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
    // (no append, no stale read).
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
});
