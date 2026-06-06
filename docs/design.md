# MPL (Micro-Phase Loop) v0.19.0 Design Document

## 1. Overview

MPL is an autonomous coding pipeline that decomposes user requests into ordered **micro-phases**. Each phase runs in an isolated session with only structured context, preventing context pollution that occurs during long-running executions.

> **Version notation**: Early roadmap documents used a separate major-version series (v1.0, v3.0, v4.0) for design milestones. The actual release versions follow the `v0.x.y` semver series. Mapping: v1.0 = initial design, v3.0 ≈ v0.3.0, v4.0 ≈ v0.4.0. This document uses v0.x.y exclusively; legacy v3.x/v4.x references remain in historical roadmap files.

The current architecture (v0.3.0+) evolved from the initial 5-step·5-agent structure to a **9+ step pipeline**. Key changes:

| Area | Initial (v1.0) | Current |
|------|------|------|
| Pipeline Steps | 5 steps (Step 0~5) | 9+ steps (Step 0~6 + sub-steps) |
| Agents | 5 | 11 |
| Pre-Analysis | None | Phase 0 Enhanced (Triage REMOVED in v0.17) |
| Quality System | Simple verification | Build-Test-Fix + 3 Hard Gates + A/S/H classification + Convergence Detection |
| Caching | None | Phase 0 artifact caching |
| Token Profiling | None | Per-phase token/time profiling |

> **Detailed procedures** are defined in `mpl-run.md` (orchestration protocol). This document covers concepts, structure, and policy.

---

## 2. Design Principles

### Principle 1: Orchestrator–Phase Runner Separation

