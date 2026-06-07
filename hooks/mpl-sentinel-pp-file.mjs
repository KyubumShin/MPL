#!/usr/bin/env node
/**
 * MPL Sentinel PP-File — thin wrapper (Move #12).
 *
 * Delegates the Pivot Point file-touch advisor to
 * `lib/observability/signals.mjs::handleSentinelPPFile`. Legacy verbatim
 * impl preserved in `mpl-sentinel-pp-file.legacy.mjs`.
 *
 * AD-04 (v0.13.0): L1 "defend at the keystroke" — advisory only, never
 * blocks. The wrapper preserves the exact stdout shape the legacy hook
 * emitted (`additionalContext` at top-level, NOT inside hookSpecificOutput)
 * so existing consumers and tests stay byte-compatible.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { isMplActive } = await import(pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href);
const { readStdin } = await import(pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href);
const { handleSentinelPPFile } = await import(pathToFileURL(join(__dirname, 'lib', 'observability', 'signals.mjs')).href);

function ok() { console.log(JSON.stringify({ continue: true, suppressOutput: true })); }

async function main() {
  const input = await readStdin();
  let data;
  try { data = JSON.parse(input); } catch { return ok(); }
  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return ok();

  const decision = handleSentinelPPFile({
    cwd,
    toolName: data.tool_name || data.toolName || '',
    toolInput: data.tool_input || data.toolInput || {},
  });

  if (!decision || decision.action !== 'signal' || !decision.additionalContext) return ok();
  // Preserve legacy top-level additionalContext shape.
  console.log(JSON.stringify({
    continue: true,
    suppressOutput: false,
    additionalContext: decision.additionalContext,
  }));
}

main().catch(() => ok());

export {
  parsePivotPoints,
  matchFileToPP,
} from './lib/observability/signals.mjs';
