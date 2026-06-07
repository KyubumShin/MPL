/**
 * MPL Evidence Policy (L2 module — Move #8, Phase A)
 *
 * Replaces the substring+'pass' Evidence Latch with per-token STRUCTURAL
 * evidence checks. Each token has a dedicated handler that performs a
 * state-join / artifact-existence / schema parse — no scraping of
 * verification.md for the literal string `pass`.
 *
 * Public API:
 *   verifyToken(token, ctx) -> { valid, issues, supported }
 *   verifyPhase(phaseId, ctx) -> { valid, issues, tokens }
 *   getSupportedTokens() -> string[]
 *
 * ctx shape:
 *   { cwd, state, phase, phaseId, verificationText, config }
 *
 * Dependency boundary (per hooks/lib/policy/README.md):
 *   - L1 helpers only (mpl-test-agent-evidence, mpl-phase-evidence,
 *     mpl-goal-contract, mpl-goal-trace, mpl-config).
 *   - NEVER imports policy/contracts.mjs (L2 isolation).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { isPassingTestAgentEvidence } from '../mpl-test-agent-evidence.mjs';
import { readPhaseEvidence } from '../mpl-phase-evidence.mjs';
import { readGoalContract } from '../mpl-goal-contract.mjs';
import { parseDecompositionGoalTraceText } from '../mpl-goal-trace.mjs';

// ============================================================================
// Token registry — keep in sync with the YAML evidence.rules[] keys.
// ============================================================================

export const SUPPORTED_TOKENS = Object.freeze([
  'command',
  'test_agent',
  'test_agent_brief',
  'goal_trace',
  'api_contract',
  'type_policy',
  'error_spec',
  'tests_pass',
  'security',
  'e2e',
  'e2e_authenticity',
  'file_exists',
  'export_manifest',
  'lsp_diagnostics',
  'lint',
  'type_check',
  'build',
  'documentation',
  'manual',
  'external_audit',
  'tooling',
]);

export function getSupportedTokens() {
  return [...SUPPORTED_TOKENS];
}

// ============================================================================
// Small helpers
// ============================================================================

function normalizeToken(value) {
  return String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function readJsonIfExists(cwd, relPath) {
  const abs = join(cwd, relPath);
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, 'utf-8'));
  } catch {
    return null;
  }
}

function readTextIfExists(cwd, relPath) {
  const abs = join(cwd, relPath);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, 'utf-8');
  } catch {
    return null;
  }
}

function getEvidenceRule(config, token) {
  const rules = config?.evidence?.rules;
  if (!Array.isArray(rules)) return null;
  return rules.find((r) => r && r.token === token) || null;
}

function isLegacyTextFallbackAllowed(config) {
  return config?.evidence?.allow_legacy_text_fallback === true;
}

// ----------------------------------------------------------------------------
// Phase YAML peek — read the phase block straight from decomposition.yaml so
// the structural checks have access to phase.contract_files, type_policy,
// error_spec, impact, etc. without re-implementing the whole decomposer
// parser.
// ----------------------------------------------------------------------------

function readPhaseBlock(cwd, phaseId) {
  const path = join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
  if (!existsSync(path)) return null;
  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const out = [];
  let inside = false;
  let phaseIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const idMatch = line.match(/^(\s*)-\s+id:\s*["']?(phase-[\w.-]+)["']?/);
    if (idMatch) {
      if (inside) break;
      if (idMatch[2] === phaseId) {
        inside = true;
        phaseIndent = idMatch[1].length;
        out.push(line);
      }
      continue;
    }
    if (inside) {
      if (line.trim() === '') {
        out.push(line);
        continue;
      }
      const indent = (line.match(/^(\s*)/) || ['', ''])[1].length;
      if (indent <= phaseIndent && line.trim() !== '') break;
      out.push(line);
    }
  }
  return out.length === 0 ? null : out.join('\n');
}

function fieldListInBlock(block, key) {
  if (!block) return null;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Inline form: key: [a, b, c]
  const inline = block.match(new RegExp(`^[\\s]+${escaped}\\s*:\\s*\\[(.*)\\]\\s*$`, 'm'));
  if (inline) {
    return inline[1]
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  // Block form: key:
  //   - val
  const block_re = new RegExp(`^([\\s]+)${escaped}\\s*:\\s*$\\n((?:\\1[\\s]+.+\\n?)*)`, 'm');
  const m = block.match(block_re);
  if (!m) return null;
  const out = [];
  for (const ln of m[2].split('\n')) {
    const im = ln.match(/^\s*-\s+["']?([^"'\s#]+)["']?/);
    if (im) out.push(im[1]);
  }
  return out;
}

function fieldScalarInBlock(block, key) {
  if (!block) return null;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = block.match(new RegExp(`^[\\s]+${escaped}\\s*:\\s*(.+?)\\s*$`, 'm'));
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function fieldExistsInBlock(block, key) {
  if (!block) return false;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^[\\s]+${escaped}\\s*:`, 'm').test(block);
}

// Extract structured list-of-objects like error_spec[].
function parseListOfObjects(block, key) {
  if (!block) return null;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^([\\s]+)${escaped}\\s*:\\s*$\\n((?:.|\\n)*)`, 'm');
  const m = block.match(re);
  if (!m) return null;
  const baseIndent = m[1].length;
  const tail = m[2].split('\n');
  const items = [];
  let cur = null;
  for (const ln of tail) {
    if (!ln.trim()) continue;
    const indent = (ln.match(/^(\s*)/) || ['', ''])[1].length;
    if (indent <= baseIndent) break;
    const itemMatch = ln.match(/^(\s*)-\s+(.+?)\s*$/);
    if (itemMatch) {
      if (cur) items.push(cur);
      cur = {};
      const inline = itemMatch[2].match(/^([a-zA-Z_][\w-]*)\s*:\s*(.+)$/);
      if (inline) cur[inline[1]] = inline[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    if (cur) {
      const kv = ln.match(/^\s+([a-zA-Z_][\w-]*)\s*:\s*(.+?)\s*$/);
      if (kv) cur[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  if (cur) items.push(cur);
  return items;
}

function parseImpactCreate(block) {
  if (!block) return [];
  // impact:
  //   create:
  //     - path: ...
  //     - "path/string"
  const m = block.match(/^(\s+)impact\s*:\s*$\n((?:.|\n)*)/m);
  if (!m) return [];
  const baseIndent = m[1].length;
  const tail = m[2].split('\n');
  const created = [];
  let inCreate = false;
  let createIndent = -1;
  for (const ln of tail) {
    if (!ln.trim()) continue;
    const indent = (ln.match(/^(\s*)/) || ['', ''])[1].length;
    if (indent <= baseIndent && !inCreate) {
      if (!/^\s+create\s*:/.test(ln)) break;
    }
    if (indent <= baseIndent && inCreate) break;
    const createHeader = ln.match(/^(\s+)create\s*:\s*$/);
    if (createHeader) {
      inCreate = true;
      createIndent = createHeader[1].length;
      continue;
    }
    if (inCreate) {
      const im = ln.match(/^\s*-\s+(?:path\s*:\s*)?["']?([^"'\s#]+)["']?/);
      if (im) created.push(im[1]);
    }
  }
  return created;
}

// ============================================================================
// Per-token verifiers
// ============================================================================

function verifyCommand(ctx) {
  const issues = [];
  const { state, phaseId, config, verificationText } = ctx;
  const gate = state?.gate_results || {};
  if (gate?.hard1?.exit_code === 0 || gate?.hard2?.exit_code === 0) {
    return { valid: true, issues };
  }
  // Structured record in execution.phase_details[].commands_run[]
  const details = Array.isArray(state?.execution?.phase_details)
    ? state.execution.phase_details
    : [];
  const detail = details.find((d) => d && d.id === phaseId);
  const cmds = Array.isArray(detail?.commands_run) ? detail.commands_run : [];
  if (cmds.length > 0 && cmds.every((c) => Number(c?.exit_code) === 0)) {
    return { valid: true, issues };
  }
  // Optional text fallback when configured (transition only).
  const rule = getEvidenceRule(config, 'command');
  const allowFallback = rule?.fallback_allowed === true || isLegacyTextFallbackAllowed(config);
  if (allowFallback && verificationText) {
    if (/\bcommand\b/i.test(verificationText) &&
        /\bexit[_\s-]?code\s*[:=]\s*0\b/i.test(verificationText)) {
      return { valid: true, issues };
    }
  }
  issues.push(`${phaseId}:command:missing_exit_code_0`);
  return { valid: false, issues };
}

function verifyTestAgent(ctx) {
  const { state, phaseId } = ctx;
  const record = state?.test_agent_dispatched?.[phaseId];
  if (isPassingTestAgentEvidence(record)) {
    return { valid: true, issues: [] };
  }
  return {
    valid: false,
    issues: [`${phaseId}:test_agent:missing_pass_evidence`],
  };
}

function verifyTestAgentBrief(ctx) {
  const { cwd, phaseId } = ctx;
  const relPath = `.mpl/mpl/phases/${phaseId}/test-agent-brief.yaml`;
  const abs = join(cwd, relPath);
  if (!existsSync(abs)) {
    return { valid: false, issues: [`${phaseId}:test_agent_brief:missing:${relPath}`] };
  }
  let text;
  try {
    text = readFileSync(abs, 'utf-8');
  } catch {
    return { valid: false, issues: [`${phaseId}:test_agent_brief:unreadable`] };
  }
  // Minimal field presence (avoid hard dep on validateBrief schema for
  // structural existence — fail open on unparseable YAML).
  const required = [
    'phase_id',
    'target_implementation_files',
    'a_item_coverage',
    's_item_coverage',
    'required_test_commands',
    'expected_evidence_shape',
  ];
  const issues = [];
  for (const key of required) {
    const re = new RegExp(`^\\s*${key}\\s*:`, 'm');
    if (!re.test(text)) issues.push(`${phaseId}:test_agent_brief:missing_field:${key}`);
  }
  return { valid: issues.length === 0, issues };
}

function verifyGoalTrace(ctx) {
  const { cwd, phaseId } = ctx;
  // Parse decomposition.yaml + goal-contract.yaml, check this phase's
  // goal_trace lists known AC/AX ids.
  const decompPath = join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
  if (!existsSync(decompPath)) {
    return { valid: false, issues: [`${phaseId}:goal_trace:decomposition_missing`] };
  }
  let decompText;
  try { decompText = readFileSync(decompPath, 'utf-8'); }
  catch { return { valid: false, issues: [`${phaseId}:goal_trace:decomposition_unreadable`] }; }
  const decomposition = parseDecompositionGoalTraceText(decompText);
  const phase = decomposition?.phases?.find((p) => p.id === phaseId);
  if (!phase) {
    return { valid: false, issues: [`${phaseId}:goal_trace:phase_block_missing`] };
  }
  if (!phase.has_goal_trace) {
    return { valid: false, issues: [`${phaseId}:goal_trace:missing`] };
  }
  const acList = phase.acceptance_criteria || [];
  // variation_axes is allowed to be empty but must be present (the parser
  // returns [] when absent; presence is harder to detect without a schema
  // marker, so we accept empty here and rely on contracts.handleGoalTrace
  // for the cross-graph requirement check).
  if (acList.length === 0) {
    return {
      valid: false,
      issues: [`${phaseId}:goal_trace:empty_acceptance_criteria`],
    };
  }

  // Cross-check vs goal-contract.yaml id sets.
  const goal = readGoalContract(cwd);
  if (!goal?.valid) {
    return {
      valid: false,
      issues: [`${phaseId}:goal_trace:goal_contract_invalid`],
    };
  }
  const knownAc = new Set((goal.contract.acceptance_criteria || []).map((x) => x.id || x));
  const knownAx = new Set((goal.contract.variation_axes || []).map((x) => x.id || x));
  const issues = [];
  for (const ac of acList) {
    if (!knownAc.has(ac) && !knownAx.has(ac)) {
      issues.push(`${phaseId}:goal_trace:unknown_id:${ac}`);
    }
  }
  for (const ax of phase.variation_axes || []) {
    if (!knownAx.has(ax) && !knownAc.has(ax)) {
      issues.push(`${phaseId}:goal_trace:unknown_id:${ax}`);
    }
  }
  return { valid: issues.length === 0, issues };
}

function verifyApiContract(ctx) {
  const { cwd, phaseId } = ctx;
  const block = readPhaseBlock(cwd, phaseId);
  if (!block) {
    return { valid: false, issues: [`${phaseId}:api_contract:phase_block_missing`] };
  }
  const contractFiles = fieldListInBlock(block, 'contract_files');
  if (!Array.isArray(contractFiles) || contractFiles.length === 0) {
    return { valid: false, issues: [`${phaseId}:api_contract:contract_files_missing`] };
  }
  const issues = [];
  for (const rel of contractFiles) {
    const abs = join(cwd, rel);
    if (!existsSync(abs)) {
      issues.push(`${phaseId}:api_contract:file_missing:${rel}`);
      continue;
    }
    if (rel.endsWith('.json')) {
      try { JSON.parse(readFileSync(abs, 'utf-8')); }
      catch { issues.push(`${phaseId}:api_contract:parse_failed:${rel}`); }
    } else if (/\.ya?ml$/.test(rel)) {
      // Structural: ensure non-empty content; deep YAML parse skipped
      // (no js-yaml dep). Acceptable for Phase A.
      try {
        const t = readFileSync(abs, 'utf-8');
        if (!t.trim()) issues.push(`${phaseId}:api_contract:empty:${rel}`);
      } catch { issues.push(`${phaseId}:api_contract:unreadable:${rel}`); }
    }
  }
  return { valid: issues.length === 0, issues };
}

function verifyTypePolicy(ctx) {
  const { cwd, phaseId, state } = ctx;
  const block = readPhaseBlock(cwd, phaseId);
  if (!block) {
    return { valid: false, issues: [`${phaseId}:type_policy:phase_block_missing`] };
  }
  const scalar = fieldScalarInBlock(block, 'type_policy');
  const hasField = fieldExistsInBlock(block, 'type_policy');
  if (!hasField || (scalar === null && !/^\s+type_policy\s*:\s*$/m.test(block))) {
    return { valid: false, issues: [`${phaseId}:type_policy:missing_field`] };
  }
  if (scalar !== null && scalar === '') {
    return { valid: false, issues: [`${phaseId}:type_policy:empty`] };
  }
  if (state?.gate_results?.hard1?.exit_code !== 0) {
    return { valid: false, issues: [`${phaseId}:type_policy:hard1_not_passing`] };
  }
  return { valid: true, issues: [] };
}

function verifyErrorSpec(ctx) {
  const { cwd, phaseId } = ctx;
  const block = readPhaseBlock(cwd, phaseId);
  if (!block) {
    return { valid: false, issues: [`${phaseId}:error_spec:phase_block_missing`] };
  }
  const entries = parseListOfObjects(block, 'error_spec');
  if (!entries || entries.length === 0) {
    return { valid: false, issues: [`${phaseId}:error_spec:missing_or_empty`] };
  }
  const issues = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const code = e?.code;
    const message = e?.message;
    if (!code || !/^[A-Z][A-Z0-9_]{2,}$/.test(String(code))) {
      issues.push(`${phaseId}:error_spec:invalid_code:${i}:${code || 'missing'}`);
    }
    if (!message || String(message).trim().length === 0) {
      issues.push(`${phaseId}:error_spec:missing_message:${i}`);
    }
  }
  return { valid: issues.length === 0, issues };
}

function verifyTestsPass(ctx) {
  const { cwd, phaseId, state } = ctx;
  const phaseDir = join(cwd, '.mpl', 'mpl', 'phases', phaseId);
  if (existsSync(phaseDir)) {
    let entries = [];
    try { entries = readdirSync(phaseDir); } catch { /* ignore */ }
    const junits = entries.filter((e) => /^junit.*\.xml$/i.test(e));
    if (junits.length > 0) {
      let allOk = true;
      const found = [];
      for (const j of junits) {
        try {
          const xml = readFileSync(join(phaseDir, j), 'utf-8');
          const failuresMatch = xml.match(/failures\s*=\s*"(\d+)"/);
          const errorsMatch = xml.match(/errors\s*=\s*"(\d+)"/);
          const testsMatch = xml.match(/tests\s*=\s*"(\d+)"/);
          const failures = failuresMatch ? Number(failuresMatch[1]) : 0;
          const errors = errorsMatch ? Number(errorsMatch[1]) : 0;
          const tests = testsMatch ? Number(testsMatch[1]) : 0;
          found.push({ j, failures, errors, tests });
          if (failures !== 0 || errors !== 0 || tests <= 0) allOk = false;
        } catch {
          allOk = false;
          found.push({ j, error: 'unreadable' });
        }
      }
      if (allOk) return { valid: true, issues: [] };
      return {
        valid: false,
        issues: found
          .filter((f) => f.error || f.failures > 0 || f.errors > 0 || f.tests <= 0)
          .map((f) => `${phaseId}:tests_pass:junit_failed:${f.j}`),
      };
    }
  }
  // Fallback: structured test-agent evidence.
  const evidence = state?.test_agent_dispatched?.[phaseId];
  if (evidence
    && typeof evidence.tests_total === 'number' && evidence.tests_total > 0
    && evidence.tests_failed === 0
    && evidence.tests_skipped === 0) {
    return { valid: true, issues: [] };
  }
  return {
    valid: false,
    issues: [`${phaseId}:tests_pass:no_junit_no_test_agent_evidence`],
  };
}

