# MPL (Micro-Phase Loop) v3.2 설계 문서

## 1. 개요

MPL은 독립 자율 코딩 파이프라인으로, 사용자 요청을 순서가 지정된 **마이크로 페이즈(micro-phase)**로 분해한다. 각 페이즈는 격리된 세션에서 구조화된 컨텍스트만으로 실행되어, 장시간 실행 시 발생하는 컨텍스트 오염(context pollution)을 방지한다.

v3.0은 v1.0의 5단계·5에이전트 구조에서 **9+단계·15개 에이전트** 구조로 진화했다. 핵심 변화는 다음과 같다:

| 영역 | v1.0 | v3.0 |
|------|------|------|
| 파이프라인 단계 | 5단계 (Step 0~5) | 9+단계 (Step 0~6 + 하위 단계) |
| 에이전트 | 5개 | 15개 |
| 사전 분석 | 없음 | Triage + Phase 0 Enhanced + Pre-Execution Analysis |
| 품질 시스템 | 단순 검증 | Build-Test-Fix + 5-Gate + A/S/H 분류 + Convergence Detection |
| 캐싱 | 없음 | Phase 0 산출물 캐싱 |
| 토큰 프로파일링 | 없음 | 페이즈별 토큰/시간 프로파일링 |

> **세부 절차**는 `mpl-run.md`(오케스트레이션 프로토콜)에 정의되어 있다. 이 문서는 개념, 구조, 정책을 다룬다.

---

## 2. 설계 원칙

### 원칙 1: 오케스트레이터-워커 분리 (Orchestrator-Worker Separation)

오케스트레이터는 **절대로 소스 코드를 직접 작성하지 않는다.** 모든 코드 변경은 `mpl-worker` 에이전트에게 Task 도구를 통해 위임한다. `mpl-write-guard` PreToolUse 훅이 이를 권고 경고로 안내한다.

### 원칙 2: 계획 우선 (Plan First)

실행은 페이즈 분해 이후에만 시작한다. 분해 산출물(`decomposition.yaml`)이 단일 진실 소스(SSOT)이며, 순서가 지정된 페이즈와 인터페이스 계약을 포함한다.

### 원칙 3: 테스트 기반 검증 (Test-Based Verification)

각 페이즈는 기계 검증 가능한 성공 기준을 갖는다. 주관적 "완료" 선언은 허용하지 않으며, 증거 기반 검증(커맨드 종료 코드, 테스트 결과, 파일 존재 여부, grep 패턴)만 인정한다.

### 원칙 4: 제한된 재시도 (Bounded Retries)

Phase Runner는 내부적으로 최대 3회 재시도한다. 오케스트레이터는 최대 2회 재분해한다. 한도 초과 시 회로 차단(circuit break)이 발동하며, 무한 루프는 발생하지 않는다.

### 원칙 5: 지식 축적 (Knowledge Accumulation)

**State Summary**가 페이즈 간 유일한 지식 전달 수단이다. Phase Decision은 3-Tier 분류 시스템(Active/Summary/Archived)으로 관리되어 토큰 예산을 일정하게 유지한다.

---

## 3. 파이프라인 아키텍처

### 3.1 상태 머신

```
mpl-init -> mpl-decompose -> mpl-phase-running <-> mpl-phase-complete
                 ^                    |                      |
                 +-- mpl-circuit-break               mpl-finalize -> completed
                           |
                       mpl-failed
```

- **재시도**: Phase Runner가 내부에서 3회 재시도 (D-1 Hybrid). 오케스트레이터는 `"complete"` 또는 `"circuit_break"`만 수신한다.
- **재분해**: `max_redecompose = 2`. 초과 시 `mpl-failed` 상태로 전이한다.

### 3.2 전체 플로우 요약표

