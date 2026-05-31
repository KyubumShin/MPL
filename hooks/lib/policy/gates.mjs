/**
 * MPL Gates Policy (L2 module — Move #9)
 *
 * SSOT for the four runtime gate hooks:
 *   1. finalize    — coalesce e2e + e2e_authenticity + finalize_artifacts +
 *                    whole_goal_closure into a single batched envelope.
 *   2. quality     — adversarial-reviewer score → pass/retry/escalate,
 *                    with the I/O+lockstep wrapper that gates consumeSignal
 *                    on a successful writeState (Move #9 fix; see
 *                    handleQuality docstring + the regression test).
 *   3. ambiguity   — user_contract_set + goal_contract validity +
 *                    ambiguity_score threshold check + override branch +
 *                    phase-reversion writes.
 *   4. phase_transition — Stop-hook decision skeleton (phase-switch
 *                    routing, transition predicate evaluation, G4-hang
 *                    short-circuit). Pass-A scope: returns the decision
 *                    envelope; the wrapper hook still owns release-manifest
 *                    / artifact / atomicWrite side effects (those move into
 *                    `lib/release/` in a follow-up Move).
 *
 * Public API:
 *   handle(event, ctx) -> dispatches to the right sub-handler
 *   handleFinalize(ctx)        -> { action, failures[], advisories[], reason, ... }
 *   handleQuality(ctx)         -> { action, systemMessage, stateMutations, consumeSignal, writeStateError? }
 *   handleAmbiguity(ctx)       -> { action, reason, phaseRevert?, stateMutations?, stderr? }
 *   handlePhaseTransition(ctx) -> { stopReason, stateMutations:[…], artifactsToWrite:[…], session_status_changes }
 *
 * Dependency boundary (per hooks/lib/policy/README.md, post-Move #9 update):
 *   - L1 helpers only EXCEPT a single narrow exception: gates.mjs MAY import
 *     `policy/contracts.mjs` for the four finalize-child handlers
 *     (handleE2eGate, handleE2eAuthenticity, handleFinalizeArtifacts,
 *     handleWholeGoalClosure). This is the ONLY permitted cross-policy
 *     import. contracts.mjs is already the SSOT for those four rules;
 *     re-implementing them here would clone code.
 *   - Does NOT import policy/evidence.mjs, policy/channel-registry.mjs,
 *     or policy/source-edit.mjs.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// L1 helpers
import { readState, writeState, isMplActive, checkConvergence } from '../mpl-state.mjs';
import { loadConfig } from '../mpl-config.mjs';
import { readGoalContract } from '../mpl-goal-contract.mjs';
import { detectHang } from '../mpl-hang-detector.mjs';
import { resolveRuleAction } from '../mpl-enforcement.mjs';
import { blockedPhaseTransitionReason } from '../mpl-phase0-artifacts.mjs';

// Pure-fn quality decision module
import {
  parseScore,
  decideAction,
  composeHistoryEntry,
  DEFAULT_QUALITY_THRESHOLD,
  DEFAULT_MAX_ADVERSARIAL_RETRIES,
} from '../mpl-quality-gate.mjs';

// Narrow cross-policy exception (see header for rationale).
import {
  handleE2eGate,
  handleE2eAuthenticity,
  handleFinalizeArtifacts,
  handleWholeGoalClosure,
} from './contracts.mjs';

// ============================================================================
// Shared constants
// ============================================================================

export const FINALIZE_HOOK_ID = 'mpl-finalize-gate';
export const FINALIZE_BLOCKED_ARTIFACT = '.mpl/state.json#finalize_done';

export const QUALITY_SCORE_PATH = '.mpl/signals/quality-score.json';
export const QUALITY_ADVERSARIAL_AGENT = 'mpl-adversarial-reviewer';

export const AMBIGUITY_THRESHOLD = 0.2;

// Verbose legacy reason text — must match the strings the existing tests
// assert against. Defined as constants so the wrapper hook can rehydrate the
// envelope without round-tripping through policy.
export const QUALITY_SCORE_MISSING_MSG_PREFIX =
  '[MPL P0-A] adversarial-reviewer dispatch finished but ';
export const QUALITY_SCORE_MISSING_MSG_SUFFIX =
  ' is missing. Treat as gate-NOT-passed: re-dispatch the reviewer or surface to the user. Quality history was NOT mutated this round.';
export const QUALITY_MALFORMED_MSG =
  '[MPL P0-A] quality-score.json is malformed — expected {phase, score, verdict, issues[], timestamp} with score ∈ [0, 1]. Reviewer must rewrite the file.';

// ============================================================================
// (1) FINALIZE GATE — coalesced envelope over the four contracts.* handlers
// ============================================================================

/**
 * Detect a write to .mpl/state.json that sets finalize_done:true.
 * Mirrors the legacy implementation in mpl-finalize-gate.mjs.
 */
