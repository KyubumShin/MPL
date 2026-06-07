/**
 * MPL v2 Envelope Bridge (Move #14 Part 2)
 *
 * Bridges policy module decisions back into the `blocked_hook` envelope that
 * lives on `.mpl/state.json` and is consumed by:
 *
 *   - mpl-recover           (resume gate reads `blocked_by_hook` to drive the
 *                            recovery skill)
 *   - mpl-state-invariant   (BLOCKED_HOOK_STALE enforcement scans the same
 *                            row + the H8 schema guard)
 *   - normalizeBlockedHookState (state.mjs invariant normalizer)
 *   - telemetry-errors.jsonl + RUNBOOK rows that the writeState path appends
 *
 * Two distinct sources of envelope side-effects per decision:
 *
 *   (1) STRUCTURED   — the policy module already attached entries to
 *                      decision.sideEffects (source-edit.mjs / schemas.mjs /
 *                      contracts.mjs). These are dispatched verbatim using
 *                      the legacy mpl-write-guard.mjs switch (lines 54-108).
 *
 *   (2) IMPLICIT     — the policy returned action='block' or action='allow'
 *                      but did not attach a sideEffect. We synthesize the
 *                      matching recordBlockedHook / clearBlockedHook call
 *                      from the fields the module already exposes
 *                      ({ruleId, code, reason, artifact, resumeInstruction,
 *                      retryContext, hookId}).
 *
 * Fail-open: every dispatch is wrapped in try/catch (envelope writes are
 * best-effort; the hook response is authoritative — same contract as
 * recordBlockedHook itself).
 *
 * SECURITY: buildBlockedHookPatch tombstones
 * `retry_context.recovery.awaiting_instruction = null` (PR #242 r11). The
 * bridge does NOT touch that path so the leak guard remains intact.
 */

import {
  recordBlockedHook,
  clearBlockedHook,
} from '../mpl-blocked-hook.mjs';
import { readState, writeState } from '../mpl-state.mjs';

// ---------------------------------------------------------------------------
// SSOT: route id -> legacy hook id mapping.
//
// Used only when a policy module does NOT set `decision.hookId` itself. The
// legacy hook ids are stable identifiers consumed by mpl-recover and
// mpl-state-invariant; if a module sets its own hookId (gates.mjs
// FINALIZE_HOOK_ID, contracts HOOK_IDS), that wins.
// ---------------------------------------------------------------------------
const ROUTE_TO_HOOK_ID = Object.freeze({
  'permit.auto-permit':         'mpl-auto-permit',
  'permit.permit-learner':      'mpl-permit-learner',
  'permit.bash-timeout':        'mpl-bash-timeout',
  'permit.fallback-grep':       'mpl-fallback-grep',
  'source-edit':                'mpl-write-guard',
  'gates.finalize':             'mpl-finalize-gate',
  'gates.quality':              'mpl-quality-gate',
  'gates.ambiguity':            'mpl-ambiguity-gate',
  'gates.phase-transition':     'mpl-phase-controller',
  // contracts.* — fall back to ruleId resolved per-decision.
  'contracts.pre':              null,
  'contracts.post':             null,
  'channel-registry.pre':       'mpl-channel-registry',
  'channel-registry.post':      'mpl-channel-registry',
  'schemas.pivot-points':       'mpl-validate-pp-schema',
  'schemas.agent-output':       'mpl-validate-output',
  'schemas.seed':               'mpl-validate-seed',
});

// contracts.* ruleId -> legacy hook id. Mirrors contracts.HOOK_IDS so the
// engine envelope row stays stable for downstream consumers.
const CONTRACTS_RULE_TO_HOOK_ID = Object.freeze({
  chain_assignment:        'mpl-require-chain-assignment',
  covers:                  'mpl-require-covers',
  decomposition_delta:     'mpl-require-decomposition-delta',
  goal_trace:              'mpl-require-goal-trace',
  phase_contract_graph:    'mpl-require-phase-contract-graph',
  reviewer:                'mpl-require-reviewer',
  test_agent_brief:        'mpl-require-test-agent-brief',
  test_agent_postrun:      'mpl-require-test-agent',
  e2e:                     'mpl-require-e2e',
  e2e_authenticity:        'mpl-require-e2e-authenticity',
  finalize_artifacts:      'mpl-require-finalize-artifacts',
  whole_goal_closure:      'mpl-require-whole-goal-closure',
  phase_evidence:          'mpl-require-phase-evidence',
});

