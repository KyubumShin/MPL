---
description: MPL Step 5.0.4 Automated E2E Recovery Loop protocol (progressive disclosure reference)
---

# E2E Auto-Recovery Loop Protocol

**Loaded by**: `commands/mpl-run-finalize.md` Step 5.0.4 when `failures[]` is non-empty after Step 5.0.
**Exit**: recovery succeeded → return to Step 5.1 · OR circuit breaker halts → HITL fallback.

The protocol below was inlined in finalize.md before v0.17 WS-3A (#67) and now lives here to keep the finalize.md core lean (~780L) while preserving the full recovery spec for the cases that need it.

---


Triggered from Step 5.0 step 2 when `failures[]` is non-empty. This step
replaces the old "fail → HITL 3 options" path. HITL still runs, but only
as the fallback when the circuit breaker halts recovery.

**Pre-check — Tier C UC coverage** (fast fail before spending an LLM call):

```
contract = Read(".mpl/requirements/user-contract.md")
included_ucs = parseIncluded(contract)
covered = union(scenarios[*].covers)
missing = included_ucs - covered

if missing.size > 0:
  announce: "[MPL 0.16 Tier C] {missing.size} UC(s) not covered by any scenario: {missing}. " +
            "Diagnostician WILL NOT be called — fix the contract first."
  → fall through to HITL (existing 3-option AskUserQuestion).
```

**Recovery loop** (when UC coverage is complete):

```
state.e2e_recovery.iter default 0
state.e2e_recovery.max_iter default 2

while state.e2e_recovery.iter < state.e2e_recovery.max_iter AND failures not empty:
  # 1. Prepare diagnostic context
  trace_excerpt = ""
  for fid in failures:
    tp = state.e2e_results[fid].trace_path
    if tp and File.exists(tp):
      trace_excerpt += "\n[" + fid + "]\n" + Bash("head -c 2000 " + tp)
    else:
      trace_excerpt += "\n[" + fid + "] (no trace)\n" + state.e2e_results[fid].stderr_tail or ""

  # 2. Call the MCP tool (opus, session auth, PROMPT_VERSION frozen)
  diag = mpl_diagnose_e2e_failure({
    cwd,
    scenarios: Read(".mpl/mpl/e2e-scenarios.yaml"),
    e2e_results: JSON.stringify(state.e2e_results),
    trace_excerpt: trace_excerpt.slice(0, 4000),
    user_contract: Read(".mpl/requirements/user-contract.md"),
    decomposition: Read(".mpl/mpl/decomposition.yaml"),
    prev_iter: state.e2e_recovery.iter,
  })

  # 3. Persist diagnosis (Q9: resume reads this inline)
  mpl_state_write({
    e2e_recovery: {
      iter: state.e2e_recovery.iter + diag.iter_hint,
      max_iter: state.e2e_recovery.max_iter,
      last_classification: diag.classification,
      last_diagnosis: diag,
    }
  })

  announce: "[MPL 0.16 S3] Diagnosis iter {iter+1}/{max}: classification={diag.classification} " +
            "confidence={diag.confidence} — {diag.root_cause}"

  # 4. Dispatch fix per classification
  switch diag.classification:
    case "A":   # spec gap → decomposer appends phases
      Task(subagent_type="mpl-decomposer", prompt=`
        APPEND-MODE: existing decomposition.yaml remains; append the phases
        below without modifying existing phase ids. Each appended phase MUST
        include covers:[UC-N] per 0.16 Tier B and test_agent_required:true.

        Append hints (from mpl_diagnose_e2e_failure):
        ${JSON.stringify(diag.append_phases, null, 2)}

        After appending, re-emit the full decomposition.yaml.
      `)
      # After decomposer completes, re-enter Phase Execution for the new
      # phases (mpl-run-execute.md Step 4), then return here.

    case "B":   # test bug → test-agent rewrites the test
      Task(subagent_type="mpl-test-agent", prompt=`
        The following E2E scenario failed; the diagnostician believes the TEST
        is wrong, not the implementation. Review and fix the test.

        Scenario: ${failures[0]}
        Root cause: ${diag.root_cause}
        Fix strategy: ${diag.fix_strategy}
        Trace excerpt: ${diag.trace_excerpt}
      `)

    case "C":   # missing capability → Phase 0 Step 1.5 minimal re-run
      announce: "[MPL 0.16 S3] Classification C — missing UC detected. " +
                "Returning to Phase 0 Step 1.5 (minimal mode) to append the UC."
      mpl_state_write({ current_phase: "mpl-init", user_contract_set: false })
      # orchestrator re-enters Phase 0 Step 1.5 inline loop; on completion
      # it must preserve existing UCs (prev_contract) and only add the missing
      # one. After Step 1.5 convergence, re-enter Phase Execution for any new
      # phases spawned by the new UC, then return here.

    case "D":   # flake → single rerun with trace on
      announce: "[MPL 0.16 S3] Classification D — flake. Rerunning with trace on."
      for fid in failures:
        Bash("<scenario test_command for fid> --trace on")  # see Step 5.6 (S3-6)

  # 5. Re-run originally failing scenarios to see if fix worked
  new_failures = []
  for fid in failures:
    Bash(state.e2e_results[fid].test_command)  # gate-recorder updates results
    if state.e2e_results[fid].exit_code != 0:
      new_failures.append(fid)
  failures = new_failures

# loop exit: either failures empty (success) or iter >= max_iter
```

**Circuit breaker (iter >= max_iter, failures remain)**:

```
mpl_state_write({
  e2e_recovery: { ...state.e2e_recovery, halted: true, halt_reason: "e2e_circuit_breaker" }
})

announce: "[MPL 0.16 S3] Circuit breaker: recovery iter={max_iter} reached, " +
          "{failures.size} scenario(s) still failing. Entering HITL."

# Fall through to the original 3-option AskUserQuestion (재시도 / Override 추가 /
# 파이프라인 실패 처리) — now informed by state.e2e_recovery.last_diagnosis so
# the user sees the diagnostician's verdict alongside the options.
AskUserQuestion(
  question: "E2E 자동복구 실패 (iter={state.e2e_recovery.iter}/{state.e2e_recovery.max_iter}). " +
            "마지막 진단: {state.e2e_recovery.last_diagnosis.classification} — " +
            "{state.e2e_recovery.last_diagnosis.root_cause}. 어떻게 할까요?",
  header: "E2E 자동복구 실패",
  options: [ /* same 3 options as original Step 5.0 */ ]
)
```

**Resume behavior (Q9)**: when `/mpl:mpl resume` re-enters after a halt,
`mpl-run-finalize-resume.md` reads `state.e2e_recovery.last_diagnosis`
directly from state.json and inlines the summary into the orchestrator
prompt. No MCP round-trip.

**Exp12 measurement**: every diagnostician call increments
`state.e2e_recovery.iter` by `iter_hint`; the pipeline summary writes
`{classification, confidence, iter}` into `.mpl/metrics/e2e-recovery.jsonl`
for Stage 4 data-driven promotion analysis.

### 5.0.5: AD Final Verification

Before knowledge extraction, verify all AD (After Decision) markers:
- Check each AD has: interface definition + minimal implementation
- Incomplete ADs: report to user (awareness, not blocking)
- Report: `[MPL] AD Verification: {complete}/{total} ADs verified.`

