#!/usr/bin/env node
/**
 * MPL Sentinel S0 — Seed Fact-Check (SNT-S0)
 *
 * PostToolUse hook that validates Phase Seed contract_snippet keys against
 * actual contract JSON files (.mpl/contracts/*.json).
 *
 * Catches hallucinated keys: keys that the Seed Generator claims exist in a
 * contract but are not actually present in the SSOT contract registry (CB-08 L0).
 *
 * Validation rules:
 *   - Each key in contract_snippet.inbound must exist in contract JSON `.params`
 *   - Each key in contract_snippet.outbound must exist in contract JSON `.returns`
 *   - If no contract_snippet in seed output: skip (single-layer phase)
 *
 * Output:
 *   - Hallucinated keys found: system-reminder warning, continue=true, suppressOutput=false
 *   - All keys valid: continue=true, suppressOutput=true
 */

import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
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

/**
 * Extract contract_snippet keys from Phase Seed YAML text using regex.
 * Parses the YAML-like structure to find inbound/outbound key names.
 *
 * Expected YAML structure:
 *   contract_snippet:
 *     inbound:
 *       key_name: "type_string"
 *     outbound:
 *       key_name: "type_string"
 *     contract_ref: ".mpl/contracts/foo.json"
 *
 * @param {string} yamlText - Phase Seed YAML output text
 * @returns {{ inbound: string[], outbound: string[], contractRef: string|null }}
 */
export function extractContractSnippet(yamlText) {
  const result = { inbound: [], outbound: [], contractRef: null };
  if (!yamlText) return result;

  // Check if contract_snippet exists and is not null
  const snippetMatch = yamlText.match(/contract_snippet\s*:\s*\n([\s\S]*?)(?=\n\s{0,6}\w+:|$)/);
  if (!snippetMatch) return result;

  const snippetBlock = snippetMatch[1];

  // Check for explicit null
  if (/contract_snippet\s*:\s*null/i.test(yamlText)) return result;

  // Extract contract_ref
  const refMatch = snippetBlock.match(/contract_ref\s*:\s*["']?([^\s"'\n]+)["']?/);
  if (refMatch) {
    result.contractRef = refMatch[1] === 'null' ? null : refMatch[1];
  }

  // Extract inbound keys
  const inboundMatch = snippetBlock.match(/inbound\s*:\s*\n((?:\s+\w[^\n]*\n)*)/);
  if (inboundMatch && !/inbound\s*:\s*null/i.test(snippetBlock)) {
    const inboundBlock = inboundMatch[1];
    const keyPattern = /^\s+(\w[\w_]*)\s*:/gm;
    let m;
    while ((m = keyPattern.exec(inboundBlock)) !== null) {
      // Skip sub-section keywords
      if (m[1] !== 'outbound' && m[1] !== 'contract_ref') {
        result.inbound.push(m[1]);
      }
    }
  }

  // Extract outbound keys
  const outboundMatch = snippetBlock.match(/outbound\s*:\s*\n((?:\s+\w[^\n]*\n)*)/);
  if (outboundMatch && !/outbound\s*:\s*null/i.test(snippetBlock)) {
    const outboundBlock = outboundMatch[1];
    const keyPattern = /^\s+(\w[\w_]*)\s*:/gm;
    let m;
    while ((m = keyPattern.exec(outboundBlock)) !== null) {
      if (m[1] !== 'contract_ref') {
        result.outbound.push(m[1]);
      }
    }
  }

  return result;
}

/**
 * Load and parse a contract JSON file.
 * @param {string} cwd - Working directory
 * @param {string} contractPath - Relative or absolute path to contract JSON
 * @returns {{ params: string[], returns: string[] } | null}
 */
