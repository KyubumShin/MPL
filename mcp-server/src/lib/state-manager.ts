/**
 * MPL State Manager — Move #3.
 *
 * Move #3 collapses the divergent MCP-side writer that used to live in
 * this file. `writeState` is now a subprocess shim that synchronously
 * spawns `hooks/lib/state/writer-cli.mjs`, which delegates to the
 * canonical hooks-side `writeState(cwd, patch)` from
 * `hooks/lib/state/writer.mjs`. The CLI prints
 * `{success, updated_keys, reason?}` JSON to stdout; the shim returns it
 * verbatim. `handleStateWrite` (src/tools/state.ts) sees the exact same
 * return shape, so no caller needs to change.
 *
 * `readState` stays here because:
 *   (a) it's a pure JSON parse + deep-merge against DEFAULT_STATE,
 *   (b) three siblings depend on its typed return
 *       (feature-classifier, e2e-diagnoser, llm-scorer), and
 *   (c) keeping reads in-process avoids subprocess overhead on the hot
 *       read path.
 *
 * Source-of-truth notes:
 *   - The on-disk `schema_version` is owned by the hooks-side writer,
 *     which imports the canonical `CURRENT_SCHEMA_VERSION` from
 *     `hooks/lib/state/reader.mjs` (=7 at time of writing). The MCP
 *     side intentionally has no `CURRENT_SCHEMA_VERSION` constant any
 *     more — there is no second authoritative default shape to keep in
 *     sync. The MCP `DEFAULT_STATE` below is a shallow safety net for
 *     typed reads only; its job is to satisfy the TS interface when
 *     the on-disk file is missing fields the consumer expects, not to
 *     define what a fresh state.json looks like.
 *   - Ring-buffer caps (ambiguity_history, phase_scheduler_history,
 *     worktree_pool_history), the I5 fix_loop_count lockstep, the H8
 *     fail-closed schema check, the I13 phase-0-artifact gate, and any
 *     future writer-side rule live exclusively on the hooks side.
 *     Adding a new rule there is automatically picked up here through
 *     the subprocess boundary — drift between two writers is
 *     eliminated by construction.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const STATE_PATH = '.mpl/state.json';

/**
 * Ring-buffer cap for ambiguity_history. Mirrored from
 * hooks/lib/state/reader.mjs so callers that want to slice client-side
 * as a courtesy (cheaper stringify) can read the same bound from here.
 * The actual enforcement lives in the hooks-side writer; this constant
 * is informational only.
 */
export const MAX_AMBIGUITY_HISTORY = 10;

export interface MplExecutionState {
  task: string | null;
  status: string | null;
  started_at: string | null;
  phases: {
    total: number;
    completed: number;
    current: string | null;
    failed: number;
    circuit_breaks: number;
  };
  phase_details: Array<Record<string, unknown>>;
  totals: {
    total_retries: number;
    total_micro_fixes: number;
    total_discoveries: number;
    elapsed_ms: number;
  };
  cumulative_pass_rate: number | null;
  failure_phase: string | null;
}

export interface MplState {
  // schema_version is owned by the hooks-side writer
  // (hooks/lib/state/reader.mjs CURRENT_SCHEMA_VERSION). Read-side
  // consumers may inspect it but MUST NOT assume a fixed value here.
  schema_version?: number;
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
  };
  fix_loop_count: number;
  max_fix_loops: number;
  compaction_count: number;
  session_id: string | null;
  cost: {
    total_tokens: number;
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
  // 0.16 Tier A' — user contract tracking
  user_contract_set: boolean;
  user_contract_path: string | null;
  user_contract_iterations: number;
  // 0.16 Tier C — E2E recovery circuit breaker + last diagnosis snapshot
  e2e_recovery: {
    iter: number;
    max_iter: number;
    last_classification: 'A' | 'B' | 'C' | 'D' | null;
    last_diagnosis: Record<string, unknown> | null;
    halted: boolean;
    halt_reason: string | null;
  };
  // P2-6: execution-scope state absorbed from the legacy .mpl/mpl/state.json.
  execution: MplExecutionState;
  [key: string]: unknown;
}

