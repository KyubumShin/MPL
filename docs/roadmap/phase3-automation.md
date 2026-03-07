# Phase 3: Automation - 자동화 및 최적화 설계

> **구현 상태**: 4개 중 2개 완료, 2개 미구현.
> - ✓ **토큰 프로파일링**: v3.0 구현 완료 (`mpl-run.md` Step 2.5.9, 4.3, 5.4)
> - ✓ **Phase 0 캐싱**: v3.0 구현 완료 (`mpl-run.md` Step 2.5.0, 2.5.8)
> - ✓ **API 자동 추출 (AST 파서)**: 구현 완료 — `hooks/lib/mpl-test-analyzer.mjs`
> - ✓ **패턴 자동 분석 (패턴 감지기)**: 구현 완료 — `hooks/lib/mpl-pattern-detector.mjs`

## 목표

Phase 1(Foundation)과 Phase 2(Incremental)에서 수립한 패턴을 자동화하여, 사람의 개입 없이 Phase 0 산출물을 생성하고 토큰 사용을 최적화한다.

---

## 자동화 영역

### 1. 테스트 파일 자동 파싱 → API 계약 자동 추출

> **미구현** — 설계 내용을 보존한다. 현재 v3.0에서는 오케스트레이터가 `ast_grep_search`, `lsp_document_symbols`, `lsp_hover` 등 빌트인 도구를 사용하여 수동으로 분석한다 (Step 2.5.2). 자동화하면 이 과정을 코드화된 `TestAnalyzer` 클래스로 대체할 수 있다.

Exp 1에서 수동으로 수행했던 바이트코드/소스 분석을 자동화한다.

#### 설계

```
테스트 파일 입력
      │
      ▼
┌──────────────┐
│ AST 파서     │──→ 함수 호출 추출
│              │──→ 파라미터 순서 추출
│              │──→ 예외 타입 추출
│              │──→ 반환값 패턴 추출
└──────────────┘
      │
      ▼
phase0-api-contracts.md (자동 생성)
```

#### 추출 대상

| 패턴 | AST 노드 | 추출 정보 |
|------|----------|----------|
| 함수 호출 | `ast.Call` | 함수명, 인자 수, 키워드 인자 |
| pytest.raises | `ast.With` + `pytest.raises` | 예외 타입, match 패턴 |
| assert 문 | `ast.Assert` | 기대값, 비교 연산자 |
| fixture 사용 | `ast.FunctionDef` (파라미터) | fixture 이름, 의존성 |
| 타입 체크 | `isinstance` 호출 | 기대 타입 |

#### 구현 계획

```python
class TestAnalyzer:
    """테스트 파일에서 API 계약을 자동 추출한다."""

    def analyze_file(self, test_file: str) -> APIContracts:
        """단일 테스트 파일 분석"""

    def analyze_directory(self, test_dir: str) -> List[APIContracts]:
        """테스트 디렉토리 전체 분석"""

    def generate_contracts_md(self, contracts: List[APIContracts]) -> str:
        """API 계약 문서 자동 생성"""
```

#### 실험 근거

Exp 1에서 수동 바이트코드 분석에 45분이 소요되었다. 자동화하면 이를 수 초로 단축할 수 있다. 특히 다음 패턴의 자동 추출이 가장 큰 가치를 제공한다:
- **파라미터 순서**: `get_ready_tasks(completed, failed, config)` - 수동 발견에 20분 소요
- **예외 타입 매핑**: `pytest.raises(ValueError, match=r'[Cc]ycl')` - 패턴 매칭 자동화
- **기본값 추출**: fixture 정의에서 기본값 자동 수집

---

### 2. 패턴 자동 분석

> **미구현** — 설계 내용을 보존한다. 현재 v3.0에서는 오케스트레이터가 Step 2.5.3에서 Grep, ast_grep_search 등으로 패턴을 수동 추출하고 분류한다. 자동화하면 코드화된 패턴 감지기로 대체할 수 있다.

Exp 3의 예제 패턴 분석을 자동화한다.

#### 설계

```
테스트 파일 입력
      │
      ▼
┌──────────────┐
│ 패턴 감지기  │──→ 생성 패턴 (객체 인스턴스화)
│              │──→ 검증 패턴 (assert 문)
│              │──→ 에러 패턴 (pytest.raises)
│              │──→ 정렬 패턴 (리스트 비교)
│              │──→ 부수효과 패턴 (상태 변경)
└──────────────┘
      │
      ▼
phase0-examples.md (자동 생성)
```

#### 7개 패턴 카테고리 자동 분류

