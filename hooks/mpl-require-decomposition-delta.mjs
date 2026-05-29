#!/usr/bin/env node
/**
 * MPL Require Decomposition Delta Hook (PreToolUse on Write|Edit|MultiEdit).
 *
 * Existing decomposition graphs may only change through a recomposition delta:
 * write `.mpl/mpl/decomposition-deltas/recompose-N.yaml`, then write the full
 * updated `.mpl/mpl/decomposition.yaml` with `recompose_count: N`.
 */

import { existsSync, readFileSync } from 'fs';
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
const { parsePhaseContractGraphText } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-phase-contract-graph.mjs')).href
);
const {
  findMatchingDecompositionDelta,
  parseDecompositionDeltaText,
  parseRecomposeCount,
  targetCountFromDeltaPath,
  validateDecompositionDelta,
} = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-decomposition-delta.mjs')).href
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
const { readState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);

const HOOK_ID = 'mpl-require-decomposition-delta';
const BLOCKED_ARTIFACT = '.mpl/mpl/decomposition-deltas/';

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function isFullWriteTool(toolName) {
  return ['Write', 'write'].includes(String(toolName || ''));
}

export function targetsDecompositionFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  return /(^|\/)\.mpl\/mpl\/decomposition\.ya?ml$/.test(filePath);
}

export function targetsDecompositionDeltaFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  return /(^|\/)\.mpl\/mpl\/decomposition-delta\.ya?ml$/.test(filePath) ||
    /(^|\/)\.mpl\/mpl\/decomposition-deltas\/[^/]+\.ya?ml$/.test(filePath);
}

function currentDecompositionPath(cwd) {
  return join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
}

function recomposeCountFromText(text) {
  const graph = parsePhaseContractGraphText(text);
  return parseRecomposeCount(graph.recompose_count);
}

function validateDeltaWrite(cwd, filePath, text, toolName) {
  const issues = [];
  if (!isFullWriteTool(toolName)) {
    issues.push('delta_write:partial_edit_not_allowed');
  }
  if (!text || !String(text).trim()) {
    issues.push('delta_write:empty');
    return issues;
  }

  const existingPath = currentDecompositionPath(cwd);
  if (!existsSync(existingPath)) {
    issues.push('decomposition:missing_for_delta');
    return issues;
  }

  const baseCount = recomposeCountFromText(readFileSync(existingPath, 'utf-8'));
  if (!Number.isInteger(baseCount)) {
    issues.push('decomposition:recompose_count:missing');
    return issues;
  }

  const pathTarget = targetCountFromDeltaPath(filePath);
  const delta = parseDecompositionDeltaText(text);
  const verdict = validateDecompositionDelta(delta, {
    expectedBase: baseCount,
    expectedTarget: baseCount + 1,
    ...(pathTarget === null ? {} : { expectedPathTarget: pathTarget }),
  });
  issues.push(...verdict.issues);
  return issues;
}

function validateDecompositionWrite(cwd, text, toolName) {
  const issues = [];
  const existingPath = currentDecompositionPath(cwd);
  if (!existsSync(existingPath)) return issues;

  const oldText = readFileSync(existingPath, 'utf-8');
  if (text && String(text).trim() === oldText.trim()) return issues;

  if (!isFullWriteTool(toolName)) {
    issues.push('decomposition:partial_edit_not_allowed');
    return issues;
  }
  if (!text || !String(text).trim()) {
    issues.push('decomposition:empty_write');
    return issues;
  }

  const oldCount = recomposeCountFromText(oldText);
  const newCount = recomposeCountFromText(text);
  if (!Number.isInteger(oldCount)) issues.push('decomposition:old_recompose_count:missing');
  if (!Number.isInteger(newCount)) issues.push('decomposition:new_recompose_count:missing');
  if (!Number.isInteger(oldCount) || !Number.isInteger(newCount)) return issues;

  if (newCount !== oldCount + 1) {
    issues.push(`recompose_count:expected:${oldCount + 1}:actual:${newCount}`);
    return issues;
  }

  const delta = findMatchingDecompositionDelta(cwd, oldCount, newCount);
  if (!delta) {
    issues.push(`decomposition_delta:missing:recompose-${newCount}.yaml`);
    return issues;
  }
  if (!delta.verdict.valid) {
    issues.push(...delta.verdict.issues.map((issue) => `decomposition_delta:${issue}`));
  }
  return issues;
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
  if (cfg.decomposition_delta_required === false) return ok();

  const toolInput = data.tool_input || data.toolInput || {};
  const issues = [];
  for (const entry of collectFileWrites(toolInput)) {
    if (targetsDecompositionDeltaFile(entry.filePath)) {
      issues.push(...validateDeltaWrite(cwd, entry.filePath, entry.text, toolName));
    } else if (targetsDecompositionFile(entry.filePath)) {
      issues.push(...validateDecompositionWrite(cwd, entry.text, toolName));
    }
  }

  if (issues.length > 0) {
    const shown = issues.slice(0, 12).join(', ');
    const more = issues.length > 12 ? ` (+${issues.length - 12} more)` : '';
    const state = readState(cwd) || {};
    emitBlockedHook(cwd, state, {
      hookId: HOOK_ID,
      ruleId: 'missing_decomposition_delta',
      code: 'decomposition_delta_missing',
      artifact: BLOCKED_ARTIFACT,
      reason:
        `[MPL Decomposition Delta] Existing decomposition changes must go through ` +
        `.mpl/mpl/decomposition-deltas/recompose-N.yaml before the full graph rewrite: ${shown}${more}.`,
      resumeInstruction:
        'Write the recompose delta artifact .mpl/mpl/decomposition-deltas/recompose-N.yaml first, then retry the decomposition rewrite.',
      retryContext: { issues: issues.slice(0, 50) },
    });
    return;
  }

  emitClearedOk(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
}

if (isMain) {
  await main().catch(() => ok());
}
