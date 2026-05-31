#!/usr/bin/env node
/**
 * MPL Require Completed Phase Immutability Hook (PreToolUse Write|Edit|MultiEdit).
 *
 * Move #7: thin shim over `hooks/lib/policy/channel-registry.mjs`. This
 * hook activates ONLY the `completed_phase_block_unchanged` slice of the
 * registry; semantics are byte-equivalent to the pre-Move #7 hand-rolled
 * gate, including the partial-edit special-case for Edit/MultiEdit on
 * `.mpl/mpl/decomposition.yaml`. Routes through `emitBlockedHook` so the
 * `enforcement.missing_completed_phase_immutability` warn/block/off
 * tiering is preserved.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
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
const { emitBlockedHook, emitClearedOk } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-block-surface.mjs')).href
);
const { evaluateChannelWrite } = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'channel-registry.mjs')).href
);

const HOOK_ID = 'mpl-require-completed-phase-immutability';
const HOOK_EVENT = 'PreToolUse';
const BLOCKED_ARTIFACT = '.mpl/mpl/decomposition.yaml';
const FOCUS = {
  runForbidden: false,
  runAllowlist: false,
  runSchema: false,
  rules: ['completed_phase_block_unchanged'],
};

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

export function targetsDecompositionFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  return /(^|\/)\.mpl\/mpl\/decomposition\.ya?ml$/.test(filePath);
}

function normalizeRel(cwd, filePath) {
  if (!filePath) return '';
  const abs = resolve(filePath);
  const cwdAbs = resolve(cwd);
  if (abs.startsWith(cwdAbs + '/')) {
    return abs.slice(cwdAbs.length + 1);
  }
  return filePath.replace(/\\/g, '/');
}

function currentDecompositionPath(cwd) {
  return join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
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
  if (cfg.completed_phase_immutability_required === false) {
    // Explicit config opt-out clears stale envelope.
    emitClearedOk(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
    return;
  }

  const existingPath = currentDecompositionPath(cwd);
  if (!existsSync(existingPath)) return ok();

  const state = readState(cwd) || {};
  const oldText = readFileSync(existingPath, 'utf-8');

  const toolInput = data.tool_input || data.toolInput || {};
  const writes = collectFileWrites(toolInput);

  let firstBlock = null;
  for (const entry of writes) {
    const relPath = normalizeRel(cwd, entry.filePath);
    if (!targetsDecompositionFile(relPath)) continue;

    const verdict = evaluateChannelWrite({
      cwd,
      state,
      cfg,
      relPath,
      oldText,
      newText: entry.text,
      toolName,
      hookEvent: HOOK_EVENT,
      focus: FOCUS,
    });

    if (verdict.action === 'block') {
      firstBlock = verdict;
      break;
    }
  }

  if (firstBlock) {
    emitBlockedHook(cwd, state, {
      hookId: HOOK_ID,
      ruleId: firstBlock.ruleId || 'missing_completed_phase_immutability',
      code: firstBlock.code || 'completed_phase_mutation',
      artifact: firstBlock.artifact || BLOCKED_ARTIFACT,
      reason: firstBlock.reason,
      resumeInstruction: firstBlock.resumeInstruction,
      retryContext: firstBlock.retryContext || {},
    });
    return;
  }

  emitClearedOk(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
}

if (isMain) {
  await main().catch(() => ok());
}
