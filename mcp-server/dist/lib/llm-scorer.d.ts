/**
 * LLM Scorer — uses Claude Agent SDK for scoring (no API key needed).
 *
 * Leverages the user's Claude Code session authentication (Max Plan credits).
 * This is the same pattern used by Ouroboros (ClaudeCodeAdapter).
 *
 * Fallback: if Agent SDK is unavailable, returns neutral scores.
 */
export interface DimensionScore {
    score: number;
    justification: string;
    conflicts?: string[];
    infeasible?: string[];
}
export interface ScoringResult {
    spec_completeness: DimensionScore;
    edge_case_coverage: DimensionScore;
    technical_decision: DimensionScore;
    acceptance_testability: DimensionScore;
    pp_conformance: DimensionScore & {
        conflicts: string[];
        infeasible: string[];
    };
}
export declare function scoreDimensions(input: {
    pivot_points: string;
    user_responses: string;
    spec_analysis?: string;
    codebase_context?: string;
    current_choices?: string;
}): Promise<ScoringResult>;
//# sourceMappingURL=llm-scorer.d.ts.map