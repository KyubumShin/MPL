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
| F-269 | RUNBOOK as docs/documentation.md | ❌ Deferred → v1.1.0 | 🟡 Low |

4-Document mapping Axis 1: RUNBOOK.md exists but doesn't match Codex `docs/documentation.md` spec. Audit log + cross-session continuity format needs alignment.

### F-06: Multi-Project Support

| ID | Feature | Status | Priority |
|----|---------|--------|----------|
| F-06 | Multi-Project Support | ❌ Deferred → v1.2.0 | 🟡 Low |

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
| **#4** | Legacy Awareness | 🔀 **Out of MPL scope** | Field 3(진정한 레거시)만 범위 밖. 별도 CEP 도구로 이관. Field 2(Well-Documented)는 MPL 지원 (4-Field 분류, 2026-03-27) | ✅ |
| **#2** | Impact Radius Analysis | 🔀 **Out of MPL scope** | 레거시 코드(Field 3) 영향도 분석은 CEP 도구. Field 2는 Codebase Analyzer 확장으로 부분 지원 | ✅ |
| **#3** | Regression Shield | ✅ **Scope restored** | Gate 0.8을 Field 2(기존 테스트 baseline) + Field 4(.mpl/ baseline) 모두 적용. Field 3만 제외 (팀 토론 합의, 2026-03-27) | ✅ |
| **#5** | Incremental Merge | ❌ **Skip** | Git workflow problem, not MPL's responsibility. T-04 already handles PR. | ✅ |

---

## Version Mapping (revised 2026-03-25)

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
| 0.6.7 | 1M context parameter tuning (토큰 예산 증가, 임팩트 파일 캡 2000줄, episodic memory 5 phases) | ✅ |
| 0.7.0 | 1M context protocol restructuring (PD 2-Tier, Sliding Window N=3, N-1 diff 전달, budget predictor 1M) | ✅ |
| 0.8.0 | V-01 Cluster Ralph + V-02 Lint Gate + V-03 TSConfig Strict + V-04 Config Schema + V-05 Scope Drift Report | ✅ |
| 0.8.1 | #1 alt Reference file auto-selection + TS-03 Regression Accumulator + Round 1-T Test Strategy Interview + Step 8.6 E2E framework auto-insertion | ✅ |

### Recently Completed (v0.8.6~0.10.2)

| Version | Features | Status |
|---------|----------|:------:|
| 0.8.6 | BM-05 Gate 2 PP/PD 체크리스트 + BM-02 Phase Hint + LT-05 severity 메트릭 + LT-02 테스트 병렬화 | ✅ |
| 0.9.0 | PR-01~05 Prompt Reinforcement + F-E2E-1/1b/1c E2E Fallback Chain | ✅ |
| 0.9.1 | CB-01~04 Cross-Boundary Detection (Boundary Pair Scan + Rule 8 + Gate 0.7 + Mock Gap) | ✅ |
| 0.9.2 | CB-05~07 Cross-Boundary Enforcement (boundary_check output + Contract Snippet + Post-Join Reconciliation) | ✅ |
| 0.9.3 | CB-08 Mechanical Boundary Verification (L0/L1/L2) | ✅ |
| 0.9.4 | **Pre-v2 Cleanup** — Worker removal + Principle 1/5 update + version notation | ✅ |
| 0.10.0 | **Mechanical Boundary Foundation** — **KT-01** Channel Registry + **CB-L0** Adjacent Contracts + **SEED-01/02/03** Contract Snippet + **SNT-S0/S1/S3** Sentinel Hooks + **CB-L1** L1 Hard Gate | ✅ |
| 0.10.1 | **MCP Path Fix** — .mcp.json args에 `${CLAUDE_PLUGIN_ROOT}` prefix 추가 (플러그인 MCP 서버 경로 해결) | ✅ |
| 0.10.2 | **T-11 Skill Quality Polish** — Description 트리거 힌트 (강한/약한/command-only 분류) + Deprecated 스킬 stub화 + mpl-setup references/ 분리 | ✅ |

> **v0.9.0 코드베이스 스캔 결과 (2026-03-29)**: PR-01~05 전부 구현 확인. F-E2E-1(3-tier fallback), F-E2E-1b(Rule 12 few-shot), F-E2E-1c(GUI app mandatory Step 3-B) 모두 구현 확인. B-03(Step 4.55 Cross-Layer) 존재하지만 의사코드 수준 → CB-05로 대체 예정.

### Planned — v2 Roadmap (revised 2026-03-30, v0.10.2 기준)

> v2 로드맵(`analysis/mpl-v2-roadmap.md`) 기반으로 재정리. 기존 v0.9.3~0.10.0 Planned는 완료 또는 v2로 흡수/드랍됨.

| Version | Theme | Features | Priority |
|---------|-------|----------|----------|
| **v0.11.0** | **v2 Phase 2: 구조 전환** | GATE-01 (6→3H+1A) + HAT-01/02/03 (Hat+Floor) + AGT-02~05 (17→8 에이전트) + RETRY-01/02 + CLUST-01 | 🔴 High |
| **v1.0.0** | **v2 Phase 3: 완전체** | JUDGE-01/02/03 (MCP Judge) + FLOW-01/01b/02/03 (Runner/Test 분리) + CB-L2 + DOC-05 | 🟠 Medium |
| **v1.1.0** | **Post-v2 기능** | T-05 Design Contract + T-06 Doc Sync + TS-01/02 재설계 + BM-04 Discovery 매트릭스 + F-269 RUNBOOK | 🟡 Low |
| **v1.2.0** | **Post-v2 관리** | T-08 Trend Retro + T-09 Performance Gate + P-04 Skill Audit CLI + F-06 Multi-Project | 🟡 Low |

### Dropped (v2로 인해 불필요 — 2026-03-30 정리)

| 기능 | 이유 |
|------|------|
| **LT-01** Contract Changes 필수 섹션 | Seed Generator contract_snippet이 대체 (v0.10.0 SEED-01/02) |
| **LT-03a** Contract Verification Gate | Sentinel S0/S1/S3 hook이 이미 대체 (v0.10.0 SNT-S0/S1/S3) |
| **LT-03b** Blame Analysis fallback | Seed Generator 통일 명세가 대체 |
| **BM-03** interface_contract weight | Hat Model PP-proximity가 대체 (v0.11.0 HAT-01) |
| **LT-04b** 분해 결합도 게이트 | Seed Schema Validation이 대체 (v0.10.0 SEED-03) |
| **T-02** Cross-Model Review | MCP Judge에 흡수 (v1.0.0 JUDGE-01) |

### Status Updated (2026-03-30 코드 검증)

| 기능 | 이전 상태 | 변경 | 근거 |
|------|----------|------|------|
| **F-E2E-1** E2E Fallback Chain | ❌ Not implemented | ✅ **v0.9.0 done** | v0.9.0 코드베이스 스캔에서 구현 확인 |
| **F-E2E-1b** Cluster Ralph E2E | ❌ Not implemented | ✅ **v0.9.0 done** | Rule 12 few-shot 구현 확인 |
| **F-E2E-1c** GUI app Step 3-B | ❌ Not implemented | ✅ **v0.9.0 done** | src-tauri 감지 구현 확인 |
| **LT-04** Multi-Resolution Summary | ❌ Not implemented | ⚠️ **Partial** (v0.10.2) | L0/L1/L2 구현됨, L3+On-Demand는 v0.11.0에서 |
| **T-10** Ambiguity Gate Enforcement | ⚠️ Partial | **Absorbed** → v0.11.0 AGT-05 | Interviewer가 Ambiguity Resolver 흡수 |

### Non-Active

| Status | Features | Reason |
|--------|----------|--------|
| ~~**Brownfield**~~ | ~~#4 Do-Not-Touch + #2 IRA + #3 Regression Shield~~ | 4-Field Rescoped (2026-03-27): CEP 이관. See `analysis/mpl-3field-classification.md` |
| **Dropped** | P-02 Phase 0 L0 (P-01 흡수), P-05 Context Assembly YAML (시기상조) | Debate consensus 2026-03-24 |
| **Dropped (Beads)** | Async Gates, Phase Library/Reuse, Success Criteria 분리 | Beads 토론 합의 2026-03-28 |
| **Deferred** | T-08 Trend Retro, T-09 Performance Gate, F-06 Multi-Project, F-269 RUNBOOK, #7 Hashline, #8 Cross-Project Learning, F-E2E-2 2-Axis Architecture | Pending data/need |
| **Absorbed** | T-07 Premise Challenge → Stage 2 PP Conformance | Already covered |
| **Skipped** | #5 Incremental Merge | Out of MPL scope |

> **v0.8.0 detailed spec**: [v0.6.7-cluster-ralph.md](./v0.6.7-cluster-ralph.md) (파일명은 원래 v0.6.7 기준, 내용은 v0.8.0에 해당)

---

## Context Intelligence Features (from OpenViking/DeerFlow analysis, 2026-03-24)

> **Source**: ByteDance OpenViking (context database) + DeerFlow 2.0 (super agent harness) 비교 분석에서 도출.
> Analysis: `analysis/bytedance-openviking-deerflow-analysis.md` (TBD)

### P-01: State Summary L0/L1/L2 Tiering

| ID | Feature | Status | Priority |
|----|---------|--------|----------|
| P-01 | State Summary L0/L1/L2 (의존성 기반 압축) | ✅ **v0.8.8 done** | 🟠 Medium-High (debate revised) |

**Inspiration**: OpenViking L0/L1/L2 tiered context loading — 83% token reduction, 49% retrieval accuracy improvement on LoCoMo10 benchmark.

**Current MPL State**:
- State Summary is single-resolution (full text, ~400-800 tokens per phase)
- Context Assembly (Step 4.1) loads all dependency phase summaries at full resolution
- 10-phase project → ~4K-8K tokens for summaries alone

**Proposal**:
State Summary를 3-tier resolution으로 생성:

| Tier | Content | Token Budget | Load Condition |
|------|---------|-------------|----------------|
| L0 | 1-line: "무엇을 했고 결과가 무엇인가" | ~20 tok | 모든 phase에서 항상 로드 |
| L1 | L0 + 생성/수정 파일 목록 + 인터페이스 변경 요약 | ~200 tok | 같은 모듈 내 phase |
| L2 | L1 + 전체 상세 + 결정 배경 + 검증 결과 | ~800 tok | 직접 의존 phase (interface_contract.requires) |

