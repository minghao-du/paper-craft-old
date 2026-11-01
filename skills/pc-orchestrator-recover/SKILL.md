---
name: pc-orchestrator-recover
description: Recover tmux workspaces and recorded agent conversations after shutdown or reboot, or set up periodic saving and startup recovery.
---

# Recover a workspace

Read [Lifecycle recovery](../pc-orchestrator/managed-lifecycle.md) before resuming any
role. Restore conversations through the selected runner's supported exact-session
mechanism; runtime layout is separate from EPIC identity, checkout ownership and approval.
If it is unavailable, retain durable state and report manual continuation required.

Reconcile the owning Run before resuming its EPIC or task. A restored worker or
landing agent waits for its Run's verified next assignment before editing.
Conversation restoration alone grants no checkout ownership.

For one Run, reconcile startup receipts and durable results:

```sh
pc workflow orchestrator recover <run> --config /absolute/path/.epic-config.json
```

Use `--replace` only after verified termination of the previous Orchestrator.
To reconcile every incomplete Run independently:

```sh
pc workflow orchestrator recover-all --config /absolute/path/.epic-config.json
```

Unknown occupancy retains resources and exits with code 2. Batch recovery reports each
Run, including provider failures. Recovery reconciles evidence; continue stages through
the owning Run after inspecting its blockers. Persisted explicit human EPIC-close
confirmation survives recovery; silence remains unconfirmed.

Run on the machine that owns the tmux workspace. Recovery spans all sessions on the **selected tmux server**, without a project or `.epic-config.json`. Each server needs its own configuration and snapshot directory; read [plugin setup](references/tmux.md) when installing or handling multiple servers.

Set `HELPER` to this skill directory plus `/epic-recover`. It runs standalone TypeScript with Node ≥22.18 and tmux; no project build is required.

## 1. Find the saved workspace

Check whether tmux-resurrect and tmux-continuum are configured. If missing, follow [plugin setup](references/tmux.md). Installation protects **future** shutdowns; it cannot reconstruct a layout that was never saved.

On a newly started server, continuum restores automatically. For an existing server, use:

```sh
"$HELPER" restore
```

Manual restore preserves existing panes. A newly started server may replace its initial placeholder pane. A saved pane whose directory is unavailable needs that directory restored first.

Done when every saved session/window/pane is accounted for as restored, already present, or blocked with a concrete reason.

## 2. Check conversations

```sh
"$HELPER" status
```

Check each restored TUI for missing executables, authentication, hook review, or a conversation that cannot be opened. A process starting is insufficient evidence that the original conversation loaded.

Read only the relevant adapter:

- [Codex CLI](references/codex.md): recording hooks, local launcher, exact-session resume.
- [agy CLI](references/agy.md): status line recording and conversation resume.

A pane without a verified conversation ID returns as a shell with a notice. Resolve its identity from the runner's own conversation view and the user's choice. Register it with `bind` while that agent is live; use the adapter's explicit resume command if it has already stopped. A directory or newest transcript is insufficient to identify a conversation.

Done when every agent pane has its original conversation open or is explicitly reported as unresolved. Restored agents wait for user input.

## 3. Verify the next save

```sh
"$HELPER" save
"$HELPER" status
```

Report any unresolved pane and the saved workspace location. The automatic save interval is five minutes while continuum's status-line callback is running; an immediate save before shutdown closes that gap. See [prepare reboot](../pc-orchestrator-prepare-reboot/SKILL.md) for the planned-shutdown workflow.

Done when the snapshot exists and every agent pane's recording status has been checked. Verify changed recovery code using the isolated round trip in [verification](references/verification.md).
