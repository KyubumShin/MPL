#!/usr/bin/env node
/**
 * MPL Discovery Scanner — thin wrapper (Move #12).
 *
 * Delegates the discovery-candidates filter to
 * `lib/observability/signals.mjs::handleDiscoveryScanner`. Legacy verbatim
 * impl preserved in `mpl-discovery-scanner.legacy.mjs`.
 *
 * Already properly subagent_type-gated (mpl-phase-runner only) — the new
 * filter knob is therefore advisory; the handler still enforces the
 * existing runner-only gate as a defensive default.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { isMplActive, readState } = await import(pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href);
const { readStdin } = await import(pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href);
const { handleDiscoveryScanner } = await import(pathToFileURL(join(__dirname, 'lib', 'observability', 'signals.mjs')).href);
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

  handleDiscoveryScanner({
    cwd,
    toolName: data.tool_name || data.toolName || '',
    toolInput: data.tool_input || data.toolInput || {},
    state: readState(cwd) || {},
    config: loadCfg(cwd),
  });
  ok();
}

main().catch(() => ok());

export {
  shouldFilterDiscoveryCandidate,
  readDiscoveryCandidates,
} from './lib/observability/signals.mjs';
