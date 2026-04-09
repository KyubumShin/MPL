# Subdomain: DB/NoSQL (Document-Oriented Database)

## Core Principles
- Design schemas around data access patterns — do not apply relational normalization principles directly
- Embed data that is frequently read together; reference entities that are managed independently
- Design with eventual consistency in mind — adjust read preference when immediate consistency after reads is required
- Use TTL indexes for automatic cleanup of expired data — minimize reliance on application-level deletion logic

## Cautions
- Be careful not to exceed document size limits (e.g., MongoDB 16MB) — prohibit embedding unbounded arrays
- Measure the performance cost of multi-stage `$lookup` in aggregation pipelines
- Queries without indexes cause full collection scans — analyze with `explain()` before designing compound indexes
- Distributed transactions (multi-document) carry significant performance costs — consider resolving with single-document atomicity

## Verification Points
- Are indexes defined for all major query patterns?
- Is the structure of embedded arrays designed to not grow unboundedly?
- Does the aggregation pipeline place `$match`/`$project` early to reduce processing volume?
- Does a TTL index or explicit cleanup logic manage stale data?
