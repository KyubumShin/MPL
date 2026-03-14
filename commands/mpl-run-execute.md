---
description: MPL Execution Protocol - Phase Execution Loop, Context Assembly, 3-Gate Quality, Fix Loop
---

# MPL Execution: Step 4 (Phase Execution Loop)

This file contains Step 4 of the MPL orchestration protocol — the core execution engine.
Load this when `current_phase` is `mpl-phase-running`.

---

## Step 4: Phase Execution Loop (CORE)

For each phase in order:

### 4.1: Context Assembly

```
context = {
  phase0_artifacts: load_phase0_artifacts(),        // Phase 0 Enhanced outputs
  pivot_points:     Read(".mpl/pivot-points.md"),
  phase_decisions:  build_tiered_pd(current_phase), // 3-Tier PD
  phase_definition: phases[current_index],
  impact_files:     load_impact_files(phase.impact),
  maturity_mode:    config.maturity_mode,
  prev_summary:     Read previous phase's state-summary.md (if available),
  dep_summaries:    load_dependency_summaries(current_phase),  // All phases referenced in interface_contract.requires
  verification_plan:  load_phase_verification_plan(current_phase),  // A/S/H items for this phase
  learnings:        load_learnings(),               // F-11: Past run learnings (optional)
  error_files:      load_error_files(current_phase) // F-30: Error files from previous attempts (optional)
}
```

#### Run-to-Run Learnings Loading (F-11) — Legacy

> **참고**: F-25 4-Tier Adaptive Memory가 이 단일 learnings 로딩을 대체한다.
> semantic.md가 존재하면 4-Tier 로딩을 사용하고, semantic.md가 없고 learnings.md만 존재하면 아래 레거시 로직을 사용한다.

```
load_learnings():
  path = ".mpl/memory/learnings.md"
  if exists(path):
    content = Read(path)
    // Cap at 2000 tokens (~100 lines) to bound context
    // Prioritize Failure Patterns section (most actionable)
    return truncate(content, max_lines=100)
  return null  // No learnings yet — first run
```

#### Layer 8: 4-Tier Adaptive Memory (F-25)

기존 learnings.md 단일 로딩을 4-Tier 선택적 로딩으로 확장한다.

```
load_adaptive_memory(task_description):
  1. **semantic.md** (항상 로드): 프로젝트 지식 — 일반화된 규칙, 컨벤션
     - 전체 로드, 최대 500 토큰
     - 최초 실행(파일 없음) 시 스킵

  2. **procedural.jsonl** (관련 항목만): 도구 사용 패턴
     - task_description에서 키워드 추출 → 태그 매칭
     - 매칭된 항목만 로드, 최대 500 토큰 (최근 10건)
     - 태그 예: type_mismatch, dependency_conflict, test_flake, api_contract_violation

  3. **episodic.md** (최근만): 이전 Phase 실행 요약
     - 최근 2 Phase 상세 + 이전 압축 1줄씩
     - 최대 800 토큰
     - 첫 Phase 실행 시: 없음 (episodic이 비어있음)

  4. **working.md** (현재 Phase만): 현재 Phase TODO 상태
     - Phase Runner가 자율 갱신
     - Context assembly에서는 Phase 시작 시 초기화

  총 메모리 예산: 최대 2000 토큰 (semantic 500 + procedural 500 + episodic 800 + working 200)

  기존 learnings.md는 semantic.md + procedural.jsonl로 대체되나,
  하위 호환을 위해 learnings.md가 존재하고 semantic.md가 없으면 learnings.md를 로드한다.
```

메모리 파일 경로:
```
.mpl/memory/
├── semantic.md         # 프로젝트 지식 (일반화된 규칙)
├── procedural.jsonl    # 도구 사용 패턴 (태그 기반 검색)
├── episodic.md         # Phase 실행 이력 (시간순)
├── working.md          # 현재 Phase 작업 상태 (휘발성)
└── learnings.md        # 레거시 호환 (F-11)
```

Context assembly의 `learnings` 필드는 다음 로직으로 결정:
```
if exists(".mpl/memory/semantic.md"):
  // F-25 활성: 4-Tier 로딩
  context.adaptive_memory = load_adaptive_memory(phase.description)
  context.learnings = null  // 레거시 비활성
else if exists(".mpl/memory/learnings.md"):
  // 레거시 폴백
  context.adaptive_memory = null
  context.learnings = load_learnings()
else:
  // 첫 실행
  context.adaptive_memory = null
  context.learnings = null
```

#### Error File Loading (F-30)

```
load_error_files(current_phase):
  errors_dir = ".mpl/mpl/phases/{current_phase.id}/errors/"
  if exists(errors_dir):
    files = list(errors_dir)  // todo-{n}-error.md, gate-{n}-error.md
    if files is not empty:
      return { path: errors_dir, files: files, contents: Read each file }
  return null  // No prior errors — first attempt or clean run
```

If error files exist for the current phase, include them in the Phase Runner context so the runner has full error history without relying on compacted conversation memory.

> **QMD Integration**: Fix loop 진입 시 에러 파일이 있으면 QMD에 경로를 전달하여 정밀 진단 수행. 예: `Task(subagent_type="mpl-scout", prompt="Diagnose error at {errors_dir}...")`.

#### Phase 0 Artifacts Loading

```
load_phase0_artifacts():
  summary = Read(".mpl/mpl/phase0/summary.md")
  grade = Read(".mpl/mpl/phase0/complexity-report.json").grade

  artifacts = { summary }

  // Load only generated artifacts (check existence)
  if exists(".mpl/mpl/phase0/api-contracts.md"):
    artifacts.api_contracts = Read(".mpl/mpl/phase0/api-contracts.md")
  if exists(".mpl/mpl/phase0/examples.md"):
    artifacts.examples = Read(".mpl/mpl/phase0/examples.md")
  if exists(".mpl/mpl/phase0/type-policy.md"):
    artifacts.type_policy = Read(".mpl/mpl/phase0/type-policy.md")
  if exists(".mpl/mpl/phase0/error-spec.md"):
    artifacts.error_spec = Read(".mpl/mpl/phase0/error-spec.md")

  // Token budget: ~2000 tokens for summary + key sections
  // Full artifacts only for Phase 1-2 (foundation phases)
  // Later phases: summary only (unless phase impacts Phase 0 artifact areas)
  return artifacts
```

#### Dependency-Based Summary Loading

```
load_dependency_summaries(current_phase):
  deps = current_phase.interface_contract.requires || []
  summaries = {}
  for each dep in deps:
    from_phase = dep.from_phase
    if from_phase != previous_phase:  // previous phase already loaded via prev_summary
      summary_path = ".mpl/mpl/phases/{from_phase}/state-summary.md"
      if exists(summary_path):
        summaries[from_phase] = Read(summary_path)

  // Token budget: max 30% of model context for all injected summaries
  // If over budget: trim summaries to first 100 lines each
  return summaries
```

