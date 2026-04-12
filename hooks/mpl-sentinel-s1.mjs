#!/usr/bin/env node
/**
 * MPL Sentinel S1 — Export Manifest Symbol Validator (PostToolUse)
 *
 * Validates that Phase Runner's export-manifest.json symbols exist in actual files.
 * Runs after Phase Runner completes to catch phantom exports before Test Agent runs.
 *
 * Channel Registry entry #9: export-manifest.json (Phase Runner → Test Agent, Sentinels)
 */

import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync, readdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import shared MPL state utility
const { isMplActive, readState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);

// Import shared stdin reader
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

/**
 * Symbol patterns supported for grep matching.
 * Covers JS/TS (export function/class/const/default), Python (def), Rust (pub fn).
 */
const SYMBOL_PATTERNS = [
  // JS/TS: export function X, export async function X
  (name) => new RegExp(`\\bexport\\s+(async\\s+)?function\\s+${escapeRegex(name)}\\b`),
  // JS/TS: export class X
  (name) => new RegExp(`\\bexport\\s+class\\s+${escapeRegex(name)}\\b`),
  // JS/TS: export const X, export let X, export var X
  (name) => new RegExp(`\\bexport\\s+(const|let|var)\\s+${escapeRegex(name)}\\b`),
  // JS/TS: export default (only matches when symbol is "default")
  (name) => name === 'default' ? new RegExp(`\\bexport\\s+default\\b`) : null,
  // JS/TS: export { X } or export { X as Y } (named re-exports)
  (name) => new RegExp(`\\bexport\\s*\\{[^}]*\\b${escapeRegex(name)}\\b[^}]*\\}`),
  // Python: def X
  (name) => new RegExp(`\\bdef\\s+${escapeRegex(name)}\\b`),
  // Python: class X
  (name) => new RegExp(`\\bclass\\s+${escapeRegex(name)}\\b`),
  // Rust: pub fn X
  (name) => new RegExp(`\\bpub\\s+fn\\s+${escapeRegex(name)}\\b`),
  // Rust: pub struct X, pub enum X, pub type X
  (name) => new RegExp(`\\bpub\\s+(struct|enum|type)\\s+${escapeRegex(name)}\\b`),
];

/**
 * Escape special regex characters in a string.
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if a symbol name exists in file content using supported patterns.
 * @param {string} symbolName - Symbol to search for
 * @param {string} content - File content to search in
 * @returns {boolean}
 */
export function symbolExistsInContent(symbolName, content) {
  for (const patternFn of SYMBOL_PATTERNS) {
    const regex = patternFn(symbolName);
    if (regex && regex.test(content)) {
      return true;
    }
  }
  return false;
}

/**
 * Find the phase directory for the current phase.
 * Checks .mpl/mpl/phases/{phase_id}/ for export-manifest.json.
 * @param {string} cwd - Working directory
 * @param {string} currentPhase - Current phase from state (e.g., "phase2-sprint")
 * @returns {string[]} List of phase directory paths that contain export-manifest.json
 */
export function findManifestPaths(cwd) {
  const phasesDir = join(cwd, '.mpl', 'mpl', 'phases');
  if (!existsSync(phasesDir)) return [];

  const manifests = [];
  try {
    const entries = readdirSync(phasesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(phasesDir, entry.name, 'export-manifest.json');
      if (existsSync(manifestPath)) {
        manifests.push(manifestPath);
      }
    }
  } catch {
    // Directory read failure: return empty
  }
  return manifests;
}

/**
 * Validate a single export-manifest.json file.
 * @param {string} manifestPath - Absolute path to export-manifest.json
 * @param {string} cwd - Working directory for resolving relative paths
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateManifest(manifestPath, cwd) {
  const errors = [];

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    return { valid: false, errors: [`Failed to parse ${manifestPath}: ${e.message}`] };
  }

  const exports = manifest.exports;
  if (!Array.isArray(exports)) {
    // No exports array: nothing to validate
    return { valid: true, errors: [] };
  }

  for (const entry of exports) {
    const filePath = entry.file || entry.path;
    if (!filePath) {
      errors.push(`Export entry missing "file" field in ${manifestPath}`);
      continue;
    }

    // Resolve relative paths against cwd
    const resolvedPath = resolve(cwd, filePath);

    // Check file exists
    if (!existsSync(resolvedPath)) {
      errors.push(`File not found: ${filePath} (resolved: ${resolvedPath})`);
      continue;
    }

    // Check each symbol in the file
    const symbols = entry.symbols;
    if (!Array.isArray(symbols) || symbols.length === 0) {
      continue; // No symbols to check
    }

    let content;
    try {
      content = readFileSync(resolvedPath, 'utf-8');
    } catch {
      errors.push(`Cannot read file: ${filePath}`);
      continue;
    }

    for (const symbol of symbols) {
      const symbolName = typeof symbol === 'string' ? symbol : symbol.name || symbol.symbol;
      if (!symbolName) continue;

      if (!symbolExistsInContent(symbolName, content)) {
        errors.push(`Symbol "${symbolName}" not found in ${filePath}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
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

  // Only intercept Task/Agent tool completions
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

  // Find all export-manifest.json files in phase directories
  const manifestPaths = findManifestPaths(cwd);

  // Skip if no export-manifest.json found (not all phases produce one)
  if (manifestPaths.length === 0) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Validate all manifests
  const allErrors = [];
  for (const manifestPath of manifestPaths) {
    const { errors } = validateManifest(manifestPath, cwd);
    allErrors.push(...errors);
  }

  if (allErrors.length === 0) {
    // All symbols verified
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Validation failed: output system-reminder with missing symbols/files
  const errorList = allErrors.map(e => `  - ${e}`).join('\n');
  const message = `[MPL SENTINEL S1] Export manifest validation failed.

The following symbols/files declared in export-manifest.json could not be verified:
${errorList}

ACTION REQUIRED: Phase Runner must fix missing exports before Test Agent runs.
Either create the missing symbols or update export-manifest.json to match actual exports.`;

  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: message
    }
  }));
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
});
