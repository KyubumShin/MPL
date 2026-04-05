/**
 * MPL State Manager — ported from hooks/lib/mpl-state.mjs
 * Provides deterministic state read/write with atomic file operations.
 */
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
export declare function readState(cwd: string): MplState | null;
export declare function writeState(cwd: string, patch: Record<string, unknown>): {
    success: boolean;
    updated_keys: string[];
};
export declare function filterState(state: MplState, keys: string[]): Record<string, unknown>;
//# sourceMappingURL=state-manager.d.ts.map