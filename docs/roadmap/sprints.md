# v3.2 Sprint 계획

> Sprint 1 완료 기준으로 남은 10개 항목을 4개 Sprint로 구성.
> 작성일: 2026-03-08

---

## 완료: Sprint 1 — Adaptive Router Core (F-20, F-21, F-10, F-14)

단일 진입점 + 자동 tier 분류 + 동적 에스컬레이션 + RUNBOOK 기반 확립.

---

## 완료: Sprint 2 — 실행 간 학습과 세션 연속성 (F-12, F-11, F-22)

> 테마: "기억하는 파이프라인" — 실행이 끝나도 교훈이 남고, 세션이 바뀌어도 맥락이 유지된다.

| ID | 항목 | 우선순위 | 의존성 | 핵심 산출물 |
|----|------|---------|--------|-----------|
| F-11 | Run-to-Run 학습 축적 | HIGH | F-10(RUNBOOK) 완료 | `.mpl/memory/learnings.md`, mpl-compound 증류 로직 |
| F-12 | 세션 내 컨텍스트 영속 | HIGH | 없음 | `<remember priority>` 마킹 프로토콜, RUNBOOK 이중 안전망 |
| F-22 | Routing Pattern Learning | MED | F-20(Router) 완료 | `.mpl/memory/routing-patterns.jsonl`, Jaccard 매칭 |

### 의존성 그래프

```
F-10 (RUNBOOK, 완료) ──→ F-11 (학습 증류)
                              │
F-20 (Router, 완료) ──→ F-22 (패턴 학습) ←─ F-11 (learnings와 별도 파일이지만 Finalize에서 동시 기록)

F-12 (컨텍스트 영속) ──→ 독립, 단 F-11과 함께 적용 시 시너지
```

### 구현 순서

1. **F-12** — `<remember priority>` 태그 프로토콜을 mpl-run.md 페이즈 전환 지점에 삽입. 가장 독립적이고 즉시 효과.
2. **F-11** — RUNBOOK decisions/issues → learnings.md 증류 로직. mpl-run-finalize.md에 증류 단계 추가.
3. **F-22** — routing-patterns.jsonl 기록/매칭. Triage에 패턴 참조, Finalize에 결과 기록 추가.

### 검증 기준

- [ ] 세션 압축(compaction) 후에도 현재 페이즈/PP 요약/실패 원인이 유지됨 (F-12)
- [ ] 실행 완료 후 learnings.md에 failure/success 패턴이 자동 기록됨 (F-11)
- [ ] 다음 실행 Phase 0에서 learnings.md가 자동 로드됨 (F-11)
- [ ] routing-patterns.jsonl에 실행 결과가 append됨 (F-22)
- [ ] 유사 태스크 재실행 시 이전 tier가 추천됨 (F-22)

---

## 완료: Sprint 3 — Phase Runner 실행 엔진 강화 (F-24, F-23, F-13)

> 테마: "더 빠르고 더 자율적인 실행" — Phase Runner가 병렬로 일하고, 스스로 맥락을 찾는다.

| ID | 항목 | 우선순위 | 의존성 | 핵심 산출물 |
|----|------|---------|--------|-----------|
| F-23 | Task-based TODO 관리 | MED | 없음 | Task tool 기반 TODO 디스패치, mini-plan.md 대체 |
| F-13 | Background Execution | MED | F-23과 시너지 | `run_in_background: true` 병렬 worker, 파일 충돌 감지 연동 |
| F-24 | Self-Directed Context | MED | 없음 | Phase Runner scope-bounded search 허용 |

### 의존성 그래프

```
F-23 (Task TODO) ←──시너지──→ F-13 (Background Exec)
  │                              │
  └── 독립 TODO를 Task로 관리      └── 독립 Task를 병렬 실행

F-24 (Self-Directed Context) ── 독립, 단 F-23 Task 구조에서 scope 전달 가능
```

### 구현 순서

