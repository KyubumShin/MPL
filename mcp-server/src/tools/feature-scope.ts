/**
 * MCP Tool: mpl_classify_feature_scope
 *
 * Orchestrator-driven Feature Scope classification for 0.16 Tier A'.
 * Called during Phase 0 Step 1.5 (inline loop, after PP Discovery).
 *
 * Returns a structured classification:
 *   - user_cases (included), deferred, cut
 *   - scenarios (E2E test seeds)
 *   - pp_conflict (UC ↔ PP conflict ledger)
 *   - ambiguity_hints (for Stage 2 Ambiguity Resolution)
 *   - next_question (null iff convergence)
 *   - convergence (boolean)
 *
 * Pattern: deterministic return shape; LLM call (opus, session auth) handled
 * inside lib/feature-classifier.ts. Matches mpl_score_ambiguity style.
 */

import {
  classifyFeatureScope,
  PROMPT_VERSION,
} from '../lib/feature-classifier.js';

export const classifyFeatureScopeTool = {
  name: 'mpl_classify_feature_scope',
  description:
    'Classify user-facing feature scope into included/deferred/cut UCs + scenarios + PP conflict ledger. Orchestrator calls this inline during Phase 0 Step 1.5 until convergence.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      cwd: { type: 'string', description: 'Project root directory' },
      spec_text: {
        type: 'string',
        description: 'Raw spec / PRD content',
      },
      pivot_points: {
        type: 'string',
        description: 'Pivot Points markdown content (read-only — classifier must not modify PPs)',
      },
      user_responses: {
        type: 'string',
        description:
          'Concatenated user responses from Step 1.5 interview rounds (format: round N: Q: .. A: ..)',
      },
      prev_contract: {
        type: 'string',
        description:
          'Previous iteration user-contract.md content, for UC id stability (optional)',
      },
      round: {
        type: 'number',
        description:
          'Current iteration number (1..4). Recorded in source_round fields.',
      },
    },
    required: ['cwd', 'spec_text', 'pivot_points', 'user_responses', 'round'],
  },
};

export async function handleClassifyFeatureScope(args: {
  cwd: string;
  spec_text: string;
  pivot_points: string;
  user_responses: string;
  prev_contract?: string;
  round: number;
}) {
  const round = Math.max(1, Math.min(4, Math.floor(args.round)));

  const result = await classifyFeatureScope({
    spec_text: args.spec_text,
    pivot_points: args.pivot_points,
    user_responses: args.user_responses,
    prev_contract: args.prev_contract,
    round,
  });

  // Ensure deterministic field order at the top level for caller parsing stability
  const ordered = {
    prompt_version: PROMPT_VERSION,
    round,
    user_cases: result.user_cases,
    deferred: result.deferred,
    cut: result.cut,
    scenarios: result.scenarios,
    pp_conflict: result.pp_conflict,
    ambiguity_hints: result.ambiguity_hints,
    next_question: result.next_question,
    convergence: result.convergence,
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(ordered, null, 2) }],
  };
}
