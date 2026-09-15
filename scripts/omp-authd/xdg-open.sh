#!/usr/bin/env bash
# xdg-open shim: hand omp's Google OAuth authorize URLs to omp-authd (real Chrome
# over CDP, clicks the account + consent screens) instead of dumping them on a
# browser and waiting for a human. Everything else goes to the real xdg-open.
#
# Repo source of ~/.local/bin/xdg-open; scripts/omp-authd/install.sh symlinks it.
#
# omp's TUI /login panel calls ctx.openInBrowser(url) -> xdg-open <url>, so this
# file is the interception point. ~/.local/bin precedes /usr/bin in PATH.
#
# Escape hatches:
#   OMP_AUTHD_DISABLE=1 xdg-open <url>   -> one-shot passthrough
#   remove this file                     -> global passthrough

REAL=/usr/bin/xdg-open
TARGET="${1:-}"

if [ -n "${OMP_AUTHD_DISABLE:-}" ] || [ -z "$TARGET" ]; then
  exec "$REAL" "$@"
fi

case "$TARGET" in
  https://accounts.google.com/o/oauth2/*)
    if command -v omp-authd >/dev/null 2>&1; then
      mkdir -p "$HOME/.cache/omp-authd/logs"
      {
        echo "$(date -Is) shim intercepted state=$(printf '%s' "$TARGET" | sed -n 's/.*[?&]state=\([0-9a-f]*\).*/\1/p')"
      } >>"$HOME/.cache/omp-authd/logs/shim.log"
      # omp ignores the opener's stdio and does not wait for it, but keep the
      # session alive in the background so the drive survives this process.
      nohup omp-authd complete "$TARGET" >>"$HOME/.cache/omp-authd/logs/shim.log" 2>&1 &
      disown 2>/dev/null || true
      exit 0
    fi
    echo "xdg-open(shim): omp-authd not found; falling through to $REAL" >&2
    ;;
esac

exec "$REAL" "$@"
