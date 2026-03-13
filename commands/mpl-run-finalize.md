---
description: MPL Finalize Protocol - E2E, Learnings, Commits, Resume, Discovery Processing
---

# MPL Finalize: Steps 5 through 6

This file contains Steps 5 (E2E & Finalize), Step 6 (Resume Protocol), Discovery Processing, and Related Skills.
Load this when `current_phase` is `mpl-finalize` or when resuming a session.

---

## Step 5: E2E & Finalize

### 5.0: E2E Test (Final)

After 3-Gate Quality passes, run final E2E validation:
- Execute Verification Planner's S-items designated as E2E scenarios
- If Docker available: run in container. Otherwise: local E2E.
- Execute remaining H-items via final Side Interview (if any unconsumed H-items remain)
- Report: `[MPL] E2E Test: {passed}/{total} scenarios passed.`

### 5.0.5: AD Final Verification

Before knowledge extraction, verify all AD (After Decision) markers:
- Check each AD has: interface definition + minimal implementation
- Incomplete ADs: report to user (awareness, not blocking)
- Report: `[MPL] AD Verification: {complete}/{total} ADs verified.`

### 5.1: Final Verification

Run ALL success_criteria from ALL completed phases. If project has build/test commands:
```
Bash("npm run build")
Bash("npm test")
```

### 5.2: Extract Learnings

Reuse `mpl-compound` skill:
```
Task(subagent_type="mpl-compound", model="sonnet",
     prompt="Extract learnings from MPL session.
     Phase summaries: {all state-summary.md contents}
     Phase decisions: {all PDs}
     Discoveries: {all discoveries}")
```
Save to `docs/learnings/{feature}/`: learnings.md, decisions.md, issues.md, metrics.md

### 5.2.5: Run-to-Run Learning Distillation (F-11)

Distill RUNBOOK decisions/issues into persistent learnings for future runs:

```
runbook = Read(".mpl/mpl/RUNBOOK.md")
existing_learnings = Read(".mpl/memory/learnings.md") or ""

Task(subagent_type="mpl-compound", model="sonnet",
     prompt="""
     Distill execution learnings into the persistent memory file.

     ## RUNBOOK (current run)
     {runbook}

     ## Phase Summaries
     {all state-summary.md contents}

     ## Existing Learnings (append, do not duplicate)
     {existing_learnings}

     ## Output Format
     Append NEW entries only to the existing file. Use this structure:

     ### Failure Patterns
     - [{date}] {pattern description} — {resolution}

     ### Success Patterns
     - [{date}] {what worked and why}

     ### Project Conventions (discovered)
     - {convention discovered during execution}

     Rules:
     1. Do NOT duplicate entries already in existing learnings
     2. Only record patterns that would help FUTURE runs
     3. Skip session-specific details (file paths, variable names)
     4. Focus on generalizable lessons (type mismatches, API patterns, test strategies)
     """)

Save output to `.mpl/memory/learnings.md`
Ensure .mpl/memory/ directory exists.
Report: "[MPL] Learnings distilled: {new_entries} new patterns added to memory."
```

### 5.2.6: 4-Tier Memory 갱신 (F-25)

mpl-compound의 4-Tier Memory 프로토콜을 실행한다:

1. **episodic.md 갱신**: 각 완료 Phase의 요약을 episodic.md에 추가
   - 형식: `### Phase {N}: {name} ({timestamp})\n{2-3줄 요약: 구현 내용, 핵심 결정, 결과}`
   - Phase 0 요약도 포함 (complexity grade, 적용 step 등)

2. **episodic 압축**: 시간 기반 압축 실행
   - 최근 2 Phase: 상세 유지 (2-3줄)
   - 이전 Phase: 1줄 압축 (`- Phase N: {name} — {결과}`)
   - 100줄 상한 유지

3. **semantic.md 승격**: episodic에서 3회+ 반복 패턴 감지 → 일반화
   - 반복 실패 패턴 → "## Failure Patterns" 섹션에 규칙화
   - 반복 성공 패턴 → "## Success Patterns" 섹션에 규칙화
   - 반복 컨벤션 → "## Project Conventions" 섹션에 규칙화
   - episodic의 해당 항목은 1줄로 축약 + semantic 참조 링크

