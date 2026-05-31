# MPL (Micro-Phase Loop) v0.19.0

**Prevention over cure. Specification over debugging.**

An agent workflow plugin for Claude Code and Codex CLI that decomposes ambitious tasks into micro-phases — each independently planned, executed, and verified in isolation — so context never corrupts and failures never cascade.

[Quick Start](#quick-start) · [Philosophy](#from-chaos-to-coherence) · [How](#the-loop) · [Pipeline Depth](#pipeline-depth-v017) · [Agents](#the-agent-roster) · [Under the Hood](#under-the-hood)

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

The moment the orchestrator touches source files, it becomes invested in its own implementation. It defends its code instead of objectively verifying it. MPL enforces separation with a PreToolUse hook (`mpl-write-guard`) that BLOCKS unsafe direct source edits by default — including Bash redirect/tee/sed-i/dd-of/cp-mv/git-apply write paths (Move #6) — and downgrades to a warning only for in-scope edits. `mpl-cancel` SKILL paths and `decomposition.yaml` writer identity are hard-protected (#236). All code flows through `mpl-phase-runner` agents via Task delegation.

---

## Quick Start

**Step 1 — Install for your agent runtime:**

Install with the bootstrap script for the runtime you use. Git is optional; the script downloads a clean MPL source archive with `curl` when it is not run from a checkout.

```bash
# Claude Code
curl -fsSL https://raw.githubusercontent.com/KyubumShin/MPL/main/install.sh | bash -s -- --runtime claude --scope user

# Codex CLI
curl -fsSL https://raw.githubusercontent.com/KyubumShin/MPL/main/install.sh | bash -s -- --runtime codex

# Both runtimes (the scope flag applies to Claude Code)
curl -fsSL https://raw.githubusercontent.com/KyubumShin/MPL/main/install.sh | bash -s -- --runtime both --scope user
```

The installer stores the downloaded MPL source under `~/.mpl/install/source/mpl` by default. Claude Code installs default to `--scope user`; pass `--scope ask` to choose interactively from Bash, where Enter selects `user`, or pass `--scope project`/`--scope local` for explicit non-interactive installs. `--scope ask` requires a real interactive TTY even when used with `curl | bash`; use an explicit scope in CI or other headless runs. For reproducible installs, pin a release tag by passing the env var to `bash`, for example `curl -fsSL https://raw.githubusercontent.com/KyubumShin/MPL/main/install.sh | MPL_REF=v0.19.0 bash -s -- --runtime codex`. Set `MPL_INSTALL_ROOT=<path>` to choose another install root.

When `install.sh` is run from a local checkout, that local source takes precedence; `--ref`/`MPL_REF` will warn unless `MPL_FORCE_DOWNLOAD=1` is set. To inspect before running, download the script first: `curl -fsSLo /tmp/mpl-install.sh https://raw.githubusercontent.com/KyubumShin/MPL/main/install.sh && less /tmp/mpl-install.sh && bash /tmp/mpl-install.sh --runtime codex`.

The installers keep runtime-specific marketplace metadata separate. Claude registers the persistent MPL source directly; Codex creates a small wrapper marketplace under `$CODEX_HOME/mpl-marketplace` (or `~/.codex/mpl-marketplace`) and stages a clean MPL plugin root at `./plugins/mpl` from the archive manifest.

**Refresh note:** after updating MPL, rerun the same `install.sh` command. Existing installs pick up the shared MCP launcher after rerun; the first MCP call after each refresh may prepare dependencies and rebuild the MCP server.

<details>
<summary><strong>Alternative: Manual installation</strong></summary>

```bash
# Local checkout install
git clone https://github.com/KyubumShin/MPL.git
cd MPL
./install.sh --runtime both --scope user
# or install Claude only into the project scope
./install/claude.sh --scope project

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
- Detects available tools (LSP, AST)
- Configures standalone fallbacks if needed
- Optionally enables the HUD statusline
- Registers the MPL MCP server for the active runtime when available

**Step 3 — Start building:**

```
mpl add user authentication with OAuth and role-based access
```

<details>
<summary><strong>What just happened?</strong></summary>

```
Goal Contract  → AC/AX frozen, real_runtime_required computed
Phase 0        → API contracts + type policy + error spec + raw scan
Decomposition  → ordered phases with execution_tiers + resource_locks + covers + reviewer_required
Phase Execution → fresh session per phase, Phase Runner + Test Agent (independent author) + Adversarial Reviewer
Gates          → Hard 1 build+types, Hard 2 tests, Hard 3 PP/H-item closure (no Advisory)
Finalize       → E2E real-runtime, Codex Audit (Tier 4), Atomic Commit
RUNBOOK        → resume-safe execution log
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
                    │  3 Hard Gates           │
                    │  Hard 1: Build+Types    │
                    │  Hard 2: Tests          │
                    │  Hard 3: PP Compliance  │
                    └──────────┬──────────────┘
                               │
                           Complete
```

| Step | What Happens | Why It Matters |
|------|-------------|----------------|
| **Pivot Points** | Socratic interview extracts immutable constraints | Prevent scope drift |
| **Phase 0** | Pre-specification: contracts, types, errors | Eliminate debugging |
| **Decompose** | Break into ordered phases with interface contracts | Each phase is independently verifiable |
| **Execute** | Fresh session per phase, Phase Runner delegation, micro-test cycles | No context pollution |
| **3 Hard Gates** | Tests (Hard 2) → PP+H-items (Hard 3) + Build/Types (Hard 1) | Evidence-based completion |
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
3. Transition to `phase5-finalize` (partial completion)

Circuit break leads directly to pipeline failure. MPL reports what succeeded and what failed — partial progress is always preserved.

---

## Pipeline Depth (v0.17+)

v0.17 removed the Hat/Triage front-door. Every prompt now enters at full
depth: Phase 0 Enhanced → Decomposition → Phase Execution → 3 Hard Gates →
Finalize. The decomposer decides scope (phase count, execution_tiers,
resource_locks). Dynamic escalation, PP-proximity tiers, and keyword
overrides ("mpl bugfix" / "mpl small") are gone — they are no longer
recognized by mpl-keyword-detector.

---

## The Agent Roster

Eleven agents, each with a single purpose. Loaded on-demand, never preloaded. Grouped by lifecycle stage:

**Interview & Analysis**
| Agent | Role | Model |
|-------|------|-------|
| **Interviewer** | Stage 1 PP discovery + Stage 2 ambiguity resolution. "What are you NOT willing to compromise on?" | opus |
| **Codebase Analyzer** | 6-module structural scan → `codebase-analysis.json` | haiku |
| **Phase 0 Analyzer** | Mechanical raw scan (boundaries, signatures, tests, type/error sites) → `raw-scan.md`. Pure extraction; synthesis moved to Decomposer per #57 | haiku |

**Decomposition & Seed**
| Agent | Role | Model |
|-------|------|-------|
| **Decomposer** | Breaks request into ordered micro-phases, synthesizes per-phase type policy + error spec + verification plan. Sole writer of `decomposition.yaml` | opus |
| **Seed Generator** | Designs per-phase execution specs (chain or inline mode, #58) → `chain-seed.yaml` / `phase-seed.yaml` | opus |

**Execute & Verify**
| Agent | Role | Model |
|-------|------|-------|
| **Phase Runner** | Executes one phase: resolves TODOs, implements directly, verifies, emits State Summary | sonnet |
| **Test Agent** | Independent test writer — code author ≠ test author (AD-0004) | sonnet |
| **Adversarial Reviewer** | Post-phase intent-vs-implementation audit, scores quality, surfaces hidden gaps (#103). Consumed by `mpl-quality-gate.mjs` | sonnet |

**Finalize**
| Agent | Role | Model |
|-------|------|-------|
| **Codex Auditor** | Tier 4 finalize-time intent-vs-impl diff (F6, #117) → `audit-report.json` | haiku |
| **Git Master** | Atomic commit specialist — style detection, semantic splitting (3+ files = 2+ commits) | haiku |

**Diagnostics**
| Agent | Role | Model |
|-------|------|-------|
| **Doctor** | 12-category installation diagnostics. Read-only | haiku |

> The original "Eight Minds" framing predated v0.17/v0.18. Phase 0 was split (Analyzer + Decomposer synthesis per #57) and a dedicated Seed Generator (#58) was carved out; Tier 4 verification added the Adversarial Reviewer (#103) and Codex Auditor (#117, F6); Git Master separates commit hygiene from phase execution. Scout and Compound were absorbed into the orchestrator's grep-based loop and `.mpl/memory/learnings.md` (F-11) respectively.

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

### 3 Hard Gates

Three hard gates that block completion:

| Gate | Type | Method | Pass Criteria |
|------|------|--------|---------------|
| **Hard 1** | **Hard** | Build + Type Check (project-wide) | 0 build errors, 0 type errors |
| **Hard 2** | **Hard** | Automated tests (A + S items) | pass_rate >= 95% |
| **Hard 3** | **Hard** | PP compliance + H-item resolution | No violations + all H-items resolved |

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
<summary><strong>11 agents · 46 hooks · 10 skills · 11 protocol files</strong></summary>

```
MPL/
├── agents/                # 11 agents (mpl-adversarial-reviewer, mpl-codebase-analyzer,
│                          #   mpl-codex-auditor, mpl-decomposer, mpl-doctor, mpl-git-master,
│                          #   mpl-interviewer, mpl-phase-runner, mpl-phase0-analyzer,
│                          #   mpl-seed-generator, mpl-test-agent)
├── commands/              # 11 protocol files (mpl-run + run-phase0/decompose/execute/finalize splits)
├── prompts/               # 4-Layer template system (F-39)
├── hooks/
│   ├── hooks.json         # 6 events × 1 entrypoint (PreCompact / PreToolUse / PostToolUse
│   │                      #   / Stop / SessionStart / UserPromptSubmit)
│   ├── mpl-engine.mjs     # v2 dispatcher — single entrypoint for all 6 events
│   ├── mpl-*.mjs          # 46 hook modules (36 with .legacy siblings during the v2 cutover,
│   │                      #   routed through lib/dispatch.mjs ROUTES)
│   └── lib/
│       ├── dispatch.mjs              # ROUTES table per event
│       ├── state/                    # reader / writer / writer-cli / shard-writer / wave-reducer (schema v7)
│       ├── policy/                   # 12 v2 policy modules: audit, channel-registry, contracts,
│       │                             #   envelope-bridge, evidence, gates, isolation, permit,
│       │                             #   scheduler, schemas, session-init, source-edit
│       │                             #   + reconcile/ (4 modules)
│       ├── observability/            # bootstrap / signals / trackers
│       └── migrations/               # v1→v7 schema migration chain
├── skills/                # 10 skills (mpl, mpl-pivot, mpl-status, mpl-cancel, mpl-resume,
│                          #   mpl-recover, mpl-gap-analysis, mpl-version-bump, mpl-doctor, mpl-setup)
└── docs/
    ├── design.md
    ├── redesign-proposal.html   # v2 architecture rationale + Stage A move log
    ├── standalone.md
    ├── config-schema.md
    └── roadmap/
```

**Key internals:**

- **Policy Engine (v2, #18)** — 12 policy modules under hooks/lib/policy/ replace 36 standalone hook decisions; .legacy.mjs siblings retained for one cycle as rollback tier.
- **Single-Dispatcher Hook Surface (v2 #14)** — hooks.json shrinks from 39 entries to 6 (one per event); mpl-engine.mjs fans out via lib/dispatch.mjs ROUTES.
- **State Sharding + Wave Reducer (v2 #17)** — concurrent phase workers write shard files; wave-reducer collapses them into .mpl/state.json (schema v7).
- **Scheduler + Isolation (v2 #16)** — ExecutionContext threads scheduler decisions and isolation policy through the dispatch layer.
- **Audit Policy + Tier 4 Drift Gating (v2 #13)** — Codex Auditor verdict gates finalize.
- **RUNBOOK (F-10)** — Integrated execution log, auto-updated at pipeline transition points, enables session resume.
- **Session Persistence (F-12)** — `<remember priority>` tags at phase transitions + RUNBOOK dual safety net.
- **Run-to-Run Learning (F-11)** — Orchestrator distills RUNBOOK → `.mpl/memory/learnings.md`.
- **Self-Directed Context (F-24)** — Phase Runner can Read/Grep within scope-bounded impact files.
- **Task-based TODO (F-23)** — TaskCreate/TaskUpdate as primary TODO state manager during execution.
- **Background Execution (F-13)** — Independent TODOs dispatched with `run_in_background: true`.
- **Hard 1 Build+Type Check** — Project-wide build and type checking (consolidates previous Gate 0.5).
- **4-Layer Templates (F-39)** — Domain + Subdomain + Task Type + Language prompt composition.
- **Standalone Mode (F-04)** — Auto-detect tool availability, Grep/Glob fallbacks when LSP/AST unavailable.
- **2-Tier PD** — Phase Decisions classified Active/Summary per phase for bounded token budget.
- **Convergence Detection** — Stagnation (variance < 5%), regression (delta < -10%), strategy suggestions.
- **MCP Server Tier 1 (M-01, v0.5.1)** — Deterministic ambiguity scoring + active state read/write via MCP tools.
- **2-Pass Decomposition + Phase Seed (D-01, v0.6.0)** — JIT seed generation, deterministic TODOs, acceptance mapping.
- **2-Level Parallelism (D-01, v0.6.0)** — TODO parallel graph (within phase) + EXTENSION/SUPPORT phase parallel (between phases).

</details>

## v2 Architecture

The v0.19.0 release is the closing cut of the Stage A v2 redesign (moves
#1–#18). The hook layer moved from 39 entries in hooks.json calling
individual scripts to a single mpl-engine.mjs dispatcher routing 46
modules through lib/dispatch.mjs ROUTES, with policy decisions
consolidated into hooks/lib/policy/. Full rationale, before/after
diagrams, and the per-move log live in
[`docs/redesign-proposal.html`](./docs/redesign-proposal.html).

### State Directory: `.mpl/`

| Path | Purpose |
|------|---------|
| `.mpl/state.json` | Unified pipeline + execution state (schema v7, v1→v7 migration chain in hooks/lib/migrations/). Contains `run_mode`, `current_phase`, `tool_mode`, and the `execution` subtree (task, phase_details, totals, cumulative_pass_rate) — formerly split across two files. |
| `.mpl/pivot-points.md` | Immutable constraints (Pivot Points) |
| `.mpl/config.json` | User configuration overrides |
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
MPL Full | Sprint | TODO:3/7 | Gate:✓-- | Fix:2/10 | tok:45.2K/500.0K
```

**Line 1 — Project & Usage:**
- Project folder, API rate limits (5-hour / 7-day from Anthropic OAuth API), context window %, session duration

**Line 2 — Pipeline Status (MPL active only):**
- Current phase
- TODO progress, Gate results (✓/✗/-), Fix loop count
- Token usage vs budget, tool mode

**Color coding:**
- Rate limits: green <70%, yellow 70-90%, red ≥90% (with reset countdown)
- Context: green <70%, yellow 70-85%, red ≥85%
- Fix loop & tokens: yellow at 50%+, red at 80%+

**Activate:** Run `/mpl:mpl-setup` → enable HUD, or manually:
```json
// ~/.claude/settings.json
{ "statusLine": { "type": "command", "command": "node <MPL_ROOT>/cli/mpl-hud.mjs" } }
```

---

## Usage

```bash
# Just say what you want — the decomposer sizes the pipeline
mpl add user authentication with OAuth
mpl add input validation to signup form
mpl fix null check in handleSubmit

# Direct skill invocation
/mpl:mpl

# Diagnostics
/mpl:mpl-doctor

# Hook-block recovery after resume reports blocked_hook
/mpl:mpl-recover

# Hook-chain visibility for a canonical artifact
node hooks/lib/mpl-hook-trace.mjs .mpl/mpl/decomposition.yaml
```

Codex also discovers the same MPL skills from the plugin. Use `mpl ...` in a Codex session, or invoke the installed MPL skill by name from the skills menu.

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
| **Session Memory** | [QMD (Tobi Lütke)](https://github.com/tobi/qmd) — local hybrid search (BM25+vector+reranking) *(historical influence; QMD integration removed in v0.14.2/v0.15.3)* | Originally Scout QMD integration; Scout functionality absorbed by orchestrator in v2 with grep-based search |
| **Grep Is Dead** | [ArtemXTech](https://x.com/ArtemXTech/status/2028330693659332615) — /recall pattern, cross-session context persistence *(historical)* | Originally Scout 2-layer search; Scout removed in v2 |
| **Long-Horizon Tasks** | [Codex docs pattern](https://www.linkedin.com/posts/gb-jeong_run-long-horizon-tasks-with-codex-activity-7435825294554484736-hBEX) — 4-Document mapping | RUNBOOK.md (F-10) |
| **Agent Design** | [Seeing like an Agent (Thariq, Anthropic)](https://x.com/trq212/status/2027463795355095314) — self-directed search, progressive disclosure | F-23, F-24, F-16 |
| **Software Factory** | [gstack (Garry Tan)](https://github.com/garrytan/gstack) — 25-skill sprint lifecycle, design-first approach, cross-model review | Temp roadmap: Safety Guard, Cross-Model Review, Ship Pipeline |

Detailed analysis: [`docs/REFERENCES.md`](./docs/REFERENCES.md)

---

*"The best debugging session is the one that never happens."*

**MPL doesn't fix bugs faster — it prevents them from existing.**
