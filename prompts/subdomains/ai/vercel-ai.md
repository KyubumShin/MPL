# Subdomain: AI/Vercel-AI (Using Vercel AI SDK)

## Core Principles
- Use `useChat`/`useCompletion` hooks on the client and separate server logic into Route Handlers or Server Actions
- Leverage provider abstraction of `streamText`/`generateText` — minimize code changes when switching models
- Define tool calling parameters with Zod schemas to ensure type safety
- Use `createStreamableUI` from `ai/rsc` for progressive rendering with RSC (React Server Components) streaming

## Cautions
- Missing `onFinish`/`onError` handlers in `useChat` leaves error states invisible to users
- Handling streaming response aborts requires both providing a `stop()` function and handling `AbortSignal` on the server
- Watch for state management complexity in multi-turn tool calling flows where tool results are passed back to the LLM
- There is no automatic truncation when exceeding per-model context window limits — message length management is required

## Verification Points
- Does the client display an appropriate error message when a connection drops during streaming?
- In the tool calling flow, does the LLM receive the tool result and generate a final response?
- Does the system work identically when switching between different providers (Anthropic, OpenAI, Gemini)?
- Are server component errors captured by `ErrorBoundary` in RSC streaming?
