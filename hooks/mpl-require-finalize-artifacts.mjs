#!/usr/bin/env node
/**
 * MPL Finalize Artifact Guard (PreToolUse on Write|Edit|MultiEdit targeting state.json).
 *
 * E2E pass/fail is necessary but not sufficient for completion. This hook
 * blocks `finalize_done=true` unless the goal contract's declared completion
 * evidence exists: audit report, run summary, RUNBOOK final section, finalize
 * timestamps, security evidence, and optional commit evidence.
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
const { readGoalContract, readBaselineGoalContractHash, defaultRequiredArtifacts } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-goal-contract.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { aggregateScheduler, explanationRequiredFromAggregate } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-scheduler-aggregate.mjs')).href
);

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function block(reason) {
  console.log(JSON.stringify({ continue: false, decision: 'block', reason }));
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
  // Intentionally re-check any proposed state text that contains
  // finalize_done=true, including state re-serializations after completion:
  // evidence can be deleted or invalidated between final writes.
  return proposedTexts(toolInput).some((text) => /"finalize_done"\s*:\s*true/.test(text));
}

function incomingText(toolInput) {
  return proposedTexts(toolInput).join('\n');
}

function hasTimestamp(state, text, key) {
  if (typeof state?.[key] === 'string' && state[key].trim()) return true;
  const re = new RegExp(`"${key}"\\s*:\\s*"[^"]+"`);
  return re.test(text);
}

function loadOverride(cwd) {
  const path = join(cwd, '.mpl', 'config', 'finalize-artifact-override.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof parsed?.reason === 'string' && parsed.reason.trim()) return parsed;
  } catch {
    // fall through
  }
  return null;
}

function readJsonIfExists(cwd, relPath) {
  const path = join(cwd, relPath);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function isPassRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (record.exit_code === 0) return true;
  if (record.verdict === 'pass' || record.status === 'pass' || record.status === 'PASS') return true;
  return false;
}

function securityEvidenceMissing(cwd, state, contract) {
  if (contract?.security_policy?.required !== true) return [];

  const checks = contract.security_policy.checks || [];
  const report = readJsonIfExists(cwd, '.mpl/mpl/security-report.json');
  const stateResults = state?.security_results && typeof state.security_results === 'object'
    ? state.security_results
    : {};

  if (checks.length === 0) {
    if (isPassRecord(report)) return [];
    return ['security_report_or_checks'];
  }

  const missing = [];
  for (const check of checks) {
    const stateRecord = stateResults[check];
    const reportRecord = report?.checks?.[check];
    if (!isPassRecord(stateRecord) && !isPassRecord(reportRecord)) missing.push(check);
  }
  return missing;
}

function readBaselineSha(cwd) {
  const path = join(cwd, '.mpl', 'mpl', 'baseline.yaml');
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, 'utf-8');
    const match = text.match(/base_sha:\s*["']?([0-9a-f]{7,40})["']?/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function hasCommitSinceBaseline(cwd) {
  const base = readBaselineSha(cwd);
  if (!base) return { ok: false, reason: 'baseline_sha_missing' };
  try {
    const count = execFileSync('git', ['rev-list', '--count', `${base}..HEAD`], {
      cwd,
      encoding: 'utf-8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { ok: Number(count) > 0, reason: Number(count) > 0 ? null : 'no_commit_since_baseline' };
  } catch {
    return { ok: false, reason: 'git_commit_check_failed' };
  }
}

function schedulerExplanationMissing(cwd, state) {
  // Exp22 R6 / #205: when decomposition.yaml declares any
  // execution_tiers[].parallel:true, the run-summary scheduler block must
  // either show full execution or carry a non-null no_parallel_explanation.
  // The prompt in commands/mpl-run-finalize.md documents this MUST; the
  // hook makes it machine-enforceable so prompt drift cannot ship a
  // completed run with rejected/missing parallelism and no explanation.
  //
  // The hook re-derives the aggregation itself from phase-scheduler.jsonl
  // and state.phase_scheduler_history (see hooks/lib/mpl-scheduler-aggregate.mjs).
  // A drifted or hand-edited run-summary can self-report a clean state, so
  // the summary cannot be trusted as the source of truth — only as an
  // informational mirror that must MATCH the computed evidence.
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

  // The summary's self-report must match what we just recomputed from the
  // raw event stream. Mismatches indicate prompt drift, hand-edits, or
  // missing telemetry that the finalizer prompt failed to surface. Compare
  // every aggregate field, not just a sentinel subset — codex r11 noted a
  // narrow subset still let drift through (mis-named missing tier ids,
  // under-reported rejected waves).
  const scalarKeys = [
    'tiers_total',
    'tiers_parallel_requested',
    'tiers_parallel_executed',
    'tiers_parallel_rejected',
    'waves_parallel_rejected',
    'waves_parallel_failed',
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
    if (summarySorted === null) {
      return `scheduler:${k}_not_array_in_summary`;
    }
    if (computedSorted.length !== summarySorted.length ||
        computedSorted.some((v, i) => v !== summarySorted[i])) {
      return `scheduler:${k}_contents_mismatch:computed=[${computedSorted.join(',')}],summary=[${summarySorted.join(',')}]`;
    }
  }

  // rejection_reasons set must match what we observed in events.
  const computedReasons = [...(computed.rejection_reasons || [])].sort();
  const summaryReasons = Array.isArray(sched.rejection_reasons)
    ? [...sched.rejection_reasons].filter((r) => typeof r === 'string' && r).sort()
    : null;
  if (summaryReasons === null) {
    return 'scheduler:rejection_reasons_not_array_in_summary';
  }
  // Set equality (order-independent, deduplicated).
  const computedReasonSet = new Set(computedReasons);
  const summaryReasonSet = new Set(summaryReasons);
  const reasonsMatch =
    computedReasonSet.size === summaryReasonSet.size &&
    [...computedReasonSet].every((r) => summaryReasonSet.has(r));
  if (!reasonsMatch) {
    return `scheduler:rejection_reasons_mismatch:computed=[${[...computedReasonSet].sort().join(',')}],summary=[${[...summaryReasonSet].sort().join(',')}]`;
  }

  const explanation = sched.no_parallel_explanation;
  const explanationFilled = typeof explanation === 'string' && explanation.trim().length > 0;
  if (explanationRequiredFromAggregate(computed) && !explanationFilled) {
    return 'scheduler:no_parallel_explanation_required_but_missing';
  }
  // The explanation must reference each affected tier id by number, so an
  // operator reading the summary can find which tiers lost parallelism.
  // `n/a`-style placeholders fail this check.
  if (explanationFilled && Array.isArray(computed.affected_tier_ids) && computed.affected_tier_ids.length > 0) {
    const missingMentions = computed.affected_tier_ids.filter((tid) => {
      // Match the tier id as a standalone integer (not embedded in another
      // number). Accept both "tier 1" and bare "1" anywhere in the text.
      const re = new RegExp(`(^|[^\\d])${tid}(?=[^\\d]|$)`);
      return !re.test(explanation);
    });
    if (missingMentions.length > 0) {
      return `scheduler:no_parallel_explanation_missing_tier_refs:[${missingMentions.join(',')}]`;
    }
  }
  // #214: tier-id-only explanations (e.g. "tier 1") used to pass even
  // when computed.rejection_reasons named concrete reasons like
  // "file_overlap" or "depends_on_predecessor_failure". The summary
  // must actually name at least one such reason — otherwise an operator
  // reading it has zero information about WHY parallelism was lost.
  //
  // Each computed reason has a canonical lowercase snake_case form
  // (e.g. "file_overlap"). The explanation matches a reason when it
  // either includes the exact token, OR includes any of its hyphen-/
  // space-separated variants (e.g. "file-overlap", "file overlap"),
  // case-insensitively. Free text containing the same words in
  // different order or stem (e.g. "overlapping files") does NOT match
  // — operators MUST use the canonical vocabulary so the gate signal
  // is unambiguous.
  if (explanationFilled && computedReasons.length > 0) {
    const lowerExplanation = explanation.toLowerCase();
    const reasonMatched = computedReasons.some((reason) => {
      const r = String(reason).toLowerCase();
      const variants = [r, r.replace(/_/g, '-'), r.replace(/_/g, ' ')];
      return variants.some((v) => lowerExplanation.includes(v));
    });
    if (!reasonMatched) {
      return `scheduler:no_parallel_explanation_missing_reasons:expected_one_of=[${computedReasons.join(',')}]`;
    }
  }
  return null;
}

function runbookFinalized(cwd) {
  const path = join(cwd, '.mpl', 'mpl', 'RUNBOOK.md');
  if (!existsSync(path)) return false;
  try {
    return /(^|\n)##\s+Pipeline Complete\b/.test(readFileSync(path, 'utf-8'));
  } catch {
    return false;
  }
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
  if (cfg.finalize_artifacts_required === false) return ok();

  const override = loadOverride(cwd);
  if (override) return ok();

  const state = readState(cwd) || {};
  const text = incomingText(toolInput);
  const goal = readGoalContract(cwd);
  if (cfg.goal_contract_required !== false && (!goal.exists || !goal.valid)) {
    block(`[MPL Goal Contract] Cannot set finalize_done=true — goal contract missing or invalid: ${goal.missing.join(', ')}.`);
    return;
  }

  const contract = goal.valid ? goal.contract : null;
  if (cfg.goal_contract_required !== false && contract?.content_sha256) {
    const baseline = readBaselineGoalContractHash(cwd);
    if (baseline.error) {
      block(
        `[MPL Finalize Guard] Cannot set finalize_done=true — corrupt baseline.yaml goal_contract sha256 ` +
          `(${baseline.error}${baseline.rawHash ? `: ${baseline.rawHash}` : ''}). ` +
          `Expected the 64-character lowercase normalized SHA-256 for .mpl/goal-contract.yaml. ` +
          `Raw shasum may differ because MPL normalizes CRLF to LF and trims surrounding whitespace before hashing. ` +
          `Re-run Phase 0 renewal before finalizing.`
      );
      return;
    }
    if (baseline.hash && baseline.hash !== contract.content_sha256) {
      block(
        `[MPL Finalize Guard] Cannot set finalize_done=true — goal contract drifted from baseline.yaml ` +
          `(baseline=${baseline.hash}, current=${contract.content_sha256}). ` +
          `These are MPL normalized hashes; raw shasum may differ because MPL normalizes CRLF to LF and trims surrounding whitespace. ` +
          `Re-run Phase 0 renewal before finalizing.`
      );
      return;
    }
  }

  const requiredArtifacts = contract?.completion_evidence?.required_artifacts?.length
    ? contract.completion_evidence.required_artifacts
    : defaultRequiredArtifacts();

  const missing = [];
  for (const rel of requiredArtifacts) {
    if (!existsSync(join(cwd, rel))) missing.push(rel);
  }

  if (requiredArtifacts.includes('.mpl/mpl/RUNBOOK.md') && !runbookFinalized(cwd)) {
    missing.push('.mpl/mpl/RUNBOOK.md#Pipeline Complete');
  }

  if (contract?.completion_evidence?.require_finalize_timestamps !== false) {
    if (!hasTimestamp(state, text, 'completed_at')) missing.push('state.completed_at');
    if (!hasTimestamp(state, text, 'finalized_at')) missing.push('state.finalized_at');
  }

  const securityMissing = securityEvidenceMissing(cwd, state, contract);
  for (const check of securityMissing) missing.push(`security:${check}`);

  if (contract?.completion_evidence?.require_commit === true) {
    const commit = hasCommitSinceBaseline(cwd);
    if (!commit.ok) missing.push(`git:${commit.reason}`);
  }

  // Exp22 R6 / #205: machine-enforce the scheduler observability MUST.
  // Independent of contract.completion_evidence so even runs without an
  // explicit completion contract still satisfy the no-parallel
  // explanation rule when decomposition declared parallel tiers.
  const schedulerProblem = schedulerExplanationMissing(cwd, state);
  if (schedulerProblem) missing.push(schedulerProblem);

  if (missing.length > 0) {
    block(
      `[MPL Finalize Guard] Cannot set finalize_done=true — missing completion evidence: ${missing.join(', ')}. ` +
        'Create the declared artifacts/evidence or record a user-approved override in .mpl/config/finalize-artifact-override.json.'
    );
    return;
  }

  ok();
}

if (isMain) {
  await main().catch(() => ok());
}
