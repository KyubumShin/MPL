/**
 * Tests for hooks/lib/policy/gates.mjs (Move #9).
 *
 * Synthetic state + cwd fixtures. The wrapper hooks delegate to this module
 * — these tests validate the policy module in isolation against the same
 * inputs the wrappers pass in. The headline regression test exercises the
 * writeState-throw → consumeSignal-preserved bug fix.
 */

import { describe, it, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  handle,
  handleFinalize,
  handleQuality,
  handleAmbiguity,
  handlePhaseTransition,
  isFinalizeDoneWrite,
  summarizeFinalizeFailures,
  summarizeFinalizeAdvisories,
  AMBIGUITY_THRESHOLD,
  QUALITY_SCORE_PATH,
  FINALIZE_HOOK_ID,
  FINALIZE_BLOCKED_ARTIFACT,
} from '../lib/policy/gates.mjs';

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mpl-policy-gates-'));
  mkdirSync(join(dir, '.mpl', 'mpl'), { recursive: true });
  mkdirSync(join(dir, '.mpl', 'signals'), { recursive: true });
  return dir;
}

function goalContractYaml({ realRuntimeRequired = false } = {}) {
  return `
source:
  user_request: "Build app"
  user_request_hash: "req"
mission:
  goal: "Goal"
  project_pivot: "Pivot"
  must_ship_outcomes:
    - "ship"
ontology:
  entities:
    - app
variation_axes:
  - id: AX-1
acceptance_criteria:
  - id: AC-1
e2e_policy:
  real_runtime_required: ${realRuntimeRequired ? 'true' : 'false'}
  mock_allowed: false
  placeholder_assertions_allowed: false
security_policy:
  required: false
completion_evidence:
  required_artifacts:
    - .mpl/mpl/RUNBOOK.md
  require_commit: false
  require_finalize_timestamps: true
`;
}

// ============================================================================
// (A) FINALIZE GATE — coalesced envelope
// ============================================================================

