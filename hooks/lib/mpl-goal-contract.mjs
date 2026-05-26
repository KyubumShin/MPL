/**
 * Goal Contract utilities.
 *
 * The goal contract is the pipeline-level constitution: the source goal,
 * project pivot, ontology, variation axes, acceptance criteria, and completion
 * evidence that later gates must prove before `finalize_done=true`.
 *
 * This intentionally uses a small YAML-shaped parser instead of a dependency.
 * MPL artifact schemas are controlled by the prompts, and the hook only needs
 * presence/boolean/list checks for hard-gate readiness. Supported YAML is a
 * prompt-controlled subset: scalar keys, block lists, inline scalar lists, and
 * list-of-object `id:` fields. Block scalars, anchors, aliases, and arbitrary
 * YAML expressions are out of scope; use the schema examples in
 * docs/schemas/goal-contract.md to avoid prompt drift.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

export const GOAL_CONTRACT_REL_PATH = '.mpl/goal-contract.yaml';
export const BASELINE_REL_PATH = '.mpl/mpl/baseline.yaml';
const LOWER_HEX_SHA256_RE = /^[0-9a-f]{64}$/;

const DEFAULT_REQUIRED_ARTIFACTS = [
  '.mpl/mpl/audit-report.json',
  '.mpl/mpl/profile/run-summary.json',
  '.mpl/mpl/RUNBOOK.md',
];

export const MVP_SCOPE_ARTIFACTS = Object.freeze([
  'draft_pr',
  'branch',
  'tag',
  'release_manifest',
]);

function normalizeScalar(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null') return null;
  return trimmed.replace(/^["']|["']$/g, '').trim() || null;
}

function extractTopBlock(text, key) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\r$/, ''));
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    if (new RegExp(`^${key}\\s*:\\s*$`).test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && /^[A-Za-z_][\w-]*\s*:/.test(line)) break;
    if (inBlock) out.push(line);
  }
  return out.join('\n');
}

function scalarInBlock(block, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s+${escaped}\\s*:\\s*(.+?)\\s*$`, 'm');
  const match = block.match(re);
  return match ? normalizeScalar(match[1]) : null;
}

function booleanInBlock(block, key) {
  const raw = scalarInBlock(block, key);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

function listAfterKey(block, key) {
  const lines = String(block || '').split('\n');
  const out = [];
  let inList = false;
  let baseIndent = -1;
  const keyRe = new RegExp(`^(\\s+)${key}\\s*:\\s*(?:\\[(.*)\\])?\\s*$`);

  for (const line of lines) {
    const inline = line.match(keyRe);
    if (inline) {
      inList = true;
      baseIndent = inline[1].length;
      if (inline[2] !== undefined) {
        return inline[2]
          .split(',')
          .map((s) => normalizeScalar(s))
          .filter(Boolean);
      }
      continue;
    }
    if (!inList) continue;

    const item = line.match(/^(\s*)-\s+(.+?)\s*$/);
    if (item && item[1].length > baseIndent) {
      out.push(normalizeScalar(item[2]));
      continue;
    }
    if (line.trim() && item === null && line.match(/^\s*\w[\w-]*\s*:/)) break;
  }
  return out.filter(Boolean);
}

function idsInTopList(text, key, prefixRe) {
  const block = extractTopBlock(text, key);
  const out = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    const itemText = current.join('\n');
    const match = itemText.match(/(?:^|\n)\s*id\s*:\s*["']?([^"'\s#]+)["']?/);
    if (match && (!prefixRe || prefixRe.test(match[1]))) out.push(match[1]);
    current = null;
  };

  for (const line of block.split('\n')) {
    const itemStart = line.match(/^\s*-\s+(.+?)\s*$/);
    if (itemStart) {
      flush();
      current = [itemStart[1]];
      continue;
    }
    if (current) current.push(line);
  }
  flush();
  return out;
}

export function normalizeGoalContractText(text) {
  // Goal contracts are YAML-shaped MPL artifacts. Leading/trailing whitespace
  // and UTF-8 BOMs are non-semantic for this contract hash.
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

export function hashNormalizedGoalContractText(text) {
  return createHash('sha256').update(normalizeGoalContractText(text)).digest('hex');
}

export function hashNormalizedGoalContractFile(cwd, relPath = GOAL_CONTRACT_REL_PATH) {
  const path = join(cwd, relPath);
  if (!existsSync(path)) return null;
  return hashNormalizedGoalContractText(readFileSync(path, 'utf-8'));
}

function parseMvpScope(text) {
  // `null` reserved for "key absent" — i.e., the contract opted out of MVP entirely.
  // A present-but-empty `mvp_scope:` block is a *malformed declaration*: the user
  // committed to MVP but didn't fill it in. Return an empty-shape object so the
  // validator surfaces it as missing AC/AX/artifact rather than silently dropping.
  if (!/^mvp_scope\s*:/m.test(text)) return null;
  const block = extractTopBlock(text, 'mvp_scope');
  return {
    acceptance_criteria: listAfterKey(block, 'acceptance_criteria'),
    variation_axes: listAfterKey(block, 'variation_axes'),
    artifact: scalarInBlock(block, 'artifact'),
  };
}

export function parseGoalContractText(text) {
  const source = extractTopBlock(text, 'source');
  const mission = extractTopBlock(text, 'mission');
  const ontology = extractTopBlock(text, 'ontology');
  const e2ePolicy = extractTopBlock(text, 'e2e_policy');
  const securityPolicy = extractTopBlock(text, 'security_policy');
  const completionEvidence = extractTopBlock(text, 'completion_evidence');

  return {
    source: {
      runtime: scalarInBlock(source, 'runtime'),
      runtime_goal: scalarInBlock(source, 'runtime_goal'),
      codex_goal: scalarInBlock(source, 'codex_goal'),
      claude_goal: scalarInBlock(source, 'claude_goal'),
      user_request: scalarInBlock(source, 'user_request'),
      user_request_hash: scalarInBlock(source, 'user_request_hash'),
    },
    mission: {
      goal: scalarInBlock(mission, 'goal'),
      project_pivot: scalarInBlock(mission, 'project_pivot'),
      non_goals: listAfterKey(mission, 'non_goals'),
      must_ship_outcomes: listAfterKey(mission, 'must_ship_outcomes'),
    },
    ontology: {
      entities: listAfterKey(ontology, 'entities'),
      relationships: listAfterKey(ontology, 'relationships'),
      state_transitions: listAfterKey(ontology, 'state_transitions'),
    },
    variation_axes: idsInTopList(text, 'variation_axes', /^AX-/),
    acceptance_criteria: idsInTopList(text, 'acceptance_criteria', /^AC-/),
    e2e_policy: {
      real_runtime_required: booleanInBlock(e2ePolicy, 'real_runtime_required'),
      mock_allowed: booleanInBlock(e2ePolicy, 'mock_allowed'),
      placeholder_assertions_allowed: booleanInBlock(e2ePolicy, 'placeholder_assertions_allowed'),
    },
    security_policy: {
      required: booleanInBlock(securityPolicy, 'required'),
      checks: listAfterKey(securityPolicy, 'checks'),
    },
    completion_evidence: {
      required_artifacts: listAfterKey(completionEvidence, 'required_artifacts'),
      require_commit: booleanInBlock(completionEvidence, 'require_commit'),
      require_finalize_timestamps: booleanInBlock(completionEvidence, 'require_finalize_timestamps'),
    },
    mvp_scope: parseMvpScope(text),
    content_sha256: hashNormalizedGoalContractText(text),
  };
}

export function validateGoalContractText(text) {
  const contract = parseGoalContractText(text);
  const missing = [];
  const warnings = [];

  if (
    !contract.source.runtime_goal
    && !contract.source.codex_goal
    && !contract.source.claude_goal
    && !contract.source.user_request
  ) {
    missing.push('source.runtime_goal_or_user_request');
  }
  if (!contract.source.user_request_hash) missing.push('source.user_request_hash');
  if (!contract.mission.goal) missing.push('mission.goal');
  if (!contract.mission.project_pivot) missing.push('mission.project_pivot');
  if (contract.mission.must_ship_outcomes.length === 0) missing.push('mission.must_ship_outcomes');
  if (contract.ontology.entities.length === 0) missing.push('ontology.entities');
  if (contract.variation_axes.length === 0) missing.push('variation_axes[].id');
  if (contract.acceptance_criteria.length === 0) missing.push('acceptance_criteria[].id');

  for (const key of ['real_runtime_required', 'mock_allowed', 'placeholder_assertions_allowed']) {
    if (contract.e2e_policy[key] === null) missing.push(`e2e_policy.${key}`);
  }
  if (contract.security_policy.required === null) missing.push('security_policy.required');
  if (contract.security_policy.required === true && contract.security_policy.checks.length === 0) {
    missing.push('security_policy.checks');
  }
  if (contract.completion_evidence.required_artifacts.length === 0) {
    missing.push('completion_evidence.required_artifacts');
  }
  if (contract.completion_evidence.require_commit === null) {
    missing.push('completion_evidence.require_commit');
  }
  if (contract.completion_evidence.require_finalize_timestamps === null) {
    missing.push('completion_evidence.require_finalize_timestamps');
  }

  for (const artifact of DEFAULT_REQUIRED_ARTIFACTS) {
    if (!contract.completion_evidence.required_artifacts.includes(artifact)) {
      warnings.push(`completion_evidence.required_artifacts missing recommended ${artifact}`);
    }
  }

  if (contract.mvp_scope) {
    const acIds = new Set(contract.acceptance_criteria);
    const axIds = new Set(contract.variation_axes);
    for (const id of contract.mvp_scope.acceptance_criteria) {
      if (!acIds.has(id)) missing.push(`mvp_scope.acceptance_criteria.unknown_id:${id}`);
    }
    for (const id of contract.mvp_scope.variation_axes) {
      if (!axIds.has(id)) missing.push(`mvp_scope.variation_axes.unknown_id:${id}`);
    }
    if (contract.mvp_scope.acceptance_criteria.length === 0
      && contract.mvp_scope.variation_axes.length === 0) {
      missing.push('mvp_scope.acceptance_criteria_or_variation_axes');
    }
    if (contract.mvp_scope.artifact === null) {
      missing.push('mvp_scope.artifact');
    } else if (!MVP_SCOPE_ARTIFACTS.includes(contract.mvp_scope.artifact)) {
      missing.push(`mvp_scope.artifact.unsupported:${contract.mvp_scope.artifact}`);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
    warnings,
    contract,
  };
}

export function readGoalContract(cwd) {
  const path = join(cwd, GOAL_CONTRACT_REL_PATH);
  if (!existsSync(path)) {
    return {
      exists: false,
      path: GOAL_CONTRACT_REL_PATH,
      valid: false,
      missing: ['file'],
      warnings: [],
      contract: null,
    };
  }
  try {
    const text = readFileSync(path, 'utf-8');
    const verdict = validateGoalContractText(text);
    return {
      exists: true,
      path: GOAL_CONTRACT_REL_PATH,
      ...verdict,
    };
  } catch {
    return {
      exists: true,
      path: GOAL_CONTRACT_REL_PATH,
      valid: false,
      missing: ['readable_file'],
      warnings: [],
      contract: null,
    };
  }
}

export function readBaselineGoalContractHash(cwd) {
  const path = join(cwd, BASELINE_REL_PATH);
  if (!existsSync(path)) return { exists: false, hash: null, error: null, rawHash: null };
  try {
    const text = readFileSync(path, 'utf-8');
    const block = extractTopBlock(text, 'artifacts');
    const goalBlockMatch = block.match(/^\s+goal_contract\s*:\s*\n((?:\s{4}.+\n?)*)/m);
    const goalBlock = goalBlockMatch ? goalBlockMatch[1] : '';
    const hash = scalarInBlock(goalBlock, 'sha256');
    if (!hash) {
      return {
        exists: true,
        hash: null,
        error: 'missing_goal_contract_sha256',
        rawHash: null,
      };
    }
    if (hash && !LOWER_HEX_SHA256_RE.test(hash)) {
      return {
        exists: true,
        hash: null,
        error: `corrupt_goal_contract_sha256: expected 64 lowercase hex characters, got ${hash.length}`,
        rawHash: hash,
      };
    }
    return { exists: true, hash, error: null, rawHash: hash };
  } catch (error) {
    return {
      exists: true,
      hash: null,
      error: `unreadable_baseline: ${error?.message || 'unknown error'}`,
      rawHash: null,
    };
  }
}

export function defaultRequiredArtifacts() {
  return [...DEFAULT_REQUIRED_ARTIFACTS];
}
