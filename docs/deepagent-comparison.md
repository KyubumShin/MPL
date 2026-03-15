# DeepAgent vs MPL: TODO/Task Management 비교 분석

## Executive Summary

2026년 3월 기준, 세 가지 주요 에이전트 프레임워크가 TODO/Task 관리에 대해 서로 다른 접근법을 채택하고 있다:

1. **LangChain Deep Agents**: `write_todos` 도구로 에이전트가 자율적으로 TODO 작성 후 실행
2. **RUC DeepAgent**: TODO 분해 없이 통합 추론 스트림에서 자율적으로 진행
3. **MPL v3.2 (Sprint 3)**: Task tool 기반 TODO 관리 (F-23), 병렬 실행 지원 (F-13)

---

## 1. LangChain Deep Agents의 `write_todos`

### 개념

에이전트가 작업을 스스로 TODO로 분해하고, 진행 상황을 추적하는 도구.

### 사용 패턴

```python
# Agent calls write_todos
write_todos([
  {"content": "Implement user model", "status": "pending"},
  {"content": "Add auth routes", "status": "pending"},
  {"content": "Write tests", "status": "pending"}
])

# Agent executes and updates
write_todos([
  {"content": "Implement user model", "status": "completed"},
  {"content": "Add auth routes", "status": "in_progress"},
  {"content": "Write tests", "status": "pending"}
])
```

### 특징

**장점:**
- 에이전트가 자율적으로 계획 수립
- 진행 상황 추적 자동화
- 사용자에게 진행 상황 가시성 제공

**단점:**
- TODO 리스트에 "얽매임" (LangChain 문서에서 인정한 한계)
- 에이전트 간 상태 동기화 불가능 (단일 에이전트만 가능)
- 병렬 실행 지원 없음
- TODO 간 의존성 추적 없음

### MPL과의 차이

| 특징 | Deep Agents | MPL (F-23) |
|------|------------|-----------|
| **TODO 생성 주체** | 에이전트 스스로 | Phase Runner (계획) → Task 도구 |
| **병렬 실행** | 불가능 | 가능 (F-13: Background Execution) |
| **에이전트 간 동기화** | 불가능 (단일 에이전트) | 가능 (Task tool 상태 공유) |
| **의존성 추적** | 없음 | 가능 (Task depends_on) |
| **파일 충돌 감지** | 없음 | 자동 감지 + 순차 강제 |

---

## 2. RUC DeepAgent의 통합 추론 스트림

### 개념

TODO로 분해하지 않고, **단일 통합 추론 스트림**에서 자율적으로 사고-도구발견-실행.

### 철학

> "ReAct의 고정된 Reason-Act-Observe 사이클을 버리고, 모델이 전체 문제를 보며 동적으로 진행"

### Memory Folding과 TODO

RUC DeepAgent는 TODO를 명시적으로 만들지 않지만, **Memory Folding** 메커니즘이 유사한 역할:

```
Episodic Memory: "Phase 1 완료 (User model 구현)"
Working Memory: "지금 Phase 2 진행 중 (auth routes)"
Tool Memory: "Passport.js 사용 성공, JWT 설정 완료"
```

### MPL과의 차이

| 특징 | RUC DeepAgent | MPL |
|------|--------------|-----|
| **분해 방식** | 암묵적 (모델 내부) | 명시적 (Decomposer → Phase Plan) |
| **진행 추적** | Memory Folding (3-tier) | RUNBOOK + Task tool |
| **검증 방식** | RL 기반 (ToolPO) | 3-Gate (Tests, Review, PP) |
| **투명성** | 낮음 (블랙박스) | 높음 (모든 Phase/TODO 기록) |
| **재현성** | 불확실 (RL 학습 의존) | 높음 (Phase Plan 재사용) |

---

## 3. MPL Sprint 3 (F-23): Task-based TODO 관리

### 배경

MPL v3.1까지는 `mini-plan.md`의 Markdown 체크박스로 TODO 관리:

```markdown
## Mini Plan

- [ ] TODO-1: Implement User model
- [ ] TODO-2: Add auth routes
- [ ] TODO-3: Write tests
```

