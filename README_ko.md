# MPL (Micro-Phase Loop) v3.1

Claude Code를 위한 일관성 우선 자율 코딩 파이프라인 플러그인.

사용자 요청을 순서화된 마이크로 페이즈로 분해하고, 각 페이즈마다 독립적인 계획-실행-검증 미니 루프를 실행한다. 각 페이즈는 구조화된 컨텍스트(Pivot Points + Phase Decisions + 영향 파일)만으로 새 세션을 시작하여 컨텍스트 오염을 방지한다.

> **[English Documentation](./README.md)**

## 빠른 시작

```
"mpl {태스크 설명}" 이라고 입력하면 파이프라인이 시작된다
```

또는 스킬을 직접 호출:
```
/mpl:mpl
```

## 설치

MPL은 Claude Code 플러그인 구조를 따르며, 별도 의존성 없이 단독으로 설치·실행할 수 있다.

### 사전 요구사항

| 항목 | 최소 버전 | 확인 명령 |
|------|----------|----------|
| Claude Code CLI | 최신 | `claude --version` |
| Node.js | 18+ | `node --version` |
| Git | 2.x | `git --version` |

### Step 1: MPL repo 클론

대상 프로젝트 안에 서브디렉토리로 클론하거나, 별도 위치에서 심볼릭 링크로 연결한다.

```bash
cd /path/to/your-project

# 방법 A: 서브디렉토리로 클론
git clone https://github.com/<your-org>/MPL.git

# 방법 B: 별도 위치에 클론 후 심볼릭 링크
git clone https://github.com/<your-org>/MPL.git ~/tools/MPL
ln -s ~/tools/MPL /path/to/your-project/MPL
```

설치 후 프로젝트 구조:

```
your-project/
├── MPL/                        # MPL 플러그인 (클론 또는 심볼릭 링크)
│   ├── .claude-plugin/
│   │   └── plugin.json         # 플러그인 매니페스트
│   ├── .claude/
│   │   └── settings.local.json # 권한 설정
│   ├── agents/                 # 11개 에이전트 정의
│   ├── commands/               # 오케스트레이션 커맨드
│   ├── hooks/                  # 4개 훅
│   │   ├── hooks.json
│   │   ├── mpl-write-guard.mjs
│   │   ├── mpl-validate-output.mjs
│   │   ├── mpl-phase-controller.mjs
│   │   └── mpl-keyword-detector.mjs
│   ├── skills/                 # 7개 스킬
│   ├── package.json
│   └── README.md
├── src/                        # 소스 코드
└── ...
```

> Claude Code는 프로젝트 내 `.claude-plugin/plugin.json`을 가진 디렉토리를 자동으로 플러그인으로 인식한다.

### Step 2: 런타임 디렉토리 생성

MPL 파이프라인이 사용하는 상태 디렉토리를 프로젝트 루트에 생성한다.

```bash
mkdir -p .mpl/mpl/phase0
mkdir -p .mpl/mpl/phases
mkdir -p .mpl/mpl/profile
mkdir -p .mpl/cache/phase0
```

### Step 3: 기본 설정 파일 생성

`.mpl/config.json`을 프로젝트 루트에 생성한다.

```bash
cat > .mpl/config.json << 'EOF'
{
  "maturity_mode": "standard",
  "max_fix_loops": 10,
  "max_total_tokens": 500000,
  "gate1_strategy": "auto",
  "hitl_timeout_seconds": 30,
  "tool_mode": "standalone",
  "convergence": {
    "stagnation_window": 3,
    "min_improvement": 0.05,
    "regression_threshold": -0.1
  }
}
EOF
```

> `tool_mode`를 `"standalone"`으로 설정하면 LSP/AST grep 없이 Grep/Glob/Bash 폴백으로 동작한다. LSP MCP 도구가 설치된 환경에서는 `"full"`로 변경하면 LSP/AST 도구가 활성화된다.

### Step 4: .gitignore 추가 (권장)

```bash
# MPL 런타임 상태는 커밋하지 않는다
echo '.mpl/' >> .gitignore
```

### Step 5: 설치 확인

