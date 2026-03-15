---
description: MPL Phase 0 Protocol - Triage, PP Interview, Gap/Tradeoff Analysis, Codebase Analysis, Phase 0 Enhanced
---

# MPL Phase 0: Pre-Execution Analysis

This file contains Steps 0 through 2.5 of the MPL orchestration protocol.
Load this when `current_phase` is in the pre-execution stages (before decomposition).

---

## Step -1: LSP Warm-up (Non-blocking)

파이프라인 시작 시 LSP 서버를 사전 워밍업한다. Step 0 Triage와 병렬로 실행되므로 지연 없음.

```
on mpl-init:
  1. Detect project languages from file extensions:
     Glob("**/*.{ts,tsx,js,jsx,py,go,rs}")
     → language_set = detected extensions mapped to LSP servers

  2. Trigger LSP warm-up for each detected language:
     for each language in language_set:
       lsp_hover(file=first_file_of_language, line=1, character=0)
       // First call triggers LSP server initialization
       // Response is discarded — purpose is warm-up only

  3. Record active LSP servers in state:
     .mpl/mpl/state.json → lsp_servers: ["typescript", "python", ...]
```

| 언어 | LSP 서버 | Cold Start | Warm-up 후 |
|------|---------|-----------|-----------|
| TypeScript/JS | typescript-language-server | 2~5s | <100ms |
| Python | pylsp / pyright | 3~10s | <200ms |
| Go | gopls | 2~8s | <100ms |
| Rust | rust-analyzer | 5~30s | <500ms |

LSP 서버별 활용 가능 기능:

| LSP 도구 | Phase 0 활용 | Execution 활용 |
|----------|-------------|---------------|
| `lsp_hover` | API 시그니처·타입 추론 추출 | Worker 결과 타입 검증 |
| `lsp_diagnostics` | 기존 코드 건강도 파악 | Worker 결과물 정적 검증 |
| `lsp_find_references` | 중심성 분석 (import보다 정확) | blast radius 계산 |
| `lsp_goto_definition` | 의존성 체인 추적 | cross-file 참조 해결 |
| `lsp_document_symbols` | 공개 API 목록 추출 | 인터페이스 변경 감지 |
| `lsp_rename` | - | 안전한 리팩토링 |
| `lsp_code_actions` | - | auto-import, quick-fix |

워밍업 실패 시 (LSP 서버 미설치): 경고만 출력하고 진행. LSP 없이도 ast_grep_search + Grep 폴백으로 동작한다.

```
if lsp_hover fails for a language:
  Report: "[MPL] LSP warm-up: {language} server not available. Falling back to ast_grep + Grep."
  remove language from lsp_servers list
```

### Standalone Mode Detection (F-04)

After LSP warm-up attempts, determine tool_mode:

```
active_tools = { lsp: lsp_servers.length > 0, ast_grep: false }

// Test ast_grep availability
try:
  ast_grep_search(pattern="$X", language=detected_language)
  active_tools.ast_grep = true
catch:
  Report: "[MPL] ast_grep unavailable."

// Determine tool_mode
if active_tools.lsp AND active_tools.ast_grep:
  tool_mode = "full"
elif active_tools.lsp:
  tool_mode = "partial"  // LSP only, no ast_grep
else:
  tool_mode = "standalone"  // Grep/Glob only

writeState(cwd, { tool_mode: tool_mode })
Announce: "[MPL] Tool mode: {tool_mode}. LSP: {active_tools.lsp}, ast_grep: {active_tools.ast_grep}."
```

All subsequent Phase 0 steps check `tool_mode` before using LSP/ast_grep tools.
If tool_mode is "standalone" or "partial", use the fallbacks defined in `docs/standalone.md`.

---

## Step 0: Triage

Triage determines two things: **pipeline_tier** (which pipeline depth to use) and **interview_depth** (how deep the PP interview goes). Pipeline tier is determined by Quick Scope Scan (F-20), replacing the previous keyword-based mode detection.

### 0.1: Quick Scope Scan + Pipeline Tier (F-20)

Perform a lightweight codebase scan (~1-2K tokens) to calculate `pipeline_score` and determine `pipeline_tier`:

```
Quick Scope Scan:
  1. Glob("**/*.{ts,tsx,js,jsx,py,go,rs,java}") → project file count
  2. Identify affected files from user prompt:
     - Extract file/module names mentioned in prompt
     - Grep for their existence → affected_files count
  3. Test existence check:
     - Glob("**/*.{test,spec}.*", "**/*_test.*", "**/test_*") → test file count
     - Estimate test_scenarios = min(affected_files × 2, test_file_count)
  4. Import depth sampling (1-hop):
     - For first 3 affected files: Grep("import|require|from", file)
     - import_depth = max import chain depth found
  5. Risk signal from prompt keywords:
     - bugfix/fix/typo → 0.1
     - add/update/field → 0.3
     - feature/implement → 0.5
     - refactor/migrate/architecture → 0.8
     - overhaul/rewrite → 0.95

pipeline_score = (file_scope × 0.35) + (test_complexity × 0.25)
               + (dependency_depth × 0.25) + (risk_signal × 0.15)

  file_scope      = min(affected_files / 10, 1.0)
  test_complexity  = min(test_scenarios / 8, 1.0)
  dependency_depth = min(import_depth / 5, 1.0)
```

#### 0.1.5a: Routing Pattern Matching (F-22)

Before finalizing tier, check past execution patterns for a similar task:

```
if exists(".mpl/memory/routing-patterns.jsonl"):
  { match, similarity, recommendation } = findSimilarPattern(cwd, user_request)
  // Uses hooks/lib/mpl-routing-patterns.mjs (Jaccard similarity, threshold 0.8)

  if recommendation:
    // Pattern match found — use as tier hint (but score can override if 2+ tiers apart)
    if |tier_from_score - recommendation| <= 1 tier:
      tier = recommendation
      source = "pattern_match"
      Announce: "[MPL] Routing pattern match: similarity={similarity}, recommending tier={recommendation}."
    else:
      // Score and pattern disagree significantly — trust score
      Announce: "[MPL] Routing pattern found (similarity={similarity}) but score disagrees. Using score-based tier."
```

#### 0.1.5b: Load Run-to-Run Learnings (F-11)

Load accumulated learnings from past runs for Phase 0 and execution reference:

```
if exists(".mpl/memory/learnings.md"):
  learnings = Read(".mpl/memory/learnings.md")
  // Learnings are injected into Phase Runner context (Step 4.2) as supplementary reference
  // and into Phase 0 Enhanced (Step 2.5) for error spec and pattern alignment
  Announce: "[MPL] Loaded learnings from past runs."
```

#### 0.1.5c: 4-Tier Adaptive Memory 로드 (F-25)

Phase 0 시작 시 이전 실행의 메모리를 선택적으로 로드한다.
기존 learnings.md(F-11) 단일 로드를 4-Tier 구조로 확장한다.

##### 로딩 우선순위 및 예산

