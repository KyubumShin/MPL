---
description: MPL Phase 0 Protocol - Codebase Analysis, Architecture Decisions, Phase 0 Enhanced
---

# MPL Phase 0: Codebase Analysis & Phase 0 Enhanced (Steps 2-2.5)

This file contains Step 2 (Codebase Analysis), Step 2.4 (Architecture Decisions),
and Step 2.5 (Phase 0 Enhanced) of the MPL orchestration protocol.
Load this when entering Step 2 during pre-execution analysis.

See also: `mpl-run-phase0.md` (interview + triage), `mpl-run-phase0-memory.md` (4-Tier memory loading).

---

## Step 2: Codebase Analysis (Subagent Delegation) [F-36]

> **v3.3 Change**: Changed from orchestrator directly analyzing 6 modules
> to delegating to `mpl-codebase-analyzer` subagent.
> Saves ~5-10K tokens from orchestrator context, preventing Plan phase compaction.

```
Task(subagent_type="mpl-codebase-analyzer", model="sonnet",
     prompt="""
     Perform full 6-module codebase analysis for MPL Phase 0.

     ## Configuration
     - Output path: .mpl/mpl/codebase-analysis.json
     - Tool mode: {tool_mode}
     - Project root: {cwd}

     ## Modules to Analyze
     1. Structure Analysis (directories, entry points, file stats)
     2. Dependency Graph (imports, external deps, module clusters)
     3. Interface Extraction (types, functions, endpoints)
     4. Centrality Analysis (high-impact vs isolated files)
     5. Test Infrastructure (framework, test files, run commands)
     6. Configuration (env vars, config files, scripts, key deps)

     Save the full JSON to .mpl/mpl/codebase-analysis.json.
     Return only a concise summary (~500 tokens).
     """)
```

#### Scout Call

Orchestrator performs codebase analysis directly using available tools:
- `Grep` for entry points, test infrastructure, external dependency imports
- `Glob("**/*.{ts,tsx,py,go,rs}")` for full file structure
- `Read` on key files identified by the grep results

### After Receiving Output

1. Review analysis summary (full JSON is already saved to file)
2. Save `search_trajectory` to `.mpl/mpl/phase0/search-trajectory.json` for observability.
   This enables post-mortem analysis of Phase 0 exploration quality.
3. Report: `[MPL] Codebase Analysis: {files} files, {modules} modules, {deps} deps. Tool mode: {tool_mode}.`
4. Proceed to Step 2.5

> **Fallback**: If mpl-codebase-analyzer agent fails, orchestrator performs analysis directly (existing behavior).
> In that case, 6 module tool calls accumulate in orchestrator context, increasing compaction risk.

### 6-Module Detailed Spec (for agent reference)

Full spec is included in agent definition (`agents/mpl-codebase-analyzer.md`).
Summary:

| Module | Tool | Output |
|--------|------|--------|
| 1. Structure | Glob | directories, entry_points, file_stats |
| 2. Dependencies | ast_grep / Grep | modules, external_deps, module_clusters |
| 3. Interfaces | lsp_document_symbols / Grep | types, functions, endpoints |
| 4. Centrality | (derived from Module 2) | high_impact, isolated |
| 5. Tests | Glob + Read | framework, run_command, test_files |
| 6. Config | Read | env_vars, config_files, scripts |

---

## Step 2.4: Architecture Decision Checklist (B-02, v0.6.3)

Before Phase 0 Enhanced, force critical architecture decisions that affect multiple phases:

```
// Detect patterns that require early decisions
decisions_needed = []

if codebase_analysis.has_database:
  decisions_needed.push({
    pattern: "database",
    question: "How is the database path resolved? (app data dir / config / env var / hardcoded)",
    default: "App data directory via platform API"
  })

if codebase_analysis.layers.length >= 2:
  decisions_needed.push({
    pattern: "multi-layer IPC",
    question: "What IPC protocol between {layer_A} and {layer_B}? (Tauri invoke / REST / gRPC / WebSocket)",
    default: "Detect from project config"
  })

if codebase_analysis.has_auth:
  decisions_needed.push({
    pattern: "auth storage",
    question: "Where are auth tokens stored? (localStorage / httpOnly cookie / keychain / memory)",
    default: "Depends on platform"
  })

if codebase_analysis.has_file_io:
  decisions_needed.push({
    pattern: "file paths",
    question: "How are file paths resolved? (relative to CWD / app data / user-specified)",
    default: "Platform app data directory"
  })

if codebase_analysis.layers.length >= 2:
  decisions_needed.push({
    pattern: "cross-layer contracts (B-03)",
    question: "How are types shared between layers?\n  A) Contract-First: one layer generates types for the other (e.g., specta/ts-rs for Tauri, OpenAPI for REST)\n  B) Shared schema: single schema generates both sides (protobuf, JSON Schema)\n  C) Manual sync: both sides define types independently (NOT recommended — drift risk)",
    recommendation: "A or B — auto-generation eliminates structural mismatch",
    default: "A (Contract-First) if tooling exists for the stack"
  })

// Check if already answered in PP or interview responses
for each decision in decisions_needed:
  if not answered_in(pivot_points, user_responses):
    AskUserQuestion: "Architecture decision needed: {decision.question}"

// Save all decisions
Write(".mpl/mpl/phase0/architecture-decisions.md", decisions_as_markdown)
announce: "[MPL] {decisions_needed.length} architecture decisions recorded."
```

