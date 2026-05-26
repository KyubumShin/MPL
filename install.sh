#!/usr/bin/env bash
set -euo pipefail

MPL_REF_PROVIDED=0
if [ "${MPL_REF+x}" = "x" ] && [ -n "${MPL_REF}" ]; then
  MPL_REF_PROVIDED=1
fi
MPL_REPO="${MPL_REPO:-KyubumShin/MPL}"
MPL_REF="${MPL_REF:-main}"
MPL_RUNTIME="${MPL_RUNTIME:-auto}"
MPL_CLAUDE_SCOPE="${MPL_CLAUDE_SCOPE:-user}"
MPL_INSTALL_ROOT="${MPL_INSTALL_ROOT:-${HOME}/.mpl/install}"
MPL_SOURCE_DIR="${MPL_SOURCE_DIR:-${MPL_INSTALL_ROOT}/source/mpl}"
MPL_FORCE_DOWNLOAD="${MPL_FORCE_DOWNLOAD:-0}"
MPL_TARBALL_PATH="${MPL_TARBALL_PATH:-}"
MPL_TARBALL_URL="${MPL_TARBALL_URL:-}"
MPL_TARBALL_SHA256="${MPL_TARBALL_SHA256:-}"

usage() {
  cat <<USAGE
Usage: install.sh [--runtime auto|claude|codex|both] [--scope user|project|local|ask] [--ref <git-ref>] [--source-dir <path>] [--repo <owner/repo>]

Environment:
  MPL_REPO             GitHub repo to download (default: KyubumShin/MPL)
  MPL_REF              Git ref to download for archive installs (default: main)
  MPL_TARBALL_URL      Override source archive URL
  MPL_TARBALL_PATH     Use a local .tar.gz archive instead of curl (tests/offline installs)
  MPL_TARBALL_SHA256   Optional SHA256 expected for the downloaded/copied archive
  MPL_FORCE_DOWNLOAD   Force archive download/copy even when install.sh is run from a checkout
  MPL_INSTALL_ROOT     Persistent install root (default: ~/.mpl/install)
  MPL_SOURCE_DIR       Persistent MPL source dir (default: ~/.mpl/install/source/mpl)
  MPL_RUNTIME          Runtime when --runtime is omitted
  MPL_CLAUDE_SCOPE     Claude plugin scope: user, project, local, or ask (default: user)

Examples:
  curl -fsSL https://raw.githubusercontent.com/KyubumShin/MPL/main/install.sh | bash -s -- --runtime claude --scope user
  curl -fsSL https://raw.githubusercontent.com/KyubumShin/MPL/main/install.sh | bash -s -- --runtime codex
  curl -fsSL https://raw.githubusercontent.com/KyubumShin/MPL/main/install.sh | bash -s -- --runtime both --scope user
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime)
      [ "$#" -ge 2 ] || { echo "error: --runtime requires a value" >&2; exit 1; }
      MPL_RUNTIME="$2"
      shift 2
      ;;
    --scope)
      [ "$#" -ge 2 ] || { echo "error: --scope requires a value" >&2; exit 1; }
      MPL_CLAUDE_SCOPE="$2"
      shift 2
      ;;
    --ref)
      [ "$#" -ge 2 ] || { echo "error: --ref requires a value" >&2; exit 1; }
      MPL_REF="$2"
      MPL_REF_PROVIDED=1
      shift 2
      ;;
    --source-dir)
      [ "$#" -ge 2 ] || { echo "error: --source-dir requires a value" >&2; exit 1; }
      MPL_SOURCE_DIR="$2"
      shift 2
      ;;
    --repo)
      [ "$#" -ge 2 ] || { echo "error: --repo requires a value" >&2; exit 1; }
      MPL_REPO="$2"
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

case "${MPL_RUNTIME}" in
  auto|claude|codex|both|all) ;;
  *)
    echo "error: invalid runtime: ${MPL_RUNTIME}" >&2
    usage >&2
    exit 1
    ;;
esac

