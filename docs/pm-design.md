# MPL PM Integrated Design Document (F-26)

> **Version**: 2.0
> **Date**: 2026-03-13
> **Status**: Design complete — awaiting mpl-interviewer v2 extension implementation
> **Related Roadmap**: F-26 (PM Capability, mpl-interviewer integrated)
> **References**: AI_PM(kimsanguine/AI_PM), UAM uam-pm, mpl-interviewer.md, pm-skill-proposal, mpl-pm-skill-research

---

## 1. Design Philosophy

### "A good PRD starts not from good answers, but from good questions"

The core philosophy of the PM subsystem is **Socratic Partnership**. Rather than simply structuring user requests, it systematically challenges the assumptions and blind spots of the request itself to first verify **whether we are solving the right problem**.

#### Why Socratic?

In AI coding agent pipelines, the cost of unclear requirements is extreme:

| Problem | Cost |
|---------|------|
| Implementing the wrong feature | Wasted tokens for entire Phase (~15-30K) |
| Missing edge cases | Fix Loop entry + circuit break (~20-40K) |
| Scope Creep | Mid-execution halt + user re-request |
| Assumption mismatch | Gate failure + full rework |

Socratic questioning **prevents these costs with ~1-4K token investment before Phase 0**. This extends MPL's existing philosophy "prevention is better than cure (Phase 0 Enhanced)" to the requirements stage.

#### 3-Axis Framework: Product-Design-Development

Project uncertainty exists simultaneously across three axes: **Product**, **Design/UX**, and **Development**. This corrects the bias of previous interviews that focused only on the development side, performing Socratic challenges across all three axes in a balanced way.

| Axis | Challenge Target | Example Question |
|------|-----------------|-----------------|
| **Product** | User value, priority rationale, success measurement | "If you could only keep one of these features?" |
| **Design** | Visual direction, user flow, information hierarchy, state handling | "What does the user see in loading/error/empty states?" |
| **Development** | Technical assumptions, implementation direction, test criteria, compatibility | "Who are the users of this feature?" |

> **Why 3 axes?** In the Yggdrasil experiment, the feature spec (product+development) was detailed but the design system (colors, typography, component styling) was completely absent. Previous interviews failed to detect this, and the worker made arbitrary UI decisions. This is the "high information density" trap — the detail in one axis concealing the absence in another.

#### 9 Dimensions of Uncertainty Scan

Uncertainty is examined across 3 axes × 3 = 9 dimensions:

| Axis | Dimension | Inspection Target |
|------|-----------|-------------------|
| Product | U-P1 Target Users | Personas, usage context |
| Product | U-P2 Core Value | Priority rationale, criteria for keeping only one |
| Product | U-P3 Success Measurement | Success/failure criteria after completion |
| Design | U-D1 Visual System | Colors, typography, spacing, component styles |
| Design | U-D2 User Flow | Core journey, state transitions, loading/error/empty states |
| Design | U-D3 Information Hierarchy | Visual priority, responsive reduction criteria |
| Development | U-E1 Ambiguous Criteria | Non-measurable PP criteria |
| Development | U-E2 Implicit Assumptions | Environment/data/concurrency assumptions |
| Development | U-E3 Technical Decisions | Undecided library/architecture choices |

Additionally, **cross-axis checks** (Product↔Design, Design↔Development, Product↔Development) and **PP axis bias check** (warning when PP is concentrated on only one axis) are performed. Refer to the `<Uncertainty_Scan>` section in `agents/mpl-interviewer.md` for detailed protocol.

#### Socratic in the Coding Agent Context

This system is not a business PM tool. Users are developers/engineers, and the challenge targets are not market fit but **technical assumptions, scope, and design/UX direction**:

| Business PM Socratic | MPL PM Socratic |
|---------------------|----------------|
| "Who is the target market?" | "Who are the users of this feature? (admin? end-user? both?)" |
| "Is ROI sufficient?" | "Is the value proportional to the implementation complexity?" |
| "What differentiates from competitors?" | "Does a similar feature exist in the codebase?" |
| "Is there market data?" | "Are the tests to verify this behavior clear?" |
| "What are the brand guidelines?" | "Is there a reference for UI design direction?" |
| "What is the user journey map?" | "What is the UX for loading/error/empty states in core features?" |

---

## 2. Pipeline Position

### 2.1 mpl-interviewer Integrated Placement (Step 1 Extension)

PM functionality is not a separate Step, but **extends the existing Step 1 (PP Interview) to integrate PP + requirements interview**. Triage's existing `interview_depth` (light/full) field naturally controls the activation scope of PM functionality. (F-35: `skip` option removed — interview always runs at minimum light level)

```
User Request
  |
Step -1: LSP Warm-up (existing, non-blocking)
  |
Step 0: Triage (existing)
  ├── Information density analysis (information_density)
  ├── interview_depth decision (light / full)  ← PM scope also controlled by this (F-35: skip removed)
  ├── Quick Scope Scan (F-20: pipeline_score)
  └── Routing Pattern matching (F-22)
  |
Step 0.5: Maturity mode detection (existing)
  |
Step 1: PP + Requirements Interview (extended)        ← mpl-interviewer v2
  ├── [PP] Pivot Point discovery (existing 4 Rounds)
  ├── [PM] Socratic questions + requirements structuring (NEW, by depth)
  ├── [PM] JUSF output (JTBD + User Stories + Gherkin AC) (NEW, by depth)
  └── Dual-Layer artifact storage
  |
Step 2: Pre-Execution Analysis (existing)
  ...
```