**문제점 (LangChain Deep Agents와 동일):**
- Phase Runner가 체크박스 목록에 얽매임
- Worker 간 상태 동기화 불가능
- 병렬 실행 지원 없음
- 동적으로 TODO 추가/수정 어려움

### F-23: Task Tool 전환

Sprint 3에서 `mini-plan.md` → **Task tool** 전환:

```javascript
// Phase Runner creates tasks
TaskCreate({
  title: "Implement User model",
  description: "Create User schema with email/password",
  status: "pending",
  assignee: "mpl-worker-1",
  files: ["models/User.ts"]
})

TaskCreate({
  title: "Add auth routes",
  description: "POST /auth/signup, /login, /logout",
  status: "pending",
  assignee: "mpl-worker-2",
  files: ["routes/auth.ts"],
  depends_on: ["task-1"] // Dependency!
})

// Worker updates status
TaskUpdate({
  task_id: "task-1",
  status: "completed"
})
```

### 핵심 개선

**1. Worker 간 상태 동기화**
```
Worker 1: TaskUpdate(task-1, "completed")
Worker 2: TaskList() → task-1 완료됨 확인 → task-2 시작 가능
```

**2. 병렬 실행 (F-13: Background Execution)**
```javascript
// 독립 TODO는 병렬 실행
if (task.files와 다른 task.files가 겹치지 않음) {
  Task({
    run_in_background: true,
    subagent_type: "general-purpose",
    prompt: "Implement " + task.title
  })
}
```

**3. 파일 충돌 자동 감지**
```
task-1: files=["models/User.ts"]
task-2: files=["routes/auth.ts"]  ← 독립, 병렬 가능

task-3: files=["models/User.ts"]  ← task-1과 충돌, 순차 강제
```

**4. 동적 TODO 추가**
```javascript
// Worker가 실행 중 새 TODO 발견
TaskCreate({
  title: "Add email validation",
  description: "Discovered during auth route implementation",
  status: "pending"
})
```

---

## 4. 상세 비교표

### TODO 관리 방식

| 항목 | Deep Agents | RUC DeepAgent | MPL (Sprint 3) |
|------|------------|--------------|---------------|
| **분해 주체** | 에이전트 자율 | 암묵적 (내부) | Decomposer (명시적) |
| **저장 형식** | In-memory | Memory Folding | Task tool (지속) |
| **의존성 추적** | ❌ 없음 | ❌ 없음 | ✅ `depends_on` |
| **병렬 실행** | ❌ 불가능 | ❌ 단일 스트림 | ✅ F-13 지원 |
| **Worker 간 동기화** | ❌ 단일 에이전트 | ❌ 단일 에이전트 | ✅ Task 상태 공유 |
| **파일 충돌 감지** | ❌ 없음 | ❌ 없음 | ✅ 자동 감지 |
| **동적 TODO 추가** | ✅ 가능 | ✅ 자율적 | ✅ TaskCreate |
| **진행 추적** | `write_todos` | Memory Folding | TaskList + RUNBOOK |

### 컨텍스트 관리

| 항목 | Deep Agents | RUC DeepAgent | MPL |
|------|------------|--------------|-----|
| **메모리 구조** | 자동 요약 | Episodic/Working/Tool | State Summary + Phase Decisions |
| **페이즈 격리** | ❌ 없음 | ❌ 단일 스트림 | ✅ Phase별 독립 세션 |
| **컨텍스트 오염** | 가능 (긴 대화) | Memory Folding으로 완화 | 불가능 (페이즈 격리) |
| **검색 방식** | RAG (자동) | Tool Memory | F-24: Self-Directed Search |

### 검증 방식

| 항목 | Deep Agents | RUC DeepAgent | MPL |
|------|------------|--------------|-----|
| **테스트** | 사용자 정의 | RL 평가 | Gate 1 (자동 테스트) |
| **코드 리뷰** | 없음 | 없음 | Gate 2 (8-category) |
| **스펙 준수** | 없음 | 없음 | Gate 3 (PP Compliance) |
| **학습** | 없음 | ToolPO (RL 훈련) | Run-to-Run Learnings (F-11) |

---

## 5. "Seeing like an Agent" 교훈

