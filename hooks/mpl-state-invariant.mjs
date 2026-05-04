#!/usr/bin/env node
/**
 * MPL State Invariant Hook (G3 + H1, #108)
 *
 * Triggers (per hooks.json registration):
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

import { dirname, join, resolve, sep } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { isMplActive, readState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { checkInvariants, formatViolations, TRIGGERS } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state-invariant.mjs')).href
);
const { resolveRuleAction } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-enforcement.mjs')).href
);

function silent() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

/**
 * Decide which trigger context applies to this invocation. Hook spec passes
 * `hook_event_name` (Stop / PreToolUse / etc) and `tool_name` (Bash / Edit / Task).
 */
function deriveTrigger(data) {
  const event = (data.hook_event_name || data.hookEventName || '').toLowerCase();
  const tool = (data.tool_name || data.toolName || '').toLowerCase();

  if (event === 'precompact' || event === 'pre_compact') return TRIGGERS.PRE_COMPACT;
  if (event === 'stop') return TRIGGERS.STOP;
  if (event === 'pretooluse' || event === 'pre_tool_use') {
    if (['task', 'agent'].includes(tool)) return TRIGGERS.TASK_DISPATCH;
    if (['edit', 'write', 'multiedit'].includes(tool)) return TRIGGERS.STATE_WRITE;
  }
  // Unknown event: fall back to STOP semantics (safest — broadest checks).
  return TRIGGERS.STOP;
}

/**
 * Was the file path a state.json target? Filters STATE_WRITE so the hook
 * only fires on the relevant write — Edit/Write of unrelated files don't
 * trigger gate-evidence invariants.
 */
function isStateWriteTarget(toolInput, cwd) {
  if (!toolInput) return false;
  const fp = toolInput.file_path || toolInput.filePath;
  if (!fp || typeof fp !== 'string') return false;
  const abs = resolve(cwd, fp);
  return abs.endsWith(`.mpl${sep}state.json`)
      || abs.endsWith('.mpl/state.json');
}

async function main() {
  const input = await readStdin();
  let data;
  try { data = JSON.parse(input); } catch { return silent(); }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return silent();

  const trigger = deriveTrigger(data);

  // Filter STATE_WRITE to actual state.json targets — otherwise unrelated
  // Edit/Write events would invoke the gate-evidence check.
  if (trigger === TRIGGERS.STATE_WRITE) {
    const toolInput = data.tool_input || data.toolInput || {};
    if (!isStateWriteTarget(toolInput, cwd)) return silent();
  }

  const state = readState(cwd);
  if (!state) return silent();

  const result = checkInvariants(state, { cwd, trigger });
  if (result.ok) return silent();

  const action = resolveRuleAction(cwd, state, 'state_invariant_violation');
  if (action === 'off') return silent();

  const reason = formatViolations(result);
  if (action === 'block') {
    console.log(JSON.stringify({
      decision: 'block',
      reason,
    }));
    return;
  }
  // warn
  console.log(JSON.stringify({
    continue: true,
    systemMessage: reason,
  }));
}

await main().catch(() => silent());
