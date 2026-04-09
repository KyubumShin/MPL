# Task Type: Performance (Improvement)

## Core Principles
- Profile first: do not decide on optimization targets by guessing
- Before/after benchmark measurements are required (prove improvement with numbers)
- Optimize only the hot path (actual bottleneck), not the entire codebase
- Explicitly document the trade-off between readability and performance
- Explain with comments why optimization increases complexity

## Cautions
- No code changes based on "this might be faster" without measurement
- When introducing caching, define the invalidation strategy and memory limit together
- Concurrency optimization carries race condition risk — approach with caution
- Maintain existing tests to ensure performance improvements do not cause functional regressions

## Verification Points
- Is a measurable improvement (in numbers) confirmed?
- Do all existing tests pass?
- Is readability maintained within acceptable bounds?
- Does the improved metric meet the target requirements?
