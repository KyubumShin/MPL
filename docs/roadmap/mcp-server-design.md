# MPL MCP Server Design Document

> v3.7 — Starting with Ambiguity Scoring from the 2-Stage Interview, progressively migrating core hook logic to MCP tools

## 1. Design Motivation

### Current Problem

MPL's core computation logic is split across two locations:

1. **Hooks** (`mpl-state.mjs`, `mpl-scope-scan.mjs`, etc.): pipeline state, scoring, budget prediction
2. **Agent prompts** (`mpl-ambiguity-resolver.md`): Ambiguity Scoring instructed in the prompt

Problems:
- **Hooks are passive**: Only triggered at hook points. Agents cannot actively ask "what's the current state?"
- **In-prompt scoring is inconsistent**: When LLM assigns scores, the same input produces variance of 0.6~0.8
- **Context waste**: Including scoring logic in prompts consumes agent context

### Ouroboros's Solution

```
Agent (question generation) ←→ MCP Server (state management + scoring)
```

- Interview state: MCP `ouroboros_interview` tool persists to disk
- Ambiguity Score: Python code calls LLM API (temperature 0.1) → parses JSON → calculates weighted average
- Agent focuses only on "questions", MCP handles computation

### MPL Application Principle

```
Agent (orchestration + questions)
  ↕ MCP Tool calls
MPL MCP Server (state management + scoring + analysis)
  ↕ File I/O + LLM API
.mpl/ directory + Anthropic API
```

---

## 2. Architecture

### 2.1 Tech Stack

| Component | Choice | Reason |
|------|------|------|
| Language | TypeScript | Same ecosystem as MPL hooks, official MCP SDK support |
| MCP SDK | `@modelcontextprotocol/sdk` | Official, most mature |
| LLM SDK | `@anthropic-ai/sdk` | For Ambiguity Scoring |
| Runtime | Node.js >= 20 | ES modules, top-level await |
| Transport | stdio | Claude Code standard |

### 2.2 Directory Structure

```
MPL/
├── mcp/                          # MCP server root
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts              # MCP server entrypoint
│   │   ├── tools/
│   │   │   ├── ambiguity.ts      # mpl_score_ambiguity
│   │   │   ├── state.ts          # mpl_state_read, mpl_state_write
│   │   │   ├── triage.ts         # mpl_triage
│   │   │   ├── budget.ts         # mpl_estimate_budget
│   │   │   ├── test-analyzer.ts  # mpl_analyze_tests
│   │   │   └── convergence.ts    # mpl_check_convergence
│   │   ├── lib/
│   │   │   ├── scoring.ts        # Ambiguity score calculation logic
│   │   │   ├── llm.ts            # LLM API call wrapper
│   │   │   └── state.ts          # State file read/write (migrated from hooks/lib)
│   │   └── types.ts              # Shared type definitions
│   └── __tests__/
│       ├── ambiguity.test.ts
│       ├── state.test.ts
│       └── triage.test.ts
├── hooks/                        # Existing Hooks (only those that cannot be migrated to MCP remain)
│   ├── lib/
│   │   ├── mpl-state.mjs         # → migrate to mcp/src/lib/state.ts (hooks call MCP)
│   │   └── ...
│   └── ...
└── ...
```

### 2.3 Claude Code Integration Configuration

