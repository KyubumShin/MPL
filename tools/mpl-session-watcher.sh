#!/usr/bin/env bash
# MPL Session Watcher (F-33)
# Watches for session-handoff.json and auto-continues in a fresh Claude session.
#
# Usage:
#   ./tools/mpl-session-watcher.sh [project_dir]
#   ./tools/mpl-session-watcher.sh --notify-only [project_dir]
#
# Options:
#   --notify-only   Print message instead of starting new session
#   --interval N    Polling interval in seconds (default: 5)

set -euo pipefail

MODE="auto"
INTERVAL=5
PROJECT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --notify-only) MODE="notify"; shift ;;
    --interval)    INTERVAL="$2"; shift 2 ;;
    *)             PROJECT_DIR="$1"; shift ;;
  esac
done

PROJECT_DIR="${PROJECT_DIR:-.}"
SIGNAL_FILE="${PROJECT_DIR}/.mpl/signals/session-handoff.json"

echo "[mpl-watcher] Watching: ${SIGNAL_FILE}"
echo "[mpl-watcher] Mode: ${MODE}, Interval: ${INTERVAL}s"
echo "[mpl-watcher] Press Ctrl+C to stop"

while true; do
  if [[ -f "$SIGNAL_FILE" ]]; then
    echo ""
    echo "[mpl-watcher] ============================================"
    echo "[mpl-watcher] Handoff signal detected!"
    echo "[mpl-watcher] ============================================"

    # Parse signal file
    if command -v python3 &>/dev/null; then
      PIPELINE_ID=$(python3 -c "import json; d=json.load(open('$SIGNAL_FILE')); print(d.get('pipeline_id','unknown'))" 2>/dev/null || echo "unknown")
      RESUME_PHASE=$(python3 -c "import json; d=json.load(open('$SIGNAL_FILE')); print(d.get('resume_from_phase','unknown'))" 2>/dev/null || echo "unknown")
      REMAINING=$(python3 -c "import json; d=json.load(open('$SIGNAL_FILE')); print(len(d.get('remaining_phases',[])))" 2>/dev/null || echo "?")
    else
      PIPELINE_ID="unknown"
      RESUME_PHASE="unknown"
      REMAINING="?"
    fi

    echo "[mpl-watcher] Pipeline: ${PIPELINE_ID}"
    echo "[mpl-watcher] Resume from: ${RESUME_PHASE}"
    echo "[mpl-watcher] Remaining phases: ${REMAINING}"

    if [[ "$MODE" == "auto" ]]; then
      echo "[mpl-watcher] Cooldown 3s..."
      sleep 3

      # Remove signal before starting (prevent re-trigger)
      rm -f "$SIGNAL_FILE"

      echo "[mpl-watcher] Starting new Claude session..."
      cd "$PROJECT_DIR"
      claude --prompt "/mpl:mpl-resume" &
      CLAUDE_PID=$!

      echo "[mpl-watcher] Session started (PID: ${CLAUDE_PID}). Resuming watch..."
    else
      echo ""
      echo "[mpl-watcher] ▶ Manual resume required:"
      echo "[mpl-watcher]   cd ${PROJECT_DIR} && claude --prompt '/mpl:mpl-resume'"
      echo ""
      # Remove signal after notification
      rm -f "$SIGNAL_FILE"
    fi
  fi

  sleep "$INTERVAL"
done
