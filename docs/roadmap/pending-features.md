# MPL Roadmap TEMP: Pending Feature Candidates

> **Status**: Pending implementation (for review)
> **Last updated**: 2026-03-24
> **Purpose**: Consolidated list of all features not yet implemented. Completed items have been moved to `overview.md`.

---

## Migrated to overview.md (Completed)

The following items were completed and documented in `overview.md`:
- F-31 Compaction Recovery → v3.8
- F-33 Session Budget → v3.9
- F-269 remains here (not implemented)

### F-269: RUNBOOK as docs/documentation.md

| ID | Feature | Status | Priority |
|----|---------|--------|----------|
| F-269 | RUNBOOK as docs/documentation.md | ❌ Not implemented | 🟡 Low |

4-Document mapping Axis 1: RUNBOOK.md exists but doesn't match Codex `docs/documentation.md` spec. Audit log + cross-session continuity format needs alignment.

### F-06: Multi-Project Support

| ID | Feature | Status | Priority |
|----|---------|--------|----------|
| F-06 | Multi-Project Support | ❌ Not implemented | 🟡 Low |

Independent pipeline per project in monorepo. Requires `.mpl/` scoping strategy per workspace root.

---

## New Feature Candidates

### Source: gstack analysis (2026-03-22)

## Introduction Candidate Summary

| # | Feature | Inspiration source | Priority | Expected difficulty | Expected token cost |
|---|---------|-------------------|----------|--------------------|--------------------|
| T-01 | ~~Safety Guard enhancement~~ | `/careful`, `/freeze` | ✅ **v3.8 done** | Low (hook extension) | 0 (hook only) |
| T-02 | Cross-Model Review | `/codex` | 🔴 Immediate | Medium (API integration) | ~5-10K/review |
| T-03 | ~~Browser QA Gate (Claude in Chrome)~~ | `/qa` + Chrome MCP | ✅ **v4.0 done** | Medium (MCP integration) | ~5-8K |
| T-04 | ~~Ship Step (PR Creation only)~~ | `/ship` | ✅ **v4.0 done** | Low (git-master extension) | ~2-3K |
| T-05 | Design Contract | `/design-consultation`, `/design-review` | 🟡 Long-term | Medium | ~8-12K |
| T-06 | Doc Sync | `/document-release` | 🟡 Long-term | Low | ~3-5K |
| T-07 | Premise Challenge Mode | `/office-hours` | 🟢 Optional | Low | ~2K |
| T-08 | Trend Retro | `/retro` | 🟢 Optional | Low | ~3K |
| T-09 | Performance Gate | `/benchmark` | 🟢 Optional | Medium | Variable |
| T-10 | ~~Post-Execution Review (Step 5.5)~~ | Ouroboros `/evaluate` | ✅ **v3.9 done** | Low (finalize extension) | ~3-5K |
| T-11 | ~~Feasibility Check — 2-Layer Defense~~ | Ouroboros interview→seed loop | ✅ **v4.0 done** | Medium (existing extension) | ~1-2K (L1) + 0 (L2) |
| T-12 | ~~Core-First Phase Ordering~~ | MVP-first strategy | ✅ **v3.8 done** | Low (decomposer prompt) | 0 (prompt only) |
| M-01 | ~~MCP Server Tier 1 (Score + State)~~ | Ouroboros MCP pattern | ✅ **v0.5.1 done** | High (new server) | Saves ~3-5K/run |
| D-01 | ~~2-Pass Decomposition + Phase Seed + 2-Level Parallelism~~ | Ouroboros Seed + F-13 | ✅ **v0.6.0 done** | High (new agent + flow change) | +15-25K, net positive via Fix Loop reduction |

---

## Completed Feature Details (archived)

Detailed designs for completed features (T-01, T-03, T-04, T-10, T-11, T-12, M-01, D-01, B-01~B-04, R-01) have been archived. See `overview.md` for version-tagged summaries and git history for full design docs.

---

## T-02: Cross-Model Review (Gate 2 Enhancement)

### Inspiration
gstack `/codex` — Independent code review with OpenAI Codex. 3 modes: gate (block), adversarial (challenge), consultation.

