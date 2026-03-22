---
description: MPL Phase 0 Protocol - Triage, PP Interview, Gap/Tradeoff Analysis, Codebase Analysis, Phase 0 Enhanced
---

# MPL Phase 0: Pre-Execution Analysis

This file contains Steps 0 through 2.5 of the MPL orchestration protocol.
Load this when `current_phase` is in the pre-execution stages (before decomposition).

---

## Step -1: LSP Warm-up (Non-blocking)

At pipeline start, pre-warm the LSP server. Runs in parallel with Step 0 Triage — no delay.

```
on mpl-init:
  1. Detect project languages from file extensions:
     Glob("**/*.{ts,tsx,js,jsx,py,go,rs}")
     → language_set = detected extensions mapped to LSP servers

  2. Trigger LSP warm-up for each detected language:
     for each language in language_set:
       lsp_hover(file=first_file_of_language, line=1, character=0)
       // First call triggers LSP server initialization
       // Response is discarded — purpose is warm-up only

  3. Record active LSP servers in state:
     .mpl/mpl/state.json → lsp_servers: ["typescript", "python", ...]
```

| Language | LSP Server | Cold Start | After Warm-up |
|----------|-----------|-----------|--------------|
| TypeScript/JS | typescript-language-server | 2~5s | <100ms |
| Python | pylsp / pyright | 3~10s | <200ms |
| Go | gopls | 2~8s | <100ms |
| Rust | rust-analyzer | 5~30s | <500ms |

Available features per LSP server:

| LSP Tool | Phase 0 Usage | Execution Usage |
|----------|-------------|----------------|
| `lsp_hover` | Extract API signatures and type inference | Validate Worker result types |
| `lsp_diagnostics` | Assess existing code health | Static validation of Worker outputs |
| `lsp_find_references` | Centrality analysis (more accurate than imports) | Calculate blast radius |
| `lsp_goto_definition` | Trace dependency chains | Resolve cross-file references |
| `lsp_document_symbols` | Extract public API list | Detect interface changes |
| `lsp_rename` | - | Safe refactoring |
| `lsp_code_actions` | - | auto-import, quick-fix |

On warm-up failure (LSP server not installed): print warning and continue. Operates with ast_grep_search + Grep fallback even without LSP.

```
if lsp_hover fails for a language:
  Report: "[MPL] LSP warm-up: {language} server not available. Falling back to ast_grep + Grep."
  remove language from lsp_servers list
```

### Standalone Mode Detection (F-04)

After LSP warm-up attempts, determine tool_mode:

```
active_tools = { lsp: lsp_servers.length > 0, ast_grep: false }

// Test ast_grep availability
try:
  ast_grep_search(pattern="$X", language=detected_language)
  active_tools.ast_grep = true
catch:
  Report: "[MPL] ast_grep unavailable."

// Determine tool_mode
if active_tools.lsp AND active_tools.ast_grep:
  tool_mode = "full"
elif active_tools.lsp:
  tool_mode = "partial"  // LSP only, no ast_grep
else:
  tool_mode = "standalone"  // Grep/Glob only

writeState(cwd, { tool_mode: tool_mode })
Announce: "[MPL] Tool mode: {tool_mode}. LSP: {active_tools.lsp}, ast_grep: {active_tools.ast_grep}."
```

#### QMD Mode Detection (New)

Immediately after tool_mode detection, check QMD availability:

```pseudocode
qmd_available = check_tool_exists("qmd_search") OR check_tool_exists("qmd_deep_search")
qmd_mode = qmd_available ? "qmd_first" : "grep_only"

writeState(cwd, { qmd_mode: qmd_mode })  // persist to .mpl/state.json
profile.qmd_mode = qmd_mode               // also record in profile for metrics
```

qmd_mode is used in subsequent Scout calls and cache key generation.

All subsequent Phase 0 steps check `tool_mode` before using LSP/ast_grep tools.
If tool_mode is "standalone" or "partial", use the fallbacks defined in `docs/standalone.md`.

---

## Step 0: Triage

Triage determines two things: **pipeline_tier** (which pipeline depth to use) and **interview_depth** (how deep the PP interview goes). Pipeline tier is determined by Quick Scope Scan (F-20), replacing the previous keyword-based mode detection.

### 0.1: Quick Scope Scan + Pipeline Tier (F-20)

Perform a lightweight codebase scan (~1-2K tokens) to calculate `pipeline_score` and determine `pipeline_tier`:

```
Quick Scope Scan:
  1. Glob("**/*.{ts,tsx,js,jsx,py,go,rs,java}") → project file count
  2. Identify affected files from user prompt:
     - Extract file/module names mentioned in prompt
     - Grep for their existence → affected_files count
  3. Test existence check:
     - Glob("**/*.{test,spec}.*", "**/*_test.*", "**/test_*") → test file count
     - Estimate test_scenarios = min(affected_files × 2, test_file_count)
  4. Import depth sampling (1-hop):
     - For first 3 affected files: Grep("import|require|from", file)
     - import_depth = max import chain depth found
  5. Risk signal from prompt keywords:
     - bugfix/fix/typo → 0.1
     - add/update/field → 0.3
     - feature/implement → 0.5
     - refactor/migrate/architecture → 0.8
     - overhaul/rewrite → 0.95

pipeline_score = (file_scope × 0.35) + (test_complexity × 0.25)
               + (dependency_depth × 0.25) + (risk_signal × 0.15)

  file_scope      = min(affected_files / 10, 1.0)
  test_complexity  = min(test_scenarios / 8, 1.0)
  dependency_depth = min(import_depth / 5, 1.0)
```

#### 0.1.5a: Routing Pattern Matching (F-22)

Before finalizing tier, check past execution patterns for a similar task:

```
if exists(".mpl/memory/routing-patterns.jsonl"):
  { match, similarity, recommendation } = findSimilarPattern(cwd, user_request)
  // Uses hooks/lib/mpl-routing-patterns.mjs (Jaccard similarity, threshold 0.8)

  if recommendation:
    // Pattern match found — use as tier hint (but score can override if 2+ tiers apart)
    if |tier_from_score - recommendation| <= 1 tier:
      tier = recommendation
      source = "pattern_match"
      Announce: "[MPL] Routing pattern match: similarity={similarity}, recommending tier={recommendation}."
    else:
      // Score and pattern disagree significantly — trust score
      Announce: "[MPL] Routing pattern found (similarity={similarity}) but score disagrees. Using score-based tier."
```

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

Classify tier from score (or override with user hint):

| pipeline_tier | Score | Tier Hint | Pipeline Depth |
|---------------|-------|-----------|---------------|
| `"frugal"` | < 0.3 | `"mpl bugfix"` | Error Spec → Fix Cycle → Gate 1 → Commit |
| `"standard"` | 0.3~0.65 | `"mpl small"` | PP(light) → Error Spec → Single Phase → Gate 1 → Commit |
| `"frontier"` | > 0.65 | (none) | Full 9+ step pipeline (Steps 0~6) |

```
tier_hint = state.tier_hint  // from keyword-detector (may be null)
{ score, breakdown } = calculatePipelineScore(scan_results)
{ tier, source } = classifyTier(score, tier_hint)

Write pipeline_tier to state:
  writeState(cwd, { pipeline_tier: tier })

Announce: "[MPL] Triage: pipeline_tier={tier} (source={source}, score={score}).
           Scan: files={affected_files}, tests={test_scenarios}, depth={import_depth}, risk={risk_signal}."
```

#### Tier-Based Step Selection

After tier is determined, subsequent steps are selected per tier:

| Step | Frugal | Standard | Frontier |
|------|--------|----------|----------|
| Step 0.2 Interview Depth | light (+ Uncertainty Scan) | light | full detection |
| Step 0.5 Maturity | skip | read config | read config |
| Step 1 PP + Requirements Interview (v2) | light (Round 1+2 + Uncertainty Scan) | light (Round 1+2 + lightweight requirements) | full (4 rounds + Socratic + JUSF) |
| Step 1-B Pre-Execution | skip | skip | full |
| Step 2 Codebase Analysis | skip (use scan) | structure + tests only | full (6 modules) |
| Step 2.5 Phase 0 Enhanced | Step 4 only (Error Spec) | Step 4 only (Error Spec) | complexity-adaptive |
| Step 3 Decomposition | skip (single fix cycle) | skip (single phase) | full decomposition |
| Gates | Gate 1 only | Gate 1 only | Gate 1 + 2 + 3 |

```
if pipeline_tier == "frugal":
  -> Continue to Step 0.2 (interview_depth = "light" + Uncertainty Scan)
  -> Then Step 1 (light interview) → Step 2.5.5 (Error Spec only)
  -> Then proceed directly to Phase Execution (single fix cycle)

if pipeline_tier == "standard":
  -> Continue to Step 0.2 (interview_depth forced to "light")
  -> Then Steps 1 → 2.5.5 → Phase Execution (single phase)

if pipeline_tier == "frontier":
  -> Continue to Step 0.2 (full interview depth detection)
  -> Then full pipeline (Steps 0.5 → 1 → 1-B → 2 → 2.5 → 3 → 4 → 5)
```

### 0.1.5: RUNBOOK Initialization (F-10)

After Triage determines pipeline_tier, create the RUNBOOK:

```
Write(".mpl/mpl/RUNBOOK.md"):
  # RUNBOOK — {user_request (first 100 chars)}
  Started: {ISO timestamp}
  Pipeline Tier: {pipeline_tier} (source: {source}, score: {score})
  Maturity: (pending detection)

  ## Current Status
  - Phase: 0/? (triage complete, pre-execution)
  - State: mpl-init
  - Last Updated: {ISO timestamp}

  ## Milestone Progress
  (decomposition pending)

  ## Key Decisions
  (none yet)

  ## Known Issues
  (none yet)

  ## Blockers
  (none)

  ## Discoveries
  (none yet)

  ## How to Resume
  Load: this file
  Next: PP Interview → Codebase Analysis → Decomposition
```

### 0.2: Interview Depth

**The interview always runs.** Pre-resolving uncertainty is essential for implementing the full spec.
Skipping the interview causes CRITICAL discoveries to occur frequently during execution, slowing the pipeline through Side Interviews.

```
interview_depth = classify_prompt(user_request):
  information_density = count(explicit_constraints, specific_files, measurable_criteria, tradeoff_choices)

  if information_density >= 8 AND has_explicit_constraints AND has_success_criteria:
    -> "light" (Round 1 + Round 2 + Uncertainty Scan for HIGH items)
  elif information_density >= 4 AND has_some_constraints:
    -> "light" (Round 1 + Round 2 only)
  else:
    -> "full" (all 4 rounds)
```

> **NOTE**: The `"skip"` option has been removed. Even the most detailed prompt can contain implicit assumptions, conflicts between PPs, and spec ambiguities. These are pre-detected through a minimum light interview (Round 1+2).
> For high-density prompts (density ≥ 8), an Uncertainty Scan is run after the light interview to ask targeted questions (max 3) about HIGH uncertainty items.

| interview_depth | Condition | Interview Behavior |
|-----------------|-----------|-------------------|
| `"full"` | Vague/broad requests (density < 4) | PP 4-round full interview (default) |
| `"light"` | Specific but incomplete (density 4-7) | What + What NOT only |
| `"light"` | Very detailed with constraints (density 8+) | What + What NOT + **Uncertainty Scan** (0~3 targeted questions on HIGH items) |