`.mcp.json` (MPL plugin root):
```json
{
  "mcpServers": {
    "mpl": {
      "command": "node",
      "args": ["mcp/dist/index.js"],
      "env": {
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

---

## 3. MCP Tool Definitions (9 tools, full v3.7 implementation)

### Full Tool Summary

| # | Tool | Category | Source | Core Role |
|---|------|---------|----------|----------|
| 1 | `mpl_score_ambiguity` | Interview | New (Ouroboros-inspired) | Measure 4-dimensional ambiguity score + LLM scoring |
| 2 | `mpl_state_read` | State | `mpl-state.mjs` | Query pipeline state |
| 3 | `mpl_state_write` | State | `mpl-state.mjs` | Update pipeline state (atomic) |
| 4 | `mpl_triage` | Classification | `mpl-scope-scan.mjs` | Pipeline Score + Tier classification |
| 5 | `mpl_estimate_budget` | Operations | `mpl-budget-predictor.mjs` | Context budget prediction |
| 6 | `mpl_analyze_tests` | Analysis | `mpl-test-analyzer.mjs` | Extract API contracts from test files |
| 7 | `mpl_check_convergence` | Operations | `mpl-state.mjs` | Fix Loop convergence/stagnation/regression judgment |
| 8 | `mpl_extract_assertions` | Verification | New (Ouroboros extractor-inspired) | Automatically decompose AC into 4-Tier SpecAssertions |
| 9 | `mpl_verify_spec` | Verification | New (Ouroboros verifier-inspired) | Verify T1/T2 assertions against source via regex scan ($0) |

> Detailed specs for tools 8 and 9: see `docs/roadmap/test-strategy-redesign.md` section 2.2.

### Tier 1: Interview + State + Classification

#### 3.1 `mpl_score_ambiguity`

**Core tool**: Engine of the Stage 2 metric loop.

```typescript
{
  name: "mpl_score_ambiguity",
  description: "Score ambiguity of current interview state across 4 PP-orthogonal dimensions",
  inputSchema: {
    type: "object",
    properties: {
      conversation_context: {
        type: "string",
        description: "Full context of Stage 1 PP + Stage 2 conversation"
      },
      pivot_points: {
        type: "string",
        description: "List of confirmed PPs (pivot-points.md content)"
      },
      provided_specs: {
        type: "string",
        description: "Provided spec/documentation content (if any)"
      },
      cwd: {
        type: "string",
        description: "Project working directory"
      }
    },
    required: ["conversation_context", "pivot_points", "cwd"]
  }
}
```

**Return value:**
```json
{
  "ambiguity_score": 0.41,
  "clarity_percent": 59,
  "is_ready": false,
  "threshold": 0.20,
  "dimensions": {
    "spec_completeness":     { "score": 0.70, "weight": 0.35, "justification": "..." },
    "edge_case_coverage":    { "score": 0.50, "weight": 0.25, "justification": "..." },
    "technical_decision":    { "score": 0.40, "weight": 0.25, "justification": "..." },
    "acceptance_testability": { "score": 0.80, "weight": 0.15, "justification": "..." }
  },
  "weakest_dimension": "technical_decision",
  "suggested_questions": [
    "State management library selection is undecided. Is there a preference between Zustand vs Jotai vs Redux Toolkit?"
  ]
}
```

**Internal logic** (Ouroboros `ambiguity.py` pattern):
```typescript
// 1. LLM API call (temperature 0.1, reproducibility)
const response = await anthropic.messages.create({
  model: "claude-sonnet-4-20250514",  // sonnet is sufficient for scoring
  temperature: 0.1,
  max_tokens: 2048,
  system: SCORING_SYSTEM_PROMPT,  // 4-dimensional scoring instructions
  messages: [{ role: "user", content: scoringUserPrompt }]
});

// 2. JSON parsing + retry
const breakdown = parseScoreResponse(response.content);

// 3. Weighted average calculation (in code, not LLM)
const clarity = dimensions.reduce((sum, d) => sum + d.score * d.weight, 0);
const ambiguity = Math.round((1 - clarity) * 10000) / 10000;

// 4. Derive weakest dimension + question suggestions
const weakest = dimensions.sort((a, b) => a.score - b.score)[0];
```

**Scoring System Prompt:**
```
You are an expert requirements analyst. Evaluate the clarity of implementation requirements.

The project has these Pivot Points (immutable constraints):
{pivot_points}

Evaluate FOUR dimensions (orthogonal to Pivot Points):

1. Spec Completeness (35%): Is there enough information to implement? Are key details specified?
2. Edge Case Coverage (25%): Are error states, boundary conditions, and exception flows defined?
3. Technical Decision (25%): Are technology choices and architecture decisions explicit?
4. Acceptance Testability (15%): Can completion be verified with automated tests?

