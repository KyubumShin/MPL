# Phase 1: Foundation - Phase 0 Enhanced Design

> **Implementation Status**: Fully implemented in v3.0. The complexity-adaptive 4-step Phase 0 Enhanced is integrated into Step 2.5 of `mpl-run.md`. v3.0 additionally introduced artifact validation checklists, Phase 0 summary generation, and caching (`Phase 3`).

## Goal

Expand Phase 0 from ~5K tokens to 8~25K tokens to secure all required specifications upfront before implementation. Introduce a strategy to adaptively adjust the token budget based on complexity.

## Complexity-Adaptive Strategy

Automatically adjust the depth of Phase 0 based on project complexity. Implemented in v3.0 and automatically determined in Step 2.5.1 (Complexity Detection):

| Complexity Grade | Score Range | Phase 0 Configuration | Token Budget |
|------------|----------|-------------|----------|
| Simple | 0~29 | Step 4 only (Error Spec) | ~8K |
| Medium | 30~79 | Step 2 + Step 4 | ~12K |
| Complex | 80~149 | Step 1 + Step 3 + Step 4 | ~18K |
| Enterprise | 150+ | Step 1 + Step 2 + Step 3 + Step 4 | ~25K |

> **Note (v3.1):** The 4-grade system was simplified to 3 grades (Simple/Medium/Complex) in v3.1. Enterprise was merged into Complex. The current formula is `(module count × 10) + (external dependencies × 5) + (test files × 3)`. This document is preserved as initial design history.

### Complexity Assessment Criteria

Implemented in v3.0 using the following formula:

```
complexity_score = (module count × 10) + (external dependency count × 5) + (test file count × 2) + (async function count × 8)
```

| Score Range | Grade |
|----------|------|
| 0~29 | Simple |
| 30~79 | Medium |
| 80~149 | Complex |
| 150+ | Enterprise |

Artifact: `.mpl/mpl/phase0/complexity-report.json`

## Phase 0 4-Step Process

### ✓ Step 1: API Contract Extraction (Based on Exp 1) - ~5K tokens

> Implemented: `mpl-run.md` Step 2.5.2

**Applicable condition**: Complex or above

**Artifact**: `.mpl/mpl/phase0/api-contracts.md` (cache: `.mpl/cache/phase0/api-contracts.md`)

**Execution method** (v3.0): Orchestrator analyzes directly using tools:
1. Extract function/method definitions with `ast_grep_search`
2. Extract call patterns from tests with `ast_grep_search` (parameter order, type inference)
3. Map exception types with `ast_grep_search` (raise/pytest.raises/throw)
4. Confirm ambiguous signatures with `lsp_hover`

**Artifact template**:
```markdown
# API Contract Specification

## [Module Name]

### [Function Name]
- Signature: `function_name(param1: Type1, param2: Type2) -> ReturnType`
- Parameter order: [importance indicated]
- Exceptions: [condition] → [exception type]("message pattern")
- Return value: [description]
- Side effects: [describe if any]
```

**Experimental rationale**: In Exp 1, bytecode analysis discovered the parameter order of `get_ready_tasks`, which was the key factor in passing tests.

### ✓ Step 2: Example Pattern Analysis (Based on Exp 3) - ~4K tokens

> Implemented: `mpl-run.md` Step 2.5.3

**Applicable condition**: Medium or above

**Artifact**: `.mpl/mpl/phase0/examples.md` (cache: `.mpl/cache/phase0/examples.md`)

**Process**:
1. Extract usage patterns from sample tests
2. Classify into 7 pattern categories:
   - Creation patterns (object instantiation)
   - Validation patterns (validation calls)
   - Ordering patterns (alphabetical order, etc.)
   - Result patterns (return value structure)
   - Error patterns (exception conditions)
   - Side effect patterns (state changes)
   - Integration patterns (inter-module interactions)
3. Create default value tables
4. List edge cases

**Artifact template**:
```markdown
# Example Pattern Analysis

## Pattern 1: [Pattern Name]
### Basic Usage
[code example]

### Edge Cases
[code example]

### Default Values
| Field | Default | Notes |
|------|--------|------|
```

**Experimental rationale**: In Exp 3, concrete usage examples significantly improved implementation accuracy over abstract specifications. In particular, ordering requirements and context update asymmetry were only discoverable through examples.

### ✓ Step 3: Type Policy Definition (Based on Exp 4) - ~3K tokens

> Implemented: `mpl-run.md` Step 2.5.4

**Applicable condition**: Complex or above

