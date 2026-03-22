# v3.2 Sprint Plan

> Remaining 10 items organized into 4 Sprints, starting from Sprint 1 completion criteria.
> Written: 2026-03-08

---

## Completed: Sprint 1 — Adaptive Router Core (F-20, F-21, F-10, F-14)

Single entry point + automatic tier classification + dynamic escalation + RUNBOOK-based foundation.

---

## Completed: Sprint 2 — Cross-Run Learning and Session Continuity (F-12, F-11, F-22)

> Theme: "A pipeline that remembers" — lessons persist after execution ends, context is maintained across sessions.

| ID | Item | Priority | Dependencies | Key Deliverables |
|----|------|---------|--------|-----------|
| F-11 | Cross-Run Learning Accumulation | HIGH | F-10 (RUNBOOK) complete | `.mpl/memory/learnings.md`, mpl-compound distillation logic |
| F-12 | Intra-Session Context Persistence | HIGH | None | `<remember priority>` marking protocol, RUNBOOK dual safety net |
| F-22 | Routing Pattern Learning | MED | F-20 (Router) complete | `.mpl/memory/routing-patterns.jsonl`, Jaccard matching |

### Dependency Graph

```
F-10 (RUNBOOK, complete) ──→ F-11 (learning distillation)
                              │
F-20 (Router, complete) ──→ F-22 (pattern learning) ←─ F-11 (separate file from learnings but recorded simultaneously in Finalize)

F-12 (context persistence) ──→ independent, but synergizes when applied with F-11
```

### Implementation Order

1. **F-12** — Insert `<remember priority>` tag protocol at phase transition points in mpl-run.md. Most independent, immediate effect.
2. **F-11** — RUNBOOK decisions/issues → learnings.md distillation logic. Add distillation step to mpl-run-finalize.md.
3. **F-22** — routing-patterns.jsonl recording/matching. Add pattern reference to Triage, add result recording to Finalize.

### Acceptance Criteria

- [ ] Current phase/PP summary/failure cause is preserved after session compaction (F-12)
- [ ] failure/success patterns are automatically recorded in learnings.md after execution (F-11)
- [ ] learnings.md is automatically loaded in the next run's Phase 0 (F-11)
- [ ] Execution results are appended to routing-patterns.jsonl (F-22)
- [ ] Previous tier is recommended when re-running a similar task (F-22)

---

## Completed: Sprint 3 — Phase Runner Execution Engine Enhancement (F-24, F-23, F-13)

> Theme: "Faster and more autonomous execution" — Phase Runner works in parallel and finds its own context.

| ID | Item | Priority | Dependencies | Key Deliverables |
|----|------|---------|--------|-----------|
| F-23 | Task-based TODO Management | MED | None | Task tool-based TODO dispatch, mini-plan.md replacement |
| F-13 | Background Execution | MED | Synergy with F-23 | `run_in_background: true` parallel workers, file conflict detection integration |
| F-24 | Self-Directed Context | MED | None | Phase Runner scope-bounded search allowed |

### Dependency Graph

```
F-23 (Task TODO) ←──synergy──→ F-13 (Background Exec)
  │                              │
  └── manage independent TODOs as Tasks      └── run independent Tasks in parallel

F-24 (Self-Directed Context) ── independent, but scope can be passed in F-23 Task structure
```

### Implementation Order

1. **F-24** — Allow Read/Grep in Phase Runner + define scope boundary. Most independent, immediately improves execution quality.
2. **F-23** — Switch mini-plan.md checkboxes → Task tool. Redesign Phase Runner protocol.
3. **F-13** — Parallel dispatch of independent TODOs as `run_in_background: true` on top of F-23 Task structure.

### Acceptance Criteria

- [ ] Phase Runner directly reads/greps files within the impact scope to acquire context (F-24)
- [ ] TODOs are managed as Task tools and state is synchronized between workers (F-23)
- [ ] Independent TODOs without file conflicts run in parallel (F-13)
- [ ] Sequential execution is automatically forced when file conflicts are detected (F-13)

