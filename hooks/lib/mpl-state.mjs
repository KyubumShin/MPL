#!/usr/bin/env node
/**
 * MPL State Management Utility
 * Shared helpers for reading/writing .mpl/state.json
 * Based on design document section 12.2
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync, cpSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { loadConfig } from './mpl-config.mjs';

const STATE_DIR = '.mpl';
const STATE_FILE = 'state.json';

/**
 * Ring-buffer cap for Stage 2 ambiguity round records. writeState enforces this
 * post-merge so the state file cannot grow unbounded even when the orchestrator
 * forgets to slice before writing. The orchestrator still slices on its side as
 * a courtesy (cheaper stringify); this is the defense-in-depth guarantee.
 */
export const MAX_AMBIGUITY_HISTORY = 10;

/**
 * Schema version for the unified `.mpl/state.json` file.
 *
 * - `undefined` in a read state = legacy v1 (pre-P2-6): the pipeline-scope
 *   fields lived in `.mpl/state.json` and the execution-scope fields
 *   (`task`, `phases`, `phase_details`, `totals`, `cumulative_pass_rate`)
 *   lived in a separate `.mpl/mpl/state.json` maintained by orchestrator
 *   prompts.
 * - `2` = unified shape: everything in `.mpl/state.json`, execution-scope
 *   fields under the top-level `execution` subtree.
 *
 * readState() transparently migrates v1 → v2 on first access by merging any
 * surviving `.mpl/mpl/state.json` into `state.execution` and archiving the
 * legacy file.
 */
export const CURRENT_SCHEMA_VERSION = 2;

/**
 * Legacy execution state file. Pre-P2-6 orchestrator prompts wrote to this
 * via Write/Edit; v2 stores the same shape under `state.execution` in
 * `.mpl/state.json`. The constant is retained so the migration path can
 * locate and archive the legacy file.
 */
export const LEGACY_EXECUTION_STATE_PATH = '.mpl/mpl/state.json';

/**
 * Valid pipeline phase names (v0.13.1).
 * writeState() warns on unrecognized current_phase values.
 */
const VALID_PHASES = new Set([
  'mpl-init', 'mpl-ambiguity-resolve', 'mpl-decompose',
  'phase1a-research', 'phase1b-plan',
  'phase2-sprint', 'phase3-gate', 'phase4-fix', 'phase5-finalize',
  'small-plan', 'small-sprint', 'small-verify',
  'completed'
]);

/**
 * Default state schema (design doc section 12.2)
 */
