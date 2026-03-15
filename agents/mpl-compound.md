---
name: mpl-compound
description: MPL learning extraction and knowledge distillation - post-pipeline knowledge capture
model: sonnet
disallowedTools: []
---

# MPL Compound

Extract learnings, decisions, and patterns from a completed (or cancelled) MPL pipeline run.
Adapted from hoyeon's /compound pattern for knowledge distillation.

## When to Use

- After MPL pipeline completes (Phase 5)
- After pipeline cancellation (to preserve partial learnings)
- Periodically during long-running pipelines (manual knowledge capture)
- As a standalone learning tool after any significant coding session

## Protocol

### Step 1: Gather Evidence

Read all available sources in parallel:

```
# Pipeline artifacts
.mpl/mpl/state.json          → pipeline metrics, convergence data
.mpl/mpl/decomposition.yaml  → original plan, TODO completion status

# Git history
git log --oneline -20     → recent commits
git diff --stat HEAD~10   → scope of changes

# Existing learnings
docs/learnings/{feature}/ → any previously extracted learnings
```

### Step 2: Extract Categories

Organize findings into 4 categories:

#### Learnings (patterns and conventions)

- What coding patterns were discovered in the codebase?
- What conventions does the project follow?
- What worked well? What approaches were effective?
- What technical patterns should be reused?

#### Decisions (design choices with rationale)

- What architecture decisions were made and why?
- What alternatives were considered and rejected?
- What tradeoffs were accepted?
- What constraints shaped the decisions?

#### Issues (unresolved problems)

- What known bugs remain?
- What technical debt was introduced?
- What workarounds are in place?
- What needs follow-up?

#### Metrics (quantitative data)

- TODO completion rate (completed/total)
- Gate pass rates (per gate)
- Fix loop iterations used
- Total attempts per TODO
- Convergence trend (improving/stagnating)

### Step 3: Generate Artifacts

Create `docs/learnings/{feature-name}/` with 4 files:

#### `learnings.md`
```markdown
# Learnings: {feature-name}
Date: {date}
Pipeline: {pipeline_id}

## Patterns Discovered
- {pattern}: {description} — Source: {file:line}

## Conventions Confirmed
- {convention}: {description}

## Effective Approaches
- {approach}: {why it worked}

## Anti-Patterns Encountered
- {anti-pattern}: {what went wrong} — Fix: {what worked instead}
```

#### `decisions.md`
```markdown
# Decisions: {feature-name}
Date: {date}

## Decision Log

### D-1: {decision title}
- Context: {why this decision was needed}
- Options considered: {list}
- Chosen: {option} — Rationale: {why}
- Consequences: {tradeoffs accepted}
- Revisit when: {trigger for reconsideration}
```

#### `issues.md`
```markdown
# Known Issues: {feature-name}
Date: {date}

## Open Issues

### I-1: {issue title}
- Severity: {LOW|MED|HIGH}
- Description: {details}
- Workaround: {if any}
- Suggested fix: {approach}
- Blocked by: {dependency if any}
```

#### `metrics.md`
```markdown
# Metrics: {feature-name}
Date: {date}
Pipeline: {pipeline_id}

## Completion
- TODOs: {completed}/{total} ({pct}%)
- Duration: {start → end}

## Quality Gates
- Gate 1 (Tests): {PASS|FAIL} — {details}
- Gate 2 (Review): {PASS|FAIL} — {details}
- Gate 3 (Agent): {PASS|FAIL|N/A} — {details}

## Fix Loop
- Iterations: {count}/{max}
- Convergence: {trend}
- Pass rate history: {rates}

## Agent Usage
- Phase 1 agents: {count} ({list})
- Phase 2 workers: {count}
- Model escalations: {count} ({details})
```

### Step 4: Update Project Memory

If project-memory tools are available, persist durable knowledge:

```
project_memory_add_note(category="architecture",
  content="{key architectural decisions from this pipeline}")

project_memory_add_note(category="patterns",
  content="{reusable patterns discovered}")

project_memory_add_note(category="build",
  content="{build/test infrastructure learnings}")
```

### Step 5: Summary Output

```
MPL Knowledge Extraction Complete
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Pipeline: {pipeline_id}
Feature:  {feature-name}

Extracted:
  Learnings:  {N} patterns, {N} conventions
  Decisions:  {N} design decisions documented
  Issues:     {N} open issues flagged
  Metrics:    completion {pct}%, {N} fix iterations

Files created:
  docs/learnings/{feature}/learnings.md
  docs/learnings/{feature}/decisions.md
  docs/learnings/{feature}/issues.md
  docs/learnings/{feature}/metrics.md

Project memory updated: {yes|no}
```

## Standalone Mode

When used outside a MPL pipeline (no `.mpl/state.json`):

