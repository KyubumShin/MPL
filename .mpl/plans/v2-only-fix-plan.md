# v2-only 브랜치 수정 계획

> 생성일: 2026-04-04
> 대상 브랜치: `v2-only`
> 목표: v2 설계(Hat+Floor, 3 Hard Gate, 17→8 에이전트)에 맞춰 잔존 v1 용어/구조를 정리

## 현재 상태 요약

- 테스트 전체 통과 (v1 구조 기준으로는 정상)
- v2 설계 변경사항이 docs/design.md에 기술되어 있으나 실제 코드/프롬프트/테스트에는 미반영
- `pipeline_tier` (frugal/standard/frontier), `escalateTier`, 5-Gate 용어가 코드/문서 전체에 잔존
- 삭제 대상 7개 에이전트 파일이 여전히 존재하고 참조도 남아있음

## 검증 결과

| 이슈 | 보고된 상태 | 실제 확인 결과 |
|------|------------|---------------|
| #1 VALIDATE_AGENTS count mismatch | 코드 9, 테스트 8 | 현재 코드/테스트 모두 16으로 일치 (통과). v2 적용 시 변경 필요 |
| #2 phase-controller gate keys | old key 사용 | 소스와 테스트 모두 `gate1_passed` 사용 (통과). v2에서 `hard1_passed`로 변경 필요 |
| #3 7개 에이전트 파일 존재 | 삭제 미완 | 확인 — 7개 모두 존재 |
| #4 routing-patterns.mjs old tier | 12+ 곳 | 확인 — `tier` 파라미터, `pipeline_tier` JSDoc 등 12회 |
| #5 mpl-run-finalize.md old refs | escalateTier, gate keys | `gate1_pass_rate`(L459), `tier={tier}`(L588), `5-Gate`(L397) 확인. escalateTier는 해당 파일에 없음 |
| #6-14 MEDIUM/LOW | 각종 old term | 모두 확인됨 (상세 아래 참조) |

**추가 발견**: 보고된 14개 이슈 외에 다음 파일에도 old terminology 잔존:
- `hooks/lib/mpl-state.mjs` — `pipeline_tier`, `tier_hint`, `escalateTier` 함수 정의 (핵심 런타임)
- `hooks/lib/mpl-scope-scan.mjs` — `pipeline_tier`, frugal/standard/frontier 분류 로직
- `hooks/mpl-phase-controller.mjs` — `pipeline_tier`, `escalateTier` 호출
- `hooks/mpl-keyword-detector.mjs` — tier hint 로직
- `hooks/mpl-hud.mjs` — `pipeline_tier` 표시
- `mcp-server/src/lib/state-manager.ts` + `dist/` — `pipeline_tier`, `tier_hint`, gate 키
- `commands/mpl-run.md`, `mpl-run-phase0.md`, `mpl-run-execute.md` — 대량의 pipeline_tier 참조
- `docs/design.md` — 에이전트 목록, Gate 구조 설명
- `docs/config-schema.md`, `docs/pm-design.md` — pipeline_tier 참조
- `README.md`, `README_ko.md` — 삭제 에이전트 참조, old gate 구조

---

## CRITICAL (테스트 & 핵심 런타임)

### T-01: state schema — gate_results 키 변경

**파일**: `hooks/lib/mpl-state.mjs`
**현재**: L39-43 — `gate_results: { gate1_passed, gate2_passed, gate3_passed }`
**변경**: `gate_results: { hard1_passed, hard2_passed, hard3_passed }`
- L24의 `pipeline_tier` → `pp_proximity` 변경은 T-07에서 처리
- L25의 `tier_hint` → 제거 또는 `pp_hint`로 변경은 T-07에서 처리
- L152의 `pipeline_tier` 직렬화도 T-07에서 처리
**결과**: state.json의 gate 키가 v2 3-Hard Gate 명명 규칙을 따름

### T-02: phase-controller — gate key 및 tier 참조 변경