| Tier | 파일 | 로드 조건 | 최대 토큰 | 용도 |
|------|------|----------|----------|------|
| 1 | `semantic.md` | 항상 (파일 존재 시) | 500 | 프로젝트 지식, 일반화 규칙 |
| 2 | `procedural.jsonl` | 태스크 설명 키워드 매칭 | 500 | 관련 도구 패턴, 실패 회피 |
| 3 | `episodic.md` | 항상 (파일 존재 시) | 800 | 이전 실행 요약, 맥락 파악 |
| 4 | `learnings.md` (하위 호환) | semantic.md 없을 때만 | 500 | F-11 레거시 호환 |

총 예산: 최대 2000 토큰

##### 선택적 로딩 알고리즘

```pseudocode
function load_phase0_memory(task_description):
  memory_context = ""
  remaining_budget = 2000
  semantic_loaded = false

  # Tier 1: Semantic (프로젝트 지식 — 항상 유용)
  if exists(".mpl/memory/semantic.md"):
    semantic = read_truncated(".mpl/memory/semantic.md", 500)
    memory_context += "## 프로젝트 지식 (semantic)\n" + semantic
    remaining_budget -= token_count(semantic)
    semantic_loaded = true

  # Tier 2: Procedural (관련 패턴만)
  if exists(".mpl/memory/procedural.jsonl"):
    keywords = extract_keywords(task_description)  # 간단 토큰화
    relevant = query_by_tags(procedural, keywords, limit=10)
    if relevant:
      procedural_text = format_procedural(relevant)
      memory_context += "## 관련 도구 패턴 (procedural)\n" + procedural_text
      remaining_budget -= token_count(procedural_text)

  # Tier 3: Episodic (최근 실행 맥락)
  if exists(".mpl/memory/episodic.md"):
    episodic = read_recent(".mpl/memory/episodic.md", max_tokens=min(800, remaining_budget))
    memory_context += "## 이전 실행 요약 (episodic)\n" + episodic

  # 하위 호환: semantic 없으면 기존 learnings.md 사용
  elif exists(".mpl/memory/learnings.md") and not semantic_loaded:
    learnings = read_truncated(".mpl/memory/learnings.md", 500)
    memory_context += "## 축적 학습 (learnings)\n" + learnings

  return memory_context
```

```
loaded_memory = load_phase0_memory(user_request)
if loaded_memory:
  // Phase Runner context (Step 4.2) 및 Phase 0 Enhanced (Step 2.5)에 주입
  Announce: "[MPL] 4-Tier memory loaded. Budget used: {2000 - remaining_budget}/2000 tokens."
else:
  Announce: "[MPL] No memory files found. Proceeding without prior context."
```

##### 토큰 절감 측정 기준

**Baseline (F-11 기존 방식)**: learnings.md 전체 파일 로드 — 최대 2000 토큰, 선택성 없음.
**4-Tier (F-25 신규 방식)**: 선택적 로드 — semantic(관련 규칙만) + procedural(매칭 태그만) + episodic(최근 2 Phase만).

절감 비율 측정:
- Phase 5+ 실행 시 episodic 압축 효과: 10 Phase 실행 → 2 Phase 상세 + 8줄 압축 = ~400 토큰 (vs 전체 ~2000)
- procedural 태그 매칭: 100 entries 중 평균 5-10건 매칭 = ~200 토큰 (vs 전체 ~1500)
- semantic 일반화: 반복 패턴 제거로 ~200 토큰 (vs episodic 전체 반복 포함 ~800)
- **예상 총합**: ~800 토큰 / 기존 ~2000 토큰 = **60% 절감** (보수적)
- 프로파일링(Step 2.5.9)에서 `memory_tokens_loaded` vs `legacy_learnings_tokens` 비교로 실측

##### Phase 0 Enhanced와의 연동

Phase 0 Enhanced(Step 2.5) 실행 시 메모리 참조:
- **semantic.md의 "Project Conventions"** → Type Policy(Step 3) 생성 시 기존 컨벤션 반영
- **procedural.jsonl의 api_contract_violation 태그** → API Contract(Step 1) 검증 시 과거 실패 패턴 회피
- **episodic.md의 최근 Phase 0 결과** → 복잡도 판정 시 이전 실행 복잡도 참조

#### semantic.md 활용 Phase 0 단축 메커니즘

semantic.md에 축적된 프로젝트 지식이 Phase 0 Enhanced 단계를 단축한다:

| semantic.md 항목 | Phase 0 단축 효과 | 예상 절감 |
|-----------------|------------------|----------|
| `## Project Conventions` 에 타입 규칙 존재 | Step 3 (Type Policy): 기존 컨벤션을 시드로 사용하여 분석 범위 축소 | ~30% |
| `## Success Patterns` 에 API 패턴 존재 | Step 1 (API Contract): 기존 패턴 재활용, 신규 API만 추출 | ~20% |
| `## Failure Patterns` 에 에러 패턴 존재 | Step 4 (Error Spec): 과거 실패 기반 에러 명세 보강 — 재분석 불필요 | ~15% |

**단축 로직**:
```pseudocode
function phase0_with_semantic(semantic_content, complexity_grade):
  # semantic 존재 시 각 Step에 시드 주입
  if semantic_content.has("Project Conventions"):
    step3_type_policy.seed = semantic_content["Project Conventions"]
    step3_type_policy.scope = "incremental"  # 전체 분석 → 변경분만

  if semantic_content.has("Success Patterns"):
    step1_api_contracts.known_patterns = semantic_content["Success Patterns"]
    step1_api_contracts.scope = "delta_only"  # 신규 API만 추출

  if semantic_content.has("Failure Patterns"):
    step4_error_spec.prior_failures = semantic_content["Failure Patterns"]
    # 과거 실패 패턴은 자동 포함 — 재분석 불필요
```

**측정**: Phase 0 토큰 프로파일링(Step 2.5.9)에서 `semantic_seed_applied: true/false` 기록.
반복 프로젝트에서 semantic.md 유무에 따른 Phase 0 토큰 비교로 20-30% 단축 검증.

Classify tier from score (or override with user hint):

| pipeline_tier | Score | Tier Hint | Pipeline Depth |
|---------------|-------|-----------|---------------|
| `"frugal"` | < 0.3 | `"mpl bugfix"` | Error Spec → Fix Cycle → Gate 1 → Commit |
| `"standard"` | 0.3~0.65 | `"mpl small"` | PP(light) → Error Spec → Single Phase → Gate 1 → Commit |
| `"frontier"` | > 0.65 | (none) | Full 9+ step pipeline (Steps 0~6) |

```
tier_hint = state.tier_hint  // from keyword-detector (may be null)
{ score, breakdown } = calculatePipelineScore(scan_results)
{ tier, source } = classifyTier(score, tier_hint)

Write pipeline_tier to state:
  writeState(cwd, { pipeline_tier: tier })

Announce: "[MPL] Triage: pipeline_tier={tier} (source={source}, score={score}).
           Scan: files={affected_files}, tests={test_scenarios}, depth={import_depth}, risk={risk_signal}."
```

