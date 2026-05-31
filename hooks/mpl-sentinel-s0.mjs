#!/usr/bin/env node
/**
 * MPL Sentinel S0 — thin wrapper (Move #12).
 *
 * Delegates the contract_snippet hallucination check to
 * `lib/observability/signals.mjs::handleSentinelS0`. The legacy inline
 * implementation is preserved verbatim in `mpl-sentinel-s0.legacy.mjs`
 * for emergency rollback.
 *
 * Filter knob: `observability.sentinels.subagent_type_filter.s0`
 * (default: ['mpl-seed-generator', 'mpl:mpl-seed-generator',
 *           'mpl-phase-runner',    'mpl:mpl-phase-runner']).
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { isMplActive } = await import(pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href);
const { readStdin } = await import(pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href);
const { handleSentinelS0 } = await import(pathToFileURL(join(__dirname, 'lib', 'observability', 'signals.mjs')).href);
const configMod = await (async () => {
  try { return await import(pathToFileURL(join(__dirname, 'lib', 'config.mjs')).href); }
  catch { return null; }
})();
const legacyConfigMod = await (async () => {
  try { return await import(pathToFileURL(join(__dirname, 'lib', 'mpl-config.mjs')).href); }
  catch { return null; }
})();

function ok() { console.log(JSON.stringify({ continue: true, suppressOutput: true })); }

function loadCfg(cwd) {
  try {
    if (configMod && typeof configMod.loadConfigV2 === 'function') return configMod.loadConfigV2(cwd) || {};
  } catch { /* fall through */ }
  try {
    if (legacyConfigMod && typeof legacyConfigMod.loadConfig === 'function') return legacyConfigMod.loadConfig(cwd) || {};
  } catch { /* fall through */ }
  return {};
}

async function main() {
  const input = await readStdin();
  let data;
  try { data = JSON.parse(input); } catch { return ok(); }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return ok();

  const decision = handleSentinelS0({
    cwd,
    toolName: data.tool_name || data.toolName || '',
    toolInput: data.tool_input || data.toolInput || {},
    toolResponse: data.tool_response || data.toolResponse || '',
    config: loadCfg(cwd),
  });

  if (!decision || decision.action !== 'signal' || !decision.additionalContext) return ok();
  console.log(JSON.stringify({
    continue: true,
    suppressOutput: false,
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: decision.additionalContext },
  }));
}

main().catch(() => ok());

// Re-export pure helpers for legacy test compatibility.
export {
  extractContractSnippet,
  findHallucinatedKeys,
  loadContract,
} from './lib/observability/signals.mjs';
