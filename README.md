# MPL (Micro-Phase Loop) v3.2

**Prevention over cure. Specification over debugging.**

A Claude Code plugin that decomposes ambitious tasks into micro-phases — each independently planned, executed, and verified in isolation — so context never corrupts and failures never cascade.

[Quick Start](#quick-start) · [Philosophy](#from-chaos-to-coherence) · [How](#the-loop) · [Pipeline Router](#the-router) · [Agents](#the-eleven-minds) · [Under the Hood](#under-the-hood)

---

> AI can build anything in isolation. The hard part is building things that compose.
>
> The longer an AI agent runs, the more it forgets what it promised.
> MPL doesn't fight this — it embraces it by giving each phase a fresh mind
> with only the knowledge it needs.

---

## From Chaos to Coherence

> "The best way to predict the future is to prevent the past."

Every autonomous coding pipeline faces the same enemy: **context pollution**. The longer a session runs, the more accumulated state — half-finished ideas, abandoned approaches, stale assumptions — degrades every subsequent decision. By Phase 4, the agent is debugging its own confusion, not your code.

MPL's answer is architectural, not heroic:

```
 Chaos                              Coherence
   🌀                                  🔬
"Build everything at once"  →  "Build one thing perfectly, then forget"
"Fix it later in Phase 5"  →  "Prevent it in Phase 0"
"Trust the agent's memory"  →  "Trust only written artifacts"
```

This isn't a philosophy of caution — it's a philosophy of **compound reliability**. Each micro-phase is small enough to succeed. Each success is recorded as a State Summary. Each subsequent phase reads only that summary, not the messy history of how it was produced.

The result: Phase 10 runs with the same clarity as Phase 1.

### The Two Laws

MPL is built on two empirically validated laws:

**Law 1: Invest in specification, eliminate debugging.**

Seven experiments proved that Phase 0 investment (API contracts, type policies, error specs) monotonically reduces Phase 5 rework. At full specification, debugging drops to zero:

```
Phase 0 Investment    Pass Rate Progression
────────────────      ──────────────────────
No Phase 0            38% → debugging hell
+ API Contracts       58% → still painful
+ Example Patterns    65% → improving
+ Type Policy         77% → almost there
+ Error Spec          100% → zero debugging
```

**Law 2: The orchestrator must never write code.**

The moment the orchestrator touches source files, it becomes invested in its own implementation. It defends its code instead of objectively verifying it. MPL enforces separation with a PreToolUse hook that physically blocks the orchestrator from editing source files. All code flows through `mpl-worker` agents via Task delegation.

---

## Quick Start

**Step 1 — Clone into your project:**

```bash
cd /path/to/your-project
git clone https://github.com/<your-org>/MPL.git
```

**Step 2 — Create runtime directories:**

```bash
mkdir -p .mpl/mpl/{phase0,phases,profile} .mpl/cache/phase0 .mpl/memory
```

**Step 3 — Start building:**

```
mpl add user authentication with OAuth and role-based access
```

<details>
<summary><strong>What just happened?</strong></summary>

```
Quick Scope Scan  → 8 affected files, 4 test scenarios → pipeline_score 0.72
Tier Selection    → Frontier (full pipeline)
PP Interview      → 6 Pivot Points extracted (3 CONFIRMED, 3 PROVISIONAL)
Phase 0 Enhanced  → API contracts + type policy + error spec generated
Decomposition     → 4 micro-phases with interface contracts
Phase Execution   → 4 phases × (plan → worker → test → verify)
3-Gate Quality    → Gate 1: 100% tests, Gate 2: PASS, Gate 3: no PP violations
RUNBOOK           → Full execution log for session continuity
```

Each phase saw only its own context. No pollution. No cascade.

</details>

---

## The Loop

MPL's core is a **decompose-execute-verify** loop where each iteration is a fresh session:

```
                    ┌─── Phase 0: Specify ───┐
                    │  API contracts          │
                    │  Type policies          │
                    │  Error specs            │
                    └──────────┬──────────────┘
                               │
                    ┌──────────▼──────────────┐
                    │  Decompose into N       │
                    │  micro-phases           │
                    └──────────┬──────────────┘
                               │
              ┌────────────────▼────────────────┐
              │  For each phase (fresh session): │
              │    Plan → Worker → Test → Verify │
              │    Output: State Summary only     │
              └────────────────┬────────────────┘
                               │
                    ┌──────────▼──────────────┐
                    │  3-Gate Quality Check    │
                    │  Tests → Review → PP    │
                    └──────────┬──────────────┘
                               │
                           Complete
```

| Step | What Happens | Why It Matters |
|------|-------------|----------------|
| **Triage** | Analyze prompt density, scan scope | Right-size the pipeline |
| **Pivot Points** | Socratic interview extracts immutable constraints | Prevent scope drift |
| **Phase 0** | Pre-specification: contracts, types, errors | Eliminate debugging |
| **Decompose** | Break into ordered phases with interface contracts | Each phase is independently verifiable |
| **Execute** | Fresh session per phase, worker delegation, micro-test cycles | No context pollution |
| **3-Gate** | Automated tests → Code review → PP compliance | Evidence-based completion |
| **RUNBOOK** | Continuous audit log for human/agent session continuity | Pick up where you left off |

### State Summary: The Only Bridge

Between phases, only one artifact passes: the **State Summary**. It contains what was built, what was decided, and what was verified — nothing else. No code snippets, no debugging history, no abandoned approaches.

This is the key insight: **forgetting is a feature**. Each phase starts clean, with only the structured knowledge it needs. The orchestrator manages context assembly — loading the right summaries, the right Phase Decisions, the right impact files — so the Phase Runner operates with perfect information density.

### Build-Test-Fix: The Micro-Cycle

Inside each phase, every TODO gets immediate verification:

```
For each TODO:
  Build  → Worker implements the change
  Test   → Run affected tests immediately (not at the end)
  Fix    → Fix on failure (max 2 retries per TODO)

After all TODOs:
  Test Agent → Independent test writing (code author ≠ test author)
  Cumulative → Full regression check against all prior phases
```

Batching implementation before testing is forbidden. A bug discovered after 5 TODOs could have been caused by any of them. A bug discovered immediately after TODO #3 was caused by TODO #3.

### Circuit Break: Graceful Failure

When a phase fails after 3 retries, it doesn't crash — it **circuit breaks**:

1. Preserve PASS TODOs (verified work is never discarded)
2. Rollback FAIL TODO files to pre-phase state
3. Save recovery context for redecomposition
4. Attempt tier escalation before giving up (see [The Router](#the-router))

Max 2 redecompositions. After that, MPL reports what succeeded and what failed — partial progress is always preserved.

---

## The Router

> The user should never have to judge "is this a small task or a big one?"
> The system should figure it out — and adapt when it's wrong.

### The Problem

As MPL grew more powerful, it became harder to use for simple tasks. Three separate entry points (`mpl` / `mpl-small` / `mpl-bugfix`) forced users to pre-judge task complexity. Get it wrong, and you either waste tokens on a full pipeline for a typo fix, or circuit-break a complex task trapped in a lightweight pipeline with no escalation path.

### The Solution: Adaptive Pipeline Router

One entry point. Auto-scoring. Dynamic escalation.

```
"mpl fix the login bug"              → Triage → Frugal  (~8K tokens)
"mpl add email validation"           → Triage → Standard (~30K tokens)
"mpl refactor the auth system"       → Triage → Frontier (~80K tokens)
```

#### Pipeline Score

Triage runs a Quick Scope Scan (~1-2K tokens) and computes:

```
pipeline_score = (file_scope × 0.35) + (test_complexity × 0.25)
               + (dependency_depth × 0.25) + (risk_signal × 0.15)

file_scope:       min(affected_files / 10, 1.0)
test_complexity:  min(test_scenarios / 8, 1.0)
dependency_depth: min(import_chain_depth / 5, 1.0)
risk_signal:      prompt keyword analysis (0.0 ~ 1.0)
```

#### Three Tiers

| Tier | Score | What Runs | What's Skipped | ~Tokens |
|------|-------|-----------|---------------|---------|
| **Frugal** | < 0.3 | Error Spec → Fix → Gate 1 → Commit | PP, Phase 0, Decomposition, Gate 2/3 | ~5-15K |
| **Standard** | 0.3~0.65 | PP(light) → Error Spec → Single Phase → Gate 1 | Full PP, Phase 0 Steps 1-3, Multi-phase, Gate 2/3 | ~20-40K |
| **Frontier** | > 0.65 | Full 9+ step pipeline | Nothing | ~50-100K+ |

#### Dynamic Escalation

When a tier fails, it doesn't give up — it grows:

```
[Frugal] ──circuit break──→ [Standard] ──circuit break──→ [Frontier]
                                │                              │
                                ├─ Completed TODOs preserved   ├─ Completed phases preserved
                                └─ Failed TODO → single phase  └─ Failed phase → redecompose
```

Keyword hints still work as manual overrides: `"mpl bugfix"` → frugal, `"mpl small"` → standard.

---

## The Twelve Minds

Twelve agents, each with a single purpose. Loaded on-demand, never preloaded:

| Agent | Role | Core Principle |
|-------|------|---------------|
| **Interviewer** | Socratic questioning for Pivot Points | "What are you NOT willing to compromise on?" |
| **Pre-Execution Analyzer** | Gap + Tradeoff unified analysis | "What's missing? What's risky?" |
| **Decomposer** | Break into ordered micro-phases | "What depends on what?" |
| **Verification Planner** | A/S/H-items classification | "What can machines verify vs. what needs humans?" |
| **Phase Runner** | Execute a single phase end-to-end | "Plan, delegate, verify, summarize" |
| **Worker** | Implement a single TODO | "Write the code, run the test" |
| **Test Agent** | Independent test writing | "I didn't write the code, so I'll test what it claims" |
| **Code Reviewer** | 8-category quality gate | "Would I approve this PR?" |
| **Scout** | Lightweight codebase exploration (haiku) | "Find it fast, spend nothing" |
| **Compound** | Learning extraction and distillation | "What did we learn that future runs should know?" |
| **Git Master** | Atomic commits | "Each commit tells one story" |
| **Doctor** | Installation diagnostics | "Is everything wired correctly?" |

### Agent Separation Principle

The Worker who writes code is never the Test Agent who verifies it. The Decomposer who plans is never the Phase Runner who executes. The Orchestrator who assembles context never touches source files. Each separation eliminates a class of bias.

---

## Verification System

### A/S/H Classification

Not all verification is equal. MPL classifies every criterion:

| Type | Name | Verified By | Example |
|------|------|-------------|---------|
| **A-item** | Agent-Verifiable | Exit code, file exists | `npm test` exits 0 |
| **S-item** | Sandbox Testing | BDD scenarios, Given/When/Then | Integration test passes |
| **H-item** | Human-Required | Side Interview with user | UX judgment, visual review |

### 3-Gate Quality System

Four gates, four levels of confidence:

| Gate | Method | Pass Criteria |
|------|--------|---------------|
| **Gate 0.5** | Project-wide type check (`lsp_diagnostics_directory`) | Zero type errors (F-17) |
| **Gate 1** | Automated tests (A + S items) | pass_rate ≥ 95% |
| **Gate 2** | Code review (8 categories) | PASS verdict |
| **Gate 3** | PP compliance + H-item resolution | No violations + all H-items resolved |

### Convergence Detection

Fix loops track pass rate history for automatic decisions:

| Status | Condition | Action |
|--------|-----------|--------|
| `improving` | delta > min_improvement | Continue fixing |
| `stagnating` | variance < 5% AND delta < threshold | Change strategy or escalate |
| `regressing` | delta < -10% | Revert or review Phase 0 artifacts |

---

## Under the Hood

<details>
<summary><strong>12 agents · 4 hooks · 7 skills · 4 protocol files</strong></summary>

```
MPL/
├── agents/                 # 12 agent definitions (YAML)
│   └── mpl-scout.md        # Haiku-based read-only exploration (F-16)
├── commands/               # Orchestration protocols (split for token efficiency)
│   ├── mpl-run.md          # Router: which protocol file to load
│   ├── mpl-run-phase0.md   # Steps -1 ~ 2.5: Triage, PP, Phase 0
│   ├── mpl-run-decompose.md # Steps 3 ~ 3-B: Decomposition
│   ├── mpl-run-execute.md  # Step 4: Execution loop, 3-Gate, Fix loop
│   └── mpl-run-finalize.md # Steps 5 ~ 6: Finalize, Resume
├── hooks/                  # 4 hooks
│   ├── mpl-write-guard.mjs       # Blocks orchestrator from editing source
│   ├── mpl-validate-output.mjs   # Validates agent output schemas
│   ├── mpl-phase-controller.mjs  # Phase transitions + escalation (F-21)
│   ├── mpl-keyword-detector.mjs  # "mpl" keyword → pipeline init
│   └── lib/
│       ├── mpl-state.mjs         # State management + escalation
│       ├── mpl-scope-scan.mjs    # Pipeline score calculation (F-20)
│       ├── mpl-cache.mjs         # Phase 0 caching
│       ├── mpl-profile.mjs       # Token profiling
│       └── mpl-routing-patterns.mjs # Routing pattern learning (F-22)
├── skills/                 # 7 skills
│   ├── mpl/                # Main pipeline (single entry point)
│   ├── mpl-pivot/          # PP interview
│   ├── mpl-status/         # Dashboard
│   ├── mpl-cancel/         # Clean cancellation
│   ├── mpl-resume/         # Resume from checkpoint
│   ├── mpl-doctor/         # Diagnostics
│   └── mpl-setup/          # Setup wizard
└── docs/
    ├── design.md           # Full specification
    ├── standalone.md       # Standalone mode fallback matrix (F-04)
    └── roadmap/            # Evolution history + future plans
```

**Key internals:**

- **Adaptive Router (F-20)** — Quick Scope Scan + 4-factor pipeline score → 3-tier auto-classification
- **Dynamic Escalation (F-21)** — frugal → standard → frontier on circuit break, preserving completed work
- **RUNBOOK (F-10)** — Integrated execution log, auto-updated at 9 pipeline points, enables session resume
- **Session Persistence (F-12)** — `<remember priority>` tags at phase transitions + RUNBOOK dual safety net
- **Run-to-Run Learning (F-11)** — mpl-compound distills RUNBOOK → `.mpl/memory/learnings.md`
- **Routing Pattern Learning (F-22)** — Jaccard similarity matching on past execution patterns
- **Self-Directed Context (F-24)** — Phase Runner can Read/Grep within scope-bounded impact files
- **Task-based TODO (F-23)** — TaskCreate/TaskUpdate as primary TODO state manager during execution
- **Background Execution (F-13)** — Independent TODOs dispatched with `run_in_background: true`
- **mpl-scout (F-16)** — Haiku-based read-only exploration agent for lightweight codebase analysis
- **Gate 0.5 Type Check (F-17)** — Project-wide `lsp_diagnostics_directory` before Gate 1
- **Standalone Mode (F-04)** — Auto-detect tool availability, Grep/Glob fallbacks when LSP/AST unavailable
- **Phase 0 Caching** — Hash-based cache key, skip entire Phase 0 on cache hit (~8-25K tokens saved)
- **3-Tier PD** — Phase Decisions classified Active/Summary/Archived per phase for constant token budget
- **Convergence Detection** — Stagnation (variance < 5%), regression (delta < -10%), strategy suggestions

</details>

### State Directory: `.mpl/`

| Path | Purpose |
|------|---------|
| `.mpl/state.json` | Pipeline state (run_mode, current_phase, pipeline_tier, tool_mode) |
| `.mpl/pivot-points.md` | Immutable constraints (Pivot Points) |
| `.mpl/config.json` | User configuration overrides |
| `.mpl/mpl/state.json` | MPL execution state (phases, statistics) |
| `.mpl/mpl/RUNBOOK.md` | Integrated execution log for session continuity (F-10) |
| `.mpl/mpl/decomposition.yaml` | Phase decomposition output |
| `.mpl/mpl/phase-decisions.md` | Accumulated Phase Decisions (3-Tier) |
| `.mpl/mpl/phase0/` | Phase 0 Enhanced artifacts |
| `.mpl/mpl/phases/phase-N/` | Per-phase artifacts (mini-plan, state-summary, verification) |
| `.mpl/mpl/profile/` | Token/timing profile (phases.jsonl, run-summary.json) |
| `.mpl/memory/learnings.md` | Run-to-Run accumulated learnings (F-11) |
| `.mpl/memory/routing-patterns.jsonl` | Past execution patterns for tier prediction (F-22) |
| `.mpl/cache/phase0/` | Phase 0 cached artifacts |

---

## Usage

```bash
# Just say what you want — the system figures out the rest
mpl add user authentication with OAuth        # → Frontier (~80K tokens)
mpl add input validation to signup form       # → Standard (~30K tokens)
mpl fix null check in handleSubmit            # → Frugal (~8K tokens)

# Keyword hints for manual override
mpl bugfix missing error handler              # → forces Frugal
mpl small add retry logic                     # → forces Standard

# Direct skill invocation
/mpl:mpl

# Diagnostics
/mpl:mpl-doctor
```

## Testing

```bash
node --test hooks/__tests__/*.test.mjs
```

## Design Reference

- Full specification: [`docs/design.md`](./docs/design.md)
- Roadmap: [`docs/roadmap/overview.md`](./docs/roadmap/overview.md)
- Adaptive Router plan: [`docs/roadmap/adaptive-router-plan.md`](./docs/roadmap/adaptive-router-plan.md)
- Standalone mode: [`docs/standalone.md`](./docs/standalone.md)

---

*"The best debugging session is the one that never happens."*

**MPL doesn't fix bugs faster — it prevents them from existing.**