| Step | 이름 | 핵심 에이전트 | 산출물 |
|------|------|-------------|--------|
| -1 | LSP Warm-up | (오케스트레이터, 비차단) | lsp_servers 목록, cold start 제거 |
| 0 | Triage | (오케스트레이터) | interview_depth (light/full) |
| 0.5 | 성숙도 모드 감지 | (오케스트레이터) | maturity_mode (explore/standard/strict) |
| 1 | PP 인터뷰 | mpl-interviewer | `.mpl/pivot-points.md` |
| 1-B | Pre-Execution 분석 | mpl-pre-execution-analyzer | 누락 요구사항, AI 함정, Must NOT Do, 리스크 등급, 실행 순서 권장 |
| 1-D | PP 확인 | (오케스트레이터) | PP 최종 확정 |
| 2 | 코드베이스 분석 | (오케스트레이터) | `.mpl/mpl/codebase-analysis.json` |
| 2.5 | Phase 0 Enhanced | (오케스트레이터) | `.mpl/mpl/phase0/*.md` |
| 3 | 페이즈 분해 | mpl-decomposer | `.mpl/mpl/decomposition.yaml` |
| 3-B | 검증 계획 | mpl-verification-planner | A/S/H 항목 분류 |
| 3-C | ~~Critic 시뮬레이션~~ | ~~mpl-critic~~ | Decomposer risk_assessment로 흡수 (v3.1) |
| 4 | 페이즈 실행 루프 | mpl-phase-runner, mpl-worker, mpl-test-agent, mpl-code-reviewer | 페이즈별 산출물 |
| 5 | E2E & 최종화 | mpl-compound, mpl-git-master | 학습, 커밋, 메트릭스 |
| 6 | Resume 프로토콜 | (오케스트레이터) | 중단된 페이즈부터 재개 |

### 3.3 단계별 설명

#### Step 0: Triage

사용자 프롬프트의 **정보 밀도(information_density)**를 분석하여 인터뷰 깊이를 결정한다. 명시적 제약사항, 특정 파일, 측정 가능한 기준, 트레이드오프 선택의 수를 계산한다.

| interview_depth | 조건 | 인터뷰 동작 |
|-----------------|------|-----------|
| `light` | 밀도 4+ & 일부 제약 있음 | Round 1 (What) + Round 2 (What NOT)만 |
| `full` | 밀도 4 미만 (모호/광범위) | 4라운드 전체 인터뷰 |

#### Step 0.5: 성숙도 모드 감지

`.mpl/config.json`에서 `maturity_mode`를 읽는다 (기본값: `"standard"`).

| 모드 | 페이즈 크기 | PP | Discovery 처리 |
|------|-----------|-----|---------------|
| `explore` | S (1~3 TODO) | 선택적 | 자동 승인 |
| `standard` | M (3~5 TODO) | 필수 | PP 충돌 시 HITL |
| `strict` | L (5~7 TODO) | 필수 + 강제 | 모든 변경 HITL |

#### Step 1: PP 인터뷰 + Pre-Execution Analysis + PP 확인

이 단계는 4개의 하위 단계로 구성된다:

**Step 1: PP 인터뷰** — `mpl-interviewer`(opus)가 구조화된 인터뷰를 통해 Pivot Point를 발견한다. Triage의 `interview_depth`에 따라 인터뷰 범위가 조절된다. PP 상태는 CONFIRMED(하드 제약, 충돌 시 자동 거부) 또는 PROVISIONAL(소프트, 충돌 시 HITL)로 분류된다.

**Step 1-B: Pre-Execution 분석** — `mpl-pre-execution-analyzer`(sonnet)가 PP와 사용자 요청, 코드베이스를 분석하여 누락된 요구사항, AI 에이전트 함정, "Must NOT Do" 제약을 식별하고(Part 1: Gap), 제안된 변경의 리스크(LOW/MED/HIGH)와 가역성(Reversible/Irreversible)을 평가하여 최적 실행 순서를 권장한다(Part 2: Tradeoff). 이전의 gap-analyzer(haiku) + tradeoff-analyzer(sonnet) 2회 호출을 단일 sonnet 호출로 통합하여 중복 코드베이스 탐색을 제거한다.

**Step 1-D: PP 확인** — Pre-Execution 분석 결과를 반영하여 PP를 최종 확정한다. 필요시 사용자에게 추가 질문한다.

#### Step 2: 코드베이스 분석

오케스트레이터가 빌트인 도구를 사용하여 코드베이스를 분석한다. 6개 분석 모듈로 구성된다:

| 모듈 | 도구 | 분석 대상 |
|------|------|----------|
| 구조 분석 | Glob | 디렉토리 구조, 파일 목록 |
| 의존성 그래프 | ast_grep_search / Grep | 모듈 간 import/require 관계 |
| 인터페이스 추출 | lsp_document_symbols | 공개 API 시그니처 |
| 중심성 분석 | (의존성에서 도출) | 핵심 모듈 식별 |
| 테스트 인프라 | Glob + Read | 테스트 프레임워크, 기존 테스트 |
| 설정 | Read | 빌드/테스트 설정 파일 |

산출물: `.mpl/mpl/codebase-analysis.json`

#### Step 2.5: Phase 0 Enhanced (복잡도 적응형 분석)

