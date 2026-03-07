---
description: MPL Pivot Point discovery through structured interview - define immutable constraints before planning
---

# MPL Pivot Points Interview

Pivot Points(PP)는 프로젝트 전체에서 **절대 변하지 않는 제약**이다.
이 스킬은 구조화된 인터뷰를 통해 PP를 발견하고 정의한다.

## When to Use

- MPL 파이프라인 시작 전 (Phase 1 이전)
- PP가 명확하지 않을 때
- 새 프로젝트나 대규모 방향 전환 시
- `/mpl:mpl` 실행 시 PP가 없으면 자동으로 이 스킬을 먼저 실행

## Triage Integration

When invoked from the MPL pipeline, the Triage step determines interview depth:

| Triage Result | Interview Behavior |
|---------------|-------------------|
| `interview_depth: "full"` | All 4 rounds (default behavior) |
| `interview_depth: "light"` | Round 1 (What) + Round 2 (What NOT) only. Skip Either/Or and How to Judge. |
| `interview_depth: "skip"` | No interview. Extract PPs directly from the user's prompt. Generate PP candidates from explicit constraints in the prompt, then proceed to PP Confirmation (Step 1-D). |

When `interview_depth` is provided in the invocation context, respect it:
- `"light"`: After Round 2, generate PP candidates and skip to Output.
- `"skip"`: Parse the user prompt for constraint-like statements, generate PP candidates directly, skip to Output.

## Interview Protocol

### Round 1: 본질 탐색 (What)

프로젝트의 핵심 정체성을 파악한다.

```
AskUserQuestion: "이 프로젝트의 핵심 정체성은 무엇인가요?"
Options:
  1. {프로젝트 설명에서 추론한 정체성 A}
  2. {프로젝트 설명에서 추론한 정체성 B}
  3. (사용자 직접 입력)
```

**추론 방법**: 코드베이스 탐색 (explore 에이전트) + README/CLAUDE.md 분석으로 후보를 미리 파악한다.

이어서:
```
AskUserQuestion: "이 프로젝트에서 가장 중요한 가치는?"
Options:
  1. "사용자 경험 (UX)"
  2. "성능/속도"
  3. "안정성/신뢰성"
  4. (사용자 직접 입력)
```

### Round 2: 경계 탐색 (What NOT)

변하면 안 되는 것을 찾는다.

```
AskUserQuestion: "이 기능을 추가하면서 절대 잃으면 안 되는 것은?"
Options:
  1. {Round 1 답변에서 추론한 제약 A}
  2. {Round 1 답변에서 추론한 제약 B}
  3. {코드베이스에서 발견한 핵심 패턴}
  4. (사용자 직접 입력)
```

```
AskUserQuestion: "어떤 변경이 이 프로젝트를 망칠 수 있나요?"
Options:
  1. {추론한 위험 시나리오 A}
  2. {추론한 위험 시나리오 B}
  3. (사용자 직접 입력)
```

### Round 3: 트레이드오프 탐색 (Either/Or)

PP 간 우선순위를 확인한다.

```
AskUserQuestion: "{PP-A}와 {PP-B}가 충돌하면 어느 쪽을 우선하나요?"
Options:
  1. "{PP-A} 우선"
  2. "{PP-B} 우선"
  3. "상황에 따라 다름" → 판정 기준 추가 질문
```

이 라운드는 PP가 2개 이상일 때만 실행한다.
모든 PP 쌍에 대해 우선순위를 확인한다 (N*(N-1)/2 쌍).

### Round 4: 구체화 (How to Judge)

각 PP의 위반 판정 기준을 구체화한다.

```
AskUserQuestion: "'{PP-1 원칙}'을 어떻게 판단할 수 있을까요?"
Options:
  1. {추론한 판정 기준 A} (예: "클릭 수 증가하면 위반")
  2. {추론한 판정 기준 B} (예: "로딩 시간 2초 초과하면 위반")
  3. (사용자 직접 입력)
```

**판정 기준이 모호한 경우**: 사용자가 명확하게 답하지 못하면 아래 전략을 사용한다.

### Unclear PP 처리 전략

PP가 명확하지 않은 경우 3단계로 접근한다:

#### 전략 1: 예시 기반 구체화
```
AskUserQuestion: "다음 중 {PP 원칙}을 위반하는 것은?"
Options:
  1. "설정 메뉴를 3depth로 분리" → 위반?
  2. "키보드 단축키 추가" → 위반?
  3. "사이드바 상시 표시" → 위반?
```
사용자의 위반/비위반 판단에서 패턴을 추출하여 판정 기준을 역으로 도출한다.

#### 전략 2: 임시 PP로 진행
```
PP-2: 에디터 본질 유지 (PROVISIONAL)
- 원칙: 텍스트 편집이 핵심이며 부가 기능에 밀리지 않아야 한다
- 판정 기준: [미정 — Phase 2에서 Discovery 발생 시 재논의]
- 상태: PROVISIONAL (확정 전까지 soft 제약)
```

PROVISIONAL PP는:
- Discovery 충돌 시 **자동 반려하지 않고 HITL로 넘긴다**
- Phase 2 진행 중 구체적 사례가 나오면 판정 기준을 확정한다
- Phase 3 진입 전까지 CONFIRMED로 전환해야 한다

#### 전략 3: PP 없이 시작
PP를 정의할 수 없는 탐색 초기 단계에서는:
```json
{
  "maturity_mode": "explore",
  "pivot_points": [],
  "pp_status": "deferred"
}
```
explore 모드에서 PP 없이 시작하고, Phase 2 진행 중 발견되는 패턴에서 PP 후보를 추출한다.

## Output

인터뷰 완료 후 `.mpl/pivot-points.md`를 생성한다:

```markdown
# Pivot Points

## PP-1: {제목}
- 원칙: {변하지 않아야 하는 것}
- 판정 기준: {구체적 위반 조건}
- 우선순위: 1 (최고)
- 상태: CONFIRMED
- 위반 예시: {예시}
- 허용 예시: {예시}

## PP-2: {제목}
- 원칙: ...
- 판정 기준: ...
- 우선순위: 2
- 상태: PROVISIONAL (판정 기준 미확정)
- 위반 예시: {예시}
- 허용 예시: {예시}

## Priority Order
PP-1 > PP-2 > PP-3
(충돌 시 상위 PP 우선)
```

그리고 PLAN.md의 `## Pivot Points` 섹션에 동일 내용을 삽입한다.

## Integration with MPL Pipeline

```
/mpl:mpl-pivot (이 스킬)
     │
     ▼
.mpl/pivot-points.md 생성
     │
     ▼
/mpl:mpl (Phase 1)
     │
     ├── PM이 pivot-points.md 참조하여 PLAN.md 작성
     ├── PLAN.md에 ## Pivot Points 섹션 포함
     │
     ▼
Phase 2: Worker discoveries → PP 충돌 검사
     │
     ├── CONFIRMED PP 충돌 → 자동 반려
     ├── PROVISIONAL PP 충돌 → HITL로 판단 요청
     └── PP 없음 (explore) → 모든 discovery 허용
```

## Standalone Usage

MPL 파이프라인 없이도 사용 가능:
- 프로젝트 초기 방향성 정의
- 기존 프로젝트의 암묵적 제약 명문화
- 팀 온보딩 시 핵심 원칙 공유 문서 생성
