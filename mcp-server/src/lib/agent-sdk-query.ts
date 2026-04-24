/**
 * Generic cached-query runner for Claude Agent SDK calls (P2-7).
 *
 * Centralizes the session-lookup / resume / persist / 404-recover loop that
 * was previously duplicated across `llm-scorer.ts`, `feature-classifier.ts`,
 * and `e2e-diagnoser.ts`. Each caller supplies a `kind` string so the global
 * session cache (`~/.mpl/cache/sessions.json`) can segregate sessions by
 * (cwd, kind) without collisions.
 *
 * Behavior:
 *   1. Try to resolve the SDK `query` function. If unavailable (no SDK
 *      installed, import failed), return `{ degraded: true, reason: 'sdk_unavailable' }`.
 *   2. Look up a cached session id (kind-scoped, content-hashed, TTL-bound).
 *   3. Loop up to MAX_RETRIES with the resumed session id:
 *      - Capture response text + any new session id from SDK events.
 *      - On `SDKResultError` with a session-expired signature → invalidate
 *        cache, drop the resume id, retry without sessionId.
 *      - On thrown error with 404 / session-expired signature → same.
 *      - On success: persist the observed session id, return parsed result.
 *   4. If all retries fail, return `{ degraded: true, reason: 'retry_exhausted' }`.
 *
 * Testing: `__testing.setQueryFn(fn | null)` overrides the SDK import so
 * integration tests can inject deterministic event scripts without touching
 * node_modules.
 */

import {
  computeContentHash,
  invalidateSession,
  lookupSession,
  persistSession,
} from './session-cache.js';

const MAX_RETRIES = 2;

/**
 * Detect Anthropic API responses that indicate the resumed session id is no
 * longer valid (expired / purged / never-existed). The Agent SDK does not
 * expose typed errors, so we match on the small set of signatures Anthropic
 * emits: HTTP 404, "session not found" / "not_found_error" textual
 * fragments, or our SDK's own "Session ... not found" wrapper message.
 *
 * Moved from llm-scorer.ts in P2-7 so all cached-query callers share the
 * same detector (false positives are non-fatal — they trigger a cache
 * invalidation and a fresh-session retry).
 */
