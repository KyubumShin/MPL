# Phase 1: Foundation - Phase 0 Enhanced 설계

> **구현 상태**: v3.0에서 완전 구현됨. 복잡도 적응형 4단계 Phase 0 Enhanced가 `mpl-run.md`의 Step 2.5에 통합되었다. v3.0에서 추가로 산출물 검증 체크리스트, Phase 0 요약 생성, 캐싱(`Phase 3`)이 도입되었다.

## 목표

Phase 0를 ~5K 토큰에서 8~25K 토큰으로 확장하여, 구현 전에 필요한 모든 명세를 사전에 확보한다. 복잡도에 따라 적응적으로 토큰 예산을 조절하는 전략을 도입한다.

## 복잡도 적응형 전략

프로젝트 복잡도에 따라 Phase 0의 깊이를 자동 조절한다. v3.0에서 구현되어 Step 2.5.1(Complexity Detection)에서 자동 판정된다:

| 복잡도 등급 | 점수 범위 | Phase 0 구성 | 토큰 예산 |
|------------|----------|-------------|----------|
| Simple | 0~29 | Step 4만 (Error Spec) | ~8K |
| Medium | 30~79 | Step 2 + Step 4 | ~12K |
| Complex | 80~149 | Step 1 + Step 3 + Step 4 | ~18K |
| Enterprise | 150+ | Step 1 + Step 2 + Step 3 + Step 4 | ~25K |

### 복잡도 판정 기준

v3.0에서 다음 공식으로 구현되었다:

```
complexity_score = (모듈 수 × 10) + (외부 의존성 수 × 5) + (테스트 파일 수 × 2) + (비동기 함수 수 × 8)
```

| 점수 범위 | 등급 |
|----------|------|
| 0~29 | Simple |
| 30~79 | Medium |
| 80~149 | Complex |
| 150+ | Enterprise |

산출물: `.mpl/mpl/phase0/complexity-report.json`

## Phase 0 4단계 프로세스

### ✓ Step 1: API Contract Extraction (Exp 1 기반) - ~5K 토큰

> 구현됨: `mpl-run.md` Step 2.5.2

**적용 조건**: Complex 이상

**산출물**: `.mpl/mpl/phase0/api-contracts.md` (캐시: `.mpl/cache/phase0/api-contracts.md`)

**실행 방법** (v3.0): 오케스트레이터가 직접 도구를 사용하여 분석:
1. `ast_grep_search`로 함수/메서드 정의 추출
2. `ast_grep_search`로 테스트에서 호출 패턴 추출 (파라미터 순서, 타입 추론)
3. `ast_grep_search`로 예외 타입 매핑 (raise/pytest.raises/throw)
4. `lsp_hover`로 모호한 시그니처 확인

**산출물 템플릿**:
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

**실험 근거**: Exp 1에서 바이트코드 분석을 통해 `get_ready_tasks`의 파라미터 순서를 발견, 이것이 테스트 통과의 핵심 요인이었다.

### ✓ Step 2: Example Pattern Analysis (Exp 3 기반) - ~4K 토큰

> 구현됨: `mpl-run.md` Step 2.5.3

**적용 조건**: Medium 이상

**산출물**: `.mpl/mpl/phase0/examples.md` (캐시: `.mpl/cache/phase0/examples.md`)

**프로세스**:
1. 샘플 테스트에서 사용 패턴 추출
2. 7개 패턴 카테고리로 분류:
   - 생성 패턴 (객체 인스턴스화)
   - 검증 패턴 (유효성 검사 호출)
   - 정렬 패턴 (알파벳 순서 등)
   - 결과 패턴 (반환값 구조)
   - 에러 패턴 (예외 발생 조건)
   - 부수효과 패턴 (상태 변경)
   - 통합 패턴 (모듈 간 상호작용)
3. 기본값 표 작성
4. 엣지 케이스 목록화

**산출물 템플릿**:
```markdown
# 예제 패턴 분석

## 패턴 1: [패턴 이름]
### 기본 사용
[코드 예제]

### 엣지 케이스
[코드 예제]

### 기본값
| 필드 | 기본값 | 비고 |
|------|--------|------|
```

**실험 근거**: Exp 3에서 구체적인 사용 예제가 추상적 명세보다 구현 정확도를 크게 높였다. 특히 정렬 요구사항과 컨텍스트 업데이트 비대칭성이 예제를 통해서만 발견되었다.

### ✓ Step 3: Type Policy Definition (Exp 4 기반) - ~3K 토큰

> 구현됨: `mpl-run.md` Step 2.5.4

**적용 조건**: Complex 이상

**산출물**: `.mpl/mpl/phase0/type-policy.md` (캐시: `.mpl/cache/phase0/type-policy.md`)

**프로세스**:
1. 모든 함수/메서드 타입 힌트 정의
2. 컬렉션 타입 구분 (List vs Set vs Dict)
3. Optional 타입 규칙
4. 반환 타입 표준화
5. 금지 패턴 명시 (Any 남용, 제네릭 타입 등)