case "${MPL_CLAUDE_SCOPE}" in
  user|project|local|ask) ;;
  *)
    echo "error: invalid Claude plugin scope: ${MPL_CLAUDE_SCOPE}" >&2
    echo "Use --scope user, --scope project, --scope local, or --scope ask." >&2
    exit 1
    ;;
esac

case "${MPL_REPO}" in
  */*/*|""|/*|*/|*//*|*[!A-Za-z0-9_./-]*)
    echo "error: invalid GitHub repo: ${MPL_REPO}" >&2
    echo "Use --repo owner/repo or MPL_REPO=owner/repo." >&2
    exit 1
    ;;
  */*) ;;
  *)
    echo "error: invalid GitHub repo: ${MPL_REPO}" >&2
    echo "Use --repo owner/repo or MPL_REPO=owner/repo." >&2
    exit 1
    ;;
esac

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command not found: $1" >&2
    exit 1
  fi
}

replace_dir() {
  local new_dir="$1"
  local target_dir="$2"
  local old_dir="${target_dir}.old.$$"

  mkdir -p "$(dirname -- "${target_dir}")"
  rm -rf "${old_dir}"
  if [ -e "${target_dir}" ]; then
    mv "${target_dir}" "${old_dir}"
  fi

  if ! mv "${new_dir}" "${target_dir}"; then
    if [ -e "${old_dir}" ] && [ ! -e "${target_dir}" ]; then
      mv "${old_dir}" "${target_dir}" || true
    fi
    echo "error: failed to replace ${target_dir}" >&2
    exit 1
  fi

  rm -rf "${old_dir}"
}

write_manifest() {
  local source_dir="$1"
  local manifest_tmp
  manifest_tmp="$(mktemp "${TMPDIR:-/tmp}/mpl-manifest.XXXXXX")"
  (
    cd "${source_dir}"
    find . -type f ! -path "./.mpl-install-manifest" -print | LC_ALL=C sort | sed "s#^\./##"
  ) >"${manifest_tmp}"
  mv "${manifest_tmp}" "${source_dir}/.mpl-install-manifest"
}

verify_archive_sha256() {
  local archive_path="$1"
  local expected="$2"
  local actual=""

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "${archive_path}")"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "${archive_path}")"
  else
    echo "error: MPL_TARBALL_SHA256 is set but sha256sum/shasum was not found" >&2
    exit 1
  fi
  actual="${actual%% *}"

  if [ "${actual}" != "${expected}" ]; then
    echo "error: archive SHA256 mismatch" >&2
    echo "expected: ${expected}" >&2
    echo "actual:   ${actual}" >&2
    exit 1
  fi
}

download_source() {
  require_command tar
  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/mpl-install.XXXXXX")"
  local archive_path="${tmp_dir}/mpl.tar.gz"
  local extract_dir="${tmp_dir}/source"

  __mpl_cleanup_download() {
    rm -rf "${tmp_dir}"
  }
  trap __mpl_cleanup_download EXIT

  if [ -n "${MPL_TARBALL_PATH}" ]; then
    cp "${MPL_TARBALL_PATH}" "${archive_path}"
  else
    require_command curl
    local url="${MPL_TARBALL_URL}"
    if [ -z "${url}" ]; then
      url="https://github.com/${MPL_REPO}/archive/${MPL_REF}.tar.gz"
    fi
    echo "[MPL] Downloading ${url}..."
    curl -fsSL "${url}" -o "${archive_path}"
  fi

  if [ -n "${MPL_TARBALL_SHA256}" ]; then
    verify_archive_sha256 "${archive_path}" "${MPL_TARBALL_SHA256}"
  fi

  mkdir -p "${extract_dir}"
  tar -xzf "${archive_path}" -C "${extract_dir}" --strip-components=1

  if [ ! -f "${extract_dir}/.claude-plugin/plugin.json" ] || [ ! -f "${extract_dir}/.codex-plugin/plugin.json" ]; then
    echo "error: downloaded MPL source is missing runtime manifests" >&2
    exit 1
  fi

  write_manifest "${extract_dir}"
  replace_dir "${extract_dir}" "${MPL_SOURCE_DIR}"
  echo "[MPL] Installed MPL source at ${MPL_SOURCE_DIR}"
  SOURCE_ROOT="${MPL_SOURCE_DIR}"
  SOURCE_KIND="archive"
  __mpl_cleanup_download
  trap - EXIT
  unset -f __mpl_cleanup_download
  return 0
}

SOURCE_ROOT=""
SOURCE_KIND=""
SCRIPT_PATH="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
if [ -n "${SCRIPT_PATH}" ] && [ -f "${SCRIPT_PATH}" ]; then
  SCRIPT_DIR="$(cd -- "$(dirname -- "${SCRIPT_PATH}")" && pwd)"
fi

if [ "${MPL_FORCE_DOWNLOAD}" != "1" ] && [ -n "${SCRIPT_DIR}" ] && [ -f "${SCRIPT_DIR}/.claude-plugin/plugin.json" ] && [ -f "${SCRIPT_DIR}/.codex-plugin/plugin.json" ]; then
  SOURCE_ROOT="${SCRIPT_DIR}"
  if [ "${MPL_REF_PROVIDED}" = "1" ]; then
    echo "[MPL] Warning: --ref/MPL_REF=${MPL_REF} is ignored while using local MPL source at ${SOURCE_ROOT}. Set MPL_FORCE_DOWNLOAD=1 to download that ref instead." >&2
  fi
  if command -v git >/dev/null 2>&1 && git -C "${SOURCE_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    SOURCE_KIND="checkout"
  else
    SOURCE_KIND="local"
    write_manifest "${SOURCE_ROOT}"
  fi
  echo "[MPL] Using local MPL source at ${SOURCE_ROOT}"
else
  download_source
fi

install_claude=0
install_codex=0
case "${MPL_RUNTIME}" in
  auto)
    if command -v "${CLAUDE_BIN:-claude}" >/dev/null 2>&1; then install_claude=1; fi
    if command -v "${CODEX_BIN:-codex}" >/dev/null 2>&1; then install_codex=1; fi
    if [ "${install_claude}" = 0 ] && [ "${install_codex}" = 0 ]; then
      echo "error: neither Claude Code CLI nor Codex CLI was found" >&2
      echo "Install one runtime CLI, or set CLAUDE_BIN/CODEX_BIN." >&2
      exit 1
    fi
    if [ "${install_claude}" = 1 ] && [ "${install_codex}" = 1 ]; then
      echo "[MPL] Auto-detected Claude Code and Codex CLI. Use --runtime to install only one runtime."
    elif [ "${install_claude}" = 1 ]; then
      echo "[MPL] Auto-detected Claude Code. Use --runtime to override."
    else
      echo "[MPL] Auto-detected Codex CLI. Use --runtime to override."
    fi
    ;;
  claude) install_claude=1 ;;
  codex) install_codex=1 ;;
  both|all) install_claude=1; install_codex=1 ;;
esac

if [ "${install_claude}" = 1 ]; then
  echo "[MPL] Installing for Claude Code with ${MPL_CLAUDE_SCOPE} scope..."
  MPL_BOOTSTRAP_SOURCE_KIND="${SOURCE_KIND}" MPL_CLAUDE_SCOPE="${MPL_CLAUDE_SCOPE}" bash "${SOURCE_ROOT}/install/claude.sh"
fi

if [ "${install_codex}" = 1 ]; then
  echo "[MPL] Installing for Codex CLI..."
  MPL_BOOTSTRAP_SOURCE_KIND="${SOURCE_KIND}" MPL_ALLOW_NONGIT_SOURCE=1 bash "${SOURCE_ROOT}/install/codex.sh"
fi

echo "[MPL] Install complete."
if [ "${SOURCE_KIND}" = "archive" ]; then
  echo "[MPL] To update MPL later, rerun this install.sh command. Use MPL_REF=<ref> to pin a branch or tag."
fi
