# MPL MCP Server 설계 문서

> v3.7 — 2-Stage Interview의 Ambiguity Scoring을 시작으로, hooks의 핵심 로직을 MCP 도구로 점진 이전

## 1. 설계 동기

### 현재 문제

MPL의 핵심 연산 로직이 두 곳에 분산되어 있다:

1. **Hooks** (`mpl-state.mjs`, `mpl-scope-scan.mjs` 등): 파이프라인 상태, 스코어링, 예산 예측
2. **에이전트 프롬프트** (`mpl-ambiguity-resolver.md`): Ambiguity Scoring을 프롬프트에서 지시

문제점:
- **Hooks는 수동적**: Hook 시점에만 발동. 에이전트가 "지금 상태가 뭐지?"라고 능동적으로 물을 수 없음
- **프롬프트 내 스코어링은 비일관적**: LLM이 점수를 매기면 같은 입력에 0.6~0.8 편차 발생
- **컨텍스트 낭비**: 스코어링 로직이 프롬프트에 포함되면 에이전트 컨텍스트를 소모

### Ouroboros의 해결법

```
에이전트 (질문 생성) ←→ MCP Server (상태 관리 + 스코어링)
```

- 인터뷰 상태: MCP `ouroboros_interview` 도구가 디스크에 영속
- Ambiguity Score: Python 코드로 LLM API 호출 (temperature 0.1) → JSON 파싱 → 가중 평균 계산
- 에이전트는 "질문"에만 집중, 연산은 MCP가 담당

### MPL 적용 원칙

```
에이전트 (오케스트레이션 + 질문)
  ↕ MCP Tool 호출
MPL MCP Server (상태 관리 + 스코어링 + 분석)
  ↕ 파일 I/O + LLM API
.mpl/ 디렉토리 + Anthropic API
```

---

## 2. 아키텍처

### 2.1 기술 스택

| 요소 | 선택 | 이유 |
|------|------|------|
| 언어 | TypeScript | MPL hooks와 동일 생태계, MCP SDK 공식 지원 |
| MCP SDK | `@modelcontextprotocol/sdk` | 공식, 가장 성숙 |
| LLM SDK | `@anthropic-ai/sdk` | Ambiguity Scoring용 |
| 런타임 | Node.js >= 20 | ES modules, top-level await |
| 전송 | stdio | Claude Code 표준 |

### 2.2 디렉토리 구조

```
MPL/
├── mcp/                          # MCP 서버 루트
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts              # MCP 서버 엔트리포인트
│   │   ├── tools/
│   │   │   ├── ambiguity.ts      # mpl_score_ambiguity
│   │   │   ├── state.ts          # mpl_state_read, mpl_state_write
│   │   │   ├── triage.ts         # mpl_triage
│   │   │   ├── budget.ts         # mpl_estimate_budget
│   │   │   ├── test-analyzer.ts  # mpl_analyze_tests
│   │   │   └── convergence.ts    # mpl_check_convergence
│   │   ├── lib/
│   │   │   ├── scoring.ts        # Ambiguity 점수 계산 로직
│   │   │   ├── llm.ts            # LLM API 호출 래퍼
│   │   │   └── state.ts          # 상태 파일 읽기/쓰기 (hooks/lib 이전)
│   │   └── types.ts              # 공유 타입 정의
│   └── __tests__/
│       ├── ambiguity.test.ts
│       ├── state.test.ts
│       └── triage.test.ts
├── hooks/                        # 기존 Hooks (MCP로 이전 불가능한 것만 남김)
│   ├── lib/
│   │   ├── mpl-state.mjs         # → mcp/src/lib/state.ts로 이전 (hooks는 MCP 호출)
│   │   └── ...
│   └── ...
└── ...
```

### 2.3 Claude Code 연동 설정

