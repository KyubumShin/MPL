# MPL Design References

외부 소스 및 영감을 받은 프로젝트의 기록.

---

## v3.2 — Adaptive Pipeline Router + Docs-as-Memory

### Ouroboros (Q00/ouroboros)

- **Repository**: https://github.com/Q00/ouroboros
- **분석일**: 2026-03-07
- **영향 범위**: F-20, F-21, F-22, README 구조

#### 참조한 개념

| Ouroboros 개념 | MPL 적응 | 적용 위치 |
|---------------|---------|----------|
| **PAL Router** (Progressive Adaptive LLM Router) — 3-tier 비용 모델 (Frugal 1x / Standard 10x / Frontier 30x) | Pipeline Score 공식 + 3-tier 분류 (frugal/standard/frontier) | `hooks/lib/mpl-scope-scan.mjs` |
| 2회 연속 실패 시 자동 에스컬레이션 | Circuit break 시 tier 자동 승격 (F-21) | `hooks/lib/mpl-state.mjs`, `hooks/mpl-phase-controller.mjs` |
| 5회 연속 성공 시 자동 다운그레이드 | Routing Pattern Learning + Jaccard 유사도 (F-22, 계획) | `docs/roadmap/overview.md` |
| Jaccard 유사도 (임계값 0.8) 기반 패턴 매칭 | routing-patterns.jsonl + 다음 실행 tier 추천 (F-22, 계획) | `docs/roadmap/overview.md` |
| README "From Wonder to Ontology" 서사 구조 | "From Chaos to Coherence" 철학 섹션 | `README.md` |
| "The Nine Minds" 에이전트 카탈로그 | "The Eleven Minds" 핵심 원칙 포함 | `README.md` |

#### 차이점

| 영역 | Ouroboros | MPL |
|------|----------|-----|
| 라우팅 대상 | LLM 모델 선택 (haiku/sonnet/opus) | 파이프라인 전체 구조 선택 (frugal/standard/frontier) |
| 에스컬레이션 트리거 | 연속 실패 횟수 (2회) | Circuit break + convergence 상태 |
| 다운그레이드 | 런타임 자동 (연속 성공 5회) | 다음 실행 시 패턴 매칭 (F-22) |
| 점수 공식 | 모델별 비용 배수 | 4-factor 가중 점수 (파일/테스트/의존성/리스크) |
| 구현 언어 | Python (SQLAlchemy, aiosqlite) | JavaScript (Node.js hooks) |

---

### Codex Long-Horizon Tasks

- **Source**: https://www.linkedin.com/posts/gb-jeong_run-long-horizon-tasks-with-codex-activity-7435825294554484736-hBEX
- **분석일**: 2026-03-07
- **영향 범위**: F-10 (RUNBOOK.md), v3.2 "문서가 메모리다" 축

#### 참조한 개념

| 개념 | MPL 적응 | 적용 위치 |
|------|---------|----------|
| 4-Document 매핑 (prompt/plans/implement/documentation) | MPL 1~3번 문서 매핑 확인 + 4번(documentation) 부재 발견 → RUNBOOK.md 신설 | `docs/roadmap/overview.md` 4-Document 매핑표 |
| `docs/documentation.md` — 감시 기록 겸 공유 메모리 | `.mpl/mpl/RUNBOOK.md` — 9개 지점 자동 갱신 | F-10, 모든 protocol 파일 |
| 세션 간 연속성 보장 | RUNBOOK 로딩으로 세션 재개 | `commands/mpl-run-finalize.md` Step 6 |

---

### Seeing like an Agent (Thariq, Claude Code team)

- **Source**: https://x.com/trq212/status/2027463795355095314
- **저자**: Thariq (Claude Code @Anthropic)
- **분석일**: 2026-03-08
- **영향 범위**: F-23, F-24, F-16 확장

#### 참조한 교훈

| 교훈 | MPL 적응 | 적용 위치 |
|------|---------|----------|
| **TodoWrite → Task Tool 진화** — 모델 능력 향상 시 기존 도구가 제약이 됨. 체크박스 목록 → 에이전트 간 통신 도구로 교체 | Phase Runner의 mini-plan.md 체크박스 → Task tool 기반 TODO 관리 (F-23) | `docs/roadmap/overview.md` F-23 |
| **RAG → self-directed search** — 컨텍스트를 "제공"하기보다 에이전트가 "스스로 구축"하게 하는 것이 효과적 | Phase Runner scope-bounded search 허용 (F-24). 오케스트레이터 context assembly 의존도 감소 | `docs/roadmap/overview.md` F-24 |
| **Progressive Disclosure** — 시스템 프롬프트 비대화 대신, subagent/skill 파일로 필요 시 로드 | mpl-scout(F-16)를 Phase Runner 컨텍스트 보조로 확장. Guide subagent 패턴 | `docs/roadmap/overview.md` F-16 |
| **AskUserQuestion 도구** — 구조화된 질문이 plain text보다 효과적 | F-14에서 이미 적용 (Side Interview + PP Interview) | 변경 없음 |

#### MPL에 이미 잘 적용된 패턴

| 패턴 | MPL 대응 |
|------|---------|
| Progressive Disclosure (필요 시만 로드) | Protocol 4분할 (phase0/decompose/execute/finalize), Phase 0 복잡도 적응 |
| 도구 추가 없이 기능 확장 | SKILL.md → mpl-run.md → stage별 파일 체인 |
| AskUserQuestion 구조화 | F-14: Side Interview + PP Interview |
| 에이전트 간 분리 (code author ≠ tester) | Phase Runner ≠ Test Agent, Orchestrator ≠ Worker |

#### 핵심 인용

> *"As model capabilities increase, the tools that your models once needed might now be constraining them. It's important to constantly revisit previous assumptions on what tools are needed."*

> *"Claude was given this context instead of finding the context itself."*

> *"We were able to add things to Claude's action space without adding a tool."*

---

## v3.0~v3.1 — 내부 실험 기반

### 7개 실험 (Exp 1~8, Exp 2 제외)

Phase 0 Enhanced 설계의 실증적 근거. 각 실험이 Phase 0 기법 하나를 추가하며 누적 통과율이 단조 증가함을 검증.

| 실험 | 기법 | 누적 통과율 | v3.0 반영 |
|------|------|-----------|----------|
| Exp 1 | API Contract Extraction | 38% → 100% | Phase 0 Step 1 |
| Exp 3 | Example Pattern Analysis | 58% → 100% | Phase 0 Step 2 |
| Exp 4 | Type Policy Definition | 65% → 100% | Phase 0 Step 3 |
| Exp 5 | Test Stub Generation | 77% → 100% | Build-Test-Fix |
| Exp 6 | Incremental Testing | 83% → 100% | Incremental Verification |
| Exp 7 | Error Specification | 100% | Phase 0 Step 4 |
| Exp 8 | Hybrid Verification | 100% | 3-Gate Quality |

상세: `docs/roadmap/overview.md` 실험 성과 매트릭스, `docs/roadmap/experiments-summary.md`