#### PD 3-Tier Classification

Orchestrator classifies all PDs before each phase:

```
build_tiered_pd(current_phase):
  all_pd = read(".mpl/mpl/phase-decisions.md")

  for each pd in all_pd:
    if pd.affected_files INTERSECT current_phase.impact.{create,modify} != EMPTY:
      -> Tier 1 (Active): full detail included
    elif pd.from_phase in current_phase.interface_contract.requires[].from_phase:
      -> Tier 1 (Active): full detail included
    elif pd.type in ['DB Schema', 'API Contract', 'Architecture']:
      -> Tier 2 (Summary): 1-line summary
    else:
      -> Tier 3 (Archived): IDs only, not sent in context

  Token budget: Tier 1 ~400-800, Tier 2 ~90-240 tokens. Total ~500-1000 (stable regardless of phase count).
```

#### Impact Files Loading

For each file in `phase.impact.{create, modify, affected_tests, affected_config}`:
- If exists -> `Read(file)`, cap at 500 lines per file
- If not exists -> note as "new file to create"
- Total budget: ~5000 tokens

Over budget strategies:
1. `modify` files: send file paths + `location_hint` only — Phase Runner reads as needed (F-24)
2. `affected_tests`: test file names + describe/it block names only
3. `affected_config`: relevant sections only

#### Self-Directed Context Note (F-24)

Phase Runner is authorized to Read/Grep within the impact scope directly.
Therefore, the orchestrator MAY provide file paths only (without full content)
for large files, letting the Phase Runner load relevant sections on demand.
This reduces context assembly cost while maintaining Phase Runner accuracy.

#### Context Assembly 분기 (F-32: Adaptive Loading)

Phase Runner 호출 전 context 로드량을 상황에 따라 조절한다:

**Case 1: 동일 세션, compaction 없음** (compaction_count == last_phase_compaction_count)
- prev_summary만 로드 (이전 분석이 context에 남아있음)
- dependency_summaries, phase0_artifacts 스킵
- 메모리 재로드 스킵 (이미 context에 존재)
- 최소 토큰 사용

**Case 2: Compaction 발생 후** (compaction_count > last_phase_compaction_count)
- prev_summary + dependency_summaries 로드
- checkpoint 파일이 있으면 로드 (F-31) <!-- F-31 checkpoint: write-side spec TBD (roadmap Sprint 7+). Currently `if exists` check safely skips when absent. -->
- error 파일이 있으면 로드 (F-30)
- Complex grade일 때만 phase0_artifacts 로드
- **F-25 메모리 재로드**: semantic.md + 최근 procedural (태그 매칭) + episodic 요약 (최근 2 Phase)

**Post-Compaction Budget Check (F-33)**:
Compaction 발생 후 context-usage.json을 다시 읽어 예산을 확인한다:
```python
if compaction_since_last_phase:
    budget = predictBudget(cwd)
    if budget.recommendation == "pause_now":
        execute_graceful_pause(budget, current_phase_id, completed, remaining)
        return
    # "pause_after_current"는 Phase 진행 중이므로 현재 Phase 완료 후 판단
```

**Case 3: 새 세션에서 resume** (session_id 변경)
- 전체 context assembly 수행
- prev_summary + dependency_summaries + phase0_artifacts + learnings
- RUNBOOK.md tail + error files + checkpoint
- **F-25 전체 메모리 로드**: semantic.md 전체 + procedural 전체 (최근 10건) + episodic 전체 + working.md

context assembly 완료 후 state 갱신:
```
state.last_phase_compaction_count = state.compaction_count
```

### 4.1.5: Worktree 격리 판정 (F-15)

Pre-Execution Analysis(Step 1-B)에서 risk=HIGH로 판정된 페이즈는 worktree에서 격리 실행한다.

> **적용 조건**: Worktree 격리는 **Frontier tier에서만** 활성화된다. Frugal/Standard tier는 단일 Phase로 worktree 오버헤드가 이점을 초과하므로 이 단계를 스킵한다.

#### 판정 기준

state.json의 현재 Phase 정보에서 risk_level을 참조:
- `risk_level == "HIGH"` → worktree 격리 실행
- `risk_level != "HIGH"` → 일반 실행 (기존 동작, Step 4.2로 진행)

#### 격리 실행 프로토콜

1. **Worktree 생성**:
   ```
   branch_name = "mpl-isolated-{phase_id}-{timestamp}"
   git worktree add /tmp/mpl-worktree-{phase_id} -b {branch_name}
   ```

2. **Phase Runner 디스패치**:
   - Task 도구에 `isolation: "worktree"` 파라미터 추가
   - Phase Runner는 worktree 경로에서 실행
   - `.mpl/` 상태 파일은 원본에서 읽되, 코드 변경은 worktree에서

3. **결과 판정**:

   | 결과 | 대응 |
   |------|------|
   | Phase 성공 (모든 criteria pass) | worktree → main branch 머지 (`git merge --no-ff`) |
   | Phase 실패 (circuit_break) | worktree 삭제, 원본 코드 무변경 |
   | 부분 성공 (일부 TODO 완료) | 사용자에게 선택 요청 (AskUserQuestion): 머지/폐기/수동검토 |

4. **정리**:
   ```
   git worktree remove /tmp/mpl-worktree-{phase_id}
   git branch -d {branch_name}  # 머지 완료 시
   git branch -D {branch_name}  # 폐기 시
   ```

5. **State 추적**:
   state.json에 기록:
   ```json
   {
     "worktree_history": [{
       "phase_id": "phase-3",
       "branch": "mpl-isolated-phase-3-20260313",
       "path": "/tmp/mpl-worktree-phase-3",
       "risk_level": "HIGH",
       "result": "merged",
       "timestamp": "2026-03-13T14:00:00Z"
     }]
   }
   ```
   `result` 값: `"merged"` | `"discarded"` | `"manual_review"`

#### 제한 사항

- Worktree 격리는 Frontier tier에서만 활성 (Frugal/Standard는 단일 Phase로 worktree 오버헤드 > 이점)
- 동시에 1개 worktree만 유지 (병렬 worktree 미지원)
- `.mpl/` 디렉토리는 worktree에 복사하지 않음 (원본 참조)
- Worktree 내에서 Phase Runner의 Read/Grep 범위는 worktree 경로 기준으로 재매핑

### 4.2: Phase Runner Execution (Fresh Session)

Each Phase Runner is a Task agent = fresh session. This naturally prevents context accumulation.