/**
 * Shallow safety net for typed reads. NOT the authoritative default
 * state shape — that lives in `hooks/lib/state/writer.mjs` and is
 * stamped onto disk by the hooks-side writer (see Move #3 notes at the
 * top of this file). The fields below exist solely so `readState` can
 * hand a fully-typed `MplState` back to TS callers when the on-disk
 * file is missing keys the consumer expects.
 *
 * Source of truth for both `schema_version` and the canonical fresh-
 * state shape: hooks/lib/state/reader.mjs + hooks/lib/state/writer.mjs.
 */
const DEFAULT_STATE: MplState = {
  // No schema_version field here on purpose — see note above.
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
  },
  fix_loop_count: 0,
  max_fix_loops: 10,
  compaction_count: 0,
  session_id: null,
  cost: {
    total_tokens: 0,
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
  user_contract_set: false,
  user_contract_path: null,
  user_contract_iterations: 0,
  e2e_recovery: {
    iter: 0,
    max_iter: 2,
    last_classification: null,
    last_diagnosis: null,
    halted: false,
    halt_reason: null,
  },
  execution: {
    task: null,
    status: null,
    started_at: null,
    phases: { total: 0, completed: 0, current: null, failed: 0, circuit_breaks: 0 },
    phase_details: [],
    totals: { total_retries: 0, total_micro_fixes: 0, total_discoveries: 0, elapsed_ms: 0 },
    cumulative_pass_rate: null,
    failure_phase: null,
  },
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

/**
 * Walk up from this compiled module looking for a package.json whose
 * `name` is `mpl-hooks`. That's the repo root (see /package.json which
 * declares `name: mpl-hooks`). Falls back to the `MPL_HOOKS_ROOT` env
 * var so tests and dev workflows can point at a vendored checkout
 * without depending on the on-disk layout.
 *
 * Cached on first resolve — both the answer and any failure — so the
 * shim doesn't re-walk on every state-write.
 */
let cachedRepoRoot: string | null = null;
let repoRootResolved = false;

function findRepoRoot(): string | null {
  if (repoRootResolved) return cachedRepoRoot;
  repoRootResolved = true;

  const envRoot = process.env.MPL_HOOKS_ROOT;
  if (envRoot && envRoot.length > 0) {
    cachedRepoRoot = envRoot;
    return cachedRepoRoot;
  }

  // import.meta.url → dist/lib/state-manager.js → walk up looking for
  // a package.json that declares { name: 'mpl-hooks' }. Stops at fs
  // root.
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    // Hard cap on traversal depth so a misconfigured deployment can't
    // turn this into an unbounded walk.
    for (let i = 0; i < 32; i++) {
      const pkgPath = join(dir, 'package.json');
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
          if (pkg && pkg.name === 'mpl-hooks') {
            cachedRepoRoot = dir;
            return cachedRepoRoot;
          }
        } catch {
          // Skip unreadable / non-JSON package.json files and keep
          // walking — sibling packages along the path are expected
          // (mcp-server/package.json declares name=mpl-mcp-server).
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break; // reached fs root
      dir = parent;
    }
  } catch {
    // fall through
  }
  cachedRepoRoot = null;
  return null;
}

