import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import {
  checkInvariants,
  formatViolations,
  TRIGGERS,
  VIOLATION_IDS,
} from '../lib/mpl-state-invariant.mjs';

const __filename = fileURLToPath(import.meta.url);
const HOOK_PATH = join(dirname(__filename), '..', 'mpl-state-invariant.mjs');

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mpl-inv-'));
  mkdirSync(join(tmp, '.mpl'), { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function withState(s) {
  writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify(s));
}

function makePhaseFolders(n) {
  for (let i = 1; i <= n; i++) {
    mkdirSync(join(tmp, '.mpl', 'mpl', 'phases', `phase-${i}`), { recursive: true });
  }
}

/* ────────────────────────── lib unit ──────────────────────────────────── */

describe('checkInvariants — basics', () => {
  it('null/undefined state → ok=true', () => {
    assert.deepStrictEqual(checkInvariants(null), { ok: true, violations: [] });
    assert.deepStrictEqual(checkInvariants(undefined), { ok: true, violations: [] });
  });

  it('empty state → ok=true', () => {
    assert.strictEqual(checkInvariants({}, { cwd: tmp }).ok, true);
  });

  it('clean realistic state → ok=true', () => {
    makePhaseFolders(2);
    // Both phase folders carry state-summary.md → counted as completed.
    writeFileSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-1', 'state-summary.md'), '# done');
    writeFileSync(join(tmp, '.mpl', 'mpl', 'phases', 'phase-2', 'state-summary.md'), '# done');
    const r = checkInvariants({
      current_phase: 'phase2-sprint',
      finalize_done: false,
      session_status: 'active',
      schema_version: 2,
      execution: { phases: { completed: 2 } },
      fix_loop_count: 3,
      fix_loop_history: [{ phase: 'p1', count: 2 }, { phase: 'p2', count: 1 }],
    }, { cwd: tmp });
    assert.strictEqual(r.ok, true, JSON.stringify(r.violations, null, 2));
  });
});

describe('I1 paused_budget AND finalize_done', () => {
  it('flags the contradiction', () => {
    const r = checkInvariants({ session_status: 'paused_budget', finalize_done: true }, { cwd: tmp });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.violations[0].id, VIOLATION_IDS.PAUSED_BUT_FINALIZED);
  });
});

describe('I2 completed AND !finalize_done', () => {
  it('flags the contradiction', () => {
    const r = checkInvariants({ current_phase: 'completed', finalize_done: false }, { cwd: tmp });
    assert.ok(r.violations.some((v) => v.id === VIOLATION_IDS.COMPLETED_BUT_NOT_FINALIZED));
  });
  it('completed AND finalize_done=true is fine', () => {
    const r = checkInvariants({ current_phase: 'completed', finalize_done: true }, { cwd: tmp });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.COMPLETED_BUT_NOT_FINALIZED));
  });
});

describe('I3 paused/hung blocks new dispatch', () => {
  for (const status of ['paused_budget', 'paused_checkpoint', 'verification_hang']) {
    it(`flags new Task/Agent dispatch under ${status}`, () => {
      const r = checkInvariants(
        { session_status: status },
        { cwd: tmp, trigger: TRIGGERS.TASK_DISPATCH },
      );
      assert.ok(r.violations.some((v) => v.id === VIOLATION_IDS.PAUSED_NEW_DISPATCH));
    });
  }
  it('does NOT flag dispatch under active', () => {
    const r = checkInvariants(
      { session_status: 'active' },
      { cwd: tmp, trigger: TRIGGERS.TASK_DISPATCH },
    );
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.PAUSED_NEW_DISPATCH));
  });
  it('paused under STOP trigger is not I3 (I1/I2 may apply but I3 does not)', () => {
    const r = checkInvariants(
      { session_status: 'paused_budget' },
      { cwd: tmp, trigger: TRIGGERS.STOP },
    );
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.PAUSED_NEW_DISPATCH));
  });

  it("PR #128 nit #1: 'cancelled' session does NOT block dispatch (cleanup Tasks allowed)", () => {
    // The DISPATCH_BLOCKED_STATUSES set intentionally excludes `cancelled` —
    // a cancelled pipeline may still need to dispatch cleanup Tasks before
    // the session truly exits. The exclusion is documented in lib code.
    const r = checkInvariants(
      { session_status: 'cancelled' },
      { cwd: tmp, trigger: TRIGGERS.TASK_DISPATCH },
    );
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.PAUSED_NEW_DISPATCH));
  });
});

