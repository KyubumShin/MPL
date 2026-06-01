/**
 * MPL State Invariant Policy (L2 module — P3 Move).
 *
 * Single-source-of-truth for the state-invariant gate that was previously
 * housed in `hooks/mpl-state-invariant.mjs`. This policy is registered as a
 * proper dispatch route so:
 *
 *   1. EXTRA_LEGACY_ROWS + the channel-registry.pre piggyback can be deleted
 *      from `lib/route-introspection.mjs`.
 *   2. Production enforcement of I1-I13 returns to the engine path (it went
 *      silently dark in Move #14/15 when the standalone hook was no longer
 *      reached via hooks.json).
 *
 * Three entrypoints distinguished by trigger string the route passes in:
 *   - 'task-dispatch' (PreToolUse Task|Agent)        -> trigger=TASK_DISPATCH
 *   - 'state-write'   (PreToolUse Edit|Write|MultiEdit on .mpl/state.json)
 *                                                     -> trigger=STATE_WRITE
 *                                                     simulateWrittenState
 *                                                     runs before checkInvariants
 *   - 'stop'          (Stop)                          -> trigger=STOP
 *
 * Invariants preserved verbatim from the standalone hook:
 *   - The non-configurable I13 FAST_TRACK_PHASE0_ARTIFACTS_MISSING block
 *     fires even when policy=`off` (#222 codex r4).
 *   - recordBlockedHook envelope is written inline on block (#235) — sharing
 *     the contracts.mjs precedent so the bridge surface stays minimal.
 *   - clearBlockedHook fires on pass/off so the resume gate can re-arm.
 *
 * Decision envelope (mirrors contracts.mjs / schemas.mjs):
 *   { action, code, reason, ruleId, artifact, resumeInstruction,
 *     retryContext, sideEffects? }
 *
 * Dependency boundary (per hooks/lib/policy/README.md):
 *   - L1 helpers only: mpl-state-invariant, mpl-enforcement, mpl-blocked-hook,
 *     mpl-state.
 *   - Does NOT import another policy/*.mjs module.
 */

import {
  checkInvariants,
  formatViolations,
  isStateWriteTarget,
  simulateWrittenState,
  TRIGGERS,
  VIOLATION_IDS,
} from '../mpl-state-invariant.mjs';
import { resolveRuleAction } from '../mpl-enforcement.mjs';
import {
  recordBlockedHook,
  clearBlockedHook,
} from '../mpl-blocked-hook.mjs';
import { isMplActive, readState } from '../mpl-state.mjs';

export const STATE_INVARIANT_HOOK_ID = 'mpl-state-invariant';
export const STATE_INVARIANT_ARTIFACT = 'state-invariant';

// ----------------------------------------------------------------------------
// Decision envelope builders (mirror gates.mjs / schemas.mjs shape).
// ----------------------------------------------------------------------------

function noop() {
  return {
    action: 'noop',
    code: null,
    reason: null,
    ruleId: 'state_invariant',
    artifact: null,
    resumeInstruction: null,
    retryContext: null,
    sideEffects: [],
  };
}

function allow() {
  return {
    action: 'allow',
    code: null,
    reason: null,
    ruleId: 'state_invariant',
    artifact: STATE_INVARIANT_ARTIFACT,
    resumeInstruction: null,
    retryContext: null,
    sideEffects: [],
  };
}

function warn({ reason, retryContext }) {
  return {
    action: 'warn',
    code: 'state_invariant_violation',
    reason,
    ruleId: 'state_invariant',
    artifact: STATE_INVARIANT_ARTIFACT,
    resumeInstruction: null,
    retryContext: retryContext || null,
    additionalContext: reason,
    sideEffects: [],
  };
}

function block({ code, reason, resumeInstruction, retryContext }) {
  return {
    action: 'block',
    code,
    reason,
    ruleId: 'state_invariant',
    artifact: STATE_INVARIANT_ARTIFACT,
    resumeInstruction,
    retryContext: retryContext || null,
    sideEffects: [],
  };
}

// ----------------------------------------------------------------------------
// Trigger-string -> TRIGGERS.* mapping. Keeps the standalone hook's
// deriveTrigger() compatible without re-introducing the parsing here.
// ----------------------------------------------------------------------------
const TRIGGER_FROM_ROUTE = Object.freeze({
  'task-dispatch': TRIGGERS.TASK_DISPATCH,
  'state-write':   TRIGGERS.STATE_WRITE,
  'stop':          TRIGGERS.STOP,
  'pre-compact':   TRIGGERS.PRE_COMPACT,
});