export function loadContract(cwd, contractPath) {
  if (!contractPath) return null;

  try {
    const fullPath = contractPath.startsWith('/')
      ? contractPath
      : resolve(cwd, contractPath);
    const raw = readFileSync(fullPath, 'utf-8');
    const contract = JSON.parse(raw);

    const params = contract.params ? Object.keys(contract.params) : [];
    const returns = contract.returns ? Object.keys(contract.returns) : [];

    return { params, returns };
  } catch {
    return null;
  }
}

/**
 * Validate contract_snippet keys against actual contract JSON.
 * @param {string[]} snippetKeys - Keys from contract_snippet (inbound or outbound)
 * @param {string[]} contractKeys - Keys from contract JSON (params or returns)
 * @returns {string[]} - Hallucinated keys (in snippet but not in contract)
 */
export function findHallucinatedKeys(snippetKeys, contractKeys) {
  if (!snippetKeys || snippetKeys.length === 0) return [];
  if (!contractKeys) return [...snippetKeys]; // all hallucinated if contract has no keys

  const contractSet = new Set(contractKeys);
  return snippetKeys.filter(key => !contractSet.has(key));
}

/**
 * Build the warning message for hallucinated keys.
 * @param {string[]} inboundMissing - Hallucinated inbound keys
 * @param {string[]} outboundMissing - Hallucinated outbound keys
 * @param {string} contractRef - Contract file path
 * @returns {string}
 */
export function buildWarningMessage(inboundMissing, outboundMissing, contractRef) {
  const parts = [];

  if (inboundMissing.length > 0) {
    parts.push(`inbound keys {${inboundMissing.join(', ')}} not in contract ${contractRef} .params`);
  }
  if (outboundMissing.length > 0) {
    parts.push(`outbound keys {${outboundMissing.join(', ')}} not in contract ${contractRef} .returns`);
  }

  return `SEED HALLUCINATION: ${parts.join('; ')}`;
}

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

  // Only intercept Task/Agent completions (Seed Generator output)
  if (!['Task', 'task', 'Agent', 'agent'].includes(toolName)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Check if MPL is active
  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Only validate seed generator output
  const toolInput = data.tool_input || data.toolInput || {};
  const agentType = toolInput.subagent_type || toolInput.subagentType || '';
  if (agentType !== 'mpl-phase-seed-generator') {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Extract response text
  const toolResponse = data.tool_response || data.toolResponse || '';
  const responseText = typeof toolResponse === 'string'
    ? toolResponse
    : JSON.stringify(toolResponse);

  // Extract contract_snippet from seed YAML output
  const snippet = extractContractSnippet(responseText);

  // Skip if no contract_snippet (single-layer phase)
  if (!snippet.contractRef && snippet.inbound.length === 0 && snippet.outbound.length === 0) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Skip if no contract_ref to validate against
  if (!snippet.contractRef) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Load the contract JSON
  const contract = loadContract(cwd, snippet.contractRef);
  if (!contract) {
    // Contract file not found or invalid — warn but don't block
    const message = `SEED HALLUCINATION: contract_ref "${snippet.contractRef}" not found or invalid. Cannot verify contract_snippet keys.`;
    console.log(JSON.stringify({
      continue: true,
      suppressOutput: false,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `<system-reminder>\n${message}\n</system-reminder>`
      }
    }));
    return;
  }

  // Compare: snippet keys vs contract keys
  const inboundMissing = findHallucinatedKeys(snippet.inbound, contract.params);
  const outboundMissing = findHallucinatedKeys(snippet.outbound, contract.returns);

  if (inboundMissing.length === 0 && outboundMissing.length === 0) {
    // All keys valid
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Hallucinated keys found — warn via system-reminder
  const warning = buildWarningMessage(inboundMissing, outboundMissing, snippet.contractRef);
  console.log(JSON.stringify({
    continue: true,
    suppressOutput: false,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `<system-reminder>\n${warning}\n</system-reminder>`
    }
  }));
}

main().catch(() => {
  // Fail-open: don't block pipeline on sentinel errors
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
});

export { extractContractSnippet as _extractContractSnippet };
