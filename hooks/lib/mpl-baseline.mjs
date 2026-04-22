#!/usr/bin/env node
/**
 * MPL Baseline — Branch Main State Snapshot (#59)
 *
 * `.mpl/mpl/baseline.yaml` records the immutable ground-truth checkpoint taken
 * immediately after Stage 2 Ambiguity Resolution closes. Downstream consumers
 * (Decomposer, Seed Generator, 4.7 partial rollback, 5.1.5 scope drift)
 * reference baseline for delta calculation and rollback target.
 *
 * Schema:
 *   created_at: ISO timestamp (write-once)
 *   pipeline_id: state.pipeline_id
 *   git:
 *     base_sha: git rev-parse HEAD
 *     base_branch: git rev-parse --abbrev-ref HEAD
 *     working_tree_clean: boolean (git status --porcelain empty?)
 *   artifacts:
 *     pivot_points:       { path, sha256 }
 *     core_scenarios:     { path, sha256 }
 *     design_intent:      { path, sha256 }
 *     user_contract:      { path, sha256 }   # null if skip-mode
 *     codebase_analysis:  { path, sha256, skipped: boolean }
 *     raw_scan:           { path, sha256 }
 *   ambiguity:
 *     final_score: number
 *     threshold_met: boolean
 *     override: { active, reason, by } | null
 *     rounds: number
 *   spec:
 *     user_request_hash: sha256(user_request)
 *     resolved_spec_hash: sha256(Stage 1 + Stage 2 user_responses)
 *
 * Immutability: once written, `mpl-baseline-guard.mjs` (PreToolUse Edit|Write)
 * blocks subsequent writes to baseline.yaml. Only Phase 0 re-interview may
 * overwrite, and the guard accepts writes only when the sentinel flag
 * `.mpl/mpl/.baseline-renewal` exists.
 */

import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';

const BASELINE_PATH = '.mpl/mpl/baseline.yaml';
const RENEWAL_FLAG = '.mpl/mpl/.baseline-renewal';

/**
 * Compute SHA-256 of a file's contents. Returns null if the file does not exist.
 */
