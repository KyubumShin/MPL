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
| Step 0.2 Interview Depth | skip | light | full detection |
| Step 0.5 Maturity | skip | read config | read config |
| Step 1 PP Interview | skip (extract from prompt) | light (Round 1+2) | full (4 rounds) |
| Step 1-B Pre-Execution | skip | skip | full |
| Step 2 Codebase Analysis | skip (use scan) | structure + tests only | full (6 modules) |
| Step 2.5 Phase 0 Enhanced | Step 4 only (Error Spec) | Step 4 only (Error Spec) | complexity-adaptive |
| Step 3 Decomposition | skip (single fix cycle) | skip (single phase) | full decomposition |
| Gates | Gate 1 only | Gate 1 only | Gate 1 + 2 + 3 |

```
if pipeline_tier == "frugal":
  -> Skip to Step 2.5.5 (Error Spec only)
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

```
interview_depth = classify_prompt(user_request):
  information_density = count(explicit_constraints, specific_files, measurable_criteria, tradeoff_choices)

  if information_density >= 8 AND has_explicit_constraints AND has_success_criteria:
    -> "skip" (prompt is PP-grade; extract PPs directly)
  elif information_density >= 4 AND has_some_constraints:
    -> "light" (Round 1 + Round 2 only)
  else:
    -> "full" (all 4 rounds)
```

| interview_depth | Condition | Interview Behavior |
|-----------------|-----------|-------------------|
| `"full"` | Vague/broad requests (density < 4) | PP 4-round full interview (default) |
| `"light"` | Specific but incomplete (density 4-7) | What + What NOT only |
| `"skip"` | Very detailed with constraints (density 8+) | Extract PPs directly from prompt |

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

## Step 1: PP Interview

Reuse existing `mpl-pivot` skill for Pivot Points.

When `interview_depth != "skip"` (from Step 0 Triage), the orchestrator spawns `mpl-interviewer` as a Task agent to conduct the interview. The interview rounds are controlled by `interview_depth`:
- `"full"`: All 4 rounds of PP interview
- `"light"`: Round 1 (What) + Round 2 (What NOT) only

When `interview_depth == "skip"`, PPs are extracted directly from the user's prompt without spawning an interviewer agent. The orchestrator parses explicit constraints, success criteria, and tradeoff choices from the prompt and formats them as Pivot Points.

```
if .mpl/pivot-points.md exists -> Load PPs and proceed to Step 1-B

elif interview_depth == "skip":
  -> Extract PPs directly from user prompt
  -> Save to .mpl/pivot-points.md
  -> Proceed to Step 1-B

else:
  AskUserQuestion: "프로젝트의 핵심 제약사항(Pivot Points)을 정의할까요?"
  Options:
    1. "인터뷰 시작" -> Run mpl-interviewer with interview_depth setting
    2. "건너뛰기"    -> Proceed without PPs (explore mode only)
    3. "기존 PP 로드" -> Read from .mpl/pivot-points.md

if maturity_mode == "explore" -> PP is optional, skip if user declines
```

PP States: **CONFIRMED** (hard constraint, auto-reject on conflict) / **PROVISIONAL** (soft, HITL on conflict)

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
2. "Modify PPs" -> edit specific PPs, then re-run 1-B/1-C with updated PPs, return to 1-D
3. "Add New PP" -> add PP, then re-run 1-B/1-C, return to 1-D
4. "Re-interview" -> return to Step 1
```

This is a confirmation gate. Do not proceed to decomposition without explicit approval.
Save confirmation timestamp to `.mpl/mpl/state.json` as `pp_confirmed_at`.

---

## Step 2: Codebase Analysis

Done by the orchestrator using built-in tools (NOT an agent). No separate script.
Saves result to `.mpl/mpl/codebase-analysis.json`.

### Scout-Assisted Analysis (F-16)

For Phase 0 codebase analysis, the orchestrator MAY delegate initial structure
discovery to mpl-scout (haiku) to save sonnet/opus tokens:

```
scout_result = Task(subagent_type="mpl-scout", model="haiku",
     prompt="""
     Explore project structure for MPL Phase 0:
     1. Glob("**/*.{ts,tsx,js,jsx,py,go,rs,java}") — file listing
     2. Identify entry points (main.*, index.*, app.*)
     3. Sample import depth for top 5 files
     4. Check test infrastructure (frameworks, coverage)
     5. List config files
     """)
```

Scout results feed into Module 1-6 analysis, reducing orchestrator tool calls.
If mpl-scout is unavailable, orchestrator performs analysis directly (existing behavior).

### Module 1: Structure Analysis (Glob)

```
Glob("**/*.{ts,tsx,js,jsx,py,go,rs,java}")
```
Output: `directories` (path, files), `entry_points` (file, type), `file_stats` (total, by_type)

### Module 2: Dependency Graph (ast_grep_search or Grep)

```
ast_grep_search(pattern="import $$$IMPORTS from '$MODULE'", language="typescript")
```
Output: `modules` (file, imports[], imported_by[]), `external_deps` (name, used_in[]), module clusters

### Module 3: Interface Extraction (lsp_document_symbols)

```
lsp_document_symbols(file="src/main.ts")
```
Output: `types` (name, file, fields, exported), `functions` (name, file, signature), `endpoints` (if applicable)

### Module 4: Centrality Analysis (derived from Module 2)

Output: `high_impact` files (many importers, risk: high), `isolated` files (few importers, risk: low)

Decomposer guidance: high_impact files -> smaller phases, stronger verification. Isolated files -> safe for parallel.

### Module 5: Test Infrastructure (Glob + Read)

```
Glob("**/*.{test,spec}.{ts,tsx,js,jsx}")
Read("package.json") -> scripts.test, scripts.build
```
Output: `framework`, `run_command`, `test_files` (path, covers[]), `current_status` (build/tests/lint)

### Module 6: Configuration (Read)

Output: `env_vars` (name, used_in[]), `config_files` (path, purpose), `package_json` (scripts, key_deps)

**Note**: This is prompt-based guidance. The orchestrator follows these steps using available tools. For greenfield (empty) projects, most modules return empty structures -- that is expected.

---

## Step 2.5: Phase 0 Enhanced (Complexity-Adaptive Analysis)

Phase 0 Enhanced는 Step 2의 Codebase Analysis 결과를 기반으로 프로젝트 복잡도를 측정하고, 복잡도에 따라 사전 명세를 생성한다. 이 명세는 후속 Phase(Decomposition, Execution)의 정확도를 높이고 디버깅 Phase를 불필요하게 만든다.

> **원칙**: "예방이 치료보다 낫다" — Phase 0에 투자하는 토큰이 Phase 5의 디버깅 비용을 완전히 제거한다.

### 2.5.0: Cache Check (Phase 0 캐싱)

Phase 0 실행 전에 캐시를 확인한다. 캐시 히트 시 Phase 0 전체를 스킵하여 8~25K 토큰을 절감한다.

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
    → Cache stale, proceed with Phase 0
else:
  → No cache, proceed with Phase 0
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
| 테스트 파일 내용 변경 | 전체 캐시 무효화 |
| 소스 파일 공개 API 변경 | 전체 캐시 무효화 |
| 의존성 버전 변경 | 관련 계약만 무효화 |
| 디렉토리 구조 변경 | 구조 관련 캐시만 무효화 |
| `--no-cache` 플래그 | 강제 캐시 무시 |

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

save_to_cache:
  1. Create cache_dir if not exists
  2. Copy all phase0 artifacts to cache_dir
  3. Write manifest.json:
     {
       "cache_key": cache_key,
       "created_at": timestamp,
       "grade": complexity_grade,
       "artifacts": ["api-contracts.md", "examples.md", ...],
       "validation_result": { passed: N, total: M }
     }
  4. Report: "[MPL] Phase 0 artifacts cached. Key: {short_key}."
```

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
