# MPL Design References

A record of external sources and projects that provided inspiration.

---

## v3.2 — Adaptive Pipeline Router + Docs-as-Memory

### Ouroboros (Q00/ouroboros)

- **Repository**: https://github.com/Q00/ouroboros
- **Analysis date**: 2026-03-07
- **Influence scope**: F-20, F-21, F-22, README structure

#### Referenced Concepts

| Ouroboros Concept | MPL Adaptation | Applied Location |
|---------------|---------|----------|
| **PAL Router** (Progressive Adaptive LLM Router) — 3-tier cost model (Frugal 1x / Standard 10x / Frontier 30x) | Pipeline Score formula + 3-tier classification (frugal/standard/frontier) | `hooks/lib/mpl-scope-scan.mjs` |
| Automatic escalation after 2 consecutive failures | Automatic tier promotion on circuit break (F-21) | `hooks/lib/mpl-state.mjs`, `hooks/mpl-phase-controller.mjs` |
| Automatic downgrade after 5 consecutive successes | Routing Pattern Learning + Jaccard similarity (F-22, planned) | `docs/roadmap/overview.md` |
| Pattern matching based on Jaccard similarity (threshold 0.8) | routing-patterns.jsonl + next run tier recommendation (F-22, planned) | `docs/roadmap/overview.md` |
| README "From Wonder to Ontology" narrative structure | "From Chaos to Coherence" philosophy section | `README.md` |
| "The Nine Minds" agent catalog | "The Fifteen Minds" core principles included | `README.md` |

#### Differences

| Area | Ouroboros | MPL |
|------|----------|-----|
| Routing target | LLM model selection (haiku/sonnet/opus) | Entire pipeline structure selection (frugal/standard/frontier) |
| Escalation trigger | Consecutive failure count (2 times) | Circuit break + convergence state |
| Downgrade | Automatic at runtime (5 consecutive successes) | Pattern matching at next run (F-22) |
| Score formula | Cost multiplier per model | 4-factor weighted score (files/tests/dependencies/risk) |
| Implementation language | Python (SQLAlchemy, aiosqlite) | JavaScript (Node.js hooks) |

---

### Codex Long-Horizon Tasks

- **Source**: https://www.linkedin.com/posts/gb-jeong_run-long-horizon-tasks-with-codex-activity-7435825294554484736-hBEX
- **Analysis date**: 2026-03-07
- **Influence scope**: F-10 (RUNBOOK.md), v3.2 "documents as memory" axis

#### Referenced Concepts

| Concept | MPL Adaptation | Applied Location |
|------|---------|----------|
| 4-Document mapping (prompt/plans/implement/documentation) | Confirmed MPL documents 1~3 mapping + discovered absence of 4th (documentation) → introduced RUNBOOK.md | `docs/roadmap/overview.md` 4-Document mapping table |
| `docs/documentation.md` — audit log and shared memory | `.mpl/mpl/RUNBOOK.md` — auto-updated at 9 checkpoints | F-10, all protocol files |
| Cross-session continuity guarantee | Session resume via RUNBOOK loading | `commands/mpl-run-finalize.md` Step 6 |

---

### Seeing like an Agent (Thariq, Claude Code team)

- **Source**: https://x.com/trq212/status/2027463795355095314
- **Author**: Thariq (Claude Code @Anthropic)
- **Analysis date**: 2026-03-08
- **Influence scope**: F-23, F-24, F-16 expansion

#### Referenced Lessons

| Lesson | MPL Adaptation | Applied Location |
|------|---------|----------|
| **TodoWrite → Task Tool evolution** — As model capabilities increase, existing tools become constraints. Replace checkbox lists with inter-agent communication tools | Phase Runner's mini-plan.md checkboxes → Task tool-based TODO management (F-23) | `docs/roadmap/overview.md` F-23 |
| **RAG → self-directed search** — More effective to have agents "build context themselves" than to "provide" it | Allow Phase Runner scope-bounded search (F-24). Reduce orchestrator context assembly dependency | `docs/roadmap/overview.md` F-24 |
| **Progressive Disclosure** — Instead of bloating system prompts, load subagent/skill files on demand | Orchestrator search *(was mpl-scout F-16, removed v0.11.0)* as Phase Runner context assistant. Guide subagent pattern | `docs/roadmap/overview.md` F-16 |
| **AskUserQuestion tool** — Structured questions are more effective than plain text | Already applied in F-14 (Side Interview + PP Interview) | No change |

#### Patterns Already Well-Applied in MPL

| Pattern | MPL Counterpart |
|------|---------|
| Progressive Disclosure (load only when needed) | 4-part protocol split (phase0/decompose/execute/finalize), Phase 0 complexity adaptation |
| Feature expansion without adding tools | SKILL.md → mpl-run.md → per-stage file chain |
| AskUserQuestion structuring | F-14: Side Interview + PP Interview |
| Agent separation (code author ≠ tester) | Phase Runner ≠ Test Agent, Orchestrator ≠ Worker |