1. **F-24** — Phase Runner에 Read/Grep 허용 + scope boundary 정의. 가장 독립적이고 즉시 실행 품질 향상.
2. **F-23** — mini-plan.md 체크박스 → Task tool 전환. Phase Runner 프로토콜 재설계.
3. **F-13** — F-23의 Task 구조 위에서 독립 TODO를 `run_in_background: true`로 병렬 디스패치.

### 검증 기준

- [ ] Phase Runner가 impact 범위 내 파일을 직접 Read/Grep하여 컨텍스트를 획득함 (F-24)
- [ ] TODO가 Task tool로 관리되고 worker 간 상태 동기화됨 (F-23)
- [ ] 파일 충돌 없는 독립 TODO가 병렬 실행됨 (F-13)
- [ ] 파일 충돌 감지 시 자동 순차 강제됨 (F-13)

---

## 완료: Sprint 4 — 품질 인프라와 독립성 (F-16, F-17, F-04)

> 테마: "더 정확하고 더 가벼운 MPL" — 경량 탐색 에이전트, 타입 안전, OMC 독립.

| ID | 항목 | 우선순위 | 의존성 | 핵심 산출물 |
|----|------|---------|--------|-----------|
| F-16 | mpl-scout 에이전트 | MED | 없음 | haiku 기반 탐색 에이전트 (Read/Glob/Grep/LSP만) |
| F-17 | lsp_diagnostics_directory 통합 | MED | 없음 | Gate 1 전 프로젝트 타입 체크, standalone 폴백 |
| F-04 | Standalone 독립 동작 | HIGH | F-17과 시너지 | OMC 의존성 제거, Grep/Glob 폴백, mpl-doctor 진단 |

### 의존성 그래프

```
F-16 (scout) ── 독립. Phase 0, Fix Loop, Phase Runner 보조에 투입

F-17 (diagnostics) ──→ F-04 (standalone)
  │                      │
  └── tool_mode=full     └── standalone이면 tsc/py_compile 폴백
```

### 구현 순서

1. **F-16** — mpl-scout 에이전트 정의. agents/mpl-scout.md 생성, haiku 모델, 읽기 전용 도구만 허용.
2. **F-17** — Gate 1에 lsp_diagnostics_directory 호출 추가. standalone 폴백 명세.
3. **F-04** — OMC 도구(lsp_*, ast_grep) 없을 때 Grep/Glob 폴백 경로 구현. mpl-setup, mpl-doctor 완성.

### 검증 기준

- [ ] mpl-scout가 Phase 0 구조 분석에서 sonnet/opus 대비 토큰 50%+ 절감 (F-16)
- [ ] Gate 1 전에 프로젝트 전체 타입 에러가 감지됨 (F-17)
- [ ] OMC 미설치 환경에서 MPL 전체 파이프라인이 정상 동작함 (F-04)
- [ ] `/mpl:mpl-doctor`가 누락 도구를 진단하고 폴백 상태를 보고함 (F-04)

---

## 완료: Sprint 5 — 4-Tier 메모리 및 고급 격리 (F-25, F-15, F-05)

> 테마: "더 효율적이고 안전한 MPL" — 4-Tier Adaptive Memory, 위험 작업 격리, 캐시 개선.
> 업데이트: 2026-03-13 리서치 결과 반영 (F-25: 3-Tier → 4-Tier 확장)

| ID | 항목 | 우선순위 | 의존성 | 핵심 산출물 |
|----|------|---------|--------|-----------|
| F-25 | 4-Tier Adaptive Memory | HIGH | F-11, F-24 | episodic.md, semantic.md, procedural.jsonl, working.md, 70%+ 토큰 절감 |
| F-15 | Worktree 격리 실행 | MED | 없음 | risk=HIGH 페이즈를 worktree에서 실행, 성공 시 머지 |
| F-05 | Phase 0 캐시 부분 무효화 | LOW | 없음 | 변경 모듈만 재분석, git diff 기반 무효화 |