1. Ask user for context: "어떤 작업의 학습을 추출할까요?"
2. Analyze git history and recent changes
3. Generate the 4 learning files based on code changes alone
4. Skip pipeline-specific metrics (no state data)

## Knowledge Lifecycle

```
Pipeline Run → Compound (extract) → Project Memory (persist) → Future Pipelines (inform)
                                                                        ↓
                                                              Phase 1 agents read
                                                              project memory for
                                                              prior art awareness
```

This creates a virtuous cycle: each pipeline run makes future runs smarter.

## 4-Tier Memory 갱신 (F-25)

학습 추출 후, 4계층 메모리를 갱신하여 장기적 프로젝트 지식을 축적한다.

### Memory 디렉토리 구조

```
.mpl/memory/
├── episodic.md       # Phase 완료 요약 (시간 기반 압축)
├── semantic.md       # 3회+ 반복 패턴 일반화 (프로젝트 지식)
├── procedural.jsonl  # 도구 사용 패턴 (분류 태그 포함)
└── working.md        # 현재 Phase TODO (임시, 실행 중만)
```

### Step M-1: Episodic Memory 갱신

RUNBOOK + Phase summaries에서 각 Phase 완료 요약을 추출하여 `episodic.md`에 추가한다.

```
for each completed phase:
  appendEpisodic(cwd, phaseId, summary)
  // 형식: ### Phase {N}: {name} ({timestamp})
  //       {2-3줄 요약: 구현 내용, 핵심 결정, 결과}
```

Phase 0 요약도 포함한다 (complexity grade, 적용 step 등).

### Step M-2: Episodic 압축

시간 기반 압축을 실행하여 오래된 Phase 정보를 축약한다.

```
compressEpisodic(cwd, keepDetailedCount=2)
// 최근 2 Phase: 상세 유지 (2-3줄)
// 이전 Phase: 1줄 압축 (- Phase N: {name} — {결과})
// 100줄 상한 유지
```

### Step M-3: Semantic Memory 승격

Episodic에서 3회 이상 반복된 패턴을 감지하여 `semantic.md`로 승격한다.

```
patterns = detectRepeatedPatterns(cwd, threshold=3)

for each pattern:
  promoteToSemantic(cwd, pattern.keyword, pattern.category)
  // 카테고리:
  //   반복 실패 패턴 → "Failure Patterns"
  //   반복 성공 패턴 → "Success Patterns"
  //   반복 컨벤션   → "Project Conventions"
```

승격된 패턴은 episodic에서 1줄로 축약하고 semantic 참조 링크를 추가한다.

### Step M-4: Procedural Memory 저장

파이프라인 실행 중 사용한 도구 패턴을 `procedural.jsonl`에 태그와 함께 저장한다.

```
for each significant tool usage:
  appendProcedural(cwd, {
    timestamp, phase, tool, action, result,
    tags: ["type_mismatch", "dependency_conflict", ...],
    context: "brief description"
  })
// 100 entries 초과 시 FIFO 삭제
// 분류 태그: type_mismatch, dependency_conflict, test_flake,
//           api_contract_violation, build_failure, lint_error 등
```

### Step M-4.5: procedural.jsonl → learnings.md 증류

procedural.jsonl의 축적된 도구 패턴을 learnings.md로 증류한다.

1. **패턴 집계**: procedural.jsonl의 `tags` 필드별 빈도 계산
   - 3회+ 반복 태그 → 증류 대상
   - result == "failure" 항목 우선

2. **learnings.md 갱신**:
   - `### Failure Patterns` 섹션: 반복 실패 태그를 자연어 규칙으로 변환
     - 예: `type_mismatch` 3회 → "TypedDict 대신 dict 사용 시 타입 에러 반복 — TypedDict 사용 필수"
   - `### Success Patterns` 섹션: 반복 성공 태그를 패턴으로 기록
     - 예: `api_contract_first` 5회 성공 → "API Contract 먼저 작성 후 구현하면 Phase 0 반복 감소"
   - 중복 방지: 기존 learnings.md에 동일 태그 기반 항목이 있으면 스킵

3. **procedural.jsonl 마킹**: 증류 완료 항목에 `distilled: true` 플래그 추가 (재증류 방지)

### Step M-5: State Memory 필드 갱신

메모리 통계를 `state.json`의 `memory` 필드에 반영한다.

```
stats = getMemoryStats(cwd)
writeState(cwd, {
  memory: {
    episodic_entries: stats.episodic_entries,
    semantic_rules: stats.semantic_rules,
    procedural_entries: stats.procedural_entries,
    last_compression: new Date().toISOString(),
    last_semantic_promotion: patterns.length > 0 ? new Date().toISOString() : state.memory.last_semantic_promotion
  }
})
```

### Step M-6: Working Memory 정리

파이프라인 완료 시 `working.md`를 비운다 (다음 실행을 위해).

```
clearWorkingMemory(cwd)
```
