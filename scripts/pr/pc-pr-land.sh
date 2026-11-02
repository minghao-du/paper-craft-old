#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
usage() {
  echo 'Usage: pc pr ready-and-merge <pr-id> --dispatch <dispatch-id> --tested-head <sha> [--root <path>]'
  echo 'Verify successful receipt, PR HEAD and checks; squash merge, archive evidence, release worktree.'
}
if [[ ${1-} == --help || $# == 0 ]]; then usage; exit 0; fi
[[ ${1-} == ready-and-merge ]] || { usage >&2; exit 1; }
shift
if [[ ${1-} == --help ]]; then usage; exit 0; fi
pr=${1-}; shift || true
[[ $pr =~ ^[1-9][0-9]*$ ]] || { echo 'Expected positive PR id' >&2; exit 1; }
root=$PWD; dispatch=''; tested=''
while (($#)); do
  case "$1" in
    --root|--dispatch|--tested-head)
      (($# >= 2)) || { echo "Missing value for $1" >&2; exit 1; }
      case "$1" in --root) root=$2;; --dispatch) dispatch=$2;; --tested-head) tested=$2;; esac
      shift 2;;
    *) echo "Unknown option: $1" >&2; exit 1;;
  esac
done
state() { node "$SCRIPT_DIR/pc-pr-state.mjs" "$1" "$root" "$dispatch" "${@:2}"; }
dispatch_dir=$(state prepare "$tested")
mkdir "$dispatch_dir/landing.lock" || { echo 'Active landing lock conflict' >&2; exit 1; }
trap 'rmdir "$dispatch_dir/landing.lock"' EXIT
# Recheck after acquiring the landing lock.
state prepare "$tested" >/dev/null
worktree=$(state get worktree); lock=$(state get lock_path); archive=$(state get archive)
[[ $(git -C "$worktree" rev-parse HEAD) == "$tested" ]] || { echo 'Worker HEAD differs from tested HEAD' >&2; exit 1; }
[[ -z $(git -C "$worktree" status --porcelain) ]] || { echo 'Worker worktree must be clean' >&2; exit 1; }
if [[ ! -f $dispatch_dir/EXIT.json ]]; then
  pane=$(state get tmux_pane)
  if ! panes=$(tmux list-panes -a -F '#{pane_id} #{pane_dead}'); then
    echo 'Cannot verify worker termination' >&2; exit 1
  fi
  if printf '%s\n' "$panes" | grep -Fqx "$pane 0"; then echo 'Worker is still active' >&2; exit 1; fi
fi
cd -- "$root"
gh pr view "$pr" --json headRefOid,state,isDraft,headRefName,statusCheckRollup > "$dispatch_dir/pr-check.json"
state checks "$dispatch_dir/pr-check.json" "$tested"
gh pr checks "$pr" --required >/dev/null
state archive "$tested"
git -C "$worktree" bundle create "$archive/worker.bundle" HEAD
git -C "$root" bundle verify "$archive/worker.bundle" >/dev/null 2>&1
gh pr merge "$pr" --squash --match-head-commit "$tested" >&2
merged_state=$(gh pr view "$pr" --json state --jq .state)
[[ $merged_state == MERGED ]] || { echo 'PR is not merged; preserving worker resources' >&2; exit 1; }
# Ownership may have changed while GitHub ran; preserve the worktree if so.
state prepare "$tested" >/dev/null
git -C "$root" worktree remove "$worktree"
rm -- "$lock/owner.json"
rmdir -- "$lock"
state landed "$tested"