### 의존성 그래프

```
F-25 (4-Tier Memory) ──→ F-11 (learnings.md)
  │                         │
  └── episodic/semantic/    └── procedural.jsonl → learnings.md 증류
      procedural/working

F-25 ──→ F-24 (Self-Directed Context)
  │         │
  └── procedural.jsonl 참조  └── 효과적 도구 우선 선택

F-25 ──→ F-27 (Reflexion, Sprint 6)
  │         │
  └── procedural.jsonl 저장소  └── 반성 결과를 분류별 저장

F-15, F-05 — 독립
```

### 구현 순서

1. **F-25** — 4-Tier Adaptive Memory. RUC DeepAgent + Letta(MemGPT) + 최신 메모리 연구 종합.
   - Step 1: `episodic.md` — Phase 완료 시 요약 추가 + 시간 기반 압축 (최근 2 Phase 상세, 이전은 1-2줄)
   - Step 2: `semantic.md` — episodic에서 3회+ 반복 패턴을 일반화하여 프로젝트 지식으로 승격
   - Step 3: `procedural.jsonl` — 도구 사용 패턴 수집 + 분류 태그(type_mismatch, dependency_conflict 등)
   - Step 4: `working.md` — 현재 Phase TODO 동적 업데이트 (Phase Runner 자율 갱신)
   - Step 5: Phase 0 선택적 로드 — 전체 파일이 아닌 관련 메모리만 유사도 기반 필터링
   - Step 6: Phase Runner 프로토콜에 4-tier 메모리 로드 추가
2. **F-15** — Pre-Execution Analysis에서 risk=HIGH 판정 시 worktree 생성/머지/정리 프로토콜.
3. **F-05** — Phase 0 캐시에 git diff 기반 부분 무효화. 변경된 파일의 모듈만 재분석.

### 검증 기준

- [ ] Phase 5+ 실행 시 컨텍스트 로딩 토큰 70%+ 절감 (F-25)
- [ ] procedural.jsonl에 도구 성공/실패 패턴이 분류 태그와 함께 수집됨 (F-25)
- [ ] episodic.md에 시간 기반 압축 적용 — 최근 2 Phase 상세, 이전 압축 (F-25)
- [ ] semantic.md에 3회+ 반복 패턴이 자동 일반화되어 저장됨 (F-25)
- [ ] Phase 0에서 관련 메모리만 선택적 로드됨 (전체 파일 로드 아님) (F-25)
- [ ] mpl-compound가 procedural.jsonl → learnings.md 자동 증류 (F-25)
- [ ] 반복 프로젝트 Phase 0 시간 20-30% 추가 단축 (semantic.md 효과) (F-25)
- [ ] risk=HIGH 페이즈가 worktree에서 격리 실행되고 성공 시 자동 머지됨 (F-15)
- [ ] 파일 1개 변경 시 전체 Phase 0 재실행 없이 해당 모듈만 재분석됨 (F-05)

---

---

## 완료: Sprint 6 — 소크라틱 인터뷰 통합 및 학습 고도화 (F-26, F-27, F-28)

> 테마: "더 똑똑한 MPL" — 소크라틱 인터뷰로 PP+요구사항 통합, Reflexion으로 학습 고도화, 동적 라우팅으로 실행 최적화.
> 추가일: 2026-03-13 리서치 결과 기반 신규 Sprint.
> 업데이트: 2026-03-13 — F-26을 별도 PM 단계에서 mpl-interviewer v2 통합으로 방향 전환.

| ID | 항목 | 우선순위 | 의존성 | 핵심 산출물 |
|----|------|---------|--------|-----------|
| F-26 | mpl-interviewer v2: 소크라틱 통합 인터뷰 | MED | 없음 (기존 mpl-interviewer 업그레이드) | 통합 출력(PP + requirements.md), good/bad examples 아카이브 |
| F-27 | Reflexion 기반 Fix Loop 학습 | MED | F-25(procedural.jsonl) | Reflection Template, 패턴 분류 저장, 선택적 로드 |
| F-28 | Phase별 동적 에이전트 라우팅 | MED | 없음 | Decomposer `phase_domain` 태그, 도메인별 프롬프트 매칭 |

