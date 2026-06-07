#!/usr/bin/env node
/**
 * MPL Quality Gate Hook (PostToolUse Task|Agent, P0-A redesign #103).
 *
 * Thin stdin/stdout shim over `hooks/lib/policy/gates.mjs::handleQuality`
 * (Move #9). The policy module owns the parse → decide → persist → consume
 * sequence and gates `consumeSignal` on a successful writeState (the Move #9
 * bug fix — pre-Move #9, a writeState throw silently swallowed retry-counter
 * advancement while rmSync still deleted the signal, causing the gate to
 * spin forever after each missing-file fail-closed surface).
 *
 * Original implementation: hooks/mpl-quality-gate.legacy.mjs
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { rmSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { handle: gatesHandle, QUALITY_SCORE_PATH } = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'gates.mjs')).href
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

  const toolName = data.tool_name || data.toolName || '';
  const toolInput = data.tool_input || data.toolInput || {};

  const result = gatesHandle('quality', {
    cwd,
    toolName,
    toolInput,
  });

  if (result.action === 'silent') {
    return silent();
  }

  // For every non-silent action, emit the systemMessage. consumeSignal
  // controls whether the signal file is deleted — gated by writeState
  // success per the Move #9 bug fix.
  if (result.consumeSignal === true) {
    try { rmSync(join(cwd, QUALITY_SCORE_PATH)); } catch { /* best-effort cleanup */ }
  }

  console.log(JSON.stringify({
    continue: true,
    systemMessage: result.systemMessage,
  }));
}

await main().catch(() => silent());
