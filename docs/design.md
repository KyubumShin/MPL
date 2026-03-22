# MPL (Micro-Phase Loop) v0.6.6 Design Document

## 1. Overview

MPL is an autonomous coding pipeline that decomposes user requests into ordered **micro-phases**. Each phase runs in an isolated session with only structured context, preventing context pollution that occurs during long-running executions.

v3.0 evolved from v1.0's 5-step·5-agent structure to a **9+ step·15 agent** structure. Key changes are as follows:

| Area | v1.0 | v3.0 |
|------|------|------|
| Pipeline Steps | 5 steps (Step 0~5) | 9+ steps (Step 0~6 + sub-steps) |
| Agents | 5 | 15 |
| Pre-Analysis | None | Triage + Phase 0 Enhanced + Pre-Execution Analysis |
| Quality System | Simple verification | Build-Test-Fix + 5-Gate + A/S/H classification + Convergence Detection |
| Caching | None | Phase 0 artifact caching |
| Token Profiling | None | Per-phase token/time profiling |

> **Detailed procedures** are defined in `mpl-run.md` (orchestration protocol). This document covers concepts, structure, and policy.

---

## 2. Design Principles

### Principle 1: Orchestrator-Worker Separation

The orchestrator **never writes source code directly.** All code changes are delegated to the `mpl-worker` agent via the Task tool. The `mpl-write-guard` PreToolUse hook provides advisory warnings for this.

### Principle 2: Plan First

Execution begins only after phase decomposition. The decomposition artifact (`decomposition.yaml`) is the single source of truth (SSOT), containing ordered phases and interface contracts.

### Principle 3: Test-Based Verification

Each phase has machine-verifiable success criteria. Subjective "done" declarations are not permitted; only evidence-based verification (command exit codes, test results, file existence, grep patterns) is accepted.

> **QMD Semantic Search Policy:** QMD search results are used only for discovery purposes. To be accepted as verification evidence, they must pass grep cross-validation (Search-then-Verify). Results that pass cross-validation have evidence type `qmd_verified` and are treated equivalently to grep.

### Principle 4: Bounded Retries

Phase Runner retries internally up to 3 times. The orchestrator re-decomposes up to 2 times. When limits are exceeded, circuit break activates, preventing infinite loops.

### Principle 5: Knowledge Accumulation

**State Summary** is the sole means of knowledge transfer between phases. Phase Decisions are managed with a 3-Tier classification system (Active/Summary/Archived) to maintain a constant token budget.

---

## 3. Pipeline Architecture

### 3.1 State Machine

```
mpl-init -> mpl-decompose -> mpl-phase-running <-> mpl-phase-complete
                 ^                    |                      |
                 +-- mpl-circuit-break               mpl-finalize -> completed
                           |
                       mpl-failed
```

- **Retry**: Phase Runner retries internally 3 times (D-1 Hybrid). The orchestrator receives only `"complete"` or `"circuit_break"`.
- **Re-decompose**: `max_redecompose = 2`. When exceeded, transitions to `mpl-failed` state.

### 3.2 Full Flow Summary Table

| Step | Name | Core Agent | Artifact |
|------|------|-------------|--------|
| -1 | LSP Warm-up | (orchestrator, non-blocking) | lsp_servers list, cold start elimination |
| 0 | Triage | (orchestrator) | interview_depth (light/full) |
| 0.5 | Maturity Mode Detection | (orchestrator) | maturity_mode (explore/standard/strict) |
| 1 | PP Interview | mpl-interviewer | `.mpl/pivot-points.md` |
| 1-B | Pre-Execution Analysis | mpl-pre-execution-analyzer | Missing requirements, AI pitfalls, Must NOT Do, risk level, execution order recommendation |
| 1-D | PP Confirmation | (orchestrator) | PP final confirmation |
| 2 | Codebase Analysis | (orchestrator) | `.mpl/mpl/codebase-analysis.json` |
| 2.5 | Phase 0 Enhanced | (orchestrator) | `.mpl/mpl/phase0/*.md` |
| 3 | Phase Decomposition | mpl-decomposer | `.mpl/mpl/decomposition.yaml` |
| 3-B | Verification Planning | mpl-verification-planner | A/S/H item classification |
| 3-C | ~~Critic Simulation~~ | ~~mpl-critic~~ | Absorbed into Decomposer risk_assessment (v3.1) |
| 4 | Phase Execution Loop | mpl-phase-runner, mpl-worker, mpl-test-agent, mpl-code-reviewer | Per-phase artifacts |
| 5 | E2E & Finalization | mpl-compound, mpl-git-master | Learnings, commits, metrics |
| 6 | Resume Protocol | (orchestrator) | Resume from interrupted phase |