describe('I4 phase folder count vs execution.phases.completed', () => {
  function markCompleted(n) {
    // Only phase-N directories carrying state-summary.md count as completed.
    for (let i = 1; i <= n; i++) {
      writeFileSync(
        join(tmp, '.mpl', 'mpl', 'phases', `phase-${i}`, 'state-summary.md'),
        '# done',
      );
    }
  }

  it('flags mismatch when 3 phases completed but state says 1', () => {
    makePhaseFolders(3);
    markCompleted(3);
    const r = checkInvariants({ execution: { phases: { completed: 1 } } }, { cwd: tmp });
    assert.ok(r.violations.some((v) => v.id === VIOLATION_IDS.PHASE_FOLDER_MISMATCH));
  });
  it('match passes when 3 completed and state agrees', () => {
    makePhaseFolders(3);
    markCompleted(3);
    const r = checkInvariants({ execution: { phases: { completed: 3 } } }, { cwd: tmp });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.PHASE_FOLDER_MISMATCH));
  });
  it('no execution subtree → not measurable', () => {
    makePhaseFolders(3);
    const r = checkInvariants({}, { cwd: tmp });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.PHASE_FOLDER_MISMATCH));
  });

  it('PR #128 review #1: decompose-pre-created phase-N dirs without state-summary do NOT count', () => {
    // commands/mpl-run-decompose.md Step 4 pre-creates every phase-N/ directory
    // before any phase runs; Step 5 initializes execution.phases.completed=0.
    // I4 must read the disk-truth that matches phase-runner finalize artifacts
    // (state-summary.md), not raw directory existence.
    makePhaseFolders(3); // empty dirs only — no state-summary.md
    const r = checkInvariants({
      current_phase: 'phase2-sprint',
      execution: { phases: { total: 3, completed: 0 } },
    }, { cwd: tmp });
    assert.ok(
      !r.violations.some((v) => v.id === VIOLATION_IDS.PHASE_FOLDER_MISMATCH),
      `expected no I4 false positive, got: ${JSON.stringify(r.violations, null, 2)}`,
    );
  });
});

describe('I5 fix_loop_count vs fix_loop_history', () => {
  it('flags desync', () => {
    const r = checkInvariants({
      fix_loop_count: 5,
      fix_loop_history: [{ phase: 'p1', count: 2 }, { phase: 'p2', count: 1 }],
    }, { cwd: tmp });
    assert.ok(r.violations.some((v) => v.id === VIOLATION_IDS.FIX_LOOP_HISTORY_DESYNC));
  });
  it('matching count passes', () => {
    const r = checkInvariants({
      fix_loop_count: 3,
      fix_loop_history: [{ phase: 'p1', count: 2 }, { phase: 'p2', count: 1 }],
    }, { cwd: tmp });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.FIX_LOOP_HISTORY_DESYNC));
  });
  it('no history → not measurable', () => {
    const r = checkInvariants({ fix_loop_count: 5 }, { cwd: tmp });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.FIX_LOOP_HISTORY_DESYNC));
  });
  it('numeric history entries also work', () => {
    const r = checkInvariants({
      fix_loop_count: 3,
      fix_loop_history: [1, 2],
    }, { cwd: tmp });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.FIX_LOOP_HISTORY_DESYNC));
  });
});

