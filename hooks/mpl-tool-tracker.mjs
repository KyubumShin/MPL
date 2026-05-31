#!/usr/bin/env node
/**
 * MPL Tool Tracker — thin wrapper (Move #12).
 *
 * Delegates to `lib/observability/trackers.mjs::handleToolTracker` which
 * returns a `stateMutations: { last_tool_at }` patch. The wrapper just
 * applies it via writeState (G4 / #109 verification-hang detection).
 *
 * Legacy verbatim impl preserved in `mpl-tool-tracker.legacy.mjs`.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { isMplActive, readState, writeState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href);
const { handleToolTracker } = await import(
  pathToFileURL(join(__dirname, 'lib', 'observability', 'trackers.mjs')).href
);

function silent() { console.log(JSON.stringify({ continue: true, suppressOutput: true })); }

async function main() {
  const input = await readStdin();
  let data;
  try { data = JSON.parse(input); } catch { return silent(); }
  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return silent();
  if (!readState(cwd)) return silent();

  const decision = handleToolTracker();
  if (decision && decision.stateMutations) {
    try { writeState(cwd, decision.stateMutations); } catch { /* best-effort */ }
  }
  silent();
}

await main().catch(() => silent());
