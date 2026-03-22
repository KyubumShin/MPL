/**
 * MPL State Manager — ported from hooks/lib/mpl-state.mjs
 * Provides deterministic state read/write with atomic file operations.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
const STATE_PATH = '.mpl/state.json';
const DEFAULT_STATE = {
    pipeline_id: null,
    run_mode: 'full',
    tool_mode: 'full',
    pipeline_tier: null,
    pipeline_score: null,
    tier_hint: null,
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
        gate1_passed: null,
        gate2_passed: null,
        gate3_passed: null,
    },
    fix_loop_count: 0,
    max_fix_loops: 10,
    compaction_count: 0,
    session_id: null,
    cost: {
        total_tokens: 0,
        max_total_tokens: 500000,
        estimated_usd: 0,
    },
    convergence: {
        pass_rate_history: [],
        stagnation_window: 3,
        min_improvement: 0.05,
        regression_threshold: -0.10,
    },
    session_status: null,
    pause_reason: null,
    resume_from_phase: null,
    pause_timestamp: null,
    budget_at_pause: null,
};
function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype')
            continue;
        const targetVal = target[key];
        const sourceVal = source[key];
        if (sourceVal !== null &&
            typeof sourceVal === 'object' &&
            !Array.isArray(sourceVal) &&
            targetVal !== null &&
            typeof targetVal === 'object' &&
            !Array.isArray(targetVal)) {
            result[key] = deepMerge(targetVal, sourceVal);
        }
        else {
            result[key] = sourceVal;
        }
    }
    return result;
}
export function readState(cwd) {
    const filePath = join(cwd, STATE_PATH);
    if (!existsSync(filePath))
        return null;
    try {
        const content = readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(content);
        return deepMerge(DEFAULT_STATE, parsed);
    }
    catch {
        return null;
    }
}
export function writeState(cwd, patch) {
    const filePath = join(cwd, STATE_PATH);
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const current = readState(cwd) ?? { ...DEFAULT_STATE };
    const merged = deepMerge(current, patch);
    // Atomic write: temp file → rename
    const tmpPath = `${filePath}.${randomUUID().slice(0, 8)}.tmp`;
    try {
        writeFileSync(tmpPath, JSON.stringify(merged, null, 2));
        renameSync(tmpPath, filePath);
        return { success: true, updated_keys: Object.keys(patch) };
    }
    catch {
        // Cleanup temp file on failure
        try {
            writeFileSync(filePath, JSON.stringify(merged, null, 2));
        }
        catch { /* ignore */ }
        return { success: false, updated_keys: [] };
    }
}
export function filterState(state, keys) {
    if (!keys.length)
        return state;
    const result = {};
    for (const key of keys) {
        if (key in state) {
            result[key] = state[key];
        }
    }
    return result;
}
//# sourceMappingURL=state-manager.js.map