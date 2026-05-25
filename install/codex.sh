#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

CODEX_BIN="${CODEX_BIN:-codex}"
CODEX_HOME_DIR="${CODEX_HOME:-${HOME}/.codex}"
MARKETPLACE_ROOT="${MPL_CODEX_MARKETPLACE_ROOT:-${CODEX_HOME_DIR}/mpl-marketplace}"
MARKETPLACE_JSON="${MARKETPLACE_ROOT}/.agents/plugins/marketplace.json"
PLUGIN_LINK="${MARKETPLACE_ROOT}/plugins/mpl"

if ! command -v "${CODEX_BIN}" >/dev/null 2>&1; then
  echo "error: Codex CLI not found: ${CODEX_BIN}" >&2
  echo "Install Codex CLI or set CODEX_BIN=/path/to/codex." >&2
  exit 1
fi

mkdir -p "${MARKETPLACE_ROOT}/.agents/plugins" "${MARKETPLACE_ROOT}/plugins"

if [ -e "${PLUGIN_LINK}" ] && [ ! -L "${PLUGIN_LINK}" ]; then
  EXISTING_ROOT="$(cd -- "${PLUGIN_LINK}" 2>/dev/null && pwd -P || true)"
  if [ "${EXISTING_ROOT}" != "${REPO_ROOT}" ]; then
    echo "error: ${PLUGIN_LINK} already exists and is not the MPL checkout." >&2
    echo "Remove it or set MPL_CODEX_MARKETPLACE_ROOT to a different directory." >&2
    exit 1
  fi
else
  rm -f "${PLUGIN_LINK}"
  ln -s "${REPO_ROOT}" "${PLUGIN_LINK}"
fi

cat >"${MARKETPLACE_JSON}" <<'JSON'
{
  "name": "mpl",
  "interface": {
    "displayName": "MPL"
  },
  "plugins": [
    {
      "name": "mpl",
      "source": {
        "source": "local",
        "path": "./plugins/mpl"
      },
      "policy": {
        "installation": "INSTALLED_BY_DEFAULT",
        "authentication": "ON_INSTALL"
      },
      "category": "Coding"
    }
  ]
}
JSON

echo "[MPL] Registering Codex marketplace wrapper at ${MARKETPLACE_ROOT}..."
"${CODEX_BIN}" plugin marketplace add "${MARKETPLACE_ROOT}"

echo "[MPL] Installing Codex plugin mpl@mpl..."
"${CODEX_BIN}" plugin add mpl@mpl

echo "[MPL] Codex install complete. Start a new Codex session to load the MPL plugin."