---

## Completed: Sprint 4 — Quality Infrastructure and Independence (F-16, F-17, F-04)

> Theme: "More accurate and lighter MPL" — lightweight exploration agent, type safety, OMC independence.

| ID | Item | Priority | Dependencies | Key Deliverables |
|----|------|---------|--------|-----------|
| F-16 | mpl-scout agent | MED | None | haiku-based exploration agent (Read/Glob/Grep/LSP only) |
| F-17 | lsp_diagnostics_directory integration | MED | None | Project-wide type check before Gate 1, standalone fallback |
| F-04 | Standalone Independent Operation | HIGH | Synergy with F-17 | OMC dependency removal, Grep/Glob fallback, mpl-doctor diagnostics |

### Dependency Graph

```
F-16 (scout) ── independent. Deployed in Phase 0, Fix Loop, Phase Runner support

F-17 (diagnostics) ──→ F-04 (standalone)
  │                      │
  └── tool_mode=full     └── if standalone, tsc/py_compile fallback
```

### Implementation Order

1. **F-16** — Define mpl-scout agent. Create agents/mpl-scout.md, haiku model, read-only tools only.
2. **F-17** — Add lsp_diagnostics_directory call to Gate 1. Standalone fallback specification.
3. **F-04** — Implement Grep/Glob fallback path when OMC tools (lsp_*, ast_grep) are absent. Complete mpl-setup, mpl-doctor.

### Acceptance Criteria

- [ ] mpl-scout achieves 50%+ token savings compared to sonnet/opus in Phase 0 structure analysis (F-16)
- [ ] Project-wide type errors are detected before Gate 1 (F-17)
- [ ] Full MPL pipeline operates normally in environments without OMC installed (F-04)
- [ ] `/mpl:mpl-doctor` diagnoses missing tools and reports fallback status (F-04)

---

## Completed: Sprint 5 — 4-Tier Memory and Advanced Isolation (F-25, F-15, F-05)

> Theme: "More efficient and secure MPL" — 4-Tier Adaptive Memory, risky operation isolation, cache improvements.
> Updated: 2026-03-13 reflecting research results (F-25: 3-Tier → 4-Tier expansion)

| ID | Item | Priority | Dependencies | Key Deliverables |
|----|------|---------|--------|-----------|
| F-25 | 4-Tier Adaptive Memory | HIGH | F-11, F-24 | episodic.md, semantic.md, procedural.jsonl, working.md, 70%+ token savings |
| F-15 | Worktree Isolated Execution | MED | None | Execute risk=HIGH phases in worktree, merge on success |
| F-05 | Phase 0 Cache Partial Invalidation | LOW | None | Re-analyze changed modules only, git diff-based invalidation |

### Dependency Graph

```
F-25 (4-Tier Memory) ──→ F-11 (learnings.md)
  │                         │
  └── episodic/semantic/    └── procedural.jsonl → learnings.md distillation
      procedural/working

F-25 ──→ F-24 (Self-Directed Context)
  │         │
  └── procedural.jsonl reference  └── prefer effective tools first

F-25 ──→ F-27 (Reflexion, Sprint 6)
  │         │
  └── procedural.jsonl repository  └── store reflection results by category

F-15, F-05 — independent
```

### Implementation Order

1. **F-25** — 4-Tier Adaptive Memory. Synthesis of RUC DeepAgent + Letta(MemGPT) + latest memory research.
   - Step 1: `episodic.md` — append summary at Phase completion + time-based compression (latest 2 Phases detailed, older ones 1-2 lines)
   - Step 2: `semantic.md` — generalize patterns repeated 3+ times from episodic as project knowledge
   - Step 3: `procedural.jsonl` — collect tool usage patterns + classification tags (type_mismatch, dependency_conflict, etc.)
   - Step 4: `working.md` — dynamic update of current Phase TODO (Phase Runner autonomous updates)
   - Step 5: Selective loading in Phase 0 — filter only relevant memory by similarity, not full files
   - Step 6: Add 4-tier memory load to Phase Runner protocol
