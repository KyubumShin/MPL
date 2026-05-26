import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';
import { readState, writeState } from './mpl-state.mjs';
import { clearBlockedHook } from './mpl-blocked-hook.mjs';
import { readGoalContract, readBaselineGoalContractHash } from './mpl-goal-contract.mjs';
import { isPassingTestAgentEvidence } from './mpl-test-agent-evidence.mjs';
import { validateArtifactFile } from './mpl-artifact-schema.mjs';
import {
  parseDecompositionGoalTraceText,
  validateGoalTraceCoverage,
  validateMvpGoalTraceCoverage,
} from './mpl-goal-trace.mjs';
import { parsePhaseContractGraphText } from './mpl-phase-contract-graph.mjs';

const BASELINE_REL_PATH = '.mpl/mpl/baseline.yaml';
const DECOMPOSITION_REL_PATH = '.mpl/mpl/decomposition.yaml';
const RECOVERY_SIGNAL_REL_PATH = '.mpl/signals/recovery.jsonl';

const BASELINE_CORRUPT_CODES = new Set([
  'goal_contract_baseline_corrupt',
  'goal_contract_hash_corrupt',
]);

const BASELINE_DRIFT_CODES = new Set([
  'goal_contract_drift',
  'goal_contract_hash_mismatch',
]);

function nowIso() {
  return new Date().toISOString();
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function appendRecoverySignal(cwd, event) {
  try {
    const path = join(cwd, RECOVERY_SIGNAL_REL_PATH);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ts: nowIso(), ...event }) + '\n');
  } catch {
    // Recovery signals are audit-only. State remains authoritative.
  }
}

function summarizeState(state) {
  return {
    blocked_by_hook: state?.blocked_by_hook ?? null,
    blocked_phase: state?.blocked_phase ?? null,
    blocked_artifact: state?.blocked_artifact ?? null,
    block_code: state?.block_code ?? null,
  };
}

function buildResult(state, patch) {
  return {
    ...summarizeState(state),
    ...patch,
  };
}

function recoveryPatch(state, { status, reason, instruction, details = {} }) {
  const context = state?.retry_context && typeof state.retry_context === 'object'
    ? jsonClone(state.retry_context)
    : {};
  const prev = context.recovery && typeof context.recovery === 'object'
    ? context.recovery
    : {};

  return {
    session_status: 'blocked_hook',
    blocked_by_hook: state.blocked_by_hook,
    blocked_phase: state.blocked_phase,
    blocked_artifact: state.blocked_artifact,
    block_code: state.block_code,
    block_reason: reason,
    resume_instruction: instruction || state.resume_instruction,
    retry_context: {
      ...context,
      recovery: {
        attempts: (Number.isFinite(prev.attempts) ? prev.attempts : 0) + 1,
        last_status: status,
        last_attempt_at: nowIso(),
        ...details,
      },
    },
    blocked_at: state.blocked_at || nowIso(),
  };
}

function keepBlocked(cwd, state, opts) {
  writeState(cwd, recoveryPatch(state, opts));
  appendRecoverySignal(cwd, {
    ...summarizeState(state),
    result: opts.status,
    reason: opts.reason,
    details: opts.details || {},
  });
}

function clearCurrentBlock(cwd, state) {
  clearBlockedHook(cwd, {
    hookId: state.blocked_by_hook,
    phaseId: state.blocked_phase,
    artifact: state.blocked_artifact,
  });
}

function readText(cwd, relPath) {
  const path = join(cwd, relPath);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

function writeText(cwd, relPath, text) {
  const path = join(cwd, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf-8');
}

function blockRange(lines, startIndex, baseIndent) {
  let end = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= baseIndent) {
      end = i;
      break;
    }
  }
  return { start: startIndex, end };
}

