# MPL (Micro-Phase Loop) v0.10.2

**Prevention over cure. Specification over debugging.**

A Claude Code plugin that decomposes ambitious tasks into micro-phases — each independently planned, executed, and verified in isolation — so context never corrupts and failures never cascade.

[Quick Start](#quick-start) · [Philosophy](#from-chaos-to-coherence) · [How](#the-loop) · [Pipeline Router](#the-router) · [Agents](#the-fourteen-minds) · [Under the Hood](#under-the-hood)

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

The moment the orchestrator touches source files, it becomes invested in its own implementation. It defends its code instead of objectively verifying it. MPL enforces separation with a PreToolUse hook that warns the orchestrator when it attempts to edit source files directly. All code flows through `mpl-phase-runner` agents via Task delegation.

---

## Quick Start

**Step 1 — Add marketplace & install:**

```bash
# Register the MPL marketplace (one-time)
claude plugin marketplace add https://github.com/KyubumShin/MPL.git

# Install the plugin
claude plugin install mpl
```

Or from inside Claude Code:

```
/plugin marketplace add https://github.com/KyubumShin/MPL.git
/plugin install mpl
```

<details>
<summary><strong>Alternative: Manual installation</strong></summary>

```bash
# As a git submodule
cd /path/to/your-project
git submodule add https://github.com/KyubumShin/MPL.git

# Load locally for testing without installing
claude --plugin-dir ./MPL
```

</details>

**Step 2 — Run setup:**

```
/mpl:mpl-setup
```

The setup wizard automatically:
- Creates runtime directories (`.mpl/`)
- Detects available tools (LSP, AST, QMD)
- Configures standalone fallbacks if needed
- Optionally enables the HUD statusline

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
Phase Execution   → 4 phases × (plan → execute → test → verify)
5-Gate Quality    → Gate 0.5: types, Gate 1: tests, Gate 1.5: coverage, Gate 2: review, Gate 3: PP
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
              │    Plan → Phase Runner → Test → Verify │
              │    Output: State Summary only     │
              └────────────────┬────────────────┘
                               │
                    ┌──────────▼──────────────┐
                    │  5-Gate Quality Check    │
                    │  Types → Tests →        │
                    │  Coverage → Review → PP │
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
| **Execute** | Fresh session per phase, Phase Runner delegation, micro-test cycles | No context pollution |
| **5-Gate** | Type check → Tests → Coverage → Code review → PP compliance | Evidence-based completion |
| **RUNBOOK** | Continuous audit log for human/agent session continuity | Pick up where you left off |

### State Summary: The Only Bridge

Between phases, only one artifact passes: the **State Summary**. It contains what was built, what was decided, and what was verified — nothing else. No code snippets, no debugging history, no abandoned approaches.

This is the key insight: **forgetting is a feature**. Each phase starts clean, with only the structured knowledge it needs. The orchestrator manages context assembly — loading the right summaries, the right Phase Decisions, the right impact files — so the Phase Runner operates with perfect information density.

### Build-Test-Fix: The Micro-Cycle

Inside each phase, every TODO gets immediate verification:

```
For each TODO:
  Build  → Phase Runner implements the change directly
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

## The Fourteen Minds

Fourteen agents, each with a single purpose. Loaded on-demand, never preloaded:

| Agent | Role | Core Principle |
|-------|------|---------------|
| **Interviewer** | Socratic questioning for Pivot Points | "What are you NOT willing to compromise on?" |
| **Ambiguity Resolver** | PP-Aligned Spec Resolution — 5D metric-based Socratic loop with PP Conformance | "Can we derive a spec that conforms to these PPs?" |
| **Codebase Analyzer** | Project structure analysis (haiku) | "What exists before we plan?" |
| **Phase 0 Analyzer** | Pre-execution deep analysis | "Type policy, error spec, build constraints" |
| **Pre-Execution Analyzer** | Gap + Tradeoff unified analysis | "What's missing? What's risky?" |
| **Decomposer** | Break into ordered micro-phases | "What depends on what?" |
| **Verification Planner** | A/S/H-items classification | "What can machines verify vs. what needs humans?" |
| **Phase Runner** | Execute a single phase end-to-end | "Plan, implement, verify, summarize" |
| **Test Agent** | Independent test writing | "I didn't write the code, so I'll test what it claims" |
| **Code Reviewer** | 10-category quality gate (8 base + 2 UI) | "Would I approve this PR?" |
| **Scout** | Lightweight codebase exploration (haiku) | "Find it fast, spend nothing" |
| **Compound** | Learning extraction and distillation | "What did we learn that future runs should know?" |
| **Git Master** | Atomic commits | "Each commit tells one story" |
| **QA Agent** | Browser QA via Claude in Chrome MCP (Gate 1.7) | "Does the UI actually render?" |
| **Phase Seed Generator** | Per-phase immutable spec with TODO structure | "What exactly should this phase build?" |
| **Doctor** | Installation diagnostics (11 categories) | "Is everything wired correctly?" |

### Agent Separation Principle

The Phase Runner who implements code is never the Test Agent who verifies it. The Decomposer who plans is never the Phase Runner who executes. The Orchestrator who assembles context never touches source files. Each separation eliminates a class of bias.

---

## Verification System

### A/S/H Classification

Not all verification is equal. MPL classifies every criterion:

| Type | Name | Verified By | Example |
|------|------|-------------|---------|
| **A-item** | Agent-Verifiable | Exit code, file exists | `npm test` exits 0 |
| **S-item** | Sandbox Testing | BDD scenarios, Given/When/Then | Integration test passes |
| **H-item** | Human-Required | Side Interview with user | UX judgment, visual review |

### 5-Gate Quality System

Five gates ensuring evidence-based completion:

| Gate | Method | Pass Criteria |
|------|--------|---------------|
| **Gate 0.5** | Project-wide type check (`lsp_diagnostics_directory`) | Zero type errors (F-17) |
| **Gate 1** | Automated tests (A + S items) | pass_rate ≥ 95% |
| **Gate 1.5** | Coverage + metrics (F-50) | coverage ≥ 60% (MVP) / 80% (strict) |
| **Gate 2** | Code review (10 categories) | PASS verdict |
| **Gate 3** | PP compliance + H-item resolution | No violations + all H-items resolved |

### Convergence Detection

Fix loops track pass rate history for automatic decisions:

| Status | Condition | Action |
|--------|-----------|--------|
| `progressing` | delta > min_improvement | Continue fixing |
| `stagnating` | variance < 5% AND delta < threshold | Change strategy or escalate |
| `regressing` | delta < -10% | Revert or review Phase 0 artifacts |

---

## Under the Hood

<details>
<summary><strong>14 agents · 8 hooks · 11 skills · 5 protocol files</strong></summary>

```
MPL/
├── agents/                 # 14 agent definitions (YAML frontmatter)
│   └── mpl-scout.md        # Haiku-based read-only exploration (F-16)
├── commands/               # Orchestration protocols (split for token efficiency)
│   ├── mpl-run.md          # Router: which protocol file to load
│   ├── mpl-run-phase0.md   # Steps -1 ~ 2.5: Triage, PP, Phase 0
│   ├── mpl-run-decompose.md # Steps 3 ~ 3-F: Decomposition + feedback loop
│   ├── mpl-run-execute.md  # Step 4: Execution loop, 5-Gate, Fix loop
│   └── mpl-run-finalize.md # Steps 5 ~ 6: Finalize, Resume
├── prompts/                # 4-Layer template system (F-39)
│   ├── domains/            # 8 domain templates (base layer)
│   ├── subdomains/         # 19 tech-stack templates
│   ├── tasks/              # 6 task-type overlays
│   └── langs/              # 5 language templates
├── hooks/                  # 8 hooks across 6 events
│   ├── mpl-write-guard.mjs       # Warns orchestrator on source file edits
│   ├── mpl-validate-output.mjs   # Validates agent output schemas
│   ├── mpl-phase-controller.mjs  # Phase transitions + escalation (F-21)
│   ├── mpl-keyword-detector.mjs  # "mpl" keyword → pipeline init
│   ├── mpl-auto-permit.mjs       # Learned auto-permission (F-34)
│   ├── mpl-permit-learner.mjs    # Permission pattern learning (F-34)
│   ├── mpl-compaction-tracker.mjs # Compaction checkpoint (F-31)
│   ├── mpl-session-init.mjs      # Context rotation init (F-38)
│   └── lib/
│       ├── mpl-state.mjs         # State management + escalation
│       ├── mpl-scope-scan.mjs    # Pipeline score calculation (F-20)
│       ├── mpl-cache.mjs         # Phase 0 caching
│       ├── mpl-profile.mjs       # Token profiling
│       └── mpl-routing-patterns.mjs # Routing pattern learning (F-22)
├── skills/                 # 11 skills
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
- **mpl-scout (F-16)** — Haiku-based exploration with Grep/Glob/LSP, optional QMD semantic search
- **Gate 0.5 Type Check (F-17)** — Project-wide `lsp_diagnostics_directory` before Gate 1
- **4-Layer Templates (F-39)** — Domain + Subdomain + Task Type + Language prompt composition
- **Standalone Mode (F-04)** — Auto-detect tool availability, Grep/Glob fallbacks when LSP/AST unavailable
- **Phase 0 Caching** — Hash-based cache key, skip entire Phase 0 on cache hit (~8-25K tokens saved)
- **2-Tier PD** — Phase Decisions classified Active/Summary per phase for bounded token budget
- **Convergence Detection** — Stagnation (variance < 5%), regression (delta < -10%), strategy suggestions
- **Dangerous Command Detection (T-01, v3.8)** — Bash safety guard for rm -rf, DROP TABLE, git push --force, etc.
- **Core-First Phase Ordering (T-12, v3.8)** — CORE → EXTENSION → SUPPORT sort within dependency tiers
- **Compaction Recovery (F-31, v3.8)** — Read-side checkpoint loading after context compression
- **Post-Execution Review (T-10, v3.9)** — H-item severity routing: HIGH blocks, MED/LOW defer to Step 5.5
- **Phase-Scoped File Lock (T-01 P2, v3.9)** — Warn on writes outside current phase's declared scope
- **Budget Pause & Resume (F-33, v3.9)** — Auto-pause on context exhaustion, handoff signal for watcher
- **Feasibility 2-Layer Defense (T-11, v4.0)** — INFEASIBLE detection in Stage 2 + RE_INTERVIEW in Decomposer
- **Browser QA Gate (T-03, v4.0)** — Claude in Chrome MCP UI verification (Gate 1.7, non-blocking)
- **PR Creation (T-04, v4.0)** — Auto PR with Gate evidence via `gh pr create`
- **MCP Server Tier 1 (M-01, v0.5.1)** — Deterministic ambiguity scoring + active state read/write via MCP tools
- **2-Pass Decomposition + Phase Seed (D-01, v0.6.0)** — JIT seed generation, deterministic TODOs, acceptance mapping
- **2-Level Parallelism (D-01, v0.6.0)** — TODO parallel graph (within phase) + EXTENSION/SUPPORT phase parallel (between phases)

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
| `.mpl/mpl/phase-decisions.md` | Accumulated Phase Decisions (2-Tier) |
| `.mpl/mpl/phase0/` | Phase 0 Enhanced artifacts |
| `.mpl/mpl/phases/phase-N/` | Per-phase artifacts (mini-plan, state-summary, verification) |
| `.mpl/mpl/profile/` | Token/timing profile (phases.jsonl, run-summary.json) |
| `.mpl/memory/learnings.md` | Run-to-Run accumulated learnings (F-11) |
| `.mpl/memory/routing-patterns.jsonl` | Past execution patterns for tier prediction (F-22) |
| `.mpl/cache/phase0/` | Phase 0 cached artifacts |

---

## HUD (Statusline)

MPL provides a real-time statusline that shows pipeline progress at a glance:

```
harness_lab | 5h:45%(3h42m) | wk:12%(2d5h) | ctx:67% | 12m
MPL Frontier | Sprint | TODO:3/7 | Gate:✓-- | Fix:2/10 | tok:45.2K/500.0K
```

**Line 1 — Project & Usage:**
- Project folder, API rate limits (5-hour / 7-day from Anthropic OAuth API), context window %, session duration

**Line 2 — Pipeline Status (MPL active only):**
- Pipeline tier (Frugal/Standard/Frontier), current phase
- TODO progress, Gate results (✓/✗/-), Fix loop count
- Token usage vs budget, tool mode

**Color coding:**
- Rate limits: green <70%, yellow 70-90%, red ≥90% (with reset countdown)
- Context: green <70%, yellow 70-85%, red ≥85%
- Fix loop & tokens: yellow at 50%+, red at 80%+

**Activate:** Run `/mpl:mpl-setup` → enable HUD, or manually:
```json
// ~/.claude/settings.json
{ "statusLine": { "type": "command", "command": "node <MPL_ROOT>/hooks/mpl-hud.mjs" } }
```

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

## Versioning

MPL is pre-1.0 (development stage). Follows `0.MAJOR.PATCH`:

| Position | Meaning | Examples |
|----------|---------|---------|
| 0.**X**.0 | Structural change or major feature batch | MCP server, Stage 2 redesign, new gates |
| 0.0.**X** | Bug fix, prompt change, skill update, translation | OMC cleanup, Korean→English |

`1.0.0` will be assigned after production validation and stabilization.

---

## Design Reference

- Full specification: [`docs/design.md`](./docs/design.md)
- Roadmap: [`docs/roadmap/overview.md`](./docs/roadmap/overview.md)
- Adaptive Router plan: [`docs/roadmap/adaptive-router-plan.md`](./docs/roadmap/adaptive-router-plan.md)
- Standalone mode: [`docs/standalone.md`](./docs/standalone.md)
- Full references: [`docs/REFERENCES.md`](./docs/REFERENCES.md)

---

## References

MPL draws inspiration from various external projects and articles.

| Area | Source | MPL Application |
|------|--------|----------------|
| **Pipeline Router** | [Ouroboros (Q00)](https://github.com/Q00/ouroboros) — PAL Router 3-tier cost model | Adaptive Pipeline Router (F-20, F-21, F-22) |
| **Test Design** | SG-Loop (integrated in UAM) — experiment-based verification design, Phase 0 specification philosophy *(influenced by Hoyeon's test design philosophy)* | Phase 0 Enhanced (7 experiments → 4-step specification) |
| **Session Memory** | [QMD (Tobi Lütke)](https://github.com/tobi/qmd) — local hybrid search (BM25+vector+reranking) | Scout QMD integration (F-25) |
| **Grep Is Dead** | [ArtemXTech](https://x.com/ArtemXTech/status/2028330693659332615) — /recall pattern, cross-session context persistence | Scout 2-layer search strategy |
| **Long-Horizon Tasks** | [Codex docs pattern](https://www.linkedin.com/posts/gb-jeong_run-long-horizon-tasks-with-codex-activity-7435825294554484736-hBEX) — 4-Document mapping | RUNBOOK.md (F-10) |
| **Agent Design** | [Seeing like an Agent (Thariq, Anthropic)](https://x.com/trq212/status/2027463795355095314) — self-directed search, progressive disclosure | F-23, F-24, F-16 |
| **Software Factory** | [gstack (Garry Tan)](https://github.com/garrytan/gstack) — 25-skill sprint lifecycle, design-first approach, cross-model review | Temp roadmap: Safety Guard, Cross-Model Review, Ship Pipeline |

Detailed analysis: [`docs/REFERENCES.md`](./docs/REFERENCES.md)

---

*"The best debugging session is the one that never happens."*

**MPL doesn't fix bugs faster — it prevents them from existing.**