```
// Model routing: sonnet by default, opus for L complexity or architecture changes
phase_model = (phase.complexity == "L" || phase.tags.includes("architecture")) ? "opus" : "sonnet"

result = Task(subagent_type="mpl-phase-runner", model=phase_model,
     prompt="""
     You are a Phase Runner for MPL.
     Execute this single phase: plan TODOs, delegate to Workers, verify, summarize.

     ## Rules
     1. Scope discipline: Only work within this phase's scope.
     2. Impact awareness: Impact section lists files to touch. Out-of-scope -> create Discovery.
     3. Worker delegation: Delegate code changes to mpl-worker via Task tool.
     4. Incremental testing: After each TODO (or parallel group), immediately test the affected module. Fix failures before moving to the next TODO. Do NOT batch all implementation before testing.
     5. Cumulative verification: Run ALL tests (current + prior phases) at phase end. Record pass_rate.
     6. Discovery reporting: Unexpected findings -> Discovery with PP conflict assessment.
     7. PD Override: Changing past decisions -> explicit PD Override request.
     8. State Summary: Write thorough summary including pass_rate. This is the ONLY thing the next phase sees.
     9. Retry on failure: Same session retry (max 3). Change approach each time. After 3 -> circuit_break.
     10. Phase 0 reference on failure: When tests fail, consult Phase 0 artifacts (error-spec, type-policy, api-contracts) before fixing. Most failures stem from Phase 0 spec misalignment.
     11. Self-directed context (F-24): You may use Read/Grep within scope-bounded files (impact files listed below) to gather additional context. Do NOT search outside the phase's impact scope. This replaces passive "given context" with active exploration.
     12. Task-based TODO (F-23): Use TaskCreate to register TODOs instead of writing mini-plan.md checkboxes. Track TODO status via TaskUpdate (in_progress -> completed/failed). This enables worker dependency tracking and parallel dispatch readiness.

     ---
     ## Pivot Points
     {pp_content}

     ## Phase Decisions
     ### Active (full detail)
     {tier1_pd}
     ### Summary (1-line each)
     {tier2_pd}
     ### Archived (IDs only)
     {tier3_list}

     ## Phase Definition
     {phase_definition as YAML}

     ## Impact Files
     {impact_files content}

     ## Maturity Mode
     {maturity_mode}

     ## Previous Phase State Summary
     {previous phase's state-summary.md if available, or "N/A (first phase)"}

     ## Dependency Phase Summaries
     {dep_summaries — summaries from non-adjacent dependency phases, or "N/A"}

     ## Phase 0 Enhanced Artifacts
     ### Complexity: {grade} (score: {score})
     ### Summary
     {phase0_summary}
     ### API Contracts (if available)
     {api_contracts or "N/A — below complexity threshold"}
     ### Examples (if available)
     {examples or "N/A — below complexity threshold"}
     ### Type Policy (if available)
     {type_policy or "N/A — below complexity threshold"}
     ### Error Specification
     {error_spec}

     ## Verification Plan (A/S/H items for this phase)
     {phase_verification_plan}

     ## Adaptive Memory (F-25)
     ### Semantic (프로젝트 지식)
     {adaptive_memory.semantic or "N/A — 첫 실행"}
     ### Procedural (관련 도구 패턴)
     {adaptive_memory.procedural or "N/A — 매칭 항목 없음"}
     ### Episodic (이전 Phase 요약)
     {adaptive_memory.episodic or "N/A — 첫 Phase"}

     ## Past Run Learnings (F-11) — Legacy
     {learnings or "N/A — F-25 활성 시 Adaptive Memory 참조"}

     ## Prior Error Files (F-30)
     {error_files contents or "N/A — no prior errors for this phase"}

     ## Scope-Bounded Search (F-24)
     You are authorized to Read/Grep the following files directly for additional context.
     Stay within this scope — do NOT explore files outside the impact boundary.
     Allowed files: {phase.impact.create + phase.impact.modify + phase.impact.affected_tests}
     Use this when:
     - The provided context is insufficient to implement a TODO
     - You need to understand how a function is called elsewhere within scope
     - Test files need inspection for assertion patterns

     ## Working Memory (F-25)
     Phase 시작 시 working.md가 초기화되어 있다.
     실행 중 TODO 상태 변경과 핵심 발견 사항을 working.md에 기록하라.
     Phase 완료 시 working.md 내용을 episodic 형식으로 변환하여 반환하라.
     {working_md_content or "N/A — 첫 Phase, working memory 비어있음"}

     ## Expected Output
     Return structured JSON:
     {
       "status": "complete" | "circuit_break",
       "task_ids": ["task-1", "task-2"],  // F-23: IDs from TaskCreate
       "state_summary": "markdown (required sections: 구현된 것, Phase Decisions, 검증 결과)",
       "new_decisions": [{ "id": "PD-N", "title": "...", "reason": "...", "affected_files": [...], "type": "..." }],
       "discoveries": [{ "id": "D-N", "description": "...", "pp_conflict": null | "PP-N", "recommendation": "..." }],
       "verification": {
         "criteria_results": [{ "criterion": "...", "pass": true|false, "evidence": "..." }],
         "regression_results": [{ "from_phase": "...", "test": "...", "pass": true|false }],
         "micro_cycle_fixes": 0,
         "pass_rate": 100
       },
       "failure_summary": "... (only if circuit_break)",
       "attempted_fixes": ["... (only if circuit_break)"]
     }

     State Summary recommended additional sections: "수정된 것", "Discovery 처리 결과", "다음 phase를 위한 참고"
     """)
```

#### Phase Runner 디스패치 시 working.md 라이프사이클 (F-25)

Phase Runner 디스패치 전후로 working.md를 관리한다:

```
// 1. Phase 시작: working.md 초기화
Write(".mpl/memory/working.md", """
# Working Memory — Phase {N}: {phase_name}
Updated: {timestamp}

## TODOs
(Phase Runner가 Mini-Plan 생성 후 채움)

## Notes
(Phase Runner가 실행 중 발견한 노트)
""")

// 2. Phase 실행 중: Phase Runner가 TODO 완료/실패 시 working.md 자율 갱신
//    (Phase Runner 내부에서 처리 — 아래 mpl-phase-runner.md 참조)

// 3. Phase 완료: working.md 내용을 episodic.md로 이전 후 초기화
if result.status == "complete":
  episodic_entry = format_episodic(result.working_memory_snapshot)
  // "### Phase {N}: {name} ({timestamp})\n{구현 내용}\n{핵심 결정}\n{검증 결과}"
  Append(".mpl/memory/episodic.md", episodic_entry)
  Write(".mpl/memory/working.md", "")  // 초기화
```

### 4.2.1: Phase 도메인 기반 동적 라우팅 (F-28)

Decomposer(Step 3)가 각 Phase에 `phase_domain` 태그를 부여한다.
Phase Runner 디스패치 시 도메인에 따라 프롬프트와 모델을 동적 선택한다.

#### phase_domain 태그 목록