export function resolveHookId({ moduleId, decision }) {
  if (decision && typeof decision.hookId === 'string' && decision.hookId) {
    return decision.hookId;
  }
  if (moduleId && moduleId.startsWith('contracts.')) {
    const ruleId = decision && typeof decision.ruleId === 'string' ? decision.ruleId : '';
    if (ruleId && CONTRACTS_RULE_TO_HOOK_ID[ruleId]) {
      return CONTRACTS_RULE_TO_HOOK_ID[ruleId];
    }
  }
  if (moduleId && Object.prototype.hasOwnProperty.call(ROUTE_TO_HOOK_ID, moduleId)) {
    const mapped = ROUTE_TO_HOOK_ID[moduleId];
    if (mapped) return mapped;
  }
  // Last-resort fallback: the moduleId itself. Better than 'unknown' for
  // downstream debugging.
  return moduleId || 'unknown';
}

// ---------------------------------------------------------------------------
// (1) Structured sideEffect dispatcher
//     Verbatim port of hooks/mpl-write-guard.mjs:54-108 so behavior is
//     byte-identical to the legacy wrapper.
// ---------------------------------------------------------------------------
export function applySideEffect(eff) {
  if (!eff || typeof eff !== 'object') return;
  try {
    switch (eff.kind) {
      case 'recordBlockedHook': {
        const { cwd, ...opts } = eff.payload || {};
        recordBlockedHook(cwd, opts);
        break;
      }
      case 'clearBlockedHook': {
        const { cwd, ...opts } = eff.payload || {};
        clearBlockedHook(cwd, opts);
        break;
      }
      case 'lockDecomposerChild': {
        const { cwd, callerTranscriptPath } = eff.payload || {};
        const state = readState(cwd) || {};
        const flag = state.decomposer_dispatch;
        if (flag && typeof flag === 'object' && typeof flag.child_transcript_path !== 'string') {
          writeState(cwd, {
            decomposer_dispatch: {
              ...flag,
              child_transcript_path: callerTranscriptPath,
            },
          });
        }
        break;
      }
      case 'recordDecomposerDispatch': {
        const { cwd, parentTranscriptPath } = eff.payload || {};
        writeState(cwd, {
          decomposer_dispatch: {
            dispatched_at: new Date().toISOString(),
            parent_transcript_path: parentTranscriptPath || null,
            child_transcript_path: null,
          },
        });
        break;
      }
      case 'recordFirstTranscript': {
        const { cwd, transcriptPath } = eff.payload || {};
        if (!transcriptPath || typeof transcriptPath !== 'string') break;
        const state = readState(cwd) || {};
        if (typeof state.first_transcript_seen === 'string' && state.first_transcript_seen) break;
        writeState(cwd, { first_transcript_seen: transcriptPath });
        break;
      }
      default:
        // Unknown side effect — ignore (forward-compatible).
        break;
    }
  } catch {
    // Best-effort; the decision is authoritative.
  }
}

// ---------------------------------------------------------------------------
// (2) Implicit envelope inference helpers.
//
// `action: 'block'`    -> recordBlockedHook(hookId, phaseId, artifact, code,
//                          reason, resumeInstruction, retryContext)
// `action: 'allow'`    -> clearBlockedHook(hookId, artifact). The helper
//                          already returns early when state.session_status !==
//                          'blocked_hook' or blocked_by_hook !== hookId, so
//                          unrelated allows cannot blow away a sibling rule's
//                          block.
// `action: 'warn'`     -> same clear as allow + warn reason surfaced via
//                          aggregate()'s additionalContext path (no envelope
//                          write).
// `action: 'advisory'` -> no envelope side effect (skip).
// `action: 'noop'`     -> no envelope side effect (skip).
// `action: 'tracked'`  -> bypass (trackers.mjs).
// ---------------------------------------------------------------------------

