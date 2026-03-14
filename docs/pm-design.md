# MPL PM 통합 설계 문서 (F-26)

> **버전**: 2.0
> **작성일**: 2026-03-13
> **상태**: 설계 완료 — mpl-interviewer v2 확장 구현 대기
> **관련 로드맵**: F-26 (PM Capability, mpl-interviewer 통합형)
> **참조**: AI_PM(kimsanguine/AI_PM), UAM uam-pm, mpl-interviewer.md, pm-skill-proposal, mpl-pm-skill-research

---

## 1. 설계 철학

### "좋은 PRD는 좋은 답이 아니라, 좋은 질문에서 시작된다"

PM 서브시스템의 핵심 철학은 **소크라틱 파트너십(Socratic Partnership)**이다. 단순히 사용자 요청을 구조화하는 것이 아니라, 요청 자체의 가정과 맹점을 체계적으로 도전(challenge)하여 **올바른 문제를 풀고 있는지** 먼저 검증한다.

#### 왜 소크라틱인가?

AI 코딩 에이전트 파이프라인에서 요구사항 불명확이 야기하는 비용은 극단적이다:

| 문제 | 비용 |
|------|------|
| 잘못된 기능 구현 | Phase 전체 토큰 낭비 (~15-30K) |
| 누락된 엣지 케이스 | Fix Loop 진입 + 재분해 (~20-40K) |
| 범위 확산(Scope Creep) | 중간 중단 + 사용자 재요청 |
| 가정 불일치 | Gate 실패 + 전면 재작업 |

소크라틱 질문은 이러한 비용을 **Phase 0 이전에 ~1-4K 토큰 투자로 예방**한다. MPL의 기존 철학 "예방이 치료보다 낫다(Phase 0 Enhanced)"를 요구사항 단계로 확장하는 것이다.

#### 3축 프레임워크: 기획-디자인-개발

프로젝트의 불확실성은 **기획(Product)**, **디자인(Design/UX)**, **개발(Development)** 세 축에서 동시에 존재한다. 기존 인터뷰가 개발 사이드에만 집중하던 편향을 교정하여, 세 축 모두에서 균형 있게 소크라틱 도전을 수행한다.

| 축 | 도전 대상 | 질문 예시 |
|----|----------|----------|
| **기획** | 사용자 가치, 우선순위 근거, 성공 측정 | "이 기능들 중 하나만 남긴다면?" |
| **디자인** | 비주얼 방향, 사용자 플로우, 정보 계층, 상태 처리 | "로딩/에러/빈 상태에서 사용자가 보는 화면은?" |
| **개발** | 기술적 가정, 구현 방향, 테스트 기준, 호환성 | "이 기능의 사용자는 누구인가?" |

> **왜 3축인가?** Yggdrasil 실험에서 기능 스펙(기획+개발)은 상세했지만 디자인 시스템(색상, 타이포, 컴포넌트 스타일링)이 전무했다. 기존 인터뷰는 이를 감지하지 못했고, worker가 임의로 UI를 결정했다. 이는 "정보 밀도가 높다"의 함정 — 한 축의 상세함이 다른 축의 부재를 가리는 현상이다.

#### Uncertainty Scan의 9차원

3축 × 3 = 9차원으로 불확실성을 검사한다:

| 축 | 차원 | 검사 대상 |
|----|------|----------|
| 기획 | U-P1 타겟 사용자 | 페르소나, 사용 맥락 |
| 기획 | U-P2 핵심 가치 | 우선순위 근거, 하나만 남길 기준 |
| 기획 | U-P3 성공 측정 | 완료 후 성공/실패 판단 기준 |
| 디자인 | U-D1 비주얼 시스템 | 색상, 타이포, 스페이싱, 컴포넌트 스타일 |
| 디자인 | U-D2 사용자 플로우 | 핵심 여정, 상태 전환, 로딩/에러/빈 상태 |
| 디자인 | U-D3 정보 계층 | 시각적 우선순위, 반응형 축소 기준 |
| 개발 | U-E1 모호한 기준 | 측정 불가능한 PP criteria |
| 개발 | U-E2 암묵적 가정 | 환경/데이터/동시성 가정 |
| 개발 | U-E3 기술 결정 | 미확정 라이브러리/아키텍처 선택 |

추가로 **축 간 교차 검사**(기획↔디자인, 디자인↔개발, 기획↔개발)와 **PP 축 편향 체크**(PP가 한 축에만 편중 시 경고)를 수행한다. 상세 프로토콜은 `agents/mpl-interviewer.md`의 `<Uncertainty_Scan>` 섹션 참조.

#### 코딩 에이전트 맥락의 소크라틱

이 시스템은 비즈니스 PM 도구가 아니다. 사용자는 개발자/엔지니어이며, 도전하는 대상은 시장 적합성이 아니라 **기술적 가정과 범위, 그리고 디자인/UX 방향**이다:

| 비즈니스 PM 소크라틱 | MPL PM 소크라틱 |
|---------------------|----------------|
| "타겟 시장은 누구인가?" | "이 기능의 사용자는 누구인가? (admin? end-user? 둘 다?)" |
| "ROI가 충분한가?" | "이 구현의 복잡도 대비 가치가 적절한가?" |
| "경쟁사 대비 차별점은?" | "기존 코드베이스에 유사 기능이 있는가?" |
| "시장 데이터가 있는가?" | "이 동작을 검증할 테스트가 명확한가?" |
| "브랜드 가이드라인은?" | "UI 디자인 방향에 대한 레퍼런스가 있는가?" |
| "사용자 여정 맵은?" | "핵심 기능에서 로딩/에러/빈 상태의 UX는?" |

---

## 2. 파이프라인 위치

### 2.1 mpl-interviewer 통합형 배치 (Step 1 확장)

PM 기능은 별도 Step이 아니라, **기존 Step 1(PP Interview)을 확장하여 PP + 요구사항 인터뷰로 통합**한다. Triage의 기존 `interview_depth`(skip/light/full) 필드가 PM 기능의 활성화 범위를 자연스럽게 제어한다.

```
User Request
  |
Step -1: LSP Warm-up (기존, 비차단)
  |
Step 0: Triage (기존)
  ├── 정보 밀도 분석 (information_density)
  ├── interview_depth 결정 (skip / light / full)  ← PM 범위도 이것으로 제어
  ├── Quick Scope Scan (F-20: pipeline_score)
  └── Routing Pattern 매칭 (F-22)
  |
Step 0.5: 성숙도 모드 감지 (기존)
  |
Step 1: PP + Requirements Interview (확장)        ← mpl-interviewer v2
  ├── [PP] Pivot Point 발견 (기존 4 Rounds)
  ├── [PM] 소크라틱 질문 + 요구사항 구조화 (NEW, depth에 따라)
  ├── [PM] JUSF 출력 (JTBD + User Stories + Gherkin AC) (NEW, depth에 따라)
  └── Dual-Layer 산출물 저장
  |
Step 2: Pre-Execution Analysis (기존)
  ...
```

