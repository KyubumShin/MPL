/**
 * #248 — Follow-up to #241 B2/B3/B4 state-machine relaxations.
 *
 * AC coverage:
 *   - B2: phase3-gate + active cohort + PASS evidence → stopReason
 *     emitted, NOT auto-revert.
 *   - B3: first stagnant tick → advisory stopReason; third
 *     consecutive stagnant tick + `auto_finalize_on_stagnation: true`
 *     → auto-finalize.
 *   - B4: cohort with `complete_pipeline_optional: true` → finalize
 *     accepts cohort closure (only cohort phases checked).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  validateWholeGoalClosure,
  resolveCohortScope,
} from '../lib/mpl-whole-goal-closure.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const HOOKS_DIR = join(REPO_ROOT, 'hooks');

function freshWorkspace(stateOverrides = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'mpl-248-'));
  mkdirSync(join(cwd, '.mpl', 'mpl'), { recursive: true });
  const state = {
    current_phase: 'phase3-gate',
    ...stateOverrides,
  };
  writeFileSync(join(cwd, '.mpl', 'state.json'), JSON.stringify(state));
  writeFileSync(
    join(cwd, '.mpl', 'config.json'),
    JSON.stringify({}),
  );
  return cwd;
}

function runPhaseController(cwd) {
  // Stop hook runs with no stdin payload; the controller reads state directly.
  const script = join(HOOKS_DIR, 'mpl-phase-controller.mjs');
  const out = execSync(`node "${script}"`, {
    input: '',
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 5000,
    env: { ...process.env, MPL_CWD: cwd },
  }).toString();
  // The hook can emit multiple lines (writeState + JSON). Last JSON line wins.
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* skip non-JSON */
    }
  }
  return { _raw: out };
}

function readStateFromDisk(cwd) {
  return JSON.parse(readFileSync(join(cwd, '.mpl', 'state.json'), 'utf-8'));
}

// ---------------------------------------------------------------------------
// B2 — phase3-gate active cohort: advisory, NOT auto-revert
// ---------------------------------------------------------------------------

