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

## 3. MCP Tool 정의

### Tier 1: 즉시 구현 (v3.7)

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

### Tier 2: 후속 구현

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

기존 `mpl-budget-predictor.mjs`의 `predictBudget()` 이전.

#### 3.6 `mpl_analyze_tests`

```typescript
{
  name: "mpl_analyze_tests",
  description: "Extract API contracts from test files",
  inputSchema: {
    properties: {
      cwd: { type: "string" },
      test_path: { type: "string", description: "테스트 파일/디렉토리 경로" }
    },
    required: ["cwd", "test_path"]
  }
}
```

기존 `mpl-test-analyzer.mjs` 이전.

#### 3.7 `mpl_check_convergence`

```typescript
{
  name: "mpl_check_convergence",
  description: "Check fix loop convergence: improving, stagnating, or regressing",
  inputSchema: {
    properties: {
      cwd: { type: "string" }
    },
    required: ["cwd"]
  }
}
```

기존 `mpl-state.mjs`의 `checkConvergence()` 이전.

---

## 4. 마이그레이션 전략

### 단계적 이전 (Big Bang 금지)

```
Phase 1 (v3.7): MCP 서버 신규 생성 + mpl_score_ambiguity 구현
                기존 hooks 그대로 유지 (병행 운영)

Phase 2 (v3.8): mpl_state_read/write + mpl_triage 추가
                hooks에서 state/scope-scan 로직을 MCP 호출로 대체
                hooks는 thin wrapper로 변환 (MCP 호출 프록시)

Phase 3 (v3.9): mpl_estimate_budget + mpl_analyze_tests + mpl_check_convergence
                hooks의 lib/ 함수 대부분이 MCP로 이전 완료
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

MCP로 이전 **가능**한 hooks (Phase 2~3에서 thin wrapper로 변환):

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