### F-26 설계 방향: 별도 단계 추가가 아닌 기존 통합

**이전 방향 (폐기)**: Triage에 `needs_pm` 판정 추가 → Step 0.5-PM 별도 활성화 → mpl-pm 신규 에이전트
**새 방향 (채택)**: 기존 mpl-interviewer를 v2로 업그레이드. `interview_depth`(skip/light/full)에 따라 PM 역할 범위를 자동 조절

**근거**:
1. 기존 Triage의 `interview_depth`가 이미 규모별 인터뷰 깊이를 3단계로 조절하고 있음
2. PM 소크라틱 질문 Round 2("절대 깨뜨리면 안 되는 것은?")가 PP 발견과 실질적으로 동일
3. 사용자가 PM 인터뷰 + PP 인터뷰를 2회 연속으로 받는 것은 피로감 유발
4. UAM uam-pm도 이미 PP 섹션을 출력에 포함 — 분리의 실익 없음

**interview_depth별 통합 동작**:

| depth | PP (기존) | 요구사항 (신규) | 소크라틱 질문 | 솔루션 옵션 |
|-------|----------|---------------|-------------|-----------|
| `skip` | 프롬프트에서 직접 추출 | 없음 | 없음 | 없음 |
| `light` | Round 1-2 (What + What NOT) | 경량 구조화 (US + AC) | 명확화 + 가정 탐색만 | 없음 |
| `full` | Round 1-4 전체 | JUSF 전체 (JTBD + US + Gherkin AC) | **6유형 전체** | **3+ 옵션 + 매트릭스** |

### 의존성 그래프

```
mpl-interviewer (기존, 완료) ──→ F-26 (v2 업그레이드)
  │                                │
  └── interview_depth 3단계         └── depth별 PM 역할 자동 확장
      + PP 발견                         + 소크라틱 질문 + 옵션 비교
                                        + JUSF 출력 + good/bad archive

F-25 (4-Tier Memory) ──→ F-27 (Reflexion)
  │                        │
  └── procedural.jsonl      └── 반성 결과를 분류별 저장
                               Fix Loop 성공률 향상

F-28 (Dynamic Routing) ── 독립 (Decomposer 출력 확장)
```

### 구현 순서

1. **F-26** — mpl-interviewer v2: 소크라틱 통합 인터뷰
   - Step 1: 기존 `mpl-interviewer.md` 에이전트를 v2로 업그레이드 (별도 에이전트 생성 불필요)
   - Step 2: `interview_depth=full`일 때 소크라틱 6유형 질문 라이브러리 추가
     - 명확화 / 가정 탐색 / 근거 / 관점 전환 / 결과 탐색 / 메타 (AI_PM 참조)
     - 코딩 에이전트 맥락으로 적응 (시장 적합성 → 기술적 가정/범위 도전)
   - Step 3: `interview_depth=full`일 때 솔루션 옵션 3+ 제시 + 트레이드오프 매트릭스
     - 복잡도 / 토큰 비용 / 테스트 커버리지 / 의존성 리스크 축
   - Step 4: 통합 출력 스키마 — PP + JUSF(JTBD + User Stories + Gherkin AC) 단일 산출물
     - Dual-Layer: YAML frontmatter(파이프라인 파싱) + Markdown body(사용자 검토)
     - MoSCoW + sequence_score 우선순위
   - Step 5: `interview_depth=light`일 때 경량 요구사항 구조화 추가 (US + AC만)
   - Step 6: 증거 태깅 (🟢데이터/🟡유추/🔴가정) + 소크라틱 대화 로그 보존
   - Step 7: 멀티 관점 리뷰 (엔지니어/아키텍트/사용자) — full일 때만
   - Step 8: `.mpl/pm/good-examples/`, `.mpl/pm/bad-examples/` 아카이브 + F-25 memory 연동
   - Step 9: 다운스트림 연결 — 통합 출력 → Phase 0(제약) / Decomposer(순서) / Test Agent(Gherkin)
