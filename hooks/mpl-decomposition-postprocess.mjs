#!/usr/bin/env node
/**
 * MPL Decomposition Postprocess Hook (PostToolUse on Edit|Write|MultiEdit).
 *
 * Regenerates `.mpl/mpl/decomposition-derived.json` immediately after any
 * source artifact for derived risk checks, invariants, or MVP membership
 * changes so the command protocol cannot silently keep stale derived data.
 */

import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { collectTargetPaths, isFileWriteTool } = await import(
  pathToFileURL(join(__dirname, 'lib', 'tool-input.mjs')).href
);
const { writeDerivedDecompositionFields, writeTestAgentBriefs } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-decomposition-postprocess.mjs')).href
);
const { recordBlockedHook, clearBlockedHook } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-blocked-hook.mjs')).href
);

const HOOK_ID = 'mpl-decomposition-postprocess';
const BLOCKED_ARTIFACT = '.mpl/mpl/decomposition-derived.json';
const DECOMPOSITION_PATH = '.mpl/mpl/decomposition.yaml';
const DERIVED_SOURCE_KINDS = new Map([
  [DECOMPOSITION_PATH, 'decomposition'],
  ['.mpl/mpl/phase0/design-intent.yaml', 'design_intent'],
  ['.mpl/goal-contract.yaml', 'goal_contract'],
]);

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function block(cwd, reason, retryContext = {}) {
  recordBlockedHook(cwd, {
    hookId: HOOK_ID,
    artifact: BLOCKED_ARTIFACT,
    code: 'decomposition_derived_stale',
    reason,
    resumeInstruction:
      'Fix the changed derived source artifact if needed, then rewrite it or run the deterministic decomposition postprocess before continuing.',
    retryContext: {
      target: DECOMPOSITION_PATH,
      derived_path: BLOCKED_ARTIFACT,
      ...retryContext,
    },
  });
  console.log(JSON.stringify({ continue: false, decision: 'block', reason }));
}

function workspaceRel(cwd, filePath) {
  const cwdAbs = resolve(cwd);
  const abs = resolve(cwd, filePath);
  return abs.startsWith(cwdAbs + '/') ? abs.slice(cwdAbs.length + 1) : filePath;
}

function derivedSourceKind(filePath, cwd) {
  const rel = workspaceRel(cwd, filePath);
  return DERIVED_SOURCE_KINDS.get(rel) || null;
}

function decompositionExists(cwd) {
  return existsSync(join(cwd, '.mpl', 'mpl', 'decomposition.yaml'));
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

  const toolInput = data.tool_input || data.toolInput || {};
  const targets = collectTargetPaths(toolInput)
    .map((path) => ({ path, kind: derivedSourceKind(path, cwd) }))
    .filter((target) => target.kind);
  if (targets.length === 0) return ok();
  if (!targets.some((target) => target.kind === 'decomposition') && !decompositionExists(cwd)) {
    return ok();
  }

  try {
    writeDerivedDecompositionFields(cwd);
    // #225: also derive per-phase test-agent briefs from decomposition.
    // Best-effort — brief-writing errors should not block decomposition
    // derivation. If decomposition shape is malformed, the existing
    // require-test-agent-brief gate surfaces it on dispatch.
    if (targets.some((t) => t.kind === 'decomposition')) {
      try { writeTestAgentBriefs(cwd); } catch { /* swallow */ }
    }
    clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
    return ok();
  } catch (error) {
    return block(
      cwd,
      `[MPL Decomposition Postprocess] Failed to regenerate ${BLOCKED_ARTIFACT}: ${error?.message || 'unknown error'}.`,
      { error: error?.message || 'unknown error', targets }
    );
  }
}

await main().catch((error) => {
  const cwd = process.cwd();
  block(
    cwd,
    `[MPL Decomposition Postprocess] Hook crashed before derived fields could be regenerated: ${error?.message || 'unknown error'}.`,
    { error: error?.message || 'unknown error' }
  );
});
