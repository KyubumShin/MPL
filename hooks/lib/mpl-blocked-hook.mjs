import { readState, writeState } from './mpl-state.mjs';

/**
 * The set of string companion fields a `session_status === 'blocked_hook'`
 * envelope MUST carry to be considered actionable. Same list mpl-state-invariant
 * uses for the BLOCKED_HOOK_STALE violation. Exported so diagnostic tools
 * (e.g. mpl-hook-trace) can validate envelopes without duplicating the rule.
 */
export const BLOCKED_HOOK_REQUIRED_STRING_FIELDS = Object.freeze([
  'blocked_by_hook',
  'blocked_phase',
  'blocked_artifact',
  'block_code',
  'block_reason',
  'resume_instruction',
  'blocked_at',
]);

/**
 * Return the list of missing required fields from a `state` object whose
 * session_status is `blocked_hook`. An empty list means the envelope is
 * complete enough to be acted on. `retry_context` is required as a plain
 * object (not null, not an array).
 */
export function missingBlockedHookFields(state) {
  if (!state || state.session_status !== 'blocked_hook') return [];
  const missing = BLOCKED_HOOK_REQUIRED_STRING_FIELDS.filter((key) => {
    const v = state[key];
    return typeof v !== 'string' || v.trim() === '';
  });
  const rc = state.retry_context;
  if (!rc || typeof rc !== 'object' || Array.isArray(rc)) {
    missing.push('retry_context');
  }
  return missing;
}

export function buildBlockedHookPatch({
  hookId = 'unknown',
  phaseId = 'unknown',
  artifact = 'unknown',
  code = 'blocked',
  reason,
  resumeInstruction,
  retryContext = {},
  blockedAt = new Date().toISOString(),
}) {
  // Codex r10 on PR #242 [security] defense-in-depth: writeState's
  // deepMerge preserves nested keys absent from the patch. A new
  // blocked-hook envelope is a fresh block, so any stale
  // retry_context.recovery from a prior block (including a leaked
  // recovery.awaiting_instruction that could leak gated dispatch
  // text) must be tombstoned at the envelope boundary. Explicitly
  // null the recovery sub-object's known sensitive fields so deepMerge
  // overwrites any stale value. Scope-tagging in `activeRecoveryState`
  // already neutralizes the recover-skill's own consumption, but an
  // external state watcher reading state.json directly would still
  // see the stale text without this guard.
  const inboundRetryContext =
    retryContext && typeof retryContext === 'object' && !Array.isArray(retryContext)
      ? retryContext
      : {};
  // Codex r11 on PR #242 [security]: previously the tombstone was
  // spread BEFORE the caller's recovery object, so a caller passing
  // `retryContext.recovery.awaiting_instruction = "LEAK"` would
  // override the null. Tombstone must WIN — strip the sensitive
  // field unconditionally regardless of caller intent.
  const incomingRecovery =
    inboundRetryContext.recovery && typeof inboundRetryContext.recovery === 'object'
      && !Array.isArray(inboundRetryContext.recovery)
      ? inboundRetryContext.recovery
      : null;
  return {
    session_status: 'blocked_hook',
    blocked_by_hook: hookId,
    blocked_phase: phaseId || 'unknown',
    blocked_artifact: artifact || 'unknown',
    block_code: code || 'blocked',
    block_reason: reason || 'Hook blocked progress.',
    resume_instruction: resumeInstruction || 'Resolve the recorded hook block, then retry the blocked operation.',
    retry_context: {
      ...inboundRetryContext,
      recovery: {
        ...(incomingRecovery || {}),
        // Tombstone WINS — applied after the caller spread so it cannot
        // be overridden. No caller path may emit gated dispatch text.
        awaiting_instruction: null,
      },
    },
    blocked_at: blockedAt,
  };
}

export function recordBlockedHook(cwd, opts) {
  try {
    const state = readState(cwd);
    if (!state) return;
    writeState(cwd, buildBlockedHookPatch({
      ...opts,
      phaseId: opts?.phaseId || state.current_phase || 'unknown',
    }));
  } catch {
    // Visibility is best-effort; the hook's block/deny response remains authoritative.
  }
}

export function clearBlockedHook(cwd, { hookId, phaseId, artifact } = {}) {
  try {
    const state = readState(cwd) || {};
    if (state.session_status !== 'blocked_hook') return;
    if (hookId && state.blocked_by_hook !== hookId) return;
    if (phaseId && state.blocked_phase !== phaseId) return;
    if (artifact && state.blocked_artifact !== artifact) return;
    writeState(cwd, {
      session_status: null,
      blocked_by_hook: null,
      blocked_phase: null,
      blocked_artifact: null,
      block_code: null,
      block_reason: null,
      resume_instruction: null,
      retry_context: null,
      blocked_at: null,
    });
  } catch {
    // Best-effort cleanup only.
  }
}