**파일**: `hooks/mpl-phase-controller.mjs`
**현재**:
- L77: `gates.gate1_passed, gates.gate2_passed, gates.gate3_passed`
- L88-90: 같은 키 참조
- L247: 초기값 `gate0_5_passed, gate1_passed, gate1_5_passed, gate2_passed, gate3_passed`
- L269, 296: `state.pipeline_tier` 참조
- L271, 298: `escalateTier()` 호출
- L392, 399: `smallGate.gate2_passed`
**변경**:
- 모든 `gateN_passed` → `hardN_passed` (gate0_5, gate1_5 제거)
- `pipeline_tier` → `pp_proximity`
- `escalateTier` → v2 대체 로직 (Hat model escalation 또는 제거)
**결과**: phase-controller가 v2 gate/routing 체계를 사용

### T-03: phase-controller 테스트 — gate key 업데이트

**파일**: `hooks/__tests__/mpl-phase-controller.test.mjs`
**현재**: L85, 93, 101, 109 — `gate1_passed`, `gate2_passed`, `gate3_passed`
**변경**: 모든 gate 키를 `hard1_passed`, `hard2_passed`, `hard3_passed`로 변경
**의존**: T-02 완료 후
**결과**: 테스트가 v2 gate key를 검증

### T-04: validate-output — 삭제 에이전트 제거

**파일**: `hooks/mpl-validate-output.mjs`
**현재**: VALIDATE_AGENTS에 16개 에이전트, EXPECTED_SECTIONS에도 대응 항목
**변경**:
- VALIDATE_AGENTS에서 7개 제거: `mpl-pre-execution-analyzer`, `mpl-scout`, `mpl-code-reviewer`, `mpl-compound`, `mpl-verification-planner`, `mpl-qa-agent`, `mpl-phase-seed-generator`
- EXPECTED_SECTIONS에서도 해당 7개 항목 제거
- 남은 에이전트: `mpl-phase-runner`, `mpl-interviewer`, `mpl-ambiguity-resolver`, `mpl-doctor`, `mpl-test-agent`, `mpl-decomposer`, `mpl-git-master`, `mpl-codebase-analyzer`, `mpl-phase0-analyzer` (9개)
**결과**: validation이 v2 에이전트 목록만 대상으로 함

### T-05: validate-output 테스트 — 에이전트 목록 업데이트

**파일**: `hooks/__tests__/mpl-validate-output.test.mjs`
**현재**: L89-94 — expected 배열에 16개 에이전트
**변경**:
- expected 배열을 v2 9개 에이전트로 축소
- L118 `pre-execution-analyzer should have 7 sections` 테스트 케이스 삭제 (에이전트 삭제됨)
- 삭제된 에이전트를 "should not contain" 테스트에 추가 가능
**의존**: T-04 완료 후
**결과**: validate-output 테스트가 v2 에이전트 셋을 검증

### T-06: MCP server state manager — schema 업데이트

**파일**: `mcp-server/src/lib/state-manager.ts`
**현재**:
- L16: `pipeline_tier: string | null`
- L18: `tier_hint: string | null`
- L31-33: `gate1_passed`, `gate2_passed`, `gate3_passed`
- L62: `pipeline_tier: null`
- L64: `tier_hint: null`
- L77-79: gate 초기값
**변경**:
- `pipeline_tier` → `pp_proximity`
- `tier_hint` → 제거
- `gateN_passed` → `hardN_passed`
- `dist/` 재빌드 필요
**결과**: MCP server가 v2 state schema를 사용

---

## HIGH (에이전트 파일 삭제 및 핵심 런타임 모듈)

### T-07: mpl-state.mjs — pipeline_tier/escalateTier 전면 마이그레이션

**파일**: `hooks/lib/mpl-state.mjs`
**현재**:
- L24: `pipeline_tier: null` 필드
- L25: `tier_hint: null` 필드
- L152: serialize에서 `pipeline_tier` 보존
- L189-206: `escalateTier()` 함수 전체 (frugal→standard→frontier 에스컬레이션)
- L373: `pipeline_tier: null` 필드
**변경**:
- `pipeline_tier` → `pp_proximity` (값: `pp_core`/`pp_adjacent`/`non_pp`)
- `tier_hint` → 제거
- `escalateTier()` → 제거 또는 `escalateProximity()`로 대체 (Hat model 기반)
**결과**: 핵심 state 모듈이 v2 Hat model을 사용

