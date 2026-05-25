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
PLUGIN_OLD="${MARKETPLACE_ROOT}/plugins/.mpl.old.$$"
LOCK_DIR="${MARKETPLACE_ROOT}/plugins/.mpl.install.lock"

if ! command -v "${CODEX_BIN}" >/dev/null 2>&1; then
  echo "error: Codex CLI not found: ${CODEX_BIN}" >&2
  echo "Install Codex CLI or set CODEX_BIN=/path/to/codex." >&2
  exit 1
fi

SOURCE_MODE=""
if command -v git >/dev/null 2>&1 && git -C "${REPO_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  SOURCE_MODE="git"
elif [ "${MPL_ALLOW_NONGIT_SOURCE:-}" = "1" ] && [ -f "${REPO_ROOT}/.mpl-install-manifest" ]; then
  SOURCE_MODE="manifest"
else
  echo "error: Codex install requires an MPL git checkout or a manifest source prepared by install.sh." >&2
  echo "For gitless installs, run the top-level install.sh via curl." >&2
  exit 1
fi

mkdir -p "${MARKETPLACE_ROOT}/.agents/plugins" "${MARKETPLACE_ROOT}/plugins"

if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  echo "error: another MPL Codex install appears to be running: ${LOCK_DIR}" >&2
  echo "Remove the lock directory only if no installer is active." >&2
  exit 1
fi

cleanup_staging() {
  rm -rf "${PLUGIN_TMP}" "${PLUGIN_OLD}" "${LOCK_DIR}"
}

stage_clean_plugin_root() {
  rm -rf "${PLUGIN_TMP}" "${PLUGIN_OLD}"
  mkdir -p "${PLUGIN_TMP}"

  if [ "${SOURCE_MODE}" = "git" ]; then
    UNTRACKED_FILES="$(git -C "${REPO_ROOT}" ls-files --others --exclude-standard)"
    if [ -n "${UNTRACKED_FILES}" ]; then
      echo "[MPL] Warning: untracked files are not included in the Codex staged plugin root." >&2
      echo "[MPL] Run git add for files you want staged, then rerun ./install/codex.sh." >&2
    fi

    while IFS= read -r -d "" REL_PATH; do
      [ -e "${REPO_ROOT}/${REL_PATH}" ] || continue
      REL_DIR="$(dirname -- "${REL_PATH}")"
      mkdir -p "${PLUGIN_TMP}/${REL_DIR}"
      cp -p "${REPO_ROOT}/${REL_PATH}" "${PLUGIN_TMP}/${REL_PATH}"
    done < <(git -C "${REPO_ROOT}" ls-files -z)
  else
    while IFS= read -r REL_PATH; do
      [ -n "${REL_PATH}" ] || continue
      [ -e "${REPO_ROOT}/${REL_PATH}" ] || continue
      REL_DIR="$(dirname -- "${REL_PATH}")"
      mkdir -p "${PLUGIN_TMP}/${REL_DIR}"
      cp -p "${REPO_ROOT}/${REL_PATH}" "${PLUGIN_TMP}/${REL_PATH}"
    done <"${REPO_ROOT}/.mpl-install-manifest"
  fi

  if [ ! -f "${PLUGIN_TMP}/.codex-plugin/plugin.json" ]; then
    echo "error: staged Codex plugin root is missing .codex-plugin/plugin.json" >&2
    exit 1
  fi

  if [ -e "${PLUGIN_ROOT}" ]; then
    mv "${PLUGIN_ROOT}" "${PLUGIN_OLD}"
  fi

  if ! mv "${PLUGIN_TMP}" "${PLUGIN_ROOT}"; then
    if [ -e "${PLUGIN_OLD}" ] && [ ! -e "${PLUGIN_ROOT}" ]; then
      mv "${PLUGIN_OLD}" "${PLUGIN_ROOT}" || true
    fi
    echo "error: failed to replace staged Codex plugin root: ${PLUGIN_ROOT}" >&2
    exit 1
  fi

  rm -rf "${PLUGIN_OLD}"
}

trap cleanup_staging EXIT
stage_clean_plugin_root

# Codex marketplace schema v1. Keep this installer as the single source for
# Codex marketplace metadata; the repo root intentionally has no marketplace file.
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
echo "[MPL] After updating MPL, rerun install.sh or ./install/codex.sh from the refreshed source."
echo "[MPL] The MCP server will prepare dependencies and build on first use."

rm -rf "${LOCK_DIR}"
trap - EXIT