function patchBaselineGoalContractHash(text, hash) {
  const lines = String(text || '').split('\n');
  const goalIndex = lines.findIndex((line) => /^\s+goal_contract\s*:\s*$/.test(line));
  if (goalIndex < 0) {
    return { changed: false, text, reason: 'baseline goal_contract block is missing' };
  }

  const baseIndent = lines[goalIndex].match(/^\s*/)[0].length;
  const range = blockRange(lines, goalIndex, baseIndent);
  let pathIndex = -1;

  for (let i = goalIndex + 1; i < range.end; i++) {
    if (/^\s+path\s*:/.test(lines[i])) pathIndex = i;
    const match = lines[i].match(/^(\s+)sha256\s*:/);
    if (!match) continue;
    lines[i] = `${match[1]}sha256: "${hash}"`;
    return { changed: true, text: lines.join('\n') };
  }

  const childIndent = ' '.repeat(baseIndent + 2);
  const insertAt = pathIndex >= 0 ? pathIndex + 1 : goalIndex + 1;
  lines.splice(insertAt, 0, `${childIndent}sha256: "${hash}"`);
  return { changed: true, text: lines.join('\n') };
}

function patchDecompositionGoalHash(text, hash) {
  const lines = String(text || '').split('\n');
  const idx = lines.findIndex((line) => /^goal_contract_hash\s*:/.test(line));
  if (idx >= 0) {
    lines[idx] = `goal_contract_hash: "${hash}"`;
  } else {
    lines.unshift(`goal_contract_hash: "${hash}"`);
  }
  return lines.join('\n');
}

function phaseIdsMissingTestAgentRequired(state) {
  const failures = Array.isArray(state?.retry_context?.failures)
    ? state.retry_context.failures
    : [];
  const ids = [];
  for (const failure of failures) {
    const missing = Array.isArray(failure?.missing) ? failure.missing : [];
    for (const entry of missing) {
      const match = String(entry).match(/^(phase-[\w.-]+)\.test_agent_required$/);
      if (match) ids.push(match[1]);
    }
  }
  return [...new Set(ids)];
}

function patchMissingTestAgentRequired(text, phaseIds) {
  const wanted = new Set(phaseIds);
  const lines = String(text || '').split('\n');
  const patched = new Set();

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)-\s+id:\s*["']?(phase-[\w.-]+)["']?/);
    if (!match || !wanted.has(match[2])) continue;

    const baseIndent = match[1].length;
    const range = blockRange(lines, i, baseIndent);
    const hasField = lines
      .slice(i + 1, range.end)
      .some((line) => /^\s+test_agent_required\s*:/.test(line));
    if (hasField) continue;

    lines.splice(i + 1, 0, `${' '.repeat(baseIndent + 2)}test_agent_required: true`);
    patched.add(match[2]);
    i += 1;
  }

  return {
    text: lines.join('\n'),
    patched: [...patched],
    missing: [...wanted].filter((id) => !patched.has(id)),
  };
}

function goalTraceHashOnlyIssue(state) {
  const issues = Array.isArray(state?.retry_context?.issues)
    ? state.retry_context.issues.map(String)
    : [];
  return issues.length > 0 && issues.every((issue) => /^goal_contract_hash:(missing|mismatch|corrupt)/.test(issue));
}

function validateDecompositionGoalTraceText(cwd, text) {
  const goal = readGoalContract(cwd);
  if (!goal.exists || !goal.valid) return { valid: false, issues: ['goal_contract:invalid'] };
  const decomposition = parseDecompositionGoalTraceText(text);
  const verdict = validateGoalTraceCoverage(decomposition, goal.contract);
  const issues = [...verdict.issues];
  if (goal.contract?.mvp_scope) {
    const graph = parsePhaseContractGraphText(text);
    issues.push(...validateMvpGoalTraceCoverage(decomposition, goal.contract, graph).issues);
  }
  return { valid: issues.length === 0, issues };
}

function validateArtifactText(relPath, text) {
  const verdict = validateArtifactFile(relPath, text);
  return verdict || { valid: true, missing: [], missingAnyOf: [] };
}

