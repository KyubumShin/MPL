# 프롬프트 캐시 효율 분석: Claude Code 플러그인 생태계

- **작성일**: 2026-03-08
- **분류**: Analysis
- **연구 영역**: Context Engineering / Token Economics
- **분석 대상**: MPL v3.2, OMC v4.5, Hoyeon v0.6.6

---

## 1. 배경: Anthropic 프롬프트 캐시 동작 원리

Anthropic API의 프롬프트 캐시는 **prefix 기반**으로 동작한다. 이전 요청과 동일한 prefix를 공유하면 해당 부분의 입력 토큰 비용이 90% 할인된다.

```
Turn 1: [System Prompt] + [User Msg 1]
        ─── 전부 uncached (cache write) ───

Turn 2: [System Prompt] + [User Msg 1] + [Assistant 1] + [User Msg 2]
        ──────────── cached (hit!) ─────────────────   ── new only ──

Turn 3: [System Prompt] + [Msg 1] + [Resp 1] + [Msg 2] + [Resp 2] + [Msg 3]
        ──────────────────── cached (hit!) ──────────────────────   ── new ──
```

**핵심**: 대화가 길어질수록 캐시되는 prefix가 커지고, 신규 토큰 비율은 줄어든다. 캐시 TTL은 5분 (hit마다 갱신).

### /clear 시 캐시 동작

| 구간 | /clear 후 | 이유 |
|------|----------|------|
| System prompt | **캐시 유지** | 동일한 content-based prefix 재전송 → 서버 hit |
| 대화 히스토리 | **캐시 소실** | 이전 턴 삭제 → prefix 달라짐 |

---

## 2. Claude Code 플러그인의 구조적 한계

### 추상화 레이어

```
Plugin 레이어 (OMC, Hoyeon, MPL)
  ↓ Task(prompt="...") 호출
Claude Code 레이어 (내부)
  ↓ API call 구성 (system/user 분리, cache breakpoint)
Anthropic API 레이어
  ↓ 프롬프트 캐시 적용
```

플러그인 개발자는 **Task tool로 prompt 문자열을 넘길 뿐**, 실제 API 호출의 다음 요소를 제어할 수 없다:

- system/user message 분리
- cache breakpoint 위치 설정
- prefix 구성 순서
- TTL 관리

Claude Code가 내부적으로 agent `.md`를 system prompt에, 동적 context를 user message에 넣는 것은 플랫폼의 구현 디테일이다.

### 결론: 프롬프트 캐시 최적화의 책임 소재

| 최적화 영역 | 책임 주체 | 플러그인 제어 가능 |
|------------|----------|-----------------|
| Cache breakpoint 삽입 | Claude Code Product | ❌ |
| System/User message 분리 | Claude Code Product | ❌ |
| Multi-turn Task 지원 | Claude Code Product | ❌ |
| TTL 관리 | Anthropic API | ❌ |
| Task 호출 횟수 | 플러그인 | ✅ |
| 동적 컨텍스트 크기 | 플러그인 | ✅ |
| Agent prompt 크기 | 플러그인 | ✅ (간접적) |

---

## 3. MPL v3.2 캐시 효율 정량 분석

### 3.1 Orchestrator 세션 (Skill Prompts)

스킬 커맨드 파일은 세션 시작 시 1회 로드되어 전체 파이프라인 동안 캐시된다.

| 파일 | 토큰 |
|------|------|
| mpl-run.md | 1,858 |
| mpl-run-phase0.md | 7,228 |
| mpl-run-execute.md | 6,944 |
| mpl-run-finalize.md | 2,893 |
| mpl-run-decompose.md | 1,208 |
| **합계 (cached prefix)** | **20,131** |

Cache benefit: **HIGH** — 1회 로드, 파이프라인 전체 재사용.

### 3.2 Agent System Prompts (per Task call)

각 Task 호출 시 agent `.md`가 system prompt로 로드된다 (캐시 가능 prefix).

| Agent | 토큰 |
|-------|------|
| mpl-phase-runner | 3,535 |
| mpl-decomposer | 2,634 |
| mpl-interviewer | 2,397 |
| mpl-pre-execution-analyzer | 1,646 |
| mpl-doctor | 1,620 |
| mpl-compound | 1,314 |
| mpl-code-reviewer | 1,224 |
| mpl-worker | 1,149 |
| mpl-test-agent | 1,125 |
| mpl-verification-planner | 1,121 |
| mpl-git-master | 689 |
| mpl-scout | 419 |

### 3.3 Frontier 파이프라인 시뮬레이션 (4 phases)

