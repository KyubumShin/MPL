#!/usr/bin/env node
/**
 * MPL Permit Learner Hook (PostToolUse)
 *
 * Thin stdin/stdout shim over `hooks/lib/policy/permit.mjs::handlePermitLearner`
 * (Move #10). The policy module owns the decision graph including the
 * symmetric `classifyBashCommand()` veto — a command that auto-permit's
 * veto pipeline would block can no longer be persisted into the learned
 * allowlist (closes the "learning compounds the asymmetry" finding).
 *
 * Original implementation: hooks/mpl-permit-learner.legacy.mjs
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

const { handlePermitLearner } = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'permit.mjs')).href
);

const { addLearnedTool, addLearnedBashPrefix } = await import(
  pathToFileURL(join(__dirname, 'lib', 'permit-store.mjs')).href
);

const SILENT = JSON.stringify({ continue: true, suppressOutput: true });

async function main() {
  const input = await readStdin();

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(SILENT);
    return;
  }

  const toolName = data.tool_name || data.toolName || '';
  const cwd = data.cwd || data.directory || process.cwd();
  const toolInput = data.tool_input || data.toolInput || {};

  const decision = handlePermitLearner({ cwd, toolName, toolInput });

  if (decision.action === 'learn-tool' && decision.toolName) {
    try { addLearnedTool(cwd, decision.toolName); } catch { /* best effort */ }
  } else if (decision.action === 'learn-bash-prefix' && decision.prefix) {
    try { addLearnedBashPrefix(cwd, decision.prefix); } catch { /* best effort */ }
  }
  // 'noop' and 'veto-skip' fall through with no persistence side effect.

  console.log(SILENT);
}

main().catch(() => {
  console.log(SILENT);
});
