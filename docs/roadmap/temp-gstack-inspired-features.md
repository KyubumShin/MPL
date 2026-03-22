# MPL Roadmap TEMP: Undecided Feature Candidates

> **Status**: Undecided (for review)
> **Sources**: gstack analysis (2026-03-22), Ouroboros patterns, MPL internal audit
> **Purpose**: Consolidate all undecided/incomplete features in one place for review. Separate into individual design documents when confirmed.

---

## Carried Over from Existing Roadmap (Incomplete Items)

Items migrated from `roadmap/overview.md` that were not fully implemented in v3.7.

| ID | Feature | Previous Status | Remaining Work | Priority |
|----|---------|----------------|---------------|----------|
| F-06 | Multi-Project Support | Not implemented | Independent pipeline per project in monorepo. Requires `.mpl/` scoping strategy per workspace root | 🟡 Low |
| F-31 | ~~Compaction-Aware Context Recovery~~ | ✅ **v3.8 complete** | Write-side (PreCompact hook) + Read-side (Context Assembly Case 2 + Phase Runner injection + Step 6 resume). Full write→read loop complete | ✅ Done |
| F-33 | ~~Session Budget Prediction & Auto-Continue~~ | ✅ **v3.9 complete** | predictBudget + writeSessionHandoff + Step 4.8 Graceful Pause + watcher docs. Full predict→pause→signal→resume loop | ✅ Done |
| F-269 | RUNBOOK as docs/documentation.md | ❌ Not implemented | 4-Document mapping Axis 1: RUNBOOK.md exists but doesn't match Codex `docs/documentation.md` spec. Audit log + cross-session continuity format needs alignment | 🟡 Low |

### F-31: Compaction-Aware Context Recovery — Remaining Details

```
Current state:
  ✅ PreCompact hook → writes .mpl/mpl/checkpoints/compaction-{N}.md
  ✅ Warn at compaction_count == 3, recommend reset at 4+
  ✅ F-32 Adaptive Context Loading (3-way branch)

Missing:
  ❌ Orchestrator resume path: on session start, if checkpoint exists:
     1. Read latest checkpoint
     2. Determine current_phase from checkpoint
     3. Load Phase Decision + State Summary from checkpoint
     4. Re-enter Step 4 at correct phase
  ❌ Checkpoint → Step 4 handoff specification
  ❌ Integration test: simulate compaction → resume → verify phase continuity
```

### F-33: Session Budget Prediction — Remaining Details

```
Current state:
  ✅ hooks/lib/mpl-budget-predictor.mjs (budget prediction logic)
  ✅ HUD bridge (context-usage.json recording)
  ✅ Orchestrator command (Step 4.8 Graceful Pause Protocol)

Missing:
  ❌ mpl-session-watcher.sh (external process that monitors handoff signal)
  ❌ hooks.json registration for the watcher
  ❌ End-to-end test: budget → pause → handoff → new session → resume
  ❌ Integration with F-38 Auto Context Rotation (potential overlap/conflict)
```

---

## New Feature Candidates

### Source: gstack analysis (2026-03-22)

## Introduction Candidate Summary

| # | Feature | Inspiration source | Priority | Expected difficulty | Expected token cost |
|---|---------|-------------------|----------|--------------------|--------------------|
| T-01 | ~~Safety Guard enhancement~~ | `/careful`, `/freeze` | ✅ **v3.8 done** | Low (hook extension) | 0 (hook only) |
| T-02 | Cross-Model Review | `/codex` | 🔴 Immediate | Medium (API integration) | ~5-10K/review |
| T-03 | ~~Browser QA Gate (Claude in Chrome)~~ | `/qa` + Chrome MCP | ✅ **v4.0 done** | Medium (MCP integration) | ~5-8K |
| T-04 | ~~Ship Step (PR Creation only)~~ | `/ship` | ✅ **v4.0 done** | Low (git-master extension) | ~2-3K |
| T-05 | Design Contract | `/design-consultation`, `/design-review` | 🟡 Long-term | Medium | ~8-12K |
| T-06 | Doc Sync | `/document-release` | 🟡 Long-term | Low | ~3-5K |
| T-07 | Premise Challenge Mode | `/office-hours` | 🟢 Optional | Low | ~2K |
| T-08 | Trend Retro | `/retro` | 🟢 Optional | Low | ~3K |
| T-09 | Performance Gate | `/benchmark` | 🟢 Optional | Medium | Variable |
| T-10 | ~~Post-Execution Review (Step 5.5)~~ | Ouroboros `/evaluate` | ✅ **v3.9 done** | Low (finalize extension) | ~3-5K |
| T-11 | ~~Feasibility Check — 2-Layer Defense~~ | Ouroboros interview→seed loop | ✅ **v4.0 done** | Medium (existing extension) | ~1-2K (L1) + 0 (L2) |
| T-12 | ~~Core-First Phase Ordering~~ | MVP-first strategy | ✅ **v3.8 done** | Low (decomposer prompt) | 0 (prompt only) |
| M-01 | ~~MCP Server Tier 1 (Score + State)~~ | Ouroboros MCP pattern | ✅ **v4.1 done** | High (new server) | Saves ~3-5K/run |

---

## T-01: Safety Guard Enhancement

### Inspiration
gstack `/careful` — Warning before destructive commands (rm -rf, DROP TABLE, git push --force, kubectl delete).
gstack `/freeze` — Block file modifications outside specified directories.

### Current MPL State
- `mpl-write-guard` hook only warns for orchestrator's Edit/Write
- Worker agent's dangerous Bash commands are unprotected
- File scope isolation between phases is soft (specified in decomposition.yaml but not enforced)

