/**
 * MCP Tools: mpl_state_read + mpl_state_write
 * Provides active state access for agents during execution.
 */
import { readState, writeState, filterState } from '../lib/state-manager.js';
export const stateReadTool = {
    name: 'mpl_state_read',
    description: 'Read MPL pipeline state. Returns full state or specific fields.',
    inputSchema: {
        type: 'object',
        properties: {
            cwd: { type: 'string', description: 'Project root directory' },
            keys: {
                type: 'array',
                items: { type: 'string' },
                description: 'Specific fields to read. Empty or omitted = full state.',
            },
        },
        required: ['cwd'],
    },
};
export async function handleStateRead(args) {
    const state = readState(args.cwd);
    if (!state) {
        return { content: [{ type: 'text', text: JSON.stringify({ state: null, error: 'No MPL state found. Is MPL active?' }) }] };
    }
    const filtered = args.keys?.length ? filterState(state, args.keys) : state;
    return { content: [{ type: 'text', text: JSON.stringify({ state: filtered }) }] };
}
export const stateWriteTool = {
    name: 'mpl_state_write',
    description: 'Update MPL pipeline state. Deep-merges patch with current state. Atomic write.',
    inputSchema: {
        type: 'object',
        properties: {
            cwd: { type: 'string', description: 'Project root directory' },
            patch: {
                type: 'object',
                description: 'Fields to update (deep-merged with current state)',
            },
        },
        required: ['cwd', 'patch'],
    },
};
export async function handleStateWrite(args) {
    const result = writeState(args.cwd, args.patch);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}
//# sourceMappingURL=state.js.map