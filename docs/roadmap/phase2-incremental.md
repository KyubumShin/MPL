# Phase 2: Incremental - 점진적 구현/테스트 설계

> **구현 상태**: v3.0에서 완전 구현됨. Build-Test-Fix 마이크로 사이클이 Phase Runner의 표준 동작으로 통합되었다 (`mpl-run.md` Step 4.2). v3.0에서 추가로 Test Agent(독립 검증), 3-Gate 품질 시스템, Convergence Detection이 도입되어 원래 설계를 넘어서는 품질 보증 체계가 완성되었다.

## 목표

Exp 5(테스트 스텁)와 Exp 6(점진적 테스팅)의 핵심 인사이트를 결합하여, **모듈별 구현 → 즉시 테스트 → 실패 시 즉시 수정** 패턴을 MPL 파이프라인의 표준 동작으로 만든다.

## 핵심 원칙

### "Build-Test-Fix" 마이크로 사이클

> ✓ v3.0에서 구현됨. Phase Runner 규칙 4: "After each TODO (or parallel group), immediately test the affected module. Fix failures before moving to the next TODO."

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   TODO 구현 ──→ 모듈 테스트 ──→ 통과? ──→ 다음 TODO  │
│                                    │                │
│                                    ↓ 실패            │
│                               즉시 수정 ──┘          │
│                          (최대 2회 재시도)            │
│                                                     │
└─────────────────────────────────────────────────────┘
```

기존 MPL v1.0은 모든 모듈을 구현한 후 Phase 4에서 한꺼번에 테스트했다. 이는 오류가 누적되어 디버깅이 복잡해지는 문제가 있었다. v3.0에서는 각 TODO를 구현한 직후 해당 모듈의 테스트를 실행하며, 실패 시 Phase 0 산출물(error-spec, type-policy, api-contracts)을 참조하여 수정한다.

**v3.0 구현 세부사항**:
- TODO당 최대 재시도: **2회** (원래 설계의 3회에서 조정)
- 페이즈 종료 시: 현재 + 이전 페이즈의 **모든 테스트를 누적 실행**하여 회귀 방지
- Phase Runner 규칙 10: 실패 시 Phase 0 산출물 참조 필수

## Exp 6 기반 점진적 테스팅 설계

### 테스트 단계 정의

> ✓ v3.0에서 구현됨. 마이크로 페이즈 구조에서 각 페이즈가 독립 테스트 단위로 동작한다.

Exp 6에서 검증된 5단계 점진적 테스팅 구조를 표준화했다:

| 단계 | 대상 | 테스트 수 (예시) | 누적 검증 |
|------|------|----------------|----------|
| Stage 1 | 데이터 모델 | 11 | 11 |
| Stage 2 | 핵심 로직 (DAG 등) | 19 | 30 |
| Stage 3 | I/O (로더, 파서) | 15 | 45 |
| Stage 4 | 실행/오케스트레이션 | 14 | 59 |
| Stage 5 | 통합 + 히든 테스트 | 18 | 77 |

### 실험 근거

Exp 6 결과:
- Phase 1 (Models): 11/11 (100%) - 0.01s
- Phase 2 (DAG): 19/19 (100%) - 0.02s
- Phase 3 (Loader): 15/15 (100%) - 0.01s
- Phase 4 (Executor): 14/14 (100%) - 2.05s
- Phase 5 (Full): 77/77 (100%) - 2.10s

**핵심 발견**: 모든 단계에서 0개의 수정이 필요했다. 이는 Phase 0 강화(Exp 1~4, 7)와 점진적 테스팅의 시너지를 보여준다.

## Exp 5 기반 스텁 우선 개발 통합

### TDD 플로우

> ✓ v3.0에서 구현됨. Phase 0 산출물이 Phase Runner의 컨텍스트에 자동 주입되어 인터페이스 계약 기반 구현을 가능하게 한다.

Exp 5의 테스트 스텁 생성 접근법을 Phase 0 산출물과 결합했다:

```
Phase 0 산출물          페이즈 컨텍스트          Phase Runner 실행
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ API 계약     │───→│ 인터페이스   │───→│ TODO별 구현   │
│ 예제 패턴    │    │ 계약 기반    │    │ + 즉시 테스트  │
│ 타입 정책    │    │ 컨텍스트     │    │ + 즉시 수정   │
│ 에러 명세    │    │              │    │              │
└──────────────┘    └──────────────┘    └──────────────┘
```

## v3.0 추가: Test Agent (독립 검증)

> 이 기능은 원래 Phase 2 설계에 없었으나 v3.0에서 추가되었다.

`mpl-test-agent`(sonnet)는 Phase Runner 완료 후 **독립적으로** 테스트를 작성·실행한다. 코드 작성자(mpl-worker)와 테스트 작성자(mpl-test-agent)를 분리하여 가정 불일치, 인터페이스 계약 위반, 엣지 케이스를 포착한다.

```
Phase Runner 완료 ──→ Test Agent 실행 ──→ 결과 병합
     (mpl-worker가        (mpl-test-agent가      (pass_rate 비교,
      코드 작성)           독립 테스트 작성)       불일치 플래그)