function recoverGoalBaselineHash(cwd, state, { approveUnsafe = false } = {}) {
  const code = state.block_code;
  const drift = BASELINE_DRIFT_CODES.has(code);
  if (drift && !approveUnsafe) {
    const reason =
      '[MPL Recover] Goal contract hash mismatch may indicate a real goal change. ' +
      'Explicit approval is required before editing baseline.yaml.';
    keepBlocked(cwd, state, {
      status: 'requires_approval',
      reason,
      instruction:
        'Review .mpl/goal-contract.yaml and .mpl/mpl/baseline.yaml. If the current goal contract is the intended source of truth, rerun /mpl:mpl-recover with explicit unsafe approval; otherwise restore the baseline goal contract and retry decomposition.',
      details: { handler: 'goal_baseline_hash', unsafe: true },
    });
    return buildResult(state, {
      status: 'requires_approval',
      message: reason,
      requires_approval: true,
    });
  }

  const goal = readGoalContract(cwd);
  if (!goal.exists || !goal.valid) {
    const reason = '[MPL Recover] Cannot repair goal hash because .mpl/goal-contract.yaml is missing or invalid.';
    keepBlocked(cwd, state, {
      status: 'failed',
      reason,
      instruction: 'Restore a valid .mpl/goal-contract.yaml, then rerun /mpl:mpl-recover.',
      details: { handler: 'goal_baseline_hash', missing: goal.missing || [] },
    });
    return buildResult(state, { status: 'failed', message: reason });
  }

  const baseline = readBaselineGoalContractHash(cwd);
  if (!baseline.exists) {
    const reason = '[MPL Recover] Cannot repair goal hash because .mpl/mpl/baseline.yaml is missing.';
    keepBlocked(cwd, state, {
      status: 'failed',
      reason,
      instruction: 'Re-run Phase 0 renewal to recreate baseline.yaml, then retry decomposition.',
      details: { handler: 'goal_baseline_hash' },
    });
    return buildResult(state, { status: 'failed', message: reason });
  }

  const baselineText = readText(cwd, BASELINE_REL_PATH);
  const patched = patchBaselineGoalContractHash(baselineText, goal.contract.content_sha256);
  if (!patched.changed) {
    const reason = `[MPL Recover] Cannot repair baseline goal hash: ${patched.reason}.`;
    keepBlocked(cwd, state, {
      status: 'failed',
      reason,
      instruction: 'Re-run Phase 0 renewal to recreate a valid baseline.yaml, then retry decomposition.',
      details: { handler: 'goal_baseline_hash' },
    });
    return buildResult(state, { status: 'failed', message: reason });
  }

  writeText(cwd, BASELINE_REL_PATH, patched.text);
  const after = readBaselineGoalContractHash(cwd);
  if (after.error || after.hash !== goal.contract.content_sha256) {
    const reason = '[MPL Recover] Baseline hash repair did not produce a valid normalized goal_contract sha256.';
    keepBlocked(cwd, state, {
      status: 'failed',
      reason,
      instruction: 'Inspect .mpl/mpl/baseline.yaml manually, then rerun Phase 0 renewal or /mpl:mpl-recover.',
      details: { handler: 'goal_baseline_hash', error: after.error || null },
    });
    return buildResult(state, { status: 'failed', message: reason });
  }

  clearCurrentBlock(cwd, state);
  appendRecoverySignal(cwd, {
    ...summarizeState(state),
    result: 'recovered',
    handler: 'goal_baseline_hash',
    unsafe_approved: Boolean(drift && approveUnsafe),
    baseline_hash: after.hash,
  });
  return buildResult(state, {
    status: 'recovered',
    message: 'Repaired baseline.yaml goal_contract sha256 and cleared blocked_hook.',
  });
}

