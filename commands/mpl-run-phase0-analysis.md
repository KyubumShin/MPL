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

#### Scout Call Branch (QMD Integration)

Branch the codebase analysis prompt based on qmd_mode:

**QMD-First Mode** (`qmd_mode == "qmd_first"`):
```
// Orchestrator performs codebase analysis directly using available tools:
// 1. qmd_deep_search("project entry points and main modules") → identify key files
// 2. qmd_deep_search("test infrastructure and framework") → understand test structure
// 3. qmd_vector_search("external dependencies and integrations") → understand dependencies
// 4. Cross-verify each QMD result with Grep (Search-then-Verify)
// 5. Glob("**/*.{ts,tsx,py,go,rs}") → full file structure
// Output: JSON (search_mode: "qmd_first", each finding includes verification)
```

**Grep-Only Mode** (`qmd_mode == "grep_only"`):
Use Grep/Glob directly for codebase analysis.

> **Fallback:** If QMD tool calls fail (MCP server unresponsive, etc.), automatically fall back to Grep-Only mode.

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

### Common Rationalizations (AD-0006, #42 Phase 0 Agent Dispatch)

exp9, exp10, exp11 세 실험 모두에서 `mpl-phase0-analyzer` 와 `mpl-codebase-analyzer` dispatch가 0회 관측됐다. 단, **greenfield (빈 codebase) 경우 codebase-analyzer skip은 정당**하다. phase0-analyzer는 Complex grade일 때 반드시 dispatch돼야 한다.

| Rationalization | Why it's wrong |
|---|---|
| "이미 분석했으니 agent 불필요" | 당신(orchestrator)의 분석은 **자가 검토**. Phase 0 agents는 haiku 모델 + 별도 context로 **독립 관점**을 제공하는 것이 존재 이유. orchestrator가 inline 수행하면 AD-0003이 test-agent를 복원한 것과 같은 blind spot 문제가 발생. |
| "greenfield라 분석할 게 없음" | **codebase-analyzer**는 납득 (코드 없음) 이지만 **phase0-analyzer는 다르다**. Phase 0 Enhanced는 scaffolding 결정/tech stack 선정/complexity grading을 다룬다 — greenfield에도 이것은 필요. Complex grade면 dispatch 의무. |
| "api-contracts.md, type-policy.md 등 아티팩트를 내가 더 빨리 쓸 수 있음" | 속도 ≠ 품질. phase0-analyzer는 4개 아티팩트 세트를 일관된 schema로 생성하도록 프롬프트됨. orchestrator inline은 형식 drift가 발생. |
| "Phase 0 Enhanced 전체를 skip하고 바로 decompose로 가도 됨" | complexity grade 자체가 decomposition의 입력. Enhanced skip은 decomposer에 "Simple이다"라고 거짓말하는 것과 동등. |

### Red Flags — 즉시 정지

- `.mpl/mpl/phase0/` 디렉토리에 api-contracts.md/type-policy.md/examples.md 등을 orchestrator가 직접 Write하고 있다면 → **정지**. `Task(subagent_type="mpl-phase0-analyzer")` dispatch가 선행돼야 한다.
- `state.sprint_status.phase0_complete` 또는 `profile/phases.jsonl`에 `mpl-phase0-analyzer` 기록이 없는 채 Step 3 (decompose)로 진입하려 한다면 → **정지**.
- complexity grade가 "Complex"로 판정됐는데 phase0-analyzer dispatch를 생략한다면 → **AD-0003이 test-agent에 대해 한 경고와 동일 — structural skip bug**.

## Step 2.5: Phase 0 Enhanced (Subagent Delegation) [F-36]

> **v3.3 Change**: Changed from orchestrator directly measuring complexity + 4-step analysis
> to delegating to `mpl-phase0-analyzer` subagent.
> Saves ~8-25K tokens from orchestrator context, preventing Plan phase compaction.

Phase 0 Enhanced measures project complexity based on Step 2's Codebase Analysis results, and generates pre-specifications based on complexity. These specs improve the accuracy of subsequent phases (Decomposition, Execution) and make debugging phases unnecessary.

> **Principle**: "Prevention is better than cure" — tokens invested in Phase 0 completely eliminate debugging costs in Phase 5.

### Subagent Delegation

