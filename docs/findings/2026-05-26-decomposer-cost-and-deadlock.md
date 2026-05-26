# Decomposer Cost: Structural Bloat + Goal-Contract Hash Deadlock

- **Date**: 2026-05-26
- **Severity**: High — "1시간+ retry / 산출물 0" 사고가 메인 레포 코드로 재현 가능
- **Status**: Phase 1 patch covers the hash-normalization/truncation deadlock. Decomposer 구조 개선은 후속 Phase.
- **Related**: `harness_lab/MPL/docs/findings/2026-05-26-goal-trace-hash-truncation-deadlock.md` (원본 deadlock 보고)

## 요약

"decomposer 가 너무 오래 걸리고 컨텍스트를 많이 먹는다" 는 증상은 **두 개의 독립된 문제가 섞인 결과**다. 이 둘을 분리해서 보지 않으면 잘못된 곳을 고치게 된다.

| 가닥 | 원인 | 증상 | 처방 | 우선순위 |
|------|------|------|------|----------|
| **1. Goal-contract hash deadlock** | Phase 0 baseline 은 raw bytes hash, guards 는 normalized text hash 비교 + 훅이 sha256 을 `.slice(0,12)` 로 표시 + baseline.yaml 에 길이 검증 없음 | 정상 baseline 도 trailing newline 으로 즉시 drift 가능. LLM 워커가 12자를 정답으로 오인하면 baseline 영구 손상 → Write 영구 차단 → 토큰만 태우며 retry | 공유 normalized hash + 64hex 검증 + full hash 메시지 | 즉시 |
| **2. Decomposer 구조적 비대** | 단일 Opus 호출이 1,700+ lines YAML 한 번에 생성. 출력의 25% 는 기계적 필드 | 정상 케이스에서도 latency 크고 context 점유 큼 | 기계적 필드 → post-processing, 스키마/의사코드 외부화 | hash-deadlock fix 이후 |

가닥 1 을 안 고치면 가닥 2 의 어떤 개선도 같은 deadlock 에 다시 빠진다 (출력이 1,300 lines 로 줄어도 동일 hash drift 에 막힘).

---

## 가닥 1 · Goal-Contract Hash Deadlock

### 메커니즘 (4-단계 결함 체인)

0. **Hash algorithm mismatch**: baseline writer 가 `.mpl/goal-contract.yaml` 파일 raw bytes 를 해시하고, guards 는 CRLF→LF + trim 된 normalized text hash 를 비교. trailing newline 하나로 Phase 0 직후 drift 가능.
1. **Display truncation**: 훅이 가독성 위해 12자만 표시 → `"baseline=43aaf36b9bf7, current=97c94a8c3254"`
2. **LLM 의 시스템/사용자 텍스트 동등 취급**: 워커가 truncated 12자를 "올바른 현재 해시"로 오인
3. **baseline.yaml 에 12자만 작성**: 어떤 schema/length 검증도 없음 → 통과
4. **영구 불일치**: `"43aaf36b9bf7" !== <64자 실제 normalized hash>` → 모든 decomposition.yaml/finalize Write 영구 차단

여기에 baseline-guard 의 `.baseline-renewal` sentinel 이 의도된 회복 경로인데 **parent 가 "stale artifact" 로 잘못 청소** → 회복 경로마저 차단 (deadlock 보고 §Fix 4 참조).

### 메인 레포 (2026-05-26 기준) 에서 재확인된 위치

**이전 `hooks/lib/mpl-baseline.mjs`**
```javascript
const hash = sha256File(cwd, relPath); // raw bytes hash
```
✅ root cause: goal-contract baseline hash 가 guard 의 normalized `content_sha256` 과 다른 알고리즘.

**이전 `hooks/mpl-require-goal-trace.mjs:88`**
```javascript
`(baseline=${baseline.hash.slice(0, 12)}, current=${goal.contract.content_sha256.slice(0, 12)}). `
```
✅ secondary cause: guard message 가 full hash 를 숨겨 12자 baseline 손상 가능성을 키움.

