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
import {
  writeDerivedDecompositionFields,
  writeTestAgentBriefs,
} from './mpl-decomposition-postprocess.mjs';

const BASELINE_REL_PATH = '.mpl/mpl/baseline.yaml';
const DECOMPOSITION_REL_PATH = '.mpl/mpl/decomposition.yaml';
const RECOVERY_SIGNAL_REL_PATH = '.mpl/signals/recovery.jsonl';

// #234: phantom aliases `goal_contract_hash_corrupt` /
// `goal_contract_hash_mismatch` were routed but no hook ever emitted
// them. The live emission sites are `goal_contract_baseline_corrupt`
// (mpl-require-goal-trace.mjs hash check) and `goal_contract_drift`
// (baseline drift). Keep the sets single-element so future hook
// authors reading this list see the canonical code names.
const BASELINE_CORRUPT_CODES = new Set([
  'goal_contract_baseline_corrupt',
]);

const BASELINE_DRIFT_CODES = new Set([
  'goal_contract_drift',
]);

// #234: cap auto-fix retries so a deterministic regeneration that
// keeps failing (disk permission, malformed source) doesn't loop
// forever. The recovery handler reads attempts from
// state.retry_context.recovery.attempts (incremented by recoveryPatch)
// and degrades to `unsupported` past the budget so the operator sees
// the underlying error.
const AUTO_FIX_RETRY_BUDGET = 3;

// Codes the recover skill can resolve by re-running the deterministic
// postprocess that produced the source artifacts. No agent dispatch.
const AUTO_FIX_REGENERATE_CODES = new Set([
  'decomposition_derived_stale',
  'test_agent_briefs_write_failed',
]);

// Codes whose recovery is "re-dispatch the producing agent with the
// validator's structured error list". The recover skill cannot
// dispatch agents directly — it returns a dispatch instruction
// pointing at the right agent + the error context.
//
// Note (codex r1 [logic]): `goal_contract_invalid` is NOT in this set.
// Its emission site (hooks/mpl-require-goal-trace.mjs) is "missing or
// invalid .mpl/goal-contract.yaml" — re-dispatching the decomposer
// cannot repair a missing/invalid goal contract. That code is routed
// to user_action below, echoing the recorded resume_instruction.
const REDISPATCH_DECOMPOSER_CODES = new Set([
  'covers_schema_violation',
  'phase_contract_graph_invalid',
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

// Codex r2 on PR #242 [data-integrity]: writeState uses deepMerge,
// which recursively merges nested plain objects. That means a stale
// `retry_context.recovery` from a prior, unrelated block survives
// into a new block's envelope. If that stale `recovery.attempts`
// happens to be 3, `recoverAutoRegenerate` reports budget-exhausted
// before ever running the deterministic postprocess on a fresh,
// recoverable block.
//
// Scope recovery state to the active block by tagging it with the
// block_code + blocked_at. Readers (see `activeRecoveryState`) only
// trust the stored attempts when the tag matches the current envelope.
function recoveryPatch(state, { status, reason, instruction, details = {} }) {
  const context = state?.retry_context && typeof state.retry_context === 'object'
    ? jsonClone(state.retry_context)
    : {};
  const prev = activeRecoveryState(state);

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
        // Scope tag — readers compare to current state before trusting.
        block_code: state.block_code || null,
        blocked_at: state.blocked_at || null,
        attempts: (Number.isFinite(prev.attempts) ? prev.attempts : 0) + 1,
        last_status: status,
        last_attempt_at: nowIso(),
        ...details,
      },
    },
    blocked_at: state.blocked_at || nowIso(),
  };
}

