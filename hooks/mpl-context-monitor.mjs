#!/usr/bin/env node
/**
 * MPL Context Monitor — thin wrapper (Move #12).
 *
 * Delegates the Stage-1 measurement (cumulative tokens, dispatches,
 * threshold events) to `lib/observability/trackers.mjs::handleContextMonitor`.
 * The handler writes `.mpl/mpl/chains/{chain_id}/context-usage.json`
 * directly (best-effort) AND returns a `fileWrites` intent; the wrapper
 * therefore only needs to handle stdin parse + MPL-active gate.
 *
 * Legacy verbatim impl preserved in `mpl-context-monitor.legacy.mjs`.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { isMplActive, readState } = await import(pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href);
const { readStdin } = await import(pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href);
const { handleContextMonitor } = await import(pathToFileURL(join(__dirname, 'lib', 'observability', 'trackers.mjs')).href);
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

  handleContextMonitor({
    cwd,
    toolName: data.tool_name || '',
    toolInput: data.tool_input || {},
    toolResponse: data.tool_response || {},
    state: readState(cwd) || {},
    config: loadCfg(cwd),
  });
  ok();
}

main().catch(() => ok());

export { chainIdForPhase } from './lib/observability/trackers.mjs';