**이전 `hooks/lib/mpl-goal-contract.mjs:302-315`**
```javascript
export function readBaselineGoalContractHash(cwd) {
  // ...
  const hash = scalarInBlock(goalBlock, 'sha256');
  return { exists: true, hash };  // ← 길이 검증 없음
}
```
✅ secondary cause: 12자/non-hex baseline hash 를 corruption 으로 차단하지 않음.

### 재현 타임라인 (ygg-exp22 V1)

- 07:48 dispatch → 08:13 첫 Write 차단 → 08:25~31 다수 retry 차단
- 08:44 워커가 sentinel + baseline 에 truncated 12자 작성
- 08:49 첫 subagent 51분 / 2,671 tokens / 산출물 0
- 08:51 parent 가 sentinel 을 stale 로 청소 + 재dispatch
- 09:00+ retry 도 동일 deadlock 반복 → 1h 40m+ 진행, 산출물 여전히 0

### Fix (외과적, 작음)

**Fix 1 — baseline 과 guard 가 공유 normalized hash 사용**

`hooks/lib/mpl-goal-contract.mjs` 에 normalized helper 를 두고:
- `parseGoalContractText().content_sha256`
- Phase 0 baseline 의 `artifacts.goal_contract.sha256`
- decomposition/finalize guard 비교

모두 동일하게 CRLF→LF + trim 후 SHA-256 을 사용한다. raw `shasum` 과 MPL normalized hash 는 다를 수 있음을 메시지에 명시한다.

**Fix 2 — 훅 메시지에서 truncation 제거**

`hooks/mpl-require-goal-trace.mjs:88`
```javascript
block(
  `[MPL Goal Trace] Cannot write decomposition.yaml — .mpl/goal-contract.yaml drifted from baseline.yaml ` +
    `(baseline=${baseline.hash}, current=${goal.contract.content_sha256}). ` +
    `These are MPL normalized hashes; raw shasum may differ because MPL normalizes CRLF to LF and trims surrounding whitespace. ` +
    `Re-run Phase 0 renewal before recomposing.`
);
```

**Fix 3 — baseline 의 sha256 길이/형식 검증**

`hooks/lib/mpl-goal-contract.mjs:302-315`
```javascript
const hash = scalarInBlock(goalBlock, 'sha256');
if (hash && !/^[0-9a-f]{64}$/.test(hash)) {
  return { exists: true, hash: null, error: `corrupted: expected 64 lowercase hex` };
}
return { exists: true, hash };
```
훅이 이 에러를 감지하면 별도 메시지 ("baseline.yaml 손상: sha256 truncated/non-hex, 전체 재생성 필요") 출력. 워커가 같은 함정에 다시 빠지지 않게 됨. finalize guard 도 같은 fail-closed 경로를 사용한다.

**Fix 4 (권장) — Sentinel cleanup 휴리스틱 점검**

Parent 가 `.baseline-renewal` 을 stale 로 판단한 근거가 무엇이었는지 추적 필요. Sentinel 은 의도된 unblock 경로인데 정리되면 deadlock 으로 회귀.

---

## 가닥 2 · Decomposer 구조적 비대

(이 가닥은 가닥 1 패치 후 측정해서 ROI 가 정직하게 보일 때 진행하는 게 맞다.)

### 실측

- 에이전트 프롬프트 본문: **698 lines** (`agents/mpl-decomposer.md`)
- 디스패치 입력: pivot-points + goal-contract + codebase-analysis + raw-scan + core-scenarios + design-intent + user-contract + baseline ≈ **920 lines**
- 출력 (ygg-exp21 실측): **1,754 lines / 22 phases** ≈ **75~80 lines/phase**, 단일 Opus 호출

병목은 컨텍스트보다 **단일 호출 generation latency**.

### 결정자(decomposer) 가 흡수한 책임 (v0.17 #57 이후)

페이즈 분할/순서 + type_policy 합성 + error_spec 합성 + contract_files 경계 열거 + e2e_scenarios 합성 + probing_hints + risk_patterns 열거 + invariants 매핑 + risk pre-mortem + execution_tiers + mvp 컷 유도. 각 흡수 결정은 합리적이었지만 **누적 부하**가 문제.