Score each from 0.0 (completely unclear) to 1.0 (perfectly clear).
Scores above 0.8 require very specific, measurable specifications.

RESPOND ONLY WITH VALID JSON:
{
  "spec_completeness_score": 0.0,
  "spec_completeness_justification": "string",
  "edge_case_score": 0.0,
  "edge_case_justification": "string",
  "technical_decision_score": 0.0,
  "technical_decision_justification": "string",
  "testability_score": 0.0,
  "testability_justification": "string"
}
```

#### 3.2 `mpl_state_read`

```typescript
{
  name: "mpl_state_read",
  description: "Read current MPL pipeline state",
  inputSchema: {
    properties: {
      cwd: { type: "string", description: "Project working directory" },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Query specific fields only (empty = all)"
      }
    },
    required: ["cwd"]
  }
}
```

Migration of `readState()` from existing `hooks/lib/mpl-state.mjs`.

#### 3.3 `mpl_state_write`

```typescript
{
  name: "mpl_state_write",
  description: "Update MPL pipeline state (merge patch)",
  inputSchema: {
    properties: {
      cwd: { type: "string", description: "Project working directory" },
      patch: { type: "object", description: "State fields to merge" }
    },
    required: ["cwd", "patch"]
  }
}
```

Migration of existing `writeState()`. Atomic write (temp + rename) preserved.

#### 3.4 `mpl_triage`

```typescript
{
  name: "mpl_triage",
  description: "Quick scope scan: calculate pipeline score and classify tier",
  inputSchema: {
    properties: {
      cwd: { type: "string" },
      prompt: { type: "string", description: "User prompt" },
      affected_files: { type: "number" },
      test_scenarios: { type: "number" },
      import_depth: { type: "number" }
    },
    required: ["cwd", "prompt"]
  }
}
```

Integration of `calculatePipelineScore()` + `classifyTier()` + `extractRiskSignal()` from existing `mpl-scope-scan.mjs`.

### Tier 2: Pipeline Operations Tools

#### 3.5 `mpl_estimate_budget`

```typescript
{
  name: "mpl_estimate_budget",
  description: "Predict whether remaining phases fit in context window budget",
  inputSchema: {
    properties: {
      cwd: { type: "string" }
    },
    required: ["cwd"]
  }
}
```

**Return value:**
```json
{
  "can_continue": true,
  "remaining_pct": 45.2,
  "estimated_needed_pct": 32.1,
  "remaining_phases": 3,
  "avg_tokens_per_phase": 15000,
  "recommendation": "continue",
  "breakdown": {
    "total_tokens": 200000,
    "used_tokens": 109600,
    "remaining_tokens": 90400,
    "completed_phases": 4,
    "total_phases": 7,
    "safety_margin": 1.15
  }
}
```

**Internal logic** (migration of existing `mpl-budget-predictor.mjs`):
```typescript
// 1. Read current usage from .mpl/context-usage.json
const usage = readContextUsage(cwd);

// 2. Calculate average Phase tokens from .mpl/mpl/profile/phases.jsonl
const avgPerPhase = readAvgTokensPerPhase(cwd);

// 3. Get total Phase count from .mpl/mpl/decomposition.yaml
const totalPhases = readTotalPhases(cwd);
const completedPhases = readCompletedPhases(cwd);
const remainingPhases = totalPhases - completedPhases;

// 4. Prediction: remaining Phases × avg tokens × safety margin (1.15)
const estimatedNeeded = remainingPhases * avgPerPhase * SAFETY_MARGIN;

