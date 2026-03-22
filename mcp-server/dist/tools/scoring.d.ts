/**
 * MCP Tool: mpl_score_ambiguity
 * Deterministic 5-dimension ambiguity scoring via LLM API + code computation.
 */
export declare const scoreAmbiguityTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            cwd: {
                type: string;
                description: string;
            };
            pivot_points: {
                type: string;
                description: string;
            };
            user_responses: {
                type: string;
                description: string;
            };
            spec_analysis: {
                type: string;
                description: string;
            };
            codebase_context: {
                type: string;
                description: string;
            };
            current_choices: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare function handleScoreAmbiguity(args: {
    cwd: string;
    pivot_points: string;
    user_responses: string;
    spec_analysis?: string;
    codebase_context?: string;
    current_choices?: string;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=scoring.d.ts.map