| 도메인 | 설명 | 특화 프롬프트 | 모델 |
|--------|------|-------------|------|
| `db` | DB 스키마, 마이그레이션, 쿼리 | SQL 안전성, 마이그레이션 롤백, 인덱스 | sonnet |
| `api` | API 엔드포인트, 라우팅, 미들웨어 | RESTful 규칙, 에러 코드, 인증 | sonnet |
| `ui` | 프론트엔드, 컴포넌트, 스타일링 | 접근성, 반응형, 상태 관리 | sonnet |
| `algorithm` | 복잡 로직, 최적화, 데이터 구조 | 시간/공간 복잡도, 엣지 케이스 | **opus** |
| `test` | 테스트 작성, 테스트 인프라 | 커버리지, 격리, 모킹 전략 | sonnet |
| `infra` | 설정, CI/CD, 빌드, 배포 | 환경 변수, 도커, 보안 | sonnet |
| `general` | 분류 불가 또는 혼합 | 범용 (기존 동작) | sonnet |

#### 라우팅 프로토콜

```pseudocode
function dispatch_phase_runner(phase):
  domain = phase.phase_domain || "general"

  # 1. 모델 선택
  if domain == "algorithm" and phase.complexity in ["L", "XL"]:
    model = "opus"
  else:
    model = "sonnet"  # 기본값

  # 2. 도메인 특화 프롬프트 로드
  domain_prompt = load_domain_prompt(domain)
  # 경로: .mpl/prompts/domains/{domain}.md (있으면 사용, 없으면 범용)

  # 3. Phase Runner 디스패치
  phase_runner = dispatch(
    agent = "mpl-phase-runner",
    model = model,
    context = assemble_context(phase) + domain_prompt,
    phase_definition = phase
  )

  return phase_runner
```

#### 도메인 특화 프롬프트 형식

`.mpl/prompts/domains/{domain}.md` (오케스트레이터가 Phase Runner 컨텍스트에 주입):

```markdown
# Domain: {domain}
## 핵심 원칙
- {domain-specific principle 1}
- {domain-specific principle 2}

## 주의 사항
- {common pitfall 1}
- {common pitfall 2}

## 검증 포인트
- {what to verify for this domain}
```

예시 — `db.md`:
```markdown
# Domain: DB
## 핵심 원칙
- 마이그레이션은 항상 롤백 가능해야 한다
- 인덱스 추가는 데이터 크기를 고려한다
- 스키마 변경은 기존 데이터 호환성을 유지한다

## 주의 사항
- DROP TABLE/COLUMN은 되돌릴 수 없다 — 별도 Phase로 분리
- ORM 마이그레이션과 raw SQL을 혼용하지 않는다
- 트랜잭션 범위를 최소화한다

## 검증 포인트
- 마이그레이션 up/down 모두 성공하는가?
- 기존 seed/fixture 데이터와 호환되는가?
- 인덱스가 쿼리 패턴에 적절한가?
```

#### 도메인 프롬프트 경로 해석

도메인 프롬프트는 두 위치에서 탐색한다 (우선순위 순):
1. `.mpl/prompts/domains/{domain}.md` — 프로젝트별 커스텀 (사용자가 추가/수정 가능)
2. `MPL/prompts/domains/{domain}.md` — MPL 플러그인 기본 제공

`/mpl:mpl-setup` 실행 시 기본 프롬프트를 `.mpl/prompts/domains/`에 복사한다.
복사되지 않은 경우에도 MPL 플러그인 경로에서 폴백 로드한다.
두 위치 모두 없으면 범용 프롬프트 사용 (기존 동작).

#### 도메인 프롬프트 없을 때

`.mpl/prompts/domains/` 디렉토리나 해당 도메인 파일이 없으면:
- 범용 프롬프트 사용 (기존 동작과 동일)
- 도메인 프롬프트는 **선택적 확장** — 없어도 파이프라인 동작에 영향 없음

#### F-22 Routing Pattern과의 연동

실행 완료 후 routing-patterns.jsonl에 domain 정보도 기록:
```jsonl
{"ts":"...","desc":"...","tier":"frontier","domain_distribution":{"db":2,"api":3,"test":1},"result":"success","tokens":85000}
```
다음 실행 시 유사 태스크의 domain 분포를 참조하여 사전 프롬프트 캐싱 가능.

#### Phase Runner 프롬프트에 도메인 컨텍스트 주입

Step 4.2의 Phase Runner 디스패치 프롬프트에 도메인 섹션을 추가한다:

```
     ## Domain Context (F-28)
     Domain: {phase.phase_domain or "general"}
     {domain_prompt_content or "범용 — 도메인 특화 프롬프트 없음"}
```

기존 `phase_model` 로직과의 통합:
```
// 기존 복잡도 기반 라우팅과 도메인 기반 라우팅을 병합
phase_model = determine_model(phase):
  // 1. 기존 규칙: L complexity 또는 architecture 태그 → opus
  if phase.complexity == "L" || phase.tags.includes("architecture"):
    return "opus"
  // 2. F-28 규칙: algorithm 도메인 + L/XL → opus
  if phase.phase_domain == "algorithm" and phase.complexity in ["L", "XL"]:
    return "opus"
  // 3. 기본값
  return "sonnet"
```

### 4.2.2: Test Agent (Independent Verification)

After Phase Runner completes with status `"complete"`, dispatch the Test Agent for independent verification:

```
test_result = Task(subagent_type="mpl-test-agent", model="sonnet",
     prompt="""
     ## Phase: {phase_id} - {phase_name}
     ### Verification Plan (A/S-items for this phase)
     {phase_verification_plan}
     ### Interface Contract
     {phase_definition.interface_contract}
     ### Implemented Code
     {list of files created/modified by the Phase Runner}

     Write and run tests for this phase's implementation.
     """)
```

Merge test_result into Phase Runner's verification data:
- Update pass_rate with Test Agent's independent results
- Record any bugs_found for potential fix cycle
- If Test Agent pass_rate < Phase Runner's pass_rate: flag discrepancy

### 4.2.3: Task-based TODO Protocol (F-23)

Phase Runner uses Task tool instead of mini-plan.md for TODO management:

```
// Instead of writing mini-plan.md:
// - [ ] TODO 1: implement X
// - [ ] TODO 2: add tests for X

// Use Task tool:
TaskCreate(description="TODO 1: implement X", priority="high")
TaskCreate(description="TODO 2: add tests for X", priority="medium")

// Before delegating to worker:
TaskUpdate(id=task_id, status="in_progress")

// After worker completes:
TaskUpdate(id=task_id, status="completed")  // or "failed"
```

Benefits over mini-plan.md:
- Worker dependency tracking via Task metadata
- Parallel dispatch: independent Tasks can run simultaneously (F-13)
- Status synchronization: orchestrator can poll Task status
- No model-generated checkbox parsing errors