Announce: `[MPL] Triage: interview_depth={depth}. Prompt density: {score}.`

---

## Step 0.5: Maturity Mode Detection

Read `.mpl/config.json` for `maturity_mode` (default: `"standard"`).

| Mode | Phase Size | PP | Discovery Handling |
|------|-----------|-----|--------------------|
| `explore` | S (1-3 TODOs) | Optional | Auto-approved |
| `standard` | M (3-5 TODOs) | Required | HITL on PP conflict |
| `strict` | L (5-7 TODOs) | Required + enforced | All changes HITL |

Announce: `[MPL] Maturity mode: {mode}. Phase sizing: {S/M/L}`

---

## Step 1: PP + Requirements Integrated Interview (mpl-interviewer v2) [F-26]

Extends the existing PP Interview to mpl-interviewer v2. Depending on interview_depth, PP discovery and requirements structuring are performed simultaneously in a single interview session.

> **Core insight**: The PP discovery process itself is a key component of requirements definition. Separating them creates double-interview fatigue.

Interview scope is automatically adjusted based on interview_depth:

### depth == "light"

```
Phase 1 (mpl-interviewer):
  Round 1 (What) + Round 2 (What NOT) + [high-density only: Uncertainty Scan]
  → Output: pivot-points.md + user_responses_summary

Stage 2 (mpl-ambiguity-resolver):
  Spec Reading → Ambiguity Scoring Loop → Requirements Structuring
  → Output: ambiguity score + requirements-light.md
```

**Phase 1 Details**:

1. **Round 1**: "What exactly do you want?" (extract PP candidates)
2. **Round 2**: "What must never be broken?" (PP constraints + scope boundaries)
3. **[High-density only] Uncertainty Scan** (only when information_density ≥ 8):
   - Run Uncertainty Scan on draft PPs extracted from Round 1-2 + full prompt
   - 3 axes × 3 = 9 dimensions + cross-axis analysis:
     [Planning] U-P1: unclear target users, U-P2: unclear core value/priorities, U-P3: no success metrics
     [Design] U-D1: no visual design system, U-D2: undefined user flows, U-D3: unclear information hierarchy
     [Development] U-E1: ambiguous judgment criteria, U-E2: implicit assumptions, U-E3: undecided technical choices
     [Cross] planning↔design, design↔development, planning↔development alignment + PP axis bias check
   - Classify: HIGH (circuit break expected) / MED (can proceed as PROVISIONAL) / LOW (naturally resolved)
   - if HIGH == 0: pass MED/LOW as uncertainty_notes to Step 1-B
   - elif HIGH >= 1: Hypothesis-as-Options questions for HIGH items (max 3)
4. PP confirmation: save pivot-points.md + generate user_responses_summary

**Stage 2 Details** (mpl-ambiguity-resolver):

1. **Spec Reading**: identify gap/conflict/hidden constraint by comparing provided spec/docs against PPs
2. **Ambiguity Scoring**: score via 4 PP-orthogonal dimensions (Spec Completeness 35%/Edge Case 25%/Technical Decision 25%/Acceptance Testability 15%)
3. **Socratic Loop**: repeat targeted Socratic questions on weakest dimension until ambiguity <= 0.2
   - Pre-Research Protocol: present comparison table first for technical choices
   - Re-measure ambiguity after each response
4. **Lightweight Requirements Structuring**:
   - User Stories + natural language AC + MoSCoW + evidence tagging
   - Save to: `.mpl/pm/requirements-light.md`

### depth == "full"

```
Phase 1 (mpl-interviewer):
  Full Round 1-4
  → Output: pivot-points.md + user_responses_summary

Stage 2 (mpl-ambiguity-resolver):
  Spec Reading → Ambiguity Scoring Loop → Solution Options → JUSF
  → Output: ambiguity score + requirements-{hash}.md
```

**Phase 1 Details**:

1. **Round 1-4**: Full existing PP interview
2. PP confirmation: save pivot-points.md + generate user_responses_summary

**Stage 2 Details** (mpl-ambiguity-resolver):

1. **Spec Reading**: identify gap/conflict/hidden constraint by comparing provided spec/docs against PPs
2. **Ambiguity Scoring**: score via 4 PP-orthogonal dimensions
3. **Socratic Loop**: repeat targeted Socratic questions on weakest dimension until ambiguity <= 0.2
   - Pre-Research Protocol: present comparison table first for technical choices
   - Re-measure ambiguity after each response
4. **Solution Options**: 3+ options + tradeoff matrix (with Pre-Research)
   - Minimal / Balanced / Comprehensive
   - User selects → record selected_option
5. **JUSF Output**: JTBD + User Stories + Gherkin AC
   - Dual-Layer: YAML frontmatter + Markdown body
   - Evidence tagging (High/Medium/Low)
   - Multi-perspective review (planning/design/development)
   - Ambiguity Resolution Log included
   - Save to: `.mpl/pm/requirements-{hash}.md`

### Routing Logic

```
if .mpl/pivot-points.md exists -> Load PPs and proceed to Step 1-B

else:
  AskUserQuestion: "Would you like to define the project's core constraints (Pivot Points)?"
  Options:
    1. "Start interview" -> Run two-phase interview (below)
    2. "Skip"            -> Proceed without PPs (explore mode only)
    3. "Load existing PPs" -> Read from .mpl/pivot-points.md

  // NOTE: "skip" branch removed. Interview always runs at minimum "light" level.
  // Even high-density prompts go through Round 1+2 interview before Uncertainty Scan.

if maturity_mode == "explore" -> PP is optional, skip if user declines

// Two-phase interview execution:
Task(subagent_type="mpl-interviewer", ...)  // Phase 1: PP Discovery
→ save pivot-points.md + user_responses_summary

Task(subagent_type="mpl-ambiguity-resolver", ...)  // Stage 2: Ambiguity Resolution + Requirements
→ save requirements-light.md or requirements-{hash}.md + ambiguity score
```