Phase 0 Enhanced는 Step 2의 분석 결과를 기반으로 **프로젝트 복잡도를 측정**하고, 복잡도에 따라 사전 명세를 생성한다. "예방이 치료보다 낫다" — Phase 0에 투자하는 토큰이 이후의 디버깅 비용을 제거한다.

**캐시 확인** — 실행 전에 `.mpl/cache/phase0/`에서 캐시를 확인한다. 캐시 히트 시 Phase 0 전체를 스킵하여 8~25K 토큰을 절감한다. 캐시 키는 테스트 파일, 디렉토리 구조, 의존성 버전, 소스 파일의 해시로 생성된다.

**복잡도 감지** — 복잡도 점수를 산출한다:

```
complexity_score = (모듈 수 × 10) + (외부 의존성 × 5) + (테스트 파일 × 3)
```

| 점수 | 등급 | Phase 0 Step | 토큰 예산 |
|------|------|-------------|----------|
| 0~29 | Simple | Step 4만 (Error Spec) | ~8K |
| 30~79 | Medium | Step 2 + Step 4 | ~12K |
| 80+ | Complex | Step 1~4 전체 | ~20K |

**4단계 프로세스**:

| Step | 이름 | 적용 조건 | 산출물 경로 |
|------|------|----------|-----------|
| Step 1 | API Contract Extraction | Complex+ | `.mpl/mpl/phase0/api-contracts.md` |
| Step 2 | Example Pattern Analysis | Medium+ | `.mpl/mpl/phase0/examples.md` |
| Step 3 | Type Policy Definition | Complex+ | `.mpl/mpl/phase0/type-policy.md` |
| Step 4 | Error Specification | 모든 등급 (필수) | `.mpl/mpl/phase0/error-spec.md` |

각 Step의 산출물은 검증 체크리스트를 통과해야 한다. 최종 요약은 `.mpl/mpl/phase0/summary.md`에 저장되며, 성공적으로 완료된 산출물은 `.mpl/cache/phase0/`에 캐싱된다.

토큰 프로파일링도 이 단계에서 시작된다. Phase 0의 토큰 사용량을 `.mpl/mpl/profile/phases.jsonl`에 기록한다.

#### Step 3: 페이즈 분해 + 검증 계획 + Critic

이 단계는 3개의 하위 단계로 구성된다:

**Step 3: 페이즈 분해** — `mpl-decomposer`(opus)가 사용자 요청을 순서가 지정된 마이크로 페이즈로 분해한다. 분해기는 도구에 접근하지 않고 순수 추론만 수행하며, 구조화된 CodebaseAnalysis를 입력으로 받는다. 각 페이즈는 다음을 선언한다:
- 범위와 근거
- 영향 범위 (생성/수정/테스트/설정 파일)
- 인터페이스 계약 (requires/produces)
- 성공 기준 (typed: command/test/file_exists/grep/description)
- 추정 복잡도 (S/M/L)

산출물: `.mpl/mpl/decomposition.yaml`

**Step 3-B: 검증 계획** — `mpl-verification-planner`(sonnet)가 수용 기준을 A/S/H 항목으로 분류한다:
- **A-items** (Agent-Verifiable): 에이전트가 자동 검증 가능 (커맨드, 종료 코드)
- **S-items** (Sandbox Agent Testing): BDD/Gherkin 시나리오 기반 검증
- **H-items** (Human-Required): 자동화가 불충분하여 사람 판단 필요

검증 계획은 각 페이즈에 부착되어 Phase Runner와 Test Agent의 검증 기준이 된다.

**Step 3-C: ~~Critic 시뮬레이션~~** — v3.1에서 Decomposer의 `risk_assessment` 출력 섹션으로 흡수. Decomposer가 분해 추론(Step 9)에서 프리모템 분석을 수행하고, go/no-go 판정을 포함하여 출력한다. 별도 opus 에이전트 호출 없이 동일 효과를 달성하며, ~3-5K 토큰을 절감한다.

#### Step 4: 페이즈 실행 루프

파이프라인의 핵심 실행 단위이다. 각 페이즈를 순서대로 실행한다.

**4.1 컨텍스트 조립** — 각 페이즈 실행 전에 필요한 컨텍스트를 조립한다:
- Phase 0 산출물 (복잡도 등급에 따라 선택적 로딩)
- Pivot Points
- Phase Decision (3-Tier 분류 적용)
- 페이즈 정의 (decomposition.yaml에서)
- 영향 파일 (파일당 최대 500줄)
- 이전 페이즈 State Summary
- 의존성 페이즈 Summary (interface_contract.requires 기반)
- 검증 계획 (해당 페이즈의 A/S/H 항목)

