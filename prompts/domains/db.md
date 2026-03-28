# Domain: DB (Database)

## Core Principles
- Migrations must always be reversible (up + down)
- Index additions must consider data size and query patterns
- Schema changes must maintain backward compatibility with existing data
- Do not mix ORM and raw SQL

## Cautions
- DROP TABLE/COLUMN is irreversible — isolate into a separate Phase or use soft delete
- Changing NULL → NOT NULL requires migrating existing data first
- Verify existing data integrity before adding foreign key constraints
- Minimize transaction scope and review for deadlock potential
- **(PR-01, v0.9.0)** A function with 2+ DB mutation operations (INSERT/UPDATE/DELETE) MUST wrap them in a transaction (BEGIN/COMMIT, .transaction(), or ORM equivalent). Partial failures without transaction wrapping cause data integrity corruption.

## Verification Points
- Do both migration up and down succeed?
- Is it compatible with existing seed/fixture data?
- Are indexes appropriate for the primary query patterns?
- Is there no data loss on rollback?