### Model Routing (F-26)

```
// Phase 1 (mpl-interviewer):
if interview_depth == "light" AND information_density >= 8:
    model = "opus"              # Round 1-2 + Uncertainty Scan (deep reasoning needed for uncertainty judgment)
elif interview_depth == "light":
    model = "sonnet"            # PP Round 1-2
elif interview_depth == "full":
    model = "opus"              # Full PP 4 Rounds

// Stage 2 (mpl-ambiguity-resolver):
if interview_depth == "light":
    model = "sonnet"            # Ambiguity Resolution Loop + lightweight requirements structuring
elif interview_depth == "full":
    model = "opus"              # Ambiguity Resolution Loop + solution options + JUSF
```

PP States: **CONFIRMED** (hard constraint, auto-reject on conflict) / **PROVISIONAL** (soft, HITL on conflict)

### Step 1 Outputs → Downstream Connections [F-26]

| Output | Consumer | Usage |
|--------|----------|-------|
| pivot-points.md | Step 1-B, Step 3 | PP compliance validation criteria |
| requirements.md (full) | Step 3 Decomposer | Execution order hints + US→Phase mapping |
| requirements-light.md (light) | Step 3 Decomposer | Lightweight scope reference |
| acceptance_criteria.gherkin | Step 3-B, Step 4 | Automatic test generation by Test Agent |
| out_of_scope | Step 1-B | Supplementing "Must NOT Do" |
| recommended_execution_order | Step 3 | Phase order seed |
| moscow + sequence_score | Step 3 Decomposer | Must-first decomposition, sorted by sequence_score |
| job_definition | Step 2.5 Phase 0 Enhanced | User context for API Contract/Type Policy |
| risks + dependencies | Step 1-B | Risk level input |

---

## Step 1-B: Pre-Execution Analysis (Gap + Tradeoff)

After PPs are confirmed, run unified pre-execution analysis to identify gaps AND assess risks in a single agent call.
This replaces the previous separate gap-analyzer (haiku) and tradeoff-analyzer (sonnet) calls.

```
Task(subagent_type="mpl-pre-execution-analyzer", model="sonnet",
     prompt="""
     ## Input
     ### User Request
     {user_request}
     ### Pivot Points
     {pivot_points from .mpl/pivot-points.md}
     ### Codebase Analysis
     {codebase_analysis from .mpl/mpl/codebase-analysis.json}
     <!-- Note: codebase-analysis.json may not exist at this point (produced in Step 2). If absent, Pre-Execution Analyzer proceeds with pivot-points and project structure only. This analysis is refined after Step 2 completes. -->

     Analyze gaps, pitfalls, and constraints (Part 1).
     Then assess risk levels and recommend execution order (Part 2).
     """)
```

### After Receiving Output
1. Validate 7 required sections via validate-output hook (4 gap + 3 tradeoff)
2. If "Recommended Questions" (section 4) has items with HIGH impact:
   - Present top 3 questions to user via AskUserQuestion
   - Incorporate answers into PP refinement if needed
3. Save full output to `.mpl/mpl/pre-execution-analysis.md`
4. Extract Part 1 (sections 1-4) as gap analysis context for decomposer
5. Extract Part 2 "Recommended Execution Order" (section 7) for decomposer in Step 3
6. Report: `[MPL] Pre-Execution Analysis: {MR_count} missing requirements, {AP_count} pitfalls, {MND_count} constraints. Aggregate risk: {level}. {irreversible_count} irreversible changes.`

---

## Step 1-D: PP Confirmation

Present a unified summary of PPs + Pre-Execution Analysis for engineer confirmation.

```
AskUserQuestion with 4 options:
1. "Approve All" -> proceed to Step 2
2. "Modify PPs" -> edit specific PPs, then re-run 1-B with updated PPs, return to 1-D
3. "Add New PP" -> add PP, then re-run 1-B, return to 1-D
4. "Re-interview" -> return to Step 1
```

This is a confirmation gate. Do not proceed to decomposition without explicit approval.
Save confirmation timestamp to `.mpl/mpl/state.json` as `pp_confirmed_at`.

---

## Step 1-E: Interview Snapshot Save (Compaction Defense) [F-36]

After Step 1 completes, back up interview results to file. Even if compaction occurs during Step 2/2.5,
the key information gathered in the interview is preserved in a file.

```
Write(".mpl/mpl/interview-snapshot.md"):
  # Interview Snapshot
  Generated: {ISO timestamp}
  Interview Depth: {interview_depth}
  Information Density: {information_density}

  ## Pivot Points Summary
  {pivot-points.md key summary — CONFIRMED/PROVISIONAL list}

  ## User Request (Original)
  {user_request verbatim}

  ## Key Decisions from Interview
  {3-5 key decisions confirmed in the interview}

  ## Requirements (if generated)
  {reference to requirements-light.md or requirements-{hash}.md path}

  ## Deferred Uncertainties
  {list if any, or "none"}

  ## Pre-Execution Analysis Summary
  {pre-execution-analysis.md key summary — risks, gaps, recommended execution order}
```

> **Purpose**: Since Step 2/2.5 runs as subagents, orchestrator context load is reduced, but compaction can occur after long interviews or complex PP discussions.
> With this snapshot, recovery is possible after compaction via `Read(".mpl/mpl/interview-snapshot.md")`.

---

## Step 2: Codebase Analysis (Subagent Delegation) [F-36]

> **v3.3 Change**: Changed from orchestrator directly analyzing 6 modules
> to delegating to `mpl-codebase-analyzer` subagent.
> Saves ~5-10K tokens from orchestrator context, preventing Plan phase compaction.

