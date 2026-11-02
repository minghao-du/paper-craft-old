#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
usage() { echo 'Usage: pc worker release <dispatch-id> [--root <dir>] [--fleet <id>]'; }
if [ $# -eq 0 ] || [ "$1" = --help ] || [ "$1" = -h ]; then usage; exit 0; fi
id=$1; shift
root=$PWD fleet=default
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || { usage >&2; exit 1; }
  case "$1" in --root) root=$2 ;; --fleet) fleet=$2 ;; *) echo "Unknown option: $1" >&2; exit 1 ;; esac
  shift 2
done
dispatch_dir=$(node "$SCRIPT_DIR/pc-worker-wait-state.mjs" locate "$root" "$fleet" "$id")
if [ ! -f "$dispatch_dir/EXIT.json" ]; then
  pane=$(node "$SCRIPT_DIR/pc-worker-state.mjs" get "$dispatch_dir" tmux_pane)
  command -v tmux >/dev/null || { echo 'Cannot verify worker termination' >&2; exit 1; }
  panes=$(tmux list-panes -a -F '#{pane_id} #{pane_dead}') || { echo 'Cannot verify worker termination' >&2; exit 1; }
  [[ -n $pane && $pane != null ]] || exit 1
  if printf '%s\n' "$panes" | grep -Fqx "$pane 0"; then echo 'Worker still active' >&2; exit 1; fi
fi
node "$SCRIPT_DIR/pc-worker-wait-state.mjs" release "$dispatch_dir"
