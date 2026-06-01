# v2 Remaining Work

**Status as of 2026-06-01** · Branch: `v2` · After Moves #1–#18 (commits `c612bbf`…`026fb75`)

v2 정책 엔진 통합 완료, 병렬 인프라 빌드 완료. 활성화 및 통합 작업 일부 미완.
production smoke로 Law 2 Bash 차단 + Channel Registry 차단 검증됨 (`~/playground/ygg-exp23`).

이 문서는 v2 redesign proposal(`docs/redesign-proposal.html`)에서 약속된 것 중 미완 + commit에 documented된 known gaps + 오늘 production smoke에서 발견된 systemic gap을 단일 작업 카탈로그로 정리.

---

## 1. 병렬 (§07) — 활성화 0%

빌드는 완료, 실 동작 0개. 가장 큰 누락.

| 컴포넌트 | 빌드 | 활성화 |
|---|---|---|
| `hooks/lib/policy/scheduler.mjs` (698 LOC) | ✅ | ❌ |
| `hooks/lib/policy/isolation.mjs` (468 LOC) | ✅ | ❌ |
| `hooks/lib/state/shard-writer.mjs` | ✅ | ❌ |
| `hooks/lib/state/wave-reducer.mjs` | ✅ | ❌ |
| `hooks/lib/policy/reconcile/` (4-bucket T/S/C/X) | ✅ | ❌ |
| verifier `--mode=reconcile` prompt | ✅ | ❌ |
| `hooks/mpl-require-reconciliation.mjs` | ✅ | ⚠️ ROUTES 등록, 실 동작 미검증 |

### 활성화에 필요한 작업

1. **`wave_start` / `wave_end` 훅 이벤트 정의 + 등록**
   - 현재 `mpl-engine.mjs`는 PreToolUse/PostToolUse/SubagentStop/Stop/SessionStart/UserPromptSubmit/PreCompact만
   - 스케줄러 함수가 호출되려면 wave 경계 이벤트가 필요
   - 새 이벤트 추가는 hooks.json + engine + dispatch.mjs 전반 수정

2. **`commands/mpl-run-execute.md` Step 4.0 재작성**
   - 여전히 prompt-only pseudocode (`ensure_worktree_pool` / `parallel_map` / `merge_worktree`)
   - orchestrator LLM이 손으로 실행하라고 적혀 있음
   - 모델이 분기를 skip하면 무음 실패 (eval의 원래 finding)

3. **`route_to_phase` resolver (3) backfill**
   - `phase_details.impact`가 state schema에 없어서 dormant
   - decomposition.yaml에서 impact를 phase_details로 복사하거나, resolver (3)이 decomposition.yaml을 직접 읽도록 변경

4. **`wave-reducer.mergeWaveShards()` production call-site**
   - shard는 쓰이는데 머지 호출이 없음
   - wave_end 이벤트가 추가되면 자연스럽게 wired

5. **`isolation.detectImpactDrift`를 `git diff --name-only`로 wire**
   - 현재는 pure path-set diff
   - 실 wave 종료 시 git diff를 자동 호출하도록

6. **`config.scheduler` / `config.isolation` 섹션 활성화**
   - Move #16에서 mpl.config.yaml에 추가됐지만 yaml-mini가 못 파싱
   - Move #18은 `observability.sentinels`만 fix함
   - 결과: runtime에서 `config.scheduler === undefined`, fail_closed_when_running이 안전 기본값으로 동작

**예상 작업량**: Move #19–#21에 걸쳐 3-4 PR.

---

## 2. Agent / Command 통합 (proposal §3.4-3.5) — **Won't Do**

