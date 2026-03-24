---
description: MPL Decomposition Protocol - Phase Decomposition, Verification Planning (Critic absorbed into Decomposer)
---

# MPL Decomposition: Steps 3, 3-F, and 3-B

This file contains Steps 3, 3-F, and 3-B of the MPL orchestration protocol.
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
     Break the user request into ordered phases that cover the ENTIRE scope of the request.
     CRITICAL: Do NOT scope down. Every feature, requirement, and component in the user's spec must be covered by at least one phase. If the spec describes 10 features, all 10 must appear in the decomposition. Create as many phases as needed — there is no hard cap on phase count.

     Use Phase 0 artifacts to inform decomposition decisions — they contain pre-analyzed API contracts, usage patterns, type policies, and error specifications. Use the Pre-Execution Analysis's Recommended Execution Order (section 7) to guide phase ordering, and its Gap Analysis (sections 1-4) to catch missing requirements. Output YAML only.
     Each phase: id, name, phase_domain (F-28: db|api|ui|algorithm|test|ai|infra|general),
     phase_subdomain (F-39, optional: tech-stack e.g. react, prisma, langchain),
     phase_task_type (F-39, optional: greenfield|refactor|migration|bugfix|performance|security),
     phase_lang (F-39, optional: rust|go|python|typescript|java),
     scope, impact (create/modify/affected_tests/affected_config),
     interface_contract (requires/produces), success_criteria (typed: command/test/file_exists/grep/qmd_verified/description),
     estimated_complexity (S/M/L).
     Also: architecture_anchor (tech_stack, directory_pattern, naming_convention), shared_resources.
     """)
```

### Step 3 Extension: phase_domain Tag Assignment (F-28)

The Decomposer automatically assigns `phase_domain` tags to each Phase during decomposition.

#### Protocol

After generating decomposition.yaml:
1. Primary classification based on directory/extension from each Phase's `scope` file list
2. Secondary correction via semantic analysis of Phase `name` and `success_criteria`
3. Add `phase_domain` field to decomposition.yaml

#### Example

```yaml
phases:
  - id: phase-1
    name: "User Model + Migration"
    phase_domain: db
    scope: [src/models/user.py, migrations/001_create_user.py]
    ...
  - id: phase-2
    name: "Registration API Endpoint"
    phase_domain: api
    scope: [src/routes/auth.py, src/controllers/signup.py]
    ...
  - id: phase-3
    name: "Password Hashing Utility"
    phase_domain: algorithm
    scope: [src/utils/crypto.py]
    complexity: M
    ...
```

#### Decomposer Prompt Extension

Add the following instructions to the mpl-decomposer agent:
> Assign a `phase_domain` tag to each Phase. Possible values: db, api, ui, algorithm, test, ai, infra, general.
> Select the single most appropriate domain based on the Phase's scope file paths and the nature of the work.
> If 2+ domains are mixed, select the one with the highest proportion; if tied, classify as general.
> Also assign F-39 fields (all optional, omit if not detected):
> - `phase_subdomain`: tech stack (e.g. react, nextjs, prisma, langchain). Detected from project files/dependencies.
> - `phase_task_type`: work type (greenfield|refactor|migration|bugfix|performance|security). Detected from Phase characteristics.
> - `phase_lang`: target language (rust|go|python|typescript|java). Detected from file extensions.

#### qmd_verified Success Criteria Type

`qmd_verified` is a success criterion that combines QMD semantic search + Grep cross-verification. When Phase Runner encounters this type:

1. Perform QMD semantic search with `query` (explore candidate files)
2. Cross-verify candidate files with `grep_pattern`
3. Grep match success → PASS, failure → FAIL
4. If QMD unavailable, fall back to `grep_pattern` only

```yaml
# decomposition.yaml example
success_criteria:
  - type: qmd_verified
    query: "authentication middleware exports"
    grep_pattern: "export.*(auth|session|middleware)"
    description: "Verify the auth module exports the correct interface"
```

> **Fallback guarantee:** If QMD is unavailable, regular grep verification is performed using only the `grep_pattern` field. Therefore, `qmd_verified` criteria must always include `grep_pattern`.

### After Receiving Output

1. Parse YAML, validate phase count vs maturity mode sizing
2. Save to `.mpl/mpl/decomposition.yaml`
3. Initialize `.mpl/mpl/phase-decisions.md` with empty Active/Summary sections
4. Create `.mpl/mpl/phases/phase-N/` directories for each phase
5. Update MPL state with `phase_details` (all phases as `"pending"`)
6. Update pipeline state: `current_phase: "mpl-phase-running"`
7. Process `risk_assessment` from decomposer output:
   - If `go_no_go == "NOT_READY"`:
     AskUserQuestion: "Decomposer assessed NOT_READY. HIGH risks: {risks}."
     Options: "Redecompose (different strategy)" | "Proceed despite risk" | "Cancel"
     - "Redecompose": return to Step 3 with risk feedback
     - "Proceed": proceed with caveats logged
     - "Cancel": mpl-failed
   - If `go_no_go == "RE_INTERVIEW"` (T-11, v4.0):
     announce: "[MPL] Decomposer detected feasibility issue requiring clarification."
     for each question in risk_assessment.re_interview_questions:
       AskUserQuestion: "{question.question}\nEvidence: {question.evidence}\nAffected PP: {question.pp_affected}"
       Options: "Relax PP" | "Change approach" | "Accept risk" | "Cancel"
       - "Relax PP": return to Step 1 Stage 2 with mode: "feasibility_resolution" + question context
       - "Change approach": return to Step 3 (redecompose) with adjusted constraints
       - "Accept risk": proceed, log caveat to risk-assessment.md
       - "Cancel": mpl-failed
   - If `go_no_go == "READY_WITH_CAVEATS"`:
     Report HIGH risks to user (informational, non-blocking)
   - Save risk_assessment to `.mpl/mpl/risk-assessment.md`
8. Report: `"[MPL] Decomposition: N phases generated. Risk: {go_no_go}. Phase 1: {name}"`
9. **RUNBOOK Update (F-10)**: Append milestone to `.mpl/mpl/RUNBOOK.md`:
   ```markdown
   ## Decomposition Complete
   - **Phases**: {N} phases generated
   - **Risk Assessment**: {go_no_go}
   - **Phase List**: {phase_id: phase_name for each phase}
   - **Redecompose Count**: {redecompose_count}
   - **Timestamp**: {ISO timestamp}
   ```

---

## Step 3-F: Pre-Execution → Decomposition Feedback Loop (F-46)

After decomposition is saved (Step 3), cross-validate against Pre-Execution Analysis findings.
This step runs **at most once** to prevent infinite loops.

```
pre_exec = Read(".mpl/mpl/pre-execution-analysis.md")
decomposition = Read(".mpl/mpl/decomposition.yaml")

feedback_conditions = []

// FC-1: AI Pitfalls detected but no ai-domain phases
ai_pitfalls = pre_exec.ai_pitfalls.filter(ap => ap.severity in ["HIGH", "CRITICAL"])
ai_phases = decomposition.phases.filter(p => p.phase_domain == "ai")
if ai_pitfalls.length >= 3 AND ai_phases.length == 0:
  feedback_conditions.push({
    id: "FC-1",
    type: "A",  // domain reclassification
    description: "{ai_pitfalls.length} AI pitfalls found but 0 ai-domain phases.",
    action: "Reclassify relevant infra/algorithm phases to ai domain"
  })

// FC-2: AI Pitfalls not reflected in risk_notes
for each ap in ai_pitfalls:
  if NOT any phase.risk_notes mentions ap.title:
    feedback_conditions.push({
      id: "FC-2",
      type: "C",  // risk_notes augmentation
      description: "AP '{ap.title}' not reflected in any phase risk_notes.",
      action: "Add AP to relevant phase's risk_notes"
    })

// FC-3: AI phase with too many TODOs
for each phase in ai_phases:
  if phase.estimated_todos > 7:
    feedback_conditions.push({
      id: "FC-3",
      type: "B",  // phase split
      description: "Phase {phase.id} has {phase.estimated_todos} TODOs (ai domain max: 7).",
      action: "Split into sub-phases by AI concern (API integration, prompt management, retry/fallback)"
    })

// FC-4: Missing Requirements unmapped to any phase
missing_reqs = pre_exec.missing_requirements
for each mr in missing_reqs:
  if NOT any phase.scope covers mr:
    feedback_conditions.push({
      id: "FC-4",
      type: "D",  // decomposer re-invocation
      description: "Missing requirement '{mr.title}' not covered by any phase.",
      action: "Re-invoke Decomposer with MR constraint"
    })

// FC-5: AI phase missing ai_complexity dimension
for each phase in ai_phases:
  if NOT phase has ai_complexity field:
    feedback_conditions.push({
      id: "FC-5",
      type: "E",  // default value addition
      description: "Phase {phase.id} (ai domain) missing ai_complexity.",
      action: "Add default ai_complexity: {model_tier: 'medium', state: 'stateless'}"
    })
```

### Feedback Application

```
if feedback_conditions is empty:
  Report: "[MPL] Step 3-F: No feedback conditions. Proceeding to verification planning."
  -> proceed to Step 3-B

type_a_or_c = feedback_conditions.filter(fc => fc.type in ["A", "C", "E"])
type_b = feedback_conditions.filter(fc => fc.type == "B")
type_d = feedback_conditions.filter(fc => fc.type == "D")

// Type A/C/E: Lightweight fixes — patch decomposition in-place
for each fc in type_a_or_c:
  apply_patch(decomposition, fc)
  // A: change phase_domain from infra/algorithm to ai
  // C: append to risk_notes
  // E: add default ai_complexity field
Save patched decomposition to .mpl/mpl/decomposition.yaml

// Type B: Phase split — patch in-place (no re-invocation)
for each fc in type_b:
  split_phase(decomposition, fc.phase_id)
Save updated decomposition

// Type D: Re-invoke Decomposer (expensive, max 1 time)
if type_d is not empty AND state.step3f_count == 0:
  state.step3f_count = 1
  Report: "[MPL] Step 3-F: {type_d.length} unmapped requirements. Re-invoking Decomposer."
  // Re-run Step 3 with additional constraint:
  //   "The following requirements from Pre-Execution Analysis are NOT covered: {type_d}"
  // This consumes 1 of the 2 redecompose budget
  -> return to Step 3 with feedback constraints

elif type_d is not empty AND state.step3f_count >= 1:
  Report: "[MPL] Step 3-F: Unmapped requirements remain but re-decompose budget exhausted. Logging as caveats."
  // Log as READY_WITH_CAVEATS

Report: "[MPL] Step 3-F: Applied {feedback_conditions.length} feedback conditions ({type_a_or_c.length} patches, {type_b.length} splits, {type_d.length} re-invocations)."
```

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