### TodoWrite → Task 전환 (F-23)

LangChain Deep Agents 문서에서 인정한 문제:

> "에이전트가 TODO 리스트에 얽매이고, 에이전트 간 통신이 불가능"

MPL Sprint 3의 해결책:
- **TodoWrite 폐기** → Task tool 채택
- Worker 간 상태 동기화 가능
- 병렬 실행 지원 (F-13)
- 의존성 추적 (`depends_on`)

### RAG → Self-Directed Search (F-24)

기존 MPL (v3.1):
```
Orchestrator가 context assembly 후 Phase Runner에 주입
→ "given context" 패러다임
```

Sprint 3 (F-24):
```
Phase Runner가 scope-bounded search로 직접 탐색
→ "self-directed search" 패러다임
```

**장점:**
- Phase Runner가 필요한 컨텍스트만 Read/Grep
- 불필요한 컨텍스트 로딩 방지 (토큰 절감)
- 격리 원칙 유지 (impact files 범위 내에서만 검색)

**RUC DeepAgent와 비교:**
- DeepAgent: 통합 추론 스트림에서 자율 탐색
- MPL: Scope-bounded (페이즈별 impact files 범위)

---

## 6. 하이브리드 접근법 제안

### MPL + DeepAgent Memory Folding

현재 MPL의 State Summary를 3계층으로 확장:

```
.mpl/mpl/memory/
├── episodic.md      # 완료된 Phase 요약 (RUC의 Episodic Memory)
├── working.md       # 현재 Phase TODO + 단기 계획 (Working Memory)
└── tool.md          # 도구 사용 패턴 (Tool Memory)
```

**Phase Runner 프로토콜 수정:**
```markdown
# Phase Runner Context Loading

1. Load episodic.md (이전 Phase 요약)
2. Load working.md (현재 TODO 리스트)
3. Load tool.md (도구 성공/실패 패턴)
4. Self-directed search (F-24) for current phase files
```

### MPL + Deep Agents `write_todos`

F-23 Task tool을 유지하되, Phase Runner가 내부적으로 `write_todos` 스타일로 계획:

```javascript
// Phase Runner internal planning (not visible to user)
const internalPlan = [
  "Implement User model",
  "Add auth routes",
  "Write tests"
]

// But dispatches via Task tool for orchestration
for (const item of internalPlan) {
  TaskCreate({ title: item, ... })
}
```

**장점:**
- Phase Runner의 자율성 유지
- Orchestrator의 병렬 실행 제어 유지
- 에이전트 간 동기화 유지

---

## 7. 실험 아이디어

### Experiment 1: Memory Folding Integration

**목표:** RUC DeepAgent의 Memory Folding을 MPL에 통합

**구현:**
1. `.mpl/mpl/memory/` 디렉토리 생성
2. Phase 완료 시 episodic.md 업데이트
3. Phase Runner 실행 중 working.md 동적 업데이트
4. Tool 사용 성공/실패를 tool.md에 기록

**검증:**
- 토큰 사용량 감소 (State Summary 대비)
- Phase 전환 시 컨텍스트 로딩 시간 단축
- Fix Loop 시 tool.md 참조로 재시도 성공률 향상

### Experiment 2: Unified Reasoning Stream (선택적)

**목표:** RUC DeepAgent 스타일의 통합 추론을 Frugal tier에 적용

**구현:**
1. Frugal tier에서 Phase 분해 생략
2. 단일 에이전트가 통합 추론으로 진행
3. Memory Folding으로 긴 대화 관리

**검증:**
- Frugal tier 토큰 사용량 감소 (현재 ~8-15K → ~5-10K)
- 간단한 태스크 성공률 유지 (95%+)
- Phase 분해 오버헤드 제거

### Experiment 3: Task Tool + RL Learning

**목표:** RUC의 ToolPO를 MPL Task tool에 적용

**구현:**
1. Task 성공/실패 데이터 수집 (.mpl/memory/task-results.jsonl)
2. 성공 패턴 학습 (어떤 파일 조합이 병렬 가능한가?)
3. 다음 실행 시 학습된 패턴으로 TODO 분해 최적화

