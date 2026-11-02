#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
usage() { echo 'Usage: pc worker wait <dispatch-id> [--root <dir>] [--fleet <id>]'; }
if [ $# -eq 0 ] || [ "$1" = --help ] || [ "$1" = -h ]; then usage; exit 0; fi
id=$1; shift
root=$PWD fleet=default
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || { usage >&2; exit 1; }
  case "$1" in --root) root=$2 ;; --fleet) fleet=$2 ;; *) echo "Unknown option: $1" >&2; exit 1 ;; esac
  shift 2
done
dispatch_dir=$(node "$SCRIPT_DIR/pc-worker-wait-state.mjs" locate "$root" "$fleet" "$id")
while true; do
  if [ -f "$dispatch_dir/RECEIPT.md" ]; then cat -- "$dispatch_dir/RECEIPT.md"; exit 0; fi
  reason=''
  if [ -f "$dispatch_dir/EXIT.json" ]; then
    reason='Runner exited without publishing a receipt'
  else
    command -v tmux >/dev/null || { echo 'Cannot determine worker liveness: expected tmux on PATH' >&2; exit 1; }
    pane=$(node "$SCRIPT_DIR/pc-worker-state.mjs" get "$dispatch_dir" tmux_pane)
    [ "$pane" != null ] && [ -n "$pane" ] || { echo 'Cannot determine worker liveness: dispatch launch incomplete' >&2; exit 1; }
    if panes=$(tmux list-panes -a -F '#{pane_id} #{pane_dead}' 2>&1); then
      alive=false
      while read -r candidate dead; do
        if [ "$candidate" = "$pane" ] && [ "$dead" = 0 ]; then alive=true; fi
      done <<< "$panes"
      if [ "$alive" = false ]; then reason='Worker tmux pane terminated without publishing a receipt'; fi
    else
      case "$panes" in
        *'no server running'*|*'no sessions'*|*'No such file or directory'*) reason='Worker tmux server terminated without publishing a receipt' ;;
        *) echo "Cannot determine worker liveness: $panes" >&2; exit 1 ;;
      esac
    fi
  fi
  if [ -n "$reason" ]; then
    node "$SCRIPT_DIR/pc-worker-wait-state.mjs" crash "$dispatch_dir" "$reason"
    cat -- "$dispatch_dir/RECEIPT.md"
    exit 1
  fi
  sleep 0.1
done
