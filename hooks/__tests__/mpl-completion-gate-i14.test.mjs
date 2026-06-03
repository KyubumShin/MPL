/**
 * I14 — Completion-transition gate (exp24 R0 / G3 + G4).
 *
 * A state-write that flips current_phase -> 'completed' must carry
 * finalize_done===true AND passing structured Hard-Gate evidence
 * (gate_results.{hard1_baseline,hard2_coverage,hard3_resilience}).
 * I14 fires only on STATE_WRITE and is a NON-CONFIGURABLE block at the
 * policy layer (default state_invariant_violation policy is `warn`, which
 * is insufficient — exp24 jumped to completed with null gates / finalize_done
 * false and slipped past every existing gate).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { CURRENT_SCHEMA_VERSION, writeState } from '../lib/mpl-state.mjs';
import {
  checkInvariants,
  VIOLATION_IDS,
  TRIGGERS,
} from '../lib/mpl-state-invariant.mjs';
import { handle as stateInvariantHandle } from '../lib/policy/state-invariant.mjs';

let tmpDir;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'mpl-i14-')); });
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

const pass = { command: 'npm run build', exit_code: 0, source: 'recorder' };
const passingGates = {
  hard1_baseline: { ...pass, command: 'npm run build' },
  hard2_coverage: { ...pass, command: 'npm test' },
  hard3_resilience: { ...pass, command: 'npx playwright test' },
};

// A "completed" state that should be clean (no other invariant fires).
function completedState(overrides = {}) {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    current_phase: 'completed',
    finalize_done: true,
    gate_results: passingGates,
    execution: { status: 'completed', phases: { total: 3, completed: 3, current: null } },
    ...overrides,
  };
}

const ids = (r) => r.violations.map((v) => v.id);

describe('I14 completion gate — checkInvariants (pure)', () => {
  it('clean completed write (finalize_done + passing gates) → no I14', () => {
    const r = checkInvariants(completedState(), { cwd: tmpDir, trigger: TRIGGERS.STATE_WRITE });
    assert.ok(!ids(r).includes(VIOLATION_IDS.COMPLETION_WITHOUT_GATE_EVIDENCE), `unexpected I14: ${JSON.stringify(r.violations)}`);
  });

  it('completed write with gate_results=null → I14', () => {
    const r = checkInvariants(completedState({ gate_results: null }), { cwd: tmpDir, trigger: TRIGGERS.STATE_WRITE });
    assert.ok(ids(r).includes(VIOLATION_IDS.COMPLETION_WITHOUT_GATE_EVIDENCE));
  });

  it('completed write with finalize_done=false → I14 (finalize_done_not_true)', () => {
    const r = checkInvariants(completedState({ finalize_done: false }), { cwd: tmpDir, trigger: TRIGGERS.STATE_WRITE });
    const i14 = r.violations.find((v) => v.id === VIOLATION_IDS.COMPLETION_WITHOUT_GATE_EVIDENCE);
    assert.ok(i14, 'I14 expected');
    assert.ok(i14.issues.includes('finalize_done_not_true'));
  });

  it('completed write with a FAILING gate (exit_code 1) → I14 (not_passing)', () => {
    const r = checkInvariants(
      completedState({ gate_results: { ...passingGates, hard2_coverage: { command: 'npm test', exit_code: 1 } } }),
      { cwd: tmpDir, trigger: TRIGGERS.STATE_WRITE },
    );
    const i14 = r.violations.find((v) => v.id === VIOLATION_IDS.COMPLETION_WITHOUT_GATE_EVIDENCE);
    assert.ok(i14, 'I14 expected');
    assert.ok(i14.issues.includes('hard2_coverage_not_passing'));
  });

  it('explicit waiver (waived:true) counts as passing → no I14', () => {
    const r = checkInvariants(
      completedState({ gate_results: { ...passingGates, hard3_resilience: { command: 'e2e', exit_code: 7, waived: true } } }),
      { cwd: tmpDir, trigger: TRIGGERS.STATE_WRITE },
    );
    assert.ok(!ids(r).includes(VIOLATION_IDS.COMPLETION_WITHOUT_GATE_EVIDENCE));
  });

  it('I14 only fires on STATE_WRITE (not STOP)', () => {
    const r = checkInvariants(completedState({ gate_results: null, finalize_done: false }), { cwd: tmpDir, trigger: TRIGGERS.STOP });
    assert.ok(!ids(r).includes(VIOLATION_IDS.COMPLETION_WITHOUT_GATE_EVIDENCE));
  });

  it('non-completion phase write → no I14', () => {
    const r = checkInvariants(
      { schema_version: CURRENT_SCHEMA_VERSION, current_phase: 'phase2-sprint', gate_results: null },
      { cwd: tmpDir, trigger: TRIGGERS.STATE_WRITE },
    );
    assert.ok(!ids(r).includes(VIOLATION_IDS.COMPLETION_WITHOUT_GATE_EVIDENCE));
  });
});

describe('I14 completion gate — policy layer (NON-CONFIGURABLE block)', () => {
  function seedWorkspace(state) {
    mkdirSync(join(tmpDir, '.mpl'), { recursive: true });
    writeFileSync(join(tmpDir, '.mpl', 'state.json'), JSON.stringify(state));
    // Opt out of I13 (Phase 0 artifacts) so this suite isolates I14 — a real
    // completed run has the artifacts; here we only test the completion gate.
    writeFileSync(join(tmpDir, '.mpl', 'config.json'), JSON.stringify({ phase0_artifacts_required: false }));
  }
  const writeOf = (proposed) => ({
    cwd: tmpDir,
    toolName: 'Write',
    toolInput: { file_path: join(tmpDir, '.mpl', 'state.json'), content: JSON.stringify(proposed) },
  });

  it('BLOCKS a completed write with null gates even under default (warn) policy', () => {
    seedWorkspace({ schema_version: CURRENT_SCHEMA_VERSION, current_phase: 'phase2-sprint' });
    const decision = stateInvariantHandle('state-write', writeOf(completedState({ gate_results: null, finalize_done: false })));
    assert.equal(decision.action, 'block', `expected block, got ${decision.action}: ${decision.reason}`);
    assert.equal(decision.code, 'completion_without_gate_evidence');
  });

  it('ALLOWS a clean completed write (finalize_done + passing gates)', () => {
    seedWorkspace({ schema_version: CURRENT_SCHEMA_VERSION, current_phase: 'phase2-sprint' });
    const decision = stateInvariantHandle('state-write', writeOf(completedState()));
    assert.ok(decision.action === 'allow' || decision.action === 'noop', `expected allow/noop, got ${decision.action}: ${decision.reason}`);
  });
});