| Agent Call | 호출 | Cached | Dynamic | Cache% |
|-----------|------|--------|---------|--------|
| Scout (codebase scan) | 1 | 419 | 500 | 46% |
| Pre-exec analysis | 1 | 1,646 | 3,000 | 35% |
| PP Interview | 1 | 2,397 | 1,000 | 71% |
| Verification Planner | 1 | 1,121 | 2,000 | 36% |
| Decomposer | 1 | 2,634 | 5,000 | 35% |
| Phase Runner (×4) | 4 | 14,140 | 32,000 | 31% |
| Worker (×8) | 8 | 9,192 | 24,000 | 28% |
| Test Agent (×4) | 4 | 4,500 | 8,000 | 36% |
| Code Reviewer (Gate 2) | 1 | 1,224 | 5,000 | 20% |
| Compound (×2) | 2 | 2,628 | 6,000 | 30% |
| Git Master | 1 | 689 | 2,000 | 26% |
| **합계** | **25** | **40,590** | **88,500** | **31%** |

### 3.4 비용 영향 (Sonnet 기준)

| 시나리오 | 입력 비용 | 절감률 |
|---------|----------|--------|
| 캐시 없음 | $0.3873 | — |
| 캐시 적용 | $0.2777 | 28.3% |

### 3.5 비효율 패턴

1. **Phase Runner 반복 컨텍스트**: PP(500토큰) × 4회 + Phase 0 summary(1000토큰) × 4회 = ~6,000 토큰 중복 (전부 uncached)
2. **Worker 반복 컨텍스트**: PP summary(300토큰) × 8회 = ~2,400 토큰 중복 (전부 uncached)
3. **구조적 한계**: 동적 컨텍스트가 user message 위치 → cache prefix 밖

---

## 4. 생태계 비교: 프롬프트 캐시 고려 현황

| 시스템 | 프롬프트 캐시 설계 | 토큰 효율 설계 |
|--------|-----------------|--------------|
| **MPL v3.2** | 없음 (Phase 0 파일 캐시만) | ✅ 3-Tier PD, token budget, scout, impact budget |
| **OMC v4.5** | 없음 | context_window 비율 모니터링만 |
| **Hoyeon v0.6.6** | 없음 | 언급 없음 |
| **Ouroboros** | 분석 불가 (소스 없음) | — |

**공통점**: 모든 시스템이 Task tool 기반으로 에이전트를 호출하며, 프롬프트 캐시를 플러그인 레벨에서 고려한 시스템은 없다.

---

## 5. 플러그인 레벨에서 가능한 최적화

프롬프트 캐시 자체는 제어 불가하지만, 토큰 비용 절감은 가능하다.

### 5.1 MPL이 이미 하고 있는 것

| 전략 | 절감 효과 | 메커니즘 |
|------|----------|---------|
| 3-Tier Phase Decisions | ~500-1000 tokens/phase (일정) | Active/Summary/Archived 분류 |
| Phase 0 파일 캐시 | 8-25K tokens/run (재실행 시) | 해시 기반 캐시 키 |
| Impact file budget | 5,000 tokens 상한 | location_hint + on-demand Read |
| Scout agent (haiku) | sonnet/opus 호출 전 저비용 탐색 | haiku로 구조 파악 후 위임 |
| Complexity-adaptive Phase 0 | Simple: 8K, Complex: 20K | 불필요한 분석 스킵 |

### 5.2 추가 가능한 최적화

| 전략 | 예상 절감 | 난이도 | 비고 |
|------|----------|--------|------|
| Phase 0 artifact 선택적 주입 | ~4,000 tokens/run | 낮음 | fix 페이즈엔 error-spec만 |
| PP를 agent .md에 런타임 주입 | cached 비율 31%→40% | 중간 | initState 시점에 prepend |
| Agent prompt 확장 | cached 비율 +5-10% | 낮음 | 실질 효과 제한적 |
| Worker를 Phase Runner 내부 실행 | Task 8회 → 0회 | 높음 | 아키텍처 변경 필요 |

### 5.3 Claude Code Product에 요청할 수 있는 것

| 기능 | 효과 |
|------|------|
| Task tool에 `cache_breakpoint` 옵션 | 플러그인이 캐시 prefix 경계 지정 |
| Multi-turn Task 지원 | Turn 1(stable context) → cached, Turn 2(dynamic) → new |
| Task prompt의 system/user 분리 제어 | 반복 컨텍스트를 system prompt로 이동 |

---

## 6. 결론

**프롬프트 캐시 최적화는 플러그인 레벨의 관심사가 아니라 Claude Code 플랫폼 레벨의 관심사다.**

플러그인 개발자는 Task tool이라는 블랙박스를 통해서만 API에 접근하며, 캐시 제어 프리미티브가 노출되지 않는다. 플러그인이 할 수 있는 최선은 "넘기는 텍스트를 줄이는 것"이며, MPL은 이미 PD 티어링, Phase 0 캐시, impact budget, scout 등으로 이를 실천하고 있다.

프롬프트 캐시를 MPL 로드맵에 별도 피처로 넣는 것은 ROI가 없다. 다만 Claude Code가 Task tool에 캐시 관련 옵션을 추가할 경우, 가장 먼저 혜택을 볼 수 있는 구조(반복 컨텍스트가 명확히 분리된 설계)는 갖추고 있다.
