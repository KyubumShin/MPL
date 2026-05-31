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
const { recordBlockedHook, clearBlockedHook } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-blocked-hook.mjs')).href
);

const HOOK_ID = 'mpl-require-goal-trace';
const BLOCKED_ARTIFACT = '.mpl/mpl/decomposition.yaml';

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function block(reason) {
  console.log(JSON.stringify({ continue: false, decision: 'block', reason }));
}

function recordGoalTraceBlock(cwd, { code, reason, resumeInstruction, retryContext = {} }) {
  recordBlockedHook(cwd, {
    hookId: HOOK_ID,
    artifact: BLOCKED_ARTIFACT,
    code,
    reason,
    resumeInstruction,
    retryContext: {
      target: BLOCKED_ARTIFACT,
      goal_contract_path: '.mpl/goal-contract.yaml',
      ...retryContext,
    },
  });
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
  if (cfg.goal_contract_required === false || cfg.goal_trace_required === false) {
    clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
    return ok();
  }

  const goal = readGoalContract(cwd);
  if (!goal.exists || !goal.valid) {
    const reason = `[MPL Goal Trace] Cannot write decomposition.yaml — goal contract missing or invalid: ${goal.missing.join(', ')}.`;
    recordGoalTraceBlock(cwd, {
      code: 'goal_contract_invalid',
      reason,
      resumeInstruction: 'Restore a valid .mpl/goal-contract.yaml, then retry the decomposition write.',
      retryContext: { missing: goal.missing },
    });
    block(reason);
    return;
  }

  const baseline = readBaselineGoalContractHash(cwd);
  if (baseline.error) {
    const reason =
      `[MPL Goal Trace] Cannot write decomposition.yaml — corrupt baseline.yaml goal_contract sha256 ` +
        `(${baseline.error}${baseline.rawHash ? `: ${baseline.rawHash}` : ''}). ` +
        `Expected the 64-character lowercase normalized SHA-256 for .mpl/goal-contract.yaml. ` +
        `Raw shasum may differ because MPL normalizes CRLF to LF and trims surrounding whitespace before hashing. ` +
        `Re-run Phase 0 renewal before recomposing.`;
    recordGoalTraceBlock(cwd, {
      code: 'goal_contract_baseline_corrupt',
      reason,
      resumeInstruction: 'Re-run Phase 0 renewal so baseline.yaml records a valid goal_contract sha256, then retry decomposition.',
      retryContext: { baseline_error: baseline.error, raw_hash: baseline.rawHash || null },
    });
    block(reason);
    return;
  }
  if (baseline.hash && baseline.hash !== goal.contract.content_sha256) {
    const reason =
      `[MPL Goal Trace] Cannot write decomposition.yaml — .mpl/goal-contract.yaml drifted from baseline.yaml ` +
        `(baseline=${baseline.hash}, current=${goal.contract.content_sha256}). ` +
        `These are MPL normalized hashes; raw shasum may differ because MPL normalizes CRLF to LF and trims surrounding whitespace. ` +
        `Re-run Phase 0 renewal before recomposing.`;
    recordGoalTraceBlock(cwd, {
      code: 'goal_contract_drift',
      reason,
      resumeInstruction: 'Resolve the Goal Contract drift via Phase 0 renewal before recomposing decomposition.yaml.',
      retryContext: { baseline_hash: baseline.hash, current_hash: goal.contract.content_sha256 },
    });
    block(reason);
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
    const reason =
      `[MPL Goal Trace] decomposition.yaml does not cover the frozen Goal Contract: ${shown}${more}. ` +
        `Each phase needs goal_trace and the graph must cover every AC/AX from .mpl/goal-contract.yaml ` +
        `(including the MVP subset when mvp_scope is declared).`;
    recordGoalTraceBlock(cwd, {
      code: 'goal_trace_incomplete',
      reason,
      resumeInstruction: 'Add or fix per-phase goal_trace coverage for every required AC/AX, including MVP subset coverage when declared, then retry decomposition.',
      retryContext: { issue_count: issues.length, issues: issues.slice(0, 20) },
    });
    block(reason);
    return;
  }

  clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
  ok();
}

if (isMain) {
  await main().catch(() => ok());
}
