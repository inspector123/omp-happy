#!/usr/bin/env bash
# Launch the forked Happy CLI driving omp as a first-class agent.
#
# - Uses an ISOLATED happy home dir (HAPPY_HOME_DIR) so it never touches a real
#   Happy install (~/.happy). First run prints a QR — scan it with the OMP app.
# - --local drops you into an interactive omp prompt in THIS terminal while the
#   session is mirrored to your phone, so either side can drive it.
#
# Override the server with HAPPY_SERVER_URL=... (defaults to a LAN address).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export HAPPY_HOME_DIR="${HAPPY_HOME_DIR:-$HOME/.omp-happy}"
export HAPPY_SERVER_URL="${HAPPY_SERVER_URL:-http://192.168.0.252:30003}"
export PATH="$PATH:$HOME/.local/bin"   # so `omp` resolves

exec node "$REPO_ROOT/packages/happy-cli/bin/happy.mjs" acp omp --local "$@"
