# Adaptive Pipeline Router — 구현 계획

> F-20, F-21, F-22 구현 계획. Ouroboros PAL Router 분석 기반.
> 작성일: 2026-03-07

---

## 목표

**사용자가 "mpl"만 입력하면 시스템이 최적 파이프라인을 자동 선택하고, 실행 중 필요하면 확장한다.**

현재 3개 스킬(mpl, mpl-small, mpl-bugfix) → 단일 "mpl" 진입점으로 통합.

---

## 구현 단계

### Phase 1: Quick Scope Scan + Pipeline Score (F-20 핵심)

**목표**: Triage(Step 0)에서 `pipeline_tier`를 자동 산정

#### 1-1. `hooks/lib/mpl-scope-scan.mjs` 신규 생성

Quick Scope Scan 유틸리티. 오케스트레이터가 Triage 시점에 호출하는 것이 아니라, **keyword-detector 또는 Triage 프로토콜에서 참조하는 공식 정의**.

```javascript
// 입력: 사용자 프롬프트 + cwd
// 출력: { pipeline_score, pipeline_tier, scan_evidence }

// pipeline_score 공식:
// (file_scope × 0.35) + (test_complexity × 0.25)
//   + (dependency_depth × 0.25) + (risk_signal × 0.15)

// Quick Scope Scan은 오케스트레이터가 Glob/Grep으로 수행 (빌트인 도구)
// 이 모듈은 score 산정 로직만 담당
```

구현 범위:
- `calculatePipelineScore(scanResult)` — score 계산 순수 함수
- `classifyTier(score, hint)` — tier 분류 (hint가 있으면 오버라이드)
- `formatScanEvidence(scanResult, score, tier)` — 증거 문자열 생성

#### 1-2. `commands/mpl-run.md` Triage 섹션 수정

Step 0 Triage에 Quick Scope Scan + pipeline_tier 결정 절차 추가:

```markdown
### Step 0: Triage (확장)

1. 정보 밀도 분석 → interview_depth (기존)
2. **Quick Scope Scan** (신규, ~1-2K 토큰):
   a. Glob("**/*.{ts,tsx,js,jsx,py,go,rs}") → 프로젝트 파일 수 확인
   b. 사용자 프롬프트에서 언급된 파일/모듈 → Grep으로 존재 확인 → affected_files 추정
   c. 테스트 파일 존재 여부 → Glob("**/*.test.*", "**/*_test.*", "**/test_*")
   d. 언급된 모듈의 import 깊이 → Grep("import|require", affected_files) 1-hop
3. **pipeline_score 산출** → pipeline_tier
4. routing-patterns.jsonl 매칭 (F-22, Phase 3에서 구현)
5. state.json에 pipeline_tier 기록
```

#### 1-3. `commands/mpl-run-triage.md` 신규 생성

Triage 전용 상세 프로토콜. tier별 분기 로직을 명확히 정의:

```markdown
## Tier별 파이프라인 분기

pipeline_tier 결정 후, 이후 단계를 tier에 맞게 선택:

### Frugal (score < 0.3)
- Skip: PP 인터뷰, Pre-Execution Analysis, Decomposition, Gate 2/3
- Do: Error Spec(Phase 0 Step 4) → 단일 Fix Cycle → Gate 1 → Commit
- 오케스트레이터 프로토콜: mpl-run-frugal.md 로드

### Standard (0.3 ≤ score < 0.65)
- Skip: Full PP(→light), Phase 0 Step 1-3, 다중 페이즈 분해, Gate 2/3
- Do: PP(light) → Error Spec → 단일 Phase 실행 → Gate 1 → Commit
- 오케스트레이터 프로토콜: mpl-run-standard.md 로드

### Frontier (score ≥ 0.65)
- Skip: 없음
- Do: 전체 9+ step 파이프라인
- 오케스트레이터 프로토콜: mpl-run.md (기존)
```

#### 1-4. `hooks/mpl-keyword-detector.mjs` 수정

3-way 분기 → 단일 진입점으로 통합:

```javascript
// Before:
const isSmallRun = /\bmpl[\s-]*(small|quick|light)\b/i.test(cleanPrompt);
const skillName = isSmallRun ? 'mpl-small' : 'mpl';

// After:
const tierHint = extractTierHint(cleanPrompt);
// "bugfix|fix|bug" → "frugal"
// "small|quick|light" → "standard"
// 없으면 → null (auto)
initState(cwd, featureName, 'auto', tierHint);
const skillName = 'mpl'; // 항상 단일 스킬
```

#### 1-5. `hooks/lib/mpl-state.mjs` 수정

state.json에 `pipeline_tier`와 `tier_hint` 필드 추가:

```json
{
  "run_mode": "auto",
  "pipeline_tier": null,
  "tier_hint": "frugal",
  "escalation_history": []
}
```

`pipeline_tier`는 Triage 완료 후 오케스트레이터가 설정. `tier_hint`는 keyword-detector가 설정.

#### 산출물

| 파일 | 변경 유형 | 설명 |
|------|----------|------|
| `hooks/lib/mpl-scope-scan.mjs` | 신규 | pipeline_score 계산 로직 |
| `commands/mpl-run-triage.md` | 신규 | Triage 확장 프로토콜 (tier별 분기) |
| `commands/mpl-run-frugal.md` | 신규 | Frugal tier 오케스트레이션 프로토콜 |
| `commands/mpl-run-standard.md` | 신규 | Standard tier 오케스트레이션 프로토콜 |
| `commands/mpl-run.md` | 수정 | Step 0 Triage에 Quick Scope Scan 추가, tier별 프로토콜 로드 분기 |
| `hooks/mpl-keyword-detector.mjs` | 수정 | 단일 진입점 통합 |
| `hooks/lib/mpl-state.mjs` | 수정 | pipeline_tier, tier_hint 필드 추가 |
| `skills/mpl/SKILL.md` | 수정 | tier 인식 로직 추가 |

---

### Phase 2: Dynamic Escalation (F-21)

**목표**: circuit break 시 자동으로 상위 tier로 전환

#### 2-1. Escalation 프로토콜 정의

`commands/mpl-run-triage.md`에 에스컬레이션 섹션 추가:

```markdown
## Escalation Protocol

### Frugal → Standard 에스컬레이션
트리거: Frugal Fix Cycle에서 circuit break (3회 재시도 실패)
절차:
1. 완료된 TODO 목록 보존 (state.json에 기록)
2. state.json pipeline_tier를 "standard"로 변경
3. escalation_history에 기록
4. PP 추출 (light) — 프롬프트에서 직접 추출
5. Error Spec 재활용 (이미 생성됨)
6. 실패한 작업을 단일 Phase의 TODO로 재구성
7. Standard 프로토콜로 재실행

### Standard → Frontier 에스컬레이션
트리거: Standard Phase에서 circuit break
절차:
1. 완료된 TODO/Phase 보존
2. state.json pipeline_tier를 "frontier"로 변경
3. escalation_history에 기록
4. Full PP 인터뷰 실행 (기존 light PP를 기반으로 확장)
5. Phase 0 Enhanced 실행 (Error Spec 외 Step 1-3 추가)
6. 실패한 작업을 mpl-decomposer로 다중 페이즈 분해
7. Frontier 프로토콜로 재실행

### Frontier에서도 실패 시
기존 circuit break + mpl-failed 프로토콜 적용 (변경 없음)
```

#### 2-2. `hooks/mpl-phase-controller.mjs` 수정

circuit break 이벤트에서 에스컬레이션 가능 여부 확인 로직 추가:

```javascript
// circuit break 감지 시:
// 1. 현재 pipeline_tier 확인
// 2. frugal 또는 standard이면 → 에스컬레이션 메시지 반환
// 3. frontier이면 → 기존 mpl-failed 처리
```

#### 2-3. `hooks/lib/mpl-state.mjs` 수정

에스컬레이션 관련 함수 추가:

- `escalateTier(cwd)` — 현재 tier → 다음 tier 전환 + history 기록
- `getEscalationTarget(cwd)` — 다음 tier 반환 (frontier이면 null)
- `recordEscalation(cwd, from, to, reason, preservedWork)` — history append

#### 산출물

| 파일 | 변경 유형 | 설명 |
|------|----------|------|
| `commands/mpl-run-triage.md` | 수정 | Escalation Protocol 섹션 추가 |
| `hooks/mpl-phase-controller.mjs` | 수정 | circuit break → 에스컬레이션 분기 |
| `hooks/lib/mpl-state.mjs` | 수정 | escalateTier, getEscalationTarget 함수 |

---

### Phase 3: Routing Pattern Learning (F-22)

**목표**: 실행 결과를 축적하여 다음 실행의 초기 tier를 최적화

#### 3-1. `hooks/lib/mpl-routing-patterns.mjs` 신규 생성

```javascript
// append: 실행 완료 시 패턴 기록
function appendPattern(cwd, { description, tier, escalated, result, tokens, files })

// match: Triage 시 유사 패턴 검색
function findSimilarPattern(cwd, description, threshold = 0.8)

// jaccard: 토큰화 후 유사도 계산
function jaccardSimilarity(desc1, desc2)
```

#### 3-2. `commands/mpl-run-triage.md` 수정

Triage Step 0에 패턴 매칭 단계 추가:

```markdown
4. **Routing Pattern 매칭** (F-22):
   a. `.mpl/memory/routing-patterns.jsonl` 로드
   b. 사용자 프롬프트와 Jaccard 유사도 비교
   c. 유사도 ≥ 0.8인 패턴이 있으면 → 해당 패턴의 tier를 추천
   d. 추천 tier가 pipeline_score와 2단계 이상 차이나면 → score 우선
   e. 추천 적용 시 scan_evidence에 "pattern_match" 기록
```

#### 3-3. `commands/mpl-run-finalize.md` 수정

Step 5 Finalize에 패턴 기록 단계 추가:

```markdown
### Step 5.4.5: Routing Pattern 기록 (F-22)
실행 결과를 `.mpl/memory/routing-patterns.jsonl`에 append:
- 태스크 설명 (사용자 프롬프트 요약)
- 최종 pipeline_tier (에스컬레이션된 경우 최종 tier)
- 에스컬레이션 여부 및 원본 tier
- 성공/실패
- 총 토큰 사용량
- 영향 파일 수
```

#### 산출물

| 파일 | 변경 유형 | 설명 |
|------|----------|------|
| `hooks/lib/mpl-routing-patterns.mjs` | 신규 | 패턴 기록/매칭/유사도 로직 |
| `commands/mpl-run-triage.md` | 수정 | 패턴 매칭 단계 추가 |
| `commands/mpl-run-finalize.md` | 수정 | 패턴 기록 단계 추가 |

---

## 구현 순서 및 의존성

```
Phase 1 (F-20): Quick Scope Scan + Pipeline Score
  ├─ 1-5. mpl-state.mjs (tier 필드 추가)           ← 기반
  ├─ 1-1. mpl-scope-scan.mjs (score 계산)           ← 독립
  ├─ 1-4. keyword-detector.mjs (단일 진입점)         ← 1-5 의존
  ├─ 1-3. mpl-run-triage.md (tier별 분기)            ← 1-1 의존
  │   ├─ mpl-run-frugal.md (신규 프로토콜)
  │   └─ mpl-run-standard.md (신규 프로토콜)
  └─ 1-2. mpl-run.md (Step 0 수정)                   ← 1-3 의존

Phase 2 (F-21): Dynamic Escalation
  ├─ 2-3. mpl-state.mjs (escalation 함수)            ← Phase 1 완료 후
  ├─ 2-2. mpl-phase-controller.mjs (분기 추가)       ← 2-3 의존
  └─ 2-1. mpl-run-triage.md (escalation 섹션)        ← 2-3 의존

Phase 3 (F-22): Routing Pattern Learning
  ├─ 3-1. mpl-routing-patterns.mjs (패턴 로직)       ← Phase 1 완료 후
  ├─ 3-2. mpl-run-triage.md (매칭 단계)              ← 3-1 의존
  └─ 3-3. mpl-run-finalize.md (기록 단계)            ← 3-1 의존
```

