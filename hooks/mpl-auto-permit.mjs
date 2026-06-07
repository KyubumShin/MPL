#!/usr/bin/env node
/**
 * MPL Auto-Permission Hook (PreToolUse)
 *
 * Thin stdin/stdout shim over `hooks/lib/policy/permit.mjs::handleAutoPermit`
 * (Move #10). The policy module owns the entire decision graph including the
 * new layered Bash veto pipeline + `permit.unknown_bash` knob (closes the
 * verbatim L160-162 `decision: 'approve'` fail-open).
 *
 * Constants `ALWAYS_SAFE_TOOLS`, `DEFER_TOOLS`, `SAFE_BASH_PREFIXES`, and
 * `DANGEROUS_BASH_PATTERNS` are re-exported from the policy module for
 * back-compat with `mpl-permit-learner.mjs`'s dynamic import shape.
 *
 * Original implementation: hooks/mpl-auto-permit.legacy.mjs
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

const {
  handleAutoPermit,
  ALWAYS_SAFE_TOOLS,
  DEFER_TOOLS,
  SAFE_BASH_PREFIXES,
  DANGEROUS_BASH_PATTERNS,
} = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'permit.mjs')).href
);

// Re-export legacy symbols verbatim — `mpl-permit-learner.mjs` (legacy snapshot)
// dynamically imports them from this file path.
export { ALWAYS_SAFE_TOOLS, DEFER_TOOLS, SAFE_BASH_PREFIXES, DANGEROUS_BASH_PATTERNS };

async function main() {
  const input = await readStdin();

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({}));
    return;
  }

  const toolName = data.tool_name || data.toolName || '';
  const cwd = data.cwd || data.directory || process.cwd();
  const toolInput = data.tool_input || data.toolInput || {};

  const decision = handleAutoPermit({ cwd, toolName, toolInput });

  if (decision.action === 'approve') {
    console.log(JSON.stringify({ decision: 'approve' }));
    return;
  }
  if (decision.action === 'block') {
    console.log(JSON.stringify({
      decision: 'block',
      reason: decision.reason || '[MPL Permit] blocked',
    }));
    return;
  }
  // pass-through (default): emit empty envelope so Claude Code prompts the user.
  console.log(JSON.stringify({}));
}

main().catch(() => {
  // On error: pass through (fail-open at the wrapper level — the policy
  // module's veto pipeline closes the productivity fail-open inside the
  // happy path; this only handles truly unexpected wrapper crashes).
  console.log(JSON.stringify({}));
});
