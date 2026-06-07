#!/usr/bin/env node
/**
 * MPL Finalize Artifact Guard — thin wrapper.
 *
 * Phase B of the policy-module migration: the core "artifact + RUNBOOK +
 * timestamps + security evidence" allow/block decision is delegated to
 * `hooks/lib/policy/contracts.mjs::handleFinalizeArtifacts`. This wrapper
 * preserves the legacy concerns that are NOT (yet) part of the pure policy:
 *
 *   1. Early filters: stdin parse, isMplActive, tool-name allowlist,
 *      isFinalizeDoneWrite shape gate.
 *   2. `.mpl/config/finalize-artifact-override.json` user-approved bypass.
 *   3. `loadConfig.finalize_artifacts_required === false` workspace bypass.
 *   4. Baseline goal-contract hash checks with the legacy reason text
 *      (`raw shasum may differ because MPL normalizes CRLF to LF`,
 *      `corrupt baseline.yaml goal_contract sha256`, etc.) — assertions
 *      in `__tests__/mpl-require-finalize-artifacts.test.mjs` match this
 *      specific wording, so the policy module's terser reason can't be
 *      surfaced as-is.
 *   5. `contract.completion_evidence.require_commit` check
 *      (`hasCommitSinceBaseline`).
 *   6. Exp22 R6 / #205 scheduler observability guard
 *      (`schedulerExplanationMissing`). This is a large block of
 *      aggregation/comparison logic that lives in the wrapper because the
 *      policy module does not depend on `mpl-scheduler-aggregate.mjs`.
 *   7. Legacy stdout / envelope side-effects:
 *        - block → emitBlockedHook (records envelope + decision:'block')
 *        - allow → emitClearedOk (clears stale envelope)
 *
 * The legacy implementation is preserved at
 * `mpl-require-finalize-artifacts.legacy.mjs` for emergency rollback.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

const { readState, isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { loadConfig } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-config.mjs')).href
);
const { readGoalContract, readBaselineGoalContractHash } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-goal-contract.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { aggregateScheduler, explanationRequiredFromAggregate } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-scheduler-aggregate.mjs')).href
);
const { emitBlockedHook, emitClearedOk } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-block-surface.mjs')).href
);
const { handleFinalizeArtifacts } = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'contracts.mjs')).href
);

const HOOK_ID = 'mpl-require-finalize-artifacts';
const BLOCKED_ARTIFACT = '.mpl/state.json#finalize_done';
const RULE_ID = 'missing_finalize_artifacts';

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function blockWithEnvelope(cwd, state, { code, reason, resumeInstruction, retryContext = {} }) {
  emitBlockedHook(cwd, state, {
    hookId: HOOK_ID,
    ruleId: RULE_ID,
    code,
    artifact: BLOCKED_ARTIFACT,
    reason,
    resumeInstruction,
    retryContext,
  });
}

function targetPaths(toolInput) {
  const paths = [];
  if (toolInput.file_path) paths.push(toolInput.file_path);
  if (toolInput.filePath) paths.push(toolInput.filePath);
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (edit?.file_path) paths.push(edit.file_path);
      if (edit?.filePath) paths.push(edit.filePath);
    }
  }
  return paths;
}

function proposedTexts(toolInput) {
  const texts = [];
  for (const key of ['new_string', 'newString', 'content']) {
    if (typeof toolInput[key] === 'string') texts.push(toolInput[key]);
  }
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      for (const key of ['new_string', 'newString', 'content']) {
        if (typeof edit?.[key] === 'string') texts.push(edit[key]);
      }
    }
  }
  return texts;
}

function isFinalizeDoneWrite(toolInput) {
  if (!targetPaths(toolInput).some((p) => /\.mpl\/state\.json$/.test(p))) return false;
  return proposedTexts(toolInput).some((text) => /"finalize_done"\s*:\s*true/.test(text));
}

function loadOverride(cwd) {
  const path = join(cwd, '.mpl', 'config', 'finalize-artifact-override.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof parsed?.reason === 'string' && parsed.reason.trim()) return parsed;
  } catch { /* fall through */ }
  return null;
}

function readJsonIfExists(cwd, relPath) {
  const path = join(cwd, relPath);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); }
  catch { return null; }
}

function readBaselineSha(cwd) {
  const path = join(cwd, '.mpl', 'mpl', 'baseline.yaml');
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, 'utf-8');
    const match = text.match(/base_sha:\s*["']?([0-9a-f]{7,40})["']?/i);
    return match ? match[1] : null;
  } catch { return null; }
}