### 출력 중 LLM 추론 불필요한 (mechanical) 필드

다음은 명시적으로 "기계적 매핑" 인데 매번 LLM 이 다시 생성:

| 필드 | 근거 | 출처 |
|------|------|------|
| `risk_patterns` | `mpl-run-decompose.md` Step 2b 가 이미 결정론적으로 주입 | 이중 작업 |
| `probing_hints` | `phase_domain` → hint 테이블 룩업 | Step 9.5 의 테이블 |
| `invariants` | design-intent.yaml 에서 `applies_to_phases` 필터 후 verbatim copy | Step 9.7: "번역·재해석 금지" 명시 |
| `mvp.phases` | id-set 교집합 | RFC §10 D-Q4: "mechanical id-set mapping (NOT semantic inference)" |
| `error_spec.raw_audit_counts` | raw-scan 의 수치를 그대로 복사 | 단순 복사 |

이 다섯 항목만 출력 스키마에서 빼도 phase 당 15~20 lines × 25 phases ≈ **400 lines (출력의 ~25%) 축소**, 환각 위험 0.

### 프롬프트 자체의 비대

- Output_Schema YAML: 280+ lines
- Step 12 MVP 유도 의사코드: 70 lines (이미 결정론적 로직)
- 다수의 hint 테이블 + profile reference

추론에 쓰는 게 아니라 형식 규약이라 매 호출마다 컨텍스트에 들어가는 게 낭비.

### 단일-Write 강제 → 훅 블록시 풀-재생성

`covers` / `goal_trace` / `contract_files` 훅 중 하나라도 거부하면 1,700 lines 전체 재생성. 점진적 패치 경로 없음.

### 옵션 (덜→더 침습적)

**옵션 A — 기계적 필드 → post-processing (low-risk, 즉시 효과)**
`risk_patterns`, `probing_hints`, `invariants`, `mvp.phases`, `raw_audit_counts` 를 에이전트 출력 스키마에서 제거, `mpl-run-decompose.md` Step 3 post-processing 이 결정론적으로 합성. 출력 25% 축소, 환각 표면 축소.

**옵션 B — Skeleton + Enrichment 2-단계 (medium)**
1단계 Opus: id/name/scope/impact/interface_contract/goal_trace 만 (≈25 lines/phase).
2단계 per-phase Sonnet 병렬: type_policy, error_spec, contract_files, verification_plan.
Wall-time 은 1단계 Opus 호출 시간에 수렴. trade-off: 오케스트레이터 복잡도↑, phase 간 일관성 확보를 위해 1단계에서 anchor 박아야 함.

**옵션 C — 프롬프트 다이어트 (medium)**
Output_Schema 를 `agents/references/decomposition-schema.yaml` 로 추출, Step 12 의사코드를 `commands/lib/derive-mvp-phases.mjs` 헬퍼로 빼내기. 프롬프트는 참조만. 추정 -300 lines.

**옵션 D — 점진적 Write 경로 (heavy)**
훅이 특정 phase 의 특정 필드를 거부했을 때 부분-Edit 허용. v0.17.2 "authoring authority" 규칙과 충돌하므로 별도 RFC 필요.

---

## 권장 실행 순서

1. **즉시**: normalized hash 공유 + full hash 메시지 + baseline 64hex 검증 패치. 영향: deadlock 차단.
2. **Fix 후 측정**: 동일 시나리오 재실행, decomposer baseline wall-time / token / context 측정. 옵션 A~D 의 ROI 가 정직하게 보임.
3. **그다음 옵션 A**: 기계적 필드 5개 → post-processing.
4. **마지막 옵션 C**: 프롬프트 다이어트. B 는 측정 후 결정.

Hash-deadlock fix 없이 옵션 A~C 만 진행하면: **출력이 줄어도 같은 hash deadlock 에 다시 빠진다**. 순서가 바뀌면 안 됨.
