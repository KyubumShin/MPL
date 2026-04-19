#!/usr/bin/env node
/**
 * MPL Ambiguity Gate Hook (PreToolUse)
 *
 * Blocks Task(subagent_type="mpl-decomposer") if ambiguity_score is missing
 * or exceeds the threshold (0.2). Forces Stage 2 Ambiguity Resolution
 * (orchestrator drives mpl_score_ambiguity MCP tool loop inline) to
 * complete before decomposition can proceed.
 *
 * Matcher: Task|Agent (same as mpl-validate-output)
 * When ambiguity gate fails: continue=false (blocks the tool call)
 * When gate passes or not relevant: continue=true, suppressOutput=true
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { isMplActive, readState, writeState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);

/**
 * 0.16 Tier A' opt-out: legacy projects can disable the user-contract
 * gate via .mpl/config.json { "user_contract_required": false }. Default true.
 */
function isUserContractRequired(cwd) {
  try {
    const cfgPath = join(cwd, '.mpl', 'config.json');
    if (!existsSync(cfgPath)) return true;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    if (cfg && cfg.user_contract_required === false) return false;
  } catch {
    // fall through
  }
  return true;
}

const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

const AMBIGUITY_THRESHOLD = 0.2;

async function main() {
  const input = await readStdin();

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const cwd = data.cwd || data.directory || process.cwd();

  if (!isMplActive(cwd)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Only intercept Task/Agent calls targeting mpl-decomposer
  const toolName = data.tool_name || '';
  if (toolName !== 'Task' && toolName !== 'Agent') {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const toolInput = data.tool_input || {};
  const subagentType = toolInput.subagent_type || toolInput.subagentType || '';

  if (subagentType !== 'mpl-decomposer' && subagentType !== 'mpl:mpl-decomposer') {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // This IS a decomposer call — check ambiguity gate
  const state = readState(cwd);
  if (!state) {
    console.log(JSON.stringify({
      continue: false,
      reason: '[MPL] ⛔ Decomposer BLOCKED: Cannot read MPL state. Ensure .mpl/state.json exists.'
    }));
    return;
  }

  // 0.16 Tier A': Step 1.5 User Contract Interview must complete before decomposition.
  // Gate is additive to ambiguity score — BOTH must pass. Legacy projects that pre-date
  // 0.16 can opt out via .mpl/config.json { "user_contract_required": false }.
  const contractRequired = isUserContractRequired(cwd);
  const contractSet = state.user_contract_set === true;
  if (contractRequired && !contractSet) {
    writeState(cwd, { current_phase: 'mpl-init' });
    console.log(JSON.stringify({
      continue: false,
      reason: '[MPL] ⛔ Decomposer BLOCKED: user_contract_set is false. ' +
        'Run Phase 0 Step 1.5 first: orchestrator inline loop calling mpl_classify_feature_scope MCP tool ' +
        'to produce .mpl/requirements/user-contract.md, then mpl_state_write({user_contract_set:true}). ' +
        'See commands/mpl-run-phase0.md Step 1.5. ' +
        'To opt out in legacy projects: set user_contract_required=false in .mpl/config.json.'
    }));
    return;
  }

  const score = state.ambiguity_score;
  const hasScore = score !== null && score !== undefined;

  if (!hasScore) {
    // No score — block and revert phase
    writeState(cwd, { current_phase: 'mpl-ambiguity-resolve' });
    console.log(JSON.stringify({
      continue: false,
      reason: '[MPL] ⛔ Decomposer BLOCKED: ambiguity_score not found in state. ' +
        'Run Stage 2 first: call mpl_score_ambiguity MCP tool with pivot_points + user_responses and persist score via mpl_state_write. ' +
        'Phase reverted to mpl-ambiguity-resolve.'
    }));
    return;
  }

  if (score > AMBIGUITY_THRESHOLD) {
    // Score exceeds threshold — block and revert phase
    writeState(cwd, { current_phase: 'mpl-ambiguity-resolve' });
    console.log(JSON.stringify({
      continue: false,
      reason: `[MPL] ⛔ Decomposer BLOCKED: ambiguity_score=${score} exceeds threshold ${AMBIGUITY_THRESHOLD}. ` +
        'Run Stage 2 again: re-call mpl_score_ambiguity MCP tool with updated user_responses targeting the weakest dimension. ' +
        'Phase reverted to mpl-ambiguity-resolve.'
    }));
    return;
  }

  // Gate passed
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
});