`.mcp.json` (MPL 플러그인 루트):
```json
{
  "mcpServers": {
    "mpl": {
      "command": "node",
      "args": ["mcp/dist/index.js"],
      "env": {
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

---

## 3. MCP Tool 정의 (9개, 전체 v3.7 구현)

### 전체 도구 요약

| # | Tool | 카테고리 | 원본 소스 | 핵심 역할 |
|---|------|---------|----------|----------|
| 1 | `mpl_score_ambiguity` | 인터뷰 | 신규 (Ouroboros 영감) | 4차원 모호성 점수 측정 + LLM 채점 |
| 2 | `mpl_state_read` | 상태 | `mpl-state.mjs` | 파이프라인 상태 조회 |
| 3 | `mpl_state_write` | 상태 | `mpl-state.mjs` | 파이프라인 상태 업데이트 (atomic) |
| 4 | `mpl_triage` | 분류 | `mpl-scope-scan.mjs` | Pipeline Score + Tier 분류 |
| 5 | `mpl_estimate_budget` | 운영 | `mpl-budget-predictor.mjs` | 컨텍스트 예산 예측 |
| 6 | `mpl_analyze_tests` | 분석 | `mpl-test-analyzer.mjs` | 테스트 파일 API 계약 추출 |
| 7 | `mpl_check_convergence` | 운영 | `mpl-state.mjs` | Fix Loop 수렴/정체/회귀 판정 |
| 8 | `mpl_extract_assertions` | 검증 | 신규 (Ouroboros extractor 영감) | AC를 4-Tier SpecAssertion으로 자동 분해 |
| 9 | `mpl_verify_spec` | 검증 | 신규 (Ouroboros verifier 영감) | T1/T2 assertion을 regex로 소스 스캔 검증 ($0) |

> 도구 8, 9의 상세 스펙은 `docs/roadmap/test-strategy-redesign.md` 섹션 2.2 참조.

### Tier 1: 인터뷰 + 상태 + 분류

#### 3.1 `mpl_score_ambiguity`

**핵심 도구**: Stage 2 메트릭 루프의 엔진.

```typescript
{
  name: "mpl_score_ambiguity",
  description: "Score ambiguity of current interview state across 4 PP-orthogonal dimensions",
  inputSchema: {
    type: "object",
    properties: {
      conversation_context: {
        type: "string",
        description: "Stage 1 PP + Stage 2 대화 전체 컨텍스트"
      },
      pivot_points: {
        type: "string",
        description: "확정된 PP 목록 (pivot-points.md 내용)"
      },
      provided_specs: {
        type: "string",
        description: "제공된 스펙/문서 내용 (있을 경우)"
      },
      cwd: {
        type: "string",
        description: "프로젝트 작업 디렉토리"
      }
    },
    required: ["conversation_context", "pivot_points", "cwd"]
  }
}
```

**반환값:**
```json
{
  "ambiguity_score": 0.41,
  "clarity_percent": 59,
  "is_ready": false,
  "threshold": 0.20,
  "dimensions": {
    "spec_completeness":     { "score": 0.70, "weight": 0.35, "justification": "..." },
    "edge_case_coverage":    { "score": 0.50, "weight": 0.25, "justification": "..." },
    "technical_decision":    { "score": 0.40, "weight": 0.25, "justification": "..." },
    "acceptance_testability": { "score": 0.80, "weight": 0.15, "justification": "..." }
  },
  "weakest_dimension": "technical_decision",
  "suggested_questions": [
    "상태 관리 라이브러리 선택이 미확정입니다. Zustand vs Jotai vs Redux Toolkit 중 선호가 있나요?"
  ]
}
```

**내부 로직** (Ouroboros `ambiguity.py` 패턴):
```typescript
// 1. LLM API 호출 (temperature 0.1, 재현성)
const response = await anthropic.messages.create({
  model: "claude-sonnet-4-20250514",  // 스코어링은 sonnet으로 충분
  temperature: 0.1,
  max_tokens: 2048,
  system: SCORING_SYSTEM_PROMPT,  // 4차원 채점 지시
  messages: [{ role: "user", content: scoringUserPrompt }]
});

// 2. JSON 파싱 + 재시도
const breakdown = parseScoreResponse(response.content);

// 3. 가중 평균 계산 (코드로, LLM 아님)
const clarity = dimensions.reduce((sum, d) => sum + d.score * d.weight, 0);
const ambiguity = Math.round((1 - clarity) * 10000) / 10000;

// 4. 약한 차원 + 질문 제안 도출
const weakest = dimensions.sort((a, b) => a.score - b.score)[0];
```

**Scoring System Prompt:**
```
You are an expert requirements analyst. Evaluate the clarity of implementation requirements.

The project has these Pivot Points (immutable constraints):
{pivot_points}

Evaluate FOUR dimensions (orthogonal to Pivot Points):

1. Spec Completeness (35%): Is there enough information to implement? Are key details specified?
2. Edge Case Coverage (25%): Are error states, boundary conditions, and exception flows defined?
3. Technical Decision (25%): Are technology choices and architecture decisions explicit?
4. Acceptance Testability (15%): Can completion be verified with automated tests?

