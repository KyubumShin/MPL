# MPL 로드맵: v1.0→v3.0 진화와 잔여 계획

## 비전: "Phase 0 Enhanced + Phase 5 Minimized"

MPL의 핵심 철학은 **사전 명세(Phase 0)를 강화하여 사후 수정(Phase 5)을 불필요하게 만드는 것**이다. 7개의 실험(Exp 1~8, Exp 2 제외)을 통해 Phase 0에 투자하는 토큰이 Phase 5의 디버깅/수정 비용을 완전히 제거할 수 있음을 실증적으로 검증했다.

v3.0에서 이 비전은 **구현 완료**되었으며, 추가로 로드맵에 없던 기능들(Pre-Execution Analysis, 3-Gate 품질, Convergence Detection 등)도 도입되었다.

---

## 3단계 구현 로드맵 — 달성 현황

| 단계 | 이름 | 핵심 목표 | 상태 | 상세 문서 |
|------|------|----------|------|----------|
| Phase 1 | Foundation | Phase 0 Enhanced: 복잡도 적응형 4단계 분석 | **v3.0 완전 구현** | [phase1-foundation.md](./phase1-foundation.md) |
| Phase 2 | Incremental | Build-Test-Fix 마이크로 사이클, Phase 5 진입 조건 엄격화 | **v3.0 완전 구현** | [phase2-incremental.md](./phase2-incremental.md) |
| Phase 3 | Automation | 토큰 프로파일링, Phase 0 캐싱, API 자동 추출, 패턴 자동 분석 | **부분 구현** (2/4) | [phase3-automation.md](./phase3-automation.md) |

---

## 핵심 수치 목표 — 달성 여부

| 지표 | v1.0 기준 | v2.0 목표 | v3.0 달성 | 상태 |
|------|----------|----------|----------|------|
| 총 토큰 사용량 | ~81K | 50~55K | 적응형 (복잡도별 가변) | ✓ 복잡도 기반 최적화 |
| Phase 4 통과율 | 66~83% | 95%+ | 3-Gate 시스템으로 대체 | ✓ 95% 이상 요구 |
| Phase 5 의존도 | 높음 (필수) | 최소 (조건부) | Fix Loop + Convergence Detection으로 대체 | ✓ 사실상 제거 |
| Phase 0 토큰 | ~5K | 8~25K (복잡도별) | 8~25K (4등급 적응형) | ✓ 목표 달성 |
| 디버깅 사이클 수 | 3~5회 | 0~1회 | Build-Test-Fix (TODO당 최대 2회) | ✓ 즉시 수정으로 전환 |

---

## 구현 상태 매트릭스

### Phase 1: Foundation — 완전 구현

| 기능 | 설계 | 구현 | 비고 |
|------|------|------|------|
| 복잡도 감지기 (4등급) | ✓ | ✓ | Simple/Medium/Complex/Enterprise |
| Phase 0 4단계 프로세스 | ✓ | ✓ | Step 1~4, 복잡도별 선택적 적용 |
| API Contract Extraction | ✓ | ✓ | ast_grep_search + lsp 기반 |
| Example Pattern Analysis | ✓ | ✓ | 7개 패턴 카테고리 |
| Type Policy Definition | ✓ | ✓ | 타입 힌트 규칙 |
| Error Specification | ✓ | ✓ | 모든 복잡도에서 필수 |
| 산출물 검증 체크리스트 | - | ✓ | v3.0 추가 |
| Phase 0 요약 생성 | - | ✓ | v3.0 추가 |

### Phase 2: Incremental — 완전 구현

| 기능 | 설계 | 구현 | 비고 |
|------|------|------|------|
| Build-Test-Fix 마이크로 사이클 | ✓ | ✓ | TODO당 최대 2회 재시도 |
| 누적 테스트 (회귀 방지) | ✓ | ✓ | 페이즈 종료 시 전체 실행 |
| Phase 5 진입 조건 엄격화 | ✓ | ✓ | 3-Gate 시스템으로 발전 |
| 복잡도 자동 감지기 | ✓ | ✓ | Step 2.5에 통합 |
| Test Agent (독립 검증) | - | ✓ | v3.0 추가: 코드 작성자와 분리 |
| Convergence Detection | - | ✓ | v3.0 추가: improving/stagnating/regressing |

### Phase 3: Automation — 부분 구현

| 기능 | 설계 | 구현 | 비고 |
|------|------|------|------|
| 토큰 프로파일링 | ✓ | ✓ | phases.jsonl + run-summary.json |
| Phase 0 캐싱 | ✓ | ✓ | .mpl/cache/phase0/ |
| API 자동 추출 (AST 파서) | ✓ | ✗ | 미구현: 오케스트레이터가 수동 분석 |
| 패턴 자동 분석 (패턴 감지기) | ✓ | ✗ | 미구현: 에이전트 기반 분석으로 대체 중 |

---

## v3.0에서 로드맵 외 추가된 기능

로드맵에 계획되지 않았으나 v3.0에서 새로 도입된 기능들:

| 기능 | 설명 | 관련 에이전트 |
|------|------|-------------|
| **Triage** | information_density 기반 인터뷰 깊이 자동 결정 (skip/light/full) | (오케스트레이터) |
| **Pre-Execution Analysis** | Gap/Tradeoff 통합 + Verification 2단계 사전 분석 | mpl-pre-execution-analyzer, mpl-verification-planner |
| **3-Gate 품질 시스템** | Gate 1(자동 테스트) + Gate 2(코드 리뷰) + Gate 3(Agent-as-User) | mpl-code-reviewer |
| **A/S/H 검증 분류** | Agent/Sandbox/Human 검증 항목 분류 | mpl-verification-planner |
| **Test Agent** | 코드 작성자와 독립된 테스트 에이전트 | mpl-test-agent |
| **Convergence Detection** | Fix Loop에서 improving/stagnating/regressing 감지 | (오케스트레이터) |
| **Side Interview** | CRITICAL discovery / H-items / AD 마커 시 사용자 확인 | (오케스트레이터) |
| **Resume 프로토콜** | 페이즈별 상태 영속성 기반 이어하기 | (오케스트레이터) |
| **컨텍스트 정리** | 페이즈 완료 후 오케스트레이터 메모리 정리 | (오케스트레이터) |

---

## 실험 성과 매트릭스

7개 실험 모두 77/77 = 100% 달성 (최종 테스트 스위트 기준). 이 실험 결과는 v3.0의 Phase 0 Enhanced 설계의 근거가 되었다.

| 실험 | Phase 0 기법 | 누적 점수 진행 | v3.0 반영 |
|------|-------------|---------------|----------|
| Exp 1 | API 계약 추출 | 34/89 (38%) → 77/77 (100%) | Step 1: API Contract Extraction |
| Exp 3 | 예제 패턴 분석 | 52/89 (58%) → 77/77 (100%) | Step 2: Example Pattern Analysis |
| Exp 4 | 타입 정책 정의 | 58/89 (65%) → 77/77 (100%) | Step 3: Type Policy Definition |
| Exp 5 | 테스트 스텁 생성 | 69/89 (77%) → 77/77 (100%) | Build-Test-Fix 마이크로 사이클 |
| Exp 6 | 점진적 테스팅 | 74/89 (83%) → 77/77 (100%) | Incremental Verification |
| Exp 7 | 에러 명세 | 77/77 (100%) | Step 4: Error Specification |
| Exp 8 | 하이브리드 검증 | 77/77 (100%) | 3-Gate 품질 시스템 |

> **핵심 발견**: 누적 점수 진행(38% → 58% → 65% → 77% → 83% → 100%)은 Phase 0 기법이 추가될수록 점수가 단조 증가함을 보여준다. 이 발견이 복잡도 적응형 Phase 0 설계의 근거가 되었다.

## Phase 0 Enhanced: 4단계 프로세스

실험 결과를 종합하면, 완전한 Phase 0는 4단계로 구성된다. v3.0에서 **구현 완료**되었다:

```
Step 1: API Contract Extraction (Exp 1) ─── 함수 시그니처, 파라미터 순서
Step 2: Example Pattern Analysis (Exp 3) ── 사용 패턴, 기본값, 엣지 케이스
Step 3: Type Policy Definition (Exp 4) ──── 타입 힌트, 컬렉션 타입 규칙
Step 4: Error Specification (Exp 7) ──────── 표준 예외, 메시지 패턴
```

각 단계가 독립적으로도 점수를 개선하지만, 조합했을 때 시너지 효과가 극대화된다. 복잡도에 따라 적용 Step이 자동 선택된다.

## 토큰 예산 재배분

v1.0에서 v3.0으로의 토큰 예산 변화. v3.0은 Phase 5를 Fix Loop + 3-Gate로 대체하여 구조가 변경되었다:

```
v1.0 (기존)                          v3.0 (달성)
┌──────────────────────────┐        ┌──────────────────────────┐
│ Phase 0:  ~5K  ( 6%)     │        │ Phase 0: 8~25K (적응형)   │
│ Phase 1: ~15K (19%)      │        │ Phase 실행: 페이즈당 적응형  │
│ Phase 2: ~15K (19%)      │        │ 3-Gate: ~2K              │
│ Phase 3: ~15K (19%)      │        │ Fix Loop: 0~10K (조건부)  │
│ Phase 4: ~15K (19%)      │        │ Finalize: ~2K            │
│ Phase 5: ~16K (20%)      │        │                          │
│ ─────────────────────    │        │ Phase 0 캐시 히트 시: ~0K  │
│ 합계:    ~81K            │        │ 합계: 복잡도 기반 가변     │
└──────────────────────────┘        └──────────────────────────┘
```

## 잔여 계획 및 알려진 이슈

