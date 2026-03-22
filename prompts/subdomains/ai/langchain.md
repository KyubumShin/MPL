# Subdomain: AI/LangChain (LangChain Chains and Agents)

## Core Principles
- Compose chains with the LCEL (LangChain Expression Language) pipe (`|`) — avoid using legacy `LLMChain` directly
- Explicitly constrain the tool list and stopping conditions for agent patterns — prevent infinite loops
- Connect Callback/tracer (`LangSmith`) from the development phase to gain chain execution visibility
- Combine vector stores with metadata filters in retrievers to improve search accuracy

## Cautions
- Consider the context length vs. cost tradeoff when choosing Memory types (BufferMemory vs. SummaryMemory)
- Specify `max_tokens` and timeout for each LLM call — prevent cost explosions and latency spikes
- Handling parse failures is mandatory when using `StructuredOutputParser`/`JsonOutputParser`
- Tool descriptions directly impact LLM tool selection quality during tool binding — write them clearly

## Verification Points
- Are the input/output and latency of each chain step visible in LangSmith traces?
- Does the agent terminate within the maximum iteration count (`max_iterations`)?
- Does the retriever rank relevant chunks at the top? (check MMR or score threshold settings)
- On parse error, does the retry or fallback chain activate?