### 3.3 Step-by-Step Description

#### Step 0: Triage

Analyzes the **information density** of the user prompt to determine interview depth. Counts the number of explicit constraints, specific files, measurable criteria, and tradeoff choices.

| interview_depth | Condition | Interview Behavior |
|-----------------|------|-----------|
| `light` | Density 4+ & some constraints present | Round 1 (What) + Round 2 (What NOT) only |
| `full` | Density below 4 (ambiguous/broad) | Full 4-round interview |

#### Step 0.5: Maturity Mode Detection

Reads `maturity_mode` from `.mpl/config.json` (default: `"standard"`).

| Mode | Phase Size | PP | Discovery Handling |
|------|-----------|-----|---------------|
| `explore` | S (1~3 TODO) | Optional | Auto-approve |
| `standard` | M (3~5 TODO) | Required | HITL on PP conflict |
| `strict` | L (5~7 TODO) | Required + enforced | HITL for all changes |

#### Step 1: PP Interview + Pre-Execution Analysis + PP Confirmation

This step consists of 4 sub-steps:

**Step 1: PP Interview (2-Stage Design)** — The PP interview is divided into two stages:

- **Stage 1 — Value PP Discovery** (`mpl-interviewer`, opus): Discovers Pivot Points through a structured 4-Round interview. Interview scope is adjusted based on Triage's `interview_depth` (light: Round 1~2 only, full: all 4 rounds). PP status is classified as CONFIRMED (hard constraint, auto-reject on conflict) or PROVISIONAL (soft, HITL on conflict).
- **Stage 2 — PP-Aligned Spec Resolution** (`mpl-ambiguity-resolver`, opus): With PP fixed as immutable constraints, auto-resolves items that can be resolved from PP + existing context, and resolves remaining ambiguities through a Socratic loop based on 5-dimensional (4 orthogonal + PP Conformance) metrics. Choices that conflict with PP receive score penalties; PP itself is never modified.

**Step 1-B: Pre-Execution Analysis** — `mpl-pre-execution-analyzer` (sonnet) analyzes PP, user request, and codebase to identify missing requirements, AI agent pitfalls, and "Must NOT Do" constraints (Part 1: Gap), and evaluates the risk (LOW/MED/HIGH) and reversibility (Reversible/Irreversible) of proposed changes to recommend optimal execution order (Part 2: Tradeoff). Consolidates the previous gap-analyzer(haiku) + tradeoff-analyzer(sonnet) 2-call approach into a single sonnet call, eliminating duplicate codebase exploration.

**Step 1-D: PP Confirmation** — Finalizes PP incorporating Pre-Execution analysis results. Asks the user additional questions as needed.

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
| 0~29 | Simple | Step 4 only (Error Spec) | ~8K |
| 30~79 | Medium | Step 2 + Step 4 | ~12K |
| 80+ | Complex | Steps 1~4 all | ~20K |

**4-Step Process**:

| Step | Name | Applicable Condition | Artifact Path |
|------|------|----------|-----------|
| Step 1 | API Contract Extraction | Complex+ | `.mpl/mpl/phase0/api-contracts.md` |
| Step 2 | Example Pattern Analysis | Medium+ | `.mpl/mpl/phase0/examples.md` |
| Step 3 | Type Policy Definition | Complex+ | `.mpl/mpl/phase0/type-policy.md` |
| Step 4 | Error Specification | All grades (required) | `.mpl/mpl/phase0/error-spec.md` |

Each Step's artifact must pass a verification checklist. The final summary is stored in `.mpl/mpl/phase0/summary.md`, and successfully completed artifacts are cached in `.mpl/cache/phase0/`.

Token profiling also begins at this step. Phase 0 token usage is recorded in `.mpl/mpl/profile/phases.jsonl`.

#### Step 3: Phase Decomposition + Verification Planning + Critic

This step consists of 3 sub-steps:

**Step 3: Phase Decomposition** — `mpl-decomposer` (opus) decomposes the user request into ordered micro-phases. The decomposer performs pure reasoning without tool access, taking structured CodebaseAnalysis as input. Each phase declares:
- Scope and rationale
- Impact scope (created/modified/tested/configuration files)
- Interface contract (requires/produces)
- Success criteria (typed: command/test/file_exists/grep/qmd_verified/description)
- Estimated complexity (S/M/L)

Artifact: `.mpl/mpl/decomposition.yaml`

**Step 3-B: Verification Planning** — `mpl-verification-planner` (sonnet) classifies acceptance criteria into A/S/H items:
- **A-items** (Agent-Verifiable): Agent can automatically verify (command, exit code)
- **S-items** (Sandbox Agent Testing): BDD/Gherkin scenario-based verification
- **H-items** (Human-Required): Automation insufficient, requires human judgment

The verification plan is attached to each phase and serves as the verification criteria for Phase Runner and Test Agent.

**Step 3-C: ~~Critic Simulation~~** — Absorbed into Decomposer's `risk_assessment` output section in v3.1. Decomposer performs pre-mortem analysis during decomposition reasoning (Step 9) and outputs go/no-go judgment. Achieves the same effect without a separate opus agent call, saving ~3-5K tokens.

#### Step 4: Phase Execution Loop

The core execution unit of the pipeline. Executes each phase in order.

**4.1 Context Assembly** — Assembles the necessary context before each phase execution:
- Phase 0 artifacts (selectively loaded based on complexity grade)
- Pivot Points
- Phase Decision (3-Tier classification applied)
- Phase definition (from decomposition.yaml)
- Impact files (maximum 500 lines per file)
- Previous phase State Summary
- Dependency phase Summary (based on interface_contract.requires)
- Verification plan (A/S/H items for the relevant phase)

**4.2 Phase Runner Execution** — `mpl-phase-runner` (sonnet) runs in an isolated session. Phase Runner writes a mini-plan, delegates TODOs to `mpl-worker`, verifies with Build-Test-Fix micro-cycles, and produces a State Summary. Rules:
- Immediate testing per TODO (no batching)
- On failure, reference Phase 0 artifacts before fixing
- Circuit break after maximum 3 retries

**4.2.1 Test Agent (F-40 Mandatory)** — After Phase Runner completes, `mpl-test-agent` (sonnet) independently writes and runs tests. By separating code author from test author, it catches assumption mismatches, interface contract violations, and edge cases. **From F-40, Test Agent invocation is mandatory for required domains (ui, api, algorithm, db, ai), and Phase is FAIL-processed if 0 tests are returned.** The orchestrator operates as a single enforcement gate; Phase Runner's previous Step 3d call has been removed.

**4.3 Result Processing** — Performs verification, state saving, Discovery processing, and profile recording.

**4.3.5 Side Interview** — Requests user confirmation when CRITICAL discovery, H-items, or AD (After Decision) markers are present.

**4.3.6 Context Cleanup** — After each phase completes, releases detailed data from orchestrator memory, maintaining a constant context size regardless of the number of phases.

**4.4 Re-decomposition** — When circuit break occurs, `mpl-decomposer` re-decomposes the failed phase with a different strategy. Allowed up to 2 times; completed phases are preserved.

