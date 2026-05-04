#!/usr/bin/env node
/**
 * MPL Bash Timeout Hook (PreToolUse on Bash)
 *
 * G1 (#107). Verification-shape Bash commands (vitest, playwright, build, lint)
 * get category-aware timeout bounds. Without enforcement the orchestrator either
 * (a) omits timeout and Claude Code's 2-minute default kills legitimate longer
 * runs, or (b) sets an overly-large timeout that lets infinite loops accumulate
 * fix-loop wall time (exp15 phase-10 5h shape, v3.10 §6.6 G1).
 *
 * Decision matrix (see `lib/bash-timeout-categories.mjs#decideTimeout`):
 *   - non-verification command → silent allow
 *   - verification + missing timeout → strict block / non-strict warn (with recommended)
 *   - verification + timeout < sanity floor → block/warn (typo guard)
 *   - verification + timeout > ceiling → block/warn (per-call budget)
 *   - verification + in range → silent allow
 *
 * Strict mode = `state.enforcement.strict === true` (#110 P0-2).
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { isMplActive, readState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { decideTimeout } = await import(
  pathToFileURL(join(__dirname, 'lib', 'bash-timeout-categories.mjs')).href
);

function silent() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

async function main() {
  const input = await readStdin();

  let data;
  try { data = JSON.parse(input); } catch { return silent(); }

  const toolName = data.tool_name || data.toolName || '';
  if (!['Bash', 'bash'].includes(toolName)) return silent();

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return silent();

  const toolInput = data.tool_input || data.toolInput || {};
  const command = toolInput.command || '';
  const timeoutMs = toolInput.timeout;

  const state = readState(cwd) || {};
  const strict = state.enforcement && state.enforcement.strict === true;

  const decision = decideTimeout(command, timeoutMs, { strict });

  if (decision.action === 'silent') return silent();

  if (decision.action === 'block') {
    console.log(JSON.stringify({
      decision: 'block',
      reason: decision.reason,
    }));
    return;
  }

  // warn: continue with a system-reminder
  console.log(JSON.stringify({
    continue: true,
    systemMessage: decision.reason,
  }));
}

await main().catch(() => silent());
