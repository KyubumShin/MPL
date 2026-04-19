---
description: MPL Decomposition Protocol - Phase Decomposition, Verification Planning (Critic absorbed into Decomposer)
---

# MPL Decomposition: Steps 3, 3-F, and 3-B

This file contains Steps 3, 3-F, and 3-B of the MPL orchestration protocol.
Load this when transitioning from pre-execution analysis to phase decomposition.

---

## Step 3: Phase Decomposition

### 3.0: Ambiguity Gate Retry Protocol (v0.13.0)

The decomposer dispatch is guarded by `hooks/mpl-ambiguity-gate.mjs` (PreToolUse).
If `ambiguity_score > 0.2`, the gate returns `continue: false` and the dispatch is
blocked. **The orchestrator MUST handle this gracefully — not stop.**

```
max_ambiguity_retries = 3
ambiguity_retry_count = 0

while ambiguity_retry_count < max_ambiguity_retries:
  // Attempt decomposer dispatch (may be blocked by ambiguity gate)
  result = try_dispatch_decomposer()

  if result.success:
    break  // Gate passed, decomposer dispatched

  if result.blocked_by_ambiguity_gate:
    ambiguity_retry_count += 1
    current_score = readState(cwd).ambiguity_score

    announce: "[MPL] Ambiguity gate blocked decomposer (score={current_score}, threshold=0.2). Re-entering Stage 2 (attempt {ambiguity_retry_count}/{max_ambiguity_retries})."

    // Re-enter Stage 2: ask one targeted question on the weakest dimension
    weakest_dim = result.weakest_dimension or "Edge Case Coverage"
    AskUserQuestion(
      question: "Ambiguity score가 아직 높습니다 (현재: {current_score}). {weakest_dim} 관련 추가 명확화가 필요합니다. 구체적으로 설명해주세요:",
      header: "Ambiguity 해소",
      options: [
        { label: "직접 입력", description: "{weakest_dim}에 대해 자유 텍스트로 답변" },
        { label: "현재 상태로 진행", description: "ambiguity_score를 강제로 통과시키고 decompose 진행 (위험 수용)" }
      ]
    )

    if answer == "현재 상태로 진행":
      // Force-pass: write score below threshold
      writeState(cwd, { ambiguity_score: 0.15 })
      announce: "[MPL] Ambiguity score force-overridden to 0.15 by user request."
      continue  // retry dispatch

    // User provided additional input → re-score via MCP
    mpl_score_ambiguity(pivot_points, updated_responses)
    writeState(cwd, { ambiguity_score: new_score })

    if new_score <= 0.2:
      announce: "[MPL] Ambiguity resolved (score={new_score}). Retrying decomposer dispatch."
      continue  // retry dispatch
    else:
      announce: "[MPL] Score still above threshold ({new_score}). Will retry."
      continue

if ambiguity_retry_count >= max_ambiguity_retries:
  // 3 retries exhausted — force-pass with warning
  writeState(cwd, { ambiguity_score: 0.19 })
  announce: "[MPL] Ambiguity gate retry limit reached. Force-passing with score=0.19. Caveats will be logged in risk_assessment."
```

