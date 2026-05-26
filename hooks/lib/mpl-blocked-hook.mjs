import { readState, writeState } from './mpl-state.mjs';

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
