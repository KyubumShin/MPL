# v2 Remaining Work

**Status: ✅ MOSTLY CLOSED as of 2026-06-06** · Branch: `v2` · Through Moves #1–#18 + P0/P1/P2/P3

v2 정책 엔진 통합 완료, 병렬 인프라 활성화 완료, 알려진 gap 8/10 닫힘. production smoke로 Law 2 Bash 차단 + Channel Registry 차단 검증됨 (`~/playground/ygg-exp23`). 2026-06-06 현재 `hooks/hooks.json`은 6개 event entry 모두를 `hooks/mpl-engine.mjs`로 라우팅하며, production routing SSOT는 `hooks/lib/dispatch.mjs` ROUTES다.

이 문서는 v2 redesign proposal(`docs/redesign-proposal.html`)에서 약속된 것 중 미완 + commit에 documented된 known gaps + production smoke에서 발견된 systemic gap의 진행 상태 카탈로그.

---

## 1. 병렬 (§07) — ✅ ACTIVATED

**P2a (commit 37a0f6b) + P2b (commit 3321f69)에서 활성화 완료.**

| 컴포넌트 | 빌드 | 활성화 | 비고 |
|---|---|---|---|
| `hooks/lib/policy/scheduler.mjs` | ✅ | ✅ | scheduler-cli.mjs (404 LOC) 노출 |
| `hooks/lib/policy/isolation.mjs` | ✅ | ✅ | isolation-cli.mjs (224 LOC) 노출 |
| `hooks/lib/state/shard-writer.mjs` | ✅ | ✅ | wave 컨텍스트에서 호출 가능 |
| `hooks/lib/state/wave-reducer.mjs` | ✅ | ✅ | wave-reducer-cli.mjs (217 LOC) 노출 |
| `hooks/lib/policy/reconcile/` | ✅ | ✅ | merge 시 호출됨 |
| verifier `--mode=reconcile` prompt | ✅ | ✅ | Bucket C 경합 시 dispatch |
| `hooks/mpl-require-reconciliation.mjs` | ✅ | ✅ | dispatch route 등록 |

### 활성화 작업 (모두 P2b에서 완료)

- ✅ **commands/mpl-run-execute.md Step 4.0 재작성** — orchestrator가 prompt-pseudocode 대신 scheduler-cli/isolation-cli/wave-reducer-cli을 Bash로 호출. (commit 3321f69)
- ✅ **route_to_phase resolver (3) backfill** — `phase.impact = collectImpactStructured(block)`이 decomposition-postprocess에서 phase_details[i].impact를 채움. (commit 3321f69)
- ✅ **wave-reducer call-site** — wave-reducer-cli merge가 wave 끝에서 호출됨. (commit 3321f69)
- ✅ **detectImpactDrift를 git diff로 wire** — detectImpactDriftFromGit이 spawnSync('git', ['diff', '--name-only', base_ref])를 worktree 안에서 실행. (commit 3321f69)
- ✅ **config.scheduler / .isolation 활성화** — yaml-mini parse 해결로 runtime에서 정의됨. (commit 37a0f6b)

### 알려진 P2b 후속 (작음)
- ⚠️ **multi-wave-per-tier**: 현재 plan-wave가 tier당 단일 wave만 emit. orchestrator가 completed_phase_ids를 반영해 plan-wave 재호출하면 multi-wave 됨. 작은 follow-up.

---

## 2. Agent / Command 통합 (proposal §3.4-3.5) — **❌ Won't Do**

