# MPL MCP Server Setup (v4.1)

The MPL MCP Server provides deterministic ambiguity scoring and active state access for agents.

## Detection (v0.8.1 — fixed dependency check)

```
mcp_server_dir = "${CLAUDE_PLUGIN_ROOT}/mcp-server"
mcp_dist_path = "${mcp_server_dir}/dist/index.js"

dist_exists = exists(mcp_dist_path)
deps_installed = exists("${mcp_server_dir}/node_modules/@modelcontextprotocol")

if dist_exists AND deps_installed:
  mcp_available = true
elif dist_exists AND NOT deps_installed:
  Report: "MCP Server built but dependencies missing. Installing..."
  Bash("cd ${mcp_server_dir} && npm install --production")
  mcp_available = true
elif NOT dist_exists:
  mcp_available = false
```

## Dependencies Check

```
if NOT mcp_available:
  if exists("${mcp_server_dir}/src/index.ts"):
    AskUserQuestion: "MPL MCP Server needs to be built. Install dependencies and compile?"
      - "Build now" → Bash("cd ${mcp_server_dir} && npm install && npm run build")
      - "Skip" → MCP server disabled, agents use in-prompt scoring fallback
  else:
    Report: "MCP Server source not found. Scoring will use in-prompt fallback."
    skip MCP setup
```

## Configuration

```
if mcp_available:
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

## Save MCP Config

```
Write to .mpl/config.json:
  "mcp_server": {
    "enabled": true,
    "tools": ["mpl_score_ambiguity", "mpl_state_read", "mpl_state_write"]
  }
```