function recoverGoalTraceHash(cwd, state, { approveUnsafe = false } = {}) {
  if (!goalTraceHashOnlyIssue(state)) {
    const reason = '[MPL Recover] Goal trace block includes coverage issues, not just hash mismatch.';
    keepBlocked(cwd, state, {
      status: 'unsupported',
      reason,
      instruction: 'Re-run decomposition with complete goal_trace coverage for every required AC/AX, then retry.',
      details: { handler: 'goal_trace_hash', issues: state.retry_context?.issues || [] },
    });
    return buildResult(state, { status: 'unsupported', message: reason });
  }

  if (!approveUnsafe) {
    const reason =
      '[MPL Recover] Updating decomposition.yaml goal_contract_hash edits a canonical artifact and requires explicit approval.';
    keepBlocked(cwd, state, {
      status: 'requires_approval',
      reason,
      instruction:
        'Review the current decomposition.yaml. If only the top-level goal_contract_hash is stale/missing, rerun /mpl:mpl-recover with explicit unsafe approval; otherwise re-run decomposition.',
      details: { handler: 'goal_trace_hash', unsafe: true },
    });
    return buildResult(state, {
      status: 'requires_approval',
      message: reason,
      requires_approval: true,
    });
  }

  const goal = readGoalContract(cwd);
  const text = readText(cwd, DECOMPOSITION_REL_PATH);
  if (!goal.exists || !goal.valid || text === null) {
    const reason = '[MPL Recover] Cannot patch decomposition hash because goal contract or decomposition.yaml is unavailable.';
    keepBlocked(cwd, state, {
      status: 'failed',
      reason,
      instruction: 'Restore valid goal/decomposition artifacts, then rerun /mpl:mpl-recover.',
      details: { handler: 'goal_trace_hash' },
    });
    return buildResult(state, { status: 'failed', message: reason });
  }

  const patchedText = patchDecompositionGoalHash(text, goal.contract.content_sha256);
  const verdict = validateDecompositionGoalTraceText(cwd, patchedText);
  if (!verdict.valid) {
    const reason = '[MPL Recover] Patched goal_contract_hash, but decomposition.yaml still fails goal trace validation.';
    keepBlocked(cwd, state, {
      status: 'failed',
      reason,
      instruction: 'Re-run decomposition with complete goal_trace coverage, then retry.',
      details: { handler: 'goal_trace_hash', issues: verdict.issues.slice(0, 20) },
    });
    return buildResult(state, { status: 'failed', message: reason, issues: verdict.issues });
  }

  writeText(cwd, DECOMPOSITION_REL_PATH, patchedText);
  clearCurrentBlock(cwd, state);
  appendRecoverySignal(cwd, {
    ...summarizeState(state),
    result: 'recovered',
    handler: 'goal_trace_hash',
    unsafe_approved: true,
  });
  return buildResult(state, {
    status: 'recovered',
    message: 'Patched decomposition.yaml goal_contract_hash and cleared blocked_hook.',
  });
}

function recoverTestAgentEvidence(cwd, state) {
  const phaseId = state?.retry_context?.phase_id || state.blocked_phase;
  const evidence = phaseId ? state?.test_agent_dispatched?.[phaseId] : null;

  if (phaseId && isPassingTestAgentEvidence(evidence)) {
    clearCurrentBlock(cwd, state);
    appendRecoverySignal(cwd, {
      ...summarizeState(state),
      result: 'recovered',
      handler: 'test_agent_evidence',
      phase_id: phaseId,
    });
    return buildResult(state, {
      status: 'recovered',
      message: `Found PASS mpl-test-agent evidence for ${phaseId} and cleared blocked_hook.`,
      phase_id: phaseId,
    });
  }

  const reason =
    `[MPL Recover] Waiting for valid mpl-test-agent PASS evidence${phaseId ? ` for ${phaseId}` : ''}.`;
  keepBlocked(cwd, state, {
    status: 'awaiting_test_agent',
    reason,
    instruction:
      state.resume_instruction ||
      'Dispatch Task(subagent_type="mpl-test-agent", model="sonnet", prompt=...) for the blocked phase, then rerun /mpl:mpl-recover.',
    details: { handler: 'test_agent_evidence', phase_id: phaseId || null },
  });
  return buildResult(state, {
    status: 'awaiting_test_agent',
    message: reason,
    phase_id: phaseId || null,
    dispatch_instruction: state.resume_instruction || null,
  });
}

