#!/usr/bin/env node
/**
 * MPL Phase Seed Validation Hook (PostToolUse)
 *
 * Validates Phase Seed YAML structure when a seed file is written.
 * Seeds are now generated inline by the orchestrator (not by a separate agent).
 * Ensures required fields exist and, for boundary phases, validates
 * contract_snippet structure.
 *
 * Based on: SEED-03 — Seed Schema Validation Hook
 *
 * Activation: tool_name is a file-write tool targeting a seed YAML path,
 *             OR tool_name === "Task"/"Agent" with seed YAML in output
 * On failure: continue=true, suppressOutput=false + system-reminder with missing fields
 * On success: continue=true, suppressOutput=true
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

// Import shared MPL state utility
const { isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);

// Import shared stdin reader
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { collectFileWrites, isFileWriteTool } = await import(
  pathToFileURL(join(__dirname, 'lib', 'tool-input.mjs')).href
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

function countIndent(line) {
  return (line.match(/^[ \t]*/) || [''])[0].length;
}

function extractTodoStructureBlocks(yaml) {
  const blocks = [];
  const lines = String(yaml || '').split('\n').map((line) => line.replace(/\r$/, ''));

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^([ \t]*)todo_structure\s*:\s*(.*)$/);
    if (!match) continue;

    const baseIndent = match[1].length;
    const inline = match[2].trim();
    const blockLines = [];
    if (inline) blockLines.push(inline);

    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() && countIndent(line) <= baseIndent) break;
      blockLines.push(line);
    }

    blocks.push(blockLines.join('\n'));
  }

  return blocks;
}

function splitTodoItems(block) {
  const items = [];
  let current = null;

  for (const line of String(block || '').split('\n')) {
    if (/^[ \t]*-\s+(?:id\s*:|\{)/.test(line)) {
      if (current) items.push(current.join('\n'));
      current = [line];
      continue;
    }
    if (current) current.push(line);
  }
  if (current) items.push(current.join('\n'));

  return items;
}

function hasTodoField(item, key) {
  const escaped = escapeRegex(key);
  return new RegExp(`(^|[\\s,{])${escaped}\\s*:`, 'm').test(String(item || ''));
}

function extractTodoId(item, index) {
  const match = String(item || '').match(/(^|[\s,{])id\s*:\s*["']?([^"',}\]\s]+)/m);
  return match ? match[2] : `#${index + 1}`;
}

export function validateTodoSchedulingFields(yamlText) {
  const missing = [];
  const blocks = extractTodoStructureBlocks(yamlText);

  for (const block of blocks) {
    const items = splitTodoItems(block);
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const todoId = extractTodoId(item, index);
      for (const field of ['depends_on', 'files_to_modify', 'resource_locks']) {
        if (!hasTodoField(item, field)) {
          missing.push(`phase_seed.mini_plan_seed.todo_structure[${todoId}].${field}`);
        }
      }
    }
  }

  return missing;
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

  missing.push(...validateTodoSchedulingFields(yamlText));

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
// Seed file path detection
// ---------------------------------------------------------------------------

/**
 * Seed file path patterns:
 * - Legacy: .mpl/seeds/*.yaml
 * - Inline phase seed: .mpl/mpl/phases/{phase_id}/phase-seed.yaml
 * - Chain seed: .mpl/mpl/chains/{chain_id}/chain-seed.yaml
 */
const SEED_PATH_RE = /(?:^|\/)\.mpl\/(?:seeds\/[^/]+|mpl\/phases\/[^/]+\/phase-seed|mpl\/chains\/[^/]+\/chain-seed)\.ya?ml$/;

/**
 * Check whether a tool invocation is related to seed generation/writing.
 * Matches:
 *   1. File-write tools (Write, Edit, MultiEdit) targeting a seed YAML path
 *   2. Task/Agent completions whose output contains phase_seed YAML
 * @param {string} toolName
 * @param {object} toolInput
 * @param {string} responseText
 * @returns {boolean}
 */
export function isSeedRelated(toolName, toolInput, responseText) {
  // Case 1: Direct file write to seed path
  if (isFileWriteTool(toolName)) {
    if (collectFileWrites(toolInput).some((entry) => SEED_PATH_RE.test(entry.filePath))) return true;
  }

  // Case 2: Task/Agent output containing phase_seed YAML
  if (['Task', 'task', 'Agent', 'agent'].includes(toolName)) {
    if (responseText && /phase_seed\s*:/.test(responseText) && /```ya?ml/i.test(responseText)) {
      return true;
    }
  }

  return false;
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
  const toolInput = data.tool_input || data.toolInput || {};

  // Extract response text
  const toolResponse = data.tool_response || data.toolResponse || '';
  const responseText = typeof toolResponse === 'string'
    ? toolResponse
    : JSON.stringify(toolResponse);

  // Only activate for seed-related tool invocations
  if (!isSeedRelated(toolName, toolInput, responseText)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Check if MPL is active
  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // For file-write tools, the content is in toolInput; for Task tools, in response
  let textToValidate = responseText;
  if (isFileWriteTool(toolName)) {
    const seedTexts = collectFileWrites(toolInput)
      .filter((entry) => SEED_PATH_RE.test(entry.filePath))
      .map((entry) => entry.text)
      .filter(Boolean);
    textToValidate = seedTexts.join('\n') || responseText;
    // Wrap in yaml fence for extractYaml if raw YAML
    if (textToValidate && !textToValidate.includes('```yaml')) {
      textToValidate = '```yaml\n' + textToValidate + '\n```';
    }
  }

  // Extract YAML from fenced block
  const yamlText = extractYaml(textToValidate);

  if (!yamlText) {
    // No YAML block found — validation failure
    const message = `<system-reminder>
[MPL SEED VALIDATION FAILED] Seed output does not contain a YAML block.

Expected output format: \`\`\`yaml ... \`\`\` fenced block containing phase_seed specification.

Missing: entire YAML output

ACTION REQUIRED: Regenerate the Phase Seed with valid YAML structure.
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
[MPL SEED VALIDATION FAILED] Phase Seed output failed schema validation.

${issues.join('\n\n')}

ACTION REQUIRED: Regenerate the Phase Seed targeting the missing/invalid fields.
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

if (isMain) {
  main().catch(() => {
    // On error: allow (fail-open for safety)
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  });
}
