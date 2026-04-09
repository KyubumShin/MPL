/**
 * MPL State Manager — ported from hooks/lib/mpl-state.mjs
 * Provides deterministic state read/write with atomic file operations.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';

const STATE_PATH = '.mpl/state.json';

export interface MplState {
  pipeline_id: string | null;
  run_mode: string;
  tool_mode: string;
  escalation_history: string[];
  interview_depth: string | null;
  current_phase: string;
  started_at: string | null;
  finalize_done: boolean;
  sprint_status: {
    total_todos: number;
    completed_todos: number;
    in_progress_todos: number;
    failed_todos: number;
  };
  gate_results: {
    hard1_passed: boolean | null;
    hard2_passed: boolean | null;
    hard3_passed: boolean | null;
    advisory_result: string | null;
  };
  fix_loop_count: number;
  max_fix_loops: number;
  compaction_count: number;
  session_id: string | null;
  cost: {
    total_tokens: number;
    max_total_tokens: number;
    estimated_usd: number;
  };
  convergence: {
    pass_rate_history: number[];
    stagnation_window: number;
    min_improvement: number;
    regression_threshold: number;
  };
  ambiguity_score: number | null;
  session_status: string | null;
  pause_reason: string | null;
  resume_from_phase: string | null;
  pause_timestamp: string | null;
  budget_at_pause: Record<string, unknown> | null;
  [key: string]: unknown;
}

const DEFAULT_STATE: MplState = {
  pipeline_id: null,
  run_mode: 'full',
  tool_mode: 'full',
  escalation_history: [],
  interview_depth: null,
  current_phase: 'phase1-plan',
  started_at: null,
  finalize_done: false,
  sprint_status: {
    total_todos: 0,
    completed_todos: 0,
    in_progress_todos: 0,
    failed_todos: 0,
  },
  gate_results: {
    hard1_passed: null,
    hard2_passed: null,
    hard3_passed: null,
    advisory_result: null,
  },
  fix_loop_count: 0,
  max_fix_loops: 10,
  compaction_count: 0,
  session_id: null,
  cost: {
    total_tokens: 0,
    max_total_tokens: 900000,
    estimated_usd: 0,
  },
  convergence: {
    pass_rate_history: [],
    stagnation_window: 3,
    min_improvement: 0.05,
    regression_threshold: -0.10,
  },
  ambiguity_score: null,
  session_status: null,
  pause_reason: null,
  resume_from_phase: null,
  pause_timestamp: null,
  budget_at_pause: null,
};

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const targetVal = target[key];
    const sourceVal = source[key];
    if (
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else {
      result[key] = sourceVal;
    }
  }
  return result;
}

export function readState(cwd: string): MplState | null {
  const filePath = join(cwd, STATE_PATH);
  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    return deepMerge(DEFAULT_STATE as unknown as Record<string, unknown>, parsed) as unknown as MplState;
  } catch {
    return null;
  }
}

export function writeState(cwd: string, patch: Record<string, unknown>): { success: boolean; updated_keys: string[] } {
  const filePath = join(cwd, STATE_PATH);
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const current = readState(cwd) ?? { ...DEFAULT_STATE };
  const merged = deepMerge(current as unknown as Record<string, unknown>, patch);

  // Atomic write: temp file → rename
  const tmpPath = `${filePath}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(merged, null, 2));
    renameSync(tmpPath, filePath);
    return { success: true, updated_keys: Object.keys(patch) };
  } catch {
    // Cleanup temp file on failure
    try { writeFileSync(filePath, JSON.stringify(merged, null, 2)); } catch { /* ignore */ }
    return { success: false, updated_keys: [] };
  }
}

export function filterState(state: MplState, keys: string[]): Record<string, unknown> {
  if (!keys.length) return state as unknown as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in state) {
      result[key] = (state as unknown as Record<string, unknown>)[key];
    }
  }
  return result;
}
