# Phase 3: Automation - Automation and Optimization Design

> **Implementation Status**: 2 of 4 complete, 2 not yet implemented.
> - ✓ **Token Profiling**: v3.0 implementation complete (`mpl-run.md` Step 2.5.9, 4.3, 5.4)
> - ✓ **Phase 0 Caching**: v3.0 implementation complete (`mpl-run.md` Step 2.5.0, 2.5.8)
> - ✓ **Auto API Extraction (AST Parser)**: Implementation complete — `hooks/lib/mpl-test-analyzer.mjs`
> - ✓ **Auto Pattern Analysis (Pattern Detector)**: Implementation complete — `hooks/lib/mpl-pattern-detector.mjs`

## Goal

Automate the patterns established in Phase 1 (Foundation) and Phase 2 (Incremental) to generate Phase 0 artifacts without human intervention and optimize token usage.

---

## Automation Areas

### 1. Automatic Test File Parsing → Auto API Contract Extraction

> **Not yet implemented** — preserving design content. In the current v3.0, the orchestrator manually analyzes using built-in tools such as `ast_grep_search`, `lsp_document_symbols`, and `lsp_hover` (Step 2.5.2). Automation would replace this process with a coded `TestAnalyzer` class.

Automates the bytecode/source analysis that was performed manually in Exp 1.

#### Design

```
Test file input
      │
      ▼
┌──────────────┐
│ AST Parser   │──→ Extract function calls
│              │──→ Extract parameter order
│              │──→ Extract exception types
│              │──→ Extract return value patterns
└──────────────┘
      │
      ▼
phase0-api-contracts.md (auto-generated)
```

#### Extraction Targets

| Pattern | AST Node | Extracted Info |
|------|----------|----------|
| Function calls | `ast.Call` | Function name, argument count, keyword arguments |
| pytest.raises | `ast.With` + `pytest.raises` | Exception type, match pattern |
| assert statements | `ast.Assert` | Expected value, comparison operator |
| fixture usage | `ast.FunctionDef` (parameters) | Fixture name, dependencies |
| Type checks | `isinstance` calls | Expected type |

#### Implementation Plan

```python
class TestAnalyzer:
    """Automatically extracts API contracts from test files."""

    def analyze_file(self, test_file: str) -> APIContracts:
        """Analyze a single test file"""

    def analyze_directory(self, test_dir: str) -> List[APIContracts]:
        """Analyze an entire test directory"""

    def generate_contracts_md(self, contracts: List[APIContracts]) -> str:
        """Auto-generate API contract documentation"""
```

#### Experimental Rationale

Manual bytecode analysis in Exp 1 took 45 minutes. Automation can reduce this to a few seconds. In particular, automatic extraction of the following patterns provides the greatest value:
- **Parameter order**: `get_ready_tasks(completed, failed, config)` - took 20 minutes to discover manually
- **Exception type mapping**: `pytest.raises(ValueError, match=r'[Cc]ycl')` - automating pattern matching
- **Default value extraction**: Automatically collecting default values from fixture definitions

---

### 2. Auto Pattern Analysis

> **Not yet implemented** — preserving design content. In the current v3.0, the orchestrator manually extracts and classifies patterns in Step 2.5.3 using Grep, ast_grep_search, etc. Automation would replace this with a coded pattern detector.

Automates the example pattern analysis from Exp 3.

#### Design

```
Test file input
      │
      ▼
┌──────────────┐
│ Pattern      │──→ Creation patterns (object instantiation)
│ Detector     │──→ Validation patterns (assert statements)
│              │──→ Error patterns (pytest.raises)
│              │──→ Ordering patterns (list comparison)
│              │──→ Side effect patterns (state changes)
└──────────────┘
      │
      ▼
phase0-examples.md (auto-generated)
```

#### Auto-Classification of 7 Pattern Categories

| Category | Detection Rule | Priority |
|---------|----------|---------|
| Creation patterns | Class constructor calls | High |
| Validation patterns | assert statements + comparison operators | High |
| Error patterns | pytest.raises blocks | High |
| Ordering patterns | List/set comparison | Medium |
| Side effect patterns | State checks after assert | Medium |
| Default value patterns | fixture + default parameters | Low |
| Integration patterns | Multi-module imports | Low |

#### Experimental Rationale

In Exp 3, 7 pattern categories were documented manually. Automation would:
- Prevent pattern omissions (captures subtle patterns easily overlooked in manual analysis)
- Ensure consistent documentation format
- Auto-update when new tests are added

---

### 3. Token Usage Monitoring and Profiling

> **v3.0 implementation complete**. Implemented in `mpl-run.md` Step 2.5.9 (Phase 0 profiling), Step 4.3 (per-phase profile recording), and Step 5.4 (full profile generation).

#### v3.0 Implementation Details

**Profile storage paths**:
- Per-phase: `.mpl/mpl/profile/phases.jsonl` (append-only, JSONL)
- Full summary: `.mpl/mpl/profile/run-summary.json`

**Per-phase profile entry** (phases.jsonl):
```json
{
  "step": "phase-1",
  "name": "Phase Name",
  "pass_rate": 100,
  "micro_fixes": 0,
  "criteria_passed": "4/4",
  "estimated_tokens": { "context": 8000, "output": 2000, "total": 10000 },
  "retries": 0,
  "duration_ms": 45000
}
```