2. **F-27** — Reflexion 기반 Fix Loop 학습
   - Step 1: Reflection Template 설계 — 실패 TODO → 증상 → 근본 원인 → 최초 이탈 지점 → 수정 전략 → 학습 추출
   - Step 2: Fix Loop 진입 시 Reflection 실행 (Phase Runner 프로토콜에 삽입)
   - Step 3: 반성 결과를 패턴 분류 태그(type_mismatch, dependency_conflict, test_flake 등)하여 procedural.jsonl에 저장
   - Step 4: Gate 2 실패 시 mpl-code-reviewer 피드백을 반성에 통합 (MAR 패턴)
   - Step 5: Phase 0에서 태스크 설명 유사도 기반으로 관련 패턴만 선택적 로드
3. **F-28** — Phase별 동적 에이전트 라우팅
   - Step 1: Decomposer 출력에 `phase_domain` 태그 추가 (db/api/ui/algorithm/test/infra)
   - Step 2: 도메인별 프롬프트 템플릿 라이브러리 (`.mpl/prompts/domains/`)
   - Step 3: Phase Runner가 `phase_domain` → 매칭 프롬프트 자동 선택
   - Step 4: 도메인별 최적 모델 라우팅 (DB→sonnet, 복잡 알고리즘→opus)

### 검증 기준

- [ ] `interview_depth=full`일 때 소크라틱 6유형 질문이 실행됨 (F-26)
- [ ] `interview_depth=full`일 때 솔루션 옵션 3+개가 트레이드오프 매트릭스와 함께 제시됨 (F-26)
- [ ] `interview_depth=light`일 때 PP + 경량 요구사항(US+AC)이 단일 인터뷰로 출력됨 (F-26)
- [ ] `interview_depth=skip`일 때 기존 동작(PP 직접 추출)이 변경 없이 유지됨 (F-26)
- [ ] 통합 출력이 YAML frontmatter + Markdown body Dual-Layer로 생성됨 (F-26)
- [ ] Gherkin AC가 Test Agent에서 테스트 케이스로 변환됨 (F-26)
- [ ] good/bad examples 아카이브가 사용자 승인/거부에 따라 자동 분류됨 (F-26)
- [ ] 인터뷰 1회로 PP+요구사항 동시 해결 — 기존 대비 사용자 인터뷰 횟수 증가 없음 (F-26)
- [ ] Fix Loop 진입 시 Reflection Template가 실행됨 (F-27)
- [ ] 반성 결과가 분류 태그와 함께 procedural.jsonl에 저장됨 (F-27)
- [ ] 다음 실행 Phase 0에서 유사 패턴이 선택적 로드됨 (F-27)
- [ ] Fix Loop 성공률이 Reflexion 미적용 대비 향상됨 (A/B 비교) (F-27)
- [ ] Decomposer 출력에 `phase_domain` 태그가 포함됨 (F-28)
- [ ] Phase Runner가 도메인별 특화 프롬프트를 자동 선택함 (F-28)

---

## 전체 타임라인

```
Sprint 1 (완료)  ██████████  F-20, F-21, F-10, F-14     ← 라우터/RUNBOOK
Sprint 2 (완료)  ██████████  F-12, F-11, F-22            ← 학습/영속
Sprint 3 (완료)  ██████████  F-24, F-23, F-13            ← 실행 엔진
Sprint 4 (완료)  ██████████  F-16, F-17, F-04            ← 품질/독립
Sprint 5 (완료)  ██████████  F-25, F-15, F-05            ← 4-Tier 메모리/격리
Sprint 6 (완료)  ██████████  F-26, F-27, F-28            ← PM/Reflexion/동적라우팅
Sprint 7         ░░░░░░░░░░  F-33                        ← 세션 자율 연속성
```