Claude Code를 프로젝트 루트에서 실행하면 MPL 플러그인이 자동 감지된다.

```bash
claude
```

세션 내에서 진단 명령 실행:

```
/mpl:mpl-doctor
```

10개 카테고리 모두 PASS로 표시되면 설치 완료.

### 자동 설치 (대안)

Step 1(클론)만 완료한 뒤, 나머지 과정을 셋업 위저드에 맡길 수 있다:

```
/mpl:mpl-setup
```

또는 프롬프트에 `setup mpl`이라고 입력하면 런타임 디렉토리 생성, 설정 파일 생성, 도구 감지까지 자동으로 처리한다.

### MPL 업데이트

```bash
cd MPL && git pull origin main
```

심볼릭 링크 방식이면 원본 위치에서 pull 하면 된다.

---

## 아키텍처

### 핵심 원칙: 오케스트레이터-워커 분리

오케스트레이터는 절대 소스 코드를 직접 작성하지 않는다. 모든 코드 변경은 Task 도구를 통해 `mpl-worker` 에이전트에게 위임한다. PreToolUse 훅이 이를 하드 블록으로 강제한다.

### 설계 원칙

| # | 원칙 | 설명 |
|---|------|------|
| 1 | 오케스트레이터-워커 분리 | 오케스트레이터는 모든 코드 변경을 워커에게 위임 |
| 2 | 계획 우선 | 페이즈 분해 완료 후에만 실행 시작 |
| 3 | 테스트 기반 검증 | 기계 검증 가능한 성공 기준만 사용 — 주관적 "완료" 불허 |
| 4 | 제한된 재시도 | 페이즈당 최대 3회 재시도, 최대 2회 재분해, 이후 서킷 브레이크 |
| 5 | 지식 축적 | State Summary가 페이즈 간 유일한 지식 전달 수단 |

### 파이프라인 흐름

```
Step -1: LSP 워밍업 (논블로킹, Step 0과 병렬)
Step  0: 트리아지 (pipeline_mode: bugfix/small/full) + 인터뷰 깊이
Step  0.5: 성숙도 모드 감지 (explore/standard/strict)
Step  1: Pivot Points 인터뷰 (불변 제약조건)
Step  1-B: 사전 실행 분석 (gap + tradeoff 단일 호출)
Step  1-D: PP 확인 게이트
Step  2: 코드베이스 분석 (구조, 의존성, 인터페이스)
Step  2.5: Phase 0 Enhanced (API 계약, 예제, 타입, 에러 명세)
Step  3: 페이즈 분해 (mpl-decomposer -> 순서화된 마이크로 페이즈)
Step  3-B: 검증 계획 (A/S/H-items 분류)
Step  4: 페이즈 실행 루프 (mpl-phase-runner -> mpl-worker per phase)
Step  5: E2E & 마무리 (학습 추출, 원자적 커밋, 메트릭)
Step  6: 재개 프로토콜 (마지막 체크포인트에서 재시작)
```

### 빠른 실패 트리아지

| pipeline_mode | 조건 | 파이프라인 |
|---------------|------|-----------|
| `bugfix` | 단일 파일, 명확한 버그/수정 대상 | 1-페이즈, PP 없음, Phase 0 없음 |
| `small` | ≤3 파일, ≤5 TODO, 아키텍처 변경 없음 | 3-페이즈 경량 |
| `full` | 그 외 전부 | 전체 MPL 파이프라인 (Steps -1~6) |

### 상태 머신

```
mpl-init -> mpl-decompose -> mpl-phase-running <-> mpl-phase-complete
                 ^                    |                      |
                 +-- mpl-circuit-break               mpl-finalize -> completed
                           |
                       mpl-failed
```

---

## Phase 0 Enhanced

실험 7건의 실증 데이터로 검증된 사전 명세 프로세스. Phase 0에 투자하여 Phase 5(디버깅/수정)를 불필요하게 만든다.

### 복잡도 감지 (3등급)

```
complexity_score = (modules x 10) + (external_deps x 5) + (test_files x 3)
```