```
Task(subagent_type="mpl-codebase-analyzer", model="sonnet",
     prompt="""
     Perform full 6-module codebase analysis for MPL Phase 0.

     ## Configuration
     - Output path: .mpl/mpl/codebase-analysis.json
     - Tool mode: {tool_mode}
     - Project root: {cwd}

     ## Modules to Analyze
     1. Structure Analysis (directories, entry points, file stats)
     2. Dependency Graph (imports, external deps, module clusters)
     3. Interface Extraction (types, functions, endpoints)
     4. Centrality Analysis (high-impact vs isolated files)
     5. Test Infrastructure (framework, test files, run commands)
     6. Configuration (env vars, config files, scripts, key deps)

     Save the full JSON to .mpl/mpl/codebase-analysis.json.
     Return only a concise summary (~500 tokens).
     """)
```

#### Scout Call Branch (QMD Integration)

Branch the Scout call prompt based on qmd_mode:

**QMD-First Mode** (`qmd_mode == "qmd_first"`):
```
Task(mpl-scout, haiku, prompt="""
  Analyze the codebase in QMD-First mode.
  1. qmd_deep_search("project entry points and main modules") → identify key files
  2. qmd_deep_search("test infrastructure and framework") → understand test structure
  3. qmd_vector_search("external dependencies and integrations") → understand dependencies
  4. Cross-verify each QMD result with Grep (Search-then-Verify)
  5. Glob("**/*.{ts,tsx,py,go,rs}") → full file structure (supplement what QMD may miss)
  Output: JSON (search_mode: "qmd_first", each finding includes verification)
""")
```

**Grep-Only Mode** (`qmd_mode == "grep_only"`):
Use the existing Scout call protocol as-is.

> **Fallback:** If Scout fails QMD tool calls in QMD-First mode (MCP server unresponsive, etc.), Scout automatically falls back to Grep-Only. This is defined in mpl-scout.md's Search_Strategy.

### After Receiving Output

1. Review subagent's summary (full JSON is already saved to file)
2. Report: `[MPL] Codebase Analysis: {files} files, {modules} modules, {deps} deps. Tool mode: {tool_mode}.`
3. Proceed to Step 2.5

> **Fallback**: If mpl-codebase-analyzer agent fails, orchestrator performs analysis directly (existing behavior).
> In that case, 6 module tool calls accumulate in orchestrator context, increasing compaction risk.

### 6-Module Detailed Spec (for agent reference)

Full spec is included in agent definition (`agents/mpl-codebase-analyzer.md`).
Summary:

| Module | Tool | Output |
|--------|------|--------|
| 1. Structure | Glob | directories, entry_points, file_stats |
| 2. Dependencies | ast_grep / Grep | modules, external_deps, module_clusters |
| 3. Interfaces | lsp_document_symbols / Grep | types, functions, endpoints |
| 4. Centrality | (derived from Module 2) | high_impact, isolated |
| 5. Tests | Glob + Read | framework, run_command, test_files |
| 6. Config | Read | env_vars, config_files, scripts |

---

## Step 2.5: Phase 0 Enhanced (Subagent Delegation) [F-36]

> **v3.3 Change**: Changed from orchestrator directly measuring complexity + 4-step analysis
> to delegating to `mpl-phase0-analyzer` subagent.
> Saves ~8-25K tokens from orchestrator context, preventing Plan phase compaction.

Phase 0 Enhanced measures project complexity based on Step 2's Codebase Analysis results, and generates pre-specifications based on complexity. These specs improve the accuracy of subsequent phases (Decomposition, Execution) and make debugging phases unnecessary.

> **Principle**: "Prevention is better than cure" — tokens invested in Phase 0 completely eliminate debugging costs in Phase 5.

### Subagent Delegation

```
loaded_memory = load_phase0_memory(user_request)  // F-25 4-Tier Memory

Task(subagent_type="mpl-phase0-analyzer", model="sonnet",
     prompt="""
     Perform Phase 0 Enhanced analysis for MPL.

     ## Input
     - Codebase analysis: .mpl/mpl/codebase-analysis.json
     - Output directory: .mpl/mpl/phase0/
     - Cache directory: .mpl/cache/phase0/
     - Tool mode: {tool_mode}

     ## Context
     ### Pivot Points
     {pivot_points from .mpl/pivot-points.md}

     ### Memory (4-Tier)
     {loaded_memory}

     ## Task
     1. Check cache (full hit → skip, partial → rerun affected only)
     2. Detect complexity grade (Simple/Medium/Complex)
     3. Run analysis steps per grade
     4. Validate artifacts
     5. Save cache
     6. Return concise summary (~300 tokens)

     Save all artifacts to .mpl/mpl/phase0/.
     Return only the summary. Do NOT return full artifact content.
     """)
```

### After Receiving Output

1. Review subagent's summary (artifact files are already saved)
2. Report: `[MPL] Phase 0 Enhanced complete. Grade: {grade}. Artifacts: {count}/4. Cache: {HIT|MISS|PARTIAL}.`
3. Proceed to Step 3 (Phase Decomposition)

> **Fallback**: If mpl-phase0-analyzer agent fails, orchestrator performs analysis directly (see detailed spec below).
> In that case, tool calls accumulate in orchestrator context, increasing compaction risk.

---

### Phase 0 Enhanced Detailed Spec (for agent reference / fallback)

The spec below is embedded in `agents/mpl-phase0-analyzer.md`,
and is also the fallback protocol for the orchestrator to perform directly if the agent fails.

### 2.5.0: Cache Check (Phase 0 Caching, Extended: F-05 Partial Invalidation)