### 2.2 PM Scope Control by interview_depth

The existing Triage's `interview_depth` field simultaneously determines both the PP interview depth and the PM requirements structuring scope. **A separate `needs_pm` field is unnecessary.**

| depth | PP (existing) | Requirements (new) | Socratic questions | Solution options |
|-------|--------------|-------------------|-------------------|-----------------|
| light (density ≥ 8) | Round 1-2 + direct PP extraction | Uncertainty Scan (targeted questions for HIGH only) | HIGH items only (0~3) | None |
| light (density 4-7) | Round 1-2 (What + What NOT) | Lightweight structuring (US + AC) | Clarification + assumption probing only | None |
| full  | Round 1-4 full | JUSF full | All 6 types | 3+ options + matrix |

> **NOTE (F-35)**: The `skip` option has been removed. Interviews always run to ensure full spec implementation.
> Even high-density prompts (density ≥ 8) go through at minimum Round 1-2 interviews, supplemented by Uncertainty Scan.

```yaml
# Triage output (no change to existing schema)
triage_result:
  information_density: 3     # existing
  interview_depth: full       # existing — PM scope also determined by this
  pp_proximity: pp_adjacent    # F-20
```

### 2.3 Why Integrated? (Advantages over Separation)

Instead of creating separate Step 0.5-PM and mpl-pm agents, PM functionality is integrated into mpl-interviewer for these reasons:

| Perspective | Separated (mpl-pm + Step 0.5) | Integrated (mpl-interviewer v2) |
|-------------|-------------------------------|--------------------------------|
| **User Experience** | Dual interview fatigue: PM asks context questions → interviewer asks PP questions again | PP + requirements extracted simultaneously in a single interview session |
| **Deduplication** | PP Round 2 ("never break") ≈ PM scope definition | PP discovery process naturally defines scope |
| **Pipeline Complexity** | New Step + new agent + new Triage field | Extend existing Step + update agent prompt |
| **interview_depth utilization** | Separate `needs_pm` judgment required | Existing `interview_depth` controls PM scope too |
| **Token cost** | PM interview ~2-4K + PP interview ~2-4K | Integrated interview ~3-5K (duplicate context removed) |

Key insight: **The PP discovery process itself is the core element of requirements definition.**
- Round 1 (What): Core identity = PM's "purpose definition"
- Round 2 (What NOT): Immutable boundaries = PM's "scope definition"
- Round 3 (Tradeoffs): Priority = PM's "MoSCoW classification"
- Round 4 (Criteria): Judgment criteria = PM's "acceptance conditions"

Separating them means asking for the same information twice, creating a "I already told you" user experience.

### 2.4 Why Not Pre-Triage (Step -2)?

Placing PM before Triage creates a **contradiction where PM execution must be decided without information density assessment**. Since Triage already performs NLP-based analysis, controlling PM scope via `interview_depth` eliminates duplicate analysis and prevents unnecessary overhead.

---

## 3. Agent Design

### 3.1 mpl-interviewer v2 Extension Specification

No separate mpl-pm agent is created. The existing `mpl-interviewer.md` is extended with PM functionality.

**Preserved from existing**:
- 4 Rounds PP interview structure
- AskUserQuestion tool usage
- Hypothesis-as-Options pattern
- CONFIRMED / PROVISIONAL classification
- PP priority ordering

**Newly added**:
- Requirements structuring round added when `interview_depth: light/full`
- Built-in Socratic question library (Section 6)
- JUSF hybrid output generation
- MoSCoW + sequence_score classification
- Evidence tagging (🟢/🟡/🔴)
- Solution options presentation (full mode)

```yaml
# mpl-interviewer.md extension (agent metadata)
name: mpl-interviewer
description: Integrated interview specialist for PP discovery + requirements structuring
model: opus                      # Required for deep Socratic reasoning in full mode
disallowedTools:
  - Write
  - Edit
  - Bash
  - Task
```

| Attribute | Value | Rationale |
|-----------|-------|-----------|
| **Model** | Opus (default) / Sonnet (light fallback) | Requires both depth of PP discovery and Socratic reasoning simultaneously. Full mode needs reasoning depth to extract hidden requirements and edge cases |
| **Tool restriction** | Read-only + AskUserQuestion | Same as existing. Codebase exploration allowed but modification prohibited. Interview-only |
| **Token budget** | skip ~0.5K / light ~2K / full ~5K | Adaptive by interview_depth |
| **Role boundary** | PP (immutable constraints) + WHAT + WHY definition | HOW is the domain of Decomposer/Phase Runner. Technical implementation directives prohibited |

### 3.2 Model Routing Policy

```
if interview_depth == "light" AND information_density >= 8:
    model = "opus"              # Round 1-2 + Uncertainty Scan (reasoning depth needed for uncertainty determination)
elif interview_depth == "light":
    model = "sonnet"            # PP Round 1-2 + lightweight requirements structuring
elif interview_depth == "full":
    model = "opus"              # Full PP + deep Socratic reasoning + solution options
```

### 3.3 Failure Mode Avoidance List

Avoidance patterns to explicitly include in agent prompts:

| Failure Mode | Description | Response |
|-------------|-------------|---------|
| **Scope Creep** | Must items exceed 5 | Force Must review |
| **Ambiguous criteria** | "works well", "quickly" | Only measurable criteria allowed (numbers, status codes, file existence) |
| **Technical spec violation** | "use React", "use Redis" | Specify behavior only, delegate implementation choices to PP/Decomposer |
| **Missing persona** | Only happy-path user considered | Minimum 2 scenarios (happy path + error/edge) |
| **Ignoring edge cases** | 0 edge cases per US | Minimum 1 edge case per US required |
| **Silent conflict** | Quietly choosing between conflicting requirements | Explicitly state conflict + request user confirmation |
| **Duplicate questions** | Same question repeated in both PP and PM | Directly reuse information gathered in PP rounds for requirements structuring |
| **Interview fatigue** | Too many questions causing user exhaustion | Soft limit per depth + Continue Gate (user chooses continue/stop) |
| **Auto-termination at question limit** | Interview cut off regardless of user intent | Present Continue Gate when soft limit reached — user can extend |
| **Silencing uncertainty** | Missing implicit assumptions/ambiguous criteria in detailed prompts | Even for high-density prompts (density ≥ 8), pre-identify HIGH uncertainty via Round 1-2 + Uncertainty Scan (F-35) |

---

### 3.4 Continue Gate Design

The question limit is a **soft limit**. Instead of auto-terminating when the limit is reached, the user is given a choice:

| depth | Soft limit | Continue Gate behavior |
|-------|-----------|----------------------|
| light (density ≥ 8) | 3 | After Round 1-2 + Uncertainty Scan HIGH items 3 → Continue Gate if items remain |
| light (density 4-7) | 4 | After PP Round 1-2 + Socratic 2 → Continue Gate if uncertainty remains |
| full | 10 | After PP 4 Rounds + Socratic + options → Continue Gate if uncertainty remains |

#### Continue Gate Options

| Choice | Behavior |
|--------|---------|
| **Continue** | Ask additional questions about remaining uncertain items. Present Continue Gate again if limit is reached again. |
| **Stop here** | Classify remaining uncertain items as **Deferred Uncertainties**: |
| | - Tag related PP with PROVISIONAL + note reason for uncertainty |
| | - Register as Side Interview targets (confirm before entering that Phase during execution) |
| | - Pass to Pre-Execution Analysis as uncertainty_notes |
| **Exit entirely** | Ignore uncertain items and proceed with current state |

#### Deferred Uncertainties Resolution Path

```
Interview stopped
  ↓
Record "Deferred Uncertainties" section at bottom of pivot-points.md
  ↓
Referenced in Step 1-B Pre-Execution Analysis
  → Reflected as additional risk factor
  → Add +0.1 to risk_assessment of that Phase
  ↓
Side Interview triggered during Step 4 Phase Execution
  → If that Phase's item exists in Deferred Uncertainties list
  → Ask user confirmation question before Phase Runner executes
  → Promote PROVISIONAL → CONFIRMED or modify PP based on response
```

The key to this design: **Users can stop immediately when feeling interview fatigue, and remaining uncertainties are resolved just-in-time at the necessary point during execution**. Everything does not need to be perfectly defined in the interview.

---

## 4. Integrated Interview Process

PM functionality is naturally integrated into the existing mpl-interviewer's 4-Round PP interview. AI_PM's 6-Step process is absorbed into interview rounds rather than as separate steps.

### 4.1 Integrated Flow by interview_depth

#### light mode — high density (density ≥ 8, PP Round 1-2 + Uncertainty Scan)

> F-35: Replaces the existing `skip` mode. Interview always runs at minimum Round 1-2.

```
Round 1-2 interview (What + What NOT)
  → PP candidate extraction + direct PP extraction from prompt
  → Uncertainty Scan (9 dimensions: 3 axes × 3 + cross-axis)
  → 0 HIGH items: proceed without questions (MED/LOW passed as uncertainty_notes to Step 1-B)
  → 1~3 HIGH items: targeted Socratic question for each item (Hypothesis-as-Options)
  → 4+ HIGH items: question only top 3, tag rest as PROVISIONAL
  → PP reinforcement (criteria clarification, priority confirmation, new PP addition)
  → Uncertainty Resolution Log recorded
  → PP spec + lightweight requirements output
```

#### light mode — standard (density 4-7, PP Round 1-2 + lightweight PM)
```
[Context Loading]
  Codebase structure, existing features, previous PRD/memory reference

[Round 1: What — Core identity + purpose definition]
  Q1: Core Identity (existing PP)
  Q2: Success Criteria (existing PP)
  → PP candidate extraction + JTBD draft derivation

[Round 2: What NOT — Boundaries + scope definition]
  Q3: Never Break (existing PP)
  Q4: Destruction Scenario (existing PP)
  → PP immutable boundary confirmation + Out of Scope derivation

[Requirement Structuring — lightweight]
  Socratic questions (clarification + assumption probing only):
    Q5: "What specifically is the core user flow of '{feature}'?" (Clarification)
    Q6: "Are there any hidden assumptions?" (Assumption Probing)
  → User Stories + Acceptance Criteria (Gherkin) generation
  → MoSCoW classification + sequence_score assignment
  → Evidence tagging (🟢/🟡/🔴)

[Output]
  PP spec + lightweight PRD (YAML frontmatter + Markdown)
```

