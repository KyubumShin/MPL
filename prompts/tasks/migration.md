# Task Type: Migration

## Core Principles
- Establish and document a rollback strategy before starting work
- Maintain backward compatibility: explicitly define the coexistence period for old/new systems
- Separate data migration and code migration into distinct stages
- Incremental transition: proceed in stages rather than replacing everything at once
- Define success criteria for each stage before moving to the next

## Cautions
- Old system removal is a separate task performed after confirming new system stability
- Run a dry-run first for any transformation with potential data loss
- Identify all external system dependencies (clients, partner APIs) upfront
- Explicitly define a dual-write or forwarding strategy during the old/new coexistence period

## Verification Points
- Does the rollback procedure actually work?
- Do existing features operate correctly after migration?
- Are the core features of the new system verified?
- Is data integrity maintained?