Check the cache before running Phase 0. On cache hit, skip all of Phase 0 and save 8~25K tokens.

#### Existing Behavior (Full Invalidation)

```
cache_dir = ".mpl/cache/phase0/"
cache_key = generate_cache_key(codebase_analysis)

if cache_dir exists AND cache_key matches:
  cached = Read(cache_dir + "manifest.json")
  if cached.cache_key == cache_key:
    → Load all cached artifacts to .mpl/mpl/phase0/
    → Report: "[MPL] Phase 0 cache HIT. Skipping analysis. Saved ~{budget}K tokens."
    → Skip to Step 3 (Phase Decomposition)
  else:
    → Cache stale — attempt partial invalidation (see extension below)
else:
  → No cache, proceed with Phase 0
```

#### Extension: git diff-Based Partial Invalidation (F-05)

Even if the cache key doesn't match, if the change scope is limited, **re-analyze only the changed modules**.

```pseudocode
function check_cache_with_partial(cwd):
  cache_result = checkCache(cwd)

  if cache_result.hit:
    return { action: "skip", artifacts: cache_result.manifest.artifacts }

  if not cache_result.manifest:
    return { action: "full_rerun" }  # No cache — run everything

  # Cache exists but key doesn't match — attempt partial invalidation
  diff_result = analyze_diff(cwd, cache_result.manifest)

  if diff_result.scope == "none":
    return { action: "skip" }  # diff is outside cache scope (e.g. doc changes)

  if diff_result.scope == "partial":
    return {
      action: "partial_rerun",
      reuse_artifacts: diff_result.unaffected_artifacts,
      rerun_steps: diff_result.affected_steps
    }

  return { action: "full_rerun" }  # Full change
```

#### Diff Scope Analysis

```pseudocode
function analyze_diff(cwd, manifest):
  changed_files = git_diff_names(cwd, since=manifest.commit_hash or manifest.timestamp)

  # Classify changed files by Phase 0 step
  affected = {
    api_contracts: false,   # Step 1
    examples: false,        # Step 2
    type_policy: false,     # Step 3
    error_spec: false       # Step 4
  }

  for file in changed_files:
    if is_public_api(file):       # function signature changes
      affected.api_contracts = true
    if is_test_file(file):        # test pattern changes
      affected.examples = true
    if is_type_definition(file):  # type definition changes
      affected.type_policy = true
    if is_error_handler(file):    # error handling changes
      affected.error_spec = true

  affected_count = count_true(affected)

  if affected_count == 0:
    return { scope: "none" }
  elif affected_count <= 2:
    return {
      scope: "partial",
      affected_steps: [step for step, flag in affected if flag],
      unaffected_artifacts: [artifact for step, flag in affected if not flag]
    }
  else:
    return { scope: "full" }  # 3+ steps affected → full re-run is more efficient
```

#### Partial Re-run Protocol

On partial_rerun:
1. Copy cached unaffected_artifacts to `.mpl/mpl/phase0/`
2. Re-run only affected_steps in Phase 0 Enhanced
3. Merge re-run results into existing cache
4. Update manifest with new cache_key

Example:
```
Cache exists + only test files changed →
  affected: { examples: true } →
  partial_rerun: only Step 2 re-runs →
  Step 1(api_contracts), Step 3(type_policy), Step 4(error_spec) reuse cache →
  Token savings: ~60-70% (only 1 of 4 steps runs)
```

#### File Classification Rules

```
is_public_api(file):
  - src/**/*.{ts,js,py,go,rs} (excluding tests)
  - files containing function/class exports

is_test_file(file):
  - **/*.test.{ts,js}
  - **/*.spec.{ts,js}
  - **/test_*.py
  - **/*_test.{go,rs}

is_type_definition(file):
  - **/*.d.ts
  - **/types.{ts,py}
  - **/interfaces.{ts}
  - **/models.{py}

is_error_handler(file):
  - **/error*.{ts,js,py}
  - **/exception*.{py}
  - files containing "throw", "raise", "Error" patterns
```

#### Cache Key Generation

```
generate_cache_key(codebase_analysis):
  inputs = {
    test_files_hash:  hash(content of all test files),
    structure_hash:   hash(codebase_analysis.directories),
    deps_hash:        hash(codebase_analysis.external_deps),
    source_files_hash: hash(content of source files touching public API),
    qmd_mode: qmd_mode,  // "qmd_first" | "grep_only"
  }
  return sha256(JSON.stringify(inputs))
```

#### Cache Invalidation

| Change | Cache Behavior |
|--------|---------------|
| Test file content changes | Attempt partial invalidation (examples step) |
| Source file public API changes | Attempt partial invalidation (api_contracts step) |
| Type definition file changes | Attempt partial invalidation (type_policy step) |
| Error handler file changes | Attempt partial invalidation (error_spec step) |
| 3+ steps affected simultaneously | Full cache invalidation (partial re-run inefficient) |
| Dependency version changes | Full cache invalidation |
| Directory structure changes | Full cache invalidation |
| `--no-cache` flag | Force cache bypass |
| git diff failure | Full cache invalidation (safe fallback) |

### 2.5.1: Complexity Detection

Analyze the `codebase-analysis.json` generated in Step 2 to compute complexity score.
All inputs are already in codebase-analysis.json so no additional tool calls needed:

```
complexity_score = (modules × 10) + (external_deps × 5) + (test_files × 3)
```

| Score | Grade | Phase 0 Steps | Token Budget |
|-------|-------|---------------|-------------|
| 0~29 | Simple | Step 4 only (Error Spec) | ~8K |
| 30~79 | Medium | Step 2 + Step 4 (Example + Error) | ~12K |
| 80+ | Complex | Step 1 + Step 2 + Step 3 + Step 4 (Full Suite) | ~20K |

Orchestrator computes score and determines grade directly:

