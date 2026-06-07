/**
 * exp25 — single-session, CAUSE-AWARE auto-continue for Phase-2+ clean-stops.
 *
 * MPL's Stop hook otherwise emits {continue:true, suppressOutput:true} at every
 * Phase-2+ clean-stop (after each phase-runner / test-agent / reviewer / fix), so
 * the agent idles and the pipeline only advances with an external nudge — which
 * means an unattended run needs a SECOND CLI driving the first (the cmux harness).
 * For real use that is not viable. When auto_continue is on (DEFAULT ON; opt out
 * with .mpl/config.json {"auto_continue": false}) we convert that idle Stop into a
 * Stop-block envelope ({decision:'block', reason}) so the SAME session resumes —
 * no second CLI, no manual nudge.
 *
 * CAUSE-AWARE (thin-harness-visual.html roadmap 02): a blind re-continue past a
 * hook block is a live-lock. So the resume is routed by cause:
 *   - normal execute progress      → resume directive (and clear any recover streak)
 *   - session_status='blocked_hook' → ROUTE TO RECOVER: a directive that names the
 *       block and demands it be resolved (not bypassed), bounded by a per-block_code
 *       attempt streak. After RECOVER_CAP attempts on the SAME block_code →
 *       ESCALATE: stop auto-recovering, surface to the user, idle.
 *   - session_status='verification_hang' → genuine hang: do NOT power through;
 *       surface a triage message and idle (human runs /mpl:mpl-resume).
 *
 * Scope is Phase 2 (execute) → completion ONLY. Interactive setup phases
 * (interview / decompose / plan / ambiguity HITL) and terminal states are left to
 * idle. A real block the aggregate already decided is never overridden. Runaway is
 * bounded by RECOVER_CAP here + the hang detector + max_fix_loops + convergence.
 *
 * PURE (no fs / config IO): returns { envelope, mutation }. The engine reads the
 * auto_continue flag + recover streak from state, calls this, emits the envelope,
 * and persists `mutation` (a state patch, or null) via writeState.
 */

export const AUTO_CONTINUE_PHASES = Object.freeze(new Set([
  'phase2-sprint', 'phase3-gate', 'phase4-fix', 'phase5-finalize',
  'small-plan', 'small-sprint', 'small-verify',
  'release-gate', 'release-finalize',
]));

// Consecutive recover attempts on the SAME block_code before escalating to the user.
export const RECOVER_CAP = 3;

const RESUME_REASON = (phase) =>
  `[MPL auto-continue] Phase-2+ clean-stop (current_phase='${phase}'). Continue the MPL `
  + `pipeline in THIS session — do not idle. Record the just-finished step's completion, `
  + `then dispatch the next phase/tier via mpl-phase-runner; once every decomposed phase is `
  + `done, run the 3 Hard Gates and finalize (finalize_done=true) so the pipeline reaches `
  + `current_phase='completed'. Stop only at completion, a Hard Gate failing past its `
  + `fix-loop budget, or a decision that truly needs the user (use AskUserQuestion for that).`;

const noop = (envelope) => ({ envelope, mutation: null });

/**
 * @param {string} event     hook event name
 * @param {object} envelope  the aggregated hook envelope
 * @param {object|null} state parsed .mpl/state.json
 * @param {boolean} enabled  resolved auto_continue flag (DEFAULT true upstream)
 * @param {number} [cap]     recover-attempt cap per block_code (default RECOVER_CAP)
 * @returns {{envelope: object, mutation: object|null}}
 */
export function decideAutoContinue(event, envelope, state, enabled, cap = RECOVER_CAP) {
  if (enabled === false) return noop(envelope);                              // explicit opt-out
  if (event !== 'Stop' && event !== 'SubagentStop') return noop(envelope);
  if (!state || typeof state !== 'object') return noop(envelope);
  // Never override a real block / hard-stop the aggregate already decided.
  if (envelope && (envelope.decision === 'block' || envelope.continue === false)) return noop(envelope);
  // Scope: Phase 2 (execute) → completion. Interview/decompose/plan stay manual.
  if (!AUTO_CONTINUE_PHASES.has(state.current_phase)) return noop(envelope);

  const ss = state.session_status;

  // --- blocked_hook → cause-aware recover routing + escalation -------------
  if (ss === 'blocked_hook') {
    const code = typeof state.block_code === 'string' && state.block_code.trim()
      ? state.block_code.trim() : 'blocked';
    const prev = (state.auto_continue_recover && typeof state.auto_continue_recover === 'object')
      ? state.auto_continue_recover : null;
    const attempts = (prev && prev.code === code && Number.isFinite(Number(prev.attempts)))
      ? Number(prev.attempts) : 0;

    if (attempts >= cap) {
      // ESCALATE — the same block survived auto-recover; hand off to the user.
      const msg =
        `[MPL auto-continue] HALTED: block '${code}' (${state.blocked_by_hook || 'unknown hook'}) `
        + `persisted through ${attempts} auto-recover attempt(s). This needs you — run `
        + `/mpl:mpl-resume to recover, roll back, or cancel. ${state.resume_instruction || ''}`.trim();
      return { envelope: { continue: true, systemMessage: msg }, mutation: null };
    }

    // ROUTE TO RECOVER — demand the block be resolved (never bypassed), bump streak.
    const reason =
      `[MPL auto-continue · recover ${attempts + 1}/${cap}] A hook blocked progress: `
      + `${state.blocked_by_hook || 'unknown hook'} (${code}) on `
      + `'${state.blocked_phase || state.current_phase}'. ${state.block_reason || ''} `
      + `RESOLVE THE BLOCK — do NOT bypass it or work around the guard: `
      + `${state.resume_instruction || 'address the recorded block, then retry the operation'}. `
      + `If it cannot be resolved, run /mpl:mpl-resume instead of retrying.`;
    return {
      envelope: { decision: 'block', reason },
      mutation: { auto_continue_recover: { code, attempts: attempts + 1 } },
    };
  }

  // --- verification_hang → genuine hang: surface + idle (do not power through) -
  if (ss === 'verification_hang') {
    const msg =
      '[MPL auto-continue] Paused: session marked verification_hang. Auto-continue does NOT '
      + 'power through a hang — run /mpl:mpl-resume to resume the current phase, roll back, or cancel.';
    return { envelope: { continue: true, systemMessage: msg }, mutation: null };
  }

  // --- normal execute progress → resume (and clear any stale recover streak) --
  return {
    envelope: { decision: 'block', reason: RESUME_REASON(state.current_phase) },
    mutation: state.auto_continue_recover ? { auto_continue_recover: null } : null,
  };
}