export function isSessionExpiredError(err: unknown): boolean {
  if (err === null || err === undefined) return false;

  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number' && status === 404) return true;

  const parts: string[] = [];
  if (err instanceof Error) {
    if (err.message) parts.push(err.message);
    if ((err as { name?: string }).name) parts.push((err as { name: string }).name);
  } else if (typeof err === 'string') {
    parts.push(err);
  } else {
    try { parts.push(JSON.stringify(err)); } catch { parts.push(String(err)); }
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

export interface CachedQueryInput {
  /** Project root — keys the session cache entry. */
  cwd: string;
  /** Session cache bucket (e.g. `'ambiguity'`, `'classify_scope'`, `'e2e_diagnose'`). */
  kind: string;
  /** Pipeline id for cache-entry validation (fresh pipeline ⇒ fresh session). */
  pipeline_id: string;
  /**
   * Deterministic hash input for cache-entry validation. Typically the stable
   * prefix of the prompt (system prompt + shared context). Dynamic per-call
   * inputs (e.g. accumulated user responses) MUST NOT be included — otherwise
   * the hash changes every round and the cache never hits.
   */
  cache_input: string;
  /** System prompt passed to the SDK. */
  system_prompt: string;
  /** Full user prompt (including per-call variable content). */
  full_prompt: string;
  /** SDK model id — defaults to `'opus'`. */
  model?: string;
}

export interface CachedQueryOk<T> {
  ok: true;
  value: T;
  session_id: string | null;
}

export interface CachedQueryDegraded {
  ok: false;
  degraded: true;
  reason: 'sdk_unavailable' | 'retry_exhausted' | 'parse_failed';
}

export type CachedQueryResult<T> = CachedQueryOk<T> | CachedQueryDegraded;

/**
 * Run a single-turn Agent SDK query with session caching + session-expired
 * recovery. `parse` converts the raw response text into the caller's result
 * type; returning `null` triggers a retry (up to MAX_RETRIES) and finally a
 * `parse_failed` degraded result.
 */
export async function runCachedQuery<T>(
  input: CachedQueryInput,
  parse: (text: string) => T | null,
): Promise<CachedQueryResult<T>> {
  let queryFn: typeof import('@anthropic-ai/claude-agent-sdk').query | null = __injectedQueryFn;
  if (!queryFn) {
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      queryFn = sdk.query;
    } catch {
      return { ok: false, degraded: true, reason: 'sdk_unavailable' };
    }
  }

  const contentHash = computeContentHash(input.cache_input);
  let activeSessionId: string | null = lookupSession({
    cwd: input.cwd,
    kind: input.kind,
    pipeline_id: input.pipeline_id,
    content_hash: contentHash,
  });

  let parseFailedOnce = false;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const queryOptions: Record<string, unknown> = {
        model: input.model ?? 'opus',
        maxTurns: 1,
        systemPrompt: input.system_prompt,
        allowedTools: [],
      };
      if (activeSessionId) queryOptions.sessionId = activeSessionId;

      const q = queryFn({ prompt: input.full_prompt, options: queryOptions });

      let responseText = '';
      let observedSessionId: string | null = null;
      let resultErrorText: string | null = null;

      for await (const event of q) {
        if (event.type === 'result' && event.subtype === 'success') {
          responseText = (event as { result: string }).result;
          const sid = (event as { sessionId?: string }).sessionId;
          if (sid) observedSessionId = sid;
        } else if (event.type === 'result' && 'is_error' in event && (event as { is_error?: boolean }).is_error) {
          const errs = (event as { errors?: unknown }).errors;
          if (Array.isArray(errs)) resultErrorText = errs.map((e) => String(e)).join(' | ');
          else if (typeof errs === 'string') resultErrorText = errs;
        } else if (event.type === 'assistant') {
          const msg = event.message as { content?: Array<{ type: string; text?: string }> };
          if (msg.content) {
            for (const block of msg.content) {
              if (block.type === 'text' && block.text) responseText += block.text;
            }
          }
        } else if ((event as { sessionId?: string }).sessionId) {
          const sid = (event as { sessionId?: string }).sessionId;
          if (sid) observedSessionId = sid;
        }
      }

      if (resultErrorText && activeSessionId && isSessionExpiredError(resultErrorText)) {
        invalidateSession(input.cwd, input.kind);
        activeSessionId = null;
        continue;
      }

      const parsed = parse(responseText);
      if (parsed !== null) {
        if (observedSessionId) {
          persistSession({
            cwd: input.cwd,
            kind: input.kind,
            pipeline_id: input.pipeline_id,
            content_hash: contentHash,
            session_id: observedSessionId,
          });
        }
        return { ok: true, value: parsed, session_id: observedSessionId };
      }

      parseFailedOnce = true;
      // fall through to next attempt
    } catch (error) {
      if (activeSessionId && isSessionExpiredError(error)) {
        invalidateSession(input.cwd, input.kind);
        activeSessionId = null;
        if (attempt < MAX_RETRIES) continue;
      }
      if (attempt === MAX_RETRIES) {
        return { ok: false, degraded: true, reason: 'retry_exhausted' };
      }
    }
  }

  return {
    ok: false,
    degraded: true,
    reason: parseFailedOnce ? 'parse_failed' : 'retry_exhausted',
  };
}

// Test-only SDK injection hook. Mirrors the one in llm-scorer.ts so existing
// tests keep working; new callers can inject through either module.
let __injectedQueryFn: typeof import('@anthropic-ai/claude-agent-sdk').query | null = null;
export const __testing = {
  setQueryFn(fn: typeof import('@anthropic-ai/claude-agent-sdk').query | null): void {
    __injectedQueryFn = fn;
  },
};
