#!/usr/bin/env node
/**
 * MPL Ambiguity Gate Hook (PreToolUse Task|Agent → mpl-decomposer).
 *
 * Thin stdin/stdout shim over `hooks/lib/policy/gates.mjs::handleAmbiguity`
 * (Move #9). The policy module owns user_contract_set + goal_contract
 * validity + ambiguity_score threshold check + override branch + the
 * phase-reversion state mutations. The wrapper persists the returned
 * stateMutations via writeState, emits stderr surfaces, and translates
 * the decision back into the legacy { continue, reason } stdout contract.
 *
 * Legacy stdout contract preserved:
 *   allow / noop / bypass → { continue: true, suppressOutput: true }
 *   block → { continue: false, reason: <verbose legacy reason string> }
 *
 * Original implementation: hooks/mpl-ambiguity-gate.legacy.mjs
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { isMplActive, writeState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { handle: gatesHandle } = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'gates.mjs')).href
);

function pass() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

async function main() {
  const input = await readStdin();

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    return pass();
  }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return pass();

  const toolName = data.tool_name || data.toolName || '';
  const toolInput = data.tool_input || data.toolInput || {};

  const decision = gatesHandle('ambiguity', {
    cwd,
    toolName,
    toolInput,
  });

  // Persist any state mutations the policy module decided on (phase reverts,
  // goal_contract syncs). This mirrors the legacy writeState calls.
  if (decision.stateMutations && Object.keys(decision.stateMutations).length > 0) {
    try {
      writeState(cwd, decision.stateMutations);
    } catch {
      // Best-effort: never block the surfacing decision on disk failure
      // (matches legacy behavior — writeState was unguarded but a throw
      //  would have surfaced as an unhandled rejection caught by main()).
    }
  }

  if (decision.stderr) {
    try { process.stderr.write(decision.stderr); } catch { /* ignore */ }
  }

  switch (decision.action) {
    case 'noop':
    case 'allow':
    case 'bypass':
      return pass();
    case 'block':
      console.log(JSON.stringify({
        continue: false,
        reason: decision.reason,
      }));
      return;
    default:
      return pass();
  }
}

main().catch(() => pass());