**4.2 Phase Runner 실행** — `mpl-phase-runner`(sonnet)가 격리된 세션에서 실행된다. Phase Runner는 미니 플랜을 작성하고, `mpl-worker`에게 TODO를 위임하며, Build-Test-Fix 마이크로 사이클로 검증하고, State Summary를 생산한다. 규칙:
- TODO별 즉시 테스트 (배치 금지)
- 실패 시 Phase 0 산출물 참조 후 수정
- 최대 3회 재시도 후 circuit_break

**4.2.1 Test Agent (F-40 Mandatory)** — Phase Runner 완료 후 `mpl-test-agent`(sonnet)가 독립적으로 테스트를 작성·실행한다. 코드 작성자와 테스트 작성자를 분리하여 가정 불일치, 인터페이스 계약 위반, 엣지 케이스를 포착한다. **F-40부터 필수 도메인(ui, api, algorithm, db, ai)에서는 Test Agent 호출이 mandatory이며, 0개 테스트 반환 시 Phase가 FAIL 처리된다.** 오케스트레이터가 단일 강제 게이트로 운영하며, Phase Runner의 이전 Step 3d 호출은 제거되었다.

**4.3 결과 처리** — 검증, 상태 저장, Discovery 처리, 프로파일 기록을 수행한다.

**4.3.5 Side Interview** — CRITICAL discovery, H-items, AD(After Decision) 마커가 있을 때 사용자에게 확인을 요청한다.

**4.3.6 컨텍스트 정리** — 각 페이즈 완료 후 오케스트레이터 메모리에서 상세 데이터를 해제하여, 페이즈 수에 관계없이 일정한 컨텍스트 크기를 유지한다.

**4.4 재분해** — circuit break 발생 시 `mpl-decomposer`가 실패한 페이즈를 다른 전략으로 재분해한다. 최대 2회까지 허용되며, 완료된 페이즈는 보존한다.

**4.5 5-Gate 품질** — 모든 페이즈 완료 후 5단계 품질 게이트(Gate 0.5, 1, 1.5, 2, 3)를 통과해야 최종화로 진행한다 (상세는 §5 품질 시스템 참조).

**4.6 Fix Loop** — 게이트 실패 시 수정 루프에 진입한다. Convergence Detection으로 진행 상태를 모니터링하며, 정체(stagnating) 시 전략 변경, 역행(regressing) 시 즉시 회로 차단한다 (상세는 §5.4 참조).

#### Step 5: E2E & 최종화

5-Gate를 통과한 후 최종 단계를 수행한다:

| 하위 단계 | 내용 |
|----------|------|
| 5.0 E2E 테스트 | S-items의 E2E 시나리오 실행 |
| 5.0.5 AD 최종 검증 | After Decision 마커의 인터페이스 정의 확인 |
| 5.1 최종 검증 | 모든 페이즈의 성공 기준 재실행 |
| 5.2 학습 추출 | `mpl-compound`가 학습/결정/이슈 추출 |
| 5.3 원자적 커밋 | `mpl-git-master`가 스타일 감지 후 원자적 커밋 |
| 5.4 메트릭스 | `.mpl/mpl/metrics.json` + 프로파일 저장 |
| 5.5 완료 보고 | 페이즈 완료/실패, 재시도, 핵심 발견 요약 |
| 5.6 상태 업데이트 | `completed` 상태 전이 |

#### Step 6: Resume 프로토콜

MPL은 페이즈별 상태 영속성을 통해 자연스럽게 이어하기(resume)를 지원한다. 세션 시작 시 `.mpl/state.json`에 `run_mode == "mpl"`이 있으면, 다음 미완료 페이즈를 찾아 축적된 Phase Decision과 마지막 State Summary를 로드하여 실행을 재개한다.

| 데이터 | 소스 |
|--------|------|
| 완료된 결과 | `.mpl/mpl/phases/phase-N/state-summary.md` |
| 축적된 PD | `.mpl/mpl/phase-decisions.md` |
| 페이즈 정의 | `.mpl/mpl/decomposition.yaml` |
| 진행 상태 | `.mpl/mpl/state.json` |
| Pivot Points | `.mpl/pivot-points.md` |

---

## 4. 에이전트 카탈로그

MPL v3.6은 15개의 전문 에이전트를 사용한다 (critic 흡수 + gap/tradeoff 통합 + doctor 추가). 각 에이전트는 명확한 역할 경계와 도구 제한을 갖는다.