#### Tier-Based Step Selection

After tier is determined, subsequent steps are selected per tier:

| Step | Frugal | Standard | Frontier |
|------|--------|----------|----------|
| Step 0.2 Interview Depth | light (+ Uncertainty Scan) | light | full detection |
| Step 0.5 Maturity | skip | read config | read config |
| Step 1 PP + 요구사항 인터뷰 (v2) | light (Round 1+2 + Uncertainty Scan) | light (Round 1+2 + 경량 요구사항) | full (4 rounds + 소크라틱 + JUSF) |
| Step 1-B Pre-Execution | skip | skip | full |
| Step 2 Codebase Analysis | skip (use scan) | structure + tests only | full (6 modules) |
| Step 2.5 Phase 0 Enhanced | Step 4 only (Error Spec) | Step 4 only (Error Spec) | complexity-adaptive |
| Step 3 Decomposition | skip (single fix cycle) | skip (single phase) | full decomposition |
| Gates | Gate 1 only | Gate 1 only | Gate 1 + 2 + 3 |

```
if pipeline_tier == "frugal":
  -> Continue to Step 0.2 (interview_depth = "light" + Uncertainty Scan)
  -> Then Step 1 (light interview) → Step 2.5.5 (Error Spec only)
  -> Then proceed directly to Phase Execution (single fix cycle)

if pipeline_tier == "standard":
  -> Continue to Step 0.2 (interview_depth forced to "light")
  -> Then Steps 1 → 2.5.5 → Phase Execution (single phase)

if pipeline_tier == "frontier":
  -> Continue to Step 0.2 (full interview depth detection)
  -> Then full pipeline (Steps 0.5 → 1 → 1-B → 2 → 2.5 → 3 → 4 → 5)
```

### 0.1.5: RUNBOOK Initialization (F-10)

After Triage determines pipeline_tier, create the RUNBOOK:

```
Write(".mpl/mpl/RUNBOOK.md"):
  # RUNBOOK — {user_request (first 100 chars)}
  Started: {ISO timestamp}
  Pipeline Tier: {pipeline_tier} (source: {source}, score: {score})
  Maturity: (pending detection)

  ## Current Status
  - Phase: 0/? (triage complete, pre-execution)
  - State: mpl-init
  - Last Updated: {ISO timestamp}

  ## Milestone Progress
  (decomposition pending)

  ## Key Decisions
  (none yet)

  ## Known Issues
  (none yet)

  ## Blockers
  (none)

  ## Discoveries
  (none yet)

  ## How to Resume
  Load: this file
  Next: PP Interview → Codebase Analysis → Decomposition
```

### 0.2: Interview Depth

**인터뷰는 항상 실행된다.** 전체 스펙 구현을 위해 사전 불확실성 해소가 필수적이다.
인터뷰를 생략하면 실행 중 CRITICAL discovery가 빈발하여 Side Interview로 파이프라인이 느려진다.

```
interview_depth = classify_prompt(user_request):
  information_density = count(explicit_constraints, specific_files, measurable_criteria, tradeoff_choices)

  if information_density >= 8 AND has_explicit_constraints AND has_success_criteria:
    -> "light" (Round 1 + Round 2 + Uncertainty Scan for HIGH items)
  elif information_density >= 4 AND has_some_constraints:
    -> "light" (Round 1 + Round 2 only)
  else:
    -> "full" (all 4 rounds)
```

> **NOTE**: `"skip"` 옵션은 제거되었다. 아무리 상세한 프롬프트라도 암묵적 가정, PP 간 충돌,
> 스펙 모호성이 존재할 수 있다. 최소 light 인터뷰(Round 1+2)를 통해 이를 사전 검출한다.
> 고밀도 프롬프트(density ≥ 8)의 경우, light 인터뷰 후 Uncertainty Scan을 추가 실행하여
> HIGH 불확실성 항목에 대해 타겟 질문(최대 3개)을 수행한다.

| interview_depth | Condition | Interview Behavior |
|-----------------|-----------|-------------------|
| `"full"` | Vague/broad requests (density < 4) | PP 4-round full interview (default) |
| `"light"` | Specific but incomplete (density 4-7) | What + What NOT only |
| `"light"` | Very detailed with constraints (density 8+) | What + What NOT + **Uncertainty Scan** (0~3 targeted questions on HIGH items) |

Announce: `[MPL] Triage: interview_depth={depth}. Prompt density: {score}.`

---

## Step 0.5: Maturity Mode Detection

Read `.mpl/config.json` for `maturity_mode` (default: `"standard"`).

| Mode | Phase Size | PP | Discovery Handling |
|------|-----------|-----|--------------------|
| `explore` | S (1-3 TODOs) | Optional | Auto-approved |
| `standard` | M (3-5 TODOs) | Required | HITL on PP conflict |
| `strict` | L (5-7 TODOs) | Required + enforced | All changes HITL |

Announce: `[MPL] Maturity mode: {mode}. Phase sizing: {S/M/L}`

---

## Step 1: PP + 요구사항 통합 인터뷰 (mpl-interviewer v2) [F-26]

기존 PP Interview를 mpl-interviewer v2로 확장한다. interview_depth에 따라 PP 발견과 요구사항 구조화가 단일 인터뷰 세션에서 동시에 수행된다.

> **핵심 통찰**: PP 발견 과정 자체가 요구사항 정의의 핵심 요소이다. 분리하면 이중 인터뷰 피로가 발생한다.

interview_depth에 따라 인터뷰 범위가 자동 조절된다:

### depth == "light"

```
Phase 1 (mpl-interviewer):
  Round 1 (What) + Round 2 (What NOT) + [고밀도 전용: Uncertainty Scan]
  → Output: pivot-points.md + user_responses_summary

Stage 2 (mpl-ambiguity-resolver):
  Spec Reading → Ambiguity Scoring Loop → 요구사항 구조화
  → Output: ambiguity score + requirements-light.md
```

**Phase 1 상세**:

1. **Round 1**: "정확히 무엇을 원하는가?" (PP 후보 추출)
2. **Round 2**: "절대 깨뜨리면 안 되는 것은?" (PP 제약 + 범위 경계)
3. **[고밀도 전용] Uncertainty Scan** (information_density ≥ 8일 때만):
   - Round 1-2에서 추출한 draft PPs + 전체 프롬프트에 대해 Uncertainty Scan 실행
   - 3축 × 3 = 9차원 + 축 간 교차 분석:
     [기획] U-P1: 타겟 사용자 불명확, U-P2: 핵심 가치/우선순위 불명확, U-P3: 성공 측정 기준 부재
     [디자인] U-D1: 비주얼 디자인 시스템 부재, U-D2: 사용자 플로우 미정의, U-D3: 정보 계층 불명확
     [개발] U-E1: 모호한 판단 기준, U-E2: 암묵적 가정, U-E3: 기술적 결정 미확정
     [교차] 기획↔디자인, 디자인↔개발, 기획↔개발 일치성 + PP 축 편향 체크
   - Classify: HIGH (circuit break 예상) / MED (PROVISIONAL로 진행 가능) / LOW (자연 해소)
   - if HIGH == 0: MED/LOW는 Step 1-B에 uncertainty_notes로 전달
   - elif HIGH >= 1: HIGH 항목에 대해 Hypothesis-as-Options 질문 (최대 3개)