## Sprint 간 의존성

```
Sprint 1 ──→ Sprint 2 (F-10→F-11, F-20→F-22)
Sprint 2 ──→ Sprint 3 (learnings가 Phase Runner에서 참조됨)
Sprint 3 ──→ Sprint 4 (F-16 scout가 F-24 self-directed와 보완)
Sprint 4 ──→ Sprint 5 (F-11→F-25 procedural.jsonl 증류, F-24→F-25 도구 선택)
Sprint 5 ──→ Sprint 6 (F-25→F-27 procedural.jsonl 저장소, F-20→F-26 Triage 확장)
Sprint 6 ──→ Sprint 7 (F-31/F-32→F-33 compaction 데이터 + adaptive loading)
```

**Sprint 5 핵심:**
- F-25를 3-Tier에서 4-Tier로 확장 (semantic.md 추가)
- episodic→semantic 자동 통합으로 반복 프로젝트 Phase 0 단축
- procedural.jsonl → learnings.md 자동 증류 (mpl-compound)
- 시간 기반 압축 + 선택적 로드로 토큰 절감 극대화

**Sprint 6 핵심:**
- F-26 (PM Skill)이 Phase 0 사전 명세를 비즈니스 레벨까지 확장
- F-27 (Reflexion)이 Fix Loop 학습을 구조화하여 실패 반복 감소
- F-28 (동적 라우팅)이 Phase 실행 품질을 도메인 특화로 향상
- 세 기능 모두 기존 파이프라인에 점진적 통합 가능 (비침습적)

---

## Sprint 7 — 세션 자율 연속성 (F-33)

> 테마: "끊기지 않는 파이프라인" — 세션 한계를 예측하고 자동으로 이어한다.
> 추가일: 2026-03-14

| ID | 항목 | 우선순위 | 의존성 | 핵심 산출물 |
|----|------|---------|--------|-----------|
| F-33 | Session Budget Prediction & Auto-Continue | HIGH | F-31(compaction tracker), F-32(adaptive loading) | `mpl-budget-predictor.mjs`, `context-usage.json` HUD bridge, `session-handoff.json` protocol, `mpl-session-watcher.sh` |

### 구현 요소

1. **HUD File Bridge** — mpl-hud.mjs가 매 ~500ms마다 `.mpl/context-usage.json`에 context window 사용률 기록
2. **Budget Predictor** — `mpl-budget-predictor.mjs`: context 잔여량 + Phase당 평균 토큰 + 남은 Phase 수 → pause 판단
3. **Graceful Pause Protocol** — Step 4.8: handoff 신호 생성 + state 저장 + RUNBOOK 기록
4. **External Watcher** — `tools/mpl-session-watcher.sh`: handoff 감지 → 새 Claude 세션에서 `/mpl:mpl-resume`
5. **Resume Integration** — Step 6: `paused_budget` 상태 인식 + 자동 정리 후 이어하기

### 검증 기준

- [ ] HUD가 context_window stdin 수신 시 `.mpl/context-usage.json` 파일 생성됨
- [ ] Budget predictor가 context 90%+ 사용 시 `pause_now` 반환
- [ ] Budget predictor가 남은 Phase 예산 초과 시 `pause_after_current` 반환
- [ ] `context-usage.json` 없을 때 fail-open (continue 반환)
- [ ] Graceful pause 시 `.mpl/signals/session-handoff.json` 생성됨
- [ ] Graceful pause 시 state.json에 `session_status: "paused_budget"` 기록됨
- [ ] Graceful pause 시 RUNBOOK에 pause 기록 추가됨
- [ ] 새 세션에서 `/mpl:mpl-resume` 시 `paused_budget` 상태 정상 복원됨
- [ ] Watcher가 handoff 신호 감지 후 새 세션 시작됨
- [ ] Watcher `--notify-only` 모드에서 메시지만 출력됨