| 등급 | 점수 | Phase 0 단계 | 토큰 예산 |
|------|------|-------------|----------|
| Simple | 0~29 | Error Spec만 | ~8K |
| Medium | 30~79 | Example + Error | ~12K |
| Complex | 80+ | 전체 (API + Example + Type + Error) | ~20K |

### 4단계 프로세스

| 단계 | 소스 | 출력 | 조건 |
|------|------|------|------|
| 1. API 계약 추출 | 함수 시그니처, 파라미터 순서 | `api-contracts` | Complex+ |
| 2. 예제 패턴 분석 | 사용 패턴, 기본값, 엣지 케이스 | `examples` | Medium+ |
| 3. 타입 정책 정의 | 타입 힌트, 컬렉션 타입 규칙 | `type-policy` | Complex+ |
| 4. 에러 명세 | 표준 예외, 메시지 패턴 | `error-spec` | All (필수) |

### 토큰 예산 재배분

```
v1.0 (~81K 전체)               v3.1 (적응형)
Phase 0:  ~5K  ( 6%)           Phase 0: 8~20K (16~40%)  <- 강화
Phase 1-3: ~45K (57%)          Phase 1-3: ~36K (60~72%)
Phase 4:  ~15K (19%)           Phase 4:  ~6K  (11~12%)
Phase 5:  ~16K (20%)           Phase 5:  ~0K  ( 0%)     <- 제거
```

---

## Build-Test-Fix 마이크로 사이클

Phase Runner는 TODO별 즉시 검증을 수행한다:

```
각 TODO마다:
  Build  -> Worker가 구현
  Test   -> 즉시 테스트 실행
  Fix    -> 실패 시 즉시 수정 (최대 2회)

전체 TODO 완료 후:
  Test Agent -> 독립 테스트 작성/실행 (코드 작성자 ≠ 테스트 작성자)
  누적 검증 -> 전체 테스트 스위트 회귀 검증
```

---

## 구성 요소

### 에이전트 (11개)

| 에이전트 | 역할 | 모델 | 도구 제한 |
|---------|------|------|----------|
| `mpl-interviewer` | Pivot Point 인터뷰 (hypothesis-as-options) | opus | Write/Edit/Bash/Task 차단 |
| `mpl-pre-execution-analyzer` | Gap + Tradeoff 통합 분석 (7섹션 출력) | sonnet | Write/Edit/Bash/Task 차단 |
| `mpl-decomposer` | 페이즈 분해 + risk_assessment 내장 | opus | Write/Edit/Bash/Task 차단 |
| `mpl-verification-planner` | A/S/H-items 분류 및 검증 전략 설계 | sonnet | Write/Edit/Task 차단 |
| `mpl-phase-runner` | 페이즈 실행 (mini-plan, 위임, 검증) | sonnet | 없음 |
| `mpl-worker` | TODO 구현 전문가 | sonnet | Task 차단 |
| `mpl-test-agent` | 독립 테스트 작성/실행 (코드 작성자와 분리) | sonnet | 없음 |
| `mpl-code-reviewer` | 8-카테고리 코드 리뷰 및 Quality Gate | sonnet | Write/Edit/Task 차단 |
| `mpl-compound` | 학습 추출 및 지식 증류 | sonnet | 없음 |
| `mpl-git-master` | 원자적 커밋 | sonnet | Write/Edit/Task 차단 |
| `mpl-doctor` | 설치 진단 (10 카테고리, standalone 감지) | haiku | Write/Edit/Task 차단 |

### 에이전트 파이프라인 흐름

```
                    [Step -1: LSP 워밍업]
                            |
mpl-interviewer -----> mpl-pre-execution-analyzer
       |                        |
       v                        v
  Pivot Points         Gap + Tradeoff 보고서
                                |
mpl-verification-planner <------+
       |
       v
  A/S/H 검증 계획
       |
mpl-decomposer <---------------+ (risk_assessment 내장)
       |
       v
  페이즈 분해 (YAML)
       |
mpl-phase-runner (페이즈별) ----> mpl-worker (TODO별)
       |                                |
       |                     mpl-test-agent (전체 TODO 완료 후)
       |
mpl-code-reviewer <--------------------+ (Gate 2: 품질)
       |
       v
  3-Gate 품질 검사
       |
mpl-compound <-------------------------+ (마무리)
       |
mpl-git-master <------------------------+ (원자적 커밋)
```