4. PP 확정: pivot-points.md 저장 + user_responses_summary 생성

**Stage 2 상세** (mpl-ambiguity-resolver):

1. **Spec Reading**: 제공된 스펙/문서를 PP와 대조하여 gap/conflict/hidden constraint 식별
2. **Ambiguity Scoring**: PP 직교 4차원(Spec Completeness 35%/Edge Case 25%/Technical Decision 25%/Acceptance Testability 15%)으로 점수화
3. **Socratic Loop**: ambiguity <= 0.2 될 때까지 가장 약한 차원을 타겟 소크라틱 질문 반복
   - Pre-Research Protocol: 기술 선택 시 비교표 먼저 제시
   - 매 응답 후 ambiguity 재측정
4. **경량 요구사항 구조화**:
   - User Stories + 자연어 AC + MoSCoW + 증거 태깅
   - 저장: `.mpl/pm/requirements-light.md`

### depth == "full"

```
Phase 1 (mpl-interviewer):
  Round 1-4 전체
  → Output: pivot-points.md + user_responses_summary

Stage 2 (mpl-ambiguity-resolver):
  Spec Reading → Ambiguity Scoring Loop → 솔루션 옵션 → JUSF
  → Output: ambiguity score + requirements-{hash}.md
```

**Phase 1 상세**:

1. **Round 1-4**: 기존 PP 인터뷰 전체
2. PP 확정: pivot-points.md 저장 + user_responses_summary 생성

**Stage 2 상세** (mpl-ambiguity-resolver):

1. **Spec Reading**: 제공된 스펙/문서를 PP와 대조하여 gap/conflict/hidden constraint 식별
2. **Ambiguity Scoring**: PP 직교 4차원으로 점수화
3. **Socratic Loop**: ambiguity <= 0.2 될 때까지 가장 약한 차원을 타겟 소크라틱 질문 반복
   - Pre-Research Protocol: 기술 선택 시 비교표 먼저 제시
   - 매 응답 후 ambiguity 재측정
4. **솔루션 옵션**: 3개 이상 옵션 + 트레이드오프 매트릭스 (Pre-Research 포함)
   - Minimal / Balanced / Comprehensive
   - 사용자 선택 → selected_option 기록
5. **JUSF 출력**: JTBD + User Stories + Gherkin AC
   - Dual-Layer: YAML frontmatter + Markdown body
   - 증거 태깅 (High/Medium/Low)
   - 멀티 관점 리뷰 (기획/디자인/개발)
   - Ambiguity Resolution Log 포함
   - 저장: `.mpl/pm/requirements-{hash}.md`

### 라우팅 로직

```
if .mpl/pivot-points.md exists -> Load PPs and proceed to Step 1-B

else:
  AskUserQuestion: "프로젝트의 핵심 제약사항(Pivot Points)을 정의할까요?"
  Options:
    1. "인터뷰 시작" -> Run two-phase interview (below)
    2. "건너뛰기"    -> Proceed without PPs (explore mode only)
    3. "기존 PP 로드" -> Read from .mpl/pivot-points.md

  // NOTE: "skip" 분기 제거됨. 인터뷰는 항상 최소 "light" 수준으로 실행.
  // 고밀도 프롬프트도 Round 1+2 인터뷰를 거친 후 Uncertainty Scan 실행.

if maturity_mode == "explore" -> PP is optional, skip if user declines

// Two-phase interview execution:
Task(subagent_type="mpl-interviewer", ...)  // Phase 1: PP Discovery
→ save pivot-points.md + user_responses_summary

Task(subagent_type="mpl-ambiguity-resolver", ...)  // Stage 2: Ambiguity Resolution + Requirements
→ save requirements-light.md or requirements-{hash}.md + ambiguity score
```

### 모델 라우팅 (F-26)

```
// Phase 1 (mpl-interviewer):
if interview_depth == "light" AND information_density >= 8:
    model = "opus"              # Round 1-2 + Uncertainty Scan (불확실성 판별에 추론 깊이 필요)
elif interview_depth == "light":
    model = "sonnet"            # PP Round 1-2
elif interview_depth == "full":
    model = "opus"              # PP 전체 4 Round

// Stage 2 (mpl-ambiguity-resolver):
if interview_depth == "light":
    model = "sonnet"            # Ambiguity Resolution Loop + 경량 요구사항 구조화
elif interview_depth == "full":
    model = "opus"              # Ambiguity Resolution Loop + 솔루션 옵션 + JUSF
```

PP States: **CONFIRMED** (hard constraint, auto-reject on conflict) / **PROVISIONAL** (soft, HITL on conflict)

### Step 1 산출물 -> 다운스트림 연결 [F-26]

| 산출물 | 소비자 | 사용 방식 |
|--------|--------|----------|
| pivot-points.md | Step 1-B, Step 3 | PP 준수 검증 기준 |
| requirements.md (full) | Step 3 Decomposer | 실행 순서 힌트 + US->Phase 매핑 |
| requirements-light.md (light) | Step 3 Decomposer | 경량 범위 참조 |
| acceptance_criteria.gherkin | Step 3-B, Step 4 | Test Agent 자동 테스트 생성 |
| out_of_scope | Step 1-B | "Must NOT Do" 보강 |
| recommended_execution_order | Step 3 | Phase 순서 시드 |
| moscow + sequence_score | Step 3 Decomposer | Must 우선 분해, sequence_score로 정렬 |
| job_definition | Step 2.5 Phase 0 Enhanced | API Contract/Type Policy의 사용자 맥락 |
| risks + dependencies | Step 1-B | 리스크 등급 입력 |

---

## Step 1-B: Pre-Execution Analysis (Gap + Tradeoff)

After PPs are confirmed, run unified pre-execution analysis to identify gaps AND assess risks in a single agent call.
This replaces the previous separate gap-analyzer (haiku) and tradeoff-analyzer (sonnet) calls.

```
Task(subagent_type="mpl-pre-execution-analyzer", model="sonnet",
     prompt="""
     ## Input
     ### User Request
     {user_request}
     ### Pivot Points
     {pivot_points from .mpl/pivot-points.md}
     ### Codebase Analysis
     {codebase_analysis from .mpl/mpl/codebase-analysis.json}
     <!-- Note: codebase-analysis.json may not exist at this point (produced in Step 2). If absent, Pre-Execution Analyzer proceeds with pivot-points and project structure only. This analysis is refined after Step 2 completes. -->

     Analyze gaps, pitfalls, and constraints (Part 1).
     Then assess risk levels and recommend execution order (Part 2).
     """)
```