export function isFinalizeDoneWrite(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return false;
  const paths = [];
  if (toolInput.file_path) paths.push(toolInput.file_path);
  if (toolInput.filePath) paths.push(toolInput.filePath);
  const texts = [];
  for (const key of ['new_string', 'newString', 'content']) {
    if (typeof toolInput[key] === 'string') texts.push(toolInput[key]);
  }
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (edit?.file_path) paths.push(edit.file_path);
      if (edit?.filePath) paths.push(edit.filePath);
      for (const key of ['new_string', 'newString', 'content']) {
        if (typeof edit?.[key] === 'string') texts.push(edit[key]);
      }
    }
  }
  if (!paths.some((p) => /(^|\/)\.mpl\/state\.json$/.test(p))) return false;
  return texts.some((text) => /"finalize_done"\s*:\s*true/.test(text));
}

const FINALIZE_CHILDREN = Object.freeze([
  { name: 'e2e',                 hookId: 'mpl-require-e2e',                handler: handleE2eGate          },
  { name: 'e2e_authenticity',    hookId: 'mpl-require-e2e-authenticity',   handler: handleE2eAuthenticity  },
  { name: 'finalize_artifacts',  hookId: 'mpl-require-finalize-artifacts', handler: handleFinalizeArtifacts},
  { name: 'whole_goal_closure',  hookId: 'mpl-require-whole-goal-closure', handler: handleWholeGoalClosure },
]);

export function summarizeFinalizeFailures(failures) {
  const lines = failures.map((f, i) => {
    const head = `  ${i + 1}. [${f.hookId}] (${f.code})`;
    const reason = (f.reason || '').trim().replace(/\s+/g, ' ');
    return reason ? `${head}\n     ${reason}` : head;
  });
  return [
    `[MPL Finalize Gate] ${failures.length} validation failure(s) detected on the finalize_done=true write. ` +
      `Resolve every item below in one batch, then retry the write:`,
    ...lines,
  ].join('\n');
}

export function summarizeFinalizeAdvisories(advisories) {
  if (!advisories.length) return '';
  const lines = advisories.map((a) => `  - [${a.hookId}] ${a.message.trim()}`);
  return ['[MPL Finalize Gate] Advisories (non-blocking):', ...lines].join('\n');
}

/**
 * Run the four finalize-child handlers from contracts.mjs in-process,
 * collect block decisions into failures[] and surface them in a single
 * coalesced envelope. Cross-policy import to contracts.mjs is the
 * documented narrow exception (see header).
 *
 * @param {{cwd:string, state?:object, config?:object, toolName?:string, toolInput?:object, hookEvent?:string}} ctx
 * @returns {{
 *   action: 'allow'|'block'|'advisory',
 *   failures: Array,
 *   advisories: Array,
 *   reason?: string,
 *   resumeInstruction?: string,
 *   retryContext?: object,
 * }}
 */
export function handleFinalize(ctx = {}) {
  const toolName = String(ctx.toolName || '');
  const toolInput = ctx.toolInput || {};

  // Out-of-scope writes (non-finalize-done or non-Write/Edit/MultiEdit) pass
  // through silently. The wrapper hook also gates on these but we re-check
  // here so the policy module is safe to call directly from tests.
  if (!/^(Edit|Write|MultiEdit)$/.test(toolName)) {
    return { action: 'allow', failures: [], advisories: [] };
  }
  if (!isFinalizeDoneWrite(toolInput)) {
    return { action: 'allow', failures: [], advisories: [] };
  }

  const childCtx = {
    cwd: ctx.cwd,
    state: ctx.state || {},
    config: ctx.config || {},
    toolName,
    toolInput,
    hookEvent: ctx.hookEvent || 'PreToolUse',
  };

  const failures = [];
  const advisories = [];

  for (const child of FINALIZE_CHILDREN) {
    let decision;
    try {
      decision = child.handler(childCtx);
    } catch (err) {
      // Fail open per the MPL "non-blocking on error" convention so a
      // broken child cannot pin the pipeline.
      advisories.push({
        hookId: child.hookId,
        message: `child handler threw: ${err?.message || String(err)}`,
      });
      continue;
    }
    if (!decision) continue;
    if (decision.action === 'block') {
      failures.push({
        hookId: child.hookId,
        code: decision.code || 'unknown',
        reason: decision.reason || '',
        resume_instruction: decision.resumeInstruction || '',
        retry_context: decision.retryContext || {},
      });
    }
    // Note: contracts.mjs handlers currently only return 'allow' or 'block'.
    // Future warn-tier decisions land in `advisories[]` via the same shape.
  }

  if (failures.length === 0) {
    if (advisories.length === 0) {
      return { action: 'allow', failures, advisories };
    }
    return {
      action: 'advisory',
      failures,
      advisories,
      reason: summarizeFinalizeAdvisories(advisories),
    };
  }

  const reason = summarizeFinalizeFailures(failures);
  return {
    action: 'block',
    failures,
    advisories,
    reason,
    code: 'finalize_gate_failures',
    ruleId: 'finalize_gate_failures',
    artifact: FINALIZE_BLOCKED_ARTIFACT,
    resumeInstruction:
      "Address every entry in retry_context.failures[]. Each entry preserves the originating validator's hookId, code, and reason. Once all are resolved, retry the finalize_done=true write — the gate re-runs every validator on the new write.",
    retryContext: {
      failures: failures.map((f) => ({
        hookId: f.hookId,
        code: f.code,
        reason: f.reason,
        resume_instruction: f.resume_instruction,
        retry_context: f.retry_context,
      })),
      advisories,
    },
  };
}