Score each from 0.0 (completely unclear) to 1.0 (perfectly clear).
Scores above 0.8 require very specific, measurable specifications.

RESPOND ONLY WITH VALID JSON:
{
  "spec_completeness_score": 0.0,
  "spec_completeness_justification": "string",
  "edge_case_score": 0.0,
  "edge_case_justification": "string",
  "technical_decision_score": 0.0,
  "technical_decision_justification": "string",
  "testability_score": 0.0,
  "testability_justification": "string"
}
```

#### 3.2 `mpl_state_read`

```typescript
{
  name: "mpl_state_read",
  description: "Read current MPL pipeline state",
  inputSchema: {
    properties: {
      cwd: { type: "string", description: "프로젝트 작업 디렉토리" },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "특정 필드만 조회 (비어있으면 전체)"
      }
    },
    required: ["cwd"]
  }
}
```

기존 `hooks/lib/mpl-state.mjs`의 `readState()` 이전.

#### 3.3 `mpl_state_write`

```typescript
{
  name: "mpl_state_write",
  description: "Update MPL pipeline state (merge patch)",
  inputSchema: {
    properties: {
      cwd: { type: "string", description: "프로젝트 작업 디렉토리" },
      patch: { type: "object", description: "병합할 상태 필드" }
    },
    required: ["cwd", "patch"]
  }
}
```

기존 `writeState()` 이전. Atomic write (temp + rename) 유지.

#### 3.4 `mpl_triage`

```typescript
{
  name: "mpl_triage",
  description: "Quick scope scan: calculate pipeline score and classify tier",
  inputSchema: {
    properties: {
      cwd: { type: "string" },
      prompt: { type: "string", description: "사용자 프롬프트" },
      affected_files: { type: "number" },
      test_scenarios: { type: "number" },
      import_depth: { type: "number" }
    },
    required: ["cwd", "prompt"]
  }
}
```

기존 `mpl-scope-scan.mjs`의 `calculatePipelineScore()` + `classifyTier()` + `extractRiskSignal()` 통합.

### Tier 2: 파이프라인 운영 도구

#### 3.5 `mpl_estimate_budget`

```typescript
{
  name: "mpl_estimate_budget",
  description: "Predict whether remaining phases fit in context window budget",
  inputSchema: {
    properties: {
      cwd: { type: "string" }
    },
    required: ["cwd"]
  }
}
```

**반환값:**
```json
{
  "can_continue": true,
  "remaining_pct": 45.2,
  "estimated_needed_pct": 32.1,
  "remaining_phases": 3,
  "avg_tokens_per_phase": 15000,
  "recommendation": "continue",
  "breakdown": {
    "total_tokens": 200000,
    "used_tokens": 109600,
    "remaining_tokens": 90400,
    "completed_phases": 4,
    "total_phases": 7,
    "safety_margin": 1.15
  }
}
```

**내부 로직** (기존 `mpl-budget-predictor.mjs` 이전):
```typescript
// 1. .mpl/context-usage.json에서 현재 사용량 읽기
const usage = readContextUsage(cwd);

// 2. .mpl/mpl/profile/phases.jsonl에서 Phase 평균 토큰 계산
const avgPerPhase = readAvgTokensPerPhase(cwd);

// 3. .mpl/mpl/decomposition.yaml에서 총 Phase 수 파악
const totalPhases = readTotalPhases(cwd);
const completedPhases = readCompletedPhases(cwd);
const remainingPhases = totalPhases - completedPhases;

// 4. 예측: 남은 Phase × 평균 토큰 × 안전 마진(1.15)
const estimatedNeeded = remainingPhases * avgPerPhase * SAFETY_MARGIN;