**4.5 5-Gate Quality** — After all phases complete, must pass 5-stage quality gates (Gate 0.5, 1, 1.5, 2, 3) to proceed to finalization (see §5 Quality System for details).

**4.6 Fix Loop** — On gate failure, enters the fix loop. Monitors progress with Convergence Detection; changes strategy on stagnation, immediately circuit breaks on regression (see §5.4 for details).

#### Step 5: E2E & Finalization

After passing 5-Gate, performs the final steps:

| Sub-step | Content |
|----------|------|
| 5.0 E2E Testing | Run E2E scenarios for S-items |
| 5.0.5 AD Final Verification | Confirm interface definitions for After Decision markers |
| 5.1 Final Verification | Re-run success criteria for all phases |
| 5.2 Learning Extraction | `mpl-compound` extracts learnings/decisions/issues |
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

MPL v3.7 uses 15 specialized agents (critic absorbed + gap/tradeoff consolidated + doctor added). Each agent has clear role boundaries and tool restrictions.

### Pre-Execution Agents (Analysis/Planning)

| Agent | Role | Model | Disallowed Tools |
|---------|------|------|-----------|
| `mpl-interviewer` | PP Interview — discovers Pivot Points through structured 4-round interview | opus | Write, Edit, Bash, Task |
| `mpl-ambiguity-resolver` | PP-aligned spec generation — pre-resolve + 5-dimensional (including PP Conformance) metric-based Socratic loop + PP conflict detection under PP immutable constraints | opus | Write, Edit, Bash, Task |
| `mpl-codebase-analyzer` | Codebase structure analysis — static analysis of directory structure, dependencies, interfaces | haiku | Edit, Task |
| `mpl-phase0-analyzer` | Pre-Execution deep analysis — in-depth Phase 0 Enhanced analysis before execution | sonnet | Edit, Task |
| `mpl-pre-execution-analyzer` | Pre-Execution analysis — Gap (missing requirements, AI pitfalls, Must NOT Do) + Tradeoff (risk level, reversibility, execution order) consolidated | sonnet | Write, Edit, Bash, Task |
| `mpl-decomposer` | Phase decomposition — decomposes request into ordered micro-phases (Read/Glob/Grep allowed) | opus | Write, Edit, Bash, Task, WebFetch, WebSearch, NotebookEdit |
| `mpl-verification-planner` | Verification planning — A/S/H item classification, per-phase verification strategy | sonnet | Write, Edit, Task |
| ~~`mpl-critic`~~ | ~~Critic~~ — Absorbed into Decomposer risk_assessment (v3.1) | ~~opus~~ | - |

### Execution Agents (Execution/Verification)

| Agent | Role | Model | Disallowed Tools |
|---------|------|------|-----------|
| `mpl-phase-runner` | Phase execution — mini-plan, worker delegation, verification, State Summary | sonnet | None (full tool access) |
| `mpl-worker` | TODO implementation — implements a single TODO item and returns JSON output | sonnet | Task |
| `mpl-test-agent` | Independent testing — test writing/execution separated from code author | sonnet | Task |
| `mpl-code-reviewer` | Code review — 10-category review (8 basic + 2 UI-specific), handles Gate 2 | sonnet | Write, Edit, Task |

### Post-Execution Agents (Finalization)

| Agent | Role | Model | Disallowed Tools |
|---------|------|------|-----------|
| `mpl-git-master` | Atomic commit — style detection, semantic splitting, 3+ files = 2+ commits | sonnet | Write, Edit, Task |
| `mpl-compound` | Learning extraction — distills learnings/decisions/issues after pipeline completion | sonnet | None (full tool access) |

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
| mpl-worker | sonnet | Architecture change or 3+ retry failures |

---

## 5. Quality System

MPL v3.0 ensures code quality through a multi-layer quality system.

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

### 5.2 5-Gate Quality System