### 스킬 (7개)

| 스킬 | 용도 |
|------|------|
| `/mpl:mpl` | 메인 MPL 파이프라인 |
| `/mpl:mpl-pivot` | Pivot Points 인터뷰 (독립 또는 파이프라인 내) |
| `/mpl:mpl-status` | 파이프라인 상태 대시보드 |
| `/mpl:mpl-cancel` | 상태 보존 클린 취소 |
| `/mpl:mpl-resume` | 마지막 체크포인트에서 재개 |
| `/mpl:mpl-doctor` | 설치 진단 |
| `/mpl:mpl-setup` | 셋업 위저드 |

### 훅 (4개)

| 훅 | 이벤트 | 용도 |
|----|-------|------|
| `mpl-write-guard` | PreToolUse (Edit/Write) | 오케스트레이터의 소스 파일 편집 차단 |
| `mpl-validate-output` | PostToolUse (Task) | 에이전트 출력의 예상 스키마 검증 |
| `mpl-phase-controller` | Stop | 페이즈 전환 및 루프 지속 관리 |
| `mpl-keyword-detector` | UserPromptSubmit | "mpl" 키워드 감지 및 파이프라인 초기화 |

### 상태 디렉토리: `.mpl/`

| 경로 | 용도 |
|------|------|
| `.mpl/state.json` | 파이프라인 상태 |
| `.mpl/pivot-points.md` | 불변 제약조건 (Pivot Points) |
| `.mpl/config.json` | 사용자 설정 오버라이드 |
| `.mpl/mpl/state.json` | MPL 실행 상태 (lsp_servers, phases 등) |
| `.mpl/mpl/decomposition.yaml` | 페이즈 분해 출력 |
| `.mpl/mpl/phase-decisions.md` | 축적된 Phase Decisions (3-Tier) |
| `.mpl/mpl/pre-execution-analysis.md` | Gap + Tradeoff 통합 분석 |
| `.mpl/mpl/phase0/` | Phase 0 Enhanced 산출물 |
| `.mpl/mpl/phases/phase-N/` | 페이즈별 산출물 (mini-plan, state-summary, verification, recovery) |
| `.mpl/mpl/profile/` | 토큰/타이밍 프로파일 (phases.jsonl, run-summary.json) |
| `.mpl/cache/phase0/` | Phase 0 캐시 산출물 |
| `.mpl/mpl/metrics.json` | 파이프라인 메트릭 |

---

## 검증 시스템

### A/S/H-items 분류

| 타입 | 이름 | 검증 주체 | 예시 |
|------|------|----------|------|
| A-item | 에이전트 검증 가능 | 종료 코드 확인 | `npm test` 종료 코드 0 |
| S-item | 샌드박스 에이전트 테스트 | Gate 1 자동화 테스트 | Given/When/Then |
| H-item | 사람 필요 | Gate 3 사이드 인터뷰 | UX 판단, 시각적 리뷰 |

### 3-Gate 품질 시스템

| Gate | 방법 | 에이전트 | 통과 기준 |
|------|------|---------|----------|
| Gate 1 | 자동화 테스트 (A + S items) | mpl-phase-runner (누적) | pass_rate >= 95% |
| Gate 2 | 코드 리뷰 (8 카테고리) | mpl-code-reviewer | PASS 판정 |
| Gate 3 | PP 준수 + H-items 해결 | 오케스트레이터 + 사람 | PP 위반 없음 + H-items 해결 |

### 수렴 감지

Fix loop에서 pass rate 이력을 추적하여 자동 판단:

| 상태 | 조건 | 동작 |
|------|------|------|
| `improving` | delta > min_improvement | 계속 |
| `stagnating` | variance < 5% AND delta < threshold | 전략 변경 제안 |
| `regressing` | delta < -10% | 롤백 또는 Phase 0 산출물 재검토 |

### 서킷 브레이크 시 부분 롤백