**검증:**
- 병렬 실행 효율 향상 (더 많은 TODO가 병렬 가능)
- 파일 충돌 오탐 감소
- 실행 시간 단축

---

## 8. 결론

### Deep Agents의 교훈

✅ **채택 가능:**
- `write_todos` 개념 (MPL은 이미 F-23으로 해결)
- 자동 컨텍스트 요약 (MPL은 State Summary로 유사)

❌ **채택 불가:**
- 단일 에이전트 제약 (MPL은 Worker 병렬 실행 필요)
- TODO 간 의존성 없음 (MPL은 Phase 간 의존성 중요)

### RUC DeepAgent의 교훈

✅ **채택 가능:**
- Memory Folding (3-tier 메모리 구조) ← **강력 추천**
- Self-directed search (MPL F-24와 일치)
- Tool Memory (도구 사용 패턴 학습) ← **F-11과 시너지**

❌ **채택 불가:**
- 통합 추론 스트림 (MPL의 페이즈 격리 철학과 충돌)
- RL 기반 훈련 (MPL은 3-Gate 검증 선호)

### MPL의 강점

**1. 구조화된 TODO 관리 (F-23):**
- Task tool로 Worker 간 동기화
- 의존성 추적 (`depends_on`)
- 병렬 실행 (F-13)

**2. 페이즈 격리:**
- 컨텍스트 오염 불가능
- 각 페이즈 독립 검증
- 실패 전파 차단

**3. 투명성:**
- 모든 Phase/TODO 기록
- Phase Decisions 추적
- RUNBOOK으로 세션 연속성

### 최종 권장사항 및 실행 상태

**✅ 로드맵 추가 (F-25, Sprint 5):**
1. **Memory Folding 통합** (Experiment 1)
   - `.mpl/mpl/memory/episodic.md` 생성
   - tool.jsonl로 도구 사용 패턴 학습
   - State Summary와 병행 사용
   - **상태**: `docs/roadmap/overview.md` (F-25), `docs/roadmap/sprints.md` (Sprint 5) 추가 완료 ✅
   - **우선순위**: HIGH
   - **예상 효과**: Phase 5+ 실행 시 토큰 70%+ 절감

**📄 문서로만 유지 (참고용):**
2. **Unified Reasoning for Frugal** (Experiment 2)
   - Frugal tier에만 통합 추론 적용 (Phase 분해 생략)
   - Standard/Frontier는 현재 방식 유지
   - A/B 테스트로 효과 검증
   - **사유**: MPL 철학(페이즈 격리)과 충돌 가능성, 장기 연구 필요
   - **상태**: 본 문서(Section 2, 6)에 분석만 보존
   - **우선순위**: LOW (장기 실험)

3. **Pattern Learning (프롬프트 기반)** (Experiment 3 수정안)
   - Task 성공/실패 패턴 수집
   - 병렬 실행 최적화 학습 (프롬프트 주입)
   - F-11 Run-to-Run Learnings와 통합
   - **사유**: RL 직접 튜닝 불가능하나 프롬프트 기반 학습은 가능. F-25 (tool.jsonl) 선행 필요
   - **상태**: 본 문서(Section 3, 6)에 수정안 보존. F-25 완료 후 재검토 예정
   - **우선순위**: MEDIUM (F-25 이후)

---

## References

### DeepAgent (RUC-NLPIR)
- GitHub: https://github.com/RUC-NLPIR/DeepAgent
- ArXiv: https://arxiv.org/abs/2510.21618

### LangChain Deep Agents
- GitHub: https://github.com/langchain-ai/deepagents
- Docs: https://docs.langchain.com/oss/python/deepagents/overview
- Blog: https://blog.langchain.com/deep-agents/

### MPL Internal Docs
- Sprint 3: `docs/roadmap/sprints.md`
- F-23: Task-based TODO 관리
- F-24: Self-Directed Context
- F-13: Background Execution

### "Seeing like an Agent"
- TodoWrite → Task 교훈
- RAG → Self-directed search 교훈

---

**작성일**: 2026-03-12
**작성자**: KyubumShin
**버전**: v1.1
**상태**: 분석 완료, Experiment 1 로드맵 반영 (F-25), Experiment 2/3 참고 문서로 유지
