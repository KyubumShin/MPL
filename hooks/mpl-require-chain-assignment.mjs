#!/usr/bin/env node
/**
 * MPL Require Chain Assignment Hook (PreToolUse on Task|Agent)
 *
 * AP-CHAIN-01 enforcement (was: prose warning in commands/mpl-run-decompose.md).
 * When `.mpl/config.json` sets `chain_seed.enabled: true`, the Step 3-G chain
 * derivation MUST have produced `.mpl/mpl/chain-assignment.yaml` before the
 * orchestrator dispatches `mpl-seed-generator`. If the derivation was silently
 * skipped (observed in exp10 / AD-0006 §#41 → the "Gated" label was read as
 * *skippable* rather than *conditional on config*), the seed generator would
 * fall back to `chains/no-chain/` and the user's explicit activation would be
 * lost. This hook machine-enforces the invariant by denying the dispatch.
 *
 * Matcher: Task|Agent (PreToolUse)
 * Scope:   subagent_type == "mpl-seed-generator" (or "mpl:mpl-seed-generator")
 * Pass:    chain_seed.enabled != true → allow (inline mode, AP-SEED-01 exemption)
 *          chain_seed.enabled == true AND chain-assignment.yaml present → allow
 * Deny:    chain_seed.enabled == true AND chain-assignment.yaml absent
 *
 * Non-blocking on error: any exception swallowed, defaults to allow.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

const SEED_SUBAGENTS = new Set(['mpl-seed-generator', 'mpl:mpl-seed-generator']);

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function deny(reason) {
  console.log(JSON.stringify({ continue: false, decision: 'block', reason }));
}

/**
 * Read `.mpl/config.json` → `chain_seed.enabled`. Defaults to false when the
 * file is missing, unreadable, or omits the key — same contract as
 * commands/mpl-run-decompose.md Step 3-G.
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
  if (toolName !== 'Task' && toolName !== 'Agent') {
    ok();
    return;
  }

  const toolInput = data.tool_input || data.toolInput || {};
  const subagentType = String(toolInput.subagent_type || toolInput.subagentType || '');
  if (!SEED_SUBAGENTS.has(subagentType)) {
    ok();
    return;
  }

  // Seed Generator dispatch — gate only when chain mode is explicitly enabled.
  // Inline mode (default) is AP-SEED-01 exempt per #58: one call = one phase
  // by design, no chain-assignment.yaml expected.
  if (!isChainSeedEnabled(cwd)) {
    ok();
    return;
  }

  if (chainAssignmentExists(cwd)) {
    ok();
    return;
  }

  deny(
    '[MPL AP-CHAIN-01] ⛔ Seed Generator BLOCKED: chain_seed.enabled=true but ' +
      '.mpl/mpl/chain-assignment.yaml is missing. Step 3-G (Chain Derivation) ' +
      'must run before mpl-seed-generator dispatch — silent fallback to chains/no-chain/ ' +
      'would discard the user\'s explicit chain-mode activation and break baton-pass/cache reuse. ' +
      'Fix: return to commands/mpl-run-decompose.md Step 3-G, derive chains from decomposition.yaml ' +
      'phase edges, and write .mpl/mpl/chain-assignment.yaml (schema: docs/schemas/chain-assignment.md). ' +
      'Opt-out: set chain_seed.enabled=false in .mpl/config.json for inline mode (AP-SEED-01 exempt per #58).'
  );
}

main().catch(() => {
  // Hook must never wedge the pipeline.
  ok();
});
