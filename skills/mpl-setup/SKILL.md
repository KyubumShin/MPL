---
description: Setup and configure MPL plugin - install, verify, detect tool availability, and configure standalone mode + MCP server
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
3. Expected: 12 agents (11 active + 1 doctor)
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
      "Bash(git add*)",
      "Bash(git commit*)",
      "Bash(git push*)",
      "Bash(git status*)",
      "Bash(git diff*)",
      "Bash(git log*)",
      "Bash(git checkout*)",
      "Bash(gh pr*)",
      "Bash(node*)",
      "Bash(which *)",
      "Bash(qmd *)",
      "Bash(cat*)"
    ]
  }
}
```

### Step 3g: QMD Search Engine (Optional, Recommended)

QMD is a local hybrid search engine that replaces grep-heavy exploration with BM25 + semantic + LLM reranking. It enables MPL Scout to recall past analysis results and search the codebase semantically instead of string-matching.

#### Detection

```
qmd_available = Bash("which qmd 2>/dev/null && qmd --version")
```

#### Auto-Install (if not present)

```
if NOT qmd_available:
  AskUserQuestion: "Would you like to install the QMD search engine? It significantly improves the Scout agent's exploration quality and speed."
    - "Install (recommended)" → proceed to install
    - "Skip" → skip, set qmd_available = false

  if user chose install:
    1. Check Node.js >= 22:
       node_version = Bash("node --version")
       if node_version < 22:
         Report: "QMD requires Node.js >= 22. Current: {node_version}. Skipping QMD setup."
         skip QMD setup

    2. Check macOS SQLite:
       if platform == "darwin":
         Bash("brew list sqlite 2>/dev/null || brew install sqlite")

    3. Install QMD:
       Bash("npm install -g @tobilu/qmd")
       // ~1.9GB of GGUF models auto-download on first use

    4. Verify:
       Bash("qmd --version")
       if fails: Report warning and skip QMD setup
```

#### Collection Registration

```
if qmd_available:
  // Register project source and MPL artifacts as collections
  project_root = CWD

  1. Register source code:
     Bash("qmd collection add {project_root}/src --name project-src --mask '**/*.{ts,tsx,js,jsx,py,go,rs}'")
     // If src/ doesn't exist, try project root with appropriate mask

  2. Register MPL artifacts (past analysis, learnings):
     if exists(".mpl/"):
       Bash("qmd collection add {project_root}/.mpl --name mpl-artifacts --mask '**/*.{md,json}'")

  3. Register test files:
     Bash("qmd collection add {project_root} --name project-tests --mask '**/*.{test,spec}.{ts,tsx,js,jsx,py}'")
     // Skip if no test files found

  4. Generate embeddings:
     Bash("qmd embed")
     // First run downloads models (~1.9GB), takes 2-5 minutes
     // Subsequent runs are fast (delta only)

  5. Verify:
     Bash("qmd status")
```

#### MCP Integration

```
if qmd_available:
  // Configure QMD as MCP server for Claude Code
  settings_file = find_claude_settings()  // ~/.claude/settings.json or project-level

  ensure mcpServers.qmd exists:
    {
      "command": "qmd",
      "args": ["mcp"]
    }

  // For long-running sessions, recommend daemon mode:
  Report: "QMD MCP configured. For faster searches, run: qmd mcp --http --daemon"
```

#### Save QMD Config

```
Write to .mpl/config.json:
  "qmd": {
    "enabled": true,
    "collections": ["project-src", "mpl-artifacts", "project-tests"],
    "mcp_configured": true
  }
```

### Step 4: Tool Detection (Standalone Check)

Detect available tool tiers to determine `tool_mode`:

#### Tier 1: Built-in Tools (always available)
- Read, Write, Edit, Bash, Glob, Grep, Task, Agent
- Status: always PASS

#### Tier 2: LSP Tools (optional)
Test LSP tool availability directly:

```
try lsp_hover(file=any_source_file, line=1, character=0)
  → success: LSP tools available
  → error: LSP not running, use fallback

try lsp_diagnostics_directory(directory=CWD)
  → success: Type check available
  → error: use Bash(tsc --noEmit) fallback
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
if lsp_available:
  tool_mode = "full"
else:
  tool_mode = "standalone"