// 5. Judgment
if (remainingPct < 10) → "pause_now"
elif (estimatedNeeded > remainingTokens) → "pause_after_current"
else → "continue"
```

**Agent usage scenarios:**
- Before Phase execution: call `mpl_estimate_budget` → notify user if `pause_after_current`
- Currently only manually checked in Hook → MCP allows agents to **proactively** check budget

#### 3.6 `mpl_analyze_tests`

```typescript
{
  name: "mpl_analyze_tests",
  description: "Extract API contracts from test files (function calls, exceptions, assertions, fixtures)",
  inputSchema: {
    properties: {
      cwd: { type: "string" },
      test_path: {
        type: "string",
        description: "Test file or directory path (relative/absolute)"
      },
      pattern: {
        type: "string",
        description: "Filename prefix filter (default: 'test_')"
      }
    },
    required: ["cwd", "test_path"]
  }
}
```

**Return value:**
```json
{
  "files_analyzed": 3,
  "contracts": [
    {
      "file": "tests/test_auth.py",
      "calls": [
        { "name": "login", "argCount": 2, "kwargs": ["remember_me"], "line": 15 },
        { "name": "validate_token", "argCount": 1, "kwargs": [], "line": 28 }
      ],
      "exceptions": [
        { "exceptionType": "AuthError", "matchPattern": "invalid credentials", "line": 35 }
      ],
      "asserts": [
        { "assertion": "response.status_code == 200", "operator": "==", "line": 18 },
        { "assertion": "token in response.headers", "operator": "in", "line": 30 }
      ],
      "fixtures": [
        { "name": "auth_client", "params": ["db_session"], "line": 5 }
      ]
    }
  ],
  "summary": {
    "total_calls": 12,
    "total_exceptions": 3,
    "total_asserts": 25,
    "total_fixtures": 4,
    "unique_functions": ["login", "validate_token", "create_user", "..."]
  },
  "contracts_md": "# API Contract Specification (Auto-Generated)\n..."
}
```

**Internal logic** (migration of existing `mpl-test-analyzer.mjs`):
```typescript
// Regex-based parsing (no external AST dependencies)
// 1. Extract function calls: name, argCount, kwargs
// 2. pytest.raises blocks: exceptionType, matchPattern
// 3. assert statements: assertion expression, comparison operator
// 4. pytest.fixture: name, dependencies
// 5. Auto-generate Markdown contract
```

**Agent usage scenarios:**
- Called when performing API Contract Extraction (Step 1) in Phase 0 Enhanced
- Currently: agent directly reads test files and parses patterns → context waste
- MCP: single `mpl_analyze_tests` call → returns structured contracts + markdown → agent uses only the result

#### 3.7 `mpl_check_convergence`

```typescript
{
  name: "mpl_check_convergence",
  description: "Check fix loop convergence: improving, stagnating, or regressing with strategy suggestions",
  inputSchema: {
    properties: {
      cwd: { type: "string" }
    },
    required: ["cwd"]
  }
}
```

**Return value:**
```json
{
  "status": "stagnating",
  "delta": 0.02,
  "pass_rate_history": [0.65, 0.67, 0.68, 0.68],
  "current_pass_rate": 0.68,
  "fix_loop_count": 4,
  "max_fix_loops": 10,
  "suggestion": "Fix loop is not making progress. Try a different strategy: change implementation approach or consult Phase 0 artifacts.",
  "variance": 0.0002,
  "should_escalate": false,
  "should_circuit_break": true
}
```

**Internal logic** (extension of existing `checkConvergence()` from `mpl-state.mjs`):
```typescript
// 1. Read convergence.pass_rate_history from state.json
// 2. Analyze latest N entries (stagnation_window)
//    - Improving: delta >= min_improvement (0.05)
//    - Stagnating: variance < 0.0025 AND delta < min_improvement
//    - Regressing: delta < regression_threshold (-0.10)
// 3. Additional judgments (extended in MCP):
//    - should_escalate: stagnating + fix_loop_count > max/2 → suggest tier escalation
//    - should_circuit_break: regression OR (stagnating AND fix_loop_count > max*0.7) → suggest abort
// 4. Generate strategy suggestion
```

**Agent usage scenarios:**
- Before each Fix Loop iteration: call `mpl_check_convergence`
- If `should_circuit_break == true`, agent immediately changes strategy or consults user
- Currently: Hook checks at PostToolUse point → agent receives result indirectly
- MCP: agent proactively calls → uses directly in decision-making

---

## 4. Migration Strategy

### Batch Implementation (v3.7)

```
v3.7: Create MCP server + implement all of Tier 1 + Tier 2 (7 tools)
      Keep existing hooks running in parallel

      Tier 1 (Interview + State + Classification):
        mpl_score_ambiguity, mpl_state_read, mpl_state_write, mpl_triage

      Tier 2 (Operations + Analysis):
        mpl_estimate_budget, mpl_analyze_tests, mpl_check_convergence

