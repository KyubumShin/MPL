#!/usr/bin/env node
/**
 * MPL Require Goal Trace Hook (PreToolUse on Write|Edit|MultiEdit).
 *
 * Blocks `.mpl/mpl/decomposition.yaml` writes when the phase graph no longer
 * proves the frozen Goal Contract: stale/missing goal_contract_hash, uncovered
 * AC/AX ids, unknown ids, or phases with missing/empty `goal_trace`.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

const { isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { loadConfig } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-config.mjs')).href
);
const { readGoalContract, readBaselineGoalContractHash } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-goal-contract.mjs')).href
);
const { parseDecompositionGoalTraceText, validateGoalTraceCoverage, validateMvpGoalTraceCoverage } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-goal-trace.mjs')).href
);
const { parsePhaseContractGraphText } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-phase-contract-graph.mjs')).href
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

export function targetsDecompositionFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  return /(^|\/)\.mpl\/mpl\/decomposition\.ya?ml$/.test(filePath);
}

function collectDecompositionTexts(toolInput) {
  return collectFileWrites(toolInput)
    .filter((entry) => targetsDecompositionFile(entry.filePath) && entry.text)
    .map((entry) => entry.text);
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return ok();

  let data;
  try { data = JSON.parse(raw); } catch { return ok(); }

  const toolName = data.tool_name || data.toolName || '';
  if (!isFileWriteTool(toolName)) return ok();

  const toolInput = data.tool_input || data.toolInput || {};
  const texts = collectDecompositionTexts(toolInput);
  if (texts.length === 0) return ok();

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return ok();

  const cfg = loadConfig(cwd);
  if (cfg.goal_contract_required === false || cfg.goal_trace_required === false) return ok();

  const goal = readGoalContract(cwd);
  if (!goal.exists || !goal.valid) {
    block(`[MPL Goal Trace] Cannot write decomposition.yaml — goal contract missing or invalid: ${goal.missing.join(', ')}.`);
    return;
  }

  const baseline = readBaselineGoalContractHash(cwd);
  if (baseline.hash && baseline.hash !== goal.contract.content_sha256) {
    block(
      `[MPL Goal Trace] Cannot write decomposition.yaml — .mpl/goal-contract.yaml drifted from baseline.yaml ` +
        `(baseline=${baseline.hash.slice(0, 12)}, current=${goal.contract.content_sha256.slice(0, 12)}). ` +
        `Re-run Phase 0 renewal before recomposing.`
    );
    return;
  }

  const issues = [];
  for (const text of texts) {
    const decomposition = parseDecompositionGoalTraceText(text);
    const verdict = validateGoalTraceCoverage(decomposition, goal.contract);
    issues.push(...verdict.issues);

    // Stage A RFC §4.2 (post-Stage-A audit fix #2): when goal_contract
    // declares an MVP cohort, also enforce that the union of goal_trace
    // over `graph.mvp.phases[]` covers every AC/AX in
    // `goal_contract.mvp_scope`. The whole-pipeline validator above
    // catches "no phase covers AC-N anywhere"; this catches "AC-N is
    // covered by some non-MVP phase but no MVP phase, so the MVP cohort
    // manifest would assert coverage it does not actually deliver".
    // Skips silently when no mvp_scope is declared.
    if (goal.contract?.mvp_scope) {
      const graph = parsePhaseContractGraphText(text);
      const mvpVerdict = validateMvpGoalTraceCoverage(decomposition, goal.contract, graph);
      issues.push(...mvpVerdict.issues);
    }
  }

  if (issues.length > 0) {
    const shown = issues.slice(0, 12).join(', ');
    const more = issues.length > 12 ? ` (+${issues.length - 12} more)` : '';
    block(
      `[MPL Goal Trace] decomposition.yaml does not cover the frozen Goal Contract: ${shown}${more}. ` +
        `Each phase needs goal_trace and the graph must cover every AC/AX from .mpl/goal-contract.yaml ` +
        `(including the MVP subset when mvp_scope is declared).`
    );
    return;
  }

  ok();
}

if (isMain) {
  await main().catch(() => ok());
}