```

- Test Agent의 pass_rate < Phase Runner의 pass_rate → 불일치 플래그 발생
- 검증 계획의 A/S-items를 기반으로 테스트 작성
- 인터페이스 계약에 기반 (구현 세부사항 아님)

## Phase Runner 변경사항

### Incremental Verification 모드 — 구현됨

> ✓ v3.0의 Phase Runner는 incremental 모드가 기본이다 (`mpl_state.verification_mode: "incremental"`).

Build-Test-Fix 마이크로 사이클이 Phase Runner의 표준 동작이다:

```
TODO 1 구현
  → 해당 모듈 테스트 실행
  → 실패 시: Phase 0 산출물 참조 후 즉시 수정 (최대 2회)
  → 통과 시: TODO 2로 진행

TODO 2 구현
  → 이전 모듈 테스트도 포함 (회귀 방지)
  → 실패 시: 즉시 수정
  → 통과 시: TODO 3으로 진행

모든 TODO 완료
  → 누적 테스트 (현재 + 이전 페이즈 전체)
  → pass_rate 기록
```

### 실패 처리 정책 — v3.0 반영

| 실패 유형 | 처리 방식 | 최대 재시도 |
|----------|----------|-----------|
| 현재 TODO 테스트 실패 | Phase 0 산출물 참조 후 즉시 수정 | 2회 (TODO당) |
| 이전 모듈 회귀 | 회귀 원인 분석 후 수정 | Phase Runner 내 3회 재시도에 포함 |
| 페이즈 전체 실패 | Phase Runner 내부 재시도 | 3회 (페이즈당) |
| 3회 재시도 실패 | circuit_break → 재분해 | 최대 2회 재분해 |

## Phase 5 진입 조건 엄격화 → 3-Gate 품질 시스템으로 발전

### 원래 설계 (v2.0)

```
Phase 4 완료
  → 통과율 >= 95%? → 완료 (Phase 5 스킵)
  → 통과율 < 95%?  → Phase 5 진입 (최소 수정만)
```

### v3.0 구현: 3-Gate 품질 시스템

Phase 5 진입 조건 엄격화 개념은 v3.0에서 **3-Gate 품질 시스템**으로 발전했다:

| Gate | 이름 | 통과 기준 | 실패 시 |
|------|------|----------|--------|
| Gate 1 | 자동 테스트 | pass_rate ≥ 95% | Fix Loop |
| Gate 2 | 코드 리뷰 (mpl-code-reviewer) | PASS 판정 | Fix Loop 또는 mpl-failed |
| Gate 3 | Agent-as-User (S-items) | 전체 통과 + PP 위반 없음 | Fix Loop |

Fix Loop에서는 **Convergence Detection**이 작동하여 수정의 실질적 진전을 모니터링한다:
- `improving`: 계속 수정
- `stagnating`: 전략 변경; 여전히 정체 시 회로 차단
- `regressing`: 즉시 회로 차단

## 복잡도 자동 감지기 — 구현 완료

> ✓ v3.0의 Step 2.5.1(Complexity Detection)에서 구현됨.

### 분석 항목

| 항목 | 가중치 | v3.0 측정 방법 |
|------|--------|---------------|
| 모듈 수 | ×10 | codebase_analysis.directories에서 소스 파일 포함 디렉토리 수 |
| 외부 의존성 | ×5 | codebase_analysis.external_deps.length |
| 테스트 파일 | ×2 | codebase_analysis.test_infrastructure.test_files.length |
| 비동기 함수 | ×8 | ast_grep_search("async function/def") 카운팅 |

### 출력

`.mpl/mpl/phase0/complexity-report.json`:
```json
{
  "score": 85,
  "grade": "Complex",
  "breakdown": {
    "modules": 6, "external_deps": 4, "test_files": 8, "async_functions": 3
  },
  "selected_steps": [1, 3, 4],
  "token_budget": 18000
}
```

## 달성 효과

### 정량적 효과

| 지표 | v1.0 | v3.0 (달성) | 개선 |
|------|------|-----------|------|
| 디버깅 사이클 | 3~5회 | TODO당 최대 2회 즉시 수정 | 즉시 수정으로 전환 |
| Phase 5 진입률 | 100% | 3-Gate 시스템으로 대체 | 구조 변경 |
| 오류 발견 시점 | Phase 4 (늦음) | 구현 직후 (빠름) | 조기 발견 |
| 컨텍스트 전환 비용 | 높음 | 낮음 (TODO 단위 집중) | 집중도 유지 |

### 정성적 효과

1. **빠른 피드백**: 구현 직후 테스트 결과를 확인하여 기억이 신선할 때 수정
2. **회귀 방지**: 누적 테스트로 이전 모듈의 정상 동작을 지속 보장
3. **독립 검증**: Test Agent가 코드 작성자와 분리되어 가정 불일치 포착 (v3.0 추가)
4. **수렴 보장**: Convergence Detection이 Fix Loop의 실질적 진전을 모니터링 (v3.0 추가)
5. **다층 품질**: 3-Gate 시스템이 자동 테스트, 코드 리뷰, 사용자 관점 검증을 결합 (v3.0 추가)
