# Domain: Algorithm (Complex Logic)

## Core Principles
- Explicitly analyze time and space complexity
- Systematically enumerate edge cases (empty input, single element, max value, negatives)
- Document invariants as inline code comments
- Performance-critical paths must include benchmark tests

## Cautions
- No premature optimization — correctness first, then performance
- Review recursion for stack overflow risk (depth limit or iterative conversion)
- Use epsilon for floating-point comparisons
- Review for race conditions in concurrent/parallel processing

## Verification Points
- Are there tests for all edge cases?
- Do time and space complexity meet the requirements?
- Does it operate without timeout on large inputs?
- Is mathematical correctness verified?