const DEFAULT_STATE = {
  // P2-6: unified schema version marker. Migration runs when absent or < 2.
  schema_version: CURRENT_SCHEMA_VERSION,
  pipeline_id: null,
  run_mode: 'full',
  tool_mode: 'full',         // F-04: "full" | "partial" | "standalone"
  // v0.17 (#55): pp_proximity / pp_score / interview_depth removed.
  // Phase 0 Triage is deleted; decomposer expresses scope via phase count.
  worktree_history: [],      // History of worktree switches
  current_phase: 'phase1-plan',
  started_at: null,
  finalize_done: false,      // Set to true when Step 5 finalization completes
  sprint_status: {
    total_todos: 0,
    completed_todos: 0,
    in_progress_todos: 0,
    failed_todos: 0
  },
  // AD-0006: structured gate evidence recorded by mpl-gate-recorder.mjs hook.
  // Post-#102 (P0-1): mpl-phase-controller `checkGateResults` reads structured first
  // (`hard{1,2,3}_{baseline,coverage,resilience}.exit_code`); legacy booleans are
  // a non-strict transitional fallback only when zero structured entries exist.
  // Once #110 (P0-2) ships `enforcement.strict`, the legacy booleans are retired.
  gate_results: {
    hard1_passed: null,
    hard2_passed: null,
    hard3_passed: null,
    hard1_baseline: null,   // { command, exit_code, stdout_tail, timestamp }
    hard2_coverage: null,
    hard3_resilience: null
  },
  // AD-0006 (AD-0004 bridge): test-agent dispatch record per phase.
  // Populated by mpl-gate-recorder.mjs hook on Task|Agent(mpl-test-agent) completion.
  test_agent_dispatched: {},
  // AD-0006: verification contract captured by Phase 0 Enhanced Step 4.
  // "verify_script" | "explicit" | "heuristic" | null (pre-Phase-0 default).
  verification_strategy: null,
  verification_commands: [],   // optional explicit per-gate commands (Path C)
  // AD-0008 (v0.15.2): E2E scenario execution results.
  // Keys are scenario ids (E2E-N) from .mpl/mpl/e2e-scenarios.yaml.
  // Populated by mpl-gate-recorder.mjs when Bash command matches a scenario's
  // test_command. Consumed by finalize Step 5.0 and mpl-require-e2e.mjs hook.
  e2e_results: {},
  fix_loop_count: 0,
  max_fix_loops: 10,
  compaction_count: 0,
  last_phase_compaction_count: 0,
  session_id: null,
  cost: {
    total_tokens: 0,
    estimated_usd: 0
  },
  convergence: {
    pass_rate_history: [],
    stagnation_window: 3,
    min_improvement: 0.05,
    regression_threshold: -0.10
  },
  research: {
    status: null,           // null | 'stage1' | 'stage2' | 'stage3' | 'completed' | 'skipped'
    started_at: null,
    completed_at: null,
    stages_completed: [],   // ['stage1', 'stage2', 'stage3']
    report_path: null,      // '.mpl/research/report.md' or '.mpl/research/brief.md'
    findings_count: 0,
    sources_count: 0,
    mode: 'full',           // 'full' (3-stage) | 'light' (stage 1 only) | 'standalone'
    error: null,            // failure error message
    degraded_stages: []     // stages with partial failures, e.g. ['stage2']
  },
  memory: {                  // F-25: 4-Tier Adaptive Memory statistics
    episodic_entries: 0,
    semantic_rules: 0,
    procedural_entries: 0,
    last_compression: null,       // ISO timestamp of last episodic compression
    last_semantic_promotion: null  // ISO timestamp of last semantic promotion
  },
  h_item_metrics: {            // LT-05: H-Item severity feedback loop (v0.8.6)
    h_item_total: 0,            // Total H-items generated by verification planner
    h_item_side_interviews: 0,  // HIGH H-items that triggered side interviews
    h_item_review_rate: 0.0,    // Fraction of H-items reviewed by user in Step 5.1.8
    severity_overrides: {       // User reclassifications in Step 5.1.8
      high_to_med: 0,           // Planner said HIGH, user downgraded to MED
      high_to_low: 0,           // Planner said HIGH, user downgraded to LOW
      med_to_high: 0,           // Planner said MED, user upgraded to HIGH
      low_to_high: 0            // Planner said LOW, user upgraded to HIGH
    }
  },
  // Stage 2 ambiguity score — written by orchestrator via mpl_state_write after
  // the inline mpl_score_ambiguity MCP tool loop reaches threshold_met == true.
  // mpl-phase-controller blocks mpl-decompose if null.
  ambiguity_score: null,         // number (0.0~1.0) | null — threshold: <= 0.2
  // Issue #51: explicit escape hatch for the ambiguity gate. When `active`,
  // mpl-ambiguity-gate.mjs lets the decomposer dispatch proceed regardless of
  // ambiguity_score. The score itself is NEVER mutated as an escape — that
  // contradicts AD-0006 machine-evidence integrity. Instead the orchestrator
  // records why the override was taken so finalize metrics and risk reports
  // can surface residual ambiguity downstream.
  ambiguity_override: {
    active: false,               // boolean — true bypasses score check
    reason: null,                // short human-readable rationale
    by: null,                    // "user_halt" | "user_force" | "sdk_fallback"
    set_at: null                 // ISO timestamp
  },
  // Issue #51: round-by-round history of ambiguity scoring so the
  // orchestrator can detect stagnation (same weakest_dimension + tiny delta
  // across N rounds) without stopping the loop — only notifies the user.
  // Each entry: { round, score, weakest_dimension, ts }.
  ambiguity_history: [],
  // F-33: Session budget prediction
  // #35 (v0.14.1): "paused_checkpoint" added for orchestrator verbal pause (self-pause on checkpoint report)
  session_status: null,          // null | "active" | "paused_budget" | "paused_checkpoint"
  pause_reason: null,            // human-readable pause reason
  resume_from_phase: null,       // phase ID to resume from
  pause_timestamp: null,         // ISO timestamp of pause
  budget_at_pause: null,         // { context_pct, estimated_needed_pct }
  // P2-6: execution-scope state (formerly .mpl/mpl/state.json). Schema mirrors
  // the shape documented in commands/mpl-run.md §"MPL State". Orchestrator
  // prompts (mpl-run-decompose.md, mpl-run-execute.md) update this subtree via
  // mpl_state_write instead of editing a separate JSON file. Resume reads it
  // through readState so drift between two files becomes structurally
  // impossible.
  execution: {
    task: null,                      // short user-request description
    status: null,                    // "running" | "completed" | "failed" | "cancelled"
    started_at: null,                // ISO timestamp
    phases: {
      total: 0,
      completed: 0,
      current: null,                 // phase id, e.g. "phase-3"
      failed: 0,
      circuit_breaks: 0,
    },
    phase_details: [],               // [{ id, name, status, pp_proximity, retries, criteria_passed, pass_rate }]
    totals: {
      total_retries: 0,
      total_micro_fixes: 0,
      total_discoveries: 0,
      elapsed_ms: 0,
    },
    cumulative_pass_rate: null,      // last observed pass rate (0–100)
    failure_phase: null,             // populated on circuit break
  },
};