function hasCommitSinceBaseline(cwd) {
  const base = readBaselineSha(cwd);
  if (!base) return { ok: false, reason: 'baseline_sha_missing' };
  try {
    const count = execFileSync('git', ['rev-list', '--count', `${base}..HEAD`], {
      cwd, encoding: 'utf-8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { ok: Number(count) > 0, reason: Number(count) > 0 ? null : 'no_commit_since_baseline' };
  } catch { return { ok: false, reason: 'git_commit_check_failed' }; }
}

// Exp22 R6 / #205: machine-enforce the scheduler observability MUST.
// Computes per-aggregate evidence from phase-scheduler.jsonl +
// state.phase_scheduler_history and compares it against the self-report
// in run-summary.json. Returns a string error code on violation, null on
// success. Lives in the wrapper because the policy module deliberately
// does not depend on the aggregator.
function schedulerExplanationMissing(cwd, state) {
  const computed = aggregateScheduler(cwd, state);
  if (!computed) return null;
  if (computed.__decomposition_unparseable__) {
    return 'scheduler:decomposition_execution_tiers_unparseable';
  }
  if (computed.tiers_parallel_requested === 0) return null;

  const summary = readJsonIfExists(cwd, '.mpl/mpl/profile/run-summary.json');
  if (!summary) return 'scheduler:run_summary_missing';
  const sched = summary.scheduler;
  if (!sched || typeof sched !== 'object') return 'scheduler:block_missing';

  const scalarKeys = [
    'tiers_total', 'tiers_parallel_requested', 'tiers_parallel_executed',
    'tiers_parallel_rejected', 'waves_parallel_rejected', 'waves_parallel_failed',
  ];
  for (const k of scalarKeys) {
    const a = Number(computed[k]);
    const b = Number(sched[k]);
    if (!Number.isInteger(b) || a !== b) {
      return `scheduler:${k}_mismatch:computed=${a},summary=${sched[k] ?? 'null'}`;
    }
  }
  for (const k of ['tiers_with_missing_telemetry', 'tiers_with_partial_rejection']) {
    const computedSorted = Array.isArray(computed[k])
      ? [...computed[k]].map(Number).sort((x, y) => x - y) : [];
    const summarySorted = Array.isArray(sched[k])
      ? [...sched[k]].map(Number).sort((x, y) => x - y) : null;
    if (summarySorted === null) return `scheduler:${k}_not_array_in_summary`;
    if (computedSorted.length !== summarySorted.length ||
        computedSorted.some((v, i) => v !== summarySorted[i])) {
      return `scheduler:${k}_contents_mismatch:computed=[${computedSorted.join(',')}],summary=[${summarySorted.join(',')}]`;
    }
  }

  const computedReasons = [...(computed.rejection_reasons || [])].sort();
  const summaryReasons = Array.isArray(sched.rejection_reasons)
    ? [...sched.rejection_reasons].filter((r) => typeof r === 'string' && r).sort()
    : null;
  if (summaryReasons === null) return 'scheduler:rejection_reasons_not_array_in_summary';
  const computedReasonSet = new Set(computedReasons);
  const summaryReasonSet = new Set(summaryReasons);
  const reasonsMatch = computedReasonSet.size === summaryReasonSet.size &&
    [...computedReasonSet].every((r) => summaryReasonSet.has(r));
  if (!reasonsMatch) {
    return `scheduler:rejection_reasons_mismatch:computed=[${[...computedReasonSet].sort().join(',')}],summary=[${[...summaryReasonSet].sort().join(',')}]`;
  }

  const explanation = sched.no_parallel_explanation;
  const explanationFilled = typeof explanation === 'string' && explanation.trim().length > 0;
  if (explanationRequiredFromAggregate(computed) && !explanationFilled) {
    return 'scheduler:no_parallel_explanation_required_but_missing';
  }
  if (explanationFilled && Array.isArray(computed.affected_tier_ids) && computed.affected_tier_ids.length > 0) {
    const missingMentions = computed.affected_tier_ids.filter((tid) => {
      const re = new RegExp(`(^|[^\\d])${tid}(?=[^\\d]|$)`);
      return !re.test(explanation);
    });
    if (missingMentions.length > 0) {
      return `scheduler:no_parallel_explanation_missing_tier_refs:[${missingMentions.join(',')}]`;
    }
  }
  if (!explanationFilled) return null;
  const lowerExplanation = explanation.toLowerCase();
  const containsToken = (token) => {
    const t = String(token).toLowerCase();
    const variants = [t, t.replace(/_/g, '-'), t.replace(/_/g, ' ')];
    return variants.some((v) => {
      if (!v) return false;
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?=[^A-Za-z0-9_-]|$)`);
      return re.test(lowerExplanation);
    });
  };

  if (computedReasons.length > 0) {
    const matched = computedReasons.some(containsToken);
    if (!matched) {
      return `scheduler:no_parallel_explanation_missing_reasons:expected_one_of=[${computedReasons.join(',')}]`;
    }
  }

  const computedFailureCodes = Array.isArray(computed?.failure_codes)
    ? computed.failure_codes.filter((c) => typeof c === 'string' && c) : [];
  for (const code of computedFailureCodes) {
    if (!containsToken(code)) {
      return `scheduler:no_parallel_explanation_missing_failure_code:expected=${code}`;
    }
  }

  const requiredDegraded = [];
  if (explanationRequiredFromAggregate(computed)) {
    if (Array.isArray(computed.tiers_with_missing_telemetry) && computed.tiers_with_missing_telemetry.length > 0) {
      requiredDegraded.push('missing_telemetry');
    }
    if ((computed.waves_parallel_rejected_without_reason || 0) > 0) {
      requiredDegraded.push('parallel_rejected_without_reason');
    }
    if ((computed.waves_parallel_failed_without_reason || 0) > 0) {
      requiredDegraded.push('parallel_failed_without_reason');
    }
    const hasFailureCode = Array.isArray(computed?.failure_codes) && computed.failure_codes.length > 0;
    if (requiredDegraded.length === 0 && computedReasons.length === 0 && !hasFailureCode) {
      requiredDegraded.push('no_recorded_reason');
    }
  }
  for (const token of requiredDegraded) {
    if (!containsToken(token)) {
      return `scheduler:no_parallel_explanation_missing_degraded_cause:expected=${token}`;
    }
  }
  return null;
}

/**
 * Translate the policy module's `{ action:'block', code, reason, retryContext }`
 * envelope into the legacy reason text the test suite asserts on. The policy's
 * messages are terser; tests assert the legacy phrasing (e.g. "Cannot set
 * finalize_done=true — missing completion evidence: ...").
 */
function legacyReasonFromPolicy(decision) {
  const code = decision.code || 'finalize_artifacts_missing';
  const ctx = decision.retryContext || {};
  if (code === 'goal_contract_invalid') {
    const missing = Array.isArray(ctx.missing) ? ctx.missing.join(', ') : '';
    return {
      reason:
        `[MPL Goal Contract] Cannot set finalize_done=true — goal contract missing or invalid: ${missing}.`,
      resumeInstruction:
        'Restore a valid .mpl/goal-contract.yaml (Phase 0 renewal) and re-attempt finalize.',
    };
  }
  // finalize_artifacts_missing
  const missingList = Array.isArray(ctx.missing) ? ctx.missing.join(', ') : '';
  return {
    reason:
      `[MPL Finalize Guard] Cannot set finalize_done=true — missing completion evidence: ${missingList}. ` +
      'Create the declared artifacts/evidence or record a user-approved override in .mpl/config/finalize-artifact-override.json.',
    resumeInstruction:
      'Create the missing completion artifacts/evidence (or record a user-approved override), then retry finalize.',
  };
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return ok();

  let data;
  try { data = JSON.parse(raw); } catch { return ok(); }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return ok();

  const toolName = String(data.tool_name || data.toolName || '');
  if (!['Write', 'write', 'Edit', 'edit', 'MultiEdit', 'multiEdit'].includes(toolName)) return ok();

  const toolInput = data.tool_input || data.toolInput || {};
  if (!isFinalizeDoneWrite(toolInput)) return ok();

  const cfg = loadConfig(cwd);
  if (cfg.finalize_artifacts_required === false) {
    emitClearedOk(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
    return;
  }

  const override = loadOverride(cwd);
  if (override) {
    emitClearedOk(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
    return;
  }

  const state = readState(cwd) || {};

  // Legacy-only baseline drift / corruption checks. The policy module does
  // not surface the "raw shasum may differ" guidance the test suite asserts,
  // so the wrapper runs these BEFORE delegating so the legacy reason wins.
  const goal = readGoalContract(cwd);
  const contract = goal.valid ? goal.contract : null;
  if (cfg.goal_contract_required !== false && contract?.content_sha256) {
    const baseline = readBaselineGoalContractHash(cwd);
    if (baseline.error) {
      blockWithEnvelope(cwd, state, {
        code: 'goal_contract_baseline_corrupt',
        reason:
          `[MPL Finalize Guard] Cannot set finalize_done=true — corrupt baseline.yaml goal_contract sha256 ` +
          `(${baseline.error}${baseline.rawHash ? `: ${baseline.rawHash}` : ''}). ` +
          `Expected the 64-character lowercase normalized SHA-256 for .mpl/goal-contract.yaml. ` +
          `Raw shasum may differ because MPL normalizes CRLF to LF and trims surrounding whitespace before hashing. ` +
          `Re-run Phase 0 renewal before finalizing.`,
        resumeInstruction:
          'Re-run Phase 0 renewal so baseline.yaml records a valid goal_contract sha256, then retry finalize.',
        retryContext: { baseline_error: baseline.error, raw_hash: baseline.rawHash || null },
      });
      return;
    }
    if (baseline.hash && baseline.hash !== contract.content_sha256) {
      blockWithEnvelope(cwd, state, {
        code: 'goal_contract_drift',
        reason:
          `[MPL Finalize Guard] Cannot set finalize_done=true — goal contract drifted from baseline.yaml ` +
          `(baseline=${baseline.hash}, current=${contract.content_sha256}). ` +
          `These are MPL normalized hashes; raw shasum may differ because MPL normalizes CRLF to LF and trims surrounding whitespace. ` +
          `Re-run Phase 0 renewal before finalizing.`,
        resumeInstruction:
          'Resolve the Goal Contract drift via Phase 0 renewal before retrying finalize.',
        retryContext: { baseline_hash: baseline.hash, current_hash: contract.content_sha256 },
      });
      return;
    }
  }

  // Delegate the core artifact / RUNBOOK / timestamps / security decision
  // to the policy module. Pass a `ctx` shaped as the policy expects.
  const decision = await handleFinalizeArtifacts({
    cwd, state, config: cfg, toolName, toolInput, hookEvent: 'PreToolUse',
  });

  // Pre-policy goal-contract-invalid result is terminal — surface verbatim.
  if (decision.action === 'block' && decision.code === 'goal_contract_invalid') {
    const translated = legacyReasonFromPolicy(decision);
    blockWithEnvelope(cwd, state, {
      code: decision.code,
      reason: translated.reason,
      resumeInstruction: translated.resumeInstruction,
      retryContext: decision.retryContext || {},
    });
    return;
  }

  // Collect missing tokens from the policy block (if any) so we can merge
  // them with the wrapper-only `require_commit` + scheduler tokens before
  // emitting a single combined envelope. The legacy hook always emits ONE
  // block listing every missing item — tests assert e.g. that a missing
  // run-summary.json AND scheduler:decomposition_execution_tiers_unparseable
  // surface together.
  const missing = [];
  if (decision.action === 'block') {
    const policyMissing = Array.isArray(decision.retryContext?.missing)
      ? decision.retryContext.missing : [];
    missing.push(...policyMissing);
  }

  // Legacy-only commit-since-baseline gate (not in policy module).
  if (contract?.completion_evidence?.require_commit === true) {
    const commit = hasCommitSinceBaseline(cwd);
    if (!commit.ok) missing.push(`git:${commit.reason}`);
  }

  // Exp22 R6 / #205: machine-enforce the scheduler observability MUST.
  // Independent of contract.completion_evidence so runs without an explicit
  // completion contract still satisfy the no-parallel-explanation rule.
  const schedulerProblem = schedulerExplanationMissing(cwd, state);
  if (schedulerProblem) missing.push(schedulerProblem);

  if (missing.length > 0) {
    blockWithEnvelope(cwd, state, {
      code: 'finalize_artifacts_missing',
      reason:
        `[MPL Finalize Guard] Cannot set finalize_done=true — missing completion evidence: ${missing.join(', ')}. ` +
        'Create the declared artifacts/evidence or record a user-approved override in .mpl/config/finalize-artifact-override.json.',
      resumeInstruction:
        'Create the missing completion artifacts/evidence (or record a user-approved override), then retry finalize.',
      retryContext: { missing },
    });
    return;
  }

  emitClearedOk(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
}

if (isMain) {
  await main().catch(() => ok());
}