### After Receiving Output
1. Validate 7 required sections via validate-output hook (4 gap + 3 tradeoff)
2. If "Recommended Questions" (section 4) has items with HIGH impact:
   - Present top 3 questions to user via AskUserQuestion
   - Incorporate answers into PP refinement if needed
3. Save full output to `.mpl/mpl/pre-execution-analysis.md`
4. Extract Part 1 (sections 1-4) as gap analysis context for decomposer
5. Extract Part 2 "Recommended Execution Order" (section 7) for decomposer in Step 3
6. Report: `[MPL] Pre-Execution Analysis: {MR_count} missing requirements, {AP_count} pitfalls, {MND_count} constraints. Aggregate risk: {level}. {irreversible_count} irreversible changes.`

---

## Step 1-D: PP Confirmation

Present a unified summary of PPs + Pre-Execution Analysis for engineer confirmation.

```
AskUserQuestion with 4 options:
1. "Approve All" -> proceed to Step 2
2. "Modify PPs" -> edit specific PPs, then re-run 1-B with updated PPs, return to 1-D
3. "Add New PP" -> add PP, then re-run 1-B, return to 1-D
4. "Re-interview" -> return to Step 1
```

This is a confirmation gate. Do not proceed to decomposition without explicit approval.
Save confirmation timestamp to `.mpl/mpl/state.json` as `pp_confirmed_at`.

---

## Step 1-E: Interview Snapshot 저장 (Compaction 방어) [F-36]

Step 1 완료 후, 인터뷰 결과를 파일로 백업한다. 이후 Step 2/2.5에서 compaction이 발생해도
인터뷰에서 수집한 핵심 정보가 파일로 보존된다.

```
Write(".mpl/mpl/interview-snapshot.md"):
  # Interview Snapshot
  Generated: {ISO timestamp}
  Interview Depth: {interview_depth}
  Information Density: {information_density}

  ## Pivot Points Summary
  {pivot-points.md 핵심 요약 — CONFIRMED/PROVISIONAL 목록}

  ## User Request (Original)
  {user_request 원문}

  ## Key Decisions from Interview
  {인터뷰에서 확정된 핵심 결정사항 3-5개}

  ## Requirements (if generated)
  {requirements-light.md 또는 requirements-{hash}.md 경로 참조}

  ## Deferred Uncertainties
  {있으면 목록, 없으면 "없음"}

  ## Pre-Execution Analysis Summary
  {pre-execution-analysis.md 핵심 요약 — 리스크, 갭, 권장 실행 순서}
```

> **목적**: Step 2/2.5가 서브에이전트로 실행되므로 오케스트레이터 컨텍스트 부담이 줄었지만,
> 장시간 인터뷰나 복잡한 PP 논의 후 compaction이 발생할 수 있다.
> 이 스냅샷이 있으면 compaction 후에도 `Read(".mpl/mpl/interview-snapshot.md")`로 복원 가능.

---

## Step 2: Codebase Analysis (서브에이전트 위임) [F-36]

> **v3.3 변경**: 오케스트레이터가 직접 6개 모듈을 분석하던 방식에서
> `mpl-codebase-analyzer` 서브에이전트에 위임하는 방식으로 변경.
> 오케스트레이터 컨텍스트에서 ~5-10K 토큰을 절감하여 Plan 단계 compaction을 방지한다.

```
Task(subagent_type="mpl-codebase-analyzer", model="sonnet",
     prompt="""
     Perform full 6-module codebase analysis for MPL Phase 0.

     ## Configuration
     - Output path: .mpl/mpl/codebase-analysis.json
     - Tool mode: {tool_mode}
     - Project root: {cwd}

     ## Modules to Analyze
     1. Structure Analysis (directories, entry points, file stats)
     2. Dependency Graph (imports, external deps, module clusters)
     3. Interface Extraction (types, functions, endpoints)
     4. Centrality Analysis (high-impact vs isolated files)
     5. Test Infrastructure (framework, test files, run commands)
     6. Configuration (env vars, config files, scripts, key deps)

     Save the full JSON to .mpl/mpl/codebase-analysis.json.
     Return only a concise summary (~500 tokens).
     """)
```

### After Receiving Output

1. 서브에이전트의 요약을 확인 (전체 JSON은 파일에 저장됨)
2. Report: `[MPL] Codebase Analysis: {files} files, {modules} modules, {deps} deps. Tool mode: {tool_mode}.`
3. Proceed to Step 2.5

> **폴백**: mpl-codebase-analyzer 에이전트가 실패하면, 오케스트레이터가 직접 분석한다 (기존 동작).
> 이 경우 6개 모듈의 도구 호출이 오케스트레이터 컨텍스트에 누적되므로 compaction 리스크 증가.

### 6-Module 상세 명세 (에이전트 참조용)

에이전트 정의(`agents/mpl-codebase-analyzer.md`)에 전체 명세가 포함되어 있다.
요약:

| Module | 도구 | 산출물 |
|--------|------|--------|
| 1. Structure | Glob | directories, entry_points, file_stats |
| 2. Dependencies | ast_grep / Grep | modules, external_deps, module_clusters |
| 3. Interfaces | lsp_document_symbols / Grep | types, functions, endpoints |
| 4. Centrality | (Module 2에서 파생) | high_impact, isolated |
| 5. Tests | Glob + Read | framework, run_command, test_files |
| 6. Config | Read | env_vars, config_files, scripts |

---

## Step 2.5: Phase 0 Enhanced (서브에이전트 위임) [F-36]

> **v3.3 변경**: 오케스트레이터가 직접 복잡도 측정 + 4단계 분석을 수행하던 방식에서
> `mpl-phase0-analyzer` 서브에이전트에 위임하는 방식으로 변경.
> 오케스트레이터 컨텍스트에서 ~8-25K 토큰을 절감하여 Plan 단계 compaction을 방지한다.

Phase 0 Enhanced는 Step 2의 Codebase Analysis 결과를 기반으로 프로젝트 복잡도를 측정하고, 복잡도에 따라 사전 명세를 생성한다. 이 명세는 후속 Phase(Decomposition, Execution)의 정확도를 높이고 디버깅 Phase를 불필요하게 만든다.

> **원칙**: "예방이 치료보다 낫다" — Phase 0에 투자하는 토큰이 Phase 5의 디버깅 비용을 완전히 제거한다.

### 서브에이전트 위임

```
loaded_memory = load_phase0_memory(user_request)  // F-25 4-Tier Memory

Task(subagent_type="mpl-phase0-analyzer", model="sonnet",
     prompt="""
     Perform Phase 0 Enhanced analysis for MPL.

     ## Input
     - Codebase analysis: .mpl/mpl/codebase-analysis.json
     - Output directory: .mpl/mpl/phase0/
     - Cache directory: .mpl/cache/phase0/
     - Tool mode: {tool_mode}

     ## Context
     ### Pivot Points
     {pivot_points from .mpl/pivot-points.md}

     ### Memory (4-Tier)
     {loaded_memory}

     ## Task
     1. Check cache (full hit → skip, partial → rerun affected only)
     2. Detect complexity grade (Simple/Medium/Complex)
     3. Run analysis steps per grade
     4. Validate artifacts
     5. Save cache
     6. Return concise summary (~300 tokens)

     Save all artifacts to .mpl/mpl/phase0/.
     Return only the summary. Do NOT return full artifact content.
     """)
```

