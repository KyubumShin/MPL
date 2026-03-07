# MPL (Micro-Phase Loop) v3.2

Coherence-first autonomous coding pipeline plugin for Claude Code.

MPL decomposes user requests into ordered micro-phases, each with independent plan-execute-verify mini-loops. Each phase gets a fresh session with structured context only (Pivot Points + Phase Decisions + impact files), preventing context pollution.

> **[한국어 문서 (Korean)](./README_ko.md)**

## Quick Start

```
Say "mpl {task description}" to start a pipeline
```

Or use the skill directly:
```
/mpl:mpl
```

## Installation

MPL follows the Claude Code plugin structure and can be installed and run standalone with no external dependencies.

### Prerequisites

| Item | Minimum Version | Check Command |
|------|----------------|---------------|
| Claude Code CLI | Latest | `claude --version` |
| Node.js | 18+ | `node --version` |
| Git | 2.x | `git --version` |

### Step 1: Clone the MPL Repo

Clone into your project as a subdirectory, or symlink from a separate location.

```bash
cd /path/to/your-project

# Option A: Clone as subdirectory
git clone https://github.com/<your-org>/MPL.git

# Option B: Clone elsewhere and symlink
git clone https://github.com/<your-org>/MPL.git ~/tools/MPL
ln -s ~/tools/MPL /path/to/your-project/MPL
```

Project structure after setup:

```
your-project/
├── MPL/                        # MPL plugin (clone or symlink)
│   ├── .claude-plugin/
│   │   └── plugin.json         # Plugin manifest
│   ├── .claude/
│   │   └── settings.local.json # Permission settings
│   ├── agents/                 # 11 agent definitions
│   ├── commands/               # Orchestration commands
│   ├── hooks/                  # 4 hooks
│   │   ├── hooks.json
│   │   ├── mpl-write-guard.mjs
│   │   ├── mpl-validate-output.mjs
│   │   ├── mpl-phase-controller.mjs
│   │   └── mpl-keyword-detector.mjs
│   ├── skills/                 # 7 skills
│   ├── package.json
│   └── README.md
├── src/                        # Your source code
└── ...
```

> Claude Code automatically recognizes any directory containing `.claude-plugin/plugin.json` as a plugin.

### Step 2: Create Runtime Directories

Create the state directories used by the MPL pipeline at your project root.

```bash
mkdir -p .mpl/mpl/phase0
mkdir -p .mpl/mpl/phases
mkdir -p .mpl/mpl/profile
mkdir -p .mpl/cache/phase0
mkdir -p .mpl/memory
```

### Step 3: Create Default Config

Create `.mpl/config.json` at your project root.

```bash
cat > .mpl/config.json << 'EOF'
{
  "maturity_mode": "standard",
  "max_fix_loops": 10,
  "max_total_tokens": 500000,
  "gate1_strategy": "auto",
  "hitl_timeout_seconds": 30,
  "tool_mode": "standalone",
  "convergence": {
    "stagnation_window": 3,
    "min_improvement": 0.05,
    "regression_threshold": -0.1
  }
}
EOF
```

> Set `tool_mode` to `"standalone"` to use Grep/Glob/Bash fallbacks without LSP/AST grep. Change to `"full"` if LSP MCP tools are available in your environment.

### Step 4: Add to .gitignore (Recommended)

```bash
echo '.mpl/' >> .gitignore
```

### Step 5: Verify Installation

Launch Claude Code from your project root — the MPL plugin will be auto-detected.

```bash
claude
```

Run diagnostics inside the session:

```
/mpl:mpl-doctor
```

All 10 categories should show PASS.

### Automated Setup (Alternative)

After Step 1 (clone), you can let the setup wizard handle the rest:

```
/mpl:mpl-setup
```

Or type `setup mpl` in the prompt — it automatically creates runtime directories, config files, and detects available tools.

### Updating MPL

```bash
cd MPL && git pull origin main
```

If using a symlink, pull from the original location.

---

## Architecture

### Core Principle: Orchestrator-Worker Separation

The orchestrator NEVER writes source code directly. All code changes are delegated to `mpl-worker` agents via the Task tool. PreToolUse hook enforces this as a hard block.

### Design Principles

| # | Principle | Description |
|---|-----------|-------------|
| 1 | Orchestrator-Worker Separation | Orchestrator delegates all code changes to workers |
| 2 | Plan First | Execution starts only after phase decomposition |
| 3 | Test-Based Verification | Machine-verifiable success criteria only — no subjective "done" |
| 4 | Bounded Retries | Max 3 retries/phase, max 2 redecompositions, then circuit break |
| 5 | Knowledge Accumulation | State Summaries are the ONLY knowledge transfer between phases |

