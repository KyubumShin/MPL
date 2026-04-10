# MPL (Micro-Phase Loop) v0.12.2 Design Document

## 1. Overview

MPL is an autonomous coding pipeline that decomposes user requests into ordered **micro-phases**. Each phase runs in an isolated session with only structured context, preventing context pollution that occurs during long-running executions.

> **Version notation**: Early roadmap documents used a separate major-version series (v1.0, v3.0, v4.0) for design milestones. The actual release versions follow the `v0.x.y` semver series. Mapping: v1.0 = initial design, v3.0 ≈ v0.3.0, v4.0 ≈ v0.4.0. This document uses v0.x.y exclusively; legacy v3.x/v4.x references remain in historical roadmap files.

The current architecture (v0.3.0+) evolved from the initial 5-step·5-agent structure to a **9+ step pipeline**. Key changes:

| Area | Initial (v1.0) | Current |
|------|------|------|
| Pipeline Steps | 5 steps (Step 0~5) | 9+ steps (Step 0~6 + sub-steps) |
| Agents | 5 | 7 |
| Pre-Analysis | None | Triage + Phase 0 Enhanced |
| Quality System | Simple verification | Build-Test-Fix + 3 Hard Gates + 1 Advisory + A/S/H classification + Convergence Detection |
| Caching | None | Phase 0 artifact caching |
| Token Profiling | None | Per-phase token/time profiling |

> **Detailed procedures** are defined in `mpl-run.md` (orchestration protocol). This document covers concepts, structure, and policy.

---

## 2. Design Principles

### Principle 1: Orchestrator–Phase Runner Separation

The orchestrator **never writes source code directly.** All code changes are executed by `mpl-phase-runner` agents dispatched via the Task tool. The `mpl-write-guard` PreToolUse hook provides advisory warnings for this.

### Principle 2: Plan First

Execution begins only after phase decomposition. The decomposition artifact (`decomposition.yaml`) is the single source of truth (SSOT), containing ordered phases and interface contracts.

### Principle 3: Test-Based Verification

Each phase has machine-verifiable success criteria. Subjective "done" declarations are not permitted; only evidence-based verification (command exit codes, test results, file existence, grep patterns) is accepted.

> **QMD Semantic Search Policy:** QMD search results are used only for discovery purposes. To be accepted as verification evidence, they must pass grep cross-validation (Search-then-Verify). Results that pass cross-validation have evidence type `qmd_verified` and are treated equivalently to grep.

### Principle 4: Bounded Retries

Phase retry budget is determined by PP-proximity. Circuit break leads to pipeline failure, preventing infinite loops.

### Principle 5: Knowledge Accumulation via Channel Registry

Knowledge transfer between phases occurs through **registered channels only**. Unregistered channels are prohibited.

| # | Channel | Format | Creator | Consumer | SSOT |
|---|---------|--------|---------|----------|------|
| 1 | `decomposition.yaml` | YAML | Decomposer | Orchestrator | ✓ |
| 2 | `phase-decisions.md` | Markdown | Phase Runner | All subsequent phases | |
| 3 | `.mpl/contracts/*.json` | JSON | Decomposer (L0) | Phase Runner, Sentinels | ✓ |
| 4 | `pivot-points.md` | Markdown | Interviewer | All phases (immutable) | ✓ |
| 5 | `state-summary.md` | Markdown | Phase Runner | Next phase (L0/L1/L2) | |
| 6 | `regression-suite.json` | JSON | Phase Runner | Phase Runner (cumulative) | |
| 7 | `.mpl/mpl/phase0/*.md` | Markdown | Phase 0 Analyzer | Phase Runner | |
| 8 | `export-manifest.json` | JSON | Phase Runner | Sentinels | |

**State Summary** remains the primary channel. Additionally, the **immediately preceding phase's verification results and code diff** are selectively forwarded when the next phase directly depends on that work. Phase Decisions are managed with a 2-Tier classification system (Active/Summary) to preserve decision context across all phases.

---

## 3. Pipeline Architecture

### 3.1 State Machine

```
mpl-init -> mpl-decompose -> mpl-phase-running <-> mpl-phase-complete
                                   |                      |
                            mpl-circuit-break      mpl-finalize -> completed
                                   |
                               mpl-failed
```

- **Retry**: Phase Runner retries internally based on PP-proximity (PP-core 3, PP-adjacent 2, Non-PP 1). The orchestrator receives only `"complete"` or `"circuit_break"`.
- **Circuit break**: Transitions directly to `mpl-failed` state. Completed phases are preserved.

### 3.2 Full Flow Summary Table

| Step | Name | Core Agent | Artifact |
|------|------|-------------|--------|
| -1 | LSP Warm-up | (orchestrator, non-blocking) | lsp_servers list, cold start elimination |
| 0.0.5 | Artifact Freshness + Field Classification (v0.8.5) | (orchestrator) | field_classification, freshness_ratio, `.mpl/manifest.json` (read) |
| 0 | Triage | (orchestrator) | interview_depth (light/light+scan/full), pp_proximity |
| 1 | PP Interview | mpl-interviewer | `.mpl/pivot-points.md` |
| 1-D | PP Confirmation | (orchestrator) | PP final confirmation with user |
| 1-E | Interview Snapshot Save | (orchestrator) | `.mpl/mpl/interview-snapshot.md` |
| 2 | Codebase Analysis | (orchestrator) | `.mpl/mpl/codebase-analysis.json` |
| 2.4 | Architecture Decision Checklist | (orchestrator) | Key architecture decisions documented |
| 2.5 | Phase 0 Enhanced | (orchestrator) | `.mpl/mpl/phase0/*.md` |
| 3 | Phase Decomposition | mpl-decomposer | `.mpl/mpl/decomposition.yaml` |
| 4 | Phase Execution Loop | mpl-phase-runner (direct impl) | Per-phase artifacts |
| 5 | E2E & Finalization | mpl-git-master | E2E (3-tier fallback v0.8.3), commits, metrics, **manifest.json (v0.8.5)** |
| 6 | Resume Protocol | (orchestrator) | Resume from interrupted phase |

### 3.3 Step-by-Step Description

#### Step 0: Triage

Analyzes the **information density** of the user prompt to determine interview depth and PP-proximity (Hat model). Counts the number of explicit constraints, specific files, measurable criteria, and tradeoff choices.

| interview_depth | Condition | Interview Behavior |
|-----------------|------|-----------|
| `light` | Density 4-7 | Round 1 (What) + Round 2 (What NOT) only |
| `light` + scan | Density 8+ | What + What NOT + Uncertainty Scan |
| `full` | Density below 4 (ambiguous/broad) | Full 4-round PP interview |

**PP-Proximity Classification (Hat Model)** — Replaces the previous `pipeline_tier` (frugal/standard/frontier) and `maturity_mode` (explore/standard/strict) systems with a single dimension:

| PP-Proximity | Condition | Pipeline Behavior |
|-------------|-----------|-------------------|
| `pp_core` | Task directly implements a Pivot Point | Full interview + all gates |
| `pp_adjacent` | Task relates to PP but not a direct implementation | Abbreviated interview + hard gates only |
| `non_pp` | Task is unrelated to any PP (refactoring, chores) | Minimal interview + advisory gates |

#### Step 1: PP Interview + PP Confirmation

This step consists of 2 sub-steps:

**Step 1: PP Interview** — `mpl-interviewer` (opus) discovers Pivot Points through a structured 4-Round interview. Interview scope is adjusted based on Triage's `interview_depth` (light: Round 1~2 only, full: all 4 rounds). PP status is classified as CONFIRMED (hard constraint, auto-reject on conflict) or PROVISIONAL (soft, HITL on conflict). The interviewer also handles ambiguity resolution and pre-execution gap analysis inline, consolidating what was previously 3 separate agents (mpl-interviewer, mpl-ambiguity-resolver, mpl-pre-execution-analyzer) into a single opus call.

**Step 1-D: PP Confirmation** — Finalizes PP. Asks the user additional questions as needed.

#### Step 2: Codebase Analysis

The orchestrator analyzes the codebase using built-in tools. Consists of 6 analysis modules:

| Module | Tool | Analysis Target |
|------|------|----------|
| Structure Analysis | Glob | Directory structure, file list |
| Dependency Graph | ast_grep_search / Grep | Inter-module import/require relationships |
| Interface Extraction | lsp_document_symbols | Public API signatures |
| Centrality Analysis | (derived from dependencies) | Core module identification |
| Test Infrastructure | Glob + Read | Test framework, existing tests |
| Configuration | Read | Build/test configuration files |

Artifact: `.mpl/mpl/codebase-analysis.json`

#### Step 2.5: Phase 0 Enhanced (Complexity-Adaptive Analysis)

Phase 0 Enhanced **measures project complexity** based on Step 2 analysis results and generates pre-specifications according to complexity. "Prevention is better than cure" — tokens invested in Phase 0 eliminate subsequent debugging costs.