### T-08: mpl-scope-scan.mjs — tier 분류 로직 변경

**파일**: `hooks/lib/mpl-scope-scan.mjs`
**현재**: frugal/standard/frontier 3단계 분류 로직 전체 (L5, 13-15, 55-65, 76-97)
**변경**: pp_core/pp_adjacent/non_pp 분류로 전환, 또는 Hat model 입력으로 변경
**결과**: Quick Scope Scan이 v2 분류 체계를 출력

### T-09: mpl-keyword-detector.mjs — tier hint 변경

**파일**: `hooks/mpl-keyword-detector.mjs`
**현재**: L174-176 — `tierHint = 'frugal'`, L188 — `pipeline_tier (frugal/standard/frontier)` 문자열
**변경**: v2 분류 체계로 교체 또는 hint 로직 제거
**결과**: keyword detector가 v2 분류를 사용

### T-10: mpl-hud.mjs — tier 표시 변경

**파일**: `hooks/mpl-hud.mjs`
**현재**: L361, 396 — `formatTier(state.pipeline_tier)` 호출
**변경**: `pp_proximity` 기반 표시로 변경
**결과**: HUD가 v2 분류를 표시

### T-11: mpl-routing-patterns.mjs — tier 용어 전면 교체

**파일**: `hooks/lib/mpl-routing-patterns.mjs`
**현재**: `tier` 파라미터 12회 (L6, 59, 60, 75, 76, 89, 121, 123, 137, 142, 152, 156, 158)
**변경**:
- JSDoc, 파라미터명, 반환값에서 `tier` → `proximity` (또는 `pp_class`)
- `by_tier` → `by_proximity`
- `pipeline_tier` JSDoc 참조 제거
**결과**: routing patterns 모듈이 v2 용어를 사용

### T-12: 7개 에이전트 .md 파일 삭제

**파일** (모두 삭제):
1. `agents/mpl-pre-execution-analyzer.md`
2. `agents/mpl-scout.md`
3. `agents/mpl-code-reviewer.md`
4. `agents/mpl-compound.md`
5. `agents/mpl-verification-planner.md`
6. `agents/mpl-qa-agent.md`
7. `agents/mpl-phase-seed-generator.md`
**의존**: T-04 완료 후 (validate-output에서 참조 제거 먼저)
**결과**: v2 에이전트 셋(9개)만 남음

### T-13: design.md — 에이전트 목록 및 Gate 구조 업데이트

**파일**: `docs/design.md`
**현재**:
- L270: "14 specialized agents" 카운트
- L272-283: Pre-Execution Agents 테이블에 삭제 대상 포함
- L285-291: Execution Agents에 mpl-code-reviewer 포함
- L293-298: Post-Execution에 mpl-compound 포함
- L342-344: 5-Gate 역사 설명
- L346: Gate 2 → mpl-code-reviewer 참조
- L353: mpl-verification-planner 참조
- L528: V-02 Gate 0.5 참조
- L542: mpl-run-execute-gates.md Gate 0.5 참조
- L680, 686: mpl-scout 참조
- L908: `maturity_mode × pipeline_tier` → Hat model
- L918: `pipeline_tier → pp_proximity` breaking change 기술
**변경**: 에이전트 목록을 9개로 축소, Gate 구조를 3H+1A로 업데이트, 삭제 에이전트 참조 제거/역사 노트화
**결과**: design.md가 v2 구조를 정확히 반영

### T-14: README.md / README_ko.md — 삭제 에이전트 및 old gate 참조 업데이트

