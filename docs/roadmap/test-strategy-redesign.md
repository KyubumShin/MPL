# MPL 테스트 전략 재설계

> MPL ~70 tests vs Ouroboros 900+ tests — 12배 차이의 구조적 원인 분석과 개선 설계

## 1. 현상 분석

### 1.1 절대적 테스트량 비교 (유사 프로젝트 규모)

| 지표 | MPL (Yggdrasil) | Ouroboros |
|------|-----------------|----------|
| 생성된 테스트 | ~70개 | 900+개 |
| 테스트 파일 | ~10개 | 95개 |
| 테스트 계층 | Gate 1 (vitest) | Unit + Integration + E2E |
| AC → 테스트 변환 | 에이전트 재량 | 코드 자동 분해 |
| 테스트 축적 | Phase별 독립 | 세대별 단조 증가 |

### 1.2 구조적 원인 (Root Cause)

#### 원인 1: AC 분해 밀도 부족

**Ouroboros의 AssertionExtractor**:
```
AC: "API should return 200 for valid input and 400 for invalid input with error message"
  → SpecAssertion 1: T1_constant, pattern="status.*200", file_hint="*.py"
  → SpecAssertion 2: T1_constant, pattern="status.*400", file_hint="*.py"
  → SpecAssertion 3: T2_structural, pattern="error_message", file_hint="*.py"
  = 3개 검증 포인트 자동 생성
```

**MPL의 현재**:
```
A-item: `npx vitest run tests/api.test.ts` -- Expected: exit 0
  → mpl-test-agent에게 "이 AC를 테스트해라"
  → 에이전트 판단으로 1~2개 테스트 작성
  = 에이전트 재량에 의존, 분해 밀도가 불일정
```

#### 원인 2: 4-Tier 검증 부재

Ouroboros는 AC를 **검증 가능성에 따라 4 tier로 분류**한 뒤, 각 tier에 맞는 검증 방법을 적용:

| Tier | 대상 | 검증 방법 | 비용 |
|------|------|----------|------|
| T1 (Constant) | 설정값, 상수, 임계값 | regex로 소스 스캔 | $0 |
| T2 (Structural) | 파일/클래스/인터페이스 존재 | glob/grep | $0 |
| T3 (Behavioral) | 기능 동작 | 테스트 실행 | 테스트 비용 |
| T4 (Unverifiable) | 주관적 판단 | 건너뜀 | $0 |

MPL은 A/S/H 분류가 있지만:
- A-item: "명령어가 exit 0을 반환하는가" → T3(행동) 수준만 커버
- S-item: BDD 시나리오 → 역시 T3
- T1/T2에 해당하는 **$0 검증**이 누락

#### 원인 3: 테스트 축적 메커니즘 부재

```
Ouroboros evolve:
  Gen 1: 50 tests → Gen 2: 50 + 30 new = 80 → Gen 3: 80 + 20 = 100
  = 세대마다 regression suite가 축적

MPL phases:
  Phase 1: 15 tests → Phase 2: 12 tests → Phase 3: 18 tests
  = Phase별 독립. Phase 1 테스트가 Phase 3에서 regression으로 실행되는가? 보장 없음
```

#### 원인 4: Mechanical Verification 부재

Ouroboros의 Stage 1(Mechanical)은 테스트 실행 전에 lint/build/typecheck/coverage를 **코드로** 실행.
MPL의 3-Gate는 유사하지만:
- Gate 1: `tsc` → 타입 체크만 (lint 없음)
- Gate 2: `vitest` → 테스트 실행
- Gate 3: `build` → 빌드

**누락**: lint, coverage threshold, static analysis

---

## 2. 개선 설계

### 2.1 전체 아키텍처 변경

```
현재 MPL:
  Verification Planner → A/S/H 분류 → Test Agent (에이전트 재량으로 테스트 작성)
                                           ↓
                                       Gate 1-3

개선 MPL:
  Verification Planner → A/S/H 분류
        ↓
  [NEW] Assertion Extractor (MCP: mpl_extract_assertions)
        → AC를 T1/T2/T3/T4 SpecAssertion으로 자동 분해
        → T1/T2는 즉시 자동 검증 (mpl_verify_spec)
        ↓
  Test Agent (T3 assertion만 담당 → 에이전트 부담 감소, 테스트 밀도 증가)
        ↓
  [NEW] Regression Accumulator (Phase 간 테스트 축적)
        ↓
  [ENHANCED] Gate 1-4 (lint + typecheck + test + build + coverage)
```