**Cache Check** — Before execution, checks cache in `.mpl/cache/phase0/`. On cache hit, skips all of Phase 0, saving 8~25K tokens. Cache key is generated from hashes of test files, directory structure, dependency versions, and source files.

**Complexity Detection** — Calculates a complexity score:

```
complexity_score = (number of modules × 10) + (external dependencies × 5) + (test files × 3)
```

| Score | Grade | Phase 0 Step | Token Budget |
|------|------|-------------|----------|
| 0~29 | Simple | Step 4 only (Error Spec) | ~10K |
| 30~79 | Medium | Step 2 + Step 4 | ~18K |
| 80+ | Complex | Steps 1~4 all | ~30K |

> **v0.6.7 change (1M adaptation):** Token budgets increased from 8K/12K/20K to 10K/18K/30K. With 1M context, investing more tokens in Phase 0 pre-specification has negligible impact on total budget (~3% of 900K max) while improving specification quality and reducing downstream debugging.

**4-Step Process**:

| Step | Name | Applicable Condition | Artifact Path |
|------|------|----------|-----------|
| Step 1 | API Contract Extraction | Complex+ | `.mpl/mpl/phase0/api-contracts.md` |
| Step 2 | Example Pattern Analysis | Medium+ | `.mpl/mpl/phase0/examples.md` |
| Step 3 | Type Policy Definition | Complex+ | `.mpl/mpl/phase0/type-policy.md` |
| Step 4 | Error Specification | All grades (required) | `.mpl/mpl/phase0/error-spec.md` |

Each Step's artifact must pass a verification checklist. The final summary is stored in `.mpl/mpl/phase0/summary.md`, and successfully completed artifacts are cached in `.mpl/cache/phase0/`.

Token profiling also begins at this step. Phase 0 token usage is recorded in `.mpl/mpl/profile/phases.jsonl`.

#### Step 3: Phase Decomposition

**Step 3: Phase Decomposition** — `mpl-decomposer` (opus) decomposes the user request into ordered micro-phases. The decomposer performs pure reasoning without tool access, taking structured CodebaseAnalysis as input. Each phase declares:
- Scope and rationale
- Impact scope (created/modified/tested/configuration files)
- Interface contract (requires/produces)
- Success criteria (typed: command/test/file_exists/grep/qmd_verified/description)
- Estimated complexity (S/M/L)
- A/S/H verification classification (inline, previously handled by separate mpl-verification-planner agent)

Artifact: `.mpl/mpl/decomposition.yaml`

A/S/H classification is now performed inline by the decomposer:
- **A-items** (Agent-Verifiable): Agent can automatically verify (command, exit code)
- **S-items** (Sandbox Agent Testing): BDD/Gherkin scenario-based verification
- **H-items** (Human-Required): Automation insufficient, requires human judgment

The verification plan is attached to each phase and serves as the verification criteria for Phase Runner.

**Step 3-C: ~~Critic Simulation~~** — Absorbed into Decomposer's `risk_assessment` output section (v0.3.1).

#### Step 4: Phase Execution Loop

The core execution unit of the pipeline. Executes each phase in order.

**4.1 Context Assembly** — Assembles the necessary context before each phase execution:
- Phase 0 artifacts (selectively loaded based on complexity grade)
- Pivot Points
- Phase Decision (2-Tier classification applied)
- Phase definition (from decomposition.yaml)
- Impact files (maximum 2,000 lines per file)
- Previous phase State Summary + verification results + code diff (N-1 only)
- Dependency phase Summary (based on interface_contract.requires)
- Verification plan (A/S/H items for the relevant phase)

**4.2 Phase Runner Execution** — `mpl-phase-runner` (sonnet) runs in an isolated session. Phase Runner writes a mini-plan, implements TODOs directly via Build-Test-Fix micro-cycles, verifies with Build-Test-Fix micro-cycles, and produces a State Summary. Rules:
- Immediate testing per TODO (no batching)
- On failure, reference Phase 0 artifacts before fixing
- Circuit break after maximum 3 retries

**4.2.1 Testing** — Phase Runner handles testing inline via Build-Test-Fix micro-cycles. The separate `mpl-test-agent` was removed in v0.11.0; test writing and execution are now performed directly by Phase Runner, reducing agent dispatch overhead while maintaining the per-TODO test requirement.

**4.3 Result Processing** — Performs verification, state saving, Discovery processing, and profile recording.

**4.3.5 Side Interview** — Requests user confirmation when CRITICAL discovery, H-items, or AD (After Decision) markers are present.

**4.3.6 Context Cleanup (Sliding Window)** — After each phase completes, applies a sliding window retention policy: the most recent N phases (default: 3, configurable via `context_cleanup_window`) retain detailed data in orchestrator memory, while older phases are compressed to State Summary only. Token impact: ~60-90K for 3 retained phases (≈7-10% of 900K budget).

**4.4 Circuit Break** — When circuit break occurs, the pipeline transitions to `mpl-failed`. Completed phases are preserved; the failure report includes what succeeded and what failed.

**4.5 Gate System (3 Hard + 1 Advisory)** — After all phases complete, must pass 3 Hard Gates plus 1 Advisory gate to proceed to finalization (see §5 Quality System for details).

**4.6 Fix Loop** — On gate failure, enters the fix loop. Monitors progress with Convergence Detection; changes strategy on stagnation, immediately circuit breaks on regression (see §5.4 for details).

#### Step 5: E2E & Finalization

After passing all Hard Gates, performs the final steps:

| Sub-step | Content |
|----------|------|
| 5.0 E2E Testing | Run E2E scenarios for S-items |
| 5.0.5 AD Final Verification | Confirm interface definitions for After Decision markers |
| 5.1 Final Verification | Re-run success criteria for all phases |
| 5.2 Learning Extraction | Orchestrator extracts learnings/decisions/issues (previously mpl-compound, removed in v0.11.0) |
| 5.3 Atomic Commit | `mpl-git-master` detects style and creates atomic commit |
| 5.4 Metrics | `.mpl/mpl/metrics.json` + profile save |
| 5.5 Completion Report | Summary of phase completion/failure, retries, key findings |
| 5.6 State Update | Transition to `completed` state |

#### Step 6: Resume Protocol

MPL supports natural resume through per-phase state persistence. When a session starts and `.mpl/state.json` has `run_mode == "mpl"`, it finds the next incomplete phase and loads accumulated Phase Decisions and the last State Summary to resume execution.

| Data | Source |
|--------|------|
| Completed results | `.mpl/mpl/phases/phase-N/state-summary.md` |
| Accumulated PD | `.mpl/mpl/phase-decisions.md` |
| Phase definition | `.mpl/mpl/decomposition.yaml` |
| Progress state | `.mpl/mpl/state.json` |
| Pivot Points | `.mpl/pivot-points.md` |

---

## 4. Agent Catalog

MPL uses 7 specialized agents (v0.12.2: consolidated from 15 — see v0.11.0 changelog for details). Each agent has clear role boundaries and tool restrictions.

### Pre-Execution Agents (Analysis/Planning)

| Agent | Role | Model | Disallowed Tools |
|---------|------|------|-----------|
| `mpl-interviewer` | PP Interview + ambiguity resolution + gap analysis — discovers Pivot Points, resolves ambiguities, identifies gaps (consolidates previous mpl-interviewer + mpl-ambiguity-resolver + mpl-pre-execution-analyzer) | opus | Write, Edit, Bash, Task |
| `mpl-codebase-analyzer` | Codebase structure analysis — static analysis of directory structure, dependencies, interfaces | haiku | Edit, Task |
| `mpl-phase0-analyzer` | Pre-Execution deep analysis — in-depth Phase 0 Enhanced analysis before execution | sonnet | Edit, Task |
| `mpl-decomposer` | Phase decomposition + verification planning — decomposes request into ordered micro-phases with inline A/S/H classification (consolidates previous mpl-decomposer + mpl-verification-planner) | opus | Write, Edit, Bash, Task, WebFetch, WebSearch, NotebookEdit |

### Execution Agents (Execution/Verification)

| Agent | Role | Model | Disallowed Tools |
|---------|------|------|-----------|
| `mpl-phase-runner` | Phase execution — mini-plan, direct implementation, testing, verification, State Summary (absorbs previous mpl-test-agent + mpl-code-reviewer responsibilities) | sonnet | None (full tool access) |

### Post-Execution Agents (Finalization)

| Agent | Role | Model | Disallowed Tools |
|---------|------|------|-----------|
| `mpl-git-master` | Atomic commit — style detection, semantic splitting, 3+ files = 2+ commits | sonnet | Write, Edit, Task |

### Removed Agents (v0.11.0)

The following agents were removed and their responsibilities consolidated into remaining agents:

| Removed Agent | Absorbed By | Rationale |
|---------------|------------|-----------|
| `mpl-ambiguity-resolver` | `mpl-interviewer` | Single opus call handles PP discovery + ambiguity resolution |
| `mpl-pre-execution-analyzer` | `mpl-interviewer` | Gap/tradeoff analysis integrated into interview |
| `mpl-verification-planner` | `mpl-decomposer` | A/S/H classification done inline during decomposition |
| `mpl-test-agent` | `mpl-phase-runner` | Testing integrated into Build-Test-Fix micro-cycle |
| `mpl-code-reviewer` | `mpl-phase-runner` | Code review integrated into phase execution |
| `mpl-compound` | (orchestrator) | Learning extraction handled by orchestrator at finalize |
| `mpl-scout` | (orchestrator) | Search functionality handled by orchestrator directly |
| `mpl-phase-seed-generator` | `mpl-decomposer` | Seed generation integrated into decomposition |

### Utility Agents

| Agent | Role | Model | Disallowed Tools |
|---------|------|------|-----------|
| `mpl-doctor` | Installation diagnostics — 11-category inspection, tool_mode detection (full/partial/standalone) | haiku | Write, Edit, Task |

### Model Routing Policy

Default models are specified in agent definitions but may escalate based on context:

| Agent | Default | opus Escalation Condition |
|---------|------|---------------------|
| mpl-decomposer | opus | Always opus (complex reasoning) |
| mpl-phase-runner | sonnet | L complexity or architecture change |

---

## 5. Quality System

MPL ensures code quality through a multi-layer quality system.

### 5.1 Build-Test-Fix Micro-Cycle

Within Phase Runner, tests are run immediately after each TODO implementation. Instead of a batch approach that tests after all implementations are complete, **a per-TODO micro-cycle** is executed.

```
TODO implementation ──→ Test relevant module ──→ Pass? ──→ Next TODO
                                                   │
                                                   ↓ Fail
                                          Immediate fix (max 2 times) ──┘
```

- Maximum retries per TODO: 2
- At phase end: all tests from current + previous phases are run cumulatively to prevent regressions
- On failure, references Phase 0 artifacts (error-spec, type-policy, api-contracts)

### 5.2 Gate System (3 Hard + 1 Advisory)

After all phase executions complete, must pass through 3 Hard Gates plus 1 Advisory gate:

| Gate | Name | Type | Owner | Pass Criteria | On Failure |
|------|------|------|------|----------|--------|
| Hard 1 | Build + Type Check | Hard | (orchestrator) | 0 build errors, 0 type errors | Enter Fix Loop |
| Hard 2 | Automated Testing | Hard | (orchestrator) | pass_rate ≥ 95% | Enter Fix Loop |
| Hard 3 | PP Compliance | Hard | (orchestrator + Human) | No PP violations + H-items resolved | Enter Fix Loop |
| Advisory | Cross-Boundary Check | Advisory | (orchestrator) | Boundary contract consistency | Warnings logged, non-blocking |

Hard 1 performs project-wide build and type checking (consolidates previous Gate 0.5). Hard 2 runs the full test suite including S-items and regression suite (consolidates previous Gate 1 + Gate 1.5). Hard 3 validates PP compliance holistically and confirms H-items with the user (consolidates previous Gate 3). The Advisory gate checks cross-boundary contract consistency (evolved from Gate 0.7).

> **Historical note (pre-v0.11.0):** The previous 5-Gate system (Gate 0.5, 0.7, 1, 1.5, 2, 3) included a separate Code Review gate (Gate 2) handled by `mpl-code-reviewer`. In v0.11.0, code review responsibilities are absorbed into Phase Runner's Build-Test-Fix cycle, and the Gate 1.5 metrics gate and Gate 2 code review gate are removed as separate stages.

### 5.3 A/S/H Verification Classification

`mpl-decomposer` classifies all acceptance criteria inline into three categories:

| Classification | Description | Verification Method | Example |
|------|------|----------|------|
| **A-items** (Agent-Verifiable) | Agent can automatically verify | Command execution + exit code check | `npm test` pass, file existence |
| **S-items** (Sandbox Agent Testing) | Agent verifies based on scenarios | BDD/Gherkin scenario execution | "When user logs in, dashboard is displayed" |
| **H-items** (Human-Required) | Automation insufficient | User confirmation (Side Interview) | UX judgment, business logic appropriateness |

A-items are verified by Phase Runner. S-items are verified at Hard 2 (automated testing). H-items are confirmed with the user through Side Interview at Hard 3.

### 5.4 Convergence Detection

Detects whether fixes in the Fix Loop are actually making progress. Records pass_rate after each fix attempt and determines convergence state:

| State | Condition | Response |
|------|------|------|
| `progressing` | pass_rate is improving | Continue fixing |
| `stagnating` | min_improvement not reached within stagnation_window | Change strategy; circuit break if still stagnating |
| `regressing` | pass_rate drops by regression_threshold or more | Immediate circuit break, revert to last good state |

Convergence settings are adjusted in the `convergence` section of `.mpl/config.json` (stagnation_window, min_improvement, regression_threshold).

---

## 6. State Management

### 6.1 State File Structure

```
.mpl/
├── state.json                    # Pipeline state (run_mode, current_phase)
├── config.json                   # Configuration (max_fix_loops, pp_proximity, etc.)
├── pivot-points.md               # Pivot Points
├── discoveries.md                # Discovery log
├── cache/
│   └── phase0/                   # Phase 0 cache
│       ├── manifest.json         # Cache metadata (key, timestamp)
│       ├── api-contracts.md      # Cached API contracts
│       ├── examples.md           # Cached example patterns
│       ├── type-policy.md        # Cached type policy
│       ├── error-spec.md         # Cached error specification
│       ├── summary.md            # Cached Phase 0 summary
│       └── complexity-report.json
└── mpl/
    ├── state.json                # MPL state (phase progress, statistics)
    ├── codebase-analysis.json    # Codebase analysis results
    ├── decomposition.yaml        # Phase decomposition results
    ├── phase-decisions.md        # Accumulated Phase Decisions
    ├── phase0/                   # Phase 0 Enhanced artifacts
    │   ├── api-contracts.md
    │   ├── examples.md
    │   ├── type-policy.md
    │   ├── error-spec.md
    │   ├── summary.md
    │   └── complexity-report.json
    ├── phases/                   # Per-phase artifacts
    │   └── phase-N/
    │       ├── mini-plan.md      # Phase TODO list
    │       ├── state-summary.md  # Completion summary (knowledge transfer)
    │       └── verification.md   # Verification results (with evidence)
    ├── RUNBOOK.md                # Integrated execution log — current state, milestones, decisions, issues, resume info (F-10)
    ├── profile/                  # Token profiling
    │   ├── phases.jsonl          # Per-phase token/time (append-only)
    │   └── run-summary.json     # Full execution profile
    ├── metrics.json              # Final metrics
    └── ../memory/                # Routing memory (F-22)
        ├── routing-patterns.jsonl # Past execution patterns (for tier prediction, append-only)
        └── learnings.md          # Accumulated learnings across runs (F-11)
```

### 6.2 Phase Decision 2-Tier Classification

Phase Decisions are classified into 2 tiers to balance context preservation with token efficiency:

| Tier | Name | Contents | Token Budget | Classification Criteria |
|------|------|----------|----------|----------|
| Tier 1 | Active | Full detail | ~400~800 | PD's affected_files intersects with current phase impact, or PD from a dependency phase |
| Tier 2 | Summary | 1-line summary | ~90~240 | All other decisions |

Total PD token cost: ~2K~5K tokens for a 10-phase project (well within 1M budget).

### 6.3 Discovery Handling

Discoveries reported by Phase Runner are processed in the following order:

1. **PP Conflict Check**: CONFIRMED PP conflict → auto-reject. PROVISIONAL → HITL or auto-approve based on pp_proximity.
2. **PD Override Check**: Request to change past decisions → HITL or auto-approve based on pp_proximity.
3. **General Discovery**: non_pp → apply immediately, pp_adjacent → review at phase transition, pp_core → HITL confirmation required.

All Discoveries are recorded in `.mpl/discoveries.md`.

---

## 7. Hook System

MPL maintains pipeline integrity with 8 hooks:

| Hook | Event | Purpose |
|----|--------|------|
| `mpl-compaction-tracker` | PreCompact | Track compaction events and create checkpoints (F-31) |
| `mpl-auto-permit` | PreToolUse | Learning-based automatic permission allow (F-34) |
| `mpl-write-guard` | PreToolUse (Edit/Write) | Warns against orchestrator directly editing source files when MPL is active |
| `mpl-validate-output` | PostToolUse (Task) | Validates required sections of agent output and tracks token usage |
| `mpl-permit-learner` | PostToolUse | Learn permission allow patterns (F-34) |
| `mpl-phase-controller` | Stop | Manages phase transitions based on state |
| `mpl-session-init` | SessionStart | Initialize Context Rotation at session start (F-38) |
| `mpl-keyword-detector` | UserPromptSubmit | Detects "mpl" keyword in user input and initializes pipeline state |

