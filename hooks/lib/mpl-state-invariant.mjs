/**
 * MPL State Invariant Checker (G3 + H1, #108)
 *
 * exp15 surfaced 4 simultaneous state.json contradictions that no existing
 * gate caught (R-STATE-DESYNC, Evidence grade A). G3 introduces a single
 * structural validator; H1 freezes the sprint-vs-phase schema split so the
 * checker has a stable reference.
 *
 * Pure functions. Returns a list of violations; the consuming hook decides
 * `warn` / `block` / `off` via the P0-2 `state_invariant_violation` rule.
 *
 * Schema reference (H1 frozen — see docs/schemas/state.md):
 *   - `execution.phases.*`  = phase units (per phase-runner invocation)
 *   - `sprint_status.*`     = sprint units (multiple phases together)
 *   - `current_phase`       = lifecycle marker, not a phase id
 *   - `session_status`      = pause/hang reason; mutually exclusive with each other
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve, sep } from 'path';

import { CURRENT_SCHEMA_VERSION } from './mpl-state.mjs';
import { classifyGateCommand } from './mpl-gate-classify.mjs';
import { REQUIRES_PHASE0_ARTIFACTS, missingPhase0Artifacts } from './mpl-phase0-artifacts.mjs';
import { loadConfig } from './mpl-config.mjs';

// Re-export so consumers (and the H8 single-source-of-truth test) can
// confirm both modules agree on the version constant via a single
// import. Without this re-export the SSOT test had to reach back into
// mpl-state.mjs and ended up comparing the constant to itself.
export { CURRENT_SCHEMA_VERSION };

/**
 * Trigger contexts. Different triggers care about different invariants — for
 * example "no new phase dispatch while paused" only matters when the trigger
 * is a Task/Agent PreToolUse, not a vanilla Stop.
 */
export const TRIGGERS = Object.freeze({
  STOP: 'stop',
  TASK_DISPATCH: 'task-dispatch', // PreToolUse Task|Agent
  STATE_WRITE: 'state-write',     // Edit/Write of .mpl/state.json
  PRE_COMPACT: 'pre-compact',
});

/** All known violation IDs — surfaced by hooks for log/reporting. */
export const VIOLATION_IDS = Object.freeze({
  PAUSED_BUT_FINALIZED: 'I1',
  COMPLETED_BUT_NOT_FINALIZED: 'I2',
  PAUSED_NEW_DISPATCH: 'I3',
  PHASE_FOLDER_MISMATCH: 'I4',
  FIX_LOOP_HISTORY_DESYNC: 'I5',
  GATE_EVIDENCE_MISSING: 'I6',
  PHASE_FOLDER_LIFECYCLE: 'I7',
  SCHEMA_VERSION_UNSUPPORTED: 'I8',
  // G4 forward-compat — values must match the H1 enum allowlist. New
  // session_status values added by future writers MUST be registered in
  // checkI9 before this hook can vouch for them; otherwise unknown values
  // surface here.
  SESSION_STATUS_INVALID: 'I9',
  COMPLETION_EXECUTION_STALE: 'I10',
  BLOCKED_HOOK_STALE: 'I11',
  // Exp22 R13 / #209: a hard{1,2,3}_baseline/coverage/resilience entry's
  // `command` must belong to the matching gate family (lint/build for
  // H1, test for H2, e2e/contract for H3). Manual state.json patches
  // putting `git commit` into hard2_coverage are rejected here.
  GATE_COMMAND_FAMILY_MISMATCH: 'I12',
  // Exp22 R11 / #210: a transition into phase2-sprint or later must
  // not happen until the Phase 0 boundary/runtime artifacts exist.
  // Fast-track (run_mode=auto) makes this especially important because
  // user review is reduced.
  FAST_TRACK_PHASE0_ARTIFACTS_MISSING: 'I13',
  // exp24 R0 / G3 + G4: the completion transition (current_phase -> 'completed')
  // must carry PASSING structured Hard-Gate evidence AND finalize_done===true.
  // exp24 jumped phase2-sprint -> completed in a single state-write with
  // gate_results all null and finalize_done false, slipping past I6 (fires only
  // at phase3-gate) and the finalize gate (fires only on a finalize_done:true
  // write). I14 gates the completion WRITE itself and is a non-configurable
  // block (see hooks/lib/policy/state-invariant.mjs).
  COMPLETION_WITHOUT_GATE_EVIDENCE: 'I14',
});

