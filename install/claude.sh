#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
CLAUDE_SCOPE="${MPL_CLAUDE_SCOPE:-user}"

if ! command -v "${CLAUDE_BIN}" >/dev/null 2>&1; then
  echo "error: Claude Code CLI not found: ${CLAUDE_BIN}" >&2
  echo "Install Claude Code or set CLAUDE_BIN=/path/to/claude." >&2
  exit 1
fi

echo "[MPL] Validating Claude plugin metadata..."
"${CLAUDE_BIN}" plugin validate "${REPO_ROOT}/.claude-plugin/plugin.json"
"${CLAUDE_BIN}" plugin validate "${REPO_ROOT}/.claude-plugin/marketplace.json"

echo "[MPL] Registering Claude marketplace from ${REPO_ROOT}..."
"${CLAUDE_BIN}" plugin marketplace add --scope "${CLAUDE_SCOPE}" "${REPO_ROOT}"

echo "[MPL] Installing Claude plugin mpl@mpl..."
"${CLAUDE_BIN}" plugin install --scope "${CLAUDE_SCOPE}" mpl

echo "[MPL] Claude install complete. Restart Claude Code if this session was already running."