These decisions are included in Decomposer input and every Phase Seed's constraints.

### AP-PHASE0-01 · Orchestrator-inlined Phase 0 analysis

When the orchestrator writes `phase0/api-contracts.md`, `type-policy.md`, or
related artifacts directly instead of dispatching `mpl-phase0-analyzer`,
Phase 0 becomes self-review: the same session that will decompose the work
also judges its own complexity. Observed in exp9/exp10/exp11, where analyzer
dispatch was zero and the complexity grade fed to Decomposer silently defaulted
to "Simple".

Root cause: the analyzer runs on a separate context with a haiku model to
provide an *independent* complexity reading and a schema-consistent artifact
set. Inline orchestrator generation loses that independence — the same blind-
spot pattern AD-0003 restored `mpl-test-agent` to address. Format drift is a
secondary cost; the primary cost is a grade that reflects the orchestrator's
own optimism, not the codebase.

Greenfield repos legitimately skip `mpl-codebase-analyzer` (no code to read),
but Phase 0 Enhanced still covers scaffolding choices, tech-stack selection,
and complexity grading — all of which apply to greenfield. Before entering
Step 3: confirm `profile/phases.jsonl` records a `mpl-phase0-analyzer` entry
when the grade is Medium or Complex. Absent that, the grade feeding
Decomposer is your own guess.

## Step 2.5: Raw Scan (Subagent Delegation) [F-36]