// ============================================================================
// (2) QUALITY GATE — parseScore → decideAction → compose → persist → consume
// ============================================================================

function isAdversarialDispatch(toolName, toolInput) {
  if (!['Task', 'Agent', 'task', 'agent'].includes(toolName)) return false;
  const sub = toolInput?.subagent_type || toolInput?.subagentType;
  return sub === QUALITY_ADVERSARIAL_AGENT;
}

/**
 * Adversarial-reviewer quality-score consumption. Drives state mutations
 * (adversarial_retry_count + quality_score_history) and decides whether the
 * signal file can be safely consumed.
 *
 * **Bug fixed in this revision** (root cause at hooks/mpl-quality-gate.mjs
 * L110–L122 pre-Move #9): the legacy hook had TWO independent best-effort
 * blocks — writeState (try/catch swallowed) and rmSync(scoreFile) (no shared
 * status flag). When writeState threw (EBUSY/permission/disk-full on
 * .mpl/state.json) the rmSync still succeeded (different file, different
 * permission domain) → adversarial_retry_count was destroyed in RAM, never
 * persisted, the score signal was gone, and the NEXT reviewer round hit the
 * fail-closed "missing file" branch which states "Quality history was NOT
 * mutated this round" → the retry counter was permanently stuck at its
 * pre-failure value while the loop spun.
 *
 * The fix: gate consumeSignal on a successful writeState. When the write
 * fails, return action='fail-closed-disk', signal preserved, surface the
 * disk failure to the orchestrator so it escalates instead of silently
 * spinning. The wrapper hook owns the rmSync side effect — it only deletes
 * the signal when result.consumeSignal === true.
 *
 * The READ-ERROR branch was also tightened: a thrown readFileSync no longer
 * silently returns "silent" (which discarded the signal); it now mirrors the
 * existsSync miss → fail-closed surface, NO state mutation, signal preserved.
 *
 * @param {{cwd:string, toolName:string, toolInput:object, state?:object,
 *          config?:object, deps?:{readFileSync?:Function, existsSync?:Function,
 *          writeState?:Function, readState?:Function, loadConfig?:Function}}} ctx
 * @returns {{
 *   action: 'silent'|'malformed'|'fail-closed'|'fail-closed-disk'|'pass'|'retry'|'escalate',
 *   systemMessage?: string,
 *   stateMutations?: { adversarial_retry_count?: number, quality_score_history?: Array },
 *   consumeSignal: boolean,
 *   writeStateError?: string,
 * }}
 */
