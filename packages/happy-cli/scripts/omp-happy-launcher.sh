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
if [ -z "${HAPPY_SERVER_URL:-}" ]; then
  printf '%s\n' 'HAPPY_SERVER_URL is required; set it to your Happy server origin.' >&2
  exit 64
fi
export HAPPY_SERVER_URL
if [ "${1:-}" = "attach" ]; then
  exec node "$HAPPY_OMP_CLI" omp "$@"
fi

# The Telegram bridge is an opt-in extension that only some machines install.
# Pass it when present so a machine without it does not log a load failure.
TG_BRIDGE="$HOME/.omp/agent/extensions/tg_bridge.ts"
if [ -f "$TG_BRIDGE" ]; then
  set -- --extension "$TG_BRIDGE" "$@"
fi

exec node "$HAPPY_OMP_CLI" omp -- "$@"
