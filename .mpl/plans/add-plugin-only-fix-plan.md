# add-plugin-only 브랜치 수정 계획

> 생성일: 2026-04-04
> 대상 브랜치: `add-plugin-only`
> 스캔 기반: 코드 리뷰 + MCP 런타임 환경 확인

---

## 검증 요약

시스템 환경에서 확인된 실제 MCP 서버:
- `mcp__ccviz-spec__` (v2 아님): `create_node`, `add_edge`, `get_graph`, `import_graph`, `layout_graph`, `remove_node`, `update_node`
- `bluepill-v2`: **존재하지 않음** (MCP 서버 목록에 없음)

---

## CRITICAL

### T-01: MCP 서버 이름 불일치 — ccviz-spec-v2 → ccviz-spec

**문제**: 코드 전체에서 `mcp__ccviz-spec-v2__render_flow`, `mcp__ccviz-spec-v2__get_feedback`, `mcp__ccviz-spec-v2__get_flow` 등 존재하지 않는 MCP 도구를 참조. 실제 서버는 `mcp__ccviz-spec__`이며 도구는 `create_node`, `add_edge`, `get_graph`, `import_graph`, `layout_graph`, `remove_node`, `update_node`.

**영향 파일 및 변경 사항**:

| # | 파일 | 변경 내용 |
|---|------|-----------|
| 1 | `commands/mpl-run-phase0.md` (L498~559) | `mcp__ccviz-spec-v2__render_flow()` → `mcp__ccviz-spec__create_node()` + `mcp__ccviz-spec__add_edge()` + `mcp__ccviz-spec__layout_graph()` 조합으로 교체. `get_feedback()` → `mcp__ccviz-spec__get_graph()` 기반 피드백 루프로 재설계. `get_flow()` → `mcp__ccviz-spec__get_graph()` |
| 2 | `docs/design.md` (L89, L141~147) | Step 1.0-A 설명에서 `ccviz-spec-v2` → `ccviz-spec`, `render_flow()` → 실제 API(`create_node`/`add_edge`/`layout_graph`) 반영 |
| 3 | `skills/mpl-setup/SKILL.md` (L296~366) | 탐지 코드 `mcp__ccviz-spec-v2__get_flow()` → `mcp__ccviz-spec__get_graph()`, 결과 표시 `ccviz-spec-v2` → `ccviz-spec` |
| 4 | `skills/mpl/SKILL.md` (L72) | Phase Overview 테이블에서 `ccviz` 라벨 유지하되 내부 참조가 실제 MCP와 일치하는지 확인 |

**기대 결과**: Frontier 티어에서 ccviz 플러그인 세션이 실제 MCP 도구로 실행됨.

### T-02: bluepill-v2 MCP 서버 완전 제거 또는 스텁 처리

**문제**: `mcp__bluepill-v2__propose_layout`, `mcp__bluepill-v2__get_feedback`, `mcp__bluepill-v2__export_layout`, `mcp__bluepill-v2__done` — 이 서버는 시스템에 존재하지 않음. 실행 시 100% 실패.

**영향 파일 및 변경 사항**:

| # | 파일 | 변경 내용 |
|---|------|-----------|
| 1 | `commands/mpl-run-phase0.md` (L565~636) | Step 1.0-B 전체를 "미구현 플러그인" 스텁으로 교체. 진입 시 `Announce: "[MPL] bluepill plugin not yet available. Skipping."` 후 Step 1.1로 건너뛰기 |
| 2 | `docs/design.md` (L90, L145~147) | Step 1.0-B를 "계획됨 (미구현)"으로 표기, `bluepill-v2` 참조 제거 |
| 3 | `skills/mpl-setup/SKILL.md` (L304~306, L366, L629~630) | bluepill 탐지 코드 제거, 결과 표시에서 `bluepill-v2` → `bluepill (planned, not available)` |
| 4 | `skills/mpl/SKILL.md` (L73) | Phase Overview에서 bluepill 행에 "(planned)" 표기 |

**기대 결과**: bluepill 미설치 환경에서 파이프라인이 정상 스킵, 사용자에게 명확한 안내 제공.

### T-03: writeState()-debugLog() 구조적 커플링

**문제**: `hooks/lib/mpl-state.mjs` L149에서 `writeState()`가 `debugLog()`를 호출. 현재 `debugLog()`는 상태를 읽지 않으므로 재귀는 발생하지 않지만, 향후 `debugLog()`가 상태를 참조하게 되면 무한 재귀 발생.