**파일**: `README.md`, `README_ko.md`
**현재**:
- README.md: L124 (3H+1A Gate 0.5 언급), L161 (Gate 0.5 ASCII), L306 (Gate 0.5 테이블), L340 (mpl-scout), L384-392 (Gate 0.5, mpl-scout, mpl-compound), L423 (pipeline_tier)
- README_ko.md: L92 (Gate 0.5), L129 (Gate 0.5 ASCII), L274 (Gate 0.5 테이블), L308 (mpl-scout), L343-351 (Gate 0.5, mpl-compound, mpl-scout), L364 (pipeline_tier)
**변경**: Gate 0.5 → Hard 1 / Advisory로 변경, 삭제 에이전트 참조 제거, pipeline_tier → pp_proximity
**결과**: README가 v2 구조를 반영

---

## MEDIUM (커맨드/스킬 프롬프트)

### T-15: commands/mpl-run-finalize.md — old gate keys 및 tier 참조

**파일**: `commands/mpl-run-finalize.md`
**현재**:
- L397: `"5-Gate Quality Results"` 문자열
- L458-461: `gate1_pass_rate`, `gate2_verdict`, `gate3_pass`
- L533, 561, 576: `pipeline_tier` 참조
- L588: `tier={tier}` 로그 메시지
**변경**: gate 키를 hard1/2/3 체계로, `pipeline_tier` → `pp_proximity`, `5-Gate` → `3H+1A Gate`
**결과**: finalize 프롬프트가 v2 체계를 사용

### T-16: commands/mpl-run-phase0.md — pipeline_tier 대량 참조

**파일**: `commands/mpl-run-phase0.md`
**현재**: L240, 244, 299, 310-313, 333-342, 349, 355, 506, 574 — `pipeline_tier` 30회 이상
**변경**: 전체 `pipeline_tier` → `pp_proximity`, tier 값을 Hat model 값으로 교체
**결과**: Triage 프롬프트가 v2 분류 체계를 사용

### T-17: commands/mpl-run-execute.md — pipeline_tier/escalateTier 참조

**파일**: `commands/mpl-run-execute.md`
**현재**: L60, 205, 576 (`tier:frontier`), L807-815 (`pipeline_tier`, `escalateTier`), L877
**변경**: `pipeline_tier` → `pp_proximity`, `escalateTier` → v2 대체, `tier:frontier` JSON 예시 업데이트
**결과**: execute 프롬프트가 v2 체계를 사용

### T-18: commands/mpl-run-execute-parallel.md — 5-Gate 참조

**파일**: `commands/mpl-run-execute-parallel.md`
**현재**: L11 — `mpl-run-execute-gates.md (5-Gate system)`
**변경**: `5-Gate system` → `3H+1A Gate system`
**결과**: cross-reference가 v2 용어를 사용

### T-19: commands/mpl-run-execute-context.md — 5-Gate 참조

**파일**: `commands/mpl-run-execute-context.md`
**현재**: L10 — `mpl-run-execute-gates.md (5-Gate system)`
**변경**: `5-Gate system` → `3H+1A Gate system`
**결과**: cross-reference가 v2 용어를 사용

### T-20: commands/mpl-run.md — pipeline_tier 참조

**파일**: `commands/mpl-run.md`
**현재**: L128 — `Triage (Step 0) determines pipeline_tier via Quick Scope Scan`
**변경**: `pipeline_tier` → `pp_proximity`
**결과**: run 진입점 프롬프트가 v2 용어를 사용

### T-21: skills/mpl/SKILL.md — tier_hint 참조

**파일**: `skills/mpl/SKILL.md`
**현재**: L12 — `tier_hint`, L14 — `pipeline_tier`, L16 — `pipeline_tier`
**변경**: `tier_hint` → 제거 또는 `pp_hint`, `pipeline_tier` → `pp_proximity`
**결과**: 메인 스킬 프롬프트가 v2 용어를 사용

### T-22: skills/mpl-small/SKILL.md — tier 3회

**파일**: `skills/mpl-small/SKILL.md`
**현재**: L2 (`standard tier`), L8 (`appropriate tier`), L9 (`standard tier`), L11 (`tier_hint: "standard"`)
**변경**: tier → pp_proximity 체계로 변경 (deprecated 스킬이지만 redirect 설명 업데이트)
**결과**: deprecated 스킬의 redirect 설명이 v2 용어를 사용

