---
description: MPL Decomposition Protocol - Phase Decomposition, Verification Planning (Critic absorbed into Decomposer)
---

# MPL Decomposition: Steps 3, 3-F, and 3-B

This file contains Steps 3, 3-F, and 3-B of the MPL orchestration protocol.
Load this when transitioning from pre-execution analysis to phase decomposition.

---

## Step 3: Phase Decomposition

### 3.0: Ambiguity Gate — Delegated to Stage 2 Re-Entry (Issue #51)

The decomposer dispatch is guarded by `hooks/mpl-ambiguity-gate.mjs` (PreToolUse).
When `ambiguity_score > 0.2` (or null) AND `ambiguity_override.active == false`,
the gate returns `continue: false` and reverts `current_phase` to
`mpl-ambiguity-resolve`. The router (`mpl-run.md`) maps that phase back to
`mpl-run-phase0.md` Step 1 Stage 2, so the orchestrator naturally resumes the
Socratic loop rather than forcing a bypass here.

```
// 1. Attempt decomposer dispatch.
result = try_dispatch_decomposer()

// 2. If the PreToolUse gate blocked the dispatch, the hook has already set
//    current_phase := "mpl-ambiguity-resolve". Do NOT fabricate a score and
//    retry — that manufactures false evidence (AP-GATE-01). Do NOT retry in
//    a local loop — Stage 2 is the canonical place for clarifying questions
//    and already implements stagnation detection + override flow (Issue #51).
if result.blocked_by_ambiguity_gate:
  announce: "[MPL] Decomposer gated by ambiguity_score=${readState().ambiguity_score}. " +
            "Re-entering Stage 2 via mpl-run-phase0.md (see router)."
  return  // Orchestrator re-reads state, follows router to phase0 Step 1 Stage 2,
          // runs the unlimited interview loop, and re-enters this file once the
          // loop terminates (threshold_met OR ambiguity_override.active).

// 3. Gate passed. Either ambiguity_score <= 0.2 or ambiguity_override.active is
//    true. The override path keeps ambiguity_score at its true value so finalize
//    metrics and risk reports can surface residual ambiguity downstream.
```

> **Why no local retry loop any more**: the previous `max_ambiguity_retries=3`
> with force-pass to `ambiguity_score=0.19` silently manipulated state
> evidence, contradicting AD-0006 (see AP-GATE-01). Stagnation is now handled
> inside the Stage 2 loop by surfacing a user choice (continue / halt with
> override / cancel) rather than by capping attempts.

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

     ### Phase 0 Artifacts
     #### Raw Scan (v0.17, #56 — single source from mpl-phase0-analyzer)
     {raw_scan from .mpl/mpl/phase0/raw-scan.md — always exists, may be minimal for greenfield}
     #### Core Scenarios + Intent Invariants + User Contract
     {core_scenarios from .mpl/mpl/core-scenarios.yaml}
     {design_intent from .mpl/mpl/phase0/design-intent.yaml}
     {user_contract from .mpl/requirements/user-contract.md — if exists}
     #### Baseline (v0.17 #59 stub)
     {baseline from .mpl/mpl/baseline.yaml — if exists}

     ### Synthesis Responsibility (v0.17 #57)
     You (decomposer) now synthesize `type_policy` and `error_spec` per phase inline
     — previously in phase0-analyzer. Raw scan provides the facts; you decide
     per-phase rules. See agents/mpl-decomposer.md Step 5.5 / 5.6.

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

### AP-E2E-01 · Placeholder E2E test_command

If `e2e_scenarios[].test_command` contains `TODO`, `FIXME`, or `manual:`, the
pipeline produces a commit whose E2E section declares coverage it cannot prove —
observed in exp11, where 42 of 80 scenarios shipped as
`TODO(segment-7-integration-ci)`.

Root cause: decomposer output is a contract, not a draft. When the E2E infra
doesn't exist yet, Step 7.5's detection is supposed to insert a `phase-e2e-infra`
first so the test_command can reference a real runner. Deferring with a TODO
collapses that insertion path into a no-op. A scenario that genuinely requires
manual verification is expressed via `required: false` with rationale, not as
prose inside `test_command`.

Before finishing decomposition, check every `test_command` for `TODO|FIXME|manual`
and confirm no `core-scenarios.yaml` entry is missing from the `e2e_scenarios`
output. Either condition is a hard-fail — rerun Step 7.5, re-inserting
`phase-e2e-infra` if the runner does not yet exist.

---

## Step 3-G: Chain Derivation (#34 Stage 1)

**Gated**: Runs only if `.mpl/config.json` has `chain_seed.enabled: true` (default `false` in Stage 1).

### AP-CHAIN-01 · Chain derivation silent skip

When `config.chain_seed.enabled=true` but `chain-assignment.yaml` is missing at
Section 4.0.5.A entry, execution silently falls back to `chains/no-chain/` —
the opus Seed call is never made and the user's explicit activation is discarded
(observed in exp10 / AD-0006 §#41).

Root cause: Step 3-G is labeled "Gated", which the orchestrator reads as
*skippable by default* rather than *conditional on config*. A related
misconception — that `decomposition.yaml.depends_on` already encodes the chain
graph — is also wrong: `chain-assignment.yaml` is a distinct data-flow edge
mapping that drives baton-pass and cache reuse.

Before leaving decomposition with `chain_seed.enabled=true`, verify
`.mpl/mpl/chain-assignment.yaml` exists. If not, Step 3-G did not actually
run — return to it.

**Machine enforcement (P1-4d)**: `hooks/mpl-require-chain-assignment.mjs`
(PreToolUse on `Task|Agent` with `subagent_type=mpl-seed-generator`) denies
the dispatch outright when `chain_seed.enabled=true` and the yaml is absent.
The prose warning above is preserved for context; the hook makes the prior
silent-skip path impossible.


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