After all phase executions complete, must pass through 5-stage quality gates sequentially:

| Gate | Name | Owner | Pass Criteria | On Failure |
|------|------|------|----------|--------|
| Gate 0.5 | Type Check | (orchestrator) | 0 type errors | Enter Fix Loop then Gate 1 |
| Gate 1 | Automated Testing | (orchestrator) | pass_rate ≥ 95% | Enter Fix Loop |
| Gate 1.5 | Metrics (F-50) | (orchestrator) | coverage ≥ 60% (MVP) / 80% (strict) | Re-invoke Test Agent (max 2 times) |
| Gate 2 | Code Review | mpl-code-reviewer | PASS verdict | NEEDS_FIXES → Fix Loop, REJECT → mpl-failed |
| Gate 3 | PP Compliance | (orchestrator + Human) | No PP violations + H-items resolved | Enter Fix Loop |

Gate 0.5 performs project-wide type checking. Gate 1 runs the full test suite (including S-items). Gate 1.5 measures coverage, code duplication, and bundle size (F-50). Gate 2 reviews code across 10 categories (correctness, security, performance, maintainability, PP compliance, design system, bundle health, etc.). Gate 3 validates PP compliance holistically and confirms H-items with the user.

### 5.3 A/S/H Verification Classification

`mpl-verification-planner` classifies all acceptance criteria into three categories:

| Classification | Description | Verification Method | Example |
|------|------|----------|------|
| **A-items** (Agent-Verifiable) | Agent can automatically verify | Command execution + exit code check | `npm test` pass, file existence |
| **S-items** (Sandbox Agent Testing) | Agent verifies based on scenarios | BDD/Gherkin scenario execution | "When user logs in, dashboard is displayed" |
| **H-items** (Human-Required) | Automation insufficient | User confirmation (Side Interview) | UX judgment, business logic appropriateness |

A-items are verified by Phase Runner and Test Agent. S-items are verified at Gate 1 (automated testing). H-items are confirmed with the user through Side Interview at Gate 3.

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
├── config.json                   # Configuration (maturity_mode, max_fix_loops, etc.)
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

### 6.2 Phase Decision 3-Tier Classification

Phase Decisions are classified into 3 tiers to maintain constant token cost between phases:

| Tier | Name | Contents | Token Budget | Classification Criteria |
|------|------|----------|----------|----------|
| Tier 1 | Active | Full detail | ~400~800 | PD's affected_files intersects with current phase impact |
| Tier 2 | Summary | 1-line summary | ~90~240 | DB Schema/API Contract/Architecture type but no direct contact |
| Tier 3 | Archived | ID only | ~0 | Everything else |

Total PD token cost: ~500~1000 tokens (stable regardless of number of phases).

### 6.3 Discovery Handling

Discoveries reported by Phase Runner are processed in the following order:

1. **PP Conflict Check**: CONFIRMED PP conflict → auto-reject. PROVISIONAL → HITL or auto-approve based on maturity_mode.
2. **PD Override Check**: Request to change past decisions → HITL or auto-approve based on maturity_mode.
3. **General Discovery**: explore → apply immediately, standard → review at phase transition, strict → next cycle backlog.

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
| `maturity_mode` | `"standard"` | Maturity mode (explore/standard/strict) |
| `max_fix_loops` | `10` | Maximum Fix Loop iterations |
| `max_total_tokens` | `500000` | Total token upper limit |
| `gate1_strategy` | `"auto"` | Gate 1 test strategy (auto/docker/native/skip) |
| `hitl_timeout_seconds` | `30` | HITL response wait time |
| `convergence.stagnation_window` | (per config) | Stagnation detection window size |
| `convergence.min_improvement` | (per config) | Minimum improvement rate |
| `convergence.regression_threshold` | (per config) | Regression detection threshold |

---

## 9. Known Issues and Remaining Work

> Last audit date: 2026-03-05. Items below were identified through cross-validation between v3.0 codebase and documentation.

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