서킷 브레이크 발생 시 PASS TODO는 보존하고 FAIL TODO 파일만 롤백. Recovery context가 `.mpl/mpl/phases/phase-N/recovery.md`에 저장되어 재분해에 활용.

---

## Phase Decision 3-Tier 시스템

페이즈 간 의사결정 전달 시 토큰 예산 관리:

| Tier | 내용 | 토큰 예산 | 조건 |
|------|------|----------|------|
| Tier 1 (Active) | 전체 상세 | ~400-800 | 현재 페이즈 영향 파일과 교차 |
| Tier 2 (Summary) | 1줄 요약 | ~90-240 | 현재 파일에 닿지 않는 아키텍처/API PD |
| Tier 3 (Archived) | ID만 | 최소 | 현재 페이즈와 무관 |

## 성숙도 모드

| 모드 | 페이즈 크기 | PP 필수 | 발견 사항 처리 |
|------|-----------|---------|--------------|
| `explore` | S (1-3 TODO) | 선택 | 자동 승인 |
| `standard` | M (3-5 TODO) | 필수 | PP 충돌 시 HITL |
| `strict` | L (5-7 TODO) | 필수 + 강제 | 모든 변경 HITL |

## 트리아지 통합

| 트리아지 결과 | 인터뷰 동작 |
|-------------|------------|
| `full` | 4 라운드: What -> What NOT -> Either/Or -> How to Judge |
| `light` | 2 라운드: What -> What NOT만 |
| `skip` | 인터뷰 없음, 프롬프트에서 PP 직접 추출 |

## LSP 통합

파이프라인 시작 시 LSP 서버를 사전 워밍업하여 cold start를 제거한다:

| 언어 | LSP 서버 | 용도 |
|------|---------|------|
| TypeScript/JS | typescript-language-server | 타입 추론, diagnostics, references |
| Python | pylsp / pyright | 타입 체크, 심볼 탐색 |
| Go | gopls | 인터페이스 추적, 컴파일 에러 |
| Rust | rust-analyzer | lifetime/borrow 체크, trait 추적 |

LSP 미설치 시 ast_grep_search + Grep으로 자동 폴백.

## Standalone 모드

LSP/AST MCP 도구가 없는 환경에서 MPL은 자동으로 폴백 도구를 사용한다:

| MCP 도구 (미설치 시) | Standalone 폴백 | 용도 |
|---------------------|----------------|------|
| `lsp_hover` | `Grep` + `Read` | Phase 0 API 계약 추출 |
| `lsp_find_references` | `Grep` (import/require 패턴) | 코드베이스 중심성 분석 |
| `lsp_goto_definition` | `Grep` + `Glob` | 의존성 추적 |
| `lsp_diagnostics` | `Bash(tsc --noEmit)` / `Bash(python -m py_compile)` | 워커 결과 검증 |
| `lsp_document_symbols` | `Grep` (함수/클래스 정의 패턴) | 인터페이스 추출 |
| `ast_grep_search` | `Grep` (정규식 패턴) | Phase 0, 코드베이스 분석 |

> 모든 파이프라인 기능은 standalone 모드에서도 완전히 동작한다.
> LSP MCP 서버를 설치하면 LSP/AST 기반 정밀 분석이 추가로 활성화된다.

---

## 사용법

```bash
# 전체 파이프라인 실행
mpl 사용자 인증 기능 추가해줘

# 경량 파이프라인 (3 파일 이하)
mpl small 로그인 버튼 스타일 수정

# 버그픽스 (단일 파일)
mpl bugfix handleSubmit에서 null 체크 누락

# 스킬로 직접 호출
/mpl:mpl
```

## 진단

```
/mpl:mpl-doctor
```

## 테스트

```
node --test hooks/__tests__/*.test.mjs
```

## 설계 참조

- 전체 사양: `docs/design.md`
- 로드맵 개요: `docs/roadmap/overview.md`
- Phase 1 기초: `docs/roadmap/phase1-foundation.md`
- Phase 2 점진적 개선: `docs/roadmap/phase2-incremental.md`
- Phase 3 자동화: `docs/roadmap/phase3-automation.md`
- 실험 요약: `docs/roadmap/experiments-summary.md`