### 2.2 신규 MCP 도구 (2개 추가)

#### `mpl_extract_assertions`

AC를 4-Tier SpecAssertion으로 자동 분해. Ouroboros `extractor.py` 패턴.

```typescript
{
  name: "mpl_extract_assertions",
  description: "Extract machine-verifiable assertions from acceptance criteria (4-tier classification)",
  inputSchema: {
    properties: {
      cwd: { type: "string" },
      acceptance_criteria: {
        type: "array",
        items: { type: "string" },
        description: "AC 텍스트 목록 (A/S-item descriptions)"
      },
      pivot_points: {
        type: "string",
        description: "PP 목록 (검증 기준 보강용)"
      }
    },
    required: ["cwd", "acceptance_criteria"]
  }
}
```

**반환값:**
```json
{
  "assertions": [
    {
      "ac_index": 0,
      "ac_text": "API should return 200 for valid input",
      "tier": "t3_behavioral",
      "pattern": "",
      "expected_value": "",
      "file_hint": "src/api/**/*.ts",
      "description": "Valid request returns 200 OK"
    },
    {
      "ac_index": 0,
      "ac_text": "API should return 200 for valid input",
      "tier": "t1_constant",
      "pattern": "status.*200|OK",
      "expected_value": "200",
      "file_hint": "src/api/**/*.ts",
      "description": "Status code 200 is referenced in handler"
    },
    {
      "ac_index": 1,
      "ac_text": "Error responses include error_code field",
      "tier": "t2_structural",
      "pattern": "error_code",
      "expected_value": "",
      "file_hint": "src/types/**/*.ts",
      "description": "error_code field exists in error response type"
    }
  ],
  "summary": {
    "total": 12,
    "by_tier": { "t1_constant": 4, "t2_structural": 3, "t3_behavioral": 4, "t4_unverifiable": 1 },
    "auto_verifiable": 7,
    "needs_test": 4,
    "unverifiable": 1
  }
}
```

**내부 로직:**
```typescript
// LLM 호출 (sonnet, temperature 0.0, 재현성)
// Ouroboros의 _SYSTEM_PROMPT 패턴 적용:
//   - T1: 상수/설정값 → regex 패턴 추출
//   - T2: 구조적 존재 → 파일/클래스/함수명 패턴
//   - T3: 행동 → 테스트 실행 필요
//   - T4: 주관적 → 건너뜀
// 1 AC → 0~3개 assertion (다중 검증 포인트)
```

**핵심 가치:**
- 에이전트 재량 의존 → **코드 기반 자동 분해**
- 1 AC → 평균 1.5~2.5 assertion → **AC 10개면 15~25 검증 포인트**

#### `mpl_verify_spec`

T1/T2 assertion을 코드로 자동 검증. LLM 호출 없이 $0.

```typescript
{
  name: "mpl_verify_spec",
  description: "Verify T1/T2 spec assertions against actual source files (regex scan, $0 cost)",
  inputSchema: {
    properties: {
      cwd: { type: "string" },
      assertions: {
        type: "array",
        description: "mpl_extract_assertions의 반환값 중 t1/t2 assertion 목록"
      }
    },
    required: ["cwd", "assertions"]
  }
}
```

**반환값:**
```json
{
  "results": [
    {
      "ac_index": 0,
      "tier": "t1_constant",
      "verified": true,
      "actual_value": "200",
      "file_path": "src/api/handlers/user.ts:45",
      "detail": "Found: res.status(200)"
    },
    {
      "ac_index": 1,
      "tier": "t2_structural",
      "verified": false,
      "actual_value": "",
      "file_path": "",
      "detail": "error_code field not found in any type definition"
    }
  ],
  "summary": {
    "total_checked": 7,
    "verified": 5,
    "failed": 2,
    "pass_rate": 71.4,
    "discrepancies": [
      { "ac_index": 1, "agent_said": "pass", "spec_says": "fail", "detail": "..." }
    ]
  }
}
```

