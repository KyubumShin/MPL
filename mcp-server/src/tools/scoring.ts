/**
 * MCP Tool: mpl_score_ambiguity
 * Deterministic 5-dimension ambiguity scoring via LLM API + code computation.
 */

import { scoreDimensions } from '../lib/llm-scorer.js';

const WEIGHTS = {
  spec_completeness: 0.30,
  edge_case_coverage: 0.20,
  technical_decision: 0.20,
  acceptance_testability: 0.15,
  pp_conformance: 0.15,
} as const;

const AMBIGUITY_THRESHOLD = 0.2;

const DIMENSION_LABELS: Record<string, string> = {
  spec_completeness: 'Spec Completeness',
  edge_case_coverage: 'Edge Case Coverage',
  technical_decision: 'Technical Decision',
  acceptance_testability: 'Acceptance Testability',
  pp_conformance: 'PP Conformance',
};

export const scoreAmbiguityTool = {
  name: 'mpl_score_ambiguity',
  description: 'Compute 5-dimension ambiguity score deterministically. Returns exact score, weakest dimension, and suggested question.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      cwd: { type: 'string', description: 'Project root directory' },
      pivot_points: { type: 'string', description: 'Pivot Points markdown content' },
      user_responses: { type: 'string', description: 'Stage 1 Q&A summary' },
      spec_analysis: { type: 'string', description: 'Spec reading results (optional)' },
      codebase_context: { type: 'string', description: 'Relevant codebase findings (optional)' },
      current_choices: { type: 'string', description: 'Known implementation choices (optional)' },
    },
    required: ['cwd', 'pivot_points', 'user_responses'],
  },
};

export async function handleScoreAmbiguity(args: {
  cwd: string;
  pivot_points: string;
  user_responses: string;
  spec_analysis?: string;
  codebase_context?: string;
  current_choices?: string;
}) {
  // 1. Get dimension scores from LLM (temp 0.1)
  const scores = await scoreDimensions({
    pivot_points: args.pivot_points,
    user_responses: args.user_responses,
    spec_analysis: args.spec_analysis,
    codebase_context: args.codebase_context,
    current_choices: args.current_choices,
  });

  // 2. Compute weighted sum in code (deterministic)
  const clarity =
    scores.spec_completeness.score * WEIGHTS.spec_completeness +
    scores.edge_case_coverage.score * WEIGHTS.edge_case_coverage +
    scores.technical_decision.score * WEIGHTS.technical_decision +
    scores.acceptance_testability.score * WEIGHTS.acceptance_testability +
    scores.pp_conformance.score * WEIGHTS.pp_conformance;

  const ambiguity = Math.round((1.0 - clarity) * 1000) / 1000;
  const clarityPct = Math.round(clarity * 100);

  // 3. Find weakest dimension
  type DimKey = keyof typeof WEIGHTS;
  let weakestDim: DimKey = 'spec_completeness';
  let weakestScore = 1.0;
  for (const [dim, weight] of Object.entries(WEIGHTS)) {
    const score = scores[dim as DimKey].score;
    if (score < weakestScore) {
      weakestScore = score;
      weakestDim = dim as DimKey;
    }
  }

  // 4. Generate suggested question based on weakest dimension
  const suggestedQuestion = generateQuestion(weakestDim, scores[weakestDim].justification);

  const result = {
    ambiguity_score: ambiguity,
    clarity_pct: clarityPct,
    threshold_met: ambiguity <= AMBIGUITY_THRESHOLD,
    dimensions: {
      spec_completeness: scores.spec_completeness,
      edge_case_coverage: scores.edge_case_coverage,
      technical_decision: scores.technical_decision,
      acceptance_testability: scores.acceptance_testability,
      pp_conformance: scores.pp_conformance,
    },
    weakest_dimension: DIMENSION_LABELS[weakestDim] ?? weakestDim,
    weakest_dimension_key: weakestDim,
    weakest_score: weakestScore,
    suggested_question: suggestedQuestion,
  };

  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
}

function generateQuestion(dimension: string, justification: string): string {
  const templates: Record<string, string> = {
    spec_completeness: `The spec has gaps: ${justification}. What specific behavior is expected for the undefined areas?`,
    edge_case_coverage: `Edge cases are underspecified: ${justification}. How should the system handle these exceptional scenarios?`,
    technical_decision: `Technical choices are unclear: ${justification}. Which approach do you prefer?`,
    acceptance_testability: `Success criteria are vague: ${justification}. What concrete, measurable conditions indicate completion?`,
    pp_conformance: `Potential PP alignment issues: ${justification}. Should we adjust the approach to better align with PPs?`,
  };
  return templates[dimension] ?? `Clarification needed for ${dimension}: ${justification}`;
}