**Full run profile** (run-summary.json):
```json
{
  "run_id": "mpl-{timestamp}",
  "complexity": { "grade": "Complex", "score": 85 },
  "cache": { "phase0_hit": false, "saved_tokens": 0 },
  "phases": [
    { "id": "phase0", "tokens": 12000, "duration_ms": 15000, "cache_hit": false },
    { "id": "phase-1", "tokens": 10000, "duration_ms": 45000, "pass_rate": 100, "micro_fixes": 0 }
  ],
  "phase5_gate": { "final_pass_rate": 100, "decision": "skip", "fix_tokens": 0 },
  "totals": { "tokens": 49500, "duration_ms": 210000, "micro_fixes": 1, "retries": 0 }
}
```

#### Using Profile Data

By accumulating profile data:
1. **Learning optimal token budgets by complexity**: Derive average tokens per grade from past profiles
2. **Optimizing Phase 0 Step combinations**: Statistics on which combinations are most efficient
3. **Detecting abnormal runs**: Warning for excessive token usage (2x or more of average), excessive micro-fixes (5+ times)

#### Changes from Original Design

| Item | Original Design | v3.0 Implementation |
|------|----------|----------|
| Storage format | `run-{timestamp}.json` | `phases.jsonl` (append) + `run-summary.json` |
| Phase 0 profile | Not considered | Recorded separately in Step 2.5.9 |
| Anomaly detection | Proposal only | Implemented (2x average, 5+ micro-fix warnings) |
| Gate results included | Not considered | Recorded in `three_gate_results` of metrics.json |

---

### 4. Phase 0 Artifact Caching and Reuse

> **v3.0 implementation complete**. Implemented in `mpl-run.md` Step 2.5.0 (Cache Check) and Step 2.5.8 (Cache Save).

#### v3.0 Implementation Details

**Cache storage path**: `.mpl/cache/phase0/`

| File | Purpose |
|------|------|
| `manifest.json` | Cache metadata (key, timestamp, grade, artifact list) |
| `api-contracts.md` | Cached API contract specification |
| `examples.md` | Cached example pattern analysis |
| `type-policy.md` | Cached type policy definition |
| `error-spec.md` | Cached error handling specification |
| `summary.md` | Cached Phase 0 summary |
| `complexity-report.json` | Cached complexity report |

**Cache key generation**:
```
cache_key = sha256(JSON.stringify({
  test_files_hash:    hash(all test file contents),
  structure_hash:     hash(codebase_analysis.directories),
  deps_hash:          hash(codebase_analysis.external_deps),
  source_files_hash:  hash(source file contents related to public API)
}))
```

**Cache invalidation conditions**:

| Change | Cache Behavior |
|----------|----------|
| Test file content changed | Full cache invalidation |
| Source file public API changed | Full cache invalidation |
| Dependency version changed | Invalidate only related contracts |
| Directory structure changed | Invalidate only structure-related cache |
| `--no-cache` flag | Force ignore cache |

**Cache hit effect**:
- Skip entire Phase 0: saves 8~25K tokens
- Reports: `[MPL] Phase 0 cache HIT. Skipping analysis. Saved ~{budget}K tokens.`

#### Changes from Original Design

| Item | Original Design | v3.0 Implementation |
|------|----------|----------|
| Cache key | test_files + structure + deps | + source_files_hash (public API) |
| Storage path | Not specified | `.mpl/cache/phase0/` |
| manifest | None | manifest.json (metadata) |
| CI/CD integration | Proposal only | Possible via cache directory |

---

## Remaining Automation Work

Remaining work for the 2 items not yet implemented in v3.0:

### Auto API Extraction (AST Parser)

| Item | Status | Notes |
|------|------|------|
| `TestAnalyzer` class implementation | Complete | `hooks/lib/mpl-test-analyzer.mjs` |
| Function call extraction | Complete | `ast.Call` node analysis |
| pytest.raises extraction | Complete | Exception type + match pattern |
| assert statement analysis | Complete | Expected value, comparison operator |
| Integration testing | Complete | Verified against existing Step 2.5.2 results |

**Implementation location**: `hooks/lib/mpl-test-analyzer.mjs` (v3.0 implementation complete, see status section at top).

### Auto Pattern Analysis (Pattern Detector)

| Item | Status | Notes |
|------|------|------|
| Pattern detector class implementation | Complete | `hooks/lib/mpl-pattern-detector.mjs` |
| Creation/validation/error patterns | Complete | High priority |
| Ordering/side effect patterns | Complete | Medium priority |
| Default value/integration patterns | Complete | Low priority |

**Implementation location**: `hooks/lib/mpl-pattern-detector.mjs` (v3.0 implementation complete, see status section at top).

---

## Implementation Priority — Updated

| Priority | Feature | Expected Effect | Difficulty | Status |
|---------|------|----------|--------|------|
| P0 | Auto error spec generation | High | Low | ✓ Implemented in Phase 1 |
| P0 | Token profiling | High | Low | ✓ **v3.0 implementation complete** |
| P1 | Auto API contract extraction | High | Medium | ✗ Not implemented |
| P1 | Auto pattern analysis | Medium | Medium | ✗ Not implemented |
| P2 | Cache system | Medium | High | ✓ **v3.0 implementation complete** |
| P2 | Auto complexity detection | Medium | Medium | ✓ Implemented in Phase 1 |

## Expected Effect Summary — Achievement Status

| Metric | Manual (v1.0) | Automated (target) | v3.0 Achievement |
|------|-----------|-------------|----------|
| Phase 0 duration | 45~60 min | 5~10 sec | Orchestrator tool-based (minutes), ~0 on cache hit |
| Pattern miss rate | 10~20% | <2% | Agent-based analysis (improved over manual) |
| Token visibility | None | Real-time profile | ✓ phases.jsonl + run-summary.json |
| Repeated run cost | Same | ~0 (cache hit) | ✓ Phase 0 caching implemented |
| Complexity assessment | Subjective | Objective score | ✓ 4-grade complexity detector |