### T-23: skills/mpl-setup/SKILL.md — maturity_mode 참조

**파일**: `skills/mpl-setup/SKILL.md`
**현재**: L90 — `"maturity_mode": "standard"`
**변경**: `maturity_mode` 필드 제거 (v2에서 제거됨)
**결과**: config 예시에서 삭제된 옵션이 제거됨

### T-24: skills/mpl-pivot/SKILL.md — maturity_mode 참조

**파일**: `skills/mpl-pivot/SKILL.md`
**현재**: L136 — `"maturity_mode": "explore"`
**변경**: `maturity_mode` 필드 제거
**결과**: pivot 예시에서 삭제된 옵션이 제거됨

### T-25: skills/mpl-status/SKILL.md — old gate 템플릿

**파일**: `skills/mpl-status/SKILL.md`
**현재**: L53-57 — Gate 0.5, Gate 1, Gate 1.5, Gate 2, Gate 3 출력 템플릿
**변경**: 3H+1A 구조로 변경:
```
Hard 1 (Build+Type): {PASS|FAIL|PENDING}
Hard 2 (Tests):      {PASS|FAIL|PENDING}
Hard 3 (PP):         {PASS|FAIL|PENDING}
Advisory (Contract): {PASS|WARN|N/A}
```
**결과**: status 출력이 v2 gate 구조를 표시

### T-26: skills/mpl-resume/SKILL.md — old gate key 참조

**파일**: `skills/mpl-resume/SKILL.md`
**현재**: L104-107 — `gate0_5_passed`, `gate1_passed`, `gate1_5_passed`, `gate2_passed`
**변경**: v2 3H+1A 키로 변경 (hard1_passed, hard2_passed, hard3_passed)
**결과**: resume 로직이 v2 gate 키를 참조

### T-27: docs/config-schema.md — pipeline_tier 참조

**파일**: `docs/config-schema.md`
**현재**: L79/81 — `pipeline_tier` 필드 설명
**변경**: `pp_proximity` 필드로 교체, 값을 `pp_core/pp_adjacent/non_pp`로
**결과**: config schema 문서가 v2 필드를 반영

### T-28: docs/pm-design.md — pipeline_tier 참조

**파일**: `docs/pm-design.md`
**현재**: L122 — `pipeline_tier: standard`
**변경**: `pp_proximity: pp_adjacent` (또는 적절한 값)
**결과**: PM 설계 문서가 v2 필드를 사용

---

## LOW (로드맵/히스토리 문서)

### T-29: docs/roadmap/overview.md — mixed 5-Gate 및 old terminology

**파일**: `docs/roadmap/overview.md`
**현재**: 5-Gate, Gate 0.5, Gate 1.5, pipeline_tier 등 다수 (L9, 28, 56, 80, 102, 121, 128, 297, 306, 419, 543, 771, 845, 899, 938)
**변경**: 역사적 기록은 보존하되, 현재 상태를 나타내는 부분은 v2 용어로 업데이트. 과거 버전 설명에는 `(v1)` 태그 추가.
**결과**: 로드맵이 v2 현재 상태를 정확히 반영하면서 히스토리 보존

### T-30: docs/roadmap/adaptive-router-plan.md — pipeline_tier/escalateTier 대량 참조

**파일**: `docs/roadmap/adaptive-router-plan.md`
**현재**: `pipeline_tier` 30회+, `tier_hint` 5회+, `escalateTier` 2회
**변경**: 이 문서는 F-20 설계 문서. v2에서 개념 자체가 Hat model로 대체되었으므로:
- 상단에 `> **⚠ v2 이후 Deprecated**: Hat model(pp_proximity)로 대체됨. 역사적 참조용.` 노트 추가
- 또는 전면 재작성 (비용 대비 효과 낮음)
**결과**: F-20 설계 문서의 v2 상태가 명확

### T-31: docs/roadmap/v0.6.7-cluster-ralph.md — 5-Gate 참조