### Pre-Execution 에이전트 (분석/계획)

| 에이전트 | 역할 | 모델 | 비허용 도구 |
|---------|------|------|-----------|
| `mpl-interviewer` | PP 인터뷰 — 구조화된 4라운드 인터뷰로 Pivot Point 발견 | opus | Write, Edit, Bash, Task |
| `mpl-ambiguity-resolver` | Stage 2 Ambiguity Resolution — 스펙 리딩 + 메트릭 기반 소크라틱 루프 + 요구사항 구조화 | opus | Write, Edit, Bash, Task |
| `mpl-codebase-analyzer` | 코드베이스 구조 분석 — 디렉토리 구조·의존성·인터페이스 정적 분석 | haiku | Edit, Task |
| `mpl-phase0-analyzer` | Pre-Execution 깊이 분석 — 실행 전 Phase 0 Enhanced 심층 분석 | sonnet | Edit, Task |
| `mpl-pre-execution-analyzer` | Pre-Execution 분석 — Gap(누락 요구사항, AI 함정, Must NOT Do) + Tradeoff(리스크 등급, 가역성, 실행 순서) 통합 | sonnet | Write, Edit, Bash, Task |
| `mpl-decomposer` | 페이즈 분해 — 요청을 순서화된 마이크로 페이즈로 분해 (Read/Glob/Grep 허용) | opus | Write, Edit, Bash, Task, WebFetch, WebSearch, NotebookEdit |
| `mpl-verification-planner` | 검증 계획 — A/S/H 항목 분류, 페이즈별 검증 전략 | sonnet | Write, Edit, Task |
| ~~`mpl-critic`~~ | ~~Critic~~ — Decomposer risk_assessment로 흡수 (v3.1) | ~~opus~~ | - |

### Execution 에이전트 (실행/검증)

| 에이전트 | 역할 | 모델 | 비허용 도구 |
|---------|------|------|-----------|
| `mpl-phase-runner` | 페이즈 실행 — 미니 플랜, 워커 위임, 검증, State Summary | sonnet | 없음 (전체 도구 사용) |
| `mpl-worker` | TODO 구현 — 단일 TODO 항목을 구현하고 JSON 출력 반환 | sonnet | Task |
| `mpl-test-agent` | 독립 테스트 — 코드 작성자와 분리된 테스트 작성·실행 | sonnet | Task |
| `mpl-code-reviewer` | 코드 리뷰 — 10개 카테고리 리뷰 (8 기본 + 2 UI 전용), Gate 2 담당 | sonnet | Write, Edit, Task |

### Post-Execution 에이전트 (최종화)

| 에이전트 | 역할 | 모델 | 비허용 도구 |
|---------|------|------|-----------|
| `mpl-git-master` | 원자적 커밋 — 스타일 감지, 의미적 분할, 3+ 파일 = 2+ 커밋 | sonnet | Write, Edit, Task |
| `mpl-compound` | 학습 추출 — 파이프라인 완료 후 학습/결정/이슈 증류 | sonnet | 없음 (전체 도구 사용) |

### Utility 에이전트

| 에이전트 | 역할 | 모델 | 비허용 도구 |
|---------|------|------|-----------|
| `mpl-doctor` | 설치 진단 — 11 카테고리 검사, tool_mode 감지 (full/partial/standalone) | haiku | Write, Edit, Task |

### 모델 라우팅 정책

기본 모델은 에이전트 정의에 명시되어 있으나, 상황에 따라 에스컬레이션한다:

| 에이전트 | 기본 | opus 에스컬레이션 조건 |
|---------|------|---------------------|
| mpl-decomposer | opus | 항상 opus (복잡 추론) |
| mpl-phase-runner | sonnet | L 복잡도 또는 아키텍처 변경 |
| mpl-worker | sonnet | 아키텍처 변경 또는 3+ 재시도 실패 |

---

## 5. 품질 시스템

MPL v3.0은 다층 품질 시스템을 통해 코드 품질을 보장한다.

### 5.1 Build-Test-Fix 마이크로 사이클

Phase Runner 내에서 각 TODO 구현 직후 즉시 테스트를 실행한다. 모든 구현을 완료한 후 한꺼번에 테스트하는 배치 방식이 아니라, **TODO별 마이크로 사이클**을 실행한다.

```
TODO 구현 ──→ 해당 모듈 테스트 ──→ 통과? ──→ 다음 TODO
                                    │
                                    ↓ 실패
                               즉시 수정 (최대 2회) ──┘
```