4. **procedural.jsonl 정리**: mpl-compound가 추출한 도구 패턴 저장
   - 분류 태그: type_mismatch, dependency_conflict, test_flake, api_contract_violation 등
   - 100 entries 초과 시 가장 오래된 항목부터 삭제 (FIFO)

5. **state.json memory 필드 갱신**: 메모리 통계 업데이트

```
Task(subagent_type="mpl-compound", model="sonnet",
     prompt="Execute 4-Tier Memory protocol (F-25).
     Phase summaries: {all state-summary.md contents}
     RUNBOOK: {runbook contents}
     Follow Steps M-1 through M-5 from the mpl-compound protocol.")

Report: "[MPL] 4-Tier Memory updated: episodic={N} entries, semantic={N} rules, procedural={N} entries."
```

### 5.2.7: working.md 정리

파이프라인 완료 시 working.md를 비운다 (다음 실행을 위해).

```
clearWorkingMemory(cwd)
Report: "[MPL] Working memory cleared."
```

### Step 5.2.8: Good/Bad Examples 아카이브 분류 (F-26)

파이프라인 완료 시 mpl-interviewer v2가 생성한 요구사항 문서의 효과를 평가하고 아카이브한다.

#### 분류 기준

| 지표 | Good Example | Bad Example |
|------|-------------|------------|
| Phase 0 반복 횟수 | 0-1 | 3+ |
| 재분해 횟수 | 0 | 1+ |
| Gate 통과율 | 95%+ (1회) | 2회 이상 시도 |
| 사용자 수정 요청 | 0 | 2+ |

#### 프로토콜

```pseudocode
if exists(".mpl/pm/requirements-*.md"):
  metrics = {
    phase0_iterations: state.phase0_retry_count or 0,
    redecompose_count: state.redecompose_count or 0,
    gate_attempts: count_gate_retries(state),
    user_corrections: count_side_interview_corrections(state)
  }

  score = (metrics.phase0_iterations <= 1) + (metrics.redecompose_count == 0) + (metrics.gate_attempts <= 1) + (metrics.user_corrections == 0)

  if score >= 3:
    copy requirements to ".mpl/pm/good-examples/{date}-{topic}.md"
  elif score <= 1:
    copy requirements to ".mpl/pm/bad-examples/{date}-{topic}.md"
  # score 2: 중간 — 아카이브하지 않음
```

오케스트레이터가 Step 5 Finalize에서 직접 수행한다 (별도 에이전트 불필요).

**F-25 Memory 연동:**
아카이브 분류 후 procedural.jsonl에 품질 신호를 기록한다:
- Good → `appendProcedural(cwd, { tool: "mpl-interviewer", result: "success", tags: ["prd_quality_good", depth], context: filename })`
- Bad → `appendProcedural(cwd, { tool: "mpl-interviewer", result: "failure", tags: ["prd_quality_bad", depth, reason], context: filename })`
이를 통해 향후 실행에서 interviewer가 이전 PRD 품질 패턴을 참조할 수 있다.

### 5.3: Atomic Commits

Reuse `mpl-git-master`:
```
Task(subagent_type="mpl-git-master", model="sonnet",
     prompt="Create atomic commits for all changes. Detect project commit style. 3+ files -> 2+ commits.")
```

### 5.4: Metrics

Save to `.mpl/mpl/metrics.json`:
```json
{
  "phases_completed": 4, "phases_failed": 0,
  "total_retries": 2, "total_micro_fixes": 3, "redecompositions": 0,
  "total_discoveries": 3, "total_pd_count": 8, "total_pd_overrides": 1,
  "final_pass_rate": 100, "phase5_skipped": true,
  "phase0_cache_hit": false,
  "phase0_grade": "Complex",
  "phase0_artifacts_validated": "3/3",
  "token_profile": {
    "phase0": 12000,
    "phases": [10000, 12000, 8000, 5000],
    "phase5_gate": 500,
    "finalize": 2000,
    "total_estimated": 49500
  },
  "elapsed_ms": 720000, "final_verification": "all_pass",
  "side_interviews": { "count": 0, "phases": [] },
  "convergence_triggers": { "stagnation": 0, "regression": 0 },
  "gap_analysis": { "missing_requirements": 0, "pitfalls": 0, "constraints": 0 },
  "tradeoff_analysis": { "aggregate_risk": "LOW", "irreversible_count": 0 },
  "critic_assessment": "READY",
  "three_gate_results": {
    "gate1_pass_rate": 100,
    "gate2_verdict": "PASS",
    "gate3_pass": true
  },
  "verification_plan": { "a_items": 0, "s_items": 0, "h_items": 0 },
  "triage": { "interview_depth": "full", "prompt_density": 3 }
}
```

