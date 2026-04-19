# MPL Standalone Mode

MPL can operate without LSP tools installed. When LSP tools
(lsp_*, ast_grep_*) are unavailable, MPL falls back to built-in Claude Code tools.

## Tool Fallback Matrix

| LSP Tool | Standalone Fallback | Quality Impact |
|----------|-------------------|----------------|
| `lsp_hover` | `Grep` for type annotations | Lower precision for type inference |
| `lsp_goto_definition` | `Grep` + `Glob` for symbol search | May find multiple candidates |
| `lsp_find_references` | `Grep` for symbol usage | May include false positives |
| `lsp_document_symbols` | `Grep` for function/class definitions | Pattern-based, less accurate |
| `lsp_diagnostics` | `Bash("npx tsc --noEmit")` or `Bash("python -m py_compile")` | Build-tool dependent |
| `lsp_diagnostics_directory` | `Bash("npx tsc --noEmit")` (F-17 fallback) | Same as above |
| `ast_grep_search` | `Grep` with regex patterns | Less structural, more noise |
| `ast_grep_replace` | `Edit` tool (manual patterns) | Requires exact string matching |

## Detection Logic

At pipeline start (Step -1 LSP Warm-up), MPL detects available tools:

```
tool_mode = "full"  // default: all tools available

// Check LSP availability
try:
  lsp_hover(file=any_source_file, line=1, character=0)
catch:
  tool_mode = "standalone"
  Report: "[MPL] Standalone mode: LSP unavailable. Using Grep/Glob fallbacks."

// Check ast_grep availability
try:
  ast_grep_search(pattern="$X", language=detected_language)
catch:
  if tool_mode != "standalone":
    tool_mode = "partial"  // LSP works but ast_grep doesn't
  Report: "[MPL] ast_grep unavailable. Using Grep fallback for pattern search."

// Record in state
writeState(cwd, { tool_mode: tool_mode })
```

## Phase 0 in Standalone Mode

| Phase 0 Step | Full Mode | Standalone Mode |
|-------------|-----------|-----------------|
| Step 1: API Contracts | lsp_document_symbols + ast_grep | Grep for "function/def/class" + Read |
| Step 2: Examples | ast_grep for test patterns | Grep for "test/describe/it" + Read |
| Step 3: Type Policy | lsp_hover for type inference | Grep for type annotations |
| Step 4: Error Spec | ast_grep for raise/throw | Grep for "raise/throw/Error" |

## Setup

Run `/mpl:mpl-setup` to configure MPL. The setup wizard:
1. Detects available tools (LSP, ast_grep, MCP servers)
2. Sets tool_mode in `.mpl/config.json`
3. Installs recommended MCP servers if missing
4. Reports readiness status

## Diagnostics

Run `/mpl:mpl-doctor` to diagnose:
- Tool availability (LSP servers, ast_grep, MCP)
- Configuration validity (.mpl/config.json)
- State file integrity (.mpl/state.json)
- Cache health (.mpl/cache/)