```
loaded_memory = load_phase0_memory(user_request)  // F-25 4-Tier Memory

Task(subagent_type="mpl-phase0-analyzer", model="sonnet",
     prompt="""
     Perform Phase 0 Enhanced analysis for MPL.

     ## Input
     - Codebase analysis: .mpl/mpl/codebase-analysis.json
     - Output directory: .mpl/mpl/phase0/
     - Cache directory: .mpl/cache/phase0/
     - Tool mode: {tool_mode}

     ## Context
     ### Pivot Points
     {pivot_points from .mpl/pivot-points.md}

     ### Memory (4-Tier)
     {loaded_memory}

     ## Task
     1. Check cache (full hit → skip, partial → rerun affected only)
     2. Detect complexity grade (Simple/Medium/Complex)
     3. Run analysis steps per grade
     4. Validate artifacts
     5. Save cache
     6. Return concise summary (~300 tokens)

     Save all artifacts to .mpl/mpl/phase0/.
     Return only the summary. Do NOT return full artifact content.
     """)
```

### After Receiving Output

1. Review subagent's summary (artifact files are already saved)
2. Report: `[MPL] Phase 0 Enhanced complete. Grade: {grade}. Artifacts: {count}/4. Cache: {HIT|MISS|PARTIAL}.`
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

3.5. **Core Scenario Derivation (AD-0008, v0.15.2)**: derive must-work user flows from Pivot Points.

   **Runs only if** `.mpl/pivot-points.md` exists AND at least one PP has status
   CONFIRMED. Otherwise skip (noted in RUNBOOK).

   **Immutability (AD-0008 R-1)**: the output file `.mpl/mpl/core-scenarios.yaml`
   is immutable after Phase 0 approval — treated identically to pivot-points.md.
   Only a full Phase 0 re-interview regenerates both files atomically. The
   `mpl-sentinel-pp-file.mjs` hook extends to block post-approval writes.

   ```
   confirmed_pps = Read(".mpl/pivot-points.md") → extract CONFIRMED entries
   core_scenarios = []

   for pp in confirmed_pps:
     AskUserQuestion(
       question: "PP-{pp.id} ({pp.title})가 '동작한다'는 것은 어떤 사용자 flow를 의미하나요?",
       header: "Core — PP-{pp.id}",
       options: [
         { label: "단일 core scenario",
           description: "하나의 flow로 PP 충족 (예: 로그인 성공)" },
         { label: "복수 core scenarios",
           description: "여러 분리된 flow로 나뉨 (예: 로그인 + 로그아웃 + 세션 유지)" },
         { label: "PP는 invariant만, scenario 불필요",
           description: "테스트 대상 flow가 없는 개념적 PP (예: '외부 의존성 없음')" }
       ]
     )

     if answer == "PP는 invariant만":
       continue   # PP 그대로 두되 core_scenarios에는 미포함

     # Collect flow steps + acceptance via follow-up free-text questions
     for scenario_idx in 1..answer_count:
       AskUserQuestion(
         question: "PP-{pp.id} core scenario {scenario_idx}의 flow를 단계별로 나열해주세요.",
         header: "Flow 단계",
         options: [
           { label: "짧은 flow (3-4 단계)", description: "단순 조작 flow" },
           { label: "긴 flow (5+ 단계)", description: "복수 화면 또는 상태 전이 포함" },
           { label: "직접 입력", description: "자유 텍스트로 단계 나열" }
         ]
       )
       # Then collect flow steps + acceptance criteria via free-text
       core_scenarios.push({
         id: "CORE-{N}",
         pp_ref: pp.id,
         title: <user-provided>,
         user_story: <user-provided>,
         flow: [<steps>],
         must_work: true,
         acceptance: [<criteria>],
         source: "phase0_enhanced_hitl"
       })

   # Write immutable artifact
   Write(".mpl/mpl/core-scenarios.yaml", serialize({
     generated_at: now_iso(),
     generated_by: "phase0_enhanced_hitl",
     source_pps_hash: sha1(pivot-points.md),
     core_scenarios: core_scenarios
   }))

   announce: "[MPL AD-0008] Core scenarios derived: {core_scenarios.length} scenarios from {confirmed_pps.length} PPs. Immutable until next Phase 0 re-interview."
   ```

   If the user reports zero scenarios (all PPs are invariants-only), still write
   the file with an empty `core_scenarios: []` — doctor audit `[h]` flags this
   but does not FAIL (some projects are library-only without user-facing flows).

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
   if phase0_summary.complexity?.grade == "Complex" and not exists(verify_script):
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

5. Proceed to Step 3 (Phase Decomposition)

