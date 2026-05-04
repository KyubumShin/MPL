#!/usr/bin/env node
/**
 * MPL Tool Tracker Hook (PostToolUse, all tools)
 *
 * G4 (#109). Updates `state.last_tool_at = ISO-8601` on every tool invocation
 * so the Stop hook (`mpl-phase-controller.mjs`) can detect verification hangs
 * (no tool fired in > threshold minutes → mark `session_status=verification_hang`).
 *
 * Thin: read state, write last_tool_at, return silent. No decisions made here.
 * Always exits success — never blocks a tool result.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { isMplActive, readState, writeState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

function silent() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

async function main() {
  const input = await readStdin();
  let data;
  try { data = JSON.parse(input); } catch { return silent(); }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return silent();

  const state = readState(cwd);
  if (!state) return silent();

  // Write only the timestamp; do not perturb any other state field.
  // writeState performs a deep merge — patching the flat `last_tool_at`
  // key leaves nested fields (`execution`, `gate_results`, etc.) untouched.
  try {
    writeState(cwd, { last_tool_at: new Date().toISOString() });
  } catch {
    // Never propagate — tracker is best-effort.
  }
  return silent();
}

await main().catch(() => silent());