const ACTIVE_PHASES = new Set([
  'phase1-plan',
  'phase1a-research',
  'phase1b-plan',
  'mpl-decompose',
  'mpl-ambiguity-resolve',
  'phase2-sprint',
  'phase3-gate',
  'phase4-fix',
  'phase5-finalize',
]);

const PAUSE_STATUSES = new Set(['paused_budget', 'paused_checkpoint']);
const HANG_STATUSES = new Set(['verification_hang']);
// I3 dispatch-block set. `cancelled` is intentionally NOT included: a
// cancelled pipeline may need to dispatch cleanup Tasks (e.g. archive
// artifacts, post-mortem agent) before the session truly exits. If a future
// writer needs to forbid Task dispatch during cancel, add it here AND extend
// the resume protocol to cover the new resume direction.
const DISPATCH_BLOCKED_STATUSES = new Set([...PAUSE_STATUSES, ...HANG_STATUSES]);

/* ────────────────────────── helpers ──────────────────────────────────────── */

function v(id, message, details = {}) {
  return { id, message, ...details };
}

/**
 * Count phase folders that have actually completed — i.e. carry a
 * `state-summary.md` artifact written by phase-runner at finalize. Plain
 * directory existence is NOT enough: `commands/mpl-run-decompose.md` Step 4
 * pre-creates every `phase-N/` directory before any phase runs, so naïve
 * folder count would report N completed phases the moment decomposition
 * finishes even though `execution.phases.completed === 0`. (PR #128 review.)
 */
function countPhaseFolders(cwd) {
  const phasesDir = join(cwd, '.mpl', 'mpl', 'phases');
  if (!existsSync(phasesDir)) return null; // signal "not measurable"
  try {
    return readdirSync(phasesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^phase-\d+/.test(e.name))
      .filter((e) => existsSync(join(phasesDir, e.name, 'state-summary.md')))
      .length;
  } catch {
    return null;
  }
}

function phaseFolderExists(cwd, phaseId) {
  // current_phase is a lifecycle marker (phase2-sprint, mpl-decompose, ...);
  // we only correlate with disk when it looks like a phase folder id.
  if (!phaseId || !/^phase-\d+/.test(phaseId)) return null;
  const dir = join(cwd, '.mpl', 'mpl', 'phases', phaseId);
  return existsSync(dir) && safeIsDir(dir);
}

function safeIsDir(path) {
  try { return statSync(path).isDirectory(); }
  catch { return false; }
}

function sumFixLoopHistory(state) {
  const history = state?.fix_loop_history;
  if (!Array.isArray(history)) return null; // not measurable
  let sum = 0;
  for (const entry of history) {
    // Each entry: { phase: string, count: number } or just a count.
    const count = typeof entry === 'number'
      ? entry
      : (typeof entry?.count === 'number' ? entry.count : null);
    if (count === null || !Number.isFinite(count)) return null;
    sum += count;
  }
  return sum;
}

// exp25 R0' (schema unification): a gate slot is "recorded" if it is an object
// carrying EITHER schema MPL actually produces:
//   - recorder/command schema: { command, exit_code:<number>, source:'recorder' }
//     (what mpl-gate-recorder stamps from a real command run; exp24 I14 assumed
//      only this)
//   - orchestrator summary schema: { gate, ..., result:'PASS'|'FAIL' }
//     (what the Phase-5 hard-gate step actually wrote in exp25a — real tsc/vitest
//      were run, but the slot was summarized as result:'PASS' with NO exit_code).
// Pre-R0', the exit_code-only check flagged the result:'PASS' schema as
// "unrecorded" and would have FALSE-POSITIVE blocked a legitimate completion
// (exp25a live-R0 observation). Accepting both keeps the gate honest — a null /
// absent / FAIL slot is still caught.
function isStructuredEntry(e) {
  return !!e && typeof e === 'object'
    && (
      (typeof e.exit_code === 'number' && Number.isFinite(e.exit_code))
      || typeof e.result === 'string'
    );
}