describe('I6 phase3-gate state-write missing structured evidence', () => {
  const ent = (exit_code) => ({ command: 'npm test', exit_code, stdout_tail: '', timestamp: 'now' });

  it('all three structured → no violation', () => {
    const r = checkInvariants({
      current_phase: 'phase3-gate',
      gate_results: { hard1_baseline: ent(0), hard2_coverage: ent(0), hard3_resilience: ent(0) },
    }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.GATE_EVIDENCE_MISSING));
  });

  it('partial structured → violation lists missing names', () => {
    const r = checkInvariants({
      current_phase: 'phase3-gate',
      gate_results: { hard1_baseline: ent(0) },
    }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
    const v = r.violations.find((x) => x.id === VIOLATION_IDS.GATE_EVIDENCE_MISSING);
    assert.ok(v);
    assert.deepStrictEqual(v.missing.sort(), ['hard2_coverage', 'hard3_resilience']);
  });

  it('not phase3-gate → not checked', () => {
    const r = checkInvariants({
      current_phase: 'phase2-sprint',
      gate_results: {},
    }, { cwd: tmp, trigger: TRIGGERS.STATE_WRITE });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.GATE_EVIDENCE_MISSING));
  });

  it('STOP trigger → not checked (mpl-phase-controller already gates)', () => {
    const r = checkInvariants({
      current_phase: 'phase3-gate',
      gate_results: {},
    }, { cwd: tmp, trigger: TRIGGERS.STOP });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.GATE_EVIDENCE_MISSING));
  });
});

describe('I7 current_phase folder lifecycle', () => {
  it('flags missing folder for concrete phase id', () => {
    const r = checkInvariants({ current_phase: 'phase-7' }, { cwd: tmp });
    assert.ok(r.violations.some((v) => v.id === VIOLATION_IDS.PHASE_FOLDER_LIFECYCLE));
  });
  it('passes when folder exists', () => {
    makePhaseFolders(3);
    const r = checkInvariants({ current_phase: 'phase-2' }, { cwd: tmp });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.PHASE_FOLDER_LIFECYCLE));
  });
  it('lifecycle markers (phase2-sprint) are exempt', () => {
    const r = checkInvariants({ current_phase: 'phase2-sprint' }, { cwd: tmp });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.PHASE_FOLDER_LIFECYCLE));
  });
});

describe('I8 schema_version range', () => {
  it('flags schema_version > CURRENT_SCHEMA_VERSION', () => {
    const r = checkInvariants({ schema_version: 99 }, { cwd: tmp });
    assert.ok(r.violations.some((v) => v.id === VIOLATION_IDS.SCHEMA_VERSION_UNSUPPORTED));
  });
  it('matches current → ok', () => {
    const r = checkInvariants({ schema_version: 2 }, { cwd: tmp });
    assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.SCHEMA_VERSION_UNSUPPORTED));
  });
});

describe('I9 session_status enum', () => {
  it('flags unknown session_status', () => {
    const r = checkInvariants({ session_status: 'mystery_state' }, { cwd: tmp });
    assert.ok(r.violations.some((v) => v.id === VIOLATION_IDS.SESSION_STATUS_INVALID));
  });
  for (const valid of [null, 'active', 'paused_budget', 'paused_checkpoint', 'verification_hang', 'cancelled']) {
    it(`accepts ${valid === null ? 'null' : valid}`, () => {
      const r = checkInvariants({ session_status: valid }, { cwd: tmp });
      assert.ok(!r.violations.some((v) => v.id === VIOLATION_IDS.SESSION_STATUS_INVALID));
    });
  }
});

