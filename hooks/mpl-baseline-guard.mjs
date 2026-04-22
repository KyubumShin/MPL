#!/usr/bin/env node
/**
 * MPL Baseline Guard — PreToolUse blocker for immutable baseline.yaml (#59)
 *
 * Blocks Edit/Write operations on `.mpl/mpl/baseline.yaml` after it has been
 * written, unless the renewal sentinel `.mpl/mpl/.baseline-renewal` exists.
 *
 * The baseline snapshot captured at Step 2.9 is ground truth for downstream
 * delta calculation (Decomposer) and rollback target (4.7 partial rollback).
 * Silent overwrites would corrupt both. Orchestrator initiates renewal
 * explicitly by dropping the flag before Phase 0 re-interview.
 */

import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { baselineExists, renewalAuthorized, BASELINE_FILE, RENEWAL_FLAG_FILE } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-baseline.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

function normalizeRel(cwd, filePath) {
  if (!filePath) return '';
  const abs = resolve(filePath);
  const cwdAbs = resolve(cwd);
  if (abs.startsWith(cwdAbs + '/')) {
    return abs.slice(cwdAbs.length + 1);
  }
  return filePath.replace(/\\/g, '/');
}

async function main() {
  const input = await readStdin();

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const toolName = data.tool_name || data.toolName || '';
  if (!['Edit', 'edit', 'Write', 'write'].includes(toolName)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const toolInput = data.tool_input || data.toolInput || {};
  const filePath = toolInput.file_path || toolInput.filePath || '';
  if (!filePath) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const rel = normalizeRel(cwd, filePath);
  if (rel !== BASELINE_FILE) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Baseline does not yet exist → first write is allowed (Step 2.9 initial snapshot).
  if (!baselineExists(cwd)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Baseline exists → allow only when renewal sentinel is present.
  if (renewalAuthorized(cwd)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const reason = [
    `[MPL Baseline Guard] Blocked write to ${BASELINE_FILE}.`,
    '',
    `This file is the immutable ground-truth snapshot recorded at Step 2.9 after`,
    `Stage 2 Ambiguity Resolution closed. Downstream consumers (Decomposer,`,
    `Seed Generator, 4.7 Partial Rollback) treat it as the pipeline's baseline.`,
    'Silently overwriting it would corrupt delta calculation and rollback.',
    '',
    'To legitimately rewrite the baseline (Phase 0 re-interview), drop the',
    `renewal sentinel first:`,
    '',
    `  touch ${RENEWAL_FLAG_FILE}`,
    '',
    'Then retry the write. The orchestrator removes the flag after successful',
    'baseline rewrite.',
  ].join('\n');

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  }));
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
});