// A gate slot "passes" when it is structured AND (exited 0 / explicitly waived /
// summarized PASS). exp24 R0: the completion transition requires PASSING gates,
// not merely recorded ones. exp25 R0': honor the result:'PASS' summary schema too.
export function isPassingGateEntry(e) {
  if (!isStructuredEntry(e)) return false;
  if (e.waived === true) return true;
  if (typeof e.exit_code === 'number' && Number.isFinite(e.exit_code)) return e.exit_code === 0;
  if (typeof e.result === 'string') return /^pass$/i.test(e.result.trim());
  return false;
}

/**
 * The list of reasons a state would FAIL the completion-evidence gate (R0).
 * Empty array = the state may legitimately transition to current_phase:'completed'.
 *
 * Shared single source of truth so that BOTH enforcement points agree on what
 * "completion evidence" means:
 *   - checkI14()  — fires on Edit/Write of state.json (PreToolUse hook path)
 *   - writer-cli  — fires on the `mpl_state_write` MCP path, which bypasses the
 *                   hook layer (exp25: exp25b reached current_phase='completed'
 *                   with gate_results=null + finalize_done=false via that path,
 *                   so I14 never saw it). See hooks/lib/state/writer-cli.mjs.
 *
 * NOTE: callers decide WHEN to apply this (e.g. only on the transition INTO
 * 'completed', and only for the full pipeline — the lightweight small-* flow and
 * the phase-controller's internal partial-completion path are intentionally
 * exempt). This helper only answers WHAT counts as sufficient evidence.
 */
export function completionGateIssues(state) {
  const issues = [];
  if (state?.finalize_done !== true) issues.push('finalize_done_not_true');

  const gr = state?.gate_results;
  const required = ['hard1_baseline', 'hard2_coverage', 'hard3_resilience'];
  if (!gr || typeof gr !== 'object') {
    issues.push('gate_results_absent');
  } else {
    for (const k of required) {
      if (!isStructuredEntry(gr[k])) issues.push(`${k}_unrecorded`);
      else if (!isPassingGateEntry(gr[k])) issues.push(`${k}_not_passing`);
    }
  }
  return issues;
}

/* ────────────────────────── individual invariants ────────────────────────── */

function checkI1(state) {
  // Paused-budget AND finalize_done=true → contradiction
  if (state.session_status === 'paused_budget' && state.finalize_done === true) {
    return v(VIOLATION_IDS.PAUSED_BUT_FINALIZED,
      "session_status='paused_budget' but finalize_done=true — pipeline can't be both paused and finalized.",
      { session_status: state.session_status, finalize_done: state.finalize_done });
  }
  return null;
}

function checkI2(state) {
  // current_phase='completed' AND finalize_done=false → contradiction
  if (state.current_phase === 'completed' && state.finalize_done !== true) {
    return v(VIOLATION_IDS.COMPLETED_BUT_NOT_FINALIZED,
      "current_phase='completed' but finalize_done is not true — completion claims must be backed by finalize_done.",
      { current_phase: state.current_phase, finalize_done: state.finalize_done });
  }
  return null;
}

function checkI3(state, trigger) {
  // No new phase dispatch (PreToolUse Task|Agent) while paused/hung.
  // See DISPATCH_BLOCKED_STATUSES above for why `cancelled` is excluded.
  if (trigger !== TRIGGERS.TASK_DISPATCH) return null;
  if (DISPATCH_BLOCKED_STATUSES.has(state.session_status)) {
    return v(VIOLATION_IDS.PAUSED_NEW_DISPATCH,
      `session_status='${state.session_status}' — new Task/Agent dispatches are blocked. Resume the pipeline first (/mpl:mpl-resume).`,
      { session_status: state.session_status });
  }
  return null;
}

