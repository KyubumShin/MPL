#!/usr/bin/env node
/**
 * MPL State Invariant Hook (G3 + H1, #108)
 *
 * Standalone hook surface — thin wrapper over `lib/policy/state-invariant.mjs`.
 * Both the standalone path AND the engine dispatch path call the same
 * `handle()` so behavior is single-source.
 *
 * Triggers (per hooks.json registration / dispatch route):
 *   - PreToolUse Task|Agent     → trigger='task-dispatch'
 *   - PreToolUse Edit|Write     → trigger='state-write' (only when target is .mpl/state.json)
 *   - Stop                       → trigger='stop'
 *
 * Action policy is resolved through P0-2 (#110)
 * `enforcement.state_invariant_violation`:
 *   - off  → silent (audit-only)
 *   - warn → continue + systemMessage
 *   - block → block the triggering action with a structured reason
 *
 * Strict mode elevates 'warn' to 'block' at the resolver, per the standard
 * P0-2 escalation rules.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { deriveTrigger, TRIGGERS } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state-invariant.mjs')).href
);
const { handle: handleStateInvariant } = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'state-invariant.mjs')).href
);

function silent() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

const ROUTE_FOR_TRIGGER = {
  [TRIGGERS.TASK_DISPATCH]: 'task-dispatch',
  [TRIGGERS.STATE_WRITE]:   'state-write',
  [TRIGGERS.STOP]:          'stop',
  [TRIGGERS.PRE_COMPACT]:   'pre-compact',
};

async function main() {
  const input = await readStdin();
  let data;
  try { data = JSON.parse(input); } catch { return silent(); }

  const cwd = data.cwd || data.directory || process.cwd();
  const trigger = deriveTrigger(data);
  const routeTrigger = ROUTE_FOR_TRIGGER[trigger] || 'stop';

  const decision = handleStateInvariant(routeTrigger, {
    cwd,
    toolName: data.tool_name || data.toolName || '',
    toolInput: data.tool_input || data.toolInput || {},
  });

  // Translate decision envelope to legacy hook stdout shape.
  if (!decision || decision.action === 'noop' || decision.action === 'allow') {
    return silent();
  }
  if (decision.action === 'block') {
    console.log(JSON.stringify({
      decision: 'block',
      reason: decision.reason,
    }));
    return;
  }
  if (decision.action === 'warn') {
    console.log(JSON.stringify({
      continue: true,
      systemMessage: decision.reason,
    }));
    return;
  }
  // Defensive: unknown action -> silent.
  silent();
}

await main().catch(() => silent());