---

## 8. Configuration Options

The following options are supported in `.mpl/config.json`:

| Option | Default | Description |
|------|--------|------|
| `max_fix_loops` | `10` | Maximum Fix Loop iterations |
| `max_total_tokens` | `900000` | Total token upper limit (v0.6.7: raised from 500K for 1M context) |
| `context_cleanup_window` | `3` | Sliding window size — number of recent phases to retain detailed data (v0.7.0) |
| `gate1_strategy` | `"auto"` | Gate 1 test strategy (auto/docker/native/skip) |
| `hitl_timeout_seconds` | `30` | HITL response wait time |
| `convergence.stagnation_window` | `3` | Fix attempts to evaluate for stagnation (see `config-schema.md`) |
| `convergence.min_improvement` | `5` | Minimum pass_rate improvement % per window |
| `convergence.regression_threshold` | `10` | pass_rate drop % triggering circuit break |
| `e2e_timeout` | `60000` | Timeout per E2E scenario in ms (v0.8.3) |

---

## 9. Version History

### v0.6.7 — 1M Context Parameter Tuning (2026-03-24)

Adapts MPL parameters to the Claude Opus 4.6 1M context window (5× increase from ~200K). The micro-phase structure is preserved for its structural benefits (functional isolation, worker consistency, parallel execution, failure containment). This version tunes constants and token budgets; protocol-level structural changes are deferred to v0.7.0.

| Change | Before (v0.6.6) | After (v0.6.7) | Type | Rationale |
|--------|-----------------|----------------|------|-----------|
| max_total_tokens | 500K | 900K | Code (4 files) | 1M minus ~100K system overhead |
| Impact file cap | 500 lines | 2,000 lines | Prompt (1 file) | Reduce worker errors from truncated files |
| Phase 0 token budget | 8K/12K/20K | 10K/18K/30K | Design guidance | More Phase 0 investment = less Phase 5 debugging |
| Episodic memory retention | Last 2 phases | Last 5 phases | Code (1 file) | Better cross-phase knowledge retention |

**Affected files:**
- `mcp-server/src/lib/state-manager.ts` — max_total_tokens default
- `hooks/lib/mpl-config.mjs` — max_total_tokens default
- `hooks/lib/mpl-state.mjs` — max_total_tokens default + tier-based limits
- `skills/mpl-setup/SKILL.md` — config template
- `hooks/lib/mpl-memory.mjs` — compressEpisodic default + loadRelevantMemory slice
- `commands/mpl-run-execute-context.md` — impact file line cap

### v0.7.0 — 1M Context Protocol Restructuring (2026-03-24)

Structural protocol changes that leverage 1M context for richer cross-phase information flow.

| Change | Before | After | Type | Rationale |
|--------|--------|-------|------|-----------|
| Phase Decision tiers | 3-Tier (Active/Summary/Archived) | 2-Tier (Active/Summary) | Protocol (6+ files) | Tier 3 dropped all decision detail for ~0 token savings |
| Context Cleanup | Immediate full release | Sliding window (N=3 recent phases) | Protocol | ~60-90K retained = ~7-10% of budget |
| Knowledge transfer | State Summary only | State Summary + N-1 phase diff/verification | Protocol | Reduce cross-phase inconsistency |
| Budget predictor fallback | 200K | 1M | Code (1 file) | Match actual context window |
| Safety margin | 1.15× | 1.10× | Code (1 file) | Absolute headroom increased 5× |

**Affected files:**
- `commands/mpl-run-execute-context.md` — PD 2-Tier classification logic, N-1 diff/verification context, `load_prev_phase_diff` pseudocode
- `commands/mpl-run-execute.md` — Archived section removed, diff saving step 2.5, N-1 context template
- `commands/mpl-run-execute-parallel.md` — §4.3.7 sliding window cleanup logic
- `commands/mpl-run-decompose.md` — PD initialization (Active/Summary only)
- `hooks/lib/mpl-budget-predictor.mjs` — fallback 1M, safety margin 1.10
- `skills/mpl/SKILL.md`, `README.md`, `README_ko.md` — 2-Tier documentation updates

**Preserved (unchanged across both versions):** Micro-phase decomposition, orchestrator-worker separation, gate quality system, A/S/H verification, convergence detection, build-test-fix micro-cycle, bounded retries, write guard hook.

Full analysis: `analysis/mpl-1m-context-impact-analysis.md`

### v0.8.0 — Cluster Ralph: Feature-Scoped Verify-Fix Loop (2026-03-25)

Replaces the mechanical B-04 checkpoint system with semantic, feature-aligned cluster verification. Includes 4 quality-of-life improvements.

| Feature | ID | Description | Type |
|---------|-----|-------------|------|
| Cluster Ralph | V-01 | Feature-scoped verify-fix loop with per-cluster E2E and fix loop (max 2) | Core: B-04 evolution |
| Lint Gate | V-02 | Gate 0.5 extended with auto-detection of eslint/ruff/biome/flake8 | Gate extension |
| TSConfig Strict | V-03 | Scaffold phases enforce strict TypeScript baseline | Prompt constraint |
| Config Schema | V-04 | `docs/config-schema.md` — single source of truth for all config fields | Documentation |
| Scope Drift Report | V-05 | Step 5.1.5 — declared vs actual file drift measurement (informational) | Finalize extension |

**Design principles (1M context era):**
- No token optimization — ~220K pipeline usage = 22% of 1M. Plenty of headroom.
- Verify everything — every cluster gets full E2E.
- Fix immediately — fix while context is fresh.
- 2-Layer verification — Phase Runner micro-fix + Cluster Ralph + Final E2E.

**Affected files:**
- `agents/mpl-decomposer.md` — Cluster output schema, clustering rules (Rule 1-7), B-04 legacy compat
- `commands/mpl-run-execute.md` — Step 4.0.1 cluster init, Step 4.4 Cluster E2E + Fix Loop, Step 4.5a Final E2E, execute_scenario helper
- `commands/mpl-run-execute-gates.md` — Gate 0.5 lint auto-detection + execution (V-02)
- `commands/mpl-run-finalize.md` — Step 5.1.5 Scope Drift Report (V-05)
- `agents/mpl-phase-seed-generator.md` *(removed in v0.11.0)* — Step 2.5 TSConfig strict constraint (V-03)
- `prompts/langs/typescript.md` — TSConfig strict baseline (V-03)
- `docs/config-schema.md` — NEW: consolidated config reference (V-04)
- `docs/design.md` — Version bump, v0.8.0 history

**Breaking changes: NONE.** Backward compatible — old `checkpoint: true` format maps to single-phase cluster. Rollback: `cluster_ralph: { enabled: false }` in config.json.

Full spec: `docs/roadmap/v0.6.7-cluster-ralph.md`

### v0.8.1 — Test Strategy + Convention + Regression (2026-03-25)

4 features that strengthen the test pipeline through interview-driven configuration and cross-phase test accumulation.

| Feature | ID | Description | Type |
|---------|-----|-------------|------|
| Test Strategy Interview | Round 1-T | Phase 0 interview asks test verification level → PP → pipeline adapts | Interviewer extension |
| E2E Framework Auto-Insertion | Step 8.6 | Decomposer inserts e2e framework setup phase based on test strategy PP | Decomposer extension |
| Reference File Auto-Selection | #1 alt | Phase Seed finds 2-3 existing files in same directory as convention templates | Phase Seed extension |
| Regression Accumulator | TS-03 | Tests accumulate across phases in `.mpl/regression-suite.json`, run at each phase end + Gate 1 | Test infra |

**Affected files:**
- `agents/mpl-interviewer.md` — Round 1-T (Q-T1 Test Strategy, Q-T2 Coverage Target)
- `agents/mpl-decomposer.md` — Step 8.6 (test strategy PP-driven framework selection)
- `agents/mpl-phase-seed-generator.md` *(removed in v0.11.0)* — Step 2.7 (reference file auto-selection) + `reference_files` output field
- `commands/mpl-run-execute.md` — Step 4.1.6 (regression suite loading) + Step 4.3 item 11 (regression accumulation) + Phase Runner regression context
- `commands/mpl-run-execute-gates.md` — Gate 1 (regression suite execution)

**Breaking changes: NONE.** All features are additive with graceful fallbacks.

### v0.8.3 — E2E Execution Fix (2026-03-26)

3 fixes addressing E2E tests never executing, discovered via Yggdrasil (Tauri app) post-mortem.
Design validated through 2 rounds of Architect/Contrarian/Evaluator team debate.

| Change | Before | After | Type | Rationale |
|--------|--------|-------|------|-----------|
| Step 5.0 E2E Fallback (F-E2E-1) | S-items only | S-items → Cluster E2E → smoke fallback chain | Protocol | Step 3-B skip left 0 E2E scenarios |
| Rule 6 Few-Shot (F-E2E-1b) | "must be executable" text only | + few-shot examples + "build-only" rejection | Prompt | Commands defaulted to `npm run build` |
| GUI App Step 3-B (F-E2E-1c) | Always optional | Mandatory when `src-tauri/` or `electron/` detected | Protocol | Desktop apps need verification planning |

