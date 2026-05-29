/**
 * Hook block-surface helper (#235 / B-category).
 *
 * Most PreToolUse hooks used to roll their own
 *   function block(reason) {
 *     console.log(JSON.stringify({continue:false, decision:'block', reason}));
 *   }
 * which bypassed two layers:
 *   1. The blocked_hook envelope (state.json fields consumed by
 *      `mpl-recover` and `mpl-state-invariant`'s BLOCKED_HOOK_STALE
 *      check).
 *   2. The per-rule enforcement policy (ENFORCEMENT_DEFAULTS / .mpl/
 *      config.json `enforcement.*`) — operators that opt out of strict
 *      mode still saw hard blocks.
 *
 * This helper threads both. Callers describe the violation
 * declaratively; the helper resolves the policy via
 * `resolveRuleAction`, records the envelope on `block`, clears any
 * stale envelope on `warn` / `off`, and returns the appropriate hook
 * response JSON.
 *
 * Pure: no I/O beyond what `recordBlockedHook` / `clearBlockedHook`
 * already do (state.json read + patch). No console output — callers
 * print the returned value.
 *
 * Tier semantics (per
 * `docs/findings/2026-05-28-enforcement-relaxation-plan.md`):
 *   - `off` → silent pass + clear any stale envelope.
 *   - `warn` → `continue: true` with the reason surfaced via
 *     `hookSpecificOutput.additionalContext` (and `systemMessage` for
 *     non-PreToolUse hooks). Clear any stale envelope.
 *   - `block` → record envelope, return `decision: 'block'`.
 *
 * Rules whose default in ENFORCEMENT_DEFAULTS is `block` (not `warn`)
 * preserve current "always block" behavior; opt-out via
 * `.mpl/config.json` enforcement.<ruleId> = 'off' still works.
 */

import { resolveRuleAction } from './mpl-enforcement.mjs';
import { recordBlockedHook, clearBlockedHook } from './mpl-blocked-hook.mjs';

export const HOOK_EVENT_DEFAULT = 'PreToolUse';

/**
 * @param {string} cwd
 * @param {object | null} state — pipeline state.json contents (or null)
 * @param {object} opts
 * @param {string} opts.hookId — e.g. 'mpl-require-phase-evidence'
 * @param {string} opts.ruleId — e.g. 'missing_phase_evidence'
 * @param {string} opts.code — block_code stored in the envelope
 * @param {string} opts.reason — user-visible message (printed both as
 *   block.reason and as the systemMessage on warn)
 * @param {string} [opts.resumeInstruction] — envelope resume hint
 * @param {string} [opts.artifact] — envelope artifact field
 * @param {object} [opts.retryContext] — envelope retry_context
 * @param {string} [opts.hookEvent] — defaults to 'PreToolUse'; set to
 *   the correct event name when called from a non-PreToolUse hook so
 *   hookSpecificOutput.hookEventName matches.
 * @param {string} [opts.warnContext] — overrides reason for the warn
 *   surface (e.g. shorter advisory text)
 * @returns {object} hook-response JSON payload
 */
export function surfaceBlockedHook(cwd, state, opts) {
  const {
    hookId,
    ruleId,
    code,
    reason,
    resumeInstruction,
    artifact = 'unknown',
    retryContext = {},
    hookEvent = HOOK_EVENT_DEFAULT,
    warnContext,
  } = opts || {};

  const action = resolveRuleAction(cwd, state, ruleId);
  if (action === 'off') {
    clearBlockedHook(cwd, { hookId, artifact });
    return { continue: true, suppressOutput: true };
  }
  if (action === 'block') {
    recordBlockedHook(cwd, {
      hookId,
      phaseId: state?.current_phase,
      artifact,
      code,
      reason,
      resumeInstruction,
      retryContext,
    });
    return { continue: false, decision: 'block', reason };
  }
  clearBlockedHook(cwd, { hookId, artifact });
  return {
    continue: true,
    systemMessage: warnContext ?? reason,
    hookSpecificOutput: {
      hookEventName: hookEvent,
      additionalContext: warnContext ?? reason,
    },
  };
}

/**
 * Convenience: compute via `surfaceBlockedHook` and write the JSON
 * payload to stdout. Returns the resolved action ('off' | 'warn' |
 * 'block') so the caller can branch (e.g. early-return on block).
 */
export function emitBlockedHook(cwd, state, opts) {
  const payload = surfaceBlockedHook(cwd, state, opts);
  console.log(JSON.stringify(payload));
  return payload.decision === 'block' ? 'block'
    : (payload.suppressOutput ? 'off' : 'warn');
}

/**
 * Clear any pre-existing envelope tagged with this (hookId, artifact)
 * and emit the silent success response. Use on the no-violation /
 * recovered path so a previously-recorded block doesn't linger.
 */
export function emitClearedOk(cwd, { hookId, artifact }) {
  clearBlockedHook(cwd, { hookId, artifact });
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}