**파일**: `hooks/lib/mpl-state.mjs` (L149~153)

**변경 내용**:
```javascript
// 변경 전
debugLog(cwd, 'state-change', `State updated: ${Object.keys(patch).join(', ')}`, { ... });

// 변경 후 — try-catch 래핑 + 재귀 방어 플래그
const _writingState = new WeakSet();
// writeState 내부:
if (_writingState.has(patch)) return merged;
_writingState.add(patch);
try {
  debugLog(cwd, 'state-change', ...);
} finally {
  _writingState.delete(patch);
}
```

또는 더 단순한 접근: 모듈 레벨 `let _inWriteState = false` 플래그로 가드.

**기대 결과**: writeState↔debugLog 간 재귀 가능성 원천 차단.

---

## HIGH

### T-04: 디버그 로그 파일 크기 무제한

**문제**: `hooks/lib/mpl-debug.mjs` L89에서 `appendFileSync`로 무한 추가. 장시간 실행 시 debug.log가 수백 MB까지 성장 가능.

**파일**: `hooks/lib/mpl-debug.mjs` (L67~94, `debugLog` 함수)

**변경 내용**:
1. `debugLog()` 진입부에 파일 크기 체크 추가:
   ```javascript
   const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB
   const logPath = join(logDir, DEBUG_FILE);
   if (existsSync(logPath)) {
     const { size } = statSync(logPath);
     if (size > MAX_LOG_SIZE) {
       // 로테이트: 기존 → debug.log.1, 새 파일 시작
       renameSync(logPath, logPath + '.1');
     }
   }
   ```
2. `fs` import에 `statSync`, `renameSync` 추가
3. `debugError()` 동일 패턴 적용 (L140~155)

**기대 결과**: debug.log가 5MB 초과 시 자동 로테이트, 최대 2개 파일(~10MB) 유지.

### T-05: SKILL.md Phase Overview ↔ design.md Step 목록 불일치

**문제**: `skills/mpl/SKILL.md` Phase Overview 테이블에는 Step 0, 1.0, 1.0-A, 1.0-B, 1.1, 2, 2.5, 3, 4, 5만 있음. `docs/design.md`에는 Step 0.0.5, 0.5, 0.6, 1-B, 1-D, 1-E, 2.4, 3-F, 3-B, 6이 추가로 존재. 라우팅 테이블의 "Pre-Execution (Steps 0~2.5)"는 정확하지만 Phase Overview가 불완전.

**파일**: `skills/mpl/SKILL.md` (L66~79)

**변경 내용**: Phase Overview 테이블에 누락된 주요 스텝 추가:
```markdown
| Step | Name | Key Action | Agent |
|------|------|------------|-------|
| 0 | Triage + R0 Depth | Pipeline tier + feature scope depth | (orchestrator) |
| 0.5 | Maturity Mode | explore/standard/strict 결정 | (orchestrator) |
| 0.6 | R0 Depth Decision | 플러그인 기반 r0_depth 결정 | (orchestrator) |
| 1.0 | R0 Feature Scope | Feature list, user flows, I/O (optional) | mpl-interviewer (opus) |
| 1.0-A | ccviz Session | Flow visualization + feedback (optional) | (orchestrator via ccviz MCP) |
| 1.0-B | bluepill Session | UI mockup (planned, not available) | — |
| 1.1 | PP Interview | Immutable constraints | mpl-interviewer (opus) |
| 1-B | Pre-Execution Analysis | Missing reqs, AI pitfalls, risk | mpl-pre-execution-analyzer |
| 1-D | PP Confirmation | PP 최종 확인 | (orchestrator) |
| 1-E | Interview Snapshot | 인터뷰 스냅샷 저장 | (orchestrator) |
| 2 | Codebase Analysis | Structure extraction | (orchestrator) |
| 2.5 | Phase 0 Enhanced | Complexity-adaptive pre-analysis | (orchestrator) |
| 3 | Phase Decomposition | Break into micro-phases | mpl-decomposer (opus) |
| 4 | Phase Execution Loop | plan→execute→verify per phase | mpl-phase-runner x N |
| 5 | Finalize | Learnings + commit | mpl-git-master, mpl-compound |
```

**기대 결과**: SKILL.md가 실제 파이프라인 흐름의 정확한 요약본 역할 수행.

### T-06: R0 depth 조건 — design.md vs phase0.md 불일치