function checkI4(state, cwd) {
  // execution.phases.completed should match the number of `phase-N/` directories
  // that carry a `state-summary.md` finalize artifact (the disk truth phase-runner
  // emits at completion). Empty pre-created directories from
  // `commands/mpl-run-decompose.md` Step 4 are NOT counted — see countPhaseFolders.
  const declared = state?.execution?.phases?.completed;
  if (typeof declared !== 'number') return null;
  const onDisk = countPhaseFolders(cwd);
  if (onDisk === null) return null;
  if (declared !== onDisk) {
    return v(VIOLATION_IDS.PHASE_FOLDER_MISMATCH,
      `execution.phases.completed=${declared} but ${onDisk} phase(s) carry state-summary.md on disk. Drift between state and finalize artifacts.`,
      { declared, onDisk });
  }
  return null;
}

function checkI5(state) {
  // fix_loop_count must equal sum(fix_loop_history) when both are present.
  const count = state?.fix_loop_count;
  if (typeof count !== 'number') return null;
  const sum = sumFixLoopHistory(state);
  if (sum === null) return null; // history absent → can't compare
  if (count !== sum) {
    return v(VIOLATION_IDS.FIX_LOOP_HISTORY_DESYNC,
      `fix_loop_count=${count} disagrees with sum(fix_loop_history)=${sum}. G5 history and counter must agree.`,
      { count, sum });
  }
  return null;
}

function checkI6(state, trigger) {
  // Gate transition (state-write whose target leaves phase3-gate) must carry
  // structured evidence. The hook surfaces this only on STATE_WRITE — at
  // STOP, mpl-phase-controller already gates with checkGateResults.
  if (trigger !== TRIGGERS.STATE_WRITE) return null;
  if (state.current_phase !== 'phase3-gate') return null;
  const gr = state?.gate_results;
  if (!gr || typeof gr !== 'object') {
    return v(VIOLATION_IDS.GATE_EVIDENCE_MISSING,
      "phase3-gate state-write without gate_results. Run real verification commands so mpl-gate-recorder produces structured evidence.",
      { gate_results: null });
  }
  const required = ['hard1_baseline', 'hard2_coverage', 'hard3_resilience'];
  const missing = required.filter((k) => !isStructuredEntry(gr[k]));
  if (missing.length > 0) {
    return v(VIOLATION_IDS.GATE_EVIDENCE_MISSING,
      `phase3-gate state-write missing structured gate evidence: ${missing.join(', ')}. P0-1 (#102) — legacy booleans alone do not satisfy G3.`,
      { missing });
  }
  return null;
}

function checkI7(state, cwd) {
  // current_phase that names a specific phase folder (phase-N) must have a
  // matching directory. Lifecycle markers (phase2-sprint, mpl-decompose, ...)
  // are exempt.
  const phaseId = state.current_phase;
  if (!phaseId) return null;
  const exists = phaseFolderExists(cwd, phaseId);
  if (exists === null) return null;
  if (!exists) {
    return v(VIOLATION_IDS.PHASE_FOLDER_LIFECYCLE,
      `current_phase='${phaseId}' but no matching .mpl/mpl/phases/${phaseId}/ directory.`,
      { phaseId });
  }
  return null;
}

function checkI8(state) {
  // Refuse states with a schema_version newer than this hook supports.
  // Migration handles older versions automatically — newer ones mean the
  // hook is stale relative to the writer.
  //
  // Note (H8 / #116): in production, `readState` fail-closes on the same
  // condition before any caller can build a state object to pass here.
  // I8 therefore mainly catches synthetic state objects that bypass
  // readState (test fixtures, future programmatic writers) — defense in
  // depth for the read path, not the writer-side guard.
  const sv = state?.schema_version;
  if (typeof sv !== 'number') return null;
  if (sv > CURRENT_SCHEMA_VERSION) {
    return v(VIOLATION_IDS.SCHEMA_VERSION_UNSUPPORTED,
      `state.schema_version=${sv} exceeds supported CURRENT_SCHEMA_VERSION=${CURRENT_SCHEMA_VERSION}. Hook may be out of date — upgrade mpl plugin.`,
      { schema_version: sv, supported: CURRENT_SCHEMA_VERSION });
  }
  return null;
}

