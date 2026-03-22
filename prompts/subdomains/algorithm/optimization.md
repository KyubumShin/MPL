# Subdomain: Algorithm/Optimization (Computational Optimization Strategy)

## Core Principles
- Choose caching strategy based on data change frequency and consistency requirements: LRU (capacity limit), TTL (time expiry), Write-through (write synchronization)
- Apply memoization only to pure functions (same input → same output) — do not apply to functions with side effects
- Use lazy evaluation to defer costly operations until the result is actually needed
- Use batch processing to reduce I/O round trips and overhead compared to per-item processing

## Cautions
- Always profile to identify actual bottlenecks before optimizing — prohibit assumption-based optimization
- Without a cache invalidation strategy, stale data will be served — TTL or explicit eviction policy is required
- Space-time tradeoff: reduce computation with caching, but verify memory usage stays within acceptable bounds
- Premature optimization increases code complexity and raises maintenance cost

## Verification Points
- Have benchmark measurements before and after optimization been taken and improvements confirmed?
- Is the key design capable of achieving the target cache hit rate (generally 80% or above)?
- Is the memoization cache bounded to an appropriate size without memory leaks?
- Is the batch size set at the balance point between processing latency and throughput?