2. **F-15** — Create worktree/merge/cleanup protocol when Pre-Execution Analysis determines risk=HIGH.
3. **F-05** — Add git diff-based partial invalidation to Phase 0 cache. Re-analyze only modules with changed files.

### Acceptance Criteria

- [ ] 70%+ token savings on context loading when running Phase 5+ (F-25)
- [ ] Tool success/failure patterns are collected with classification tags in procedural.jsonl (F-25)
- [ ] Time-based compression applied to episodic.md — latest 2 Phases detailed, older ones compressed (F-25)
- [ ] Patterns repeated 3+ times are automatically generalized and stored in semantic.md (F-25)
- [ ] Only relevant memory is selectively loaded from Phase 0 (not full file load) (F-25)
- [ ] mpl-compound automatically distills procedural.jsonl → learnings.md (F-25)
- [ ] 20-30% additional reduction in Phase 0 time for repeated projects (semantic.md effect) (F-25)
- [ ] risk=HIGH phases are executed in isolation in worktree and automatically merged on success (F-15)
- [ ] Only the changed module is re-analyzed without a full Phase 0 re-run when 1 file changes (F-05)

---

---

## Completed: Sprint 6 — Socratic Interview Integration and Learning Enhancement (F-26, F-27, F-28)

> Theme: "Smarter MPL" — Socratic interview integrates PP + requirements, Reflexion enhances learning, dynamic routing optimizes execution.
> Added: 2026-03-13 new Sprint based on research results.
> Updated: 2026-03-13 — F-26 redirected from separate PM stage to mpl-interviewer v2 integration.

| ID | Item | Priority | Dependencies | Key Deliverables |
|----|------|---------|--------|-----------|
| F-26 | mpl-interviewer v2: Socratic integrated interview | MED | None (upgrade of existing mpl-interviewer) | Integrated output (PP + requirements.md), good/bad examples archive |
| F-27 | Reflexion-based Fix Loop Learning | MED | F-25 (procedural.jsonl) | Reflection Template, classified pattern storage, selective loading |
| F-28 | Phase-level Dynamic Agent Routing | MED | None | Decomposer `phase_domain` tag, domain-specific prompt matching |

### F-26 Design Direction: Integration into Existing vs. Separate Stage

**Previous direction (discarded)**: Add `needs_pm` judgment to Triage → Activate separate Step 0.5-PM → New mpl-pm agent
**New direction (adopted)**: Upgrade existing mpl-interviewer to v2. Automatically adjust PM role scope based on `interview_depth` (skip/light/full)

**Rationale**:
1. Existing Triage's `interview_depth` already adjusts interview depth in 3 levels by scope
2. PM Socratic question Round 2 ("What must never be broken?") is practically the same as PP discovery
3. Having users receive PM interview + PP interview consecutively causes fatigue
4. UAM uam-pm already includes a PP section in its output — no benefit in separating

**Integrated behavior by `interview_depth`**:

| depth | PP (existing) | Requirements (new) | Socratic questions | Solution options |
|-------|----------|---------------|-------------|-----------|
| `skip` | Extract directly from prompt | None | None | None |
| `light` | Round 1-2 (What + What NOT) | Lightweight structured (US + AC) | Clarification + assumption exploration only | None |
| `full` | Round 1-4 full | Full JUSF (JTBD + US + Gherkin AC) | **All 6 types** | **3+ options + matrix** |

### Dependency Graph

```
mpl-interviewer (existing, complete) ──→ F-26 (v2 upgrade)
  │                                │
  └── interview_depth 3 levels         └── automatic PM role expansion by depth
      + PP discovery                         + Socratic questions + option comparison
                                            + JUSF output + good/bad archive

F-25 (4-Tier Memory) ──→ F-27 (Reflexion)
  │                        │
  └── procedural.jsonl      └── store reflection results by category
                               Fix Loop success rate improvement

F-28 (Dynamic Routing) ── independent (Decomposer output expansion)
```

