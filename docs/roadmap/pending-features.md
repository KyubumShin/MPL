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

### Planned

| Version | Features | Type |
|---------|----------|------|
| **0.9.0** | **TS-01/02** MCP Assertion tools + T-05 Design Contract + T-06 Doc Sync | Feature: test infra + UI workflow |
| **Brownfield** | **#4** Do-Not-Touch + **#2** IRA + **#3** Regression Shield | Feature: brownfield mode |
| **Experiment** | T-02 Same-model dual review | Validate effectiveness |
| **0.10.0** (TBD) | **P-03** Scout Observability (최소 로깅) + **P-01** State Summary L0 (의존성 기반 압축) | Feature: observability + context intelligence |
| **0.11.0** (TBD) | **P-04** Skill Audit CLI (P-03 데이터 기반, auto-dream 패턴 채택) | Feature: lifecycle management |
| **Dropped** | **P-02** Phase 0 L0 (P-01에 흡수), **P-05** Context Assembly YAML (시기상조) | Debate consensus 2026-03-24 |
| **Deferred** | T-08 Trend Retro, T-09 Performance Gate, F-06 Multi-Project, F-269 RUNBOOK format, #6 (already implemented), #7 Hashline, #8 Cross-Project Learning | Pending data/need |
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
| P-01 | State Summary L0 (의존성 기반 압축) | ❌ Not implemented | 🟠 Medium-High (debate revised) |

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
| P-03 | Scout search path observability | ❌ Not implemented | 🔴 High (debate revised — P-01 선행 조건) |

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
| P-04 | Skill Audit CLI (P-03 데이터 기반) | ❌ Not implemented → deferred v0.9.0 | 🟡 Medium (debate revised — P-03 데이터 축적 후) |

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

*This document is for review before confirmation. When individual features are approved, separate them into their own design documents.*