**Context Assembly 로딩 규칙**:
- `interface_contract.requires`에 명시된 phase → L2
- impact_files 교집합이 있는 phase → L1
- 그 외 모든 phase → L0

**Expected Token Savings**: 10-phase 기준 ~4K-8K → ~1.5K-3K (50-60% 절감)

**Implementation Location**:
- Phase Runner state-summary.md output format 변경
- `commands/mpl-run-execute-context.md` Context Assembly 로직
- `docs/design.md` §4.1 Context Assembly

**Open Questions**:
- [ ] Phase Runner가 L0/L1/L2를 한 번에 생성? 아니면 L2만 생성 후 orchestrator가 L0/L1을 자동 추출?
- [ ] Sliding window(N=3)와의 상호작용 — window 밖 phase는 L0만 유지?
- [ ] Phase 0 산출물에도 동일 tiering 적용?

---

### P-02: Phase 0 Artifact L0 Summary

| ID | Feature | Status | Priority |
|----|---------|--------|----------|
| P-02 | ~~Phase 0 artifact progressive loading~~ | ❌ Dropped (P-01에 흡수) | ~~🟡 Medium~~ |

**Inspiration**: OpenViking L0/L1/L2 + DeerFlow progressive skill loading.

**Current MPL State**:
- Phase 0 산출물(api-contracts.md, type-policy.md, error-spec.md, examples.md)이 complexity grade에 따라 선택적 생성
- 하지만 생성된 산출물은 Phase Runner에게 **전문** 전달
- Simple grade phase에 Complex grade Phase 0 전체를 주는 것은 비효율

**Proposal**:
각 Phase 0 산출물에 L0 summary (3-5줄) 헤더 추가:

```markdown
<!-- L0 -->
> API Contracts: 3 endpoints (POST /auth/login, POST /auth/register, GET /auth/me).
> All return { success: boolean, data: T, error?: string }. Auth via Bearer token.

<!-- L1: full content below -->
## POST /auth/login
...
```

Phase Runner context assembly 시:
- Phase complexity S → Phase 0 L0만 로드
- Phase complexity M → Phase 0 L1 (현재와 동일)
- Phase complexity L → Phase 0 전문 (현재와 동일)

**Expected Token Savings**: S-complexity phase에서 ~5-10K → ~500 tokens

**Implementation Location**:
- Phase 0 Enhanced (Step 2.5) 산출물 format
- `commands/mpl-run-execute-context.md` Phase 0 로딩 로직

---

### P-03: Search Trajectory Logging

| ID | Feature | Status | Priority |
|----|---------|--------|----------|
| P-03 | Scout search path observability | ✅ **v0.8.7 done** | 🔴 High (debate revised — P-01 선행 조건) |

**Inspiration**: OpenViking "visualized retrieval trajectory" — 검색 궤적을 시각화하여 잘못된 검색 결과의 원인을 디버깅.

**Current MPL State**:
- Scout(F-16)는 findings를 JSON으로 반환하지만 **어떤 경로를 탐색했는지**는 기록하지 않음
- Phase Runner 실패 시 "왜 잘못된 파일을 수정했는가" 추적 불가
- `phases.jsonl`에 token/time만 기록, 검색 과정은 미기록

**Proposal**:
Scout output에 `search_trajectory` 필드 추가:

```json
{
  "search_mode": "qmd_first",
  "search_trajectory": [
    { "step": 1, "tool": "qmd_deep_search", "query": "auth middleware", "results": 5, "selected": 2 },
    { "step": 2, "tool": "Grep", "pattern": "authenticateUser", "results": 3, "verified": 3 },
    { "step": 3, "tool": "lsp_goto_definition", "symbol": "AuthMiddleware", "found": true }
  ],
  "findings": [...],
  "summary": "..."
}
```

Phase Runner 실패 시 orchestrator가 trajectory를 분석하여:
- "Step 2에서 잘못된 패턴으로 검색" → 다른 패턴으로 재탐색
- "Step 1에서 QMD가 stale 결과 반환" → Grep-Only fallback

**Implementation Location**:
- `agents/mpl-scout.md` output format 확장
- `commands/mpl-run-execute.md` Phase Runner 실패 분석 로직
- `.mpl/mpl/phases/phase-N/search-trajectory.json` 저장

---

### P-04: Skill Filtering & Memory Cleansing

| ID | Feature | Status | Priority |
|----|---------|--------|----------|
| P-04 | Skill Audit CLI (P-03 데이터 기반) | ❌ Deferred → v1.2.0 | 🟡 Low (v2 안정화 후) |

**Inspiration**: OpenViking "context self-evolving" (역방향 적용) + DeerFlow fact confidence scoring + **Claude Code auto-dream** (memory consolidation, v2.1.78).

> **📌 Auto-Dream 영향 분석 (2026-03-25)**: Claude Code의 auto-dream 기능이 P-04 ① Memory Cleansing에 검증된 패턴(4-phase consolidation)을 제공. Decay function 폐기 → rule-based consolidation 채택 권장. 일정은 유지(v0.9.0), 범위 조정. 상세: `analysis/auto-dream-p04-impact-analysis.md`

**Motivation**: 모델 성능 향상(context window 확대, reasoning 강화)에 따라 과거에 필요했던 스킬/hook/agent가 과잉 보호 상태가 됨. MPL 자체 히스토리에서 이미 수동으로 발생: `mpl-critic` 흡수(v3.1), gap+tradeoff 통합, PD 3-Tier→2-Tier(v0.7.0). 이를 체계화.

**Proposal: 2-Layer Pruning System**

**Layer 1: Usage Statistics (Passive, every N runs)**

`mpl-validate-output` hook 확장으로 각 hook/skill 발동 통계 수집:

```json
// .mpl/memory/usage-stats.jsonl (append-only)
{
  "run_id": "...",
  "timestamp": "2026-03-24T10:30:00Z",
  "hook_stats": {
    "mpl-write-guard": { "triggered": 3, "false_positive": 1 },
    "mpl-auto-permit": { "triggered": 47, "false_positive": 2 }
  },
  "skill_stats": {
    "mpl-small": { "invoked": 0 },
    "mpl-bugfix": { "invoked": 1 }
  }
}
```

Pruning candidate detection thresholds:

| Metric | Threshold | Meaning |
|--------|-----------|---------|
| `trigger_count_30d == 0` | 30일 미발동 | 사용되지 않는 스킬/hook |
| `false_positive_rate > 0.5` | 절반 이상 오탐 | 과잉 보호 |
| `learning.last_referenced > 60d` | 2달 미참조 | 사라진 메모리 |
| `routing_pattern.accuracy < 0.3` | 정확도 30% 미만 | 오래된 패턴 |

Output: `.mpl/memory/pruning-candidates.md`

**Layer 2: Model Generation Audit (Active, on model upgrade)**

모델 업그레이드 시 일회성 audit — 각 스킬/hook의 `model_dependency` (존재 이유)가 새 모델에서 여전히 유효한지 검증.

```yaml
# .mpl/memory/skill-metadata.yaml (proposed)
skills:
  mpl-write-guard:
    created: 2025-12-15
    model_dependency: "weak self-discipline in orchestrator role"
    last_audit: 2026-03-24
    audit_result: "still needed (2/10 violations without guard)"
  mpl-auto-permit:
    created: 2026-02-10
    model_dependency: "permission friction slowing pipeline"
    last_audit: 2026-03-24
    audit_result: "high value (156 triggers/month, 3% FP)"
```

Output: `.mpl/memory/pruning-report.md` → 사용자 확인 후 제거/archive

**Memory Cleansing: Confidence Decay**

`learnings.md`와 `routing-patterns.jsonl`에 confidence decay 적용:

```
confidence(t) = initial_confidence × decay^(days_since_last_use / half_life)

half_life = 90 days
prune_threshold = 0.1
```

`mpl-compound` run 완료 시:
1. 참조된 learning → confidence 복원 (max 1.0)
2. 미참조 learning → decay 적용
3. threshold 미달 → pruning-candidates.md에 추가
4. 사용자 확인 후 제거 또는 `.mpl/memory/archive/`로 이동

**Implementation Location**:
- `hooks/lib/mpl-usage-tracker.mjs` (new) — hook/skill 통계 수집
- `hooks/mpl-validate-output.mjs` 확장 — 통계 기록
- `agents/mpl-compound.md` 확장 — decay 계산 + pruning report
- `.mpl/memory/usage-stats.jsonl` (new)
- `.mpl/memory/skill-metadata.yaml` (new)
- `.mpl/memory/pruning-candidates.md` (new)
- `/mpl:mpl-audit` skill (new) — Model Generation Audit 트리거

**Open Questions**:
- [ ] half_life 기본값? (90일 vs 60일 vs 사용자 설정)
- [ ] Pruning 자동 실행? 아니면 항상 사용자 확인 필요?
- [ ] Archive된 메모리 복원 경로?
- [ ] Model upgrade 감지 방식? (agent frontmatter의 model 필드 변경 감지? 수동?)

---

### P-05: Context Assembly Middleware Pattern

| ID | Feature | Status | Priority |
|----|---------|--------|----------|
| P-05 | ~~Codified context assembly pipeline~~ | ❌ Dropped (시기상조) | ~~🟢 Low~~ |

**Inspiration**: DeerFlow 12-stage middleware chain — 순서 보장 + 앞 단계 결과를 뒤 단계가 참조.

**Current MPL State**:
- Context Assembly(Step 4.1)가 프로토콜 문서(`mpl-run-execute-context.md`)에 절차적으로 정의
- 순서: Phase 0 → PD → 이전 phase summary → verification plan → impact files
- 프로토콜 문서는 LLM이 해석하므로 순서 보장이 "soft" (LLM 재량)

**Proposal**:
Context Assembly를 코드화된 미들웨어 체인으로 변환:

```javascript
// hooks/lib/mpl-context-assembler.mjs (proposed)
const ASSEMBLY_PIPELINE = [
  { name: 'phase0_artifacts', loader: loadPhase0, tier: 'by_complexity' },
  { name: 'pivot_points', loader: loadPP, tier: 'always' },
  { name: 'phase_decisions', loader: loadPD, tier: '2tier' },
  { name: 'prev_summary', loader: loadPrevSummary, tier: 'l0_l1_l2' },
  { name: 'verification_plan', loader: loadVerificationPlan, tier: 'always' },
  { name: 'impact_files', loader: loadImpactFiles, tier: 'capped_2000' },
];
```

