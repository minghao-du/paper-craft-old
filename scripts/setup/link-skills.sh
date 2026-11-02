#!/usr/bin/env bash
set -euo pipefail

# Links all skills in the repository into the local skill directories used by
# each agent harness:
#   - ~/.claude/skills: Claude Code
#   - ~/.agents/skills: Codex and other Agent Skills-compatible harnesses
# Each entry is a symlink into this repo, so a `git pull` is all that's needed
# to keep installed skills up to date.

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DESTS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dest)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { echo 'usage: link-skills.sh [--dest <skill-directory>]...' >&2; exit 2; }
      DESTS+=("$2"); shift 2 ;;
    --help|-h)
      echo 'usage: link-skills.sh [--dest <skill-directory>]...'
      echo 'Defaults: ~/.claude/skills and ~/.agents/skills. Includes shared lib resources.'
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
if [ "${#DESTS[@]}" -eq 0 ]; then
  DESTS=("$HOME/.claude/skills" "$HOME/.agents/skills")
fi

# Collect every skill directory that contains a SKILL.md.
names=()
srcs=()
while IFS= read -r -d '' skill_md; do
  src="$(dirname "$skill_md")"
  names+=("$(basename "$src")")
  srcs+=("$src")
done < <(find "$REPO/skills" -name SKILL.md -not -path '*/node_modules/*' -print0)
names+=(lib)
srcs+=("$REPO/skills/lib")

for DEST in "${DESTS[@]}"; do
  # If $DEST is a symlink that resolves into this repo, we'd end up writing the
  # per-skill symlinks back into the repo's own skills/ tree. Detect and bail
  # out instead of polluting the working copy.
  if [ -L "$DEST" ]; then
    resolved="$(cd "$DEST" && pwd -P)"
    case "$resolved" in
      "$REPO"|"$REPO"/*)
        echo "error: $DEST is a symlink into this repo ($resolved)." >&2
        echo "Remove it (rm \"$DEST\") and re-run; the script will recreate it as a real dir." >&2
        exit 1
        ;;
    esac
  fi

  # Check every target before modifying this destination. Shared lib may belong
  # to another project; leave it intact rather than replacing its resources.
  for i in "${!names[@]}"; do
    target="$DEST/${names[$i]}"
    if { [ -e "$target" ] && [ ! -L "$target" ]; } ||
       { [ "${names[$i]}" = lib ] && [ -L "$target" ] && [ "$(readlink "$target")" != "${srcs[$i]}" ]; }; then
      echo "error: $target already exists; choose another --dest or relocate the conflicting entry." >&2
      exit 1
    fi
  done

  mkdir -p "$DEST"

  # Remove retired links owned by this checkout, preserving other installations.
  for target in "$DEST"/*; do
    [ -L "$target" ] || continue
    source="$(readlink "$target")"
    case "$source" in
      "$REPO"/skills/*)
        [ -e "$source" ] || rm "$target"
        ;;
    esac
  done

  for i in "${!names[@]}"; do
    name="${names[$i]}"
    src="${srcs[$i]}"
    target="$DEST/$name"

    ln -sfn "$src" "$target"
    echo "linked $name -> $src ($DEST)"
  done
done