> 최종 감사일: 2026-03-05. 전체 목록은 [design.md §9](../design.md#9-알려진-이슈-및-잔여-작업)를 참조한다.

### ~~CRITICAL (2건) — 정합성 영향~~ **해결됨** (2026-03-05)

| ID | 항목 | 상태 |
|----|------|------|
| I-01 | ~~유령 에이전트 `mpl-research-synthesizer`~~ | **해결됨** — VALIDATE_AGENTS 및 EXPECTED_SECTIONS에서 제거 |
| I-02 | ~~mpl-run.md Related Skills 중복~~ | **해결됨** — 중복 행 제거, 단일 등록으로 정리 |

### ~~HIGH (5건) — 기능 누락~~ **해결됨** (2026-03-05)

| ID | 항목 | 상태 |
|----|------|------|
| I-03 | ~~스킬 `/mpl:mpl-bugfix` 미구현~~ | **해결됨** — `skills/mpl-bugfix/SKILL.md` 생성 |
| I-04 | ~~스킬 `/mpl:mpl-small` 미구현~~ | **해결됨** — `skills/mpl-small/SKILL.md` 생성 |
| I-05 | ~~스킬 `/mpl:mpl-compound` 래퍼 없음~~ | **해결됨** — `skills/mpl-compound/SKILL.md` 생성 |
| I-06 | ~~스킬 `/mpl:mpl-gap-analysis` 래퍼 없음~~ | **해결됨** — `skills/mpl-gap-analysis/SKILL.md` 생성 |
| I-07 | ~~`mpl-validate-output` 에이전트 목록 불완전~~ | **해결됨** — `mpl-decomposer`, `mpl-git-master`, `mpl-compound` 추가 |

### ~~MEDIUM (2건) — 미구현 로드맵~~ **해결됨** (2026-03-05)

| ID | 항목 | 상태 |
|----|------|------|
| I-08 | ~~API 자동 추출 (AST 파서)~~ | **해결됨** — `hooks/lib/mpl-test-analyzer.mjs` 구현 |
| I-09 | ~~패턴 자동 분석 (패턴 감지기)~~ | **해결됨** — `hooks/lib/mpl-pattern-detector.mjs` 구현 |

### ~~LOW (4건) — 개선 사항~~ **해결됨** (2026-03-05)

| ID | 항목 | 상태 |
|----|------|------|
| I-10 | ~~Convergence 상태 명명 불일치~~ | **해결됨** — `stagnating`/`regressing`으로 통일 |
| I-11 | ~~Phase 0 캐시 검증 유틸리티 코드 없음~~ | **해결됨** — `hooks/lib/mpl-cache.mjs` 구현 |
| I-12 | ~~토큰 프로파일링 집계·시각화 도구 없음~~ | **해결됨** — `hooks/lib/mpl-profile.mjs` 구현 |
| I-13 | ~~Triage 로직이 훅으로 강제되지 않음~~ | **해결됨** — phase-controller에 triage 가드 추가 |

---

## v3.1 감사 및 개선 (2026-03-07)

### 완료된 항목

| # | 항목 | 유형 | 변경 내용 |
|---|------|------|----------|
| 1 | Critic → Decomposer 흡수 | 제거 | `mpl-critic` 삭제, risk_assessment를 decomposer 출력에 내장 |
| 2 | Phase 0 복잡도 공식 단순화 | 개선 | async_functions 제거, 4등급→3등급, 추가 도구 호출 불필요 |
| 3 | Gap + Tradeoff 통합 | 병합 | `mpl-pre-execution-analyzer`(sonnet) 생성, 2회→1회 호출 |
| 4 | Fast-Fail Path | 추가 | bugfix/small/full 3-way 파이프라인 모드 분류 |
| 5 | Phase Runner 진행 보고 | 추가 | 10개 마일스톤별 실시간 상태 보고 프로토콜 |
| 6 | Circuit break 부분 롤백 | 추가 | PASS TODO 보존, FAIL TODO 파일 롤백, recovery context 생성 |
| 7 | Worker 파일 충돌 감지 | 추가 | 병렬 TODO 간 파일 겹침 시 자동 순차 강제 |
| 9 | Decomposer 읽기 도구 허용 | 개선 | Read/Glob/Grep 허용으로 분해 정확도 향상 |
| 10 | State Summary 섹션명 통일 | 개선 | 한/영 혼용→일관된 영문 섹션명 |
| 11 | Worker PLAN.md 참조 수정 | 버그 | "PLAN.md"→"mini-plan" |
| 12 | Gate 3 재정의 | 개선 | Agent-as-User(S-items 중복)→PP Compliance + H-items resolution |

에이전트 수: 12→10 (critic 흡수 + gap/tradeoff 통합, deprecated 파일 삭제) → v3.2에서 12 (mpl-scout, mpl-compound 정식 추가)

### 미래 로드맵 (기존 — v3.1 이전)

| ID | 항목 | 우선순위 | 상태 | 설명 |
|----|------|---------|------|------|
| F-03 | 언어별 LSP 통합 강화 | MED | **완료** | Step -1 LSP Warm-up 추가 (mpl-run-phase0.md). 언어 자동 감지 → cold start 제거 → ast_grep 폴백 |
| F-04 | Standalone 독립 동작 | **HIGH** | 미구현 | OMC 의존성 제거. `/mpl:mpl-setup`으로 LSP·MCP 자동 설정, `mpl-doctor` 에이전트로 진단. OMC 도구(lsp_*, ast_grep) 없으면 Grep/Glob 폴백 |
| F-05 | Phase 0 캐시 부분 무효화 | LOW | 미구현 | 전체 무효화 대신 변경된 모듈만 재분석 |
| F-06 | 멀티 프로젝트 지원 | LOW | 미구현 | monorepo 환경에서 프로젝트별 독립 파이프라인 |

---

## v3.2 로드맵 — "문서가 메모리다 + 적응형 라우팅" (2026-03-07)

### 설계 방향

v3.2는 두 축으로 진화한다:

**축 1: 문서가 메모리다** — 세션 간·실행 간 연속성 보장

> 장기 실행 에이전트의 성공은 모델 지능이 아니라 **운영 구조**에서 비롯된다.
> — [Run long-horizon tasks with Codex](https://www.linkedin.com/posts/gb-jeong_run-long-horizon-tasks-with-codex-activity-7435825294554484736-hBEX)

**축 2: 적응형 파이프라인 라우팅** — 사용자가 복잡도를 판단하지 않는다

> MPL이 복잡해질수록 경량 작업의 진입 장벽이 높아지는 역설을 해결한다.
> Ouroboros의 PAL Router(Progressive Adaptive LLM Router)에서 영감을 받아,
> **단일 진입점 + 자동 tier 분류 + 동적 에스컬레이션**으로 3개 스킬(mpl/mpl-small/mpl-bugfix)을 통합한다.
> — [Ouroboros](https://github.com/Q00/ouroboros) 분석 (2026-03-07)

#### 4-Document 매핑 (축 1)

| 레퍼런스 문서 | 역할 | MPL 대응 | 상태 |
|-------------|------|---------|------|
| `docs/prompt.md` | 목표/비목표, 완료 기준 동결 | `pivot-points.md` | ✅ 있음 |
| `docs/plans.md` | 마일스톤별 수용기준 + 검증 명령 | `decomposition.yaml` | ✅ 있음 |
| `docs/implement.md` | plans를 SSOT로, 범위 확대 금지 | `mpl-run.md` (오케스트레이터 프로토콜) | ✅ 있음 |
| `docs/documentation.md` | 감시 기록, 세션 간 연속성 | **없음** → `RUNBOOK.md`로 신설 | ❌ 미구현 |

MPL은 1~3번 문서가 이미 강력하지만, 4번 — "감시 기록(audit log) 겸 공유 메모리"가 부족하다. 현재 State Summary가 페이즈별로 파편화되어 있고, 사람이나 다음 세션 에이전트가 "지금 어디까지 왔고, 왜 이런 결정을 했는지"를 한눈에 파악할 통합 문서가 없다.

#### Adaptive Pipeline Router (축 2) — 문제와 해결

**현재 문제**: 3개 스킬 분기가 사용자 키워드에 의존한다.

```
"mpl bugfix" → mpl-bugfix (최소 파이프라인)
"mpl small"  → mpl-small  (3-Phase 경량)
"mpl"        → mpl full   (9+ step 전체)
```

| 문제 | 상세 |
|------|------|
| 사용자 판단 의존 | "이건 small인가 full인가?"를 미리 결정해야 함 |
| Triage와 중복 | full의 Triage(Step 0)가 이미 정보 밀도를 분석하는데, small은 우회함 |
| 에스컬레이션 없음 | small로 시작 → 복잡 → circuit break → 사용자가 full을 재실행해야 함 |
| 다운그레이드 없음 | full로 시작 → 사실 간단 → 9+ 단계 전체 오버헤드 |
| 토큰 갭 | bugfix(~5-10K) ↔ small(~15-25K) ↔ full(~50-100K+) 사이에 최적 경로 없음 |

**해결**: Ouroboros PAL Router 방식을 MPL에 적응.

```
Before: 사용자가 3개 중 선택
  "mpl bugfix: 로그인 에러 수정"    → mpl-bugfix
  "mpl small: 검증 추가"           → mpl-small
  "mpl: 인증 시스템 리팩토링"       → mpl full

After: 시스템이 자동 판정 + 동적 전환
  "mpl 로그인 에러 수정"            → Triage → Frugal (≈bugfix)
  "mpl 검증 추가"                  → Triage → Standard (≈small 확장)
  "mpl 인증 시스템 리팩토링"        → Triage → Frontier (≈full)
  (실행 중 circuit break 시 자동 에스컬레이션)
```

---

### 전체 항목

#### HIGH — 핵심 아키텍처

| ID | 항목 | 상태 | 설명 |
|----|------|------|------|
| F-20 | **Adaptive Pipeline Router — 단일 진입점** | ✅ **S1 완료** | Triage(Step 0)를 확장하여 `pipeline_tier`(frugal/standard/frontier)를 자동 산정. Quick Scope Scan(Glob/Grep, ~1-2K 토큰)으로 영향 파일 수, 테스트 존재 여부, import 깊이를 측정. `pipeline_score` 공식으로 tier 결정. keyword-detector를 단일 진입점으로 통합 (mpl-bugfix/mpl-small 별도 분기 제거). 사용자 힌트(bugfix/small)는 tier 오버라이드로만 기능. **Ouroboros PAL Router 참조** |
| F-21 | **Dynamic Escalation/Downgrade** | ✅ **S1 완료** | 실행 중 tier 자동 전환. Frugal에서 circuit break → Standard로 에스컬레이션 → 여전히 실패 → Frontier로 에스컬레이션. 에스컬레이션 시 완료된 작업 보존, 실패 페이즈만 확장 파이프라인으로 재실행. 다운그레이드는 Phase 0에서 이전 routing pattern 참조로 구현 (F-22 연동) |
| F-10 | **RUNBOOK.md — 통합 실행 로그** | ✅ **S1 완료** | `docs/documentation.md` 개념을 MPL에 도입. `.mpl/mpl/RUNBOOK.md`에 Current Status, Milestone Progress, Key Decisions, Known Issues, How to Resume 섹션을 파이프라인 실행 중 자동 갱신. 사람이든 에이전트든 이 파일 하나로 현재 상태 파악 → 즉시 재개 가능 |
| F-11 | **Run-to-Run 학습 축적** | ✅ **S2 완료** | RUNBOOK의 decisions/issues가 실행 완료 시 `mpl-compound`를 통해 `.mpl/memory/learnings.md`로 증류. 다음 실행 Phase 0에서 자동 로드. 실패 패턴(타입 혼동, 에러 불일치), 성공 패턴, 프로젝트 컨벤션(discovered)을 축적. **흐름**: 실행 중 RUNBOOK 기록 → compound 증류 → 다음 Phase 0 참조 |
| F-12 | **세션 내 컨텍스트 영속** | ✅ **S2 완료** | 오케스트레이터가 페이즈 전환마다 `<remember priority>` 태그로 핵심 상태(현재 페이즈, PP 요약, 직전 실패 원인)를 마킹. RUNBOOK.md(파일 기반)와 `<remember>`(태그 기반)의 이중 안전망으로 장시간 실행 시 컨텍스트 압축에 대응 |
| F-04 | Standalone 독립 동작 | ✅ **S4 완료** | (기존) OMC 의존성 제거. Grep/Glob 폴백 |

#### MEDIUM — 실행 효율 및 UX

| ID | 항목 | 상태 | 설명 |
|----|------|------|------|
| F-22 | **Routing Pattern Learning** | ✅ **S2 완료** | `.mpl/memory/routing-patterns.jsonl`에 실행 결과(task 설명, tier, 성공 여부, 토큰 사용량)를 append. 다음 실행 Triage에서 Jaccard 유사도(≥0.8)로 이전 패턴과 비교하여 초기 tier 추천. F-11 learnings.md와 별도 파일 — learnings는 기술적 교훈, routing-patterns는 비용 최적화 데이터. **Ouroboros DowngradeManager 참조** |
| F-13 | **Background Execution** | ✅ **S3 완료** | Phase Runner 내에서 파일 충돌 없는 독립 TODO의 worker를 `run_in_background: true`로 병렬 실행. v3.1의 파일 충돌 감지와 결합하여 충돌 시 자동 순차 강제 |
| F-14 | **AskUserQuestion HITL** | ✅ **기존 구현** | `mpl-interviewer`의 PP 인터뷰 + Side Interview에서 `AskUserQuestion` 도구 사용. 클릭 가능한 선택지 제공으로 HITL 응답 속도 개선 |
| F-15 | **Worktree 격리 실행** | ✅ **S5 완료** | Pre-Execution Analysis에서 risk=HIGH인 페이즈를 `isolation: "worktree"`로 실행. 성공 시 머지, 실패 시 자동 정리. circuit break 시 부분 롤백 불필요. Frontier tier에서만 활성화 |
| F-16 | **mpl-scout 에이전트** | ✅ **S4 완료** | haiku 기반 경량 코드베이스 탐색 에이전트. Phase 0 구조 분석, Fix Loop 원인 탐색, Phase Runner 컨텍스트 보조에 활용. Read/Glob/Grep/LSP만 허용. sonnet/opus 토큰 절감. Claude Code의 Guide subagent 패턴 — 도구 추가 없이 기능 확장. **"Seeing like an Agent" Progressive Disclosure 참조** |
| F-17 | **lsp_diagnostics_directory 통합** | ✅ **S4 완료** | Gate 1 자동 테스트 전에 프로젝트 전체 타입 체크. tool_mode=full일 때 활성, standalone이면 `tsc --noEmit` / `python -m py_compile` 폴백 |
| F-23 | **Phase Runner Task-based TODO 관리** | ✅ **S3 완료** | Phase Runner가 mini-plan.md 체크박스 대신 Task tool로 TODO를 관리. Worker 간 의존성 추적, 병렬 실행 상태 자동 동기화. 현재 mini-plan.md 패턴은 Claude Code 초기 TodoWrite와 동일한 한계 — 모델이 목록에 얽매이고 에이전트 간 통신이 불가. F-13(Background Execution)과 시너지: 독립 TODO를 병렬 Task로 dispatch. **"Seeing like an Agent" TodoWrite→Task 교훈 참조** |
| F-24 | **Phase Runner Self-Directed Context** | ✅ **S3 완료** | Phase Runner에게 scope-bounded search를 허용하여 필요한 컨텍스트를 직접 탐색. 현재: 오케스트레이터가 context assembly 후 주입 ("given context"). 개선: impact files 목록만 제공하고 실제 내용은 Phase Runner가 직접 Read/Grep. 격리 원칙 유지를 위해 해당 phase의 impact 범위 내에서만 검색 허용(scope-bounded). **"Seeing like an Agent" RAG→self-directed search 교훈 참조** |
| F-25 | **4-Tier Adaptive Memory** | ✅ **S5 완료** | RUC DeepAgent Memory Folding + Letta(MemGPT) OS 패러다임 + 최신 메모리 연구("Memory in the Age of AI Agents", 2025.12) 종합. State Summary를 4계층 메모리로 확장: `.mpl/memory/episodic.md` (완료 Phase 요약, 시간 기반 압축 — 최근 2 Phase 상세, 이전은 1-2줄), `semantic.md` (3회+ 반복 패턴을 일반화한 프로젝트 지식), `procedural.jsonl` (도구 사용 패턴, 분류 태그 포함), `working.md` (현재 Phase TODO). episodic→semantic 자동 통합: 반복 패턴 감지 시 episodic에서 축약 + semantic에 일반화 저장. Phase 0 선택적 로드: 전체 파일이 아닌 관련 메모리만 유사도 기반 필터링. 토큰 70%+ 절감 + 반복 프로젝트 Phase 0 시간 20-30% 추가 단축. F-11 (learnings.md)과 시너지: procedural.jsonl → learnings.md 자동 증류. F-24 (Self-Directed Context)와 보완: procedural.jsonl 참조로 효과적 도구 우선 선택. **DeepAgent comparison + Letta + "Memory in the Age of AI Agents" 참조** |

#### MEDIUM — 리서치 기반 신규 (2026-03-13)

| ID | 항목 | 상태 | 설명 |
|----|------|------|------|
| F-26 | **mpl-interviewer v2: 소크라틱 통합 인터뷰** | ✅ **S6 완료** | 기존 mpl-interviewer를 확장하여 PP 발견 + 요구사항 구조화를 **단일 인터뷰로 통합**. 별도 PM 단계(Step 0.5-PM) 추가 대신, 기존 `interview_depth`(skip/light/full)에 따라 PM 역할 범위를 자동 조절. **skip**: PP 직접 추출 (PM 없음, 기존 동작 유지). **light**: Round 1-2 (PP) + 경량 요구사항 구조화(User Stories + AC). **full**: **소크라틱 6유형 질문** + **솔루션 옵션 3+ 제시** + PP 발견 + JUSF 출력(JTBD + User Stories + Gherkin AC) 통합. AI_PM(kimsanguine/AI_PM) 레포의 소크라틱 접근법 차용: 사용자 가정을 도전하고, 반드시 3개 이상 옵션 비교 후 요구사항 확정. 멀티 관점 리뷰(엔지니어/아키텍트/사용자). 증거 태깅(🟢데이터/🟡유추/🔴가정). **Dual-Layer 출력**: YAML frontmatter + Markdown body. **MoSCoW + sequence_score** 우선순위. good/bad examples 아카이브로 자기 개선. 사용자 인터뷰 1회로 PP+요구사항 동시 해결 — 인터뷰 피로 제거. Net 5-10K 토큰 절감(Phase 0 반복 감소). **AI_PM + UAM uam-pm + mpl-interviewer 통합 설계: pm-design.md 참조** |
| F-27 | **Reflexion 기반 Fix Loop 학습** | ✅ **S6 완료** | Fix Loop 진입 시 구조화된 반성(Self-Reflection) 단계 추가. Reflexion(NeurIPS 2023) + MAR(Multi-Agent Reflexion) 패턴 적용. **Reflection Template**: 실패 TODO → 증상 → 근본 원인 → 최초 이탈 지점 → 수정 전략 → 학습 추출. 반성 결과를 패턴 분류(type_mismatch, dependency_conflict, test_flake 등)하여 procedural.jsonl에 저장. 다음 실행 Phase 0에서 태스크 설명 유사도 기반으로 관련 패턴만 선택적 로드. Gate 2 실패 시 mpl-code-reviewer 피드백을 반성에 통합(MAR 패턴). HumanEval pass@1 +8.1% 개선 실적(Reflexion). F-25(procedural.jsonl)과 직접 시너지. **Reflexion + MAR 논문 참조** |
| F-28 | **Phase별 동적 에이전트 라우팅** | ✅ **S6 완료** | Phase 특성에 따라 worker 프롬프트/모델을 동적 조정. 현재 모든 Phase에 동일한 mpl-worker 할당 → Phase 도메인별 특화 프롬프트 자동 선택. TDAG(Task Decomposition and Agent Generation) 패턴 참조. 예: DB 스키마 Phase → DB 특화 프롬프트, UI Phase → 디자인 인식 프롬프트, 복잡 알고리즘 Phase → opus 모델. Decomposer 출력에 `phase_domain` 태그 추가 → Phase Runner가 매칭 프롬프트 선택. **TDAG + Anthropic 모델 라우팅 권장사항 참조** |

#### Compaction Resilience (2026-03-12 실험 기반)

| ID | 항목 | 상태 | 설명 |
|----|------|------|------|
| F-30 | **Error Context File Preservation** | ✅ **S5 완료** | Worker 실패 시 에러 전문을 `.mpl/mpl/phases/phase-N/errors/` 파일로 보존. Compaction 후에도 정확한 에러 정보로 fix loop 수렴. Phase Runner가 에러 파일 Write, orchestrator는 경로만 수신 |
| F-31 | **Compaction-Aware Context Recovery** | 부분 구현 | PreCompact 훅에서 `.mpl/mpl/checkpoints/compaction-{N}.md` checkpoint 생성. compaction_count 3회 시 경고, 4회+ 시 세션 리셋 권장. Write-side 구현 완료, orchestrator read-side 경로 명시 TBD |
| F-32 | **Adaptive Context Loading** | ✅ **S5 완료** | Phase 전환 시 context 상태 판단하여 로드량 3-way 분기: 동일 세션(최소 로드) / compaction 후(선택적 로드+checkpoint) / 새 세션(전체 로드). `last_phase_compaction_count` 필드로 compaction 감지 |
| F-33 | **Session Budget Prediction & Auto-Continue** | 미구현 | Phase 완료 시 HUD context_window 데이터 기반으로 남은 Phase 예산을 예측. 부족 시 graceful pause → `.mpl/signals/session-handoff.json` 생성 → external watcher가 새 세션에서 자동 resume. Fail-open 설계: context-usage.json 없으면 기존 동작 유지. 15% safety margin |

#### LOW — 유지

| ID | 항목 | 상태 | 설명 |
|----|------|------|------|
| F-05 | Phase 0 캐시 부분 무효화 | ✅ **S5 완료** | git diff 기반 변경 모듈만 재분석. `analyzePartialInvalidation()` + `partialCacheSave()` 구현 |
| F-06 | 멀티 프로젝트 지원 | 미구현 | monorepo 환경에서 프로젝트별 독립 파이프라인 |

---

### Adaptive Pipeline Router 상세 설계 (F-20, F-21, F-22)

#### Pipeline Score 공식

Triage(Step 0)에서 Quick Scope Scan 후 산출:

```
pipeline_score = (file_scope × 0.35) + (test_complexity × 0.25)
               + (dependency_depth × 0.25) + (risk_signal × 0.15)

file_scope:       min(affected_files / 10, 1.0)
test_complexity:  min(test_scenarios / 8, 1.0)
dependency_depth: min(import_chain_depth / 5, 1.0)
risk_signal:      keyword_hint 또는 prompt 분석 (0.0~1.0)
```

Quick Scope Scan은 Glob/Grep만으로 ~1-2K 토큰에 완료된다. 기존 Step 2 코드베이스 분석의 경량 버전.

#### 3-Tier 파이프라인 매핑

| Tier | Score | 실행 단계 | 스킵 | 예상 토큰 |
|------|-------|----------|------|----------|
| **Frugal** (< 0.3) | 단순 버그 수정, 1-2 파일 | Bug Analysis → Fix → Gate 1 → Commit | Triage, PP, Phase 0, Decomposition, Gate 2/3 | ~5-15K |
| **Standard** (0.3~0.65) | 소규모 기능, 3-5 파일 | Triage(skip) → PP(light) → Phase 0(Error Spec) → 단일 Phase → Gate 1 → Commit | Full PP, Phase 0 Step 1-3, Decomposition(다중 페이즈), Gate 2/3 | ~20-40K |
| **Frontier** (> 0.65) | 복잡 작업, 6+ 파일 | 전체 9+ step 파이프라인 | 없음 | ~50-100K+ |

사용자 힌트 오버라이드: `"mpl bugfix"` → tier를 frugal로 강제, `"mpl small"` → standard 강제. 힌트 없으면 자동 산정.

#### 동적 에스컬레이션 프로토콜

```
[Frugal] ──circuit break──→ [Standard] ──circuit break──→ [Frontier]
                              │                              │
                              ├─ 완료된 TODO 보존             ├─ 완료된 페이즈 보존
                              ├─ 실패 TODO를 단일 Phase로     ├─ 실패 Phase를 재분해
                              │  재구성                       │
                              └─ PP 추출 (light)              └─ Full PP + Phase 0
```

에스컬레이션 시 state.json에 `escalation_history` 기록:

```json
{
  "pipeline_tier": "standard",
  "escalation_history": [
    {"from": "frugal", "to": "standard", "reason": "circuit_break", "preserved_todos": 3}
  ]
}
```

#### Routing Pattern 파일 형식 (F-22)

```jsonl
{"ts":"2026-03-07T10:00:00Z","desc":"add validation to endpoint","tier":"standard","result":"success","tokens":32400,"files":4}
{"ts":"2026-03-07T11:30:00Z","desc":"fix typo in error message","tier":"frugal","result":"success","tokens":8200,"files":1}
{"ts":"2026-03-07T14:00:00Z","desc":"refactor auth module","tier":"frontier","result":"success","tokens":87000,"files":12}
{"ts":"2026-03-07T15:00:00Z","desc":"add input sanitization","tier":"frugal","escalated":"standard","result":"success","tokens":28000,"files":3}
```

Jaccard 유사도로 매칭 (토큰화 후 intersection/union, 임계값 0.8):

```
new_task: "add email validation to signup endpoint"
match:    "add validation to endpoint" (similarity=0.83) → tier=standard 추천
```

---

### 전체 흐름도

```
진입 (keyword-detector)
├── "mpl" 감지 → 단일 스킬 진입                             [F-20]
└── hint 추출 (bugfix→frugal, small→standard, 없음→auto)

Triage (Step 0) — 확장
├── 정보 밀도 분석 → interview_depth
├── Quick Scope Scan (Glob/Grep, ~1-2K 토큰)               [F-20]
│   ├── 영향 파일 수
│   ├── 테스트 존재 여부
│   └── import 깊이 샘플링
├── routing-patterns.jsonl 매칭 (이전 패턴 참조)             [F-22]
├── pipeline_score 산출 → pipeline_tier                     [F-20]
└── .mpl/memory/learnings.md 로드                           [F-11]

PP + 요구사항 통합 인터뷰 (Step 1) — mpl-interviewer v2      [F-26]
├── interview_depth에 따라 자동 범위 조절
│   ├── skip: PP 직접 추출 (기존 동작 유지)
│   ├── light: Round 1-2 (PP) + 경량 요구사항 구조화
│   └── full: 소크라틱 질문 + 옵션 3+ + PP + JUSF 출력
├── Dual-Layer 출력: YAML frontmatter + Markdown body
├── Gherkin AC → Test Agent 입력
└── good/bad examples 아카이브로 자기 개선

실행 전 (Phase 0) — tier별 분기
├── Frugal:  Error Spec만 → 단일 Fix Cycle
├── Standard: Error Spec + light PP → 단일 Phase
├── Frontier: 전체 Phase 0 → 다중 Phase
├── mpl-scout(haiku)로 구조 분석                            [F-16]
├── lsp_diagnostics_directory 타입 체크                      [F-17]
├── 4-Tier Memory 선택적 로드                                [F-25]
│   ├── semantic.md (프로젝트 지식)
│   ├── procedural.jsonl (관련 패턴만 유사도 필터)
│   └── episodic.md (이전 실행 요약)
└── phase_domain 태그 기반 프롬프트 선택                      [F-28]

실행 중 (Phase 1~N)
├── RUNBOOK.md 실시간 갱신                                   [F-10]
├── <remember priority> 태그로 컴팩션 대비                    [F-12]
├── Background Execution (독립 TODO 병렬)                    [F-13]
├── AskUserQuestion (Side Interview HITL)                    [F-14]
├── Worktree 격리 (HIGH 리스크 페이즈)                       [F-15]
├── circuit break 시 자동 에스컬레이션                        [F-21]
│   └── Frugal→Standard→Frontier (완료 작업 보존)
├── mpl-scout (Fix Loop 원인 탐색)                           [F-16]
└── Fix Loop 진입 시 Reflection Template 실행                [F-27]
    ├── 실패 원인 → 근본 원인 → 수정 전략 → 학습 추출
    └── 패턴 분류 → procedural.jsonl 저장

실행 후 (Finalize)
├── routing-patterns.jsonl에 실행 결과 append                [F-22]
├── RUNBOOK decisions/issues → memory/learnings.md 증류      [F-11]
├── episodic.md 갱신 → 3회+ 반복 시 semantic.md로 승격       [F-25]
├── procedural.jsonl → learnings.md 자동 증류                [F-25]
└── 다음 실행 Phase 0에서 4-tier memory + patterns 자동 참조
```

### RUNBOOK.md 형식 (F-10)

```markdown
# RUNBOOK — {task description}
Started: 2026-03-07T10:00:00Z

## Current Status
- Phase: 3/5 (phase-3: Add validation layer)
- Pipeline Mode: full
- Maturity: standard

## Milestone Progress
- [x] Phase 1: DB schema migration — PASS (4/4 criteria)
- [x] Phase 2: API endpoints — PASS (6/6 criteria)
- [ ] Phase 3: Validation layer — IN PROGRESS (2/5 criteria)
- [ ] Phase 4: Error handling
- [ ] Phase 5: Integration tests

## Key Decisions
- PD-001: chose Zod over Joi for validation (PP-02 type safety)
- PD-003: split user/admin routes (decomposer recommendation)

## Known Issues
- ISS-001: rate limiter not tested under load (H-item, deferred)

## Blockers
(none)

## How to Resume
Load: pivot-points.md + decomposition.yaml + this file
Next: Phase 3 TODO #3 — email format validator
```

### learnings.md 형식 (F-11)

```markdown
# MPL Learnings (auto-accumulated)
Last updated: 2026-03-07

## Failure Patterns
- [2026-03-05] Type mismatch: Python dict vs TypedDict — always use TypedDict
- [2026-03-07] pytest fixture scope confusion — default to "function" scope

## Success Patterns
- [2026-03-05] Zod schema shared between frontend/backend validation
- [2026-03-07] Error spec from Phase 0 eliminated all debugging

## Project Conventions (discovered)
- Import order: stdlib > third-party > local (enforced by ruff)
- Test naming: test_{module}_{scenario}_{expected}
```

---

## 결론

MPL은 v1.0→v3.0 진화를 통해 "예방이 치료보다 낫다"는 원칙을 실증 데이터로 뒷받침하는 파이프라인으로 성장했다. v3.2는 두 가지 원칙을 추가한다:

1. **"문서가 메모리다"** — 단일 실행 내 품질뿐 아니라 세션 간·실행 간 연속성을 보장
2. **"사용자에게 복잡도를 판단하라고 요구하지 않는다"** — Ouroboros PAL Router에서 영감을 받은 적응형 파이프라인 라우팅으로, 단일 진입점 + 자동 tier 분류 + 동적 에스컬레이션을 통해 경량 작업의 진입 장벽을 제거

상세 설계는 각 문서를 참고한다:

- [Phase 1: Foundation - Phase 0 Enhanced](./phase1-foundation.md) — **구현 완료**
- [Phase 2: Incremental - 점진적 구현/테스트](./phase2-incremental.md) — **구현 완료**
- [Phase 3: Automation - 자동화 및 최적화](./phase3-automation.md) — **부분 구현**
- [Adaptive Pipeline Router 구현 계획](./adaptive-router-plan.md) — **v3.2 신규**
- [실험 결과 요약](./experiments-summary.md)
- [v3.0 설계 문서](../design.md)