describe('Multi-violation aggregation (exp15 4-way desync)', () => {
  it('surfaces 4 simultaneous violations', () => {
    // Realistic desync — I1 (paused+finalize), I4 (folder mismatch), I5
    // (count vs history), I7 (current_phase names a folder that doesn't
    // exist). I1 and I2 are mutually exclusive on the finalize_done field,
    // so this fixture picks the I1 branch.
    makePhaseFolders(2);
    const r = checkInvariants({
      schema_version: 2,
      session_status: 'paused_budget',
      finalize_done: true,                       // I1
      current_phase: 'phase-7',                  // I7 (no phase-7 folder)
      execution: { phases: { completed: 5 } },   // I4 (5 vs 2 on disk)
      fix_loop_count: 10,
      fix_loop_history: [{ phase: 'p1', count: 1 }], // I5 (10 vs 1)
    }, { cwd: tmp });
    const ids = r.violations.map((v) => v.id);
    assert.ok(ids.includes(VIOLATION_IDS.PAUSED_BUT_FINALIZED));
    assert.ok(ids.includes(VIOLATION_IDS.PHASE_FOLDER_MISMATCH));
    assert.ok(ids.includes(VIOLATION_IDS.FIX_LOOP_HISTORY_DESYNC));
    assert.ok(ids.includes(VIOLATION_IDS.PHASE_FOLDER_LIFECYCLE));
    assert.ok(r.violations.length >= 4);
  });
});

describe('formatViolations', () => {
  it('returns empty string when ok', () => {
    assert.strictEqual(formatViolations({ ok: true, violations: [] }), '');
  });
  it('lists ids in summary', () => {
    const text = formatViolations({
      ok: false,
      violations: [
        { id: 'I1', message: 'x' },
        { id: 'I4', message: 'y' },
      ],
    });
    assert.match(text, /\[MPL G3\]/);
    assert.match(text, /I1, I4/);
  });
});

/* ────────────────────────── hook integration ──────────────────────────── */