**문제**:
- `docs/design.md` L133: `"skip"` 조건 = "No plugins installed OR **density 8+**"
- `commands/mpl-run-phase0.md` L439: `interview_depth == "skip"` 일 때 r0_depth = "skip"
- 하지만 `docs/pm-design.md` L79에서는 "F-35: skip 옵션 제거 — interview always runs at minimum light level"이라고 명시

3개 문서가 서로 다른 조건을 기술.

**파일 및 변경 내용**:

| # | 파일 | 변경 |
|---|------|------|
| 1 | `docs/design.md` (L129~135) | 조건을 phase0.md와 일치시키거나, pm-design.md의 F-35(skip 제거) 반영 여부 결정 필요. **우선**: phase0.md를 SSOT로 삼아 design.md 업데이트. "density 8+" → `interview_depth == "skip"` 또는 skip 제거 후 light 최소 보장 |
| 2 | `commands/mpl-run-phase0.md` (L439) | F-35가 적용된다면 `interview_depth == "skip"` 분기를 제거하고, `interview_depth == "light"` + density 8+ 케이스로 통합 |
| 3 | `docs/pm-design.md` | F-35 적용 범위 명확화 (PM 모드 한정인지 전체 파이프라인인지) |

**기대 결과**: R0 depth 결정 로직이 모든 문서에서 동일한 조건 표 사용.

---

## MEDIUM

### T-07: clearDebugLog 테스트 누락

**문제**: `hooks/lib/mpl-debug.mjs`의 `clearDebugLog()` 함수(L162~171)가 export되어 있지만 `hooks/__tests__/mpl-debug.test.mjs`에 테스트 없음. import 목록에도 빠져 있음.

**파일**: `hooks/__tests__/mpl-debug.test.mjs`

**변경 내용**:
1. import에 `clearDebugLog` 추가 (L15)
2. 테스트 케이스 추가:
   ```javascript
   describe('clearDebugLog', () => {
     let cwd;
     beforeEach(() => { cwd = makeTmpDir(); });
     afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

     it('should clear existing log file', () => {
       writeConfig(cwd, { debug: true });
       debugLog(cwd, 'triage', 'Some entry');
       assert.ok(readLog(cwd).length > 0);
       clearDebugLog(cwd);
       assert.equal(readLog(cwd), '');
     });

     it('should not throw when log file does not exist', () => {
       assert.doesNotThrow(() => clearDebugLog(cwd));
     });
   });
   ```

**기대 결과**: clearDebugLog 함수의 정상/비정상 경로 모두 테스트 커버리지 확보.

### T-08: feature_scope.status 상태 머신 미정의

**문제**: `commands/mpl-run-phase0.md`에서 `feature_scope.status`가 순차적으로 덮어쓰기됨:
- L487: `'r0_complete'`
- L558: `'ccviz_complete'`
- L635: `'bluepill_complete'`

ccviz를 건너뛰고 bluepill만 실행하면 `r0_complete` → `bluepill_complete`로 전이 (ccviz_complete 스킵). 스킵 시나리오의 최종 상태가 정의되지 않음. 또한 r0_depth가 skip이면 feature_scope.status는 아예 설정되지 않음.

**파일**: `commands/mpl-run-phase0.md` (L487, L558, L635 부근)

**변경 내용**:
1. feature_scope.status에 명시적 상태 전이 표 추가:
   ```
   // 상태 전이:
   // (없음) → r0_complete → ccviz_complete → bluepill_complete → scope_finalized
   //                       → scope_finalized (ccviz 스킵)
   //        → scope_finalized (r0 스킵)
   ```
2. 각 스킵 분기에 적절한 상태 설정 추가:
   - r0_depth == "skip" 시: `writeState(cwd, { feature_scope: { status: 'scope_skipped', r0_depth: 'skip' } })`
   - ccviz 스킵 시: status 유지 (다음 단계에서 갱신)
   - bluepill 스킵 시: `writeState(cwd, { feature_scope: { status: 'scope_finalized' } })`
3. Step 1.1 직전에 최종 상태 정규화:
   ```
   if feature_scope.status not in ['scope_finalized', 'scope_skipped']:
     writeState(cwd, { feature_scope: { status: 'scope_finalized' } })
   ```

**기대 결과**: 어떤 스킵 조합이든 feature_scope.status가 예측 가능한 최종 상태로 수렴.

---

## LOW

### T-09: mpl-interviewer.md R0 가드 조건 중복

**문제**: `agents/mpl-interviewer.md`에서 r0_depth 가드 조건이 두 곳에 기술됨:
- Constraints 블록 (L51~54): `"skip": Do not run R0. Proceed directly to R1.`
- Interview_Rounds 블록 (L226): `Only runs when r0_depth is "light" or "full". Skipped entirely when r0_depth is "skip".`

