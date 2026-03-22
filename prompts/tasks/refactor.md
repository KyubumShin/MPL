# Task Type: Refactor

## Core Principles
- Preserving existing behavior is the top priority: check test coverage before making changes
- Incremental changes: perform only one transformation at a time (rename, extract, move, etc.)
- Commit at each step while keeping tests passing
- Prefer IDE refactoring tools (rename, extract, inline) over manual editing
- Clearly bound the scope: do not touch adjacent code that was not requested

## Cautions
- Do not mix functional changes and refactoring in the same commit
- Code without tests must have tests added before refactoring
- Changes to public APIs (function signatures, interfaces) require a breaking change review
- Do not refactor for performance improvement (create a separate task)

## Verification Points
- Do 100% of existing tests pass?
- Is external behavior (inputs/outputs, side effects) unchanged?
- Do builds and tests pass at each intermediate commit?
- Is code complexity or readability genuinely improved?
