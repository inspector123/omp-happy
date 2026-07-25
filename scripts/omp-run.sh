#!/usr/bin/env bash
# Launch the forked Happy CLI driving omp as a first-class agent.
#
# - Uses an ISOLATED happy home dir (HAPPY_HOME_DIR) so it never touches a real
#   Happy install (~/.happy). First run prints a QR — scan it with the OMP app.
# - --local drops you into an interactive omp prompt in THIS terminal while the
#   session is mirrored to your phone, so either side can drive it.
#
# --yolo auto-approves all tool permissions (allow-all). Drop it to be prompted.
# HAPPY_SERVER_URL is required so the fork never contacts an unrelated server.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export HAPPY_HOME_DIR="${HAPPY_HOME_DIR:-$HOME/.omp-happy}"
: "${HAPPY_SERVER_URL:?Set HAPPY_SERVER_URL to your Happy server origin (for example http://127.0.0.1:3005)}"
export HAPPY_SERVER_URL
export PATH="$PATH:$HOME/.local/bin"   # so `omp` resolves

exec node "$REPO_ROOT/packages/happy-cli/bin/happy.mjs" acp omp --local --yolo "$@"