### Proposal
1. **Dangerous Command Detection** — extend `mpl-write-guard`
   - Detection patterns: `rm -rf`, `git push --force`, `DROP TABLE`, `TRUNCATE`, `kubectl delete`, `docker rm -f`
   - Worker's Bash calls also intercepted in PreToolUse
   - Allow list: `rm -rf node_modules`, `rm -rf .next`, `rm -rf dist` and other common cleanups

2. **Phase-Scoped File Lock** — enforce per-phase file scope from decomposition.yaml
   - When Phase N runs, modification attempts outside that phase's `produces` files → warning + confirmation request
   - Benefit: Prevents unintended side-effects between phases (strengthens MPL's isolation principle)

### Implementation Location
- Extend `MPL/hooks/mpl-write-guard.mjs`
- New pattern file: `MPL/hooks/lib/dangerous-patterns.mjs`

### Open Questions
- [ ] Should worker's Bash be fully blocked or warning only?
- [ ] Apply Phase-Scoped Lock in Frugal tier too?
- [ ] Allow per-project customization of the allow list?

---

## T-02: Cross-Model Review (Gate 2 Enhancement)

### Inspiration
gstack `/codex` — Independent code review with OpenAI Codex. 3 modes: gate (block), adversarial (challenge), consultation.

### Current MPL State
- `mpl-code-reviewer` (sonnet) single-model 10-category review
- Potential blind spots from using the same model
- "Code author ≠ test author" principle exists, but "reviewer ≠ same model family" does not

### Proposal
1. **Gate 2-B: Cross-Model Review** (optional, activated via config)
   - Create new `mpl-cross-reviewer` agent
   - Request independent review via OpenAI API or Gemini API
   - Compare two review results:
     - Issues flagged by both → auto-fix (high confidence)
     - Flagged by only one → present to user
     - Conflicting opinions → compare rationale then user judgment

2. **Adversarial Mode** — Frontier tier only
   - "Devil's advocate" review that intentionally attacks Phase 0 spec
   - Focus on edge cases, security vulnerabilities, performance traps

### Implementation Location
- New agent: `MPL/agents/mpl-cross-reviewer.md`
- Gate 2 extension: `MPL/docs/design.md` Gate 2 section
- Config: `.mpl/config.json` → `cross_model_review: { enabled: false, provider: "openai" }`

### Open Questions
- [ ] API key management? (env vars vs .mpl/config.json vs separate secret)
- [ ] Default between OpenAI/Gemini?
- [ ] Token cost limit? (max $0.50 per review, etc.)
- [ ] Available in Standard tier too, or Frontier only?

---

## T-03: Browser QA Gate (Claude in Chrome)

### Inspiration
gstack `/qa` — Real browser testing with Chromium daemon + Playwright. Screenshot capture, accessibility tree snapshots, automatic regression test generation.

### Previous Approach (Rejected)
Playwright integration was initially considered but rejected due to:
- High dependency overhead (`npx playwright install chromium`)
- Cookie import complexity for authenticated pages (gstack requires macOS Keychain)
- No Standalone compatibility
- Daemon process management complexity

### Revised Approach: Claude in Chrome MCP
Use the existing Claude in Chrome MCP server (`mcp__claude-in-chrome__*`) as the browser automation layer. This eliminates external dependencies and leverages the user's actual authenticated browser session.

### Current MPL State
- Gate 1 covers only unit/integration tests
- "Actual browser behavior verification" impossible for UI tasks
- Verification Planner's H-items end with "human manual verification"
- Claude in Chrome MCP is already available as a configured MCP server

### Proposal

**Gate 1.7: Visual Verification** (UI tasks only, Claude in Chrome MCP required)

```
Precondition:
  - Check mcp__claude-in-chrome server is active
  - If inactive → Gate 1.7 = SKIP (log reason, non-blocking)

Process:
  1. tabs_context_mcp → get current tab state
  2. tabs_create_mcp → open dev server URL in new tab
  3. read_page (accessibility mode) → accessibility tree snapshot
  4. read_console_messages → confirm 0 console errors
  5. find → verify core UI elements from Phase 0 spec exist
  6. computer (screenshot) → save visual snapshot
  7. gif_creator → record interaction flow (optional, Frontier only)

Output:
  - QA report: pass/fail per check item
  - Screenshots: .mpl/qa/phase-N/
  - Console errors: list with severity
  - Accessibility issues: list with WCAG level

Fail criteria:
  - Console errors > 0 → Gate FAIL
  - Core UI elements missing → Gate FAIL
  - Accessibility violations → Gate WARNING (defer to T-10 Post-Exec Review)
```

**Advantages over Playwright approach:**

| Aspect | Playwright | Claude in Chrome |
|--------|-----------|-----------------|
| Authentication | Cookie decrypt needed (macOS only) | Already logged in via user's Chrome |
| Code generation | Playwright test code needed | MCP tool calls only (no code) |
| Element selection | Custom ref system required | `find` tool handles it |
| Cross-platform | macOS cookie limitation | Chrome available everywhere |
| Maintenance | Daemon process management | MCP server manages lifecycle |
| Cost | Playwright runtime + test code tokens | MCP call tokens only (~5-8K) |

**mpl-qa-agent** (sonnet)
- Input: URL + Phase 0 UI spec + MCP tool access
- Output: QA report (pass/fail + screenshots + discovered issues)
- Add 'B (Browser)' category to A/S/H classification
- Agent uses `mcp__claude-in-chrome__*` tools directly

### Implementation Location
- New agent: `MPL/agents/mpl-qa-agent.md`
- Gate extension: design.md Gate 1.7 section
- QA artifacts: `.mpl/qa/` directory
- Doctor check: add Chrome MCP availability to `mpl-doctor`

### Dependencies
- Claude in Chrome MCP server must be configured and active
- Graceful skip when MCP server is unavailable (non-blocking)
- Dev server must be running (or auto-start detected from package.json scripts)

### Limitations
- CI environment: Chrome MCP not available → Gate 1.7 auto-skips
- MCP connection instability: 2-3 retries, then SKIP + log
- Alert/dialog blocking: `javascript_tool` pre-dismisses before interaction
- No regression test generation (unlike Playwright approach) — deferred to future

### Open Questions
- [ ] Screenshot storage: `.mpl/qa/` (persistent) vs temp (ephemeral)?
- [ ] Fully skip in Frugal/Standard? Or console error check only (lightweight)?
- [ ] Add Chrome MCP requirement to `mpl-setup` wizard?
- [ ] How to detect and auto-start dev server? (parse `package.json` scripts?)

---

## T-04: Ship Step (PR Creation Only)

### Inspiration
gstack `/ship` — Sync main → test → coverage audit → open PR.

### Descoped
CI/CD monitoring (`land-and-deploy`) and post-deploy health checks (`canary`) are **intentionally excluded**. CI/CD pipelines vary too much across projects (GitHub Actions, GitLab CI, Jenkins, CircleCI, ArgoCD, etc.) to provide a universal solution. Users should configure their own CI/CD — MPL's job ends at delivering verified, committed code with a PR.

### Current MPL State
- `mpl-git-master` handles atomic commits only
- PR creation is user's responsibility after pipeline completion
- No structured PR body with Gate pass evidence

### Proposal
**Step 5.4b: PR Creation** — optional, inserted after atomic commits (Step 5.3)

```
Process:
  1. Detect base branch (main/master/develop) from git config
  2. Create feature branch from current commits (if not already on one)
  3. Generate PR body:
     - Summary: what was built (from PP + decomposition)
     - Gate results: pass/fail for each gate
     - Coverage delta: before vs after
     - Files changed: grouped by phase
     - Deferred items: from T-10 Post-Exec Review (if any)
  4. Open PR via `gh pr create`

Output:
  - PR URL logged to RUNBOOK
  - PR body includes machine-readable Gate evidence
```

**What MPL does NOT do:**
- ❌ CI monitoring or polling
- ❌ Deploy to any platform
- ❌ Post-deploy health checks
- ❌ Merge the PR (user decision)

### Implementation Location
- Extend `mpl-git-master` agent or create lightweight `mpl-pr-agent` (haiku)
- Step 5.4b in `MPL/commands/mpl-run-finalize.md`
- Config: `.mpl/config.json` → `auto_pr: { enabled: false, base_branch: "auto" }`

### Open Questions
- [ ] Extend `mpl-git-master` or separate `mpl-pr-agent`?
- [ ] Auto-detect base branch or require config?
- [ ] Include Gate evidence as collapsible markdown or plain list?
- [ ] Skip in Frugal tier? (single commit → PR may be overkill)

---

## T-05: Design Contract (Phase 0 Extension)

### Inspiration
gstack `/design-consultation` — Research → mockup → DESIGN.md + CLAUDE.md update.
gstack `/design-review` — 80-item design audit, CSS-only atomic commit.

### Current MPL State
- `ui/` domain in prompt templates (React, Vue, Svelte, Web Components)
- No UI-dedicated analysis step in Phase 0
- No design system specification capability

### Proposal
1. **Phase 0 Step 0: Design Contract** (auto-activated when UI task detected)
   - Analyze typography, color palette, spacing scale, component library
   - Reference existing DESIGN.md if present, or suggest creating one
   - Produce "Design Contract" equivalent to Phase 0's API Contract

2. **Gate 2-C: Design Audit** (UI tasks only)
   - Accessibility (a11y), responsive, interaction states, design system compliance
   - Score-based (0-10) + minimum standard (e.g., 6/10 or above)

### Implementation Location
- Phase 0 extension: design.md Step 0 section
- New agent: `mpl-design-agent.md` (sonnet, temp 0.7)
- Output: `.mpl/mpl/phase0/design-contract.md`

### Open Questions
- [ ] Auto-detection criteria for UI tasks? (file extension? prompt keywords? both?)
- [ ] Design token format? (CSS custom properties vs Tailwind config vs JSON)
- [ ] Auto-recognize existing design systems (Material, Ant, Chakra, etc.)?
- [ ] Intensity adjustment by maturity_mode? (explore: skip, standard: recommended, strict: required)

---

## T-06: Doc Sync (Phase 5 Extension)

### Inspiration
gstack `/document-release` — Auto-detect affected documents relative to code diff → update.

### Current MPL State
- `mpl-compound` extracts learnings/decisions/issues to `.mpl/memory/`
- README, CHANGELOG, API docs and other project document updates are manual

### Proposal
**Phase 5 Step 5-B: Doc Sync**
- Scan full diff → generate list of affected document files
- `mpl-doc-agent` (haiku) — generate draft reflecting changes
- Commit after user confirmation

### Implementation Location
- Phase 5 extension: design.md
- New agent: `mpl-doc-agent.md` (haiku)
- Document mapping: `.mpl/config.json` → `doc_sync: { files: ["README.md", "CHANGELOG.md"] }`

### Open Questions
- [ ] Auto-detect CHANGELOG format? (Keep a Changelog, Conventional Changelog, etc.)
- [ ] Auto-generate API docs? (Update OpenAPI spec, etc.)
- [ ] Works in Frugal tier too? (cost is minimal since it's haiku)

---

## T-07: Premise Challenge Mode (PP Interview Extension)

### Inspiration
gstack `/office-hours` — Premise challenge that "directly pokes at uncomfortable places". Extracts 5-10 hidden possibilities from what the user said.

### Current MPL State
- `mpl-interviewer` conducts 4-round Socratic interview
- `mpl-ambiguity-resolver` resolves ambiguity score to 0.3 or below
- However, no mode to "challenge the user's premises themselves"

### Proposal
- Add `challenge_mode: true` option to `mpl-interviewer`
- When activated, add 1 round: "What if this problem were solved in a completely different way?"
- Default off in config.json (no change to existing workflow)

### Open Questions
- [ ] Auto-activation condition? (only for large-scope tasks?)
- [ ] Allow user to "skip"?
- [ ] Apply only when interview_depth: full?

---

## T-08: Trend Retro (Multi-Run Retrospective)

### Inspiration
gstack `/retro` — Weekly retrospective, per-contributor breakdown, trend analysis.

### Current MPL State
- Per-run learnings accumulated in `.mpl/memory/learnings.md`
- Token/time metrics accumulated in `.mpl/mpl/profile/phases.jsonl`
- No functionality to analyze this data

### Proposal
- Create new `/mpl:mpl-retro` skill
- Aggregate `.mpl/memory/` + `.mpl/mpl/profile/` data
- Output: repeated patterns, frequently failing Gates, average token efficiency, improvement trends

### Open Questions
- [ ] Time period basis? (recent N executions? date range?)
- [ ] Cross-project comparison feature?
- [ ] Visualization? (terminal chart? markdown table?)

---

## T-09: Performance Gate (Gate 1.5 Extension)

### Inspiration
gstack `/benchmark` — Core Web Vitals baseline + bundle size regression detection.

### Current MPL State
- Gate 1.5 has only coverage metrics
- No performance metrics (bundle size, build time, LCP/FID/CLS)

### Proposal
- Add optional `performance_check` to Gate 1.5
- Per-project config: `.mpl/config.json` → `performance: { bundle_limit: "500KB", ... }`
- Store baseline: `.mpl/baselines/performance.json`
- Regression detection: current values vs baseline comparison

### Open Questions
- [ ] Auto-detect per-framework bundle analysis tools? (webpack-bundle-analyzer, vite, etc.)
- [ ] Auto-baseline update frequency?
- [ ] Performance criteria for non-web projects (API, CLI, etc.)?

---

## T-10: Post-Execution Review Step (Step 5.5)

### Inspiration
Ouroboros `/evaluate` — Three-stage verification pipeline that evaluates execution results after completion. Reports improvement directions and additional suggestions rather than blocking execution.

### Current MPL State
- Gate 3 H-items block execution until resolved by user
- Step 5.0 runs Final Side Interview for unconsumed H-items
- Minor issues (non-PP-violating discoveries, low-severity H-items) still require human attention mid-pipeline
- No structured "post-mortem review" step that aggregates minor findings

### Proposal
**Step 5.5: Post-Execution Review** — inserted between Step 5.1 (Final Verification) and Step 5.2 (Learning Extraction)

```
Input: All deferred items accumulated during execution
  - Auto-deferred H-items (non-critical)
  - Low/MED discoveries that didn't conflict with PP
  - Gate 2 NEEDS_FIXES items that were auto-resolved
  - Convergence Detection strategy changes

Output: Structured review report with 3 sections:
  1. "Worth Reviewing" — items where human judgment adds value
  2. "Improvement Directions" — patterns for next iteration
  3. "Auto-Resolved Summary" — decisions made autonomously (for transparency)
```

**Key behavioral change:**
- Gate 3 H-items: no longer block. Collected as `deferred_h_items` and presented in Step 5.5
- Minor discoveries: auto-resolved with PP-first policy, logged for review
- Step 5.0 Final Side Interview: **removed** (absorbed into Step 5.5)
- User reviews once at the end, not multiple times mid-pipeline

**What stays blocking (critical):**
- PP conflicts (CONFIRMED PP violated) → still HITL
- PD Override requests → still HITL
- CRITICAL discoveries → still Side Interview

### Implementation Location
- Step 5.5 in `MPL/commands/mpl-run-finalize.md`
- New section in design.md between Step 5.1 and 5.2
- Modify Gate 3 in `mpl-run-execute.md`: H-items → defer instead of block

### Open Questions
- [ ] Should review report be interactive (`AskUserQuestion` per item) or static (markdown report)?
- [ ] Include actionable "Fix this in next run" suggestions?
- [ ] How to handle user who ignores the review? (e.g., auto-create follow-up tasks?)

---

## T-11: Feasibility Check — 2-Layer Defense (Redesigned)

### Inspiration
Ouroboros interview → seed generation flow — After interview achieves clarity threshold (ambiguity ≤ 0.2), the seed generator may still fail if the specification is infeasible. In that case, the system returns to interview with specific questions about the infeasibility.

### Previous Approach (Rejected)
Separate Step 2.7 after Phase 0 Enhanced was rejected because:
- Phase 0 tokens (8-25K) are already consumed before feasibility is checked
- Duplicates Phase 0's complexity scoring and Decomposer's risk_assessment
- Adds another pipeline step, increasing orchestration overhead

### Redesigned Approach: 2-Layer Defense (Direction C)

**Key insight**: "Ambiguity ≤ 0.2" means "we understand what to build" but not "we can build it". This gap must be bridged at the **earliest possible point** — during the interview itself, not after Phase 0.

#### Layer 1 (Primary): Stage 2 PP Conformance Check Extension

Extend the existing PP Conformance Check (Step 1.5 in `mpl-ambiguity-resolver`) to include technical feasibility. The Ambiguity Resolver already has Read/Glob/Grep permissions for codebase exploration.

```
Current PP Conformance Check classifications:
  AUTO_RESOLVED  — PP uniquely determines implementation
  NARROWED       — Choices reduced by PP + context
  NEEDS_INPUT    — Cannot determine from PP alone
  PP_CONFLICT    — Choice conflicts with PP

NEW classification (T-11):
  INFEASIBLE     — PP-conformant but technically impossible or impractical

INFEASIBLE detection process:
  for each PP + derived implementation choice:
    1. API Availability Check:
       - Grep/Glob for required modules, functions, endpoints in codebase
       - Check package.json/requirements.txt for required dependencies
       - Flag: "PP-N requires {API} but it doesn't exist in codebase or dependencies"

    2. Constraint Compatibility Check:
       - Cross-validate PP pairs for mutual satisfiability
       - Flag: "PP-1 requires <10ms response but PP-3 mandates ORM usage (est. ~50ms)"

    3. Tech Stack Viability Check:
       - Compare PP requirements against detected tech stack (from codebase analysis)
       - Flag: "PP requires Server Components but project uses React 17 (no RSC support)"

    4. Scope Estimation:
       - Rough file count × complexity estimate from codebase patterns
       - Flag: "Estimated 50+ files affected, may exceed single-session capacity"
```

**When INFEASIBLE is detected:**

```
Impact on scoring:
  - PP Conformance dimension score drops (same as PP_CONFLICT)
  - INFEASIBLE items are harder to resolve than PP_CONFLICT
    (PP_CONFLICT = wrong choice, fixable; INFEASIBLE = constraint itself is problematic)

Socratic Loop generates feasibility questions:
  AskUserQuestion(
    question: "PP-{N} requires '{requirement}' but {infeasibility_reason}.
              How should we proceed?",
    header: "⚠️ Feasibility Issue: {PP title}",
    options: [
      { label: "Relax the constraint",
        description: "Change PP-{N} to allow {alternative}. Returns to Stage 1 for PP adjustment." },
      { label: "Change technical approach",
        description: "Switch from {current} to {alternative} to meet the constraint." },
      { label: "Accept the risk",
        description: "Proceed knowing this may fail. Logged as HIGH risk for Decomposer." },
      { label: "PP needs fundamental review",
        description: "This constraint wasn't well thought out. Return to Stage 1." }
    ]
  )
```

**"Relax constraint" or "PP review" selected** → return `PP_RENEGOTIATION_REQUIRED` signal to orchestrator → Stage 1 re-entry with specific context (not full restart).

**"Change approach" selected** → update implementation choice, re-score PP Conformance.

**"Accept risk" selected** → log as `feasibility_risk: HIGH` in output → Decomposer receives this as input for risk_assessment.

#### Layer 2 (Safety Net): Decomposer risk_assessment Extension

Extend Decomposer's existing risk_assessment with a `RE_INTERVIEW` go_no_go option for cases that only become apparent after Phase 0 analysis.

```
Current go_no_go options:
  READY / READY_WITH_CAVEATS / NOT_READY

NEW option (T-11):
  RE_INTERVIEW — specification is clear but infeasible given Phase 0 findings

When Decomposer outputs RE_INTERVIEW:
  - Must include `re_interview_questions` field:
    questions:
      - dimension: "api_availability" | "constraint_compatibility" | "tech_viability" | "scope"
        question: "Phase 0 API contracts show {X} but PP-{N} requires {Y}. Should we..."
        options: ["relax PP", "change approach", "accept risk"]

Orchestrator handling:
  - Present questions via AskUserQuestion (similar to NOT_READY flow)
  - "Relax PP" → return to Step 1 Stage 2 with feasibility context
  - "Change approach" → redecompose with adjusted constraints
  - "Accept risk" → proceed with caveat logged
```

### Why 2 Layers?

| | Layer 1 (Stage 2) | Layer 2 (Decomposer) |
|---|---|---|
| **When** | During interview, before Phase 0 | After Phase 0 + decomposition |
| **What it catches** | Obvious infeasibility (missing APIs, version conflicts, PP contradictions) | Subtle infeasibility (only visible after API contract extraction, dependency graph analysis) |
| **Token cost if caught** | 0 extra (already in interview) | 8-25K (Phase 0 consumed) |
| **Example** | "React 17 doesn't support Server Components" | "The extracted API contracts show circular dependency between modules A and B" |

Layer 1 catches ~80% of feasibility issues at zero additional cost. Layer 2 catches the remaining ~20% that require Phase 0 analysis to discover.

### Implementation Details

**Layer 1 changes (`mpl-ambiguity-resolver.md`):**
- Add `INFEASIBLE` to PP Conformance Check classification table
- Add feasibility detection process (4 checks) to Step 1.5
- Add feasibility-specific Socratic question templates
- Add `feasibility_risks` field to output schema (items accepted as risk)
- PP Conformance score formula: INFEASIBLE items penalize harder than PP_CONFLICT

**Layer 2 changes (`mpl-decomposer.md`):**
- Add `RE_INTERVIEW` to go_no_go enum
- Add `re_interview_questions` to risk_assessment schema
- Add feasibility reasoning to Step 10 (Risk Assessment)

**Orchestration changes (`mpl-run-decompose.md`):**
- Add RE_INTERVIEW handling alongside existing NOT_READY handling
- RE_INTERVIEW → call ambiguity-resolver with `mode: "feasibility_resolution"` + specific questions
- Preserve all prior interview results (no full restart)

### Files to Modify

| File | Change |
|------|--------|
| `agents/mpl-ambiguity-resolver.md` | INFEASIBLE classification + 4 feasibility checks + question templates |
| `agents/mpl-decomposer.md` | RE_INTERVIEW go_no_go + re_interview_questions schema |
| `commands/mpl-run-decompose.md` | RE_INTERVIEW handling in post-processing |

### Open Questions
- [ ] Feasibility checks in Frugal/Standard tiers? (Layer 1 is free, but codebase Grep adds ~1-2K tokens)
- [ ] Max re-interview rounds for feasibility? (suggest: 1, then user decision)
- [ ] Should Layer 1 INFEASIBLE items auto-generate decomposer risk entries?
- [ ] Cache feasibility check results? (if same PP + same codebase hash → skip)

---

## T-12: Core-First Phase Ordering (Decomposer Enhancement)

### Inspiration
Production deployment strategy — Ship the core feature first, then extend. If sub-features fail, the core product still works. This is analogous to MVP-first development: the most valuable functionality should be verified earliest.

### Current MPL State
- Decomposer orders phases by **dependency graph** (topological sort based on `requires`/`produces`)
- No explicit priority weighting between "core functionality" and "sub/extension functionality"
- A 5-phase decomposition might interleave core and sub features based purely on dependency order
- If Phase 4 (a sub-feature) circuit-breaks, it may have already modified files that Phase 3 (core) depends on

### Proposal
**Core-First Ordering Strategy** — Decomposer applies a secondary sort after dependency resolution:

```
Phase Ordering Algorithm:
  1. Build dependency DAG (existing behavior)
  2. Topological sort (existing behavior)
  3. NEW: Within each dependency-equivalent tier, sort by feature_priority:
     - CORE: Directly implements a Must-priority PP or acceptance criterion
     - EXTENSION: Implements Should/Could items or extends a CORE feature
     - SUPPORT: Infrastructure, config, tooling that enables CORE/EXTENSION

  Result:
    Phase 1: [CORE] Main authentication flow
    Phase 2: [CORE] Role-based access control
    Phase 3: [EXTENSION] OAuth provider integration
    Phase 4: [EXTENSION] Remember-me / session persistence
    Phase 5: [SUPPORT] Admin dashboard for role management
```

**Benefits:**
- **Early value delivery**: Core features are verified first. If budget runs out, the most valuable work is done.
- **Safe degradation**: If sub-feature phases circuit-break, core is already complete and committed.
- **Better redecomposition**: When redecomposing failed phases, core phases are preserved (already PASS).
- **Sub-features get full spec context**: By the time extension phases run, Phase 0 specs + core State Summaries provide rich context for implementation.

**Integration with PP:**
- CONFIRMED PPs → features implementing them are CORE
- PROVISIONAL PPs → features implementing them are EXTENSION
- Features not tied to any PP → SUPPORT

### Implementation Location
- Modify `MPL/agents/mpl-decomposer.md`: add `feature_priority` field to phase output
- Update decomposition.yaml schema: `priority: CORE | EXTENSION | SUPPORT`
- Modify ordering logic in decomposer's Step 5 (Topological Sort)

### Open Questions
- [ ] Should CORE/EXTENSION/SUPPORT be auto-detected or user-confirmed?
- [ ] How to handle CORE features that depend on EXTENSION infrastructure?
- [ ] Apply to Frugal/Standard tiers? (single-phase → no ordering needed)
- [ ] Surface the ordering rationale to user? (e.g., "Phase 1-2 are CORE, 3-5 are EXTENSION")

---

## Feasibility Assessment (2026-03-22)

### 5-Criteria Evaluation Matrix

| # | Feature | ① Philosophy | ② Token Eff. | ③ Standalone | ④ Impact | ⑤ Frequency | **Verdict** |
|---|---------|:----------:|:----------:|:----------:|:------:|:---------:|:----------:|
| T-01 | Safety Guard | ✅ | ✅ 0 tok | ✅ | ✅ | ✅ every run | **✅ Confirmed** |
| T-02 | Cross-Model Review | ⚠️ | ❌ 5-10K | ❌ ext API | ✅ | ⚠️ Frontier | **⚠️ Redesign** |
| T-03 | Browser QA (Chrome MCP) | ✅ | ⚠️ 5-8K | ⚠️ MCP req | ✅ | ⚠️ UI only | **✅ Feasible** |
| T-04 | Ship Step (PR only) | ✅ | ✅ 2-3K | ⚠️ gh CLI | ✅ Step 5.4b | ⚠️ | **✅ Feasible** |
| T-05 | Design Contract | ✅ | ⚠️ 8-12K | ✅ | ✅ | ❌ UI only | **🟡 Low priority** |
| T-06 | Doc Sync | ⚠️ | ✅ 3-5K | ✅ | ✅ | ⚠️ | **✅ Feasible** |
| T-07 | Premise Challenge | ✅ | ✅ ~2K | ✅ | ✅ | ❌ rare | **↪️ Absorbed** |
| T-08 | Trend Retro | ⚠️ | ✅ ~3K | ✅ | ✅ | ❌ rare | **🟡 Post-data** |
| T-09 | Performance Gate | ✅ | ⚠️ var | ⚠️ tools | ⚠️ | ❌ web only | **🟡 Low priority** |
| T-10 | Post-Exec Review | ✅ | ✅ 3-5K | ✅ | ⚠️ Gate 3 | ✅ every run | **✅ Confirmed** |
| T-11 | Feasibility Check (2-Layer) | ✅ | ✅ ~1-2K (L1) | ✅ | ✅ existing ext | ✅ all tiers | **✅ Redesigned** |
| T-12 | Core-First Ordering | ✅ | ✅ 0 tok | ✅ | ✅ | ✅ Frontier | **✅ Confirmed** |

### Key Decisions

**T-02 Redesign**: External API dependency (OpenAI/Gemini) violates Standalone compatibility. Alternative: same model (sonnet) with 2 independent reviews using different prompts/perspectives — no external API needed, similar effect. Requires experiment to validate effectiveness before implementation.

**T-04 Scope Down**: CI/CD varies too much across projects to provide a universal solution. MPL's scope ends at "verified code + PR". Only PR creation (Step 5.4b) is included — no CI monitoring, no deploy, no health checks. Users configure their own CI/CD pipelines.

**T-07 Absorbed into existing**: PP Conformance Check (Stage 2 redesign) already performs premise challenging — PP Conflict Detection surfaces hidden contradictions, AUTO_RESOLVED validates premises against context. The remaining gap (divergent "what if solved differently?" questioning) is better addressed by strengthening `mpl-interviewer` Round 4 (Tradeoffs) in full mode, not as a separate feature.

**T-11 Redesigned (Direction C)**: 2-Layer Defense instead of separate Step 2.7. **Layer 1**: Extend Stage 2 PP Conformance Check with `INFEASIBLE` classification — catches ~80% of feasibility issues during interview at zero additional cost (Ambiguity Resolver already has Read/Glob/Grep). **Layer 2**: Extend Decomposer's `go_no_go` with `RE_INTERVIEW` signal for Phase 0-dependent issues. Layer 1 prevents 8-25K token waste; Layer 2 is a safety net for subtle issues only visible after API contract extraction.

**T-10 Note**: Gate 3 behavioral change (H-items → defer) requires H-item severity classification. HIGH H-items remain blocking, LOW/MED H-items defer to Step 5.5 review.

---

## M-01: MCP Server — Deterministic Scoring & Active State Access

### Motivation

MPL's core computation is currently split between hooks (passive, event-triggered) and agent prompts (LLM-computed, non-deterministic). This causes two fundamental problems:

1. **Score variance**: Ambiguity scoring in `mpl-ambiguity-resolver` is LLM-computed. Same input produces 0.6~0.8 range across runs. PP Conformance scoring has the same issue.
2. **Passive state access**: Agents cannot actively query pipeline state. Phase Runner can't ask "what phase am I in?" — the orchestrator must inject it into context, wasting tokens.

MCP tools solve both: deterministic code computes scores, agents call tools when needed.

### Reference Design
Full specification: `docs/roadmap/mcp-server-design.md` (9 tools designed, 0 implemented)

### Scope: Tier 1 (3 tools — highest value)

| Tool | Purpose | Current Problem It Solves |
|------|---------|--------------------------|
| `mpl_score_ambiguity` | Compute 5D ambiguity score deterministically | LLM score variance 0.6~0.8 → code gives exact value |
| `mpl_state_read` | Agent-accessible pipeline state read | Agents can't actively query state → must be injected |
| `mpl_state_write` | Atomic pipeline state update | State writes scattered across hooks → centralized |

### Architecture

```
Claude Code Session
  ├── mpl-ambiguity-resolver (agent)
  │     └── calls mpl_score_ambiguity tool ──→ MCP Server
  │                                                │
  ├── mpl-phase-runner (agent)                     │
  │     └── calls mpl_state_read tool ────────→ MCP Server
  │                                                │
  └── orchestrator                                 │
        └── calls mpl_state_write tool ────────→ MCP Server
                                                   │
                                              ┌────▼────┐
                                              │ stdio   │
                                              │ MCP     │
                                              │ Server  │
                                              │ (Bun/   │
                                              │  Node)  │
                                              └────┬────┘
                                                   │
                                              .mpl/state.json
                                              .mpl/scores/
```

**Stack**: TypeScript + `@modelcontextprotocol/sdk` + `@anthropic-ai/sdk` (for LLM scoring), stdio transport.

### Tool Specifications

#### `mpl_score_ambiguity`

```
Input:
  pivot_points: string[]       # PP list
  user_responses: string       # Stage 1 Q&A summary
  spec_analysis: string        # Spec reading results
  codebase_context: string     # Relevant codebase findings
  current_choices: object[]    # Known implementation choices

Process:
  1. For each of 5 dimensions (Spec/Edge/Tech/Testability/PP Conformance):
     - Generate dimension-specific evaluation prompt
     - Call LLM API (temperature 0.1) for deterministic scoring
     - Parse JSON response → extract dimension score (0.0~1.0)
  2. Compute weighted sum: clarity = Σ(score × weight)
  3. Compute ambiguity = 1.0 - clarity
  4. Detect INFEASIBLE items (T-11): cross-check PP requirements vs choices
  5. Detect PP_CONFLICT items: compare choices vs PP principles

Output:
  ambiguity_score: number      # 0.0~1.0
  clarity_pct: number          # 0~100
  threshold_met: boolean       # ambiguity <= 0.2?
  dimensions: {
    spec_completeness: { score, evidence, weakest_aspect },
    edge_case_coverage: { score, evidence, weakest_aspect },
    technical_decision: { score, evidence, weakest_aspect },
    acceptance_testability: { score, evidence, weakest_aspect },
    pp_conformance: { score, conflicts: [], infeasible: [] }
  }
  weakest_dimension: string
  suggested_question: string   # auto-generated question for weakest dimension
```

**Key benefit**: Agent calls `mpl_score_ambiguity` → gets exact score + weakest dimension + suggested question. No in-prompt scoring variance. Agent focuses on question framing, tool handles computation.

#### `mpl_state_read`

```
Input:
  keys: string[]  # optional — specific fields to read. Empty = full state

Output:
  state: {
    run_mode, current_phase, pipeline_tier, tool_mode,
    compaction_count, redecompose_count, phase_details,
    session_status, ...
  }
```

**Key benefit**: Phase Runner can call `mpl_state_read(keys: ["current_phase", "phase_details"])` to check progress without orchestrator injection.

#### `mpl_state_write`

```
Input:
  patch: object  # fields to update (deep-merged with current state)

Output:
  success: boolean
  updated_keys: string[]
```

**Key benefit**: Atomic state updates from any context (agent, hook, orchestrator). Replaces scattered `writeState()` calls in hooks.

### Implementation Plan

**Phase 1: Server scaffold**
- Create `MPL/mcp-server/` directory
- `index.ts` — MCP server entry point with stdio transport
- `tools/state.ts` — mpl_state_read + mpl_state_write
- `tools/scoring.ts` — mpl_score_ambiguity
- `package.json` — dependencies (@modelcontextprotocol/sdk, @anthropic-ai/sdk)

**Phase 2: Plugin integration**
- Add MCP server to `.claude-plugin/plugin.json` → `mcpServers` field
- Modify `mpl-ambiguity-resolver.md` — replace in-prompt scoring with tool call
- Modify `mpl-phase-runner.md` — add `mpl_state_read` for active state queries

**Phase 3: Hook migration**
- `mpl-state.mjs` → calls `mpl_state_write` via MCP instead of direct file I/O
- `mpl-scope-scan.mjs` → delegates to `mpl_triage` (Tier 2, future)

### Affected Files

| File | Change |
|------|--------|
| `MPL/mcp-server/` | **NEW** — entire MCP server directory |
| `MPL/mcp-server/index.ts` | MCP server entry point |
| `MPL/mcp-server/tools/state.ts` | state read/write tools |
| `MPL/mcp-server/tools/scoring.ts` | ambiguity scoring tool |
| `MPL/mcp-server/package.json` | dependencies |
| `.claude-plugin/plugin.json` | Add mcpServers configuration |
| `agents/mpl-ambiguity-resolver.md` | Replace in-prompt scoring with tool call |
| `agents/mpl-phase-runner.md` | Add mpl_state_read calls |

### Dependencies
- Node.js or Bun runtime
- `@modelcontextprotocol/sdk` package
- `@anthropic-ai/sdk` package (for LLM scoring API calls)
- Anthropic API key (for `mpl_score_ambiguity` LLM calls)

### Open Questions
- [ ] Bun or Node? (Bun for speed, Node for compatibility)
- [ ] API key management? (env var `ANTHROPIC_API_KEY` — same as Claude Code session)
- [ ] Scoring model? (haiku for speed + cost, sonnet for accuracy)
- [ ] Fallback when MCP server is unavailable? (graceful degradation to in-prompt scoring)
- [ ] Version Tier 2 tools (triage, budget, convergence) simultaneously or separately?

---

## Version Mapping (revised after feasibility assessment)

| Version | Inclusion Candidates | Rationale |
|---------|---------------------|-----------|
| **v3.8** | T-01 (Dangerous Command) + T-12 (Core-First) + **F-31** (Compaction Recovery read-side) | Hook + prompt + resume path completion |
| **v3.9** | T-10 (Post-Exec Review + H-item severity) + T-01 (Phase-Scoped Lock) + **F-33** (Budget watcher completion) | Gate 3 change + session continuity |
| **v4.0** | T-03 (Browser QA via Chrome MCP) + T-04 (PR creation, Step 5.4b) + T-11 (Decomposer feasibility) | Verification + ship |
| **v4.1** | **M-01** (MCP Server Tier 1: score + state) | Score variance elimination, active state access |
| **v4.2** | T-05 (Design Contract) + T-06 (Doc Sync) | UI workflow + documentation |
| **Experiment** | T-02 (same-model dual review) | Validate before committing |
| **Post-data** | T-08 (Trend Retro) | Requires 10+ runs |
| **Deferred** | T-09 (Performance Gate) + **F-06** (Multi-Project) | Project-specific / monorepo |
| **Absorbed** | T-07 (Premise Challenge) | Into Stage 2 PP Conformance Check |

---

## Decision Criteria

When confirming each candidate, review the following:

1. **MPL philosophy alignment** — Does it align with "Prevention over Cure" + "Orchestrator-Worker separation"?
2. **Token efficiency** — Does it avoid adding unnecessary cost in Frugal/Standard tier?
3. **Standalone compatibility** — Does it operate gracefully without external dependencies (Playwright, OpenAI API, etc.)?
4. **Existing pipeline impact** — Does it not compromise the stability of the existing 9-step pipeline?
5. **Actual usage frequency** — Does this feature provide value in the majority of MPL executions?

---

*This document is for review before confirmation. When individual features are approved, separate them into their own design documents.*
