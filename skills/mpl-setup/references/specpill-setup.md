# specpill MCP Setup

> **specpill** is an optional spec-assist plugin for MPL. When installed, the
> Stage 2 Socratic Ambiguity Resolution Loop gains a visual surface (flow
> graph + rough UI mockup) and a click-targeted feedback channel. When not
> installed, MPL falls back to the existing text-only Socratic loop.
>
> Full integration contract: `docs/integrations/specpill.md`

## Install

specpill is a **separate repository** — not vendored into MPL.

```bash
git clone https://github.com/KyubumShin/specpill ~/project/specpill
cd ~/project/specpill
npm install
npm run build:mcp
```

This produces `~/project/specpill/dist/mcp-server.mjs`.

## Register the MCP server

Add the following to your Claude Code MCP config (typically
`~/.claude/mcp.json` or per-project equivalent):

```json
{
  "mcpServers": {
    "specpill": {
      "command": "node",
      "args": ["/Users/<you>/project/specpill/dist/mcp-server.mjs"],
      "env": {
        "SPECPILL_WS_PORT": "19847"
      }
    }
  }
}
```

Adjust the absolute path. Restart Claude Code so the new MCP server is
discovered. Verify with `/mpl:mpl-doctor` — Category 13 should report **PASS**.

## Browser UI (optional)

The MCP server boots a WebSocket broadcast on `ws://localhost:19847`. To
view and interact with the spec visually:

```bash
cd ~/project/specpill
npm run dev
# open http://localhost:5173 in a browser
```

The browser auto-connects to the WS broadcast. As the agent populates the
spec via MCP tool calls, the graph and mockup update in real time. Click any
node or UI element to leave click-targeted feedback that the agent receives
through `wait_for_feedback`.

> **Note**: the browser is purely a clarity layer. The Socratic loop runs to
> completion even with no browser open — feedback simply flows through
> AskUserQuestion text exchanges.

## Verify the install

```bash
/mpl:mpl-doctor
```

Expected output for Category 13:

```
| 13 | specpill MCP | PASS | tools available, WS port 19847 |
```

If you see WARN, the server bundle exists but the MCP entry is not registered
in Claude Code's MCP config — re-check the JSON above and restart Claude Code.

## Uninstall

specpill is fully removable: delete the `mcpServers.specpill` entry from your
MCP config and restart. MPL will detect the absence on next run and switch to
text-only mode automatically. The `.specpill/spec.json` files in any project
roots can be removed manually if no longer wanted.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `mpl-doctor` reports WARN | `mcpServers.specpill` missing or path wrong |
| Browser shows "disconnected" | WS port mismatch — match `SPECPILL_WS_PORT` env to the URL |
| `wait_for_feedback` always times out | No browser connected, or click handler not firing — check the InspectorPanel "connected" indicator |
| Spec persists across sessions unexpectedly | `.specpill/spec.json` is per-project; delete to reset |
