# specpill — MPL Integration Contract

> **specpill** is an external, harness-agnostic spec-assist MCP plugin that
> gives an agent and a user a shared visual surface (flow graph + UI mockup)
> for refining feature specs. MPL consumes specpill **optionally** during the
> Stage 2 Socratic Ambiguity Resolution Loop. When specpill is not registered,
> MPL falls back to the existing text-only Socratic loop with no degradation
> in correctness.

- **Upstream project**: https://github.com/KyubumShin/specpill
- **MCP namespace**: `mcp__specpill__*`
- **Default WS port**: `19847` (browser broadcast — overridden via `SPECPILL_WS_PORT`)
- **Persistence**: `<project_root>/.specpill/spec.json`

## Why specpill is optional

The Socratic Loop's **correctness** comes from `mpl_score_ambiguity` — a
deterministic metric — and from the user's natural-language responses to
targeted questions. specpill adds a **clarity** layer (visual referencing,
click-targeted feedback) on top of that, but does not replace either of those
mechanisms. Removing specpill leaves the Socratic Loop fully functional in
text-only mode. This is why specpill is registered as a WARN-not-FAIL category
in mpl-doctor.

## Detection mechanism

The Stage 2 agent (`mpl-ambiguity-resolver`) checks for specpill availability
at the start of the Socratic Loop:

```
specpill_available = check_tool_available("mcp__specpill__init_session")
```

In practice, this means the agent attempts a low-cost call (or inspects its
own tool list, depending on harness capabilities) to determine whether the
specpill MCP server is registered in the current Claude session. The agent
sets a session-local flag and branches accordingly.

If `specpill_available == true` → **enhanced path** (visual loop)
If `specpill_available == false` → **fallback path** (text-only loop, current behavior)

## Tool surface MPL relies on

MPL uses **only** the following specpill tools — a stable, minimal subset.
Any additions to specpill's broader API are not consumed by MPL.

| Tool | Purpose in MPL |
|---|---|
| `mcp__specpill__init_session` | Open session at the project root after Spec Reading completes |
| `mcp__specpill__add_feature` | One call per requirement bucket discovered in Stage 1 |
| `mcp__specpill__add_flow_node` | Convert each user-flow step into a graph node |
| `mcp__specpill__link_flow_nodes` | Connect flow nodes when sequence is known |
| `mcp__specpill__add_ui_element` | Optional rough UI anchor when a user mentions UI |
| `mcp__specpill__wait_for_feedback` | Yield to the user during the Socratic Loop |
| `mcp__specpill__resolve_feedback` | Mark a feedback item as addressed after spec update |
| `mcp__specpill__finalize_spec` | Called when ambiguity ≤ 0.2 AND user approves |
| `mcp__specpill__get_spec` | Re-read the current spec for `mpl_score_ambiguity` context |

The agent **does not** use the destructive specpill tools (`reset_session`,
`delete_feature`) within the MPL pipeline.

## Enhanced path (specpill present)

The Socratic Loop with specpill is structurally identical to the text-only
loop but adds two side effects on each iteration:

1. **Spec mirror**: after every interview round, the agent's discovered
   facts (features, flows, optional UI anchors) are pushed into specpill via
   the mutation tools. The browser, if connected, sees them in real time.

2. **Yield channel**: where the text-only loop calls `AskUserQuestion`, the
   enhanced path calls `wait_for_feedback(timeout_ms)` *first* with a short
   timeout. If a click-targeted feedback event arrives, it pre-empts the
   `AskUserQuestion` and is handled as an additional Socratic input.
   `AskUserQuestion` is still issued for the targeted dimension question;
   the user can answer either via text in the question UI or by clicking
   in the browser.

```
[Call mpl_score_ambiguity MCP tool with current context]
  ↓
ambiguity <= 0.2?
  ├─ Yes → finalize_spec (if specpill_available) → Step 4
  └─ No  → [push current discovered facts to specpill]
           ↓
         [Call wait_for_feedback(timeout_ms=1500) — non-binding pre-empt]
           ├─ event arrived → reflect into context → re-score
           └─ timeout → AskUserQuestion (targeted on weakest dimension)
                     → reflect response into context → push to specpill
                     → resolve_feedback for any pre-empted events
                     → re-score
```

This is intentionally **conservative**: specpill is a clarity enhancement, not
a control-flow replacement. The Socratic loop's termination still depends on
`mpl_score_ambiguity`, not on user clicks.

## Fallback path (specpill absent)

The Stage 2 agent runs the existing text-only Socratic Loop unchanged. No
specpill calls are made. No browser is opened. No `.specpill/` directory is
created. Functionally identical to MPL's pre-integration behavior.

The user receives a one-line notice during Step 0 if specpill is absent:

```
[MPL] specpill plugin not registered — Socratic loop runs in text-only mode.
      Install: see skills/mpl-setup/references/specpill-setup.md
```

This notice is informational only. It is not a warning or error.

## Doctor reporting

`mpl-doctor` reports specpill as **Category 13** with severity capped at WARN
(specpill is optional — never FAIL). Possible states:

| State | Meaning |
|---|---|
| `PASS` | `mcp__specpill__*` tools are registered in the current session |
| `WARN` | tools not registered; Socratic loop runs in text-only mode |
| `N/A`  | doctor was invoked outside a live session and cannot probe MCP registration |

## Lifecycle

1. **Step 0 (Triage)**: doctor probe sets `session.specpill_available` flag
2. **Step 1 Stage 1 (mpl-interviewer)**: no specpill calls
3. **Step 1 Stage 2 (mpl-ambiguity-resolver)**:
   - On entry: if specpill_available, call `init_session(project_root)` and
     populate features/flows from Stage 1 output via `add_feature` /
     `add_flow_node` / optional `add_ui_element` calls
   - During loop: enhanced path as described above
   - On exit (ambiguity ≤ 0.2 AND user approves): call `finalize_spec(approved_by="user")`
4. **Step 2 onward**: spec.json remains on disk as a reference artifact;
   no further specpill calls during decomposition or execution

## What MPL does NOT promise to specpill

- MPL does not require specpill to ever exist. specpill MCP installation is
  100% user-driven.
- MPL does not version-pin specpill. Any specpill version exposing the tool
  surface above is acceptable.
- MPL does not modify `.specpill/spec.json` directly — only through MCP tools.
- MPL does not hold the spec session open across pipeline phases — Step 1
  Stage 2 opens, finalizes, and lets specpill close. Re-opening for later
  reference is the user's choice.

## What specpill does NOT promise to MPL

- specpill makes no claim about ambiguity scoring — it is a clarity layer,
  not a metric layer.
- specpill makes no claim about user availability — `wait_for_feedback`
  timing out is normal and expected, not an error.
- specpill makes no claim about spec correctness — the agent and user are
  jointly responsible.