export function handleQuality(ctx = {}) {
  // Dependency injection points for tests (regression test stubs writeState
  // to throw on demand without mocking the import graph).
  const deps = ctx.deps || {};
  const _readFileSync = deps.readFileSync || readFileSync;
  const _existsSync = deps.existsSync || existsSync;
  const _writeState = deps.writeState || writeState;
  const _readState = deps.readState || readState;
  const _loadConfig = deps.loadConfig || loadConfig;

  const cwd = ctx.cwd;
  const toolName = String(ctx.toolName || '');
  const toolInput = ctx.toolInput || {};

  if (!isAdversarialDispatch(toolName, toolInput)) {
    return { action: 'silent', consumeSignal: false };
  }

  const scoreFile = join(cwd, QUALITY_SCORE_PATH);
  const missingMsg =
    QUALITY_SCORE_MISSING_MSG_PREFIX + QUALITY_SCORE_PATH + QUALITY_SCORE_MISSING_MSG_SUFFIX;

  // existsSync miss → fail-closed surface, NO mutation, signal preserved.
  if (!_existsSync(scoreFile)) {
    return {
      action: 'fail-closed',
      systemMessage: missingMsg,
      consumeSignal: false,
    };
  }

  // KEY CHANGE vs legacy hook L81 (which used `return silent()` on read
  // failure): unreadable signal mirrors the existsSync miss path. Treating a
  // read-throw as silent would have the gate skip and let the loop spin
  // without surfacing the failure.
  let raw;
  try {
    raw = _readFileSync(scoreFile, 'utf-8');
  } catch {
    return {
      action: 'fail-closed',
      systemMessage: missingMsg,
      consumeSignal: false,
    };
  }

  const parsed = parseScore(raw);
  if (!parsed) {
    return {
      action: 'malformed',
      systemMessage: QUALITY_MALFORMED_MSG,
      consumeSignal: false,
    };
  }

  const state = ctx.state || _readState(cwd) || {};
  const config = ctx.config || _loadConfig(cwd) || {};
  const adv = (config && typeof config.adversarial === 'object') ? config.adversarial : {};
  const threshold = typeof adv.threshold === 'number' ? adv.threshold : DEFAULT_QUALITY_THRESHOLD;
  const maxRetries = typeof adv.max_retries === 'number' ? adv.max_retries : DEFAULT_MAX_ADVERSARIAL_RETRIES;
  const retryCount = typeof state.adversarial_retry_count === 'number' ? state.adversarial_retry_count : 0;

  const decision = decideAction(parsed, { retryCount, threshold, maxRetries });
  const entry = composeHistoryEntry(parsed, decision);
  const history = Array.isArray(state.quality_score_history) ? state.quality_score_history : [];

  let nextRetry;
  if (decision.action === 'pass') nextRetry = 0;
  else if (decision.action === 'retry') nextRetry = retryCount + 1;
  else nextRetry = retryCount; // escalate — preserve last value

  // PERSIST FIRST with a status flag. The core bug fix: consumeSignal MUST
  // depend on a successful state advance, otherwise the signal is deleted
  // while the retry counter is permanently stuck at its pre-failure value.
  const stateMutations = {
    adversarial_retry_count: nextRetry,
    quality_score_history: [...history, entry],
  };

  let wroteOk = false;
  let writeStateError = null;
  try {
    _writeState(cwd, stateMutations);
    wroteOk = true;
  } catch (err) {
    writeStateError = String(err?.message || err);
  }

  if (!wroteOk) {
    // State write failed: PRESERVE the signal file so the next reviewer round
    // can re-read the same score against the (unadvanced) retry counter, AND
    // surface the disk failure to the orchestrator so it escalates instead of
    // silently spinning.
    return {
      action: 'fail-closed-disk',
      systemMessage:
        `[MPL P0-A] quality gate could not persist retry state (writeState failed: ${writeStateError}). ` +
        `Signal file preserved at ${QUALITY_SCORE_PATH}. Escalate to user: the retry counter cannot advance, ` +
        `and a silent loop would never reach maxRetries. Investigate disk/permission failure on .mpl/state.json.`,
      consumeSignal: false,
      writeStateError,
    };
  }

  // happy path
  return {
    action: decision.action,
    systemMessage: decision.reason,
    stateMutations,
    consumeSignal: true,
  };
}

// ============================================================================
// (3) AMBIGUITY GATE — user contract + goal contract + score threshold
// ============================================================================

function isUserContractRequiredFromDisk(cwd) {
  try {
    const cfgPath = join(cwd, '.mpl', 'config.json');
    if (!existsSync(cfgPath)) return true;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    if (cfg && cfg.user_contract_required === false) return false;
  } catch { /* fall through */ }
  return true;
}

function isGoalContractRequiredFromDisk(cwd) {
  try {
    const cfgPath = join(cwd, '.mpl', 'config.json');
    if (!existsSync(cfgPath)) return true;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    if (cfg && cfg.goal_contract_required === false) return false;
  } catch { /* fall through */ }
  return true;
}

/**
 * Ambiguity gate decision. Mirrors the legacy mpl-ambiguity-gate.mjs branch
 * tree so the existing test expectations hold:
 *   - non-Task/non-decomposer dispatch → bypass (allow)
 *   - state.json missing → block (no phase revert; state is unreadable)
 *   - user_contract_set false → block + revert to mpl-init
 *   - goal contract invalid/missing → block + revert to mpl-ambiguity-resolve
 *   - ambiguity_override.active → bypass (with stderr surface)
 *   - ambiguity_score missing → block + revert to mpl-ambiguity-resolve
 *   - score > threshold → block + revert
 *   - else → allow
 *
 * @param {{cwd:string, toolName:string, toolInput:object, state?:object}} ctx
 * @returns {{
 *   action: 'allow'|'block'|'bypass'|'noop',
 *   reason?: string,
 *   phaseRevert?: string,
 *   stateMutations?: object,
 *   stderr?: string,
 * }}
 */