**Affected files:**
- `commands/mpl-run-finalize.md` — Step 5.0 fallback chain
- `agents/mpl-decomposer.md` — Rule 6 few-shot strengthening
- `commands/mpl-run-decompose.md` — Step 3-B GUI app mandatory check

**Breaking changes: NONE.** All changes are additive. No schema changes. Existing decompositions work unchanged.

Analysis: `analysis/yggdrasil-e2e-gap-analysis.md`
Roadmap: `docs/roadmap/pending-features.md` → "E2E Execution Fix" section

### v0.8.4 — Internal Consistency Fix (2026-03-26)

24 contradictions identified through cross-validation audit (Architect/Contrarian/Evaluator team review).
22 fixed, 2 deferred (LOW severity, no behavioral impact).

| Change | Type | Items Fixed |
|--------|------|-------------|
| Phase Runner self-contradiction fix | Prompt | C-1: removed "workers implement" vs "direct implementation" conflict |
| Phase Runner worker references cleanup | Prompt | H-5~7: "worker output" → "implementation output", "dispatching" → "implementing", "concurrent worker limit" → "concurrent implementation limit" |
| Gate 1 pass_rate policy unification | Protocol | H-11: 80-94% range = fix then re-evaluate, final Gate still requires 95% |
| Step 5 renumbering | Protocol | C-3: 5.5 duplicate → 5.1.8 (Post-Execution Review), H-12: 5.4b → 5.3b (PR after Commits, before Metrics) |
| design.md sync | Documentation | 14 items: Step 1-D/1-E/2.4/3-F added, interview depth 3-way, F-39 fields, convergence defaults, Step 3-B mandatory |
| Parallel execution clarification | Documentation | M-7: "dispatch workers" → "implement in parallel batches" |
| e2e_timeout config field | Config | M-9: added to config-schema.md |

**Affected files:**
- `agents/mpl-phase-runner.md` — self-contradiction fix, worker references cleanup
- `commands/mpl-run-finalize.md` — Step 5 renumbering (5.5→5.1.8, 5.4b→5.3b)
- `commands/mpl-run-execute-parallel.md` — worker → TODO terminology
- `docs/design.md` — Full flow table sync, interview depth, convergence defaults
- `docs/config-schema.md` — e2e_timeout field added

**Breaking changes: NONE.** All changes are documentation/prompt corrections. No schema changes.

Audit report: `analysis/mpl-internal-consistency-audit.md`

### v0.8.5 — Artifact Freshness Check + Field Classification (2026-03-27)

Foundation for Field 4 (AI-Built Maintenance) support. Detects .mpl/ artifact existence and freshness, classifies projects into 6 field types.

| Feature | ID | Description | Type |
|---------|-----|-------------|------|
| manifest.json generation | F-FC-1 | Step 5.4.5: track all .mpl/ artifacts (path, hash, timestamp, source, category) | Finalize extension |
| Artifact Freshness Check | F-FC-2 | Step 0.0.5: read manifest.json, compare hashes, calculate freshness_ratio | Triage extension |
| Field Classification | F-FC-3 | 6-way classification: field-1/2/3/4-fresh/4-stale/4-degraded | Triage extension |

**v0.8.5 is observability-only**: field_classification is recorded in state.json but does NOT change Phase 0 behavior. All fields follow the full pipeline. Phase 0 branching (Delta PP, cache shortcuts for field-4-fresh) is planned for v0.9.0.

**Affected files:**
- `commands/mpl-run-phase0.md` — Step 0.0.5 (Freshness Check + Field Classification)
- `commands/mpl-run-finalize.md` — Step 5.4.5 (manifest.json generation)
- `docs/design.md` — Flow table + version history
- `docs/config-schema.md` — manifest.json schema + field_classification table

**Breaking changes: NONE.** manifest.json absence = field-1 (greenfield). Backward compatible.

Analysis: `analysis/mpl-3field-classification.md` → renamed to 4-Field classification

### v0.8.6 — Low-Cost Quality Improvements (2026-03-29)

4 low-cost features: semantic phase hints, PP/PD checklist injection into code review, test parallelization flags, and H-item severity feedback loop. Total additional token cost: ~0.

| Feature | ID | Description | Type |
|---------|-----|-------------|------|
| Semantic Phase Hints | BM-02 | Pipeline completion extracts 1-3 one-line decomposition lessons to semantic.md "Phase Hints" category | Memory extension |
| Gate 2 PP/PD Checklist | BM-05 | Auto-generated PP/PD compliance checklist injected into code reviewer prompt and Gate 2 dispatch | Gate 2 extension |
| Test Parallelization Flags | LT-02 | Phase Runner auto-detects test framework and adds parallel execution flags (vitest, jest, pytest, cargo, go) | Phase Runner extension |
| H-Item Severity Feedback | LT-05 | Track severity reclassifications in Step 5.1.8 → h_item_metrics in state.json for planner accuracy feedback | Finalize + State extension |

**Affected files:**
- `hooks/lib/mpl-memory.mjs` — `addPhaseHint()` function (BM-02)
- `agents/mpl-code-reviewer.md` *(removed in v0.11.0)* — Investigation Protocol Step 1b PP/PD checklist (BM-05)
- `commands/mpl-run-execute-gates.md` — Gate 2 prompt with PP/PD checklist (BM-05)
- `agents/mpl-phase-runner.md` — Step 4 cumulative regression parallel flags table (LT-02)
- `hooks/lib/mpl-state.mjs` — `h_item_metrics` field in DEFAULT_STATE (LT-05)
- `commands/mpl-run-finalize.md` — Step 5.1.8 metrics tracking + Step 5.2.65 phase hint extraction (BM-02, LT-05)

**Breaking changes: NONE.** All features are additive. `h_item_metrics` defaults to zeroes. Phase hints append to existing semantic.md.

### v0.8.7 — Scout Search Path Observability (2026-03-29)

Scout agent now logs its full search trajectory, enabling post-mortem analysis of search quality and failure diagnosis.

| Feature | ID | Description | Type |
|---------|-----|-------------|------|
| Search Trajectory Logging | P-03 | Scout output includes `search_trajectory` array logging every tool call (tool, query, results, selected, note) | Agent output extension |
| Trajectory Persistence | P-03 | Orchestrator saves trajectory to `.mpl/mpl/phases/{phase}/search-trajectory.json` for both Phase 0 and fix loop scouts | Protocol extension |
| Trajectory-Based Retry | P-03 | Fix loop analyzes trajectory on 0-finding scout results to determine retry strategy (wrong pattern, stale QMD, scope too narrow) | Protocol extension |
| Validation | P-03 | `search_trajectory` added to mpl-scout expected sections in validate-output hook | Hook extension |

**Affected files:**
- `agents/mpl-scout.md` *(removed in v0.11.0)* — Output_Format extended with `search_trajectory` array + documentation
- `commands/mpl-run-execute-gates.md` — Fix loop scout trajectory save + failure analysis
- `commands/mpl-run-phase0-analysis.md` — Phase 0 scout trajectory save
- `hooks/mpl-validate-output.mjs` — `search_trajectory` added to mpl-scout expected sections

**Breaking changes: NONE.** `search_trajectory` is additive. Existing scout outputs without it still validate (findings is the primary required field).

### v0.8.8 — State Summary L0/L1/L2 Tiering (2026-03-29)

Dependency-based compression for state summaries. Instead of loading all dependency phase summaries at full resolution, loads at 3 tiers based on relationship to current phase. Expected ~50-60% token reduction for 10+ phase projects.

| Feature | ID | Description | Type |
|---------|-----|-------------|------|
| L0/L1/L2 Summary Tiering | P-01 | 3-tier loading: L0 (~20tok, 1-line) for distant phases, L1 (~200tok, files+interfaces) for overlapping phases, L2 (~800tok, full) for direct dependencies | Protocol extension |
| State Summary Structure | P-01 | Phase Runner output restructured with ordered sections (Summary → Files Changed → Interface Changes → Phase Decisions → Verification Results) for mechanical L0/L1 extraction | Agent prompt extension |
| Context Assembly Update | P-01 | `load_dependency_summaries()` rewritten with 3-tier classification logic | Protocol extension |
| Phase Runner Prompt Update | P-01 | Dependency summaries injected as L0/L1/L2 grouped sections | Prompt extension |

**Affected files:**
- `commands/mpl-run-execute-context.md` — `load_dependency_summaries()` rewritten with L0/L1/L2 classification
- `agents/mpl-phase-runner.md` — `State_Summary_Required_Sections` restructured for mechanical extraction
- `commands/mpl-run-execute.md` — Phase Runner prompt template uses L0/L1/L2 grouped sections

