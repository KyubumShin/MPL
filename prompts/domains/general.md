# Domain: General

## Core Principles
- Follow existing project conventions as the top priority
- Single responsibility principle — one function/module has one role
- Clear naming — use variable/function names that reveal intent
- Minimize the scope of changes and clearly understand the impact area

## Cautions
- No over-abstraction — do not add layers that are not immediately needed
- Functions with side effects must be explicitly marked
- Magic numbers/strings should be extracted as constants
- Changes that break existing tests must be intentional

## Verification Points
- Do all existing tests pass?
- Does the change align with project conventions?
- Have no unnecessary dependencies been added?
- Is the code self-documenting?