// Read the recovery sub-object only when it belongs to the active
// block. Returns `{}` (a fresh slate) otherwise.
//
// Three cases:
//   (a) Tagged recovery (post-codex-r2): trust iff
//       (block_code, blocked_at) matches the current envelope.
//   (b) Untagged recovery (pre-codex-r2 / pre-existing on-disk state)
//       with `last_attempt_at >= state.blocked_at`: adopt as
//       legitimately belonging to the current block. Codex r3
//       [contract-break] migration path — without this, an r1
//       budget-exhausted block would reset to attempts=0 after the
//       r2 upgrade, allowing extra auto-fix attempts past the cap.
//   (c) Untagged recovery with no timestamp signal or older than the
//       current block: treat as stale → fresh slate.
function activeRecoveryState(state) {
  const rec = state?.retry_context?.recovery;
  if (!rec || typeof rec !== 'object') return {};
  const currentCode = state?.block_code || null;
  const currentBlockedAt = state?.blocked_at || null;
  const stampedCode = rec.block_code ?? null;
  const stampedAt = rec.blocked_at ?? null;

  // (a) Tagged → strict match.
  if (stampedCode !== null || stampedAt !== null) {
    if (stampedCode === currentCode && stampedAt === currentBlockedAt) {
      return rec;
    }
    return {};
  }

  // (b)/(c) Untagged: legacy adoption iff last_attempt_at >= blocked_at.
  // When the current state has neither code nor blocked_at, fall back
  // to the original pre-tag behavior (genuinely ambiguous → trust).
  if (currentCode === null && currentBlockedAt === null) return rec;
  // Codex r4/r5 on PR #242 [data-integrity]: must compare
  // chronologically (mixed millisecond precision misorders strings)
  // AND reject inputs that Date.parse silently normalizes from
  // impossible calendar dates (e.g. `2026-02-31` → 2026-03-03). Strict
  // ISO-Z parser: regex shape check + Date.parse + round-trip
  // verification of the parsed numeric components against the claimed
  // ones. Anything that doesn't survive this is treated as malformed
  // → discard untagged recovery (fail-closed).
  const stampedLastAt = typeof rec.last_attempt_at === 'string' ? rec.last_attempt_at : null;
  if (!stampedLastAt || !currentBlockedAt) return {};
  const stampedMs = parseStrictIsoUtcMs(stampedLastAt);
  const currentMs = parseStrictIsoUtcMs(currentBlockedAt);
  if (stampedMs === null || currentMs === null) return {};
  if (stampedMs >= currentMs) return rec;
  return {};
}