**내부 로직** (Ouroboros `verifier.py` 패턴):
```typescript
// T1: regex 패턴으로 소스 파일 스캔
//   - file_hint의 glob으로 파일 목록 수집
//   - 각 파일에서 pattern 매칭
//   - expected_value와 실제 값 비교

// T2: 파일/클래스/함수 존재 확인
//   - file_hint의 glob으로 파일 존재 확인
//   - pattern으로 클래스/함수명 grep

// 보안: MAX_FILE_SIZE(50KB), MAX_PATTERN_LENGTH(200), ReDoS 방지
```

### 2.3 Verification Planner 확장

기존 A/S/H 분류에 **T1/T2/T3/T4 하위 분류** 추가.

```
현재:
  AC → A-item (명령어 기반) / S-item (BDD) / H-item (사람)

개선:
  AC → mpl_extract_assertions 호출
     → T1/T2 assertion: mpl_verify_spec으로 즉시 자동 검증
     → T3 assertion: A-item 또는 S-item으로 분류 → Test Agent가 테스트 작성
     → T4 assertion: H-item으로 분류
```

**Verification Planner 출력 변경:**

```markdown
## 2. A-items (Agent-Verifiable)
### T1 Auto-Verified (spec scan, $0)
- [A-1] Phase 1: `CACHE_TTL=300` in config.ts -- ✅ Verified: config.ts:12
- [A-2] Phase 1: `MAX_RETRIES=3` in retry.ts -- ✅ Verified: retry.ts:5

### T2 Auto-Verified (structural check, $0)
- [A-3] Phase 1: `UserSchema` type exists -- ✅ Verified: types/user.ts:8
- [A-4] Phase 2: `AuthMiddleware` class exists -- ❌ Not found

### T3 Test-Required (Test Agent handles)
- [A-5] Phase 1: `npx vitest run tests/cache.test.ts` -- Expected: exit 0
- [A-6] Phase 2: `npx vitest run tests/auth.test.ts` -- Expected: exit 0
```

### 2.4 Test Agent 역할 변경

**Before:** AC 전체를 에이전트 재량으로 테스트
**After:** T3 assertion만 집중 → **더 깊은 테스트, 더 높은 밀도**

```
현재:
  Test Agent 입력: "이 Phase의 모든 AC를 테스트해라"
  → 에이전트가 AC 해석 + 테스트 설계 + 작성 + 실행
  → 결과: ~7 tests/phase (에이전트 재량)

개선:
  Test Agent 입력:
    - T3 assertion 목록 (이미 구체적으로 분해됨)
    - T1/T2 검증 결과 (이미 자동 완료)
    - "T3 assertion 각각에 대해 테스트를 작성해라"
  → assertion당 1~2개 테스트 (분해 밀도 보장)
  → 결과: ~15-20 tests/phase (assertion 기반)
```

### 2.5 테스트 축적 정책 (Regression Accumulator)

Phase 간 테스트가 축적되는 메커니즘 도입.

```
Phase 1 완료: 15 tests → .mpl/regression-suite.json에 등록
Phase 2 시작: Phase 2 테스트 + Phase 1 regression suite 실행
Phase 2 완료: 15 + 12 = 27 tests in regression suite
Phase 3 시작: Phase 3 테스트 + 27 regression tests 실행
...
Phase N 완료: 누적 테스트가 단조 증가
```

**regression-suite.json 구조:**
```json
{
  "accumulated_tests": [
    {
      "phase": "phase-1",
      "test_files": ["tests/cache.test.ts", "tests/types.test.ts"],
      "test_command": "npx vitest run tests/cache.test.ts tests/types.test.ts",
      "added_at": "2026-03-15T10:00:00Z",
      "assertion_count": 15
    },
    {
      "phase": "phase-2",
      "test_files": ["tests/auth.test.ts"],
      "test_command": "npx vitest run tests/auth.test.ts",
      "added_at": "2026-03-15T11:00:00Z",
      "assertion_count": 12
    }
  ],
  "total_assertions": 27,
  "regression_command": "npx vitest run tests/cache.test.ts tests/types.test.ts tests/auth.test.ts"
}
```

**Gate 2 변경:**
```
현재 Gate 2: 현재 Phase 테스트만 실행
개선 Gate 2: 현재 Phase 테스트 + regression suite 전체 실행
```

### 2.6 Gate 확장 (4-Gate)

