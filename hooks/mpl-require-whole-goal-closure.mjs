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

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function block(reason) {
  console.log(JSON.stringify({ continue: false, decision: 'block', reason }));
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
  if (cfg.whole_goal_closure_required === false) return ok();

  const goal = readGoalContract(cwd);
  if (cfg.goal_contract_required !== false && (!goal.exists || !goal.valid)) {
    block(`[MPL Whole Goal Closure] Cannot set finalize_done=true — goal contract missing or invalid: ${goal.missing.join(', ')}.`);
    return;
  }

  const state = readState(cwd) || {};
  const verdict = validateWholeGoalClosure({
    cwd,
    state,
    contract: goal.valid ? goal.contract : null,
  });

  if (!verdict.valid) {
    const shown = verdict.issues.slice(0, 12).join(', ');
    const more = verdict.issues.length > 12 ? ` (+${verdict.issues.length - 12} more)` : '';
    block(
      `[MPL Whole Goal Closure] Cannot set finalize_done=true — completed phase evidence does not close the Goal Contract: ` +
        `${shown}${more}. Complete every decomposition phase and ensure verification.md Evidence Latch covers all AC/AX ids.`
    );
    return;
  }

  ok();
}

if (isMain) {
  await main().catch(() => ok());
}