### 3.1: Decomposer Dispatch

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
     pp_proximity (pp_core|pp_adjacent|non_pp — see classification rules below),
     phase_subdomain (F-39, optional: tech-stack e.g. react, prisma, langchain),
     phase_task_type (F-39, optional: greenfield|refactor|migration|bugfix|performance|security),
     phase_lang (F-39, optional: rust|go|python|typescript|java),
     scope, impact (create/modify/affected_tests/affected_config),
     interface_contract (requires/produces/**contract_files**), success_criteria (typed: command/test/file_exists/grep/description),
     estimated_complexity (S/M/L).

     **AD-01 (v0.13.0) — contract_files is REQUIRED** for every phase under `interface_contract.contract_files`. Enumerate one entry per cross-layer boundary between impact files (path, boundary_id, caller, callee, framework_rules, params key-type map, returns key-type map). Empty list `[]` only for phases with zero cross-layer boundaries (pure infra/docs). Omission is a validation error. See `agents/mpl-decomposer.md` Step 6.5 for the enumeration procedure and full sub-schema.
     Also: architecture_anchor (tech_stack, directory_pattern, naming_convention), shared_resources.

     **HA-06 (v0.13.0) — E2E verification**: if pipeline state has `e2e_required: true`, include an E2E S-item in the LAST phase's `verification_plan.s_items[]`:
     ```yaml
     s_items:
       - criterion: "E2E smoke test passes"
         test_command: "{state.e2e_command}"
         expected_exit: 0
     ```
     This ensures Step 5.0 E2E Test has a concrete S-item to execute.

     **AD-0006 (v0.15.0) — Launch smoke deterministic detection**: if any phase touches a runtime entry point detected mechanically from the project manifest, include a `launch_smoke` S-item on that phase. Detection triggers (pure file existence, no model judgment): `package.json` has `scripts.start`, `scripts.dev`, or `scripts.serve` · `Cargo.toml` has `[[bin]]` OR `[package].default-run` · `pyproject.toml` has `[project.scripts]` · project root has a `Dockerfile` ENTRYPOINT. Emit the matching smoke: `tauri dev --no-open` + liveness for Tauri, `<bin> --help` exit 0 for CLI, startup + `curl /health` for servers, `docker run --rm <image> --help` for containers. This closes the exp9 `cargo test` pass → `cargo run` abort class of failures (MPL#38).

     ## PP-Proximity Classification Rules
     Assign `pp_proximity` to each phase:
     - **pp_core**: phase impact files overlap with files referenced in pivot-points.md
     - **pp_adjacent**: phase impact files import/depend on pp_core files, OR phase handles security/data/auth
     - **non_pp**: no PP relationship
     Security/data escalation: phases touching auth, encryption, DB schema, or PII → pp_adjacent minimum.
     User can override via `pp_proximity_override` per phase.
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

### After Receiving Output

1. Parse YAML, validate phase count and pp_proximity assignments
2. Save to `.mpl/mpl/decomposition.yaml`
2a. **Write contract files (CB-08 L0 / AD-01, v0.13.0)**:
    Validate that every phase has `interface_contract.contract_files` present (empty list allowed, omission is a hard error — abort with "[MPL] Decomposer output missing required interface_contract.contract_files on phase {id}").

    ```
    mkdir(".mpl/contracts")
    any_contract_written = false
    for each phase in decomposition.phases:
      if phase.interface_contract.contract_files is None:
        ABORT: "Decomposer output missing required interface_contract.contract_files on phase {phase.id}"
      for each cf in phase.interface_contract.contract_files:
        contract_json = {
          "boundary_id": cf.boundary_id,
          "caller": cf.caller,
          "callee": cf.callee,
          "framework_rules": cf.framework_rules,
          "params": cf.params,
          "returns": cf.returns,
          "boundaries": [{
            "boundary_id": cf.boundary_id,
            "caller": cf.caller,
            "callee": cf.callee,
            "framework_rules": cf.framework_rules,
            "params": cf.params,
            "returns": cf.returns
          }]
        }
        Write(cf.path, JSON.stringify(contract_json, null, 2))
        any_contract_written = true

    if not any_contract_written:
      // Whole project has zero cross-layer boundaries. Write a placeholder so
      // Hard 3 (AD-02) sees a non-empty contracts/ directory and passes with
      // zero violations rather than FAILing on missing directory.
      Write(".mpl/contracts/_no-boundaries.json", JSON.stringify({
        "boundary_id": "_no-boundaries",
        "note": "Decomposer found no cross-layer boundaries in this project.",
        "boundaries": []
      }, null, 2))
    ```

    Report: `[MPL] AD-01: {N} contract files written to .mpl/contracts/`
2b. **Inject default risk patterns (AD-0005, v0.13.0, EXPERIMENTAL)**:
    Apply `default_risk_patterns` to each phase's `verification_plan.a_items[]`. This step ensures security patterns are checked even if the decomposer omits them from `risk_patterns[]`.

    ```
    default_risk_patterns = [
      { pattern_id: "sec-eval",        grep_pattern: "\\beval\\(",                                                      target_langs: ["js","ts","py"] },
      { pattern_id: "sec-api-key",     grep_pattern: "(api_key|apikey|secret)\\s*[:=]\\s*[\"'][^\"']{8,}",              target_langs: ["*"] },
      { pattern_id: "sec-sql-concat",  grep_pattern: "[\"']\\s*\\+\\s*\\w+.*(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)",   target_langs: ["js","ts","py","java"] },
      { pattern_id: "sec-innerhtml",   grep_pattern: "\\.innerHTML\\s*=",                                               target_langs: ["js","ts"] },
      { pattern_id: "sec-weak-crypto", grep_pattern: "Math\\.random\\(\\)",                                             target_langs: ["js","ts"] }
    ]

    for each phase in decomposition.phases:
      phase_langs = detect_languages(phase.impact.create + phase.impact.modify)

      for each rp in default_risk_patterns:
        if rp.target_langs includes "*" or any(rp.target_langs intersect phase_langs):
          // Inject as A-item grep criterion
          phase.verification_plan.a_items.push({
            criterion: "AD-0005 EXPERIMENTAL: " + rp.pattern_id,
            type: "grep",
            command: "grep -rnE '" + rp.grep_pattern + "' " + join(phase.impact_files(), " "),
            severity: "EXPERIMENTAL"  // non-blocking, metric only
          })

      // Also merge any decomposer-generated risk_patterns (project-specific)
      for each rp in phase.risk_patterns:
        if rp not already in a_items:
          phase.verification_plan.a_items.push({
            criterion: "AD-0005 EXPERIMENTAL: " + rp.pattern_id,
            type: "grep",
            command: "grep -rnE '" + rp.grep_pattern + "' " + join(phase.impact_files(), " "),
            severity: "EXPERIMENTAL"
          })

    pattern_count = count injected a_items across all phases
    ```

    Report: `[MPL] AD-0005: {pattern_count} EXPERIMENTAL pattern checks injected across {phase_count} phases`
3. Initialize `.mpl/mpl/phase-decisions.md` with empty Active/Summary sections
4. Create `.mpl/mpl/phases/phase-N/` directories for each phase
5. Update MPL state with `phase_details` (all phases as `"pending"`)
6. Update pipeline state: `current_phase: "phase2-sprint"`
7. Process `risk_assessment` from decomposer output:
   - If `go_no_go == "NOT_READY"`:
     AskUserQuestion: "Decomposer assessed NOT_READY. HIGH risks: {risks}."
     Options: "Proceed despite risk" | "Cancel"
     - "Proceed": proceed with caveats logged
     - "Cancel": writeState(cwd, { current_phase: "phase5-finalize" }), MPL status = "cancelled"
   - If `go_no_go == "RE_INTERVIEW"` (T-11, v4.0):
     announce: "[MPL] Decomposer detected feasibility issue requiring clarification."
     for each question in risk_assessment.re_interview_questions:
       AskUserQuestion: "{question.question}\nEvidence: {question.evidence}\nAffected PP: {question.pp_affected}"
       Options: "Relax PP" | "Change approach" | "Accept risk" | "Cancel"
       - "Relax PP": return to Step 1 Stage 2 with mode: "feasibility_resolution" + question context
       - "Change approach": return to Step 3 with adjusted constraints
       - "Accept risk": proceed, log caveat to risk-assessment.md
       - "Cancel": writeState(cwd, { current_phase: "phase5-finalize" }), MPL status = "cancelled"
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
   - **Circuit Breaks**: {circuit_break_count}
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
  -> return to Step 3 with feedback constraints

elif type_d is not empty AND state.step3f_count >= 1:
  Report: "[MPL] Step 3-F: Unmapped requirements remain but feedback loop exhausted. Logging as caveats."
  // Log as READY_WITH_CAVEATS

Report: "[MPL] Step 3-F: Applied {feedback_conditions.length} feedback conditions ({type_a_or_c.length} patches, {type_b.length} splits, {type_d.length} re-invocations)."
```

---

## Step 3-B: Verification Planning

### GUI App Mandatory Check (F-E2E-1c, v0.8.3)

Before deciding whether to run Step 3-B, check for GUI app indicators:

```
decomposition = Read(".mpl/mpl/decomposition.yaml")
tech_stack = decomposition.architecture_anchor.tech_stack
dir_pattern = decomposition.architecture_anchor.directory_pattern

gui_app_detected = any of:
  - "src-tauri/" in dir_pattern or directory exists
  - "electron/" or "src-electron/" in dir_pattern or directory exists
  - "Tauri" in tech_stack
  - "Electron" in tech_stack

if gui_app_detected:
  announce: "[MPL] GUI app detected. Step 3-B (Verification Planning) is mandatory."
  → MUST execute Step 3-B. Do NOT skip.
```

After decomposition, create per-phase verification plans with A/S/H-item classification.
The Decomposer already outputs A/S/H classification as part of each phase's `success_criteria`, so the orchestrator performs verification planning inline.

```
decomposition = Read(".mpl/mpl/decomposition.yaml")
pivot_points = Read(".mpl/pivot-points.md")
codebase_analysis = Read(".mpl/mpl/codebase-analysis.json")
gap_analysis = Read(".mpl/mpl/pre-execution-analysis.md")

// For each phase, classify success_criteria into A/S/H items:
//   A (Automated): type is command, test, file_exists, grep
//   S (Semi-automated): type is description but has verifiable pattern
//   H (Human): type is description with subjective/UX judgment needed
//
// Build verification_plan per phase from the decomposer's output.
// No separate agent needed — the orchestrator reads the decomposition
// and organizes the existing criteria into the A/S/H taxonomy.
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

## Step 3-H: E2E Scenario Extraction (AD-0008, v0.15.2)

**Gated**: Runs only if `.mpl/mpl/core-scenarios.yaml` exists AND contains ≥1 entry.

After Decomposer emits `e2e_scenarios[]` in its output (per Reasoning_Steps Step 7.5), extract this top-level field and write to `.mpl/mpl/e2e-scenarios.yaml`:

```
decomp_output = <Decomposer result>
if not exists(".mpl/mpl/core-scenarios.yaml"):
  announce: "[MPL AD-0008] core-scenarios.yaml not found — skipping Step 3-H. Doctor audit [h] will flag as WARN."
  proceed to Step 3-G

scenarios = decomp_output.e2e_scenarios or []
if scenarios.length == 0:
  announce: "[MPL AD-0008] Decomposer emitted 0 e2e_scenarios despite core-scenarios present. Inspect Decomposer output."
  # Do not auto-fail; Phase 0 may have declared all PPs as invariants-only.

# Infrastructure phase auto-insertion (Decomposer already handled this in
# decomposition.yaml output; Step 3-H only extracts e2e_scenarios).
Write(".mpl/mpl/e2e-scenarios.yaml", serialize({
  generated_at: now_iso(),
  generated_by: "mpl-decomposer",
  derived_from_core: "sha1(.mpl/mpl/core-scenarios.yaml)",
  e2e_scenarios: scenarios
}))

# Validation: test_command placeholder check (AD-0008 enforcement)
for s in scenarios:
  if s.test_command matches /TODO|FIXME|manual verification/i:
    Hard-fail decomposition:
    announce: "[MPL AD-0008] Scenario {s.id} has placeholder test_command '{s.test_command}'. Decomposer must emit executable commands. Re-running Step 3 with constraint."
    re-run Decomposer with explicit prompt: "No placeholder test_commands."

announce: "[MPL AD-0008] E2E scenarios written: {scenarios.length} scenarios covering {phases_involved union} phases."
```

### Common Rationalizations (AD-0008)

exp11에서 42/80 E2E가 `TODO(segment-7-integration-ci)` placeholder로 커밋됐다. Decomposer가 이런 합리화를 반복하지 않게 한다.

| Rationalization | Why it's wrong |
|---|---|
| "E2E 인프라가 아직 없으니 TODO로 남기고 나중에 채우자" | Step 7.5의 인프라 탐지가 이미 있다. 인프라 없으면 `phase-e2e-infra`를 자동 삽입해 인프라를 먼저 만든 뒤 실행 가능한 test_command를 emit. "나중에"는 `TODO(ci)` 커밋으로 고착된다. |
| "시나리오 초안만 남기고 test_command는 phase-runner가 채울 것" | Decomposer 출력은 **계약**이다. phase-runner는 그 계약을 구현하는 것이지 재계약하는 것이 아니다. test_command가 비어있거나 placeholder면 계약 위반. |
| "이 시나리오는 manual verification이 더 적합" | 수동 검증은 AD-0008 PARTIAL + HITL 경로를 통해서만 허용. test_command에 "manual: ..."로 적지 말고 required: false로 낮추고 rationale에 명시. |
| "core-scenarios에 없는 flow라 E2E에서도 생략" | core에 없으면 cross-feature 조합 대상이 안 될 뿐, 단일 PP의 복잡한 flow(≥3 steps, ≥2 impact files)는 1:1 E2E로 승격 가능. 생략이 default가 아니다. |

### Red Flags — 즉시 정지

- scenario.test_command에 `TODO`/`FIXME`/`manual` 포함 → Step 7.5 재실행
- core-scenarios.yaml이 존재하는데 e2e_scenarios 배열이 0개 → Decomposer 재호출
- `phase-e2e-infra` 없이 scenario test_command가 playwright 등을 호출 (인프라 없이 실행 불가) → Step 7.5 infra insertion 재적용

---

## Step 3-G: Chain Derivation (#34 Stage 1)

**Gated**: Runs only if `.mpl/config.json` has `chain_seed.enabled: true` (default `false` in Stage 1).

### Common Rationalizations (AD-0006, #41)

exp10 (2026-04-16) 에서 `chain_seed.enabled: true`가 명시됐음에도 Step 3-G가 silent skip되어 `chain-assignment.yaml` 미생성 → `chains/no-chain/` fallback이 관측됐다. 다음 합리화는 **모두 잘못**이다. Step에 진입하기 전 반드시 점검하라.

| Rationalization | Why it's wrong |
|---|---|
| "Stage 1 default-off이니까 skip해도 됨" | default-off는 config 미설정 시의 기본값. 사용자가 `enabled: true`로 명시했다면 skip은 **사용자 의사 위반**이다. |
| "chain 없이 no-chain fallback으로도 phase-runner가 잘 돌아감" | no-chain은 **성능 저하 모드**. opus seed generator의 chain-scoped 이점(baton-pass, 재사용 캐시)을 전부 잃는다. chain_seed=true 실험의 측정 의미가 사라진다. |
| "decomposition.yaml의 depends_on 필드가 이미 의존성을 담고 있음" | chain-assignment.yaml은 phase 간 **data-flow edge 그래프** — depends_on과 다른 레이어다. 양쪽 모두 필요. |
| "chain derivation 알고리즘이 복잡해 보이니 스펙 뒤에서 다루자" | 이 섹션 아래에 전체 알고리즘이 명시돼 있다. 읽지 않고 스킵하는 것은 **directive 위반**이다. |

### Red Flags — 즉시 정지하고 재실행

- `.mpl/config.json`에 `chain_seed.enabled: true` 존재 → Step 3-G를 건너뛰고 Step 4로 진입하려 한다면 **정지**. config를 다시 Read하고 chain derivation 블록을 실행하라.
- Step 4.0.5 진입 시점에 `.mpl/mpl/chain-assignment.yaml`이 없다면 → Step 3-G가 실행되지 않은 것. Step 3-G로 **되돌아가서 실행**하라.
- `announce: "[MPL] skip Step 3-G"` 출력이 config.enabled=true와 함께 나타난다면 → **fatal inconsistency**. 즉시 user에게 에스컬레이션.


After decomposition is saved (Step 3) and validated (Step 3-F, 3-B), derive chain structure from phase edges and proximity. Output: `.mpl/mpl/chain-assignment.yaml`.

**Schema**: `docs/schemas/chain-assignment.md`

```
decomposition = Read(".mpl/mpl/decomposition.yaml")
config = readConfig(cwd)
if config.chain_seed?.enabled != true:
  skip Step 3-G (Stage 1 default-off)
  proceed to Step 3-B completion

max_chain_size = config.chain_seed.max_chain_size || 5

// Build adjacency from phase edges (from interface_contract.requires/produces or
// execution_tiers + depends_on). Contract/data edges = strong; sequence/resource = weak.
adjacency = build_strong_adjacency(decomposition.phases)

// Group connected pp_core phases into chains (topological order preserved).
// Each connected component of strong edges forms a chain (split if > max_chain_size).
chains = []
visited = set()
for phase in phases_topological_order:
  if phase in visited: continue
  component = connected_strong_component(phase, adjacency)
  visited.update(component)
  if len(component) > max_chain_size:
    // split at weak edge boundaries
    component = split_at_weak_edges(component, max_chain_size)
  chains.append(component)

// Assign model per Chain Size Model Selection Rule:
//   size >= 2              -> opus, baton_pass: true
//   size == 1 + pp_core    -> opus, baton_pass: false
//   size == 1 + non-pp     -> sonnet, baton_pass: false
//   size == 1 + pp_adjacent -> sonnet (default) unless gate weakness flagged -> opus
for chain in chains:
  size = len(chain.phases)
  dominant_proximity = most_common_proximity(chain.phases)
  if size >= 2:
    chain.model = "opus"
    chain.baton_pass = true
  elif dominant_proximity == "pp_core":
    chain.model = "opus"
    chain.baton_pass = false
  else:
    chain.model = "sonnet"
    chain.baton_pass = false

// Derive inter-chain blocks_on from cross-chain edges
//   any decomposition edge A→B where chain(A) != chain(B) adds chain(A) to chain(B).blocks_on
phase_to_chain = { p: c.id for c in chains for p in c.phases }
for chain in chains:
  chain.blocks_on = []
for edge in decomposition.edges:  // or interface_contract.requires relations
  src_chain = phase_to_chain[edge.from]
  dst_chain = phase_to_chain[edge.to]
  if src_chain != dst_chain and src_chain not in phase_to_chain[edge.to].blocks_on:
    chains[dst_chain].blocks_on.append(src_chain)
// dedup + preserve topological order

// Validation
for phase in decomposition.phases:
  assert phase appears in exactly one chain (exhaustive + disjoint)
for chain in chains:
  assert chain.phases ordered topologically per decomposition edges
  assert len(chain.phases) <= max_chain_size

Write(".mpl/mpl/chain-assignment.yaml", chains)
Report: "[MPL] #34: {len(chains)} chains derived. Opus: {N_opus}, Sonnet: {N_sonnet}. Baton-pass enabled: {N_baton}."
```

**Gated note**: Stage 1 default keeps `chain_seed.enabled: false`, so existing pipeline behavior is unchanged. Enable per-project via `.mpl/config.json` when ready to measure.

---
