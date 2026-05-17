/**
 * Validation helpers for controlled decomposition recomposition.
 *
 * Recomposition is a two-step protocol:
 * 1. Write `.mpl/mpl/decomposition-deltas/recompose-N.yaml`.
 * 2. Write the full updated `.mpl/mpl/decomposition.yaml` with
 *    `recompose_count: N`.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, join } from 'path';

export const DELTA_DIR_REL = '.mpl/mpl/decomposition-deltas';
export const LEGACY_DELTA_REL = '.mpl/mpl/decomposition-delta.yaml';

const ALLOWED_OPS = new Set([
  'append_phase',
  'split_phase',
  'modify_phase',
  'retire_phase',
  'reorder_phase',
  'update_dependency',
  'update_evidence',
]);

function normalizeScalar(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null') return null;
  return trimmed.replace(/^["']|["']$/g, '').trim() || null;
}

function scalar(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(text || '').match(new RegExp(`^${escaped}\\s*:\\s*(.+?)\\s*$`, 'm'));
  return m ? normalizeScalar(m[1]) : null;
}

export function parseRecomposeCount(value) {
  const normalized = normalizeScalar(String(value ?? ''));
  if (normalized === null) return null;
  if (!/^\d+$/.test(normalized)) return null;
  return Number.parseInt(normalized, 10);
}

function extractOperations(text) {
  return [...String(text || '').matchAll(/^\s*-\s+op\s*:\s*["']?([\w-]+)["']?/gm)]
    .map((m) => m[1]);
}

export function parseDecompositionDeltaText(text) {
  return {
    delta_version: scalar(text, 'delta_version'),
    generated_by: scalar(text, 'generated_by'),
    base_recompose_count: parseRecomposeCount(scalar(text, 'base_recompose_count')),
    target_recompose_count: parseRecomposeCount(scalar(text, 'target_recompose_count')),
    reason: scalar(text, 'reason'),
    change_policy: scalar(text, 'change_policy'),
    operations: extractOperations(text),
  };
}

export function targetCountFromDeltaPath(filePath) {
  const m = basename(String(filePath || '')).match(/^recompose-(\d+)\.ya?ml$/);
  return m ? Number.parseInt(m[1], 10) : null;
}

export function validateDecompositionDelta(delta, opts = {}) {
  const issues = [];
  if (!delta?.delta_version) issues.push('delta_version:missing');
  if (delta?.generated_by !== 'mpl-decomposer') {
    issues.push(`generated_by:${delta?.generated_by || 'missing'}`);
  }
  if (!Number.isInteger(delta?.base_recompose_count)) {
    issues.push('base_recompose_count:missing');
  }
  if (!Number.isInteger(delta?.target_recompose_count)) {
    issues.push('target_recompose_count:missing');
  }
  if (Number.isInteger(delta?.base_recompose_count) && Number.isInteger(delta?.target_recompose_count)) {
    if (delta.target_recompose_count !== delta.base_recompose_count + 1) {
      issues.push(`target_recompose_count:not_next:${delta.base_recompose_count}->${delta.target_recompose_count}`);
    }
  }
  if (!delta?.reason) issues.push('reason:missing');
  if (delta?.change_policy !== 'decomposition_delta_then_recompose') {
    issues.push(`change_policy:${delta?.change_policy || 'missing'}`);
  }
  if (!Array.isArray(delta?.operations) || delta.operations.length === 0) {
    issues.push('operations:missing');
  } else {
    for (const op of delta.operations) {
      if (!ALLOWED_OPS.has(op)) issues.push(`operations:unknown:${op}`);
    }
  }

  if (Number.isInteger(opts.expectedBase) && delta?.base_recompose_count !== opts.expectedBase) {
    issues.push(`base_recompose_count:expected:${opts.expectedBase}:actual:${delta?.base_recompose_count ?? 'missing'}`);
  }
  if (Number.isInteger(opts.expectedTarget) && delta?.target_recompose_count !== opts.expectedTarget) {
    issues.push(`target_recompose_count:expected:${opts.expectedTarget}:actual:${delta?.target_recompose_count ?? 'missing'}`);
  }
  if (Number.isInteger(opts.expectedPathTarget) && delta?.target_recompose_count !== opts.expectedPathTarget) {
    issues.push(`path_target:expected:${opts.expectedPathTarget}:actual:${delta?.target_recompose_count ?? 'missing'}`);
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

function readDeltaCandidate(path, expectedBase, expectedTarget) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf-8');
  const expectedPathTarget = targetCountFromDeltaPath(path);
  const delta = parseDecompositionDeltaText(text);
  const verdict = validateDecompositionDelta(delta, {
    expectedBase,
    expectedTarget,
    ...(expectedPathTarget === null ? {} : { expectedPathTarget }),
  });
  return { path, delta, verdict };
}

export function findMatchingDecompositionDelta(cwd, expectedBase, expectedTarget) {
  const candidates = [
    join(cwd, DELTA_DIR_REL, `recompose-${expectedTarget}.yaml`),
    join(cwd, DELTA_DIR_REL, `recompose-${expectedTarget}.yml`),
    join(cwd, LEGACY_DELTA_REL),
  ];

  for (const path of candidates) {
    const result = readDeltaCandidate(path, expectedBase, expectedTarget);
    if (result) return result;
  }

  const dir = join(cwd, DELTA_DIR_REL);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!/\.ya?ml$/.test(name)) continue;
      const result = readDeltaCandidate(join(dir, name), expectedBase, expectedTarget);
      if (result?.verdict.valid) return result;
    }
  }

  return null;
}
