#!/usr/bin/env node
/**
 * MPL Require Phase Contract Graph Hook (PreToolUse on Write|Edit|MultiEdit).
 *
 * Thin wrapper around `lib/policy/contracts.mjs#handlePhaseContractGraph`.
 * The policy module owns the structural decision; this wrapper:
 *   1. Parses stdin / gates on isMplActive + file-write tools + decomposition.yaml writes.
 *   2. Hydrates `state` from `.mpl/state.json` so the policy's released-cut
 *      immutability check can use `state.release.completed_cut_ids` (the
 *      legacy hook read this directly from disk).
 *   3. Translates the policy decision envelope back to the legacy stdout
 *      shape `{continue, suppressOutput}` or `{continue: false, decision: 'block', reason}`.
 *   4. Preserves the original recordBlockedHook / clearBlockedHook signal
 *      emissions (the test suite asserts on .mpl/state.json side effects).
 *
 * The previous monolithic implementation lives at
 * `mpl-require-phase-contract-graph.legacy.mjs` for emergency rollback.
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
const { recordBlockedHook, clearBlockedHook } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-blocked-hook.mjs')).href
);
const { handlePhaseContractGraph } = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'contracts.mjs')).href
);

const HOOK_ID = 'mpl-require-phase-contract-graph';
const BLOCKED_ARTIFACT = '.mpl/mpl/decomposition.yaml';

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

function hasDecompositionWrite(toolInput) {
  return collectFileWrites(toolInput)
    .some((entry) => targetsDecompositionFile(entry.filePath) && entry.text);
}

/**
 * Normalize MultiEdit toolInput so the policy module's inline parser sees
 * the (file_path, new_string) pair on every edit entry. The L2 policy
 * module's `collectDecompositionTexts` requires both fields on the SAME
 * object; the live Claude Code MultiEdit shape carries `file_path` only at
 * the top level. Without this adapter, MultiEdit writes silently bypass
 * the decomposition-graph check (legacy behavior would block them).
 */
function normalizeToolInputForPolicy(toolInput) {
  if (!toolInput || !Array.isArray(toolInput.edits)) return toolInput;
  const topPath = toolInput.file_path || toolInput.filePath;
  if (!topPath) return toolInput;
  const edits = toolInput.edits.map((e) => {
    if (!e || typeof e !== 'object') return e;
    if (e.file_path || e.filePath) return e;
    return { ...e, file_path: topPath };
  });
  return { ...toolInput, edits };
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return ok();

  let data;
  try { data = JSON.parse(raw); } catch { return ok(); }

  const toolName = data.tool_name || data.toolName || '';
  if (!isFileWriteTool(toolName)) return ok();

  const toolInput = data.tool_input || data.toolInput || {};
  if (!hasDecompositionWrite(toolInput)) return ok();

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return ok();

  const config = loadConfig(cwd);

  // Hydrate state so the policy module's released-cut immutability check
  // sees the same `state.release.completed_cut_ids` the legacy hook read
  // straight from disk.
  let state = {};
  try { state = readState(cwd) || {}; } catch { state = {}; }

  const decision = await handlePhaseContractGraph({
    cwd,
    state,
    config,
    toolName,
    toolInput: normalizeToolInputForPolicy(toolInput),
    hookEvent: data.hook_event_name || data.hookEvent || 'PreToolUse',
  });

  if (decision.action === 'block') {
    const reason = decision.reason || 'phase contract graph invalid';
    // Augment retryContext with `target` for legacy parity. Policy emits
    // {issue_count, issues}; the legacy hook also included {target}.
    const retryContext = {
      target: decision.artifact || BLOCKED_ARTIFACT,
      ...(decision.retryContext || {}),
    };
    recordBlockedHook(cwd, {
      hookId: HOOK_ID,
      artifact: decision.artifact || BLOCKED_ARTIFACT,
      code: decision.code || 'phase_contract_graph_invalid',
      reason,
      resumeInstruction:
        decision.resumeInstruction ||
        'Re-emit decomposition.yaml as a valid phase contract graph with metadata, execution tiers, per-phase policies, valid dependencies, and preserved released-cut memberships.',
      retryContext,
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
