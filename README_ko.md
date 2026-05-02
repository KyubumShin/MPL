# MPL (Micro-Phase Loop) v0.17.1

**예방이 치료보다 낫다. 명세가 디버깅보다 낫다.**

Claude Code 플러그인으로, 야심찬 태스크를 마이크로 페이즈로 분해하여 각각 독립적으로 계획-실행-검증한다. 컨텍스트가 오염되지 않고, 실패가 전파되지 않는다.

> **[English Documentation](./README.md)**

[빠른 시작](#빠른-시작) · [철학](#혼돈에서-일관성으로) · [루프](#루프) · [라우터](#라우터) · [에이전트](#여덟-개의-마음) · [내부 구조](#내부-구조)

---

> AI는 격리된 환경에서 무엇이든 만들 수 있다. 어려운 것은 조합되는 것을 만드는 것이다.
>
> AI 에이전트가 오래 실행될수록, 약속한 것을 더 많이 잊는다.
> MPL은 이에 맞서 싸우지 않는다 — 각 페이즈에 필요한 지식만 가진 새로운 마음을 부여한다.

---

## 혼돈에서 일관성으로

> "미래를 예측하는 최선의 방법은 과거를 예방하는 것이다."

모든 자율 코딩 파이프라인은 같은 적에 직면한다: **컨텍스트 오염**. 세션이 길어질수록 축적된 상태 — 미완성 아이디어, 버려진 접근법, 오래된 가정 — 가 이후 모든 결정을 저하시킨다. Phase 4쯤 되면 에이전트는 코드가 아닌 자신의 혼란을 디버깅하고 있다.

MPL의 답은 영웅적이 아니라 구조적이다:

```
 혼돈                                일관성
   "한 번에 전부 만들기"  →  "하나를 완벽히 만들고, 잊기"
   "Phase 5에서 고치기"   →  "Phase 0에서 예방하기"
   "에이전트 기억 신뢰"   →  "기록된 산출물만 신뢰"
```

이것은 조심의 철학이 아니다 — **복리적 신뢰성**의 철학이다. 각 마이크로 페이즈는 성공할 수 있을 만큼 작다. 각 성공은 State Summary로 기록된다. 이후 페이즈는 그 요약만 읽고, 어떻게 만들어졌는지의 지저분한 역사는 읽지 않는다.

결과: Phase 10이 Phase 1과 같은 명확함으로 실행된다.

### 두 가지 법칙

**법칙 1: 명세에 투자하라, 디버깅을 제거하라.**

7번의 실험으로 Phase 0 투자(API 계약, 타입 정책, 에러 명세)가 Phase 5 재작업을 단조적으로 감소시킴을 증명했다:

```
Phase 0 투자          통과율 추이
────────────────      ──────────────────────
Phase 0 없음          38% → 디버깅 지옥
+ API 계약            58% → 여전히 고통스러움
+ 예제 패턴           65% → 개선 중
+ 타입 정책           77% → 거의 다 됨
+ 에러 명세           100% → 디버깅 제로
```

**법칙 2: 오케스트레이터는 절대 코드를 작성하지 않는다.**

오케스트레이터가 소스 파일을 건드리는 순간, 자신의 구현에 투자하게 된다. 객관적 검증 대신 자기 코드를 방어한다. MPL은 PreToolUse 훅으로 오케스트레이터의 소스 파일 편집을 물리적으로 차단한다. 모든 코드는 Task 위임을 통해 `mpl-phase-runner` 에이전트로 흐른다.

---

## 빠른 시작

**Step 1 — 프로젝트에 클론:**

```bash
cd /path/to/your-project
git clone https://github.com/<your-org>/MPL.git
```

**Step 2 — 런타임 디렉토리 생성:**

```bash
mkdir -p .mpl/mpl/{phase0,phases,profile} .mpl/cache/phase0 .mpl/memory
```

**Step 3 — 빌드 시작:**

```
mpl 사용자 인증에 OAuth와 역할 기반 접근 제어 추가
```

<details>
<summary><strong>무슨 일이 일어났나?</strong></summary>

```
Quick Scope Scan  → 8개 영향 파일, 4개 테스트 시나리오 → pp_proximity 0.72
Hat 선택         → PP-proximity 스코어링 → 적정 파이프라인 깊이
PP 인터뷰        → 6개 Pivot Points 추출 (3 CONFIRMED, 3 PROVISIONAL)
Phase 0 Enhanced → API 계약 + 타입 정책 + 에러 명세 생성
분해              → 4개 마이크로 페이즈 + 인터페이스 계약
페이즈 실행       → 4 페이즈 × (계획 → 페이즈 러너 → 테스트 → 검증)
3H+1A Gate       → Hard 1: 빌드+타입, Hard 2: 테스트, Hard 3: PP 준수, Advisory: 크로스 바운더리
RUNBOOK          → 전체 실행 로그 (세션 연속성 보장)
```

각 페이즈는 자신의 컨텍스트만 보았다. 오염 없음. 전파 없음.

</details>

---

## 루프

MPL의 핵심은 **분해-실행-검증** 루프이며, 각 반복은 새로운 세션이다:

```
                    ┌─── Phase 0: 명세 ───┐
                    │  API 계약            │
                    │  타입 정책           │
                    │  에러 명세           │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  N개 마이크로       │
                    │  페이즈로 분해      │
                    └──────────┬──────────┘
                               │
              ┌────────────────▼────────────────┐
              │  각 페이즈 (새로운 세션):              │
              │    계획 → 페이즈 러너 → 테스트 → 검증  │
              │    출력: State Summary만                │
              └────────────────┬────────────────┘
                               │
                    ┌──────────▼──────────────┐
                    │  3 Hard + 1 Advisory    │
                    │  Hard 1: 빌드+타입      │
                    │  Hard 2: 테스트         │
                    │  Hard 3: PP 준수        │
                    │  Advisory: 크로스 바운더리│
                    └──────────┬──────────────┘
                               │
                           완료
```

| 단계 | 무엇을 하는가 | 왜 중요한가 |
|------|-------------|------------|
| **트리아지** | 프롬프트 밀도 분석, 스코프 스캔 | 파이프라인 적정 규모 선택 |
| **Pivot Points** | 소크라테스식 인터뷰로 불변 제약조건 추출 | 스코프 드리프트 방지 |
| **Phase 0** | 사전 명세: 계약, 타입, 에러 | 디버깅 제거 |
| **분해** | 인터페이스 계약과 함께 순서화된 페이즈로 분할 | 각 페이즈 독립 검증 가능 |
| **실행** | 페이즈별 새 세션, 페이즈 러너 위임, 마이크로 테스트 사이클 | 컨텍스트 오염 없음 |
| **3H+1A Gate** | 테스트(Hard) → 리뷰(Hard) → PP(Hard) + 타입(Advisory) | 증거 기반 완료 |
| **RUNBOOK** | 연속 감사 로그 (사람/에이전트 세션 연속성) | 중단된 곳에서 재개 |

### State Summary: 유일한 다리

페이즈 간에 오직 하나의 산출물만 전달된다: **State Summary**. 무엇을 만들었고, 무엇을 결정했고, 무엇을 검증했는지 — 그 외에는 아무것도 없다. 코드 조각도, 디버깅 히스토리도, 버려진 접근법도 없다.

이것이 핵심 통찰이다: **잊는 것이 기능이다**. 각 페이즈는 깨끗하게 시작하며, 필요한 구조화된 지식만 가진다. 오케스트레이터가 컨텍스트 조립을 관리 — 올바른 요약, 올바른 Phase Decisions, 올바른 영향 파일을 로드 — 하여 Phase Runner가 완벽한 정보 밀도로 작동한다.

### Build-Test-Fix: 마이크로 사이클

각 페이즈 내부에서 모든 TODO는 즉시 검증된다:

```
각 TODO마다:
  Build  → Phase Runner가 변경 사항 구현
  Test   → 즉시 관련 테스트 실행 (마지막이 아닌)
  Fix    → 실패 시 수정 (TODO당 최대 2회 재시도)

전체 TODO 완료 후:
  Test Agent → 독립 테스트 작성 (코드 작성자 ≠ 테스트 작성자)
  누적 검증  → 이전 페이즈 전체에 대한 회귀 검사
```

구현을 테스트 전에 묶어서 처리하는 것은 금지다. 5개 TODO 이후 발견된 버그는 어느 것이 원인인지 알 수 없다. TODO #3 직후 발견된 버그는 TODO #3이 원인이다.

### 서킷 브레이크: 우아한 실패

페이즈가 3회 재시도 후에도 실패하면, 충돌하지 않고 **서킷 브레이크**한다:

1. PASS TODO 보존 (검증된 작업은 절대 폐기하지 않음)
2. FAIL TODO 파일을 페이즈 이전 상태로 롤백
3. 재분해를 위한 복구 컨텍스트 저장
4. 포기하기 전 티어 에스컬레이션 시도 ([라우터](#라우터) 참고)

최대 2회 재분해. 이후 MPL은 성공한 것과 실패한 것을 보고 — 부분 진행 상황은 항상 보존된다.

---

## 라우터

> 사용자가 "이것이 작은 작업인가 큰 작업인가?"를 판단할 필요가 없어야 한다.
> 시스템이 알아내야 한다 — 그리고 틀렸을 때 적응해야 한다.

### Hat 모델 (PP-Proximity)

MPL은 **PP-proximity** (Pivot Point 근접도)를 사용하여 파이프라인 깊이를 결정한다. 각 태스크는 프로젝트의 불변 제약조건(Pivot Points)에 얼마나 가까이 닿는지로 점수화된다. 근접도가 높을수록 더 엄격한 파이프라인이 적용된다.

하나의 진입점. 자동 스코어링. 동적 에스컬레이션.

```
"mpl 로그인 버그 수정"           → 트리아지 → Hat PP-proximity 스코어링 → 경량 파이프라인
"mpl 이메일 유효성 검증 추가"    → 트리아지 → Hat PP-proximity 스코어링 → 표준 파이프라인
"mpl 인증 시스템 리팩토링"       → 트리아지 → Hat PP-proximity 스코어링 → 전체 파이프라인
```

#### PP-Proximity 점수

트리아지가 Quick Scope Scan을 실행하고 PP-proximity를 계산한다 — 태스크가 핵심 제약조건에 얼마나 닿는가:

```
pp_proximity = (pp_impact × 0.40) + (file_scope × 0.25)
             + (contract_change × 0.20) + (risk_signal × 0.15)

pp_impact:        직접 영향받는 PP 수 (0.0 ~ 1.0)
file_scope:       min(affected_files / 10, 1.0)
contract_change:  인터페이스 계약 변경 여부 (0.0 또는 1.0)
risk_signal:      프롬프트 키워드 분석 (0.0 ~ 1.0)
```

#### Hat + Floor

| Hat | PP-Proximity | 실행 단계 | Floor (최소 보장) | ~토큰 |
|-----|-------------|----------|------------------|-------|
| **Light** | 낮음 | Error Spec → 수정 → Gate 1 → 커밋 | Gate 1 항상 실행 | ~5-15K |
| **Standard** | 중간 | PP(light) → Error Spec → 단일 페이즈 → Gate 1+2 | Gate 1+2 항상 실행 | ~20-40K |
| **Full** | 높음 | 전체 파이프라인 (모든 게이트 포함) | 3 Hard Gate 모두 실행 | ~50-100K+ |

#### 동적 에스컬레이션

Hat 레벨이 실패하면, 포기하지 않고 성장한다:

```
[Light] ──서킷 브레이크──→ [Standard] ──서킷 브레이크──→ [Full]
                                │                              │
                                ├─ 완료된 TODO 보존             ├─ 완료된 페이즈 보존
                                └─ 실패 TODO → 단일 페이즈      └─ 실패 페이즈 → 재분해
```

키워드 힌트는 수동 오버라이드로 사용: `"mpl bugfix"` → light, `"mpl small"` → standard.

---

## 여덟 개의 마음

8개 에이전트, 각각 단일 목적. 온디맨드 로드, 사전 로드 없음:

| 에이전트 | 역할 | 핵심 원칙 |
|---------|------|----------|
| **Interviewer** | Pivot Points 소크라테스식 질문 + 모호성 해소 | "타협할 수 없는 것은?" |
| **Codebase Analyzer** | 코드베이스 구조 정적 분석 | "디렉토리, 의존성, 인터페이스를 파악한다" |
| **Decomposer** | 순서화된 마이크로 페이즈로 분해 + Phase Seed 생성 | "무엇이 무엇에 의존하나?" |
| **Phase Runner** | 단일 페이즈 전체 실행 + 테스트 작성 | "계획, 구현, 검증, 요약" |
| **Code Reviewer** | 품질 게이트 + PP 준수 | "이 PR을 승인하겠는가?" |
| **Scout** | 경량 코드베이스 탐색 (haiku) | "빠르게 찾고, 비용 없이" |
| **Compound** | 학습 추출 및 증류 | "미래 실행이 알아야 할 것을 배웠는가?" |
| **Doctor** | 설치 진단 | "모든 것이 올바르게 연결되었는가?" |

### 에이전트 분리 원칙

코드를 구현하는 Phase Runner는 검증하는 Test Agent가 아니다. 계획하는 Decomposer는 실행하는 Phase Runner가 아니다. 컨텍스트를 조립하는 오케스트레이터는 소스 파일을 건드리지 않는다. 각 분리가 한 부류의 편향을 제거한다.

---

## 검증 시스템

### A/S/H 분류

모든 검증이 동일하지 않다. MPL은 모든 기준을 분류한다:

| 타입 | 이름 | 검증 주체 | 예시 |
|------|------|----------|------|
| **A-item** | 에이전트 검증 가능 | 종료 코드, 파일 존재 | `npm test` 종료 코드 0 |
| **S-item** | 샌드박스 테스팅 | BDD 시나리오, Given/When/Then | 통합 테스트 통과 |
| **H-item** | 사람 필요 | 사용자와 사이드 인터뷰 | UX 판단, 시각적 리뷰 |

### 3 Hard Gate + 1 Advisory

세 개의 Hard Gate(차단) + 하나의 Advisory Gate(경고):

| Gate | 타입 | 방법 | 통과 기준 |
|------|------|------|----------|
| **Hard 1** | **Hard** | 빌드 + 타입 검사 (프로젝트 전체) | 빌드 에러 0, 타입 에러 0 |
| **Hard 2** | **Hard** | 자동화 테스트 (A + S items) | pass_rate >= 95% |
| **Hard 3** | **Hard** | PP 준수 + H-item 해결 | 위반 없음 + 모든 H-items 해결 |
| **Advisory** | Advisory | 크로스 바운더리 계약 검사 | 바운더리 계약 일관성 (경고, 차단하지 않음) |

### 수렴 감지

Fix loop에서 pass rate 이력을 추적하여 자동 판단:

| 상태 | 조건 | 동작 |
|------|------|------|
| `improving` | delta > min_improvement | 수정 계속 |
| `stagnating` | variance < 5% AND delta < threshold | 전략 변경 또는 에스컬레이션 |
| `regressing` | delta < -10% | 롤백 또는 Phase 0 산출물 재검토 |

---

## 내부 구조

<details>
<summary><strong>8 에이전트 · 4 훅 · 7 스킬 · 4 프로토콜 파일</strong></summary>

```
MPL/
├── agents/                 # 8개 에이전트 정의 (YAML)
│   └── mpl-interviewer.md   # PP 인터뷰 + 모호성 해소 (opus)
├── commands/               # 오케스트레이션 프로토콜 (토큰 효율을 위해 분할)
│   ├── mpl-run.md          # 라우터: 어떤 프로토콜 파일을 로드할지
│   ├── mpl-run-phase0.md   # Steps -1 ~ 2.5: 트리아지, PP, Phase 0
│   ├── mpl-run-decompose.md # Steps 3 ~ 3-B: 분해
│   ├── mpl-run-execute.md  # Step 4: 실행 루프, 3-Gate, Fix 루프
│   └── mpl-run-finalize.md # Steps 5 ~ 6: 마무리, 재개
├── hooks/                  # 4개 훅
│   ├── mpl-write-guard.mjs       # 오케스트레이터 소스 편집 차단
│   ├── mpl-validate-output.mjs   # 에이전트 출력 스키마 검증
│   ├── mpl-phase-controller.mjs  # 페이즈 전환 + 에스컬레이션 (F-21)
│   ├── mpl-keyword-detector.mjs  # "mpl" 키워드 → 파이프라인 초기화
│   └── lib/
│       ├── mpl-state.mjs         # 상태 관리 + 에스컬레이션
│       ├── mpl-scope-scan.mjs    # Pipeline score 계산 (F-20)
│       ├── mpl-cache.mjs         # Phase 0 캐싱
│       ├── mpl-profile.mjs       # 토큰 프로파일링
│       └── mpl-routing-patterns.mjs # 라우팅 패턴 학습 (F-22)
├── skills/                 # 7개 스킬
│   ├── mpl/                # 메인 파이프라인 (단일 진입점)
│   ├── mpl-pivot/          # PP 인터뷰
│   ├── mpl-status/         # 대시보드
│   ├── mpl-cancel/         # 클린 취소
│   ├── mpl-resume/         # 체크포인트에서 재개
│   ├── mpl-doctor/         # 진단
│   └── mpl-setup/          # 셋업 위저드
└── docs/
    ├── design.md           # 전체 사양
    ├── standalone.md       # Standalone 모드 폴백 매트릭스 (F-04)
    └── roadmap/            # 진화 역사 + 향후 계획
```

**핵심 내부 구조:**

- **Hat 모델 (PP-proximity)** — Quick Scope Scan + PP-proximity 스코어 → Hat 기반 파이프라인 깊이 선택
- **Dynamic Escalation (F-21)** — light → standard → full 서킷 브레이크 시, 완료된 작업 보존
- **RUNBOOK (F-10)** — 통합 실행 로그, 9개 파이프라인 지점에서 자동 업데이트, 세션 재개 가능
- **Session Persistence (F-12)** — 페이즈 전환마다 `<remember priority>` 태그 + RUNBOOK 이중 안전망
- **Run-to-Run Learning (F-11)** — 오케스트레이터가 RUNBOOK → `.mpl/memory/learnings.md` 증류
- **Routing Pattern Learning (F-22)** — 과거 실행 패턴의 Jaccard 유사도 매칭
- **Self-Directed Context (F-24)** — Phase Runner가 스코프 바운디드 영향 파일 내 Read/Grep 가능
- **Task-based TODO (F-23)** — 실행 중 TaskCreate/TaskUpdate가 주요 TODO 상태 관리자
- **Background Execution (F-13)** — 독립 TODO를 `run_in_background: true`로 병렬 디스패치
- **Hard 1 빌드+타입 검사** — 프로젝트 전체 빌드 및 타입 검사 (이전 Gate 0.5 통합)
- **Standalone Mode (F-04)** — 도구 가용성 자동 감지, LSP/AST 미설치 시 Grep/Glob 폴백
- **Phase 0 Caching** — 해시 기반 캐시 키, 캐시 히트 시 Phase 0 전체 스킵 (~8-25K 토큰 절감)
- **2-Tier PD** — Phase Decisions를 Active/Summary로 분류, 페이즈당 일정 토큰 예산
- **Convergence Detection** — 정체(variance < 5%), 회귀(delta < -10%), 전략 제안

</details>

### 상태 디렉토리: `.mpl/`

| 경로 | 용도 |
|------|------|
| `.mpl/state.json` | 파이프라인 + 실행 상태 통합 파일 (schema v2, P2-6). `run_mode`/`current_phase`/`tool_mode` + `execution` subtree(task, phase_details, totals, cumulative_pass_rate) — 이전 2개 파일이 통합됨. |
| `.mpl/pivot-points.md` | 불변 제약조건 (Pivot Points) |
| `.mpl/config.json` | 사용자 설정 오버라이드 |
| `.mpl/mpl/RUNBOOK.md` | 세션 연속성을 위한 통합 실행 로그 (F-10) |
| `.mpl/mpl/decomposition.yaml` | 페이즈 분해 출력 |
| `.mpl/mpl/phase-decisions.md` | 축적된 Phase Decisions (2-Tier) |
| `.mpl/mpl/phase0/` | Phase 0 Enhanced 산출물 |
| `.mpl/mpl/phases/phase-N/` | 페이즈별 산출물 (mini-plan, state-summary, verification) |
| `.mpl/mpl/profile/` | 토큰/타이밍 프로파일 (phases.jsonl, run-summary.json) |
| `.mpl/memory/learnings.md` | Run-to-Run 축적 학습 (F-11) |
| `.mpl/memory/routing-patterns.jsonl` | 티어 예측을 위한 과거 실행 패턴 (F-22) |
| `.mpl/cache/phase0/` | Phase 0 캐시 산출물 |

---

## 설치

MPL은 Claude Code 플러그인 구조를 따르며, 별도 의존성 없이 단독으로 설치·실행할 수 있다.

### 사전 요구사항

| 항목 | 최소 버전 | 확인 명령 |
|------|----------|----------|
| Claude Code CLI | 최신 | `claude --version` |
| Node.js | 18+ | `node --version` |
| Git | 2.x | `git --version` |

### 자동 설치

클론 후 셋업 위저드에 맡길 수 있다:

```
/mpl:mpl-setup
```

또는 `setup mpl`이라고 입력하면 런타임 디렉토리, 설정 파일, 도구 감지까지 자동 처리한다.

### 설치 확인

```
/mpl:mpl-doctor
```

---

## 사용법

```bash
# 하고 싶은 것만 말하면 — 시스템이 나머지를 알아낸다
mpl 사용자 인증에 OAuth 추가                    # → Full (~80K 토큰)
mpl 회원가입 폼에 입력 유효성 검증 추가          # → Standard (~30K 토큰)
mpl handleSubmit에서 null 체크 수정             # → Light (~8K 토큰)

# 키워드 힌트로 수동 오버라이드
mpl bugfix 누락된 에러 핸들러                   # → light 강제
mpl small 재시도 로직 추가                      # → standard 강제

# 스킬 직접 호출
/mpl:mpl

# 진단
/mpl:mpl-doctor
```

## Standalone 모드

LSP/AST MCP 도구가 없는 환경에서 MPL은 자동으로 폴백 도구를 사용한다:

| MCP 도구 (미설치 시) | Standalone 폴백 | 용도 |
|---------------------|----------------|------|
| `lsp_hover` | `Grep` + `Read` | Phase 0 API 계약 추출 |
| `lsp_find_references` | `Grep` (import/require 패턴) | 코드베이스 중심성 분석 |
| `lsp_goto_definition` | `Grep` + `Glob` | 의존성 추적 |
| `lsp_diagnostics` | `Bash(tsc --noEmit)` / `Bash(python -m py_compile)` | 페이즈 러너 결과 검증 |
| `lsp_document_symbols` | `Grep` (함수/클래스 정의 패턴) | 인터페이스 추출 |
| `ast_grep_search` | `Grep` (정규식 패턴) | Phase 0, 코드베이스 분석 |

> 모든 파이프라인 기능은 standalone 모드에서도 완전히 동작한다.

## 테스트

```bash
node --test hooks/__tests__/*.test.mjs
```

## 설계 참조

- 전체 사양: [`docs/design.md`](./docs/design.md)
- 로드맵: [`docs/roadmap/overview.md`](./docs/roadmap/overview.md)
- Adaptive Router 계획: [`docs/roadmap/adaptive-router-plan.md`](./docs/roadmap/adaptive-router-plan.md)
- Standalone 모드: [`docs/standalone.md`](./docs/standalone.md)

---

*"최고의 디버깅 세션은 결코 일어나지 않는 것이다."*

**MPL은 버그를 더 빨리 고치지 않는다 — 버그가 존재하지 않게 예방한다.**