#### full mode (full PP + complete PM)
```
[Context Loading]
  Codebase structure, existing features, previous PRD/memory, failure patterns reference

[Round 1: What — Core identity + purpose definition]
  Q1: Core Identity (existing PP)
  Q2: Success Criteria (existing PP)
  → PP candidate extraction + JTBD draft derivation

[Round 2: What NOT — Boundaries + scope definition]
  Q3: Never Break (existing PP)
  Q4: Destruction Scenario (existing PP)
  → PP immutable boundary confirmation + Out of Scope derivation

[Round 3: Either/Or — Priority + MoSCoW confirmation]
  Q5-Q7: PP priority comparison (existing)
  → PP priority confirmation + Must vs Should vs Could classification

[Round 4: How to Judge — Judgment criteria + AC clarification]
  Q8-Q9: Violation scenarios (existing PP)
  → PP judgment criteria confirmation + Gherkin AC draft

[Socratic Deep Dive — all 6 types]
  Q10: Evidence — "What is the basis for needing this feature?" (evidence request)
  Q11: Perspective — "From the API consumer/operator perspective?" (perspective shift)
  Q12: Consequence — "What happens without this feature?" (consequence exploration)
  Q13: Meta — "What scenarios are we missing?" (meta question)
  (Clarification and assumption probing already performed in Round 1-2)

[Solution Options — 3+ options presented]
  Option A: Minimal, Option B: Balanced, Option C: Comprehensive
  Trade-off Matrix (Impact / Complexity / Risk / Token Cost / Test Coverage)
  User selection

[Requirement Structuring — full JUSF]
  JTBD + User Stories + Gherkin AC + Edge Cases
  MoSCoW + sequence_score
  Evidence tagging + multi-perspective review

[Output]
  PP spec + complete PRD (Dual-Layer YAML + Markdown)
```

### 4.2 Natural Mapping of PP Rounds to PM Questions

| PP Round | PP Output | PM Output (auto-derived) |
|----------|----------|------------------------|
| Round 1: What | Core identity PP | JTBD (situation, motivation, outcome) |
| Round 2: What NOT | Immutable boundary PP | Out of Scope, constraints |
| Round 3: Either/Or | PP priority | MoSCoW classification (Must aligned with top-priority PP) |
| Round 4: How to Judge | Violation judgment criteria | Acceptance Criteria (Gherkin draft) |

This mapping is the key insight: **The skeleton of requirements is already formed during the PP discovery process.** PM-specific questions only need to reinforce this skeleton.

### 4.3 Context Loading

Context collected by the interviewer before reasoning:

| Source | Content | Tool |
|--------|---------|------|
| User request | Original text + Triage result | (orchestrator injection) |
| Codebase structure | Directory tree, key files | Glob |
| Existing features | Whether similar features exist | Grep, Read |
| Previous PRD | `.mpl/pm/requirements-*.md` | Read |
| Project memory | `.mpl/memory/learnings.md` | Read |
| Previous failure patterns | `.mpl/memory/procedural.jsonl` (F-25) | Read |

**Purpose**: Understand features, patterns, and constraints already present in the codebase to build the basis for Socratic questions.

### 4.4 Solution Options (full mode only)

**Always present 3 or more solution options** (AI_PM core pattern). In the coding context, these are architecture/implementation approach alternatives.

```markdown
## Solution Options

### Option A: Minimal
- Scope: Core Must items only
- Expected complexity: S (1-2 Phase)
- Advantages: Fast validation, low risk
- Disadvantages: Limited scalability

### Option B: Balanced
- Scope: Must + core Should
- Expected complexity: M (3-4 Phase)
- Advantages: Appropriate coverage
- Disadvantages: Mid-level token cost

### Option C: Comprehensive
- Scope: Must + Should + partial Could
- Expected complexity: L (5+ Phase)
- Advantages: Complete implementation
- Disadvantages: High token cost, scope creep risk
```

**Trade-off Matrix** (adapted to coding context instead of RICE):

| Criterion | Option A | Option B | Option C |
|-----------|----------|----------|----------|
| **Impact** (user value) | 3/5 | 4/5 | 5/5 |
| **Complexity** (implementation complexity) | 1/5 | 3/5 | 5/5 |
| **Risk** (failure risk) | 1/5 | 2/5 | 4/5 |
| **Token Cost** (estimated tokens) | ~15K | ~35K | ~70K |
| **Test Coverage** (auto-verifiable degree) | 90% | 85% | 75% |

### 4.5 Multi-perspective Review

AI_PM's 3-perspective review adapted to the coding agent context:

| Perspective | Business PM | MPL Interviewer (coding context) |
|-------------|-------------|----------------------------------|
| **Engineer** | Technical feasibility | Codebase compatibility, dependency conflicts, testability |
| **Executive** | Business impact | Value vs implementation complexity, token cost justification |
| **Researcher** | Data gaps | Identifying uncertain requirements, checking evidence level (🟢/🟡/🔴) |

The interviewer applies the 3 perspectives **sequentially within a single reasoning chain** (no separate agent calls required). Review results are recorded in the `## Review Notes` section at the bottom of the PRD.

### 4.6 Save & Downstream Connection

Artifact storage locations:

```
.mpl/pm/
├── requirements-{hash}.md      # Dual-Layer PRD (YAML + Markdown)
├── socratic-log-{hash}.md      # Socratic dialogue log (decision context preserved)
├── change-log.yaml             # Change management log
└── good-examples/              # Good PRD archive for self-improvement
    └── {date}-{topic}.md
```