| 카테고리 | 감지 규칙 | 우선순위 |
|---------|----------|---------|
| 생성 패턴 | 클래스 생성자 호출 | 높음 |
| 검증 패턴 | assert 문 + 비교 연산 | 높음 |
| 에러 패턴 | pytest.raises 블록 | 높음 |
| 정렬 패턴 | 리스트/집합 비교 | 중간 |
| 부수효과 패턴 | assert 후 상태 확인 | 중간 |
| 기본값 패턴 | fixture + 기본 파라미터 | 낮음 |
| 통합 패턴 | 다중 모듈 import | 낮음 |

#### 실험 근거

Exp 3에서 7개 패턴 카테고리를 수동으로 문서화했다. 자동화하면:
- 패턴 누락 방지 (수동 분석에서는 간과하기 쉬운 미묘한 패턴 포착)
- 일관된 문서 형식 보장
- 새 테스트 추가 시 자동 업데이트

---

### 3. 토큰 사용량 모니터링 및 프로파일링

> **v3.0 구현 완료**. `mpl-run.md`의 Step 2.5.9(Phase 0 프로파일링), Step 4.3(페이즈별 프로파일 기록), Step 5.4(전체 프로파일 생성)에서 구현되었다.

#### v3.0 구현 세부사항

**프로파일 저장 경로**:
- 페이즈별: `.mpl/mpl/profile/phases.jsonl` (append-only, JSONL)
- 전체 요약: `.mpl/mpl/profile/run-summary.json`

**페이즈별 프로파일 항목** (phases.jsonl):
```json
{
  "step": "phase-1",
  "name": "Phase Name",
  "pass_rate": 100,
  "micro_fixes": 0,
  "criteria_passed": "4/4",
  "estimated_tokens": { "context": 8000, "output": 2000, "total": 10000 },
  "retries": 0,
  "duration_ms": 45000
}
```

**전체 실행 프로파일** (run-summary.json):
```json
{
  "run_id": "mpl-{timestamp}",
  "complexity": { "grade": "Complex", "score": 85 },
  "cache": { "phase0_hit": false, "saved_tokens": 0 },
  "phases": [
    { "id": "phase0", "tokens": 12000, "duration_ms": 15000, "cache_hit": false },
    { "id": "phase-1", "tokens": 10000, "duration_ms": 45000, "pass_rate": 100, "micro_fixes": 0 }
  ],
  "phase5_gate": { "final_pass_rate": 100, "decision": "skip", "fix_tokens": 0 },
  "totals": { "tokens": 49500, "duration_ms": 210000, "micro_fixes": 1, "retries": 0 }
}
```

#### 프로파일 데이터 활용

프로파일 데이터를 축적하여:
1. **복잡도별 최적 토큰 예산 학습**: 과거 프로파일에서 등급별 평균 토큰 산출
2. **Phase 0 Step 조합 최적화**: 어떤 조합이 가장 효율적인지 통계
3. **비정상 실행 탐지**: 토큰 과다 사용(평균의 2x 이상), 과도한 마이크로 수정(5회+) 경고

#### 원래 설계 대비 변경사항

| 항목 | 원래 설계 | v3.0 구현 |
|------|----------|----------|
| 저장 형식 | `run-{timestamp}.json` | `phases.jsonl` (append) + `run-summary.json` |
| Phase 0 프로파일 | 미고려 | Step 2.5.9에서 별도 기록 |
| 비정상 탐지 | 제안 수준 | 구현됨 (평균 2x, 5회+ 마이크로 수정 경고) |
| Gate 결과 포함 | 미고려 | metrics.json의 `three_gate_results`에 기록 |

---

### 4. Phase 0 산출물 캐싱 및 재사용

> **v3.0 구현 완료**. `mpl-run.md`의 Step 2.5.0(Cache Check)과 Step 2.5.8(Cache Save)에서 구현되었다.

#### v3.0 구현 세부사항

**캐시 저장 경로**: `.mpl/cache/phase0/`

| 파일 | 용도 |
|------|------|
| `manifest.json` | 캐시 메타데이터 (키, 타임스탬프, 등급, 산출물 목록) |
| `api-contracts.md` | 캐시된 API 계약 명세 |
| `examples.md` | 캐시된 예제 패턴 분석 |
| `type-policy.md` | 캐시된 타입 정책 정의 |
| `error-spec.md` | 캐시된 에러 처리 명세 |
| `summary.md` | 캐시된 Phase 0 요약 |
| `complexity-report.json` | 캐시된 복잡도 보고서 |

