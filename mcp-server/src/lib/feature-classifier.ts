/**
 * Feature Scope Classifier — LLM-driven UC classification for 0.16 Tier A'.
 *
 * Uses the Claude Agent SDK (session auth, no API key) following the same
 * pattern as llm-scorer.ts. Given spec + pivot points + user responses,
 * classifies features into included / deferred / cut, extracts scenarios,
 * records PP conflicts, and suggests the next clarifying question.
 *
 * PROMPT_VERSION is frozen inline — changing the prompt requires bumping
 * the version so exp12 measurements can detect prompt drift.
 */

export const PROMPT_VERSION = 'v1-2026-04-19';

const MAX_RETRIES = 2;

let cachedSessionId: string | null = null;

export interface UserCase {
  id: string;
  title: string;
  user_delta: string;
  priority: 'P0' | 'P1' | 'P2';
  status: 'included';
  covers_pp: string[];
  acceptance_hint?: string;
}

export interface DeferredCase {
  id: string;
  title: string;
  reason: string;
  revisit_at: string;
  source_round: number;
}

export interface CutCase {
  id: string;
  title: string;
  reason: string;
  source_round: number;
}

export interface ScenarioSpec {
  id: string;
  title: string;
  covers: string[];
  covers_pp: string[];
  steps: string[];
  skip_allowed: string[];
}

export interface PpConflict {
  uc_id: string;
  pp_id: string;
  conflict_type: 'direct' | 'boundary' | 'performance';
  resolution: 'uc_dropped' | 'uc_reshaped' | 'pp_reaffirmed';
  round: number;
  note: string;
}

export interface AmbiguityHint {
  uc_id: string;
  dimension:
    | 'specificity'
    | 'priority'
    | 'dependency'
    | 'boundary'
    | 'success_criteria';
  suggestion: string;
}

export interface NextQuestion {
  kind: 'clarify' | 'priority' | 'conflict';
  payload: Record<string, unknown>;
}

export interface ClassificationResult {
  prompt_version: string;
  user_cases: UserCase[];
  deferred: DeferredCase[];
  cut: CutCase[];
  scenarios: ScenarioSpec[];
  pp_conflict: PpConflict[];
  ambiguity_hints: AmbiguityHint[];
  next_question: NextQuestion | null;
  convergence: boolean;
}

const CLASSIFY_PROMPT = `You are the MPL Feature Scope Classifier (0.16 Tier A').

GOAL: Produce a deterministic JSON classification of user-facing features for the
input spec + Pivot Points + user responses. Do NOT implement anything. Do NOT
prescribe architecture. Only classify scope.

RULES:
1. Every included user_case MUST list at least one covers_pp id (PP-N) drawn from
   the supplied Pivot Points. If no PP matches, record it as pp_conflict with
   resolution "pp_reaffirmed" and move the candidate to cut or deferred.
2. user_delta is the key field: non-empty iff the UC was NOT derivable from the
   spec alone (i.e., surfaced via user responses). Spec-only UCs use "".
3. Use UC-NN ids with 2+ digits (UC-01, UC-15). Prefer stable ids across
   iterations — if prev_contract shows a UC, keep that id.
4. deferred_cases have a reason and revisit_at ("post-v0.17" / "after-UC-03" /
   "on-user-request"). cut_cases are permanent out-of-scope.
5. scenarios are E2E test seeds. Each scenario covers at least 1 UC. covers_pp
   is the union of covers[*].covers_pp.
6. skip_allowed: list environmental skip reasons that are acceptable for this
   scenario (ENV_API_DOWN, FLAKY_NETWORK, DEPENDENCY_MISSING, RATE_LIMIT,
   OS_INCOMPATIBLE). Empty array means strict (no skip allowed).
7. next_question: set to null only when convergence is true. Otherwise propose
   ONE targeted question to close the highest-uncertainty gap.
8. convergence: true only when every included UC has covers_pp, no unresolved
   pp_conflict exists, and no ambiguity_hint has dimension "priority" or
   "boundary".

RESPOND ONLY WITH VALID JSON (no markdown, no prose):
{
  "user_cases": [{ "id": "UC-01", "title": "", "user_delta": "", "priority": "P0|P1|P2", "status": "included", "covers_pp": ["PP-1"], "acceptance_hint": "" }],
  "deferred": [{ "id": "UC-0X", "title": "", "reason": "", "revisit_at": "", "source_round": 1 }],
  "cut": [{ "id": "UC-0X", "title": "", "reason": "", "source_round": 1 }],
  "scenarios": [{ "id": "SC-01", "title": "", "covers": ["UC-01"], "covers_pp": ["PP-1"], "steps": [""], "skip_allowed": [] }],
  "pp_conflict": [{ "uc_id": "UC-0X", "pp_id": "PP-X", "conflict_type": "direct|boundary|performance", "resolution": "uc_dropped|uc_reshaped|pp_reaffirmed", "round": 1, "note": "" }],
  "ambiguity_hints": [{ "uc_id": "UC-0X", "dimension": "specificity|priority|dependency|boundary|success_criteria", "suggestion": "" }],
  "next_question": null,
  "convergence": false
}`;

