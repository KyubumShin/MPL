---
description: Diagnose MPL installation - validate plugin structure, hooks, agents, skills, state, and configuration
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

Delegate to the `mpl-doctor` agent with the MPL root path:

```
Task(
  subagent_type="mpl-doctor",
  model="haiku",
  prompt="Run full MPL diagnostics on the plugin at {MPL_ROOT}. Check all 8 categories: plugin structure, hooks, agents, skills, commands, state/runtime, configuration, documentation. The project working directory is {CWD}."
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