### Implementation Order

1. **F-26** — mpl-interviewer v2: Socratic integrated interview
   - Step 1: Upgrade existing `mpl-interviewer.md` agent to v2 (no separate agent creation needed)
   - Step 2: Add Socratic 6-type question library when `interview_depth=full`
     - Clarification / Assumption exploration / Rationale / Perspective shift / Consequence exploration / Meta (ref AI_PM)
     - Adapt to coding agent context (market fit → technical assumptions/scope challenge)
   - Step 3: Present 3+ solution options + tradeoff matrix when `interview_depth=full`
     - Complexity / token cost / test coverage / dependency risk axes
   - Step 4: Integrated output schema — PP + JUSF (JTBD + User Stories + Gherkin AC) single deliverable
     - Dual-Layer: YAML frontmatter (pipeline parsing) + Markdown body (user review)
     - MoSCoW + sequence_score priority
   - Step 5: Add lightweight requirement structuring when `interview_depth=light` (US + AC only)
   - Step 6: Evidence tagging (🟢data/🟡inference/🔴assumption) + preserve Socratic dialogue log
   - Step 7: Multi-perspective review (engineer/architect/user) — full only
   - Step 8: `.mpl/pm/good-examples/`, `.mpl/pm/bad-examples/` archive + F-25 memory integration
   - Step 9: Downstream connections — integrated output → Phase 0 (constraints) / Decomposer (order) / Test Agent (Gherkin)
2. **F-27** — Reflexion-based Fix Loop Learning
   - Step 1: Design Reflection Template — failed TODO → symptom → root cause → first deviation point → correction strategy → learning extraction
   - Step 2: Execute Reflection upon Fix Loop entry (insert into Phase Runner protocol)
   - Step 3: Store reflection results in procedural.jsonl with pattern classification tags (type_mismatch, dependency_conflict, test_flake, etc.)
   - Step 4: Integrate mpl-code-reviewer feedback into reflection when Gate 2 fails (MAR pattern)
   - Step 5: Selectively load only relevant patterns from Phase 0 based on task description similarity
3. **F-28** — Phase-level dynamic agent routing
   - Step 1: Add `phase_domain` tag to Decomposer output (db/api/ui/algorithm/test/infra)
   - Step 2: Domain-specific prompt template library (`.mpl/prompts/domains/`)
   - Step 3: Phase Runner automatically selects matching prompt from `phase_domain`
   - Step 4: Optimal model routing by domain (DB→sonnet, complex algorithm→opus)

### Acceptance Criteria

- [ ] Socratic 6-type questions are executed when `interview_depth=full` (F-26)
- [ ] 3+ solution options are presented with a tradeoff matrix when `interview_depth=full` (F-26)
- [ ] PP + lightweight requirements (US+AC) are output in a single interview when `interview_depth=light` (F-26)
- [ ] Existing behavior (direct PP extraction) is unchanged when `interview_depth=skip` (F-26)
- [ ] Integrated output is generated as YAML frontmatter + Markdown body Dual-Layer (F-26)
- [ ] Gherkin AC is converted into test cases by Test Agent (F-26)
- [ ] good/bad examples archive is automatically classified based on user approval/rejection (F-26)
- [ ] PP + requirements resolved simultaneously in 1 interview — no increase in user interview count compared to before (F-26)
- [ ] Reflection Template is executed when entering Fix Loop (F-27)
- [ ] Reflection results are stored in procedural.jsonl with classification tags (F-27)
- [ ] Similar patterns are selectively loaded in the next run's Phase 0 (F-27)
- [ ] Fix Loop success rate improves compared to without Reflexion (A/B comparison) (F-27)
- [ ] Decomposer output includes `phase_domain` tag (F-28)
- [ ] Phase Runner automatically selects domain-specific prompt (F-28)

---

## Overall Timeline