```

Save to `.mpl/config.json`: `"tool_mode": "{mode}"`

#### Fallback Table

| LSP Tool | Standalone Fallback | Used In |
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
  prompt="Run full MPL diagnostics on {MPL_ROOT}. Report all 11 categories. Project directory: {CWD}."
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
  LSP Tools (Tier 2) : {OK|N/A — standalone fallback active}
  QMD Search (Tier 2b): {OK v{version}|N/A — grep fallback active}
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
  LSP tools are unavailable. Grep/Glob/Bash fallbacks are active.
  All pipeline features remain functional.
  For enhanced analysis, ensure a language server is running for your project.
{/if}

{if qmd_available}
QMD Search Engine:
  Version:      {qmd_version}
  Collections:  {collection_count} registered ({total_docs} documents)
  Embeddings:   {embedded_count}/{total_docs} embedded
  MCP:          {configured|not configured}
{else}
QMD Search Engine: Not installed
  Install QMD for semantic codebase search and past-analysis recall.
  Run: npm install -g @tobilu/qmd
{/if}

{if mcp_available}
MCP Server:
  Status:       Running (3 tools registered)
  Tools:        mpl_score_ambiguity, mpl_state_read, mpl_state_write
  Scoring:      Deterministic (via Claude Agent SDK)
{else}
MCP Server: Not configured
  Scoring uses in-prompt fallback (may have variance).
  Run /mpl:mpl-setup to build and configure MCP server.
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

### Step 7: QMD Search Engine Setup

AskUserQuestion: "Would you like to use the QMD semantic search engine? It speeds up the Scout agent's codebase exploration by 50-60%."
  - "Install and use (recommended)" → Install QMD + register collections + enable (run Step 3g)
  - "Already installed — activate only" → Skip install, register collections + enable
  - "Do not use" → Set qmd.enabled = false, Scout uses Grep fallback

### Step 7b: Context Rotation Backend (Auto-Resume)

Context rotation enables MPL to automatically continue when context window fills up, by sending `/clear` via terminal control and auto-resuming.

#### Detection

```
// Detect terminal environment
backend = null

if env.TMUX:
  backend = "tmux"
elif env.TERM_PROGRAM contains "kitty":
  backend = "kitty"
elif platform == "darwin":
  backend = "osascript"
```

#### Validation

```
if backend detected:
  // Test if backend is functional
  test_result = Bash("node -e \"
    import('${CLAUDE_PLUGIN_ROOT}/hooks/lib/rotation-backends.mjs')
      .then(m => console.log(JSON.stringify(m.testBackend('${backend}'))))
  \"")

  if test_result.available:
    Report: "Context rotation backend detected: {backend}"
  else:
    Report: "Backend {backend} detected but not functional: {test_result.error}"
    backend = null
```

#### Configuration

```
AskUserQuestion: "Would you like to enable automatic context rotation? When the pipeline reaches the context limit, it will automatically /clear + resume."
  - "Enable (recommended)" → save backend config
  - "Do not use" → set enabled = false

if enabled:
  Write to .mpl/config.json:
    "context_rotation": {
      "enabled": true,
      "backend": "{detected_backend}",
      "trigger_pct": 65,
      "max_rotations": 10,
      "backend_opts": {}
    }
```

#### Backend-specific Setup

| Backend | Requirement | Setup Action |
|---------|-------------|-------------|
| kitty | `allow_remote_control yes` in kitty.conf | Check and warn if not set |
| tmux | Active tmux session | Auto-detected via $TMUX |
| osascript | macOS + Accessibility permission | Warn about System Preferences |

```
if backend == "kitty":
  // Check kitty remote control
  kitty_conf = Bash("cat ~/.config/kitty/kitty.conf 2>/dev/null | grep allow_remote_control")
  if "yes" not in kitty_conf:
    Report: "Kitty remote control is disabled."
    Report: "  Add the following to ~/.config/kitty/kitty.conf:"
    Report: "  allow_remote_control yes"
    Report: "  Then restart Kitty."
