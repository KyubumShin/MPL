#!/usr/bin/env node
/**
 * MPL Validate PP Schema Hook (PreToolUse on Write|Edit|MultiEdit)
 *
 * Thin stdin/stdout shim over
 * `hooks/lib/policy/schemas.mjs::handlePivotPointsSchema` (Move #11). The
 * policy module owns the UC-leakage denylist; this wrapper preserves the
 * legacy block-surface I/O (emitBlockedHook / emitClearedOk) and the symbol
 * exports the existing tests assert against:
 *   - targetsPivotPointsFile
 *   - extractProposedContent
 *   - detectUcLeakage
 *   - formatBlockReason
 *
 * Original implementation: hooks/mpl-validate-pp-schema.legacy.mjs
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

const {
  handle: schemasHandle,
  targetsPivotPointsFile,
  extractProposedContent,
  detectUcLeakage,
  formatPivotPointsBlockReason,
  formatBlockReason,
  UC_SCHEMA_PATTERNS,
  PIVOT_POINTS_BLOCKED_ARTIFACT,
} = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'schemas.mjs')).href
);

const { readState, isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { collectFileWrites, isFileWriteTool } = await import(
  pathToFileURL(join(__dirname, 'lib', 'tool-input.mjs')).href
);

const HOOK_ID = 'mpl-validate-pp-schema';
const BLOCKED_ARTIFACT = PIVOT_POINTS_BLOCKED_ARTIFACT;

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

async function runHook(stdinPayload) {
  if (!stdinPayload) { ok(); return; }

  let input;
  try {
    input = JSON.parse(stdinPayload);
  } catch {
    ok();
    return;
  }

  const toolName = input.tool_name || input.toolName || '';
  const toolInput = input.tool_input || input.toolInput || {};
  const cwd = input.cwd || input.directory || process.cwd();
  const mplActive = isMplActive(cwd);

  const decision = schemasHandle('pivot_points_schema', {
    toolName,
    toolInput,
    cwd,
    mplActive,
  });

  if (decision.action === 'noop') {
    ok();
    return;
  }

  const { emitBlockedHook, emitClearedOk } = await import(
    pathToFileURL(join(__dirname, 'lib', 'mpl-block-surface.mjs')).href
  );

  if (decision.action === 'allow') {
    if (mplActive) {
      emitClearedOk(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
    } else {
      ok();
    }
    return;
  }

  // block
  if (!mplActive) {
    // Pre-MPL workspaces — preserve original legacy stdout shape.
    console.log(JSON.stringify({
      continue: false,
      decision: 'block',
      reason: decision.reason,
    }));
    return;
  }

  const state = readState(cwd) || {};
  emitBlockedHook(cwd, state, {
    hookId: HOOK_ID,
    ruleId: decision.ruleId || 'pp_schema_invalid',
    code: decision.code || 'pp_schema_uc_leakage',
    artifact: decision.artifact || BLOCKED_ARTIFACT,
    reason: decision.reason,
    resumeInstruction: decision.resumeInstruction,
    retryContext: decision.retryContext || {},
  });
}

if (isMain) {
  const { readStdin } = await import(
    pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
  );
  try {
    const raw = await readStdin();
    await runHook(raw);
  } catch {
    ok();
  }
}

// Re-export legacy symbols so the existing tests keep passing.
export {
  targetsPivotPointsFile,
  extractProposedContent,
  detectUcLeakage,
  formatPivotPointsBlockReason,
  formatBlockReason,
  UC_SCHEMA_PATTERNS,
  HOOK_ID,
  BLOCKED_ARTIFACT,
};
