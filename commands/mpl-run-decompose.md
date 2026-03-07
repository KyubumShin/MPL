---
description: MPL Decomposition Protocol - Phase Decomposition, Verification Planning (Critic absorbed into Decomposer)
---

# MPL Decomposition: Steps 3 through 3-C

This file contains Steps 3, 3-B, and 3-C of the MPL orchestration protocol.
Load this when transitioning from pre-execution analysis to phase decomposition.

---

## Step 3: Phase Decomposition

```
Task(subagent_type="mpl-decomposer", model="opus",
     prompt="""
     You are the Phase Decomposer for MPL.
     Break the user request into ordered micro-phases.

     ## Input
     ### User Request
     {user_request}
     ### Pivot Points
     {pivot_points content from .mpl/pivot-points.md}
     ### Maturity Mode
     {maturity_mode}
     ### Codebase Analysis
     {codebase_analysis JSON from .mpl/mpl/codebase-analysis.json}

     ### Phase 0 Enhanced Artifacts
     #### Complexity
     {complexity_report from .mpl/mpl/phase0/complexity-report.json}
     #### Phase 0 Summary
     {phase0_summary from .mpl/mpl/phase0/summary.md}
     #### Detailed Artifacts (if generated)
     {api_contracts from .mpl/mpl/phase0/api-contracts.md — if exists}
     {examples from .mpl/mpl/phase0/examples.md — if exists}
     {type_policy from .mpl/mpl/phase0/type-policy.md — if exists}
     {error_spec from .mpl/mpl/phase0/error-spec.md — always exists}

     ### Pre-Execution Analysis (Gap + Tradeoff)
     {pre_execution_analysis from .mpl/mpl/pre-execution-analysis.md}

     ## Task
     Break the user request into ordered phases. Use Phase 0 artifacts to inform decomposition decisions — they contain pre-analyzed API contracts, usage patterns, type policies, and error specifications. Use the Pre-Execution Analysis's Recommended Execution Order (section 7) to guide phase ordering, and its Gap Analysis (sections 1-4) to catch missing requirements. Output YAML only.
     Each phase: id, name, scope, impact (create/modify/affected_tests/affected_config),
     interface_contract (requires/produces), success_criteria (typed: command/test/file_exists/grep/description),
     estimated_complexity (S/M/L).
     Also: architecture_anchor (tech_stack, directory_pattern, naming_convention), shared_resources.
     """)
```

### After Receiving Output

1. Parse YAML, validate phase count vs maturity mode sizing
2. Save to `.mpl/mpl/decomposition.yaml`
3. Initialize `.mpl/mpl/phase-decisions.md` with empty Active/Summary/Archived sections
4. Create `.mpl/mpl/phases/phase-N/` directories for each phase
5. Update MPL state with `phase_details` (all phases as `"pending"`)
6. Update pipeline state: `current_phase: "mpl-phase-running"`
7. Process `risk_assessment` from decomposer output:
   - If `go_no_go == "NOT_READY"`:
     AskUserQuestion: "Decomposer가 NOT_READY 판정. HIGH 리스크: {risks}."
     Options: "재분해 (다른 전략)" | "위험 감수하고 진행" | "취소"
     - "재분해": return to Step 3 with risk feedback
     - "진행": proceed with caveats logged
     - "취소": mpl-failed
   - If `go_no_go == "READY_WITH_CAVEATS"`:
     Report HIGH risks to user (informational, non-blocking)
   - Save risk_assessment to `.mpl/mpl/risk-assessment.md`
8. Report: `"[MPL] Decomposition: N phases generated. Risk: {go_no_go}. Phase 1: {name}"`

---

## Step 3-B: Verification Planning

After decomposition, create per-phase verification plans with A/S/H-item classification.

```
Task(subagent_type="mpl-verification-planner", model="sonnet",
     prompt="""
     ## Input
     ### Phase Decomposition
     {decomposition YAML from .mpl/mpl/decomposition.yaml}
     ### Pivot Points
     {pivot_points}
     ### Codebase Analysis
     {codebase_analysis}
     ### Gap Analysis
     {gap_analysis}

     Classify all criteria into A/S/H items per phase.
     """)
```

### After Receiving Output
1. Validate 6 required sections via validate-output hook
2. Parse A/S/H items and attach to each phase_definition as `verification_plan` field
3. Save full plan to `.mpl/mpl/verification-plan.md`
4. Note phases with H-items (these will trigger Side Interviews during execution)
5. Report: `[MPL] Verification Plan: {A_count} A-items, {S_count} S-items, {H_count} H-items across {phase_count} phases.`

---

> **Note**: Step 3-C (Critic Simulation) has been absorbed into the Decomposer's `risk_assessment` output section (Step 3). The Decomposer now performs pre-mortem analysis as part of its reasoning (Step 9), eliminating a separate opus agent call. Risk handling is done in Step 3's post-processing (item 7).

---
