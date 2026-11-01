---
name: pc-helper
description: Start, coordinate, resume and retire a durable helper through tmux or a supported background runner when work must outlive the primary session
---

# /pc-helper

Read [the shared runtime and workflow contract](../lib/workflow.md) before using helper commands or runtime-specific tools.
Tmux is shared infrastructure; Claude-specific tool names and examples apply only when that runner provides them, with file-based delivery otherwise.

A helper is a separate agent session that you, the primary, start in tmux or a supported background runner and later shut down.
It is not an `Agent` subagent: a subagent lives inside your process, reports only to you, and dies with you.
A helper has its own context window, keeps running through your compaction or restart, records results durably and optionally messages supported sessions, and the user can attach to it.
Reach for a subagent when the work fits in one call and only you need the answer; reach for a helper when it outlives your turn or talks to other sessions.

## Usage

```
/pc-helper start <role> "<brief>"   # role is a short word: review, gate, build
/pc-helper stop <role>
/pc-helper sweep
```

## Execution mode

Choose one implementation and read it before `start`, talking/resuming, `stop` or `sweep`:

- [Tmux](tmux/guide.md): a separate terminal running the selected agent runner.
- [Claude Code background](claude-background/guide.md): `claude --bg`, when supported.

Use that implementation throughout the helper's lifecycle, starting from its recorded pane or job identity on later turns.
The home, ownership, result, record and cleanup rules below apply to both modes.

## Rules

- Apply [Project instructions in every dispatch](../lib/workflow.md#project-instructions-in-every-dispatch) to helper startup and resume briefs, using the project checkout separately from the helper's home directory.

- **Every helper owns a home directory, `$HELPERS/<name>/`.**
  Its `result.md`, every extra checkout it makes, and every file it cites as evidence live there, so `stop` and `sweep` see all of it.
- **The helper works in a directory of its own.**
  Never a checkout another live session works in: `/pc-issue-work` sends a co-tenant's branch work into a worktree, and the reclaim protocol blocks reuse while any owner or job still uses the slot.
  A pooled clone is allowed only when it is available and you hold it first (start, step 2).
  A `--bg` helper has no tmux window, so the hold is the only thing that marks the clone as in use.
- **A worker in a pooled slot does not start helpers.**
  Its helper's checkouts would hang off the slot's repo, and the portable reclaim check cannot retire them, so they would outlive the slot.
  Ask the epic or the orchestrator to start one instead.
- **Delete with `find <path> -delete`, never `rm`.**
  A `$` in the same command as `rm` trips Claude Code's destructive-removal guard, which bypass mode does not suppress.
- **Kill only by the recorded short id**, never `pgrep`/`pkill`, a name, or argv: a spawn prompt is argv, so a pattern can match your own shell.

## Records

```bash
HELPERS="/absolute/path/to/configured/project/_ignore/helpers"
# $HELPERS/<short-id>.json   written by the primary at start:
#   {"id","session_id","name","primary","home","dir","dir_kind":"worktree|held-clone","hold"}
# $HELPERS/<name>/           the helper's home
# $HELPERS/<name>/result.md  written by the helper, one appended section per round
```

## start

1. **Name it and make its home.**
   Use the assigned primary identifier or the selected runner's exact returned identity (`ListAgents`' own row in the Claude branch).
   The helper is `<primary>-<role>`.
   If `ListAgents` shows that name or `$HELPERS/<primary>-<role>` already exists, pick another role word.
   ```bash
   HELPERS="/absolute/path/to/configured/project/_ignore/helpers"
   HOME_DIR="$HELPERS/<primary>-<role>"
   mkdir -p "$HOME_DIR"
   ```

2. **Pick its working directory `DIR`.**
   - Research, review, messaging, or code changes: a detached worktree of your own repo off `origin/main`, inside the home, `KIND=worktree`; tell a research-only helper the checkout is read-only.
     ```bash
     git -C <repo> fetch -q origin
     DIR="$HOME_DIR/$(basename "$(git -C <repo> rev-parse --show-toplevel)")"
     git -C <repo> worktree add --detach "$DIR" origin/main
     ```
     It branches there itself (for example via `/pc-issue-work`), as the checkout's only session.
   - Gates or builds that need a built environment (a `.pixi` env, a vendored binary), where a fresh worktree would pay a full install first: the owning managed Orchestrator can reserve an available pooled clone through its lifecycle contract, `KIND=held-clone`:
     ```bash
     CONFIG=/absolute/path/to/orchestrator/.epic-config.json
     CLONE_ROOT=$(pc workflow root --config "$CONFIG" --path) || exit 2
     HOLD="$CLONE_ROOT/.holds/<clone>"
     mkdir -p "$CLONE_ROOT/.holds" && echo "helper <primary>-<role>" > "$HOLD"
     DIR="$CLONE_ROOT/<clone>"
     ```
     Run it from your own checkout, where `.epic-config.json` lives.
     Use the authoritative orchestrator config; the shared CLI resolves and validates its paths.
     Write the hold before anything else touches the clone, then confirm the clone is still `available`; if it is not, delete the hold and pick another.