function checkI9(state) {
  // session_status enum validity (G4 #109 forward-compat). Today the field is
  // a single-valued string so mutual exclusivity is structurally enforced;
  // this check guards the value itself. Future writers introducing new
  // statuses MUST add them to the H1 allowlist (`docs/schemas/state.md`)
  // before they can be emitted — otherwise unknown values surface as I9.
  const allowed = new Set([null, 'active', 'paused_budget', 'paused_checkpoint', 'verification_hang', 'blocked_hook', 'cancelled']);
  if (!allowed.has(state.session_status ?? null)) {
    return v(VIOLATION_IDS.SESSION_STATUS_INVALID,
      `session_status='${state.session_status}' is not in the allowed enum (null|active|paused_budget|paused_checkpoint|verification_hang|blocked_hook|cancelled).`,
      { session_status: state.session_status });
  }
  return null;
}

function checkI10(state) {
  // Completion freshness: exp20 reached current_phase='completed' while
  // execution.phases stayed at its zero/null defaults. At completion/finalize
  // time, the execution subtree must show that real phase accounting survived.
  if (state.current_phase !== 'completed' && state.finalize_done !== true) return null;

  const phases = state?.execution?.phases || {};
  const issues = [];
  const total = phases.total;
  const completed = phases.completed;
  const current = phases.current;

  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) {
    issues.push('execution.phases.total<=0_or_missing');
  }
  if (typeof completed !== 'number' || !Number.isFinite(completed) || completed <= 0) {
    issues.push('execution.phases.completed<=0_or_missing');
  }
  if (
    typeof total === 'number' && Number.isFinite(total) &&
    typeof completed === 'number' && Number.isFinite(completed) &&
    completed > total
  ) {
    issues.push('execution.phases.completed>total');
  }
  if (current !== null && current !== undefined) {
    issues.push('execution.phases.current_not_null_at_completion');
  }
  if (state?.execution?.status !== 'completed') {
    issues.push('execution.status_not_completed');
  }

  if (issues.length === 0) return null;
  return v(VIOLATION_IDS.COMPLETION_EXECUTION_STALE,
    `completion state is stale: ${issues.join(', ')}. Final completion requires fresh execution.phases accounting.`,
    { issues });
}

function checkI11(state) {
  // A visible hook block is actionable only when all companion fields remain
  // present. Missing reason/instruction was the exp20 blocked_hook cleanup
  // failure mode.
  if (state.session_status !== 'blocked_hook') return null;
  const required = [
    'blocked_by_hook',
    'blocked_phase',
    'blocked_artifact',
    'block_code',
    'block_reason',
    'resume_instruction',
    'blocked_at',
  ];
  const missing = required.filter((key) => {
    const value = state[key];
    return typeof value !== 'string' || value.trim() === '';
  });
  const retryContext = state.retry_context;
  if (
    !retryContext ||
    typeof retryContext !== 'object' ||
    Array.isArray(retryContext)
  ) {
    missing.push('retry_context');
  }
  if (missing.length === 0) return null;
  return v(VIOLATION_IDS.BLOCKED_HOOK_STALE,
    `session_status='blocked_hook' but companion field(s) are missing: ${missing.join(', ')}. Hook block cleanup/recording must be atomic.`,
    { missing });
}