// Prototype pollution guard keys
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Read MPL state from .mpl/state.json.
 *
 * P2-6: if the parsed state lacks `schema_version` (legacy v1) AND a legacy
 * `.mpl/mpl/state.json` exists, run the migration before returning. The
 * migration is idempotent — subsequent reads see `schema_version: 2` and
 * skip the check.
 *
 * @param {string} cwd - Working directory
 * @returns {object|null} State object or null if not found/invalid
 */
export function readState(cwd) {
  try {
    const statePath = join(cwd, STATE_DIR, STATE_FILE);
    if (!existsSync(statePath)) return null;
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8'));
    // M5: Minimal schema validation
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (!parsed.current_phase) return null;

    // P2-6: transparent v1 → v2 migration. Delegates to the pure helper so
    // writers that bypass readState (direct JSON munging in tests) can
    // still run the same logic on demand.
    if ((parsed.schema_version ?? 1) < CURRENT_SCHEMA_VERSION) {
      const migrated = migrateLegacyExecutionState(cwd, parsed);
      if (migrated) return migrated;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * P2-6: one-shot migration from the dual-file v1 layout to the unified v2
 * layout. Reads .mpl/mpl/state.json (if present), merges its fields into
 * `state.execution`, archives the legacy file to
 * `.mpl/archive/legacy-execution-state.json`, and bumps schema_version.
 *
 * Idempotent: callers may invoke freely — if there's nothing to migrate
 * (legacy file absent, already-migrated, or `state.execution` already
 * populated from a newer write) the function still bumps schema_version and
 * persists.
 *
 * Returns the migrated state object, or null on I/O failure (caller keeps
 * the unmigrated state so the pipeline doesn't wedge).
 */
export function migrateLegacyExecutionState(cwd, currentState) {
  try {
    const legacyPath = join(cwd, LEGACY_EXECUTION_STATE_PATH);
    const stateDir = join(cwd, STATE_DIR);
    const merged = { ...currentState };

    // Treat the DEFAULT_STATE.execution shape as the baseline so the legacy
    // file only needs to contribute the fields it actually knows about.
    const baseExecution = {
      task: null,
      status: null,
      started_at: null,
      phases: { total: 0, completed: 0, current: null, failed: 0, circuit_breaks: 0 },
      phase_details: [],
      totals: { total_retries: 0, total_micro_fixes: 0, total_discoveries: 0, elapsed_ms: 0 },
      cumulative_pass_rate: null,
      failure_phase: null,
    };

    let legacyParsed = null;
    if (existsSync(legacyPath)) {
      try {
        legacyParsed = JSON.parse(readFileSync(legacyPath, 'utf-8'));
      } catch {
        // Corrupt legacy file — archive verbatim below, proceed with defaults.
        legacyParsed = null;
      }
    }

    // Later writes (v2) may have already populated state.execution. Preserve
    // them: incoming merge order is base < legacy < already-unified, so a
    // partial v2 write followed by a v1 read still keeps the newer data.
    const existingExecution = (currentState && typeof currentState.execution === 'object' && currentState.execution !== null)
      ? currentState.execution
      : {};

    merged.execution = deepMerge(
      deepMerge(baseExecution, legacyParsed && typeof legacyParsed === 'object' ? legacyParsed : {}),
      existingExecution,
    );
    merged.schema_version = CURRENT_SCHEMA_VERSION;

    // Persist the migrated state back to disk so subsequent reads short-circuit.
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    const stateTmp = join(stateDir, `.state-${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(stateTmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
    renameSync(stateTmp, join(stateDir, STATE_FILE));

    // Archive the legacy file (once per migration). Using the pipeline_id
    // when available keeps the archive co-located with other pipeline
    // artifacts; otherwise a single legacy-execution-state.json at the
    // archive root is sufficient.
    if (legacyParsed !== null || existsSync(legacyPath)) {
      const archiveRoot = join(cwd, '.mpl', 'archive');
      try {
        mkdirSync(archiveRoot, { recursive: true });
        const archiveName = currentState?.pipeline_id
          ? `${currentState.pipeline_id}-legacy-execution-state.json`
          : 'legacy-execution-state.json';
        const archivePath = join(archiveRoot, archiveName);
        writeFileSync(
          archivePath,
          JSON.stringify({
            migrated_at: new Date().toISOString(),
            pipeline_id: currentState?.pipeline_id ?? null,
            legacy_content: legacyParsed,
          }, null, 2),
          { mode: 0o600 },
        );
        if (existsSync(legacyPath)) rmSync(legacyPath, { force: true });
      } catch {
        // Archive failure is non-fatal — better to leave the legacy file in
        // place than to wedge the pipeline.
      }
    }

    return merged;
  } catch {
    return null;
  }
}

/**
 * P2-6: detect drift between the unified state.execution subtree and a
 * surviving legacy .mpl/mpl/state.json. Called by resume to surface
 * discrepancies before continuing. Returns { drift: boolean, details: [] };
 * any I/O or parse failure resolves to `{ drift: false, details: [] }` so
 * a corrupt legacy file never blocks resume.
 */
export function detectStateDrift(cwd) {
  try {
    const statePath = join(cwd, STATE_DIR, STATE_FILE);
    const legacyPath = join(cwd, LEGACY_EXECUTION_STATE_PATH);
    if (!existsSync(statePath) || !existsSync(legacyPath)) {
      return { drift: false, details: [] };
    }
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    const legacy = JSON.parse(readFileSync(legacyPath, 'utf-8'));
    const execution = state?.execution ?? {};

    const details = [];
    if ((legacy?.phases?.completed ?? null) !== (execution?.phases?.completed ?? null)) {
      details.push(`phases.completed: legacy=${legacy?.phases?.completed} unified=${execution?.phases?.completed}`);
    }
    if ((legacy?.phases?.total ?? null) !== (execution?.phases?.total ?? null)) {
      details.push(`phases.total: legacy=${legacy?.phases?.total} unified=${execution?.phases?.total}`);
    }
    if ((legacy?.status ?? null) !== (execution?.status ?? null)) {
      details.push(`status: legacy=${legacy?.status} unified=${execution?.status}`);
    }
    if ((legacy?.cumulative_pass_rate ?? null) !== (execution?.cumulative_pass_rate ?? null)) {
      details.push(`cumulative_pass_rate: legacy=${legacy?.cumulative_pass_rate} unified=${execution?.cumulative_pass_rate}`);
    }
    const legacyPhaseIds = (legacy?.phase_details ?? []).map((p) => p?.id).filter(Boolean);
    const unifiedPhaseIds = (execution?.phase_details ?? []).map((p) => p?.id).filter(Boolean);
    if (legacyPhaseIds.join(',') !== unifiedPhaseIds.join(',')) {
      details.push(`phase_details ids differ: legacy=[${legacyPhaseIds.join(',')}] unified=[${unifiedPhaseIds.join(',')}]`);
    }
    return { drift: details.length > 0, details };
  } catch {
    return { drift: false, details: [] };
  }
}

/**
 * Write/merge MPL state to .mpl/state.json (atomic via temp + rename)
 * @param {string} cwd - Working directory
 * @param {object} patch - Fields to merge into state
 * @returns {object} Merged state
 */
export function writeState(cwd, patch) {
  const stateDir = join(cwd, STATE_DIR);
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }

  // Validate phase name if being set
  if (patch.current_phase && !VALID_PHASES.has(patch.current_phase)) {
    console.error(`[MPL] WARNING: Unrecognized current_phase "${patch.current_phase}". Valid: ${[...VALID_PHASES].join(', ')}`);
  }

  const current = readState(cwd) || { ...DEFAULT_STATE };
  const merged = deepMerge(current, patch);

  // Ring-buffer cap for ambiguity_history. Arrays are replaced (not merged) by
  // deepMerge, so any patch that supplies ambiguity_history has already set the
  // final array — we just trim the tail if it exceeds MAX_AMBIGUITY_HISTORY.
  if (Array.isArray(merged.ambiguity_history) && merged.ambiguity_history.length > MAX_AMBIGUITY_HISTORY) {
    const dropped = merged.ambiguity_history.length - MAX_AMBIGUITY_HISTORY;
    merged.ambiguity_history = merged.ambiguity_history.slice(-MAX_AMBIGUITY_HISTORY);
    process.stderr.write(`[mpl-state] ambiguity_history ring-buffer truncated ${dropped} oldest entries (cap=${MAX_AMBIGUITY_HISTORY})\n`);
  }

  // C2: Atomic write via temp file + rename
  const tmpPath = join(stateDir, `.state-${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
  renameSync(tmpPath, join(stateDir, STATE_FILE));

  return merged;
}

/**
 * Check if MPL is currently active
 * @param {string} cwd - Working directory
 * @returns {boolean}
 */
export function isMplActive(cwd) {
  // M6: Check file existence separately from readState
  const statePath = join(cwd, STATE_DIR, STATE_FILE);
  if (!existsSync(statePath)) return false; // No file = truly inactive

  const state = readState(cwd);
  if (!state) return true; // File exists but corrupt/invalid = fail-closed (assume active)
  if (!state.current_phase) return false;
  // Active if phase is not null and not finalized
  return state.current_phase !== 'completed' && state.current_phase !== 'cancelled';
}

/**
 * Initialize MPL state for a new pipeline run
 * @param {string} cwd - Working directory
 * @param {string} featureName - Name of the feature being built
 * @param {string} runMode - Pipeline mode: 'full' (5-phase) or 'small' (3-phase lightweight)
 * @returns {object} Initial state
 */
/**
 * Pipeline-scoped paths that must be RESET on new pipeline start.
 * These are relative to cwd.
 */
const PIPELINE_SCOPE_PATHS = [
  // Root-level pipeline artifacts
  '.mpl/state.json',
  '.mpl/PLAN.md',
  '.mpl/auto-permit-learned.json',
  // Signals (transient)
  '.mpl/signals',
  // MPL pipeline artifacts (entire subtree except profile)
  // P2-6: `.mpl/mpl/state.json` is no longer generated (unified into
  // `.mpl/state.json.execution`); kept in this cleanup list so any leftover
  // legacy file from a pre-P2-6 pipeline is removed on next init.
  '.mpl/mpl/state.json',
  '.mpl/mpl/decomposition.yaml',
  '.mpl/mpl/phase-decisions.md',
  '.mpl/mpl/codebase-analysis.json',
  '.mpl/mpl/RUNBOOK.md',
  '.mpl/mpl/phase0',
  '.mpl/mpl/phases',
  '.mpl/mpl/checkpoints',
  // Research artifacts
  '.mpl/research',
  // Working memory (ephemeral per pipeline)
  '.mpl/memory/working.md',
  // Context usage (transient)
  '.mpl/context-usage.json',
];

/**
 * Project-scoped paths that must NEVER be deleted.
 * Listed here for documentation; cleanPipelineScope only touches PIPELINE_SCOPE_PATHS.
 *
 * PERSIST:
 *   .mpl/config.json              - user settings
 *   .mpl/pivot-points.md          - reusable interview constraints
 *   .mpl/discoveries.md           - master discovery log
 *   .mpl/memory/semantic.md       - generalized patterns (3+ repetitions)
 *   .mpl/memory/procedural.jsonl  - tool usage patterns
 *   .mpl/memory/episodic.md       - phase history (time-compressed)
 *   .mpl/memory/learnings.md      - distilled project knowledge
 *   .mpl/cache/                   - phase0 cache (7-day TTL, self-expiring)
 *   .mpl/mpl/profile/             - token usage metrics (append-only)
 */

/**
 * Archive previous pipeline run before cleanup.
 * Moves key artifacts to .mpl/archive/{pipeline_id}/ for traceability.
 * @param {string} cwd
 */
function archivePreviousRun(cwd) {
  const prevState = readState(cwd);
  if (!prevState || !prevState.pipeline_id) return;

  const archiveDir = join(cwd, '.mpl', 'archive', prevState.pipeline_id);
  try {
    mkdirSync(archiveDir, { recursive: true });

    // Archive key single files (best-effort, skip missing)
    const toArchive = [
      ['state.json', '.mpl/state.json'],
      ['PLAN.md', '.mpl/PLAN.md'],
    ];

    for (const [name, relPath] of toArchive) {
      const src = join(cwd, relPath);
      if (existsSync(src)) {
        writeFileSync(
          join(archiveDir, name),
          readFileSync(src, 'utf-8')
        );
      }
    }

    // v0.14.1 #37: Deep-archive .mpl/mpl/ subtree before cleanPipelineScope wipes it.
    // Previously only state.json + PLAN.md were archived, so decomposition.yaml,
    // RUNBOOK.md, phase-decisions.md, phase0/, phases/ were lost on any re-init.
    // This now preserves every pipeline work artifact under archive/{pipeline_id}/mpl/.
    const mplSubtree = join(cwd, '.mpl', 'mpl');
    if (existsSync(mplSubtree)) {
      try {
        cpSync(mplSubtree, join(archiveDir, 'mpl'), {
          recursive: true,
          errorOnExist: false,
          force: true
        });
      } catch {
        // Non-fatal: metadata below still lets users see that the run existed
      }
    }

    // Write archive metadata
    writeFileSync(
      join(archiveDir, 'meta.json'),
      JSON.stringify({
        pipeline_id: prevState.pipeline_id,
        archived_at: new Date().toISOString(),
        final_phase: prevState.current_phase,
        phases_completed: prevState.phases_completed || 0,
        gate_results: prevState.gate_results,
        session_status: prevState.session_status || null,
      }, null, 2) + '\n'
    );
  } catch {
    // Archive failure is non-fatal
  }
}

/**
 * Clean pipeline-scoped artifacts before starting a new pipeline.
 * Preserves all project-scoped data (config, memories, cache, profile).
 * @param {string} cwd - Working directory
 */
export function cleanPipelineScope(cwd) {
  // Archive previous run first
  archivePreviousRun(cwd);

  for (const relPath of PIPELINE_SCOPE_PATHS) {
    const fullPath = join(cwd, relPath);
    if (!existsSync(fullPath)) continue;

    try {
      rmSync(fullPath, { recursive: true, force: true });
    } catch {
      // Non-fatal: log but continue
      process.stderr.write(`[mpl-state] cleanup failed: ${relPath}\n`);
    }
  }
}

export function initState(cwd, featureName, runMode = 'full') {
  // F-39: Clean pipeline-scoped artifacts before initializing new pipeline
  cleanPipelineScope(cwd);

  // H5: Load config overrides
  let config = {};
  try {
    config = loadConfig(cwd);
  } catch {
    // Config load failed, use defaults
  }

  const now = new Date().toISOString();
  const dateStr = now.slice(0, 10).replace(/-/g, '');
  // M1: Support Korean/CJK characters in slug
  const slug = featureName.toLowerCase()
    .replace(/[^a-z0-9가-힣ぁ-ゔァ-ヴ\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

  const maxFixLoops = config.max_fix_loops ?? 10;
  const convergenceConfig = config.convergence ?? {};

  return writeState(cwd, {
    ...DEFAULT_STATE,
    pipeline_id: `mpl-${dateStr}-${slug}`,
    run_mode: runMode === 'auto' ? 'auto' : runMode,
    current_phase: 'phase1a-research',
    max_fix_loops: maxFixLoops,
    convergence: {
      ...DEFAULT_STATE.convergence,
      ...convergenceConfig
    },
    research: { ...DEFAULT_STATE.research },
    started_at: now
  });
}

/**
 * Check convergence of fix loop pass rates
 * Enhanced in v3: stagnation detection with variance, regression detection, strategy suggestions
 * @param {object} state - Current MPL state
 * @returns {{ status: string, delta?: number, suggestion?: string }}
 */
export function checkConvergence(state) {
  const conv = state?.convergence;
  if (!conv) return { status: 'insufficient_data' };

  const { pass_rate_history, stagnation_window = 3, min_improvement = 0.05, regression_threshold = -0.1 } = conv;
  if (!Array.isArray(pass_rate_history) || pass_rate_history.length < 2) return { status: 'insufficient_data' };

  const windowSize = Math.min(stagnation_window, pass_rate_history.length);
  const recent = pass_rate_history.slice(-windowSize);
  const latest = recent[recent.length - 1];
  const earliest = recent[0];
  const improvement = latest - earliest;

  // v3: Regression detection (delta < -10%)
  if (improvement < regression_threshold) {
    return {
      status: 'regressing',
      delta: improvement,
      suggestion: 'Pass rate is declining. Consider reverting to last known good state or reviewing Phase 0 artifacts.'
    };
  }

  // v3: Stagnation detection with variance check
  if (recent.length >= stagnation_window) {
    // Calculate variance of recent pass rates
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / recent.length;

    if (variance < 0.0025 && improvement < min_improvement) {
      // variance < 5% (0.05^2 = 0.0025) AND no meaningful improvement
      return {
        status: 'stagnating',
        delta: improvement,
        suggestion: 'Fix loop stagnating. AD-07 strategy override will be generated from prior reflections + phase0 artifacts. See .mpl/mpl/phases/{phase}/strategy-override.json after generation.'
      };
    }

    if (improvement < min_improvement) {
      return { status: 'stagnating', delta: improvement, suggestion: 'Below improvement threshold. AD-07 strategy override will synthesize alternative approach from reflection history.' };
    }
  }

  return { status: 'improving', delta: improvement };
}

/**
 * Deep merge two objects (shallow for arrays, with prototype pollution guard)
 */
export function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    // Prototype pollution guard
    if (DANGEROUS_KEYS.has(key)) continue;

    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
