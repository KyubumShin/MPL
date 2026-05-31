#!/usr/bin/env node
/**
 * MPL Require Chain Assignment Hook (PreToolUse on Task|Agent)
 *
 * Thin wrapper — delegates the structural decision to
 * `lib/policy/contracts.mjs::handleChainAssignment`. All decision shape is
 * SSOT'd in that module; this hook only handles stdin parse, MPL activation
 * gate, config load, and translation of the policy envelope back into the
 * legacy stdout contract that Claude Code + the test suite expect.
 *
 * AP-CHAIN-01 enforcement (see legacy sibling `.legacy.mjs` for the original
 * inline implementation kept for emergency rollback).
 *
 * Matcher: Task|Agent (PreToolUse)
 * Scope:   subagent_type == "mpl-seed-generator" (or "mpl:mpl-seed-generator")
 *
 * Non-blocking on error: any exception swallowed, defaults to allow.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { isMplActive, readState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { emitBlockedHook, emitClearedOk } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-block-surface.mjs')).href
);
const { handleChainAssignment } = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'contracts.mjs')).href
);

const HOOK_ID = 'mpl-require-chain-assignment';
const BLOCKED_ARTIFACT = '.mpl/mpl/chain-assignment.yaml';

// Legacy verbose reason text — preserved here because callers (the test
// suite + recovery-time docs surfaced to Claude Code) match against the
// "Step 3-G" / "chains/no-chain" phrasing. The policy module returns a
// shorter envelope so other handlers can reuse the same builder, so this
// wrapper rehydrates the long form. Update both this string and the
// legacy sibling in lockstep if the docs change.
const LEGACY_BLOCK_REASON =
  '[MPL AP-CHAIN-01] Seed Generator BLOCKED: chain_seed.enabled=true but ' +
  '.mpl/mpl/chain-assignment.yaml is missing. Step 3-G (Chain Derivation) ' +
  'must run before mpl-seed-generator dispatch — silent fallback to chains/no-chain/ ' +
  "would discard the user's explicit chain-mode activation and break baton-pass/cache reuse. " +
  'Fix: return to commands/mpl-run-decompose.md Step 3-G, derive chains from decomposition.yaml ' +
  'phase edges, and write .mpl/mpl/chain-assignment.yaml (schema: docs/schemas/chain-assignment.md). ' +
  'Opt-out: set chain_seed.enabled=false in .mpl/config.json for inline mode (AP-SEED-01 exempt per #58).';
const LEGACY_RESUME_INSTRUCTION =
  'Run Step 3-G (Chain Derivation) and write .mpl/mpl/chain-assignment.yaml, then retry the mpl-seed-generator dispatch.';
const LEGACY_RETRY_CONTEXT = {
  schema_reference: 'docs/schemas/chain-assignment.md',
  opt_out: 'chain_seed.enabled = false',
};

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function loadConfig(cwd) {
  try {
    const configPath = join(cwd, '.mpl', 'config.json');
    if (!existsSync(configPath)) return {};
    return JSON.parse(readFileSync(configPath, 'utf-8')) || {};
  } catch {
    return {};
  }
}

/**
 * Read `.mpl/config.json` → `chain_seed.enabled`. Defaults to false when the
 * file is missing, unreadable, or omits the key. Kept as a named export for
 * the test suite (and any caller that imported the legacy helper).
 */
export function isChainSeedEnabled(cwd) {
  try {
    const configPath = join(cwd, '.mpl', 'config.json');
    if (!existsSync(configPath)) return false;
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    return cfg?.chain_seed?.enabled === true;
  } catch {
    return false;
  }
}

export function chainAssignmentExists(cwd) {
  return existsSync(join(cwd, '.mpl', 'mpl', 'chain-assignment.yaml'));
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) {
    ok();
    return;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    ok();
    return;
  }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) {
    ok();
    return;
  }

  const toolName = String(data.tool_name || data.toolName || '');
  const toolInput = data.tool_input || data.toolInput || {};
  const hookEvent = String(data.hook_event_name || data.hookEventName || 'PreToolUse');
  const config = loadConfig(cwd);
  const state = readState(cwd) || {};

  // Delegate the structural decision to the policy module.
  const decision = await handleChainAssignment({
    cwd,
    state,
    config,
    toolName,
    toolInput,
    hookEvent,
    raw: data,
  });

  if (!decision || decision.action !== 'block') {
    // The legacy hook emitted `emitClearedOk` ONLY on the recovery path —
    // when chain mode was enabled AND chain-assignment.yaml was present.
    // For every other out-of-scope branch (not Task/Agent, wrong subagent,
    // chain mode disabled) it emitted a plain ok() so the block-surface
    // jsonl was untouched. Preserve that contract exactly.
    const sub = String(toolInput.subagent_type || toolInput.subagentType || '');
    const inSeedDispatch =
      (toolName === 'Task' || toolName === 'Agent') &&
      (sub === 'mpl-seed-generator' || sub === 'mpl:mpl-seed-generator');
    const chainEnabled = config?.chain_seed?.enabled === true;
    const haveArtifact = existsSync(join(cwd, '.mpl', 'mpl', 'chain-assignment.yaml'));
    if (inSeedDispatch && chainEnabled && haveArtifact) {
      emitClearedOk(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
    } else {
      ok();
    }
    return;
  }

  // The policy returns a compact envelope; the legacy hook's stdout was
  // verbose ("Step 3-G", opt-out hint). Match the legacy contract so the
  // test suite + Claude Code recovery prompt stay byte-identical.
  emitBlockedHook(cwd, state, {
    hookId: HOOK_ID,
    ruleId: decision.ruleId || 'missing_chain_assignment',
    code: decision.code || 'chain_assignment_missing',
    artifact: decision.artifact || BLOCKED_ARTIFACT,
    reason: LEGACY_BLOCK_REASON,
    resumeInstruction: LEGACY_RESUME_INSTRUCTION,
    retryContext: { ...LEGACY_RETRY_CONTEXT, ...(decision.retryContext || {}) },
  });
}

main().catch(() => {
  // Hook must never wedge the pipeline.
  ok();
});
