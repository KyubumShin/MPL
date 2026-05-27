#!/usr/bin/env node
/**
 * MPL Require Test Agent Hook (PostToolUse on Task|Agent)
 *
 * Blocks the orchestrator from proceeding past a phase-runner completion if the
 * completed phase was marked `test_agent_required: true` in decomposition.yaml
 * and `state.test_agent_dispatched[phase_id]` is missing or not structured
 * PASS evidence.
 *
 * Fixes the F-40 self-disabling pattern observed in ygg-exp11 (Opus 4.7):
 *   - 83 phase-runner dispatches, 1 test-agent dispatch (1.2% coverage)
 *   - The single test-agent dispatch found 5 gaps immediately
 *   - F-40's `pass_rate < 100%` trigger depended on phase-runner's self-test,
 *     which always reported 100%, so test-agent was never called
 *
 * AD-0007 enforcement contract:
 *   1. Decomposer emits `test_agent_required: true|false` + `test_agent_rationale`
 *      for every phase (boundary/e2e/db/algorithm/ai → true by default).
 *   2. This hook fires on phase-runner completion. It reads decomposition.yaml
 *      for the completed phase, and state.test_agent_dispatched for PASS
 *      evidence (written by mpl-gate-recorder.mjs).
 *   3. If required AND no PASS evidence AND not overridden → emit block decision
 *      so the orchestrator must dispatch test-agent before continuing.
 *   4. Override: `.mpl/config/test-agent-override.json` with explicit phase-id +
 *      user-supplied reason. Blanket overrides ("all-phases": "trivial") are
 *      logged as anti-patterns but accepted (user has final say).
 *
 * Non-blocking on error: swallows every exception and returns {continue: true}
 * to avoid wedging the pipeline on hook bugs.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { readState, isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { isPassingTestAgentEvidence } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-test-agent-evidence.mjs')).href
);
const {
  recordBlockedHook: recordBlockedHookEnvelope,
  clearBlockedHook: clearBlockedHookEnvelope,
} = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-blocked-hook.mjs')).href
);

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function block(reason) {
  console.log(JSON.stringify({ continue: false, decision: 'block', reason }));
}

const HOOK_ID = 'mpl-require-test-agent';

function recordBlockedHook(cwd, phaseId, reason, resumeInstruction) {
  // Codex r5 on PR #218: do not clobber an existing blocked_hook owned by
  // a different hook. mpl-gate-recorder runs ahead of this PreToolUse
  // hook for the same Task completion event and may have already set a
  // higher-priority phase_runner_<anomaly> block; overwriting it would
  // hide the structural anomaly signal and let a later test-agent PASS
  // clear the only visible block while the anomaly remained un-recovered.
  try {
    const existing = readState(cwd);
    if (existing && existing.session_status === 'blocked_hook'
        && existing.blocked_by_hook && existing.blocked_by_hook !== HOOK_ID) {
      return;  // defer to the more-specific existing block
    }
  } catch {
    // Fall through to recordBlockedHookEnvelope, which has its own try/catch.
  }
  recordBlockedHookEnvelope(cwd, {
    hookId: HOOK_ID,
    phaseId,
    artifact: `state.test_agent_dispatched.${phaseId}`,
    code: 'missing_or_invalid_test_agent_evidence',
    reason,
    resumeInstruction,
    retryContext: {
      phase_id: phaseId,
      required_agent: 'mpl-test-agent',
      override_path: '.mpl/config/test-agent-override.json',
      schema_reminder: 'Final response must be a single fenced ```json block with no prose outside it.',
    },
  });
}

function clearBlockedHook(cwd, phaseId) {
  clearBlockedHookEnvelope(cwd, { hookId: HOOK_ID, phaseId });
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function missingScalarCountFields(evidence) {
  const fields = [
    'test_files_created_count',
    'command_exit_codes_count',
    'command_exit_codes_nonzero_count',
  ];
  return fields.filter((field) => !finiteNumber(evidence?.[field]));
}

function isLegacyArrayOnlyPassEvidence(evidence) {
  if (!evidence) return false;
  const missingFields = missingScalarCountFields(evidence);
  return Boolean(
    missingFields.length > 0 &&
    evidence.valid_json === true &&
    evidence.verdict === 'PASS' &&
    (evidence.invalid_reason === null || evidence.invalid_reason === undefined) &&
    finiteNumber(evidence.tests_total) &&
    evidence.tests_total > 0 &&
    finiteNumber(evidence.tests_failed) &&
    evidence.tests_failed === 0 &&
    finiteNumber(evidence.tests_skipped) &&
    evidence.tests_skipped === 0 &&
    Array.isArray(evidence.test_files_created) &&
    evidence.test_files_created.length > 0 &&
    Array.isArray(evidence.command_exit_codes) &&
    evidence.command_exit_codes.length > 0 &&
    evidence.command_exit_codes.every((code) => code === 0) &&
    evidence.bugs_found_count === 0
  );
}

function describePriorEvidence(prior, phaseId) {
  if (!prior) return 'but mpl-test-agent was not dispatched';
  const len = typeof prior.response_len === 'number' ? `, response_len=${prior.response_len}` : '';
  const anomaly = prior.subagent_anomaly_type ? `, anomaly=${prior.subagent_anomaly_type}` : '';
  const summary = `but the recorded mpl-test-agent evidence is verdict=${prior.verdict || 'UNKNOWN'} ` +
    `(valid_json=${prior.valid_json === true}, reason=${prior.invalid_reason || 'none'}${len}${anomaly})`;
  if (!isLegacyArrayOnlyPassEvidence(prior)) return summary;

  return `${summary}; missing scalar count fields (${missingScalarCountFields(prior).join(', ')}) ` +
    `in a pre-v0.18.7 legacy record. Re-run mpl-test-agent for ${phaseId} so MPL records ` +
    `lossless scalar counts`;
}

function formatPriorEvidenceDetails(prior) {
  if (!prior) return 'No prior mpl-test-agent evidence is recorded.';
  const lines = [
    `verdict=${prior.verdict || 'UNKNOWN'}`,
    `valid_json=${prior.valid_json === true}`,
    `invalid_reason=${prior.invalid_reason || 'none'}`,
  ];
  if (typeof prior.response_len === 'number') lines.push(`response_len=${prior.response_len}`);
  if (prior.subagent_anomaly_type) lines.push(`subagent_anomaly_type=${prior.subagent_anomaly_type}`);
  if (prior.response_preview) lines.push(`response_preview=${JSON.stringify(prior.response_preview)}`);
  return lines.join('\n');
}

/**
 * Extract phase id from the phase-runner prompt. Looks for "phase-N" / "phase N".
 * Returns null if no match — the hook conservatively allows such dispatches (the
 * orchestrator may be running a non-phase task through the runner).
 */
