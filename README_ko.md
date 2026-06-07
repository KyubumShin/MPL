# MPL (Micro-Phase Loop) v0.19.0

**예방이 치료보다 낫다. 명세가 디버깅보다 낫다.**

Claude Code와 Codex CLI에서 사용할 수 있는 에이전트 워크플로 플러그인이다. 야심찬 태스크를 마이크로 페이즈로 분해하여 각각 독립적으로 계획-실행-검증한다. 컨텍스트가 오염되지 않고, 실패가 전파되지 않는다.

> **[English Documentation](./README.md)**

[빠른 시작](#빠른-시작) · [철학](#혼돈에서-일관성으로) · [루프](#루프) · [파이프라인 깊이](#파이프라인-깊이-v017) · [에이전트](#에이전트-구성) · [내부 구조](#내부-구조)

---

> AI는 격리된 환경에서 무엇이든 만들 수 있다. 어려운 것은 조합되는 것을 만드는 것이다.
>
> AI 에이전트가 오래 실행될수록, 약속한 것을 더 많이 잊는다.
> MPL은 이에 맞서 싸우지 않는다 — 각 페이즈에 필요한 지식만 가진 새로운 마음을 부여한다.

---

## 혼돈에서 일관성으로

> "미래를 예측하는 최선의 방법은 과거를 예방하는 것이다."

모든 자율 코딩 파이프라인은 같은 적에 직면한다: **컨텍스트 오염**. 세션이 길어질수록 축적된 상태 — 미완성 아이디어, 버려진 접근법, 오래된 가정 — 가 이후 모든 결정을 저하시킨다. Phase 4쯤 되면 에이전트는 코드가 아닌 자신의 혼란을 디버깅하고 있다.

MPL의 답은 영웅적이 아니라 구조적이다:

```
 혼돈                                일관성
   "한 번에 전부 만들기"  →  "하나를 완벽히 만들고, 잊기"
   "Phase 5에서 고치기"   →  "Phase 0에서 예방하기"
   "에이전트 기억 신뢰"   →  "기록된 산출물만 신뢰"
```

이것은 조심의 철학이 아니다 — **복리적 신뢰성**의 철학이다. 각 마이크로 페이즈는 성공할 수 있을 만큼 작다. 각 성공은 State Summary로 기록된다. 이후 페이즈는 그 요약만 읽고, 어떻게 만들어졌는지의 지저분한 역사는 읽지 않는다.

결과: Phase 10이 Phase 1과 같은 명확함으로 실행된다.

### 두 가지 법칙

**법칙 1: 명세에 투자하라, 디버깅을 제거하라.**

7번의 실험으로 Phase 0 투자(API 계약, 타입 정책, 에러 명세)가 Phase 5 재작업을 단조적으로 감소시킴을 증명했다:

```
Phase 0 투자          통과율 추이
────────────────      ──────────────────────
Phase 0 없음          38% → 디버깅 지옥
+ API 계약            58% → 여전히 고통스러움
+ 예제 패턴           65% → 개선 중
+ 타입 정책           77% → 거의 다 됨
+ 에러 명세           100% → 디버깅 제로
```

**법칙 2: 오케스트레이터는 절대 코드를 작성하지 않는다.**

오케스트레이터가 소스 파일을 건드리는 순간, 자신의 구현에 투자하게 된다. 객관적 검증 대신 자기 코드를 방어한다. MPL은 PreToolUse 훅(`mpl-write-guard`)으로 안전하지 않은 직접 소스 편집(Move #6의 Bash redirect/tee/sed-i/dd-of/cp-mv/git-apply 경로 포함)을 기본 BLOCK 한다. 스코프 안의 편집만 경고로 격하된다. `mpl-cancel` SKILL 경로와 `decomposition.yaml` 작성자 신원은 강하게 보호된다 (#236). 모든 코드는 Task 위임을 통해 `mpl-phase-runner` 에이전트로 흐른다.

---

## 빠른 시작

**Step 1 — 사용하는 런타임에 설치:**

사용할 런타임에 맞춰 bootstrap 스크립트를 실행한다. Git은 선택 사항이다. checkout에서 실행하지 않으면 스크립트가 `curl`로 깨끗한 MPL source archive를 내려받는다.

```bash
# Claude Code
curl -fsSL https://raw.githubusercontent.com/KyubumShin/MPL/main/install.sh | bash -s -- --runtime claude --scope user

# Codex CLI
curl -fsSL https://raw.githubusercontent.com/KyubumShin/MPL/main/install.sh | bash -s -- --runtime codex

# 둘 다 (--scope는 Claude Code 설치에 적용됨)
curl -fsSL https://raw.githubusercontent.com/KyubumShin/MPL/main/install.sh | bash -s -- --runtime both --scope user
```

다운로드된 MPL source는 기본적으로 `~/.mpl/install/source/mpl` 아래에 유지된다. Claude Code 설치는 기본적으로 `--scope user`이며, `--scope ask`를 넘기면 Bash 안에서 선택할 수 있고 Enter는 `user`를 선택한다. `--scope ask`는 `curl | bash` 형태에서도 실제 대화형 TTY가 필요하므로, CI나 headless 환경에서는 `--scope user`, `--scope project`, `--scope local` 중 하나를 명시한다. 재현 가능한 설치가 필요하면 `curl -fsSL https://raw.githubusercontent.com/KyubumShin/MPL/main/install.sh | MPL_REF=v0.19.0 bash -s -- --runtime codex`처럼 release tag를 `bash`에 전달한다. 설치 루트를 바꾸려면 `MPL_INSTALL_ROOT=<path>`를 설정한다.

로컬 checkout에서 `install.sh`를 실행하면 로컬 source가 우선한다. 이때 `--ref`/`MPL_REF`는 경고를 출력하며, 특정 ref를 다운로드하려면 `MPL_FORCE_DOWNLOAD=1`을 함께 설정한다. 실행 전 확인하려면 `curl -fsSLo /tmp/mpl-install.sh https://raw.githubusercontent.com/KyubumShin/MPL/main/install.sh && less /tmp/mpl-install.sh && bash /tmp/mpl-install.sh --runtime codex`처럼 먼저 내려받아 검토할 수 있다.

설치 스크립트는 런타임별 marketplace 메타데이터를 분리한다. Claude는 persistent MPL source를 직접 marketplace로 등록하고, Codex는 `$CODEX_HOME/mpl-marketplace` 또는 `~/.codex/mpl-marketplace` 아래에 작은 wrapper marketplace를 만든 뒤 archive manifest 기준으로 `./plugins/mpl`에 깨끗한 MPL plugin root를 staging한다.

**갱신 안내:** MPL 업데이트 후에는 같은 `install.sh` 명령을 다시 실행한다. 기존 설치도 재실행 후 shared MCP launcher를 사용하며, 각 갱신 후 첫 MCP 호출에서 의존성 준비와 MCP 서버 빌드가 수행될 수 있다.

**Step 2 — 셋업 실행:**

```
/mpl:mpl-setup
```

**Step 3 — 빌드 시작:**

```
mpl 사용자 인증에 OAuth와 역할 기반 접근 제어 추가
```

<details>
<summary><strong>무슨 일이 일어났나?</strong></summary>

```
Goal Contract  → AC/AX 동결, real_runtime_required 계산
Phase 0        → API 계약 + 타입 정책 + 에러 명세 + raw scan
분해           → 순서화된 페이즈 + execution_tiers + resource_locks + covers + reviewer_required
페이즈 실행    → 페이즈별 새 세션, Phase Runner + Test Agent (독립 작성자) + Adversarial Reviewer
게이트         → Hard 1 빌드+타입, Hard 2 테스트, Hard 3 PP/H-item 종료 (Advisory 없음)
Finalize       → E2E real-runtime, Codex Audit (Tier 4), Atomic Commit
RUNBOOK        → resume-safe 실행 로그
```

각 페이즈는 자신의 컨텍스트만 보았다. 오염 없음. 전파 없음.

</details>

---

## 루프

MPL의 핵심은 **분해-실행-검증** 루프이며, 각 반복은 새로운 세션이다:

```
                    ┌─── Phase 0: 명세 ───┐
                    │  API 계약            │
                    │  타입 정책           │
                    │  에러 명세           │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  N개 마이크로       │
                    │  페이즈로 분해      │
                    └──────────┬──────────┘
                               │
              ┌────────────────▼────────────────┐
              │  각 페이즈 (새로운 세션):              │
              │    계획 → 페이즈 러너 → 테스트 → 검증  │
              │    출력: State Summary만                │
              └────────────────┬────────────────┘
                               │
                    ┌──────────▼──────────────┐
                    │  3 Hard Gates           │
                    │  Hard 1: 빌드+타입      │
                    │  Hard 2: 테스트         │
                    │  Hard 3: PP 준수        │
                    └──────────┬──────────────┘
                               │
                           완료
```

| 단계 | 무엇을 하는가 | 왜 중요한가 |
|------|-------------|------------|
| **Pivot Points** | 소크라테스식 인터뷰로 불변 제약조건 추출 | 스코프 드리프트 방지 |
| **Phase 0** | 사전 명세: 계약, 타입, 에러 | 디버깅 제거 |
| **분해** | 인터페이스 계약과 함께 순서화된 페이즈로 분할 | 각 페이즈 독립 검증 가능 |
| **실행** | 페이즈별 새 세션, 페이즈 러너 위임, 마이크로 테스트 사이클 | 컨텍스트 오염 없음 |
| **3 Hard Gates** | 테스트(Hard 2) → PP+H-items(Hard 3) + 빌드/타입(Hard 1) | 증거 기반 완료 |
| **RUNBOOK** | 연속 감사 로그 (사람/에이전트 세션 연속성) | 중단된 곳에서 재개 |

### State Summary: 유일한 다리

페이즈 간에 오직 하나의 산출물만 전달된다: **State Summary**. 무엇을 만들었고, 무엇을 결정했고, 무엇을 검증했는지 — 그 외에는 아무것도 없다. 코드 조각도, 디버깅 히스토리도, 버려진 접근법도 없다.

이것이 핵심 통찰이다: **잊는 것이 기능이다**. 각 페이즈는 깨끗하게 시작하며, 필요한 구조화된 지식만 가진다. 오케스트레이터가 컨텍스트 조립을 관리 — 올바른 요약, 올바른 Phase Decisions, 올바른 영향 파일을 로드 — 하여 Phase Runner가 완벽한 정보 밀도로 작동한다.

### Build-Test-Fix: 마이크로 사이클

각 페이즈 내부에서 모든 TODO는 즉시 검증된다:

```
각 TODO마다:
  Build  → Phase Runner가 변경 사항 구현
  Test   → 즉시 관련 테스트 실행 (마지막이 아닌)
  Fix    → 실패 시 수정 (TODO당 최대 2회 재시도)

전체 TODO 완료 후:
  Test Agent → 독립 테스트 작성 (코드 작성자 ≠ 테스트 작성자)
  누적 검증  → 이전 페이즈 전체에 대한 회귀 검사
```

구현을 테스트 전에 묶어서 처리하는 것은 금지다. 5개 TODO 이후 발견된 버그는 어느 것이 원인인지 알 수 없다. TODO #3 직후 발견된 버그는 TODO #3이 원인이다.

### 서킷 브레이크: 우아한 실패

페이즈가 3회 재시도 후에도 실패하면, 충돌하지 않고 **서킷 브레이크**한다:

1. PASS TODO 보존 (검증된 작업은 절대 폐기하지 않음)
2. FAIL TODO 파일을 페이즈 이전 상태로 롤백
3. `phase5-finalize`로 전환 (부분 완료)

MPL은 성공한 것과 실패한 것을 보고 — 부분 진행 상황은 항상 보존된다.

---

## 파이프라인 깊이 (v0.17+)

v0.17은 Hat/Triage 전면 라우팅을 제거했다. 모든 프롬프트는 풀 깊이로
진입한다: Phase 0 Enhanced → Decomposition → Phase Execution → 3 Hard Gates →
Finalize. 분해기(decomposer)가 스코프(페이즈 개수, execution_tiers,
resource_locks)를 결정한다. 동적 에스컬레이션, PP-proximity 티어, 키워드
오버라이드("mpl bugfix" / "mpl small")는 사라졌다 — mpl-keyword-detector는
더 이상 이를 인식하지 않는다.

---

## 에이전트 구성

11개 에이전트, 각각 단일 목적. 온디맨드 로드, 사전 로드 없음. 라이프사이클 단계별 그룹:

**인터뷰 & 분석**
| 에이전트 | 역할 | 모델 |
|---------|------|------|
| **Interviewer** | Stage 1 PP 발견 + Stage 2 모호성 해소. "타협할 수 없는 것은?" | opus |
| **Codebase Analyzer** | 6-모듈 구조 스캔 → `codebase-analysis.json` | haiku |
| **Phase 0 Analyzer** | 기계적 raw scan (경계, 시그니처, 테스트, 타입/에러 지점) → `raw-scan.md`. 추출만; 종합은 Decomposer로 이동 (#57) | haiku |

**분해 & Seed**
| 에이전트 | 역할 | 모델 |
|---------|------|------|
| **Decomposer** | 요청을 순서화된 마이크로 페이즈로 분해, 페이즈별 type policy + error spec + 검증 계획 종합. `decomposition.yaml` 단독 작성자 | opus |
| **Seed Generator** | 페이즈별 실행 spec 설계 (chain/inline 모드, #58) → `chain-seed.yaml` / `phase-seed.yaml` | opus |

**실행 & 검증**
| 에이전트 | 역할 | 모델 |
|---------|------|------|
| **Phase Runner** | 한 페이즈 실행: TODO 해소, 직접 구현, 검증, State Summary 작성 | sonnet |
| **Test Agent** | 독립 테스트 작성자 — 코드 작성자 ≠ 테스트 작성자 (AD-0004) | sonnet |
| **Adversarial Reviewer** | 페이즈 후 의도 vs 구현 감사, 품질 점수, 숨은 갭 표면화 (#103). `mpl-quality-gate.mjs`가 소비 | sonnet |

**Finalize**
| 에이전트 | 역할 | 모델 |
|---------|------|------|
| **Codex Auditor** | Tier 4 finalize-time 의도-구현 diff (F6, #117) → `audit-report.json` | haiku |
| **Git Master** | 원자 커밋 전문가 — 스타일 감지, 시맨틱 분할 (3+ 파일 = 2+ 커밋) | haiku |

**진단**
| 에이전트 | 역할 | 모델 |
|---------|------|------|
| **Doctor** | 12-카테고리 설치 진단. 읽기 전용 | haiku |

> 원래의 "여덟 개의 마음" 명명은 v0.17/v0.18 이전. Phase 0가 분리(Analyzer + Decomposer 종합, #57)되고 전용 Seed Generator(#58)가 분리되었으며, Tier 4 검증으로 Adversarial Reviewer(#103)와 Codex Auditor(#117, F6)가 추가되고 Git Master가 커밋 위생을 페이즈 실행에서 분리. Scout과 Compound는 오케스트레이터의 grep 기반 루프와 `.mpl/memory/learnings.md`(F-11)로 각각 흡수됨.

### 에이전트 분리 원칙

코드를 구현하는 Phase Runner는 검증하는 Test Agent가 아니다. 계획하는 Decomposer는 실행하는 Phase Runner가 아니다. 컨텍스트를 조립하는 오케스트레이터는 소스 파일을 건드리지 않는다. 각 분리가 한 부류의 편향을 제거한다.

---

## 검증 시스템

### A/S/H 분류

모든 검증이 동일하지 않다. MPL은 모든 기준을 분류한다:

| 타입 | 이름 | 검증 주체 | 예시 |
|------|------|----------|------|
| **A-item** | 에이전트 검증 가능 | 종료 코드, 파일 존재 | `npm test` 종료 코드 0 |
| **S-item** | 샌드박스 테스팅 | BDD 시나리오, Given/When/Then | 통합 테스트 통과 |
| **H-item** | 사람 필요 | 사용자와 사이드 인터뷰 | UX 판단, 시각적 리뷰 |

### 3 Hard Gates

세 개의 Hard Gate(차단):

| Gate | 타입 | 방법 | 통과 기준 |
|------|------|------|----------|
| **Hard 1** | **Hard** | 빌드 + 타입 검사 (프로젝트 전체) | 빌드 에러 0, 타입 에러 0 |
| **Hard 2** | **Hard** | 자동화 테스트 (A + S items) | pass_rate >= 95% |
| **Hard 3** | **Hard** | PP 준수 + H-item 해결 | 위반 없음 + 모든 H-items 해결 |

### 수렴 감지

Fix loop에서 pass rate 이력을 추적하여 자동 판단:

| 상태 | 조건 | 동작 |
|------|------|------|
| `improving` | delta > min_improvement | 수정 계속 |
| `stagnating` | variance < 5% AND delta < threshold | 전략 변경 또는 에스컬레이션 |
| `regressing` | delta < -10% | 롤백 또는 Phase 0 산출물 재검토 |

---

## 내부 구조

<details>
<summary><strong>11 에이전트 · 46 훅 · 10 스킬 · 11 프로토콜 파일</strong></summary>

```
MPL/
├── agents/                # 11개 에이전트 (mpl-adversarial-reviewer, mpl-codebase-analyzer,
│                          #   mpl-codex-auditor, mpl-decomposer, mpl-doctor, mpl-git-master,
│                          #   mpl-interviewer, mpl-phase-runner, mpl-phase0-analyzer,
│                          #   mpl-seed-generator, mpl-test-agent)
├── commands/              # 11개 프로토콜 파일 (mpl-run + run-phase0/decompose/execute/finalize 분할)
├── prompts/               # 4-Layer 템플릿 시스템 (F-39)
├── hooks/
│   ├── hooks.json         # 6 이벤트 × 1 엔트리포인트 (PreCompact / PreToolUse / PostToolUse
│   │                      #   / Stop / SessionStart / UserPromptSubmit)
│   ├── mpl-engine.mjs     # v2 디스패처 — 6개 이벤트 단일 엔트리포인트
│   ├── mpl-*.mjs          # 46개 훅 모듈 (v2 컷오버 동안 36개는 .legacy 형제 보유,
│   │                      #   lib/dispatch.mjs ROUTES로 라우팅)
│   └── lib/
│       ├── dispatch.mjs              # 이벤트별 ROUTES 테이블
│       ├── state/                    # reader / writer / shard-writer / wave-reducer (schema v7)
│       ├── policy/                   # 12개 v2 정책 모듈: audit, channel-registry, contracts,
│       │                             #   envelope-bridge, evidence, gates, isolation, permit,
│       │                             #   scheduler, schemas, session-init, source-edit
│       │                             #   + reconcile/ (4개 모듈)
│       ├── observability/            # bootstrap / signals / trackers
│       └── migrations/               # v1→v7 schema migration chain
├── skills/                # 10개 스킬 (mpl, mpl-pivot, mpl-status, mpl-cancel, mpl-resume,
│                          #   mpl-recover, mpl-gap-analysis, mpl-version-bump, mpl-doctor, mpl-setup)
└── docs/
    ├── design.md
    ├── redesign-proposal.html   # v2 아키텍처 근거 + Stage A move 로그
    ├── standalone.md
    ├── config-schema.md
    └── roadmap/
```

**핵심 내부 구조:**

- **Policy Engine (v2, #18)** — 12개 정책 모듈(hooks/lib/policy/)이 36개 독립 훅 판단을 대체; .legacy.mjs 형제는 한 사이클 동안 롤백 티어로 보존
- **Single-Dispatcher Hook Surface (v2 #14)** — hooks.json은 39 엔트리에서 6 엔트리(이벤트당 하나)로 축소; mpl-engine.mjs가 lib/dispatch.mjs ROUTES로 팬아웃
- **State Sharding + Wave Reducer (v2 #17)** — 병렬 페이즈 워커가 샤드 파일에 기록; wave-reducer가 `.mpl/state.json`(schema v7)으로 통합
- **Scheduler + Isolation (v2 #16)** — ExecutionContext가 디스패치 레이어를 통해 스케줄러 결정과 격리 정책 전달
- **Audit Policy + Tier 4 Drift Gating (v2 #13)** — Codex Auditor 평결이 finalize를 게이팅
- **RUNBOOK (F-10)** — 통합 실행 로그, 파이프라인 전환 지점에서 자동 업데이트, 세션 재개 가능
- **Session Persistence (F-12)** — 페이즈 전환마다 `<remember priority>` 태그 + RUNBOOK 이중 안전망
- **Run-to-Run Learning (F-11)** — 오케스트레이터가 RUNBOOK → `.mpl/memory/learnings.md` 증류
- **Self-Directed Context (F-24)** — Phase Runner가 스코프 바운디드 영향 파일 내 Read/Grep 가능
- **Task-based TODO (F-23)** — 실행 중 TaskCreate/TaskUpdate가 주요 TODO 상태 관리자
- **Background Execution (F-13)** — 독립 TODO를 `run_in_background: true`로 병렬 디스패치
- **Hard 1 빌드+타입 검사** — 프로젝트 전체 빌드 및 타입 검사 (이전 Gate 0.5 통합)
- **Standalone Mode (F-04)** — 도구 가용성 자동 감지, LSP/AST 미설치 시 Grep/Glob 폴백
- **2-Tier PD** — Phase Decisions를 Active/Summary로 분류, 페이즈당 일정 토큰 예산
- **Convergence Detection** — 정체(variance < 5%), 회귀(delta < -10%), 전략 제안

</details>

## v2 아키텍처

v0.19.0 릴리스는 Stage A v2 재설계(moves #1–#18)의 마지막 컷이다. 훅
레이어는 hooks.json의 39개 엔트리가 개별 스크립트를 호출하던 형태에서
단일 mpl-engine.mjs 디스패처가 lib/dispatch.mjs ROUTES를 통해 46개 모듈을
라우팅하는 구조로 이동했고, 정책 판단은 hooks/lib/policy/에 통합됐다. 전체
근거와 before/after 다이어그램, move별 로그는
[`docs/redesign-proposal.html`](./docs/redesign-proposal.html)에 있다.

### 상태 디렉토리: `.mpl/`

| 경로 | 용도 |
|------|------|
| `.mpl/state.json` | 파이프라인 + 실행 상태 통합 파일 (schema v7, v1→v7 migration chain은 hooks/lib/migrations/). `run_mode`/`current_phase`/`tool_mode` + `execution` subtree(task, phase_details, totals, cumulative_pass_rate) — 이전 2개 파일이 통합됨. |
| `.mpl/pivot-points.md` | 불변 제약조건 (Pivot Points) |
| `.mpl/config.json` | 사용자 설정 오버라이드 |
| `.mpl/mpl/RUNBOOK.md` | 세션 연속성을 위한 통합 실행 로그 (F-10) |
| `.mpl/mpl/decomposition.yaml` | 페이즈 분해 출력 |
| `.mpl/mpl/phase-decisions.md` | 축적된 Phase Decisions (2-Tier) |
| `.mpl/mpl/phase0/` | Phase 0 Enhanced 산출물 |
| `.mpl/mpl/phases/phase-N/` | 페이즈별 산출물 (mini-plan, state-summary, verification) |
| `.mpl/mpl/profile/` | 토큰/타이밍 프로파일 (phases.jsonl, run-summary.json) |
| `.mpl/memory/learnings.md` | Run-to-Run 축적 학습 (F-11) |
| `.mpl/memory/routing-patterns.jsonl` | 티어 예측을 위한 과거 실행 패턴 (F-22) |
| `.mpl/cache/phase0/` | Phase 0 캐시 산출물 |

---

## 설치

MPL은 Claude Code 플러그인과 Codex 플러그인 구조를 모두 제공한다. 동일한 `skills/`, `commands/`, MCP 서버 구현을 공유하고, 각 런타임별 manifest만 분리한다.

### 사전 요구사항

| 항목 | 최소 버전 | 확인 명령 |
|------|----------|----------|
| Claude Code CLI | 최신 | `claude --version` |
| Codex CLI | 최신 | `codex --version` |
| Node.js | 18+ | `node --version` |
| Git | 선택 사항 | `git --version` |

### 자동 설치

curl bootstrap:

```bash
# Claude Code
curl -fsSL https://raw.githubusercontent.com/KyubumShin/MPL/main/install.sh | bash -s -- --runtime claude --scope user

# Codex CLI
curl -fsSL https://raw.githubusercontent.com/KyubumShin/MPL/main/install.sh | bash -s -- --runtime codex
```

로컬 checkout에서 설치할 때는 다음을 사용할 수 있다:

```bash
./install.sh --runtime both --scope user
# 또는 Claude만 project scope에 설치
./install/claude.sh --scope project
```

MPL 업데이트 후에는 같은 `install.sh` 명령을 다시 실행해야 한다. 재현 가능한 설치가 필요하면 `MPL_REF=v0.19.0`처럼 release tag를 고정한다. 첫 MCP 사용 시 의존성 준비와 빌드가 한 번 수행될 수 있다.

설치 후 셋업 위저드에 맡길 수 있다:

```
/mpl:mpl-setup
```

또는 `setup mpl`이라고 입력하면 런타임 디렉토리, 설정 파일, 도구 감지까지 자동 처리한다.

### 설치 확인

```
/mpl:mpl-doctor
```

---

## 사용법

```bash
# 하고 싶은 것만 말하면 — 분해기가 파이프라인 규모를 결정한다
mpl 사용자 인증에 OAuth 추가
mpl 회원가입 폼에 입력 유효성 검증 추가
mpl handleSubmit에서 null 체크 수정

# 스킬 직접 호출
/mpl:mpl

# 진단
/mpl:mpl-doctor

# resume이 blocked_hook을 보고한 뒤 훅 차단 복구
/mpl:mpl-recover
```

Codex에서도 같은 MPL 스킬을 감지한다. Codex 세션에서 `mpl ...` 형태로 요청하거나 설치된 MPL 스킬을 직접 선택한다.

## Standalone 모드

LSP/AST MCP 도구가 없는 환경에서 MPL은 자동으로 폴백 도구를 사용한다:

| MCP 도구 (미설치 시) | Standalone 폴백 | 용도 |
|---------------------|----------------|------|
| `lsp_hover` | `Grep` + `Read` | Phase 0 API 계약 추출 |
| `lsp_find_references` | `Grep` (import/require 패턴) | 코드베이스 중심성 분석 |
| `lsp_goto_definition` | `Grep` + `Glob` | 의존성 추적 |
| `lsp_diagnostics` | `Bash(tsc --noEmit)` / `Bash(python -m py_compile)` | 페이즈 러너 결과 검증 |
| `lsp_document_symbols` | `Grep` (함수/클래스 정의 패턴) | 인터페이스 추출 |
| `ast_grep_search` | `Grep` (정규식 패턴) | Phase 0, 코드베이스 분석 |

> 모든 파이프라인 기능은 standalone 모드에서도 완전히 동작한다.

## 테스트

```bash
node --test hooks/__tests__/*.test.mjs
```

## 설계 참조

- 전체 사양: [`docs/design.md`](./docs/design.md)
- 로드맵: [`docs/roadmap/overview.md`](./docs/roadmap/overview.md)
- Adaptive Router 계획: [`docs/roadmap/adaptive-router-plan.md`](./docs/roadmap/adaptive-router-plan.md)
- Standalone 모드: [`docs/standalone.md`](./docs/standalone.md)

---

*"최고의 디버깅 세션은 결코 일어나지 않는 것이다."*

**MPL은 버그를 더 빨리 고치지 않는다 — 버그가 존재하지 않게 예방한다.**
