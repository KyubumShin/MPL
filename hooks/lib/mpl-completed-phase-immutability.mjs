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

// The decomposer Output_Schema (`agents/mpl-decomposer.md`) defines
// these as REQUIRED per-phase fields. Each is contractually
// load-bearing for a downstream hook:
//   change_policy   — recompose semantics
//   resource_locks  — executor parallel-wave conflict avoidance
//   goal_trace      — acceptance_criteria / variation_axes /
//                     ontology_entities AC/AX traceability ledger
//                     consumed by mpl-require-goal-trace and
//                     whole-goal-closure
//   verification_plan — a_items / s_items / h_items read by
//                     mpl-require-test-agent to build the brief
// (Claude r1 on PR #247 caught these as missing from the original
// allowlist — silent mutation on a completed phase would otherwise
// pass.) The flat `acceptance_criteria` / `variation_axes` entries
// remain so legacy / hand-emitted top-level forms are still gated.
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
  // r1: added per the decomposer Output_Schema
  'change_policy',
  'resource_locks',
  'goal_trace',
  'verification_plan',
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
/**
 * Strip an inline `# …` comment from a YAML line while respecting
 * single- and double-quoted strings. A `#` that appears inside an
 * unterminated quote on the same line is preserved (it's part of the
 * value, not a comment). A `#` that appears outside quotes AND
 * follows whitespace (or starts the comment span) becomes the cut
 * point. The trailing whitespace before the `#` is also stripped.
 *
 * This is a heuristic — block scalars (`|` / `>`) and multi-line
 * folded values that legitimately contain `#` are emitted by
 * `normalizePhaseBlock`'s continuation-line path, where this strip
 * runs equally on both old and new sides, so symmetric strips don't
 * produce diffs even if they're semantically lossy.
 */
function stripInlineYamlComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && (inSingle || inDouble)) {
      // Skip the escaped char.
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch !== '#') continue;
    if (inSingle || inDouble) continue;
    // A `#` is a comment only when it starts a token (preceded by
    // whitespace, or at the start of the line). Otherwise it's part
    // of a value (e.g. anchors / refs / URL fragments).
    if (i > 0 && !/\s/.test(line[i - 1])) continue;
    return line.slice(0, i).replace(/[ \t]+$/g, '');
  }
  return line;
}

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
    return idLine ? stripInlineYamlComment(idLine).replace(/[ \t]+$/, '').trim() : '';
  }

  const out = [];
  let currentField = null;
  // Codex r2 on PR #247: track block-scalar (`|` / `>`) mode so we do
  // NOT strip `#` inside literal payload. A field that opens a block
  // scalar with `field: |` or `field: >` keeps lines deeper than
  // `fieldIndent` as verbatim payload until a line at fieldIndent or
  // shallower reappears.
  let inBlockScalar = false;

  for (const rawLine of lines) {
    const lineIndent = (rawLine.match(/^(\s*)/) || ['', ''])[1].length;

    // Inside a block scalar — until indent backs up to fieldIndent.
    // Claude r2 follow-up: full-line `#` is literal payload inside
    // `|` / `>` scalars (e.g. markdown-style criterion text), not a
    // YAML comment. Emit verbatim BEFORE the `^\s*#` skip below.
    if (inBlockScalar && rawLine.trim() && lineIndent > fieldIndent) {
      if (currentField && LOAD_BEARING_FIELDS.has(currentField)) {
        out.push(rawLine.replace(/[ \t]+$/g, ''));
      }
      continue;
    }

    // Drop pure comment lines (`# …`) — only outside block scalars.
    if (/^\s*#/.test(rawLine)) continue;
    // Drop empty lines.
    if (!rawLine.trim()) continue;

    // `- id:` line — always emitted; resets currentField, exits scalar.
    if (/^\s*-\s+id\s*:/.test(rawLine)) {
      out.push(stripInlineYamlComment(rawLine).replace(/[ \t]+$/g, ''));
      currentField = 'id';
      inBlockScalar = false;
      continue;
    }

    inBlockScalar = false;

    // Field-level line (at fieldIndent).
    const fieldMatch = rawLine.match(/^(\s+)([a-zA-Z_][a-zA-Z0-9_]*)\s*:(.*)$/);
    if (fieldMatch && fieldMatch[1].length === fieldIndent) {
      const fieldName = fieldMatch[2];
      const remainder = fieldMatch[3];
      currentField = fieldName;
      // Detect block-scalar opener: `|`, `>`, with optional `+`/`-`
      // chomping indicator and optional explicit indentation digit.
      // Codex r3 on PR #247 [contract-break]: valid YAML allows an
      // inline comment after the indicator (`field: | # operator note`).
      // Strip the inline comment from the remainder via the same
      // quote-aware helper before testing the regex, so the scalar is
      // correctly entered.
      const remainderNoComment = stripInlineYamlComment(remainder);
      inBlockScalar = /^\s*[|>][+-]?\d?\s*$/.test(remainderNoComment);
      if (LOAD_BEARING_FIELDS.has(fieldName)) {
        out.push(stripInlineYamlComment(rawLine).replace(/[ \t]+$/g, ''));
      }
      continue;
    }

    // Continuation line (flow-style, list item, nested mapping) —
    // emit when in load-bearing field. Inline comments are
    // syntactically allowed here, so strip them quote-aware.
    if (currentField && LOAD_BEARING_FIELDS.has(currentField)) {
      out.push(stripInlineYamlComment(rawLine).replace(/[ \t]+$/g, ''));
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