| Gate | 현재 | 개선 |
|------|------|------|
| Gate 1 | `tsc` (타입 체크) | `tsc` + lint (ruff/eslint) |
| Gate 2 | `vitest` (현재 Phase만) | `vitest` (현재 Phase + regression suite) |
| Gate 3 | `build` | `build` + **coverage threshold** (>= 70%) |
| Gate 4 | 없음 | **Spec Verification** (`mpl_verify_spec` T1/T2 자동 검증) |

Gate 4는 $0 비용 (LLM 호출 없음, regex 스캔만). 하지만 에이전트의 "구현했습니다"를 코드로 교차 검증.

---

## 3. 예상 효과

### 3.1 테스트 수량 예측

Yggdrasil과 동일 규모(AC ~30개, 7 Phase) 기준:

| 단계 | 현재 | 개선 후 |
|------|------|--------|
| AC 분해 | 30 AC → ~30 검증 포인트 | 30 AC → ~60-75 SpecAssertion |
| T1/T2 자동 검증 | 0 | ~25-30 (즉시, $0) |
| T3 테스트 생성 | ~70 (전체) | ~35-45 (T3만, 더 집중) |
| Regression 축적 | 없음 (Phase별 독립) | 7 Phase × ~10 = 70 regression tests |
| **총 검증 포인트** | **~70** | **~130-145 + 70 regression = ~200** |

3배 증가. 900에는 못 미치지만, 핵심 차이:
- Ouroboros는 900개가 프로젝트 자체의 단위 테스트 (evolve 루프로 축적)
- MPL은 "사용자 프로젝트의 테스트"를 생성하는 것이므로 동일 비교는 부적절
- **AC당 검증 밀도**(assertion/AC)가 핵심 지표: 현재 ~2.3 → 개선 후 ~5-7

### 3.2 품질 개선

| 지표 | 현재 | 개선 후 |
|------|------|--------|
| False positive (에이전트가 pass라 했는데 실제 fail) | 감지 불가 | T1/T2 교차 검증으로 감지 |
| AC 커버리지 | 에이전트 재량 | 모든 AC가 최소 1 assertion |
| Regression | Phase별 독립 | 누적 regression suite |
| 검증 비용 | 전부 LLM 비용 | T1/T2는 $0, T3만 LLM |

---

## 4. 구현 순서

```
Phase 1: MCP 도구 추가 (mpl_extract_assertions, mpl_verify_spec)
  → mcp-server-design.md의 도구 목록에 추가 (총 9개)

Phase 2: Verification Planner 에이전트 개선
  → A/S/H + T1/T2/T3/T4 하위 분류 출력
  → mpl_extract_assertions 호출 통합

Phase 3: Test Agent 역할 변경
  → T3 assertion 기반 테스트 작성으로 전환
  → 에이전트 프롬프트 경량화

Phase 4: Regression Accumulator + Gate 4
  → regression-suite.json 관리
  → Gate 2에 regression 통합
  → Gate 4 (Spec Verification) 추가

Phase 5: 에이전트 프롬프트 업데이트
  → mpl-verification-planner.md: T1/T2/T3/T4 분류 추가
  → mpl-test-agent.md: T3 assertion 기반으로 전환
  → mpl-run-execute.md: Gate 4 + regression 반영
```

---

## 5. Ouroboros와의 차이 정리

MPL은 Ouroboros의 **검증 밀도 메커니즘**을 도입하되, 전체 구조를 그대로 가져오지 않는다.

| 영역 | Ouroboros | MPL 적응 |
|------|----------|---------|
| Assertion 분해 | `extractor.py` (Python) | `mpl_extract_assertions` MCP 도구 (TypeScript) |
| Spec 검증 | `verifier.py` (regex scan) | `mpl_verify_spec` MCP 도구 (regex scan) |
| 3-Stage Evaluation | Mechanical → Semantic → Consensus | Gate 1-4 (lint/typecheck/test+regression/build+coverage/spec) |
| Evolve Loop | 세대별 테스트 축적 | Phase별 regression suite 축적 |
| Multi-Model Consensus | GPT-4o + Claude + Gemini 투표 | 미도입 (MPL은 PP 기반 검증으로 대체) |
| Devil's Advocate | 의도적 반론 에이전트 | 미도입 (향후 검토) |

MPL은 **PP 기반 coherence guarantee**가 Ouroboros의 Consensus를 대체하는 역할을 한다.
PP 위반 감지 + Side Interview가 Multi-Model Consensus 없이도 검증 품질을 보장하는 메커니즘.
