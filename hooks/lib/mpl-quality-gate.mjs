/**
 * MPL Quality Gate (P0-A redesign, #103)
 *
 * Original P0-A had `mpl-phase-runner` itself dispatch an adversarial reviewer
 * via Step 4.5. Claude Code does NOT support nested Agent dispatch ("Agent
 * tool is not available in this environment"), so the redesign moves the
 * reviewer to the orchestrator (`commands/mpl-run-execute.md`) which calls
 * `Task(subagent_type='mpl-adversarial-reviewer')` after each phase finishes.
 * The reviewer writes a score JSON; this lib + hook decide pass / retry /
 * escalate.
 *
 * Pure functions. No I/O.
 */

/**
 * Default acceptance threshold. Workspace can override via
 * `.mpl/config.json:adversarial.threshold`.
 */
export const DEFAULT_QUALITY_THRESHOLD = 0.7;

/**
 * Default retry budget before escalation to the user. Workspace can override
 * via `.mpl/config.json:adversarial.max_retries`.
 */
export const DEFAULT_MAX_ADVERSARIAL_RETRIES = 3;

/**
 * Parse the JSON written by the adversarial-reviewer agent. Returns null when
 * the input isn't a valid object with the required fields. Conservative:
 * malformed score is treated as "no decision" rather than auto-pass/fail.
 *
 * Expected shape:
 *   {
 *     phase: string,
 *     score: number (0..1),
 *     verdict: 'PASS' | 'FAIL',
 *     issues: string[],
 *     timestamp: ISO-8601 string
 *   }
 *
 * @param {unknown} input
 * @returns {{
 *   phase: string,
 *   score: number,
 *   verdict: 'PASS' | 'FAIL',
 *   issues: string[],
 *   timestamp: string,
 * } | null}
 */
export function parseScore(input) {
  let obj = input;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const phase = typeof obj.phase === 'string' ? obj.phase : null;
  const score = typeof obj.score === 'number' && Number.isFinite(obj.score)
    ? obj.score : null;
  const verdict = obj.verdict === 'PASS' || obj.verdict === 'FAIL' ? obj.verdict : null;
  const issues = Array.isArray(obj.issues) ? obj.issues.filter((s) => typeof s === 'string') : [];
  const timestamp = typeof obj.timestamp === 'string' ? obj.timestamp : null;
  if (phase === null || score === null || verdict === null || timestamp === null) return null;
  return { phase, score, verdict, issues, timestamp };
}

/**
 * Decide the gate action from a parsed score + retry history.
 *
 * @param {{ score: number, verdict: 'PASS' | 'FAIL' }} parsed
 * @param {{ retryCount?: number, threshold?: number, maxRetries?: number }} [opts]
 * @returns {{
 *   action: 'pass' | 'retry' | 'escalate',
 *   reason: string,
 *   retryCount: number,
 *   threshold: number,
 *   maxRetries: number,
 * }}
 */
export function decideAction(parsed, opts = {}) {
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_QUALITY_THRESHOLD;
  const maxRetries = typeof opts.maxRetries === 'number' ? opts.maxRetries : DEFAULT_MAX_ADVERSARIAL_RETRIES;
  const retryCount = typeof opts.retryCount === 'number' ? opts.retryCount : 0;

  // Verdict from the reviewer is authoritative; score is the secondary signal.
  // Both must agree for PASS — score >= threshold AND verdict='PASS'. A high
  // score with verdict='FAIL' surfaces (the reviewer found something the score
  // didn't capture); a low score with verdict='PASS' also surfaces (we trust
  // the explicit threshold).
  const passes = parsed.score >= threshold && parsed.verdict === 'PASS';

  if (passes) {
    return {
      action: 'pass',
      reason: `[MPL P0-A] Adversarial review PASS (score=${parsed.score.toFixed(3)} >= ${threshold}, verdict=${parsed.verdict}).`,
      retryCount,
      threshold,
      maxRetries,
    };
  }

  if (retryCount >= maxRetries) {
    return {
      action: 'escalate',
      reason: `[MPL P0-A] Adversarial review FAIL after ${retryCount} retr${retryCount === 1 ? 'y' : 'ies'} (max ${maxRetries}). Score=${parsed.score.toFixed(3)} threshold=${threshold} verdict=${parsed.verdict}. Surface to the user — phase-runner cannot self-correct further.`,
      retryCount,
      threshold,
      maxRetries,
    };
  }

  return {
    action: 'retry',
    reason: `[MPL P0-A] Adversarial review FAIL (score=${parsed.score.toFixed(3)} < ${threshold} OR verdict=${parsed.verdict}). Retry ${retryCount + 1}/${maxRetries} — re-dispatch phase-runner with reviewer feedback.`,
    retryCount,
    threshold,
    maxRetries,
  };
}

/**
 * Compose a fresh history entry for `state.quality_score_history[]`. Tracks
 * one record per reviewer dispatch so resume + finalize can replay the
 * accept/reject sequence.
 *
 * @param {ReturnType<typeof parseScore>} parsed
 * @param {ReturnType<typeof decideAction>} decision
 * @returns {{
 *   phase: string,
 *   score: number,
 *   verdict: 'PASS' | 'FAIL',
 *   issues: string[],
 *   timestamp: string,
 *   action: 'pass' | 'retry' | 'escalate',
 *   retry_count: number,
 * }}
 */
export function composeHistoryEntry(parsed, decision) {
  return {
    phase: parsed.phase,
    score: parsed.score,
    verdict: parsed.verdict,
    issues: parsed.issues,
    timestamp: parsed.timestamp,
    action: decision.action,
    retry_count: decision.retryCount,
  };
}