### 2.2 interview_depth에 의한 PM 범위 제어

기존 Triage의 `interview_depth` 필드가 PP 인터뷰 깊이와 PM 요구사항 구조화 범위를 동시에 결정한다. **별도의 `needs_pm` 필드는 불필요하다.**

| depth | PP (기존) | 요구사항 (신규) | 소크라틱 질문 | 솔루션 옵션 |
|-------|----------|---------------|-------------|-----------|
| skip  | 프롬프트에서 직접 추출 | 없음 | 없음 | 없음 |
| light | Round 1-2 (What + What NOT) | 경량 구조화 (US + AC) | 명확화 + 가정 탐색만 | 없음 |
| full  | Round 1-4 전체 | JUSF 전체 | 6유형 전체 | 3+ 옵션 + 매트릭스 |

```yaml
# Triage 출력 (기존 스키마 변경 없음)
triage_result:
  information_density: 3     # 기존
  interview_depth: full       # 기존 — PM 범위도 이것으로 결정
  pipeline_tier: standard     # F-20
```

### 2.3 왜 통합인가? (분리 대비 장점)

별도의 Step 0.5-PM과 mpl-pm 에이전트를 만드는 대신, mpl-interviewer에 PM 기능을 통합하는 이유:

| 관점 | 분리 (mpl-pm + Step 0.5) | 통합 (mpl-interviewer v2) |
|------|--------------------------|--------------------------|
| **사용자 경험** | 이중 인터뷰 피로: PM이 맥락 질문 → 다시 인터뷰어가 PP 질문 | 단일 인터뷰 세션에서 PP + 요구사항 동시 추출 |
| **중복 제거** | PP Round 2("절대 깨뜨리면 안 되는 것") ≈ PM 범위 정의 | PP 발견 과정이 자연스럽게 범위를 정의 |
| **파이프라인 복잡도** | 새 Step + 새 에이전트 + 새 Triage 필드 | 기존 Step 확장 + 에이전트 프롬프트 업데이트 |
| **interview_depth 활용** | `needs_pm` 별도 판정 필요 | 기존 `interview_depth`가 PM 범위도 제어 |
| **토큰 비용** | PM 인터뷰 ~2-4K + PP 인터뷰 ~2-4K | 통합 인터뷰 ~3-5K (중복 맥락 제거) |

핵심 통찰: **PP 발견 과정 자체가 요구사항 정의의 핵심 요소**이다.
- Round 1(What): 핵심 정체성 = PM의 "목적 정의"
- Round 2(What NOT): 불변 경계 = PM의 "범위 정의"
- Round 3(Tradeoffs): 우선순위 = PM의 "MoSCoW 분류"
- Round 4(Criteria): 판단 기준 = PM의 "인수 조건"

이를 분리하면 같은 정보를 두 번 묻게 되고, 사용자는 "아까 말했는데" 경험을 하게 된다.

### 2.4 왜 Pre-Triage(Step -2)가 아닌가?

PM을 Triage 이전에 배치하면 **정보 밀도 판단 없이 PM 실행 여부를 결정해야 하는 모순**이 발생한다. Triage가 이미 NLP 기반 분석을 수행하므로, `interview_depth`로 PM 범위를 제어하면 중복 분석을 제거하고 불필요한 오버헤드를 방지한다.

---

## 3. 에이전트 설계

### 3.1 mpl-interviewer v2 확장 사양

별도의 mpl-pm 에이전트를 생성하지 않는다. 기존 `mpl-interviewer.md`를 PM 기능으로 확장한다.

**기존 유지 사항**:
- 4 Rounds PP 인터뷰 구조
- AskUserQuestion 도구 활용
- Hypothesis-as-Options 패턴
- CONFIRMED / PROVISIONAL 분류
- PP 우선순위 정렬

**신규 추가 사항**:
- `interview_depth: light/full`일 때 요구사항 구조화 라운드 추가
- 소크라틱 질문 라이브러리 내장 (Section 6)
- JUSF 하이브리드 출력 생성
- MoSCoW + sequence_score 분류
- 증거 태깅 (🟢/🟡/🔴)
- 솔루션 옵션 제시 (full 모드)

```yaml
# mpl-interviewer.md 확장 (에이전트 메타데이터)
name: mpl-interviewer
description: PP 발견 + 요구사항 구조화를 위한 통합 인터뷰 전문가
model: opus                      # full 모드의 깊은 소크라틱 추론에 필요
disallowedTools:
  - Write
  - Edit
  - Bash
  - Task
```

| 속성 | 값 | 근거 |
|------|-----|------|
| **모델** | Opus (기본) / Sonnet (light 폴백) | PP 발견 + 소크라틱 추론의 깊이를 동시에 요구. full 모드에서 숨은 요구사항과 엣지 케이스 추출에 추론 깊이 필요 |
| **도구 제한** | Read-only + AskUserQuestion | 기존과 동일. 코드베이스 탐색은 허용하되 수정 불가. 인터뷰 전용 |
| **토큰 예산** | skip ~0.5K / light ~2K / full ~5K | interview_depth에 따라 적응형 |
| **역할 경계** | PP(불변 제약) + WHAT(무엇) + WHY(왜) 정의 | HOW(어떻게)는 Decomposer/Phase Runner의 영역. 기술 구현 지시 금지 |

### 3.2 모델 라우팅 정책

```
if interview_depth == "skip":
    model = "opus"              # PP 직접 추출 (기존과 동일, 빠르게 완료)
elif interview_depth == "light":
    model = "sonnet"            # PP Round 1-2 + 경량 요구사항 구조화
elif interview_depth == "full":
    model = "opus"              # PP 전체 + 깊은 소크라틱 추론 + 솔루션 옵션
```

### 3.3 실패 모드 회피 목록

에이전트 프롬프트에 명시적으로 포함할 회피 패턴:

| 실패 모드 | 설명 | 대응 |
|-----------|------|------|
| **범위 확산(Scope Creep)** | Must 항목이 5개 초과 | Must 재검토 강제 |
| **모호한 기준** | "잘 동작함", "빠르게" | 측정 가능한 기준만 허용 (숫자, 상태 코드, 파일 존재) |
| **기술 명세 침범** | "React 사용", "Redis 사용" | 행동만 명세, 구현 선택은 PP/Decomposer에 위임 |
| **페르소나 누락** | 정상 경로 사용자만 고려 | 최소 2개 시나리오 (정상 + 에러/엣지) |
| **엣지 케이스 무시** | US별 엣지 케이스 0건 | US당 최소 1개 엣지 케이스 필수 |
| **침묵 충돌** | 상충하는 요구사항을 조용히 선택 | 충돌 명시 + 사용자 확인 요청 |
| **이중 질문** | PP와 PM에서 같은 질문 반복 | PP 라운드에서 수집된 정보를 요구사항 구조화에 직접 재활용 |
| **인터뷰 피로** | 질문이 너무 많아 사용자가 지침 | depth별 소프트 리밋 + Continue Gate (사용자가 계속/중단 선택) |
| **질문 상한 자동 종료** | 사용자 의사와 무관하게 인터뷰가 끊김 | 소프트 리밋 도달 시 Continue Gate 제시 — 사용자가 연장 가능 |
| **불확실성 묵살 (skip)** | 상세 프롬프트에서 암묵적 가정/모호한 기준을 놓침 | skip 모드에서도 Uncertainty Scan으로 HIGH 불확실성 사전 식별 |

---

### 3.4 Continue Gate 설계

질문 상한은 **소프트 리밋**이다. 상한 도달 시 자동 종료 대신 사용자에게 선택권을 부여한다:

| depth | 소프트 리밋 | Continue Gate 동작 |
|-------|-----------|-------------------|
| skip | 3개 | Uncertainty Scan HIGH 항목 3개 후 → 남은 항목 있으면 Continue Gate |
| light | 4개 | PP Round 1-2 + 소크라틱 2개 후 → 남은 불확실성 있으면 Continue Gate |
| full | 10개 | PP 4 Round + 소크라틱 + 옵션 후 → 남은 불확실성 있으면 Continue Gate |

#### Continue Gate 선택지

| 선택 | 동작 |
|------|------|
| **계속 진행** | 남은 불확실 항목에 대해 추가 질문 수행. 다시 리밋 도달 시 Continue Gate 재제시. |
| **여기서 멈추기** | 남은 불확실 항목을 **Deferred Uncertainties**로 분류: |
| | - 관련 PP에 PROVISIONAL 태깅 + 불확실 사유 메모 |
| | - Side Interview 대상 목록에 등록 (실행 중 해당 Phase 진입 전 확인) |
| | - Pre-Execution Analysis에 uncertainty_notes로 전달 |
| **전체 종료** | 불확실 항목을 무시하고 현재 상태로 진행 |

#### Deferred Uncertainties 후속 해소 경로

```
인터뷰 중단
  ↓
pivot-points.md 하단에 "Deferred Uncertainties" 섹션 기록
  ↓
Step 1-B Pre-Execution Analysis에서 참조
  → 추가 risk 요인으로 반영
  → 해당 Phase의 risk_assessment에 +0.1 가산
  ↓
Step 4 Phase Execution 중 Side Interview 트리거
  → Deferred Uncertainties 목록의 해당 Phase 항목이 존재하면
  → Phase Runner 실행 전에 사용자에게 확인 질문
  → 응답으로 PROVISIONAL → CONFIRMED 승격 또는 PP 수정
```

이 설계의 핵심: **사용자가 인터뷰 피로를 느끼면 즉시 멈출 수 있고, 남은 불확실성은 실행 과정에서 필요한 시점에 just-in-time으로 해소**된다. 인터뷰에서 모든 것을 완벽하게 정의할 필요가 없다.

---

## 4. 통합 인터뷰 프로세스

기존 mpl-interviewer의 4-Round PP 인터뷰에 PM 기능을 자연스럽게 통합한다. AI_PM의 6-Step 프로세스를 별도 단계가 아닌 인터뷰 라운드 내에 흡수한다.

### 4.1 interview_depth별 통합 흐름

#### skip 모드 (+ Uncertainty Scan)
```
프롬프트에서 PP 직접 추출
  → Uncertainty Scan (5차원: 모호한 기준, 암묵적 가정, PP 충돌, 엣지 케이스, 미확정 기술 결정)
  → HIGH 0건: 질문 없이 진행 (MED/LOW는 Step 1-B에 uncertainty_notes 전달)
  → HIGH 1~3건: 각 항목에 대해 타겟 소크라틱 질문 (Hypothesis-as-Options)
  → HIGH 4건+: 상위 3건만 질문, 나머지는 PROVISIONAL 태깅
  → PP 보강 (criteria 구체화, priority 확정, 새 PP 추가)
  → Uncertainty Resolution Log 기록
  → PP 명세 출력
```

#### light 모드 (PP Round 1-2 + 경량 PM)
```
[Context Loading]
  코드베이스 구조, 기존 기능, 이전 PRD/메모리 참조

[Round 1: What — 핵심 정체성 + 목적 정의]
  Q1: Core Identity (기존 PP)
  Q2: Success Criteria (기존 PP)
  → PP 후보 추출 + JTBD 초안 도출

[Round 2: What NOT — 경계 + 범위 정의]
  Q3: Never Break (기존 PP)
  Q4: Destruction Scenario (기존 PP)
  → PP 불변 경계 확정 + Out of Scope 도출

[Requirement Structuring — 경량]
  소크라틱 질문 (명확화 + 가정 탐색만):
    Q5: "'{기능}'의 핵심 사용자 흐름은 구체적으로?" (Clarification)
    Q6: "숨어 있는 가정이 있는가?" (Assumption Probing)
  → User Stories + Acceptance Criteria (Gherkin) 생성
  → MoSCoW 분류 + sequence_score 할당
  → 증거 태깅 (🟢/🟡/🔴)

[Output]
  PP 명세 + 경량 PRD (YAML frontmatter + Markdown)
```