Backward compatibility: mini-plan.md is still written as a human-readable artifact,
but Task tool is the SSOT for TODO state during execution.

### 4.2.4: Background Execution for Independent TODOs (F-13)

When Phase Runner identifies independent TODOs (no file overlap), dispatch workers in parallel:

```
// File conflict detection (v3.1):
for each pair of pending TODOs:
  files_a = todo_a.impact_files
  files_b = todo_b.impact_files
  if intersection(files_a, files_b) is EMPTY:
    -> mark as independent, eligible for parallel dispatch

// Parallel dispatch:
for each independent TODO group:
  // Model routing: opus for architecture changes or 3+ retry failures
  worker_model = (todo.retry_count >= 3 || todo.tags.includes("architecture")) ? "opus" : "sonnet"
  Task(subagent_type="mpl-worker", model=worker_model,
       prompt="...", run_in_background=true)

// Sequential fallback:
for each TODO with file conflicts:
  worker_model = (todo.retry_count >= 3 || todo.tags.includes("architecture")) ? "opus" : "sonnet"
  Task(subagent_type="mpl-worker", model=worker_model,
       prompt="...", run_in_background=false)

// Wait and collect:
for each background task:
  result = await task completion
  TaskUpdate(id=task_id, status=result.status)
```

Constraints:
- Maximum 3 concurrent background workers per phase
- File conflict detection uses v3.1's existing overlap logic
- If any parallel worker fails, remaining workers continue
- Failed worker results feed into fix cycle (existing behavior)
- Phase Runner must wait for ALL workers before proceeding to verification

### 4.3: Result Processing

**On `"complete"`**:

```
1. Validate state_summary required sections: ["구현된 것", "Phase Decisions", "검증 결과"]
   - Missing -> request supplement (1 attempt). Still missing -> warn, proceed (non-blocking)
2. Save state_summary to .mpl/mpl/phases/phase-N/state-summary.md
3. Save verification to .mpl/mpl/phases/phase-N/verification.md
4. Update phase-decisions.md with result.new_decisions
5. Process discoveries (see Discovery Processing section)
6. Update MPL state:
   phases.completed++, phase_details[N].status = "completed"
   phase_details[N].criteria_passed, pass_rate, micro_fixes, pd_count, discoveries
   totals.total_micro_fixes += result.verification.micro_cycle_fixes
   cumulative_pass_rate = result.verification.pass_rate
   // M-5: Populate pass_rate_history for convergence detection
   convergence.pass_rate_history.push(result.verification.pass_rate)
7. Update pipeline state: current_phase = "mpl-phase-complete"
8. Profile: Record phase execution profile to .mpl/mpl/profile/phases.jsonl:
   {
     "step": "phase-{N}",
     "name": phase_name,
     "pass_rate": pass_rate,
     "micro_fixes": micro_fixes,
     "criteria_passed": "X/Y",
     "estimated_tokens": { "context": ~ctx_size, "output": ~out_size, "total": ~total },
     "retries": retry_count,
     "duration_ms": elapsed
   }
9. Report: "[MPL] Phase N/total 완료: {name}. Pass rate: {pass_rate}%. Micro-fixes: {micro_fixes}. PD {count}건."
10. **RUNBOOK Update (F-10)**: Append to `.mpl/mpl/RUNBOOK.md`:
    ```markdown
    ## Phase {N} Complete: {name}
    - **Pass Rate**: {pass_rate}%
    - **Criteria**: {criteria_passed}
    - **Micro-fixes**: {micro_fixes}
    - **PDs Created**: {pd_count}
    - **Discoveries**: {discovery_count}
    - **Timestamp**: {ISO timestamp}
    ```
11. More phases -> current_phase = "mpl-phase-running", continue 4.1
    → **Budget Check (F-33)**: Step 4.3 확장 참조 — 다음 Phase 시작 전에 세션 예산을 확인한다.
12. All done -> proceed to Step 4.5 (3-Gate Quality)

#### Step 4.3 확장: Budget Check (F-33)

Phase 완료 후 다음 Phase 시작 전에 세션 예산을 확인한다:

```python
budget = predictBudget(cwd)  # .mpl/context-usage.json 기반

if budget.recommendation == "pause_now" or budget.recommendation == "pause_after_current":
    # 현재 Phase는 완료됨 — Graceful Pause 실행
    execute_graceful_pause(budget, next_phase_id, completed_phases, remaining_phases)
    return  # 오케스트레이션 루프 종료
else:
    # 예산 충분 — 다음 Phase 계속
    current_phase = "mpl-phase-running"
    continue  # Step 4.1로 복귀
```

**Fail-open**: `context-usage.json`이 없거나 stale(>30s)이면 budget check를 건너뛰고 계속 진행한다.
```

**On `"circuit_break"`**:

```
1. Record: phase_details[N].status = "circuit_break", phases.circuit_breaks++
2. Update pipeline state: current_phase = "mpl-circuit-break"
3. **RUNBOOK Update (F-10)**: Append to `.mpl/mpl/RUNBOOK.md`:
   ## Circuit Break: Phase {N} - {name}
   - **Failure**: {failure_summary}
   - **Attempted Fixes**: {attempted_fixes list}
   - **Retries Exhausted**: 3/3
   - **Timestamp**: {ISO timestamp}
4. **Dynamic Escalation (F-21)**: Check pipeline_tier before redecomposition:
   - If pipeline_tier < "frontier":
     escalation = escalateTier(cwd, "circuit_break", { completed_phases, failed_phase })
     If escalation succeeded:
       Report: "[MPL] Escalating: {from} → {to}. Preserving completed work."
       RUNBOOK: Append "## Tier Escalation: {from} → {to}"
       Re-run Triage with new tier (reload skipped steps)
       Continue from failed phase with expanded pipeline
   - If pipeline_tier == "frontier" or escalation returns null:
     Proceed to Redecomposition (4.4)
5. Proceed to Redecomposition (4.4) if no escalation
```

### 4.3.5: Side Interview (Conditional — CRITICAL Only)

After processing phase results, check if a Side Interview is needed before the next phase.
Side Interview는 **실행 흐름을 blocking**하므로, 사전 인터뷰(Step 1)에서 충분히 해소하여 여기서의 발생을 최소화해야 한다.

Trigger conditions — **CRITICAL 기준 강화**:
1. Phase reported a **CRITICAL** discovery that **directly conflicts with a CONFIRMED PP** or makes further execution impossible
2. ~~Phase has 1+ H-items in verification_plan~~ → H-items는 best-effort 자동 검증 시도 후, **검증 불가 + PP 위반 가능성**일 때만 트리거
3. ~~AD marker was created~~ → AD marker는 로깅만 하고 **자동 진행**. PP 충돌이 있을 때만 Side Interview