### Current MPL State
- `mpl-code-reviewer` (sonnet) single-model 10-category review
- Potential blind spots from using the same model
- "Code author ≠ test author" principle exists, but "reviewer ≠ same model family" does not

### Proposal
1. **Gate 2-B: Cross-Model Review** (optional, activated via config)
   - Create new `mpl-cross-reviewer` agent
   - Request independent review via OpenAI API or Gemini API
   - Compare two review results:
     - Issues flagged by both → auto-fix (high confidence)
     - Flagged by only one → present to user
     - Conflicting opinions → compare rationale then user judgment

2. **Adversarial Mode** — Frontier tier only
   - "Devil's advocate" review that intentionally attacks Phase 0 spec
   - Focus on edge cases, security vulnerabilities, performance traps

### Implementation Location
- New agent: `MPL/agents/mpl-cross-reviewer.md`
- Gate 2 extension: `MPL/docs/design.md` Gate 2 section
- Config: `.mpl/config.json` → `cross_model_review: { enabled: false, provider: "openai" }`

### Open Questions
- [ ] API key management? (env vars vs .mpl/config.json vs separate secret)
- [ ] Default between OpenAI/Gemini?
- [ ] Token cost limit? (max $0.50 per review, etc.)
- [ ] Available in Standard tier too, or Frontier only?

---

## T-05: Design Contract (Phase 0 Extension)

### Inspiration
gstack `/design-consultation` — Research → mockup → DESIGN.md + CLAUDE.md update.
gstack `/design-review` — 80-item design audit, CSS-only atomic commit.

### Current MPL State
- `ui/` domain in prompt templates (React, Vue, Svelte, Web Components)
- No UI-dedicated analysis step in Phase 0
- No design system specification capability

### Proposal
1. **Phase 0 Step 0: Design Contract** (auto-activated when UI task detected)
   - Analyze typography, color palette, spacing scale, component library
   - Reference existing DESIGN.md if present, or suggest creating one
   - Produce "Design Contract" equivalent to Phase 0's API Contract

2. **Gate 2-C: Design Audit** (UI tasks only)
   - Accessibility (a11y), responsive, interaction states, design system compliance
   - Score-based (0-10) + minimum standard (e.g., 6/10 or above)

### Implementation Location
- Phase 0 extension: design.md Step 0 section
- New agent: `mpl-design-agent.md` (sonnet, temp 0.7)
- Output: `.mpl/mpl/phase0/design-contract.md`

### Open Questions
- [ ] Auto-detection criteria for UI tasks? (file extension? prompt keywords? both?)
- [ ] Design token format? (CSS custom properties vs Tailwind config vs JSON)
- [ ] Auto-recognize existing design systems (Material, Ant, Chakra, etc.)?
- [ ] Intensity adjustment by maturity_mode? (explore: skip, standard: recommended, strict: required)

---

## T-06: Doc Sync (Phase 5 Extension)

### Inspiration
gstack `/document-release` — Auto-detect affected documents relative to code diff → update.

### Current MPL State
- `mpl-compound` extracts learnings/decisions/issues to `.mpl/memory/`
- README, CHANGELOG, API docs and other project document updates are manual

### Proposal
**Phase 5 Step 5-B: Doc Sync**
- Scan full diff → generate list of affected document files
- `mpl-doc-agent` (haiku) — generate draft reflecting changes
- Commit after user confirmation

### Implementation Location
- Phase 5 extension: design.md
- New agent: `mpl-doc-agent.md` (haiku)
- Document mapping: `.mpl/config.json` → `doc_sync: { files: ["README.md", "CHANGELOG.md"] }`