#### full 모드 (PP 전체 + 완전 PM)
```
[Context Loading]
  코드베이스 구조, 기존 기능, 이전 PRD/메모리, 실패 패턴 참조

[Round 1: What — 핵심 정체성 + 목적 정의]
  Q1: Core Identity (기존 PP)
  Q2: Success Criteria (기존 PP)
  → PP 후보 추출 + JTBD 초안 도출

[Round 2: What NOT — 경계 + 범위 정의]
  Q3: Never Break (기존 PP)
  Q4: Destruction Scenario (기존 PP)
  → PP 불변 경계 확정 + Out of Scope 도출

[Round 3: Either/Or — 우선순위 + MoSCoW 확정]
  Q5-Q7: PP 우선순위 비교 (기존)
  → PP 우선순위 확정 + Must vs Should vs Could 분류

[Round 4: How to Judge — 판단 기준 + AC 구체화]
  Q8-Q9: 위반 시나리오 (기존 PP)
  → PP 판단 기준 확정 + Gherkin AC 초안

[Socratic Deep Dive — 6유형 전체]
  Q10: Evidence — "이 기능이 필요한 근거는?" (증거 요구)
  Q11: Perspective — "API 소비자/운영자 관점에서는?" (관점 전환)
  Q12: Consequence — "이 기능 없이 어떤 일이 발생하는가?" (결과 탐색)
  Q13: Meta — "우리가 놓치고 있는 시나리오는?" (메타 질문)
  (명확화와 가정 탐색은 Round 1-2에서 이미 수행됨)

[Solution Options — 3+ 옵션 제시]
  Option A: Minimal, Option B: Balanced, Option C: Comprehensive
  Trade-off Matrix (Impact / Complexity / Risk / Token Cost / Test Coverage)
  사용자 선택

[Requirement Structuring — JUSF 전체]
  JTBD + User Stories + Gherkin AC + Edge Cases
  MoSCoW + sequence_score
  증거 태깅 + 다관점 검토

[Output]
  PP 명세 + 완전 PRD (Dual-Layer YAML + Markdown)
```

### 4.2 PP 라운드와 PM 질문의 자연스러운 매핑

| PP Round | PP 산출물 | PM 산출물 (자동 도출) |
|----------|----------|---------------------|
| Round 1: What | 핵심 정체성 PP | JTBD (situation, motivation, outcome) |
| Round 2: What NOT | 불변 경계 PP | Out of Scope, 제약 조건 |
| Round 3: Either/Or | PP 우선순위 | MoSCoW 분류 (Must는 최상위 PP와 정렬) |
| Round 4: How to Judge | 위반 판단 기준 | Acceptance Criteria (Gherkin 초안) |

이 매핑이 핵심 통찰이다: **PP 발견 과정에서 이미 요구사항의 골격이 형성된다.** PM 전용 질문은 이 골격을 보강하는 역할만 수행하면 된다.

### 4.3 Context Loading (컨텍스트 로딩)

인터뷰어가 추론 전에 수집하는 컨텍스트:

| 소스 | 내용 | 도구 |
|------|------|------|
| 사용자 요청 | 원문 + Triage 결과 | (오케스트레이터 주입) |
| 코드베이스 구조 | 디렉토리 트리, 핵심 파일 | Glob |
| 기존 기능 | 유사 기능 존재 여부 | Grep, Read |
| 이전 PRD | `.mpl/pm/requirements-*.md` | Read |
| 프로젝트 메모리 | `.mpl/memory/learnings.md` | Read |
| 이전 실패 패턴 | `.mpl/memory/procedural.jsonl` (F-25) | Read |

**목적**: 코드베이스에 이미 존재하는 기능, 패턴, 제약을 파악하여 소크라틱 질문의 근거를 마련한다.

### 4.4 솔루션 옵션 (full 모드 전용)

**항상 3개 이상의 솔루션 옵션**을 제시한다 (AI_PM 핵심 패턴). 코딩 맥락에서 이는 아키텍처/구현 접근법 대안이다.

```markdown
## Solution Options

### Option A: Minimal (최소 구현)
- 범위: 핵심 Must 항목만
- 예상 복잡도: S (1-2 Phase)
- 장점: 빠른 검증, 낮은 리스크
- 단점: 확장성 제한

### Option B: Balanced (균형)
- 범위: Must + Should 핵심
- 예상 복잡도: M (3-4 Phase)
- 장점: 적절한 커버리지
- 단점: 중간 토큰 비용

### Option C: Comprehensive (포괄)
- 범위: Must + Should + Could 일부
- 예상 복잡도: L (5+ Phase)
- 장점: 완전한 구현
- 단점: 높은 토큰 비용, 범위 확산 리스크
```

**Trade-off Matrix** (RICE 대신 코딩 맥락 적응):

| 기준 | Option A | Option B | Option C |
|------|----------|----------|----------|
| **Impact** (사용자 가치) | 3/5 | 4/5 | 5/5 |
| **Complexity** (구현 복잡도) | 1/5 | 3/5 | 5/5 |
| **Risk** (실패 리스크) | 1/5 | 2/5 | 4/5 |
| **Token Cost** (예상 토큰) | ~15K | ~35K | ~70K |
| **Test Coverage** (자동 검증 가능도) | 90% | 85% | 75% |

### 4.5 Multi-perspective Review (다관점 검토)

AI_PM의 3관점 검토를 코딩 에이전트 맥락에 적응한다:

| 관점 | 비즈니스 PM | MPL 인터뷰어 (코딩 맥락) |
|------|-----------|-------------------------|
| **Engineer** | 기술 실현 가능성 | 코드베이스 호환성, 의존성 충돌, 테스트 가능성 |
| **Executive** | 비즈니스 영향 | 구현 복잡도 대비 가치, 토큰 비용 정당성 |
| **Researcher** | 데이터 갭 | 불확실한 요구사항 식별, 증거 수준(🟢/🟡/🔴) 점검 |

인터뷰어는 3관점을 **단일 추론 체인 내에서 순차적으로 적용**한다 (별도 에이전트 호출 불필요). 검토 결과는 PRD 하단의 `## Review Notes` 섹션에 기록한다.

### 4.6 Save & Downstream Connection (저장 및 다운스트림 연결)

산출물 저장 위치:

```
.mpl/pm/
├── requirements-{hash}.md      # Dual-Layer PRD (YAML + Markdown)
├── socratic-log-{hash}.md      # 소크라틱 대화 로그 (결정 맥락 보존)
├── change-log.yaml             # 변경 관리 로그
└── good-examples/              # 자기 개선용 좋은 PRD 아카이브
    └── {date}-{topic}.md
```

