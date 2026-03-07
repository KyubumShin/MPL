---
description: Setup and configure MPL plugin - install, verify, detect tool availability, and configure standalone/OMC mode
---

# MPL Setup

Interactive setup wizard for the MPL plugin. Handles first-time installation, tool detection, standalone configuration, and repair.

## Protocol

### Step 1: Detect Current State

Check the current MPL installation state:

1. **Plugin exists?** Check for `MPL/.claude-plugin/plugin.json`
2. **Hooks registered?** Check for `MPL/hooks/hooks.json` with all 4 events
3. **State directory?** Check for `.mpl/` directory
4. **Config exists?** Check for `.mpl/config.json`
5. **Settings configured?** Check for `MPL/.claude/settings.local.json`

Classify installation state:
- **NOT_INSTALLED**: No plugin.json found
- **PARTIAL**: Plugin exists but missing hooks, config, or settings
- **INSTALLED**: All components present
- **CORRUPTED**: Files exist but are invalid (bad JSON, missing fields)

### Step 2: Route by State

| State | Action |
|-------|--------|
| NOT_INSTALLED | Report error: "MPL plugin files not found. This project needs the MPL directory with plugin structure. Clone or copy the MPL plugin first." |
| PARTIAL | Go to Step 3 (Repair) |
| INSTALLED | Go to Step 4 (Tool Detection) |
| CORRUPTED | Go to Step 3 (Repair) |

### Step 3: Repair / First-time Configuration

#### 3a: Create `.mpl/` Runtime Directory

```bash
mkdir -p .mpl
mkdir -p .mpl/mpl/phase0
mkdir -p .mpl/mpl/phases
mkdir -p .mpl/mpl/profile
mkdir -p .mpl/cache/phase0
```

#### 3b: Create Default Config

If `.mpl/config.json` does not exist, create it:

```json
{
  "maturity_mode": "standard",
  "max_fix_loops": 10,
  "max_total_tokens": 500000,
  "gate1_strategy": "auto",
  "hitl_timeout_seconds": 30,
  "tool_mode": "auto",
  "convergence": {
    "stagnation_window": 3,
    "min_improvement": 0.05,
    "regression_threshold": -0.1
  }
}
```

#### 3c: Verify Hook File Integrity

For each hook file referenced in `hooks/hooks.json`:
1. Check the .mjs file exists
2. Run `node --check {file}` to validate syntax
3. If syntax error found, report the exact error and file

#### 3d: Verify Agent Definitions

For each .md file in `agents/`:
1. Check YAML frontmatter has `name`, `description`, `model`
2. Validate `model` is one of: haiku, sonnet, opus
3. Expected: 11 agents (10 active + 1 doctor)
4. Report any malformed agents

#### 3e: Verify Skill Definitions

For each directory in `skills/`:
1. Check `SKILL.md` exists
2. Check YAML frontmatter has `description`
3. Report any incomplete skills

#### 3f: Ensure Settings

If `MPL/.claude/settings.local.json` doesn't have minimum permissions, create/update:

```json
{
  "permissions": {
    "allow": [
      "Bash(git commit*)",
      "Bash(gh pr*)",
      "Bash(git checkout*)",
      "Bash(node*)",
      "Bash(cat*)"
    ]
  }
}
```

### Step 4: Tool Detection (Standalone Check)

Detect available tool tiers to determine `tool_mode`:

#### Tier 1: Built-in Tools (always available)
- Read, Write, Edit, Bash, Glob, Grep, Task, Agent
- Status: always PASS

#### Tier 2: OMC MCP Tools (optional)
Test each tool's availability:

```
try lsp_hover(file=any_source_file, line=1, character=0)
  → success: OMC LSP tools available
  → error: OMC not installed, use fallback

try ast_grep_search(pattern="function $NAME", language="javascript")
  → success: AST tools available
  → error: use Grep fallback
```

#### Tier 3: LSP Servers (optional, per language)

Detect project languages and test LSP:
```
languages = detect from Glob("**/*.{ts,tsx,js,jsx,py,go,rs}")

for each language:
  try lsp_hover on first file of that language
  → success: LSP server active for this language
  → error: LSP server not running, use ast_grep/Grep fallback
```

#### Determine tool_mode

