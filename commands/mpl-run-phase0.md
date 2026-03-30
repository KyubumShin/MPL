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

## Step 0.0.5: Artifact Freshness Check + Field Classification (F-FC-1/2/3, v0.8.5)

Before Triage, check if `.mpl/` artifacts exist from a previous MPL run and classify the project field.
This enables Field 4 (AI-Built Maintenance) support in future versions.

**v0.8.5**: `field_classification` is recorded in state.json for observability only. All fields follow the existing full pipeline. Phase 0 branching (Delta PP, cache shortcuts) is planned for v0.9.0.

### 0.0.5a: .mpl/ Existence Check

```pseudocode
mpl_exists = Glob(".mpl/").length > 0
manifest_path = ".mpl/manifest.json"
manifest_exists = mpl_exists AND file_exists(manifest_path)
```

### 0.0.5b: Artifact Freshness Check (when manifest exists)

```pseudocode
if manifest_exists:
  manifest = JSON.parse(Read(manifest_path))

  fresh_count = 0
  stale_files = []
  fresh_files = []

  // Compare each tracked artifact's hash against current file
  for each artifact in manifest.artifacts:
    if not file_exists(artifact.path):
      stale_files.push({ path: artifact.path, reason: "missing" })
      continue

    current_hash = Bash("shasum -a 256 " + artifact.path).split(" ")[0]
    if current_hash != artifact.hash:
      stale_files.push({ path: artifact.path, reason: "modified" })
    else:
      fresh_count += 1
      fresh_files.push(artifact.path)

  freshness_ratio = fresh_count / Math.max(manifest.artifacts.length, 1)

  writeState(cwd, {
    freshness_ratio: freshness_ratio,
    stale_artifact_count: stale_files.length,
    fresh_artifact_count: fresh_files.length
  })

  Announce: "[MPL] Artifact Freshness: {(freshness_ratio * 100).toFixed(0)}% ({fresh_count}/{manifest.artifacts.length} fresh). Stale: {stale_files.length} files."
else:
  freshness_ratio = null
```

### 0.0.5c: Field Classification

```pseudocode
if not mpl_exists:
  // No .mpl/ directory → classify by source code presence
  source_files = Glob("**/*.{ts,tsx,js,jsx,py,go,rs,java}")
  test_files = Glob("**/*.{test,spec}.*", "**/*_test.*", "**/test_*.*")

  if source_files.length == 0:
    field = "field-1"  // Greenfield: no source files
  else:
    test_ratio = test_files.length / Math.max(source_files.length, 1)
    if test_ratio > 0.3:
      field = "field-2"  // Well-Documented Existing: source + tests
    else:
      field = "field-3"  // Legacy: source + minimal tests
      Announce: "[MPL] WARNING: Legacy project detected (minimal test coverage). Proceeding as greenfield. Consider adding tests first."

elif not manifest_exists:
  // .mpl/ exists but no manifest.json → pre-v0.8.5 MPL run, treat as greenfield
  field = "field-1"

else:
  // .mpl/ + manifest.json → classify by freshness
  if freshness_ratio >= 0.8:
    field = "field-4-fresh"
  elif freshness_ratio >= 0.4:
    field = "field-4-stale"
  else:
    field = "field-4-degraded"
    Announce: "[MPL] WARNING: .mpl/ artifacts severely degraded (freshness {(freshness_ratio * 100).toFixed(0)}%). Full Phase 0 re-execution recommended."

writeState(cwd, { field_classification: field })
Announce: "[MPL] Field Classification: {field}."
```

**Field values:**
| Value | Condition | MPL Scope |
|-------|-----------|-----------|
| `field-1` | No source or no manifest | ✅ Greenfield |
| `field-2` | Source + tests (>30%), no .mpl/ | ✅ Well-Documented |
| `field-3` | Source + minimal tests, no .mpl/ | ⚠️ WARNING, proceed as field-1 |
| `field-4-fresh` | .mpl/ + freshness ≥ 0.8 | ✅ AI-Built (Phase 0 shortcut in v0.9.0) |
| `field-4-stale` | .mpl/ + freshness 0.4~0.8 | ✅ AI-Built (partial re-exec in v0.9.0) |
| `field-4-degraded` | .mpl/ + freshness < 0.4 | ⚠️ WARNING, full re-execution |

---

## Step 0: Triage

Triage determines two things: **pp_proximity** (how deep to analyze based on task scope) and **interview_depth** (how deep the PP interview goes). PP-proximity is determined by Quick Scope Scan (F-20), replacing the previous keyword-based mode detection.

### 0.1: Quick Scope Scan + PP-Proximity (F-20)

Perform a lightweight codebase scan (~1-2K tokens) to calculate `pipeline_score` and determine `pp_proximity`:

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

Before finalizing proximity, check past execution patterns for a similar task:

```
if exists(".mpl/memory/routing-patterns.jsonl"):
  { match, similarity, recommendation } = findSimilarPattern(cwd, user_request)
  // Uses hooks/lib/mpl-routing-patterns.mjs (Jaccard similarity, threshold 0.8)

  if recommendation:
    // Pattern match found — use as proximity hint (but score can override if 2+ levels apart)
    if |proximity_from_score - recommendation| <= 1 level:
      proximity = recommendation
      source = "pattern_match"
      Announce: "[MPL] Routing pattern match: similarity={similarity}, recommending proximity={recommendation}."
    else:
      // Score and pattern disagree significantly — trust score
      Announce: "[MPL] Routing pattern found (similarity={similarity}) but score disagrees. Using score-based proximity."
```


