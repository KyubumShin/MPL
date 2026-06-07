#!/usr/bin/env node
/**
 * #239 C2 / #251 — `reviewer_required: false` requires a non-empty
 * `reviewer_rationale` on the same phase.
 *
 * Wrapper (Move #8, Phase B): the structural decision now lives in
 * `hooks/lib/policy/contracts.mjs` (`handleReviewer`). This file:
 *   - parses stdin (Claude Code hook payload)
 *   - applies the same `isMplActive` / config / write-tool gates as
 *     before (so non-MPL workspaces and unrelated tools are no-ops)
 *   - delegates the offender detection to `handleReviewer`
 *   - translates the policy envelope back to the legacy stdout shape
 *     that Claude Code and the test suite consume
 *
 * The original implementation is preserved at
 * `mpl-require-reviewer.legacy.mjs` for emergency rollback AND so the
 * test suite can keep importing `findReviewerRationaleGaps` from this
 * module's public surface (re-exported below).
 *
 * **PostToolUse** on Edit|Write|MultiEdit. Reads the post-write
 * decomposition.yaml from disk (disk is authoritative for
 * PostToolUse); Edit/MultiEdit deliver only patch fragments in
 * `tool_input` so the pre-edit text alone is insufficient.
 *
 * Telemetry: when the skip is legitimate (rationale non-empty), the
 * executor's Step 12 emits a `reviewer-skipped` record to
 * `.mpl/mpl/quality-signals.jsonl` (#238). This hook does not emit
 * telemetry — it only enforces the rationale shape so the skip path
 * is not silently abused.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

const { isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { isFileWriteTool } = await import(
  pathToFileURL(join(__dirname, 'lib', 'tool-input.mjs')).href
);
const { loadConfig } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-config.mjs')).href
);
const { handleReviewer } = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'contracts.mjs')).href
);

// Re-export the parser used by the C2 unit tests
// (hooks/__tests__/mpl-issue-251-c2c3c6-runtime.test.mjs imports it
// from `../mpl-require-reviewer.mjs`). The implementation lives in
// the preserved legacy file so the wrapper stays a thin shim.
export { findReviewerRationaleGaps } from './mpl-require-reviewer.legacy.mjs';

function silent() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function block(reason) {
  console.log(
    JSON.stringify({
      continue: false,
      decision: 'block',
      reason,
    }),
  );
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) {
    silent();
    return;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    silent();
    return;
  }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) {
    silent();
    return;
  }

  const toolName = data.tool_name || data.toolName || '';
  if (!isFileWriteTool(toolName)) {
    silent();
    return;
  }

  const toolInput = data.tool_input || data.toolInput || {};
  const hookEvent = data.hook_event_name || data.hookEvent || 'PostToolUse';
  const state = data.state || {};
  let config;
  try {
    config = loadConfig(cwd);
  } catch {
    config = {};
  }

  let decision;
  try {
    decision = await handleReviewer({
      cwd,
      state,
      config,
      toolName,
      toolInput,
      hookEvent,
      raw: data,
    });
  } catch {
    // Fail-soft: policy errors must never break the pipeline.
    silent();
    return;
  }

  if (!decision || decision.action !== 'block') {
    silent();
    return;
  }
  block(String(decision.reason || 'Reviewer rationale contract violation.'));
}

if (isMain) {
  main().catch(() => {
    // Fail-soft: never break the pipeline on hook IO error.
    silent();
  });
}