> **결정: 옵션 C 채택 (2026-06-01)** — proposal §3.4 / §3.5의 11 agents → 4, 11 commands → 3 비전은 formally deferred로 격하한다. TODO 큐가 아니라 **rejected direction** (Won't Do)이며, Moves #22-#24은 이 축에 reserved되지 **않는다**. AD-0003 / AD-0004 / AD-0007 체인이 그 분리를 frontmatter-locked invariant로 잠그고 있으므로 향후 planner가 "남은 v2 잔여"로 이 비전을 부활시키지 않도록 본 결정 기록을 §2의 표준 진입점으로 사용한다.

상세 5-point 근거 + 결정 체인 + Historical vision은 commit 52d01a4 참조 (이 섹션의 이전 버전 전체).

---

## 3. Task List Pending — ✅ ALL CLOSED

| # | 항목 | 상태 |
|---|---|---|
| 17 | yaml-mini flow-style support OR `channels` 섹션 block style 재작성 | ✅ P2a (commit 37a0f6b) — channels.allowed 35 entries + channels.immutable_when 5 entries + reconcile.bucket_priority → block style |
| 18 | Move #8 follow-up — phase-evidence + e2e-authenticity wrapper fix | ✅ P1 (commit be318d1) — layered-acceptance + policy-SSOT + legacy-layer wrapper, 23/23 targeted tests pass |

---

## 4. Commit Concerns — ✅ 8 of 10 CLOSED

```
✅ #1 MODULE_TO_HOOK_IDS 수동 매핑                    P3 (commit 8dcce99)
   → mpl-route-introspection-coverage.test.mjs 회귀 테스트 추가
   → 실 drift 발견: reconcile.require 누락 → [] 추가

✅ #2 EXTRA_LEGACY_ROWS hardcoded (state-invariant)    P3 deferred (commit 3316c09)
   → policy/state-invariant.mjs NEW + dispatch.mjs 3 routes (pre.task,
      pre.write, stop) + EXTRA_LEGACY_ROWS 삭제 + coalesceRowsByHookEvent
   → BONUS: Move #14/15 collapse에서 silently dark된 I1-I13 enforcement 복귀

✅ #3 reconciler_reentries DEFAULT_STATE 결손          P3 (commit 8dcce99)
   → writer.mjs DEFAULT_STATE.reconciler_reentries = {} 명시

✅ #4 BUILTIN_MERGE_POLICY YAML matrix 중복             P3 (commit 8dcce99)
   → verifyBuiltinMatchesYaml() runtime warning +
      state-merge-policy-ssot.test.mjs SSOT 검증

✅ #5 source-edit `decision` vs canonical `action`     P3 (commit 8dcce99)
   → action SSOT + .decision getter alias + 1-shot deprecation warning

✅ #6 policy/schemas.rules registry 비어있음           P3 deferred (commit 3316c09)
   → mpl.config.yaml schemas.rules에 pp_uc_leakage / agent_output_sections
      / property_audit_targets 선언 + schemas.mjs YAML-first + frozen fallback
   → phase_seed_required는 enabled:false 파킹 (Pass 3 dispatcher 작업 별도)

✅ #7 permit.unknown_bash가 .mpl/config.json만        P3 (commit 8dcce99)
   → permit.mjs _loadMergedConfig가 loadConfigV2 우선 + 레거시 fallback
   → 우선순위: state override > .mpl/config.json > mpl.config.yaml > pass-through

⏸️  #8 gate-recorder legacy bridge                     의도된 deferral
   → PRs #218/#232/#264 회귀 위험 너무 큼. .legacy.mjs bridge는
      defense-in-depth로 의도된 패턴. 별도 move에서 careful port.

⏸️  #9 wave-reducer RFC-6902 minimal                   의도된 deferral
   → 오늘 shard envelope는 add/replace/remove만 사용. move/copy 도입
      시 hardening 필요. 그 전까지는 minimal로 충분.

✅ #10 Bash interpreter 우회                          P3 (commit 8dcce99)
   → docs/changelog.md "Known limitations" 추가 + design.md §6 paragraph
      + source-edit.mjs extractBashWriteTargets 위에 comment
```

---

## 5. Production 미검증 surface — ⚠️ 부분 검증 (smoke로 일부)

cmux-control smoke로 검증된 것 (2026-06-01, `~/playground/ygg-exp23`):
- ✅ Law 2 Bash 차단 (`echo forged > src/auth.ts` → BLOCKED with delegation notice)
- ✅ Channel Registry 차단 (`Write .mpl/scratchpad.md` → BLOCKED with forbidden pattern)
- ✅ /mpl 슬래시 명령 13+개 등록
- ✅ /mpl-doctor 11/11 PASS

남은 미검증 (Production smoke 확대 필요):
```
□ /mpl run 전체 사이클 (Phase 0 → execute → finalize)
□ Evidence Latch structural check (실 active phase에서)
□ MCP 도구 직접 호출 (mpl_state_write subprocess 흐름)
□ statusline (cli/mpl-hud.mjs) 실 렌더링
□ verifier 실제 dispatch (audit + reconcile 두 모드)
□ envelope bridge 실 .mpl/blocked-hook/*.json 생성 확인
□ Tier 1/2/3 rollback 실 시나리오 검증
□ 병렬 wave 실 동작 (CLI 노출됐지만 production wave 실 실행 미검증)
```

이 항목들은 작은 실제 task로 `/mpl run` 사이클을 도는 것이 가장 효율적.

---

## 6. Systemic Gap — ✅ CLOSED

### 6.1 + 6.2 Agent frontmatter validation — ✅ P0 (commit 95a2591)

- ✅ hooks/__tests__/plugin-validate.test.mjs — `claude plugin validate --strict <repo>` + per-agent 11개 frontmatter schema 검증
- ✅ 11 agents 모두 valid (mpl-adversarial-reviewer는 이전 commit 026fb75에서 fix됨)
- ✅ CI에서 자동 catch — `npm test`가 `claude` binary 발견 시 invoke, 없으면 graceful skip

---

## 7. Stage B / NICE-to-have (proposal §7.4) — ⏸️ 후순위

```
□ Tree-sitter 심볼 추출 (현재 regex)        병렬 사용 누적 후
□ Priority inheritance (anti-starvation)     scheduler 실 사용 데이터 후
□ Post-merge consensus recheck               병렬 사용 후
□ Per-wave hard1_baseline intermediate gate  phase3-gate-only로 충분
□ exports_symbols_manual_overrides[]         regex 한계 사례 보고 후
```

모두 production 사용 데이터 누적 후 판단. 현재 차단 요소 아님.

---

## 8. 다음 액션 — 권장 순서

| Priority | Category | 작업량 |
|---|---|---|
| ~~🔴 P1~~ | ~~§9 local harness regression — macOS tmpdir vs isolation safe-path~~ | ✅ closed 2026-06-02 |
| 🟠 P1 | §5 production smoke 확대 — 작은 task로 `/mpl run` 사이클 한 바퀴 | 시간 (수동) |
| 🟢 P3 | §1 P2b multi-wave-per-tier follow-up | 작음 |
| 🟢 P3 | §4 #6 phase_seed_required dispatcher 빌드 (Pass 3) | 중간 |
| 🟢 P3 | §4 #8 gate-recorder bridge careful port (회귀 위험 있음) | 중간 |
| 🟢 P3 | §4 #9 wave-reducer RFC-6902 move/copy (사용 시점에) | 작음 |
| ⏸️ | §7 Stage B (NICE-to-have) | 큼 |

---

## 9. 2026-06-02 Local Harness Recheck — ✅ CLOSED

Branch: `v2`
Baseline: 기존 v1은 `backup/main-2026-05-31`

### v1 대비 하네스 확장

| Metric | v1 backup | v2 |
|---|---:|---:|
| `hooks/__tests__` + `mcp-server/__tests__` 파일 수 | 80 | 105 |
| `test(...)` grep 기준 케이스 수 | 241 | 366 |
| v2 실제 `node --test hooks/__tests__/*.test.mjs` 집계 (2026-06-02 최초 재확인) | - | 2,147 |

v2는 v1 대비 hook/policy/state/observability 하네스가 크게 늘었다. 특히 `hooks/lib/policy`,
`hooks/lib/state`, `hooks/lib/observability`, `hooks/mpl-engine.mjs`, `mpl.config.yaml`
관련 diff만 보아도 `74 files changed, 25595 insertions(+), 876 deletions(-)` 규모다.

### 현재 로컬 실행 결과

2026-06-02 최초 재확인 시 `npm test` 결과:

```text
tests 2147
pass 2140
fail 7
duration_ms 23782.074042
```

실패는 모두 병렬 isolation/worktree slot 계열이다.

- `hooks/__tests__/isolation-cli.test.mjs`
  - `negative staleness window forces stale`
- `hooks/__tests__/policy-isolation.test.mjs`
  - `refreshHeartbeat writes the file`
  - `isSlotStale: false when fresh, true when older than staleness_ms`
  - `acquireSlot creates a worktree + slot.lock + heartbeat`
  - `acquireSlot fails when worktree already exists`
  - `releaseSlot tears down the worktree and lock`
  - `contract freeze: decomposition.yaml is hardlinked + read-only`

### 원인 판단

macOS에서 `tmpdir()`가 `/var/folders/...` 아래를 반환하는데,
`hooks/lib/policy/isolation.mjs:isSafeAbsolutePath()`가 `/var` prefix를 unsafe로 차단한다.
테스트 fixture는 `mkdtempSync(join(tmpdir(), ...))`로 workspace/pool/slot을 만들기 때문에
heartbeat와 worktree acquire 경로가 unsafe로 판정된다.

대표 실패 메시지:

```text
cwd must be an absolute path outside protected roots
false !== true
```

### 평가 보정

v2의 정책 엔진, state/policy 분리, source-edit guard, Bash timeout/classification,
channel registry, finalize gate, blocked hook envelope, scheduler/wave reducer 하네스는
v1 대비 명확히 강화됐다. 2026-06-02 최초 재확인 시점에는 전체 하네스가 green이 아니었으므로,
당시 “2,147 hooks 테스트 통과” 또는 “Production ship 가능”은 조건부 판정이었다. 아래 fix와
2026-06-06 재확인 이후에는 green 판정으로 갱신됐다.

### 해결 (2026-06-02)

`hooks/lib/policy/isolation.mjs#isSafeAbsolutePath()`는 *의도된 안전 차단*이었지만 macOS의
`tmpdir()` 동작(`/var/folders/...`)을 고려하지 않은 Linux-centric prefix block이었다. 함수
자체 코멘트가 "pool sits under tmpdir()"이라고 명시하므로 코드와 의도의 자기모순.

수정: `/var` prefix를 통째로 차단하는 대신 system root만 차단하고 valid tmpdir 위치는 허용.

```javascript
if (norm === '/') return false;
if (norm === '/var') return false;
if (norm.startsWith('/etc')) return false;
if (norm.startsWith('/usr')) return false;
// allow /var/folders/ (macOS tmpdir) + /var/tmp/ (POSIX alt-tmpdir),
// block everything else under /var/ (system /var/log, /var/spool, …)
if (norm.startsWith('/var/') &&
    !norm.startsWith('/var/folders/') &&
    !norm.startsWith('/var/tmp/')) return false;
// macOS firmlink /var → /private/var. realpath() 통과한 경로도 동일 정책.
if (norm.startsWith('/private/var/') &&
    !norm.startsWith('/private/var/folders/') &&
    !norm.startsWith('/private/var/tmp/')) return false;
```

`npm test` 결과: **2,147 / 0 fail**. 7건 isolation/worktree slot 테스트 모두 green.

### 최신 재확인 (2026-06-06)

현재 로컬 `npm test` 결과:

```text
tests 2237
pass 2237
fail 0
duration_ms 36253.945792
```

테스트 수가 2,147에서 2,237로 늘었고, isolation/worktree slot 회귀를 포함한 전체 hook 하네스가 green이다.

---

## v2 최종 평가 (2026-06-01)

**2026-06-06 업데이트**: §9 macOS tmpdir vs isSafeAbsolutePath 자기모순 fix 이후
`npm test` 2,237 / 0 fail 재확인. Ship-ready 판정 유지.

**Ship 준비 완료(2026-06-01 기준)**:
- 정책 엔진 통합 (per-hook entrypoint fanout → 1 dispatcher, 6 hooks.json event entries)
- 평가 결손 8개 모두 구조 해결 (Law 2 Bash bypass, Evidence Latch 구조화,
  Channel Registry enforcement, Tier 4 drift verdict, quality-gate retry 등)
- 병렬 인프라 **빌드 + 활성화** 완료
- production smoke (cmux-control) Law 2 + Channel Registry 검증
- 2,237 hooks 테스트 통과 (2026-06-06 로컬 재실행)
- 알려진 commit gap 8/10 closed (2개 intentional deferral)
- v0.19.0 bump + docs 화해 + frontmatter validation 통합

**남은 본질적 작업**:
- Production smoke 확대 (실 /mpl run 사이클) — 수동 작업
- Stage B NICE-to-have — 누적 사용 데이터 의존

**완료 메시지**: v2 = 정책 엔진 통합 + 평가 결손 8개 구조 해결 + 병렬 활성화 + 알려진 gap 8/10 closed + production smoke 검증 + macOS isolation safe-path fix. Agent/command 통합은 AD-0007 invariant에 의해 superseded되어 Won't Do. **Production ship 가능.**
