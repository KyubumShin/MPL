#!/usr/bin/env node
/**
 * MPL Require Whole Goal Closure Hook (PreToolUse Write|Edit|MultiEdit).
 *
 * Blocks `finalize_done=true` unless every decomposition phase is completed and
 * completed phase evidence covers every Goal Contract AC/AX id.
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
const { readGoalContract } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-goal-contract.mjs')).href
);
const { validateWholeGoalClosure } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-whole-goal-closure.mjs')).href
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

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return ok();

  let data;
  try { data = JSON.parse(raw); } catch { return ok(); }

  const toolName = data.tool_name || data.toolName || '';
  if (!isFileWriteTool(toolName)) return ok();

  const toolInput = data.tool_input || data.toolInput || {};
  if (!isFinalizeDoneStateWrite(toolInput)) return ok();

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return ok();

  const cfg = loadConfig(cwd);
  if (cfg.whole_goal_closure_required === false) {
    // Codex r1 on PR #246: explicit config opt-out clears stale envelope.
    emitClearedOk(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
    return;
  }

  const goal = readGoalContract(cwd);
  const state = readState(cwd) || {};
  if (cfg.goal_contract_required !== false && (!goal.exists || !goal.valid)) {
    emitBlockedHook(cwd, state, {
      hookId: HOOK_ID,
      ruleId: 'missing_whole_goal_closure',
      code: 'goal_contract_invalid',
      artifact: BLOCKED_ARTIFACT,
      reason: `[MPL Whole Goal Closure] Cannot set finalize_done=true — goal contract missing or invalid: ${goal.missing.join(', ')}.`,
      resumeInstruction:
        'Restore a valid .mpl/goal-contract.yaml (Phase 0 renewal) before re-attempting finalize.',
      retryContext: { missing: goal.missing },
    });
    return;
  }

  const verdict = validateWholeGoalClosure({
    cwd,
    state,
    contract: goal.valid ? goal.contract : null,
  });

  if (!verdict.valid) {
    const shown = verdict.issues.slice(0, 12).join(', ');
    const more = verdict.issues.length > 12 ? ` (+${verdict.issues.length - 12} more)` : '';
    emitBlockedHook(cwd, state, {
      hookId: HOOK_ID,
      ruleId: 'missing_whole_goal_closure',
      code: 'whole_goal_closure_missing',
      artifact: BLOCKED_ARTIFACT,
      reason:
        `[MPL Whole Goal Closure] Cannot set finalize_done=true — completed phase evidence does not close the Goal Contract: ` +
        `${shown}${more}. Complete every decomposition phase and ensure verification.md Evidence Latch covers all AC/AX ids.`,
      resumeInstruction:
        'Complete every decomposition phase and latch every Goal Contract AC/AX id in verification.md Evidence Latch sections, then retry finalize.',
      retryContext: { issues: verdict.issues.slice(0, 50) },
    });
    return;
  }

  emitClearedOk(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
}

if (isMain) {
  await main().catch(() => ok());
}
