#!/usr/bin/env node
/**
 * MPL Require Test Agent Hook (PostToolUse on Task|Agent)
 *
 * Thin wrapper over `hooks/lib/policy/contracts.mjs::handleTestAgentPostRun`.
 * The policy module is the SSOT for the structural decision
 * (test_agent_required? override? PASS evidence?). This file translates
 * the policy decision envelope into the legacy stdout shape the
 * orchestrator + test suite expect, and rebuilds the rich phase-aware
 * `reason` / `resumeInstruction` strings the legacy hook produced — the
 * policy emits generic ones, but downstream consumers (state.json
 * envelope, agent recovery prompt) depend on the phase-context-rich
 * version (Interface Contract, Impact, Probing Hints, Verification Plan,
 * legacy array-only PASS detection, etc).
 *
 * Legacy stdout contract preserved:
 *   allow → {continue: true, suppressOutput: true}
 *   block → {continue: false, decision: 'block', reason}
 *   block → blocked_hook envelope (deferred when a different hook owns it)
 *
 * Original implementation: hooks/mpl-require-test-agent.legacy.mjs
 *
 * Non-blocking on error: every exception → {continue: true}.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const L = (rel) => pathToFileURL(join(__dirname, 'lib', rel)).href;

const { readState, isMplActive } = await import(L('mpl-state.mjs'));
const { readStdin } = await import(L('stdin.mjs'));
const {
  recordBlockedHook: recordEnv,
  clearBlockedHook: clearEnv,
} = await import(L('mpl-blocked-hook.mjs'));
const { loadConfig } = await import(L('mpl-config.mjs'));
const { handleTestAgentPostRun } = await import(L('policy/contracts.mjs'));

const HOOK_ID = 'mpl-require-test-agent';

const ok = () => console.log(JSON.stringify({ continue: true, suppressOutput: true }));
const block = (reason) => console.log(JSON.stringify({ continue: false, decision: 'block', reason }));

function recordBlockedHook(cwd, phaseId, reason, resumeInstruction) {
  // Codex r5 (PR #218) deferral: do not clobber a different hook's envelope.
  try {
    const ex = readState(cwd);
    if (ex && ex.session_status === 'blocked_hook'
        && ex.blocked_by_hook && ex.blocked_by_hook !== HOOK_ID) return;
  } catch { /* fall through */ }
  recordEnv(cwd, {
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

// ---------------------------------------------------------------------------
// Phase YAML extraction (lightweight subset, preserved from legacy).
// ---------------------------------------------------------------------------

function extractPhaseId(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\bphase[-\s]?(\d+)\b/i);
  return m ? `phase-${m[1]}` : null;
}

function trimTrailingBlanks(lines) {
  const c = [...lines];
  while (c.length && !c[c.length - 1].trim()) c.pop();
  return c;
}

function yamlScalar(v) {
  let s = String(v || '').trim();
  if (!s) return null;
  s = s.replace(/\s+#.*$/, '').trim();
  if (!s) return null;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  return s.trim() || null;
}

function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function extractScalar(lines, key) {
  const re = new RegExp(`^\\s+${escRe(key)}:\\s*(.*?)\\s*$`);
  for (const l of lines) { const m = l.match(re); if (m) return yamlScalar(m[1]); }
  return null;
}

function extractSection(lines, key) {
  const re = new RegExp(`^(\\s*)${escRe(key)}:\\s*(.*?)\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const base = m[1].length;
    const out = [lines[i]];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) { out.push(l); continue; }
      if (l.match(/^\s*/)[0].length <= base) break;
      out.push(l);
    }
    return trimTrailingBlanks(out).join('\n');
  }
  return null;
}

function readPhase(cwd, phaseId) {
  try {
    const fp = join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
    if (!existsSync(fp)) return null;
    const text = readFileSync(fp, 'utf-8');
    const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
    let cur = null;
    let collecting = false;
    const phaseLines = [];
    for (const line of lines) {
      const idM = line.match(/^\s*-\s+id:\s*["']?(phase-[\w-]+)["']?/);
      if (idM) {
        if (collecting) break;
        if (idM[1] === phaseId) { cur = phaseId; collecting = true; phaseLines.push(line); continue; }
        continue;
      }
      if (collecting) phaseLines.push(line);
    }
    if (!cur) return null;
    return {
      id: phaseId,
      phase_domain: extractScalar(phaseLines, 'phase_domain'),
      test_agent_rationale: extractScalar(phaseLines, 'test_agent_rationale'),
      impact: extractSection(phaseLines, 'impact'),
      interface_contract: extractSection(phaseLines, 'interface_contract'),
      probing_hints: extractSection(phaseLines, 'probing_hints'),
      verification_plan: extractSection(phaseLines, 'verification_plan'),
      success_criteria: extractSection(phaseLines, 'success_criteria'),
    };
  } catch { return null; }
}

function clamp(text, limit = 1400) {
  if (!text) return 'N/A - not declared in decomposition.yaml';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 80).trimEnd()}\n... [truncated; read .mpl/mpl/decomposition.yaml for full context]`;
}

// ---------------------------------------------------------------------------
// Prior-evidence diagnostics (preserved from legacy).
// ---------------------------------------------------------------------------

function fin(v) { return typeof v === 'number' && Number.isFinite(v); }

function missingScalarCountFields(e) {
  return ['test_files_created_count', 'command_exit_codes_count', 'command_exit_codes_nonzero_count']
    .filter((f) => !fin(e?.[f]));
}

function isLegacyArrayOnlyPass(e) {
  if (!e) return false;
  const missing = missingScalarCountFields(e);
  return missing.length > 0
    && e.valid_json === true && e.verdict === 'PASS'
    && (e.invalid_reason === null || e.invalid_reason === undefined)
    && fin(e.tests_total) && e.tests_total > 0
    && fin(e.tests_failed) && e.tests_failed === 0
    && fin(e.tests_skipped) && e.tests_skipped === 0
    && Array.isArray(e.test_files_created) && e.test_files_created.length > 0
    && Array.isArray(e.command_exit_codes) && e.command_exit_codes.length > 0
    && e.command_exit_codes.every((c) => c === 0)
    && e.bugs_found_count === 0;
}

function describePrior(prior, phaseId) {
  if (!prior) return 'but mpl-test-agent was not dispatched';
  const len = fin(prior.response_len) ? `, response_len=${prior.response_len}` : '';
  const an = prior.subagent_anomaly_type ? `, anomaly=${prior.subagent_anomaly_type}` : '';
  const summary = `but the recorded mpl-test-agent evidence is verdict=${prior.verdict || 'UNKNOWN'} `
    + `(valid_json=${prior.valid_json === true}, reason=${prior.invalid_reason || 'none'}${len}${an})`;
  if (!isLegacyArrayOnlyPass(prior)) return summary;
  return `${summary}; missing scalar count fields (${missingScalarCountFields(prior).join(', ')}) `
    + `in a pre-v0.18.7 legacy record. Re-run mpl-test-agent for ${phaseId} so MPL records `
    + `lossless scalar counts`;
}

function priorDetails(p) {
  if (!p) return 'No prior mpl-test-agent evidence is recorded.';
  const out = [
    `verdict=${p.verdict || 'UNKNOWN'}`,
    `valid_json=${p.valid_json === true}`,
    `invalid_reason=${p.invalid_reason || 'none'}`,
  ];
  if (fin(p.response_len)) out.push(`response_len=${p.response_len}`);
  if (p.subagent_anomaly_type) out.push(`subagent_anomaly_type=${p.subagent_anomaly_type}`);
  if (p.response_preview) out.push(`response_preview=${JSON.stringify(p.response_preview)}`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Reason + resumeInstruction builders (preserved verbatim from legacy).
// ---------------------------------------------------------------------------

function buildReason(phase, phaseId, prior) {
  const rationale = phase?.test_agent_rationale ? ` (rationale: ${phase.test_agent_rationale})` : '';
  return `[MPL AD-0007] Phase ${phaseId} is marked test_agent_required=true${rationale} `
    + `${describePrior(prior, phaseId)}. You MUST run Task(subagent_type="mpl-test-agent", `
    + `model="sonnet", prompt=...) with the phase's interface_contract + impact files `
    + `and obtain valid JSON with verdict=PASS, executable tests, and command exit_code=0 `
    + `BEFORE proceeding to the next phase. code_author == test_author is a tautology, `
    + `not a verification (AD-0004). To bypass with user consent, add ${phaseId} to `
    + `.mpl/config/test-agent-override.json with a reason.`;
}

function buildResume(phase, phaseId, prior) {
  const domain = phase?.phase_domain || 'unknown';
  const priorDesc = describePrior(prior, phaseId);
  return [
    `Dispatch mpl-test-agent for ${phaseId}, then retry the blocked phase transition.`,
    '',
    'Prior mpl-test-agent evidence diagnostics:',
    priorDetails(prior),
    '',
    'FINAL OUTPUT RULE:',
    '- The final assistant message MUST start with ```json.',
    '- The final assistant message MUST end with the closing ``` fence.',
    '- Do not put prose before or after the JSON block.',
    '- Put any human-readable summary inside JSON fields only.',
    '',
    'Use this exact recovery shape:',
    'Task(subagent_type="mpl-test-agent", model="sonnet", prompt="""',
    `Resume blocked MPL transition for ${phaseId} (phase_domain=${domain}).`,
    'AD-0004: you are an independent test author. Do not treat phase-runner self-tests as evidence.',
    `Prior evidence status: ${priorDesc}.`,
    '',
    'Interface Contract:',
    clamp(phase?.interface_contract),
    '',
    'Impact Files / Phase Impact:',
    clamp(phase?.impact),
    '',
    'Probing Hints:',
    clamp(phase?.probing_hints),
    '',
    'Verification Plan:',
    clamp(phase?.verification_plan || phase?.success_criteria),
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
    `Override only with explicit user consent by adding "${phaseId}": "<reason>" to .mpl/config/test-agent-override.json.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Background-task handle-stub guard (preserved verbatim from legacy).
// ---------------------------------------------------------------------------
function isHandleStub(toolInput, toolResponse) {
  const bg = toolInput?.run_in_background === true || toolInput?.runInBackground === true;
  return bg && toolResponse !== null && typeof toolResponse === 'object' && !Array.isArray(toolResponse)
    && (toolResponse.handle !== undefined || toolResponse.taskId !== undefined
        || toolResponse.task_id !== undefined || toolResponse.id !== undefined)
    && typeof toolResponse.text !== 'string' && typeof toolResponse.response !== 'string'
    && typeof toolResponse.output !== 'string' && typeof toolResponse.content !== 'string'
    && !Array.isArray(toolResponse.content);
}

// ---------------------------------------------------------------------------
// Main: stdin → delegate to policy → translate to legacy stdout shape.
// ---------------------------------------------------------------------------
try {
  const raw = await readStdin();
  if (!raw.trim()) { ok(); process.exit(0); }

  let data;
  try { data = JSON.parse(raw); }
  catch { ok(); process.exit(0); }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) { ok(); process.exit(0); }

  const toolName = String(data.tool_name || data.toolName || '');
  const toolInput = data.tool_input || data.toolInput || {};
  const toolResponse = data.tool_response ?? data.toolResponse ?? null;

  if (isHandleStub(toolInput, toolResponse)) { ok(); process.exit(0); }

  const config = loadConfig(cwd);
  const state = readState(cwd) || {};

  const decision = await handleTestAgentPostRun({
    cwd, toolName, toolInput, state, config, hookEvent: 'PostToolUse',
  });

  const phaseId = extractPhaseId(toolInput.prompt || toolInput.description || '')
    || decision.retryContext?.phase_id || null;

  if (decision.action === 'allow') {
    if (phaseId) clearEnv(cwd, { hookId: HOOK_ID, phaseId });
    ok();
    process.exit(0);
  }

  // Policy says block — rebuild the rich legacy-shape strings.
  const pid = phaseId || 'unknown-phase';
  const prior = (state.test_agent_dispatched || {})[pid];
  const phase = readPhase(cwd, pid);
  const reason = buildReason(phase, pid, prior);
  const resume = buildResume(phase, pid, prior);
  recordBlockedHook(cwd, pid, reason, resume);
  block(reason);
} catch {
  ok();
}