function checkGateFamilyForBlock(block, label, cwd) {
  // A "structured gate entry" carries { command, exit_code, ... }. Check
  // that the recorded `command` belongs to the family this slot expects.
  // mpl-gate-recorder produces commands the classifier recognizes; manual
  // patches that put unrelated commands here (Exp22 R13: `git commit` in
  // hard2_coverage) are rejected.
  //
  // Codex r2 on PR #219: a structured entry with a numeric exit_code but
  // NO command is also a violation — manual `{exit_code: 0}` writes can
  // otherwise claim a verified gate without any recorded command family.
  // Treat missing/blank command as the strongest mismatch ("absent").
  if (!block || typeof block !== 'object') return [];
  const slots = [
    ['hard1_baseline', 'hard1_baseline'],
    ['hard2_coverage', 'hard2_coverage'],
    ['hard3_resilience', 'hard3_resilience'],
  ];
  const issues = [];
  for (const [slot, expectedFamily] of slots) {
    const entry = block[slot];
    if (!entry || typeof entry !== 'object') continue;
    const command = entry.command;
    if (typeof command !== 'string' || !command.trim()) {
      issues.push({
        gate: `${label}.${slot}`,
        command: command === undefined ? '(missing)' : String(command),
        classified_as: 'missing_command',
        expected_family: expectedFamily,
      });
      continue;
    }
    // #232 (2) [contract-break]: strict re-classification is for
    // MANUAL state.gate_results writes — it deliberately rejects
    // execution wrappers (`docker`, `kubectl exec`, `bash -lc`) because
    // a hand-typed wrapper command is not credible gate evidence.
    // But the recorder LEGITIMATELY accepts those wrappers; without
    // this carve-out, every recorder write of a wrapper-shaped command
    // would re-classify as `null` here and fire I12 family mismatch.
    // `source: 'recorder'` is the entry's own attestation; recorder
    // writes are authoritative for what they observed at execution
    // time. Manual writes that try to forge `source: 'recorder'` are
    // out of scope — the broader anti-forgery layer is upstream
    // (mpl-write-guard rejects direct edits to state.gate_results
    // outside the gate-recorder).
    if (entry.source === 'recorder') continue;
    const family = classifyGateCommand(command, { cwd });
    if (family !== expectedFamily) {
      issues.push({
        gate: `${label}.${slot}`,
        command,
        classified_as: family ?? 'unclassified',
        expected_family: expectedFamily,
      });
    }
  }
  return issues;
}

function checkI13(state, cwd, trigger) {
  // Exp22 R11 / #210: a fast-track run that skipped user interviews
  // must not also skip the boundary/runtime artifacts. Fire on
  // STATE_WRITE so a manual edit into phase1b-plan / phase2-sprint /
  // phase3-gate / ... cannot land without the required artifacts.
  // Phase-controller writes also call missingPhase0Artifacts directly
  // for its writeState path (codex r1 on PR #222).
  if (trigger !== TRIGGERS.STATE_WRITE) return null;
  const phase = state?.current_phase;
  if (!phase || !REQUIRES_PHASE0_ARTIFACTS.has(phase)) return null;
  // #240 A1 + codex/claude r2 on PR #244 [contract-break]: honor the
  // workspace config knob. blockedPhaseTransitionReason() already
  // bails out when phase0_artifacts_required is false; I13 must
  // match so a workspace that opts out via .mpl/config.json doesn't
  // hit the invariant on mpl_state_write.
  const cfg = loadConfig(cwd);
  if (cfg?.phase0_artifacts_required === false) return null;

  const missing = missingPhase0Artifacts(cwd);
  if (missing.length === 0) return null;
  return v(VIOLATION_IDS.FAST_TRACK_PHASE0_ARTIFACTS_MISSING,
    `Phase ${phase} cannot start without the Phase 0 boundary/runtime artifacts. ` +
      `Missing: ${missing.join(', ')}. ` +
      `Fast-track (run_mode=auto) may shorten user interviews but MUST NOT skip ` +
      `boundary/runtime evidence. Re-run Phase 0 to produce the missing artifacts, ` +
      `or write '_no-boundaries.json' under .mpl/contracts/ as the explicit ` +
      `opt-out for non-boundary tasks.`,
    { phase, missing });
}

