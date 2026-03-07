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

## Sprint 5 — 고급 격리와 확장

> 테마: "안전하고 확장 가능한 MPL" — 위험 작업 격리, 캐시 최적화, 모노레포 지원.

| ID | 항목 | 우선순위 | 의존성 | 핵심 산출물 |
|----|------|---------|--------|-----------|
| F-15 | Worktree 격리 실행 | MED | 없음 | risk=HIGH 페이즈를 worktree에서 실행, 성공 시 머지 |
| F-05 | Phase 0 캐시 부분 무효화 | LOW | 없음 | 변경 모듈만 재분석, git diff 기반 무효화 |
| F-06 | 멀티 프로젝트 지원 | LOW | 없음 | monorepo 프로젝트별 독립 파이프라인 |

### 구현 순서

1. **F-15** — Pre-Execution Analysis에서 risk=HIGH 판정 시 worktree 생성/머지/정리 프로토콜.
2. **F-05** — Phase 0 캐시에 git diff 기반 부분 무효화. 변경된 파일의 모듈만 재분석.
3. **F-06** — monorepo 루트 감지, 프로젝트별 `.mpl/` 디렉토리 분리, 독립 state 관리.

### 검증 기준

- [ ] risk=HIGH 페이즈가 worktree에서 격리 실행되고 성공 시 자동 머지됨 (F-15)
- [ ] 파일 1개 변경 시 전체 Phase 0 재실행 없이 해당 모듈만 재분석됨 (F-05)
- [ ] monorepo 내 독립 프로젝트에서 각각 MPL 실행 가능 (F-06)

---

## 전체 타임라인

```
Sprint 1 (완료)  ██████████  F-20, F-21, F-10, F-14
Sprint 2 (완료)  ██████████  F-12, F-11, F-22         ← 학습/영속
Sprint 3 (완료)  ██████████  F-24, F-23, F-13         ← 실행 엔진
Sprint 4 (완료)  ██████████  F-16, F-17, F-04         ← 품질/독립
Sprint 5         ░░░░░░░░░░  F-15, F-05, F-06         ← 격리/확장
```

## Sprint 간 의존성

```
Sprint 1 ──→ Sprint 2 (F-10→F-11, F-20→F-22)
Sprint 2 ──→ Sprint 3 (learnings가 Phase Runner에서 참조됨)
Sprint 3 ──→ Sprint 4 (F-16 scout가 F-24 self-directed와 보완)
Sprint 4 ──→ Sprint 5 (F-04 standalone이 F-15 worktree의 전제)
```

각 Sprint는 이전 Sprint 완료 후 시작을 권장하나, Sprint 3과 4는 병렬 진행 가능.
