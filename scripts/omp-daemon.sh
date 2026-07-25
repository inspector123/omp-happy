#!/usr/bin/env bash
# Run the omp-happy daemon so the phone can spawn omp sessions on this machine
# (＋ New session → omp). Isolated from a real Happy install via HAPPY_HOME_DIR.
#
# Usage:
#   scripts/omp-daemon.sh start     # start (or no-op if running)
#   scripts/omp-daemon.sh status
#   scripts/omp-daemon.sh stop
#   scripts/omp-daemon.sh restart   # after rebuilding the CLI
#
# HAPPY_SERVER_URL is required so the daemon never contacts an unrelated server.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export HAPPY_HOME_DIR="${HAPPY_HOME_DIR:-$HOME/.omp-happy}"
: "${HAPPY_SERVER_URL:?Set HAPPY_SERVER_URL to your Happy server origin (for example http://127.0.0.1:3005)}"
export HAPPY_SERVER_URL
export PATH="$PATH:$HOME/.local/bin"   # so `omp` resolves

CLI="$REPO_ROOT/packages/happy-cli/bin/happy.mjs"
cmd="${1:-start}"

case "$cmd" in
  restart) node "$CLI" daemon stop >/dev/null 2>&1 || true; exec node "$CLI" daemon start ;;
  *)       exec node "$CLI" daemon "$cmd" ;;
esac