```
modules = count of directories containing source files (from codebase_analysis.directories)
external_deps = codebase_analysis.external_deps.length
test_files = codebase_analysis.test_infrastructure.test_files.length
```

> v3.0 to v3.1 changes: removed `async_functions × 8` (requires separate ast_grep_search call), merged Enterprise grade into Complex (simplified to 3-grade system). test_files weight increased from 2 to 3.

Save to `.mpl/mpl/phase0/complexity-report.json`:
```json
{
  "score": 89,
  "grade": "Complex",
  "breakdown": {
    "modules": 6, "external_deps": 4, "test_files": 3
  },
  "selected_steps": [1, 2, 3, 4],
  "token_budget": 20000
}
```

Announce: `[MPL] Complexity: {score} ({grade}). Phase 0 steps: {step_list}`

### 2.5.2: Step 1 — API Contract Extraction (Complex+)

**Applies when**: Complex (80+) only

Analyze test files and source code to extract function signatures, parameter order, and exception types.

**Execution method**: Orchestrator directly uses tools to analyze:

```
1. Extract function/method definitions
   ast_grep_search(pattern="def $NAME($$$ARGS)", language="python")
   ast_grep_search(pattern="function $NAME($$$ARGS)", language="typescript")
   lsp_document_symbols(file) for each key source file

2. Extract call patterns from tests
   ast_grep_search(pattern="$OBJ.$METHOD($$$ARGS)", language="python", path="tests/")
   — infer parameter order and types

3. Map exception types
   ast_grep_search(pattern="raise $EXCEPTION($$$ARGS)", language="python")
   ast_grep_search(pattern="pytest.raises($EXCEPTION)", language="python", path="tests/")
   ast_grep_search(pattern="throw new $EXCEPTION($$$ARGS)", language="typescript")

4. Signature verification
   lsp_hover(file, line, character) for ambiguous signatures
```

**Output**: `.mpl/mpl/phase0/api-contracts.md`

```markdown
# API Contract Specification

## [Module Name]

### [Function Name]
- Signature: `function_name(param1: Type1, param2: Type2) -> ReturnType`
- Parameter order: [importance indicator]
- Exceptions: [condition] → [exception type]("message pattern")
- Return value: [description]
- Side effects: [describe if any]
```

**Experimental basis**: In Exp 1, discovering parameter order was the key factor in passing tests.

### 2.5.3: Step 2 — Example Pattern Analysis (Medium+)

**Applies when**: Medium (30+) and above

Extract concrete usage patterns, default values, and edge cases from test files.

**Execution method**: Orchestrator analyzes test files:

```
1. Read test files (test_files identified in Step 2)
   Read(test_file) for each test file (cap: 300 lines per file)

2. Classify patterns (7 categories):
   - Creation patterns: object instantiation methods (constructor args, factory methods)
   - Validation patterns: assert/expect call patterns
   - Sorting patterns: order-related verifications (sorted, order_by)
   - Result patterns: return value structures (dict keys, list structure)
   - Error patterns: exception trigger conditions
   - Side effect patterns: state change verifications
   - Integration patterns: cross-module interactions

3. Extract default values
   ast_grep_search(pattern="$PARAM=$DEFAULT", language="python")
   Grep(pattern="default|DEFAULT", path="src/")

4. Identify edge cases
   Grep(pattern="edge|corner|boundary|empty|null|None|zero|negative", path="tests/")
```

**Output**: `.mpl/mpl/phase0/examples.md`

```markdown
# Example Pattern Analysis

## Pattern 1: [Pattern Name]
### Basic Usage
[code example from tests]

### Edge Cases
[code example from tests]

### Default Values
| Field | Default | Notes |
|-------|---------|-------|
```

**Experimental basis**: In Exp 3, concrete examples significantly improved implementation accuracy over abstract specifications. Sorting requirements and context update asymmetry were only discovered through examples.

### 2.5.4: Step 3 — Type Policy Definition (Complex+)

**Applies when**: Complex (80+) only

Define type hints for all functions/methods and explicitly specify collection type distinction rules.

**Execution method**: Orchestrator extracts type information from source + tests:

```
1. Collect existing type hints
   ast_grep_search(pattern="def $NAME($$$ARGS) -> $RET:", language="python")
   lsp_hover(file, line, character) for inferred types

2. Infer expected types from tests
   Analyze isinstance/type() call patterns
   Infer collection types from assert statements (set vs list vs dict)
   Grep(pattern="isinstance|type\\(", path="tests/")

3. Define type policy
   - Collection type distinction: List (order guaranteed) vs Set (dedup) vs Dict (key-value)
   - Optional rules: use Optional[T] for nullable parameters
   - Return type standardization: consistent return type patterns
   - Prohibited patterns: Any abuse, untyped collections, implicit None
```

**Output**: `.mpl/mpl/phase0/type-policy.md`

```markdown
# Type Policy

## Rules
1. Type hints required for all function parameters
2. Return type required for all functions
3. Use specific types (List[str], Set[int], Dict[str, Any])
4. Express nullable with Optional[T]
5. Prohibited: bare list, dict, set without type parameters

## Type Reference Table
| Field/Parameter | Type | Rationale |
|----------------|------|-----------|
```

**Experimental basis**: In Exp 4, confusion between `Set[str]` and `List[str]` was the primary cause of test failures.

### 2.5.5: Step 4 — Error Specification (All Grades)

**Applies when**: All complexity grades (required — always runs)

Specify standard exception mappings, error message patterns, and trigger conditions.

**Execution method**: Orchestrator extracts error patterns from tests + source:

```
1. Extract exception trigger patterns
   ast_grep_search(pattern="raise $EXC($$$ARGS)", language="python")
   ast_grep_search(pattern="throw new $EXC($$$ARGS)", language="typescript")

2. Extract error validations from tests
   ast_grep_search(pattern="pytest.raises($EXC)", language="python", path="tests/")
   Grep(pattern="with pytest.raises|assertRaises|expect.*toThrow", path="tests/")

3. Extract error message patterns
   Grep(pattern="match=|message=|msg=", path="tests/")
   — preserve regex patterns as-is

4. Analyze validation order
   Check if/raise order in source code — which condition is checked first
```

**Output**: `.mpl/mpl/phase0/error-spec.md`

```markdown
# Error Handling Specification

## [Module] Errors
- Type: [ExceptionType]
- Condition: [trigger condition]
- Message: "[pattern with {placeholders}]"
- Validation order: [priority]

## Prohibited
- Do not create custom exception classes (use standard exceptions only)
- Error messages must exactly match the match pattern in tests
```

**Experimental basis**: In Exp 7, error specification was found to be the "missing puzzle piece." Score jumped from 83% to 100% just by adding the error spec.

### 2.5.6: Phase 0 Output Summary

Summarize all applied step results in `.mpl/mpl/phase0/summary.md`:

```markdown
# Phase 0 Enhanced Summary

## Complexity
- Grade: {grade} (score: {score})
- Breakdown: modules={n}, deps={n}, tests={n}, async={n}

## Applied Steps
- [x/o] Step 1: API Contract Extraction
- [x/o] Step 2: Example Pattern Analysis
- [x/o] Step 3: Type Policy Definition
- [x] Step 4: Error Specification

## Artifacts
| Artifact | Path | Status |
|----------|------|--------|
| API Contracts | `.mpl/mpl/phase0/api-contracts.md` | generated / skipped |
| Examples | `.mpl/mpl/phase0/examples.md` | generated / skipped |
| Type Policy | `.mpl/mpl/phase0/type-policy.md` | generated / skipped |
| Error Spec | `.mpl/mpl/phase0/error-spec.md` | generated |

## Key Findings
[auto-generated key findings]
```

Announce: `[MPL] Phase 0 Enhanced complete. Grade: {grade}. Artifacts: {count}/4 generated. Token budget: {budget}.`

### 2.5.7: Artifact Validation

Automatically validate the quality of Phase 0 artifacts:

```
for each generated artifact:
  validate_artifact(artifact):
    1. Structure check: verify required sections exist
       - api-contracts.md: "## [Module Name]" + "### [Function Name]" sections exist
       - examples.md: "## Pattern" section + code blocks exist
       - type-policy.md: "## Rules" + "## Type Reference Table" sections exist
       - error-spec.md: "## [Module] Errors" section exists
    2. Coverage check: verify functions called in tests are included in contract
       - Extract function call list from tests via ast_grep_search
       - Compare against function list in api-contracts.md
       - Missing rate > 20% → warning
    3. Consistency check: cross-artifact reference consistency
       - types in api-contracts ↔ types in type-policy match
       - exceptions in api-contracts ↔ exceptions in error-spec match

  if validation fails:
    → Report: "[MPL] Phase 0 artifact validation WARNING: {details}"
    → Attempt auto-fix (re-run failed step with narrower focus)
    → Max 1 retry per artifact

Report: "[MPL] Phase 0 validation: {passed}/{total} artifacts validated."
```

### 2.5.8: Cache Save

After Phase 0 execution completes, save results to cache:

```
cache_dir = ".mpl/cache/phase0/"
cache_key = generate_cache_key(codebase_analysis)
commit_hash = git_rev_parse("HEAD")  # used as diff baseline in partial invalidation (F-05)

save_to_cache:
  1. Create cache_dir if not exists
  2. Copy all phase0 artifacts to cache_dir
  3. Write manifest.json:
     {
       "cache_key": cache_key,
       "commit_hash": commit_hash,
       "timestamp": ISO timestamp,
       "complexity_grade": complexity_grade,
       "artifacts": ["api-contracts.md", "examples.md", ...],
       "validation_result": { passed: N, total: M }
     }
  4. Report: "[MPL] Phase 0 artifacts cached. Key: {short_key}."
```

#### 2.5.8 Extension: Cache Save on Partial Re-run (F-05)

After partial re-run completes:
1. Merge reused cache artifacts + newly generated artifacts
2. Generate new cache_key (full hash at current point)
3. Update manifest.json: add partial_rerun_info field
   ```json
   {
     "cache_key": "new_full_hash",
     "commit_hash": "current_HEAD",
     "timestamp": "2026-03-13T...",
     "complexity_grade": "Complex",
     "artifacts": ["api-contracts.md", "examples.md", "type-policy.md", "error-spec.md"],
     "validation_result": { "passed": 4, "total": 4 },
     "partial_rerun": true,
     "rerun_steps": ["examples"],
     "reused_steps": ["api_contracts", "type_policy", "error_spec"],
     "original_cache_key": "previous_hash"
   }
   ```
4. Report: `"[MPL] Partial cache save. Rerun: {rerun_steps}. Reused: {reused_steps}. New key: {short_key}."`

### 2.5.9: Token Profiling (Phase 0)

Record token usage for Phase 0 execution:

```
phase0_profile = {
  "step": "phase0-enhanced",
  "grade": complexity_grade,
  "cache_hit": false,
  "steps_executed": [1, 3, 4],
  "artifacts_generated": 3,
  "validation_passed": 3,
  "estimated_tokens": {
    "complexity_detection": ~500,
    "step1_api_contracts": ~5000,
    "step2_examples": 0,
    "step3_type_policy": ~3000,
    "step4_error_spec": ~3000,
    "validation": ~500,
    "total": ~12000
  },
  "duration_ms": elapsed
}

Append to .mpl/mpl/profile/phases.jsonl
```

---
