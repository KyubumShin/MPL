#!/usr/bin/env node
/**
 * MPL Finalize Artifact Guard (PreToolUse on Write|Edit targeting state.json).
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
const { readGoalContract, defaultRequiredArtifacts } = await import(
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

function isFinalizeDoneWrite(toolInput) {
  const filePath = toolInput.file_path || toolInput.filePath || '';
  if (!/\.mpl\/state\.json$/.test(filePath)) return false;
  const newText = toolInput.new_string || toolInput.newString || toolInput.content || '';
  return /"finalize_done"\s*:\s*true/.test(newText);
}

function incomingText(toolInput) {
  return String(toolInput.new_string || toolInput.newString || toolInput.content || '');
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
  if (!['Write', 'write', 'Edit', 'edit'].includes(toolName)) return ok();

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