v3.8: Convert hooks to thin wrappers
      Replace hooks/lib/ logic with MCP imports
      Hooks handle event triggers + MCP call proxy only
```

### Coexistence with Hooks

Hooks that **cannot** be migrated to MCP (kept as-is):

| Hook | Reason |
|------|------|
| `mpl-write-guard.mjs` | Must block at PreToolUse point — impossible with MCP call timing |
| `mpl-hud.mjs` | StatusLine is a hook-exclusive feature |
| `mpl-keyword-detector.mjs` | Activate pipeline at UserPromptSubmit point |
| `mpl-auto-permit.mjs` | Permission hook |
| `mpl-session-init.mjs` | Session init hook |
| `mpl-compaction-tracker.mjs` | Notification hook |

Hooks that **can** be migrated to MCP (converted to thin wrappers in v3.8):

| Hook | Current Role | After MCP Migration |
|------|----------|-------------|
| `mpl-phase-controller.mjs` | State read/write + escalation | Call `mpl_state_read/write` |
| `mpl-validate-output.mjs` | Agent output validation | Validation logic in MCP, Hook is trigger only |

### Code Reuse

Existing `hooks/lib/` → TypeScript conversion to `mcp/src/lib/`:

| Source | Target | Conversion |
|------|----------|----------|
| `mpl-state.mjs` | `mcp/src/lib/state.ts` | Add types + export |
| `mpl-scope-scan.mjs` | `mcp/src/tools/triage.ts` | Add types |
| `mpl-budget-predictor.mjs` | `mcp/src/tools/budget.ts` | Add types |
| `mpl-test-analyzer.mjs` | `mcp/src/tools/test-analyzer.ts` | Add types |

---

## 5. mpl-ambiguity-resolver Agent Changes

After MCP introduction, the Stage 2 agent's Socratic Loop is simplified:

### Before (current v3.7)

```
Agent directly:
1. Analyze conversation context
2. Calculate 4-dimensional score (instructed via prompt)
3. Calculate weighted average
4. Identify weakest dimension
5. Generate questions
6. Collect user responses
7. Repeat 1~6
```

### After (with MCP)

```
Agent:
1. Call mpl_score_ambiguity(context, PPs)
2. Check weakest_dimension + suggested_questions from result
3. Generate questions (reference suggested_questions but adjust to context)
4. Collect user responses
5. Repeat 1~4 (until is_ready == true)
```

Most scoring-related sections can be removed from the agent prompt.
Agent focuses only on "crafting good questions."

---

## 6. Cost Analysis

### mpl_score_ambiguity cost per call

| Item | Estimate |
|------|------|
| LLM input | ~1,500 tokens (scoring prompt + context summary) |
| LLM output | ~300 tokens (JSON) |
| Model | claude-sonnet-4 (most cost-efficient) |
| Cost/call | ~$0.006 |
| Loop average | 3~5 calls → ~$0.02~0.03/interview |

Same as Ouroboros: **use Sonnet exclusively for scoring**, keep interview agent on Opus.
This ensures both scoring consistency (temperature 0.1) and cost efficiency.

---

## 7. Test Strategy

```
Unit Tests:
  - scoring.ts: weighted average calculation, JSON parsing, retry logic
  - state.ts: read/write, atomic write, deep merge
  - triage.ts: pipeline score calculation, tier classification

Integration Tests:
  - Start MCP server → call tool → validate response
  - Scoring E2E with LLM API mock

Manual Validation:
  - Call mpl_score_ambiguity in a real interview session → observe score changes
  - Compare same results as existing hooks (state, triage)
```
