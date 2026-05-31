#!/usr/bin/env node
/**
 * MPL Bash Timeout Hook (PreToolUse on Bash)
 *
 * Thin stdin/stdout shim over `hooks/lib/policy/permit.mjs::handleBashTimeout`
 * (Move #10). The policy module wraps `decideTimeout()` +
 * `resolveRuleAction('bash_timeout_violation')` verbatim.
 *
 * Original implementation: hooks/mpl-bash-timeout.legacy.mjs
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

const { handleBashTimeout } = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'permit.mjs')).href
);

function silent() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

async function main() {
  const input = await readStdin();

  let data;
  try { data = JSON.parse(input); } catch { return silent(); }

  const toolName = data.tool_name || data.toolName || '';
  const cwd = data.cwd || data.directory || process.cwd();
  const toolInput = data.tool_input || data.toolInput || {};

  const decision = handleBashTimeout({ cwd, toolName, toolInput });

  if (decision.action === 'silent') return silent();
  if (decision.action === 'block') {
    console.log(JSON.stringify({
      decision: 'block',
      reason: decision.reason,
    }));
    return;
  }
  // warn
  console.log(JSON.stringify({
    continue: true,
    systemMessage: decision.reason,
  }));
}

await main().catch(() => silent());
