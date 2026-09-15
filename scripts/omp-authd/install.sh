#!/usr/bin/env bash
# Install the omp-authd OAuth autopilot from this repo directory.
#
# Everything is a symlink, so the repo is the live source of truth: edit the
# file, and the next run (or `systemctl --user restart omp-authd-watch`) uses it.
#
#   ~/.local/bin/omp-authd                      driver: drives Chrome over CDP
#   ~/.local/bin/omp-authd-watch                tmux pane watcher (the service)
#   ~/.local/bin/xdg-open                       shim that intercepts omp's opener
#   ~/.omp/agent/extensions/oauth-autopilot.ts  /gauth + auto re-auth
#   ~/.config/systemd/user/omp-authd-watch.service
#
# Any pre-existing real file is moved aside to <name>.pre-repo.bak, never deleted.
#
#   ./install.sh            install/refresh + restart the watcher
#   ./install.sh status     show what is linked, running, and configured
#   ./install.sh uninstall  remove only our symlinks, restore the backups
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/.local/bin"
EXT_DIR="$HOME/.omp/agent/extensions"
UNIT_DIR="$HOME/.config/systemd/user"
CONF_DIR="$HOME/.config/omp-authd"
UNIT=omp-authd-watch.service

# src -> destination
LINKS=(
  "omp-authd|$BIN_DIR/omp-authd"
  "omp-authd-watch|$BIN_DIR/omp-authd-watch"
  "xdg-open.sh|$BIN_DIR/xdg-open"
  "oauth-autopilot.ts|$EXT_DIR/oauth-autopilot.ts"
  "$UNIT|$UNIT_DIR/$UNIT"
)

link_one() {
  local src="$SRC/$1" dst="$2"
  [ -e "$src" ] || { echo "missing source: $src" >&2; exit 1; }
  case "$(head -c2 "$src" 2>/dev/null || true)" in "#!") chmod +x "$src" ;; esac
  if [ -L "$dst" ]; then
    rm "$dst"
  elif [ -e "$dst" ]; then
    local bak="$dst.pre-repo.bak"
    [ -e "$bak" ] && bak="$dst.pre-repo.$(date +%s).bak"
    mv "$dst" "$bak"
    echo "  backed up $dst -> $(basename "$bak")"
  fi
  ln -s "$src" "$dst"
  echo "  $dst -> $src"
}

systemd_available() { [ -d /run/user/"$(id -u)"/systemd ] && command -v systemctl >/dev/null 2>&1; }

install() {
  command -v bun >/dev/null 2>&1 || echo "WARNING: bun not on PATH; the driver and watcher will not run" >&2
  echo "linking"
  for entry in "${LINKS[@]}"; do link_one "${entry%%|*}" "${entry##*|}"; done
  if [ ! -f "$CONF_DIR/config.json" ]; then
    mkdir -p "$CONF_DIR"
    cat > "$CONF_DIR/config.json" <<EOF
{
  "account": "${OMP_AUTHD_ACCOUNT:-}",
  "cdpPort": 9333,
  "chromeBin": "/usr/bin/google-chrome",
  "display": ":0",
  "timeoutMs": 180000
}
EOF
    chmod 600 "$CONF_DIR/config.json"
    echo "wrote $CONF_DIR/config.json"
  fi
  local acct
  acct="$("$BIN_DIR/omp-authd" status 2>/dev/null | sed -n 's/^account: //p' || true)"
  case "$acct" in
    "" | "(unset"*)
      echo "WARNING: no Google account configured. Set \"account\" in $CONF_DIR/config.json," >&2
      echo "         otherwise a sign-in that reaches Google's account chooser stops there." >&2
      ;;
  esac

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "WARNING: $BIN_DIR is not on PATH; neither the shim nor the watcher will be found" >&2 ;;
  esac
  # The shim only intercepts if ~/.local/bin is searched before /usr/bin.
  local shim_ok=1 found_bin=0 dir
  local old_ifs="$IFS"; IFS=:; set -- $PATH; IFS="$old_ifs"
  for dir in "$@"; do
    [ "$dir" = "$BIN_DIR" ] && found_bin=1
    if [ "$dir" = "/usr/bin" ] && [ "$found_bin" -eq 0 ]; then shim_ok=0; break; fi
  done
  [ "$shim_ok" -eq 0 ] && echo "WARNING: $BIN_DIR comes after /usr/bin on PATH; the xdg-open shim will never run" >&2

  if systemd_available; then
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT"
    systemctl --user restart "$UNIT"
    echo "watcher: $(systemctl --user is-active "$UNIT")"
  else
    echo "NOTE: no user systemd instance; start the watcher by hand: $BIN_DIR/omp-authd-watch" >&2
  fi
  echo
  status
}

uninstall() {
  if systemd_available; then
    systemctl --user disable --now "$UNIT" 2>/dev/null || true
  fi
  for entry in "${LINKS[@]}"; do
    local_src="${entry%%|*}"; dst="${entry##*|}"
    if [ -L "$dst" ] && [ "$(readlink -f "$dst")" = "$SRC/$local_src" ]; then
      rm "$dst"
      echo "  removed $dst"
    fi
    bak="$dst.pre-repo.bak"
    if [ -e "$bak" ] && [ ! -e "$dst" ]; then
      mv "$bak" "$dst"
      echo "  restored $dst"
    fi
  done
  if systemd_available; then systemctl --user daemon-reload; fi
}

status() {
  echo "links"
  for entry in "${LINKS[@]}"; do
    dst="${entry##*|}"
    if [ -L "$dst" ] && [ "$(readlink -f "$dst")" = "$SRC/${entry%%|*}" ]; then
      echo "  ok   $dst"
    else
      echo "  NOT INSTALLED  $dst"
    fi
  done
  echo "service"
  if systemd_available; then
    echo "  $UNIT: $(systemctl --user is-active "$UNIT" 2>/dev/null || echo inactive) (enabled: $(systemctl --user is-enabled "$UNIT" 2>/dev/null || echo no))"
  else
    echo "  user systemd unavailable"
  fi
  echo "driver"
  "$BIN_DIR/omp-authd" status 2>&1 | sed 's/^/  /'
}

case "${1:-install}" in
  install) install ;;
  uninstall) uninstall ;;
  status) status ;;
  *) echo "usage: $0 [install|uninstall|status]" >&2; exit 2 ;;
esac
