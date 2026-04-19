---
description: "Diagnose MPL installation — validate plugin structure, hooks, agents, skills, state, and configuration. Command-only: invoke via /mpl:mpl-doctor. Do not auto-trigger from natural language."
---

# MPL Doctor

Run comprehensive diagnostics on the MPL installation and report health status.

## Protocol

### Step 1: Locate MPL Root

Find the MPL plugin root directory:
1. Check if `MPL/.claude-plugin/plugin.json` exists relative to the project root
2. If not found, search for `.claude-plugin/plugin.json` in parent directories
3. If not found, report: "MPL plugin not found. Run `/mpl:mpl-setup` to install."

Record the MPL root path for all subsequent checks.

### Step 2: Run Diagnostics

Invocation mode decides which categories run:

- `/mpl:mpl-doctor` (default) → Categories 1-12 (installation health)
- `/mpl:mpl-doctor audit` → Categories 1-12 + **Category 13 Measurement Integrity Audit** (AD-0006, v0.15.0). Requires a finalized pipeline (`.mpl/state.json.finalize_done == true`); otherwise Category 13 returns "NOT APPLICABLE".

Delegate to the `mpl-doctor` agent:

```
audit_mode = (arguments include "audit") ? "yes" : "no"

Task(
  subagent_type="mpl-doctor",
  model="haiku",
  prompt=f"Run MPL diagnostics on the plugin at {MPL_ROOT}. Check Categories 1-12 (installation health). audit_mode={audit_mode}. If audit_mode=yes AND .mpl/state.json.finalize_done==true, ALSO run Category 13 Measurement Integrity Audit (AD-0006 [a]-[g] checks) against the completed pipeline. Working dir: {CWD}."
)
```

### Step 3: Present Results

Display the doctor's report to the user. Add a summary header:

```
MPL Doctor - Installation Diagnostics
══════════════════════════════════════
{agent report}
```

### Step 4: Offer Next Steps

Based on the results:

| Result | Action |
|--------|--------|
| All PASS | "MPL is healthy and ready to use. Say `mpl` to start a pipeline." |
| WARN only | "MPL is functional with minor issues. Recommendations listed above." |
| Any FAIL | "MPL has issues that need fixing. Run `/mpl:mpl-setup` to auto-repair, or fix manually using the recommendations above." |
| Plugin not found | "MPL is not installed. Run `/mpl:mpl-setup` to set up." |