- TODO당 최대 재시도: 2회
- 페이즈 종료 시: 현재 + 이전 페이즈의 모든 테스트를 누적 실행하여 회귀를 방지한다
- 실패 시 Phase 0 산출물(error-spec, type-policy, api-contracts)을 참조한다

### 5.2 5-Gate 품질 시스템

모든 페이즈 실행이 완료된 후, 5단계 품질 게이트를 순차적으로 통과해야 한다:

| Gate | 이름 | 담당 | 통과 기준 | 실패 시 |
|------|------|------|----------|--------|
| Gate 0.5 | 타입 체크 | (오케스트레이터) | 타입 에러 0개 | Fix Loop 진입 후 Gate 1 |
| Gate 1 | 자동 테스트 | (오케스트레이터) | pass_rate ≥ 95% | Fix Loop 진입 |
| Gate 1.5 | 메트릭 (F-50) | (오케스트레이터) | 커버리지 ≥ 60% (MVP) / 80% (strict) | Test Agent 재호출 (최대 2회) |
| Gate 2 | 코드 리뷰 | mpl-code-reviewer | PASS 판정 | NEEDS_FIXES → Fix Loop, REJECT → mpl-failed |
| Gate 3 | PP Compliance | (오케스트레이터 + Human) | PP 위반 없음 + H-items 해결 | Fix Loop 진입 |

Gate 0.5는 프로젝트 전체 타입 체크를 수행한다. Gate 1은 전체 테스트 스위트를 실행한다 (S-items 포함). Gate 1.5는 커버리지, 코드 중복, 번들 크기를 측정한다 (F-50). Gate 2는 10개 카테고리(정확성, 보안, 성능, 유지보수성, PP 준수, 디자인 시스템, 번들 건강도 등)로 코드를 리뷰한다. Gate 3은 PP compliance를 전체적으로 검증하고 H-items를 사용자에게 확인한다.

### 5.3 A/S/H 검증 분류

`mpl-verification-planner`가 모든 수용 기준을 세 범주로 분류한다:

| 분류 | 설명 | 검증 방법 | 예시 |
|------|------|----------|------|
| **A-items** (Agent-Verifiable) | 에이전트가 자동 검증 가능 | 커맨드 실행 + 종료 코드 확인 | `npm test` 통과, 파일 존재 여부 |
| **S-items** (Sandbox Agent Testing) | 에이전트가 시나리오 기반 검증 | BDD/Gherkin 시나리오 실행 | "사용자가 로그인하면 대시보드가 표시된다" |
| **H-items** (Human-Required) | 자동화가 불충분 | 사용자 확인 (Side Interview) | UX 판단, 비즈니스 로직 적절성 |

A-items는 Phase Runner와 Test Agent가 검증한다. S-items는 Gate 1(자동 테스트)에서 검증한다. H-items는 Gate 3에서 Side Interview를 통해 사용자에게 확인한다.

### 5.4 Convergence Detection

Fix Loop에서 수정이 실제로 진전되고 있는지 감지한다. 각 수정 시도 후 pass_rate를 기록하고, 수렴 상태를 판정한다:

| 상태 | 조건 | 대응 |
|------|------|------|
| `progressing` | pass_rate가 개선 중 | 계속 수정 |
| `stagnating` | stagnation_window 내 min_improvement 미달 | 전략 변경; 여전히 정체 시 회로 차단 |
| `regressing` | pass_rate가 regression_threshold 이상 하락 | 즉시 회로 차단, 마지막 양호 상태로 복귀 |

수렴 설정은 `.mpl/config.json`의 `convergence` 섹션에서 조정한다 (stagnation_window, min_improvement, regression_threshold).

---

## 6. 상태 관리

### 6.1 상태 파일 구조