Non-CRITICAL items (H-items without PP conflict, AD markers, MED/LOW discoveries) are:
- Logged to `.mpl/mpl/phases/phase-N/deferred-items.md`
- Included in finalize report for post-hoc review
- **NOT blocking** — execution continues automatically

If NO CRITICAL triggers -> skip Side Interview, proceed to next phase.

If triggered (CRITICAL only):

```
interview_role = determine_role(triggers):
  - CRITICAL discovery + PP conflict -> "Issue Resolution": present discovery and ask for resolution
  - H-item + PP violation risk -> "PP Compliance Check": present conflict for human judgment

AskUserQuestion based on interview_role:
  - Issue Resolution: "Phase {N}에서 CRITICAL discovery가 발생했습니다: {description}. PP-{M}와 충돌합니다. 어떻게 처리할까요?"
    Options: "수용 (PP 수정)" | "반려 (현재 PP 유지)" | "수정 후 계속"
  - PP Compliance: "Phase {N}의 결과가 PP-{M}을 위반할 수 있습니다: {details}"
    Options: "위반 아님 (계속)" | "위반 맞음 (수정 필요)"

Record Side Interview results in `.mpl/mpl/phases/phase-N/side-interview.md`
Report: "[MPL] Side Interview (Phase {N}): {role}. Result: {outcome}."
```

### Deferred Items (Non-Blocking)

```
// H-items, AD markers, MED/LOW discoveries → 자동 진행 + 로깅
for each non_critical_item in phase_results:
  append to `.mpl/mpl/phases/phase-N/deferred-items.md`:
    - Type: {H-item|AD|Discovery}
    - Summary: {description}
    - PP Impact: {None|PP-N (low risk)}
    - Action: Deferred to finalize review

Report: "[MPL] Phase {N}: {count} items deferred (non-critical). Continuing."
```

### 4.3.6: Session Context Persistence (F-12)

After each phase completes, persist critical state to survive context compression:

```
<remember priority>
[MPL Session State]
- Pipeline: {pipeline_id}
- Phase: {completed_phase}/{total_phases} complete
- Tier: {pipeline_tier}
- PP Summary: {top 3 PP names and status}
- Last Phase: {phase_name} — {pass/fail}, pass_rate={pass_rate}%
- Last Failure: {failure_reason or "none"}
- Next: {next_phase_name or "finalize"}
- RUNBOOK: .mpl/mpl/RUNBOOK.md
</remember>
```

This tag is emitted by the orchestrator after Step 4.3 result processing. Combined with RUNBOOK.md (file-based), this creates a dual safety net:
- `<remember priority>` — survives context compression within the session
- `RUNBOOK.md` — survives session boundaries (readable by next session)

### 4.3.7: Orchestrator Context Cleanup

After each phase completes, manage orchestrator context to prevent accumulation:

1. Ensure state_summary is saved to `.mpl/mpl/phases/phase-N/state-summary.md` (already done in 4.3)
2. Emit `<remember priority>` tag with critical state (4.3.6 above)
3. Release detailed phase data from orchestrator working memory
4. For next phase, load only:
   - Previous phase summary (from file)
   - Dependency summaries (from files, per interface_contract.requires)
   - Updated phase-decisions.md
   - Current phase definition

This ensures each phase starts with a bounded context regardless of total phase count.

### 4.4: Redecomposition (on circuit break)

```
redecompose_count = mpl_state.redecompose_count + 1

if redecompose_count > 2 (max_redecompose):
  -> pipeline: "mpl-failed", MPL: status = "failed"
  -> Report failure (preserve completed results), EXIT

else:
  mpl_state.redecompose_count = redecompose_count

  Task(subagent_type="mpl-decomposer", model="opus",
       prompt="""
       ## Redecomposition Request
       A phase failed after exhausting retries. Redecompose REMAINING work only.

       ### Completed Phases (preserve, do NOT regenerate)
       {for each completed phase: id, name, state-summary snippet}

       ### Failed Phase
       ID: {id}, Name: {name}
       Failure: {result.failure_summary}
       Attempts: {result.attempted_fixes}

       ### Original Remaining Phases (unconsumed)
       {phases not yet started}

       ### Existing Phase Decisions
       {all PDs from .mpl/mpl/phase-decisions.md}

       ### Codebase Analysis
       {codebase-analysis.json}

       Break failed phase differently or use new strategy. Output YAML only.
       """)

  After receiving new phases:
  1. Replace remaining phases (keep completed intact)
  2. Create new .mpl/mpl/phases/phase-N/ directories
  3. Update MPL state with new phase_details
  4. pipeline: current_phase = "mpl-phase-running"
  5. Resume from first new phase (back to 4.1)
```

### 4.5: 3-Gate Quality

After all phases complete, apply the 3-Gate Quality system before finalization.

#### Gate 0.5: Project-Wide Type Check (F-17)

Before running tests, perform project-level type checking:

```
diagnostics = lsp_diagnostics_directory(path=".", strategy="auto")
// strategy="auto": uses tsc when tsconfig.json exists, falls back to LSP iteration
// Standalone fallback (F-04): Bash("npx tsc --noEmit") or Bash("python -m py_compile *.py")

if diagnostics.errors > 0:
  Report: "[MPL] Type check: {errors} errors found. Entering fix loop."
  -> Enter fix loop targeting type errors before Gate 1

if diagnostics.warnings > 5:
  Report: "[MPL] Type check: {warnings} warnings. Proceeding with caution."

Report: "[MPL] Type check: clean. Proceeding to Gate 1."
```

This catches type errors before test execution, reducing fix loop iterations.

#### Gate 1: Automated Tests

Run the full test suite:
- Execute all test commands (pytest, npm test, etc.)
- pass_rate must be >= 95% to proceed to Gate 2
- If pass_rate < 95%: enter fix loop (see 4.6)

#### Gate 2: Code Review

```
Task(subagent_type="mpl-code-reviewer", model="sonnet",
     prompt="""
     ## Review Scope
     All files changed during pipeline execution.
     ### Pivot Points
     {pivot_points}
     ### Interface Contracts
     {all phase interface_contracts}
     ### Changed Files
     {list all created/modified files across all phases}

     Review all changes for the Quality Gate.
     """)
```

Verdict handling:
- PASS -> proceed to Gate 3
- NEEDS_FIXES -> enter fix loop with prioritized fix list (see 4.6)
- REJECT -> report to user, enter mpl-failed state

#### Gate 3: PP Compliance

Final validation focused on Pivot Point compliance and H-item resolution:
- Verify all CONFIRMED PPs are satisfied (no violations across all phases)
- Check PROVISIONAL PPs for drift (flag any deviations for user review)
- Present H-items requiring human judgment via AskUserQuestion
- S-items are already covered by Gate 1 (automated tests) — no duplication here

Gate 3 pass criteria: no PP violations detected + all H-items resolved.

If Gate 3 fails -> enter fix loop (see 4.6).

