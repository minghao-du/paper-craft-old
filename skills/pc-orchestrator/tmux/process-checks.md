# Tmux fleet process checks

Use during slot occupancy and liveness inspection from [pc-orchestrator](../SKILL.md). Linux/Agy examples apply to managed runs and tmux panes.

A runner may carry its entire spawn prompt in argv, so **never match argv** (`pgrep -f`, `ps | grep`) for a question about processes: it matches every worker whose prompt mentions the string, and the asking shell itself. Enumerate tmux panes or check processes by exact name and attribute by working directory:

```bash
# Tmux pane enumeration across fleet sessions
tmux list-panes -a -F "#{session_name} #{window_id} #{pane_id} #{pane_pid} #{pane_current_path}"

# Which clone is each live Agy session in?
for pid in $(pgrep -x agy); do
  printf '%s\t%s\n' "$pid" "$(readlink /proc/$pid/cwd 2>/dev/null)"
done
```

- `pgrep -x` is not fleet-scoped; filter on the cwd being under `$CLONE_ROOT`.
- To ask "what is running in my pool", don't hand-list names: enumerate tmux panes (`tmux list-panes -s -t <session>`) or take `/proc/<pid>/comm` for every pid whose cwd is under `$CLONE_ROOT`, `sort | uniq -c` (test runners are named neither `zig` nor after the product).
- On shared hosts, scope with `-u $(id -u)`. You cannot read another user's `/proc/<pid>/cwd`; treat an unreadable cwd as foreign and report own and foreign counts separately.
- To wait on something you launched, poll its `$!`, never a pattern — or background it and let the harness re-invoke you.
- Load average answers "is this host contended", not "is my job still running": enumerate processes or tmux panes for occupancy.
- zsh does not word-split an unquoted `$VAR`, so `$EXTRA` holding several flags is one argument. Write flags literally or use an array, and read a failing arm's stderr before recording a non-result.
- argv size separates workers from interactive sessions without reading content: `wc -c < /proc/<pid>/cmdline` is over ~1 KB for a spawned worker, under ~100 B for a hand-started session.

Where you must identify a process you did not launch:

```bash
n=0
for p in $(pgrep -x agy); do
  [ "$p" = "$$" ] && continue
  [ "$(readlink /proc/$p/cwd 2>/dev/null)" = "$PWD" ] && n=$((n+1))
done
echo "$n"
```

**A slot blocked on a foreground shell wait** is not idle:
Sweep whenever a pane appears blocked, and on any full reconciliation:

```bash
# Check pane processes and commands across tmux
for pane in $(tmux list-panes -a -F "#{pane_id}"); do
  cmd=$(tmux display-message -p -t "$pane" "#{pane_current_command}")
  pid=$(tmux display-message -p -t "$pane" "#{pane_pid}")
  echo "$pane|$pid|$cmd"
done

# Inspect child shell processes under agy
for pid in $(pgrep -x zsh; pgrep -x bash; pgrep -x sh); do
  [ "$pid" = "$$" ] && continue
  cwd=$(readlink /proc/$pid/cwd 2>/dev/null); case "$cwd" in "$CLONE_ROOT"/*) ;; *) continue;; esac
  ppid=$(ps -o ppid= -p $pid | tr -d ' '); et=$(ps -o etimes= -p $pid | tr -d ' ')
  parent_comm=$(ps -o comm= -p $ppid 2>/dev/null | tr -d ' ')
  [ "$parent_comm" = "agy" ] || continue
  [ "$et" -gt 600 ] || continue
  echo "$et|$pid|${cwd##*/}"
done | sort -rn
```

Before killing one, confirm no real process of that clone is being waited on (`pgrep -x make` / `-x zig` plus a cwd match).
