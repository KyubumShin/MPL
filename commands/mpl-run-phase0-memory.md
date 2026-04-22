---
description: MPL Phase 0 Protocol - 4-Tier Adaptive Memory
---

# MPL Phase 0: Memory Loading (F-11, F-25)

This file contains the memory loading protocols used during Phase 0 and execution:
Run-to-Run Learnings (F-11), 4-Tier Adaptive Memory (F-25), and the semantic.md-assisted
Phase 0 shortcut mechanism. F-22 Routing Pattern Matching removed in v0.17 (#60).
Load this when loading memory in Step 0 or Step 2.5.

See also: `mpl-run-phase0.md` (interview + triage), `mpl-run-phase0-analysis.md` (codebase analysis).

---

#### 0.1.5b: Load Run-to-Run Learnings (F-11)

Load accumulated learnings from past runs for Phase 0 and execution reference:

```
if exists(".mpl/memory/learnings.md"):
  learnings = Read(".mpl/memory/learnings.md")
  // Learnings are injected into Phase Runner context (Step 4.2) as supplementary reference
  // and into Phase 0 Enhanced (Step 2.5) for error spec and pattern alignment
  Announce: "[MPL] Loaded learnings from past runs."
```

#### 0.1.5c: 4-Tier Adaptive Memory Load (F-25)

At Phase 0 start, selectively load memory from previous runs.
Extends the existing single learnings.md (F-11) load to a 4-Tier structure.

##### Loading Priority and Budget

| Tier | File | Load Condition | Max Tokens | Purpose |
|------|------|----------------|-----------|---------|
| 1 | `semantic.md` | Always (if file exists) | 500 | Project knowledge, generalized rules |
| 2 | `procedural.jsonl` | Keyword matching against task description | 500 | Relevant tool patterns, failure avoidance |
| 3 | `episodic.md` | Always (if file exists) | 800 | Previous run summaries, context understanding |
| 4 | `learnings.md` (backward compat) | Only when semantic.md is absent | 500 | F-11 legacy compatibility |

Total budget: max 2000 tokens

##### Selective Loading Algorithm

```pseudocode
function load_phase0_memory(task_description):
  memory_context = ""
  remaining_budget = 2000
  semantic_loaded = false

  # Tier 1: Semantic (project knowledge — always useful)
  if exists(".mpl/memory/semantic.md"):
    semantic = read_truncated(".mpl/memory/semantic.md", 500)
    memory_context += "## Project Knowledge (semantic)\n" + semantic
    remaining_budget -= token_count(semantic)
    semantic_loaded = true

  # Tier 2: Procedural (relevant patterns only)
  if exists(".mpl/memory/procedural.jsonl"):
    keywords = extract_keywords(task_description)  # simple tokenization
    relevant = query_by_tags(procedural, keywords, limit=10)
    if relevant:
      procedural_text = format_procedural(relevant)
      memory_context += "## Relevant Tool Patterns (procedural)\n" + procedural_text
      remaining_budget -= token_count(procedural_text)

  # Tier 3: Episodic (recent run context)
  if exists(".mpl/memory/episodic.md"):
    episodic = read_recent(".mpl/memory/episodic.md", max_tokens=min(800, remaining_budget))
    memory_context += "## Previous Run Summaries (episodic)\n" + episodic

  # Backward compatibility: use existing learnings.md if no semantic
  elif exists(".mpl/memory/learnings.md") and not semantic_loaded:
    learnings = read_truncated(".mpl/memory/learnings.md", 500)
    memory_context += "## Accumulated Learnings (learnings)\n" + learnings

  return memory_context
```

```
loaded_memory = load_phase0_memory(user_request)
if loaded_memory:
  // Inject into Phase Runner context (Step 4.2) and Phase 0 Enhanced (Step 2.5)
  Announce: "[MPL] 4-Tier memory loaded. Budget used: {2000 - remaining_budget}/2000 tokens."
else:
  Announce: "[MPL] No memory files found. Proceeding without prior context."
```

##### Token Savings Measurement

**Baseline (F-11 old approach)**: Load entire learnings.md — max 2000 tokens, no selectivity.
**4-Tier (F-25 new approach)**: Selective load — semantic (relevant rules only) + procedural (matching tags only) + episodic (recent 2 Phases only).

Savings rate measurement:
- Episodic compression effect on Phase 5+ runs: 10 Phase run → 2 Phase detailed + 8 lines compressed = ~400 tokens (vs full ~2000)
- Procedural tag matching: average 5-10 matches out of 100 entries = ~200 tokens (vs full ~1500)
- Semantic generalization: ~200 tokens removed from repeated patterns (vs episodic full with repetition ~800)
- **Estimated total**: ~800 tokens / original ~2000 tokens = **60% savings** (conservative)
- Measured via profiling (Step 2.5.9) by comparing `memory_tokens_loaded` vs `legacy_learnings_tokens`

##### Integration with Phase 0 Enhanced

When Phase 0 Enhanced (Step 2.5) runs, memory is referenced as follows:
- **semantic.md "Project Conventions"** → reflected in existing conventions when generating Type Policy (Step 3)
- **procedural.jsonl api_contract_violation tag** → avoids past failure patterns when validating API Contracts (Step 1)
- **episodic.md recent Phase 0 results** → references previous run complexity when making complexity judgments

#### semantic.md-Assisted Phase 0 Shortcut Mechanism

Project knowledge accumulated in semantic.md shortens Phase 0 Enhanced steps:

| semantic.md Entry | Phase 0 Shortcut Effect | Estimated Savings |
|------------------|------------------------|------------------|
| Type rules exist in `## Project Conventions` | Step 3 (Type Policy): use existing conventions as seed, narrow analysis scope | ~30% |
| API patterns exist in `## Success Patterns` | Step 1 (API Contract): reuse existing patterns, extract only new APIs | ~20% |
| Error patterns exist in `## Failure Patterns` | Step 4 (Error Spec): supplement error spec based on past failures — no re-analysis needed | ~15% |

**Shortcut Logic**:
```pseudocode
function phase0_with_semantic(semantic_content, complexity_grade):
  # Inject seed into each Step when semantic exists
  if semantic_content.has("Project Conventions"):
    step3_type_policy.seed = semantic_content["Project Conventions"]
    step3_type_policy.scope = "incremental"  # full analysis → delta only

  if semantic_content.has("Success Patterns"):
    step1_api_contracts.known_patterns = semantic_content["Success Patterns"]
    step1_api_contracts.scope = "delta_only"  # extract only new APIs

  if semantic_content.has("Failure Patterns"):
    step4_error_spec.prior_failures = semantic_content["Failure Patterns"]
    # Past failure patterns included automatically — no re-analysis needed
```

**Measurement**: Record `semantic_seed_applied: true/false` in Phase 0 token profiling (Step 2.5.9).
Verify 20-30% shortcut by comparing Phase 0 tokens with and without semantic.md on repeated projects.

