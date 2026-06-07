#!/usr/bin/env node
/**
 * MPL Output Validation Hook (PostToolUse Task|Agent)
 *
 * Thin stdin/stdout shim over
 * `hooks/lib/policy/schemas.mjs::handleAgentOutputSchema` (Move #11). The
 * policy module owns the VALIDATE_AGENTS / EXPECTED_SECTIONS denylist and
 * the telemetry side effects (trackTokenUsage + logPhaseProfile). The
 * wrapper translates the decision envelope back to the legacy stdout shape:
 *
 *   - allow:  { continue: true,  suppressOutput: true }
 *           — when the agent isn't in VALIDATE_AGENTS the legacy hook
 *             stayed silent; we preserve that.
 *           — when the agent IS in VALIDATE_AGENTS and passes, the legacy
 *             hook emitted { continue: true, hookSpecificOutput.additionalContext:
 *             "[MPL VALIDATION PASSED] …" }; we preserve that too.
 *   - block: { continue: false, hookSpecificOutput.additionalContext: <reason> }
 *
 * Original implementation: hooks/mpl-validate-output.legacy.mjs
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

const {
  handle: schemasHandle,
  validateSections,
  formatValidationMessage,
  VALIDATE_AGENTS,
  EXPECTED_SECTIONS,
} = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'schemas.mjs')).href
);

const { isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

async function runHook(stdinPayload) {
  if (!stdinPayload) { ok(); return; }

  let data;
  try {
    data = JSON.parse(stdinPayload);
  } catch {
    ok();
    return;
  }

  const toolName = data.tool_name || data.toolName || '';
  const toolInput = data.tool_input || data.toolInput || {};
  const toolResponse = data.tool_response || data.toolResponse || '';
  const cwd = data.cwd || data.directory || process.cwd();
  const mplActive = isMplActive(cwd);

  const decision = schemasHandle('agent_output_schema', {
    toolName,
    toolInput,
    toolResponse,
    cwd,
    mplActive,
  });

  if (decision.action === 'noop') {
    ok();
    return;
  }

  if (decision.action === 'allow') {
    // The legacy hook emitted a [MPL VALIDATION PASSED] additionalContext
    // ONLY when the agent was in VALIDATE_AGENTS. For other Tasks the
    // hook stayed silent. We detect via the rule id.
    if (decision.ruleId === 'agent_output_sections_ok') {
      const agentType =
        (toolInput && (toolInput.subagent_type || toolInput.subagentType)) || '';
      const sections = EXPECTED_SECTIONS[agentType] || [];
      const message =
        `[MPL VALIDATION PASSED] Agent "${agentType}" output contains all ${sections.length} required sections.`;
      console.log(JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: message,
        },
      }));
      return;
    }
    ok();
    return;
  }

  // block — preserve legacy stdout shape: `continue: false` +
  // additionalContext text.
  console.log(JSON.stringify({
    continue: false,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: decision.reason,
    },
  }));
}

if (isMain) {
  const { readStdin } = await import(
    pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
  );
  try {
    const raw = await readStdin();
    await runHook(raw);
  } catch {
    ok();
  }
}

// Re-export legacy symbols so existing tests keep passing.
export {
  VALIDATE_AGENTS,
  EXPECTED_SECTIONS,
  validateSections,
  formatValidationMessage,
};
