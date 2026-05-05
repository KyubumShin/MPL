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
import { deepMerge } from './mpl-state-merge.mjs';
import { runMigrations } from './migrations/index.mjs';
import { LEGACY_EXECUTION_STATE_PATH as V1_TO_V2_LEGACY_PATH } from './migrations/v1-to-v2.mjs';

export { deepMerge };

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
 * H8 (#116) routes per-version logic through `hooks/lib/migrations/`. To
 * bump this constant, register a new migration entry; see
 * `docs/schemas/migration-policy.md`.
 */
export const CURRENT_SCHEMA_VERSION = 2;

/**
 * Legacy execution state file. Pre-P2-6 orchestrator prompts wrote to this
 * via Write/Edit; v2 stores the same shape under `state.execution` in
 * `.mpl/state.json`. The constant is re-exported from the v1-to-v2
 * migration so existing consumers (resume skill, archive helpers) keep
 * the import path stable.
 */
export const LEGACY_EXECUTION_STATE_PATH = V1_TO_V2_LEGACY_PATH;

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
  // #109 G4 (v0.18.0): "verification_hang" added — Stop hook detects when last_tool_at is older
  // than the hang threshold (default 15min) and marks the session for resume / user intervention.
  session_status: null,          // null | "active" | "paused_budget" | "paused_checkpoint" | "verification_hang"
  pause_reason: null,            // human-readable pause reason
  resume_from_phase: null,       // phase ID to resume from
  pause_timestamp: null,         // ISO timestamp of pause
  budget_at_pause: null,         // { context_pct, estimated_needed_pct }
  // #109 G4: ISO-8601 timestamp of the most recent PostToolUse event from
  // mpl-tool-tracker.mjs. Stop hook compares to wall clock; > threshold (default
  // 15min) without an active "paused_*" flag → verification_hang marking.
  last_tool_at: null,            // ISO-8601 timestamp | null
  // #103 P0-A redesign: orchestrator-driven adversarial reviewer.
  // hooks/mpl-quality-gate.mjs increments retry on FAIL, resets to 0 on PASS,
  // freezes at max on escalate. Default budget = 3 retries before user surface.
  adversarial_retry_count: 0,    // current consecutive retry count
  quality_score_history: [],     // [{ phase, score, verdict, issues, timestamp, action, retry_count }]
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

/**
 * Read MPL state from .mpl/state.json.
 *
 * Schema-version handling (H8 / #116):
 *   - `schema_version > CURRENT_SCHEMA_VERSION` → **fail-closed**. The
 *     plugin is older than the writer; we cannot reason about field
 *     shapes that may have been renamed or removed. Returns `null` so
 *     downstream hooks degrade rather than misinterpret. A diagnostic
 *     line is written to stderr; G3 I8 (defense-in-depth) also catches
 *     the same condition when invoked.
 *   - `schema_version < CURRENT_SCHEMA_VERSION` (or absent → treated as
 *     1) → run the migration registry up to current. Migrations persist
 *     atomically inside this function so subsequent reads short-circuit.
 *
 * @param {string} cwd - Working directory
 * @returns {object|null} State object or null if not found/invalid/unsupported
 */
export function readState(cwd) {
  try {
    const statePath = join(cwd, STATE_DIR, STATE_FILE);
    if (!existsSync(statePath)) return null;
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8'));
    // M5: Minimal schema validation
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (!parsed.current_phase) return null;

    // H8 fail-closed guard — refuse to act on a state from a newer writer.
    if (typeof parsed.schema_version === 'number' && parsed.schema_version > CURRENT_SCHEMA_VERSION) {
      process.stderr.write(
        `[MPL state] schema_version=${parsed.schema_version} exceeds supported MAX=${CURRENT_SCHEMA_VERSION}. ` +
        `Upgrade the mpl plugin or restore .mpl/state.json from a compatible run. ` +
        `See docs/schemas/migration-policy.md.\n`
      );
      return null;
    }

    if ((parsed.schema_version ?? 1) < CURRENT_SCHEMA_VERSION) {
      const migrated = applyMigrationChain(cwd, parsed);
      if (migrated) return migrated;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Run the migration registry against `state` and persist the result
 * atomically. Returns the migrated state, or `null` on I/O failure
 * (caller falls back to the unmigrated state).
 */
function applyMigrationChain(cwd, state) {
  try {
    const migrated = runMigrations(state, cwd, CURRENT_SCHEMA_VERSION);
    if (!migrated || migrated === state) return migrated || state;

    const stateDir = join(cwd, STATE_DIR);
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    const stateTmp = join(stateDir, `.state-${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(stateTmp, JSON.stringify(migrated, null, 2), { mode: 0o600 });
    renameSync(stateTmp, join(stateDir, STATE_FILE));
    return migrated;
  } catch {
    return null;
  }
}

/**
 * Public migration entry point. Retained from P2-6 so external consumers
 * (e.g. `skills/mpl-resume/SKILL.md`) keep working — the body now
 * delegates to the H8 migration registry, which handles archive +
 * persistence in `applyMigrationChain`. The returned object is the
 * migrated state, or `null` on I/O failure (caller keeps the unmigrated
 * state so the pipeline doesn't wedge).
 */
export function migrateLegacyExecutionState(cwd, currentState) {
  if (!currentState || typeof currentState !== 'object') return null;
  return applyMigrationChain(cwd, currentState);
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
 * Thrown by `writeState` when `.mpl/state.json` already carries a
 * `schema_version` that exceeds what this plugin supports. Without this
 * the on-disk state would silently be overwritten with the v2 default
 * shape + patch (PR #132 review #1) — a fresh-writer state from a newer
 * plugin would be downgraded and any field outside v2's vocabulary lost.
 */
export class UnsupportedSchemaVersionError extends Error {
  constructor(version, supported) {
    super(
      `state.schema_version=${version} exceeds supported MAX=${supported}. ` +
      `Refusing to overwrite a fresher state with an older shape. ` +
      `Upgrade the mpl plugin or restore .mpl/state.json from a compatible run. ` +
      `See docs/schemas/migration-policy.md.`
    );
    this.name = 'UnsupportedSchemaVersionError';
    this.version = version;
    this.supported = supported;
  }
}

/**
 * Probe the on-disk state.json for a schema_version that this plugin can
 * not safely round-trip. Returns the offending version if the file
 * exists, parses, and exceeds CURRENT_SCHEMA_VERSION; null otherwise
 * (missing, corrupt, parity, or older). Pure read — no mutation.
 */
function readPersistedSchemaVersion(cwd) {
  const statePath = join(cwd, STATE_DIR, STATE_FILE);
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8'));
    if (typeof parsed?.schema_version === 'number' && parsed.schema_version > CURRENT_SCHEMA_VERSION) {
      return parsed.schema_version;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write/merge MPL state to .mpl/state.json (atomic via temp + rename).
 *
 * H8 (#116, PR #132 review #1): if the on-disk file declares a
 * `schema_version` newer than `CURRENT_SCHEMA_VERSION`, throw
 * `UnsupportedSchemaVersionError` instead of overwriting it. `readState`
 * already returns `null` for that case (fail-closed read), but
 * `writeState` previously treated `null` the same as "no file" and
 * wrote `DEFAULT_STATE` + patch — silently downgrading the fresher
 * state and dropping any field outside the v2 vocabulary.
 *
 * @param {string} cwd - Working directory
 * @param {object} patch - Fields to merge into state
 * @returns {object} Merged state
 * @throws {UnsupportedSchemaVersionError} when on-disk schema_version > CURRENT
 */
export function writeState(cwd, patch) {
  const futureVersion = readPersistedSchemaVersion(cwd);
  if (futureVersion !== null) {
    process.stderr.write(
      `[MPL state] writeState refused — on-disk schema_version=${futureVersion} ` +
      `exceeds supported MAX=${CURRENT_SCHEMA_VERSION}. State left untouched. ` +
      `See docs/schemas/migration-policy.md.\n`
    );
    throw new UnsupportedSchemaVersionError(futureVersion, CURRENT_SCHEMA_VERSION);
  }

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