### Pipeline Flow

```
Step -1: LSP Warm-up (non-blocking, parallel with Step 0)
Step  0: Triage + Quick Scope Scan → pipeline_tier (frugal/standard/frontier)
Step  0.5: Maturity Mode Detection (explore/standard/strict)
Step  1: Pivot Points Interview (immutable constraints)
Step  1-B: Pre-Execution Analysis (gap + tradeoff in single call)
Step  1-D: PP Confirmation Gate
Step  2: Codebase Analysis (structure, dependencies, interfaces)
Step  2.5: Phase 0 Enhanced (API contracts, examples, types, error specs)
Step  3: Phase Decomposition (mpl-decomposer -> ordered micro-phases)
Step  3-B: Verification Planning (A/S/H-items classification)
Step  4: Phase Execution Loop (mpl-phase-runner -> mpl-worker per phase)
Step  5: E2E & Finalize (learnings, atomic commits, metrics, RUNBOOK)
Step  6: Resume Protocol (restart from last checkpoint via RUNBOOK)
```

### Adaptive Pipeline Router (v3.2)

Single entry point — the system auto-detects task complexity:

```
pipeline_score = (file_scope × 0.35) + (test_complexity × 0.25)
               + (dependency_depth × 0.25) + (risk_signal × 0.15)
```

| Tier | Score | Pipeline | ~Tokens |
|------|-------|----------|---------|
| **Frugal** | < 0.3 | Error Spec → Fix → Gate 1 → Commit | ~5-15K |
| **Standard** | 0.3~0.65 | PP(light) → Error Spec → Single Phase → Gate 1 → Commit | ~20-40K |
| **Frontier** | > 0.65 | Full 9+ step pipeline | ~50-100K+ |

**Dynamic Escalation**: On circuit break, auto-escalates frugal→standard→frontier, preserving completed work.

**Keyword hints**: `"mpl bugfix"` → frugal, `"mpl small"` → standard, `"mpl"` → auto.

### State Machine

```
mpl-init -> mpl-decompose -> mpl-phase-running <-> mpl-phase-complete
                 ^                    |                      |
                 +-- mpl-circuit-break               mpl-finalize -> completed
                           |
                       mpl-failed
```

---

## Phase 0 Enhanced

Pre-specification process validated with empirical data from 7 experiments. Invest in Phase 0 to eliminate the need for Phase 5 (debugging/fixing).

### Complexity Detection (3-Grade)

```
complexity_score = (modules x 10) + (external_deps x 5) + (test_files x 3)
```

| Grade | Score | Phase 0 Steps | Token Budget |
|-------|-------|---------------|-------------|
| Simple | 0~29 | Error Spec only | ~8K |
| Medium | 30~79 | Example + Error | ~12K |
| Complex | 80+ | Full Suite (API + Example + Type + Error) | ~20K |

### 4-Step Process

| Step | Source | Output | Condition |
|------|--------|--------|-----------|
| 1. API Contract Extraction | Function signatures, parameter order | `api-contracts` | Complex+ |
| 2. Example Pattern Analysis | Usage patterns, defaults, edge cases | `examples` | Medium+ |
| 3. Type Policy Definition | Type hints, collection type rules | `type-policy` | Complex+ |
| 4. Error Specification | Standard exceptions, message patterns | `error-spec` | All (required) |

### Token Budget Rebalance

```
v1.0 (~81K total)              v3.2 (adaptive)
Phase 0:  ~5K  ( 6%)           Phase 0: 8~20K (16~40%)  <- strengthened
Phase 1-3: ~45K (57%)          Phase 1-3: ~36K (60~72%)
Phase 4:  ~15K (19%)           Phase 4:  ~6K  (11~12%)
Phase 5:  ~16K (20%)           Phase 5:  ~0K  ( 0%)     <- eliminated
```

---

## Build-Test-Fix Micro-Cycles

Phase Runner performs immediate verification per TODO:

```
For each TODO:
  Build  -> Worker implements
  Test   -> Run tests immediately
  Fix    -> Fix on failure (max 2 attempts)

After all TODOs:
  Test Agent -> Independent test writing/execution (code author != test author)
  Cumulative Verification -> Full test suite regression check
```

---

## Components

### Agents (11)