> **Steps 0.1.5b (F-11 Learnings), 0.1.5c (F-25 4-Tier Memory), and semantic.md-assisted shortcuts have been moved to `mpl-run-phase0-memory.md`.**
> Load when loading memory in Step 0 or Step 2.5.

Classify pp_proximity from score (or override with user hint):

| pp_proximity | Score | Hint | Pipeline Depth |
|--------------|-------|------|---------------|
| `"near"` | < 0.3 | `"mpl bugfix"` | Error Spec → Fix Cycle → Gate 1 → Commit |
| `"mid"` | 0.3~0.65 | `"mpl small"` | PP(light) → Error Spec → Single Phase → Gate 1 → Commit |
| `"far"` | > 0.65 | (none) | Full 9+ step pipeline (Steps 0~6) |

```
proximity_hint = state.proximity_hint  // from keyword-detector (may be null)
{ score, breakdown } = calculatePipelineScore(scan_results)
{ proximity, source } = classifyProximity(score, proximity_hint)

Write pp_proximity to state:
  writeState(cwd, { pp_proximity: proximity })

Announce: "[MPL] Triage: pp_proximity={proximity} (source={source}, score={score}).
           Scan: files={affected_files}, tests={test_scenarios}, depth={import_depth}, risk={risk_signal}."
```

#### Proximity-Based Step Selection

After pp_proximity is determined, subsequent steps are selected per proximity:

| Step | Near | Mid | Far |
|------|------|-----|-----|
| Step 0.2 Interview Depth | light (+ Uncertainty Scan) | light | full detection |
| Step 1 PP + Requirements Interview (v2) | light (Round 1+2 + Uncertainty Scan) | light (Round 1+2 + lightweight requirements) | full (4 rounds + Socratic + JUSF) |
| Step 1-B Pre-Execution | skip | skip | full |
| Step 2 Codebase Analysis | skip (use scan) | structure + tests only | full (6 modules) |
| Step 2.5 Phase 0 Enhanced | Step 4 only (Error Spec) | Step 4 only (Error Spec) | complexity-adaptive |
| Step 3 Decomposition | skip (single fix cycle) | skip (single phase) | full decomposition |
| Gates | Gate 1 only | Gate 1 only | Gate 1 + 2 + 3 |

```
if pp_proximity == "near":
  -> Continue to Step 0.2 (interview_depth = "light" + Uncertainty Scan)
  -> Then Step 1 (light interview) → Step 2.5.5 (Error Spec only)
  -> Then proceed directly to Phase Execution (single fix cycle)

if pp_proximity == "mid":
  -> Continue to Step 0.2 (interview_depth forced to "light")
  -> Then Steps 1 → 2.5.5 → Phase Execution (single phase)

if pp_proximity == "far":
  -> Continue to Step 0.2 (full interview depth detection)
  -> Then full pipeline (Steps 1 → 1-B → 2 → 2.5 → 3 → 4 → 5)
```

### 0.1.5: RUNBOOK Initialization (F-10)

After Triage determines pp_proximity, create the RUNBOOK:

```
Write(".mpl/mpl/RUNBOOK.md"):
  # RUNBOOK — {user_request (first 100 chars)}
  Started: {ISO timestamp}
  PP-Proximity: {pp_proximity} (source: {source}, score: {score})

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

Stage 2 (Ambiguity Resolution):
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

**Stage 2 Details** (Ambiguity Resolution):

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

Stage 2 (Ambiguity Resolution):
  Spec Reading → Ambiguity Scoring Loop → Solution Options → JUSF
  → Output: ambiguity score + requirements-{hash}.md
```

**Phase 1 Details**:

1. **Round 1-4**: Full existing PP interview
2. PP confirmation: save pivot-points.md + generate user_responses_summary

**Stage 2 Details** (Ambiguity Resolution):

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

// Two-phase interview execution:
Task(subagent_type="mpl-interviewer", ...)  // Phase 1: PP Discovery
→ save pivot-points.md + user_responses_summary

// Stage 2: Ambiguity Resolution + Requirements (performed by mpl-interviewer)
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

// Stage 2 (Ambiguity Resolution):
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
// Pre-execution analysis performed inline by the orchestrator:
// Analyze gaps, pitfalls, and constraints (Part 1),
// then assess risk levels and recommend execution order (Part 2).
//
// Input:
//   - user_request
//   - pivot_points from .mpl/pivot-points.md
//   - codebase_analysis from .mpl/mpl/codebase-analysis.json (if available)
//
// Part 1 (Gap Analysis): Missing requirements, AI pitfalls, Must NOT Do, Recommended Questions
// Part 2 (Tradeoff Analysis): Risk ratings, reversibility, blast radius, execution ordering
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

> **Step 2 (Codebase Analysis), Step 2.4 (Architecture Decisions), and Step 2.5 (Phase 0 Enhanced) have been moved to `mpl-run-phase0-analysis.md`.**
> This includes: 6-Module analysis, QMD integration, cache check, complexity detection, API contract extraction, example pattern analysis, type policy, error specification, validation, cache save, and token profiling.
>
> Load `mpl-run-phase0-analysis.md` when entering Step 2.

---