### After Receiving Output

1. 서브에이전트의 요약을 확인 (artifact 파일은 이미 저장됨)
2. Report: `[MPL] Phase 0 Enhanced complete. Grade: {grade}. Artifacts: {count}/4. Cache: {HIT|MISS|PARTIAL}.`
3. Proceed to Step 3 (Phase Decomposition)

> **폴백**: mpl-phase0-analyzer 에이전트가 실패하면, 오케스트레이터가 직접 분석한다 (아래 상세 명세 참조).
> 이 경우 도구 호출이 오케스트레이터 컨텍스트에 누적되므로 compaction 리스크 증가.

---

### Phase 0 Enhanced 상세 명세 (에이전트 참조용 / 폴백용)

아래 명세는 `agents/mpl-phase0-analyzer.md`에 내장되어 있으며,
에이전트 실패 시 오케스트레이터가 직접 수행하는 폴백 프로토콜이기도 하다.

### 2.5.0: Cache Check (Phase 0 캐싱, 확장: F-05 부분 무효화)

Phase 0 실행 전에 캐시를 확인한다. 캐시 히트 시 Phase 0 전체를 스킵하여 8~25K 토큰을 절감한다.

#### 기존 동작 (전체 무효화)

```
cache_dir = ".mpl/cache/phase0/"
cache_key = generate_cache_key(codebase_analysis)

if cache_dir exists AND cache_key matches:
  cached = Read(cache_dir + "manifest.json")
  if cached.cache_key == cache_key:
    → Load all cached artifacts to .mpl/mpl/phase0/
    → Report: "[MPL] Phase 0 cache HIT. Skipping analysis. Saved ~{budget}K tokens."
    → Skip to Step 3 (Phase Decomposition)
  else:
    → Cache stale — 부분 무효화 시도 (아래 확장 참조)
else:
  → No cache, proceed with Phase 0
```

#### 확장: git diff 기반 부분 무효화 (F-05)

캐시 키가 불일치하더라도, 변경 범위가 제한적이면 **변경 모듈만 재분석**한다.

```pseudocode
function check_cache_with_partial(cwd):
  cache_result = checkCache(cwd)

  if cache_result.hit:
    return { action: "skip", artifacts: cache_result.manifest.artifacts }

  if not cache_result.manifest:
    return { action: "full_rerun" }  # 캐시 없음 — 전체 실행

  # 캐시 존재하지만 키 불일치 — 부분 무효화 시도
  diff_result = analyze_diff(cwd, cache_result.manifest)

  if diff_result.scope == "none":
    return { action: "skip" }  # diff가 캐시 범위 밖 (문서 변경 등)

  if diff_result.scope == "partial":
    return {
      action: "partial_rerun",
      reuse_artifacts: diff_result.unaffected_artifacts,
      rerun_steps: diff_result.affected_steps
    }

  return { action: "full_rerun" }  # 전면 변경
```

#### diff 범위 분석

```pseudocode
function analyze_diff(cwd, manifest):
  changed_files = git_diff_names(cwd, since=manifest.commit_hash or manifest.timestamp)

  # 변경 파일을 Phase 0 단계별로 분류
  affected = {
    api_contracts: false,   # Step 1
    examples: false,        # Step 2
    type_policy: false,     # Step 3
    error_spec: false       # Step 4
  }

  for file in changed_files:
    if is_public_api(file):       # 함수 시그니처 변경
      affected.api_contracts = true
    if is_test_file(file):        # 테스트 패턴 변경
      affected.examples = true
    if is_type_definition(file):  # 타입 정의 변경
      affected.type_policy = true
    if is_error_handler(file):    # 에러 처리 변경
      affected.error_spec = true

  affected_count = count_true(affected)

  if affected_count == 0:
    return { scope: "none" }
  elif affected_count <= 2:
    return {
      scope: "partial",
      affected_steps: [step for step, flag in affected if flag],
      unaffected_artifacts: [artifact for step, flag in affected if not flag]
    }
  else:
    return { scope: "full" }  # 3+ 단계 영향 → 전체 재실행이 효율적
```

#### 부분 재실행 프로토콜

partial_rerun 시:
1. 캐시된 unaffected_artifacts를 `.mpl/mpl/phase0/`에 복사
2. affected_steps만 Phase 0 Enhanced에서 재실행
3. 재실행 결과를 기존 캐시에 병합
4. 새 cache_key로 manifest 갱신

예시:
```
캐시 존재 + test 파일만 변경 →
  affected: { examples: true } →
  partial_rerun: Step 2만 재실행 →
  Step 1(api_contracts), Step 3(type_policy), Step 4(error_spec)는 캐시 재사용 →
  토큰 절감: ~60-70% (4단계 중 1단계만 실행)
```

#### 파일 분류 규칙

```
is_public_api(file):
  - src/**/*.{ts,js,py,go,rs} (test 제외)
  - 함수/클래스 export 포함 파일

is_test_file(file):
  - **/*.test.{ts,js}
  - **/*.spec.{ts,js}
  - **/test_*.py
  - **/*_test.{go,rs}

is_type_definition(file):
  - **/*.d.ts
  - **/types.{ts,py}
  - **/interfaces.{ts}
  - **/models.{py}

is_error_handler(file):
  - **/error*.{ts,js,py}
  - **/exception*.{py}
  - 파일 내 "throw", "raise", "Error" 패턴 포함
```

#### Cache Key Generation

```
generate_cache_key(codebase_analysis):
  inputs = {
    test_files_hash:  hash(content of all test files),
    structure_hash:   hash(codebase_analysis.directories),
    deps_hash:        hash(codebase_analysis.external_deps),
    source_files_hash: hash(content of source files touching public API)
  }
  return sha256(JSON.stringify(inputs))
```

#### Cache Invalidation

| 변경 사항 | 캐시 동작 |
|----------|----------|
| 테스트 파일 내용 변경 | 부분 무효화 시도 (examples 단계) |
| 소스 파일 공개 API 변경 | 부분 무효화 시도 (api_contracts 단계) |
| 타입 정의 파일 변경 | 부분 무효화 시도 (type_policy 단계) |
| 에러 처리 파일 변경 | 부분 무효화 시도 (error_spec 단계) |
| 3+ 단계 동시 영향 | 전체 캐시 무효화 (부분 재실행 비효율) |
| 의존성 버전 변경 | 전체 캐시 무효화 |
| 디렉토리 구조 변경 | 전체 캐시 무효화 |
| `--no-cache` 플래그 | 강제 캐시 무시 |
| git diff 실패 | 전체 캐시 무효화 (안전 폴백) |

