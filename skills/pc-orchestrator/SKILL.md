---
name: pc-orchestrator
description: Coordinate an Issue or EPIC using a transparent CLI runner, isolated workers, durable receipts, and verified PR landing.
---

# /pc-orchestrator

The current conversational agent is the Run's scheduler. Make scope, dependency,
acceptance and rework decisions here; Bash commands execute them and files retain
state across sessions.

## Intake

Accept an issue number, runner command and optional conversational requirements:

```markdown
/pc-orchestrator
- **Issue**: #79
- **Runner**: claude -p
- **Requirements**:
  - Keep changes within the requested scope
```

Record all additional requirements with repeated `--instructions`:

```bash
pc run create --issue 79 --runner 'claude -p' --instructions 'Keep changes within the requested scope'
pc run inspect <run-id>
```

Reuse the Run ID when reconnecting. `--root <directory>` and `--fleet <id>` select
its runtime location (defaults: current directory and `default`). Read `run.json`
and the GitHub issue before dispatch. For an EPIC, dispatch an EPIC role to clarify
the task graph first. Start independent, unblocked work concurrently.

## Dispatch and reconcile

```bash
pc worker spawn <issue-id> <role> --run <run-id>
pc worker wait <dispatch-id>
pc worker status <run-id>
pc worker status <run-id> --ack <dispatch-id>
```

Named persistent roles require the [verified managed lifecycle](managed-lifecycle.md) and cannot use this transparent command path.
Temporary roles outside Orchestrator, EPIC, Worker, PR landing, pipeline-refactor, pipeline-audit and research-state may use it.

Spawn inherits `runner_cmd`; `--runner <command>` overrides it for that dispatch.
The runner receives the immutable brief path as its final argument. Use a wrapper
when the CLI expects prompt contents rather than a path. No platform adapter is
required. The brief carries the issue, requirements, checkout and receipt contract.

Dispatch state lives under `.runtime/<fleet>/runs/<run-id>/dispatches/<dispatch-id>/`.
Workers publish `RECEIPT.md` atomically with outcome, summary, tested revision and
validation evidence. Wait returns the receipt, synthesizing `outcome: crashed` on
verified premature termination. Unavailable liveness evidence stays unknown.

On reconnect, `pc status <run-id>` (alias of worker status) lists in-flight attempts
and complete unhandled receipts. Inspection does not consume results. Read each
receipt, independently assess its evidence, then accept or schedule rework before
acknowledging it. Use wait to establish liveness for attempts without receipts.
Launch failures retain records and locks; inspect them before another dispatch.

## Land accepted work

```bash
pc pr ready-and-merge <pr-id> --dispatch <dispatch-id> --tested-head <full-sha>
```

Independently validate that revision before landing; the succeeded receipt must
identify it. Landing verifies PR HEAD, passing required checks, clean worktree,
worker termination and lock ownership. It verifies a Git bundle, archives the
dispatch/receipt/worklog, squash merges with GitHub's HEAD gate, then releases the
worktree and owned lock. Failure retains resources and evidence for investigation.

Use the intake root/fleet options consistently; landing takes `--root` and locates
the dispatch across fleets. Consult each command's `--help` for available flags.
A failed receipt or merge is a scheduling decision here, not authorization to
remove locks or force cleanup. Completion means accepted issue scope, recorded
outcomes and verified resource release.

`pc workflow orchestrator issue` is deprecated and exits without dispatching.

For a failed or crashed attempt, run `pc worker release <dispatch-id>` after reviewing its receipt. This verifies termination and lock ownership, preserves its evidence and worktree, and permits a new spawn for the same issue and role. Use the same `--root` and `--fleet` selectors as wait. A queued PR preserves worker resources until GitHub reports it merged.