// 5. 판정
if (remainingPct < 10) → "pause_now"
elif (estimatedNeeded > remainingTokens) → "pause_after_current"
else → "continue"
```

**에이전트 활용 시나리오:**
- Phase 실행 전: `mpl_estimate_budget` 호출 → `pause_after_current`이면 사용자에게 알림
- 현재는 Hook에서만 수동 체크 → MCP로 에이전트가 **능동적으로** 예산 확인 가능

#### 3.6 `mpl_analyze_tests`

```typescript
{
  name: "mpl_analyze_tests",
  description: "Extract API contracts from test files (function calls, exceptions, assertions, fixtures)",
  inputSchema: {
    properties: {
      cwd: { type: "string" },
      test_path: {
        type: "string",
        description: "테스트 파일 또는 디렉토리 경로 (상대/절대)"
      },
      pattern: {
        type: "string",
        description: "파일명 접두사 필터 (기본: 'test_')"
      }
    },
    required: ["cwd", "test_path"]
  }
}
```

**반환값:**
```json
{
  "files_analyzed": 3,
  "contracts": [
    {
      "file": "tests/test_auth.py",
      "calls": [
        { "name": "login", "argCount": 2, "kwargs": ["remember_me"], "line": 15 },
        { "name": "validate_token", "argCount": 1, "kwargs": [], "line": 28 }
      ],
      "exceptions": [
        { "exceptionType": "AuthError", "matchPattern": "invalid credentials", "line": 35 }
      ],
      "asserts": [
        { "assertion": "response.status_code == 200", "operator": "==", "line": 18 },
        { "assertion": "token in response.headers", "operator": "in", "line": 30 }
      ],
      "fixtures": [
        { "name": "auth_client", "params": ["db_session"], "line": 5 }
      ]
    }
  ],
  "summary": {
    "total_calls": 12,
    "total_exceptions": 3,
    "total_asserts": 25,
    "total_fixtures": 4,
    "unique_functions": ["login", "validate_token", "create_user", "..."]
  },
  "contracts_md": "# API Contract Specification (Auto-Generated)\n..."
}
```

**내부 로직** (기존 `mpl-test-analyzer.mjs` 이전):
```typescript
// Regex 기반 파싱 (AST 외부 의존성 없음)
// 1. 함수 호출 추출: name, argCount, kwargs
// 2. pytest.raises 블록: exceptionType, matchPattern
// 3. assert 문: assertion expression, comparison operator
// 4. pytest.fixture: name, dependencies
// 5. Markdown 계약서 자동 생성
```

**에이전트 활용 시나리오:**
- Phase 0 Enhanced에서 API Contract Extraction(Step 1) 수행 시 호출
- 현재: 에이전트가 직접 테스트 파일을 읽고 패턴 파싱 → 컨텍스트 낭비
- MCP: `mpl_analyze_tests` 한번 호출 → 구조화된 계약 + 마크다운 반환 → 에이전트는 결과만 활용

#### 3.7 `mpl_check_convergence`

```typescript
{
  name: "mpl_check_convergence",
  description: "Check fix loop convergence: improving, stagnating, or regressing with strategy suggestions",
  inputSchema: {
    properties: {
      cwd: { type: "string" }
    },
    required: ["cwd"]
  }
}
```

**반환값:**
```json
{
  "status": "stagnating",
  "delta": 0.02,
  "pass_rate_history": [0.65, 0.67, 0.68, 0.68],
  "current_pass_rate": 0.68,
  "fix_loop_count": 4,
  "max_fix_loops": 10,
  "suggestion": "Fix loop is not making progress. Try a different strategy: change implementation approach, consult Phase 0 artifacts, or escalate to redecomposition.",
  "variance": 0.0002,
  "should_escalate": false,
  "should_circuit_break": true
}
```

**내부 로직** (기존 `mpl-state.mjs`의 `checkConvergence()` 확장):
```typescript
// 1. state.json에서 convergence.pass_rate_history 읽기
// 2. 최근 N개(stagnation_window) 분석
//    - 개선 중: delta >= min_improvement (0.05)
//    - 정체: variance < 0.0025 AND delta < min_improvement
//    - 회귀: delta < regression_threshold (-0.10)
// 3. 추가 판정 (MCP에서 확장):
//    - should_escalate: 정체 + fix_loop_count > max/2 → tier 에스컬레이션 제안
//    - should_circuit_break: 회귀 OR (정체 AND fix_loop_count > max*0.7) → 중단 제안
// 4. strategy suggestion 생성
```

**에이전트 활용 시나리오:**
- Fix Loop 매 반복 시작 전: `mpl_check_convergence` 호출
- `should_circuit_break == true`이면 에이전트가 즉시 전략 변경 또는 사용자 상담
- 현재: Hook이 PostToolUse 시점에 체크 → 에이전트는 결과를 간접 수신
- MCP: 에이전트가 능동적으로 호출 → 판단에 직접 활용

---

## 4. 마이그레이션 전략

### 일괄 구현 (v3.7)

```
v3.7: MCP 서버 생성 + Tier 1 + Tier 2 전체 구현 (7개 도구)
      기존 hooks 병행 유지

      Tier 1 (인터뷰 + 상태 + 분류):
        mpl_score_ambiguity, mpl_state_read, mpl_state_write, mpl_triage

      Tier 2 (운영 + 분석):
        mpl_estimate_budget, mpl_analyze_tests, mpl_check_convergence