#### Key Quotes

> *"As model capabilities increase, the tools that your models once needed might now be constraining them. It's important to constantly revisit previous assumptions on what tools are needed."*

> *"Claude was given this context instead of finding the context itself."*

> *"We were able to add things to Claude's action space without adding a tool."*

---

### QMD + "Grep Is Dead" (ArtemXTech / Tobi Lütke)

- **QMD Repository**: https://github.com/tobi/qmd
- **Article**: https://x.com/ArtemXTech/status/2028330693659332615
- **Analysis date**: 2026-03-09
- **Influence scope**: F-25 (Scout QMD integration), mpl-setup Step 3g

#### Referenced Concepts

| Concept | MPL Adaptation | Applied Location |
|------|---------|----------|
| **BM25 + Semantic + LLM Reranking** — 3-stage hybrid search pipeline | Added qmd_search, qmd_deep_search, qmd_vector_search to orchestrator's available tools | *(v1: `agents/mpl-scout.md` — removed in v2, Scout functionality absorbed by orchestrator)* |
| **/recall pattern** — Load past context before session starts | 2-layer search: QMD recall (Layer 1) → Live tools (Layer 2) | *(v1: `agents/mpl-scout.md` — removed in v2)* |
| **Cross-session learning accumulation** — JSONL → Markdown → QMD indexing automation | Register .mpl/ artifacts as QMD collection, recall past analysis results | `skills/mpl-setup/SKILL.md` Step 3g |
| **MCP server integration** — Expose 6 tools to Claude Code via qmd mcp | Scout searches QMD via MCP, 0 LLM tokens | `agents/mpl-doctor.md` Category 10 |

#### Differences

| Area | ArtemXTech Approach | MPL Approach |
|------|----------------|---------|
| Indexing target | Obsidian vault + Claude Code sessions | Codebase + MPL artifacts (.mpl/) |
| Primary use | General-purpose /recall skill | Scout agent exclusive (Phase 0, Fix Loop) |
| Fallback strategy | None (QMD required) | Automatic Grep/Glob fallback (QMD optional) |
| Embedding updates | Automatic via session-end hook | Currently manual (automation planned) |

---

### SG-Loop (Test Design & Specification Philosophy)

- **Source**: No independent repository — directly integrated into UAM plugin (`UAM/docs/design_unified_agent_methodology.md`)
- **Author**: kbshin (same author as this project)
- **Analysis date**: 2026-02 ~ 2026-03
- **Influence scope**: Entire Phase 0 Enhanced, experimental design methodology
- **Prior influence**: SG-Loop developed inspired by Hoyeon's test design philosophy

#### Referenced Concepts

| Concept | MPL Adaptation | Applied Location |
|------|---------|----------|
| **Experiment-based verification** — hypothesis → experiment → measure → iterate | Individually verified Phase 0 techniques through 7 experiments (Exp 1~8) | `docs/roadmap/experiments-summary.md` |
| **Specification-first philosophy** — extract specifications from tests first | Phase 0 order: API contracts → example patterns → type policy → error specification | `commands/mpl-run-phase0.md` Step 2.5 |
| **Monotonically increasing cumulative pass rate** — scores must increase monotonically when techniques are added | Verified Exp 1 (38%) → Exp 7 (100%); remove technique if regression occurs | Basis for Phase 0 step selection |
| **Code author ≠ test author** — separation principle | Worker ≠ Test Agent, Orchestrator ≠ Worker | Agent Separation Principle |

#### Prior Influence: Hoyeon

Hoyeon's test design philosophy — particularly the perspective that "tests are specifications" and the verification-driven development approach — influenced the design philosophy of SG-Loop. SG-Loop extended this into the agent pipeline context to derive the "prevention is better than cure" principle, which is the direct origin of MPL's second law ("tokens invested in Phase 0 completely eliminate the debugging cost of Phase 5").

---

## v3.0~v3.1 — Based on Internal Experiments

### 7 Experiments (Exp 1~8, excluding Exp 2)

Empirical basis for Phase 0 Enhanced design. Verified that cumulative pass rate increases monotonically as each experiment adds one Phase 0 technique.

| Experiment | Technique | Cumulative Pass Rate | v3.0 Reflection |
|------|------|-----------|----------|
| Exp 1 | API Contract Extraction | 38% → 100% | Phase 0 Step 1 |
| Exp 3 | Example Pattern Analysis | 58% → 100% | Phase 0 Step 2 |
| Exp 4 | Type Policy Definition | 65% → 100% | Phase 0 Step 3 |
| Exp 5 | Test Stub Generation | 77% → 100% | Build-Test-Fix |
| Exp 6 | Incremental Testing | 83% → 100% | Incremental Verification |
| Exp 7 | Error Specification | 100% | Phase 0 Step 4 |
| Exp 8 | Hybrid Verification | 100% | 3-Gate Quality |

Details: `docs/roadmap/overview.md` experiment performance matrix, `docs/roadmap/experiments-summary.md`