> **Fallback**: If mpl-phase0-analyzer agent fails, orchestrator performs analysis directly (see detailed spec below).
> In that case, tool calls accumulate in orchestrator context, increasing compaction risk.

---

### Phase 0 Enhanced Detailed Spec (for agent reference / fallback)

The spec below is embedded in `agents/mpl-phase0-analyzer.md`,
and is also the fallback protocol for the orchestrator to perform directly if the agent fails.

### 2.5.0: Cache Check (Phase 0 Caching, Extended: F-05 Partial Invalidation)

Check the cache before running Phase 0. On cache hit, skip all of Phase 0 and save 8~25K tokens.

#### Existing Behavior (Full Invalidation)

```
cache_dir = ".mpl/cache/phase0/"
cache_key = generate_cache_key(codebase_analysis)

if cache_dir exists AND cache_key matches:
  cached = Read(cache_dir + "manifest.json")
  if cached.cache_key == cache_key:
    → Load all cached artifacts to .mpl/mpl/phase0/
    → Report: "[MPL] Phase 0 cache HIT. Skipping analysis. Saved ~{budget}K tokens."
    → Skip to Step 3 (Phase Decomposition)
  else:
    → Cache stale — attempt partial invalidation (see extension below)
else:
  → No cache, proceed with Phase 0
```

#### Extension: git diff-Based Partial Invalidation (F-05)

Even if the cache key doesn't match, if the change scope is limited, **re-analyze only the changed modules**.

```pseudocode
function check_cache_with_partial(cwd):
  cache_result = checkCache(cwd)

  if cache_result.hit:
    return { action: "skip", artifacts: cache_result.manifest.artifacts }

  if not cache_result.manifest:
    return { action: "full_rerun" }  # No cache — run everything

  # Cache exists but key doesn't match — attempt partial invalidation
  diff_result = analyze_diff(cwd, cache_result.manifest)

  if diff_result.scope == "none":
    return { action: "skip" }  # diff is outside cache scope (e.g. doc changes)

  if diff_result.scope == "partial":
    return {
      action: "partial_rerun",
      reuse_artifacts: diff_result.unaffected_artifacts,
      rerun_steps: diff_result.affected_steps
    }

  return { action: "full_rerun" }  # Full change
```

#### Diff Scope Analysis

```pseudocode
function analyze_diff(cwd, manifest):
  changed_files = git_diff_names(cwd, since=manifest.commit_hash or manifest.timestamp)

  # Classify changed files by Phase 0 step
  affected = {
    api_contracts: false,   # Step 1
    examples: false,        # Step 2
    type_policy: false,     # Step 3
    error_spec: false       # Step 4
  }

  for file in changed_files:
    if is_public_api(file):       # function signature changes
      affected.api_contracts = true
    if is_test_file(file):        # test pattern changes
      affected.examples = true
    if is_type_definition(file):  # type definition changes
      affected.type_policy = true
    if is_error_handler(file):    # error handling changes
      affected.error_spec = true

  affected_count = count_true(affected)

  if affected_count == 0:
    return { scope: "none" }
  elif affected_count <= 2:
    return {
      scope: "partial",
      affected_steps: [step for step, flag in affected if flag],
      unaffected_artifacts: [artifact for step, flag in affected if not flag]
    }
  else:
    return { scope: "full" }  # 3+ steps affected → full re-run is more efficient
```

#### Partial Re-run Protocol

On partial_rerun:
1. Copy cached unaffected_artifacts to `.mpl/mpl/phase0/`
2. Re-run only affected_steps in Phase 0 Enhanced
3. Merge re-run results into existing cache
4. Update manifest with new cache_key

Example:
```
Cache exists + only test files changed →
  affected: { examples: true } →
  partial_rerun: only Step 2 re-runs →
  Step 1(api_contracts), Step 3(type_policy), Step 4(error_spec) reuse cache →
  Token savings: ~60-70% (only 1 of 4 steps runs)
```

#### File Classification Rules

```
is_public_api(file):
  - src/**/*.{ts,js,py,go,rs} (excluding tests)
  - files containing function/class exports

is_test_file(file):
  - **/*.test.{ts,js}
  - **/*.spec.{ts,js}
  - **/test_*.py
  - **/*_test.{go,rs}

is_type_definition(file):
  - **/*.d.ts
  - **/types.{ts,py}
  - **/interfaces.{ts}
  - **/models.{py}

is_error_handler(file):
  - **/error*.{ts,js,py}
  - **/exception*.{py}
  - files containing "throw", "raise", "Error" patterns
```