> **v0.17 Change (#56)**: `mpl-phase0-analyzer` reduced to mechanical extraction only.
> Complexity grading, type policy synthesis, and error spec synthesis moved to the
> decomposer (opus) — they required design judgment that haiku shouldn't make.
> Output: single `raw-scan.md` artifact. No more `complexity-report.json`,
> `type-policy.md`, or `error-spec.md` (decomposer generates these inline per-phase).

The raw scan collects boundary pairs, API signatures, test patterns, type hints (brownfield only), error locations, platform API hits, and E2E infra — all via grep/ast_grep with no inference. Decomposer interprets the raw facts during phase decomposition.

### Subagent Delegation

```
loaded_memory = load_phase0_memory(user_request)  // F-25 4-Tier Memory
field = state.codebase_skipped ? "greenfield" : "brownfield"

Task(subagent_type="mpl-phase0-analyzer", model="haiku",
     prompt="""
     Perform raw scan for MPL Phase 0.

     ## Input
     - Codebase analysis: .mpl/mpl/codebase-analysis.json (may not exist for greenfield)
     - Output directory: .mpl/mpl/phase0/
     - Cache directory: .mpl/cache/phase0/
     - Tool mode: {tool_mode}
     - Field: {field}   # brownfield | greenfield

     ## Context
     ### Pivot Points
     {pivot_points from .mpl/pivot-points.md}

     ### Memory (4-Tier) — used only for cache acceleration
     {loaded_memory}

     ## Task
     1. Check cache (full hit → skip, partial → rerun affected passes only)
     2. Run all scan passes unconditionally: boundary, API, tests, types (Path A only), errors, platform, e2e
     3. Assemble single raw-scan.md artifact
     4. Save cache with per-pass hashes for future partial invalidation
     5. Return ~200-token summary

     Save only raw-scan.md + manifest.json. Do NOT synthesize type policy or error spec.
     Return only the summary. Do NOT return full artifact content.
     """)
```

### After Receiving Output

1. Review subagent's summary (raw-scan.md is already saved)
2. Report: `[MPL] Raw scan complete. Boundary: {N}, API: {N}, Tests: {N}, E2E infra: {tool|none}. Cache: {HIT|MISS|PARTIAL}.`
3. **E2E awareness check (HA-06, v0.13.0)**: if Phase 0 summary reports `e2e_infra.detected: true`:

   ```
   if phase0_summary.e2e_infra?.detected:
     e2e_tool = phase0_summary.e2e_infra.tool
     e2e_config = phase0_summary.e2e_infra.config_file

     AskUserQuestion(
       question: "E2E 테스트 인프라가 감지되었습니다 ({e2e_tool}, {e2e_config}). 이번 작업의 결과를 E2E로 검증해야 하나요?",
       header: "E2E 검증",
       options: [
         { label: "예 — 기존 도구 사용",
           description: phase0_summary.e2e_infra.run_command
             ? "감지된 명령어: " + phase0_summary.e2e_infra.run_command
             : "E2E 실행 명령어를 지정해주세요" },
         { label: "예 — 다른 방법 지정",
           description: "직접 E2E 실행 명령어를 입력합니다" },
         { label: "아니오",
           description: "이번 작업은 E2E 불필요" }
       ]
     )

     if answer starts with "예":
       e2e_command = phase0_summary.e2e_infra.run_command or user_input
       writeState(cwd, { e2e_required: true, e2e_command: e2e_command })
       announce: "[MPL] HA-06: E2E 검증 활성화 ({e2e_tool}). 명령어: {e2e_command}"
     else:
       writeState(cwd, { e2e_required: false })
   else:
     // No E2E infra detected — skip question entirely. Zero overhead.
     pass
   ```

   The `e2e_required` + `e2e_command` state fields are consumed by the decomposer
   (generates S-items for E2E phases) and Step 5.0 E2E Test (executes the command
   in the existing fallback chain).

   **Note (AD-0008, v0.15.2)**: HA-06's single `e2e_command` is now supplemented
   by the full `e2e_scenarios[]` contract. Step 2.5.3 below derives the core
   scenarios that feed Decomposer Step 7.5, which emits the per-scenario
   test_commands. `e2e_command` remains as a quick smoke (often identical to
   one scenario's test_command); `e2e_scenarios` provides structured coverage.

> **Moved in v0.17 (#55)**: Step 3.5 Core Scenario Derivation and Step 3.6 Intent Invariants Derivation have moved to `mpl-run-phase0.md` Stage 1.1 and Stage 1.2 respectively. Both only depend on Pivot Points + user_request, so they belong in the Interview Block (before codebase analysis) rather than in Phase 0 Enhanced.

4. **Verification Command Capture (AD-0006, v0.15.0)**: establish the verification contract for gate-recorder hook consumption.

   ```
   verify_script = ".mpl/verify.sh"
   verify_commands = state.verification_commands || []

   # Path A (Primary): project-provided verify.sh script
   if exists(verify_script):
     announce: "[MPL] AD-0006: .mpl/verify.sh detected. gate-recorder hook will match its output."
     # Record marker so doctor audit can confirm the setup
     writeState(cwd, {
       verification_strategy: "verify_script",
       verification_commands: []   # hook infers from verify.sh output
     })

   # Path B (Fallback): heuristic matching by gate-recorder
   # gate-recorder classifies common tool commands (pnpm lint/test/build,
   # cargo test/clippy, playwright, etc.) automatically. No orchestrator action
   # needed for stacks covered by the heuristic.

   # Path C (Best-effort): Phase 0 interview for explicit commands
   # Trigger only when Phase 0 Enhanced grade is Complex AND no verify.sh exists.
   if (phase0_summary.boundary_pairs?.length ?? 0) >= 3 and not exists(verify_script):
     AskUserQuestion(
       question: "프로젝트의 gate 검증 명령어를 알려주세요. (또는 .mpl/verify.sh 작성 권장)",
       header: "검증 명령어 수집",
       options: [
         { label: "기본 heuristic 사용",
           description: "pnpm lint/test/build, cargo test/clippy 등 자동 매칭 — 대부분 프로젝트에 충분" },
         { label: "명령어 직접 지정",
           description: "lint/test/build/e2e 명령을 각각 입력" },
         { label: ".mpl/verify.sh 작성 예정",
           description: "파이프라인 시작 후 사용자가 verify.sh 작성 → gate-recorder가 감지" }
       ]
     )
     if answer starts with "명령어 직접":
       # Collect gate-by-gate via free-text follow-up, then:
       writeState(cwd, {
         verification_strategy: "explicit",
         verification_commands: [
           { gate: "hard1_baseline", command: "<lint+build+typecheck>" },
           { gate: "hard2_coverage", command: "<test runner>" },
           { gate: "hard3_resilience", command: "<e2e or contract>" }
         ]
       })
     else:
       writeState(cwd, { verification_strategy: "heuristic", verification_commands: [] })
   ```

   **Design note**: `hooks/mpl-gate-recorder.mjs` writes `state.gate_results[gate_name]` structurally
   regardless of which path was chosen. verify.sh is only documentation of project intent;
   the hook fires on every Bash completion whose command matches a known gate pattern.
   SSOT stays `state.gate_results` per AD-0006.

5. Proceed to Stage 2 (Ambiguity Resolution Loop in `mpl-run-phase0.md`) — the raw-scan.md artifact feeds `codebase_context` for the MCP score call.

> **Fallback**: If `mpl-phase0-analyzer` agent fails, the orchestrator may perform the scan directly using the protocol embedded in `agents/mpl-phase0-analyzer.md`. That doubles orchestrator context load and increases compaction risk; prefer retrying the agent.

> **v0.17 change (#56)**: Prior sections 2.5.0-2.5.9 (complexity detection, API contracts, examples, type policy, error spec, validation per artifact, token profiling per step) are removed. That protocol was duplicated between the orchestrator doc and the agent prompt; the agent is now the single source of truth. Synthesis (complexity grade, type policy, error spec) moved to decomposer (#57).


