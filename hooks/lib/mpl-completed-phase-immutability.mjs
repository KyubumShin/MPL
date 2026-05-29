/**
 * Completed phase immutability helpers.
 *
 * Once a phase has completed evidence, recomposition may append or adjust later
 * phases but must not mutate the completed phase contract block.
 *
 * #241 B1: relaxed from byte-for-byte equality on the whole phase YAML
 * to a field-scoped comparison. Only the contractually-load-bearing
 * fields trigger a violation when they change; free-form fields
 * (`notes`, `test_agent_rationale`, etc.) and presentation details
 * (line comments, trailing whitespace) are allowed to change.
 *
 * The closed list of load-bearing fields (per the over-enforcement
 * audit B1 acceptance criteria + AD-0006 / AD-0007 contracts):
 *   - id, interface_contract, depends_on, impact, acceptance_criteria,
 *     variation_axes, success_criteria, covers, scope,
 *     test_agent_required, evidence_required, test_command,
 *     verification_strategy, scope_files
 * Anything outside this set may change without violating immutability.
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

const LOAD_BEARING_FIELDS = new Set([
  'id',
  'interface_contract',
  'depends_on',
  'impact',
  'acceptance_criteria',
  'variation_axes',
  'success_criteria',
  'covers',
  'scope',
  'scope_files',
  'test_agent_required',
  'evidence_required',
  'test_command',
  'verification_strategy',
]);

function phaseBlocks(text) {
  const blocks = new Map();
  let cur = null;

  const flush = () => {
    if (cur) blocks.set(cur.id, normalizePhaseBlock(cur.text));
    cur = null;
  };

  for (const line of String(text || '').split('\n').map((l) => l.replace(/\r$/, ''))) {
    const idMatch = line.match(/^\s*-\s+id:\s*["']?(phase-[\w.-]+)["']?/);
    if (idMatch) {
      flush();
      cur = { id: idMatch[1], text: `${line}\n` };
      continue;
    }
    if (cur) cur.text += `${line}\n`;
  }
  flush();
  return blocks;
}

/**
 * Normalize a phase YAML block down to its load-bearing fields. The
 * returned canonical form is what gets compared old vs. new — two
 * blocks differing only in notes / comments / whitespace produce
 * identical canonical forms and pass the immutability check.
 *
 * Strategy: scan the block lines once. The `- id:` line opens the
 * block. The first non-blank, non-comment line at the phase-field
 * indent establishes the per-phase field indent. Each subsequent
 * line at exactly that indent introduces a new top-level field —
 * lookup the name against `LOAD_BEARING_FIELDS`. Pure `#`-prefixed
 * lines are dropped; trailing whitespace is stripped; continuation
 * lines (deeper indent) are emitted only when the current field
 * is load-bearing.
 *
 * (Renaming the function would break the public API; preserve the
 * `normalizePhaseBlock` name and have it perform the load-bearing
 * extraction.)
 */
export function normalizePhaseBlock(text) {
  const raw = String(text || '');
  if (!raw.trim()) return '';

  const lines = raw.split('\n').map((l) => l.replace(/\r$/, ''));

  // Establish phase-field indent: the indent of the first non-blank,
  // non-comment line that comes after the `- id:` line.
  let fieldIndent = -1;
  let sawIdLine = false;
  for (const line of lines) {
    if (/^\s*-\s+id\s*:/.test(line)) { sawIdLine = true; continue; }
    if (!sawIdLine) continue;
    if (!line.trim()) continue;
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^(\s+)\S/);
    if (m) { fieldIndent = m[1].length; break; }
  }

  // Block with no fields → just keep the id line.
  if (fieldIndent < 0) {
    const idLine = lines.find((l) => /^\s*-\s+id\s*:/.test(l));
    return idLine ? idLine.replace(/[ \t]+$/, '').trim() : '';
  }

  const out = [];
  let currentField = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/[ \t]+$/g, '');
    // Drop pure comment lines (`# …`).
    if (/^\s*#/.test(line)) continue;
    // Drop empty lines.
    if (!line.trim()) continue;

    // `- id:` line is always emitted; it's the contract anchor.
    if (/^\s*-\s+id\s*:/.test(line)) {
      out.push(line);
      currentField = 'id';
      continue;
    }

    const fieldMatch = line.match(/^(\s+)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
    if (fieldMatch && fieldMatch[1].length === fieldIndent) {
      const fieldName = fieldMatch[2];
      currentField = fieldName;
      if (LOAD_BEARING_FIELDS.has(fieldName)) out.push(line);
      continue;
    }

    // Continuation line — emit only when in a load-bearing field.
    if (currentField && LOAD_BEARING_FIELDS.has(currentField)) {
      out.push(line);
    }
  }

  return out.join('\n').trim();
}

/**
 * Exposed for tests / doctor: the set of fields whose change
 * triggers a completed-phase immutability violation.
 */
export const COMPLETED_PHASE_LOAD_BEARING_FIELDS = Object.freeze(
  new Set([...LOAD_BEARING_FIELDS])
);

function diskCompletedPhaseIds(cwd) {
  const phasesDir = join(cwd, '.mpl', 'mpl', 'phases');
  if (!existsSync(phasesDir)) return [];
  const out = [];
  try {
    for (const entry of readdirSync(phasesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!/^phase-[\w.-]+$/.test(entry.name)) continue;
      if (existsSync(join(phasesDir, entry.name, 'state-summary.md'))) {
        out.push(entry.name);
      }
    }
  } catch {
    return [];
  }
  return out;
}

function stateCompletedPhaseIds(state = {}) {
  return (state?.execution?.phase_details || [])
    .filter((detail) => detail?.id && detail.status === 'completed')
    .map((detail) => detail.id);
}

export function completedPhaseIds(cwd, state = {}) {
  return [...new Set([...diskCompletedPhaseIds(cwd), ...stateCompletedPhaseIds(state)])].sort();
}

export function validateCompletedPhaseImmutability({ oldText, newText, completedIds }) {
  const issues = [];
  const oldBlocks = phaseBlocks(oldText);
  const newBlocks = phaseBlocks(newText);

  for (const phaseId of completedIds || []) {
    const oldBlock = oldBlocks.get(phaseId);
    const newBlock = newBlocks.get(phaseId);
    if (!oldBlock) {
      issues.push(`${phaseId}:old_contract:missing`);
      continue;
    }
    if (!newBlock) {
      issues.push(`${phaseId}:new_contract:missing`);
      continue;
    }
    if (oldBlock !== newBlock) {
      issues.push(`${phaseId}:contract:modified`);
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