3. **Write the brief.**
   The helper starts with no other context.
   Beyond the task, the brief gives your name (it reports to you by `SendMessage`), its home and working directory as expanded paths, and these rules:
   - extra checkouts and anything it cites go under its home, never its scratchpad;
   - after each round, append a timed section with findings and evidence paths to `result.md` (the durable record), then report to the primary; if that send fails, the primary was likely renamed on a restart — re-resolve it from `ListAgents` by name prefix and resend;
   - leave a held clone clean and on `main`;
   - no merging, no pushing to main, no other checkouts, no helpers of its own.

4. **Start it** from `$DIR`, within the current task authorization.
   Follow the chosen implementation’s **Start** procedure. Record only a verified launch.

5. **Write the record.**
   `HOLD` is empty unless `KIND=held-clone`.
   ```bash
   jq -n --arg id "$ID" --arg sid "$SID" --arg name "<primary>-<role>" --arg primary "<primary>" \
       --arg home "$HOME_DIR" --arg dir "$DIR" --arg kind "$KIND" --arg hold "${HOLD:-}" \
       '{id:$id, session_id:$sid, name:$name, primary:$primary, home:$home, dir:$dir, dir_kind:$kind, hold:$hold}' \
       > "$HELPERS/$ID.json"
   ```

6. **Confirm reports flow both ways.**
   Follow the chosen implementation’s **Confirm reports** procedure.

## Finding a helper's record

`stop`, `sweep`, and a later turn start from the record, not from shell variables left over from `start`:

```bash
HELPERS="/absolute/path/to/configured/project/_ignore/helpers"
R=$(jq -r --arg n "<primary>-<role>" 'select(.name==$n) | input_filename' "$HELPERS"/*.json)
```

If `R` names no file or more than one, stop and show the user the records.
Read `id`, `session_id`, `home`, `dir`, `dir_kind`, and `hold` from `$R` with `jq -r`.

## Talking to it

- Read `result.md` in its home first; each round it finished has a section there.
  Resume it only for a new round or a question the file does not answer.
- Use the chosen implementation’s **Talk and resume** procedure.

## stop

1. Ask it to wrap up: commit and push anything it owns, append its last section to `result.md`, then report to you.
   If it is stopped, resume it for this.
2. Confirm every owner and dependent job released the directory before cleanup.
   Follow the chosen implementation’s **Stop** procedure before continuing with directory cleanup.
3. Remove every worktree under the home:
   ```bash
   find "$HOME_DIR" -mindepth 2 -maxdepth 3 -name .git -type f | while read -r g; do
       w=$(dirname "$g"); git -C "$w" worktree remove "$w" || echo "KEEP $w"
   done
   ```
   `worktree remove` refuses on uncommitted or untracked files; for each `KEEP`, show the user rather than forcing.
4. For a held clone, never delete the clone.
   If all owners/jobs released it, `git -C "$DIR" status --porcelain` is empty and it is on `main`, lift the recorded hold with `find "$(dirname "$hold")" -maxdepth 1 -name "$(basename "$hold")" -delete`.
   Otherwise keep the hold and show the user what the helper left.
5. The home holds `result.md` and the evidence it cites, which may be quoted on GitHub.
   Show the user the evidence paths `result.md` lists and ask before `find "$HOME_DIR" -delete`; if nothing is listed and step 3 kept nothing, delete it.
6. Delete the record with `find "$HELPERS" -maxdepth 1 -name "<id>.json" -delete`, and tell the user the helper is gone.

## sweep

For each record in `$HELPERS`, verify the recorded pane or job against the selected runner's actual state.
Follow the chosen implementation’s **Sweep** procedure.

Report and ask; do not stop or remove anything in a sweep without the user's go-ahead.
Match on the record's `id` only — never infer a helper from a name prefix in the listing.