```

### Step 7c: MPL MCP Server Setup (v4.1)

The MPL MCP Server provides deterministic ambiguity scoring and active state access for agents.

#### Detection

```
mcp_server_path = "${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.js"
mcp_available = Bash("node --check ${mcp_server_path} 2>/dev/null && echo OK || echo FAIL")
```

#### Dependencies Check

```
if mcp_available == "FAIL":
  // Check if source exists but not built
  if exists("${CLAUDE_PLUGIN_ROOT}/mcp-server/src/index.ts"):
    AskUserQuestion: "MPL MCP Server needs to be built. Install dependencies and compile?"
      - "Build now" → Bash("cd ${CLAUDE_PLUGIN_ROOT}/mcp-server && npm install && npm run build")
      - "Skip" → MCP server disabled, agents use in-prompt scoring fallback
  else:
    Report: "MCP Server source not found. Scoring will use in-prompt fallback (less deterministic)."
    skip MCP setup
```

#### Configuration

```
if mcp_available:
  // Ensure .mcp.json in plugin root has the server registered
  mcp_config_path = "${CLAUDE_PLUGIN_ROOT}/.mcp.json"

  ensure mcp_config contains:
    {
      "mcpServers": {
        "mpl-server": {
          "command": "node",
          "args": ["mcp-server/dist/index.js"]
        }
      }
    }

  Report: "MPL MCP Server configured. Tools: mpl_score_ambiguity, mpl_state_read, mpl_state_write"
```

#### Save MCP Config

```
Write to .mpl/config.json:
  "mcp_server": {
    "enabled": true,
    "tools": ["mpl_score_ambiguity", "mpl_state_read", "mpl_state_write"]
  }
```

### Step 8: HUD Statusline Setup

AskUserQuestion: "Would you like to enable the MPL HUD (statusline)? You can see pipeline progress, token usage, and Gate status in real time."
  - "Enable (recommended)" → Configure statusLine in Claude settings
  - "Do not use" → Skip HUD setup

If enabled:

#### 1. Create wrapper script at `~/.claude/mpl-hud-wrapper.sh`:

```bash
#!/bin/bash
# MPL HUD Wrapper - resolves latest cached version dynamically
HUD=$(ls -d ~/.claude/plugins/cache/mpl/mpl/*/hooks/mpl-hud.mjs 2>/dev/null | sort -V | tail -1)
[ -n "$HUD" ] && exec node "$HUD" || exit 0
```

```
Bash("chmod +x ~/.claude/mpl-hud-wrapper.sh")
```

#### 2. Configure statusLine to use the wrapper:

```
settings.statusLine = {
  "type": "command",
  "command": "bash ~/.claude/mpl-hud-wrapper.sh"
}
```

**CRITICAL**: Do NOT use `${CLAUDE_PLUGIN_ROOT}` in statusLine — it is only expanded inside hook execution, not in statusLine which runs as a separate process. Do NOT use hardcoded versioned cache paths like `~/.claude/plugins/cache/mpl/mpl/X.Y.Z/...` — they break on version bump. The wrapper script dynamically resolves the latest cached version.

Note: This replaces any existing statusLine config.
If another HUD is active, warn and ask for confirmation.

### Step 9: Optional Advanced Configuration

AskUserQuestion: "Would you like to customize advanced settings?"
  - "Use defaults (recommended)" → Skip to Step 10
  - "Customize" → Ask the following:

If "Customize" selected:
1. **Maturity mode** (default standard): explore / standard / strict
2. **Max fix loops** (default 10): How many fix attempts before circuit breaker?
3. **Token budget** (default 500K): Maximum token spend per pipeline run?
4. **HITL timeout** (default 30s): How long to wait for human approval?
5. **Gate 1 strategy** (auto/docker/native/skip): How to run automated tests?

Write all answers to `.mpl/config.json`.

### Step 10: Setup Complete

Display final summary (same as Step 6 output) and Quick Start instructions.

## Error Handling

| Error | Recovery |
|-------|----------|
| MPL directory not found | "MPL plugin directory not found. Ensure the MPL/ directory exists in your project." |
| Node.js not available | "Node.js is required for MPL hooks. Install Node.js >= 18." |
| Hook syntax error | "Hook file has syntax error: {detail}. Check the file manually." |
| Permission denied | "Cannot create .mpl/ directory. Check file system permissions." |
| Invalid plugin.json | "Plugin config is corrupted. Recreating from template..." |
| LSP not available | "No LSP server detected. MPL will run in standalone mode with Grep/Glob fallbacks." |

## Idempotency

This skill is safe to run multiple times:
- Existing valid files are never overwritten
- Only missing or invalid components are created/repaired
- Config customizations are preserved across re-runs
- State files (.mpl/state.json) are never touched by setup
- Tool detection is always re-run to reflect environment changes
