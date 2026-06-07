#!/usr/bin/env node
/**
 * MPL Phase Seed Validation Hook (PostToolUse)
 *
 * Thin stdin/stdout shim over
 * `hooks/lib/policy/schemas.mjs::handleSeedSchema` (Move #11). The policy
 * module owns the YAML schema check and the #238 ambiguity-notes
 * quality-signal side effect. This wrapper preserves the legacy stdout
 * shape: advisory system-reminders never block, so it always emits
 * `continue: true` with `suppressOutput: false` + additionalContext when
 * the policy returns an advisory.
 *
 * Original implementation: hooks/mpl-validate-seed.legacy.mjs
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

const {
  handle: schemasHandle,
  validateSeed,
  validateTodoSchedulingFields,
  extractYaml,
  hasYamlField,
  hasNonEmptyArray,
  hasNonEmptyString,
  extractMappingKeys,
  validateMappingValues,
  hasContractFilesContext,
  isSeedRelated,
  SEED_PATH_RE,
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

  const decision = schemasHandle('seed_schema', {
    toolName,
    toolInput,
    toolResponse,
    cwd,
    mplActive,
  });

  if (decision.action === 'noop' || decision.action === 'allow') {
    ok();
    return;
  }

  // advisory — never blocks. Surface via hookSpecificOutput.additionalContext.
  console.log(JSON.stringify({
    continue: true,
    suppressOutput: false,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: decision.additionalContext || decision.reason,
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
    // Fail-open on error — preserves legacy behaviour.
    ok();
  }
}

// Re-export legacy symbols so existing tests keep passing.
export {
  validateSeed,
  validateTodoSchedulingFields,
  extractYaml,
  hasYamlField,
  hasNonEmptyArray,
  hasNonEmptyString,
  extractMappingKeys,
  validateMappingValues,
  hasContractFilesContext,
  isSeedRelated,
  SEED_PATH_RE,
};