### 2.5.1: Complexity Detection

Step 2에서 생성한 `codebase-analysis.json`을 분석하여 복잡도 점수를 산출한다.
모든 입력은 이미 codebase-analysis.json에 있으므로 추가 도구 호출 불필요:

```
complexity_score = (modules × 10) + (external_deps × 5) + (test_files × 3)
```

| Score | Grade | Phase 0 Steps | Token Budget |
|-------|-------|---------------|-------------|
| 0~29 | Simple | Step 4 only (Error Spec) | ~8K |
| 30~79 | Medium | Step 2 + Step 4 (Example + Error) | ~12K |
| 80+ | Complex | Step 1 + Step 2 + Step 3 + Step 4 (Full Suite) | ~20K |

Orchestrator가 직접 점수를 계산하고 등급을 판정한다:

```
modules = count of directories containing source files (from codebase_analysis.directories)
external_deps = codebase_analysis.external_deps.length
test_files = codebase_analysis.test_infrastructure.test_files.length
```

> v3.0에서 v3.1 변경: `async_functions × 8` 제거 (별도 ast_grep_search 호출 필요), Enterprise 등급을 Complex로 통합 (3등급 체계로 단순화). test_files 가중치 2→3으로 상향.

Save to `.mpl/mpl/phase0/complexity-report.json`:
```json
{
  "score": 89,
  "grade": "Complex",
  "breakdown": {
    "modules": 6, "external_deps": 4, "test_files": 3
  },
  "selected_steps": [1, 2, 3, 4],
  "token_budget": 20000
}
```

Announce: `[MPL] Complexity: {score} ({grade}). Phase 0 steps: {step_list}`

### 2.5.2: Step 1 — API Contract Extraction (Complex+)

**적용 조건**: Complex (80+) 이상에서만 실행

테스트 파일과 소스 코드를 분석하여 함수 시그니처, 파라미터 순서, 예외 타입을 추출한다.

**실행 방법**: Orchestrator가 직접 도구를 사용하여 분석:

```
1. 함수/메서드 정의 추출
   ast_grep_search(pattern="def $NAME($$$ARGS)", language="python")
   ast_grep_search(pattern="function $NAME($$$ARGS)", language="typescript")
   lsp_document_symbols(file) for each key source file

2. 테스트에서 호출 패턴 추출
   ast_grep_search(pattern="$OBJ.$METHOD($$$ARGS)", language="python", path="tests/")
   — 파라미터 순서와 타입 추론

3. 예외 타입 매핑
   ast_grep_search(pattern="raise $EXCEPTION($$$ARGS)", language="python")
   ast_grep_search(pattern="pytest.raises($EXCEPTION)", language="python", path="tests/")
   ast_grep_search(pattern="throw new $EXCEPTION($$$ARGS)", language="typescript")

4. 시그니처 확인
   lsp_hover(file, line, character) for ambiguous signatures
```

**산출물**: `.mpl/mpl/phase0/api-contracts.md`

```markdown
# API 계약 명세

## [모듈명]

### [함수명]
- 시그니처: `function_name(param1: Type1, param2: Type2) -> ReturnType`
- 파라미터 순서: [중요도 표시]
- 예외: [조건] → [예외 타입]("메시지 패턴")
- 반환값: [설명]
- 부수효과: [있으면 기술]
```

**실험 근거**: Exp 1에서 파라미터 순서 발견이 테스트 통과의 핵심 요인이었다.

### 2.5.3: Step 2 — Example Pattern Analysis (Medium+)

**적용 조건**: Medium (30+) 이상에서 실행

테스트 파일에서 구체적 사용 패턴, 기본값, 엣지 케이스를 추출한다.

**실행 방법**: Orchestrator가 테스트 파일 분석:

```
1. 테스트 파일 읽기 (Step 2에서 식별된 test_files)
   Read(test_file) for each test file (cap: 300 lines per file)

2. 패턴 분류 (7 categories):
   - 생성 패턴: 객체 인스턴스화 방법 (constructor args, factory methods)
   - 검증 패턴: assert/expect 호출 패턴
   - 정렬 패턴: 순서 관련 검증 (sorted, order_by)
   - 결과 패턴: 반환값 구조 (dict keys, list structure)
   - 에러 패턴: 예외 발생 조건
   - 부수효과 패턴: 상태 변경 검증
   - 통합 패턴: 모듈 간 상호작용

3. 기본값 추출
   ast_grep_search(pattern="$PARAM=$DEFAULT", language="python")
   Grep(pattern="default|DEFAULT", path="src/")

4. 엣지 케이스 식별
   Grep(pattern="edge|corner|boundary|empty|null|None|zero|negative", path="tests/")
```

**산출물**: `.mpl/mpl/phase0/examples.md`

```markdown
# 예제 패턴 분석

## 패턴 1: [패턴 이름]
### 기본 사용
[코드 예제 from tests]

### 엣지 케이스
[코드 예제 from tests]

### 기본값
| 필드 | 기본값 | 비고 |
|------|--------|------|
```

**실험 근거**: Exp 3에서 구체적 예제가 추상적 명세보다 구현 정확도를 크게 높였다. 정렬 요구사항과 컨텍스트 업데이트 비대칭성이 예제를 통해서만 발견되었다.

### 2.5.4: Step 3 — Type Policy Definition (Complex+)

**적용 조건**: Complex (80+) 이상에서 실행

모든 함수/메서드의 타입 힌트를 정의하고, 컬렉션 타입 구분 규칙을 명시한다.

**실행 방법**: Orchestrator가 소스 + 테스트에서 타입 정보 추출:

```
1. 기존 타입 힌트 수집
   ast_grep_search(pattern="def $NAME($$$ARGS) -> $RET:", language="python")
   lsp_hover(file, line, character) for inferred types

2. 테스트에서 기대 타입 추론
   isinstance/type() 호출 패턴 분석
   assert 문에서 컬렉션 타입 추론 (set vs list vs dict)
   Grep(pattern="isinstance|type\\(", path="tests/")

3. 타입 정책 수립
   - 컬렉션 타입 구분: List (순서 보장) vs Set (중복 제거) vs Dict (키-값)
   - Optional 규칙: None 가능 파라미터에 Optional[T] 사용
   - 반환 타입 표준화: 일관된 반환 타입 패턴
   - 금지 패턴: Any 남용, untyped collections, implicit None
```

**산출물**: `.mpl/mpl/phase0/type-policy.md`

```markdown
# 타입 정책

## 규칙
1. 모든 함수 파라미터에 타입 힌트 필수
2. 모든 함수에 반환 타입 필수
3. 구체적 타입 사용 (List[str], Set[int], Dict[str, Any])
4. Optional[T]로 nullable 표현
5. 금지: bare list, dict, set without type parameters

## 타입 참조표
| 필드/파라미터 | 타입 | 근거 |
|-------------|------|------|
```

