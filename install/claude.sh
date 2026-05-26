#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
CLAUDE_SCOPE="${MPL_CLAUDE_SCOPE:-user}"

usage() {
  cat <<USAGE
Usage: install/claude.sh [--scope user|project|local|ask]

Environment:
  MPL_CLAUDE_SCOPE     Claude plugin scope: user, project, local, or ask (default: user)
                       CLI --scope overrides this environment value.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --scope)
      [ "$#" -ge 2 ] || { echo "error: --scope requires a value" >&2; exit 1; }
      CLAUDE_SCOPE="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

case "${CLAUDE_SCOPE}" in
  user|project|local|ask) ;;
  *)
    echo "error: invalid Claude plugin scope: ${CLAUDE_SCOPE}" >&2
    echo "Use --scope user, --scope project, --scope local, or --scope ask." >&2
    exit 1
    ;;
esac

prompt_claude_scope() {
  if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
    echo "error: --scope ask requires an interactive terminal" >&2
    echo "Use --scope user, --scope project, or --scope local for non-interactive installs." >&2
    exit 1
  fi

  local choice=""
  while true; do
    printf '%s\n' "[MPL] Select Claude Code plugin scope:" > /dev/tty
    printf '%s\n' "  1) user    Install for this OS user (default)" > /dev/tty
    printf '%s\n' "  2) project Install for the current project" > /dev/tty
    printf '%s\n' "  3) local   Install for the current local workspace" > /dev/tty
    printf '%s' "Choose scope [1/user]: " > /dev/tty
    IFS= read -r choice < /dev/tty || choice=""
    case "${choice}" in
      ""|1|u|U|user) CLAUDE_SCOPE="user"; break ;;
      2|p|P|project) CLAUDE_SCOPE="project"; break ;;
      3|l|L|local) CLAUDE_SCOPE="local"; break ;;
      *) printf '%s\n' "[MPL] Invalid scope: ${choice}" > /dev/tty ;;
    esac
  done
}

if [ "${CLAUDE_SCOPE}" = "ask" ]; then
  prompt_claude_scope
fi

if ! command -v "${CLAUDE_BIN}" >/dev/null 2>&1; then
  echo "error: Claude Code CLI not found: ${CLAUDE_BIN}" >&2
  echo "Install Claude Code or set CLAUDE_BIN=/path/to/claude." >&2
  exit 1
fi

echo "[MPL] Validating Claude plugin metadata..."
"${CLAUDE_BIN}" plugin validate "${REPO_ROOT}/.claude-plugin/plugin.json"
"${CLAUDE_BIN}" plugin validate "${REPO_ROOT}/.claude-plugin/marketplace.json"

echo "[MPL] Registering Claude marketplace from ${REPO_ROOT} with ${CLAUDE_SCOPE} scope..."
# Claude CLI accepts already-registered marketplaces and installed plugins, so
# rerunning this installer is a no-op after the first successful install.
"${CLAUDE_BIN}" plugin marketplace add --scope "${CLAUDE_SCOPE}" "${REPO_ROOT}"

echo "[MPL] Installing Claude plugin mpl@mpl with ${CLAUDE_SCOPE} scope..."
"${CLAUDE_BIN}" plugin install --scope "${CLAUDE_SCOPE}" mpl

echo "[MPL] Claude install complete. Restart Claude Code if this session was already running."