#### Cache Key Generation

```
generate_cache_key(codebase_analysis):
  inputs = {
    test_files_hash:  hash(content of all test files),
    structure_hash:   hash(codebase_analysis.directories),
    deps_hash:        hash(codebase_analysis.external_deps),
    source_files_hash: hash(content of source files touching public API),
    qmd_mode: qmd_mode,  // "qmd_first" | "grep_only"
  }
  return sha256(JSON.stringify(inputs))
```

#### Cache Invalidation

| Change | Cache Behavior |
|--------|---------------|
| Test file content changes | Attempt partial invalidation (examples step) |
| Source file public API changes | Attempt partial invalidation (api_contracts step) |
| Type definition file changes | Attempt partial invalidation (type_policy step) |
| Error handler file changes | Attempt partial invalidation (error_spec step) |
| 3+ steps affected simultaneously | Full cache invalidation (partial re-run inefficient) |
| Dependency version changes | Full cache invalidation |
| Directory structure changes | Full cache invalidation |
| `--no-cache` flag | Force cache bypass |
| git diff failure | Full cache invalidation (safe fallback) |

### 2.5.1: Complexity Detection

Analyze the `codebase-analysis.json` generated in Step 2 to compute complexity score.
All inputs are already in codebase-analysis.json so no additional tool calls needed:

```
complexity_score = (modules × 10) + (external_deps × 5) + (test_files × 3)
```

| Score | Grade | Phase 0 Steps | Token Budget |
|-------|-------|---------------|-------------|
| 0~29 | Simple | Step 4 only (Error Spec) | ~8K |
| 30~79 | Medium | Step 2 + Step 4 (Example + Error) | ~12K |
| 80+ | Complex | Step 1 + Step 2 + Step 3 + Step 4 (Full Suite) | ~20K |

Orchestrator computes score and determines grade directly:

```
modules = count of directories containing source files (from codebase_analysis.directories)
external_deps = codebase_analysis.external_deps.length
test_files = codebase_analysis.test_infrastructure.test_files.length
```

> v3.0 to v3.1 changes: removed `async_functions × 8` (requires separate ast_grep_search call), merged Enterprise grade into Complex (simplified to 3-grade system). test_files weight increased from 2 to 3.

Save to `.mpl/mpl/phase0/complexity-report.json`:
```json
{
  "score": 89,
  "grade": "Complex",
  "breakdown": {
    "modules": 6, "external_deps": 4, "test_files": 3
  },
  "selected_steps": [1, 2, 3, 4],
  "token_budget": 20000
}
```

Announce: `[MPL] Complexity: {score} ({grade}). Phase 0 steps: {step_list}`

### 2.5.2: Step 1 — API Contract Extraction (Complex+)

**Applies when**: Complex (80+) only

Analyze test files and source code to extract function signatures, parameter order, and exception types.

**Execution method**: Orchestrator directly uses tools to analyze:

```
1. Extract function/method definitions
   ast_grep_search(pattern="def $NAME($$$ARGS)", language="python")
   ast_grep_search(pattern="function $NAME($$$ARGS)", language="typescript")
   lsp_document_symbols(file) for each key source file

2. Extract call patterns from tests
   ast_grep_search(pattern="$OBJ.$METHOD($$$ARGS)", language="python", path="tests/")
   — infer parameter order and types

3. Map exception types
   ast_grep_search(pattern="raise $EXCEPTION($$$ARGS)", language="python")
   ast_grep_search(pattern="pytest.raises($EXCEPTION)", language="python", path="tests/")
   ast_grep_search(pattern="throw new $EXCEPTION($$$ARGS)", language="typescript")

4. Signature verification
   lsp_hover(file, line, character) for ambiguous signatures
```

**Output**: `.mpl/mpl/phase0/api-contracts.md`

```markdown
# API Contract Specification

## [Module Name]

### [Function Name]
- Signature: `function_name(param1: Type1, param2: Type2) -> ReturnType`
- Parameter order: [importance indicator]
- Exceptions: [condition] → [exception type]("message pattern")
- Return value: [description]
- Side effects: [describe if any]
```

**Experimental basis**: In Exp 1, discovering parameter order was the key factor in passing tests.

### 2.5.3: Step 2 — Example Pattern Analysis (Medium+)

**Applies when**: Medium (30+) and above

Extract concrete usage patterns, default values, and edge cases from test files.

**Execution method**: Orchestrator analyzes test files:

