#!/usr/bin/env node
/**
 * MPL Baseline Guard — PreToolUse blocker for immutable baseline.yaml (#59).
 *
 * Move #7: thin shim over `hooks/lib/policy/channel-registry.mjs`. This
 * hook activates ONLY the `baseline_renewal_sentinel_absent` slice of
 * the registry (focus.categories: ['baseline']); semantics are
 * byte-equivalent to the pre-Move #7 hand-rolled gate.
 */

import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { isMplActive, readState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { loadConfig } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-config.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { collectFileWrites, isFileWriteTool } = await import(
  pathToFileURL(join(__dirname, 'lib', 'tool-input.mjs')).href
);
const { evaluateChannelWrite } = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'channel-registry.mjs')).href
);
const { recordBlockedHook, clearBlockedHook } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-blocked-hook.mjs')).href
);

const HOOK_ID = 'mpl-baseline-guard';
const HOOK_EVENT = 'PreToolUse';
const BASELINE_REL = '.mpl/mpl/baseline.yaml';
const FOCUS = {
  runForbidden: false,
  runAllowlist: false,
  runSchema: false,
  rules: ['baseline_renewal_sentinel_absent'],
};

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
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
  const writes = collectFileWrites(toolInput);
  if (writes.length === 0) return ok();

  const state = readState(cwd) || {};
  const cfg = loadConfig(cwd);

  let targetedBaseline = false;
  for (const w of writes) {
    const relPath = normalizeRel(cwd, w.filePath);
    if (relPath !== BASELINE_REL) continue;
    targetedBaseline = true;

    const verdict = evaluateChannelWrite({
      cwd,
      state,
      cfg,
      relPath,
      newText: w.text,
      toolName,
      hookEvent: HOOK_EVENT,
      focus: FOCUS,
    });

    if (verdict.action === 'block') {
      recordBlockedHook(cwd, {
        hookId: HOOK_ID,
        phaseId: state?.current_phase,
        artifact: verdict.artifact || BASELINE_REL,
        code: verdict.code || 'baseline_immutable',
        reason: verdict.reason,
        resumeInstruction: verdict.resumeInstruction,
        retryContext: {
          ...(verdict.retryContext || {}),
          requested_targets: writes
            .map((entry) => normalizeRel(cwd, entry.filePath))
            .filter(Boolean),
        },
      });
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: HOOK_EVENT,
          permissionDecision: 'deny',
          permissionDecisionReason: verdict.reason,
        },
      }));
      return;
    }
  }

  if (targetedBaseline) {
    clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: BASELINE_REL });
  }
  ok();
}

main().catch(() => ok());