**파일**: `docs/roadmap/v0.6.7-cluster-ralph.md`
**현재**: 5-Gate, Gate 0.5, maturity_mode 다수 참조
**변경**: 역사적 문서이므로 상단에 deprecated 노트 추가
**결과**: 과거 설계 문서임이 명확

### T-32: docs/roadmap/pending-features.md — old terminology

**파일**: `docs/roadmap/pending-features.md`
**현재**: maturity_mode, 5-Gate, Gate 0.5, Gate 1.5 등 다수
**변경**: 역사적 문서이므로 상단에 v2 기준 상태 노트 추가, 구현된 항목은 상태 업데이트
**결과**: pending features의 v2 적용 상태가 명확

---

## 실행 순서

의존성 그래프에 따른 권장 실행 순서:

```
Phase 1 — Core State Schema (T-01, T-06, T-07)
  └─ gate_results 키 변경, pp_proximity 도입, escalateTier 제거

Phase 2 — Runtime Code (T-02, T-08, T-09, T-10, T-11)
  └─ state를 사용하는 모든 런타임 모듈 업데이트
  └─ 의존: Phase 1

Phase 3 — Validation & Tests (T-03, T-04, T-05)
  └─ 테스트를 새 키/에이전트 목록에 맞춤
  └─ 의존: Phase 1, Phase 2

Phase 4 — Agent Files (T-12)
  └─ 7개 에이전트 .md 파일 삭제
  └─ 의존: Phase 3 (참조 제거 후)

Phase 5 — Design Docs (T-13, T-14)
  └─ design.md, README 업데이트
  └─ 의존: Phase 4

Phase 6 — Command Prompts (T-15 ~ T-20)
  └─ 모든 커맨드 프롬프트에서 old terminology 교체
  └─ 의존 없음 (병렬 가능)

Phase 7 — Skill Prompts (T-21 ~ T-28)
  └─ 모든 스킬 프롬프트에서 old terminology 교체
  └─ 의존 없음 (병렬 가능)

Phase 8 — Roadmap/History Docs (T-29 ~ T-32)
  └─ deprecated 노트 추가, 현재 상태 반영
  └─ 의존 없음 (병렬 가능)
```

Phase 6, 7, 8은 서로 독립적이므로 병렬 실행 가능.

---

## 최종 검증 (T-33)

모든 태스크 완료 후 실행:

### 1. 테스트 실행
```bash
node --test hooks/__tests__/mpl-validate-output.test.mjs
node --test hooks/__tests__/mpl-phase-controller.test.mjs
node --test hooks/__tests__/*.test.mjs
```

### 2. Old terminology grep (제로 히트 목표, 로드맵 히스토리 제외)
```bash
grep -rn "pipeline_tier\|escalateTier\|tier_hint\|gate1_passed\|gate2_passed\|gate3_passed\|gate0_5_passed\|gate1_5_passed\|5-Gate\|maturity_mode" \
  --include="*.mjs" --include="*.md" --include="*.ts" --include="*.json" \
  | grep -v node_modules | grep -v '.git/' | grep -v 'docs/roadmap/'
```
**기대 결과**: 0건 (docs/roadmap/은 역사적 문서이므로 제외)

### 3. 삭제 에이전트 참조 grep
```bash
grep -rn "mpl-pre-execution-analyzer\|mpl-scout\|mpl-code-reviewer\|mpl-compound\|mpl-verification-planner\|mpl-qa-agent\|mpl-phase-seed-generator" \
  --include="*.mjs" --include="*.md" --include="*.ts" \
  | grep -v node_modules | grep -v '.git/' | grep -v 'docs/roadmap/'
```
**기대 결과**: 0건 (docs/roadmap/ 히스토리 제외)

### 4. MCP server 빌드 확인
```bash
cd mcp-server && npm run build
```

### 5. 에이전트 파일 수 확인
```bash
ls agents/*.md | wc -l
# 기대: 9 (interviewer, ambiguity-resolver, codebase-analyzer, phase0-analyzer, decomposer, phase-runner, test-agent, git-master, doctor)
```