Generate full run profile at `.mpl/mpl/profile/run-summary.json`:
```json
{
  "run_id": "mpl-{timestamp}",
  "complexity": { "grade": "Complex", "score": 85 },
  "cache": { "phase0_hit": false, "saved_tokens": 0 },
  "phases": [
    { "id": "phase0", "tokens": 12000, "duration_ms": 15000, "cache_hit": false },
    { "id": "phase-1", "tokens": 10000, "duration_ms": 45000, "pass_rate": 100, "micro_fixes": 0 },
    { "id": "phase-2", "tokens": 12000, "duration_ms": 60000, "pass_rate": 100, "micro_fixes": 1 },
    { "id": "phase-3", "tokens": 8000, "duration_ms": 40000, "pass_rate": 100, "micro_fixes": 0 },
    { "id": "phase-4", "tokens": 5000, "duration_ms": 30000, "pass_rate": 100, "micro_fixes": 0 }
  ],
  "phase5_gate": { "final_pass_rate": 100, "decision": "skip", "fix_tokens": 0 },
  "totals": { "tokens": 49500, "duration_ms": 210000, "micro_fixes": 1, "retries": 0 }
}
```

Profile data enables:
1. **복잡도별 최적 토큰 예산 학습**: 과거 프로파일에서 등급별 평균 토큰 산출
2. **Phase 0 Step 조합 최적화**: 어떤 Step 조합이 가장 효율적인지 통계
3. **비정상 실행 탐지**: 토큰 과다 사용(평균의 2x 이상), 과도한 마이크로 수정(5회+) 경고

### 5.5: Completion Report

Summarize: phases completed/failed, retries, redecompositions, key discoveries/PD overrides, verification status, key learnings.

### 5.6: RUNBOOK Finalize (F-10)

Append final section to `.mpl/mpl/RUNBOOK.md`:
```markdown
## Pipeline Complete
- **Status**: {completed | partial}
- **Phases**: {completed}/{total}
- **Final Pass Rate**: {pass_rate}%
- **Total Retries**: {total_retries}
- **Total Micro-fixes**: {total_micro_fixes}
- **Redecompositions**: {redecompose_count}
- **Elapsed**: {elapsed_ms}ms
- **Pipeline Tier**: {pipeline_tier}
- **Escalations**: {escalation_count}
- **Completed At**: {ISO timestamp}
```

### 5.6.5: Routing Pattern Recording (F-22)

Record execution result to `.mpl/memory/routing-patterns.jsonl` for future tier prediction:

```
state = Read(".mpl/state.json")
mpl_state = Read(".mpl/mpl/state.json")

pattern = {
  description: state.task or user_request (first 100 chars, summarized),
  tier: state.pipeline_tier,
  escalated_from: state.escalation_history.length > 0
    ? state.escalation_history[0].from
    : null,
  result: mpl_state.status,  // "completed" | "partial" | "failed"
  tokens: mpl_state.totals.total_tokens or profile.totals.tokens,
  files: count of all created/modified files across phases
}

appendPattern(cwd, pattern)
// Uses hooks/lib/mpl-routing-patterns.mjs

Report: "[MPL] Routing pattern recorded: tier={tier}, result={result}, tokens={tokens}."
```

### 5.7: Update State

Pipeline `current_phase = "completed"`, MPL `status = "completed"`, `completed_at = timestamp`.

---

## Step 6: Resume Protocol

MPL naturally supports resume via per-phase state persistence.

