#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

CODEX_BIN="${CODEX_BIN:-codex}"
CODEX_HOME_DIR="${CODEX_HOME:-${HOME}/.codex}"
MARKETPLACE_ROOT="${MPL_CODEX_MARKETPLACE_ROOT:-${CODEX_HOME_DIR}/mpl-marketplace}"
MARKETPLACE_JSON="${MARKETPLACE_ROOT}/.agents/plugins/marketplace.json"
PLUGIN_ROOT="${MARKETPLACE_ROOT}/plugins/mpl"
PLUGIN_TMP="${MARKETPLACE_ROOT}/plugins/.mpl.tmp.$$"

if ! command -v "${CODEX_BIN}" >/dev/null 2>&1; then
  echo "error: Codex CLI not found: ${CODEX_BIN}" >&2
  echo "Install Codex CLI or set CODEX_BIN=/path/to/codex." >&2
  exit 1
fi

mkdir -p "${MARKETPLACE_ROOT}/.agents/plugins" "${MARKETPLACE_ROOT}/plugins"

stage_clean_plugin_root() {
  rm -rf "${PLUGIN_TMP}"
  mkdir -p "${PLUGIN_TMP}"

  if git -C "${REPO_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    while IFS= read -r -d "" REL_PATH; do
      [ -e "${REPO_ROOT}/${REL_PATH}" ] || continue
      REL_DIR="$(dirname -- "${REL_PATH}")"
      mkdir -p "${PLUGIN_TMP}/${REL_DIR}"
      cp -p "${REPO_ROOT}/${REL_PATH}" "${PLUGIN_TMP}/${REL_PATH}"
    done < <(git -C "${REPO_ROOT}" ls-files -z)
  else
    tar -C "${REPO_ROOT}" \
      --exclude "./.git" \
      --exclude "./.mpl" \
      --exclude "./.pr-review-state" \
      --exclude "./.claude" \
      --exclude "./node_modules" \
      --exclude "./mcp-server/node_modules" \
      --exclude "./mcp-server/dist" \
      --exclude "./.DS_Store" \
      -cf - . | tar -x -C "${PLUGIN_TMP}"
  fi

  if [ ! -f "${PLUGIN_TMP}/.codex-plugin/plugin.json" ]; then
    echo "error: staged Codex plugin root is missing .codex-plugin/plugin.json" >&2
    exit 1
  fi

  rm -rf "${PLUGIN_ROOT}"
  mv "${PLUGIN_TMP}" "${PLUGIN_ROOT}"
}

cleanup_staging() {
  rm -rf "${PLUGIN_TMP}"
}

trap cleanup_staging EXIT
stage_clean_plugin_root
trap - EXIT

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
# Codex CLI accepts already-registered marketplaces and installed plugins, so
# rerunning this installer is a no-op after the first successful install.
"${CODEX_BIN}" plugin marketplace add "${MARKETPLACE_ROOT}"

echo "[MPL] Installing Codex plugin mpl@mpl..."
"${CODEX_BIN}" plugin add mpl@mpl

echo "[MPL] Codex install complete. Start a new Codex session to load the MPL plugin."