**현재는 우선순위 낮음** — 프로토콜 문서 기반 Context Assembly가 충분히 동작하고 있고, 코드화의 이점(순서 엄격 보장)이 비용(구현 + 유지보수)을 아직 정당화하지 못함. P-01 (L0/L1/L2) 구현 이후 복잡도가 증가하면 재검토.

**Implementation Location**:
- `hooks/lib/mpl-context-assembler.mjs` (new)
- `commands/mpl-run-execute-context.md` → 코드 참조로 전환

---

### Feasibility Assessment (Context Intelligence Features)

**Original assessment (pre-debate):**

| # | Feature | ① Philosophy | ② Token Eff. | ③ Standalone | ④ Impact | ⑤ Frequency | **Verdict** |
|---|---------|:----------:|:----------:|:----------:|:------:|:---------:|:----------:|
| P-01 | State Summary L0/L1/L2 | ✅ context isolation | ✅ 50-60% savings | ✅ | ✅ every phase | ✅ every run | **✅ High** |
| P-02 | Phase 0 L0 Summary | ✅ prevention | ✅ S-phase savings | ✅ | ⚠️ S-phase only | ⚠️ conditional | **🟡 Medium** |
| P-03 | Search Trajectory | ⚠️ observability | ⚠️ ~200 tok/phase | ✅ | ✅ debug quality | ⚠️ on failure | **🟡 Medium** |
| P-04 | Skill Filter + Memory Decay | ✅ self-evolving | ✅ long-term savings | ✅ | ✅ maintenance | ⚠️ periodic | **✅ High** |
| P-05 | Context Middleware | ⚠️ engineering | ✅ 0 tok | ✅ | ⚠️ existing works | ❌ rare benefit | **🟢 Low (post P-01)** |

**Post-debate revision (2026-03-24, Architect vs Contrarian 3-round debate):**

| # | Feature | Debate Verdict | Revised Priority | Key Insight |
|---|---------|:--------------:|:----------------:|-------------|
| P-03 | Scout Observability | ✅ IMPLEMENT v0.8.0 | 🔴 **HIGH** | 관찰 불가능성은 아키텍처 결함. P-01 검증의 선행 조건 |
| P-01 | State Summary L0 | ✅ IMPLEMENT v0.8.0 | 🟠 **MED-HIGH** | L0 단일 계층으로 축소. 의존성 기반 압축으로 재정의 |
| P-04 | Skill Audit CLI | ⏸️ DEFER v0.9.0 | 🟡 **MEDIUM** | P-03 데이터 10회+ 축적 후 설계. Decay function 제거 |
| P-02 | Phase 0 L0 | ❌ DROP | — | Phase 0 = 전체 예산 ~3%. P-01에 흡수 |
| P-05 | Context YAML | ❌ DROP | — | v0.7.0 직후 안정화 필요. 해결 < 생성 문제 |

> **Debate transcript**: `analysis/p01-p05-debate-transcript.md`

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

## E2E Execution Fix (Yggdrasil Post-Mortem, 2026-03-26)

> **발견 경위**: Yggdrasil (Tauri 소설 작성 도구) MPL 실행 후 E2E 테스트가 전혀 실행되지 않음.
> Cluster Ralph는 정상 동작하여 7개 클러스터 × feature_e2e + final_e2e를 정의했으나,
> (1) Step 5.0이 Cluster E2E를 소비하지 않았고, (2) E2E commands가 전부 `npm run build`뿐이었으며,
> (3) Step 3-B가 스킵되어 S-items도 없었음.
> **분석**: `analysis/yggdrasil-e2e-gap-analysis.md`
>
> **설계 의사결정**: 2차례 팀 토론(Architect/Contrarian/Evaluator)을 통해 합의 도출.
> 원래 4-feature 아키텍처 리디자인이 제안되었으나, "이것은 버그 수정이지 아키텍처 리디자인이 아니다"라는
> 합의에 따라 최소 수정으로 축소. F-E2E-1 + 프롬프트 패치로 원래 문제의 95% 해결 판정.

---

### F-E2E-1: Step 5.0 E2E Source Fallback Chain

| ID | Feature | Status | Target | Priority |
|----|---------|--------|--------|----------|
| F-E2E-1 | Step 5.0이 다중 소스에서 E2E 시나리오를 수집하여 실행 | ✅ **v0.9.0 done** (코드 스캔 확인) | **v0.8.3** | ~~🔴 High~~ |

**현재 문제**: Step 5.0이 Verification Planner의 S-items만 참조 → Step 3-B 스킵 시 실행 대상 없음.

**변경**: 3단계 Fallback Chain 도입.

```
E2E Source Resolution Order:
  1. S-items (Step 3-B Verification Planner) — 가장 정밀한 시나리오
  2. Cluster E2E (Decomposer feature_e2e + final_e2e) — 실행 가능한 commands 포함
  3. 기본 smoke test (npm test / npm run build) — 최소한의 빌드 검증

  → 소스 1 존재 시 1 사용, 없으면 2, 2도 없으면 3
  → 소스 혼합 가능: S-items + Cluster E2E 합집합 실행 (중복 제거)
```

Step 5.0 finalize 프로토콜 변경 (`mpl-run-finalize.md`):
```markdown
### 5.0: E2E Test (Final)

After 5-Gate Quality passes, run final E2E validation:

1. **Collect E2E sources** (fallback chain):
   a. Read Verification Planner S-items (domain: "e2e") from `.mpl/mpl/verification-plan.yaml`
   b. Read decomposition.yaml `clusters[].feature_e2e` + `final_e2e`
   c. Default smoke: `npm test` (or `cargo test` / `pytest`)
   → Merge (a ∪ b), deduplicate by scenario similarity, append (c) if no overlap

2. **Execute collected scenarios** sequentially:
   - Each scenario: run commands[], check exit code
   - Timeout: 60s per scenario (configurable)
   - On failure: log but continue (non-blocking by default)

3. **Report**:
   - `[MPL] E2E Test: {passed}/{total} scenarios passed. (source: S-items|cluster|smoke)`
   - Fallback 사용 시: `[MPL] WARNING: Using Cluster E2E fallback (Verification Planner was skipped)`
```

- **수정 범위**: `mpl-run-finalize.md` 1곳
- **토큰 비용**: ~1K (decomposition.yaml 파싱)
- **위험도**: 낮음 — 기존 S-items 우선, 추가 소스는 fallback. 최악의 경우 smoke test 실행 (현재보다 나음)

---

### F-E2E-1b: Decomposer Rule 12 Few-Shot 강화

| ID | Feature | Status | Target | Priority |
|----|---------|--------|--------|----------|
| F-E2E-1b | Cluster Ralph E2E commands가 실제 검증 명령어를 생성하도록 프롬프트 강화 | ✅ **v0.9.0 done** (Rule 12 few-shot 확인) | **v0.8.3** | ~~🔴 High~~ |

**현재 문제**: Rule 12에 "E2E scenarios must be executable"이라고 명시되어 있지만,
실제 출력에서 commands가 전부 `npm run build`로 생성됨. 규칙은 있으나 따르지 않은 것.

**변경**: Rule 12에 few-shot 예시 + validation 규칙 추가.

```markdown
Rule 12 (강화):
  E2E scenarios의 commands는 실제 기능 검증이어야 한다.
  "npm run build"만으로 구성된 E2E 시나리오는 거부한다.

  ❌ BAD:
    scenario: "Chapter CRUD가 동작한다"
    commands: ["npm run build"]

  ✅ GOOD:
    scenario: "Chapter CRUD가 동작한다"
    commands: ["npm test -- --grep 'chapter'"]

  ✅ GOOD (GUI app):
    scenario: "앱이 빌드되고 Rust 바이너리가 생성된다"
    commands: ["npm run build", "ls src-tauri/target/debug/yggdrasil"]

  GUI app (src-tauri/, electron/) 프로젝트의 경우:
    - 최소 1개 시나리오는 빌드 산출물(binary/dist) 존재를 확인해야 함
    - 가능하면 관련 테스트 파일 실행 명령어 포함 (npm test -- --grep ...)
```

- **수정 범위**: `mpl-decomposer.md` Rule 12 부분 1곳
- **토큰 비용**: ~0.5K (few-shot 예시 추가)
- **위험도**: 매우 낮음 — 프롬프트 개선, 기존 동작에 영향 없음

---

### F-E2E-1c: GUI App 감지 시 Step 3-B Mandatory

| ID | Feature | Status | Target | Priority |
|----|---------|--------|--------|----------|
| F-E2E-1c | src-tauri/ 또는 electron/ 감지 시 Step 3-B를 mandatory로 전환 | ✅ **v0.9.0 done** (src-tauri 감지 확인) | **v0.8.3** | ~~🟠 Medium~~ |

**현재 문제**: Step 3-B가 무조건 optional이어서, GUI app에서도 Verification Planning이 스킵됨.

**변경**: 오케스트레이터에서 간단한 조건 추가.

```
Step 3 진입 시:
  if codebase contains "src-tauri/" OR "electron/" OR "src-electron/":
    → Step 3-B mandatory. 스킵 시 경고:
      "[MPL] WARNING: GUI app detected. Step 3-B (Verification Planning) is required."
  else:
    → 현행 유지 (optional)
```

- **수정 범위**: 오케스트레이터 프로토콜 1곳
- **토큰 비용**: 없음 (조건 분기만)
- **위험도**: 매우 낮음 — 오탐지 시에도 Step 3-B가 추가 실행될 뿐 (해가 없음)
- **하위 호환**: 기존 프로젝트에 영향 없음 (Step 3-B가 실행 안 됐던 것이 실행되는 것뿐)

---

### v0.8.3 출시 범위 요약

| 작업 | 수정 파일 | 작업량 |
|------|----------|--------|
| F-E2E-1 (Fallback Chain) | `mpl-run-finalize.md` | Step 5.0 프로토콜 수정 |
| F-E2E-1b (Rule 12 강화) | `mpl-decomposer.md` | few-shot 예시 + validation 추가 |
| F-E2E-1c (Step 3-B 조건) | 오케스트레이터 프로토콜 | 조건 분기 1개 추가 |

**총 3파일 수정, 신규 파일 0개. 스키마 변경 없음.**

---

### F-E2E-2: 2-Axis E2E Architecture (test_topology + tool_hint)