export function handleAmbiguity(ctx = {}) {
  const cwd = ctx.cwd;
  const toolName = String(ctx.toolName || '');
  const toolInput = ctx.toolInput || {};

  if (toolName !== 'Task' && toolName !== 'Agent') {
    return { action: 'noop' };
  }
  const subagentType = String(toolInput.subagent_type || toolInput.subagentType || '');
  if (subagentType !== 'mpl-decomposer' && subagentType !== 'mpl:mpl-decomposer') {
    return { action: 'noop' };
  }

  const state = ctx.state !== undefined ? ctx.state : readState(cwd);
  if (!state) {
    return {
      action: 'block',
      reason: '[MPL] ⛔ Decomposer BLOCKED: Cannot read MPL state. Ensure .mpl/state.json exists.',
    };
  }

  // Step 1.5 user-contract gate (0.16 Tier A').
  const contractRequired = isUserContractRequiredFromDisk(cwd);
  if (contractRequired && state.user_contract_set !== true) {
    return {
      action: 'block',
      phaseRevert: 'mpl-init',
      stateMutations: { current_phase: 'mpl-init' },
      reason:
        '[MPL] ⛔ Decomposer BLOCKED: user_contract_set is false. ' +
        'Run Phase 0 Step 1.5 first: orchestrator inline loop calling mpl_classify_feature_scope MCP tool ' +
        'to produce .mpl/requirements/user-contract.md, then mpl_state_write({user_contract_set:true}). ' +
        'See commands/mpl-run-phase0.md Step 1.5. ' +
        'To opt out in legacy projects: set user_contract_required=false in .mpl/config.json.',
    };
  }

  // Goal Contract readiness gate.
  if (isGoalContractRequiredFromDisk(cwd)) {
    const goal = readGoalContract(cwd);
    if (!goal.exists || !goal.valid) {
      return {
        action: 'block',
        phaseRevert: 'mpl-ambiguity-resolve',
        stateMutations: { current_phase: 'mpl-ambiguity-resolve' },
        reason:
          '[MPL] ⛔ Decomposer BLOCKED: goal contract is missing or incomplete. ' +
          `Write .mpl/goal-contract.yaml before decomposition. Missing: ${goal.missing.join(', ')}. ` +
          'It must freeze source goal/user request, project pivot, ontology, variation axes, acceptance criteria, E2E policy, security policy, and completion evidence. ' +
          'To opt out in legacy projects: set goal_contract_required=false in .mpl/config.json.',
      };
    }

    if (state.goal_contract_set !== true || state.goal_contract_hash !== goal.contract.content_sha256) {
      // Caller side-effect — but expressed as a state mutation so the wrapper
      // can persist it before the score check (legacy behavior preserved).
      const mutation = {
        goal_contract_set: true,
        goal_contract_path: goal.path,
        goal_contract_hash: goal.contract.content_sha256,
      };
      return _ambiguityScoreCheck(state, { mutationsPending: mutation });
    }
  }

  return _ambiguityScoreCheck(state, { mutationsPending: null });
}

function _ambiguityScoreCheck(state, { mutationsPending } = {}) {
  const override = state.ambiguity_override;
  const overrideActive = override && override.active === true;
  const score = state.ambiguity_score;
  const hasScore = score !== null && score !== undefined;

  if (overrideActive) {
    return {
      action: 'bypass',
      stateMutations: mutationsPending || {},
      stderr:
        `[MPL] Ambiguity gate bypassed by override (by="${override.by}", reason="${override.reason}", score=${hasScore ? score : 'null'})\n`,
    };
  }

  if (!hasScore) {
    return {
      action: 'block',
      phaseRevert: 'mpl-ambiguity-resolve',
      stateMutations: { ...(mutationsPending || {}), current_phase: 'mpl-ambiguity-resolve' },
      reason:
        '[MPL] ⛔ Decomposer BLOCKED: ambiguity_score not found in state. ' +
        'Run Stage 2 first: call mpl_score_ambiguity MCP tool with pivot_points + user_responses and persist score via mpl_state_write. ' +
        'Phase reverted to mpl-ambiguity-resolve. ' +
        'If the interview should be halted without further questions, set ambiguity_override.active=true with a reason before retrying.',
    };
  }

  if (score > AMBIGUITY_THRESHOLD) {
    return {
      action: 'block',
      phaseRevert: 'mpl-ambiguity-resolve',
      stateMutations: { ...(mutationsPending || {}), current_phase: 'mpl-ambiguity-resolve' },
      reason:
        `[MPL] ⛔ Decomposer BLOCKED: ambiguity_score=${score} exceeds threshold ${AMBIGUITY_THRESHOLD}. ` +
        'Run Stage 2 again: re-call mpl_score_ambiguity MCP tool with updated user_responses targeting the weakest dimension. ' +
        'Phase reverted to mpl-ambiguity-resolve. ' +
        'To halt the loop without passing the threshold, set ambiguity_override.active=true with a reason (preserves the true score for downstream reporting).',
    };
  }

  return {
    action: 'allow',
    stateMutations: mutationsPending || {},
  };
}

// ============================================================================
// (4) PHASE TRANSITION CONTROLLER — Stop hook decision skeleton (Pass A)
// ============================================================================

