# Task Type: Greenfield (New Creation)

## Core Principles
- Structure design first: finalize file/directory layout before implementing logic
- Consider extensibility but prohibit over-engineering beyond current requirements
- Follow the existing project's naming conventions, file structure, and patterns exactly
- Complete scaffolding first, then fill in logic in order
- When adding dependencies, first verify consistency with the existing stack

## Cautions
- Do not introduce new patterns without understanding existing codebase conventions
- Do not design with the assumption of "we'll refactor later"
- Interfaces/abstractions are introduced only when actually needed
- Include environment configuration, error handling, and logging from the start (no afterthoughts)

## Verification Points
- Is there consistency with the existing code's naming and structural conventions?
- Does the build pass?
- Are there tests that verify basic behavior?
- Can the newly added files/modules be referenced from existing entry points?