| Agent | Role | Model | Tool Restrictions |
|-------|------|-------|-------------------|
| `mpl-interviewer` | Pivot Point interview (hypothesis-as-options) | opus | Write/Edit/Bash/Task blocked |
| `mpl-pre-execution-analyzer` | Gap + Tradeoff unified analysis (7-section output) | sonnet | Write/Edit/Bash/Task blocked |
| `mpl-decomposer` | Phase decomposition + built-in risk_assessment | opus | Write/Edit/Bash/Task blocked |
| `mpl-verification-planner` | A/S/H-items classification and verification strategy | sonnet | Write/Edit/Task blocked |
| `mpl-phase-runner` | Phase execution (mini-plan, delegation, verification) | sonnet | None |
| `mpl-worker` | TODO implementation specialist | sonnet | Task blocked |
| `mpl-test-agent` | Independent test writing/execution (separated from code author) | sonnet | None |
| `mpl-code-reviewer` | 8-category code review and Quality Gate | sonnet | Write/Edit/Task blocked |
| `mpl-compound` | Learning extraction and knowledge distillation | sonnet | None |
| `mpl-git-master` | Atomic commits | sonnet | Write/Edit/Task blocked |
| `mpl-doctor` | Installation diagnostics (10 categories, standalone detection) | haiku | Write/Edit/Task blocked |

### Agent Pipeline Flow

```
                    [Step -1: LSP Warm-up]
                            |
mpl-interviewer -----> mpl-pre-execution-analyzer
       |                        |
       v                        v
  Pivot Points         Gap + Tradeoff Report
                                |
mpl-verification-planner <------+
       |
       v
  A/S/H Verification Plan
       |
mpl-decomposer <---------------+ (built-in risk_assessment)
       |
       v
  Phase Decomposition (YAML)
       |
mpl-phase-runner (per phase) ----> mpl-worker (per TODO)
       |                                |
       |                     mpl-test-agent (after all TODOs)
       |
mpl-code-reviewer <--------------------+ (Gate 2: Quality)
       |
       v
  3-Gate Quality Check
       |
mpl-compound <-------------------------+ (Finalize)
       |
mpl-git-master <------------------------+ (Atomic Commits)
```

### Skills (7)

| Skill | Purpose |
|-------|---------|
| `/mpl:mpl` | Main MPL pipeline — single entry point with auto tier routing |
| `/mpl:mpl-pivot` | Pivot Points interview (standalone or pipeline) |
| `/mpl:mpl-status` | Pipeline status dashboard |
| `/mpl:mpl-cancel` | Clean cancellation with state preservation |
| `/mpl:mpl-resume` | Resume from last checkpoint |
| `/mpl:mpl-doctor` | Installation diagnostics |
| `/mpl:mpl-setup` | Setup wizard |

> **Deprecated**: `/mpl:mpl-small` and `/mpl:mpl-bugfix` still work but redirect to `/mpl:mpl` with tier hints.

### Hooks (4)

| Hook | Event | Purpose |
|------|-------|---------|
| `mpl-write-guard` | PreToolUse (Edit/Write) | Blocks orchestrator from editing source files |
| `mpl-validate-output` | PostToolUse (Task) | Validates agent output against expected schema |
| `mpl-phase-controller` | Stop | Manages phase transitions and loop continuation |
| `mpl-keyword-detector` | UserPromptSubmit | Detects "mpl" keyword and initializes pipeline |

### State Directory: `.mpl/`

| Path | Purpose |
|------|---------|
| `.mpl/state.json` | Pipeline state |
| `.mpl/pivot-points.md` | Immutable constraints (Pivot Points) |
| `.mpl/config.json` | User configuration overrides |
| `.mpl/mpl/state.json` | MPL execution state (lsp_servers, phases, etc.) |
| `.mpl/mpl/decomposition.yaml` | Phase decomposition output |
| `.mpl/mpl/phase-decisions.md` | Accumulated Phase Decisions (3-Tier) |
| `.mpl/mpl/pre-execution-analysis.md` | Gap + Tradeoff unified analysis |
| `.mpl/mpl/phase0/` | Phase 0 Enhanced artifacts |
| `.mpl/mpl/phases/phase-N/` | Per-phase artifacts (mini-plan, state-summary, verification, recovery) |
| `.mpl/mpl/RUNBOOK.md` | Integrated execution log for session continuity |
| `.mpl/mpl/profile/` | Token/timing profile (phases.jsonl, run-summary.json) |
| `.mpl/memory/routing-patterns.jsonl` | Past execution patterns for tier prediction |
| `.mpl/memory/learnings.md` | Run-to-run accumulated learnings |
| `.mpl/cache/phase0/` | Phase 0 cached artifacts |
| `.mpl/mpl/metrics.json` | Pipeline metrics |

---

## Verification System

### A/S/H-items Classification

| Type | Name | Verified By | Example |
|------|------|-------------|---------|
| A-item | Agent-Verifiable | Exit code check | `npm test` exits 0 |
| S-item | Sandbox Agent Testing | Gate 1 automated tests | Given/When/Then |
| H-item | Human-Required | Gate 3 Side Interview | UX judgment, visual review |