describe('mpl-state-invariant hook integration', () => {
  function runHook(eventName, toolName, toolInput = {}, extraState = null) {
    if (extraState) withState(extraState);
    const stdin = JSON.stringify({
      cwd: tmp,
      hook_event_name: eventName,
      tool_name: toolName,
      tool_input: toolInput,
    });
    const out = execFileSync('node', [HOOK_PATH], { input: stdin, encoding: 'utf-8' });
    return JSON.parse(out);
  }

  it('clean state → silent', () => {
    const r = runHook('Stop', null, {}, { current_phase: 'phase2-sprint', schema_version: 2 });
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });

  it('I1 violation under default policy (warn) → systemMessage', () => {
    const r = runHook('Stop', null, {}, {
      current_phase: 'phase2-sprint',
      session_status: 'paused_budget',
      finalize_done: true,
    });
    assert.strictEqual(r.continue, true);
    assert.match(r.systemMessage, /\[MPL G3\]/);
    assert.match(r.systemMessage, /I1/);
  });

  it('strict mode → block', () => {
    const r = runHook('Stop', null, {}, {
      current_phase: 'phase2-sprint',
      session_status: 'paused_budget',
      finalize_done: true,
      enforcement: { strict: true },
    });
    assert.strictEqual(r.decision, 'block');
    assert.match(r.reason, /I1/);
  });

  it('off opt-out → silent even with violations', () => {
    writeFileSync(
      join(tmp, '.mpl', 'config.json'),
      JSON.stringify({ enforcement: { state_invariant_violation: 'off' } }),
    );
    const r = runHook('Stop', null, {}, {
      current_phase: 'completed',
      finalize_done: false,
    });
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });

  it('PreToolUse Task with paused_budget → I3 surfaced', () => {
    const r = runHook('PreToolUse', 'Task', {}, {
      current_phase: 'phase2-sprint',
      session_status: 'paused_budget',
    });
    assert.match(r.systemMessage || r.reason || '', /I3/);
  });

  it('PreToolUse Edit on unrelated file → silent (state.json filter)', () => {
    const r = runHook('PreToolUse', 'Edit',
      { file_path: '/tmp/foo.ts', old_string: 'x', new_string: 'y' },
      { current_phase: 'phase3-gate', gate_results: {} },
    );
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });

  it('PreToolUse Edit on .mpl/state.json with phase3-gate missing evidence → I6 surfaced', () => {
    const stateJsonPath = join(tmp, '.mpl', 'state.json');
    const r = runHook('PreToolUse', 'Edit',
      { file_path: stateJsonPath, old_string: 'x', new_string: 'y' },
      { current_phase: 'phase3-gate', gate_results: {} },
    );
    assert.match(r.systemMessage || r.reason || '', /I6/);
  });

  it('PR #128 review #2: PreToolUse Write that strips structured evidence → I6 surfaced (proposed state simulation)', () => {
    // Pre-write state HAS structured evidence; the Write replaces it with
    // legacy-booleans only. The hook must validate the PROPOSED state, not
    // the current on-disk state, otherwise the strip-down silently passes.
    const stateJsonPath = join(tmp, '.mpl', 'state.json');
    const ent = (e) => ({ command: 'npm test', exit_code: e, stdout_tail: '', timestamp: 'now' });
    const cleanState = {
      schema_version: 2,
      current_phase: 'phase3-gate',
      gate_results: {
        hard1_baseline: ent(0),
        hard2_coverage: ent(0),
        hard3_resilience: ent(0),
      },
    };
    writeFileSync(stateJsonPath, JSON.stringify(cleanState));
    const proposedDirty = {
      schema_version: 2,
      current_phase: 'phase3-gate',
      gate_results: { hard1_passed: true, hard2_passed: true, hard3_passed: true },
    };
    const stdin = JSON.stringify({
      cwd: tmp,
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: stateJsonPath, content: JSON.stringify(proposedDirty) },
    });
    const out = execFileSync('node', [HOOK_PATH], { input: stdin, encoding: 'utf-8' });
    const r = JSON.parse(out);
    assert.match(r.systemMessage || r.reason || '', /I6/);
  });

  it('PR #128 review #2: PreToolUse Edit that swaps structured for legacy → I6 surfaced', () => {
    const stateJsonPath = join(tmp, '.mpl', 'state.json');
    const ent = (e) => ({ command: 'npm test', exit_code: e, stdout_tail: '', timestamp: 'now' });
    const cleanState = {
      schema_version: 2,
      current_phase: 'phase3-gate',
      gate_results: {
        hard1_baseline: ent(0),
        hard2_coverage: ent(0),
        hard3_resilience: ent(0),
      },
    };
    const cleanText = JSON.stringify(cleanState);
    writeFileSync(stateJsonPath, cleanText);
    const dirtyText = JSON.stringify({
      schema_version: 2,
      current_phase: 'phase3-gate',
      gate_results: { hard1_passed: true, hard2_passed: true, hard3_passed: true },
    });
    const stdin = JSON.stringify({
      cwd: tmp,
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: stateJsonPath, old_string: cleanText, new_string: dirtyText },
    });
    const out = execFileSync('node', [HOOK_PATH], { input: stdin, encoding: 'utf-8' });
    const r = JSON.parse(out);
    assert.match(r.systemMessage || r.reason || '', /I6/);
  });

  it('Write that ADDS structured evidence (clean transition) → silent, no I6', () => {
    // Inverse case: a Write that introduces structured evidence to a state
    // that previously had none should NOT surface I6.
    const stateJsonPath = join(tmp, '.mpl', 'state.json');
    const ent = (e) => ({ command: 'npm test', exit_code: e, stdout_tail: '', timestamp: 'now' });
    writeFileSync(stateJsonPath, JSON.stringify({
      schema_version: 2,
      current_phase: 'phase3-gate',
      gate_results: {},
    }));
    const proposedClean = {
      schema_version: 2,
      current_phase: 'phase3-gate',
      gate_results: {
        hard1_baseline: ent(0),
        hard2_coverage: ent(0),
        hard3_resilience: ent(0),
      },
    };
    const stdin = JSON.stringify({
      cwd: tmp,
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: stateJsonPath, content: JSON.stringify(proposedClean) },
    });
    const out = execFileSync('node', [HOOK_PATH], { input: stdin, encoding: 'utf-8' });
    const r = JSON.parse(out);
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });

  it('MPL not active → silent', () => {
    rmSync(join(tmp, '.mpl'), { recursive: true });
    const r = runHook('Stop', null, {});
    assert.strictEqual(r.continue, true);
    assert.strictEqual(r.suppressOutput, true);
  });
});
