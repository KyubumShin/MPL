# Domain: AI (LLM/AI Integration)

## Core Principles

1. **Prompt Engineering**: Separate system/user prompts, make them constants, version-control them
   - No inline prompts — manage in separate files or constants modules
   - Prompt changes go through the same review process as code changes
2. **API Key Management**: Absolutely no hardcoding, no exposure in logs
   - Use environment variables or a secrets manager
   - Verify that keys are not exposed in logs, error messages, or client bundles
3. **Structured Output**: Schema validation is required
   - LLM responses must be used only after schema validation (dual path: `.parsed` + `.text`)
   - A graceful fallback path is required on parse failure
4. **Retry / Rate Limit**: Exponential backoff + immediate failure on auth errors
   - Default: 3 retries with exponential backoff (1s, 2s, 4s)
   - Do not retry 401/403 (auth issues cannot be resolved by retrying)
   - Respect the Retry-After header for 429
5. **Model Fallback**: After 3 failures, switch to an alternative model or graceful degradation
   - Automatically switch to a secondary model on primary model failure
   - Show a clear error to the user when all models fail
6. **Cost Monitoring**: Record tokens per call
   - Log input/output token counts
   - Define per-model unit cost constants
7. **Stateful vs Stateless**: Follow the pattern confirmed in PP
   - Do not leak AI state into IPC
   - If session management is needed, use an explicit context object
8. **Input Preprocessing**: Prevent token waste
   - Remove HTML tags, clean up unnecessary whitespace
   - Mask personally identifiable information (PII)
   - Pre-calculate token count to prevent context window overflow

## Anti-Patterns (Must Avoid)

| # | Anti-Pattern | Correct Pattern |
|---|-------------|----------------|
| 1 | Hardcoded API key | Environment variable / secrets manager |
| 2 | Single call with no retry | 3x exponential backoff |
| 3 | Parsing `.text` only (regex) | Structured output schema + `.parsed` |
| 4 | Inline prompt string | Separate prompt module/file |
| 5 | Infinite retry loop | Max retries + fallback + error propagation |
| 6 | Storing LLM response without validation | Store after schema validation |
| 7 | Synchronous blocking LLM call | Async + timeout configured |

## AI Complexity Two-Dimensional Assessment

AI Phases are assessed with the following two dimensions in addition to general complexity:

| Model Tier × State | stateless | session | persistent |
|--------------------|-----------|---------|------------|
| simple (single call) | **S** | M | M |
| composite (chaining) | M | **L** | L |
| orchestrated (LangGraph, etc.) | L | L | **L+opus** |

## Verification Points

- Is the API key not exposed in code, logs, or bundles?
- Is the LLM response validated against a structured output schema?
- Does the retry logic follow exponential backoff?
- Does it fail immediately on auth errors (401/403)?
- Does a fallback path exist and is it tested?
- Is the prompt separated into a dedicated module?
- Is token usage being logged?
