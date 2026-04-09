# QMD Search Engine Setup

QMD is a local hybrid search engine that replaces grep-heavy exploration with BM25 + semantic + LLM reranking. It enables MPL Scout to recall past analysis results and search the codebase semantically instead of string-matching.

## Detection

```
qmd_available = Bash("which qmd 2>/dev/null && qmd --version")
```

## Auto-Install (if not present)

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

    4. Verify:
       Bash("qmd --version")
       if fails: Report warning and skip QMD setup
```

## Collection Registration

```
if qmd_available:
  project_root = CWD

  1. Register source code:
     Bash("qmd collection add {project_root}/src --name project-src --mask '**/*.{ts,tsx,js,jsx,py,go,rs}'")

  2. Register MPL artifacts (past analysis, learnings):
     if exists(".mpl/"):
       Bash("qmd collection add {project_root}/.mpl --name mpl-artifacts --mask '**/*.{md,json}'")

  3. Register test files:
     Bash("qmd collection add {project_root} --name project-tests --mask '**/*.{test,spec}.{ts,tsx,js,jsx,py}'")

  4. Generate embeddings:
     Bash("qmd embed")

  5. Verify:
     Bash("qmd status")
```

## MCP Integration

```
if qmd_available:
  settings_file = SETTINGS_TARGET

  ensure mcpServers.qmd exists:
    {
      "command": "qmd",
      "args": ["mcp"]
    }

  Report: "QMD MCP configured. For faster searches, run: qmd mcp --http --daemon"
```

## Save QMD Config

```
Write to .mpl/config.json:
  "qmd": {
    "enabled": true,
    "collections": ["project-src", "mpl-artifacts", "project-tests"],
    "mcp_configured": true
  }
```
