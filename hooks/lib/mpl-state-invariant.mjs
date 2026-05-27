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

import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { CURRENT_SCHEMA_VERSION } from './mpl-state.mjs';
import { classifyGateCommand } from './mpl-gate-classify.mjs';

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

function isStructuredEntry(e) {
  return e && typeof e === 'object'
    && typeof e.exit_code === 'number'
    && Number.isFinite(e.exit_code);
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

function checkGateFamilyForBlock(block, label) {
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
    const family = classifyGateCommand(command);
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

// Phases where the Phase-0 boundary/runtime artifacts MUST already
// exist before the orchestrator transitions in. Phase 0 itself, the
// decomposer, and ambiguity-resolve are exempt — that's where these
// artifacts get produced. Anything from phase1b-plan onward must wait
// for them to land.
const REQUIRES_PHASE0_ARTIFACTS = new Set([
  'phase1b-plan',
  'phase2-sprint',
  'phase3-gate',
  'phase4-fix',
  'phase5-finalize',
  'release-gate',
  'release-finalize',
  'completed',
]);

function listDirSafe(dir) {
  try { return existsSync(dir) ? readdirSync(dir) : []; } catch { return []; }
}

function checkI13(state, cwd, trigger) {
  // Exp22 R11 / #210: a fast-track run that skipped user interviews
  // must not also skip the boundary/runtime artifacts. Fire on
  // STATE_WRITE so a transition write into phase1b-plan / phase2-sprint
  // / phase3-gate / ... cannot land without the required artifacts.
  if (trigger !== TRIGGERS.STATE_WRITE) return null;
  const phase = state?.current_phase;
  if (!phase || !REQUIRES_PHASE0_ARTIFACTS.has(phase)) return null;

  const missing = [];
  if (!existsSync(join(cwd, '.mpl', 'mpl', 'phase0', 'raw-scan.md'))) {
    missing.push('.mpl/mpl/phase0/raw-scan.md');
  }
  if (!existsSync(join(cwd, '.mpl', 'mpl', 'phase0', 'design-intent.yaml'))) {
    missing.push('.mpl/mpl/phase0/design-intent.yaml');
  }
  // Contracts requirement: at least one .json file in `.mpl/contracts/`.
  // The decomposer writes `_no-boundaries.json` when the project has no
  // cross-layer boundary, so simple/non-boundary tasks still satisfy
  // this without forcing irrelevant contract files.
  const contractsDir = join(cwd, '.mpl', 'contracts');
  const contractFiles = listDirSafe(contractsDir).filter((n) => n.endsWith('.json'));
  if (contractFiles.length === 0) {
    missing.push('.mpl/contracts/*.json (or _no-boundaries.json)');
  }

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

function checkI12(state, trigger) {
  // Exp22 R13 / #209. Surface on STATE_WRITE so manual patches that try
  // to land malformed evidence are caught at the write boundary.
  if (trigger !== TRIGGERS.STATE_WRITE) return null;
  const issues = [
    ...checkGateFamilyForBlock(state?.gate_results, 'state.gate_results'),
    ...checkGateFamilyForBlock(state?.release?.gate_results, 'state.release.gate_results'),
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
    () => checkI12(state, trigger),
    () => checkI13(state, cwd, trigger),
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
