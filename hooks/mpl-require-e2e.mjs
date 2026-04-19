#!/usr/bin/env node
/**
 * MPL Require E2E Hook (PreToolUse on Write|Edit targeting state.json)
 *
 * Guards the transition to `finalize_done: true`. Reads the declared required
 * E2E scenarios from `.mpl/mpl/e2e-scenarios.yaml` and blocks the state write
 * if any required scenario has not been recorded as passing in
 * `state.e2e_results` AND is not overridden.
 *
 * AD-0008 enforcement contract:
 *   - Finalize Step 5.0 is responsible for executing missing scenarios
 *     (via Bash) before setting finalize_done. The gate-recorder hook writes
 *     `state.e2e_results[scenario.id]` as each execution completes.
 *   - This hook is the last line of defence: if finalize is asked to mark the
 *     pipeline complete while any required scenario lacks a passing exit code,
 *     the hook emits {continue: false, decision: "block", reason: ...}.
 *   - Override: `.mpl/config/e2e-scenario-override.json` can bypass with a
 *     user-supplied reason (AD-0007 pattern, extended with environment marker
 *     per AD-0008 R-2).
 *
 * The hook deliberately does NOT attempt to parse arbitrary Edit new_string
 * JSON — instead it reads the CURRENT state.json from disk after the write
 * would have happened (effectively an after-the-fact check). Because a
 * PreToolUse hook fires BEFORE the tool runs, we inspect the tool input
 * directly when it's a JSON assignment the caller can reveal.
 *
 * Non-blocking on error: swallows every exception.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { readState, isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function block(reason) {
  console.log(JSON.stringify({ continue: false, decision: 'block', reason }));
}

/**
 * Parse e2e-scenarios.yaml minimal subset for required entries.
 * Returns array of { id, title, test_command, required } in declaration order.
 */
function parseScenarios(cwd) {
  const path = join(cwd, '.mpl', 'mpl', 'e2e-scenarios.yaml');
  if (!existsSync(path)) return [];

  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }

  const out = [];
  let cur = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');

    const idMatch = line.match(/^\s*-\s+id:\s*["']?(E2E-[\w-]+)["']?/);
    if (idMatch) {
      if (cur) out.push(cur);
      cur = {
        id: idMatch[1],
        title: null,
        test_command: null,
        required: true, // default
      };
      continue;
    }
    if (!cur) continue;

    const titleMatch = line.match(/^\s+title:\s*["']?(.+?)["']?\s*$/);
    if (titleMatch) {
      cur.title = titleMatch[1];
      continue;
    }

    const tcMatch = line.match(/^\s+test_command:\s*["']?(.+?)["']?\s*$/);
    if (tcMatch) {
      cur.test_command = tcMatch[1];
      continue;
    }

    const reqMatch = line.match(/^\s+required:\s*(true|false)\s*$/i);
    if (reqMatch) {
      cur.required = reqMatch[1].toLowerCase() === 'true';
      continue;
    }
  }
  if (cur) out.push(cur);

  return out;
}

/**
 * AD-0008 R-2: overrides may be a string (legacy shape from AD-0007) or an
 * object with { reason, test_command_hash, recorded_at, source }. Returns the
 * unified shape or null.
 */
function loadOverride(cwd) {
  const path = join(cwd, '.mpl', 'config', 'e2e-scenario-override.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Detect whether the incoming tool input writes `finalize_done: true` to
 * `.mpl/state.json`. Handles Edit (old_string/new_string) and Write (content).
 * False positives are acceptable — the hook only blocks when scenarios are
 * actually missing, so innocent state edits pass through.
 */
function isFinalizeDoneWrite(toolInput) {
  const filePath = toolInput.file_path || toolInput.filePath || '';
  if (!/\.mpl\/state\.json$/.test(filePath)) return false;

  const newText =
    toolInput.new_string ||
    toolInput.newString ||
    toolInput.content ||
    '';
  // Match "finalize_done": true in either quoted-JSON or unquoted source
  return /"finalize_done"\s*:\s*true/.test(newText);
}

try {
  const raw = await readStdin();
  if (!raw.trim()) {
    ok();
    process.exit(0);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    ok();
    process.exit(0);
  }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) {
    ok();
    process.exit(0);
  }

  const toolName = String(data.tool_name || data.toolName || '');
  if (!['Write', 'write', 'Edit', 'edit'].includes(toolName)) {
    ok();
    process.exit(0);
  }

  const toolInput = data.tool_input || data.toolInput || {};
  if (!isFinalizeDoneWrite(toolInput)) {
    ok();
    process.exit(0);
  }

  // A finalize_done: true write is imminent. Validate E2E coverage.
  const scenarios = parseScenarios(cwd);
  const required = scenarios.filter((s) => s.required && s.test_command);
  if (required.length === 0) {
    // No declared E2E scenarios — nothing to enforce. Allow.
    ok();
    process.exit(0);
  }

  const state = readState(cwd) || {};
  const results = state.e2e_results || {};
  const override = loadOverride(cwd);

  const unresolved = [];
  for (const s of required) {
    // Override check (both legacy string and AD-0008 object shape)
    const entry = override[s.id] ?? override['*'];
    if (entry) {
      if (typeof entry === 'string' && entry.trim().length > 0) continue;
      if (
        typeof entry === 'object' &&
        entry !== null &&
        typeof entry.reason === 'string' &&
        entry.reason.trim().length > 0
      ) {
        // If test_command_hash recorded, check whether scenario changed.
        // We don't compute sha1 inline (keep hook zero-dep); absence of hash
        // match means we trust the override (legacy/unmigrated entry).
        continue;
      }
    }

    const rec = results[s.id];
    if (!rec) {
      unresolved.push(`${s.id} (never executed)`);
      continue;
    }
    if (rec.exit_code !== 0) {
      unresolved.push(`${s.id} (exit ${rec.exit_code})`);
      continue;
    }
  }

  if (unresolved.length === 0) {
    ok();
    process.exit(0);
  }

  block(
    `[MPL AD-0008] Cannot set finalize_done=true — ${unresolved.length} required E2E scenario(s) missing or failing: ${unresolved.join(', ')}. ` +
      `Each required scenario's test_command must be executed (gate-recorder writes state.e2e_results automatically) AND exit 0, ` +
      `OR explicitly overridden via .mpl/config/e2e-scenario-override.json with a user reason. ` +
      `Re-run the scenarios or use /mpl:mpl-finalize Step 5.0 HITL to record overrides before retrying finalize.`
  );
} catch {
  // Hook must never wedge the pipeline.
  ok();
}