```
Sprint 1 (complete)  ██████████  F-20, F-21, F-10, F-14     ← router/RUNBOOK
Sprint 2 (complete)  ██████████  F-12, F-11, F-22            ← learning/persistence
Sprint 3 (complete)  ██████████  F-24, F-23, F-13            ← execution engine
Sprint 4 (complete)  ██████████  F-16, F-17, F-04            ← quality/independence
Sprint 5 (complete)  ██████████  F-25, F-15, F-05            ← 4-Tier memory/isolation
Sprint 6 (complete)  ██████████  F-26, F-27, F-28            ← PM/Reflexion/dynamic routing
Sprint 7             ░░░░░░░░░░  F-33                        ← session autonomous continuity
```

## Inter-Sprint Dependencies

```
Sprint 1 ──→ Sprint 2 (F-10→F-11, F-20→F-22)
Sprint 2 ──→ Sprint 3 (learnings referenced in Phase Runner)
Sprint 3 ──→ Sprint 4 (F-16 scout complements F-24 self-directed)
Sprint 4 ──→ Sprint 5 (F-11→F-25 procedural.jsonl distillation, F-24→F-25 tool selection)
Sprint 5 ──→ Sprint 6 (F-25→F-27 procedural.jsonl repository, F-20→F-26 Triage expansion)
Sprint 6 ──→ Sprint 7 (F-31/F-32→F-33 compaction data + adaptive loading)
```

**Sprint 5 highlights:**
- F-25 expanded from 3-Tier to 4-Tier (semantic.md added)
- Automatic episodic→semantic integration shortens Phase 0 for repeated projects
- Automatic procedural.jsonl → learnings.md distillation (mpl-compound)
- Maximize token savings with time-based compression + selective loading

**Sprint 6 highlights:**
- F-26 (PM Skill) extends Phase 0 pre-specification to business level
- F-27 (Reflexion) structures Fix Loop learning to reduce failure repetition
- F-28 (dynamic routing) improves Phase execution quality through domain specialization
- All three features can be progressively integrated into the existing pipeline (non-invasive)

---

## Sprint 7 — Session Autonomous Continuity (F-33)

> Theme: "Uninterrupted pipeline" — predict session limits and automatically continue.
> Added: 2026-03-14

| ID | Item | Priority | Dependencies | Key Deliverables |
|----|------|---------|--------|-----------|
| F-33 | Session Budget Prediction & Auto-Continue | HIGH | F-31 (compaction tracker), F-32 (adaptive loading) | `mpl-budget-predictor.mjs`, `context-usage.json` HUD bridge, `session-handoff.json` protocol, `mpl-session-watcher.sh` |

### Implementation Components

1. **HUD File Bridge** — mpl-hud.mjs records context window usage in `.mpl/context-usage.json` every ~500ms
2. **Budget Predictor** — `mpl-budget-predictor.mjs`: remaining context + average tokens per Phase + remaining Phase count → pause judgment
3. **Graceful Pause Protocol** — Step 4.8: generate handoff signal + save state + record in RUNBOOK
4. **External Watcher** — `tools/mpl-session-watcher.sh`: detect handoff → start new Claude session with `/mpl:mpl-resume`
5. **Resume Integration** — Step 6: recognize `paused_budget` state + auto-cleanup and resume

### Acceptance Criteria

- [ ] HUD creates `.mpl/context-usage.json` file when receiving context_window stdin
- [ ] Budget predictor returns `pause_now` when context usage exceeds 90%
- [ ] Budget predictor returns `pause_after_current` when remaining Phase budget is exceeded
- [ ] Returns fail-open (continue) when `context-usage.json` is absent
- [ ] `.mpl/signals/session-handoff.json` is created on graceful pause
- [ ] `session_status: "paused_budget"` is recorded in state.json on graceful pause
- [ ] Pause record is added to RUNBOOK on graceful pause
- [ ] `paused_budget` state is correctly restored when running `/mpl:mpl-resume` in a new session
- [ ] Watcher starts a new session after detecting the handoff signal
- [ ] Watcher in `--notify-only` mode outputs message only
