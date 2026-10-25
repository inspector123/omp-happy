#!/usr/bin/env bash
# Install omp thread memory from this repo directory.
#
# Every omp session loads the extension. After each assistant reply it indexes the session's new
# turns into one shared SQLite file, and it gives the agent the thread_search and thread_open tools
# plus a /threads command, so a thread from any session can be picked up from any other session.
# The index is derived from the session JSONL files: delete it and `omp-threads sync` rebuilds it.
#
#   ~/.omp/agent/extensions/thread-memory.ts   the extension (symlink to this directory)
#   ~/.local/bin/omp-threads                    shell search CLI (symlink)
#   ~/.omp/agent/thread-memory/threads.db       the index
#
# Any pre-existing real file is moved aside to <name>.pre-repo.bak, never deleted.
#
#   ./install.sh            link both, then index existing sessions in the background
#   ./install.sh status     show the links and index statistics
#   ./install.sh uninstall  remove only our symlinks; the index stays
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT="$HOME/.omp/agent/extensions/thread-memory.ts"
BIN="$HOME/.local/bin/omp-threads"
DATA_DIR="$HOME/.omp/agent/thread-memory"

# src -> destination
LINKS=(
  "thread-memory.ts|$EXT"
  "omp-threads|$BIN"
)

link_one() {
  local src="$SRC/$1" dst="$2"
  [ -e "$src" ] || { echo "missing source: $src" >&2; exit 1; }
  mkdir -p "$(dirname "$dst")"
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

install() {
  command -v bun >/dev/null 2>&1 || { echo "bun is required on PATH" >&2; exit 1; }
  chmod +x "$SRC/omp-threads"
  echo "linking"
  for entry in "${LINKS[@]}"; do link_one "${entry%%|*}" "${entry##*|}"; done
  mkdir -p "$DATA_DIR"
  chmod 700 "$DATA_DIR"
  nohup "$SRC/omp-threads" sync > "$DATA_DIR/sync.log" 2>&1 &
  echo "indexing existing sessions in the background: pid $!, log $DATA_DIR/sync.log"
  echo "new omp sessions load the extension; running sessions pick it up when restarted"
}

uninstall() {
  for entry in "${LINKS[@]}"; do
    local dst="${entry##*|}"
    if [ -L "$dst" ] && [ "$(readlink -f "$dst")" = "$SRC/${entry%%|*}" ]; then
      rm "$dst"
      echo "  removed $dst"
    fi
    if [ -e "$dst.pre-repo.bak" ] && [ ! -e "$dst" ]; then
      mv "$dst.pre-repo.bak" "$dst"
      echo "  restored $dst"
    fi
  done
  echo "the index at $DATA_DIR was kept"
}

status() {
  echo "links"
  for entry in "${LINKS[@]}"; do
    local dst="${entry##*|}"
    if [ -L "$dst" ] && [ "$(readlink -f "$dst")" = "$SRC/${entry%%|*}" ]; then
      echo "  ok   $dst"
    else
      echo "  NOT INSTALLED  $dst"
    fi
  done
  echo "index"
  "$SRC/omp-threads" stats 2>&1 | sed 's/^/  /'
}

case "${1:-install}" in
  install) install ;;
  uninstall) uninstall ;;
  status) status ;;
  *) echo "usage: $0 [install|uninstall|status]" >&2; exit 2 ;;
esac