**실험 근거**: Exp 4에서 `Set[str]`과 `List[str]`의 혼동이 테스트 실패의 주요 원인이었다.

### 2.5.5: Step 4 — Error Specification (All Grades)

**적용 조건**: 모든 복잡도 (필수 — 항상 실행)

표준 예외 매핑, 에러 메시지 패턴, 발생 조건을 명세한다.

**실행 방법**: Orchestrator가 테스트 + 소스에서 에러 패턴 추출:

```
1. 예외 발생 패턴 추출
   ast_grep_search(pattern="raise $EXC($$$ARGS)", language="python")
   ast_grep_search(pattern="throw new $EXC($$$ARGS)", language="typescript")

2. 테스트의 에러 검증 추출
   ast_grep_search(pattern="pytest.raises($EXC)", language="python", path="tests/")
   Grep(pattern="with pytest.raises|assertRaises|expect.*toThrow", path="tests/")

3. 에러 메시지 패턴 추출
   Grep(pattern="match=|message=|msg=", path="tests/")
   — 정규식 패턴이면 그대로 보존

4. 검증 순서 분석
   소스 코드에서 if/raise 순서 확인 — 어떤 조건이 먼저 검사되는지
```

**산출물**: `.mpl/mpl/phase0/error-spec.md`

```markdown
# 에러 처리 명세

## [모듈] 에러
- 타입: [ExceptionType]
- 조건: [발생 조건]
- 메시지: "[패턴 with {플레이스홀더}]"
- 검증 순서: [우선순위]

## 금지사항
- 커스텀 예외 클래스 생성 금지 (표준 예외만 사용)
- 에러 메시지는 테스트의 match 패턴과 정확히 일치해야 함
```

**실험 근거**: Exp 7에서 에러 명세가 "빠진 퍼즐 조각"임이 밝혀졌다. 에러 명세 추가만으로 점수가 83%에서 100%로 도약했다.

### 2.5.6: Phase 0 Output Summary

모든 적용된 Step의 결과를 `.mpl/mpl/phase0/summary.md`에 요약:

```markdown
# Phase 0 Enhanced Summary

## Complexity
- Grade: {grade} (score: {score})
- Breakdown: modules={n}, deps={n}, tests={n}, async={n}

## Applied Steps
- [x/o] Step 1: API Contract Extraction
- [x/o] Step 2: Example Pattern Analysis
- [x/o] Step 3: Type Policy Definition
- [x] Step 4: Error Specification

## Artifacts
| Artifact | Path | Status |
|----------|------|--------|
| API Contracts | `.mpl/mpl/phase0/api-contracts.md` | generated / skipped |
| Examples | `.mpl/mpl/phase0/examples.md` | generated / skipped |
| Type Policy | `.mpl/mpl/phase0/type-policy.md` | generated / skipped |
| Error Spec | `.mpl/mpl/phase0/error-spec.md` | generated |

## Key Findings
[자동 생성된 주요 발견사항]
```

Announce: `[MPL] Phase 0 Enhanced complete. Grade: {grade}. Artifacts: {count}/4 generated. Token budget: {budget}.`

### 2.5.7: Artifact Validation

Phase 0 산출물의 품질을 자동 검증한다:

```
for each generated artifact:
  validate_artifact(artifact):
    1. Structure check: 필수 섹션이 존재하는지 확인
       - api-contracts.md: "## [모듈명]" + "### [함수명]" 섹션 존재
       - examples.md: "## 패턴" 섹션 + 코드 블록 존재
       - type-policy.md: "## 규칙" + "## 타입 참조표" 섹션 존재
       - error-spec.md: "## [모듈] 에러" 섹션 존재
    2. Coverage check: 테스트에서 호출되는 함수가 계약에 포함되었는지
       - ast_grep_search로 테스트의 함수 호출 목록 추출
       - api-contracts.md의 함수 목록과 비교
       - 누락률 > 20% → 경고
    3. Consistency check: 아티팩트 간 상호 참조 일관성
       - api-contracts의 타입 ↔ type-policy의 타입 일치
       - api-contracts의 예외 ↔ error-spec의 예외 일치

  if validation fails:
    → Report: "[MPL] Phase 0 artifact validation WARNING: {details}"
    → Attempt auto-fix (re-run failed step with narrower focus)
    → Max 1 retry per artifact

Report: "[MPL] Phase 0 validation: {passed}/{total} artifacts validated."
```

### 2.5.8: Cache Save

Phase 0 실행이 완료되면 결과를 캐시에 저장한다:

```
cache_dir = ".mpl/cache/phase0/"
cache_key = generate_cache_key(codebase_analysis)
commit_hash = git_rev_parse("HEAD")  # 부분 무효화(F-05)에서 diff 기준점으로 사용

save_to_cache:
  1. Create cache_dir if not exists
  2. Copy all phase0 artifacts to cache_dir
  3. Write manifest.json:
     {
       "cache_key": cache_key,
       "commit_hash": commit_hash,
       "timestamp": ISO timestamp,
       "complexity_grade": complexity_grade,
       "artifacts": ["api-contracts.md", "examples.md", ...],
       "validation_result": { passed: N, total: M }
     }
  4. Report: "[MPL] Phase 0 artifacts cached. Key: {short_key}."
```

#### 2.5.8 확장: 부분 재실행 시 캐시 저장 (F-05)

부분 재실행(partial_rerun) 완료 후:
1. 재사용된 캐시 아티팩트 + 새로 생성된 아티팩트를 병합
2. 새 cache_key 생성 (현재 시점의 전체 해시)
3. manifest.json 갱신: partial_rerun_info 필드 추가
   ```json
   {
     "cache_key": "new_full_hash",
     "commit_hash": "current_HEAD",
     "timestamp": "2026-03-13T...",
     "complexity_grade": "Complex",
     "artifacts": ["api-contracts.md", "examples.md", "type-policy.md", "error-spec.md"],
     "validation_result": { "passed": 4, "total": 4 },
     "partial_rerun": true,
     "rerun_steps": ["examples"],
     "reused_steps": ["api_contracts", "type_policy", "error_spec"],
     "original_cache_key": "previous_hash"
   }
   ```
4. Report: `"[MPL] Partial cache save. Rerun: {rerun_steps}. Reused: {reused_steps}. New key: {short_key}."`

### 2.5.9: Token Profiling (Phase 0)

Phase 0 실행의 토큰 사용량을 기록한다:

```
phase0_profile = {
  "step": "phase0-enhanced",
  "grade": complexity_grade,
  "cache_hit": false,
  "steps_executed": [1, 3, 4],
  "artifacts_generated": 3,
  "validation_passed": 3,
  "estimated_tokens": {
    "complexity_detection": ~500,
    "step1_api_contracts": ~5000,
    "step2_examples": 0,
    "step3_type_policy": ~3000,
    "step4_error_spec": ~3000,
    "validation": ~500,
    "total": ~12000
  },
  "duration_ms": elapsed
}

Append to .mpl/mpl/profile/phases.jsonl
```

---