export function sha256File(cwd, relPath) {
  const abs = resolve(cwd, relPath);
  if (!existsSync(abs)) return null;
  const buf = readFileSync(abs);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Compute SHA-256 of a string (normalized: trim + LF).
 */
export function sha256String(s) {
  const normalized = String(s ?? '').replace(/\r\n/g, '\n').trim();
  return createHash('sha256').update(normalized, 'utf-8').digest('hex');
}

/**
 * Shell out to git. Returns trimmed stdout or null on error.
 */
function git(cwd, args) {
  try {
    return execSync(`git ${args}`, {
      cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8'
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Build a baseline snapshot object from the current project state.
 *
 * @param {string} cwd
 * @param {object} opts
 * @param {string} opts.pipelineId
 * @param {string} opts.userRequest
 * @param {string} opts.accumulatedResponses - concatenated Stage 1 + Stage 2 user responses
 * @param {object} opts.ambiguity - { final_score, threshold_met, override, rounds }
 * @param {boolean} opts.codebaseSkipped - true if Step 2 was skipped (greenfield)
 * @returns {object} baseline snapshot
 */
export function buildBaseline(cwd, {
  pipelineId,
  userRequest,
  accumulatedResponses,
  ambiguity,
  codebaseSkipped,
}) {
  const baseSha = git(cwd, 'rev-parse HEAD');
  const baseBranch = git(cwd, 'rev-parse --abbrev-ref HEAD');
  const porcelain = git(cwd, 'status --porcelain');
  const workingTreeClean = porcelain === '';

  const artifactFor = (relPath) => {
    const hash = sha256File(cwd, relPath);
    return hash ? { path: relPath, sha256: hash } : null;
  };

  const codebaseHash = sha256File(cwd, '.mpl/mpl/codebase-analysis.json');

  return {
    created_at: new Date().toISOString(),
    pipeline_id: pipelineId,
    git: {
      base_sha: baseSha,
      base_branch: baseBranch,
      working_tree_clean: workingTreeClean,
    },
    artifacts: {
      pivot_points: artifactFor('.mpl/pivot-points.md'),
      core_scenarios: artifactFor('.mpl/mpl/core-scenarios.yaml'),
      design_intent: artifactFor('.mpl/mpl/phase0/design-intent.yaml'),
      user_contract: artifactFor('.mpl/requirements/user-contract.md'),
      codebase_analysis: codebaseSkipped
        ? { path: '.mpl/mpl/codebase-analysis.json', sha256: null, skipped: true }
        : (codebaseHash
            ? { path: '.mpl/mpl/codebase-analysis.json', sha256: codebaseHash, skipped: false }
            : { path: '.mpl/mpl/codebase-analysis.json', sha256: null, skipped: true }),
      raw_scan: artifactFor('.mpl/mpl/phase0/raw-scan.md'),
    },
    ambiguity: {
      final_score: ambiguity?.final_score ?? null,
      threshold_met: ambiguity?.threshold_met ?? false,
      override: ambiguity?.override ?? null,
      rounds: ambiguity?.rounds ?? 0,
    },
    spec: {
      user_request_hash: sha256String(userRequest),
      resolved_spec_hash: sha256String(accumulatedResponses),
    },
  };
}

/**
 * Serialize baseline to simple YAML (no external dep). We control the shape,
 * so a hand-rolled emitter is sufficient and cheap.
 */
export function serializeBaseline(b) {
  const lines = [];
  lines.push(`created_at: "${b.created_at}"`);
  lines.push(`pipeline_id: "${b.pipeline_id ?? ''}"`);
  lines.push('git:');
  lines.push(`  base_sha: ${b.git.base_sha ? `"${b.git.base_sha}"` : 'null'}`);
  lines.push(`  base_branch: ${b.git.base_branch ? `"${b.git.base_branch}"` : 'null'}`);
  lines.push(`  working_tree_clean: ${Boolean(b.git.working_tree_clean)}`);
  lines.push('artifacts:');
  for (const [k, v] of Object.entries(b.artifacts)) {
    if (v === null) {
      lines.push(`  ${k}: null`);
      continue;
    }
    lines.push(`  ${k}:`);
    lines.push(`    path: "${v.path}"`);
    lines.push(`    sha256: ${v.sha256 ? `"${v.sha256}"` : 'null'}`);
    if (typeof v.skipped === 'boolean') {
      lines.push(`    skipped: ${v.skipped}`);
    }
  }
  lines.push('ambiguity:');
  lines.push(`  final_score: ${b.ambiguity.final_score ?? 'null'}`);
  lines.push(`  threshold_met: ${Boolean(b.ambiguity.threshold_met)}`);
  if (b.ambiguity.override) {
    lines.push('  override:');
    for (const [k, v] of Object.entries(b.ambiguity.override)) {
      const value = typeof v === 'string' ? `"${v}"` : v;
      lines.push(`    ${k}: ${value}`);
    }
  } else {
    lines.push('  override: null');
  }
  lines.push(`  rounds: ${b.ambiguity.rounds ?? 0}`);
  lines.push('spec:');
  lines.push(`  user_request_hash: "${b.spec.user_request_hash}"`);
  lines.push(`  resolved_spec_hash: "${b.spec.resolved_spec_hash}"`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Write baseline.yaml to disk. Caller must ensure renewal flag is set when
 * overwriting an existing baseline (the PreToolUse guard enforces this for
 * non-orchestrator writers).
 */
export function writeBaseline(cwd, baseline) {
  const abs = resolve(cwd, BASELINE_PATH);
  mkdirSync(resolve(cwd, '.mpl/mpl'), { recursive: true });
  writeFileSync(abs, serializeBaseline(baseline), 'utf-8');
  return abs;
}

/**
 * Check whether a baseline already exists on disk.
 */
export function baselineExists(cwd) {
  return existsSync(resolve(cwd, BASELINE_PATH));
}

/**
 * Check renewal flag. Returns true if `.mpl/mpl/.baseline-renewal` exists.
 * Orchestrator drops this file before Phase 0 re-interview to authorize a
 * baseline overwrite.
 */
export function renewalAuthorized(cwd) {
  return existsSync(resolve(cwd, RENEWAL_FLAG));
}

export const BASELINE_FILE = BASELINE_PATH;
export const RENEWAL_FLAG_FILE = RENEWAL_FLAG;
