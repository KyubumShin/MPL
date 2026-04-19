#!/usr/bin/env node
/**
 * MPL MCP Server — Tier 1: Deterministic Scoring + Active State Access
 *
 * Tools:
 *   mpl_score_ambiguity         — 5D ambiguity scoring via LLM API (temp 0.1) + code computation
 *   mpl_state_read              — Read pipeline state (active agent access)
 *   mpl_state_write             — Update pipeline state (atomic, deep-merge)
 *   mpl_classify_feature_scope  — 0.16 Tier A': classify user cases (included/deferred/cut) +
 *                                 scenarios + PP conflict ledger (called inline during Phase 0 Step 1.5)
 *   mpl_diagnose_e2e_failure    — 0.16 Tier C: classify E2E failure as A/B/C/D + fix strategy
 *                                 (called conditionally from Finalize; circuit breaker iter<=2)
 *
 * Transport: stdio (Claude Code standard)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { scoreAmbiguityTool, handleScoreAmbiguity } from './tools/scoring.js';
import { stateReadTool, handleStateRead, stateWriteTool, handleStateWrite } from './tools/state.js';
import {
  classifyFeatureScopeTool,
  handleClassifyFeatureScope,
} from './tools/feature-scope.js';
import {
  diagnoseE2EFailureTool,
  handleDiagnoseE2EFailure,
} from './tools/e2e-diagnose.js';

const server = new Server(
  { name: 'mpl-server', version: '0.6.6' },
  { capabilities: { tools: {} } },
);

// Register tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    scoreAmbiguityTool,
    stateReadTool,
    stateWriteTool,
    classifyFeatureScopeTool,
    diagnoseE2EFailureTool,
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'mpl_score_ambiguity':
      return handleScoreAmbiguity(args as Parameters<typeof handleScoreAmbiguity>[0]);

    case 'mpl_state_read':
      return handleStateRead(args as Parameters<typeof handleStateRead>[0]);

    case 'mpl_state_write':
      return handleStateWrite(args as Parameters<typeof handleStateWrite>[0]);

    case 'mpl_classify_feature_scope':
      return handleClassifyFeatureScope(
        args as Parameters<typeof handleClassifyFeatureScope>[0],
      );

    case 'mpl_diagnose_e2e_failure':
      return handleDiagnoseE2EFailure(
        args as Parameters<typeof handleDiagnoseE2EFailure>[0],
      );

    default:
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('MCP server failed to start:', error);
  process.exit(1);
});