function verifySecurity(ctx) {
  const { cwd, phaseId, state } = ctx;
  const results = state?.security_results;
  if (results && typeof results === 'object') {
    // Look for any pipeline entry with no high/critical findings.
    let sawAny = false;
    let cleanAny = false;
    for (const [, v] of Object.entries(results)) {
      sawAny = true;
      const findings = Array.isArray(v?.findings) ? v.findings : [];
      const bad = findings.some((f) => ['high', 'critical'].includes(String(f?.severity || '').toLowerCase()));
      if (!bad) cleanAny = true;
    }
    if (sawAny && cleanAny) return { valid: true, issues: [] };
  }
  const report = readJsonIfExists(cwd, '.mpl/security-report.json');
  if (report && Array.isArray(report.findings) && report.findings.length === 0) {
    return { valid: true, issues: [] };
  }
  return {
    valid: false,
    issues: [`${phaseId}:security:no_clean_evidence`],
  };
}

function readE2eScenarios(cwd) {
  const text = readTextIfExists(cwd, '.mpl/mpl/e2e-scenarios.yaml');
  if (!text) return [];
  // Minimal scenario peek: id + covers[] + test_files[]
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const out = [];
  let cur = null;
  let listField = null;
  let listIndent = -1;
  for (const line of lines) {
    const idMatch = line.match(/^\s*-\s+id:\s*["']?(E2E-[\w-]+)["']?/);
    if (idMatch) {
      if (cur) out.push(cur);
      cur = { id: idMatch[1], covers: [], test_files: [] };
      listField = null;
      continue;
    }
    if (!cur) continue;
    const inlineCovers = line.match(/^\s+covers\s*:\s*\[(.*)\]\s*$/);
    if (inlineCovers) {
      cur.covers = inlineCovers[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      continue;
    }
    const inlineFiles = line.match(/^\s+test_files\s*:\s*\[(.*)\]\s*$/);
    if (inlineFiles) {
      cur.test_files = inlineFiles[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      continue;
    }
    const blockCovers = line.match(/^(\s+)covers\s*:\s*$/);
    if (blockCovers) { listField = 'covers'; listIndent = blockCovers[1].length; continue; }
    const blockFiles = line.match(/^(\s+)test_files\s*:\s*$/);
    if (blockFiles) { listField = 'test_files'; listIndent = blockFiles[1].length; continue; }
    if (listField) {
      const im = line.match(/^(\s*)-\s+["']?([^"'\s#]+)["']?/);
      if (im && im[1].length > listIndent) {
        cur[listField].push(im[2]);
        continue;
      }
      listField = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function phaseCoversFromBlock(block) {
  if (!block) return [];
  return fieldListInBlock(block, 'covers') || [];
}

function verifyE2e(ctx) {
  const { cwd, phaseId, state } = ctx;
  const scenarios = readE2eScenarios(cwd);
  if (scenarios.length === 0) {
    return { valid: false, issues: [`${phaseId}:e2e:no_scenarios_defined`] };
  }
  const block = readPhaseBlock(cwd, phaseId);
  const phaseCovers = new Set(phaseCoversFromBlock(block));
  if (phaseCovers.size === 0) {
    return { valid: false, issues: [`${phaseId}:e2e:phase_covers_missing`] };
  }
  const covering = scenarios.filter((s) =>
    (s.covers || []).some((c) => phaseCovers.has(c)),
  );
  if (covering.length === 0) {
    return { valid: false, issues: [`${phaseId}:e2e:no_covering_scenarios`] };
  }
  const results = state?.e2e_results || {};
  const issues = [];
  for (const s of covering) {
    const r = results[s.id];
    if (!r) {
      issues.push(`${phaseId}:e2e:missing:${s.id}`);
      continue;
    }
    if (r.exit_code !== 0) {
      issues.push(`${phaseId}:e2e:nonzero_exit:${s.id}:${r.exit_code}`);
    }
  }
  return { valid: issues.length === 0, issues };
}

const REAL_RUNTIME_PATTERN = /\bfetch\b|\baxios\b|\bhttp\.|\btauri::invoke\b|\bWebSocket\b|\bpage\.goto\b|\bchromedriver\b|\bwebdriver\b|@tauri-apps\/api/i;
const PLACEHOLDER_PATTERN = /\bexpect\s*\(\s*true\s*\)|\.toBe\s*\(\s*true\s*\)|\btest\.skip\b|\bit\.skip\b/;

function verifyE2eAuthenticity(ctx) {
  const { cwd, phaseId } = ctx;
  const scenarios = readE2eScenarios(cwd);
  if (scenarios.length === 0) {
    return { valid: false, issues: [`${phaseId}:e2e_authenticity:no_scenarios`] };
  }
  const block = readPhaseBlock(cwd, phaseId);
  const phaseCovers = new Set(phaseCoversFromBlock(block));
  const covering = scenarios.filter((s) =>
    (s.covers || []).some((c) => phaseCovers.has(c)),
  );
  if (covering.length === 0) {
    return { valid: false, issues: [`${phaseId}:e2e_authenticity:no_covering_scenarios`] };
  }
  const issues = [];
  for (const s of covering) {
    if (!Array.isArray(s.test_files) || s.test_files.length === 0) {
      issues.push(`${phaseId}:e2e_authenticity:no_test_files:${s.id}`);
      continue;
    }
    let sawAuthentic = false;
    for (const rel of s.test_files) {
      const txt = readTextIfExists(cwd, rel);
      if (txt === null) {
        issues.push(`${phaseId}:e2e_authenticity:file_missing:${s.id}:${rel}`);
        continue;
      }
      if (PLACEHOLDER_PATTERN.test(txt)) {
        issues.push(`${phaseId}:e2e_authenticity:placeholder:${s.id}:${rel}`);
      }
      if (REAL_RUNTIME_PATTERN.test(txt)) {
        sawAuthentic = true;
      }
    }
    if (!sawAuthentic) {
      issues.push(`${phaseId}:e2e_authenticity:no_real_runtime_signal:${s.id}`);
    }
  }
  return { valid: issues.length === 0, issues };
}

function verifyFileExists(ctx) {
  const { cwd, phaseId } = ctx;
  const block = readPhaseBlock(cwd, phaseId);
  const created = parseImpactCreate(block);
  if (created.length === 0) {
    return { valid: false, issues: [`${phaseId}:file_exists:no_impact_create_declared`] };
  }
  const issues = [];
  for (const rel of created) {
    const abs = join(cwd, rel);
    if (!existsSync(abs)) issues.push(`${phaseId}:file_exists:missing:${rel}`);
  }
  return { valid: issues.length === 0, issues };
}

function verifyExportManifest(ctx) {
  const { cwd, phaseId, state } = ctx;
  const cutId = state?.release?.current_cut_id;
  if (!cutId) {
    return { valid: false, issues: [`${phaseId}:export_manifest:no_current_cut_id`] };
  }
  const rel = `.mpl/mpl/releases/${cutId}/release-manifest.json`;
  const manifest = readJsonIfExists(cwd, rel);
  if (!manifest) {
    return { valid: false, issues: [`${phaseId}:export_manifest:missing:${rel}`] };
  }
  const phases = Array.isArray(manifest.phases) ? manifest.phases : [];
  if (!phases.includes(phaseId)) {
    return { valid: false, issues: [`${phaseId}:export_manifest:phase_not_in_manifest`] };
  }
  return { valid: true, issues: [] };
}

function verifyLspDiagnostics(ctx) {
  const { cwd, phaseId, state } = ctx;
  if (state?.gate_results?.hard1?.lsp_diagnostics_count === 0) {
    return { valid: true, issues: [] };
  }
  const rel = `.mpl/mpl/phases/${phaseId}/lsp-diagnostics.json`;
  const artifact = readJsonIfExists(cwd, rel);
  if (artifact && Array.isArray(artifact.errors) && artifact.errors.length === 0) {
    return { valid: true, issues: [] };
  }
  return { valid: false, issues: [`${phaseId}:lsp_diagnostics:no_clean_evidence`] };
}

function verifyLint(ctx) {
  const { cwd, phaseId, state } = ctx;
  if (state?.gate_results?.hard1?.lint_exit_code === 0) {
    return { valid: true, issues: [] };
  }
  const rel = `.mpl/mpl/phases/${phaseId}/lint.json`;
  const artifact = readJsonIfExists(cwd, rel);
  if (artifact && Number(artifact.error_count) === 0) {
    return { valid: true, issues: [] };
  }
  return { valid: false, issues: [`${phaseId}:lint:no_clean_evidence`] };
}

function verifyTypeCheck(ctx) {
  const { phaseId, state } = ctx;
  if (state?.gate_results?.hard1?.typecheck_exit_code === 0) {
    return { valid: true, issues: [] };
  }
  return { valid: false, issues: [`${phaseId}:type_check:no_clean_evidence`] };
}

function verifyBuild(ctx) {
  const { cwd, phaseId, state } = ctx;
  if (state?.gate_results?.hard1?.build_exit_code === 0) {
    return { valid: true, issues: [] };
  }
  const rel = `.mpl/mpl/phases/${phaseId}/build.log`;
  const log = readTextIfExists(cwd, rel);
  if (log && /(BUILD\s+SUCCESS|build\s+succeeded|Compiled successfully)/i.test(log)) {
    return { valid: true, issues: [] };
  }
  return { valid: false, issues: [`${phaseId}:build:no_clean_evidence`] };
}

function verifyDocumentation(ctx) {
  const { cwd, phaseId, config, verificationText } = ctx;
  const docsDir = join(cwd, '.mpl', 'mpl', 'phases', phaseId, 'docs');
  if (existsSync(docsDir)) {
    try {
      const entries = readdirSync(docsDir);
      if (entries.length > 0) return { valid: true, issues: [] };
    } catch { /* fall through */ }
  }
  const block = readPhaseBlock(cwd, phaseId);
  const created = parseImpactCreate(block);
  const docHit = created.find((rel) => /\.(md|rst|txt)$/i.test(rel) && existsSync(join(cwd, rel)));
  if (docHit) return { valid: true, issues: [] };

  const rule = getEvidenceRule(config, 'documentation');
  if ((rule?.fallback_allowed === true || isLegacyTextFallbackAllowed(config)) && verificationText) {
    if (/\bdocumentation\b/i.test(verificationText)) {
      return { valid: true, issues: [] };
    }
  }
  return { valid: false, issues: [`${phaseId}:documentation:missing`] };
}

function verifyManual(ctx) {
  const { state, phaseId } = ctx;
  const rec = state?.gate_results?.manual_attestation?.[phaseId];
  if (rec && rec.attested_by && rec.attested_at) {
    return { valid: true, issues: [] };
  }
  return { valid: false, issues: [`${phaseId}:manual:no_attestation`] };
}

function verifyExternalAudit(ctx) {
  const { cwd, phaseId } = ctx;
  const rel = `.mpl/mpl/phases/${phaseId}/external-audit.json`;
  const audit = readJsonIfExists(cwd, rel);
  if (!audit) {
    return { valid: false, issues: [`${phaseId}:external_audit:missing:${rel}`] };
  }
  if (String(audit.verdict).toUpperCase() !== 'PASS') {
    return { valid: false, issues: [`${phaseId}:external_audit:verdict_not_pass`] };
  }
  if (!audit.auditor || String(audit.auditor).trim().length === 0) {
    return { valid: false, issues: [`${phaseId}:external_audit:auditor_missing`] };
  }
  return { valid: true, issues: [] };
}

function verifyTooling(ctx) {
  const { state, phaseId } = ctx;
  const rec = state?.gate_results?.tooling?.[phaseId];
  if (rec && (rec.status === 'pass' || rec.exit_code === 0)) {
    return { valid: true, issues: [] };
  }
  return { valid: false, issues: [`${phaseId}:tooling:no_pass_record`] };
}

const HANDLERS = {
  command: verifyCommand,
  test_agent: verifyTestAgent,
  test_agent_brief: verifyTestAgentBrief,
  goal_trace: verifyGoalTrace,
  api_contract: verifyApiContract,
  type_policy: verifyTypePolicy,
  error_spec: verifyErrorSpec,
  tests_pass: verifyTestsPass,
  security: verifySecurity,
  e2e: verifyE2e,
  e2e_authenticity: verifyE2eAuthenticity,
  file_exists: verifyFileExists,
  export_manifest: verifyExportManifest,
  lsp_diagnostics: verifyLspDiagnostics,
  lint: verifyLint,
  type_check: verifyTypeCheck,
  build: verifyBuild,
  documentation: verifyDocumentation,
  manual: verifyManual,
  external_audit: verifyExternalAudit,
  tooling: verifyTooling,
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Verify a single evidence token against ctx.
 *
 * @param {string} token — evidence token, e.g. 'command', 'test_agent_brief'
 * @param {object} ctx
 *   @param {string} ctx.cwd
 *   @param {object} ctx.state
 *   @param {object} [ctx.phase]    — phase block (optional pre-parsed)
 *   @param {string} ctx.phaseId
 *   @param {string} [ctx.verificationText] — verification.md text
 *   @param {object} [ctx.config]   — mpl.config.yaml-derived config
 * @returns {{valid: boolean, issues: string[], supported: boolean}}
 */
export function verifyToken(token, ctx) {
  const normalized = normalizeToken(token);
  if (!HANDLERS[normalized]) {
    const phaseId = ctx?.phaseId || 'unknown';
    return {
      valid: false,
      supported: false,
      issues: [
        `${phaseId}:unknown_evidence_token:${normalized}`,
        `supported: ${SUPPORTED_TOKENS.join(',')}`,
      ],
    };
  }
  const out = HANDLERS[normalized](ctx || {});
  return { ...out, supported: true };
}

/**
 * Verify every evidence token declared by a phase block. Pulls the
 * phase's evidence_required list from decomposition.yaml (via the
 * existing L1 helper) when ctx.phase is omitted.
 *
 * @param {string} phaseId
 * @param {object} ctx
 * @returns {{valid: boolean, issues: string[], tokens: Array<{token: string, valid: boolean, issues: string[]}>}}
 */
export function verifyPhase(phaseId, ctx = {}) {
  const merged = { ...ctx, phaseId };
  let phase = ctx.phase;
  if (!phase) {
    const parsed = readPhaseEvidence(ctx.cwd);
    phase = parsed?.phases?.find((p) => p.id === phaseId) || null;
  }
  if (!phase) {
    return {
      valid: false,
      issues: [`${phaseId}:phase:missing`],
      tokens: [],
    };
  }
  const required = phase.evidence_required || [];
  if (required.length === 0) {
    return {
      valid: false,
      issues: [`${phaseId}:evidence_required:missing`],
      tokens: [],
    };
  }
  const tokenResults = [];
  const allIssues = [];
  for (const t of required) {
    const r = verifyToken(t, merged);
    tokenResults.push({ token: t, valid: r.valid, issues: r.issues });
    if (!r.valid) allIssues.push(...r.issues);
  }
  return {
    valid: allIssues.length === 0,
    issues: allIssues,
    tokens: tokenResults,
  };
}
