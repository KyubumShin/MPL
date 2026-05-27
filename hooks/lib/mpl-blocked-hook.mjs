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
  return {
    session_status: 'blocked_hook',
    blocked_by_hook: hookId,
    blocked_phase: phaseId || 'unknown',
    blocked_artifact: artifact || 'unknown',
    block_code: code || 'blocked',
    block_reason: reason || 'Hook blocked progress.',
    resume_instruction: resumeInstruction || 'Resolve the recorded hook block, then retry the blocked operation.',
    retry_context:
      retryContext && typeof retryContext === 'object' && !Array.isArray(retryContext)
        ? retryContext
        : {},
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