**캐시 키 생성**:
```
cache_key = sha256(JSON.stringify({
  test_files_hash:    hash(모든 테스트 파일 내용),
  structure_hash:     hash(codebase_analysis.directories),
  deps_hash:          hash(codebase_analysis.external_deps),
  source_files_hash:  hash(공개 API에 관련된 소스 파일 내용)
}))
```

**캐시 무효화 조건**:

| 변경 사항 | 캐시 동작 |
|----------|----------|
| 테스트 파일 내용 변경 | 전체 캐시 무효화 |
| 소스 파일 공개 API 변경 | 전체 캐시 무효화 |
| 의존성 버전 변경 | 관련 계약만 무효화 |
| 디렉토리 구조 변경 | 구조 관련 캐시만 무효화 |
| `--no-cache` 플래그 | 강제 캐시 무시 |

**캐시 히트 시 효과**:
- Phase 0 전체 스킵: 8~25K 토큰 절감
- 보고: `[MPL] Phase 0 cache HIT. Skipping analysis. Saved ~{budget}K tokens.`

#### 원래 설계 대비 변경사항

| 항목 | 원래 설계 | v3.0 구현 |
|------|----------|----------|
| 캐시 키 | test_files + structure + deps | + source_files_hash (공개 API) |
| 저장 경로 | 명시되지 않음 | `.mpl/cache/phase0/` |
| manifest | 없음 | manifest.json (메타데이터) |
| CI/CD 통합 | 제안 수준 | 캐시 디렉토리 기반으로 가능 |

---

## 잔여 자동화 작업

v3.0에서 미구현된 2개 항목의 잔여 작업:

### API 자동 추출 (AST 파서)

| 항목 | 상태 | 비고 |
|------|------|------|
| `TestAnalyzer` 클래스 구현 | 미착수 | Python AST 기반 분석기 |
| 함수 호출 추출 | 미착수 | `ast.Call` 노드 분석 |
| pytest.raises 추출 | 미착수 | 예외 타입 + match 패턴 |
| assert 문 분석 | 미착수 | 기대값, 비교 연산자 |
| 통합 테스트 | 미착수 | 기존 Step 2.5.2 결과와 비교 검증 |

**현재 대안**: 오케스트레이터가 `ast_grep_search`, `lsp_document_symbols`, `lsp_hover`를 사용하여 매 실행마다 수동 분석. 기능적으로 동일하나 자동화 수준이 낮다.

### 패턴 자동 분석 (패턴 감지기)

| 항목 | 상태 | 비고 |
|------|------|------|
| 패턴 감지기 클래스 구현 | 미착수 | 7개 카테고리 자동 분류 |
| 생성/검증/에러 패턴 | 미착수 | 높은 우선순위 |
| 정렬/부수효과 패턴 | 미착수 | 중간 우선순위 |
| 기본값/통합 패턴 | 미착수 | 낮은 우선순위 |

**현재 대안**: 오케스트레이터가 Grep, ast_grep_search 등으로 패턴을 수동 추출. 에이전트 기반 분석으로 동작하나 코드화된 감지기보다 일관성이 낮다.

---

## 구현 우선순위 — 업데이트

| 우선순위 | 기능 | 예상 효과 | 난이도 | 상태 |
|---------|------|----------|--------|------|
| P0 | 에러 명세 자동 생성 | 높음 | 낮음 | ✓ Phase 1에서 구현 |
| P0 | 토큰 프로파일링 | 높음 | 낮음 | ✓ **v3.0 구현 완료** |
| P1 | API 계약 자동 추출 | 높음 | 중간 | ✗ 미구현 |
| P1 | 패턴 자동 분석 | 중간 | 중간 | ✗ 미구현 |
| P2 | 캐시 시스템 | 중간 | 높음 | ✓ **v3.0 구현 완료** |
| P2 | 복잡도 자동 감지 | 중간 | 중간 | ✓ Phase 1에서 구현 |

## 예상 효과 요약 — 달성 현황

| 지표 | 수동 (v1.0) | 자동화 (목표) | v3.0 달성 |
|------|-----------|-------------|----------|
| Phase 0 소요 시간 | 45~60분 | 5~10초 | 오케스트레이터 도구 기반 (수 분), 캐시 히트 시 ~0 |
| 패턴 누락률 | 10~20% | <2% | 에이전트 기반 분석 (수동보다 개선) |
| 토큰 가시성 | 없음 | 실시간 프로파일 | ✓ phases.jsonl + run-summary.json |
| 반복 실행 비용 | 동일 | ~0 (캐시 히트) | ✓ Phase 0 캐싱 구현 |
| 복잡도 판단 | 주관적 | 객관적 점수 | ✓ 4등급 복잡도 감지기 |
