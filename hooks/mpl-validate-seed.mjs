#!/usr/bin/env node
/**
 * MPL Phase Seed Validation Hook (PostToolUse)
 *
 * Validates Phase Seed YAML output from mpl-phase-seed-generator.
 * Ensures required fields exist and, for boundary phases, validates
 * contract_snippet structure.
 *
 * Based on: SEED-03 — Seed Schema Validation Hook
 *
 * Activation: tool_name === "Task" && agent === "mpl-phase-seed-generator"
 * On failure: continue=true, suppressOutput=false + system-reminder with missing fields
 * On success: continue=true, suppressOutput=true
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import shared MPL state utility
const { isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);

// Import shared stdin reader
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

// ---------------------------------------------------------------------------
// YAML extraction (regex-based, no external parser — MPL minimal deps)
// ---------------------------------------------------------------------------

/**
 * Extract YAML content from markdown-fenced code block.
 * Looks for ```yaml ... ``` and returns the inner text.
 * @param {string} text - Full response text
 * @returns {string|null} Raw YAML string or null if not found
 */
export function extractYaml(text) {
  // Match ```yaml or ```yml fenced blocks
  const match = text.match(/```ya?ml\s*\n([\s\S]*?)```/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Lightweight YAML field presence checks (regex-based)
// ---------------------------------------------------------------------------

/**
 * Check whether a top-level or nested YAML key is present and non-empty.
 * Uses indentation-aware regex to handle nested keys.
 *
 * @param {string} yaml - Raw YAML string
 * @param {string} keyPath - Dot-separated path, e.g. "phase_seed.goal"
 * @returns {boolean}
 */
export function hasYamlField(yaml, keyPath) {
  const parts = keyPath.split('.');
  // Build a regex that checks for the key at the expected indentation
  // e.g. "phase_seed.goal" → look for "goal:" under "phase_seed:"
  const leaf = parts[parts.length - 1];

  // For simple presence: just check the leaf key exists with a non-empty value
  // The key should appear as "key:" followed by something meaningful
  const keyRegex = new RegExp(`^[ \\t]*${escapeRegex(leaf)}\\s*:`, 'm');
  return keyRegex.test(yaml);
}

/**
 * Check whether a YAML key has a non-empty array value (at least one "- " child).
 * @param {string} yaml - Raw YAML string
 * @param {string} key - Leaf key name, e.g. "acceptance_criteria"
 * @returns {boolean}
 */
export function hasNonEmptyArray(yaml, key) {
  // Find the key line, then check subsequent indented lines for array items
  const regex = new RegExp(
    `^([ \\t]*)${escapeRegex(key)}\\s*:\\s*\\n((?:\\1[ \\t]+.*\\n?)*)`,
    'm'
  );
  const match = yaml.match(regex);
  if (!match) return false;
  const block = match[2];
  // At least one array item indicator
  return /^\s+-\s+/m.test(block) || /^\s+-\s*$/m.test(block);
}

/**
 * Check whether a YAML key has a non-empty scalar string value (not null, not empty).
 * @param {string} yaml - Raw YAML string
 * @param {string} key - Leaf key name, e.g. "goal"
 * @returns {boolean}
 */
export function hasNonEmptyString(yaml, key) {
  const regex = new RegExp(
    `^[ \\t]*${escapeRegex(key)}\\s*:\\s*(.+)$`,
    'm'
  );
  const match = yaml.match(regex);
  if (!match) return false;
  const value = match[1].trim();
  // Reject null, empty, and bare quotes
  if (!value || value === 'null' || value === '~' || value === '""' || value === "''") {
    return false;
  }
  return true;
}

/**
 * Extract keys under a YAML mapping block (one level deep).
 * Used for contract_snippet.inbound / .outbound parsing.
 * @param {string} yaml - Raw YAML string
 * @param {string} parentKey - Parent key name, e.g. "inbound"
 * @returns {string[]} Array of child key names
 */
export function extractMappingKeys(yaml, parentKey) {
  const regex = new RegExp(
    `^([ \\t]*)${escapeRegex(parentKey)}\\s*:\\s*\\n((?:\\1[ \\t]+.*\\n?)*)`,
    'm'
  );
  const match = yaml.match(regex);
  if (!match) return [];
  const block = match[2];
  const keys = [];
  const keyRegex = /^[ \t]+(\w[\w_-]*)\s*:\s*(.+)$/gm;
  let m;
  while ((m = keyRegex.exec(block)) !== null) {
    keys.push(m[1]);
  }
  return keys;
}

/**
 * Check whether mapping children have string type values.
 * @param {string} yaml - Raw YAML string
 * @param {string} parentKey - Parent key name
 * @returns {{ valid: boolean, invalidKeys: string[] }}
 */
export function validateMappingValues(yaml, parentKey) {
  const regex = new RegExp(
    `^([ \\t]*)${escapeRegex(parentKey)}\\s*:\\s*\\n((?:\\1[ \\t]+.*\\n?)*)`,
    'm'
  );
  const match = yaml.match(regex);
  if (!match) return { valid: true, invalidKeys: [] };
  const block = match[2];
  const invalidKeys = [];
  const keyRegex = /^[ \t]+(\w[\w_-]*)\s*:\s*(.*)$/gm;
  let m;
  while ((m = keyRegex.exec(block)) !== null) {
    const value = m[2].trim();
    // Value must be a non-empty string (quoted or unquoted)
    if (!value || value === 'null' || value === '~') {
      invalidKeys.push(m[1]);
    }
  }
  return { valid: invalidKeys.length === 0, invalidKeys };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Core validation
// ---------------------------------------------------------------------------

/**
 * Validate Phase Seed YAML against required schema.
 *
 * @param {string} yamlText - Raw YAML content (already extracted from fences)
 * @param {{ hasContractFiles: boolean }} options - Context flags
 * @returns {{ valid: boolean, missing: string[], warnings: string[] }}
 */
export function validateSeed(yamlText, options = {}) {
  const missing = [];
  const warnings = [];

  // --- Required fields ---

  // 1. phase_seed.goal — non-empty string
  if (!hasNonEmptyString(yamlText, 'goal')) {
    missing.push('phase_seed.goal');
  }

  // 2. phase_seed.acceptance_criteria — non-empty array
  if (!hasNonEmptyArray(yamlText, 'acceptance_criteria')) {
    missing.push('phase_seed.acceptance_criteria');
  }

  // 3. phase_seed.mini_plan_seed.todo_structure — non-empty array
  if (!hasNonEmptyArray(yamlText, 'todo_structure')) {
    missing.push('phase_seed.mini_plan_seed.todo_structure');
  }

  // 4. phase_seed.exit_conditions — non-empty array
  if (!hasNonEmptyArray(yamlText, 'exit_conditions')) {
    missing.push('phase_seed.exit_conditions');
  }

  // --- Boundary phase contract validation ---
  if (options.hasContractFiles) {
    // contract_snippet must exist
    if (!hasYamlField(yamlText, 'phase_seed.contract_snippet')) {
      missing.push('phase_seed.contract_snippet');
    } else {
      // At least one of inbound/outbound must have keys
      const inboundKeys = extractMappingKeys(yamlText, 'inbound');
      const outboundKeys = extractMappingKeys(yamlText, 'outbound');

      if (inboundKeys.length === 0 && outboundKeys.length === 0) {
        missing.push('phase_seed.contract_snippet.inbound|outbound (at least one must have keys)');
      }

      // Each key must have a string type value
      const inboundValidation = validateMappingValues(yamlText, 'inbound');
      if (!inboundValidation.valid) {
        warnings.push(`contract_snippet.inbound: non-string values for keys: ${inboundValidation.invalidKeys.join(', ')}`);
      }

      const outboundValidation = validateMappingValues(yamlText, 'outbound');
      if (!outboundValidation.valid) {
        warnings.push(`contract_snippet.outbound: non-string values for keys: ${outboundValidation.invalidKeys.join(', ')}`);
      }
    }
  }

  return {
    valid: missing.length === 0 && warnings.length === 0,
    missing,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Detect whether contract_files context was provided in the Task prompt
// ---------------------------------------------------------------------------

/**
 * Heuristic check: did the orchestrator provide contract_files context?
 * Looks for the string "contract_files" in the Task tool input prompt.
 * @param {string} promptText - The Task tool input prompt
 * @returns {boolean}
 */
export function hasContractFilesContext(promptText) {
  if (!promptText) return false;
  // Check for explicit contract_files mention (not just "contract" generically)
  return /contract_files\s*[:=]/.test(promptText) ||
    /contract_files.*\[/.test(promptText) ||
    /\.mpl\/contracts\//.test(promptText);
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdin();

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const toolName = data.tool_name || data.toolName || '';

  // Only intercept Task tool completions
  if (!['Task', 'task'].includes(toolName)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Only activate for mpl-phase-seed-generator agent
  const toolInput = data.tool_input || data.toolInput || {};
  const agentType = toolInput.subagent_type || toolInput.subagentType || '';

  if (agentType !== 'mpl-phase-seed-generator') {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Check if MPL is active
  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Extract response text
  const toolResponse = data.tool_response || data.toolResponse || '';
  const responseText = typeof toolResponse === 'string'
    ? toolResponse
    : JSON.stringify(toolResponse);

  // Extract YAML from fenced block
  const yamlText = extractYaml(responseText);

  if (!yamlText) {
    // No YAML block found — validation failure
    const message = `<system-reminder>
[MPL SEED VALIDATION FAILED] mpl-phase-seed-generator output does not contain a YAML block.

Expected output format: \`\`\`yaml ... \`\`\` fenced block containing phase_seed specification.

Missing: entire YAML output

ACTION REQUIRED: Re-run mpl-phase-seed-generator with clarified instructions.
Do NOT proceed to Phase Runner until a valid Phase Seed is produced.
</system-reminder>`;

    console.log(JSON.stringify({
      continue: true,
      suppressOutput: false,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: message,
      },
    }));
    return;
  }

  // Detect boundary phase context
  const promptText = toolInput.prompt || toolInput.description || '';
  const hasContracts = hasContractFilesContext(promptText);

  // Validate seed
  const result = validateSeed(yamlText, { hasContractFiles: hasContracts });

  if (result.valid) {
    // All checks passed
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Build failure message
  const issues = [];
  if (result.missing.length > 0) {
    issues.push(`Missing required fields:\n${result.missing.map(f => `  - ${f}`).join('\n')}`);
  }
  if (result.warnings.length > 0) {
    issues.push(`Validation warnings:\n${result.warnings.map(w => `  - ${w}`).join('\n')}`);
  }

  const message = `<system-reminder>
[MPL SEED VALIDATION FAILED] mpl-phase-seed-generator output failed schema validation.

${issues.join('\n\n')}

ACTION REQUIRED: Re-run mpl-phase-seed-generator targeting the missing/invalid fields.
Do NOT proceed to Phase Runner until all required Seed fields are present and valid.
</system-reminder>`;

  console.log(JSON.stringify({
    continue: true,
    suppressOutput: false,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: message,
    },
  }));
}

main().catch(() => {
  // On error: allow (fail-open for safety)
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
});