function checkI12(state, trigger, cwd) {
  // Exp22 R13 / #209. Surface on STATE_WRITE so manual patches that try
  // to land malformed evidence are caught at the write boundary.
  if (trigger !== TRIGGERS.STATE_WRITE) return null;
  const issues = [
    ...checkGateFamilyForBlock(state?.gate_results, 'state.gate_results', cwd),
    ...checkGateFamilyForBlock(state?.release?.gate_results, 'state.release.gate_results', cwd),
  ];
  if (issues.length === 0) return null;
  const messages = issues
    .map((x) => `${x.gate}.command='${x.command}' (classified as ${x.classified_as}, expected ${x.expected_family})`);
  return v(VIOLATION_IDS.GATE_COMMAND_FAMILY_MISMATCH,
    `Gate evidence command family mismatch: ${messages.join('; ')}. ` +
      `Hard 1 expects lint/typecheck/build/compile; Hard 2 expects test runner; ` +
      `Hard 3 expects e2e/contract/a11y. Manual state.json patches MUST use a ` +
      `recognized command, or record evidence by running the verification command ` +
      `(mpl-gate-recorder hook auto-routes).`,
    { mismatches: issues });
}

function checkI14(state, trigger) {
  // exp24 R0 (G3 + G4): gate the COMPLETION transition. Fire on STATE_WRITE so a
  // manual/orchestrator write that flips current_phase -> 'completed' cannot
  // land unless (a) finalize_done===true and (b) all three Hard Gates carry
  // PASSING structured evidence. Closes the gap where I6 only checks at
  // phase3-gate and the finalize gate fires only on a finalize_done:true write —
  // jumping straight to 'completed' bypassed both (exp24, gate_results all null,
  // finalize_done false).
  if (trigger !== TRIGGERS.STATE_WRITE) return null;
  if (state.current_phase !== 'completed') return null;

  // Shared evidence definition with the mpl_state_write path (writer-cli.mjs).
  const issues = completionGateIssues(state);

  if (issues.length === 0) return null;
  return v(VIOLATION_IDS.COMPLETION_WITHOUT_GATE_EVIDENCE,
    `Completion transition to current_phase='completed' lacks passing gate/finalize evidence: ${issues.join(', ')}. ` +
      `A 'completed' state-write requires finalize_done=true AND structured PASSING ` +
      `gate_results.{hard1_baseline,hard2_coverage,hard3_resilience} (exit_code 0 or waived:true). ` +
      `Run the Hard Gates so mpl-gate-recorder produces evidence and complete finalize, then transition — ` +
      `do not patch current_phase='completed' directly.`,
    { issues });
}

/* ────────────────────────── aggregator ──────────────────────────────────── */

/**
 * Run the invariant suite. Some invariants only fire on specific triggers
 * (see TRIGGERS).
 *
 * @param {object | null | undefined} state - state.json contents
 * @param {{ cwd?: string, trigger?: string }} [opts]
 * @returns {{ ok: boolean, violations: Array<{id, message, ...}> }}
 */