```
On session start:
  if .mpl/state.json has run_mode == "mpl":
    mplState = Read .mpl/mpl/state.json
    nextPhase = first phase with status != "completed"

    # F-10: Load RUNBOOK for session continuity
    if exists(".mpl/mpl/RUNBOOK.md"):
      runbook = Read(".mpl/mpl/RUNBOOK.md")
      // RUNBOOK provides: current status, milestones, decisions, issues
      // Use as primary context for understanding pipeline state

    if all completed -> Step 5 (Finalize) if not done
    else:
      Report: "[MPL] Resuming: {completed}/{total} done. Next: {nextPhase.name}"
      Load: RUNBOOK.md + phase-decisions.md + last state-summary.md
      Continue from Step 4.1 for nextPhase
```

#### F-33: Budget Pause Resume

```python
if state.session_status == "paused_budget":
    print(f"[MPL] Resuming from budget pause (paused at {state.pause_timestamp})")
    print(f"[MPL] Previous session: context {state.budget_at_pause.context_pct}% remaining")

    # Clear pause state
    writeState(cwd, {
        "session_status": "active",
        "pause_reason": None,
        "pause_timestamp": None,
        "budget_at_pause": None
        # resume_from_phase는 유지 — Step 6의 기존 로직이 사용
    })

    # Handoff 신호 정리
    rm -f ".mpl/signals/session-handoff.json"

    # 기존 Resume 로직으로 진행 (resume_from_phase 기반)
```

이 처리는 기존 Resume 로직 **이전**에 실행되며, `session_status`를 정리한 후 기존 Phase 복원 로직이 `resume_from_phase`를 사용하여 정상 이어하기를 수행한다.

| Data | Source |
|------|--------|
| Completed results | `.mpl/mpl/phases/phase-N/state-summary.md` |
| Accumulated PDs | `.mpl/mpl/phase-decisions.md` |
| Phase definitions | `.mpl/mpl/decomposition.yaml` |
| Progress | `.mpl/mpl/state.json` |
| Pivot Points | `.mpl/pivot-points.md` |

---

## Discovery Processing

When Phase Runner reports discoveries, Orchestrator processes them:

```
for each discovery in result.discoveries:

  # 1. PP Conflict Check
  if discovery.pp_conflict:
    pp = find_pp(discovery.pp_conflict)

    if pp.status == "CONFIRMED":
      -> Automatic rejection (hard constraint)
      -> Record in .mpl/discoveries.md with reason

    elif pp.status == "PROVISIONAL":
      -> Handle by maturity_mode:
         explore:  Auto-approve + record
         standard: HITL:
           AskUserQuestion: "Discovery D-{N}이 PP-{M}과 충돌합니다."
           Options: "반려" | "수용" | "보류"
           Timeout: 30s -> Auto-select "보류"
         strict: HITL (same options, no auto-timeout)

  # 2. PD Override Check
  elif discovery.pd_override:
    explore:  Auto-approve + record PD-override
    standard: HITL judgment
    strict:   HITL judgment + impact analysis

  # 3. General Discovery (no conflict)
  else:
    explore:  Immediately reflect in next phase context
    standard: Review at phase transition
    strict:   Backlog for next cycle

  # 4. Record
  Append to .mpl/discoveries.md:
    "D-{N} (Phase {current}): {description} [status: approved/rejected/pending]"
```

---

## Related Skills

| Skill | Purpose |
|-------|---------|
| `/mpl:mpl` | Micro-Phase Loop pipeline — single entry point with auto tier routing (F-20) |
| `/mpl:mpl-small` | **Deprecated** — use `/mpl:mpl` (auto-routes to standard tier) |
| `/mpl:mpl-pivot` | Pivot Points interview |
| `/mpl:mpl-status` | Pipeline status dashboard |
| `/mpl:mpl-cancel` | Clean cancellation |
| `/mpl:mpl-resume` | Resume from last phase |
| `/mpl:mpl-bugfix` | **Deprecated** — use `/mpl:mpl` (auto-routes to frugal tier) |
| `/mpl:mpl-compound` | Learning extraction |
| `/mpl:mpl-doctor` | Installation diagnostics |
| `/mpl:mpl-setup` | Setup wizard |
| `/mpl:mpl-gap-analysis` | Gap analysis for missing requirements |

> **Note (F-20)**: `mpl-small` and `mpl-bugfix` are deprecated. The `/mpl:mpl` skill now auto-detects
> pipeline tier (frugal/standard/frontier) via Quick Scope Scan. Use keyword hints for manual override:
> `"mpl bugfix"` → frugal, `"mpl small"` → standard.