/**
 * Pass-A scope: factor the *decision* skeleton out of the legacy
 * mpl-phase-controller.mjs. The wrapper hook still owns release-manifest /
 * artifact / atomicWrite file-write side effects; those move into
 * `lib/release/` in a follow-up Move (not Move #9 per the plan).
 *
 * What this handler owns NOW:
 *   - G4 hang detection (newly detected + already-marked branches)
 *   - blocked_hook short-circuit
 *   - Phase 0 artifact pre-transition guard via blockedPhaseTransitionReason
 *   - Phase-switch routing decisions for the simple cases:
 *       mpl-init, mpl-decompose, mpl-ambiguity-resolve, phase1-plan,
 *       phase1a-research, phase1b-plan, phase3-gate, phase4-fix, phase5-finalize,
 *       small-plan, small-sprint, small-verify
 *
 * What stays in the wrapper for Pass-A:
 *   - phase2-sprint cohort lazy-init (touches goal-contract + writeState)
 *   - release-gate, release-finalize (heavy manifest / snapshot / artifact I/O)
 *
 * The wrapper signals "delegate not handled, use legacy code path" with
 * `result.action === 'delegate-to-legacy'`.
 *
 * @param {{cwd:string, state:object, config?:object}} ctx
 * @returns {{
 *   action: 'emit'|'delegate-to-legacy',
 *   stopReason?: string,
 *   continue?: boolean,
 *   stateMutations?: object,
 *   suppressOutput?: boolean,
 * }}
 */
export function handlePhaseTransition(ctx = {}) {
  const { cwd, state, config: cfgIn } = ctx;
  if (!state) {
    return { action: 'emit', continue: true, suppressOutput: true };
  }
  const config = cfgIn || loadConfig(cwd) || {};

  // G4 hang detection.
  const hangDet = detectHang(state, Date.now());
  if (hangDet.hung) {
    return {
      action: 'emit',
      continue: true,
      stopReason: hangDet.reason,
      stateMutations: { session_status: 'verification_hang' },
    };
  }
  if (state.session_status === 'verification_hang') {
    return {
      action: 'emit',
      continue: true,
      stopReason: '[MPL G4] Session is currently marked verification_hang. Phase routing is paused until user triage. Run /mpl:mpl-resume to choose: resume current phase, roll back, or cancel.',
    };
  }
  if (state.session_status === 'blocked_hook') {
    const hook = state.blocked_by_hook || 'unknown hook';
    const blockedPhase = state.blocked_phase || state.current_phase || 'unknown phase';
    const instruction = state.resume_instruction || 'Resolve the recorded hook block, then retry the transition.';
    return {
      action: 'emit',
      continue: true,
      stopReason:
        `[MPL] Phase routing is paused by ${hook} for ${blockedPhase}. ` +
        `${instruction} Run /mpl:mpl-resume to continue once the missing evidence is restored.`,
    };
  }

  const phase = state.current_phase;

  switch (phase) {
    case 'mpl-init':
      return {
        action: 'emit',
        continue: true,
        stopReason: '[MPL] Initialization in progress. Complete Triage → Stage 1 (PP Interview) → Stage 2 (Ambiguity Resolution) before Decomposition.',
      };

    case 'mpl-decompose':
    case 'mpl-ambiguity-resolve': {
      // Both reference ambiguity threshold + force-proceed knobs. Reuse a
      // single _ambiguityPhaseDecision helper to avoid drift between cases.
      return _phaseDecomposeAmbiguityDecision(cwd, state, config, phase);
    }

    case 'phase1-plan':
      return {
        action: 'emit',
        continue: true,
        stopReason: '[MPL] Phase 1: Quick Plan in progress. Complete planning and HITL before proceeding.',
      };

    case 'phase1a-research':
      return _phase1aResearchDecision(state);

    case 'phase1b-plan': {
      const reportPath = state.research?.report_path;
      const reportNote = reportPath ? ` Research report: ${reportPath}.` : '';
      return {
        action: 'emit',
        continue: true,
        stopReason: `[MPL] Phase 1-B: Plan Generation in progress.${reportNote} Use research findings as input for planning agents. Complete PLAN.md and HITL before proceeding.`,
      };
    }

    case 'phase4-fix':
      return _phase4FixDecision(cwd, state, config);

    case 'phase5-finalize':
      return _phase5FinalizeDecision(cwd, state);

    case 'small-plan':
    case 'small-sprint':
    case 'small-verify':
      // Delegate to wrapper — small-plan reads goal contract + small-verify
      // touches gate booleans. Pass-A keeps these in the wrapper.
      return { action: 'delegate-to-legacy' };

    case 'phase2-sprint':
    case 'release-gate':
    case 'release-finalize':
    case 'phase3-gate':
      // Heavy file/state side effects (cohort lazy-init, release-manifest,
      // snapshot ref, artifact creation, gate evidence routing). Pass-A
      // keeps these in the wrapper; Pass-B will migrate the file-write side
      // effects into lib/release/.
      return { action: 'delegate-to-legacy' };

    default:
      return { action: 'emit', continue: true, suppressOutput: true };
  }
}

function _ambiguityConfigFromCfg(config) {
  const raw = config?.ambiguity?.threshold;
  const threshold = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0.2;
  const fpRaw = config?.ambiguity?.force_proceed_after_rounds;
  const forceProceedAfterRounds = Number.isInteger(fpRaw) && fpRaw > 0 ? fpRaw : null;
  return { threshold, forceProceedAfterRounds };
}
function _ambiguityRounds(state) {
  const h = state?.ambiguity_history;
  return Array.isArray(h) ? h.length : 0;
}