function recoverArtifactSchema(cwd, state, { approveUnsafe = false } = {}) {
  const phaseIds = phaseIdsMissingTestAgentRequired(state);
  if (phaseIds.length === 0) {
    const reason = '[MPL Recover] Artifact schema block has no supported automatic patch.';
    keepBlocked(cwd, state, {
      status: 'unsupported',
      reason,
      instruction:
        'Re-emit the blocked artifact with all required schema fields, then retry the next MPL step.',
      details: { handler: 'artifact_schema', failures: state.retry_context?.failures || [] },
    });
    return buildResult(state, { status: 'unsupported', message: reason });
  }

  if (!approveUnsafe) {
    const reason =
      `[MPL Recover] decomposition.yaml is missing test_agent_required for ${phaseIds.join(', ')}. ` +
      'Adding conservative defaults edits a canonical artifact and requires explicit approval.';
    keepBlocked(cwd, state, {
      status: 'requires_approval',
      reason,
      instruction:
        'Approve unsafe schema recovery to insert test_agent_required: true for the listed phases, or re-run decomposition manually.',
      details: { handler: 'artifact_schema', unsafe: true, phase_ids: phaseIds },
    });
    return buildResult(state, {
      status: 'requires_approval',
      message: reason,
      requires_approval: true,
      phase_ids: phaseIds,
    });
  }

  const text = readText(cwd, DECOMPOSITION_REL_PATH);
  if (text === null) {
    const reason = '[MPL Recover] Cannot patch decomposition schema because decomposition.yaml is missing.';
    keepBlocked(cwd, state, {
      status: 'failed',
      reason,
      instruction: 'Re-run decomposition to recreate decomposition.yaml, then retry.',
      details: { handler: 'artifact_schema', phase_ids: phaseIds },
    });
    return buildResult(state, { status: 'failed', message: reason });
  }

  const patched = patchMissingTestAgentRequired(text, phaseIds);
  if (patched.patched.length === 0 || patched.missing.length > 0) {
    const reason = '[MPL Recover] Could not locate every phase missing test_agent_required in decomposition.yaml.';
    keepBlocked(cwd, state, {
      status: 'failed',
      reason,
      instruction: 'Re-run decomposition or patch the listed phases manually, then retry.',
      details: { handler: 'artifact_schema', phase_ids: phaseIds, missing: patched.missing },
    });
    return buildResult(state, { status: 'failed', message: reason, missing: patched.missing });
  }

  const verdict = validateArtifactText(DECOMPOSITION_REL_PATH, patched.text);
  if (!verdict.valid) {
    const reason = '[MPL Recover] Patched test_agent_required defaults, but decomposition.yaml still fails artifact schema validation.';
    keepBlocked(cwd, state, {
      status: 'failed',
      reason,
      instruction: 'Re-emit decomposition.yaml with the remaining required schema fields, then retry.',
      details: {
        handler: 'artifact_schema',
        phase_ids: phaseIds,
        missing: verdict.missing,
        missing_any_of: verdict.missingAnyOf,
      },
    });
    return buildResult(state, {
      status: 'failed',
      message: reason,
      missing: verdict.missing,
      missing_any_of: verdict.missingAnyOf,
    });
  }

  writeText(cwd, DECOMPOSITION_REL_PATH, patched.text);
  clearCurrentBlock(cwd, state);
  appendRecoverySignal(cwd, {
    ...summarizeState(state),
    result: 'recovered',
    handler: 'artifact_schema',
    unsafe_approved: true,
    patched_phase_ids: patched.patched,
  });
  return buildResult(state, {
    status: 'recovered',
    message: `Inserted test_agent_required: true for ${patched.patched.join(', ')} and cleared blocked_hook.`,
    phase_ids: patched.patched,
  });
}

