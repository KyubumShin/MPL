/**
 * LLM Scorer — uses Claude Agent SDK for scoring (no API key needed).
 *
 * Leverages the user's Claude Code session authentication (Max Plan credits).
 * This is the same pattern used by Ouroboros (ClaudeCodeAdapter).
 *
 * Fallback: if Agent SDK is unavailable, returns neutral scores.
 */

const MAX_RETRIES = 2;

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

function neutralResult(): ScoringResult {
  const neutral: DimensionScore = { score: 0.5, justification: 'Scoring unavailable — neutral fallback' };
  return {
    spec_completeness: neutral,
    edge_case_coverage: neutral,
    technical_decision: neutral,
    acceptance_testability: neutral,
    pp_conformance: { ...neutral, conflicts: [], infeasible: [] },
  };
}

export async function scoreDimensions(input: {
  pivot_points: string;
  user_responses: string;
  spec_analysis?: string;
  codebase_context?: string;
  current_choices?: string;
}): Promise<ScoringResult> {
  const userMessage = buildUserMessage(input);
  const fullPrompt = `${SCORING_PROMPT}\n\nINPUT:\n${userMessage}`;

  // Try Claude Agent SDK (no API key needed — uses session auth)
  let queryFn: typeof import('@anthropic-ai/claude-agent-sdk').query | null = null;
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    queryFn = sdk.query;
  } catch {
    // Agent SDK not available — return neutral scores
    return neutralResult();
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const q = queryFn({
        prompt: fullPrompt,
        options: {
          model: 'haiku',
          maxTurns: 1,
          systemPrompt: 'You are a JSON-only scoring assistant. Output only valid JSON.',
          allowedTools: [], // No tools needed — pure text completion
        },
      });

      // Collect response text from SDK events
      let responseText = '';
      for await (const event of q) {
        if (event.type === 'result' && event.subtype === 'success') {
          // SDKResultSuccess has a `result` field
          responseText = (event as { result: string }).result;
        } else if (event.type === 'assistant') {
          // SDKAssistantMessage — extract text from BetaMessage content blocks
          const msg = event.message as { content?: Array<{ type: string; text?: string }> };
          if (msg.content) {
            for (const block of msg.content) {
              if (block.type === 'text' && block.text) {
                responseText += block.text;
              }
            }
          }
        }
      }

      const scores = parseScores(responseText);
      if (scores) return scores;

      // Parse failed, retry
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        // All retries failed — return neutral
        return neutralResult();
      }
    }
  }

  return neutralResult();
}