**Breaking changes: NONE.** Old state-summary.md files without the new section structure are loaded as L2 (full detail) by default. New structure is backward compatible.

### v0.9.0 — Prompt Reinforcement: Yggdrasil-Validated Patterns (2026-03-29)

5 prompt-only enhancements that concretize abstract review categories with grep-verifiable patterns. All derived from Yggdrasil 27-phase test post-mortem. Total additional token cost: ~300 (grep calls in PR-02/PR-03 only).

| Feature | ID | Description | Type |
|---------|-----|-------------|------|
| Transaction Boundary | PR-01 | db.md: 2+ DB mutations in one function must be transaction-wrapped | Domain prompt + Verification planner |
| Security Grep Patterns | PR-02 | Code reviewer Security category: 4 concrete grep patterns (weak random, CSP, secrets, SQLi) | Agent prompt |
| UI Hardcoding Detection | PR-03 | Code reviewer Design System category: hex color grep + dark mode gap detection | Agent prompt |
| Resource Lifecycle Pairs | PR-04 | Code reviewer Correctness category: open/close, create/destroy lifecycle pair verification | Agent prompt |
| Strict Mode + unwrap Audit | PR-05 | Phase 0 Error Spec Step 4: tsconfig strict check + Rust unwrap count + Go error ignore scan | Phase 0 extension |

**Affected files:**
- `prompts/domains/db.md` — transaction wrapping rule (PR-01)
- `agents/mpl-code-reviewer.md` *(removed in v0.11.0)* — Security, Correctness, Design System categories (PR-02, PR-03, PR-04)
- `agents/mpl-phase0-analyzer.md` — Step 4 Error Spec strict/unwrap checks (PR-05)
- `agents/mpl-verification-planner.md` *(removed in v0.11.0)* — A-TX auto-insert for DB phases (PR-01)

**Breaking changes: NONE.** All changes are prompt text additions. No schema, protocol, or config changes.

### v0.9.1 — Cross-Boundary Detection (2026-03-29)

4 features for detecting cross-language boundary contract mismatches. Source: yggdrasil-exp2 experiment (200 tests pass, 9 CRITICAL cross-boundary bugs found).

| Feature | ID | Description | Type |
|---------|-----|-------------|------|
| Boundary Pair Scan | CB-01 | Phase 0 Step 1b: grep-based detection of caller↔callee pairs across languages (Tauri invoke, REST, JSON-RPC) | Phase 0 extension |
| Decomposer Rule 8 | CB-02 | Boundary-pair awareness: paired files should share a phase, 2-phase split if size exceeds L | Decomposer rule |
| Gate 0.7 Advisory | CB-03 | Static verification of parameter name/type matching across boundaries (non-blocking advisory) | New gate |
| Mock Gap Flagging | CB-04 | Auto-flag verification gaps where mocked IPC prevents serde validation | Verification planner extension |

**Affected files:**
- `agents/mpl-phase0-analyzer.md` — Step 1b Boundary Pair Scan (CB-01)
- `agents/mpl-decomposer.md` — Rule 8 boundary-pair awareness (CB-02)
- `commands/mpl-run-execute-gates.md` — Gate 0.7 section (CB-03)
- `docs/design.md` — Gate table updated with Gate 0.7 (CB-03)
- `agents/mpl-code-reviewer.md` *(removed in v0.11.0)* — Step 4.5 gate-0.7 integration (CB-03)
- `commands/mpl-run-finalize.md` — Gate 0.7 warning aggregation (CB-03)
- `agents/mpl-verification-planner.md` *(removed in v0.11.0)* — Section 5.5 mock boundary gaps (CB-04)

**Breaking changes: NONE.**

### v0.9.2 — Cross-Boundary Enforcement (2026-03-29)

3 features converting cross-boundary verification from behavioral instruction to structural enforcement. Design principle: "Instruct less, structure more" — instruction→schema transition.

| Feature | ID | Description | Type |
|---------|-----|-------------|------|
| ~~boundary_check Required Output~~ | ~~CB-05~~ | ~~Worker output schema: mandatory `boundary_check` field.~~ **Replaced by CB-08 L1 in v0.9.3.** LLM self-report was unreliable (exp3 showed 3 CB bugs despite CB-05 being "done"). | ~~Worker schema~~ → Deprecated |
| Contract Snippet Injection | CB-06 | Decomposer extracts 3-5 line targeted contract excerpts per phase (reduces context competition vs full 2000-token contract) | Decomposer extension |
| ~~Post-Join Reconciliation~~ | ~~CB-07~~ | ~~Cross-validate boundary_check assertions between phases.~~ **Replaced by CB-08 L2 in v0.9.3.** Now uses shell-based key extraction instead of LLM boundary_check output. | ~~Orchestrator~~ → Deprecated |
| **Contract Registry (L0)** | **CB-08** | **Phase 0 generates `.mpl/contracts/*.json` per boundary. Minimal key-type registries (NOT JSON Schema). SSOT for L1/L2 verification.** | **Decomposer + Phase 0** |
| **Diff Guard (L1)** | **CB-08** | **PostPhase hook: `jq keys + comm` compares contract vs implementation keys. $0 cost. Catches parameter name mismatches (`content` vs `text`).** | **Phase Runner Step 4.57** |
| **Semantic Verify (L2)** | **CB-08** | **Post-Join: extracts keys from both sides of boundary via grep, diffs them. Catches Python↔DB field gaps (`real_order` missing).** | **Orchestrator protocol** |

**Design principle (CB-08):** "LLM generates contracts, machines enforce them." All verification is shell-based ($0, no LLM calls).

**Affected files:**
- `agents/mpl-decomposer.md` — Step 6.5: Contract Registry generation (CB-08 L0) + contract_snippet (CB-06)
- `agents/mpl-phase-runner.md` — Step 4.57: Mechanical L1 Diff Guard (CB-08, replaces CB-05)
- `commands/mpl-run-execute.md` — Step 4.0.6: Semantic L2 verification (CB-08, replaces CB-07)

**Breaking changes:** CB-05 `boundary_check` Worker output field is **deprecated**. Multi-layer phases no longer require this field. Verification is now external (shell-based) rather than internal (LLM self-report).

### v0.9.3 — Mechanical Boundary Verification (CB-08) (2026-03-29)

Replaces CB-05/CB-07's LLM-dependent verification with shell-based mechanical verification. Motivated by exp3 (Yggdrasil v2) where 210 tests passed but 3 cross-boundary bugs were found — CB-05 `boundary_check` was filled correctly by LLM but the actual code was wrong.

| Change | Before (v0.9.2) | After (v0.9.3) | Type | Rationale |
|--------|-----------------|----------------|------|-----------|
| L0: Contract Registry | api-contracts.md (prose) | `.mpl/contracts/*.json` (key-type pairs) | Decomposer | Machine-parseable SSOT for verification |
| L1: PostPhase Diff Guard | CB-05 boundary_check (LLM self-report) | `jq keys + comm` shell verification | Phase Runner | LLM self-report unreliable (exp3 evidence) |
| L2: Post-Join Semantic | CB-07 boundary_check cross-validation | Shell-based key extraction + diff | Orchestrator | No LLM dependency, $0 cost |
| CB-05 boundary_check | Required output field | **Deprecated** | Worker schema | Replaced by mechanical L1 |

**Affected files:**
- `agents/mpl-decomposer.md` — Step 6.5 rewritten for Contract Registry generation
- `agents/mpl-phase-runner.md` — Step 4.57 rewritten for L1 Diff Guard
- `commands/mpl-run-execute.md` — Step 4.0.6 rewritten for L2 Semantic Verify

**Breaking changes:** `boundary_check` Worker output field deprecated. Phases no longer need to produce this field.

**Evidence:** `analysis/mpl-exp3-report.md`, `analysis/mpl-cross-boundary-final-consensus.md`

### v0.9.4 — Pre-v2 Cleanup (2026-03-29)

Documentation-only release. No code changes. Prepares the codebase for v2 structural changes (v0.10.0+).

| Change | Description | Type |
|--------|-------------|------|
| Worker agent removal | `mpl-worker.md` deleted. All references updated to `mpl-phase-runner` direct implementation. Worker was unused since v0.6.0 due to nested agent limitation. | Agent deletion |
| Principle 1 rename | "Orchestrator-Worker Separation" → "Orchestrator–Phase Runner Separation". Reflects actual architecture. | Design principle |
| Principle 5 update | "Knowledge Accumulation" → "Knowledge Accumulation via Channel Registry". Introduces Channel Registry concept for v0.10.0 preparation. | Design principle |
| Version notation disambiguation | Added version mapping note (v3.x ≈ v0.3.x). design.md uses v0.x.y exclusively; legacy notation preserved in historical roadmap files. | Documentation |
| `boundary_check` cleanup | Deprecated field references removed from worker schema (file deleted), pending-features.md annotated. | Schema cleanup |