function _normalizeAction(decision) {
  if (!decision || typeof decision !== 'object') return null;
  // Engine convention: `action` is the canonical field. source-edit (and a
  // few other legacy-shaped envelopes) used `decision` instead — accept both.
  const a = decision.action || decision.decision || null;
  if (typeof a !== 'string') return null;
  return a;
}

function _structuredHasBlocked(decision, hookId, artifact) {
  if (!decision || !Array.isArray(decision.sideEffects)) return false;
  for (const eff of decision.sideEffects) {
    if (!eff || eff.kind !== 'recordBlockedHook') continue;
    const p = eff.payload || {};
    if (p.hookId === hookId && (!artifact || p.artifact === artifact)) {
      return true;
    }
  }
  return false;
}

function _structuredHasCleared(decision, hookId, artifact) {
  if (!decision || !Array.isArray(decision.sideEffects)) return false;
  for (const eff of decision.sideEffects) {
    if (!eff || eff.kind !== 'clearBlockedHook') continue;
    const p = eff.payload || {};
    if (p.hookId === hookId && (!artifact || p.artifact === artifact)) {
      return true;
    }
  }
  return false;
}

/**
 * Apply the envelope side-effects for ONE module decision.
 *
 * @param {object} args
 * @param {string} args.cwd
 * @param {string} args.moduleId   — engine route id (e.g. 'gates.finalize')
 * @param {object} args.decision   — module's returned decision envelope
 * @param {object} [args.state]    — pre-handler state snapshot (used for phaseId fallback)
 */
export function applyEnvelopeForDecision({ cwd, moduleId, decision, state }) {
  if (!cwd || !decision) return;

  // Step (1) — Structured sideEffects dispatch (always runs first).
  if (Array.isArray(decision.sideEffects)) {
    for (const eff of decision.sideEffects) {
      applySideEffect(eff);
    }
  }

  // Step (2) — Implicit inference. Skip when the policy already emitted a
  // matching structured sideEffect; skip for non-envelope actions.
  const action = _normalizeAction(decision);
  if (!action) return;
  if (action === 'advisory' || action === 'noop' || action === 'tracked' ||
      action === 'report' || action === 'silent' || action === 'malformed' ||
      action === 'fail-closed' || action === 'fail-closed-disk' ||
      action === 'pass-through' || action === 'approve' ||
      action === 'learn-tool' || action === 'learn-bash-prefix' ||
      action === 'veto-skip' || action === 'bypass' ||
      action === 'pass' || action === 'retry' || action === 'escalate' ||
      action === 'emit' || action === 'delegate-to-legacy') {
    return;
  }

  const hookId = resolveHookId({ moduleId, decision });
  const artifact = (decision.artifact && typeof decision.artifact === 'string')
    ? decision.artifact
    : 'unknown';

  try {
    if (action === 'block') {
      // Dedupe: skip when the policy already attached a matching
      // recordBlockedHook for the same (hookId, artifact).
      if (_structuredHasBlocked(decision, hookId, artifact)) return;
      recordBlockedHook(cwd, {
        hookId,
        phaseId: (decision.phaseId || decision.blocked_phase || state?.current_phase || 'unknown'),
        artifact,
        code: decision.code || decision.block_code || 'blocked',
        reason: decision.reason || decision.block_reason || 'Hook blocked progress.',
        resumeInstruction: decision.resumeInstruction || decision.resume_instruction,
        retryContext: decision.retryContext || decision.retry_context || {},
      });
      return;
    }

    if (action === 'allow' || action === 'warn') {
      // Skip when the policy already attached a matching clearBlockedHook.
      if (_structuredHasCleared(decision, hookId, artifact)) return;
      // Unconditional call — clearBlockedHook helper already returns early
      // when state.session_status !== 'blocked_hook' OR blocked_by_hook !==
      // hookId, so a sibling rule's block is never disturbed.
      clearBlockedHook(cwd, { hookId, artifact });
      return;
    }
  } catch {
    // Fail-open: envelope writes are best-effort.
  }
}