/**
 * Policy entrypoint.
 *
 * @param {'task-dispatch'|'state-write'|'stop'|'pre-compact'} routeTrigger
 * @param {object} ctx engine route context — { cwd, toolName, toolInput,
 *                     state? } (state is engine-supplied; we re-read for
 *                     simulation correctness on STATE_WRITE).
 */
export function handle(routeTrigger, ctx = {}) {
  const cwd = (ctx && ctx.cwd) || process.cwd();
  if (!isMplActive(cwd)) return noop();

  const trigger = TRIGGER_FROM_ROUTE[routeTrigger] || TRIGGERS.STOP;
  const toolInput = ctx.toolInput || ctx.tool_input || {};
  const toolName = ctx.toolName || ctx.tool_name || '';

  // Filter STATE_WRITE to actual state.json targets — otherwise unrelated
  // Edit/Write events would invoke the gate-evidence check.
  if (trigger === TRIGGERS.STATE_WRITE) {
    if (!isStateWriteTarget(toolInput, cwd)) return noop();
  }

  // For state-writes, validate the PROPOSED state (post-write content), not
  // the on-disk state — otherwise a Write that strips structured evidence
  // would slip through because the current file still has it.
  let state = readState(cwd);
  if (trigger === TRIGGERS.STATE_WRITE) {
    const proposed = simulateWrittenState(toolName, toolInput, cwd);
    if (proposed && typeof proposed === 'object') state = proposed;
    // If simulation failed (unparseable, missing string), fall back to
    // current state. Conservative: we may miss a violation rather than
    // block a write on a hypothetical we couldn't compute.
  }
  if (!state) return noop();

  const result = checkInvariants(state, { cwd, trigger });
  if (result.ok) {
    clearBlockedHook(cwd, { hookId: STATE_INVARIANT_HOOK_ID, artifact: STATE_INVARIANT_ARTIFACT });
    return allow();
  }

  // Codex r4 on PR #222 [data-integrity]: I13 (Phase 0 artifacts) MUST be a
  // non-configurable block. The default `state_invariant_violation` policy is
  // `warn`, which would let a manual Write to state.json land a protected
  // phase without artifacts and only emit a systemMessage. The fast-track
  // invariant exists precisely to stop that path.
  const hasFastTrackViolation = result.violations.some(
    (v) => v.id === VIOLATION_IDS.FAST_TRACK_PHASE0_ARTIFACTS_MISSING,
  );
  const action = resolveRuleAction(cwd, state, 'state_invariant_violation');
  if (action === 'off' && !hasFastTrackViolation) {
    clearBlockedHook(cwd, { hookId: STATE_INVARIANT_HOOK_ID, artifact: STATE_INVARIANT_ARTIFACT });
    return noop();
  }

  const reason = formatViolations(result);
  const retryContext = {
    violations: result.violations.slice(0, 12).map((v) => ({
      id: v.id,
      message: v.message,
    })),
    trigger: routeTrigger,
  };

  if (action === 'block' || hasFastTrackViolation) {
    // #235: record envelope so mpl-recover sees the block code. I13 fast-track
    // uses its own non-configurable code; other invariant violations use the
    // generic state_invariant_violation bucket from ENFORCEMENT_DEFAULTS.
    const code = hasFastTrackViolation
      ? 'fast_track_phase0_artifacts_missing'
      : 'state_invariant_violation';
    const resumeInstruction = hasFastTrackViolation
      ? 'Materialize the required Phase 0 artifacts (raw-scan.md / design-intent.yaml / contracts) and rewrite the state transition, or opt out via .mpl/config.json `phase0_artifacts_required: false`.'
      : 'Resolve the state-invariant violation(s) in state.json (see reason for the specific check IDs), then retry the write.';
    try {
      recordBlockedHook(cwd, {
        hookId: STATE_INVARIANT_HOOK_ID,
        phaseId: state?.current_phase,
        artifact: STATE_INVARIANT_ARTIFACT,
        code,
        reason,
        resumeInstruction,
        retryContext,
      });
    } catch {
      // best-effort: the decision is authoritative even if envelope write fails.
    }
    return block({ code, reason, resumeInstruction, retryContext });
  }

  // warn (default policy)
  clearBlockedHook(cwd, { hookId: STATE_INVARIANT_HOOK_ID, artifact: STATE_INVARIANT_ARTIFACT });
  return warn({ reason, retryContext });
}