**Affected files:**
- `agents/mpl-worker.md` — **Deleted**
- `docs/design.md` — Principles 1 & 5, Agent Catalog, version notation
- `agents/mpl-phase-runner.md` — Removed nested agent limitation notes
- `agents/mpl-test-agent.md` *(removed in v0.11.0)*, `agents/mpl-doctor.md` — Worker references removed
- `commands/mpl-run.md`, `mpl-run-execute.md`, `mpl-run-execute-gates.md`, `mpl-run-execute-parallel.md` — Worker → Phase Runner
- `skills/mpl/SKILL.md`, `skills/mpl-small/SKILL.md`, `skills/mpl-bugfix/SKILL.md` — Worker → Phase Runner
- `hooks/mpl-write-guard.mjs`, `hooks/mpl-validate-output.mjs` — Worker references removed
- `hooks/__tests__/mpl-validate-output.test.mjs` — Test cases updated
- `README.md`, `README_ko.md` — Worker → Phase Runner
- `docs/roadmap/overview.md`, `docs/roadmap/phase2-incremental.md`, `docs/roadmap/pending-features.md` — Worker references updated
- `docs/deepagent-comparison.md` — Example agent names updated

**Breaking changes:** `mpl-worker` agent no longer exists. Pipelines referencing `subagent_type="mpl-worker"` must use `subagent_type="mpl-phase-runner"`.

### v0.10.0 — Mechanical Boundary Foundation (v2 Phase 1) (2026-03-29)

7 features establishing the mechanical enforcement layer for cross-boundary safety.

