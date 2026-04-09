# Subdomain: DB/ORM-Drizzle (Using Drizzle ORM)

## Core Principles
- Define schemas with `pgTable`/`sqliteTable`/`mysqlTable` functions and manage them in separate files
- `drizzle-kit push` is for development; `generate` + `migrate` is the production migration workflow
- Use prepared statements to eliminate parsing overhead for frequently executed queries — `db.select().prepare()`
- Relation queries (`with`) are Drizzle's type-safe JOIN abstraction — minimize mixing with `sql` tags

## Cautions
- Mixing adapters like `drizzle-orm/pg-core` and `drizzle-orm/sqlite-core` causes type mismatches
- Enforce `drizzle-kit generate` in CI after changes to `schema.ts` — prevent schema drift
- Use `sql.placeholder()` for parameterized binding in `sql` tag raw queries — prevent XSS/SQL injection
- `with` relation queries JOIN N tables, so include only the necessary depth

## Verification Points
- Are migration files synchronized with the schema definition? (`drizzle-kit check`)
- Are prepared statements applied on hot paths to reduce query parsing cost?
- Do relation definitions (`relations()`) match the actual foreign key columns?
- Is type inference correctly applied to query results, allowing usage without runtime casting?