All 3 gates pass -> proceed to Step 5 (E2E & Finalize).
Report: `[MPL] 3-Gate Quality: Gate 1 {pass_rate}%, Gate 2 {verdict}, Gate 3 {pass/fail}.`

**RUNBOOK Update (F-10)**: Append to `.mpl/mpl/RUNBOOK.md`:
```markdown
## 3-Gate Quality Results
- **Gate 0.5 (Type Check)**: {errors} errors, {warnings} warnings
- **Gate 1 (Tests)**: {pass_rate}%
- **Gate 2 (Code Review)**: {verdict}
- **Gate 3 (PP Compliance)**: {pass/fail}
- **Overall**: {all_pass ? "PASSED" : "FAILED — entering fix loop"}
- **Timestamp**: {ISO timestamp}
```

### 4.6: Fix Loop (with Convergence Detection)

When any gate fails, enter the fix loop:

1. Analyze failure: which gate failed, what specifically failed
2. (F-16) Optionally dispatch mpl-scout for root cause exploration:
   ```
   Task(subagent_type="mpl-scout", model="haiku",
        prompt="Trace failure: {failure_description}. Find root cause in: {affected_files}")
   ```
   Use scout findings to inform fix strategy before dispatching worker.
3. Dispatch targeted fixes via mpl-worker
3. Re-run the failed gate + all subsequent gates
4. Track pass_rate in convergence history

Convergence detection after each fix attempt:

```
push pass_rate to convergence.pass_rate_history
convergence_result = checkConvergence(state)

if convergence_result.status == "stagnating":
  -> Change strategy: provide different fix approach hints to worker
  -> If still stagnating after strategy change: circuit break

if convergence_result.status == "regressing":
  -> Immediate circuit break
  -> Report: "[MPL] Fix loop regression detected. Reverting to last good state."

Record convergence_status in state: "progressing" | "stagnating" | "regressing"
```

Max fix loop iterations: controlled by max_fix_loops from config (default 10).
Exceeding max -> mpl-failed state.

### 4.6.1: Reflexion 기반 반성 (F-27)

Fix Loop 진입 시 **즉각적 수정이 아닌 구조화된 반성(Self-Reflection)**을 먼저 수행한다.
NeurIPS 2023 Reflexion + Multi-Agent Reflexion(MAR) 패턴 적용.

#### Reflection Template

Fix Loop 매 시도 전 Phase Runner에게 아래 템플릿 실행을 지시한다:

```
## Reflection — Fix Attempt {N}

### 1. 증상 (Symptom)
실패한 테스트/Gate 결과를 정확히 기술한다.
- 어떤 테스트가 실패했는가?
- 에러 메시지는?
- 예상 vs 실제 동작?

### 2. 근본 원인 (Root Cause)
증상의 원인을 추적한다.
- 코드의 어느 부분이 문제인가? (file:line)
- 왜 이 코드가 잘못되었는가?
- 이전 시도에서 이 원인을 놓친 이유는?

### 3. 최초 이탈 지점 (Divergence Point)
원래 계획(mini-plan/Phase 0)에서 어디서 벗어났는가?
- Phase 0 명세와 실제 구현의 차이?
- PP 위반 여부?
- 가정 불일치?

### 4. 수정 전략 (Fix Strategy)
- 이전과 다른 접근 방식은?
- 어떤 Phase 0 아티팩트를 재참조해야 하는가?
- 수정의 부작용(side effect) 예측?

### 5. 학습 추출 (Learning)
- 이 실패에서 추출할 패턴은?
- 패턴 분류 태그: {tag}
- 다음 실행에서 이 실패를 예방하려면?
```

#### Reflection 실행 프로토콜

```pseudocode
function fix_loop_with_reflection(phase, failures, attempt):
  # 1. Reflection 생성
  reflection = phase_runner.generate_reflection(
    template = REFLECTION_TEMPLATE,
    failures = failures,
    phase0_artifacts = load_phase0(),
    previous_reflections = load_previous_reflections(phase),
    attempt_number = attempt
  )

  # 2. Gate 2 실패 시 MAR 패턴: 코드 리뷰어 피드백 통합
  if failure_source == "gate2":
    reviewer_feedback = gate2_result.feedback
    reflection.root_cause += "\n코드 리뷰 피드백: " + reviewer_feedback

  # 3. 반성 결과 저장
  save_reflection(phase, attempt, reflection)
  # 경로: .mpl/mpl/phases/{phase_id}/reflections/attempt-{N}.md

  # 4. 패턴 분류 + procedural.jsonl 저장 (F-25 연동)
  appendProcedural(cwd, {
    timestamp: now(),
    phase: phase.id,
    tool: "reflection",
    action: reflection.fix_strategy,
    result: "pending",  # 수정 후 success/failure로 갱신
    tags: reflection.learning.tags,  # [type_mismatch, dependency_conflict, etc.]
    context: reflection.root_cause
  })

  # 5. 반성 기반 수정 실행
  fix_result = phase_runner.execute_fix(
    strategy = reflection.fix_strategy,
    phase0_refs = reflection.phase0_refs
  )

  # 6. 결과 반영
  update_procedural_result(fix_result.success ? "success" : "failure")

  return fix_result
```

#### 패턴 분류 태그 (Taxonomy)

| 태그 | 설명 | 예시 |
|------|------|------|
| `type_mismatch` | 타입 불일치 | dict vs TypedDict, string vs number |
| `dependency_conflict` | 의존성 충돌 | 버전 호환, import 순서 |
| `test_flake` | 불안정 테스트 | 타이밍, 환경 의존 |
| `api_contract_violation` | API 계약 위반 | 파라미터 순서, 반환 타입 |
| `build_failure` | 빌드 실패 | 컴파일 에러, 린트 에러 |
| `logic_error` | 로직 오류 | 조건 반전, 경계값 |
| `missing_edge_case` | 엣지 케이스 누락 | null, 빈 배열, 동시성 |
| `scope_violation` | 범위 위반 | PP/Must NOT Do 위반 |

#### Convergence Detection과의 연동

기존 Convergence Detection(improving/stagnating/regressing)에 Reflection 정보를 추가:
- **stagnating + 동일 태그 반복**: 전략 전환 강제 (같은 접근 반복 방지)
- **regressing**: 이전 Reflection의 fix_strategy를 역참조하여 되돌리기
- **improving**: 현재 전략 유지, Reflection 생략 가능

#### 이전 Reflection 참조 (누적 학습)

Fix 시도 2회차부터는 이전 Reflection을 참조하여 같은 접근 반복을 방지:
```
load_previous_reflections(phase):
  - .mpl/mpl/phases/{phase_id}/reflections/attempt-*.md 전체 로드
  - 최대 3개 (토큰 예산 ~1500)
  - 이전 실패 접근을 "하지 말아야 할 것" 목록으로 Phase Runner에 전달
```

