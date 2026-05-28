/**
 * test-agent-brief.yaml validator (#212 MVP).
 *
 * Parses the brief YAML (using the same regex-style minimal peek
 * pattern other MPL hook libs use — no js-yaml dependency) and
 * surfaces the structured violation list so
 * `hooks/mpl-require-test-agent-brief.mjs` can block dispatch with a
 * copy-ready recovery hint. See `docs/schemas/test-agent-brief.md`
 * for the canonical schema.
 */

const PLACEHOLDER_COMMANDS = new Set([
  'echo', 'true', 'false', ':', 'noop', 'pass',
]);

const PLACEHOLDER_TARGETS = new Set([
  '', 'todo', 'tbd', 'n/a', 'na', '-', '...',
  'expect(true)', 'expect(true).tobe(true)', 'pass',
]);

function isPlaceholderTarget(s) {
  if (typeof s !== 'string') return true;
  const norm = s.trim().toLowerCase();
  if (norm.length === 0) return true;
  return PLACEHOLDER_TARGETS.has(norm);
}

function isPlaceholderCommand(s) {
  if (typeof s !== 'string') return true;
  const trimmed = s.trim();
  if (trimmed.length < 5) return true;
  // first word check
  const head = trimmed.split(/\s+/)[0].toLowerCase();
  if (PLACEHOLDER_COMMANDS.has(head)) return true;
  return false;
}

/**
 * Minimal YAML peek. Recognizes top-level scalars + named blocks +
 * `- ` list items at one indent. Good enough for the brief schema;
 * malformed YAML lands the same as missing required fields.
 */
function parseBriefText(text) {
  const out = {};
  const lines = String(text || '').split('\n');
  let currentKey = null;
  let currentList = null;
  let currentObj = null;
  for (const raw of lines) {
    const line = raw.replace(/^﻿/, '');
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;
    // Top-level scalar: key: value
    const scalar = line.match(/^([a-z_][a-z0-9_]*)\s*:\s*(.*)$/i);
    if (scalar && !line.startsWith(' ')) {
      const key = scalar[1];
      const val = scalar[2].trim();
      if (val === '' || val.startsWith('#')) {
        // start of nested block
        currentKey = key;
        currentList = [];
        currentObj = null;
        out[key] = currentList;
        continue;
      }
      out[key] = stripQuotes(val);
      currentKey = null;
      currentList = null;
      currentObj = null;
      continue;
    }
    // List item under currentKey
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && currentList) {
      const body = item[1].trim();
      const m = body.match(/^([a-z_][a-z0-9_]*)\s*:\s*(.*)$/i);
      if (m) {
        currentObj = { [m[1]]: stripQuotes(m[2].trim()) };
        currentList.push(currentObj);
      } else {
        currentList.push(stripQuotes(body));
        currentObj = null;
      }
      continue;
    }
    // key: value under currentObj
    const sub = line.match(/^\s+([a-z_][a-z0-9_]*)\s*:\s*(.*)$/i);
    if (sub && currentObj) {
      currentObj[sub[1]] = stripQuotes(sub[2].trim());
      continue;
    }
  }
  return out;
}

function stripQuotes(s) {
  if (typeof s !== 'string') return s;
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Validate the parsed brief. Caller may pass `phaseId` to also assert
 * the `phase_id` field matches.
 *
 * Returns { valid: boolean, errors: string[] }.
 */
export function validateBrief(text, { phaseId = null } = {}) {
  const errors = [];
  let brief;
  try {
    brief = parseBriefText(text);
  } catch (e) {
    return { valid: false, errors: [`unparseable_yaml:${e?.message || 'unknown'}`] };
  }
  if (!brief || typeof brief !== 'object') {
    return { valid: false, errors: ['empty_or_invalid_brief'] };
  }

  if (typeof brief.phase_id !== 'string' || !brief.phase_id.trim()) {
    errors.push('missing_phase_id');
  } else if (phaseId && brief.phase_id !== phaseId) {
    errors.push(`phase_id_mismatch:expected=${phaseId},actual=${brief.phase_id}`);
  }

  const interfaceContracts = Array.isArray(brief.interface_contracts)
    ? brief.interface_contracts : [];
  const codeBearing = interfaceContracts.length > 0;

  const targets = Array.isArray(brief.target_implementation_files)
    ? brief.target_implementation_files : [];
  if (codeBearing && targets.length === 0) {
    errors.push('missing_target_implementation_files');
  }

  // A/S coverage
  for (const fld of ['a_item_coverage', 's_item_coverage']) {
    const cov = Array.isArray(brief[fld]) ? brief[fld] : [];
    if (cov.length === 0) {
      errors.push(`missing_${fld}`);
      continue;
    }
    cov.forEach((entry, idx) => {
      if (!entry || typeof entry !== 'object') {
        errors.push(`${fld}[${idx}]_malformed`);
        return;
      }
      if (typeof entry.id !== 'string' || !entry.id.trim()) {
        errors.push(`${fld}[${idx}]_missing_id`);
      }
      if (isPlaceholderTarget(entry.test_target)) {
        errors.push(`${fld}[${idx}]_placeholder_or_missing_test_target`);
      }
    });
  }

  // Required test commands — non-empty, real commands
  const cmds = Array.isArray(brief.required_test_commands)
    ? brief.required_test_commands : [];
  if (cmds.length === 0) {
    errors.push('missing_required_test_commands');
  } else {
    cmds.forEach((c, idx) => {
      if (isPlaceholderCommand(c)) {
        errors.push(`required_test_commands[${idx}]_placeholder_or_too_short`);
      }
    });
  }

  // Contract assertions (optional; if present, no placeholder-only)
  if (Array.isArray(brief.contract_assertions)) {
    brief.contract_assertions.forEach((a, idx) => {
      if (isPlaceholderTarget(a)) {
        errors.push(`contract_assertions[${idx}]_placeholder`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}
