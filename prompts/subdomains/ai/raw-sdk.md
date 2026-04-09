# Subdomain: AI/Raw-SDK (Using Anthropic/OpenAI SDK Directly)

## Core Principles
- Understand and correctly construct the Messages API structure (`role`, `content`, `tool_use`, `tool_result`)
- Parse streaming responses by event type (`content_block_delta`, `message_stop`, etc.) for processing
- Tool use flow: assistant's `tool_use` block → user message containing `tool_result` → re-invoke
- Estimate token counts using tiktoken or the SDK's `countTokens` to prevent context window overflow

## Cautions
- Manage API keys via environment variables — prohibit hardcoding in code or including in client bundles
- Implement exponential backoff retry logic for rate limits (429) and server errors (5xx)
- When `stop_reason: "max_tokens"` truncates a response, handle incomplete JSON/code safely
- When using the Batch API, handle request ID-to-result mapping and partial failure scenarios

## Verification Points
- Is the message array structure maintained correctly in multi-turn conversations that include tool use?
- Is partial response handled safely when streaming is interrupted (connection error, timeout)?
- When token count exceeds 80% of the context window limit, does context compression or summarization execute?
- Is the `usage` field of API responses logged for cost monitoring?
