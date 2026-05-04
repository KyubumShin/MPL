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
  SESSION_STATUS_CONFLICT: 'I9', // G4 forward-compat: paused_* ⊥ verification_hang
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

/* ────────────────────────── helpers ──────────────────────────────────────── */

function v(id, message, details = {}) {
  return { id, message, ...details };
}

function countPhaseFolders(cwd) {
  const phasesDir = join(cwd, '.mpl', 'mpl', 'phases');
  if (!existsSync(phasesDir)) return null; // signal "not measurable"
  try {
    return readdirSync(phasesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^phase-\d+/.test(e.name))
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
  if (trigger !== TRIGGERS.TASK_DISPATCH) return null;
  if (PAUSE_STATUSES.has(state.session_status) || HANG_STATUSES.has(state.session_status)) {
    return v(VIOLATION_IDS.PAUSED_NEW_DISPATCH,
      `session_status='${state.session_status}' — new Task/Agent dispatches are blocked. Resume the pipeline first (/mpl:mpl-resume).`,
      { session_status: state.session_status });
  }
  return null;
}

function checkI4(state, cwd) {
  // execution.phases.completed should match phase folder count on disk.
  // Only meaningful when execution subtree exists and the phases directory exists.
  const declared = state?.execution?.phases?.completed;
  if (typeof declared !== 'number') return null;
  const onDisk = countPhaseFolders(cwd);
  if (onDisk === null) return null;
  if (declared !== onDisk) {
    return v(VIOLATION_IDS.PHASE_FOLDER_MISMATCH,
      `execution.phases.completed=${declared} but ${onDisk} phase folders exist on disk. Drift between state and filesystem.`,
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
  // session_status mutual exclusivity (forward-compat with G4 #109): a
  // pipeline cannot be intentionally paused AND mid-hang at the same time.
  // Although session_status is a single field today, future writers might
  // combine flags or mark transition states; this guards against schema
  // expansion that breaks the assumption.
  // Note: the field is a string, so direct combination isn't currently
  // expressible. We instead validate the value is in the allowed enum.
  const allowed = new Set([null, 'active', 'paused_budget', 'paused_checkpoint', 'verification_hang', 'cancelled']);
  if (!allowed.has(state.session_status ?? null)) {
    return v(VIOLATION_IDS.SESSION_STATUS_CONFLICT,
      `session_status='${state.session_status}' is not in the allowed enum (null|active|paused_budget|paused_checkpoint|verification_hang|cancelled).`,
      { session_status: state.session_status });
  }
  return null;
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