다운스트림 연결은 [Section 7](#7-다운스트림-연결)에서 상세히 다룬다.

---

## 5. 출력 스키마

### 5.1 Dual-Layer PRD 전체 스키마

```markdown
---
# === YAML Frontmatter (Pipeline-Parseable) ===
pm_version: 2
request_hash: "abc123"
created_at: "2026-03-13T14:00:00Z"
model_used: opus
interview_depth: full             # skip / light / full
source_agent: mpl-interviewer     # 항상 mpl-interviewer

job_definition:
  situation: "새 서비스를 만들었지만 사용자 인증이 없음"
  motivation: "사용자별 데이터를 분리하고 보안을 확보하고 싶음"
  outcome: "사용자가 안전하게 자신의 데이터만 접근할 수 있음"

personas:
  - id: P-1
    name: "신규 사용자"
    description: "처음 서비스를 이용하는 사용자"
  - id: P-2
    name: "재방문 사용자"
    description: "기존 계정이 있는 사용자"

acceptance_criteria:
  - id: AC-1
    story: US-1
    description: "이메일/비밀번호로 회원가입"
    moscow: Must
    sequence_score: 1
    verification: A              # A (Agent) / S (Sandbox) / H (Human)
    evidence: green              # green / yellow / red
    gherkin: "Given no account exists, When user submits valid email+password, Then account is created and 201 returned"
  - id: AC-2
    story: US-1
    description: "중복 이메일 가입 방지"
    moscow: Must
    sequence_score: 2
    verification: A
    evidence: green
    gherkin: "Given account with email exists, When user submits same email, Then 409 Conflict returned"

out_of_scope:
  - item: "Admin 사용자 관리"
    reason: "별도 태스크로 분리"
    revisit: "v2"

risks:
  - id: R-1
    description: "세션 저장소 전략 미결정"
    severity: MED                # LOW / MED / HIGH
    mitigation: "PP로 분류하여 인터뷰에서 결정"

dependencies:
  - id: D-1
    description: "User 모델 생성"
    status: blocked              # available / blocked / unknown

pivot_point_candidates:
  - "세션 저장소: Redis vs In-Memory vs DB"
  - "토큰 전략: JWT vs Session Cookie"
  - "비밀번호 정책: 최소 요구사항 수준"

recommended_execution_order:
  - step: 1
    description: "User 모델 + 마이그레이션"
    stories: [US-1]
    complexity: S
  - step: 2
    description: "회원가입 엔드포인트"
    stories: [US-1]
    complexity: S
  - step: 3
    description: "로그인/로그아웃 + 세션"
    stories: [US-2, US-3]
    complexity: M

selected_option: B              # A / B / C (선택된 솔루션 옵션, full 모드만)
---

# Product Requirements: 사용자 인증

## Job Definition (JTBD)

**상황(When)**: 새 서비스를 만들었지만 사용자 인증이 없다.
**동기(I want to)**: 사용자별 데이터를 분리하고 보안을 확보하고 싶다.
**기대 결과(So I can)**: 사용자가 안전하게 자신의 데이터만 접근할 수 있다.

**증거 수준**: 🟢 High — 코드베이스에 인증 관련 코드 없음 확인

## Product Context

- **문제**: 모든 사용자가 동일한 데이터에 접근하여 데이터 격리 불가
- **타겟 사용자**: P-1(신규 사용자), P-2(재방문 사용자)
- **성공 메트릭**: 모든 AC 통과 + Gate 1(95%+) + 보안 취약점 0건

## User Stories

### US-1: 회원가입
- As a **신규 사용자**, I want to **이메일/비밀번호로 회원가입**, so that **서비스를 이용할 수 있다**
- Priority: **Must** | Sequence: 1
- Acceptance Criteria:
  - [AC-1] Given 계정 미존재, When 유효한 이메일+비밀번호 제출, Then 계정 생성 + 201 응답 — **A** 🟢
  - [AC-2] Given 이미 존재하는 이메일, When 회원가입 시도, Then 409 Conflict — **A** 🟢
  - [AC-3] Given 비밀번호 저장, When DB 조회, Then bcrypt 해시 패턴 일치 — **A** 🟢
- Edge Cases:
  - 비밀번호 8자 미만 → 400 Bad Request + 에러 메시지
  - 이메일 형식 오류 → 400 Bad Request + 검증 에러
  - 빈 요청 body → 400 Bad Request
  - 서버 DB 연결 실패 → 503 Service Unavailable

### US-2: 로그인
- (이하 동일 패턴)
...

## Scope

### In Scope (this iteration)
| ID | 항목 | Priority | Sequence | Verification |
|----|------|----------|----------|-------------|
| AC-1 | 이메일/비밀번호 회원가입 | Must | 1 | A |
| AC-2 | 중복 이메일 차단 | Must | 2 | A |
| AC-3 | 비밀번호 해싱 | Must | 3 | A |
| AC-4 | 로그인 | Must | 4 | A |
| AC-5 | 로그아웃 + 세션 관리 | Must | 5 | A |

### Out of Scope
- **Admin 사용자 관리** — 별도 태스크, v2에서 재검토
- **RBAC** — 별도 태스크, v2에서 재검토
- **소셜 로그인** — Could, 현재 범위 초과

## Risks & Dependencies
- [R-1] 세션 저장소 전략 미결정 — Severity: MED — Mitigation: PP로 분류하여 인터뷰에서 결정
- [D-1] User 모델 생성 — Status: blocked (선행 작업)

## Pivot Point 후보
> PP 인터뷰 라운드에서 PP와 함께 확정

- **PP-C1**: 세션 저장소 — Redis vs In-Memory vs DB
- **PP-C2**: 토큰 전략 — JWT vs Session Cookie

## Recommended Execution Order
1. User 모델 + 마이그레이션 (AC-1 선행 의존성) — Complexity: S
2. 회원가입 엔드포인트 (AC-1, AC-2, AC-3) — Complexity: S
3. 로그인/로그아웃 + 세션 관리 (AC-4, AC-5) — Complexity: M
4. 통합 테스트 — Complexity: S

## Socratic Dialogue Log
> 결정 맥락 보존 (AI_PM 패턴)

- **Q**: "모든 사용자가 이메일을 사용한다는 가정이 맞는가?" (Assumption Probing)
- **A**: 사용자 확인 — MVP에서는 이메일만, 소셜 로그인은 v2
- **Implication**: 소셜 로그인을 Out of Scope으로 분류

## Review Notes
- **Engineer 관점**: DB 마이그레이션이 선행 의존성. bcrypt 해싱은 표준적 접근.
- **Architect 관점**: 세션 저장소 결정이 전체 구조에 영향 — PP로 분류 적절.
- **User 관점**: 회원가입→로그인 순서가 자연스러운 사용자 흐름과 일치.
```

### 5.2 YAML Frontmatter 필수/선택 필드

| 필드 | 필수 | 설명 |
|------|------|------|
| `pm_version` | Y | 스키마 버전 (v2) |
| `request_hash` | Y | 요청 고유 식별자 |
| `interview_depth` | Y | skip / light / full |
| `source_agent` | Y | 항상 `mpl-interviewer` |
| `job_definition` | Y | JTBD 레이어 |
| `acceptance_criteria` | Y | 구조화된 AC 목록 |
| `out_of_scope` | Y | 명시적 제외 항목 |
| `pivot_point_candidates` | Y | PP 인터뷰에서 직접 연결 |
| `recommended_execution_order` | Y | Decomposer 힌트 |
| `personas` | N | 사용자 페르소나 (feature일 때 권장) |
| `risks` | N | 식별된 리스크 |
| `dependencies` | N | 의존성 |
| `selected_option` | N | 선택된 솔루션 옵션 (full 모드만) |

---

## 6. 소크라틱 질문 라이브러리

코딩 에이전트 맥락에 맞게 적응한 6유형별 질문 템플릿이다. 인터뷰어는 interview_depth와 정보 밀도에 따라 적절한 질문을 선택한다.

### 6.1 Clarification (명확화)

> 목적: 모호한 용어와 범위를 명확히 정의
> **사용**: light + full 모드

| 상황 | 질문 |
|------|------|
| 기능 범위 불명확 | "'{기능}'이란 구체적으로 어떤 사용자 흐름(user flow)을 의미하는가?" |
| 대상 불명확 | "이 기능의 사용자는 누구인가? (end-user / admin / API consumer / 모두)" |
| 성공 기준 없음 | "이 기능이 '완료'되었다고 판단하는 구체적인 기준은?" |
| 용어 모호 | "'{용어}'의 정의를 코드베이스 맥락에서 명확히 해달라" |

### 6.2 Assumption Probing (가정 도전)

> 목적: 사용자가 당연하게 여기는 가정을 노출
> **사용**: light + full 모드

| 상황 | 질문 |
|------|------|
| 입력 가정 | "모든 입력이 유효하다고 가정하고 있는가? 비정상 입력은 어떻게 처리?" |
| 환경 가정 | "이 기능이 작동해야 하는 환경은? (단일 서버 / 분산 / 오프라인)" |
| 데이터 가정 | "기존 데이터와의 호환성이 필요한가? 마이그레이션은?" |
| 동시성 가정 | "동시에 여러 사용자가 같은 리소스에 접근하면?" |
| 의존성 가정 | "코드베이스의 {모듈}에 기존 유사 기능이 있는데, 이를 활용할 것인가 새로 만들 것인가?" |

### 6.3 Evidence (증거 요구)

> 목적: 요구사항의 근거 확인, 증거 수준 태깅
> **사용**: full 모드 전용

| 상황 | 질문 |
|------|------|
| 필요성 근거 | "이 기능이 필요하다는 판단의 근거는? 기존 사용 패턴이나 에러 로그가 있는가?" |
| 우선순위 근거 | "이것이 Must인 이유는? 없으면 시스템이 실제로 사용 불가능한가?" |
| 성능 요구 | "성능 요구사항의 근거는? (현재 측정치, SLA, 사용자 기대)" |
| 보안 요구 | "보안 요구사항의 수준은? (내부 도구 / 공개 서비스 / 금융 데이터)" |

### 6.4 Perspective Shift (관점 전환)

> 목적: 다른 사용자/소비자 관점에서 요구사항 검토
> **사용**: full 모드 전용

| 상황 | 질문 |
|------|------|
| API 소비자 | "이 API를 소비하는 프론트엔드/모바일 개발자 관점에서 인터페이스가 직관적인가?" |
| 운영자 | "이 기능을 운영/디버깅해야 하는 사람 관점에서 로깅/모니터링이 충분한가?" |
| 신규 개발자 | "이 코드를 처음 보는 개발자가 이해할 수 있는 구조인가?" |
| 에러 사용자 | "기능이 실패했을 때 사용자가 받는 피드백은 충분한가?" |

### 6.5 Consequence (결과 탐색)

> 목적: 선택의 결과와 영향을 탐색
> **사용**: full 모드 전용

| 상황 | 질문 |
|------|------|
| 미구현 | "이 기능을 구현하지 않으면 어떤 일이 발생하는가? 대안은?" |
| 확장성 | "사용자/데이터가 10배 증가하면 이 설계가 유지되는가?" |
| 호환성 | "이 변경이 기존 API 소비자에게 breaking change인가?" |
| 의존성 | "이 라이브러리/프레임워크에 의존하면 장기적으로 어떤 제약이 생기는가?" |
| 테스트 | "이 기능의 테스트가 실패하면 어떤 기능이 함께 깨지는가?" |

### 6.6 Meta (메타 질문)

> 목적: 질문 프로세스 자체를 검증
> **사용**: full 모드 전용

| 상황 | 질문 |
|------|------|
| 누락 점검 | "우리가 고려하지 않은 사용자 시나리오가 있는가?" |
| 범위 확인 | "이 요구사항 목록에서 실제로는 불필요한 것이 있는가?" |
| 가정 재검토 | "지금까지의 논의에서 가장 불확실한 가정은 무엇인가?" |

---

## 7. 다운스트림 연결

인터뷰어 출력이 파이프라인 후속 단계에 흘러가는 구체적 매핑:

### 7.1 연결 매트릭스

```
Interviewer Output              →  Downstream Consumer           →  사용 방식
─────────────────────────────────────────────────────────────────────────────
acceptance_criteria.count       →  Triage (pipeline_score)       →  test_complexity 팩터 조정
pivot_point_candidates          →  PP 명세 (Step 1 내부)         →  인터뷰에서 직접 PP로 확정
out_of_scope                    →  Pre-Execution Analyzer        →  "Must NOT Do" 리스트 보강
risks + dependencies            →  Pre-Execution Analyzer        →  리스크 등급 입력
acceptance_criteria.gherkin     →  Verification Planner (3-B)    →  A/S/H 항목 사전 분류
recommended_execution_order     →  Decomposer (Step 3)           →  페이즈 순서 힌트
acceptance_criteria.gherkin     →  Test Agent (Step 4)            →  테스트 케이스 자동 생성
job_definition                  →  Phase 0 Enhanced (Step 2.5)   →  API Contract/Type Policy의 사용자 맥락
moscow + sequence_score         →  Decomposer                    →  Must 우선 분해, sequence_score로 정렬
```

### 7.2 Triage → Interviewer v2 → Decomposer 흐름

```
Step 0 Triage
├── information_density: 3
├── interview_depth: full        ← PP + PM 범위를 동시에 결정
├── Quick Scope Scan (pipeline_score)
└── Routing Pattern 매칭
         |
         v
Step 1 PP + Requirements Interview (mpl-interviewer v2)
├── [PP] Round 1-4 → PP 명세
├── [PM] 소크라틱 질문 → 요구사항 구조화
├── [PM] JUSF PRD 생성
├── [PM] AC-1~AC-5 (Gherkin 포함)
├── [PM] PP 후보 → 인터뷰 내에서 바로 PP로 확정
└── [PM] 실행 순서 권장
         |
         v
Step 2 Pre-Execution Analysis
├── PRD의 Out of Scope → "Must NOT Do" 보강
├── PRD의 Risks → 리스크 등급 입력
└── PRD의 JTBD → API Contract 맥락
         |
         v
Step 3 Decomposer
├── PRD의 recommended_execution_order → 페이즈 순서 힌트
├── PRD의 MoSCoW → Must 우선 분해
├── PRD의 Gherkin AC → 페이즈별 검증 기준
└── PP 명세 → 페이즈별 PP 위반 검사
```

### 7.3 Interviewer → Decomposer 연결

인터뷰어의 `recommended_execution_order`는 Decomposer에게 **힌트(suggestion)**로 제공된다. Decomposer는 코드베이스 의존성 분석을 바탕으로 이 순서를 수용하거나 재정렬할 수 있다.

```yaml
# decomposition.yaml에서 인터뷰어 출력 참조
phases:
  - id: phase-1
    name: "User 모델 + 마이그레이션"
    pm_source: "recommended_execution_order.step[0]"
    pm_stories: [US-1]
    acceptance_criteria: [AC-1, AC-2, AC-3]
    gherkin_tests:                  # Test Agent 직접 사용
      - "Given no account exists, When user submits valid email+password, Then account is created"
```

### 7.4 Interviewer → Test Agent 연결

인터뷰어의 Gherkin AC가 Test Agent에 직접 전달되어 테스트 자동 생성을 활성화한다:

```
Interviewer AC (Gherkin)
  "Given no account, When valid signup, Then 201 + account created"
       |
       v
Verification Planner (A/S/H 분류)
  AC-1: verification=A → Agent 자동 검증
       |
       v
Test Agent
  def test_signup_success():
      # Given no account
      # When valid signup
      response = client.post("/signup", json={"email": "...", "password": "..."})
      # Then 201 + account created
      assert response.status_code == 201
```

---

## 8. 적응형 깊이

### 8.1 interview_depth별 전체 동작 매트릭스

| 차원 | skip | light | full |
|------|------|-------|------|
| **PP Rounds** | 프롬프트 직접 추출 | Round 1-2 | Round 1-4 전체 |
| **Uncertainty Scan** | **✅ PP 추출 후 5차원 불확실성 검사** | PP 라운드에서 자연 해소 | PP 라운드에서 자연 해소 |
| **Job Definition** | 없음 | PP Round 1에서 자동 도출 | Full JTBD |
| **소크라틱 질문** | **불확실 HIGH 항목 한정 (0~3개)** | 명확화 + 가정 탐색 (2유형) | 6유형 전체 |
| **User Stories** | 없음 | 경량 구조화 | 전체 작성 |
| **Gherkin AC** | 없음 | 핵심 AC만 | 전체 + Edge Cases |
| **솔루션 옵션** | 없음 | 없음 | 3개+ |
| **PP 후보** | 프롬프트에서 추출 | Round 1-2에서 추출 | 전체 라운드에서 추출 + 확정 |
| **MoSCoW** | 없음 | 암시적 (Must만) | 명시적 분류 |
| **증거 태깅** | 없음 | 🟢/🔴만 | 🟢/🟡/🔴 전체 |
| **다관점 검토** | 없음 | 없음 | 3관점 전체 |
| **예상 토큰** | ~0.5K (불확실 0건) ~ ~1.5K (3건) | ~2K | ~5K |
| **모델** | Opus | Sonnet | Opus |

### 8.2 interview_depth 결정 기준 (Triage 기존 로직)

기존 Triage의 `interview_depth` 결정 로직을 그대로 활용한다. PM을 위한 별도 판정 로직이나 필드(`needs_pm`)는 추가하지 않는다.

```
interview_depth =
  if information_density >= 7:
    "skip"        # 요청이 이미 상세 → PP 직접 추출 + Uncertainty Scan
  elif information_density >= 4:
    "light"       # 적당히 상세 → PP 핵심 + 경량 요구사항
  else:
    "full"        # 모호한 요청 → PP 전체 + 완전 PM
```

> **Uncertainty Scan (skip 모드 보강)**: "정보 밀도가 높다"는 것은 양이 많다는 의미이지, 모든 것이 명확하다는 의미가 아니다. skip 모드에서도 PP 추출 후 5차원 불확실성 검사(모호한 기준, 암묵적 가정, PP 충돌, 엣지 케이스, 미확정 기술 결정)를 수행하고, HIGH 불확실성이 발견되면 해당 항목에 대해서만 타겟 소크라틱 질문을 수행한다(최대 3개). 이는 skip의 경량성을 유지하면서도 실행 단계의 circuit break/재분해를 예방한다. 상세 프로토콜은 `agents/mpl-interviewer.md`의 `<Uncertainty_Scan>` 섹션 참조.

### 8.3 Pipeline Tier와의 상호작용

| Pipeline Tier | interview_depth 경향 | PM 동작 |
|---------------|---------------------|---------|
| **Frugal** (< 0.3) | skip | PM 없음 (bugfix/config에 해당) |
| **Standard** (0.3~0.65) | light | 경량 요구사항 구조화 |
| **Frontier** (> 0.65) | full | 완전 소크라틱 + 솔루션 옵션 |

---

## 9. 자기 개선 루프

### 9.1 Good/Bad Examples 아카이브 (AI_PM 패턴)

인터뷰어의 PM 품질을 지속적으로 개선하기 위해, 실행 완료 후 PRD의 효과를 평가하고 아카이브한다.

```
.mpl/pm/
├── good-examples/
│   └── 2026-03-13-auth-system.md    # 성공 사례
└── bad-examples/
    └── 2026-03-10-search-filter.md  # 개선 필요 사례
```

**분류 기준**:

| 지표 | Good Example | Bad Example |
|------|-------------|------------|
| Phase 0 반복 횟수 | 0-1 | 3+ |
| 재분해 횟수 | 0 | 1+ |
| Gate 통과율 | 95%+ (1회) | 2회 이상 시도 |
| 사용자 수정 요청 | 0 | 2+ |

### 9.2 F-25 Memory 통합

인터뷰어의 PM 학습은 F-25(4-Tier Adaptive Memory)와 통합된다:

| Memory Tier | PM 기여 |
|-------------|---------|
| **episodic.md** | "이 유형의 요청에서 인터뷰어가 어떤 AC를 식별했고, 실제로 유용했는가" |
| **semantic.md** | "feature 요청은 항상 인증 관련 PP가 필요하다" (3회+ 반복 패턴) |
| **procedural.jsonl** | 인터뷰어 모델 선택, 인터뷰 깊이별 효과 (토큰 대비 Phase 0 반복 감소) |

### 9.3 프로파일링

PM 단계의 ROI를 정량적으로 측정한다:

```jsonl
{"timestamp":"2026-03-13T14:00:00Z","pm_enabled":true,"model":"opus","tokens_used":3500,"interview_depth":"full","stories_count":3,"ac_count":8,"phase0_iterations":1,"redecompose_count":0,"total_pipeline_tokens":45000}
```

프로파일은 `.mpl/mpl/profile/phases.jsonl`에 PM 단계로 기록되며, 대조군(PM 비활성)과 비교하여:
- Phase 0 반복 횟수 변화
- 재분해 횟수 변화
- 전체 토큰 사용량 변화
- 최종 Gate 통과율 변화

---

## 10. 변경 관리

### 10.1 3-Tier 변경 분류

실행 중 요구사항 변경 요청을 3단계로 분류한다:

| Tier | 이름 | 조건 | 대응 |
|------|------|------|------|
| **Tier 1** | Cosmetic | AC 수정 없음 (오타, 문구 변경) | 현재 페이즈에 즉시 반영. 버전 태그 불필요 |
| **Tier 2** | Scope Adjustment | AC 추가/삭제, Must→Should 변경 등 | 현재 페이즈 완료 후 반영. requirements-v{N}.md 스냅샷 + 영향 페이즈 식별 + 필요시 재분해 |
| **Tier 3** | Pivot | 핵심 JTBD 변경, PP 위반 | 즉시 실행 중단 + 인터뷰어 재인터뷰 + 전체 재분해 |

### 10.2 변경 감지 메커니즘

Side Interview(Step 4.3.5)에서 사용자의 변경 요청을 감지하면 다음 절차를 수행한다:

1. **Tier 분류**: AC 영향 범위로 자동 분류
2. **영향도 분석**: 어떤 페이즈/AC가 영향받는지 식별
3. **기록**: `.mpl/pm/change-log.yaml`에 기록

```yaml
# .mpl/pm/change-log.yaml
changes:
  - version: 2
    timestamp: "2026-03-13T15:30:00Z"
    tier: 2
    description: "소셜 로그인을 Must에서 Out of Scope으로 변경"
    affected_phases: [3, 4]
    affected_acs: [AC-7, AC-8]
    action: "Phase 2 완료 후 나머지 재분해"
    approved: true
```

### 10.3 Scope Creep 감지

사용자 입력에서 범위 확장 신호를 감지한다:

| 신호 패턴 | 예시 | 대응 |
|-----------|------|------|
| "이것도 추가로" | "이것도 추가로 비밀번호 찾기도 넣어줘" | Tier 2 변경으로 분류 + 확인 |
| "그러면서" | "그러면서 관리자 페이지도 만들어줘" | Tier 2/3 판정 + 경고 |
| 새로운 Must 추가 요청 | "이건 반드시 있어야 해" | Must 5개 초과 시 재검토 |

---

## 11. References

### 주요 참조

| 소스 | 핵심 기여 | 적용 위치 |
|------|----------|----------|
| **AI_PM** (kimsanguine/AI_PM) | 소크라틱 6유형, 6-Step 프로세스, 3+ 솔루션 옵션, 증거 태깅, good/bad 아카이브 | 전체 설계 철학, Section 4 소크라틱, Section 6, Section 9 |
| **UAM uam-pm** | Product Context, Edge Cases, PP 연결, MoSCoW, Failure Modes, Read-only 제약 | Section 3, 5 출력 스키마, 3.3 실패 모드 |
| **mpl-interviewer.md** | 4 Rounds PP 인터뷰, AskUserQuestion, Hypothesis-as-Options, interview_depth(skip/light/full) | Section 2, 3, 4 통합 인터뷰 프로세스의 기반 |
| **mpl-pm-skill-research** | JUSF 하이브리드, Dual-Layer, Triage 통합, 3-Tier 변경관리, MoSCoW+sequence_score | Section 4, 5, 8, 10 |
| **MPL design.md v3.2** | 파이프라인 아키텍처, A/S/H 검증, Phase 0 Enhanced, 3-Gate | Section 2, 7 다운스트림 연결 |
| **MPL roadmap overview** | F-26 정의, Adaptive Router, RUNBOOK, learnings.md | Section 2, 7, 9 |
| **ChatPRD** | AI PRD 생성 패턴 | Section 4 PRD 생성 참고 |
| **Haberlah (2026)** | AI Coding Agent용 PRD 원칙: 실행 가능한 명세 | Section 4, 5.1 스키마 설계 |
| **AGENTS.md 표준** | 벤더 중립적 에이전트 문서 형식 | 출력 포맷 호환성 |
| **JTBD + JUSF** | Job Definition + User Stories 하이브리드 | Section 4, 5.1 JTBD 레이어 |

### 관련 MPL 로드맵 항목

| ID | 항목 | PM 서브시스템과의 관계 |
|----|------|---------------------|
| F-20 | Adaptive Pipeline Router | Triage의 interview_depth가 PM 범위를 자연스럽게 제어 |
| F-22 | Routing Pattern Learning | interview_depth별 PM 효과를 routing pattern에 기록 |
| F-25 | 4-Tier Adaptive Memory | 인터뷰어 PM 학습을 episodic/semantic/procedural에 통합 |
| F-27 | Reflexion Fix Loop | 인터뷰어 AC가 Fix Loop 반성의 기준점 제공 |
| F-11 | Run-to-Run 학습 축적 | PM 효과 메트릭이 learnings.md에 축적 |

---

## 부록 A: 구현 우선순위

### Phase 1 (즉시 구현)

1. `mpl-interviewer.md` 확장: PM 기능 프롬프트 추가 (interview_depth별 분기)
2. JUSF 하이브리드 + Dual-Layer 출력 스키마 정의
3. 소크라틱 질문 라이브러리 (에이전트 프롬프트 내장)
4. PP 후보 → 인터뷰 내 PP 확정 연결
5. Gherkin AC → Test Agent 연결

### Phase 2 (단기 개선)

6. interview_depth별 적응형 인터뷰 흐름 최적화
7. 다운스트림 통합 완성 (모든 소비자 연결)
8. 프로파일링 메트릭 수집
9. 3-Tier 변경 관리 + change-log

### Phase 3 (장기)

10. Good/Bad Examples 아카이브 자동화
11. F-25 Memory 통합
12. MCP 기반 외부 도구 통합 포인트
13. PM 템플릿 라이브러리 (API/Frontend/Data Pipeline별)
