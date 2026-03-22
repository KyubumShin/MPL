# Subdomain: API/GraphQL (GraphQL API Development)

## Core Principles
- Schema-first design: define types and contracts in SDL before implementing resolvers
- Solve N+1 problems with DataLoader — prohibit direct DB queries in list resolvers
- Wrap mutation arguments in Input types to ensure reusability and validation consistency
- Use Subscriptions only when real-time requirements genuinely exist — avoid when polling or ISR is sufficient

## Cautions
- Design Nullable fields carefully — overusing `!` reduces schema evolution flexibility
- Do not repeat duplicate field selections without fragments — hurts client query maintainability
- Do not implement business logic directly in resolvers — delegate to the service/domain layer
- Centralize auth/authorization with directives or shield middleware rather than handling it per resolver

## Verification Points
- Does DataLoader batch requests within the same request into a single DB query?
- Do error responses follow the standard `errors` array format and avoid exposing sensitive data?
- Are maximum nesting depth and complexity limits set for nested resolvers?
- Do schema changes maintain backward compatibility with existing queries?