export function checkInvariants(state, opts = {}) {
  if (!state || typeof state !== 'object') {
    return { ok: true, violations: [] };
  }
  const cwd = opts.cwd ?? process.cwd();
  const trigger = opts.trigger ?? TRIGGERS.STOP;

  const checks = [
    () => checkI1(state),
    () => checkI2(state),
    () => checkI3(state, trigger),
    () => checkI4(state, cwd),
    () => checkI5(state),
    () => checkI6(state, trigger),
    () => checkI7(state, cwd),
    () => checkI8(state),
    () => checkI9(state),
    () => checkI10(state),
    () => checkI11(state),
    () => checkI12(state, trigger, cwd),
    () => checkI13(state, cwd, trigger),
    () => checkI14(state, trigger),
  ];

  const violations = [];
  for (const fn of checks) {
    const r = fn();
    if (r) violations.push(r);
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Format a single concise summary line for systemMessage / stopReason output.
 *
 * @param {ReturnType<typeof checkInvariants>} result
 * @returns {string}
 */
export function formatViolations(result) {
  if (result.ok) return '';
  const ids = result.violations.map((v) => v.id).join(', ');
  const heads = result.violations.map((v) => `[${v.id}] ${v.message}`).join('\n');
  return `[MPL G3] state invariant violations (${result.violations.length}: ${ids})\n${heads}`;
}

/**
 * Decide which trigger context applies to a given hook invocation envelope.
 * Shared by the standalone hook AND the policy dispatcher so the trigger
 * derivation stays single-source.
 *
 * @param {object} data hook stdin payload (hook_event_name + tool_name)
 * @returns {string} one of TRIGGERS.*
 */
export function deriveTrigger(data = {}) {
  const event = String(data.hook_event_name || data.hookEventName || '').toLowerCase();
  const tool = String(data.tool_name || data.toolName || '').toLowerCase();

  if (event === 'precompact' || event === 'pre_compact') return TRIGGERS.PRE_COMPACT;
  if (event === 'stop') return TRIGGERS.STOP;
  if (event === 'pretooluse' || event === 'pre_tool_use') {
    if (['task', 'agent'].includes(tool)) return TRIGGERS.TASK_DISPATCH;
    if (['edit', 'write', 'multiedit'].includes(tool)) return TRIGGERS.STATE_WRITE;
  }
  // Unknown event: fall back to STOP semantics (safest — broadest checks).
  return TRIGGERS.STOP;
}

/**
 * Was the file path a state.json target? Filters STATE_WRITE so the hook
 * only fires on the relevant write — Edit/Write of unrelated files don't
 * trigger gate-evidence invariants.
 */
export function isStateWriteTarget(toolInput, cwd) {
  if (!toolInput) return false;
  const fp = toolInput.file_path || toolInput.filePath;
  if (!fp || typeof fp !== 'string') return false;
  const abs = resolve(cwd, fp);
  return abs.endsWith(`.mpl${sep}state.json`)
      || abs.endsWith('.mpl/state.json');
}

/**
 * Simulate the state.json contents AFTER the proposed Write/Edit/MultiEdit.
 * The PreToolUse hook fires before the tool applies, so reading the current
 * file would miss the very change about to land. (PR #128 review #2.)
 *
 * Returns the parsed proposed state object, or null when simulation isn't
 * possible (parse failure, missing inputs, edit string not found). Callers
 * fall back to the current state — conservative: hook may miss but never
 * blocks a write on a hypothetical state we can't compute.
 */
export function simulateWrittenState(toolName, toolInput, cwd) {
  const t = String(toolName || '').toLowerCase();
  const fp = toolInput?.file_path || toolInput?.filePath;
  const abs = fp ? resolve(cwd, fp) : null;

  if (t === 'write') {
    if (typeof toolInput.content !== 'string') return null;
    try { return JSON.parse(toolInput.content); } catch { return null; }
  }

  if (t === 'edit' || t === 'multiedit') {
    if (!abs || !existsSync(abs)) return null;
    let content;
    try { content = readFileSync(abs, 'utf-8'); } catch { return null; }

    const apply = (oldStr, newStr, replaceAll) => {
      if (typeof oldStr !== 'string' || typeof newStr !== 'string') return null;
      if (replaceAll === true) return content.split(oldStr).join(newStr);
      const idx = content.indexOf(oldStr);
      if (idx === -1) return null;
      return content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
    };

    if (t === 'edit') {
      const next = apply(toolInput.old_string, toolInput.new_string, toolInput.replace_all);
      if (next === null) return null;
      content = next;
    } else {
      // MultiEdit: edits[] applied in order
      if (!Array.isArray(toolInput.edits)) return null;
      for (const e of toolInput.edits) {
        const next = apply(e?.old_string, e?.new_string, e?.replace_all);
        if (next === null) return null;
        content = next;
      }
    }
    try { return JSON.parse(content); } catch { return null; }
  }

  return null;
}
