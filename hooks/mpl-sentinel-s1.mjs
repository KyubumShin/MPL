#!/usr/bin/env node
/**
 * MPL Sentinel S1 — thin wrapper (Move #12).
 *
 * Delegates the export-manifest symbol validator to
 * `lib/observability/signals.mjs::handleSentinelS1`. Legacy verbatim impl
 * preserved in `mpl-sentinel-s1.legacy.mjs`.
 *
 * CLOSES EVAL FINDING: filter knob `observability.sentinels.subagent_type_filter.s1`
 * (default: ['mpl-phase-runner', 'mpl:mpl-phase-runner']) short-circuits the
 * recursive phase-dir scan when the dispatching subagent_type does not match,
 * so debate / validate-seed / ambiguity-gate dispatches no longer do
 * per-call readdirSync + readFileSync over every export-manifest.json.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { isMplActive } = await import(pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href);
const { readStdin } = await import(pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href);
const { handleSentinelS1 } = await import(pathToFileURL(join(__dirname, 'lib', 'observability', 'signals.mjs')).href);
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
  try { if (configMod?.loadConfigV2) return configMod.loadConfigV2(cwd) || {}; } catch { /* */ }
  try { if (legacyConfigMod?.loadConfig) return legacyConfigMod.loadConfig(cwd) || {}; } catch { /* */ }
  return {};
}

async function main() {
  const input = await readStdin();
  let data;
  try { data = JSON.parse(input); } catch { return ok(); }
  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return ok();

  const decision = handleSentinelS1({
    cwd,
    toolName: data.tool_name || data.toolName || '',
    toolInput: data.tool_input || data.toolInput || {},
    toolResponse: data.tool_response || data.toolResponse || '',
    config: loadCfg(cwd),
  });

  if (!decision || decision.action !== 'signal' || !decision.additionalContext) return ok();
  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: decision.additionalContext },
  }));
}

main().catch(() => ok());

export {
  symbolExistsInContent,
  findManifestPaths,
  validateManifest,
} from './lib/observability/signals.mjs';