| ID | Feature | Status | Target | Priority | 도입 조건 |
|----|---------|--------|--------|----------|----------|
| F-E2E-2 | primary_topology 4종 분류 + feature_e2e.tool_hint | ⏸️ Deferred | **v0.9.0** | 🟡 Conditional | 2+ 프로젝트에서 동일 문제 재현 시 |

> **팀 토론 합의**: Round 1에서 8개 platform_type + tool_registry + 4-Step Algorithm이 제안되었으나,
> Round 2에서 "한 건의 버그를 아키텍처 혁명으로 둔갑시킨 것"이라는 비판에 따라 조건부 연기.
> Architect가 제안한 축소안(primary_topology + tool_hint)을 v0.9.0 후보로 유지.

**도입 시 변경 범위 (축소안):**

1. `architecture_anchor`에 `primary_topology` 필드 추가
   - 4종: `gui-app` | `server` | `headless` | `library`
   - "unknown"이 거의 불가능 (소프트웨어 본질에 의한 분류)

2. `feature_e2e` 스키마에 `tool_hint` optional 필드 추가
   - 하위 호환 완벽 (additive change, migration 불필요)
   - cluster_topology 대신 시나리오별로 도구를 명시하는 가벼운 접근

3. E2E 도구 기본값을 프롬프트 내장으로 처리 (정적 레지스트리 파일 불필요)
   - "기존 deps 우선, 없으면 playwright(gui-app) / supertest(server) / vitest(unit) 기본"

```yaml
# 변경된 스키마 (v0.9.0 도입 시)
architecture_anchor:
  tech_stack: [string]
  primary_topology: "gui-app" | "server" | "headless" | "library"  # NEW

clusters:
  - feature_e2e:
      - id: string
        scenario: string
        type: "integration" | "smoke" | "contract"
        tool_hint: string    # NEW, optional (e.g., "playwright", "pytest")
        commands: [string]
```

**도입 조건**: v0.8.3 출시 후, 2개 이상의 프로젝트에서 다음 문제가 재현될 때:
- E2E commands 품질 문제 (build만 나옴)가 프롬프트 강화로도 해결되지 않는 경우
- Step 3-B mandatory 조건이 `src-tauri/`/`electron/` 외에도 필요한 경우

---

### 폐기된 설계 (팀 토론에서 Kill 판정)

| 항목 | 폐기 사유 | 결정 라운드 |
|------|----------|------------|
| F-E2E-3 (cluster-level topology) | `tool_hint`로 대체. 추상화 레이어 추가 불필요 | Round 2 Architect |
| F-E2E-4 (WebSearch Discovery) | 핵심 경로에서 비결정적 요소 주입. 재현성/Standalone/보안 위반 | Round 1 만장일치 |
| tool_registry 정적 파일 | LLM이 이미 도구를 알고 있음. 프롬프트 기본값으로 충분 | Round 2 Evaluator |
| 4-Step Tool Selection Algorithm | Decomposer는 Bash 실행 불가. 역할 초과, 과잉 설계 | Round 2 Architect |
| 3-Tier Trust Model (T1-T4) | 관리 비용 > 문제 비용. "보안 극장" 위험 | Round 1 Contrarian |
| 8개 platform_type 하드코딩 | 4종 topology가 더 본질적이고 확장 가능 (v0.9.0에서 도입 시) | Round 2 Architect |

### 팀 토론 교훈 (설계 원칙으로 기록)

> **"실제 사용자가 실제로 겪은 문제만 해결하라. 미래에 겪을 수도 있는 문제를 미리 해결하려다가 현재의 단순함을 파괴하지 마라."** — Contrarian
>
> **"새로운 추상화 레이어를 추가하기 전에, 기존 스키마에 optional 필드 하나를 추가하는 것으로 충분한지 확인하라."** — Architect
>
> **"이것은 버그 수정이다. 아키텍처 리디자인이 아니다. 3파일 수정으로 95% 해결되는 문제에 4-feature 아키텍처를 설계하는 것은 비례적이지 않다."** — Evaluator

---

## Decision Criteria

When confirming each candidate, review the following:

1. **MPL philosophy alignment** — Does it align with "Prevention over Cure" + "Orchestrator-Worker separation"?
2. **Token efficiency** — Does it avoid adding unnecessary cost in Frugal/Standard tier?
3. **Standalone compatibility** — Does it operate gracefully without external dependencies (Playwright, OpenAI API, etc.)?
   - **Platform dependencies** (Claude Agent SDK, MCP SDK): `^` range allowed — shares lifecycle with Claude Code platform
   - **Runtime prerequisites** (Node.js, git): accepted as essential dev environment tools
   - **Optional MCP integrations** (QMD, Chrome MCP): graceful fallback required
   - **Third-party packages**: prohibited by default. If unavoidable, exact pin + security audit required
   - **Background**: litellm supply chain attack (2025, BerriAI/litellm#24512) — agent toolchain dependency became a credential stealer vector
4. **Existing pipeline impact** — Does it not compromise the stability of the existing 9-step pipeline?
5. **Actual usage frequency** — Does this feature provide value in the majority of MPL executions?
6. **Greenfield safety** — Does it NOT break existing greenfield code generation? (added v0.6.6)
7. **Migration impact** — Does it include backward-compatible fallback? (added v0.6.0)

---

---

## Beads Comparison & Long-Term Stability Features (from steveyegge/beads analysis, 2026-03-28)

> **Source**: [steveyegge/beads](https://github.com/steveyegge/beads) v0.62.0 아키텍처 비교 분석 + 장기 실행 이슈 팀 토론
> Analysis: `analysis/beads-mpl-comparison-research.md`, `analysis/beads-mpl-long-term-issues-debate.md`

### BM (Beads-MPL) Features — Beads 비교에서 도출

| ID | Feature | Status | Priority | Version |
|----|---------|--------|----------|---------|
| BM-02 | Semantic Memory Phase Hint (1줄 힌트) | ✅ **v0.8.6 done** | 🟢 Low (비용 ~0) | 0.8.6 |
| BM-03 | interface_contract weight 필드 (hard/soft/info) | ~~❌~~ **Dropped** — Hat Model PP-proximity 대체 (v0.11.0) | ~~🟠 Medium~~ | ~~0.9.x~~ |
| BM-04 | Discovery 2축 매트릭스 (Validity × Urgency) | ❌ Deferred → v1.1.0 | 🟡 Low | v1.1.0 |
| BM-05 | Gate 2 PP/PD 체크리스트 주입 | ✅ **v0.8.6 done** | 🟢 Low (비용 ~0) | 0.8.6 |

**Dropped (Beads 토론 기각)**:
- BM-01 Async Gates → MPL 범위 밖 (외부 오케스트레이터 + Resume Protocol로 대체)
- BM-06 Phase Library/Reuse → anchoring bias 위험, "잊는 것이 기능" 철학 충돌
- BM-07 Success Criteria 분리 → 기존 3중 검증(PP+PD+Gate 2)으로 충분

#### BM-02: Semantic Memory Phase Hint

mpl-compound가 파이프라인 완료 시 semantic.md에 **한 줄짜리 Phase 힌트** 추가:
```markdown
## Phase Hints
- DB migration: 스키마 변경과 데이터 마이그레이션을 반드시 별도 Phase로 분리
- API endpoint: 타입 정의를 먼저 별도 Phase로 처리하면 후속 Phase 에러 감소
```
템플릿이 아니라 제약 조건. Decomposer anchoring 없이 교훈만 전달. 구현 비용 ~0.

#### BM-03: interface_contract weight 필드

```yaml
requires:
  - type: "DB Model"
    from_phase: "phase-2"
    weight: "hard"      # 기본값, 차단
  - type: "API Schema Reference"
    from_phase: "phase-3"
    weight: "soft"      # 있으면 로드, 없어도 진행
  - type: "Error Handling Pattern"
    from_phase: "phase-1"
    weight: "info"      # 토큰 여유 시에만 로드
```
전제: P-01 State Summary Tiering 도입 후 구현. soft dependency의 summary 해상도를 선택 가능.

#### BM-04: Discovery 2축 매트릭스

기존 PP/PD 충돌 모델(Validity 축) 보존 + Urgency 축 추가:

|  | immediate | deferred |
|--|-----------|----------|
| **PP conflict** | HALT + HITL | FLAG + Phase 후 HITL |
| **PD diverge** | HITL or auto-adapt | LOG + batch review |

maturity_mode는 분류가 아닌 정책 레이어 (explore: PD+immediate도 auto-adapt, strict: PD+deferred도 HITL).

#### BM-05: Gate 2 PP/PD 체크리스트 주입

Code Reviewer 프롬프트에 현재 Phase 관련 PP/PD를 명시적 체크리스트로 변환 주입:
```markdown
## PP/PD Compliance Checklist (auto-generated)
- [ ] PP-2: JWT 기반 인증 사용 (Pivot Point)
- [ ] PD-3: PostgreSQL transaction wrapping 적용 (Phase 3 결정)
- [ ] PD-7: Error response 형식 RFC 7807 준수 (Phase 5 결정)
```
design_criteria 분리 없이 동일 효과 달성. 구현 비용 ~0.

---

### LT (Long-Term) Features — 장기 실행 이슈 토론에서 도출

| ID | Feature | Status | Priority | Version |
|----|---------|--------|----------|---------|
| LT-01 | State Summary Contract Changes 필수 섹션 | ~~❌~~ **Dropped** — Seed contract_snippet 대체 (v0.10.0 SEED-01/02) | ~~🔴 High~~ | ~~0.9.2~~ |
| LT-02 | 테스트 병렬화 플래그 자동 감지 | ✅ **v0.8.6 done** | 🟢 Low (비용 ~0) | 0.8.6 |
| LT-03a | Contract Verification Gate (예방적) | ~~❌~~ **Dropped** — Sentinel S0/S1/S3 대체 (v0.10.0) | ~~🔴 High~~ | ~~0.9.2~~ |
| LT-03b | Blame Analysis fallback (반응적) | ~~❌~~ **Dropped** — Seed Generator 통일 명세 대체 | ~~🟠 Medium~~ | ~~0.9.x~~ |
| LT-04 | Multi-Resolution Summary L1/L2/L3 | ⚠️ **Partial** — L0/L1/L2 구현, L3+On-Demand는 v0.11.0 | 🟡 Low | v0.11.0 |
| LT-04b | Phase 분해 결합도 검증 게이트 | ~~❌~~ **Dropped** — Seed Schema Validation 대체 (v0.10.0 SEED-03) | ~~🟠 Medium~~ | ~~0.9.x~~ |
| LT-05 | H-Item severity 피드백 루프 메트릭 | ✅ **v0.8.6 done** | 🟢 Low | 0.8.6 |

**Dropped (장기 토론 기각)**:
- 회귀 테스트 선택적 실행 (Option A/B/C) → O(n²)는 오류(실제 O(n)), 실측 데이터 필요, 병렬화가 정답
- H-Item 배칭/자동분류/S-Item전환 → T-10이 이미 80% 해결 (실제 Side Interview 2-5회)

#### LT-01: State Summary Contract Changes

State Summary 템플릿에 mandatory 섹션 추가:
```markdown
## Contract Changes
- API: POST /users response에 avatar 필드 추가 (optional, string|null)
- Types: UserProfile.avatar 추가
- Errors: E_AVATAR_TOO_LARGE 추가
```
변경 없으면 `None` 기록. Context Assembly에서 Phase 0 + 누적 Contract Changes를 overlay 병합하여 "Current Contract State" 생성. Phase 0 자체는 수정하지 않음. 비용: Phase당 ~300-800 토큰.

#### LT-02: 테스트 병렬화 플래그 자동 감지

Phase Runner의 Bash 호출에서 테스트 프레임워크별 병렬 플래그 자동 추가:
- `vitest` → `--pool=threads`
- `pytest` → `-n auto`
- `cargo test` → `--jobs`
- `go test` → `-parallel`

프로토콜 복잡도 0 증가, 회귀 감지율 100% 유지.

#### LT-03a: Contract Verification Gate

Phase N 완료 후, Phase N+1 시작 전 경량 검증:
```
for each completed_phase in [1..N]:
  for each produce in completed_phase.interface_contract.produces:
    verify_exists(produce.path)
    if produce.type == "export": verify_grep(produce.path, produce.symbol)

if violations_found:
  re-execute violated_phase (NOT full redecompose)
```
비용: Phase당 ~5-15K 토큰. 예상 재분해율: 15-30% → 2-5%.

#### LT-03b: Blame Analysis Fallback

Contract Gate 통과 후에도 circuit_break 발생 시:
```
blame_result = analyze_blame(failure_info, changed_files, phase_history)
if blame_result.confidence > 0.7: re_execute(origin_phase)
else: redecompose()  # 기존 경로
```
LT-03a와 결합 시 예상 재분해율: 1-3%.

#### LT-04: Multi-Resolution Summary L1/L2/L3

P-01 (State Summary Tiering)의 확장된 구현:
- **L1 (Full)**: 전체 State Summary + 코드 diff (~800 토큰) — 최근 3 Phase
- **L2 (Medium)**: 결정 + 인터페이스 변경 + 검증 요약 (~300 토큰) — 의존 Phase
- **L3 (Compact)**: 1줄 요약 (~50 토큰) — 나머지
- **On-Demand**: L3에서 정보 부족 시 L2/L1로 동적 로딩

핵심 발견: 윈도우의 목적이 "용량 관리" → "복원력 관리"로 전환. Compaction 대비 보존 대상 명시적 선언.

#### LT-04b: Phase 분해 결합도 검증 게이트

Decomposer 출력 검증: 7개 이상 Phase를 참조하는 Phase가 있으면 분해 재설계 경고. Phase 간 결합도가 과다하면 윈도우를 최적화해도 해결 불가 (근본 원인 차단).

#### LT-05: H-Item Severity 피드백 루프

metrics.json에 추가:
```json
{
  "h_item_severity_overrides": { "high_to_med": 0, "med_to_high": 0 },
  "h_item_review_rate": 0.0,
  "h_item_total": 0,
  "h_item_side_interviews": 0
}
```
Step 5.5에서 사용자가 severity를 재분류하는 경우를 추적. verification planner 정확도 피드백 루프.

---

---

## Cross-Boundary Verification Features (from Yggdrasil Invoke Audit, 2026-03-28)

> **Source**: Yggdrasil MPL 파이프라인 완료 후 수동 감사에서 26건의 프론트-백엔드 컨트랙트 불일치 발견.
> 5-Gate Quality System 전량 통과 후 사후 발견. 근본 원인: MPL 검증이 단일 언어 경계 내에서만 작동.
> Analysis: `analysis/mpl-cross-boundary-verification-gap.md`
> Team debate: Architect/Contrarian/Hacker/Ontologist/Evaluator 2회 수행, 수렴안 도출.

### CB-01: Boundary Pair Scan (Codebase Analysis Module 2b)

| ID | Feature | Status | Priority | Version |
|----|---------|--------|----------|---------|
| CB-01 | Cross-Boundary Pair Scan | ✅ **v0.9.1 done** | 🔴 High | 0.9.1 |

**Problem**: Step 2 Codebase Analysis의 Module 2 (Dependency Graph)가 단일 언어 내 import 의존성만 추적. 언어 간 경계(TS invoke → Rust command, fetch → API handler)가 매핑되지 않아 Decomposer가 cross-boundary 의존성을 인식 못함.

**Proposal**: Module 2b "Boundary Pair Scan" 추가.

Brownfield:
```
# Tauri invoke pairs
Grep("invoke\\(['\"]([^'\"]+)['\"]", "src/", glob="*.{ts,tsx}")  → caller
Grep("#\\[tauri::command\\].*fn\\s+(\\w+)", "src-tauri/", glob="*.rs")  → callee

# REST API pairs
Grep("(fetch|axios)\\.(get|post|put|delete)\\(['\"]([^'\"]+)['\"]", "src/")  → caller
Grep("@(Get|Post|Put|Delete)\\(['\"]([^'\"]+)['\"]", "app/")  → callee
```

Greenfield:
- PP Interview + user request에서 tech stack 키워드로 프로토콜 감지
- 개별 pair는 `projected` 상태로 마킹, 코드 생성 후 `confirmed` 전환

Output: `codebase-analysis.json`에 `boundary_pairs` 배열 추가.

```yaml
boundary_pairs:
  - id: "BP-1"
    status: "confirmed"   # confirmed (brownfield) | projected (greenfield)
    caller: { lang: "ts", file: "src/stores/characterStore.ts", symbol: "invoke('save_character')" }
    callee: { lang: "rust", file: "src-tauri/src/commands/character.rs", symbol: "fn save_character()" }
    protocol: "tauri-invoke"
    framework_rules:
      - "top-level params: camelCase (Tauri v2 default)"
      - "struct fields: snake_case (serde default)"
```

**Token cost**: ~500 (brownfield), ~200 (greenfield). Module 2 실행 시 함께 처리.

**Evaluator verdict**: ADOPT. MPL 호환성 높음, 외부 의존성 없음, 기존 Module 구조의 자연스러운 확장.

### CB-02: Decomposer Rule 9b (Boundary-Aware Decomposition)

| ID | Feature | Status | Priority | Version |
|----|---------|--------|----------|---------|
| CB-02 | Boundary Pair Phase Grouping Rule | ✅ **v0.9.1 done** | 🔴 High | 0.9.1 |

**Problem**: Decomposer가 cross-boundary 의존성을 모르기 때문에 TS 타입 정의와 Rust 구조체가 서로 다른 phase에 배치됨. Worker가 한쪽만 보고 구현하여 불일치 발생.

**Proposal**: Decomposer에 Rule 9b 추가.

```
Rule 9b: Boundary pair awareness
- boundary_pair로 연결된 두 파일의 변경은 반드시 같은 phase에 배치
- 같은 phase에 넣으면 L 복잡도를 초과하는 경우:
  callee phase → caller phase 순으로 2-phase 분할
  caller phase의 requires에 callee의 produces 참조 필수
  Gate 0.7이 분할 경계의 contract 정합성 검증
- 기존 Rule 9 (Cluster awareness)의 자연스러운 확장
```

**Token cost**: ~100 (decomposer 프롬프트에 규칙 한 줄 추가).

**Evaluator conditions**:
- ⚠️ **필수 조건**: phase 크기 제한(S/M/L)과 Rule 9b 충돌 시 해소 규칙 정의 필요. 위 분할 전략으로 해소.

### CB-03: Gate 0.7 Cross-Boundary Advisory (Static Verification)

| ID | Feature | Status | Priority | Version |
|----|---------|--------|----------|---------|
| CB-03 | Gate 0.7 Cross-Boundary Advisory | ✅ **v0.9.1 done** | 🔴 High | 0.9.1 |

**Problem**: Gate 0.5(tsc/cargo check)는 각 언어 내부만 검증. Gate 1(Tests)은 mock 기반이라 실제 직렬화 경로 미검증. 두 언어 사이의 컨트랙트를 정적으로 대조하는 게이트가 없음.

**Proposal**: Gate 0.5와 Gate 1 사이에 Gate 0.7 삽입 (advisory, non-blocking).

```
Gate 0.7: Cross-Boundary Advisory
  Input: boundary_pairs (from CB-01) + 실제 코드
  Method:
    for each boundary_pair:
      1. caller 측 invoke 파라미터명/타입을 grep 추출
      2. callee 측 command 파라미터명/타입을 grep 추출
      3. framework_rules 적용하여 이름 변환 후 대조
      4. 불일치 → advisory warning 생성

  Output: `.mpl/mpl/gate-0.7-report.md`
  Mode: advisory (non-blocking)
  Warning routing:
    - 경고를 mpl-code-reviewer (Gate 2)에 전달 → 리뷰 컨텍스트로 활용
    - Step 5.5 (Post-Execution Review) Completion Report에 별도 섹션으로 표시
    - 경고 5건 이상 → orchestrator에 "cross-boundary 집중 검토 권고" 알림
```

**Token cost**: 프로젝트 규모에 비례 (50 invoke 기준 ~3-5K).

**Evaluator conditions**:
- ⚠️ **필수 조건**: advisory 경고 라우팅 경로 명시 (위 routing 섹션으로 충족)
- grep 기반이므로 제네릭, serde 속성, 타입 별칭 등에서 false negative 발생 가능 → advisory 모드로 수용

**LT-03a와의 관계**: LT-03a는 **phase 간** interface_contract 검증 (같은 언어 내 produces/requires 존재 확인). CB-03은 **언어 간** cross-boundary contract 검증. 서로 다른 차원의 검증이며 상호 보완적.

### CB-04: Mock Boundary Gap Identification (Verification Planner Extension)

| ID | Feature | Status | Priority | Version |
|----|---------|--------|----------|---------|
| CB-04 | Mock Boundary Gap Flagging | ✅ **v0.9.1 done** | 🟠 Medium | 0.9.1 |

**Problem**: 프론트엔드 테스트가 invoke를 mock하면 실제 serde 직렬화/역직렬화 경로가 검증되지 않음. 이 "검증 갭"이 Verification Planner 산출물에 명시되지 않아 26건의 직렬화 불일치가 테스트를 통과함.

**Proposal**: mpl-verification-planner 프롬프트에 mock gap 식별 규칙 추가.

```yaml
# Verification Planner 산출물에 자동 추가
verification_gaps:
  - gap: "invoke() calls mocked in frontend tests"
    risk: "serde serialization mismatches undetectable"
    mitigation: "CB-03 Gate 0.7 static verification"
    severity: HIGH
    affected_pairs: ["BP-1", "BP-2", ...]
```

**Token cost**: ~50 (프롬프트 확장). 산출물에 verification_gaps 섹션 ~200 추가.

### Summary Table

| ID | Feature | Evaluator Verdict | Priority | Version | Token Cost |
|----|---------|:-----------------:|----------|---------|------------|
| CB-01 | Boundary Pair Scan | ✅ ADOPT | 🔴 High | 0.9.0 | ~500 |
| CB-02 | Decomposer Rule 9b | ✅ ADOPT (with condition) | 🔴 High | 0.9.0 | ~100 |
| CB-03 | Gate 0.7 Advisory | ✅ ADOPT (with condition) | 🔴 High | 0.9.0 | ~3-5K |
| CB-04 | Mock Gap Flagging | ✅ ADOPT (recommended) | 🟠 Medium | 0.9.0 | ~250 |

### Rejected Alternatives

| Alternative | Rejection Reason |
|-------------|-----------------|
| **Full Dependency Graph (CBDG)** | 10K+ 토큰, boundary pairs 대비 추가 가치 불명확. YAGNI. |
| **contracts.yaml SSOT** | 3번째 진실 소스 생성 → 3-way drift 위험. Phase 중 갱신 소유권 충돌. |
| **Codegen (tauri-specta)** | 외부 의존성 금지 원칙 위배. Tauri 전용, 범용성 없음. 프로젝트에 이미 존재 시 기회주의적 활용은 허용. |
| **E2E Integration Tests** | Tauri 백엔드 실행 필요 → 에이전트 환경에서 불가. yggdrasil-e2e-gap-analysis.md에서 이미 확인된 제약. |

### Expected Coverage (combined CB-01 + CB-02 + CB-03 + CB-04)

| Pattern | Issues | Prevention (CB-01+02) | Detection (CB-03) | Combined |
|---------|--------|----------------------|-------------------|----------|
| Spec vs Impl field mismatch | 14 | ~8 (same phase) | ~11 (grep) | ~12/14 |
| Tauri v2 camelCase | 5 | ~4 (framework rules) | ~4 (rule check) | ~5/5 |
| Missing required fields | 3 | ~2 (same phase) | ~2 (field count) | ~2/3 |
| JSON serialization boundary | 4 | ~1 (data_contract) | ~1 (type mismatch) | ~1-2/4 |
| **Total** | **26** | | | **~20-23/26 (77-88%)** |

0% → 77-88% 는 극적 개선. 나머지 ~12-23%는 JSON 직렬화 경계 등 정적 분석 한계이며, v0.9.x에서 추가 대응 검토.

### CB-05: Boundary Check Required Output Field (Worker Schema Enforcement)

| ID | Feature | Status | Priority | Version |
|----|---------|--------|----------|---------|
| CB-05 | boundary_check 필수 출력 필드 | ✅ **v0.9.2 done** | 🔴 High | 0.9.2 |

**Source**: yggdrasil-exp2 (자연어 인터뷰 기반 MPL 테스트, 2026-03-29). 200 테스트 전부 통과했으나 9개 CRITICAL cross-boundary 버그 발견. 기존 CB-01~04는 "감지(detection)" 측 강화이고, CB-05는 "생성(production)" 측 강제.
Analysis: `analysis/mpl-cross-boundary-root-cause-analysis.md`, `analysis/mpl-cross-boundary-consensus-proposal.md`

**Problem**: CB-03(Gate 0.7)은 사후 감지. Step 4.55는 의사코드라 실행 보장 불가. Phase 0 type-policy를 참조한 Phase도 잘못 구현(Phase 2: VisibilityLevel 오정의). 12/18 Phase가 Phase 0 계약 미참조. 근본 원인: **검증이 LLM "판단"에 의존하며, 결정론적 도구로 강제되지 않음.**

**Root Cause (3-Agent Debate 합의)**: "instruction은 무시 가능하지만 output schema는 무시 불가능하다." 기존 접근(Step 4.55 의사코드, type-policy Markdown)은 모두 행동 지시(behavioral instruction). Worker가 따를지는 확률론적. output field를 필수로 만들면 구조적 강제(structural enforcement)가 됨.

**Proposal**: Worker/Phase Runner Output Schema에 `boundary_check` 필수 필드 추가.

```json
{
  "boundary_check": {
    "layers_touched": ["rust", "typescript"],
    "contract_source": ".mpl/mpl/phase0/api-contracts.md#section",
    "assertions": [
      {
        "field": "command_name",
        "contract_value": "create_glossary_term",
        "actual_value": "create_glossary_term",
        "match": true
      },
      {
        "field": "serde_rule:ExtractionResult",
        "contract_value": "snake_case (python direction)",
        "actual_value": "camelCase",
        "match": false
      }
    ],
    "boundary_files_read": [
      "src-tauri/src/commands/glossary.rs",
      "src/stores/entityStore.ts"
    ]
  }
}
```

**Enforcement mechanism**: `validate-output` PostToolUse 훅이 `layers_touched.length >= 2`인 Phase에서 `boundary_check` 미작성 시 출력 거부. Orchestrator가 `match: false` 발견 시 자동 Fix Loop 진입. 단순 문자열 비교 — LLM 판단 불필요.

**CB-01~04와의 관계**:
- CB-01~03은 **감지 측(detection)**: 코드 생성 후 정적 분석으로 불일치 발견
- CB-05는 **생성 측(production)**: 코드 생성 시점에 Worker가 경계 대비 자기 검증을 구조적으로 강제
- CB-05가 먼저 작동(생성 시점), CB-03이 나중에 작동(Gate 시점) → 이중 방어

**Implementation location**:
- ~~`MPL/agents/mpl-worker.md` — Output Schema 확장~~ (v0.9.4: Worker 삭제, CB-05 deprecated by CB-08)
- `MPL/agents/mpl-phase-runner.md` — Step 4.57 L1 Diff Guard (CB-08, replaces CB-05)
- `MPL/hooks/validate-output` — boundary_check 검증 제거 (CB-08 기계적 검증으로 대체)

**Token cost**: ~100 (Worker output 증가분). 검증 자체는 문자열 비교라 추가 LLM 호출 0.

**3-Agent Debate 합의 결론**: Change 1(CB-05) 단독으로 9개 CRITICAL 중 7개 예방 가능. grep/bash 접근(검증 극장)보다 효과적이고, Gate 0.7(사후 감지)보다 시점이 빠름.

**Rejected alternatives (from debate)**:
- grep/bash 기반 Step 4.55 구체화 → "검증 극장". 이름만 잡고 타입/serde 못 잡음. LLM이 grep 실행해도 결과 해석에 또 LLM 의존.
- 컴파일러 기반 (ts-rs, specta) → 외부 의존성 금지 원칙 위배. Python 측은 컴파일러 부재.
- contract.json SSOT → 3번째 진실 소스 생성 위험. CB-05의 assertion이 이를 대체.

### CB-06: Phase별 Contract Snippet 주입 (Decomposer Extension)

| ID | Feature | Status | Priority | Version |
|----|---------|--------|----------|---------|
| CB-06 | Targeted Contract Snippet Injection | ✅ **v0.9.2 done** | 🟠 Medium | 0.9.2 |

**Problem**: Phase 0 계약 전체(~2000 tok)를 주입하면 컨텍스트 경합으로 Worker가 무시하거나 오해석. Phase 2가 type-policy를 참조하고도 VisibilityLevel을 잘못 정의한 사례.

**Proposal**: Decomposer가 Phase 분해 시, 해당 Phase의 `interface_contract`에 Phase 0 계약의 관련 부분만 발췌(3-5줄):

```yaml
phase_5:
  interface_contract:
    contract_snippet: |
      ## From type-policy.md
      ChapterStatus: draft | reviewed | locked
      Tauri param serialization: camelCase
      ## From api-contracts.md
      save_chapter(chapter: SaveChapterInput) → ChapterRecord
```

**CB-05와의 관계**: CB-06은 확률론적 보조(Worker가 snippet을 읽고 올바르게 구현할 확률 향상). CB-05는 구조적 강제(결과를 검증). 순서: CB-06(생성 시 참고) → CB-05(생성 후 검증) → CB-03(Gate에서 감지).

### CB-07: Post-Join Reconciliation Step (Parallel Phase Fix)

| ID | Feature | Status | Priority | Version |
|----|---------|--------|----------|---------|
| CB-07 | Post-Join Boundary Reconciliation | ✅ **v0.9.2 done** | 🟠 Medium | 0.9.2 |

**Problem**: 병렬 Phase(16, 17)가 동시 실행 시 서로의 코드를 읽을 수 없어 커맨드 이름 불일치 발생. Phase 16은 `list_volumes` 호출, Phase 9는 해당 커맨드 미구현. State summary도 없어 추적 불가.

**Proposal**: 병렬 Phase fan-out 후 합류(join) 시점에 reconciliation micro-step:

```
After parallel phases [N, N+1, ...] complete:
  1. Collect boundary_check.assertions from each phase (CB-05 산출물)
  2. Cross-check: Phase N의 actual_value가 Phase N+1의 contract_value와 일치하는가
  3. 불일치 시: targeted fix phase 삽입 (다음 Phase 진행 전)
```

**CB-05 필수**: CB-07은 CB-05의 boundary_check 출력을 입력으로 사용. CB-05 없이 단독 동작 불가.

### Updated Summary Table

| ID | Feature | Evaluator Verdict | Priority | Version | Token Cost | Type |
|----|---------|:-----------------:|----------|---------|------------|------|
| CB-01 | Boundary Pair Scan | ✅ **v0.9.1 done** | 🔴 High | 0.9.1 | ~500 | Detection |
| CB-02 | Decomposer Rule 9b | ✅ **v0.9.1 done** | 🔴 High | 0.9.1 | ~100 | Prevention |
| CB-03 | Gate 0.7 Advisory | ✅ **v0.9.1 done** | 🔴 High | 0.9.1 | ~3-5K | Detection |
| CB-04 | Mock Gap Flagging | ✅ **v0.9.1 done** | 🟠 Medium | 0.9.1 | ~250 | Detection |
| **CB-05** | **boundary_check Required Output** | **✅ v0.9.2 done** | **🔴 High** | **0.9.2** | **~100** | **Enforcement** |
| **CB-06** | **Contract Snippet Injection** | **✅ v0.9.2 done** | **🟠 Medium** | **0.9.2** | **~50** | **Prevention** |
| **CB-05** | **boundary_check Required Output** | **✅ v0.9.2 done** | **🔴 High** | **0.9.2** | **~100** | **Enforcement** |
| **CB-06** | **Contract Snippet Injection** | **✅ v0.9.2 done** | **🟠 Medium** | **0.9.2** | **~50** | **Prevention** |
| **CB-07** | **Post-Join Reconciliation** | **✅ v0.9.2 done** | **🟠 Medium** | **0.9.2** | **~200** | **Enforcement** |
| **CB-08** | **Mechanical Boundary Verification (L0/L1/L2)** | **✅ v0.9.3 done** | **🔴 High** | **0.9.3** | **~0 (shell only)** | **Enforcement** |

> **CB-05~07 실효성 검증 결과 (exp3, 2026-03-29)**: CB-05~07은 프롬프트 수준 구현(done 마킹)이었으나, exp3(Yggdrasil v2)에서 동일 패턴의 cross-boundary 에러 3건이 재현됨. CB-05의 `boundary_check`는 LLM 자기보고이므로 구조적으로 불신뢰. 3-Agent 재토론(Architect/Contrarian/Simplifier) 결과, CB-05의 LLM 의존 검증을 **기계적 검증(shell 기반)으로 대체**하는 CB-08을 합의.

CB-05~07의 설계 원칙: **"LLM에게 지시하지 말고, LLM의 출력을 구조화하라."** (instruction → schema 전환)
CB-08의 설계 원칙: **"LLM이 계약을 생성하고, 기계가 계약을 강제한다."** (LLM verification → shell verification 전환)

### CB-08: Mechanical Boundary Verification (3-Layer)

| ID | Feature | Status | Priority |
|----|---------|--------|----------|
| CB-08 | Mechanical Boundary Verification (L0/L1/L2) | ✅ **v0.9.3 done** | 🔴 High |

**Source**: yggdrasil-exp3 3-Agent Debate Phase 2 (2026-03-29). See `analysis/mpl-cross-boundary-final-consensus.md`.

**Problem**: CB-05~07은 프롬프트/스키마 수준에서 "done"이었으나, exp3에서 210 테스트 전부 통과 + 3건 cross-boundary 에러 재현:
- CB-1: Rust `"content"` vs Python `"text"` (파라미터명 불일치) → 추출 기능 완전 불능
- CB-2: Rust가 `api_key` 미전송, Python이 필수 요구 → 추출 기능 완전 불능
- CB-3: Python Event 모델에 `real_order` 누락 → 듀얼 타임라인 데이터 유실

**Root cause**: CB-05 `boundary_check`는 Worker LLM이 자기 출력을 자기가 검증 — Metaswarm의 "자기 보고 불신" 원칙 위반. 210개 테스트도 mock 기반이라 레이어 간 계약을 검증하지 않음.

**Proposal**: 3-Layer 기계적 검증 (LLM 호출 0건)

| Layer | 이름 | 시점 | 메커니즘 |
|-------|------|------|----------|
| L0 | Contract Definition | Phase 0 | `.mpl/contracts/*.json`에 경계별 키-타입 쌍 생성 |
| L1 | Diff Guard | PostPhase 훅 | `jq keys` + `comm` — 계약 vs 구현 키 대조 |
| L2 | Semantic Verify | Post-Join | 양쪽 구현 파일에서 키 추출 후 diff |

**CB-05~07과의 관계**: CB-08은 CB-05의 **대체(replacement)**. CB-05의 `boundary_check` LLM 출력 필드를 폐기하고, shell 기반 기계적 검증으로 전환. CB-06(snippet 주입)은 확률론적 보조로 유지 가능. CB-07(post-join)의 입력을 CB-05 산출물이 아닌 L1/L2 산출물로 교체.

**Implementation files**:
- `MPL/hooks/mpl-postphase-boundary-check.sh` (신규 — L1 Diff Guard)
- `MPL/prompts/tasks/mpl-run-execute.md` (Post-Join에 L2 추가)
- `MPL/agents/mpl-decomposer.md` (Phase 0에서 contract JSON 생성 지시)

### Version Mapping Update (revised 2026-03-29)

기존 v0.9.0 묶음을 테마별로 분리. PR-01~04는 이미 완료.

```
0.9.0: PR-01~05 + F-E2E-1/1b/1c                ← prompt reinforcement + E2E fallback (DONE)
0.9.1: CB-01 + CB-02 + CB-03 + CB-04           ← cross-boundary detection (DONE)
0.9.2: CB-05 + CB-06 + CB-07                    ← cross-boundary enforcement (DONE)
0.9.3: CB-08 (L0/L1/L2 Mechanical Verification) ← cross-boundary mechanical enforcement (DONE)
0.9.4: Worker removal + Principle 1/5 update + version notation (Pre-v2 Cleanup) (DONE)
0.10.0: KT-01 + CB-L0 + SEED-01/02/03 + SNT-S0/S1/S3 + CB-L1 (Mechanical Boundary Foundation) (DONE)
0.10.1: MCP path fix (.mcp.json ${CLAUDE_PLUGIN_ROOT} prefix) (DONE)
0.10.2: T-11 Skill Quality Polish (description trigger hints + deprecated stub + setup split) (DONE)
--- v2 Phase 2 ---
0.11.0: GATE-01 + HAT-01/02/03 + AGT-02~05 + RETRY-01/02 + CLUST-01 (구조 전환)
--- v2 Phase 3 ---
1.0.0: JUDGE-01/02/03 + FLOW-01/01b/02/03 + CB-L2 + DOC-05 (완전체)
--- Post-v2 ---
1.1.0: T-05 + T-06 + TS-01/02 + BM-04 + F-269 (기능 추가)
1.2.0: T-08 + T-09 + P-04 + F-06 (관리 도구)
```

> Dropped (v2 대체): LT-01, LT-03a, LT-03b, BM-03, LT-04b, T-02
> Source: `analysis/mpl-v2-roadmap.md` + `analysis/mpl-v2-design-consensus.md`

---

## Prompt Reinforcement Features (from Yggdrasil Codebase Issue Scan, 2026-03-28)

> **Source**: Yggdrasil codebase-issue-scan에서 33건 이슈 발견. CB-01~04로 커버되는 ~15건 외 나머지 ~18건 분석.
> 3-Agent 토론(Architect/Contrarian/Evaluator) 수행. 합의: 신규 Gate/Module 없이 기존 프롬프트 강화로 대응.
> Analysis: `analysis/mpl-cross-boundary-verification-gap.md`, Yggdrasil `.mpl/mpl/codebase-issue-scan.md`

### 설계 원칙

Contrarian/Evaluator 합의에 따라, 나머지 18건은 **신규 인프라(Gate 0.8, Module 7) 없이** 기존 파이프라인 프롬프트 강화만으로 대응한다.

근거:
1. 카테고리당 2~4건으로 전용 시스템 정당화 불가 (CB-01~04의 15건과 대비)
2. 대부분 Gate 2 Code Review의 기존 10개 카테고리에 자연스럽게 매핑
3. 프롬프트 1~5줄 추가로 추가 토큰 비용 거의 0
4. 신규 Gate 증식은 micro-phase 철학과 충돌 (이미 7개 Gate 존재/계획)

Module 7(Pattern Scan) + Gate 0.8(Pattern Advisory)는 **동일 패턴 이슈 5건 이상 재발 시** v0.9.x에서 재평가한다.

### PR-01: Transaction Boundary Check (db.md Domain Prompt)

| ID | Feature | Status | Priority | Version |
|----|---------|--------|----------|---------|
| PR-01 | Transaction Boundary Verification | ✅ **v0.9.0 done** | 🔴 High | 0.9.0 |

**Problem**: 다중 DB 변경 연산(INSERT/UPDATE/DELETE)이 트랜잭션 래핑 없이 실행되어 partial failure 시 데이터 무결성 훼손. Yggdrasil에서 2건 발견 (import_world 70+ INSERTs, reorder_chapters loop UPDATEs).

**Proposal**: `MPL/prompts/domains/db.md`에 트랜잭션 래핑 규칙 추가.

```markdown
# db.md 추가 규칙
- 단일 함수 내 2개 이상의 DB 변경 연산(INSERT/UPDATE/DELETE)은 반드시 트랜잭션으로 래핑
- Step 3-B에서 DB 도메인 페이즈에 A-item 자동 삽입:
  "[A-TX] 다중 DB 변경 함수에 BEGIN/COMMIT 또는 .transaction() 래핑 확인"
```

**Token cost**: +0 (프롬프트 2줄 추가)

**Evaluator verdict**: ✅ ADOPT. Value Score 9.0 (최고). grep 탐지 신뢰도 HIGH, 구현 비용 극히 낮음.

**Covers**: Issue 1.9 (import_world), 1.14 (reorder_chapters)

### PR-02: Security Pattern Concretization (Gate 2 Security Category)

| ID | Feature | Status | Priority | Version |
|----|---------|--------|----------|---------|
| PR-02 | Security Pattern Grep Patterns | ✅ **v0.9.0 done** | 🔴 High | 0.9.0 |

**Problem**: Gate 2 Code Reviewer의 Category 2(Security)가 추상적 지시만 포함. LLM이 매번 다른 보안 항목을 검사하여 일관성 없음. Yggdrasil에서 weak UUID(SystemTime nanos만 사용)와 CSP null이 통과.

**Proposal**: Gate 2 Security 카테고리에 구체적 grep 패턴 목록 추가.

```markdown
# code-reviewer 프롬프트 Security 카테고리 확장
Security 검사 시 다음 패턴을 Bash grep으로 반드시 확인:
- Weak random: `SystemTime|Date.now.*%|Math.random.*id` → uuid crate 또는 crypto.randomUUID() 권고
- Missing CSP: `csp.*null|content.security.policy` in config files → production CSP 설정 권고
- Hardcoded secrets: `password\s*=\s*"|api_key\s*=\s*"|secret\s*=\s*"` → 환경변수 권고
- SQL injection: 문자열 보간 SQL (`format!("SELECT.*{}")`, template literal SQL) → parameterized query 권고
```

**Token cost**: +0 (프롬프트 5줄 추가). Gate 2 실행 시 grep 호출 ~200 토큰 추가.

**Evaluator verdict**: ✅ ADOPT. Value Score 6.5. 기존 카테고리 구체화일 뿐, 신규 메커니즘 아님.

**Covers**: Issue 1.6 (weak UUID), 6.1 (CSP null)

**Alternative considered**: `/security-audit` 스킬 연동 — v0.9.1에서 검토. 현재는 프롬프트 강화가 최소 비용.

### PR-03: UI Hardcoding Detection (Gate 2 Design System Category)

| ID | Feature | Status | Priority | Version |
|----|---------|--------|----------|---------|
| PR-03 | UI Hardcoding Grep Patterns | ✅ **v0.9.0 done** | 🟠 Medium | 0.9.0 |

**Problem**: Gate 2 Category 9(Design System Compliance)가 `phase_domain == "ui"` 조건에서만 활성화되나, 구체적 grep 패턴이 없어 하드코딩 색상을 체계적으로 잡지 못함. Yggdrasil에서 3개 컴포넌트의 light-mode 전용 hex 색상, 27개 파일의 82개 raw hex 인스턴스 발견.

**Proposal**: Gate 2 Design System 카테고리에 하드코딩 탐지 지시 추가.

```markdown
# code-reviewer 프롬프트 Design System 카테고리 확장 (phase_domain == "ui" 시)
다음 패턴을 Bash grep으로 확인:
- Raw hex colors: `/#[0-9a-fA-F]{3,8}/` in .tsx/.vue/.svelte (CSS 변수 정의 파일 제외)
  → `var(--color-xxx)` 또는 theme 토큰 사용 권고
- Dark mode 미대응: 배경/텍스트에 light-only 색상 (#fee2e2, #fef3c7 등) 사용
  → prefers-color-scheme 또는 dark: variant 필요
- 20건 이상 raw hex → "디자인 토큰화 필요" advisory
```

**Token cost**: +0 (프롬프트 3줄 추가). Gate 2 실행 시 grep 호출 ~100 토큰 추가.

**Evaluator verdict**: ✅ ADOPT. Value Score 8.5. 기존 카테고리에 패턴만 명시.

**Covers**: Issue 4.1 (ConflictCard), 4.2 (ConflictPanel), 4.3 (ReviewPanel), 4.4 (widespread hardcoded colors)

### PR-04: Resource Lifecycle Pair Check (Gate 2 Correctness Category)

| ID | Feature | Status | Priority | Version |
|----|---------|--------|----------|---------|
| PR-04 | Resource Lifecycle Pair Checklist | ✅ **v0.9.0 done** | 🟠 Medium | 0.9.0 |

**Problem**: open/close, backup/restore, create/destroy 같은 lifecycle 쌍에서 리소스 정리가 누락. Yggdrasil에서 close_project()가 DB 연결 미해제, restore_backup()이 DB 재연결 미수행, Frontend closeProject()가 Backend 미호출.

**Proposal**: Gate 2 Correctness(Category 1) 체크리스트에 lifecycle pair 항목 추가.

```markdown
# code-reviewer 프롬프트 Correctness 카테고리 확장
- Resource lifecycle pair: open/connect/create/backup 함수가 있으면,
  대응하는 close/disconnect/destroy/restore 함수에서 해당 리소스를 실제로 정리하는지 확인.
  Frontend ↔ Backend 양쪽에서 lifecycle이 동기화되는지 확인 (예: Frontend close → Backend close 호출).
```

**Token cost**: +0 (프롬프트 2줄 추가)

**Evaluator verdict**: ✅ ADOPT. Value Score 7.0. grep 기반 자동 탐지(Gap 1의 RL-01)는 제어 흐름 분석 한계로 보류. Code Reviewer의 의미론적 판단에 위임이 현실적.

**Covers**: Issue 1.7 (close_project DB), 1.8 (restore_backup DB), 3.4 (Frontend closeProject)

**Escalation trigger**: Lifecycle 이슈 5건 이상 재발 시 → Module 7 (RL Pair Scan) + Gate 0.8 정식 도입 검토.

### PR-05: Error Handling Strictness (Phase 0 Error Spec)

| ID | Feature | Status | Priority | Version |
|----|---------|--------|----------|---------|
| PR-05 | Strict Mode + unwrap Audit | ✅ **v0.9.0 done** | 🟢 Low | 0.9.0 |

**Problem**: TypeScript의 `strictNullChecks` 미설정으로 null 관련 런타임 오류 미탐지. Rust에서 `unwrap()` 남용으로 패닉 위험. Yggdrasil에서 `invoke<Chapter>` 반환값이 실제로는 `Option<Chapter>`인데 null check 없이 접근.

**Proposal**: Phase 0 Enhanced Step 4(Error Spec)에서 strict 설정 확인 추가.

```markdown
# Phase 0 Error Spec 확장
- TypeScript: `tsconfig.json`에서 `strict: true` 또는 `strictNullChecks: true` 확인.
  미설정 시 advisory 경고 + Phase Decision에 기록.
- Rust: 프로덕션 코드에서 `.unwrap()` 사용 개수 확인.
  10건 이상 시 "unwrap 감사 필요" advisory.
```

**Token cost**: +0 (프롬프트 2줄 추가)

**Evaluator verdict**: ✅ ADOPT. Value Score 8.0. 컴파일러가 대부분 처리하므로 프롬프트 추가만으로 충분.

**Covers**: Issue 3.8 (missing try/catch), 3.10 (null check 부재)

### PR Summary Table

| ID | Feature | Evaluator Verdict | Priority | Version | Token Cost | Covers |
|----|---------|:-----------------:|----------|---------|------------|--------|
| PR-01 | Transaction Boundary Check | ✅ ADOPT | 🔴 High | 0.9.0 | +0 | 1.9, 1.14 |
| PR-02 | Security Pattern Grep | ✅ ADOPT | 🔴 High | 0.9.0 | ~200 | 1.6, 6.1 |
| PR-03 | UI Hardcoding Detection | ✅ ADOPT | 🟠 Medium | 0.9.0 | ~100 | 4.1~4.4 |
| PR-04 | Lifecycle Pair Check | ✅ ADOPT | 🟠 Medium | 0.9.0 | +0 | 1.7, 1.8, 3.4 |
| PR-05 | Error Handling Strictness | ✅ ADOPT | 🟢 Low | 0.9.0 | +0 | 3.8, 3.10 |

**총 추가 토큰 비용**: ~300 (PR-02, PR-03의 grep 호출만)

### Expected Coverage (CB-01~04 + PR-01~05 combined)

| Source | Issues | CB-01~04 | PR-01~05 | Combined | Uncovered |
|--------|--------|----------|----------|----------|-----------|
| Cross-boundary contracts | 15 | ~15 | — | ~15 | 0 |
| Transaction boundaries | 2 | — | 2 | 2 | 0 |
| Security patterns | 2 | — | 2 | 2 | 0 |
| UI consistency | 4 | — | 4 | 4 | 0 |
| Resource lifecycle | 3 | — | ~2 | ~2 | ~1 |
| Error handling | 2 | — | ~2 | ~2 | 0 |
| Code quality (DRY) | 3 | — | — | 0 | 3 (Gate 1.5+2 기존 커버) |
| Feature completeness | 2 | — | — | 0 | 2 (S-item+E2E 기존 커버) |
| **Total** | **33** | **~15** | **~12** | **~27** | **~6** |

**0% → 82% 커버리지** (CB-01~04의 77-88%에서 추가 12건 확보). 잔여 6건은 기존 Gate 1.5/Gate 2/S-item/E2E로 이미 담당하는 영역이므로 추가 메커니즘 불필요.

### Deferred: Module 7 + Gate 0.8 (Architect Proposal)

| Feature | Status | Escalation Trigger |
|---------|--------|-------------------|
| Module 7 (Pattern Discovery) | ⏸️ Deferred | 동일 패턴 카테고리 이슈 5건 이상 재발 |
| Gate 0.8 (Pattern Advisory) | ⏸️ Deferred | PR-01~05 프롬프트 강화로 커버 불가 확인 시 |

Architect의 Module 7(lifecycle_pairs, transaction_candidates, security_findings, design_system_info를 codebase-analysis.json에 추가) + Gate 0.8(패턴별 정적 검증) 설계는 보존하되, 프롬프트 강화 효과 검증 후 필요성 재평가.

### Out of Scope

| Category | Issues | Reason |
|----------|--------|--------|
| Code Quality (DRY) | 1.4, 1.5, 1.13 | Gate 1.5(F-50 code duplication) + Gate 2 Category 4(Maintainability) 이미 담당 |
| Feature Completeness | 3.5, 7.6 | S-item + E2E + Browser QA(Gate 1.7) 이미 담당. 근본 원인은 스펙 불완전성 → Phase 0 강화가 정답 |

### Debate Transcript Summary

**3-Agent 토론 (2026-03-28)**:

| Agent | Position | Key Argument |
|-------|----------|--------------|
| **Architect** | Module 7 + Gate 0.8 신설 | 5개 gap을 "Verification Pattern" 추상화로 통합. pluggable scanner 구조. ~4.3K 토큰 |
| **Contrarian** | 기존 구조 강화만 | Gate 증식은 micro-phase 철학 위배. 보안/UI는 린터 영역. Feature Completeness는 스펙 갭. "체계화는 데이터 축적 후" |
| **Evaluator** | 프롬프트 강화 우선 | Value Score 기반 우선순위. 상위 4개 모두 "프롬프트 1줄" 수준. CB+PR = 79-82% 커버리지 |

**합의점**: CB-01~04 + PR-01~05(프롬프트 강화) → v0.9.0. Module 7/Gate 0.8 → deferred. DRY/FC → out of scope.

**분기점 해소**: Gate 0.8 신설 불필요 (Contrarian 승). 단, Architect의 Module 7 + Gate 0.8 설계는 escalation trigger 조건부로 보존.

---

*This document is for review before confirmation. When individual features are approved, separate them into their own design documents.*