동일 규칙의 중복이며 향후 한 쪽만 수정 시 불일치 리스크.

**파일**: `agents/mpl-interviewer.md` (L226)

**변경 내용**: Interview_Rounds의 R0 가드를 Constraints 참조로 변경:
```markdown
### Round 0: Feature Scope (What to Build)
Discover what features to build, user flows, and I/O definitions.
R0 activation is controlled by `r0_depth` — see Constraints above.
```

**기대 결과**: 단일 정의 원칙(SSOT) 준수, 향후 변경 시 한 곳만 수정하면 됨.

### T-10: 동기 I/O 사용 (readFileSync + appendFileSync)

**문제**: `hooks/lib/mpl-debug.mjs` 전체에서 동기 파일 I/O 사용. 매 호출마다 `readFileSync`(config) + `appendFileSync`(log). hook 특성상 빈번 호출 시 이벤트 루프 차단.

**파일**: `hooks/lib/mpl-debug.mjs`

**변경 내용** (권장 — 우선순위 낮음, 성능 문제 측정 후 적용):
1. config 캐시: 모듈 레벨에서 config를 캐시하고, `mtime` 비교로 변경 시에만 재로드
   ```javascript
   let _configCache = null;
   let _configMtime = 0;

   export function getDebugConfig(cwd) {
     const configPath = join(cwd, CONFIG_DIR, CONFIG_FILE);
     try {
       const { mtimeMs } = statSync(configPath);
       if (_configCache && mtimeMs === _configMtime) return _configCache;
       _configMtime = mtimeMs;
       // ... 기존 로직 ...
       _configCache = result;
       return result;
     } catch { ... }
   }
   ```
2. appendFileSync는 hook 실행 컨텍스트상 동기가 적절 (비동기 시 로그 유실 가능) — 유지

**기대 결과**: config 읽기 I/O가 ~90% 감소 (변경 시에만 읽기). append는 현행 유지.

---

## 실행 순서

```
T-01 (CRITICAL: ccviz MCP 이름 수정) ─┐
T-02 (CRITICAL: bluepill 제거/스텁)   ─┤── 병렬 가능 (파일 겹침 주의)
T-03 (CRITICAL: writeState 재귀 방어) ─┘

T-06 (HIGH: R0 depth 문서 통일) ← T-01, T-02 완료 후 (design.md 공유)
T-05 (HIGH: SKILL.md Phase Overview) ← T-02 완료 후 (bluepill 표기 반영)
T-04 (HIGH: 로그 크기 제한)

T-08 (MEDIUM: status 상태 머신) ← T-02 완료 후 (bluepill 스킵 로직 반영)
T-07 (MEDIUM: clearDebugLog 테스트) ← T-04 완료 후 (로테이트 로직 포함 시)

T-09 (LOW: R0 가드 중복)
T-10 (LOW: config 캐시)
```

## 최종 검증 단계

### V-01: MCP 도구 이름 전수 검사
```bash
grep -rn "ccviz-spec-v2\|bluepill-v2" --include="*.mjs" --include="*.md" --include="*.ts" --include="*.json" | grep -v node_modules | grep -v '.git/'
# 기대 결과: 0건
```

### V-02: 실제 MCP 도구 참조 검증
```bash
grep -rn "mcp__ccviz-spec__" --include="*.md" | grep -v node_modules
# 기대 결과: create_node, add_edge, get_graph, layout_graph 등 실제 도구만 참조
```

### V-03: 테스트 실행
```bash
cd MPL && node --test hooks/__tests__/mpl-debug.test.mjs
cd MPL && node --test hooks/__tests__/mpl-state.test.mjs
# 기대 결과: 전체 통과, clearDebugLog 테스트 포함
```

### V-04: feature_scope.status 추적
```bash
grep -n "feature_scope.*status" commands/mpl-run-phase0.md
# 기대 결과: 모든 분기(실행/스킵)에서 status 설정 확인
```

### V-05: R0 depth 조건 일관성
```bash
grep -n "r0_depth.*skip\|density.*8\|interview_depth.*skip" docs/design.md commands/mpl-run-phase0.md docs/pm-design.md
# 기대 결과: 3개 파일이 동일 조건 사용
```

### V-06: writeState 재귀 방어 확인
```bash
grep -A5 "debugLog" hooks/lib/mpl-state.mjs
# 기대 결과: 재귀 가드 또는 try-catch 래핑 확인
```