```
.mpl/
├── state.json                    # 파이프라인 상태 (run_mode, current_phase)
├── config.json                   # 설정 (maturity_mode, max_fix_loops 등)
├── pivot-points.md               # Pivot Points
├── discoveries.md                # Discovery 기록
├── cache/
│   └── phase0/                   # Phase 0 캐시
│       ├── manifest.json         # 캐시 메타데이터 (키, 타임스탬프)
│       ├── api-contracts.md      # 캐시된 API 계약
│       ├── examples.md           # 캐시된 예제 패턴
│       ├── type-policy.md        # 캐시된 타입 정책
│       ├── error-spec.md         # 캐시된 에러 명세
│       ├── summary.md            # 캐시된 Phase 0 요약
│       └── complexity-report.json
└── mpl/
    ├── state.json                # MPL 상태 (페이즈 진행, 통계)
    ├── codebase-analysis.json    # 코드베이스 분석 결과
    ├── decomposition.yaml        # 페이즈 분해 결과
    ├── phase-decisions.md        # 축적된 Phase Decision
    ├── phase0/                   # Phase 0 Enhanced 산출물
    │   ├── api-contracts.md
    │   ├── examples.md
    │   ├── type-policy.md
    │   ├── error-spec.md
    │   ├── summary.md
    │   └── complexity-report.json
    ├── phases/                   # 페이즈별 산출물
    │   └── phase-N/
    │       ├── mini-plan.md      # 페이즈 TODO 목록
    │       ├── state-summary.md  # 완료 요약 (지식 전달)
    │       └── verification.md   # 검증 결과 (증거 포함)
    ├── RUNBOOK.md                # 통합 실행 로그 — 현재 상태, 마일스톤, 결정, 이슈, 재개 정보 (F-10)
    ├── profile/                  # 토큰 프로파일링
    │   ├── phases.jsonl          # 페이즈별 토큰/시간 (append-only)
    │   └── run-summary.json     # 전체 실행 프로파일
    ├── metrics.json              # 최종 메트릭스
    └── ../memory/                # 라우팅 메모리 (F-22)
        ├── routing-patterns.jsonl # 과거 실행 패턴 (tier 예측용, append-only)
        └── learnings.md          # 실행 간 축적 학습 (F-11)
```

### 6.2 Phase Decision 3-Tier 분류

페이즈 간 Phase Decision의 토큰 비용을 일정하게 유지하기 위해 3-Tier로 분류한다:

| Tier | 이름 | 포함 내용 | 토큰 예산 | 분류 기준 |
|------|------|----------|----------|----------|
| Tier 1 | Active | 전체 상세 | ~400~800 | PD의 affected_files가 현재 페이즈 impact와 교집합 |
| Tier 2 | Summary | 1줄 요약 | ~90~240 | DB Schema/API Contract/Architecture 타입이지만 직접 접촉 없음 |
| Tier 3 | Archived | ID만 | ~0 | 나머지 전부 |

전체 PD 토큰 비용: ~500~1000 토큰 (페이즈 수와 무관하게 안정적).

### 6.3 Discovery 처리

Phase Runner가 보고한 Discovery는 다음 순서로 처리한다:

1. **PP 충돌 검사**: CONFIRMED PP 충돌 → 자동 거부. PROVISIONAL → maturity_mode에 따라 HITL 또는 자동 승인.
2. **PD Override 검사**: 과거 결정 변경 요청 → maturity_mode에 따라 HITL 또는 자동 승인.
3. **일반 Discovery**: explore → 즉시 반영, standard → 페이즈 전환 시 리뷰, strict → 다음 사이클 백로그.

모든 Discovery는 `.mpl/discoveries.md`에 기록된다.

---

## 7. 훅 시스템

MPL은 8개의 훅으로 파이프라인 무결성을 유지한다:

| 훅 | 이벤트 | 목적 |
|----|--------|------|
| `mpl-compaction-tracker` | PreCompact | Compaction 이벤트 추적 및 체크포인트 생성 (F-31) |
| `mpl-auto-permit` | PreToolUse | 학습 기반 자동 권한 허용 (F-34) |
| `mpl-write-guard` | PreToolUse (Edit/Write) | MPL 활성 시 오케스트레이터의 소스 파일 직접 편집을 경고한다 |
| `mpl-validate-output` | PostToolUse (Task) | 에이전트 출력의 필수 섹션을 검증하고, 토큰 사용량을 추적한다 |
| `mpl-permit-learner` | PostToolUse | 권한 허용 패턴 학습 (F-34) |
| `mpl-phase-controller` | Stop | 상태에 기반하여 페이즈 전이를 관리한다 |
| `mpl-session-init` | SessionStart | 세션 시작 시 Context Rotation 초기화 (F-38) |
| `mpl-keyword-detector` | UserPromptSubmit | 사용자 입력에서 "mpl" 키워드를 감지하고, 파이프라인 상태를 초기화한다 |

---

## 8. 설정 옵션