/**
 * Update MPL state by delegating to the hooks-side writer via a
 * subprocess. Returns the JSON object that the CLI printed verbatim,
 * preserving the `{success, updated_keys, reason?}` contract that
 * `handleStateWrite` already forwards.
 *
 * Behavior contract (preserved across Move #3):
 *   - success path → `{success:true, updated_keys:[...keys of patch]}`.
 *   - I13 reject (Phase 0 artifacts missing for protected current_phase)
 *     → `{success:false, updated_keys:[], reason:'[MPL I13] ...'}`,
 *     subprocess exit code 0.
 *   - H8 reject (on-disk schema_version newer than hooks side supports)
 *     → `{success:false, updated_keys:[], reason:'[MPL H8] ...'}`,
 *     subprocess exit code 0.
 *   - subprocess failure (spawn error, non-zero exit other than the
 *     above) → `{success:false, updated_keys:[], reason:'[MPL state]
 *     writer subprocess failed: <stderr tail>'}`. The pre-Move-#3
 *     non-atomic catch-block fallback (which wrote directly to
 *     filePath on tmp-rename failure, leaving tmp files dangling) is
 *     intentionally GONE — propagating the failure honestly is safer
 *     than papering over it with a non-atomic write.
 */
export function writeState(
  cwd: string,
  patch: Record<string, unknown>,
): { success: boolean; updated_keys: string[]; reason?: string } {
  const repoRoot = findRepoRoot();
  if (!repoRoot) {
    return {
      success: false,
      updated_keys: [],
      reason:
        '[MPL state] writer subprocess failed: could not locate hooks repo root ' +
        '(no package.json with name=mpl-hooks found by walking up from state-manager.js; ' +
        'set MPL_HOOKS_ROOT to override).',
    };
  }

  const cliPath = join(repoRoot, 'hooks', 'lib', 'state', 'writer-cli.mjs');
  if (!existsSync(cliPath)) {
    return {
      success: false,
      updated_keys: [],
      reason: `[MPL state] writer subprocess failed: writer-cli.mjs not found at ${cliPath}`,
    };
  }

  const child = spawnSync(
    process.execPath,
    [cliPath, '--cwd', cwd],
    {
      input: JSON.stringify(patch),
      encoding: 'utf-8',
      // Don't inherit stdio — we need to capture stdout/stderr.
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  if (child.error) {
    return {
      success: false,
      updated_keys: [],
      reason: `[MPL state] writer subprocess failed: ${child.error.message}`,
    };
  }

  // Forward subprocess stderr verbatim so writer diagnostics
  // (ring-buffer truncation, schema-version warnings, RUNBOOK append
  // notices, etc.) remain visible on the MCP host's stderr after
  // Move #3. Without this, those messages would be swallowed by the
  // subprocess boundary and operators would lose the observability
  // signal that the in-process writer used to surface directly.
  if (child.stderr && child.stderr.length > 0) {
    process.stderr.write(child.stderr);
  }

  // The CLI exits 0 on success AND on expected rejection (I13/H8) —
  // the body of stdout carries the verdict in both cases. Treat any
  // non-zero exit as a true subprocess failure.
  if (child.status !== 0) {
    const stderrTail = (child.stderr || '').toString().trim().split('\n').slice(-5).join(' | ');
    return {
      success: false,
      updated_keys: [],
      reason: `[MPL state] writer subprocess failed (exit=${child.status}): ${stderrTail || '<no stderr>'}`,
    };
  }

  const stdout = (child.stdout || '').toString().trim();
  if (!stdout) {
    return {
      success: false,
      updated_keys: [],
      reason: '[MPL state] writer subprocess produced empty stdout',
    };
  }

  try {
    const parsed = JSON.parse(stdout);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('writer subprocess stdout was not a JSON object');
    }
    const success = typeof parsed.success === 'boolean' ? parsed.success : false;
    const updatedKeys = Array.isArray(parsed.updated_keys) ? parsed.updated_keys.map(String) : [];
    const result: { success: boolean; updated_keys: string[]; reason?: string } = {
      success,
      updated_keys: updatedKeys,
    };
    if (typeof parsed.reason === 'string') result.reason = parsed.reason;
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      updated_keys: [],
      reason: `[MPL state] writer subprocess returned unparseable stdout: ${msg}`,
    };
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
