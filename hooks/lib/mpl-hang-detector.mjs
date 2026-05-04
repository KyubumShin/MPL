/**
 * MPL Hang Detection (G4, #109)
 *
 * G1 (#107) bounds individual Bash verification runs. G4 catches the
 * orthogonal failure mode: orchestrator silently stalled — no tool call has
 * fired in N minutes. exp15 phase-10 produced a 5h 18m hang because nothing
 * marked the session, so the user had to externally notice and kill it.
 *
 * Mechanism:
 *   1. PostToolUse `mpl-tool-tracker.mjs` writes `state.last_tool_at` on every
 *      tool invocation.
 *   2. Stop hook (`mpl-phase-controller.mjs`) calls `detectHang(state, now)`
 *      before phase routing. If `now - last_tool_at > threshold` AND the
 *      session is not already paused for a known reason, mark
 *      `session_status = 'verification_hang'`.
 *   3. Resume / user intervention surfaces the marking.
 *
 * Pure functions. No I/O.
 */

/**
 * Hang threshold in ms — 15 minutes per issue #109.
 * Configurable via `.mpl/config.json:hang_detection.threshold_ms` (future).
 */
export const DEFAULT_HANG_THRESHOLD_MS = 15 * 60 * 1000;

/**
 * Status values for which hang detection should NOT fire.
 * `paused_budget` / `paused_checkpoint` are intentional, user-acknowledged pauses.
 * `verification_hang` itself: don't re-mark; preserve the original detection time.
 */
const HANG_EXEMPT_STATUSES = new Set([
  'paused_budget',
  'paused_checkpoint',
  'verification_hang',
]);

/**
 * Detect a verification hang from state + current wall clock.
 *
 * @param {object | null | undefined} state - state.json contents
 * @param {Date | number} now - reference time (Date or epoch-ms)
 * @param {{ thresholdMs?: number }} [opts]
 * @returns {{
 *   hung: boolean,
 *   elapsedMs: number | null,
 *   thresholdMs: number,
 *   lastToolAt: string | null,
 *   reason: string,
 * }}
 */
export function detectHang(state, now, opts = {}) {
  const thresholdMs = opts.thresholdMs ?? DEFAULT_HANG_THRESHOLD_MS;
  const result = (hung, elapsedMs, lastToolAt, reason) => ({
    hung,
    elapsedMs,
    thresholdMs,
    lastToolAt: lastToolAt ?? null,
    reason,
  });

  if (!state || typeof state !== 'object') {
    return result(false, null, null, 'no state');
  }
  if (HANG_EXEMPT_STATUSES.has(state.session_status)) {
    return result(false, null, state.last_tool_at ?? null, `exempt status: ${state.session_status}`);
  }

  const lastToolAt = state.last_tool_at;
  if (!lastToolAt || typeof lastToolAt !== 'string') {
    // No PostToolUse has fired yet — can't detect a hang.
    return result(false, null, null, 'no last_tool_at recorded');
  }

  const lastMs = Date.parse(lastToolAt);
  if (Number.isNaN(lastMs)) {
    return result(false, null, lastToolAt, 'unparseable last_tool_at');
  }

  const nowMs = typeof now === 'number' ? now : now.getTime();
  const elapsedMs = nowMs - lastMs;

  if (elapsedMs <= thresholdMs) {
    return result(false, elapsedMs, lastToolAt, 'within threshold');
  }

  const minutes = Math.floor(elapsedMs / 60_000);
  return result(
    true,
    elapsedMs,
    lastToolAt,
    `[MPL G4] ⚠ Verification appears hung. Last tool execution: ${lastToolAt} (${minutes}min ago, threshold ${Math.floor(thresholdMs / 60_000)}min). Check the verification command or kill the stuck process. Session marked as verification_hang — run /mpl:mpl-resume to triage (resume / rollback / cancel).`,
  );
}

/**
 * Format the user-facing message for a detected hang. Returned as
 * `stopReason` text in the Stop hook output so the user can intervene.
 *
 * @param {ReturnType<typeof detectHang>} det
 * @returns {string}
 */
export function formatHangMessage(det) {
  if (!det.hung) return '';
  return det.reason;
}
