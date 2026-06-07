#!/usr/bin/env node
/**
 * MPL Require Decomposition Delta Hook (PreToolUse on Write|Edit|MultiEdit).
 *
 * Thin wrapper around the SSOT policy `handleDecompositionDelta` in
 * `hooks/lib/policy/contracts.mjs`. Existing decomposition graphs may only
 * change through a recomposition delta: write
 * `.mpl/mpl/decomposition-deltas/recompose-N.yaml`, then write the full updated
 * `.mpl/mpl/decomposition.yaml` with `recompose_count: N`.
 *
 * Original imperative implementation preserved at
 * `mpl-require-decomposition-delta.legacy.mjs` for emergency rollback.
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
const { isFileWriteTool } = await import(
  pathToFileURL(join(__dirname, 'lib', 'tool-input.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { emitBlockedHook, emitClearedOk } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-block-surface.mjs')).href
);
const { handleDecompositionDelta } = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'contracts.mjs')).href
);

const HOOK_ID = 'mpl-require-decomposition-delta';
const BLOCKED_ARTIFACT = '.mpl/mpl/decomposition-deltas/';

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

// Path-shape predicates kept exported for backwards-compatible imports.
export function targetsDecompositionFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  return /(^|\/)\.mpl\/mpl\/decomposition\.ya?ml$/.test(filePath);
}

export function targetsDecompositionDeltaFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  return /(^|\/)\.mpl\/mpl\/decomposition-delta\.ya?ml$/.test(filePath) ||
    /(^|\/)\.mpl\/mpl\/decomposition-deltas\/[^/]+\.ya?ml$/.test(filePath);
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return ok();

  let data;
  try { data = JSON.parse(raw); } catch { return ok(); }

  const toolName = data.tool_name || data.toolName || '';
  if (!isFileWriteTool(toolName)) return ok();

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return ok();

  const cfg = loadConfig(cwd);
  const toolInput = data.tool_input || data.toolInput || {};
  const state = readState(cwd) || {};

  // Delegate the structural decision to the SSOT policy.
  const decision = await handleDecompositionDelta({
    cwd,
    state,
    config: cfg,
    toolName,
    toolInput,
    hookEvent: data.hook_event_name || data.hookEvent || 'PreToolUse',
  });

  // Translate the policy envelope back to the legacy stdout contract.
  if (decision.action === 'allow') {
    emitClearedOk(cwd, {
      hookId: HOOK_ID,
      artifact: decision.artifact || BLOCKED_ARTIFACT,
    });
    return;
  }

  emitBlockedHook(cwd, state, {
    hookId: HOOK_ID,
    ruleId: decision.ruleId || 'missing_decomposition_delta',
    code: decision.code || 'decomposition_delta_missing',
    artifact: decision.artifact || BLOCKED_ARTIFACT,
    reason: decision.reason,
    resumeInstruction: decision.resumeInstruction,
    retryContext: decision.retryContext || {},
  });
}

if (isMain) {
  await main().catch(() => ok());
}