Phase 2와 Phase 3는 Phase 1 완료 후 병렬 진행 가능.

---

## 검증 계획

### Phase 1 검증

| 검증 항목 | 방법 | 통과 기준 |
|----------|------|----------|
| score 계산 정확성 | mpl-scope-scan.mjs 단위 테스트 | 3가지 시나리오(frugal/standard/frontier)에서 올바른 tier 분류 |
| keyword-detector 통합 | "mpl bugfix X", "mpl small X", "mpl X" 입력 테스트 | 모두 단일 스킬로 진입, tier_hint 올바르게 설정 |
| Triage 확장 | 실제 프로젝트에서 mpl 실행 | pipeline_tier가 state.json에 기록됨 |
| Frugal 프로토콜 | 단순 버그 수정 태스크 | mpl-bugfix와 동등한 결과, 토큰 ~5-15K |
| Standard 프로토콜 | 소규모 기능 추가 태스크 | mpl-small과 동등한 결과, 토큰 ~20-40K |

### Phase 2 검증

| 검증 항목 | 방법 | 통과 기준 |
|----------|------|----------|
| Frugal→Standard 에스컬레이션 | 의도적으로 복잡한 태스크를 bugfix 힌트로 시작 | circuit break 후 자동 Standard 전환, 완료된 TODO 보존 |
| Standard→Frontier 에스컬레이션 | 중간 복잡도 태스크에서 실패 유도 | 자동 Frontier 전환, light PP가 full PP로 확장 |
| 에스컬레이션 history | state.json 검사 | escalation_history에 전환 기록 존재 |

### Phase 3 검증

| 검증 항목 | 방법 | 통과 기준 |
|----------|------|----------|
| 패턴 기록 | 실행 완료 후 routing-patterns.jsonl 확인 | 올바른 형식으로 append됨 |
| 유사도 매칭 | 비슷한 태스크 설명으로 재실행 | 이전 패턴의 tier가 추천됨 |
| Jaccard 정확도 | 단위 테스트 | 동일 문장 = 1.0, 완전 다른 문장 = 0.0 |

---

## 하위 호환성

| 기존 기능 | 영향 | 대응 |
|----------|------|------|
| `/mpl:mpl-bugfix` 스킬 | **Deprecated** | tier_hint="frugal"로 리다이렉트. SKILL.md에 deprecation 안내 추가 |
| `/mpl:mpl-small` 스킬 | **Deprecated** | tier_hint="standard"로 리다이렉트. SKILL.md에 deprecation 안내 추가 |
| `/mpl:mpl` 스킬 | 유지 | tier 인식 로직 추가 |
| `mpl-keyword-detector.mjs` | 수정 | 기존 "mpl small", "mpl bugfix" 키워드는 여전히 인식하되 hint로만 사용 |
| `state.json` 형식 | 필드 추가 | pipeline_tier, tier_hint, escalation_history 추가. 기존 필드 보존 |
| `mpl-run.md` | 수정 | Step 0에 Quick Scope Scan 추가, tier별 프로토콜 로드 분기 |

---

## 레퍼런스

- [Ouroboros PAL Router](https://github.com/Q00/ouroboros) — `src/ouroboros/routing/` (router.py, complexity.py, tiers.py, escalation.py, downgrade.py)
- Ouroboros Complexity Score: `(token × 0.30) + (tool × 0.30) + (ac_depth × 0.40)`
- Ouroboros Escalation: 2회 연속 실패 → 다음 tier, 성공 시 카운터 리셋
- Ouroboros Downgrade: 5회 연속 성공 → 이전 tier, Jaccard 유사도 0.8로 패턴 상속
- MPL design.md §3.2 (Triage), §3.3 Step 0.5 (성숙도 모드)
