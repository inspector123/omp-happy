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
# Override the server with HAPPY_SERVER_URL=... (defaults to a LAN address).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export HAPPY_HOME_DIR="${HAPPY_HOME_DIR:-$HOME/.omp-happy}"
export HAPPY_SERVER_URL="${HAPPY_SERVER_URL:-http://192.168.0.252:30003}"
export PATH="$PATH:$HOME/.local/bin"   # so `omp` resolves

CLI="$REPO_ROOT/packages/happy-cli/bin/happy.mjs"
cmd="${1:-start}"

case "$cmd" in
  restart) node "$CLI" daemon stop >/dev/null 2>&1 || true; exec node "$CLI" daemon start ;;
  *)       exec node "$CLI" daemon "$cmd" ;;
esac
