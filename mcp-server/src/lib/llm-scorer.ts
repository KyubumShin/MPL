/**
 * LLM Scorer — uses Claude Agent SDK for scoring (no API key needed).
 *
 * Leverages the user's Claude Code session authentication (Max Plan credits).
 * This is the same pattern used by Ouroboros (ClaudeCodeAdapter).
 *
 * Session reuse: the Agent SDK's `sessionId` is both the continuation token
 * AND the prompt-cache key — without it the scoring prompt + pivot_points
 * prefix is re-billed at full input rate on every call. To keep cost bounded
 * across MCP server restarts and across projects sharing the same MCP
 * process, session ids are persisted to `~/.mpl/cache/sessions.json` via
 * `session-cache.ts`, keyed by (cwd, kind) and validated against
 * pipeline_id + pivot_points hash + TTL.
 *
 * Fallback: if Agent SDK is unavailable, returns neutral scores.
 */

import { runCachedQuery, isSessionExpiredError as _isSessionExpiredError } from './agent-sdk-query.js';
import { readState } from './state-manager.js';

const SESSION_KIND = 'ambiguity';

/**
 * Re-export of `isSessionExpiredError` from the shared agent-sdk-query module.
 * Retained for backward compatibility with pre-P2-7 tests importing from
 * llm-scorer; new callers should import directly from `./agent-sdk-query.js`.
 */
export const isSessionExpiredError = _isSessionExpiredError;

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
  pp_conformance: DimensionScore & { conflicts: string[]; infeasible: string[] };
  /**
   * True when every dimension was filled from the neutral-fallback path
   * (SDK unavailable, all retries exhausted, or parse failure). The
   * orchestrator uses this to escalate to the user instead of looping on
   * cosmetic 0.5 scores that carry no real information.
   */
  degraded?: boolean;
  /** Short reason string when `degraded === true`. */
  degraded_reason?: string;
}

const SCORING_PROMPT = `You are a requirements clarity analyst. Score the following across 5 dimensions.

DIMENSIONS (each 0.0 to 1.0):
1. Spec Completeness (30%): sufficient implementation info? Key details specified?
2. Edge Case Coverage (20%): error states and exception flows defined?
3. Technical Decision (20%): technology choices and architecture decisions explicit?
4. Acceptance Testability (15%): completion criteria concrete enough for automated tests?
5. PP Conformance (15%): choices align with Pivot Points? Any conflicts or infeasibility?

Score each dimension from 0.0 (completely unclear) to 1.0 (perfectly clear).

RESPOND ONLY WITH VALID JSON (no markdown, no explanation):
{
  "spec_completeness": { "score": 0.0, "justification": "" },
  "edge_case_coverage": { "score": 0.0, "justification": "" },
  "technical_decision": { "score": 0.0, "justification": "" },
  "acceptance_testability": { "score": 0.0, "justification": "" },
  "pp_conformance": { "score": 0.0, "justification": "", "conflicts": [], "infeasible": [] }
}`;

function buildUserMessage(input: {
  pivot_points: string;
  user_responses: string;
  spec_analysis?: string;
  codebase_context?: string;
  current_choices?: string;
}): string {
  let msg = `Pivot Points:\n${input.pivot_points}\n\nUser Responses:\n${input.user_responses}`;
  if (input.spec_analysis) msg += `\n\nSpec Analysis:\n${input.spec_analysis}`;
  if (input.codebase_context) msg += `\n\nCodebase Context:\n${input.codebase_context}`;
  if (input.current_choices) msg += `\n\nCurrent Implementation Choices:\n${input.current_choices}`;
  return msg;
}

function parseScores(text: string): ScoringResult | null {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);

    const dims = ['spec_completeness', 'edge_case_coverage', 'technical_decision', 'acceptance_testability', 'pp_conformance'];
    for (const dim of dims) {
      if (!parsed[dim] || typeof parsed[dim].score !== 'number') return null;
      parsed[dim].score = Math.max(0, Math.min(1, parsed[dim].score));
    }

    if (!Array.isArray(parsed.pp_conformance.conflicts)) parsed.pp_conformance.conflicts = [];
    if (!Array.isArray(parsed.pp_conformance.infeasible)) parsed.pp_conformance.infeasible = [];

    return parsed as ScoringResult;
  } catch {
    return null;
  }
}

function neutralResult(reason = 'scoring_unavailable'): ScoringResult {
  const neutral: DimensionScore = { score: 0.5, justification: 'Scoring unavailable — neutral fallback' };
  return {
    spec_completeness: neutral,
    edge_case_coverage: neutral,
    technical_decision: neutral,
    acceptance_testability: neutral,
    pp_conformance: { ...neutral, conflicts: [], infeasible: [] },
    degraded: true,
    degraded_reason: reason,
  };
}

export async function scoreDimensions(input: {
  cwd: string;
  pivot_points: string;
  user_responses: string;
  spec_analysis?: string;
  codebase_context?: string;
  current_choices?: string;
}): Promise<ScoringResult> {
  const userMessage = buildUserMessage(input);
  const fullPrompt = `${SCORING_PROMPT}\n\nINPUT:\n${userMessage}`;

  // Session cache identity: pipeline_id from state + content hash over the
  // stable scoring prefix (prompt + pivot_points). user_responses is NOT
  // hashed — it grows across rounds and mismatch would force a fresh
  // session on every round, defeating the cache.
  const state = readState(input.cwd);
  const pipelineId = state?.pipeline_id ?? 'unknown-pipeline';

  const r = await runCachedQuery<ScoringResult>(
    {
      cwd: input.cwd,
      kind: SESSION_KIND,
      pipeline_id: pipelineId,
      cache_input: `${SCORING_PROMPT}\n${input.pivot_points}`,
      system_prompt: 'You are a JSON-only scoring assistant. Output only valid JSON.',
      full_prompt: fullPrompt,
    },
    parseScores,
  );

  if (r.ok) return r.value;
  return neutralResult(r.reason);
}

// Test-only injection point. Delegates to the shared agent-sdk-query hook so
// existing scorer tests (`__testing.setQueryFn`) keep working verbatim.
import { __testing as _sdkTesting } from './agent-sdk-query.js';
export const __testing = _sdkTesting;