// Strict ISO 8601 UTC parser. Returns the numeric milliseconds since
// epoch only when the input is in canonical `YYYY-MM-DDTHH:MM:SS(.\d+)?Z`
// shape AND the parsed Date's components match the input verbatim
// (so an impossible calendar date like 2026-02-31 — which Date.parse
// silently rolls forward to 2026-03-03 — is rejected). Returns null
// for any malformed / non-UTC / out-of-range input.
const STRICT_ISO_Z = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;
function parseStrictIsoUtcMs(input) {
  if (typeof input !== 'string') return null;
  const m = STRICT_ISO_Z.exec(input);
  if (!m) return null;
  const ms = Date.parse(input);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (
    d.getUTCFullYear() !== Number(m[1]) ||
    d.getUTCMonth() + 1 !== Number(m[2]) ||
    d.getUTCDate() !== Number(m[3]) ||
    d.getUTCHours() !== Number(m[4]) ||
    d.getUTCMinutes() !== Number(m[5]) ||
    d.getUTCSeconds() !== Number(m[6])
  ) {
    return null;
  }
  return ms;
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

// #234: deterministic auto-fix. Re-run the mechanical postprocess
// that produced the missing/stale derived artifact. Capped retries
// so a permission / disk error doesn't loop forever.
function recoverAutoRegenerate(cwd, state) {
  const code = state.block_code;
  // Codex r2 [data-integrity]: read attempts only from the
  // scope-tagged recovery state so stale attempts from a previous
  // block can't poison a fresh, recoverable envelope.
  const attempts = Number(activeRecoveryState(state).attempts || 0);
  if (attempts >= AUTO_FIX_RETRY_BUDGET) {
    const reason = `[MPL Recover] Auto-fix budget exhausted for ${code} after ${attempts} attempts; inspect the underlying I/O failure manually.`;
    keepBlocked(cwd, state, {
      status: 'failed',
      reason,
      instruction:
        state.resume_instruction ||
        'Resolve the I/O failure (permissions / disk space / malformed source) and re-save the decomposition source artifact.',
      details: { handler: 'auto_regenerate', code, attempts },
    });
    return buildResult(state, { status: 'failed', message: reason, attempts });
  }

  let written = null;
  try {
    if (code === 'decomposition_derived_stale') {
      writeDerivedDecompositionFields(cwd);
    } else if (code === 'test_agent_briefs_write_failed') {
      // Codex r1 on PR #242 [data-integrity]: writeTestAgentBriefs
      // does NOT throw when decomposition.yaml is absent — it returns
      // an empty list. Blindly treating that as success would clear
      // the block while no brief was actually regenerated. Verify the
      // produced phase ids before declaring recovery.
      written = writeTestAgentBriefs(cwd);
    } else {
      const reason = `[MPL Recover] No regeneration handler for ${code}.`;
      keepBlocked(cwd, state, {
        status: 'unsupported',
        reason,
        instruction: state.resume_instruction || 'Resolve the recorded hook block manually.',
        details: { handler: 'auto_regenerate', code },
      });
      return buildResult(state, { status: 'unsupported', message: reason });
    }
  } catch (error) {
    const reason = `[MPL Recover] Auto-fix regeneration failed for ${code}: ${error?.message || 'unknown error'}.`;
    keepBlocked(cwd, state, {
      status: 'failed',
      reason,
      instruction:
        'Inspect the source artifact / disk / permissions and retry. Auto-fix will quit after the retry budget is exhausted.',
      details: { handler: 'auto_regenerate', code, error: error?.message || 'unknown' },
    });
    return buildResult(state, { status: 'failed', message: reason });
  }

  // Post-condition check: silent no-op (empty produced list) when the
  // source artifact is missing must NOT clear the block.
  if (code === 'test_agent_briefs_write_failed') {
    const decompositionPresent = existsSync(join(cwd, DECOMPOSITION_REL_PATH));
    const producedCount = Array.isArray(written) ? written.length : 0;
    if (!decompositionPresent || producedCount === 0) {
      const reason = decompositionPresent
        ? '[MPL Recover] writeTestAgentBriefs produced zero briefs (no phases declared test_agent_required); keeping the block.'
        : '[MPL Recover] Cannot regenerate test-agent briefs because .mpl/mpl/decomposition.yaml is missing.';
      keepBlocked(cwd, state, {
        status: 'failed',
        reason,
        instruction: decompositionPresent
          ? 'Verify the blocked phase has test_agent_required: true in decomposition.yaml, then retry.'
          : 'Re-run decomposition to recreate decomposition.yaml, then retry.',
        details: {
          handler: 'auto_regenerate',
          code,
          decomposition_present: decompositionPresent,
          produced_count: producedCount,
        },
      });
      return buildResult(state, {
        status: 'failed',
        message: reason,
        decomposition_present: decompositionPresent,
        produced_count: producedCount,
      });
    }
  }

  clearCurrentBlock(cwd, state);
  appendRecoverySignal(cwd, {
    ...summarizeState(state),
    result: 'recovered',
    handler: 'auto_regenerate',
    code,
    produced: written,
  });
  return buildResult(state, {
    status: 'recovered',
    message: `Regenerated derived artifact for ${code} and cleared blocked_hook.`,
    produced: written,
  });
}

// Codex r1 on PR #242 [contract-break]: real hooks record validator
// diagnostics under different retry_context field names. Normalize
// across all known shapes so the dispatch instruction echoes the
// actual findings instead of dropping them.
//
//   covers_schema_violation        → retry_context.issues
//   phase_contract_graph_invalid   → retry_context.issues
//   (legacy test fixtures used `failures` — preserved for back-compat)
function collectValidatorDiagnostics(state) {
  const ctx = state?.retry_context || {};
  const items = [];
  for (const key of ['failures', 'issues', 'missing']) {
    const v = ctx[key];
    if (Array.isArray(v)) {
      for (const entry of v) items.push(entry);
    }
  }
  return items
    .filter((x) => x !== null && x !== undefined)
    .map((x) => {
      if (typeof x === 'string') return x;
      try { return JSON.stringify(x); } catch { return String(x); }
    });
}

// #234: producer-agent re-dispatch. Recover skill returns a dispatch
// instruction (no actual agent spawn — that's the orchestrator's
// responsibility). Validator diagnostics from retry_context.failures
// / .issues / .missing are normalized and echoed back so the producer
// can fix the exact findings.
function recoverRedispatchDecomposer(cwd, state) {
  const code = state.block_code;
  const diagnostics = collectValidatorDiagnostics(state);
  const failureSummary = diagnostics.length > 0
    ? `Validator findings to address: ${diagnostics.slice(0, 8).join('; ')}.`
    : '';
  const instruction =
    `Re-dispatch Task(subagent_type="mpl-decomposer", model="sonnet", prompt=...) to fix ${code}. ${failureSummary}`.trim();

  const reason = `[MPL Recover] ${code} requires decomposer re-dispatch.`;
  keepBlocked(cwd, state, {
    status: 'awaiting_decomposer',
    reason,
    instruction,
    details: { handler: 'redispatch_decomposer', code, findings: diagnostics },
  });
  return buildResult(state, {
    status: 'awaiting_decomposer',
    message: reason,
    dispatch_instruction: instruction,
    findings: diagnostics,
  });
}

// Codex r1 on PR #242 [logic]: `goal_contract_invalid` recovery is a
// user-action route. The recorded resume_instruction is "Restore a
// valid .mpl/goal-contract.yaml" — a decomposer re-dispatch cannot
// repair a missing source file. Echo the recorded instruction (with a
// generic fallback) so the operator sees the actionable step.
function recoverGoalContractInvalid(cwd, state) {
  const diagnostics = collectValidatorDiagnostics(state);
  const missingSummary = diagnostics.length > 0
    ? ` Missing fields: ${diagnostics.slice(0, 8).join(', ')}.`
    : '';
  const reason = '[MPL Recover] goal_contract_invalid requires restoring .mpl/goal-contract.yaml.';
  const instruction =
    state.resume_instruction ||
    'Restore a valid .mpl/goal-contract.yaml, then retry the decomposition write.';
  keepBlocked(cwd, state, {
    status: 'requires_user_action',
    reason,
    instruction: `${instruction}${missingSummary}`.trim(),
    details: { handler: 'goal_contract_invalid', findings: diagnostics },
  });
  return buildResult(state, {
    status: 'requires_user_action',
    message: reason,
    user_instruction: `${instruction}${missingSummary}`.trim(),
    findings: diagnostics,
  });
}

// #234: phase-runner anomaly re-dispatch. block_code shape is
// `phase_runner_<anomaly_type>` (emitted at hooks/mpl-gate-recorder.mjs
// per subagent anomaly). Each anomaly has a different corrective
// framing — keep the dispatch templates here so the recover skill is
// a single source of truth.
const PHASE_RUNNER_ANOMALY_TEMPLATES = {
  empty_response:
    'Re-dispatch Task(subagent_type="mpl-phase-runner", model="sonnet", prompt=...) with stronger framing: include the full phase brief and require structured JSON output. Verify the phase prompt isn\'t exceeding context budget.',
  truncated_response:
    'Re-dispatch Task(subagent_type="mpl-phase-runner", model="sonnet", prompt=...) with reduced context: drop optional decomposition fields, focus the prompt on the single phase brief, request output in chunks if necessary.',
  invalid_json:
    'Re-dispatch Task(subagent_type="mpl-phase-runner", model="sonnet", prompt=...) with explicit JSON schema reminder at the prompt tail. The previous run emitted unparseable output.',
  no_evidence:
    'Re-dispatch Task(subagent_type="mpl-phase-runner", model="sonnet", prompt=...) emphasizing evidence_required fields. Previous run completed without latching required evidence.',
};

function recoverPhaseRunnerAnomaly(cwd, state) {
  const code = state.block_code || '';
  const anomalyType = code.startsWith('phase_runner_') ? code.slice('phase_runner_'.length) : '';
  const template = PHASE_RUNNER_ANOMALY_TEMPLATES[anomalyType];
  const phaseId = state.blocked_phase || state?.retry_context?.phase_id || null;

  const instruction = template ||
    state.resume_instruction ||
    `Re-dispatch Task(subagent_type="mpl-phase-runner", model="sonnet", prompt=...) for ${phaseId || 'the blocked phase'} after addressing the recorded ${anomalyType || 'anomaly'}.`;

  const reason = `[MPL Recover] ${code} requires mpl-phase-runner re-dispatch (anomaly=${anomalyType || 'unknown'}).`;
  keepBlocked(cwd, state, {
    status: 'awaiting_phase_runner',
    reason,
    instruction,
    details: { handler: 'phase_runner_anomaly', code, anomaly: anomalyType, phase_id: phaseId },
  });
  return buildResult(state, {
    status: 'awaiting_phase_runner',
    message: reason,
    dispatch_instruction: instruction,
    anomaly: anomalyType,
    phase_id: phaseId,
  });
}

// #234: baseline_immutable echoes the recorded resume_instruction
// (touch the renewal sentinel). No agent dispatch; user action.
function recoverBaselineImmutable(cwd, state) {
  const reason = '[MPL Recover] Baseline is immutable; renewal sentinel required.';
  const instruction =
    state.resume_instruction ||
    'Touch .mpl/mpl/.baseline-renewal to authorize a new baseline write, then retry.';
  keepBlocked(cwd, state, {
    status: 'requires_user_action',
    reason,
    instruction,
    details: { handler: 'baseline_immutable' },
  });
  return buildResult(state, {
    status: 'requires_user_action',
    message: reason,
    user_instruction: instruction,
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

  // #234 new routes:
  if (AUTO_FIX_REGENERATE_CODES.has(code)) {
    const attempts = Number(activeRecoveryState(state).attempts || 0);
    const exhausted = attempts >= AUTO_FIX_RETRY_BUDGET;
    return buildResult(state, {
      status: exhausted ? 'unsupported' : 'recoverable',
      handler: 'auto_regenerate',
      safe: true,
      attempts,
      message: exhausted
        ? `Auto-fix budget exhausted (${attempts}/${AUTO_FIX_RETRY_BUDGET}). Resolve the I/O failure manually.`
        : 'Recover can re-run the deterministic postprocess that produced the derived artifact.',
    });
  }
  if (REDISPATCH_DECOMPOSER_CODES.has(code)) {
    return buildResult(state, {
      status: 'requires_approval',
      handler: 'redispatch_decomposer',
      safe: false,
      message: 'Recover returns a mpl-decomposer dispatch instruction with the validator findings; orchestrator must execute the Task call.',
    });
  }
  if (code === 'goal_contract_invalid') {
    return buildResult(state, {
      status: 'requires_user_action',
      handler: 'goal_contract_invalid',
      safe: false,
      message: 'goal_contract_invalid requires restoring .mpl/goal-contract.yaml; recover echoes the recorded user instruction.',
    });
  }
  if (code && code.startsWith('phase_runner_')) {
    const anomalyType = code.slice('phase_runner_'.length);
    return buildResult(state, {
      status: 'requires_approval',
      handler: 'phase_runner_anomaly',
      anomaly: anomalyType,
      safe: false,
      message: `Recover returns a mpl-phase-runner re-dispatch instruction for anomaly=${anomalyType}.`,
    });
  }
  if (code === 'baseline_immutable') {
    return buildResult(state, {
      status: 'requires_user_action',
      handler: 'baseline_immutable',
      safe: false,
      message: 'Baseline renewal sentinel (.mpl/mpl/.baseline-renewal) must be touched manually to authorize the write.',
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
  if (AUTO_FIX_REGENERATE_CODES.has(code)) {
    return recoverAutoRegenerate(cwd, state);
  }
  if (REDISPATCH_DECOMPOSER_CODES.has(code)) {
    return recoverRedispatchDecomposer(cwd, state);
  }
  if (code === 'goal_contract_invalid') {
    return recoverGoalContractInvalid(cwd, state);
  }
  if (code && code.startsWith('phase_runner_')) {
    return recoverPhaseRunnerAnomaly(cwd, state);
  }
  if (code === 'baseline_immutable') {
    return recoverBaselineImmutable(cwd, state);
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
