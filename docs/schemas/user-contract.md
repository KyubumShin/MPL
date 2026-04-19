# User Contract Schema (`user-contract.md`)

**생성 시점**: Phase 0 Step 1.5 (PP Discovery 완료 후, orchestrator inline loop + `mpl_classify_feature_scope` MCP tool)
**경로**: `.mpl/requirements/user-contract.md`
**소비자**: Decomposer (TODO `covers` 매핑), Test Agent (UC→E2E 커버리지), Hook `mpl-require-covers`, Hook `mpl-require-e2e` (@contract)
**재생성**: Finalize E2E fail classification C (missing capability) 시 축소 모드 재실행 (누락 UC만 append)
**관련**: 0.16 Resume Plan S1-2, Decision `2026-04-19-mpl-0.16-implementation-plan.md` Tier A'

## 개요

사용자가 원하는 가변(mutable) 기능 scope를 명세한다. **PP(불변)와는 파일이 분리**되며, UC는 included/deferred/cut 로 분류되어 협상 가능.

핵심 원칙:
1. **UC는 가변**. Phase 진행 중 deferred/cut 로 이동 가능 (사용자 승인 필요).
2. **PP 참조는 read-only**. UC가 PP를 변경하지 않음. 충돌 시 `pp_conflict_log`에 기록 후 사용자 재질문.
3. **모든 included UC는 covers_pp 최소 1개** (spec 외 feature도 어떤 PP 원칙 하에서 실행되는지 명시).
4. 순수 배관 작업은 UC 부여하지 않고 TODO에서 `covers: [internal]` 로 표시 (Tier B 스키마 참조).

## 스키마

```yaml
schema_version: 1
created_at: string                 # ISO 8601, orchestrator 작성 시각
iterations: number                 # MCP classify tool 호출 횟수 (최대 4)

user_cases:
  - id: "UC-01"                    # 형식 "UC-" + zero-padded 2자리 이상
    title: string                  # 한 줄 (≤ 80 chars)
    user_delta: string             # spec에 없지만 사용자가 추가 요구한 것. spec-only UC는 "" (empty)
    priority: "P0" | "P1" | "P2"   # P0=출시 필수, P1=핵심, P2=개선
    status: "included"             # 이 섹션은 included만. deferred/cut는 아래로 이동.
    covers_pp: ["PP-A", "PP-B"]    # 이 UC가 어떤 PP 원칙 하에 실행되는지 (최소 1개)
    acceptance_hint: string        # Test Agent가 E2E scenario로 확장할 힌트 (optional)

deferred_cases:                    # 다음 릴리즈 이후로 미룬 UC
  - id: "UC-09"
    title: string
    reason: string                 # 왜 미뤘는지 (용량/우선순위/리스크/의존성)
    revisit_at: string             # "post-v0.17" | "after-UC-03" | "on-user-request"
    source_round: number           # classify loop 몇 번째 iteration에서 deferred 판정

cut_cases:                         # 영구 제외된 UC (out-of-scope 확정)
  - id: "UC-12"
    title: string
    reason: string                 # 왜 잘랐는지 (PP 충돌/기술 불가/사용자 철회)
    source_round: number

scenarios:                         # E2E 시나리오 설계 힌트 (Decomposer/Test Agent 소비)
  - id: "SC-01"
    title: string
    covers: ["UC-01", "UC-03"]     # 이 시나리오가 검증하는 UC 목록 (≥ 1)
    covers_pp: ["PP-A"]            # 연관 PP (derived from covers UC의 covers_pp union)
    steps:
      - string                     # 순차 단계 (자연어 또는 Gherkin)
    skip_allowed:                  # 어떤 조건에서 skip 허용인지 (strict 디폴트는 skip 불가)
      - "ENV_API_DOWN"
      - "FLAKY_NETWORK"

pp_conflict_log:                   # UC와 PP 충돌 판정 기록 (MCP tool 출력 반영)
  - uc_id: "UC-05"
    pp_id: "PP-B"
    conflict_type: "direct" | "boundary" | "performance"
    resolution: "uc_dropped" | "uc_reshaped" | "pp_reaffirmed"
    round: number
    note: string

ambiguity_hints:                   # MCP tool이 Stage 2 Ambiguity Resolution에 넘기는 힌트
  - uc_id: "UC-07"
    dimension: "specificity" | "priority" | "dependency" | "boundary" | "success_criteria"
    suggestion: string
```

## 필드 설명

### `user_cases[*].user_delta`

Spec 문서 외에 **사용자가 인터뷰 중 새로 제시한 요구사항**을 기록. 이것이 ygg-exp11에서 "user-feature 포착 0건" gap을 직접 해결하는 필드.

