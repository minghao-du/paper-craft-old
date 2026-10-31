#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
usage() {
  cat <<'HELP'
Usage: pc worker spawn <issue-id> <role> [options]
  --run <id>        Run identifier (required when multiple Runs exist)
  --runner <cmd>    Override Run runner command; brief path is appended as one argument
  --root <dir>      Repository/runtime root (default: current directory)
  --fleet <id>      Fleet identifier (default: default)
  -h, --help       Show help
HELP
}
if [ $# -eq 0 ]; then usage; exit 0; fi
for arg in "$@"; do if [ "$arg" = --help ] || [ "$arg" = -h ]; then usage; exit 0; fi; done
if [ "$1" != spawn ] || [ $# -lt 3 ]; then usage >&2; exit 1; fi
issue=$2 role=$3; shift 3
root=$PWD fleet=default run='' runner=''
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || { echo "Expected value for $1" >&2; exit 1; }
  case "$1" in
    --root) root=$2 ;; --fleet) fleet=$2 ;; --run) run=$2 ;; --runner) runner=$2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift 2
done
command -v tmux >/dev/null || { echo 'Expected tmux on PATH' >&2; exit 1; }
root=$(cd -- "$root" && pwd -P)
git -C "$root" rev-parse --show-toplevel >/dev/null
home=$(node "$SCRIPT_DIR/pc-worker-state.mjs" prepare "$issue" "$role" "$root" "$fleet" "$run" "$runner")
get() { node "$SCRIPT_DIR/pc-worker-state.mjs" get "$home" "$1"; }
worktree=$(get worktree) branch=$(get branch) session=$(get tmux_session)
# On launch failure keep the dispatch and lock as recovery evidence.
git -C "$root" worktree add -b "$branch" "$worktree" HEAD >&2
if ! tmux has-session -t "$session" 2>/dev/null; then
  tmux new-session -d -s "$session" -n control || tmux has-session -t "$session"
fi
printf -v command 'bash %q' "$home/launch.sh"
pane=$(tmux new-window -d -P -F '#{pane_id}' -t "$session:" -n "worker-${home##*/}" "$command")
node "$SCRIPT_DIR/pc-worker-state.mjs" launched "$home" "$pane"
