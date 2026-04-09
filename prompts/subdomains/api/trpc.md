# Subdomain: API/tRPC (tRPC Type-Safe API)

## Core Principles
- Split routers by domain and compose them into the root router with `mergeRouters`
- Context should include only request-scoped dependencies: auth info, DB client, session, etc.
- Separate cross-cutting concerns (auth, logging, rate-limiting) from procedures via middleware chains
- Extract client type inference using `RouterOutputs`/`RouterInputs` utilities and share them

## Cautions
- When mixing `publicProcedure` and `protectedProcedure`, apply lint rules to prevent accidentally exposing protected endpoints
- Input validation via Zod schema is mandatory — missing runtime validation cannot guarantee type safety
- Subscriptions must return an `observable` and must handle unsubscribe cleanup
- Use `inferAsyncReturnType` only for context type inference — avoid excessive type manipulation

## Verification Points
- When calling procedures from the client, does type inference and auto-completion work without type errors?
- Are middleware errors returned as `TRPCError` with appropriate codes?
- Do Input Zod schemas reflect actual business constraints (max length, allowed value ranges, etc.)?
- Do all procedures requiring authentication use `protectedProcedure` as their base?
