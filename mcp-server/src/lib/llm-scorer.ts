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

import {
  computeContentHash,
  invalidateSession,
  lookupSession,
  persistSession,
} from './session-cache.js';
import { readState } from './state-manager.js';

const MAX_RETRIES = 2;
const SESSION_KIND = 'ambiguity';

/**
 * Detect Anthropic API responses that indicate the resumed session id is no
 * longer valid (expired / purged / never-existed). The Agent SDK does not
 * expose typed errors, so we match on the small set of signatures Anthropic
 * emits: HTTP 404, "session not found" / "not_found_error" textual fragments,
 * or our SDK's own "Session ... not found" wrapper message.
 *
 * Exported for tests. False positives are non-fatal — they trigger a cache
 * invalidation and a fresh-session retry, which is the same work we'd do on
 * any cache miss.
 */
export function isSessionExpiredError(err: unknown): boolean {
  if (err === null || err === undefined) return false;

  // Thrown error with numeric status (Anthropic SDK or fetch)
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number' && status === 404) return true;

  const parts: string[] = [];
  if (err instanceof Error) {
    if (err.message) parts.push(err.message);
    if ((err as { name?: string }).name) parts.push((err as { name: string }).name);
  } else if (typeof err === 'string') {
    parts.push(err);
  } else {
    try {
      parts.push(JSON.stringify(err));
    } catch {
      parts.push(String(err));
    }
  }

  const haystack = parts.join(' ').toLowerCase();
  if (!haystack) return false;

  const signatures = [
    'session not found',
    'session_not_found',
    'not_found_error',
    'sessionid not found',
    'sessionid is invalid',
    'no such session',
    '"status":404',
    'status: 404',
  ];
  return signatures.some((sig) => haystack.includes(sig));
}

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

  // Try Claude Agent SDK (no API key needed — uses session auth). Tests
  // override via `__testing.setQueryFn` to inject a deterministic fake.
  let queryFn: typeof import('@anthropic-ai/claude-agent-sdk').query | null = __injectedQueryFn;
  if (!queryFn) {
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      queryFn = sdk.query;
    } catch {
      // Agent SDK not available — return neutral scores
      return neutralResult('sdk_unavailable');
    }
  }

  // Session cache identity: pipeline_id from state + content hash over the
  // stable scoring prefix (prompt + pivot_points). user_responses is NOT
  // hashed — it grows across rounds and mismatch would force a fresh
  // session on every round, defeating the cache.
  const state = readState(input.cwd);
  const pipelineId = state?.pipeline_id ?? 'unknown-pipeline';
  const contentHash = computeContentHash(`${SCORING_PROMPT}\n${input.pivot_points}`);

  // `activeSessionId` starts as the cached id and is cleared the moment we
  // observe a session-expired signature, so the next retry runs without a
  // stale resume token.
  let activeSessionId: string | null = lookupSession({
    cwd: input.cwd,
    kind: SESSION_KIND,
    pipeline_id: pipelineId,
    content_hash: contentHash,
  });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const queryOptions: Record<string, unknown> = {
        model: 'opus',
        maxTurns: 1,
        systemPrompt: 'You are a JSON-only scoring assistant. Output only valid JSON.',
        allowedTools: [], // No tools needed — pure text completion
      };

      // Resume existing session when we have a valid cached id so the
      // prompt-cache prefix survives across calls.
      if (activeSessionId) queryOptions.sessionId = activeSessionId;

      const q = queryFn({
        prompt: fullPrompt,
        options: queryOptions,
      });

      // Collect response text and sessionId from SDK events
      let responseText = '';
      let observedSessionId: string | null = null;
      let resultErrorText: string | null = null;
      for await (const event of q) {
        if (event.type === 'result' && event.subtype === 'success') {
          responseText = (event as { result: string }).result;
          const sessionId = (event as { sessionId?: string }).sessionId;
          if (sessionId) observedSessionId = sessionId;
        } else if (event.type === 'result' && 'is_error' in event && (event as { is_error?: boolean }).is_error) {
          // SDKResultError — collect the error payload so we can detect a
          // session-expired signature and invalidate the cache entry.
          const errs = (event as { errors?: unknown }).errors;
          if (Array.isArray(errs)) resultErrorText = errs.map((e) => String(e)).join(' | ');
          else if (typeof errs === 'string') resultErrorText = errs;
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
        } else if ((event as { sessionId?: string }).sessionId) {
          // Capture sessionId from any event that carries it
          const sessionId = (event as { sessionId?: string }).sessionId;
          if (sessionId) observedSessionId = sessionId;
        }
      }

      // Result-level error with session-expired signature → invalidate and
      // retry without the sessionId. Burns one retry attempt, which is the
      // correct accounting (the server already processed the bad resume).
      if (resultErrorText && activeSessionId && isSessionExpiredError(resultErrorText)) {
        invalidateSession(input.cwd, SESSION_KIND);
        activeSessionId = null;
        continue;
      }

      const scores = parseScores(responseText);
      if (scores) {
        if (observedSessionId) {
          // Upsert cache so subsequent rounds hit the prompt cache. The
          // persist call refreshes last_used_at and bumps turn_count.
          persistSession({
            cwd: input.cwd,
            kind: SESSION_KIND,
            pipeline_id: pipelineId,
            content_hash: contentHash,
            session_id: observedSessionId,
          });
        }
        return scores;
      }

      // Parse failed, retry
    } catch (error) {
      // Thrown session-expired error (e.g. 404 from resume). Invalidate the
      // stale cache entry and retry with a fresh session on the next attempt.
      if (activeSessionId && isSessionExpiredError(error)) {
        invalidateSession(input.cwd, SESSION_KIND);
        activeSessionId = null;
        if (attempt < MAX_RETRIES) continue;
      }
      if (attempt === MAX_RETRIES) {
        // All retries failed — return neutral
        return neutralResult('retry_exhausted');
      }
    }
  }

  return neutralResult('retry_exhausted');
}

// Test-only injection point for the Agent SDK `query` function. Callers should
// use `__testing.setQueryFn(fn)` to install, and `setQueryFn(null)` to reset.
let __injectedQueryFn: typeof import('@anthropic-ai/claude-agent-sdk').query | null = null;
export const __testing = {
  setQueryFn(fn: typeof import('@anthropic-ai/claude-agent-sdk').query | null): void {
    __injectedQueryFn = fn;
  },
};