**산출물 템플릿**:
```markdown
# 타입 정책

## 규칙
1. 모든 함수 파라미터에 타입 힌트 필수
2. 모든 함수에 반환 타입 필수
3. 구체적 타입 사용 (List, Set, Dict)
4. Optional[T]로 nullable 표현

## 타입 참조표
| 필드/파라미터 | 타입 | 예시 |
|-------------|------|------|
```

**실험 근거**: Exp 4에서 `Set[str]`과 `List[str]`의 혼동이 테스트 실패의 주요 원인이었다. 명시적 타입 정책이 이를 방지했다.

### ✓ Step 4: Error Specification (Exp 7 기반) - ~3K 토큰

> 구현됨: `mpl-run.md` Step 2.5.5

**적용 조건**: 모든 복잡도 (필수)

**산출물**: `.mpl/mpl/phase0/error-spec.md` (캐시: `.mpl/cache/phase0/error-spec.md`)

**프로세스**:
1. 표준 Python 예외 매핑 (커스텀 예외 금지)
2. 에러 메시지 패턴 정의
3. 예외 발생 조건 명세
4. 검증 순서 정의

**산출물 템플릿**:
```markdown
# 에러 처리 명세

## [모듈] 에러
- 타입: [ExceptionType]
- 조건: [발생 조건]
- 메시지: "[패턴 with {플레이스홀더}]"

## 금지사항
- 커스텀 예외 클래스 생성 금지
- 표준 Python 예외만 사용
```

**실험 근거**: Exp 7에서 에러 명세가 "빠진 퍼즐 조각"임이 밝혀졌다. 에러 명세 추가만으로 점수가 83%에서 100%로 도약했다. 이는 테스트의 약 30%가 에러 핸들링을 검증하기 때문이다.

## 토큰 예산 재배분

### v1.0 vs v3.0 비교

| Phase | v1.0 토큰 | v3.0 토큰 | 변화 |
|-------|----------|----------|------|
| Phase 0 | ~5K (6%) | 8~25K (적응형) | 복잡도 기반 증가 |
| Phase 실행 | ~60K (74%) | 페이즈당 적응형 | 효율화 |
| Phase 5 | ~16K (20%) | 0K (3-Gate로 대체) | 제거 |
| **합계** | **~81K** | **복잡도 기반 가변** | **최적화** |

### 절감 원리

1. **Phase 0 투자 증가** → 명세 품질 향상
2. **Phase 실행 효율화** → 명확한 명세로 구현 시간 단축 + Build-Test-Fix로 즉시 수정
3. **Phase 5 제거** → 3-Gate 품질 시스템 + Fix Loop + Convergence Detection으로 대체

## 구현 마일스톤 — 완료

### ✓ 마일스톤 1: 복잡도 감지기
- 프로젝트 분석 함수 구현 → Step 2.5.1에서 오케스트레이터가 직접 계산
- LOC, 모듈 수, 의존성, 비동기 함수 카운팅 → codebase-analysis.json + ast_grep_search
- 복잡도 등급 자동 판정 → `.mpl/mpl/phase0/complexity-report.json` 저장

### ✓ 마일스톤 2: Step별 분석 프로세스
- 4단계 각각의 분석 프로세스 정의 → Step 2.5.2~2.5.5
- 복잡도별 조합 규칙 코드화 → 등급별 선택적 Step 적용
- 산출물 검증 체크리스트 → Step 2.5.7 (v3.0 추가)

### ✓ 마일스톤 3: Phase Runner 통합
- 기존 Phase Runner에 Enhanced Phase 0 통합 → Step 4.1 Context Assembly
- 복잡도 기반 자동 라우팅 → Phase 0 산출물 선택적 로딩
- 산출물을 후속 Phase 컨텍스트에 자동 주입 → load_phase0_artifacts()

## v3.0 추가 기능

로드맵 Phase 1에 포함되지 않았으나 v3.0에서 추가된 기능:

- **산출물 검증 체크리스트** (Step 2.5.7): 각 Step의 산출물이 필수 섹션을 포함하는지 검증
- **Phase 0 요약 생성** (Step 2.5.6): 모든 산출물을 종합하는 요약 문서 생성
- **캐싱** (Step 2.5.0, 2.5.8): Phase 0 산출물을 `.mpl/cache/phase0/`에 캐싱하여 반복 실행 시 8~25K 토큰 절감
- **토큰 프로파일링** (Step 2.5.9): Phase 0의 토큰 사용량을 프로파일에 기록

## 예상 효과 → 달성 확인

- **토큰 절감**: Phase 0 투자 대비 전체 절감 → ✓ Phase 5 제거로 확인
- **통과율 향상**: 3-Gate 시스템에서 95%+ 요구 → ✓ 구현됨
- **디버깅 제거**: Build-Test-Fix로 즉시 수정 → ✓ TODO당 최대 2회 재시도
- **일관성**: 복잡도에 관계없이 안정적 품질 → ✓ 4등급 적응형 Phase 0
