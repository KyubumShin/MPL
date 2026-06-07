#!/usr/bin/env node
/**
 * MPL Require Whole Goal Closure Hook — thin wrapper over
 * `hooks/lib/policy/contracts.mjs::handleWholeGoalClosure`.
 *
 * The structural allow/block decision (every decomposition phase
 * completed + completed-phase evidence closes every Goal Contract
 * AC/AX id) is delegated to the policy module. This wrapper:
 *   1. Performs the legacy stdin parse + isMplActive guard so off-
 *      workspace / non-finalize writes silently pass without
 *      touching state.
 *   2. Loads workspace config via the same loader the legacy hook used.
 *   3. Calls `handleWholeGoalClosure` with the policy context.
 *   4. Translates the policy decision envelope back to the legacy
 *      stdout contract (continue/block + reason + blocked_hook
 *      envelope via `emitBlockedHook` / `emitClearedOk`) so callers
 *      (Claude Code surface + the test suite) keep their contract.
 *
 * The policy module's `reason` and `resumeInstruction` are deliberately
 * generic. This wrapper re-renders the legacy operator-facing copy
 * (`Cannot set finalize_done=true — …` prefix + `Complete every
 * decomposition phase and ensure verification.md Evidence Latch covers
 * all AC/AX ids.` suffix) from the policy's `retryContext` so the
 * user-visible message is unchanged.
 *
 * For emergency rollback the original implementation lives at
 *   hooks/mpl-require-whole-goal-closure.legacy.mjs
 *
 * Non-blocking on any error.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

const { isMplActive, readState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { loadConfig } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-config.mjs')).href
);
const { collectFileWrites, isFileWriteTool } = await import(
  pathToFileURL(join(__dirname, 'lib', 'tool-input.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { emitBlockedHook, emitClearedOk } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-block-surface.mjs')).href
);
const { handleWholeGoalClosure } = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'contracts.mjs')).href
);

const HOOK_ID = 'mpl-require-whole-goal-closure';
const BLOCKED_ARTIFACT = '.mpl/state.json#finalize_done';

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function isFinalizeDoneStateWrite(toolInput) {
  const writes = collectFileWrites(toolInput);
  return writes.some((entry) =>
    /(^|\/)\.mpl\/state\.json$/.test(entry.filePath || '') &&
    /"finalize_done"\s*:\s*true/.test(entry.text || '')
  );
}

/**
 * Re-render the legacy operator-facing reason from the policy's
 * `code` + `retryContext`. The policy's stock reason is shorter than
 * the legacy contract; this brings back the `Cannot set
 * finalize_done=true — …` framing the test suite + recover skill
 * expect.
 */
function renderLegacyReason(decision) {
  const code = decision?.code;
  const ctx = decision?.retryContext || {};
  if (code === 'goal_contract_invalid') {
    const missing = Array.isArray(ctx.missing) ? ctx.missing.join(', ') : '';
    return `[MPL Whole Goal Closure] Cannot set finalize_done=true — goal contract missing or invalid: ${missing}.`;
  }
  const issues = Array.isArray(ctx.issues) ? ctx.issues : [];
  const shown = issues.slice(0, 12).join(', ');
  const more = issues.length > 12 ? ` (+${issues.length - 12} more)` : '';
  return (
    `[MPL Whole Goal Closure] Cannot set finalize_done=true — completed phase evidence does not close the Goal Contract: ` +
    `${shown}${more}. Complete every decomposition phase and ensure verification.md Evidence Latch covers all AC/AX ids.`
  );
}

function renderLegacyResume(decision) {
  if (decision?.code === 'goal_contract_invalid') {
    return 'Restore a valid .mpl/goal-contract.yaml (Phase 0 renewal) before re-attempting finalize.';
  }
  return 'Complete every decomposition phase and latch every Goal Contract AC/AX id in verification.md Evidence Latch sections, then retry finalize.';
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return ok();

  let data;
  try { data = JSON.parse(raw); } catch { return ok(); }

  const toolName = data.tool_name || data.toolName || '';
  if (!isFileWriteTool(toolName)) return ok();

  const toolInput = data.tool_input || data.toolInput || {};
  // Cheap guard: only this hook's structural concern (finalize_done=true
  // on .mpl/state.json) matters. Skip the policy call otherwise so
  // unrelated writes don't even pay the import cost.
  if (!isFinalizeDoneStateWrite(toolInput)) return ok();

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return ok();

  const config = loadConfig(cwd);
  const state = readState(cwd) || {};

  const decision = await handleWholeGoalClosure({
    cwd,
    toolName,
    toolInput,
    state,
    config,
    hookEvent: data.hook_event_name || 'PreToolUse',
  });

  if (!decision || decision.action === 'allow') {
    emitClearedOk(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
    return;
  }

  emitBlockedHook(cwd, state, {
    hookId: HOOK_ID,
    ruleId: decision.ruleId || 'missing_whole_goal_closure',
    code: decision.code || 'whole_goal_closure_missing',
    artifact: decision.artifact || BLOCKED_ARTIFACT,
    reason: renderLegacyReason(decision),
    resumeInstruction: renderLegacyResume(decision),
    retryContext: decision.retryContext || {},
  });
}

if (isMain) {
  await main().catch(() => ok());
}