function buildUserMessage(input: ClassifierInput): string {
  let msg = `Spec:\n${input.spec_text || '(empty)'}\n\nPivot Points:\n${input.pivot_points}\n\nUser Responses:\n${input.user_responses}`;
  if (input.prev_contract) {
    msg += `\n\nPrevious Iteration Contract (for id stability):\n${input.prev_contract}`;
  }
  msg += `\n\nRound: ${input.round}`;
  return msg;
}

export interface ClassifierInput {
  spec_text: string;
  pivot_points: string;
  user_responses: string;
  prev_contract?: string;
  round: number;
}

export function parseClassification(text: string): ClassificationResult | null {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);

    // Structural sanity
    const requiredArrays = [
      'user_cases',
      'deferred',
      'cut',
      'scenarios',
      'pp_conflict',
      'ambiguity_hints',
    ];
    for (const key of requiredArrays) {
      if (!Array.isArray(parsed[key])) return null;
    }
    if (typeof parsed.convergence !== 'boolean') return null;
    if (parsed.next_question !== null && typeof parsed.next_question !== 'object') {
      return null;
    }

    return {
      prompt_version: PROMPT_VERSION,
      user_cases: parsed.user_cases,
      deferred: parsed.deferred,
      cut: parsed.cut,
      scenarios: parsed.scenarios,
      pp_conflict: parsed.pp_conflict,
      ambiguity_hints: parsed.ambiguity_hints,
      next_question: parsed.next_question,
      convergence: parsed.convergence,
    };
  } catch {
    return null;
  }
}

export function neutralResult(): ClassificationResult {
  return {
    prompt_version: PROMPT_VERSION,
    user_cases: [],
    deferred: [],
    cut: [],
    scenarios: [],
    pp_conflict: [],
    ambiguity_hints: [
      {
        uc_id: 'UC-00',
        dimension: 'specificity',
        suggestion:
          'LLM classifier unavailable. Provide UC list manually or retry after restoring Agent SDK access.',
      },
    ],
    next_question: {
      kind: 'clarify',
      payload: {
        reason: 'classifier_unavailable',
        instruction:
          'Agent SDK not reachable; the orchestrator should degrade to a manual spec-only UC extraction or halt.',
      },
    },
    convergence: false,
  };
}

export async function classifyFeatureScope(
  input: ClassifierInput,
): Promise<ClassificationResult> {
  const userMessage = buildUserMessage(input);
  const fullPrompt = `${CLASSIFY_PROMPT}\n\nINPUT:\n${userMessage}`;

  let queryFn:
    | typeof import('@anthropic-ai/claude-agent-sdk').query
    | null = null;
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    queryFn = sdk.query;
  } catch {
    return neutralResult();
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const queryOptions: Record<string, unknown> = {
        model: 'opus',
        maxTurns: 1,
        systemPrompt:
          'You are a JSON-only classification assistant. Output only valid JSON per the schema.',
        allowedTools: [],
      };
      if (cachedSessionId) queryOptions.sessionId = cachedSessionId;

      const q = queryFn({ prompt: fullPrompt, options: queryOptions });
      let responseText = '';
      for await (const event of q) {
        if (event.type === 'result' && event.subtype === 'success') {
          responseText = (event as { result: string }).result;
          const sessionId = (event as { sessionId?: string }).sessionId;
          if (sessionId) cachedSessionId = sessionId;
        } else if (event.type === 'assistant') {
          const msg = event.message as {
            content?: Array<{ type: string; text?: string }>;
          };
          if (msg.content) {
            for (const block of msg.content) {
              if (block.type === 'text' && block.text) {
                responseText += block.text;
              }
            }
          }
        } else if ((event as { sessionId?: string }).sessionId) {
          const sessionId = (event as { sessionId?: string }).sessionId;
          if (sessionId) cachedSessionId = sessionId;
        }
      }

      const parsed = parseClassification(responseText);
      if (parsed) return parsed;
    } catch {
      if (attempt === MAX_RETRIES) return neutralResult();
    }
  }

  return neutralResult();
}