> **결정: 옵션 C 채택 (2026-06-01)** — proposal §3.4 / §3.5의 11 agents → 4, 11 commands → 3 비전은 formally deferred로 격하한다. TODO 큐가 아니라 **rejected direction** (Won't Do)이며, Moves #22-#24은 이 축에 reserved되지 **않는다**. AD-0003 / AD-0004 / AD-0007 체인이 그 분리를 frontmatter-locked invariant로 잠그고 있으므로 향후 planner가 "남은 v2 잔여"로 이 비전을 부활시키지 않도록 본 결정 기록을 §2의 표준 진입점으로 사용한다.

### Why 11 agents stayed (and 11 commands stayed)

§3.4/§3.5의 통합 비전(11 agents → 4, 11 commands → 3)은 v2 redesign proposal의 *aspirational* sketch였다. 18 Moves의 v2 실행을 거친 뒤 우리는 의도적으로 그 비전을 추구하지 않았다. 비전은 이제 formally deferred — TODO가 아니라 **rejected direction**으로 닫는다. 이유:

1. **AD-0007 author-independence는 frontmatter-locked invariant이지 prompt-mode flag가 아니다.** `mpl-test-agent`는 자신의 `disallowed-tools: Task` frontmatter를 가진 별도 agent 파일이어야 한다 — code author가 *동시에* test author일 수 없도록 Claude Code agent loader가 dispatch 시점에 강제한다. 단일 `mpl-verifier` agent에 `--mode=test|review|audit` 플래그를 다는 설계는 test 작성, 적대적 review, Tier-4 audit를 하나의 prompt context로 합치며, 그 안에서 모델은 (실측상, 압력하에서) review slot을 통과시키려고 test slot에서 증거를 fabricate할 수 있다. 분리 자체가 안전 속성이며, 합치는 순간 그 속성이 삭제된다.

2. **적대적 체인은 역할마다 fresh context를 전제로 한다.** `mpl-phase-runner` → `mpl-test-agent` → `mpl-adversarial-reviewer` → `mpl-codex-auditor`는 각각 깨끗한 context window와 frontmatter에 잠긴 role-locked tool grant(`disallowed-tools`)로 진입한다. "verifier가 executor와 disagree 가능"이 성립하는 이유 — 서로의 추론을 볼 수 없기 때문이다. mode-flagged 단일 agent는 정의상 mode 간에 context를 공유하므로, AD-0003 / AD-0004 / AD-0007이 막으려고 만들어진 바로 그 실패 모드로 회귀한다.

3. **Frontmatter `disallowed-tools`는 runtime branching보다 강한 boundary다.** 현재 `mpl-codex-auditor`는 literally Write/Edit를 호출할 수 없다 — prompt가 돌기 전에 harness가 tool call을 거부한다. 통합 agent는 같은 제한을 prompt body 안에서 gate해야 하며, 모델은 그것을 rationalize할 수 있다. loader에서 무료로 얻는 보장이며, 통합하면 prompt complexity로 영원히 그 보장을 지불해야 한다.

4. **Empirical validation.** Doctor 11/11 PASS, `~/playground/ygg-exp23`에서 production smoke가 Law 2 Bash + Channel Registry를 agent-layer regression 없이 통과. 11-agent surface의 비용은 roster bookkeeping (역할당 `agents/*.md` 하나); 통합 비용은 mode-dispatch prompt를 작성/유지하면서 "왜 mode flag가 AD-0007을 깨지 않는지"를 reader에게 영원히 설명하는 것.

5. **Hook 통합이 성공한 이유는 agent 층에 적용되지 않는다.** 47→1 엔진 cutover가 paid off된 이유는 hook이 pure deterministic policy이기 때문이다 — merge가 실제 중복(dispatch glue, JSON parsing, state I/O)을 제거하고 8개 eval finding을 닫았다. Agent는 role-locked tool grant를 가진 LLM prompt이다; "merging"은 단지 역할 경계를 frontmatter(enforced)에서 prose(advisory)로 옮기는 것일 뿐, decision point 수는 같고 enforcement만 약해진다.

**Conclusion:** 11 agents와 11 commands는 통합 대기 중인 technical debt가 아니다. 이들은 AD-0003, AD-0004, AD-0007의 load-bearing 구현이다. §3.4/§3.5 비전은 **Won't Do**로 닫는다 — v2가 추가한 바로 그 안전 속성에 의해 superseded됨.

### 결정 체인 (참조)

- `docs/decisions/AD-0003-v012.2-accidental-agent-deletion.md` — agent file 삭제 사고로 학습한 분리의 비대칭 가치
- `docs/decisions/AD-0004-test-agent-long-term-architecture.md` — test-agent를 별도 dispatch surface로 유지하는 장기 결정
- `docs/decisions/AD-0007-test-agent-enforcement.md` — frontmatter-locked `disallowed-tools: Task` enforcement (이 결정의 핵심 invariant)

### Historical vision (not pursued)

아래는 proposal §3.4 / §3.5의 원안 비전이다. **추구하지 않기로 한 방향**의 감사 기록으로 그대로 보존하며, 현재 또는 미래의 작업 항목이 아니다.

```
mpl-planner   = decomposer + phase0-analyzer + interviewer + seed-generator  (4→1)
mpl-executor  = phase-runner                                                   (1 그대로)
mpl-verifier  = test-agent + adversarial-reviewer + codex-auditor + 
                codebase-analyzer                                              (4→1)
mpl-doctor    = doctor + git-master                                            (2→1)
```

```
/mpl plan     = mpl-run-decompose + mpl-run-phase0(+analysis +memory)         (4→1)
/mpl run      = mpl-run + mpl-run-execute(+context +gates +parallel)          (5→1)
/mpl finalize = mpl-run-finalize + mpl-run-finalize-resume                    (2→1)
```

---

## 3. Task List Pending (수동 추적)

| # | 항목 | 작업량 |
|---|---|---|
| 17 | yaml-mini flow-style support OR `channels` 섹션 block style 재작성 | 작음 |
| 18 | Move #8 follow-up — phase-evidence + e2e-authenticity wrapper fix | 중간 |

---

## 4. Commit Concerns (비차단, follow-up 가치)

각 Move의 commit message에 documented된 known gap:

```
□ MODULE_TO_HOOK_IDS 수동 매핑 — auto cross-check 회귀 테스트 없음
  → 새 dispatch route 추가 시 silent drift 위험
  → Fix: route id ⊆ MODULE_TO_HOOK_IDS key set 회귀 테스트

□ EXTRA_LEGACY_ROWS hardcoded (mpl-state-invariant Stop)
  → dispatch.mjs에 gates.state-invariant Stop route 추가 시 제거 잊을 가능성
  → Fix: state-invariant를 정식 route로 등록

□ reconciler_reentries DEFAULT_STATE 결손
  → reentry-policy.mjs가 defensively 처리하지만 schema 명시 필요
  → Fix: DEFAULT_STATE에 reconciler_reentries: {} 추가

□ BUILTIN_MERGE_POLICY YAML matrix와 중복 (drift 위험)
  → 새 top-level state 필드 추가 시 양쪽 동기화 필요
  → Fix: YAML이 SSOT, BUILTIN을 derive 또는 startup에 verify

□ source-edit `decision` vs engine canonical `action`
  → 엔진이 양쪽 키 모두 수용 중 (정상화 패치)
  → Fix: source-edit를 action으로 통일

□ policy/schemas.rules registry 비어있음
  → schema가 모듈 안에 frozen (UC_SCHEMA_PATTERNS, VALIDATE_AGENTS 등)
  → Fix: mpl.config.yaml#schemas.rules에 declarative 정의 도입

□ permit.unknown_bash가 .mpl/config.json에서만 읽힘
  → mpl.config.yaml의 permit 섹션이 미연결
  → Fix: lib/config.mjs가 permit 섹션을 노출, permit.mjs가 그것 consume

□ gate-recorder legacy bridge (PRs #218/#232/#264 보존)
  → .legacy.mjs를 module load 시 import (anomaly install + exit-code masking + I12 + canonical failure_code)
  → Fix: 해당 PR 로직을 signals.mjs로 포팅 (회귀 위험 큰 작업)

□ wave-reducer RFC-6902 minimal
  → add/replace/remove만 안전. move/copy 사용 시 보장 못 함
  → Fix: shard envelope에 move/copy 도입 전까지 OK

□ Bash interpreter 우회 (Move #6에서 documented)
  → String.prototype['repeat'].call('writ','e') 등 obfuscated 형태
  → Fix: 정적 분석 한계, 의도된 제한
```

---

## 5. Production 미검증 surface

오늘 cmux-control smoke로 일부 검증 (Law 2 Bash + Channel Registry). 나머지:

```
□ /mpl run 전체 사이클 (Phase 0 → execute → finalize)
  - 사용자 인터뷰 + LLM dispatch 흐름 검증 필요
  - 작은 실제 task로 한 바퀴

□ Evidence Latch structural check
  - active phase + verifier dispatch + verification.md 생성 시
  - 구조적 검사가 실제로 substring fallback을 막는지

□ MCP 도구 직접 호출 (mpl_state_write subprocess 흐름)
  - 30-80ms 오버헤드 실측
  - MPL_HOOKS_ROOT 외부 packaging 시나리오

□ statusline (cli/mpl-hud.mjs) 실 렌더링
  - 이동만 했지 실제 statusline 표시 미검증

□ verifier 실제 dispatch
  - audit 모드: phase-runner 완료 후 자동 invoke
  - reconcile 모드: Bucket C 경합 발생 시 invoke (병렬 활성화 후에만 가능)

□ envelope bridge 실 PreToolUse 이벤트 — 오늘 부분 검증
  - .mpl/blocked-hook/*.json 실제 생성 확인 (smoke에서 message 확인했지만 파일 미확인)

□ Tier 1 rollback (MPL_ENGINE_BYPASS=1) 실 시나리오 검증
  - 빈 envelope 응답만 unit test로 확인. 실 세션에서 engine 비활성 시 legacy hook fallback 미확인 (hooks.json은 engine만 가리킴)

□ Tier 2 rollback (cp hooks.json.legacy-backup hooks.json)
  - 적용 시 실제 39 entries 복원 확인

□ Tier 3 rollback (MPL_DISABLE_MODULES) per-route 효과
  - 환경 변수 변경 시 dispatch 재계산 동작 확인
```

---

## 6. 오늘 발견한 Systemic Gap

### 6.1 Agent frontmatter validation이 unit test surface 밖

- `mpl-adversarial-reviewer.md` frontmatter 깨졌는데 **2,064 test 전부 통과**
- production install에서야 발견 (`claude plugin validate` 실패)
- **권장**: `npm test`에 `claude plugin validate` 통합 — 모든 agent .md frontmatter 자동 검증
- 다른 agent .md 파일들도 잠재 위험 — 일괄 audit 안 함

### 6.2 다른 agent .md 일괄 audit

```bash
# 권장 명령:
for agent in agents/*.md; do
  echo "=== $agent ==="
  claude plugin validate --agent "$agent" 2>&1 | grep -E "error|✘"
done
```

이걸 CI에 추가하면 6.1과 함께 systemic gap 폐쇄.

---

## 7. Stage B / NICE-to-have (proposal §7.4)

```
□ Tree-sitter 심볼 추출 (현재 regex)
  → reconcile Bucket S의 signature_hash 매칭 정확도 향상

□ Priority inheritance — anti-starvation
  → 긴 phase가 자기 dependents의 slot priority 올림

□ Post-merge consensus recheck
  → merge_worktree 완료 후 silent 3-way merge 캐치
  → reconcile.recheck() 호출

□ Per-wave hard1_baseline intermediate gate + file-set-hash 캐시
  → 현재 phase3-gate-only

□ exports_symbols_manual_overrides[] 탈출구
  → regex 한계 우회용 decomposition.yaml 필드
```

---

## 우선순위 정리

| Priority | Category | 작업량 | 권장 시점 |
|---|---|---|---|
| 🔴 **P0** | §6.1 agent frontmatter validation을 npm test에 통합 | 작음 (1 PR) | 즉시 |
| 🔴 **P0** | §6.2 다른 agent .md frontmatter 일괄 audit | 작음 (1 PR) | 즉시 |
| 🟠 **P1** | §3.18 Move #8 follow-up — 2 deferred wrapper fix | 중간 (1 PR) | 곧 |
| 🟠 **P1** | §5 /mpl run 한 사이클 실 production 검증 | 시간 (불확실) | 곧 |
| 🟡 **P2** | §1 병렬 활성화 (wave 이벤트 + route_to_phase + commands 재작성) | **큼** (3-4 PR) | 병렬이 핵심 가치라면 |
| 🟡 **P2** | §3.17 yaml-mini flow-style or channels block style | 작음 (1 PR) | scheduler/isolation config 활성화 시 함께 |
| 🟢 **P3** | §2 Agent/command 통합 OR 옵션 C 격하 | 큼 또는 무 | 판단 필요 |
| 🟢 **P3** | §4 commit-documented gaps (10개) | 각 작음 | 기회 있을 때 |
| 🟢 **P3** | §7 Stage B NICE-to-have | 큼 | 병렬 사용 누적 후 |

---

## 솔직한 v2 평가

**Ship 가능한 베이스**: 정책 엔진 통합 + Law 2 fix + Channel Registry + Evidence Latch 구조화 + 8개 eval finding 구조적 해결 + 1,953 → 2,064 테스트 +Production smoke 검증

**미완으로 인정해야 할 부분**:
- 병렬은 코드만 있고 활성화 안 됨 — "MPL이 진짜 병렬 실행한다"는 주장은 아직 못 함
- Agent/command 통합은 안 됨 — proposal §3.4-3.5는 실현 안 됨

**가장 정직한 ship 메시지**: "v2 = 정책 엔진 통합 + 평가 결손 8개 구조 해결 + 병렬 인프라 빌드. 병렬 활성화 및 agent 통합은 future work."
