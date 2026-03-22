# Subdomain: DB/ORM-Prisma (Using Prisma ORM)

## Core Principles
- Clearly distinguish `include` (full relation) from `select` (only needed fields) when loading relations
- Use `prisma migrate dev` for development migrations and `prisma migrate deploy` for production
- Handle cross-cutting logic such as soft deletes, audit logs, and timestamp automation via Prisma middleware
- Explicitly configure `connection_limit` to suit serverless/container environments

## Cautions
- N+1 queries: use `findMany` + `where: { id: { in: ids } }` instead of calling `findUnique` inside a loop
- Parameterized binding is mandatory for `raw` queries — string interpolation risks SQL injection
- Missing `prisma generate` causes type mismatch with the schema — automate this in CI
- Use `createMany`/`updateMany` for bulk data operations — avoid per-record loop processing

## Verification Points
- Do relation definitions in `schema.prisma` match the actual DB foreign key constraints?
- Are only necessary fields fetched via `select` to prevent excessive data transfer?
- Are migration files committed and synchronized with the production deployment history?
- Does the connection pool handle concurrent requests without exhaustion in serverless environments?