### Open Questions
- [ ] Auto-detect CHANGELOG format? (Keep a Changelog, Conventional Changelog, etc.)
- [ ] Auto-generate API docs? (Update OpenAPI spec, etc.)
- [ ] Works in Frugal tier too? (cost is minimal since it's haiku)

---

## T-07: Premise Challenge Mode (PP Interview Extension)

> **Note**: Partially absorbed into Stage 2 PP Conformance Check. PP Conflict Detection and AUTO_RESOLVED already cover premise challenging. The remaining gap (divergent "what if solved differently?" questioning) could strengthen `mpl-interviewer` Round 4 (Tradeoffs) in full mode.

### Inspiration
gstack `/office-hours` — Premise challenge that "directly pokes at uncomfortable places". Extracts 5-10 hidden possibilities from what the user said.

### Current MPL State
- `mpl-interviewer` conducts 4-round Socratic interview
- `mpl-ambiguity-resolver` resolves ambiguity score to 0.3 or below
- However, no mode to "challenge the user's premises themselves"

### Proposal
- Add `challenge_mode: true` option to `mpl-interviewer`
- When activated, add 1 round: "What if this problem were solved in a completely different way?"
- Default off in config.json (no change to existing workflow)

### Open Questions
- [ ] Auto-activation condition? (only for large-scope tasks?)
- [ ] Allow user to "skip"?
- [ ] Apply only when interview_depth: full?

---

## T-08: Trend Retro (Multi-Run Retrospective)

### Inspiration
gstack `/retro` — Weekly retrospective, per-contributor breakdown, trend analysis.

### Current MPL State
- Per-run learnings accumulated in `.mpl/memory/learnings.md`
- Token/time metrics accumulated in `.mpl/mpl/profile/phases.jsonl`
- No functionality to analyze this data

### Proposal
- Create new `/mpl:mpl-retro` skill
- Aggregate `.mpl/memory/` + `.mpl/mpl/profile/` data
- Output: repeated patterns, frequently failing Gates, average token efficiency, improvement trends

### Open Questions
- [ ] Time period basis? (recent N executions? date range?)
- [ ] Cross-project comparison feature?
- [ ] Visualization? (terminal chart? markdown table?)

---

## T-09: Performance Gate (Gate 1.5 Extension)

### Inspiration
gstack `/benchmark` — Core Web Vitals baseline + bundle size regression detection.

### Current MPL State
- Gate 1.5 has only coverage metrics
- No performance metrics (bundle size, build time, LCP/FID/CLS)

### Proposal
- Add optional `performance_check` to Gate 1.5
- Per-project config: `.mpl/config.json` → `performance: { bundle_limit: "500KB", ... }`
- Store baseline: `.mpl/baselines/performance.json`
- Regression detection: current values vs baseline comparison

### Open Questions
- [ ] Auto-detect per-framework bundle analysis tools? (webpack-bundle-analyzer, vite, etc.)
- [ ] Auto-baseline update frequency?
- [ ] Performance criteria for non-web projects (API, CLI, etc.)?

---

## Feasibility Assessment (2026-03-22)

### 5-Criteria Evaluation Matrix

| # | Feature | ① Philosophy | ② Token Eff. | ③ Standalone | ④ Impact | ⑤ Frequency | **Verdict** |
|---|---------|:----------:|:----------:|:----------:|:------:|:---------:|:----------:|
| T-01 | Safety Guard | ✅ | ✅ 0 tok | ✅ | ✅ | ✅ every run | **✅ Confirmed** |
| T-02 | Cross-Model Review | ⚠️ | ❌ 5-10K | ❌ ext API | ✅ | ⚠️ Frontier | **⚠️ Redesign** |
| T-03 | Browser QA (Chrome MCP) | ✅ | ⚠️ 5-8K | ⚠️ MCP req | ✅ | ⚠️ UI only | **✅ Feasible** |
| T-04 | Ship Step (PR only) | ✅ | ✅ 2-3K | ⚠️ gh CLI | ✅ Step 5.4b | ⚠️ | **✅ Feasible** |
| T-05 | Design Contract | ✅ | ⚠️ 8-12K | ✅ | ✅ | ❌ UI only | **🟡 Low priority** |
| T-06 | Doc Sync | ⚠️ | ✅ 3-5K | ✅ | ✅ | ⚠️ | **✅ Feasible** |
| T-07 | Premise Challenge | ✅ | ✅ ~2K | ✅ | ✅ | ❌ rare | **↪️ Absorbed** |
| T-08 | Trend Retro | ⚠️ | ✅ ~3K | ✅ | ✅ | ❌ rare | **🟡 Post-data** |
| T-09 | Performance Gate | ✅ | ⚠️ var | ⚠️ tools | ⚠️ | ❌ web only | **🟡 Low priority** |
| T-10 | Post-Exec Review | ✅ | ✅ 3-5K | ✅ | ⚠️ Gate 3 | ✅ every run | **✅ Confirmed** |
| T-11 | Feasibility Check (2-Layer) | ✅ | ✅ ~1-2K (L1) | ✅ | ✅ existing ext | ✅ all tiers | **✅ Redesigned** |
| T-12 | Core-First Ordering | ✅ | ✅ 0 tok | ✅ | ✅ | ✅ Frontier | **✅ Confirmed** |

### Key Decisions

**T-02 Redesign**: External API dependency (OpenAI/Gemini) violates Standalone compatibility. Alternative: same model (sonnet) with 2 independent reviews using different prompts/perspectives — no external API needed, similar effect. Requires experiment to validate effectiveness before implementation.

**T-04 Scope Down**: CI/CD varies too much across projects to provide a universal solution. MPL's scope ends at "verified code + PR". Only PR creation (Step 5.4b) is included — no CI monitoring, no deploy, no health checks. Users configure their own CI/CD pipelines.

**T-07 Absorbed into existing**: PP Conformance Check (Stage 2 redesign) already performs premise challenging — PP Conflict Detection surfaces hidden contradictions, AUTO_RESOLVED validates premises against context. The remaining gap (divergent "what if solved differently?" questioning) is better addressed by strengthening `mpl-interviewer` Round 4 (Tradeoffs) in full mode, not as a separate feature.

**T-11 Redesigned (Direction C)**: 2-Layer Defense instead of separate Step 2.7. **Layer 1**: Extend Stage 2 PP Conformance Check with `INFEASIBLE` classification — catches ~80% of feasibility issues during interview at zero additional cost (Ambiguity Resolver already has Read/Glob/Grep). **Layer 2**: Extend Decomposer's `go_no_go` with `RE_INTERVIEW` signal for Phase 0-dependent issues. Layer 1 prevents 8-25K token waste; Layer 2 is a safety net for subtle issues only visible after API contract extraction.

**T-10 Note**: Gate 3 behavioral change (H-items → defer) requires H-item severity classification. HIGH H-items remain blocking, LOW/MED H-items defer to Step 5.5 review.

---

## GitHub Issues Triage (2026-03-23)

### Issues reviewed from [KyubumShin/MPL](https://github.com/KyubumShin/MPL/issues)

| # | Issue | Verdict | Action | Author Agreed |
|---|-------|:-------:|--------|:-------------:|
| **#6** | Ambiguity Hard Gate | ✅ **Apply (v0.6.7)** | Add blocking check: ambiguity > 0.2 → Phase 0 blocked. Show per-dimension scores in block message. | ✅ + dimension display suggestion |
| **#9** | Drift Measurement MVP | ✅ **Apply (v0.6.7)** | Scope Drift only: declared vs actual files. Add "intentional expansion" tag (question, not auto-block). | ✅ + intentional expansion tag |
| **#1** | Convention Scan | ⏸️ **Defer** | Alternative: Phase Seed auto-selects 2-3 reference files from same directory (v0.6.8) | ✅ + reference file selection |
| **#7** | Hashline Edit | ⏸️ **Defer** | Claude Code Edit is content-matching, not line-number-based. Revisit if edit failure rate > 10%. | ✅ |
| **#8** | Cross-Project Learning | ⏸️ **Defer** | Staleness/pollution risk. Revisit after 10+ project data accumulated. | ✅ |
| **#4** | Legacy Awareness | ⏸️ **Defer** | Do-Not-Touch config only (brownfield.json, 0.5 day). Rest is over-engineering. | ✅ |
| **#2** | Impact Radius Analysis | 🏗️ **Brownfield** | Greenfield: no code to analyze. Implement with brownfield mode launch. | ✅ |
| **#3** | Regression Shield | 🏗️ **Brownfield** | Gate 0.8 Pre-Baseline. Implement with brownfield mode launch. | ✅ |
| **#5** | Incremental Merge | ❌ **Skip** | Git workflow problem, not MPL's responsibility. T-04 already handles PR. | ✅ |

---

## Version Mapping (revised 2026-03-23)

### Completed

| Version | Features | Status |
|---------|----------|:------:|
| v3.7 | Baseline: 2-Stage Interview, 15 agents, Adaptive Router, 5-Gate | ✅ |
| v3.8→0.5.1 | Stage 2 redesign, MCP Server, T-01/03/04/10/11/12, F-31/33, translation | ✅ |
| 0.6.0 | D-01 Phase Seed + 2-Level Parallelism + 17 agents | ✅ |
| 0.6.1 | Nested agent limitation fix | ✅ |
| 0.6.2 | B-01 Zero-test gate enforcement | ✅ |
| 0.6.3 | B-02 Multi-stack build + runtime + anti-stub | ✅ |
| 0.6.4 | R-01 Protocol file split (1,663→765 max) | ✅ |
| 0.6.5 | B-03 Vertical slice + cross-layer contracts | ✅ |
| 0.6.6 | B-04 Integration checkpoints + agent model optimization + audit fixes | ✅ |

### Planned

| Version | Features | Type |
|---------|----------|------|
| **0.6.7** | **V-01** Cluster Ralph (B-04 진화) + **V-02** Lint Gate + **V-03** TSConfig Strict + **V-04** Config Schema + **V-05** Scope Drift Report | Feature: layered verification |
| **0.6.8** | **#1 alt** Phase Seed reference file auto-selection + **TS-03** Regression Accumulator | Patch: convention + regression |
| **0.7.0** | **TS-01/02** MCP Assertion tools + T-05 Design Contract + T-06 Doc Sync | Feature: test infra + UI workflow |
| **Brownfield** | **#4** Do-Not-Touch + **#2** IRA + **#3** Regression Shield | Feature: brownfield mode |
| **Experiment** | T-02 Same-model dual review | Validate effectiveness |
| **Deferred** | T-08 Trend Retro, T-09 Performance Gate, F-06 Multi-Project, F-269 RUNBOOK format, #6 (already implemented), #7 Hashline, #8 Cross-Project Learning | Pending data/need |
| **Absorbed** | T-07 Premise Challenge → Stage 2 PP Conformance | Already covered |
| **Skipped** | #5 Incremental Merge | Out of MPL scope |

> **v0.6.7 detailed spec**: [v0.6.7-cluster-ralph.md](./v0.6.7-cluster-ralph.md)

---

## Test Infrastructure Enhancement (from test-strategy-redesign.md)

Items designed but not yet scheduled:

| ID | Feature | Priority | Description |
|----|---------|----------|-------------|
| TS-01 | `mpl_extract_assertions` MCP tool | 🟡 Medium | Decompose ACs into 4-tier SpecAssertions (T1 Constant/T2 Structural/T3 Behavioral/T4 Unverifiable) |
| TS-02 | `mpl_verify_spec` MCP tool | 🟡 Medium | Auto-verify T1/T2 assertions via regex scan ($0 cost) |
| TS-03 | Regression Accumulator | 🟡 Medium | Accumulate tests across phases as regression suite |
| TS-04 | Enhanced Gate (lint+coverage) | 🟢 Low | Extend Gate 1 with lint checks and coverage thresholds |

Expected impact: Test count ~70 → ~200 (3x), Verification density 2.3 → 5-7 assertions/AC.
See `test-strategy-redesign.md` for full design.

---

## Decision Criteria

When confirming each candidate, review the following:

1. **MPL philosophy alignment** — Does it align with "Prevention over Cure" + "Orchestrator-Worker separation"?
2. **Token efficiency** — Does it avoid adding unnecessary cost in Frugal/Standard tier?
3. **Standalone compatibility** — Does it operate gracefully without external dependencies (Playwright, OpenAI API, etc.)?
4. **Existing pipeline impact** — Does it not compromise the stability of the existing 9-step pipeline?
5. **Actual usage frequency** — Does this feature provide value in the majority of MPL executions?
6. **Greenfield safety** — Does it NOT break existing greenfield code generation? (added v0.6.6)
7. **Migration impact** — Does it include backward-compatible fallback? (added v0.6.0)

---

*This document is for review before confirmation. When individual features are approved, separate them into their own design documents.*
