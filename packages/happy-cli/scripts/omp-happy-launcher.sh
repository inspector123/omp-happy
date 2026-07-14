#!/bin/sh
set -eu

REAL_OMP="${OMP_HAPPY_REAL_BIN:-$HOME/.local/bin/omp}"
HAPPY_OMP_CLI="${HAPPY_OMP_CLI:-$HOME/projects/omp-happy/packages/happy-cli/bin/happy.mjs}"

if [ ! -x "$REAL_OMP" ] || [ ! -f "$HAPPY_OMP_CLI" ]; then
  exec "$REAL_OMP" "$@"
fi

previous_argument=
for argument in "$@"; do
  case "$argument" in
    --mode=rpc|--mode=rpc-ui|--help|-h|--version|-v)
      exec "$REAL_OMP" "$@"
      ;;
  esac
  case "$previous_argument:$argument" in
    --mode:rpc|--mode:rpc-ui)
      exec "$REAL_OMP" "$@"
      ;;
  esac
  previous_argument="$argument"
done

if [ "${1:-}" = "acp" ] || [ "${1:-}" = "update" ]; then
  exec "$REAL_OMP" "$@"
fi

export OMP_HAPPY_REAL_BIN="$REAL_OMP"
export HAPPY_HOME_DIR="${HAPPY_HOME_DIR:-$HOME/.omp-happy}"
export HAPPY_SERVER_URL="${HAPPY_SERVER_URL:-http://192.168.0.252:30003}"
if [ "${1:-}" = "attach" ]; then
  exec node "$HAPPY_OMP_CLI" omp "$@"
fi

exec node "$HAPPY_OMP_CLI" omp -- "$@"
