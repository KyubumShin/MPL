#!/usr/bin/env node
/**
 * MPL Decomposition Parser (T-01 Phase 2, v3.9)
 *
 * Parses decomposition.yaml to extract per-phase file scopes.
 * Used by mpl-write-guard to enforce phase-scoped file locks.
 *
 * Uses regex-based YAML parsing (consistent with mpl-scope-scan.mjs pattern)
 * rather than a full YAML parser to avoid external dependencies.
 */

import { join } from 'path';
import { readFileSync, existsSync } from 'fs';

const DECOMP_PATH = '.mpl/mpl/decomposition.yaml';

// Module-level cache (decomposition doesn't change mid-execution)
let _cache = null;
let _cacheCwd = null;

/**
 * Read and parse decomposition.yaml into a structured format.
 * Returns array of { id, files[] } where files is the union of
 * create/modify/affected_tests/affected_config paths.
 */
function readDecomposition(cwd) {
  if (_cache && _cacheCwd === cwd) return _cache;

  const filePath = join(cwd, DECOMP_PATH);
  if (!existsSync(filePath)) return null;

  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const phases = [];
  // Split by phase boundaries (lines starting with "  - id:")
  const phaseBlocks = content.split(/^  - id:\s*/m).slice(1);

  for (const block of phaseBlocks) {
    const lines = block.split('\n');
    const id = lines[0]?.replace(/["']/g, '').trim();
    if (!id) continue;

    const files = new Set();

    // Extract paths from create/modify/affected_tests/affected_config sections
    // Pattern: lines containing "path:" followed by a string value
    const pathMatches = block.matchAll(/^\s+path:\s*["']?([^"'\n]+)["']?\s*$/gm);
    for (const match of pathMatches) {
      const p = match[1].trim();
      if (p) files.add(p);
    }

    phases.push({ id, files: [...files] });
  }

  _cache = phases;
  _cacheCwd = cwd;
  return phases;
}

/**
 * Get the allowed file scope for a specific phase.
 * Returns { allowed: string[] } or null if phase not found.
 */
export function getPhaseScope(cwd, phaseId) {
  const phases = readDecomposition(cwd);
  if (!phases) return null;

  const phase = phases.find(p => p.id === phaseId);
  if (!phase) return null;

  return { allowed: phase.files };
}

/**
 * Clear the cached decomposition (for testing or re-decomposition).
 */
export function clearCache() {
  _cache = null;
  _cacheCwd = null;
}