**Artifact**: `.mpl/mpl/phase0/type-policy.md` (cache: `.mpl/cache/phase0/type-policy.md`)

**Process**:
1. Define type hints for all functions/methods
2. Distinguish collection types (List vs Set vs Dict)
3. Optional type rules
4. Standardize return types
5. Specify prohibited patterns (Any overuse, generic types, etc.)

**Artifact template**:
```markdown
# Type Policy

## Rules
1. Type hints required for all function parameters
2. Return types required for all functions
3. Use specific types (List, Set, Dict)
4. Express nullable with Optional[T]

## Type Reference Table
| Field/Parameter | Type | Example |
|-------------|------|------|
```

**Experimental rationale**: In Exp 4, confusion between `Set[str]` and `List[str]` was the main cause of test failures. An explicit type policy prevented this.

### ✓ Step 4: Error Specification (Based on Exp 7) - ~3K tokens

> Implemented: `mpl-run.md` Step 2.5.5

**Applicable condition**: All complexity levels (required)

**Artifact**: `.mpl/mpl/phase0/error-spec.md` (cache: `.mpl/cache/phase0/error-spec.md`)

**Process**:
1. Map standard Python exceptions (no custom exceptions)
2. Define error message patterns
3. Specify exception conditions
4. Define validation order

**Artifact template**:
```markdown
# Error Handling Specification

## [Module] Errors
- Type: [ExceptionType]
- Condition: [trigger condition]
- Message: "[pattern with {placeholder}]"

## Prohibited
- No custom exception class creation
- Use only standard Python exceptions
```

**Experimental rationale**: In Exp 7, the error specification was revealed to be the "missing puzzle piece." Adding the error specification alone caused the score to leap from 83% to 100%. This is because approximately 30% of tests verify error handling.

## Token Budget Reallocation

### v1.0 vs v3.0 Comparison

| Phase | v1.0 Tokens | v3.0 Tokens | Change |
|-------|----------|----------|------|
| Phase 0 | ~5K (6%) | 8~25K (adaptive) | Increase based on complexity |
| Phase execution | ~60K (74%) | Adaptive per phase | Optimized |
| Phase 5 | ~16K (20%) | 0K (replaced by 3-Gate) | Removed |
| **Total** | **~81K** | **Variable based on complexity** | **Optimized** |

### Saving Principle

1. **Increased Phase 0 investment** → Improved specification quality
2. **Phase execution efficiency** → Shortened implementation time with clear specs + immediate fixes with Build-Test-Fix
3. **Phase 5 removal** → Replaced by 3-Gate quality system + Fix Loop + Convergence Detection

## Implementation Milestones — Complete

### ✓ Milestone 1: Complexity Detector
- Project analysis function implementation → Orchestrator calculates directly in Step 2.5.1
- LOC, module count, dependencies, async function counting → codebase-analysis.json + ast_grep_search
- Automatic complexity grade determination → Saved to `.mpl/mpl/phase0/complexity-report.json`

### ✓ Milestone 2: Per-Step Analysis Process
- Define analysis process for each of the 4 steps → Step 2.5.2~2.5.5
- Codify combination rules per complexity → Selective step application by grade
- Artifact validation checklist → Step 2.5.7 (added in v3.0)

### ✓ Milestone 3: Phase Runner Integration
- Integrate Enhanced Phase 0 into existing Phase Runner → Step 4.1 Context Assembly
- Complexity-based automatic routing → Selective loading of Phase 0 artifacts
- Auto-inject artifacts into subsequent Phase context → load_phase0_artifacts()

## v3.0 Additional Features

Features not included in roadmap Phase 1 but added in v3.0:

- **Artifact validation checklist** (Step 2.5.7): Validates that each Step's artifacts contain required sections
- **Phase 0 summary generation** (Step 2.5.6): Generates a summary document consolidating all artifacts
- **Caching** (Step 2.5.0, 2.5.8): Caches Phase 0 artifacts in `.mpl/cache/phase0/` to save 8~25K tokens on repeated runs
- **Token profiling** (Step 2.5.9): Records Phase 0 token usage in the profile

## Expected Effects → Achievement Confirmation

- **Token savings**: Overall savings relative to Phase 0 investment → ✓ Confirmed by Phase 5 removal
- **Pass rate improvement**: 95%+ required in 3-Gate system → ✓ Implemented
- **Debugging elimination**: Immediate fixes with Build-Test-Fix → ✓ Maximum 2 retries per TODO
- **Consistency**: Stable quality regardless of complexity → ✓ 4-grade adaptive Phase 0