The orchestrator **never writes source code directly.** All code changes are executed by `mpl-phase-runner` agents dispatched via the Task tool. The `mpl-write-guard` PreToolUse hook provides advisory warnings for in-scope edits and BLOCKS unsafe direct source edits (Move #6 Bash bypass closure, #236 protected SKILL paths).

### Principle 2: Plan First

Execution begins only after phase decomposition. The decomposition artifact (`decomposition.yaml`) is the single source of truth (SSOT), containing ordered phases and interface contracts.

### Principle 3: Test-Based Verification

Each phase has machine-verifiable success criteria. Subjective "done" declarations are not permitted; only evidence-based verification (command exit codes, test results, file existence, grep patterns) is accepted.

> **Verification Evidence Policy (v0.14.2+):** Only machine-verifiable evidence is accepted — command exit codes, test results, file existence, and grep patterns. Earlier releases allowed `qmd_verified` (QMD semantic search + grep cross-check); that type was retired when QMD integration was removed.

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
mpl-init → mpl-decompose → phase2-sprint → phase3-gate → phase5-finalize → completed
                              ↑    ↑            │
                              │    └── phase4-fix
                              └─── (next phase) ┘
```

- **Retry**: Phase Runner retries internally based on PP-proximity (PP-core 3, PP-adjacent 2, Non-PP 1). The orchestrator receives only `"complete"` or `"circuit_break"`.
- **Circuit break**: Transitions to `phase5-finalize` (partial completion). Completed phases are preserved.

### 3.2 Full Flow Summary Table

> **v0.17 status note**: rows below preserved as historical record; the
> v0.17 simplification (#55) removed Step -1 (moved to `hooks/mpl-lsp-warmup.mjs`),
> Step 0.0.5 (artifact freshness + field classification), and Step 0 Triage
> (interview_depth + pp_proximity scoring). Step 1 PP Interview is now Stage 1
> inside `commands/mpl-run-phase0.md` Step 1 Interview Block; Steps 1-D / 1-E
> are absorbed into Stage 1.9 Interview Snapshot. See `commands/mpl-run-phase0.md`
> for the canonical v0.17 flow.

| Step | Name | Core Agent | Artifact | Status |
|------|------|-------------|--------|--------|
| -1 | LSP Warm-up *(v0.17: hook)* | `hooks/mpl-lsp-warmup.mjs` (UserPromptSubmit) | `state.lsp_servers` | (REMOVED) |
| 0.0.5 | Artifact Freshness + Field Classification *(v0.17: REMOVED)* | — | (was: `.mpl/manifest.json`) | (REMOVED) |
| 0 | Triage *(v0.17: REMOVED)* | — | (was: interview_depth, pp_proximity) | (REMOVED) |
| 1 | PP Interview | mpl-interviewer | `.mpl/pivot-points.md` | active |
| 1-D | PP Confirmation *(v0.17: absorbed into Stage 1.9)* | (orchestrator) | PP final confirmation with user | (REMOVED) |
| 1-E | Interview Snapshot Save *(v0.17: Stage 1.9)* | (orchestrator) | `.mpl/mpl/interview-snapshot.md` | (REMOVED) |
| 2 | Codebase Analysis | (orchestrator) | `.mpl/mpl/codebase-analysis.json` | active |
| 2.4 | Architecture Decision Checklist | (orchestrator) | Key architecture decisions documented | active |
| 2.5 | Phase 0 Enhanced | (orchestrator) | `.mpl/mpl/phase0/*.md` | active |
| 3 | Phase Decomposition | mpl-decomposer | `.mpl/mpl/decomposition.yaml` | active |
| 4 | Phase Execution Loop | mpl-phase-runner (direct impl) | Per-phase artifacts | active |
| 5 | E2E & Finalization | mpl-git-master | E2E (3-tier fallback v0.8.3), commits, metrics, **manifest.json (v0.8.5)** | active |
| 6 | Resume Protocol | (orchestrator) | Resume from interrupted phase | active |

> See closed issue #55 and the roadmap index for the full history of removed steps.

### 3.3 Step-by-Step Description

#### Step 0: Triage *(v0.17 REMOVED — entire step deleted; both `interview_depth` and `pp_proximity` are no longer computed. Body preserved as historical reference; current pipeline enters Stage 1 directly with full-equivalent interview depth and no hat selection. See closed issue #55.)*

Analyzes the **information density** of the user prompt to determine interview depth and PP-proximity (Hat model). Counts the number of explicit constraints, specific files, measurable criteria, and tradeoff choices.

| interview_depth | Condition | Interview Behavior |
|-----------------|------|-----------|
| `light` | Density 4-7 | Round 1 (What) + Round 2 (What NOT) only |
| `light` + scan | Density 8+ | What + What NOT + Uncertainty Scan |
| `full` | Density below 4 (ambiguous/broad) | Full 4-round PP interview |

**PP-Proximity Classification (Hat Model)** — Replaces the previous `pipeline_tier` (frugal/standard/frontier) and `maturity_mode` (explore/standard/strict) systems with a single dimension:

| PP-Proximity | Condition | Pipeline Behavior |
|-------------|-----------|-------------------|
| `pp_core` | Task directly implements a Pivot Point | Full interview + all hard gates |
| `pp_adjacent` | Task relates to PP but not a direct implementation | Abbreviated interview + hard gates |
| `non_pp` | Task is unrelated to any PP (refactoring, chores) | Minimal interview + hard gates |

#### Step 1: PP Interview + PP Confirmation

This step consists of 2 sub-steps:

**Step 1: PP Interview** — `mpl-interviewer` (opus) discovers Pivot Points through a structured 4-Round interview. *(v0.17: interview always runs at full-equivalent depth — Triage `interview_depth` no longer adjusts scope.)* Interview scope is adjusted based on Triage's `interview_depth` (light: Round 1~2 only, full: all 4 rounds). PP status is classified as CONFIRMED (hard constraint, auto-reject on conflict) or PROVISIONAL (soft, HITL on conflict). The interviewer also handles ambiguity resolution and pre-execution gap analysis inline, consolidating what was previously 3 separate agents (mpl-interviewer, mpl-ambiguity-resolver, mpl-pre-execution-analyzer) into a single opus call.

**Step 1-D: PP Confirmation** *(v0.17: absorbed into Stage 1.9 single confirmation gate inside the interview)* — Finalizes PP. Asks the user additional questions as needed.

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
- Success criteria (typed: command/test/file_exists/grep/description)
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

**4.4 Circuit Break** — When circuit break occurs, the pipeline transitions to `phase5-finalize` (partial completion). Completed phases are preserved; the failure report includes what succeeded and what failed.

**4.5 Gate System (3 Hard)** — After all phases complete, must pass 3 Hard Gates to proceed to finalization (see §5 Quality System for details).

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
| Progress state | `.mpl/state.json` → `execution` subtree (P2-6; legacy `.mpl/mpl/state.json` auto-migrated on read) |
| Pivot Points | `.mpl/pivot-points.md` |

---

## 4. Agent Catalog

MPL uses 11 specialized agents in the active catalog (v0.18.x additions: mpl-adversarial-reviewer #103, mpl-codex-auditor F6 #117, mpl-test-agent AD-0003 restoration, mpl-seed-generator #34). Each agent has clear role boundaries and tool restrictions.

> **AD-0004 status (2026-04-16)**: `mpl-test-agent` is restored and catalogued (AD-0003). Its dispatch site exists at `mpl-run-execute.md:511` and `mpl-run-execute-gates.md:154` but runtime dispatch was 0 in both exp9 and exp10 — empirical measurement gap remains. `mpl-seed-generator` was added in #34 (v0.14.0) for chain-scoped seed; dispatch gated by `chain_seed.enabled` config which failed to activate in exp10 (#41).

### Pre-Execution Agents (Analysis/Planning)

| Agent | Role | Model | Disallowed Tools |
|---------|------|------|-----------|
| `mpl-interviewer` | PP Interview + ambiguity resolution + gap analysis — discovers Pivot Points, resolves ambiguities, identifies gaps (consolidates previous mpl-interviewer + mpl-ambiguity-resolver + mpl-pre-execution-analyzer) | opus | Write, Edit, Bash, Task |
| `mpl-codebase-analyzer` | Codebase structure analysis — static analysis of directory structure, dependencies, interfaces | haiku | Edit, Task |
| `mpl-phase0-analyzer` | Pre-Execution deep analysis — in-depth Phase 0 Enhanced analysis before execution | sonnet | Edit, Task |
| `mpl-decomposer` | Phase decomposition + verification planning — decomposes request into ordered micro-phases with inline A/S/H classification (consolidates previous mpl-decomposer + mpl-verification-planner). v0.17.2: agent now owns the Write to `.mpl/mpl/decomposition.yaml` directly (orchestrator no longer authors). | opus | Bash, Task, WebFetch, WebSearch, NotebookEdit |
| `mpl-seed-generator` | Per-phase chain/inline execution seed (#34, #58) | opus | Bash, Task |

### Execution Agents (Execution/Verification)

| Agent | Role | Model | Disallowed Tools |
|---------|------|------|-----------|
| `mpl-phase-runner` | Phase execution — mini-plan, direct implementation, testing, verification, State Summary | sonnet | None (full tool access) |
| `mpl-test-agent` | Independent test author (AD-0004 separation) — code author ≠ test author | sonnet | Task |
| `mpl-adversarial-reviewer` | Post-phase intent-vs-impl audit (#103) — surfaces hidden gaps, scores quality | sonnet | Task |

### Post-Execution Agents (Finalization)

| Agent | Role | Model | Disallowed Tools |
|---------|------|------|-----------|
| `mpl-codex-auditor` | Tier 4 finalize-time intent diff (F6, #117) — anti-pattern residual + missing covers + drift | haiku | Write, Edit, Task |
| `mpl-git-master` | Atomic commit — style detection, semantic splitting, 3+ files = 2+ commits | sonnet | Write, Edit, Task |

### Removed Agents (v0.11.0)

The following agents were removed and their responsibilities consolidated into remaining agents:

| Removed Agent | Absorbed By | Rationale |
|---------------|------------|-----------|
| `mpl-ambiguity-resolver` | `mpl-interviewer` | Single opus call handles PP discovery + ambiguity resolution |
| `mpl-pre-execution-analyzer` | `mpl-interviewer` | Gap/tradeoff analysis integrated into interview |
| `mpl-verification-planner` | `mpl-decomposer` | A/S/H classification done inline during decomposition |
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

### 5.2 Gate System (3 Hard)

After all phase executions complete, must pass through 3 Hard Gates:

| Gate | Name | Type | Owner | Pass Criteria | On Failure |
|------|------|------|------|----------|--------|
| Hard 1 | Build + Type Check | Hard | (orchestrator) | 0 build errors, 0 type errors | Enter Fix Loop |
| Hard 2 | Automated Testing | Hard | (orchestrator) | pass_rate ≥ 95% | Enter Fix Loop |
| Hard 3 | PP Compliance | Hard | (orchestrator + Human) | No PP violations + H-items resolved | Enter Fix Loop |

Hard 1 performs project-wide build and type checking (consolidates previous Gate 0.5). Hard 2 runs the full test suite including S-items and regression suite (consolidates previous Gate 1 + Gate 1.5). Hard 3 validates PP compliance holistically and confirms H-items with the user (consolidates previous Gate 3).

> **Historical notes:** The pre-v0.11.0 5-Gate system (Gate 0.5, 0.7, 1, 1.5, 2, 3) included a separate Code Review gate (Gate 2) handled by `mpl-code-reviewer`. In v0.11.0, code review responsibilities are absorbed into Phase Runner's Build-Test-Fix cycle; Gate 1.5 metrics and Gate 2 code review are removed as separate stages. v0.11.0 also introduced an Advisory Gate (Cross-Boundary Check, Review+PP Compliance) as a non-blocking observational layer. Per #13 Option B + AD-0002, the Advisory Gate was removed in v0.12.3 — empirical cb-phase-a1 results showed L2/L3 defects are structurally beyond any non-blocking advisory layer; Hard 3 parameter-level verification (#19 AD-05) is the correct response for the 37% residual leak.

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
├── state.json                    # Pipeline + execution state (schema v7, v1→v7 migration chain in hooks/lib/migrations/)
├── config.json                   # Configuration (max_fix_loops, etc.)
├── pivot-points.md               # Pivot Points (immutable)
├── discoveries.md                # Discovery log
├── archive/                      # Legacy state + cancelled-run archives ({pipeline_id}/mpl/ deep copies)
├── contracts/                    # Decomposer-emitted contract JSONs (channel #3 SSOT)
├── e2e-traces/                   # Playwright trace dumps per scenario (Tier C scenario evidence)
├── requirements/
│   └── user-contract.md          # Tier A' UC scope (mutable; distinct from immutable pivot-points.md)
├── memory/
│   └── learnings.md              # Run-to-Run accumulated learnings (F-11)
├── cache/
│   └── phase0/                   # Phase 0 cache
│       ├── manifest.json         # Cache metadata (key, timestamp)
│       ├── api-contracts.md
│       ├── examples.md
│       ├── type-policy.md
│       ├── error-spec.md
│       ├── summary.md
│       └── complexity-report.json
└── mpl/
    ├── codebase-analysis.json    # Codebase analysis results
    ├── decomposition.yaml        # Phase decomposition results (decomposer is sole writer, v0.17.2)
    ├── decomposition-derived.json # Mechanical post-processing output (regenerated by mpl-decomposition-postprocess)
    ├── baseline.yaml             # P2 stream (#59) — frozen pre-execution baseline; guarded by mpl-baseline-guard
    ├── chain-assignment.yaml     # AP-CHAIN-01: chain groupings for seed-generator dispatch
    ├── core-scenarios.yaml       # Phase 0 Enhanced Step 2.5.3 HITL-derived PP-anchored scenarios (immutable)
    ├── e2e-scenarios.yaml        # Decomposer Step 7.5 composition of core scenarios into E2E
    ├── quality-signals.jsonl     # mpl-soft-signal-emit telemetry (HA-01 vague delegation, etc.)
    ├── phase-decisions.md        # Accumulated Phase Decisions (2-Tier Active/Summary)
    ├── interview-snapshot.md     # Stage 1.9 PP confirmation snapshot
    ├── phase0/                   # Phase 0 Enhanced artifacts
    │   ├── api-contracts.md
    │   ├── examples.md
    │   ├── type-policy.md
    │   ├── error-spec.md
    │   ├── summary.md
    │   ├── raw-scan.md           # mpl-phase0-analyzer mechanical scan output (#57)
    │   ├── design-intent.yaml    # Phase 0 #34 Stage 1 output — feeds Seed Generator
    │   └── complexity-report.json
    ├── phases/                   # Per-phase artifacts
    │   └── phase-N/
    │       ├── mini-plan.md      # Phase TODO list
    │       ├── state-summary.md  # Completion summary (knowledge transfer)
    │       ├── verification.md   # Verification results (with evidence)
    │       ├── phase-seed.yaml   # Inline-mode seed (mpl-seed-generator output)
    │       └── test-agent-brief.yaml # Test agent runbook (#212)
    ├── chains/
    │   └── chain-N/
    │       └── chain-seed.yaml   # Chain-mode seed (when chain_seed.enabled=true)
    ├── RUNBOOK.md                # Integrated execution log — current state, milestones, decisions, issues, resume info (F-10)
    ├── profile/                  # Token profiling
    │   ├── phases.jsonl          # Per-phase token/time (append-only)
    │   ├── run-summary.json      # Full execution profile
    │   └── telemetry-errors.jsonl # Non-blocking telemetry health channel
    └── metrics.json              # Final metrics
```

### 6.1b Removed Paths (historical)

| Path | Removed | Reason |
|------|---------|--------|
| `.mpl/manifest.json` | v0.17 | Step 0.0.5 deleted; no downstream consumer (#55) |
| `.mpl/mpl/state.json` | v0.17 / P2-6 | Unified into `.mpl/state.json` `execution` subtree; auto-archived on first read |
| `.mpl/memory/routing-patterns.jsonl` | v0.17 | Triage removed; recall has no consumer (#55) |

### 6.2 Phase Decision 2-Tier Classification

Phase Decisions are classified into 2 tiers to balance context preservation with token efficiency:

| Tier | Name | Contents | Token Budget | Classification Criteria |
|------|------|----------|----------|----------|
| Tier 1 | Active | Full detail | ~400~800 | PD's affected_files intersects with current phase impact, or PD from a dependency phase |
| Tier 2 | Summary | 1-line summary | ~90~240 | All other decisions |

Total PD token cost: ~2K~5K tokens for a 10-phase project (well within 1M budget).

### 6.3 Discovery Handling

Discoveries are reviewed at phase transition; CONFIRMED PP conflicts auto-reject, PD overrides require HITL. All Discoveries are recorded in `.mpl/discoveries.md`.

---

## 7. Hook System

`hooks/hooks.json` is the live event-entry SSOT. As of the v2 cutover, it contains 6 entries — one per hook event — and every entry invokes the single dispatcher `hooks/mpl-engine.mjs`. Per-module behavior is wired through the production ROUTES registry in `hooks/lib/dispatch.mjs`. The repo currently ships 46 live `hooks/mpl-*.mjs` modules plus 39 `.legacy.mjs` rollback/reference siblings; not every live module has a one-to-one dispatcher route because several policies are coalesced under shared route handlers. MPL maintains pipeline integrity through 39 logical hook surfaces:

| Hook | Event / matcher | Purpose | Introduced |
|----|--------|------|------------|
| `mpl-compaction-tracker` | PreCompact | Track compaction events and create checkpoints (F-31). | v0.13.x baseline |
| `mpl-auto-permit` | PreToolUse | Apply learned safe permission decisions (F-34). | v0.13.x baseline |
| `mpl-write-guard` | PreToolUse: Edit/Write/MultiEdit/NotebookEdit/Bash/Task/Agent | Warn or block unsafe direct source edits and dangerous shell commands; #236: protect mpl-cancel SKILL paths from `rm -rf` and require mpl-decomposer subagent identity for decomposition.yaml writes; Move #6: Bash write-target extraction closes the Law 2 bypass (redirect/tee/sed-i/dd-of/cp-mv/interpreter-write/touch/sponge/formatter/patch/git-apply); decision graph moved into `lib/policy/source-edit.mjs`. | v0.13.x baseline; MultiEdit/MCP hardening v0.18.1; protected-path + decomposition-writer v0.18.5; NotebookEdit + Bash source-edit Move #6 v0.18.1 |
| `mpl-bash-timeout` | PreToolUse: Bash | Enforce timeout budgets on build, lint, test, and verification commands. | v0.18.1 |
| `mpl-state-invariant` | PreToolUse: Task/Agent/Edit/Write/MultiEdit; Stop | Validate state schema, gate evidence, pause/block status, and completion invariants before state can drift. | v0.18.1; I10/I11 recovery v0.18.4 |
| `mpl-finalize-gate` | PreToolUse: Edit/Write/MultiEdit | Coalesced finalize_done=true gate. Delegates to the four finalize validators (E2E scenarios, E2E authenticity, declared artifacts, AC/AX closure) as subprocesses, aggregates every failure into a single `finalize_gate_failures` envelope (`retry_context.failures[]` preserves each validator's hookId+code+reason), and emits one block instead of cascading retries. | #257 |
| `mpl-validate-pp-schema` | PreToolUse: Edit/Write/MultiEdit | Keep mutable User Contract fields out of immutable `pivot-points.md`. | v0.16.0 |
| `mpl-require-covers` | PreToolUse: Edit/Write/MultiEdit | Require decomposition phases to declare valid `covers` mappings to UC ids or `internal`. | v0.16.0 |
| `mpl-require-goal-trace` | PreToolUse: Edit/Write/MultiEdit | Ensure decomposition goal traces cover the frozen Goal Contract hash and AC/AX ids. | v0.18.3 guard stream |
| `mpl-require-phase-contract-graph` | PreToolUse: Edit/Write/MultiEdit | Enforce graph metadata, evidence policy, resource locks, and valid phase dependencies in `decomposition.yaml`. | v0.18.3 guard stream; resource locks v0.18.5 |
| `mpl-require-decomposition-delta` | PreToolUse: Edit/Write/MultiEdit | Require recomposition deltas for existing decomposition graph rewrites. | v0.18.3 guard stream |
| `mpl-require-completed-phase-immutability` | PreToolUse: Edit/Write/MultiEdit | Prevent completed phase blocks from being mutated or removed during recomposition. | v0.18.3 guard stream |
| `mpl-require-phase-evidence` | PreToolUse: Edit/Write/MultiEdit | Require phase Evidence Latches before completion artifacts or completion state writes. | v0.18.3 guard stream |
| `mpl-baseline-guard` | PreToolUse: Edit/Write/MultiEdit | Protect `.mpl/mpl/baseline.yaml` after creation unless an explicit renewal sentinel exists. | v0.17.0 P2 stream (#59) |
| `mpl-ambiguity-gate` | PreToolUse: Task/Agent | Block decomposer dispatch until ambiguity and user-contract readiness gates pass. | v0.11.2; UC readiness v0.16.0 |
| `mpl-soft-signal-emit` | PreToolUse: Task/Agent | Emit quality-signal telemetry records (HA-01 vague delegation, etc.) to `.mpl/mpl/quality-signals.jsonl`. Never blocks. | #238 |
| `mpl-require-chain-assignment` | PreToolUse: Task/Agent | Require `chain-assignment.yaml` before seed-generator dispatch when chain seed is enabled. | v0.17.0 P1-4d |
| `mpl-tool-tracker` | PostToolUse: Bash/Edit/Write/MultiEdit/Task/Agent/Read/Grep/Glob/TodoWrite/NotebookEdit/WebFetch/WebSearch/SlashCommand/BashOutput/KillShell/ExitPlanMode/mcp__.* | Stamp `state.last_tool_at` for hang detection and telemetry freshness. | v0.18.1 |
| `mpl-gate-recorder` | PostToolUse: Bash/Task/Agent | Record structured gate, E2E, sprint, and test-agent PASS evidence from real tool results. | v0.15.0; blocked-hook cleanup v0.18.3/v0.18.4 |
| `mpl-fallback-grep` | PostToolUse: Edit/Write/MultiEdit | Run anti-pattern registry checks against edited files as a fallback static guard. | v0.18.1 |
| `mpl-artifact-schema` | PostToolUse: Edit/Write/MultiEdit/mcp__.*__write.* | Validate MPL artifacts against required markdown headings and YAML key schemas. | v0.18.1 |
| `mpl-decomposition-postprocess` | PostToolUse: Edit/Write/MultiEdit | Regenerate `.mpl/mpl/decomposition-derived.json` immediately after derived source artifacts change. | v0.18 Phase 5 diet |
| `mpl-require-reviewer` | PostToolUse: Edit/Write/MultiEdit | Enforce non-empty `reviewer_rationale` when a phase declares `reviewer_required: false`. | #239 C2 / #251 |
| `mpl-require-test-agent` | PostToolUse: Task/Agent | Block phase-runner completion until required test-agent PASS evidence or override exists. | v0.15.1; structured PASS hardening v0.18.3 |
| `mpl-require-test-agent-brief` | PreToolUse: Task/Agent | Block `mpl-test-agent` dispatch when `test_agent_required: true` phase has no valid `test-agent-brief.yaml` runbook artifact. | #212 |
| `mpl-quality-gate` | PostToolUse: Task/Agent | Consume adversarial reviewer quality scores and trigger retry/escalation decisions. | v0.18.1 |
| `mpl-validate-output` | PostToolUse: Task/Agent | Validate required sections of agent output and track token usage. | v0.13.x baseline |
| `mpl-validate-seed` | PostToolUse: Task/Agent/Write/Edit/MultiEdit | Validate phase and chain seed YAML, contract snippets, TODO dependencies, files, and resource locks. | v0.10.0; registered v0.11.3; scheduling metadata v0.18.6 |
| `mpl-phase-receipt` | PostToolUse: Task/Agent | Parse the phase-runner's compact handoff receipt (verdict enum + sha256 of on-disk artifacts + counts), verify the sha against the artifacts, append to `.mpl/mpl/receipts.jsonl` audit ledger; advise explicitly on a missing/malformed receipt or sha mismatch (never blocks). | exp25 R04 |
| `mpl-sentinel-s0` | PostToolUse: Task/Agent/Write/Edit/MultiEdit | Fact-check seed contract snippets against known contract keys. | v0.10.0; registered v0.11.3 |
| `mpl-sentinel-s1` | PostToolUse: Task/Agent | Validate runner export-manifest symbols against generated files. | v0.10.0; registered v0.11.3 |
| `mpl-sentinel-s3` | PostToolUse: Task/Agent | Validate test-agent import paths against actual files. | v0.10.0; registered v0.11.3 |
| `mpl-permit-learner` | PostToolUse | Learn permission allow patterns from safe tool usage (F-34). | v0.13.x baseline |
| `mpl-sentinel-pp-file` | PostToolUse: Edit/Write/MultiEdit | Inject PP context for edits touching files referenced by Pivot Points. | v0.13.0 AD-04 |
| `mpl-context-monitor` | PostToolUse: Task/Agent | Track token and dispatch context signals for baton-pass and measurement. | v0.14.0 #34 Stage 1 |
| `mpl-discovery-scanner` | PostToolUse: Task/Agent | Mechanically filter runner discovery candidates before later review steps. | v0.14.0 #34 Stage 1 |
| `mpl-phase-controller` | Stop | Route phases, enforce structured gate evidence, surface hook blocks, and pause routing on verification hangs. | v0.13.x baseline; hang/block routing v0.18.1/v0.18.4 |
| `mpl-session-init` | SessionStart | Initialize context rotation and MCP bootstrap state at session start (F-38). | v0.13.x baseline |
| `mpl-keyword-detector` | UserPromptSubmit | Detect MPL entry prompts, initialize pipeline state, count user intervention, and ignore `<task-notification>` completion XML. | v0.13.x baseline; intervention counter v0.18.1; task-notification guard #153 |

### 7.1 Known static-analysis limitations (Source-Edit policy)

`mpl-write-guard` delegates its Bash write-target extraction to
`hooks/lib/policy/source-edit.mjs#extractBashWriteTargets`. The extractor is a
**static** Bash parser by design — it inspects the command string before
execution and cannot resolve runtime-constructed call paths or payloads.

The following bypass patterns are accepted as known limitations of the
static layer:

- Obfuscated interpreter call names, e.g.
  `String.prototype['repeat'].call('writ','e')` reconstructed at runtime.
- `eval`-decoded base64 payloads passed to `node -e` / `python -c` / `ruby -e`.
- Runtime-constructed target paths inside `$(…)` / backtick command
  substitutions.

Defense-in-depth at execution time is handled by:

1. `lib/policy/permit.mjs`'s layered veto (PreToolUse): dangerous-union →
   protected-delete → state/decomposition writes → source-target redirects.
2. `mpl-tool-tracker` (PostToolUse): records the tool invocation fingerprint
   so a later auditor (Tier 4 / `audit.mjs`) can flag drift.

This intentional limit is documented so contributors do not repeatedly file
"we should detect X obfuscation" issues against the static extractor. See
also `docs/changelog.md` → Unreleased → Known limitations.

---

## 8. Configuration Options

The following options are supported in `.mpl/config.json`:

| Option | Default | Description |
|------|--------|------|
| `max_fix_loops` | `10` | Maximum Fix Loop iterations |
| `context_cleanup_window` | `3` | Sliding window size — number of recent phases to retain detailed data (v0.7.0, historical) |
| `parallelism.max_phase_workers` | `2` | Maximum concurrent phase workers for `execution_tiers[].parallel: true`; runtime clamps to max 3 |
| `test_wait.pipelining_enabled` | `true` | Allow Test Agent/reviewer background verification until a dependency frontier, Gate, or finalize join boundary |
| `gate1_strategy` | `"auto"` | Gate 1 test strategy (auto/docker/native/skip) |
| `hitl_timeout_seconds` | `30` | HITL response wait time |
| `convergence.stagnation_window` | `3` | Fix attempts to evaluate for stagnation (see `config-schema.md`) |
| `convergence.min_improvement` | `5` | Minimum pass_rate improvement % per window |
| `convergence.regression_threshold` | `10` | pass_rate drop % triggering circuit break |
| `e2e_timeout` | `60000` | Timeout per E2E scenario in ms (v0.8.3) |

---

## 9. Version History

> **Note (v0.19.0+):** This section keeps only the current architecture cutover
> summary. Older release narratives belong in the closed issue / PR trail, with
> [`docs/changelog.md`](./changelog.md), [`docs/v2-remaining-work.md`](./v2-remaining-work.md),
> and roadmap docs acting as indexes.

### v0.19.0 — v2 Architecture Cutover (2026-06-01)

Closing cut of the Stage A v2 redesign (moves #1–#18). The hook layer
moved from many `hooks.json` entries calling individual scripts to 6 event
entries that all invoke the single `mpl-engine.mjs` dispatcher. The
dispatcher routes through `lib/dispatch.mjs` ROUTES, with the former
per-hook decision graphs consolidated into `hooks/lib/policy/`.
State sharding + wave-reducer (Move #17) bumps `.mpl/state.json` schema
v6 → v7 with auto-migration. `.legacy.mjs` siblings are retained as a
one-release rollback tier.

| Change | Before | After | Type | Rationale |
|--------|--------|-------|------|-----------|
| Hook entry surface | Many individual entries in `hooks.json` | 6 dispatcher entries (one per event) routing through `mpl-engine.mjs` + `lib/dispatch.mjs` ROUTES | Hook (Move #14) | Single observation point, lower fanout cost |
| Policy decisions | Each `mpl-*.mjs` carried its own decision graph | 12 policy modules under `hooks/lib/policy/` (audit, channel-registry, contracts, envelope-bridge, evidence, gates, isolation, permit, scheduler, schemas, session-init, source-edit) consumed by hooks | Hook (Move #6–#13, #16) | One file per policy class; hooks become thin adapters |
| State writer | Inline state writes per hook | `hooks/lib/state/writer.mjs` + `shard-writer.mjs` + `wave-reducer.mjs`; MCP `state_write` delegates via subprocess | Hook (Move #2/#3/#17) | Single writer; concurrent waves merge through reducer |
| State schema | v6 | v7 (`hooks/lib/migrations/v6-to-v7.mjs`) | Schema | State shard + reducer envelope makes v6 incompatible |
| Law 2 enforcement | Warn-only (advisory) | `mpl-write-guard` blocks unsafe direct edits by default + Bash redirect/tee/sed-i/dd-of/cp-mv/git-apply bypass closure (Move #6); `mpl-cancel` SKILL paths + `decomposition.yaml` writer identity hard-protected (#236) | Hook (Move #6) | Closes the Bash bypass class surfaced by exp scans |
| Documentation | README/design.md drifted with v0.17 router removal + advisory gate removal | README §The Router replaced with §Pipeline Depth (v0.17+); 3 Hard Gates + Advisory → 3 Hard Gates; tree + agent catalog refreshed (9 → 11 agents) | Docs (Move #18) | Reconcile pre-v2 cosmetic drift; introduce `docs/redesign-proposal.html` + `docs/changelog.md` |

**Affected files:**
- Hooks: `hooks/hooks.json`, `hooks/mpl-engine.mjs`, `hooks/lib/dispatch.mjs`, `hooks/lib/state/{reader,writer,shard-writer,wave-reducer,writer-cli}.mjs`, `hooks/lib/policy/{audit,channel-registry,contracts,envelope-bridge,evidence,gates,isolation,permit,scheduler,schemas,session-init,source-edit}.mjs` + `hooks/lib/policy/reconcile/`, `hooks/lib/migrations/v6-to-v7.mjs`, plus 39 `.legacy.mjs` rollback/reference siblings.
- Docs: `README.md`, `README_ko.md`, `docs/design.md` (this entry + §1/§2/§3.2/§3.3/§4/§6.1/§6.3/§7/§8), `docs/config-schema.md`, `docs/changelog.md` (new), `docs/archive/2026-03-30-hooks-review.md` (relocated).
- Commands: `commands/mpl-run.md` (Hat Model section removed).
- Skills: `skills/mpl-version-bump/SKILL.md` (added `package.json` checklist entry).
- Config / metadata: `package.json` (new `version` field), `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json`, `mcp-server/package.json`, `mcp-server/package-lock.json`.
- Config fix: `mpl.config.yaml` (`observability.sentinels.subagent_type_filter` rewritten from flow-style sequences to block-style; closes a `yaml-mini: expected 'key:' at line 211` stderr warning and a latent silent filter bug).

**Breaking changes:** `.legacy.mjs` rollback/reference siblings remain importable where still needed; production event entrypoints consume `mpl-engine.mjs` and `lib/dispatch.mjs`. Existing `.mpl/state.json` files auto-migrate v1→v7 on first read.

**Tests:** Added `hooks/__tests__/mpl-yaml-mini.test.mjs` regression coverage for block vs flow sequences and a round-trip parse of `mpl.config.yaml`.

### Historical Releases

Older release narratives are intentionally not duplicated in this design document. For context-efficient archaeology, use the closed issue / PR trail that introduced each behavior, then consult `docs/changelog.md` and roadmap summaries only as indexes.

Primary references:

| Area | Closed issue / reference | Notes |
|------|--------------------------|-------|
| v0.17 simplification | #55 | Removed Triage / Hat / PP-proximity router and related stale artifacts. |
| P1/P2 hardening stream | #79, #81, #83, #85, #88 | MCP session robustness, chain assignment, unified state, session cache, docs drift audit. |
| Decomposer write authority | #90, #91, #92 and v0.17.2 notes | Decomposer owns `decomposition.yaml`; orchestrator reads and validates. |
| v0.18 enforcement stack | #103-#117, #129, #135-#136 | Bash timeout, anti-patterns, state invariants, schema migration, artifact schema, Codex audit. |
| Runtime verification closure | exp19 / v0.18.3 notes | Real-runtime E2E, authenticity, Tauri capability, visible blocked-hook state. |
| Scheduler and pipelining | v0.18.5 / v0.18.6 roadmap notes | Execution tiers, resource locks, bounded workers, verification pipelining. |
| v2 cutover | `docs/redesign-proposal.html`, `docs/v2-remaining-work.md`, `docs/changelog.md` | Moves #1-#18, remaining work, and current verification status. |

This keeps `docs/design.md` focused on the current architecture. Historical prose can still be recovered from Git history when the exact narrative is needed.

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