`.mpl/config.json`에서 다음 옵션을 지원한다:

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `maturity_mode` | `"standard"` | 성숙도 모드 (explore/standard/strict) |
| `max_fix_loops` | `10` | Fix Loop 최대 반복 횟수 |
| `max_total_tokens` | `500000` | 전체 토큰 상한 |
| `gate1_strategy` | `"auto"` | Gate 1 테스트 전략 (auto/docker/native/skip) |
| `hitl_timeout_seconds` | `30` | HITL 응답 대기 시간 |
| `convergence.stagnation_window` | (설정별) | 정체 판정 윈도우 크기 |
| `convergence.min_improvement` | (설정별) | 최소 개선율 |
| `convergence.regression_threshold` | (설정별) | 역행 판정 임계값 |

---

## 9. 알려진 이슈 및 잔여 작업

> 최종 감사일: 2026-03-05. 아래 항목은 v3.0 코드베이스와 문서 간 교차 검증을 통해 식별되었다.

### CRITICAL — 파이프라인 정합성에 영향

| ID | 항목 | 상세 | 위치 | 상태 |
|----|------|------|------|------|
| I-01 | ~~유령 에이전트 `mpl-research-synthesizer`~~ | `VALIDATE_AGENTS` Set 및 `EXPECTED_SECTIONS`에서 제거 완료. | `hooks/mpl-validate-output.mjs` | **해결됨** (2026-03-05) |
| I-02 | ~~mpl-run.md Related Skills 표 중복~~ | 중복된 `/mpl:mpl` 행 제거, 단일 등록으로 정리 완료. | `commands/mpl-run.md` | **해결됨** (2026-03-05) |

### HIGH — 기능 누락

| ID | 항목 | 상세 | 위치 | 상태 |
|----|------|------|------|------|
| I-03 | ~~스킬 `/mpl:mpl-bugfix` 미구현~~ | `skills/mpl-bugfix/SKILL.md` 생성 완료. 경량 버그 수정 파이프라인. | `skills/mpl-bugfix/SKILL.md` | **해결됨** (2026-03-05) |
| I-04 | ~~스킬 `/mpl:mpl-small` 미구현~~ | `skills/mpl-small/SKILL.md` 생성 완료. 3-Phase 경량 파이프라인. | `skills/mpl-small/SKILL.md` | **해결됨** (2026-03-05) |
| I-05 | ~~스킬 `/mpl:mpl-compound` 래퍼 없음~~ | `skills/mpl-compound/SKILL.md` 생성 완료. 학습 추출 독립 실행. | `skills/mpl-compound/SKILL.md` | **해결됨** (2026-03-05) |
| I-06 | ~~스킬 `/mpl:mpl-gap-analysis` 래퍼 없음~~ | `skills/mpl-gap-analysis/SKILL.md` 생성 완료. 독립 갭 분석. | `skills/mpl-gap-analysis/SKILL.md` | **해결됨** (2026-03-05) |
| I-07 | ~~`mpl-validate-output` 에이전트 목록 불완전~~ | `mpl-decomposer`, `mpl-git-master`, `mpl-compound`를 VALIDATE_AGENTS 및 EXPECTED_SECTIONS에 추가 완료. | `hooks/mpl-validate-output.mjs` | **해결됨** (2026-03-05) |

### MEDIUM — 미구현 로드맵 기능

| ID | 항목 | 상세 | 상태 |
|----|------|------|------|
| I-08 | ~~API 자동 추출 (AST 파서)~~ | `mpl-test-analyzer.mjs` 구현 완료. 함수 호출, pytest.raises, assert, fixture 추출. | **해결됨** (2026-03-05) |
| I-09 | ~~패턴 자동 분석 (패턴 감지기)~~ | `mpl-pattern-detector.mjs` 구현 완료. 7개 카테고리 자동 분류. | **해결됨** (2026-03-05) |

### LOW — 개선 사항

| ID | 항목 | 상세 | 상태 |
|----|------|------|------|
| I-10 | ~~Convergence 상태 명명 불일치~~ | `stagnant` → `stagnating`, `regression` → `regressing`으로 통일 완료. | **해결됨** (2026-03-05) |
| I-11 | ~~Phase 0 캐시 검증 코드 없음~~ | `mpl-cache.mjs` 구현 완료. 캐시 키 생성, 히트/미스 판정, 저장/읽기 유틸리티. | **해결됨** (2026-03-05) |
| I-12 | ~~토큰 프로파일링 집계 도구 없음~~ | `mpl-profile.mjs` 구현 완료. JSONL 파싱, 집계 통계, 이상 탐지, 텍스트 리포트. | **해결됨** (2026-03-05) |
| I-13 | ~~Triage 로직 훅 미반영~~ | `mpl-phase-controller.mjs`의 `phase2-sprint` 진입 시 `interview_depth` 가드 추가 완료. | **해결됨** (2026-03-05) |
