#!/usr/bin/env node
/**
 * MPL Finalize Gate (PreToolUse on Write|Edit|MultiEdit targeting state.json).
 *
 * Thin stdin/stdout shim over `hooks/lib/policy/gates.mjs::handleFinalize`
 * (Move #9). The policy module owns the decision graph by calling the four
 * contracts.mjs child handlers (e2e, e2e_authenticity, finalize_artifacts,
 * whole_goal_closure) IN-PROCESS — no more spawnSync. The wrapper preserves
 * the legacy block-surface I/O (emitBlockedHook / emitClearedOk +
 * clearBlockedHook of stale envelopes) and the symbol exports the existing
 * tests assert against (isFinalizeDoneWrite, summarizeFailures,
 * summarizeAdvisories, DELEGATES, HOOK_ID, BLOCKED_ARTIFACT).
 *
 * Original implementation: hooks/mpl-finalize-gate.legacy.mjs
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

const { readState, isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = isMain
  ? await import(pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href)
  : { readStdin: async () => '' };
const { emitBlockedHook, emitClearedOk } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-block-surface.mjs')).href
);
const { clearBlockedHook } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-blocked-hook.mjs')).href
);
const {
  handle: gatesHandle,
  isFinalizeDoneWrite,
  summarizeFinalizeFailures,
  summarizeFinalizeAdvisories,
  FINALIZE_HOOK_ID,
  FINALIZE_BLOCKED_ARTIFACT,
} = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'gates.mjs')).href
);
const { loadConfig } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-config.mjs')).href
);

const HOOK_ID = FINALIZE_HOOK_ID;
const BLOCKED_ARTIFACT = FINALIZE_BLOCKED_ARTIFACT;

// DELEGATES retained as a constant for the existing test which asserts the
// canonical four-child list. Post-Move #9 the gate runs in-process, but the
// labels still identify which child contributed each failure entry. The test
// `.sort()`s in place, so we expose a mutable array (legacy contract).
const DELEGATES = [
  'mpl-require-e2e.mjs',
  'mpl-require-e2e-authenticity.mjs',
  'mpl-require-finalize-artifacts.mjs',
  'mpl-require-whole-goal-closure.mjs',
];

const ENV_GUARD_KEY = 'MPL_FINALIZE_GATE_ACTIVE';

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

// Re-export the legacy summarizer names so tests asserting wording stay green.
const summarizeFailures = summarizeFinalizeFailures;
const summarizeAdvisories = summarizeFinalizeAdvisories;

export async function runGate({ stdinPayload, cwd } = {}) {
  if (!stdinPayload) { ok(); return 'ok'; }

  let data;
  try {
    data = JSON.parse(stdinPayload);
  } catch {
    ok();
    return 'ok';
  }

  const toolName = data.tool_name || data.toolName || '';
  if (!/^(Edit|Write|MultiEdit)$/.test(toolName)) { ok(); return 'ok'; }

  const toolInput = data.tool_input || data.toolInput || {};
  if (!isFinalizeDoneWrite(toolInput)) { ok(); return 'ok'; }

  const resolvedCwd = cwd || data.cwd || data.directory || process.cwd();
  if (!isMplActive(resolvedCwd)) { ok(); return 'ok'; }

  const state = readState(resolvedCwd) || {};
  const config = loadConfig(resolvedCwd) || {};

  // Clear any stale child envelopes from a prior round before we delegate. The
  // children may have run as standalone hooks earlier in the pipeline; their
  // envelopes are not the coalesced surface and would confuse mpl-recover.
  for (const child of DELEGATES) {
    clearBlockedHook(resolvedCwd, {
      hookId: child.replace(/\.mjs$/, ''),
      artifact: BLOCKED_ARTIFACT,
    });
  }

  const decision = gatesHandle('finalize', {
    cwd: resolvedCwd,
    state,
    config,
    toolName,
    toolInput,
    hookEvent: 'PreToolUse',
  });

  if (decision.action === 'allow') {
    emitClearedOk(resolvedCwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
    return 'ok';
  }

  if (decision.action === 'advisory') {
    clearBlockedHook(resolvedCwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
    const advisoryText = summarizeAdvisories(decision.advisories || []);
    console.log(JSON.stringify({
      continue: true,
      systemMessage: advisoryText,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: advisoryText,
      },
    }));
    return 'warn';
  }

  // block
  emitBlockedHook(resolvedCwd, state, {
    hookId: HOOK_ID,
    ruleId: 'finalize_gate_failures',
    code: 'finalize_gate_failures',
    artifact: BLOCKED_ARTIFACT,
    reason: decision.reason,
    resumeInstruction: decision.resumeInstruction,
    retryContext: decision.retryContext || {},
  });
  return 'block';
}

async function main() {
  // Recursion guard preserved from legacy: the post-Move #9 gate runs
  // in-process so it can't recurse, but the env-var stays so any orchestrator
  // that previously expected the guard remains safe.
  if (process.env[ENV_GUARD_KEY] === '1') {
    ok();
    return;
  }
  const raw = await readStdin();
  if (!raw.trim()) {
    ok();
    return;
  }
  try {
    await runGate({ stdinPayload: raw });
  } catch {
    ok();
  }
}

if (isMain) {
  await main();
}

export { isFinalizeDoneWrite, summarizeFailures, summarizeAdvisories, DELEGATES, HOOK_ID, BLOCKED_ARTIFACT };
