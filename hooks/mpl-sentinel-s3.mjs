#!/usr/bin/env node
/**
 * MPL Sentinel S3 — thin wrapper (Move #12).
 *
 * Delegates the test-import-path validator to
 * `lib/observability/signals.mjs::handleSentinelS3`. Legacy verbatim impl
 * preserved in `mpl-sentinel-s3.legacy.mjs`.
 *
 * CLOSES EVAL FINDING (biggest perf cost): filter knob
 * `observability.sentinels.subagent_type_filter.s3`
 * (default: ['mpl-test-agent', 'mpl:mpl-test-agent']) short-circuits the
 * recursive readdir + statSync per import resolution attempt, so
 * unrelated Task|Agent completions no longer pay the cost.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { isMplActive } = await import(pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href);
const { readStdin } = await import(pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href);
const { handleSentinelS3 } = await import(pathToFileURL(join(__dirname, 'lib', 'observability', 'signals.mjs')).href);
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

  const decision = handleSentinelS3({
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
  isTestFile,
  extractImportPaths,
  resolveImportPath,
  findTestFiles,
  validateTestImports,
} from './lib/observability/signals.mjs';