```
if tier2_available AND tier3_available:
  tool_mode = "full"
elif tier2_available:
  tool_mode = "enhanced"
else:
  tool_mode = "standalone"
```

Save to `.mpl/config.json`: `"tool_mode": "{mode}"`

#### Fallback Table

| OMC Tool | Standalone Fallback | Used In |
|----------|-------------------|---------|
| `lsp_hover` | `Grep` for signatures + `Read` for context | Phase 0 API contracts |
| `lsp_find_references` | `Grep` for import/require patterns | Codebase analysis centrality |
| `lsp_goto_definition` | `Grep` + `Glob` for definition patterns | Dependency tracking |
| `lsp_diagnostics` | `Bash(tsc --noEmit)` or `Bash(python -m py_compile)` | Worker result validation |
| `lsp_document_symbols` | `Grep` for function/class definitions | Interface extraction |
| `lsp_rename` | `Edit` with `replace_all` | Worker refactoring |
| `ast_grep_search` | `Grep` with regex patterns | Phase 0, codebase analysis |
| `ast_grep_replace` | `Edit` with `replace_all` | Not used in pipeline |

### Step 5: Run Doctor Diagnostic

```
Task(
  subagent_type="mpl-doctor",
  model="haiku",
  prompt="Run full MPL diagnostics on {MPL_ROOT}. Report all 10 categories. Project directory: {CWD}."
)
```

### Step 6: Present Results

Display a setup summary:

```
MPL Setup Complete
==================

Plugin:     MPL v{version}
Location:   {MPL_ROOT}
Tool Mode:  {full|enhanced|standalone}
Status:     {HEALTHY|REPAIRED|ISSUES_REMAIN}

Tool Availability:
  Built-in (Tier 1) : OK (Read, Write, Edit, Bash, Glob, Grep)
  OMC MCP (Tier 2)  : {OK|N/A — standalone fallback active}
  LSP Servers (Tier 3):
    {language}: {OK|N/A}
    ...

Components:
  Plugin Config  : OK
  Hooks (4/4)    : OK
  Agents ({N})   : OK
  Skills ({N})   : OK
  Commands (5)   : OK
  Runtime (.mpl) : OK
  Config         : OK

{if tool_mode == "standalone"}
Standalone Mode Active:
  MPL is running without OMC. LSP tools are replaced with
  Grep/Glob/Bash fallbacks. All pipeline features are functional.
  Install OMC for enhanced analysis (lsp_hover, ast_grep).
{/if}

{if REPAIRED}
Repairs Made:
  - {repair list}
{/if}

Quick Start:
  Say "mpl {task description}" to start a full pipeline
  Say "mpl small {task}" for a lightweight pipeline
  Run "/mpl:mpl-doctor" to re-check health
```

### Step 7: Optional Configuration Interview

After basic setup, ask the user if they want to customize:

Use AskUserQuestion:
- "Would you like to customize MPL settings?"
  - "Use defaults (Recommended)" - Skip customization
  - "Customize" - Proceed to customization questions

If "Customize" selected, ask about:
1. **Maturity mode** (default standard): explore / standard / strict
2. **Max fix loops** (default 10): How many fix attempts before circuit breaker?
3. **Token budget** (default 500K): Maximum token spend per pipeline run?
4. **HITL timeout** (default 30s): How long to wait for human approval?
5. **Gate 1 strategy** (auto/docker/native/skip): How to run automated tests?

Write answers to `.mpl/config.json`.

## Error Handling

| Error | Recovery |
|-------|----------|
| MPL directory not found | "MPL plugin directory not found. Ensure the MPL/ directory exists in your project." |
| Node.js not available | "Node.js is required for MPL hooks. Install Node.js >= 18." |
| Hook syntax error | "Hook file has syntax error: {detail}. Check the file manually." |
| Permission denied | "Cannot create .mpl/ directory. Check file system permissions." |
| Invalid plugin.json | "Plugin config is corrupted. Recreating from template..." |
| OMC not detected | "OMC not installed. MPL will run in standalone mode with Grep/Glob fallbacks." |

## Idempotency

This skill is safe to run multiple times:
- Existing valid files are never overwritten
- Only missing or invalid components are created/repaired
- Config customizations are preserved across re-runs
- State files (.mpl/state.json) are never touched by setup
- Tool detection is always re-run to reflect environment changes