function _phaseDecomposeAmbiguityDecision(cwd, state, config, phase) {
  const { threshold, forceProceedAfterRounds } = _ambiguityConfigFromCfg(config);
  const ambiguityScore = state.ambiguity_score;
  const hasScore = ambiguityScore !== null && ambiguityScore !== undefined;
  const rounds = _ambiguityRounds(state);
  const forceProceed = state?.ambiguity_force_proceed === true &&
    forceProceedAfterRounds !== null &&
    rounds >= forceProceedAfterRounds;

  if (phase === 'mpl-decompose') {
    if (!hasScore) {
      return {
        action: 'emit',
        continue: true,
        stateMutations: { current_phase: 'mpl-ambiguity-resolve' },
        stopReason:
          '[MPL] ⛔ Decomposition BLOCKED: ambiguity_score not found in state. ' +
          'Reverting to Stage 2 Ambiguity Resolution. ' +
          'Call mpl_score_ambiguity MCP tool with pivot_points + user_responses, then persist the result via mpl_state_write.',
      };
    }
    if (ambiguityScore > threshold) {
      if (forceProceed) {
        return {
          action: 'emit',
          continue: true,
          stopReason: `[MPL] Decomposition: ambiguity_score=${ambiguityScore} exceeds threshold ${threshold}, but force-proceed override active (rounds=${rounds} >= ${forceProceedAfterRounds}). Proceeding with elevated ambiguity.`,
        };
      }
      return {
        action: 'emit',
        continue: true,
        stateMutations: { current_phase: 'mpl-ambiguity-resolve' },
        stopReason:
          `[MPL] ⛔ Decomposition BLOCKED: ambiguity_score=${ambiguityScore} exceeds threshold ${threshold}. ` +
          'Reverting to Stage 2 Ambiguity Resolution for additional Socratic resolution. ' +
          'Re-call mpl_score_ambiguity MCP tool with updated user_responses targeting the weakest dimension.',
      };
    }
    return {
      action: 'emit',
      continue: true,
      stopReason: `[MPL] Decomposition: ambiguity_score=${ambiguityScore} (threshold: <=${threshold}). ✓ Proceed with micro-phase decomposition.`,
    };
  }

  // mpl-ambiguity-resolve
  if (forceProceed && hasScore && ambiguityScore > threshold) {
    return {
      action: 'emit',
      continue: true,
      stateMutations: { current_phase: 'mpl-decompose' },
      stopReason: `[MPL] Ambiguity force-proceed (score=${ambiguityScore}, rounds=${rounds} >= ${forceProceedAfterRounds}). Transitioning to Decomposition.`,
    };
  }
  if (hasScore && ambiguityScore <= threshold) {
    return {
      action: 'emit',
      continue: true,
      stateMutations: { current_phase: 'mpl-decompose' },
      stopReason: `[MPL] Ambiguity resolved: score=${ambiguityScore} (<=${threshold}). Transitioning to Decomposition.`,
    };
  }
  const scoreInfo = hasScore ? ` Current score: ${ambiguityScore}.` : '';
  return {
    action: 'emit',
    continue: true,
    stopReason:
      `[MPL] Stage 2: Ambiguity Resolution in progress.${scoreInfo} Target: <=${threshold}. ` +
      'Drive the Socratic loop inline: call mpl_score_ambiguity MCP tool after each user response and persist via mpl_state_write.',
  };
}

function _phase1aResearchDecision(state) {
  const research = state.research || {};
  if (research.error) {
    return {
      action: 'emit',
      continue: true,
      stateMutations: { current_phase: 'phase1b-plan', research: { status: 'skipped' } },
      stopReason: `[MPL] Research failed: ${research.error}. Skipping to Phase 1-B: Plan Generation (without research).`,
    };
  }
  if (research.status === 'completed' || research.status === 'skipped') {
    const msg = research.status === 'skipped'
      ? '[MPL] Research skipped. Transitioning to Phase 1-B: Plan Generation.'
      : `[MPL] Research completed (${research.stages_completed?.length || 0} stages, ${research.findings_count || 0} findings, ${research.sources_count || 0} sources). Transitioning to Phase 1-B: Plan Generation.`;
    return {
      action: 'emit',
      continue: true,
      stateMutations: { current_phase: 'phase1b-plan' },
      stopReason: msg,
    };
  }
  const currentStage = research.status || 'not started';
  const stagesCompleted = research.stages_completed?.length || 0;
  return {
    action: 'emit',
    continue: true,
    stopReason: `[MPL] Phase 1-A: Deep Research in progress (stage: ${currentStage}, ${stagesCompleted}/3 stages completed). Complete all research stages or skip to proceed.`,
  };
}