v3.8: hooks를 thin wrapper로 변환
      hooks/lib/의 로직을 MCP import로 대체
      hooks는 이벤트 트리거 + MCP 호출 프록시만 담당
```

### Hooks와의 공존

MCP로 이전 **불가능**한 hooks (그대로 유지):

| Hook | 이유 |
|------|------|
| `mpl-write-guard.mjs` | PreToolUse 시점에서 차단해야 함 — MCP 호출 타이밍으로는 불가 |
| `mpl-hud.mjs` | StatusLine은 Hook 전용 기능 |
| `mpl-keyword-detector.mjs` | UserPromptSubmit 시점에서 파이프라인 활성화 |
| `mpl-auto-permit.mjs` | Permission hook |
| `mpl-session-init.mjs` | Session init hook |
| `mpl-compaction-tracker.mjs` | Notification hook |

MCP로 이전 **가능**한 hooks (v3.8에서 thin wrapper로 변환):

| Hook | 현재 역할 | MCP 이전 후 |
|------|----------|-------------|
| `mpl-phase-controller.mjs` | 상태 읽기/쓰기 + 에스컬레이션 | `mpl_state_read/write` 호출 |
| `mpl-validate-output.mjs` | 에이전트 출력 검증 | 검증 로직은 MCP, Hook은 트리거만 |

### 코드 재사용

기존 `hooks/lib/` → `mcp/src/lib/`로 TypeScript 변환:

| 원본 | 변환 대상 | 변환 내용 |
|------|----------|----------|
| `mpl-state.mjs` | `mcp/src/lib/state.ts` | 타입 추가 + export |
| `mpl-scope-scan.mjs` | `mcp/src/tools/triage.ts` | 타입 추가 |
| `mpl-budget-predictor.mjs` | `mcp/src/tools/budget.ts` | 타입 추가 |
| `mpl-test-analyzer.mjs` | `mcp/src/tools/test-analyzer.ts` | 타입 추가 |

---

## 5. mpl-ambiguity-resolver 에이전트 변경

MCP 도입 후 Stage 2 에이전트의 Socratic Loop가 단순화된다:

### Before (v3.7 현재)

```
에이전트가 직접:
1. 대화 컨텍스트 분석
2. 4차원 점수 산출 (프롬프트로 지시)
3. 가중 평균 계산
4. 약한 차원 식별
5. 질문 생성
6. 사용자 응답 수집
7. 1~6 반복
```

### After (MCP 도입)

```
에이전트:
1. mpl_score_ambiguity(context, PPs) 호출
2. 결과에서 weakest_dimension + suggested_questions 확인
3. 질문 생성 (suggested_questions를 참고하되 맥락에 맞게 조정)
4. 사용자 응답 수집
5. 1~4 반복 (is_ready == true까지)
```

에이전트 프롬프트에서 스코어링 관련 섹션 대부분을 제거할 수 있다.
에이전트는 "좋은 질문을 만드는 것"에만 집중.

---

## 6. 비용 분석

### mpl_score_ambiguity 1회 호출 비용

| 항목 | 예상 |
|------|------|
| LLM 입력 | ~1,500 tokens (scoring prompt + context 요약) |
| LLM 출력 | ~300 tokens (JSON) |
| 모델 | claude-sonnet-4 (가장 비용 효율적) |
| 비용/호출 | ~$0.006 |
| 루프 평균 | 3~5회 → ~$0.02~0.03/인터뷰 |

Ouroboros와 동일하게 **Sonnet을 스코어링 전용으로 사용**, 인터뷰 에이전트는 Opus 유지.
이렇게 하면 스코어링의 일관성(temperature 0.1)과 비용 효율을 동시에 확보.

---

## 7. 테스트 전략

```
Unit Tests:
  - scoring.ts: 가중 평균 계산, JSON 파싱, 재시도 로직
  - state.ts: 읽기/쓰기, atomic write, deep merge
  - triage.ts: 파이프라인 스코어 계산, tier 분류

Integration Tests:
  - MCP 서버 시작 → tool 호출 → 응답 검증
  - LLM API mock으로 스코어링 E2E

Manual Validation:
  - 실제 인터뷰 세션에서 mpl_score_ambiguity 호출 → 점수 변화 관찰
  - 기존 hooks와 동일 결과 비교 (state, triage)
```
