# Managed workflow operator cutover guide

[简体中文](managed-workflow-cutover.zh.md)

This guide provides concrete operational steps for transitioning to the unified Managed Workflow architecture. Managed Workflow is the sole supported Issue and EPIC execution path across `paper-craft`. Standalone drivers, unmanaged turn loops, and local checkout status files are retired.

## Background and architectural rationale

Prior versions maintained two competing execution architectures: Managed Workflow (centered on `RunRegistry`, `WorkflowRun`, and `StageDispatch`) and independent unmanaged drivers (`issue-driver`, `epic-driver`, `epic-completion`, and `postmerge`). Legacy drivers maintained side records in `.runtime/tasks/`, `.runtime/epics/`, and `.runtime/completion/`, while relying on mutable checkout markers (`.epic-status.json` and `.epic-worklog.md`). This duplication created fragmented lifecycle authority, competing recovery paths, and conflicting status observations.

Under the unified architecture, `RunRegistry` is the single source of truth for scheduling, progress tracking, acceptance, delivery, and recovery. The operational model adheres to four core principles:

- Single state authority: `RunRegistry` is authoritative for scheduling, progress, acceptance, delivery, and recovery.
- Run-scoped Orchestrators: each Run owns its Orchestrator attempt; no fleet-wide scheduling agent or unmanaged turn loops.
- Cross-run delivery references: EPICs reference child deliveries by verified evidence and canonical fingerprints without duplicating workers or transferring ownership.
- Gated closure and recoverable finalization: closure requires integrated acceptance and explicit human confirmation; post-closure failures leave Runs recoverable.

## Pre-cutover preparation

Before switching to the unified workflow, operators must ensure that all execution environments reach quiescence. Do not attempt to migrate active executions in flight.

1. Stop all running legacy driver processes and background workers cleanly.
2. Stop active recovery watchers and fleet pollers so no new tasks are spawned during the transition.
3. Inspect working checkouts to verify no uncommitted edits or lingering process locks exist.
4. Retain all evidence and verification records before proceeding with the switch.

## Historical data protection

Historical operator-owned data is strictly protected throughout the cutover. The system does not alter or destroy legacy execution records.

- No auto-adoption: legacy records in `.runtime/` (`tasks/`, `epics/`, `completion/`) and checkouts (`.epic-status.json`, `.epic-worklog.md`) are never imported into `RunRegistry`.
- No automatic deletion: historical operator data is neither modified nor deleted during or after cutover.
- Explicit re-verification: any continuing work must start as a new Managed Run, verifying existing code and test results independently rather than resuming stale state.

## Cutover execution

The cutover is executed as a single, coordinated step. Verify that software builds cleanly and the expected command surface is active before launching new work.

1. Update repository sources and rebuild workspace packages.
2. Verify the public CLI help output and confirm that retired commands (`finalize-epic`, standalone `run`/`pr`/`worker`) are absent.
3. Confirm that the `agy` CLI is accessible and provider dependencies are satisfied.
4. Relink current agent skills (`pc-orchestrator`, `pc-issue-work`, `pc-pr-land`, `pc-dashboard`) and remove stale skill links.

```sh
pnpm install
pnpm run build
./pc workflow orchestrator --help
```

## Starting Managed work cleanly

All new work starts through the `pc workflow orchestrator` command suite. Each Run is created with an explicit subject and provider, creating an accountable owner and tracked dispatches.

1. Ordinary Issue intake: start an issue with `--type issue --provider agy` to assign a dedicated Managed Run and Orchestrator.
2. EPIC intake: start an EPIC with `--type epic --provider agy` to decompose planning, child delivery dispatches, and integrated acceptance.
3. Observability and inspection: check active runs and resource allocations using `pc workflow orchestrator status`, or monitor through the fleet dashboard.
4. Resuming and recovery: reconcile interrupted attempts with `pc workflow orchestrator recover <run>` without repeating successful external merges, closures, or publications.
5. Delivery landing and closure: execute landing stages and close accepted EPICs with explicit human confirmation bound to canonical delivery fingerprints.

```sh
pc workflow orchestrator start 152 --type epic --provider agy
pc workflow orchestrator status --detailed
pc workflow orchestrator recover 152
pc workflow stage execute --dispatch d-delivery-001 --pr 153
pc workflow orchestrator close-epic 152 --fingerprint fp-abc1234
```