**RUNBOOK Update (F-10)**: After each fix attempt, append to `.mpl/mpl/RUNBOOK.md`:
```markdown
## Fix Loop Iteration {N}
- **Target Gate**: {failed_gate}
- **Fix Strategy**: {strategy_description}
- **Pass Rate**: {new_pass_rate}% (delta: {delta})
- **Convergence**: {convergence_status}
- **Timestamp**: {ISO timestamp}
```

#### Reflexion 효과 측정 (관측 지표)

Reflexion의 효과는 토큰 프로파일링(phases.jsonl)에 기록되어 사후 분석한다:

```jsonl
{"phase":"phase-3","fix_loop":true,"reflexion_applied":true,"attempts":2,"result":"success","tags":["type_mismatch"],"tokens_used":4500}
```

측정 항목:
- `reflexion_applied`: true/false — Reflexion 적용 여부
- `attempts`: Fix Loop 시도 횟수
- `result`: 최종 성공/실패
- `tags`: 패턴 분류

**A/B 비교는 충분한 실행 데이터 축적 후 사후 분석으로 수행한다.**
동일 프로젝트에서 Reflexion 적용/미적용 실행의 Fix Loop 성공률, 평균 시도 횟수, 토큰 비용을 비교한다.
이는 런타임 기능이 아닌 **관측 지표(observability metric)**이다.

### 4.7: Partial Rollback on Circuit Break

When a phase ends in `circuit_break`, preserve completed work and isolate the failure:

```
on circuit_break(phase_id, failure_info):
  1. Identify safe boundary:
     - Find the last TODO with PASS status in this phase
     - All files changed by PASS TODOs are "safe"
     - All files changed by FAIL/PARTIAL TODOs are "contaminated"

  2. Rollback contaminated files:
     - For each contaminated file:
       git checkout HEAD -- {file}  (revert to pre-phase state)
     - Record rollback in state: rolled_back_files[]

  3. Preserve safe work:
     - Keep changes from PASS TODOs (they verified successfully)
     - Update state_summary to reflect partial completion
     - Mark preserved TODOs in phase state

  4. Generate recovery context for redecomposition:
     - What was completed (preserved TODO list with outputs)
     - What failed (failure_info with retry history)
     - Contaminated files that were rolled back
     - Recommendations for redecomposition strategy

  5. Report:
     "[MPL] Circuit break on phase-{N}. {safe_count}/{total_count} TODOs preserved.
      Rolled back: {rolled_back_files}. Recovery context saved."
```

The recovery context is saved to `.mpl/mpl/phases/phase-N/recovery.md` and used by the decomposer if redecomposition is triggered.

### Step 4.8: Graceful Pause Protocol (F-33)

Budget prediction이 pause를 권장할 때 실행하는 프로토콜.

**트리거 조건**:
- `predictBudget(cwd).recommendation` == `"pause_now"` (context < 10%)
- `predictBudget(cwd).recommendation` == `"pause_after_current"` (남은 Phase 예산 부족)

**프로토콜**:

```python
def execute_graceful_pause(budget, next_phase_id, completed_phases, remaining_phases):
    # 1. Handoff 신호 파일 생성
    mkdir -p ".mpl/signals/"
    handoff = {
        "version": 1,
        "pipeline_id": state.pipeline_id,
        "paused_at": now_iso(),
        "resume_from_phase": next_phase_id,
        "completed_phases": completed_phases,
        "remaining_phases": remaining_phases,
        "budget_snapshot": {
            "context_pct_used": 100 - budget.remaining_pct,
            "remaining_pct": budget.remaining_pct,
            "estimated_needed_pct": budget.estimated_needed_pct,
            "avg_tokens_per_phase": budget.avg_tokens_per_phase
        },
        "state_file": ".mpl/state.json",
        "runbook_file": ".mpl/mpl/RUNBOOK.md"
    }
    Write(".mpl/signals/session-handoff.json", JSON.stringify(handoff))

    # 2. State 업데이트
    writeState(cwd, {
        "session_status": "paused_budget",
        "pause_reason": f"Context budget insufficient: {budget.remaining_pct}% remaining, {budget.estimated_needed_pct}% needed for {len(remaining_phases)} phases",
        "resume_from_phase": next_phase_id,
        "pause_timestamp": now_iso(),
        "budget_at_pause": {
            "context_pct": budget.remaining_pct,
            "estimated_needed_pct": budget.estimated_needed_pct
        }
    })

    # 3. RUNBOOK 기록
    Append to RUNBOOK.md:
    """
    ## Session Paused — Budget Prediction (F-33)
    - **Timestamp**: {ISO}
    - **Context Used**: {100 - budget.remaining_pct}%
    - **Estimated Needed**: {budget.estimated_needed_pct}% for {len(remaining_phases)} phases
    - **Resume From**: {next_phase_id}
    - **Action**: `/mpl:mpl-resume` in new session or auto-watcher
    """

    # 4. <remember priority> 태그
    <remember priority>
    [MPL Session Paused — Budget F-33]
    Pipeline: {pipeline_id}
    Paused at: {next_phase_id}
    Completed: {len(completed_phases)}/{total} phases
    Resume: /mpl:mpl-resume
    </remember>

    # 5. 사용자 메시지
    Print:
    "[MPL] ⏸ Session pausing — context {100-budget.remaining_pct}% used, estimated {budget.estimated_needed_pct}% needed for {len(remaining_phases)} remaining phases."
    "[MPL] Resume: run `/mpl:mpl-resume` in a new session, or auto-watcher will continue."
```

**Budget Prediction 데이터 소스**:

| 데이터 | 파일 | 갱신 주기 |
|--------|------|----------|
| Context 사용률 | `.mpl/context-usage.json` | HUD ~500ms |
| Phase당 평균 토큰 | `.mpl/mpl/profile/phases.jsonl` | Phase 완료 시 |
| 전체 Phase 수 | `.mpl/mpl/decomposition.yaml` | Step 3 완료 시 |
| 완료 Phase 수 | `.mpl/state.json` | Phase 완료 시 |

**Prediction 알고리즘**:
```
remaining_pct = 100 - context_usage.pct
estimated_needed = remaining_phases × avg_tokens_per_phase × 1.15 (safety margin)
estimated_needed_pct = estimated_needed / total_context_tokens × 100

IF remaining_pct < 10%: → pause_now
IF estimated_needed_pct > remaining_pct: → pause_after_current
ELSE: → continue
```

**안전 장치**:
- `context-usage.json` 없음 또는 stale(>30s) → fail-open (계속 진행)
- Phase 0개 남음 → continue (할 일 없음)
- 히스토리 데이터 없음 → 보수적 기본값 15K tokens/phase
- Watcher 없이도 수동 `/mpl:mpl-resume`으로 이어하기 가능

---