export function inspectRecovery(cwd = process.cwd()) {
  const state = readState(cwd);
  if (!state) {
    return { status: 'no_state', message: 'No readable .mpl/state.json found.' };
  }
  if (state.session_status !== 'blocked_hook') {
    return { status: 'not_blocked', message: 'MPL is not currently blocked by a hook.' };
  }

  const code = state.block_code;
  if (BASELINE_CORRUPT_CODES.has(code)) {
    return buildResult(state, {
      status: 'recoverable',
      handler: 'goal_baseline_hash',
      safe: true,
      message: 'Baseline goal_contract hash can be repaired from the normalized goal contract hash.',
    });
  }
  if (BASELINE_DRIFT_CODES.has(code)) {
    return buildResult(state, {
      status: 'requires_approval',
      handler: 'goal_baseline_hash',
      safe: false,
      message: 'Goal contract hash drift requires explicit approval before baseline.yaml is edited.',
    });
  }
  if (code === 'goal_trace_incomplete' && goalTraceHashOnlyIssue(state)) {
    return buildResult(state, {
      status: 'requires_approval',
      handler: 'goal_trace_hash',
      safe: false,
      message: 'decomposition.yaml hash-only goal trace mismatch requires explicit approval before patching.',
    });
  }
  if (code === 'missing_or_invalid_test_agent_evidence') {
    return buildResult(state, {
      status: 'recoverable',
      handler: 'test_agent_evidence',
      safe: true,
      message: 'Recover can clear the block after PASS mpl-test-agent evidence exists; otherwise it returns the dispatch instruction.',
    });
  }
  if (code === 'missing_artifact_schema') {
    const phaseIds = phaseIdsMissingTestAgentRequired(state);
    return buildResult(state, {
      status: phaseIds.length > 0 ? 'requires_approval' : 'unsupported',
      handler: 'artifact_schema',
      safe: false,
      phase_ids: phaseIds,
      message: phaseIds.length > 0
        ? 'Missing test_agent_required can be patched with conservative true defaults after explicit approval.'
        : 'This artifact schema violation has no automatic patch.',
    });
  }

  return buildResult(state, {
    status: 'unsupported',
    handler: null,
    message: `No /mpl:mpl-recover handler for block_code=${code || 'unknown'}.`,
  });
}

export function recoverBlockedHook(cwd = process.cwd(), { approveUnsafe = false } = {}) {
  const state = readState(cwd);
  if (!state) {
    return { status: 'no_state', message: 'No readable .mpl/state.json found.' };
  }
  if (state.session_status !== 'blocked_hook') {
    return { status: 'not_blocked', message: 'MPL is not currently blocked by a hook.' };
  }

  const code = state.block_code;
  if (BASELINE_CORRUPT_CODES.has(code)) {
    return recoverGoalBaselineHash(cwd, state, { approveUnsafe: false });
  }
  if (BASELINE_DRIFT_CODES.has(code)) {
    return recoverGoalBaselineHash(cwd, state, { approveUnsafe });
  }
  if (code === 'goal_trace_incomplete' && goalTraceHashOnlyIssue(state)) {
    return recoverGoalTraceHash(cwd, state, { approveUnsafe });
  }
  if (code === 'missing_or_invalid_test_agent_evidence') {
    return recoverTestAgentEvidence(cwd, state);
  }
  if (code === 'missing_artifact_schema') {
    return recoverArtifactSchema(cwd, state, { approveUnsafe });
  }

  const reason = `[MPL Recover] Unsupported hook block code: ${code || 'unknown'}.`;
  keepBlocked(cwd, state, {
    status: 'unsupported',
    reason,
    instruction:
      state.resume_instruction ||
      'Resolve the recorded hook block manually, then retry the blocked MPL step.',
    details: { handler: null },
  });
  return buildResult(state, { status: 'unsupported', message: reason });
}

function parseCli(argv) {
  const args = [...argv];
  const opts = { mode: 'plan', cwd: process.cwd(), approveUnsafe: false };
  for (const arg of args) {
    if (arg === '--plan') opts.mode = 'plan';
    else if (arg === '--apply-safe') opts.mode = 'recover';
    else if (arg === '--approve-unsafe') {
      opts.mode = 'recover';
      opts.approveUnsafe = true;
    } else if (!arg.startsWith('-')) {
      opts.cwd = arg;
    }
  }
  return opts;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const opts = parseCli(process.argv.slice(2));
  const result = opts.mode === 'plan'
    ? inspectRecovery(opts.cwd)
    : recoverBlockedHook(opts.cwd, { approveUnsafe: opts.approveUnsafe });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
