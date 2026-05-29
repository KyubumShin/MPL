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
import { existsSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { isMplActive, readState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { checkInvariants, formatViolations, TRIGGERS, VIOLATION_IDS } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state-invariant.mjs')).href
);
const { resolveRuleAction } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-enforcement.mjs')).href
);
// #235: record envelope on the I13 fast-track block so mpl-recover
// can dispatch and BLOCKED_HOOK_STALE doesn't fire on the next
// state-write trigger.
const { recordBlockedHook, clearBlockedHook } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-blocked-hook.mjs')).href
);

const HOOK_ID = 'mpl-state-invariant';

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

/**
 * Simulate the state.json contents AFTER the proposed Write/Edit/MultiEdit.
 * The PreToolUse hook fires before the tool applies, so reading the current
 * file would miss the very change about to land. (PR #128 review #2.)
 *
 * Returns the parsed proposed state object, or null when simulation isn't
 * possible (parse failure, missing inputs, edit string not found). Callers
 * fall back to the current state — conservative: hook may miss but never
 * blocks a write on a hypothetical state we can't compute.
 */
function simulateWrittenState(toolName, toolInput, cwd) {
  const t = (toolName || '').toLowerCase();
  const fp = toolInput?.file_path || toolInput?.filePath;
  const abs = fp ? resolve(cwd, fp) : null;

  if (t === 'write') {
    if (typeof toolInput.content !== 'string') return null;
    try { return JSON.parse(toolInput.content); } catch { return null; }
  }

  if (t === 'edit' || t === 'multiedit') {
    if (!abs || !existsSync(abs)) return null;
    let content;
    try { content = readFileSync(abs, 'utf-8'); } catch { return null; }

    const apply = (oldStr, newStr, replaceAll) => {
      if (typeof oldStr !== 'string' || typeof newStr !== 'string') return null;
      if (replaceAll === true) return content.split(oldStr).join(newStr);
      const idx = content.indexOf(oldStr);
      if (idx === -1) return null;
      return content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
    };

    if (t === 'edit') {
      const next = apply(toolInput.old_string, toolInput.new_string, toolInput.replace_all);
      if (next === null) return null;
      content = next;
    } else {
      // MultiEdit: edits[] applied in order
      if (!Array.isArray(toolInput.edits)) return null;
      for (const e of toolInput.edits) {
        const next = apply(e?.old_string, e?.new_string, e?.replace_all);
        if (next === null) return null;
        content = next;
      }
    }
    try { return JSON.parse(content); } catch { return null; }
  }

  return null;
}

async function main() {
  const input = await readStdin();
  let data;
  try { data = JSON.parse(input); } catch { return silent(); }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return silent();

  const trigger = deriveTrigger(data);
  const toolInput = data.tool_input || data.toolInput || {};
  const toolName = data.tool_name || data.toolName || '';

  // Filter STATE_WRITE to actual state.json targets — otherwise unrelated
  // Edit/Write events would invoke the gate-evidence check.
  if (trigger === TRIGGERS.STATE_WRITE) {
    if (!isStateWriteTarget(toolInput, cwd)) return silent();
  }

  // For state-writes, validate the PROPOSED state (post-write content), not
  // the on-disk state — otherwise a Write that strips structured evidence
  // would slip through because the current file still has it.
  let state = readState(cwd);
  if (trigger === TRIGGERS.STATE_WRITE) {
    const proposed = simulateWrittenState(toolName, toolInput, cwd);
    if (proposed && typeof proposed === 'object') state = proposed;
    // If simulation failed (unparseable, missing string), fall back to
    // current state. Conservative: we may miss a violation rather than
    // block a write on a hypothetical we couldn't compute.
  }
  if (!state) return silent();

  const result = checkInvariants(state, { cwd, trigger });
  if (result.ok) {
    clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: 'state-invariant' });
    return silent();
  }

  // Codex r4 on PR #222 [data-integrity]: I13 (Phase 0 artifacts) MUST
  // be a non-configurable block. The default `state_invariant_violation`
  // policy is `warn`, which would let a manual Write to state.json land
  // a protected phase without artifacts and only emit a systemMessage.
  // The fast-track invariant exists precisely to stop that path.
  const hasFastTrackViolation = result.violations.some(
    (v) => v.id === VIOLATION_IDS.FAST_TRACK_PHASE0_ARTIFACTS_MISSING
  );
  const action = resolveRuleAction(cwd, state, 'state_invariant_violation');
  if (action === 'off' && !hasFastTrackViolation) {
    clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: 'state-invariant' });
    return silent();
  }

  const reason = formatViolations(result);
  if (action === 'block' || hasFastTrackViolation) {
    // #235: record envelope so mpl-recover sees the block code.
    // I13 fast-track uses its own non-configurable code; other
    // invariant violations use the generic state_invariant_violation
    // bucket from ENFORCEMENT_DEFAULTS.
    recordBlockedHook(cwd, {
      hookId: HOOK_ID,
      phaseId: state?.current_phase,
      artifact: 'state-invariant',
      code: hasFastTrackViolation
        ? 'fast_track_phase0_artifacts_missing'
        : 'state_invariant_violation',
      reason,
      resumeInstruction: hasFastTrackViolation
        ? 'Materialize the required Phase 0 artifacts (raw-scan.md / design-intent.yaml / contracts) and rewrite the state transition, or opt out via .mpl/config.json `phase0_artifacts_required: false`.'
        : 'Resolve the state-invariant violation(s) in state.json (see reason for the specific check IDs), then retry the write.',
      retryContext: {
        violations: result.violations.slice(0, 12).map((v) => ({
          id: v.id,
          message: v.message,
        })),
        trigger,
      },
    });
    console.log(JSON.stringify({
      decision: 'block',
      reason,
    }));
    return;
  }
  // warn
  clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: 'state-invariant' });
  console.log(JSON.stringify({
    continue: true,
    systemMessage: reason,
  }));
}

await main().catch(() => silent());