| Feature | ID | Description | Type |
|---------|-----|-------------|------|
| Channel Registry | KT-01 | 9 registered knowledge channels in Principle 5. Unregistered channels prohibited. | Protocol |
| Contract Registry Enhancement | CB-L0 | `adjacent_contracts` field in Decomposer interface_contract. Enables Seed Generator to load N-1/N+1 contracts. | Decomposer extension |
| Seed Input Extension | SEED-01 | Seed Generator receives `.mpl/contracts/*.json` for current + adjacent phases. | Agent input |
| Seed Output Extension | SEED-02 | `contract_snippet` field in phase-seed.yaml with inbound/outbound key-type pairs. | Agent output |
| Seed Schema Validation | SEED-03 | `mpl-validate-seed.mjs` hook validates required fields + contract_snippet structure. | Hook (new) |
| Seed Fact-Check | SNT-S0 | `mpl-sentinel-s0.mjs` hook verifies contract_snippet keys ⊆ contracts/*.json keys. Catches LLM hallucination. | Hook (new) |
| Runner Manifest Validation | SNT-S1 | `mpl-sentinel-s1.mjs` hook validates export-manifest.json symbols exist in generated files. | Hook (new) |
| Test Import Validation | SNT-S3 | `mpl-sentinel-s3.mjs` hook validates Test Agent import paths resolve to actual files. | Hook (new) |
| L1 Hard Gate | CB-L1 | L1 Diff Guard upgraded from advisory to Hard Gate. Boundary mismatches block Phase completion. | Gate change |

**New files:**
- `hooks/mpl-validate-seed.mjs` — SEED-03
- `hooks/mpl-sentinel-s0.mjs` — SNT-S0
- `hooks/mpl-sentinel-s1.mjs` — SNT-S1
- `hooks/mpl-sentinel-s3.mjs` — SNT-S3

**Modified files:**
- `docs/design.md` — Channel Registry, Gate table, changelog
- `agents/mpl-decomposer.md` — adjacent_contracts (CB-L0)
- `agents/mpl-phase-seed-generator.md` *(removed in v0.11.0)* — contract_files input, contract_snippet output (SEED-01/02)
- `agents/mpl-phase-runner.md` — export-manifest generation, L1 Hard Gate (CB-L1)
- `agents/mpl-test-agent.md` — S3 validation note
- `commands/mpl-run-execute.md` — Seed validation + Sentinel steps
- `commands/mpl-run-execute-gates.md` — L1 Hard Gate documentation

**Breaking changes:** L1 Diff Guard is now a Hard Gate. Boundary-crossing phases that fail L1 cannot complete (previously advisory warning only).

### v0.10.1 — MCP Path Fix (2026-03-30)

Bugfix: MCP server path resolution in `.mcp.json`.

| Change | Before | After | Type | Rationale |
|--------|--------|-------|------|-----------|
| .mcp.json args path | `mcp-server/dist/index.js` (relative) | `${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.js` (absolute via env var) | bugfix | Plugin MCP server failed to start because relative path resolved against CWD, not plugin root. `${CLAUDE_PLUGIN_ROOT}` is expanded by Claude Code at runtime to the correct plugin installation directory. |

**Affected files:** `.mcp.json`
**Breaking changes:** NONE

### v0.12.1 — v2 Completion: Agent Deletion + Terminology Cleanup (2026-04-04)

| Change | Before | After | Type | Rationale |
|--------|--------|-------|------|-----------|
| Delete 7 agents per 17→8 plan | 7 agent .md files still existed | Deleted: code-reviewer, compound, phase-seed-generator, pre-execution-analyzer, qa-agent, scout, verification-planner | cleanup | v0.11.0 consolidated to 8 agents but files remained |
| v1→v2 terminology migration | `gate1/gate2/gate3`, `pipeline_tier`, `5-Gate` in 38 files | `hard1/hard2/hard3`, `pp_proximity`, `3H+1A Gate` | refactor | Code and docs now use consistent v2 terms |
| routing-patterns backward compat | No fallback | `p.proximity \|\| p.tier` | bugfix | Prevent breakage during gradual migration |
| MCP dist rebuild | Old v1 schema fields | v2 schema (ambiguity_score, advisory_result) | cleanup | TypeScript types match runtime state |
| Version history annotations | Deleted agent paths referenced as current | Annotated with *(removed in v0.11.0)* | docs | Prevent confusion in version history |

**Affected files:** 38 files — agents/ (7 deleted), hooks/ (tests, routing-patterns), mcp-server/dist/, docs/, skills/, commands/, README
**Breaking changes:** NONE (all agent files were already unused since v0.11.0)

### v0.12.0 — Harness Analysis Adoption: Adversarial Verification + Platform Safety (2026-03-31)

| Change | Before | After | Type | Rationale |
|--------|--------|-------|------|-----------|
| HA-01: Synthesis-first delegation | No delegation quality enforcement | Core Rule #5: lazy delegation anti-patterns prohibited (4 patterns listed) | feature | Claude Code Coordinator pattern — prevents "based on your findings" style prompts that delegate understanding |
| HA-02: Adversarial verification prompt | Test Agent had no bias mitigation | Self-rationalization anti-patterns (5 patterns) + structured verification output (Test/Expected/Actual/Verdict) | feature | Claude Code Verification Agent + Anthropic blog: LLMs systematically rationalize away discovered issues |
| HA-03: Seed probing hints | No adversarial testing guidance in Seed | `probing_hints` optional field in phase_seed.yaml — domain-specific + platform constraint hints | feature | exp5 B-1: Tauri WebView `window.prompt()` blocked but not tested. Probing hints provide safety net |
| HA-04: Export manifest warnings | No mechanism for unexpected findings between phases | `warnings` field in Phase Runner output + State Summary `## Warnings` section + orchestrator Step 5.5 processing | feature | Alternative to Scratchpad (rejected for violating channel registry principle) — registered channel for ad-hoc findings |
| HA-05: Seed self-verification + Platform MND | Seed Generator had no self-check or platform awareness | 5-item self-verification checklist (Step 9) + Platform MND auto-injection (Step 8.7) from config file detection | feature | exp5 B-1~B-3: MND lacked platform constraints → Runner used browser APIs blocked in Tauri WebView |

**Affected files:** `commands/mpl-run.md`, `agents/mpl-test-agent.md`, `agents/mpl-phase-seed-generator.md` *(removed in v0.11.0)*, `agents/mpl-phase-runner.md`, `commands/mpl-run-execute.md`, `docs/design.md`
**Breaking changes:** NONE
**Source analysis:** `analysis/mpl-adoption-candidates-debate.md`, `analysis/instructkr-claude-code-analysis.md`, `analysis/anthropic-harness-design-longrunning.md`

### v0.11.3 — Sentinel Activation + Platform Constraints (2026-03-31)

| Change | Before | After | Type | Rationale |
|--------|--------|-------|------|-----------|
| Sentinel hooks registration | S0/S1/S3/validate-seed files existed but not in hooks.json | All 4 registered in PostToolUse with appropriate matchers | fix | Sentinel hooks were dead code — never executed despite being implemented in v0.10.0 |
| Phase 0 Step 5: Platform Constraints | No platform constraint awareness | Step 5 generates platform-constraints.md from LLM knowledge of tech stack | feature | exp5: window.prompt() blocked in Tauri WebView but Phase Runner didn't know (B-1 bug) |
| Finalize protocol load enforcement | phase-controller silently entered finalize | system-reminder forces orchestrator to read gate/finalize protocols + check platform-constraints | fix | exp1/exp5: finalize protocol never loaded, E2E rules were dead letter |

**Affected files:** `hooks/hooks.json`, `agents/mpl-phase0-analyzer.md`, `hooks/mpl-phase-controller.mjs`
**Breaking changes:** NONE

### v0.11.2 — Ambiguity Gate Enforcement (2026-03-31)

| Change | Before | After | Type | Rationale |
|--------|--------|-------|------|-----------|
| Stage 1/2 separation | mpl-interviewer "Unified" (PP + Ambiguity) | mpl-interviewer=Stage 1 (PP only), mpl-ambiguity-resolver=Stage 2 (separate Task) | fix | Ambiguity scoring was silently skipped because unified agent only did PP discovery |
| MCP-based scoring | Agent self-scores ambiguity inline | mpl_score_ambiguity MCP tool mandatory, self-scoring prohibited | feature | External LLM (haiku) + code-computed weights ensure objective, deterministic scoring |
| Ambiguity Gate hook | No gate before decomposition | PreToolUse hook (mpl-ambiguity-gate.mjs) blocks Task(mpl-decomposer) if score missing or > 0.2 | feature | Prevents decomposition without ambiguity resolution |
| Phase controller cases | No mpl-init/mpl-decompose/mpl-ambiguity-resolve handling | Stop hook checks score at mpl-decompose, auto-reverts to mpl-ambiguity-resolve if threshold not met | feature | Dual-layer gate (PreToolUse L1 + Stop L2) |
| State schema | No ambiguity_score field | ambiguity_score: number \| null added to MplState + DEFAULT_STATE | schema | Required for gate enforcement |
| Validate output | mpl-ambiguity-resolver not validated | Added to VALIDATE_AGENTS with expected sections | fix | Stage 2 output now validated by PostToolUse hook |

**Affected files:** `agents/mpl-interviewer.md`, `agents/mpl-ambiguity-resolver.md`, `commands/mpl-run-phase0.md`, `hooks/mpl-ambiguity-gate.mjs` (new), `hooks/mpl-phase-controller.mjs`, `hooks/mpl-validate-output.mjs`, `hooks/hooks.json`, `hooks/lib/mpl-state.mjs`, `mcp-server/src/lib/state-manager.ts`
**Breaking changes:** NONE

### v0.11.1 — MCP Server Dependency Recovery (2026-03-31)

| Change | Before | After | Type | Rationale |
|--------|--------|-------|------|-----------|
| MCP setup dep recovery | Check `node_modules` existence only | Import verification + auto-reinstall + full rebuild fallback | fix | Plugin cache installs dist/ without node_modules, causing MCP server startup failure |

**Affected files:** `skills/mpl-setup/SKILL.md`
**Breaking changes:** NONE

### v0.11.0 — v2 Phase 2: Structural Transition (2026-03-31)

| Change | Before | After | Type | Rationale |
|--------|--------|-------|------|-----------|
| Gate restructuring | 6 Gates (0.5/0.7/1/1.5/1.7/2/3) | 3 Hard + 1 Advisory | structural | Probabilistic gates merged, mechanical gates separated |
| Hat model | maturity_mode × pipeline_tier | PP-proximity (near/mid/far) | structural | Single axis simplification |
| Agent consolidation | 16 agents | 8 agents | structural | 8 agents deleted, core logic absorbed |
| Phase Runner | ~718 lines | 171 lines | reduction | Seed-based execution, domain awareness removed |
| Decomposer | ~662 lines | 186 lines | reduction | Verification planner + pre-execution analyzer absorbed |
| Interviewer | ~509 lines | 355 lines | absorption | Ambiguity resolver merged |
| Cluster Ralph | Active | Removed | removal | Replaced by Hat model PP-proximity |
| Redecomposition | max 2 redecompositions | Removed (circuit break → mpl-failed) | removal | Phase-level retry only principle |
| Reflexion | 5-stage template | 4-stage template | simplification | Divergence Point removed |

**Affected files:** 50 files (agents, commands, hooks, skills, docs, mcp-server)
**Breaking changes:** Gate structure, agent names, state schema (pipeline_tier → pp_proximity)

### v0.10.2 — Skill Quality Polish (2026-03-30)

T-11: Skill description/structure consistency improvement across all 12 built-in skills.

| Change | Before | After | Type | Rationale |
|--------|--------|-------|------|-----------|
| Description trigger hints | Generic functional descriptions only | 3-tier trigger classification: strong (4), weak (3), command-only (3) | feature | Improve skill triggering accuracy — skills now declare when they should/shouldn't auto-trigger |
| Deprecated skill stub | mpl-bugfix (76 lines), mpl-small (64 lines) with full protocol | 7-line redirect stubs | cleanup | Reduce unnecessary context consumption for deprecated skills |
| mpl-setup references/ split | 612-line monolithic SKILL.md | 392 lines + 3 reference files (qmd-setup, rotation-setup, mcp-setup) | refactor | Keep SKILL.md under 500-line recommendation for progressive disclosure |

**Affected files:** `skills/*/SKILL.md` (all 12 skills), `skills/mpl-setup/references/` (3 new files)
**Breaking changes:** NONE

---

## 10. Known Issues and Remaining Work

> Last audit date: 2026-03-05. Items below were identified through cross-validation between codebase and documentation.

### CRITICAL — Affects Pipeline Integrity

| ID | Item | Detail | Location | Status |
|----|------|------|------|------|
| I-01 | ~~Ghost agent `mpl-research-synthesizer`~~ | Removed from `VALIDATE_AGENTS` Set and `EXPECTED_SECTIONS`. | `hooks/mpl-validate-output.mjs` | **Resolved** (2026-03-05) |
| I-02 | ~~mpl-run.md Related Skills table duplication~~ | Duplicate `/mpl:mpl` row removed, cleaned up to single registration. | `commands/mpl-run.md` | **Resolved** (2026-03-05) |

### HIGH — Missing Features

| ID | Item | Detail | Location | Status |
|----|------|------|------|------|
| I-03 | ~~Skill `/mpl:mpl-bugfix` not implemented~~ | `skills/mpl-bugfix/SKILL.md` created. Lightweight bug fix pipeline. | `skills/mpl-bugfix/SKILL.md` | **Resolved** (2026-03-05) |
| I-04 | ~~Skill `/mpl:mpl-small` not implemented~~ | `skills/mpl-small/SKILL.md` created. 3-Phase lightweight pipeline. | `skills/mpl-small/SKILL.md` | **Resolved** (2026-03-05) |
| I-05 | ~~Skill `/mpl:mpl-compound` wrapper missing~~ | `skills/mpl-compound/SKILL.md` created. Standalone learning extraction. | `skills/mpl-compound/SKILL.md` | **Resolved** (2026-03-05) |
| I-06 | ~~Skill `/mpl:mpl-gap-analysis` wrapper missing~~ | `skills/mpl-gap-analysis/SKILL.md` created. Standalone gap analysis. | `skills/mpl-gap-analysis/SKILL.md` | **Resolved** (2026-03-05) |
| I-07 | ~~`mpl-validate-output` agent list incomplete~~ | Added `mpl-decomposer`, `mpl-git-master`, `mpl-compound` to VALIDATE_AGENTS and EXPECTED_SECTIONS. | `hooks/mpl-validate-output.mjs` | **Resolved** (2026-03-05) |

### MEDIUM — Unimplemented Roadmap Features

| ID | Item | Detail | Status |
|----|------|------|------|
| I-08 | ~~Automatic API extraction (AST parser)~~ | `mpl-test-analyzer.mjs` implemented. Extracts function calls, pytest.raises, assert, fixture. | **Resolved** (2026-03-05) |
| I-09 | ~~Automatic pattern analysis (pattern detector)~~ | `mpl-pattern-detector.mjs` implemented. Automatic classification into 7 categories. | **Resolved** (2026-03-05) |

### LOW — Improvements

| ID | Item | Detail | Status |
|----|------|------|------|
| I-10 | ~~Convergence state naming inconsistency~~ | Unified `stagnant` → `stagnating`, `regression` → `regressing`. | **Resolved** (2026-03-05) |
| I-11 | ~~Phase 0 cache validation code missing~~ | `mpl-cache.mjs` implemented. Cache key generation, hit/miss determination, save/read utilities. | **Resolved** (2026-03-05) |
| I-12 | ~~Token profiling aggregation tool missing~~ | `mpl-profile.mjs` implemented. JSONL parsing, aggregation statistics, anomaly detection, text report. | **Resolved** (2026-03-05) |
| I-13 | ~~Triage logic not reflected in hook~~ | Added `interview_depth` guard on `phase2-sprint` entry in `mpl-phase-controller.mjs`. | **Resolved** (2026-03-05) |
