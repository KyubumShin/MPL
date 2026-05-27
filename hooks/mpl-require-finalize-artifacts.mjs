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

function readDecompositionTiers(cwd) {
  // Minimal YAML peek: we only need execution_tiers[].parallel bool flags.
  // Parsing the whole decomposition.yaml here would couple this hook to
  // every decomposer field. Use a regex over the execution_tiers block.
  const path = join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
  if (!existsSync(path)) return null;
  let text;
  try { text = readFileSync(path, 'utf-8'); } catch { return null; }
  const block = text.match(/(^|\n)execution_tiers:\s*\n([\s\S]*?)(\n[a-zA-Z_]+:|\n*$)/);
  if (!block) return { tiers: [], parallelTierCount: 0 };
  const tiers = [];
  for (const line of block[2].split('\n')) {
    const parallelMatch = line.match(/^\s*parallel:\s*(true|false)/i);
    if (parallelMatch) tiers.push({ parallel: parallelMatch[1].toLowerCase() === 'true' });
  }
  const parallelTierCount = tiers.filter((t) => t.parallel).length;
  return { tiers, parallelTierCount };
}

function schedulerExplanationMissing(cwd) {
  // Exp22 R6 / #205: when decomposition.yaml declares any
  // execution_tiers[].parallel:true, the run-summary scheduler block must
  // either show full execution or carry a non-null no_parallel_explanation.
  // The prompt in commands/mpl-run-finalize.md already documents this MUST;
  // this guard makes it machine-enforceable so prompt drift cannot ship a
  // completed run with rejected/missing parallelism and no explanation.
  const decomp = readDecompositionTiers(cwd);
  if (!decomp || decomp.parallelTierCount === 0) return null;

  const summary = readJsonIfExists(cwd, '.mpl/mpl/profile/run-summary.json');
  if (!summary) return 'scheduler:run_summary_missing';
  const sched = summary.scheduler;
  if (!sched || typeof sched !== 'object') return 'scheduler:block_missing';

  // decomposition.yaml is the truth for "did this run request parallelism".
  // The summary self-reports tiers_parallel_requested — if the finalizer
  // prompt drifted or someone hand-edited run-summary.json, that field can
  // be set to 0 to vacuously satisfy "executed >= requested". Use the
  // decomposition-derived count instead, and additionally require the
  // summary's self-reported count to match it.
  const requestedFromDecomp = decomp.parallelTierCount;
  const requestedFromSummary = Number(sched.tiers_parallel_requested);
  if (!Number.isInteger(requestedFromSummary) || requestedFromSummary !== requestedFromDecomp) {
    return `scheduler:tiers_parallel_requested_mismatch:decomp=${requestedFromDecomp},summary=${sched.tiers_parallel_requested ?? 'null'}`;
  }

  const executed = Number(sched.tiers_parallel_executed) || 0;
  const missingTelemetry = Array.isArray(sched.tiers_with_missing_telemetry)
    ? sched.tiers_with_missing_telemetry.length : 0;
  const partial = Array.isArray(sched.tiers_with_partial_rejection)
    ? sched.tiers_with_partial_rejection.length : 0;
  const wavesFailed = Number(sched.waves_parallel_failed) || 0;
  const explanation = sched.no_parallel_explanation;
  const explanationFilled = typeof explanation === 'string' && explanation.trim().length > 0;

  const explanationRequired = (
    executed < requestedFromDecomp ||
    missingTelemetry > 0 ||
    partial > 0 ||
    wavesFailed > 0
  );

  if (explanationRequired && !explanationFilled) {
    return 'scheduler:no_parallel_explanation_required_but_missing';
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
  const schedulerProblem = schedulerExplanationMissing(cwd);
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