test('#248 B2: phase3-gate with active current_cut_id no longer auto-reverts to phase2-sprint', () => {
  const cwd = freshWorkspace({
    current_phase: 'phase3-gate',
    release: { current_cut_id: 'cut-1' },
    gate_results: {
      hard1_passed: true,
      hard2_passed: true,
      hard3_passed: true,
      hard1_baseline: { source: 'structured' },
      hard2_coverage: { source: 'structured' },
      hard3_resilience: { source: 'structured' },
    },
  });
  try {
    const decision = runPhaseController(cwd);
    // The decision is the LAST emitted line — when gates all pass that's
    // the phase5-finalize transition stopReason. The B2 advisory was
    // emitted earlier in the stream; the controller did NOT revert
    // current_phase back to phase2-sprint.
    const newState = readStateFromDisk(cwd);
    assert.notEqual(
      newState.current_phase,
      'phase2-sprint',
      'B2: must NOT auto-revert to phase2-sprint',
    );
    assert.ok(decision.continue, 'must keep the pipeline running');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#248 B2 wire: stopReason mentions mpl-recover advisory', () => {
  const text = readFileSync(
    join(REPO_ROOT, 'hooks', 'mpl-phase-controller.mjs'),
    'utf-8',
  );
  // The active-cohort branch must reference mpl-recover and the
  // not-auto-revert promise.
  const branch = text.match(/case 'phase3-gate'[\s\S]{0,3500}?current_cut_id[\s\S]{0,2500}?(?=\/\/ Per-rule policy|gateRuleAction)/);
  assert.ok(branch, 'phase3-gate active-cohort branch must exist');
  assert.match(branch[0], /mpl-recover/);
  assert.match(branch[0], /not auto-reverting|#241 B2|#248/i);
  // The forced writeState back to phase2-sprint inside the branch must be gone.
  assert.ok(
    !/writeState\(cwd,\s*\{\s*current_phase:\s*['"]phase2-sprint['"]/i.test(branch[0]),
    'forced revert to phase2-sprint must be removed',
  );
});

// ---------------------------------------------------------------------------
// B3 — stagnation multi-tick gating
// ---------------------------------------------------------------------------

test('#248 B3 wire: stagnation auto-finalize requires multi-tick + config opt-in', () => {
  const text = readFileSync(
    join(REPO_ROOT, 'hooks', 'mpl-phase-controller.mjs'),
    'utf-8',
  );
  // Must reference the counter, the threshold, and the config flag.
  assert.match(text, /stagnation_tick_count/);
  assert.match(text, /stagnation_window/);
  assert.match(text, /auto_finalize_on_stagnation/);
  // The auto-finalize transition must be GATED by both counter ≥ window AND
  // config flag.
  const fixLoopBlock = text.match(/case 'phase4-fix'[\s\S]+?\n\s*break;/);
  assert.ok(fixLoopBlock, 'phase4-fix block must exist');
  assert.match(
    fixLoopBlock[0],
    /newCount\s*>=\s*stagnationWindow\s*&&\s*autoFinalizeOnStagnation/,
    'auto-finalize must be guarded by counter && config flag',
  );
  // The reset path must clear the counter.
  assert.match(fixLoopBlock[0], /stagnation_tick_count:\s*0/);
});

test('#248 B3 [logic]: single stagnant tick does NOT auto-finalize when config flag is off', () => {
  const cwd = freshWorkspace({
    current_phase: 'phase4-fix',
    fix_loop_count: 1,
    convergence: {
      pass_rate_history: [0.5, 0.5],
      stagnation_window: 3,
      min_improvement: 0.05,
      regression_threshold: -0.1,
    },
  });
  try {
    runPhaseController(cwd);
    const newState = readStateFromDisk(cwd);
    // Must NOT have transitioned to phase5-finalize.
    assert.equal(newState.current_phase, 'phase4-fix');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B4 — complete_pipeline_optional partial-MVP finalize
// ---------------------------------------------------------------------------

test('#248 B4 [unit]: resolveCohortScope returns cohort phases when opted in', () => {
  // State-level opt-in.
  const stateOptIn = {
    release: {
      cohort: {
        complete_pipeline_optional: true,
        phases: ['phase-1', 'phase-2'],
      },
    },
  };
  const cwd = freshWorkspace(stateOptIn);
  try {
    const scope = resolveCohortScope({ cwd, state: stateOptIn });
    assert.deepEqual(scope, ['phase-1', 'phase-2']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#248 B4 [unit]: resolveCohortScope returns null when complete_pipeline_optional is absent', () => {
  const state = {
    release: { cohort: { phases: ['phase-1', 'phase-2'] } },
  };
  const cwd = freshWorkspace(state);
  try {
    assert.equal(resolveCohortScope({ cwd, state }), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#248 B4 [unit]: resolveCohortScope reads workspace config fallback', () => {
  const state = {
    release: { cohort: { phases: ['phase-1', 'phase-2'] } },
  };
  const cwd = freshWorkspace(state);
  try {
    writeFileSync(
      join(cwd, '.mpl', 'config.json'),
      JSON.stringify({ release: { complete_pipeline_optional: true } }),
    );
    const scope = resolveCohortScope({ cwd, state });
    assert.deepEqual(scope, ['phase-1', 'phase-2']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#248 B4 [unit]: resolveCohortScope returns null on missing or empty cohort.phases', () => {
  for (const state of [
    { release: { cohort: { complete_pipeline_optional: true } } },
    { release: { cohort: { complete_pipeline_optional: true, phases: [] } } },
    { release: { cohort: { complete_pipeline_optional: true, phases: 'oops' } } },
    {},
  ]) {
    const cwd = freshWorkspace(state);
    try {
      assert.equal(resolveCohortScope({ cwd, state }), null);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test('#248 B4 [logic]: validateWholeGoalClosure scopes to cohort phases when opted in', () => {
  // 3-phase decomposition; cohort declares only phase-1 + phase-2.
  // Only phase-1 + phase-2 are completed; phase-3 is incomplete with
  // its own AC. With B4 the closure passes; without B4 it fails on
  // phase-3 + the AC carried by phase-3.
  const cwd = freshWorkspace({
    release: {
      cohort: {
        complete_pipeline_optional: true,
        phases: ['phase-1', 'phase-2'],
      },
    },
  });
  try {
    mkdirSync(join(cwd, '.mpl', 'mpl', 'phases', 'phase-1'), { recursive: true });
    mkdirSync(join(cwd, '.mpl', 'mpl', 'phases', 'phase-2'), { recursive: true });
    writeFileSync(
      join(cwd, '.mpl', 'mpl', 'phases', 'phase-1', 'state-summary.md'),
      '# evidence',
    );
    writeFileSync(
      join(cwd, '.mpl', 'mpl', 'phases', 'phase-2', 'state-summary.md'),
      '# evidence',
    );
    writeFileSync(
      join(cwd, '.mpl', 'mpl', 'decomposition.yaml'),
      `phases:
  - id: phase-1
    goal_trace:
      acceptance_criteria: ['AC-1']
      variation_axes: ['AX-1']
  - id: phase-2
    goal_trace:
      acceptance_criteria: ['AC-2']
      variation_axes: []
  - id: phase-3
    goal_trace:
      acceptance_criteria: ['AC-3']
      variation_axes: []
`,
    );
    const contract = {
      acceptance_criteria: ['AC-1', 'AC-2', 'AC-3'],
      variation_axes: ['AX-1'],
    };
    const state = {
      release: {
        cohort: {
          complete_pipeline_optional: true,
          phases: ['phase-1', 'phase-2'],
        },
      },
    };

    // With B4: cohort-scoped → AC-3 doesn't block (it's a non-cohort
    // contract item).
    const cohortVerdict = validateWholeGoalClosure({ cwd, state, contract });
    assert.equal(cohortVerdict.cohort_scoped, true);
    assert.deepEqual(cohortVerdict.scoped_phase_ids, ['phase-1', 'phase-2']);
    // The cohort's AC universe = {AC-1, AC-2}. AC-3 is outside the
    // cohort scope and must not appear as missing.
    const missingAcs = cohortVerdict.issues.filter((i) =>
      i.startsWith('acceptance_criteria:not_completed'),
    );
    assert.equal(missingAcs.length, 0);
    // phase-3 should NOT appear as not_completed when cohort-scoped.
    assert.ok(
      !cohortVerdict.issues.includes('phase-3:not_completed'),
      'cohort-scoped run must not flag non-cohort phases',
    );

    // Without B4 (no opt-in): same decomposition, no flag → whole pipeline.
    const wholePipelineState = { release: { cohort: { phases: ['phase-1', 'phase-2'] } } };
    const wholeVerdict = validateWholeGoalClosure({
      cwd,
      state: wholePipelineState,
      contract,
    });
    assert.equal(wholeVerdict.cohort_scoped, false);
    // Both phase-3 incomplete AND AC-3 not covered must surface.
    assert.ok(wholeVerdict.issues.includes('phase-3:not_completed'));
    assert.ok(
      wholeVerdict.issues.some((i) => i === 'acceptance_criteria:not_completed:AC-3'),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#248 B4 [logic]: stale cohort phase ids (not in decomposition) fail closed', () => {
  const cwd = freshWorkspace({
    release: {
      cohort: {
        complete_pipeline_optional: true,
        phases: ['phase-stale-1', 'phase-stale-2'],
      },
    },
  });
  try {
    writeFileSync(
      join(cwd, '.mpl', 'mpl', 'decomposition.yaml'),
      `phases:
  - id: phase-1
    goal_trace:
      acceptance_criteria: ['AC-1']
`,
    );
    const verdict = validateWholeGoalClosure({
      cwd,
      state: {
        release: {
          cohort: {
            complete_pipeline_optional: true,
            phases: ['phase-stale-1', 'phase-stale-2'],
          },
        },
      },
      contract: { acceptance_criteria: ['AC-1'] },
    });
    assert.equal(verdict.valid, false);
    assert.match(
      verdict.issues[0] || '',
      /cohort:phases_not_in_decomposition/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