Downstream connections are covered in detail in [Section 7](#7-downstream-connection).

---

## 5. Output Schema

### 5.1 Full Dual-Layer PRD Schema

```markdown
---
# === YAML Frontmatter (Pipeline-Parseable) ===
pm_version: 2
request_hash: "abc123"
created_at: "2026-03-13T14:00:00Z"
model_used: opus
interview_depth: full             # skip / light / full
source_agent: mpl-interviewer     # always mpl-interviewer

job_definition:
  situation: "Built a new service but there is no user authentication"
  motivation: "Want to separate user data and ensure security"
  outcome: "Users can safely access only their own data"

personas:
  - id: P-1
    name: "New user"
    description: "A user using the service for the first time"
  - id: P-2
    name: "Returning user"
    description: "A user with an existing account"

acceptance_criteria:
  - id: AC-1
    story: US-1
    description: "Sign up with email/password"
    moscow: Must
    sequence_score: 1
    verification: A              # A (Agent) / S (Sandbox) / H (Human)
    evidence: green              # green / yellow / red
    gherkin: "Given no account exists, When user submits valid email+password, Then account is created and 201 returned"
  - id: AC-2
    story: US-1
    description: "Prevent duplicate email registration"
    moscow: Must
    sequence_score: 2
    verification: A
    evidence: green
    gherkin: "Given account with email exists, When user submits same email, Then 409 Conflict returned"

out_of_scope:
  - item: "Admin user management"
    reason: "Separated as a separate task"
    revisit: "v2"

risks:
  - id: R-1
    description: "Session storage strategy undecided"
    severity: MED                # LOW / MED / HIGH
    mitigation: "Classify as PP and decide during interview"

dependencies:
  - id: D-1
    description: "User model creation"
    status: blocked              # available / blocked / unknown

pivot_point_candidates:
  - "Session storage: Redis vs In-Memory vs DB"
  - "Token strategy: JWT vs Session Cookie"
  - "Password policy: minimum requirements level"

recommended_execution_order:
  - step: 1
    description: "User model + migration"
    stories: [US-1]
    complexity: S
  - step: 2
    description: "Sign-up endpoint"
    stories: [US-1]
    complexity: S
  - step: 3
    description: "Login/logout + session"
    stories: [US-2, US-3]
    complexity: M

selected_option: B              # A / B / C (selected solution option, full mode only)
---

# Product Requirements: User Authentication

## Job Definition (JTBD)

**Situation (When)**: Built a new service but there is no user authentication.
**Motivation (I want to)**: Want to separate user data and ensure security.
**Expected outcome (So I can)**: Users can safely access only their own data.

**Evidence level**: 🟢 High — Confirmed no authentication-related code in codebase

## Product Context

- **Problem**: All users access the same data, making data isolation impossible
- **Target users**: P-1 (new user), P-2 (returning user)
- **Success metrics**: All AC passed + Gate 1 (95%+) + 0 security vulnerabilities

## User Stories

### US-1: Sign Up
- As a **new user**, I want to **sign up with email/password**, so that **I can use the service**
- Priority: **Must** | Sequence: 1
- Acceptance Criteria:
  - [AC-1] Given account does not exist, When valid email+password submitted, Then account created + 201 response — **A** 🟢
  - [AC-2] Given email already exists, When sign-up attempted, Then 409 Conflict — **A** 🟢
  - [AC-3] Given password stored, When DB queried, Then bcrypt hash pattern matches — **A** 🟢
- Edge Cases:
  - Password less than 8 chars → 400 Bad Request + error message
  - Invalid email format → 400 Bad Request + validation error
  - Empty request body → 400 Bad Request
  - Server DB connection failure → 503 Service Unavailable

### US-2: Login
- (same pattern follows)
...

## Scope

### In Scope (this iteration)
| ID | Item | Priority | Sequence | Verification |
|----|------|----------|----------|-------------|
| AC-1 | Email/password sign-up | Must | 1 | A |
| AC-2 | Duplicate email prevention | Must | 2 | A |
| AC-3 | Password hashing | Must | 3 | A |
| AC-4 | Login | Must | 4 | A |
| AC-5 | Logout + session management | Must | 5 | A |

### Out of Scope
- **Admin user management** — separate task, revisit in v2
- **RBAC** — separate task, revisit in v2
- **Social login** — Could, exceeds current scope

## Risks & Dependencies
- [R-1] Session storage strategy undecided — Severity: MED — Mitigation: Classify as PP and decide during interview
- [D-1] User model creation — Status: blocked (prerequisite)

## Pivot Point Candidates
> To be finalized together with PP in the PP interview rounds

- **PP-C1**: Session storage — Redis vs In-Memory vs DB
- **PP-C2**: Token strategy — JWT vs Session Cookie

## Recommended Execution Order
1. User model + migration (AC-1 prerequisite dependency) — Complexity: S
2. Sign-up endpoint (AC-1, AC-2, AC-3) — Complexity: S
3. Login/logout + session management (AC-4, AC-5) — Complexity: M
4. Integration tests — Complexity: S

## Socratic Dialogue Log
> Decision context preserved (AI_PM pattern)

- **Q**: "Is the assumption that all users use email correct?" (Assumption Probing)
- **A**: User confirmed — email only for MVP, social login in v2
- **Implication**: Social login classified as Out of Scope

## Review Notes
- **Engineer perspective**: DB migration is a prerequisite dependency. bcrypt hashing is a standard approach.
- **Architect perspective**: Session storage decision affects the entire architecture — classifying as PP is appropriate.
- **User perspective**: Sign-up → login order aligns with natural user flow.
```

### 5.2 YAML Frontmatter Required/Optional Fields

| Field | Required | Description |
|-------|----------|-------------|
| `pm_version` | Y | Schema version (v2) |
| `request_hash` | Y | Request unique identifier |
| `interview_depth` | Y | light / full (F-35: skip removed) |
| `source_agent` | Y | Always `mpl-interviewer` |
| `job_definition` | Y | JTBD layer |
| `acceptance_criteria` | Y | Structured AC list |
| `out_of_scope` | Y | Explicitly excluded items |
| `pivot_point_candidates` | Y | Directly connected in PP interview |
| `recommended_execution_order` | Y | Hint for Decomposer |
| `personas` | N | User personas (recommended for features) |
| `risks` | N | Identified risks |
| `dependencies` | N | Dependencies |
| `selected_option` | N | Selected solution option (full mode only) |

---

## 6. Socratic Question Library

Question templates by 6 types, adapted to the coding agent context. The interviewer selects appropriate questions based on interview_depth and information density.

### 6.1 Clarification

> Purpose: Clearly define ambiguous terms and scope
> **Used in**: light + full mode

| Situation | Question |
|-----------|---------|
| Unclear feature scope | "What specific user flow does '{feature}' mean concretely?" |
| Unclear target | "Who are the users of this feature? (end-user / admin / API consumer / all)" |
| No success criteria | "What are the specific criteria for judging this feature as 'complete'?" |
| Ambiguous terminology | "Please clarify the definition of '{term}' in the codebase context" |

### 6.2 Assumption Probing

> Purpose: Surface assumptions the user takes for granted
> **Used in**: light + full mode

| Situation | Question |
|-----------|---------|
| Input assumption | "Are we assuming all inputs are valid? How is invalid input handled?" |
| Environment assumption | "What environment must this feature operate in? (single server / distributed / offline)" |
| Data assumption | "Is compatibility with existing data required? What about migration?" |
| Concurrency assumption | "What happens when multiple users access the same resource simultaneously?" |
| Dependency assumption | "There is a similar existing feature in {module} of the codebase — should we reuse it or build new?" |

### 6.3 Evidence

> Purpose: Verify basis for requirements, tag evidence level
> **Used in**: full mode only

| Situation | Question |
|-----------|---------|
| Basis for necessity | "What is the basis for judging this feature is needed? Are there existing usage patterns or error logs?" |
| Basis for priority | "Why is this a Must? Would the system actually be unusable without it?" |
| Performance requirements | "What is the basis for performance requirements? (current measurements, SLA, user expectations)" |
| Security requirements | "What is the level of security requirements? (internal tool / public service / financial data)" |

### 6.4 Perspective Shift

> Purpose: Review requirements from different user/consumer perspectives
> **Used in**: full mode only

| Situation | Question |
|-----------|---------|
| API consumer | "Is the interface intuitive from the perspective of a frontend/mobile developer consuming this API?" |
| Operator | "Is logging/monitoring sufficient from the perspective of someone who needs to operate/debug this feature?" |
| New developer | "Is the structure understandable to a developer seeing this code for the first time?" |
| Error user | "Is the feedback a user receives when the feature fails sufficient?" |

### 6.5 Consequence

> Purpose: Explore the results and impact of choices
> **Used in**: full mode only

| Situation | Question |
|-----------|---------|
| Not implemented | "What happens if this feature is not implemented? What are the alternatives?" |
| Scalability | "Will this design hold if users/data increases 10x?" |
| Compatibility | "Is this change a breaking change for existing API consumers?" |
| Dependency | "What long-term constraints arise from depending on this library/framework?" |
| Testing | "If the tests for this feature fail, what other features break together?" |

### 6.6 Meta

> Purpose: Validate the questioning process itself
> **Used in**: full mode only

| Situation | Question |
|-----------|---------|
| Missing check | "Are there user scenarios we have not considered?" |
| Scope check | "Are there items in this requirements list that are actually unnecessary?" |
| Assumption review | "What is the most uncertain assumption in our discussion so far?" |

---

## 7. Downstream Connection

Specific mapping of interviewer output flowing to subsequent pipeline stages:

### 7.1 Connection Matrix

```
Interviewer Output              →  Downstream Consumer           →  Usage
─────────────────────────────────────────────────────────────────────────────
acceptance_criteria.count       →  Triage (pipeline_score)       →  Adjust test_complexity factor
pivot_point_candidates          →  PP spec (Step 1 internal)     →  Directly confirmed as PP during interview
out_of_scope                    →  Pre-Execution Analyzer        →  Reinforce "Must NOT Do" list
risks + dependencies            →  Pre-Execution Analyzer        →  Risk level input
acceptance_criteria.gherkin     →  Verification Planner (3-B)    →  Pre-classify A/S/H items
recommended_execution_order     →  Decomposer (Step 3)           →  Phase order hint
acceptance_criteria.gherkin     →  Test Agent (Step 4)           →  Automatic test case generation
job_definition                  →  Phase 0 Enhanced (Step 2.5)   →  User context for API Contract/Type Policy
moscow + sequence_score         →  Decomposer                    →  Must-first decomposition, sort by sequence_score
```

### 7.2 Triage → Interviewer v2 → Decomposer Flow

```
Step 0 Triage
├── information_density: 3
├── interview_depth: full        ← PP + PM scope decided simultaneously
├── Quick Scope Scan (pipeline_score)
└── Routing Pattern matching
         |
         v
Step 1 PP + Requirements Interview (mpl-interviewer v2)
├── [PP] Round 1-4 → PP spec
├── [PM] Socratic questions → requirements structuring
├── [PM] JUSF PRD generation
├── [PM] AC-1~AC-5 (including Gherkin)
├── [PM] PP candidates → immediately confirmed as PP within interview
└── [PM] Execution order recommendation
         |
         v
Step 2 Pre-Execution Analysis
├── PRD's Out of Scope → reinforce "Must NOT Do"
├── PRD's Risks → risk level input
└── PRD's JTBD → API Contract context
         |
         v
Step 3 Decomposer
├── PRD's recommended_execution_order → phase order hint
├── PRD's MoSCoW → Must-first decomposition
├── PRD's Gherkin AC → verification criteria per phase
└── PP spec → PP violation check per phase
```

### 7.3 Interviewer → Decomposer Connection

The interviewer's `recommended_execution_order` is provided to the Decomposer as a **suggestion**. The Decomposer may accept or reorder this based on codebase dependency analysis.

```yaml
# Referencing interviewer output in decomposition.yaml
phases:
  - id: phase-1
    name: "User model + migration"
    pm_source: "recommended_execution_order.step[0]"
    pm_stories: [US-1]
    acceptance_criteria: [AC-1, AC-2, AC-3]
    gherkin_tests:                  # Used directly by Test Agent
      - "Given no account exists, When user submits valid email+password, Then account is created"
```

### 7.4 Interviewer → Test Agent Connection

The interviewer's Gherkin AC is passed directly to Test Agent to enable automatic test generation:

```
Interviewer AC (Gherkin)
  "Given no account, When valid signup, Then 201 + account created"
       |
       v
Verification Planner (A/S/H classification)
  AC-1: verification=A → Agent automatic verification
       |
       v
Test Agent
  def test_signup_success():
      # Given no account
      # When valid signup
      response = client.post("/signup", json={"email": "...", "password": "..."})
      # Then 201 + account created
      assert response.status_code == 201
```

---

## 8. Adaptive Depth

### 8.1 Full Behavior Matrix by interview_depth

| Dimension | light (density ≥ 8) | light (density 4-7) | full |
|-----------|---------------------|---------------------|------|
| **PP Rounds** | Round 1-2 + direct PP extraction | Round 1-2 | Round 1-4 full |
| **Uncertainty Scan** | **✅ 9-dimension uncertainty check after Round 1-2** | Naturally resolved in PP rounds | Naturally resolved in PP rounds |
| **Job Definition** | Auto-derived in PP Round 1 | Auto-derived in PP Round 1 | Full JTBD |
| **Socratic questions** | **HIGH items only (0~3)** | Clarification + assumption probing (2 types) | All 6 types |
| **User Stories** | Lightweight structuring | Lightweight structuring | Full writing |
| **Gherkin AC** | Core AC only | Core AC only | Full + Edge Cases |
| **Solution options** | None | None | 3+ |
| **PP candidates** | Extracted in Round 1-2 | Extracted in Round 1-2 | Extracted + confirmed in all rounds |
| **MoSCoW** | Implicit (Must only) | Implicit (Must only) | Explicit classification |
| **Evidence tagging** | 🟢/🔴 only | 🟢/🔴 only | Full 🟢/🟡/🔴 |
| **Multi-perspective review** | None | None | All 3 perspectives |
| **Expected tokens** | ~1.5-2.5K | ~2K | ~5K |
| **Model** | Opus | Sonnet | Opus |

> **NOTE (F-35)**: The `skip` row has been removed and replaced with the `light (density ≥ 8)` row. Interviews always run.

### 8.2 interview_depth Decision Criteria (Existing Triage Logic)

The existing Triage's `interview_depth` decision logic is reused as-is. No separate decision logic or field (`needs_pm`) for PM is added.

```
interview_depth =
  if information_density >= 8:
    "light"       # Interview required even for detailed requests → Round 1-2 + Uncertainty Scan (F-35)
  elif information_density >= 4:
    "light"       # Moderately detailed → PP core + lightweight requirements
  else:
    "full"        # Vague requests → Full PP + complete PM
```

> **Interview Mandatory (F-35)**: The `skip` option has been removed. Interviews always run at minimum light level for full spec implementation. "High information density" means quantity, not that everything is clear. Even high-density prompts (density ≥ 8) perform Uncertainty Scan (9-dimension uncertainty check) after Round 1-2 interviews, and only perform targeted Socratic questions for HIGH uncertainty items (maximum 3). Refer to the `<Uncertainty_Scan>` section in `agents/mpl-interviewer.md` for detailed protocol.

### 8.3 Interaction with Pipeline Tier

| PP-Proximity | interview_depth tendency | PM behavior |
|---------------|------------------------|------------|
| **non_pp** (< 0.3) | light (+ Uncertainty Scan) | Lightweight requirements confirmation (F-35: interview mandatory) |
| **pp_adjacent** (0.3~0.65) | light | Lightweight requirements structuring |
| **pp_core** (> 0.65) | full | Full Socratic + solution options |

---

## 9. Self-Improvement Loop

### 9.1 Good/Bad Examples Archive (AI_PM Pattern)

To continuously improve the interviewer's PM quality, evaluate the effectiveness of PRDs after execution completes and archive them.

```
.mpl/pm/
├── good-examples/
│   └── 2026-03-13-auth-system.md    # Success case
└── bad-examples/
    └── 2026-03-10-search-filter.md  # Case requiring improvement
```

**Classification criteria**:

| Metric | Good Example | Bad Example |
|--------|-------------|------------|
| Phase 0 iterations | 0-1 | 3+ |
| Circuit break count | 0 | 1+ |
| Gate pass rate | 95%+ (1 attempt) | 2+ attempts |
| User correction requests | 0 | 2+ |

### 9.2 F-25 Memory Integration

The interviewer's PM learnings are integrated with F-25 (4-Tier Adaptive Memory):

| Memory Tier | PM contribution |
|-------------|----------------|
| **episodic.md** | "What ACs did the interviewer identify for this type of request, and were they actually useful" |
| **semantic.md** | "Feature requests always need authentication-related PP" (3+ repeated patterns) |
| **procedural.jsonl** | Interviewer model selection, effectiveness by interview depth (Phase 0 iterations reduced per token) |

### 9.3 Profiling

Quantitatively measure the ROI of the PM stage:

```jsonl
{"timestamp":"2026-03-13T14:00:00Z","pm_enabled":true,"model":"opus","tokens_used":3500,"interview_depth":"full","stories_count":3,"ac_count":8,"phase0_iterations":1,"circuit_break_count":0,"total_pipeline_tokens":45000}
```

Profiles are recorded as PM stage in `.mpl/mpl/profile/phases.jsonl`, compared against control group (PM disabled) for:
- Change in Phase 0 iteration count
- Change in circuit break count
- Change in total token usage
- Change in final Gate pass rate

---

## 10. Change Management

### 10.1 3-Tier Change Classification

Requirements change requests during execution are classified into 3 tiers:

| Tier | Name | Condition | Response |
|------|------|-----------|---------|
| **Tier 1** | Cosmetic | No AC modification (typo, wording change) | Apply immediately to current phase. No version tag needed |
| **Tier 2** | Scope Adjustment | AC addition/removal, Must→Should change, etc. | Apply after current phase completes. requirements-v{N}.md snapshot + affected phase identification |
| **Tier 3** | Pivot | Core JTBD change, PP violation | Immediately halt execution + re-interview with interviewer + full re-planning |

### 10.2 Change Detection Mechanism

When user change requests are detected in Side Interview (Step 4.3.5), the following procedure is performed:

1. **Tier classification**: Auto-classify by AC impact scope
2. **Impact analysis**: Identify which phases/ACs are affected
3. **Record**: Record in `.mpl/pm/change-log.yaml`

```yaml
# .mpl/pm/change-log.yaml
changes:
  - version: 2
    timestamp: "2026-03-13T15:30:00Z"
    tier: 2
    description: "Changed social login from Must to Out of Scope"
    affected_phases: [3, 4]
    affected_acs: [AC-7, AC-8]
    action: "Adjust remaining phases after Phase 2 completes"
    approved: true
```

### 10.3 Scope Creep Detection

Detect scope expansion signals in user input:

| Signal Pattern | Example | Response |
|----------------|---------|---------|
| "also add" | "Also add password recovery" | Classify as Tier 2 change + confirmation |
| "while you're at it" | "While you're at it, add admin page too" | Tier 2/3 determination + warning |
| New Must addition request | "This must be included" | Review when Must exceeds 5 items |

---

## 11. References

### Key References

| Source | Core Contribution | Application Location |
|--------|------------------|---------------------|
| **AI_PM** (kimsanguine/AI_PM) | Socratic 6 types, 6-Step process, 3+ solution options, evidence tagging, good/bad archive | Overall design philosophy, Section 4 Socratic, Section 6, Section 9 |
| **UAM uam-pm** | Product Context, Edge Cases, PP connection, MoSCoW, Failure Modes, Read-only constraint | Section 3, 5 output schema, 3.3 failure modes |
| **mpl-interviewer.md** | 4 Rounds PP interview, AskUserQuestion, Hypothesis-as-Options, interview_depth(skip/light/full) | Foundation of Section 2, 3, 4 integrated interview process |
| **mpl-pm-skill-research** | JUSF hybrid, Dual-Layer, Triage integration, 3-Tier change management, MoSCoW+sequence_score | Section 4, 5, 8, 10 |
| **MPL design.md v3.2** | Pipeline architecture, A/S/H verification, Phase 0 Enhanced, 3-Gate | Section 2, 7 downstream connection |
| **MPL roadmap overview** | F-26 definition, Adaptive Router, RUNBOOK, learnings.md | Section 2, 7, 9 |
| **ChatPRD** | AI PRD generation patterns | Section 4 PRD generation reference |
| **Haberlah (2026)** | PRD principles for AI Coding Agents: executable specifications | Section 4, 5.1 schema design |
| **AGENTS.md standard** | Vendor-neutral agent documentation format | Output format compatibility |
| **JTBD + JUSF** | Job Definition + User Stories hybrid | Section 4, 5.1 JTBD layer |

### Related MPL Roadmap Items

| ID | Item | Relationship to PM Subsystem |
|----|------|------------------------------|
| F-20 | Adaptive Pipeline Router | Triage's interview_depth naturally controls PM scope |
| F-22 | Routing Pattern Learning | PM effectiveness per interview_depth recorded in routing pattern |
| F-25 | 4-Tier Adaptive Memory | Interviewer PM learnings integrated into episodic/semantic/procedural |
| F-27 | Reflexion Fix Loop | Interviewer AC provides reference point for Fix Loop reflection |
| F-11 | Run-to-Run Learning Accumulation | PM effectiveness metrics accumulated in learnings.md |

---

## Appendix A: Implementation Priority

### Phase 1 (Immediate Implementation)

1. `mpl-interviewer.md` extension: add PM feature prompts (branch by interview_depth)
2. JUSF hybrid + Dual-Layer output schema definition
3. Socratic question library (embedded in agent prompt)
4. PP candidates → PP confirmation within interview connection
5. Gherkin AC → Test Agent connection

### Phase 2 (Short-term Improvements)

6. Adaptive interview flow optimization per interview_depth
7. Downstream integration completion (connect all consumers)
8. Profiling metrics collection
9. 3-Tier change management + change-log

### Phase 3 (Long-term)

10. Good/Bad Examples archive automation
11. F-25 Memory integration
12. MCP-based external tool integration points
13. PM template library (per API/Frontend/Data Pipeline)