function extractPhaseId(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\bphase[-\s]?(\d+)\b/i);
  return m ? `phase-${m[1]}` : null;
}

function trimTrailingBlankLines(lines) {
  const copy = [...lines];
  while (copy.length > 0 && !copy[copy.length - 1].trim()) copy.pop();
  return copy;
}

function yamlScalarValue(value) {
  let v = String(value || '').trim();
  if (!v) return null;
  // Minimal YAML subset: enough for MPL's simple scalar fields. Escaped
  // double-quoted YAML strings are not decoded here; this hook degrades by
  // showing the raw scalar in resume instructions.
  v = v.replace(/\s+#.*$/, '').trim();
  if (!v) return null;
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  return v.trim() || null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractScalar(lines, key) {
  const re = new RegExp(`^\\s+${escapeRegExp(key)}:\\s*(.*?)\\s*$`);
  for (const line of lines) {
    const match = line.match(re);
    if (match) return yamlScalarValue(match[1]);
  }
  return null;
}

function parseYamlBoolean(value) {
  if (value === null) return null;
  const normalized = value.replace(/\s+#.*$/, '').trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return null;
}

function extractSection(lines, key) {
  const re = new RegExp(`^(\\s*)${escapeRegExp(key)}:\\s*(.*?)\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(re);
    if (!match) continue;

    const baseIndent = match[1].length;
    const section = [lines[i]];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) {
        section.push(line);
        continue;
      }
      const indent = line.match(/^\s*/)[0].length;
      if (indent <= baseIndent) break;
      section.push(line);
    }
    return trimTrailingBlankLines(section).join('\n');
  }
  return null;
}

function clampSnippet(text, limit = 1400) {
  if (!text) return 'N/A - not declared in decomposition.yaml';
  if (text.length <= limit) return text;
  // Leave room for the truncation suffix so the returned section stays near
  // the requested hard cap.
  return `${text.slice(0, limit - 80).trimEnd()}\n... [truncated; read .mpl/mpl/decomposition.yaml for full context]`;
}

function finalizePhase(rawPhase) {
  const lines = rawPhase.rawLines || [];
  const required = parseYamlBoolean(extractScalar(lines, 'test_agent_required'));
  const phaseDomain = extractScalar(lines, 'phase_domain');
  return {
    id: rawPhase.id,
    phase_domain: phaseDomain,
    test_agent_required: required,
    test_agent_rationale: extractScalar(lines, 'test_agent_rationale'),
    impact: extractSection(lines, 'impact'),
    interface_contract: extractSection(lines, 'interface_contract'),
    probing_hints: extractSection(lines, 'probing_hints'),
    verification_plan: extractSection(lines, 'verification_plan'),
    success_criteria: extractSection(lines, 'success_criteria'),
  };
}

function formatTestAgentResumeInstruction(phase, priorDescription, priorEvidence = null) {
  const domain = phase.phase_domain || 'unknown';
  return [
    `Dispatch mpl-test-agent for ${phase.id}, then retry the blocked phase transition.`,
    '',
    'Prior mpl-test-agent evidence diagnostics:',
    formatPriorEvidenceDetails(priorEvidence),
    '',
    'FINAL OUTPUT RULE:',
    '- The final assistant message MUST start with ```json.',
    '- The final assistant message MUST end with the closing ``` fence.',
    '- Do not put prose before or after the JSON block.',
    '- Put any human-readable summary inside JSON fields only.',
    '',
    'Use this exact recovery shape:',
    'Task(subagent_type="mpl-test-agent", model="sonnet", prompt="""',
    `Resume blocked MPL transition for ${phase.id} (phase_domain=${domain}).`,
    'AD-0004: you are an independent test author. Do not treat phase-runner self-tests as evidence.',
    `Prior evidence status: ${priorDescription}.`,
    '',
    'Interface Contract:',
    clampSnippet(phase.interface_contract),
    '',
    'Impact Files / Phase Impact:',
    clampSnippet(phase.impact),
    '',
    'Probing Hints:',
    clampSnippet(phase.probing_hints),
    '',
    'Verification Plan:',
    clampSnippet(phase.verification_plan || phase.success_criteria),
    '',
    'Write and run executable tests for this phase. Return valid JSON with:',
    '- final response starts with ```json and has no prose outside the fence',
    '- verdict: "PASS" only when all checks pass',
    '- test_results.total > 0',
    '- test_results.failed == 0 and test_results.skipped == 0',
    '- test_files_created with at least one test file path',
    '- commands_run[] with every exit_code == 0',
    '- bugs_found: []',
    '""")',
    '',
    `Override only with explicit user consent by adding "${phase.id}": "<reason>" to .mpl/config/test-agent-override.json.`,
  ].join('\n');
}

/**
 * Parse decomposition.yaml (minimal YAML subset — we only need per-phase keys).
 * Returns { phases: [{ id, test_agent_required, test_agent_rationale, ... }, ...] }.
 * Uses naive line-based parsing to avoid pulling in a YAML dep; MPL project
 * policy forbids third-party runtime deps (see harness_lab CLAUDE.md).
 */
function parseDecomposition(cwd) {
  const decompPath = join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
  if (!existsSync(decompPath)) return null;

  const text = readFileSync(decompPath, 'utf-8');
  const phases = [];
  let cur = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');

    // Phase entry start: "  - id: phase-3"  (2-space indent) or "- id: phase-3"
    const idMatch = line.match(/^\s*-\s+id:\s*["']?(phase-[\w-]+)["']?/);
    if (idMatch) {
      if (cur) phases.push(finalizePhase(cur));
      cur = { id: idMatch[1], rawLines: [line] };
      continue;
    }

    if (!cur) continue;
    cur.rawLines.push(line);
  }
  if (cur) phases.push(finalizePhase(cur));

  return { phases };
}

/**
 * Load user-supplied override config.
 * Schema: { "phase-3": "trivial doc edit", "phase-5": "manual qa done" }
 * Or blanket: { "*": "global bypass — use with caution" }
 */
function loadOverride(cwd) {
  const overridePath = join(cwd, '.mpl', 'config', 'test-agent-override.json');
  if (!existsSync(overridePath)) return {};
  try {
    return JSON.parse(readFileSync(overridePath, 'utf-8'));
  } catch {
    return {};
  }
}

try {
  const raw = await readStdin();
  if (!raw.trim()) {
    ok();
    process.exit(0);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    ok();
    process.exit(0);
  }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) {
    ok();
    process.exit(0);
  }

  const toolName = String(data.tool_name || data.toolName || '');
  if (!['Task', 'task', 'Agent', 'agent'].includes(toolName)) {
    ok();
    process.exit(0);
  }

  const toolInput = data.tool_input || data.toolInput || {};
  const agentType = String(toolInput.subagent_type || toolInput.subagentType || '');

  // We only care about phase-runner completions. Every other agent type (test-agent
  // itself, git-master, decomposer, etc.) passes through.
  if (!/mpl-phase-runner$/.test(agentType)) {
    ok();
    process.exit(0);
  }

  // Background Task dispatches return a handle stub on the first
  // PostToolUse event, not a real phase completion. Skip the gate until
  // the eventual completion event arrives with the real response — same
  // reasoning as mpl-gate-recorder's background guard (codex r8/r9 on
  // PR #218). Treating a handle as a completed phase would otherwise
  // install a missing_or_invalid_test_agent_evidence block before the
  // runner has even produced final output.
  if (toolInput?.run_in_background === true || toolInput?.runInBackground === true) {
    ok();
    process.exit(0);
  }

  const phaseId = extractPhaseId(toolInput.prompt || toolInput.description || '');
  if (!phaseId) {
    // Non-phase task — conservatively allow.
    ok();
    process.exit(0);
  }

  const decomp = parseDecomposition(cwd);
  if (!decomp) {
    // Decomposition not yet available (pre-phase-2 or external dispatch) — allow.
    ok();
    process.exit(0);
  }

  const phase = decomp.phases.find((p) => p.id === phaseId);
  if (!phase) {
    // Phase not in decomposition — conservatively allow.
    ok();
    process.exit(0);
  }

  // Default safety: if the field is missing, TREAT AS REQUIRED. AD-0007 intent is
  // that Decomposer must actively mark `test_agent_required: false` with a
  // rationale to opt out; absence is not permission.
  const required = phase.test_agent_required !== false;
  if (!required) {
    ok();
    process.exit(0);
  }

  // Check override
  const override = loadOverride(cwd);
  if (override[phaseId] || override['*']) {
    // Override accepted — the reason is logged but we do not block.
    clearBlockedHook(cwd, phaseId);
    ok();
    process.exit(0);
  }

  // Check dispatch record
  const state = readState(cwd) || {};
  const dispatched = state.test_agent_dispatched || {};
  if (isPassingTestAgentEvidence(dispatched[phaseId])) {
    clearBlockedHook(cwd, phaseId);
    ok();
    process.exit(0);
  }

  // Not overridden, required, not dispatched → BLOCK
  const prior = dispatched[phaseId];
  const missingOrBad = describePriorEvidence(prior, phaseId);
  const rationale = phase.test_agent_rationale
    ? ` (rationale: ${phase.test_agent_rationale})`
    : '';
  const reason =
    `[MPL AD-0007] Phase ${phaseId} is marked test_agent_required=true${rationale} ` +
      `${missingOrBad}. You MUST run Task(subagent_type="mpl-test-agent", ` +
      `model="sonnet", prompt=...) with the phase's interface_contract + impact files ` +
      `and obtain valid JSON with verdict=PASS, executable tests, and command exit_code=0 ` +
      `BEFORE proceeding to the next phase. code_author == test_author is a tautology, ` +
      `not a verification (AD-0004). To bypass with user consent, add ${phaseId} to ` +
      `.mpl/config/test-agent-override.json with a reason.`;
  const resumeInstruction = formatTestAgentResumeInstruction(phase, missingOrBad, prior);
  recordBlockedHook(cwd, phaseId, reason, resumeInstruction);
  block(reason);
} catch {
  // Hook must never wedge the pipeline.
  ok();
}