function _phase4FixDecision(cwd, state, config) {
  const fixCount = state.fix_loop_count || 0;
  const maxFix = state.max_fix_loops || 10;
  if (fixCount >= maxFix) {
    const block = blockedPhaseTransitionReason(cwd, 'phase5-finalize');
    if (block) return { action: 'emit', continue: true, stopReason: block };
    return {
      action: 'emit',
      continue: true,
      stateMutations: { current_phase: 'phase5-finalize' },
      stopReason: `[MPL] Fix loop limit reached (${fixCount}/${maxFix}). Transitioning to Phase 5: Finalize (partial completion).`,
    };
  }
  const convergenceResult = checkConvergence(state);
  const convergenceCfg = config?.convergence || {};
  const stagnationWindow = Number.isInteger(convergenceCfg.stagnation_window) && convergenceCfg.stagnation_window > 0
    ? convergenceCfg.stagnation_window : 3;
  const autoFinalizeOnStagnation = convergenceCfg.auto_finalize_on_stagnation === true;

  if (convergenceResult.status === 'stagnating' || convergenceResult.status === 'regressing') {
    const prevCount = state.fix_loop?.stagnation_tick_count || 0;
    const newCount = prevCount + 1;
    if (newCount >= stagnationWindow && autoFinalizeOnStagnation) {
      const block = blockedPhaseTransitionReason(cwd, 'phase5-finalize');
      if (block) return { action: 'emit', continue: true, stopReason: block };
      return {
        action: 'emit',
        continue: true,
        stateMutations: {
          current_phase: 'phase5-finalize',
          fix_loop: { ...(state.fix_loop || {}), stagnation_tick_count: newCount },
        },
        stopReason: `[MPL] Convergence ${convergenceResult.status} for ${newCount}/${stagnationWindow} consecutive ticks ` +
          `(delta: ${convergenceResult.delta?.toFixed(3)}; auto_finalize_on_stagnation=true). ` +
          `Transitioning to Phase 5: Finalize (partial completion).`,
      };
    }
    const autoFinalizeNote = autoFinalizeOnStagnation
      ? ` After ${stagnationWindow} consecutive stagnant ticks, this will auto-finalize.`
      : ` Auto-finalize is off (set .mpl/config.json:convergence.auto_finalize_on_stagnation to true to enable). Continue fixing, force-finalize manually, or abort.`;
    return {
      action: 'emit',
      continue: true,
      stateMutations: { fix_loop: { ...(state.fix_loop || {}), stagnation_tick_count: newCount } },
      stopReason: `[MPL #241 B3 / #248] Advisory: convergence ${convergenceResult.status} on tick ${newCount}/${stagnationWindow} ` +
        `(delta: ${convergenceResult.delta?.toFixed(3)}).${autoFinalizeNote}`,
    };
  }
  // Convergence is fine — reset the stagnation counter.
  const stateMutations = (state.fix_loop?.stagnation_tick_count || 0) > 0
    ? { fix_loop: { ...(state.fix_loop || {}), stagnation_tick_count: 0 } }
    : undefined;
  return {
    action: 'emit',
    continue: true,
    stateMutations,
    stopReason: `[MPL] Phase 4: Fix Loop ${fixCount}/${maxFix}. Continue fixing or re-run Quality Gate.`,
  };
}

function _phase5FinalizeDecision(cwd, state) {
  if (state.finalize_done === true) {
    const block = blockedPhaseTransitionReason(cwd, 'completed');
    if (block) return { action: 'emit', continue: true, stopReason: block };
    return {
      action: 'emit',
      continue: false,
      stateMutations: { current_phase: 'completed' },
      stopReason: '[MPL] Phase 5: Finalize complete. MPL pipeline finished.',
    };
  }
  const protocolReminder = '\n\nIMPORTANT: Before proceeding, you MUST read the finalize protocol documents:\n' +
    '1. Read the gate execution protocol (mpl-run-execute-gates or equivalent)\n' +
    '2. Read the finalize protocol (mpl-run-finalize or equivalent)\n' +
    '3. Execute all Hard Gates (H1: Build+Lint+Type, H2: Full Test Suite, H3: Contract Diff Guard)\n' +
    '4. Run project-root-level tests (cargo test --workspace, npx vitest run, pytest, etc.)\n' +
    '5. Check platform-constraints.md violations if it exists in .mpl/mpl/phase0/';
  return {
    action: 'emit',
    continue: true,
    stopReason: '[MPL] Phase 5: Finalize in progress. Extract learnings, commit, then set state.finalize_done = true to complete.' + protocolReminder,
  };
}

// ============================================================================
// Top-level dispatch
// ============================================================================

/**
 * @param {string} event — one of 'finalize' | 'quality' | 'ambiguity' | 'phase_transition'
 * @param {object} ctx
 * @returns {object} per-handler decision envelope
 */
export function handle(event, ctx = {}) {
  switch (event) {
    case 'finalize':         return handleFinalize(ctx);
    case 'quality':          return handleQuality(ctx);
    case 'ambiguity':        return handleAmbiguity(ctx);
    case 'phase_transition': return handlePhaseTransition(ctx);
    default:                 throw new Error(`policy/gates.mjs: unknown event '${event}'`);
  }
}

// Re-export L1 helper that hooks need at the surface so the wrapper hooks
// don't have to duplicate the import.
export { isMplActive };
