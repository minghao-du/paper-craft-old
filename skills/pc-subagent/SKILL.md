---
name: pc-subagent
description: Delegate temporary read-only or writable tasks from Orchestrator, EPIC, Worker or Landing, collect results, and request Worker ownership for persistent work.
---

# Temporary delegation

Apply [Project instructions in every dispatch](../lib/workflow.md#project-instructions-in-every-dispatch) to every request's `brief`, including read-only tasks.

Use `pc workflow subagent --help` for the shared queue interface. Every core role uses the same contract. The parent retains checkout ownership and coordinates file allocation, conflicts and integration. Read-only tasks use a read-only sandbox; writable tasks use workspace-write and an explicit file allocation in their brief.

1. Write a JSON request with `parent: {id, role, task}`, `checkout`, `mode` (`read` or `write`), `brief`, and `files` (relative allocated paths; required for writes). Use the managed parent's execution ID and logical task identity. Read applicable project and directory guidance before deciding the allocation.
2. Queue with `pc workflow subagent create --config <authoritative-config> --input <request.json>`. Retain the returned task and attempt IDs. Fleet and per-parent limits are fixed by the first queue invocation; pass the same `--fleet-limit` and `--parent-limit` subsequently.
3. Run `pc workflow subagent dispatch --config <authoritative-config>`. This executes queued short tasks directly without tmux. Dispatch conservatively serializes work; limits are upper bounds. The parent drives dispatch and polls `get --id <uuid>` or waits with `wait --id <uuid> --timeout-ms <milliseconds>`; `list` shows the Fleet queue.
4. Collect with `collect --id <uuid>` and integrate the attributed result. Failure is a terminal result only with termination evidence; unknown execution retains capacity and modification responsibility. Preserve its evidence for reconciliation.
5. After collection, `cleanup --id <uuid>` removes scratch while retaining the durable result. For independent ownership, cross-session progression or handoff, use `handoff --id <uuid> --issue <number>` and have Orchestrator read this request and dispatch the Issue through the Worker workflow. A request is not a Worker launch receipt.

The parent may use writable delegation for code changes. File allocations guide coordination; the Runner sandbox grants checkout access, not per-file enforcement. Keep tasks requiring separate ownership in the Worker lifecycle.

A wait timeout is an observation, not an execution outcome: inspect `wait.timedOut` separately from `status` and collect a later result. `cancel --id <uuid>` records the request and adapter outcome; unsupported adapters report unsupported. A failed or unsupported cancellation retains running/unknown occupancy. Use `reconcile --id <uuid>` for adapter evidence after loss; absence of evidence stays unknown. Only verified terminal evidence releases execution capacity, while checkout preservation and ownership still follow the parent workflow.