### 3-Gate Quality System

| Gate | Method | Agent | Pass Criteria |
|------|--------|-------|---------------|
| Gate 1 | Automated tests (A + S items) | mpl-phase-runner (cumulative) | pass_rate >= 95% |
| Gate 2 | Code review (8 categories) | mpl-code-reviewer | PASS verdict |
| Gate 3 | PP compliance + H-items resolution | Orchestrator + Human | No PP violations + H-items resolved |

### Convergence Detection

Tracks pass rate history in fix loops for automatic decisions:

| Status | Condition | Action |
|--------|-----------|--------|
| `improving` | delta > min_improvement | Continue |
| `stagnating` | variance < 5% AND delta < threshold | Strategy change suggestion |
| `regressing` | delta < -10% | Revert or review Phase 0 artifacts |

### Partial Rollback on Circuit Break

On circuit break, PASS TODOs are preserved and only FAIL TODO files are rolled back. Recovery context is saved to `.mpl/mpl/phases/phase-N/recovery.md` for use in redecomposition.

---

## Phase Decision 3-Tier System

Token budget management for inter-phase decision transfer:

| Tier | Content | Token Budget | When |
|------|---------|-------------|------|
| Tier 1 (Active) | Full detail | ~400-800 | Files intersect current phase impact |
| Tier 2 (Summary) | 1-line summary | ~90-240 | Architectural/API PDs not touching current files |
| Tier 3 (Archived) | IDs only | Minimal | Not relevant to current phase |

## Maturity Modes

| Mode | Phase Size | PP Required | Discovery Handling |
|------|-----------|-------------|-------------------|
| `explore` | S (1-3 TODOs) | Optional | Auto-approved |
| `standard` | M (3-5 TODOs) | Required | HITL on PP conflict |
| `strict` | L (5-7 TODOs) | Required + enforced | All changes HITL |

## Triage Integration

| Triage Result | Interview Behavior |
|---------------|-------------------|
| `full` | 4 Rounds: What -> What NOT -> Either/Or -> How to Judge |
| `light` | 2 Rounds: What -> What NOT only |
| `skip` | No interview, extract PPs from prompt directly |

## LSP Integration

LSP servers are pre-warmed at pipeline start to eliminate cold starts:

| Language | LSP Server | Used For |
|----------|-----------|----------|
| TypeScript/JS | typescript-language-server | Type inference, diagnostics, references |
| Python | pylsp / pyright | Type checking, symbol navigation |
| Go | gopls | Interface tracking, compile errors |
| Rust | rust-analyzer | Lifetime/borrow checking, trait tracking |

Falls back to ast_grep_search + Grep when LSP is not installed.

## Standalone Mode

When LSP/AST MCP tools are unavailable, MPL automatically uses fallback tools:

| MCP Tool (unavailable) | Standalone Fallback | Used In |
|------------------------|-------------------|---------|
| `lsp_hover` | `Grep` + `Read` | Phase 0 API contract extraction |
| `lsp_find_references` | `Grep` (import/require patterns) | Codebase centrality analysis |
| `lsp_goto_definition` | `Grep` + `Glob` | Dependency tracking |
| `lsp_diagnostics` | `Bash(tsc --noEmit)` / `Bash(python -m py_compile)` | Worker result validation |
| `lsp_document_symbols` | `Grep` (function/class definition patterns) | Interface extraction |
| `ast_grep_search` | `Grep` (regex patterns) | Phase 0, codebase analysis |

> All pipeline features are fully functional in standalone mode.
> Installing an LSP MCP server enables additional precision analysis via LSP/AST tools.

---

## Usage

```bash
# Auto-routing (recommended) — system determines tier automatically
mpl add user authentication           # → likely frontier
mpl add validation to signup           # → likely standard
mpl fix null check in handleSubmit     # → likely frugal

# Keyword hints (optional) — override auto-routing
mpl bugfix missing null check          # → forces frugal tier
mpl small fix login button style       # → forces standard tier

# Direct skill invocation
/mpl:mpl
```

## Diagnostics

```
/mpl:mpl-doctor
```

## Testing

```
node --test hooks/__tests__/*.test.mjs
```

## Design Reference

- Full specification: `docs/design.md`
- Roadmap overview: `docs/roadmap/overview.md`
- Adaptive Router plan: `docs/roadmap/adaptive-router-plan.md`
- Phase 1 Foundation: `docs/roadmap/phase1-foundation.md`
- Phase 2 Incremental: `docs/roadmap/phase2-incremental.md`
- Phase 3 Automation: `docs/roadmap/phase3-automation.md`
- Experiments summary: `docs/roadmap/experiments-summary.md`
