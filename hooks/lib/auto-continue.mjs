/**
 * exp25 — single-session auto-continue for Phase-2+ clean-stops.
 *
 * MPL's Stop hook otherwise emits {continue:true, suppressOutput:true} at every
 * Phase-2+ clean-stop (after each phase-runner / test-agent / reviewer / fix),
 * so the agent idles and the pipeline only advances with an external nudge —
 * which means an unattended run needs a SECOND CLI driving the first (the cmux
 * harness). For real use that is not viable. When auto_continue is on (DEFAULT
 * ON; opt out with .mpl/config.json {"auto_continue": false}) we convert that
 * idle Stop into a Stop-block envelope ({decision:'block', reason}) so the SAME
 * session resumes the pipeline — no second CLI, no manual nudge.
 *
 * Scope is Phase 2 (execute) → completion ONLY. The interactive setup phases
 * (interview / decompose / plan / ambiguity HITL) and genuine pause states
 * (verification_hang, blocked_hook) and terminal states are deliberately left to
 * idle so a human still drives them. A real block the aggregate already decided
 * is never overridden. Runaway is bounded by the existing hang detector (sets
 * verification_hang → excluded here) + max_fix_loops + convergence stagnation.
 *
 * This module is PURE (no fs / config IO) so it is unit-testable; the engine
 * reads the auto_continue flag from the v1 config and passes the boolean in.
 */

export const AUTO_CONTINUE_PHASES = Object.freeze(new Set([
  'phase2-sprint', 'phase3-gate', 'phase4-fix', 'phase5-finalize',
  'small-plan', 'small-sprint', 'small-verify',
  'release-gate', 'release-finalize',
]));

const PAUSE_STATES = new Set(['verification_hang', 'blocked_hook']);

/**
 * @param {string} event        hook event name
 * @param {object} envelope     the aggregated hook envelope (may be rewritten)
 * @param {object|null} state   parsed .mpl/state.json
 * @param {boolean} enabled     resolved auto_continue flag (DEFAULT true upstream)
 * @returns {object} the original envelope, or a {decision:'block', reason} resume envelope
 */
export function maybeAutoContinue(event, envelope, state, enabled) {
  if (enabled === false) return envelope;                                   // explicit opt-out
  if (event !== 'Stop' && event !== 'SubagentStop') return envelope;
  if (!state || typeof state !== 'object') return envelope;
  // Never override a real block / hard-stop the aggregate already decided.
  if (envelope && (envelope.decision === 'block' || envelope.continue === false)) return envelope;
  // Scope: Phase 2 (execute) → completion. Interview/decompose/plan stay manual.
  if (!AUTO_CONTINUE_PHASES.has(state.current_phase)) return envelope;
  // Genuine pause states need human triage — do NOT auto-continue past them.
  if (PAUSE_STATES.has(state.session_status)) return envelope;

  const phase = state.current_phase;
  const reason =
    `[MPL auto-continue] Phase-2+ clean-stop (current_phase='${phase}'). Continue the MPL `
    + `pipeline in THIS session — do not idle. Record the just-finished step's completion, `
    + `then dispatch the next phase/tier via mpl-phase-runner; once every decomposed phase is `
    + `done, run the 3 Hard Gates and finalize (finalize_done=true) so the pipeline reaches `
    + `current_phase='completed'. Stop only at completion, a Hard Gate failing past its `
    + `fix-loop budget, or a decision that truly needs the user (use AskUserQuestion for that).`;
  return { decision: 'block', reason };
}