```
1. Read test files (test_files identified in Step 2)
   Read(test_file) for each test file (cap: 300 lines per file)

2. Classify patterns (7 categories):
   - Creation patterns: object instantiation methods (constructor args, factory methods)
   - Validation patterns: assert/expect call patterns
   - Sorting patterns: order-related verifications (sorted, order_by)
   - Result patterns: return value structures (dict keys, list structure)
   - Error patterns: exception trigger conditions
   - Side effect patterns: state change verifications
   - Integration patterns: cross-module interactions

3. Extract default values
   ast_grep_search(pattern="$PARAM=$DEFAULT", language="python")
   Grep(pattern="default|DEFAULT", path="src/")

4. Identify edge cases
   Grep(pattern="edge|corner|boundary|empty|null|None|zero|negative", path="tests/")
```

**Output**: `.mpl/mpl/phase0/examples.md`

```markdown
# Example Pattern Analysis

## Pattern 1: [Pattern Name]
### Basic Usage
[code example from tests]

### Edge Cases
[code example from tests]

### Default Values
| Field | Default | Notes |
|-------|---------|-------|
```

**Experimental basis**: In Exp 3, concrete examples significantly improved implementation accuracy over abstract specifications. Sorting requirements and context update asymmetry were only discovered through examples.

### 2.5.4: Step 3 — Type Policy Definition (Complex+)

**Applies when**: Complex (80+) only

Define type hints for all functions/methods and explicitly specify collection type distinction rules.

**Execution method**: Orchestrator extracts type information from source + tests:

```
1. Collect existing type hints
   ast_grep_search(pattern="def $NAME($$$ARGS) -> $RET:", language="python")
   lsp_hover(file, line, character) for inferred types

2. Infer expected types from tests
   Analyze isinstance/type() call patterns
   Infer collection types from assert statements (set vs list vs dict)
   Grep(pattern="isinstance|type\\(", path="tests/")

3. Define type policy
   - Collection type distinction: List (order guaranteed) vs Set (dedup) vs Dict (key-value)
   - Optional rules: use Optional[T] for nullable parameters
   - Return type standardization: consistent return type patterns
   - Prohibited patterns: Any abuse, untyped collections, implicit None
```

**Output**: `.mpl/mpl/phase0/type-policy.md`

```markdown
# Type Policy

## Rules
1. Type hints required for all function parameters
2. Return type required for all functions
3. Use specific types (List[str], Set[int], Dict[str, Any])
4. Express nullable with Optional[T]
5. Prohibited: bare list, dict, set without type parameters

## Type Reference Table
| Field/Parameter | Type | Rationale |
|----------------|------|-----------|
```

**Experimental basis**: In Exp 4, confusion between `Set[str]` and `List[str]` was the primary cause of test failures.

### 2.5.5: Step 4 — Error Specification (All Grades)

**Applies when**: All complexity grades (required — always runs)

Specify standard exception mappings, error message patterns, and trigger conditions.

**Execution method**: Orchestrator extracts error patterns from tests + source:

```
1. Extract exception trigger patterns
   ast_grep_search(pattern="raise $EXC($$$ARGS)", language="python")
   ast_grep_search(pattern="throw new $EXC($$$ARGS)", language="typescript")

2. Extract error validations from tests
   ast_grep_search(pattern="pytest.raises($EXC)", language="python", path="tests/")
   Grep(pattern="with pytest.raises|assertRaises|expect.*toThrow", path="tests/")

3. Extract error message patterns
   Grep(pattern="match=|message=|msg=", path="tests/")
   — preserve regex patterns as-is

4. Analyze validation order
   Check if/raise order in source code — which condition is checked first
```

**Output**: `.mpl/mpl/phase0/error-spec.md`

```markdown
# Error Handling Specification

## [Module] Errors
- Type: [ExceptionType]
- Condition: [trigger condition]
- Message: "[pattern with {placeholders}]"
- Validation order: [priority]

## Prohibited
- Do not create custom exception classes (use standard exceptions only)
- Error messages must exactly match the match pattern in tests
```

**Experimental basis**: In Exp 7, error specification was found to be the "missing puzzle piece." Score jumped from 83% to 100% just by adding the error spec.

### 2.5.6: Phase 0 Output Summary

Summarize all applied step results in `.mpl/mpl/phase0/summary.md`:

```markdown
# Phase 0 Enhanced Summary

## Complexity
- Grade: {grade} (score: {score})
- Breakdown: modules={n}, deps={n}, tests={n}, async={n}

## Applied Steps
- [x/o] Step 1: API Contract Extraction
- [x/o] Step 2: Example Pattern Analysis
- [x/o] Step 3: Type Policy Definition
- [x] Step 4: Error Specification

## Artifacts
| Artifact | Path | Status |
|----------|------|--------|
| API Contracts | `.mpl/mpl/phase0/api-contracts.md` | generated / skipped |
| Examples | `.mpl/mpl/phase0/examples.md` | generated / skipped |
| Type Policy | `.mpl/mpl/phase0/type-policy.md` | generated / skipped |
| Error Spec | `.mpl/mpl/phase0/error-spec.md` | generated |

## Key Findings
[auto-generated key findings]
```

Announce: `[MPL] Phase 0 Enhanced complete. Grade: {grade}. Artifacts: {count}/4 generated. Token budget: {budget}.`

### 2.5.7: Artifact Validation

Automatically validate the quality of Phase 0 artifacts:

```
for each generated artifact:
  validate_artifact(artifact):
    1. Structure check: verify required sections exist
       - api-contracts.md: "## [Module Name]" + "### [Function Name]" sections exist
       - examples.md: "## Pattern" section + code blocks exist
       - type-policy.md: "## Rules" + "## Type Reference Table" sections exist
       - error-spec.md: "## [Module] Errors" section exists
    2. Coverage check: verify functions called in tests are included in contract
       - Extract function call list from tests via ast_grep_search
       - Compare against function list in api-contracts.md
       - Missing rate > 20% → warning
    3. Consistency check: cross-artifact reference consistency
       - types in api-contracts ↔ types in type-policy match
       - exceptions in api-contracts ↔ exceptions in error-spec match

  if validation fails:
    → Report: "[MPL] Phase 0 artifact validation WARNING: {details}"
    → Attempt auto-fix (re-run failed step with narrower focus)
    → Max 1 retry per artifact

Report: "[MPL] Phase 0 validation: {passed}/{total} artifacts validated."
```

### 2.5.8: Cache Save

After Phase 0 execution completes, save results to cache:

```
cache_dir = ".mpl/cache/phase0/"
cache_key = generate_cache_key(codebase_analysis)
commit_hash = git_rev_parse("HEAD")  # used as diff baseline in partial invalidation (F-05)

save_to_cache:
  1. Create cache_dir if not exists
  2. Copy all phase0 artifacts to cache_dir
  3. Write manifest.json:
     {
       "cache_key": cache_key,
       "commit_hash": commit_hash,
       "timestamp": ISO timestamp,
       "complexity_grade": complexity_grade,
       "artifacts": ["api-contracts.md", "examples.md", ...],
       "validation_result": { passed: N, total: M }
     }
  4. Report: "[MPL] Phase 0 artifacts cached. Key: {short_key}."
```

#### 2.5.8 Extension: Cache Save on Partial Re-run (F-05)

After partial re-run completes:
1. Merge reused cache artifacts + newly generated artifacts
2. Generate new cache_key (full hash at current point)
3. Update manifest.json: add partial_rerun_info field
   ```json
   {
     "cache_key": "new_full_hash",
     "commit_hash": "current_HEAD",
     "timestamp": "2026-03-13T...",
     "complexity_grade": "Complex",
     "artifacts": ["api-contracts.md", "examples.md", "type-policy.md", "error-spec.md"],
     "validation_result": { "passed": 4, "total": 4 },
     "partial_rerun": true,
     "rerun_steps": ["examples"],
     "reused_steps": ["api_contracts", "type_policy", "error_spec"],
     "original_cache_key": "previous_hash"
   }
   ```
4. Report: `"[MPL] Partial cache save. Rerun: {rerun_steps}. Reused: {reused_steps}. New key: {short_key}."`

### 2.5.9: Token Profiling (Phase 0)

Record token usage for Phase 0 execution:

```
phase0_profile = {
  "step": "phase0-enhanced",
  "grade": complexity_grade,
  "cache_hit": false,
  "steps_executed": [1, 3, 4],
  "artifacts_generated": 3,
  "validation_passed": 3,
  "estimated_tokens": {
    "complexity_detection": ~500,
    "step1_api_contracts": ~5000,
    "step2_examples": 0,
    "step3_type_policy": ~3000,
    "step4_error_spec": ~3000,
    "validation": ~500,
    "total": ~12000
  },
  "duration_ms": elapsed
}

Append to .mpl/mpl/profile/phases.jsonl
```

---