- 값이 빈 문자열 `""` → spec에서 추출한 UC (delta 없음)
- 값이 있는 경우 → orchestrator가 `AskUserQuestion` 응답에서 이 UC가 새로 드러난 출처 문장을 요약

### `user_cases[*].covers_pp`

Decomposer와 Test Agent가 PP 준수 검증 시 UC→PP 매핑을 이용. **최소 1개 필수** — PP와 무관한 UC는 존재할 수 없다는 원칙(MPL coherence 보장).

매핑이 어려운 경우 `pp_conflict_log`에 기록하고 사용자 재질문.

### `scenarios[*].skip_allowed`

Tier C E2E gate에서 `@skip_reason` 값이 이 배열에 포함되면 환경 skip으로 인정 (카운터만 증가, Hard fail 아님). strict 디폴트이므로 비어 있으면 어떤 skip도 허용되지 않음.

### `pp_conflict_log[*].resolution`

- `uc_dropped` → UC가 cut_cases 로 이동
- `uc_reshaped` → UC title/delta 수정 후 included 유지
- `pp_reaffirmed` → PP 유지, UC 쪽이 잘라냄 (PP는 불변 원칙 재확인)

## Producer Input

`mpl_classify_feature_scope` MCP tool 입력:

```json
{
  "spec_text": "string (raw spec or PRD content)",
  "pivot_points": "string (pivot-points.md content)",
  "user_responses": [
    { "question": "...", "answer": "..." }
  ],
  "prev_contract": "string | null (prior iteration's user-contract.md, if any)",
  "cwd": "string"
}
```

MCP tool 출력 (orchestrator가 받아 user-contract.md 로 직렬화):

```json
{
  "user_cases": [...],
  "deferred": [...],
  "cut": [...],
  "scenarios": [...],
  "pp_conflict": [...],
  "ambiguity_hints": [...],
  "next_question": { "kind": "clarify|priority|conflict", "payload": {...} } | null,
  "convergence": boolean
}
```

`convergence == true` 일 때까지 orchestrator가 `AskUserQuestion` → MCP tool 재호출 루프 (최대 4 iteration).

## Consumer Contract

### Decomposer 소비

- 각 node (TODO/phase) 는 `covers: [UC-N]` 필드 필수 (Tier B 스키마 참조)
- 순수 배관 작업은 `covers: [internal]` (단일 escape)
- Decomposer prompt는 user-contract.md 의 `user_cases[*].id` 전체를 read-only 참조로 받음

### Test Agent 소비

- 각 UC에 대해 최소 1개의 E2E scenario 필요 (Tier C 스키마 참조)
- `scenarios[*].steps` 를 Gherkin으로 확장
- `acceptance_hint` 를 추가 검증 조건으로 활용

### Hook 소비

- `mpl-require-covers.mjs` — TODO `covers` 값이 user_cases[*].id 또는 `[internal]` 인지 검증
- `mpl-require-e2e.mjs` — included user_cases 전체에 대해 @contract(UC-N) 커버리지 diff 계산
- `mpl-validate-pp-schema.mjs` (S1-3 신설) — pivot-points.md 에 UC 필드가 섞여 들어가지 않는지 guard

## 불변/가변 경계 규칙

| 파일 | 분류 | 변경 조건 |
|------|------|----------|
| `.mpl/pivot-points.md` | **불변** | PP Discovery 완료 후 수정 금지 (Step 1-D PP Confirmation에서만 재협상) |
| `.mpl/requirements/user-contract.md` | **가변** | Step 1.5 재실행, Finalize classification C 축소 모드, 사용자 명시 요청 시 |

**교차 참조 금지**: user-contract.md 가 PP를 수정하거나, pivot-points.md 가 UC를 포함하면 Hook이 block.

## Backward Compatibility

- 기존 0.15.x 프로젝트 업그레이드 시 `.mpl/requirements/user-contract.md` 부재 → orchestrator가 graceful skip 모드 (light contract: UC 0개, scenarios는 spec에서 자동 추출)
- 이 경우 `iterations: 0`, `user_cases: []`, `scenarios: [...auto-extracted]`
- `mpl-doctor` 가 업그레이드 프롬프트 제공: "user-contract.md 가 없습니다. `/mpl:mpl` 재실행으로 Step 1.5 를 수행하시겠습니까?"

## 관련 문서

- Decision: `~/project/decision/2026-04-19-mpl-0.16-implementation-plan.md` (Tier A')
- Resume Plan: `~/project/wiki/scratch/2026-04-19/mpl-0.16-implementation-resume-plan.md` §3 S1-2
- Tier B 스키마: `docs/schemas/decomposition.md` (S1-4에서 `covers` 필드 추가)
- Tier C 스키마: `docs/schemas/e2e-contract.md` (S1-6에서 신설)
