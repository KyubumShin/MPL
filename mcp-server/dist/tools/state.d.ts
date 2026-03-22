/**
 * MCP Tools: mpl_state_read + mpl_state_write
 * Provides active state access for agents during execution.
 */
export declare const stateReadTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            cwd: {
                type: string;
                description: string;
            };
            keys: {
                type: string;
                items: {
                    type: string;
                };
                description: string;
            };
        };
        required: string[];
    };
};
export declare function handleStateRead(args: {
    cwd: string;
    keys?: string[];
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare const stateWriteTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            cwd: {
                type: string;
                description: string;
            };
            patch: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare function handleStateWrite(args: {
    cwd: string;
    patch: Record<string, unknown>;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=state.d.ts.map