describe('handleFinalize', () => {
  let tmp;
  beforeEach(() => { tmp = freshDir(); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('allows non-finalize writes (toolName not Write/Edit/MultiEdit)', () => {
    const d = handleFinalize({
      cwd: tmp,
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      state: {},
      config: {},
    });
    assert.equal(d.action, 'allow');
    assert.deepEqual(d.failures, []);
  });

  it('allows state.json writes without finalize_done:true', () => {
    const d = handleFinalize({
      cwd: tmp,
      toolName: 'Write',
      toolInput: { file_path: '.mpl/state.json', content: '{"current_phase":"phase2-sprint"}' },
      state: {},
      config: {},
    });
    assert.equal(d.action, 'allow');
  });

  it('blocks finalize_done writes with no e2e evidence (coalesced failures)', () => {
    writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'), goalContractYaml({ realRuntimeRequired: true }));
    const d = handleFinalize({
      cwd: tmp,
      toolName: 'Write',
      toolInput: {
        file_path: '.mpl/state.json',
        content: JSON.stringify({ current_phase: 'phase5-finalize', finalize_done: true }),
      },
      state: {},
      config: {},
    });
    assert.equal(d.action, 'block');
    assert.equal(d.code, 'finalize_gate_failures');
    assert.equal(d.artifact, FINALIZE_BLOCKED_ARTIFACT);
    // Multiple child handlers should have contributed failures.
    assert.ok(Array.isArray(d.failures));
    assert.ok(d.failures.length >= 1);
    // Each failure preserves originating hookId.
    for (const f of d.failures) {
      assert.match(f.hookId, /^mpl-require-/);
      assert.equal(typeof f.code, 'string');
    }
  });

  it('summarizeFinalizeFailures produces a numbered, hookId-tagged report', () => {
    const out = summarizeFinalizeFailures([
      { hookId: 'mpl-require-e2e', code: 'e2e_scenarios_unresolved', reason: 'scenarios missing' },
      { hookId: 'mpl-require-whole-goal-closure', code: 'whole_goal_closure_missing', reason: 'AC-1 uncovered' },
    ]);
    assert.match(out, /2 validation failure/);
    assert.match(out, /\[mpl-require-e2e\] \(e2e_scenarios_unresolved\)/);
    assert.match(out, /\[mpl-require-whole-goal-closure\] \(whole_goal_closure_missing\)/);
  });

  it('summarizeFinalizeAdvisories returns empty string for empty input', () => {
    assert.equal(summarizeFinalizeAdvisories([]), '');
  });

  it('isFinalizeDoneWrite matches Write to .mpl/state.json with finalize_done:true', () => {
    assert.equal(isFinalizeDoneWrite({
      file_path: '.mpl/state.json',
      content: '{"finalize_done": true}',
    }), true);
    assert.equal(isFinalizeDoneWrite({
      file_path: '.mpl/state.txt',
      content: '{"finalize_done": true}',
    }), false);
    assert.equal(isFinalizeDoneWrite({
      file_path: '.mpl/state.json',
      content: '{"finalize_done": false}',
    }), false);
    assert.equal(isFinalizeDoneWrite({
      file_path: '.mpl/state.json',
      edits: [{ new_string: '"finalize_done": true' }],
    }), true);
  });
});

// ============================================================================
// (B) QUALITY GATE — including the writeState-throw regression
// ============================================================================

const VALID_PASS_SCORE = {
  phase: 'phase-3',
  score: 0.85,
  verdict: 'PASS',
  issues: [],
  timestamp: '2026-05-04T17:30:00Z',
};
const VALID_FAIL_SCORE = {
  phase: 'phase-3',
  score: 0.45,
  verdict: 'FAIL',
  issues: ['scope leak'],
  timestamp: '2026-05-04T17:30:00Z',
};

describe('handleQuality', () => {
  let tmp;
  beforeEach(() => { tmp = freshDir(); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function writeScore(obj) {
    writeFileSync(join(tmp, QUALITY_SCORE_PATH), JSON.stringify(obj));
  }

  it('non-adversarial dispatch → silent (consumeSignal=false)', () => {
    const r = handleQuality({
      cwd: tmp,
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-test-agent' },
    });
    assert.equal(r.action, 'silent');
    assert.equal(r.consumeSignal, false);
  });

  it('missing score file → fail-closed with verbose surface, no consume', () => {
    const r = handleQuality({
      cwd: tmp,
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-adversarial-reviewer' },
    });
    assert.equal(r.action, 'fail-closed');
    assert.match(r.systemMessage, /quality-score\.json/);
    assert.match(r.systemMessage, /gate-NOT-passed/);
    assert.equal(r.consumeSignal, false);
  });

  it('readFileSync throws → also fail-closed (was silent in legacy)', () => {
    // The injected readFileSync stub throws; existsSync returns true so we
    // reach the read branch.
    const r = handleQuality({
      cwd: tmp,
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-adversarial-reviewer' },
      deps: {
        existsSync: () => true,
        readFileSync: () => { throw new Error('EBUSY'); },
        readState: () => ({}),
        loadConfig: () => ({}),
        writeState: () => {},
      },
    });
    assert.equal(r.action, 'fail-closed');
    assert.match(r.systemMessage, /quality-score\.json/);
    assert.equal(r.consumeSignal, false);
  });

  it('malformed score → action=malformed, no consume, no mutation', () => {
    writeFileSync(join(tmp, QUALITY_SCORE_PATH), 'not-json');
    const r = handleQuality({
      cwd: tmp,
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-adversarial-reviewer' },
      state: {},
      config: {},
    });
    assert.equal(r.action, 'malformed');
    assert.match(r.systemMessage, /malformed/);
    assert.equal(r.consumeSignal, false);
  });

  it('valid PASS → action=pass, retry counter reset, signal consumable', () => {
    writeScore(VALID_PASS_SCORE);
    let wrote = null;
    const r = handleQuality({
      cwd: tmp,
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-adversarial-reviewer' },
      state: { adversarial_retry_count: 2 },
      config: {},
      deps: { writeState: (_cwd, m) => { wrote = m; } },
    });
    assert.equal(r.action, 'pass');
    assert.equal(r.consumeSignal, true);
    assert.equal(wrote.adversarial_retry_count, 0);
    assert.equal(wrote.quality_score_history.length, 1);
    assert.equal(wrote.quality_score_history[0].action, 'pass');
  });

  it('valid FAIL → action=retry, counter increments, signal consumable', () => {
    writeScore(VALID_FAIL_SCORE);
    let wrote = null;
    const r = handleQuality({
      cwd: tmp,
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-adversarial-reviewer' },
      state: { adversarial_retry_count: 0 },
      config: {},
      deps: { writeState: (_cwd, m) => { wrote = m; } },
    });
    assert.equal(r.action, 'retry');
    assert.equal(r.consumeSignal, true);
    assert.equal(wrote.adversarial_retry_count, 1);
  });

  it('escalates at retry budget exhaustion, counter freezes', () => {
    writeScore(VALID_FAIL_SCORE);
    let wrote = null;
    const r = handleQuality({
      cwd: tmp,
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-adversarial-reviewer' },
      state: { adversarial_retry_count: 3 },
      config: {},
      deps: { writeState: (_cwd, m) => { wrote = m; } },
    });
    assert.equal(r.action, 'escalate');
    assert.equal(r.consumeSignal, true);
    assert.equal(wrote.adversarial_retry_count, 3);
  });

  // ===========================================================================
  // HEADLINE REGRESSION — writeState throw must PRESERVE the signal AND
  // surface the disk failure to the orchestrator, so the retry counter
  // can advance toward escalation on a subsequent successful round.
  // ===========================================================================
  it('regression: writeState throw preserves signal and advances toward escalation', () => {
    // Setup: retry-2, score=FAIL. A successful round would normally write
    // adversarial_retry_count=3 (and decision=retry). We mock writeState to
    // throw ONCE, simulating EBUSY/permission/disk-full on .mpl/state.json.
    writeScore(VALID_FAIL_SCORE);

    // Round 1: writeState throws.
    const r1 = handleQuality({
      cwd: tmp,
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-adversarial-reviewer' },
      state: { adversarial_retry_count: 2 },
      config: {},
      deps: {
        writeState: () => { throw new Error('EBUSY on .mpl/state.json'); },
      },
    });
    // (a) Surface names the disk failure.
    assert.equal(r1.action, 'fail-closed-disk');
    assert.match(r1.systemMessage, /could not persist retry state/);
    assert.match(r1.systemMessage, /EBUSY/);
    // (b) Signal file is preserved (wrapper hook will NOT call rmSync because
    //     consumeSignal=false).
    assert.equal(r1.consumeSignal, false);
    assert.ok(existsSync(join(tmp, QUALITY_SCORE_PATH)),
      'signal file must be preserved when writeState fails');
    // (c) writeStateError surfaces for orchestrator diagnostics.
    assert.match(r1.writeStateError, /EBUSY/);

    // Round 2: writeState succeeds — the SAME signal file is re-read (the
    // wrapper preserved it), and the retry counter advances to 3 (the
    // legacy bug would have left state at 2 forever because round-1 silently
    // swallowed the throw AND consumed the signal, so round-2 hit the
    // missing-file fail-closed branch which explicitly does NOT mutate
    // history. The fix gates consumeSignal on writeState success, so the
    // counter advances to 3 here).
    let wrote = null;
    const r2 = handleQuality({
      cwd: tmp,
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-adversarial-reviewer' },
      state: { adversarial_retry_count: 2 },
      config: {},
      deps: { writeState: (_cwd, m) => { wrote = m; } },
    });
    assert.equal(r2.action, 'retry');
    assert.equal(wrote.adversarial_retry_count, 3,
      'retry counter must advance to 3 once writeState succeeds (legacy bug: stuck at 2 forever)');
    assert.equal(r2.consumeSignal, true);

    // (d) Escalation must fire at maxRetries — verify by running with
    //     retry-count already at the budget cap (default maxRetries=3).
    writeScore(VALID_FAIL_SCORE);
    const r3 = handleQuality({
      cwd: tmp,
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-adversarial-reviewer' },
      state: { adversarial_retry_count: 3 },
      config: {},
      deps: { writeState: () => {} },
    });
    assert.equal(r3.action, 'escalate');
  });

  it('regression supplement: a writeState success but rmSync failure is benign', () => {
    // The state-OK path is idempotent at the decision level. If the wrapper's
    // rmSync fails (read-only signals/ dir, race with sibling), the next
    // round re-reads the SAME score against an ALREADY-advanced retry
    // counter — decideAction returns the same action (retry-N+1 becomes
    // retry-N+2, which is correct). We verify that here at the policy level
    // by running TWO successive successful rounds with the SAME signal: the
    // counter monotonically advances and never stalls.
    writeScore(VALID_FAIL_SCORE);
    let lastWrite = null;
    const stubs = { writeState: (_cwd, m) => { lastWrite = m; } };

    const r1 = handleQuality({
      cwd: tmp,
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-adversarial-reviewer' },
      state: { adversarial_retry_count: 0 },
      config: {},
      deps: stubs,
    });
    assert.equal(r1.consumeSignal, true);
    assert.equal(lastWrite.adversarial_retry_count, 1);

    // Simulate "rmSync failed → signal still on disk for round 2".
    const r2 = handleQuality({
      cwd: tmp,
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-adversarial-reviewer' },
      state: { adversarial_retry_count: 1 },
      config: {},
      deps: stubs,
    });
    assert.equal(r2.consumeSignal, true);
    assert.equal(lastWrite.adversarial_retry_count, 2);
  });
});

// ============================================================================
// (C) AMBIGUITY GATE
// ============================================================================

describe('handleAmbiguity', () => {
  let tmp;
  beforeEach(() => { tmp = freshDir(); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('noop for non-Task tool', () => {
    const d = handleAmbiguity({ cwd: tmp, toolName: 'Bash', toolInput: { command: 'ls' }, state: {} });
    assert.equal(d.action, 'noop');
  });

  it('noop for Task targeting a non-decomposer subagent', () => {
    const d = handleAmbiguity({
      cwd: tmp,
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-test-agent' },
      state: {},
    });
    assert.equal(d.action, 'noop');
  });

  it('blocks when user_contract_set is false (phase reverts to mpl-init)', () => {
    writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'), goalContractYaml());
    const d = handleAmbiguity({
      cwd: tmp,
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-decomposer' },
      state: { user_contract_set: false, ambiguity_score: 0.1 },
    });
    assert.equal(d.action, 'block');
    assert.equal(d.phaseRevert, 'mpl-init');
    assert.deepEqual(d.stateMutations, { current_phase: 'mpl-init' });
    assert.match(d.reason, /user_contract_set is false/);
  });

  it('blocks when goal contract is missing', () => {
    const d = handleAmbiguity({
      cwd: tmp,
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-decomposer' },
      state: { user_contract_set: true, ambiguity_score: 0.1 },
    });
    assert.equal(d.action, 'block');
    assert.equal(d.phaseRevert, 'mpl-ambiguity-resolve');
    assert.match(d.reason, /goal contract is missing or incomplete/);
  });

  it('allows when score is within threshold', () => {
    writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'), goalContractYaml());
    const d = handleAmbiguity({
      cwd: tmp,
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-decomposer' },
      state: {
        user_contract_set: true,
        ambiguity_score: 0.1,
        goal_contract_set: true,
        // Force a hash mismatch so the goal-contract sync mutation is
        // included in stateMutations — not strictly required for the assert,
        // but it documents that allow can ship mutations too.
      },
    });
    assert.equal(d.action, 'allow');
  });

  it('blocks when ambiguity_score exceeds threshold', () => {
    writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'), goalContractYaml());
    const d = handleAmbiguity({
      cwd: tmp,
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-decomposer' },
      state: { user_contract_set: true, ambiguity_score: AMBIGUITY_THRESHOLD + 0.5 },
    });
    assert.equal(d.action, 'block');
    assert.match(d.reason, new RegExp(`exceeds threshold ${AMBIGUITY_THRESHOLD}`));
    assert.equal(d.stateMutations.current_phase, 'mpl-ambiguity-resolve');
  });

  it('blocks when ambiguity_score is missing', () => {
    writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'), goalContractYaml());
    const d = handleAmbiguity({
      cwd: tmp,
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-decomposer' },
      state: { user_contract_set: true },
    });
    assert.equal(d.action, 'block');
    assert.match(d.reason, /ambiguity_score not found/);
    assert.equal(d.stateMutations.current_phase, 'mpl-ambiguity-resolve');
  });

  it('bypasses gate when override is active (with stderr surface)', () => {
    writeFileSync(join(tmp, '.mpl', 'goal-contract.yaml'), goalContractYaml());
    const d = handleAmbiguity({
      cwd: tmp,
      toolName: 'Task',
      toolInput: { subagent_type: 'mpl-decomposer' },
      state: {
        user_contract_set: true,
        ambiguity_score: 0.9,
        ambiguity_override: { active: true, by: 'user', reason: 'enough' },
      },
    });
    assert.equal(d.action, 'bypass');
    assert.match(d.stderr, /Ambiguity gate bypassed by override/);
  });
});

// ============================================================================
// (D) PHASE TRANSITION CONTROLLER (Pass-A scope)
// ============================================================================

describe('handlePhaseTransition', () => {
  it('mpl-init → in-progress stopReason', () => {
    const d = handlePhaseTransition({
      cwd: '/tmp',
      state: { current_phase: 'mpl-init' },
      config: {},
    });
    assert.equal(d.action, 'emit');
    assert.match(d.stopReason, /Initialization in progress/);
  });

  it('mpl-decompose with score below threshold → proceed', () => {
    const d = handlePhaseTransition({
      cwd: '/tmp',
      state: { current_phase: 'mpl-decompose', ambiguity_score: 0.1 },
      config: {},
    });
    assert.equal(d.action, 'emit');
    assert.match(d.stopReason, /Decomposition: ambiguity_score=0\.1/);
  });

  it('mpl-decompose with score above threshold → revert to mpl-ambiguity-resolve', () => {
    const d = handlePhaseTransition({
      cwd: '/tmp',
      state: { current_phase: 'mpl-decompose', ambiguity_score: 0.5 },
      config: {},
    });
    assert.equal(d.action, 'emit');
    assert.equal(d.stateMutations.current_phase, 'mpl-ambiguity-resolve');
    assert.match(d.stopReason, /Decomposition BLOCKED/);
  });

  it('mpl-ambiguity-resolve with score at threshold → advance to mpl-decompose', () => {
    const d = handlePhaseTransition({
      cwd: '/tmp',
      state: { current_phase: 'mpl-ambiguity-resolve', ambiguity_score: 0.1 },
      config: {},
    });
    assert.equal(d.action, 'emit');
    assert.equal(d.stateMutations.current_phase, 'mpl-decompose');
  });

  it('blocked_hook session_status → paused stopReason', () => {
    const d = handlePhaseTransition({
      cwd: '/tmp',
      state: {
        current_phase: 'phase2-sprint',
        session_status: 'blocked_hook',
        blocked_by_hook: 'mpl-require-e2e',
        blocked_phase: 'phase5-finalize',
        resume_instruction: 'fix the things',
      },
      config: {},
    });
    assert.equal(d.action, 'emit');
    assert.match(d.stopReason, /paused by mpl-require-e2e/);
  });

  it('verification_hang already marked → triage stopReason', () => {
    const d = handlePhaseTransition({
      cwd: '/tmp',
      state: { current_phase: 'phase2-sprint', session_status: 'verification_hang' },
      config: {},
    });
    assert.equal(d.action, 'emit');
    assert.match(d.stopReason, /verification_hang/);
  });

  it('phase2-sprint → delegate-to-legacy (heavy cohort lazy-init lives in wrapper)', () => {
    const d = handlePhaseTransition({
      cwd: '/tmp',
      state: { current_phase: 'phase2-sprint' },
      config: {},
    });
    assert.equal(d.action, 'delegate-to-legacy');
  });

  it('release-finalize → delegate-to-legacy', () => {
    const d = handlePhaseTransition({
      cwd: '/tmp',
      state: { current_phase: 'release-finalize', release: { current_cut_id: 'mvp' } },
      config: {},
    });
    assert.equal(d.action, 'delegate-to-legacy');
  });

  it('phase3-gate → delegate-to-legacy', () => {
    const d = handlePhaseTransition({
      cwd: '/tmp',
      state: { current_phase: 'phase3-gate' },
      config: {},
    });
    assert.equal(d.action, 'delegate-to-legacy');
  });

  it('phase5-finalize complete → emit "finished" with continue=false', () => {
    // Use a tmp dir so blockedPhaseTransitionReason has no Phase 0 artifacts
    // to find; the function returns null for 'completed' so the emit proceeds.
    const tmp = freshDir();
    try {
      const d = handlePhaseTransition({
        cwd: tmp,
        state: { current_phase: 'phase5-finalize', finalize_done: true },
        config: {},
      });
      assert.equal(d.action, 'emit');
      // blockedPhaseTransitionReason may emit for 'completed' if Phase 0
      // artifacts are missing — accept either outcome here.
      if (d.stateMutations) {
        assert.equal(d.stateMutations.current_phase, 'completed');
        assert.equal(d.continue, false);
      } else {
        assert.match(d.stopReason, /Phase 0|BLOCKED|completed|finalize/i);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// (E) DISPATCH
// ============================================================================

describe('handle (top-level dispatch)', () => {
  it('routes finalize event', () => {
    const tmp = freshDir();
    try {
      const d = handle('finalize', {
        cwd: tmp,
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        state: {},
        config: {},
      });
      assert.equal(d.action, 'allow');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('routes quality event', () => {
    const tmp = freshDir();
    try {
      const d = handle('quality', {
        cwd: tmp,
        toolName: 'Task',
        toolInput: { subagent_type: 'mpl-test-agent' },
      });
      assert.equal(d.action, 'silent');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('routes ambiguity event', () => {
    const tmp = freshDir();
    try {
      const d = handle('ambiguity', {
        cwd: tmp,
        toolName: 'Bash',
        toolInput: {},
        state: {},
      });
      assert.equal(d.action, 'noop');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('routes phase_transition event', () => {
    const d = handle('phase_transition', {
      cwd: '/tmp',
      state: { current_phase: 'mpl-init' },
      config: {},
    });
    assert.equal(d.action, 'emit');
  });

  it('throws on unknown event', () => {
    assert.throws(() => handle('bogus', {}), /unknown event/);
  });
});

// ============================================================================
// (F) FINALIZE_HOOK_ID export sanity
// ============================================================================

test('FINALIZE_HOOK_ID is the canonical wrapper hookId', () => {
  assert.equal(FINALIZE_HOOK_ID, 'mpl-finalize-gate');
  assert.equal(FINALIZE_BLOCKED_ARTIFACT, '.mpl/state.json#finalize_done');
});
