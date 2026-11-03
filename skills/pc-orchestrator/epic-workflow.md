# EPIC coordination

Read for an explicit EPIC intake after the [entry checks](SKILL.md#intake).
EPIC coordination surrounds [Shared Issue Delivery](SKILL.md#shared-issue-delivery); it adds no second Worker or PR workflow.

## Planning

The Orchestrator dispatches the EPIC Agent to establish scope, child objectives, dependencies, priorities and professional acceptance evidence.
The EPIC Agent recommends readiness and domain judgments; the owning Orchestrator schedules persistent work through [the execution contract](managed-lifecycle.md).

**Done:** The durable plan accounts for every child, its prerequisites and its contribution to the original EPIC objective.

## Child scheduling

Before each allocation, resolve dependencies, file collisions, checkout/resource ownership and authorization.
Dispatch independent ready children concurrently; retain blockers for dependent or colliding work.
Follow [overlapping Run ownership](managed-lifecycle.md#child-only-intake-and-overlapping-runs) when standalone delivery already owns a child.
An existing result still needs explicit professional acceptance against this EPIC's objective.

For a Demo-constrained EPIC Run (`--demo-round <id>` or configured demo round), follow [pc-demo](../pc-demo/SKILL.md): planning creates exactly two native children with task 2 natively blocked by task 1. The Orchestrator automatically checks Gate 1 (`pc demo --config <file> gate <round> worker1`) before dispatching Worker 1. Worker dispatch without claimed Gate authorization is denied. Task 2 remains blocked until task 1 handover is fully released and verified by automatic Gate 2 (`pc demo --config <file> gate <round> worker2`), proving task 1 merge ancestry at dispatch. Corrective rework, stage retries, replacement attempts, and extra task PRs are prohibited.

Execute each ready child's [Shared Issue Delivery](SKILL.md#shared-issue-delivery) under the owning Run, retaining its parent constraints.
Collect accepted child outcomes before unblocking their dependents.

**Done:** Every child is delivered with evidence, in flight under an identified owner, or blocked with an actionable reason; dependent work consumes only accepted prerequisites.

## Integrated acceptance and closure

Have the EPIC Agent assess the integrated delivery against the original objective and child evidence.
Child delivery does not itself establish integrated acceptance.
Route required repairs through the shared delivery steps and reassess the resulting delivery version.

Use the [EPIC closure evidence gate](managed-lifecycle.md#epic-closure-and-completion) to obtain explicit human closure confirmation and verify actual closure against the accepted delivery fingerprint.
This confirmation concerns parent closure; it adds no per-child human PR approval gate.

**Done:** The integrated objective has professional acceptance, human confirmation matches the current delivery version, and EPIC closure is verified.

## Post-closure finalization

Only after verified closure, follow [finalization](finalization.md) for Pipeline applicability/audit, any maintenance deliveries, Research-State prerequisites and final reporting.
Finalization owns these specialist rules, including the required Pipeline applicability check even when planning predicts no Pipeline changes.
Maintenance implementations reuse [Shared Issue Delivery](SKILL.md#shared-issue-delivery) with the finalization-specific approval prerequisites.

**Done:** The finalization contract's Pipeline disposition and reporting gates are satisfied and Run completion is verified.

## Partial progress and resume

Resume the owning Run through [managed recovery](managed-lifecycle.md), retaining the plan, accepted child versions and remaining blockers.
Use [finalization recovery](finalization.md#3-verify-and-recover) once closure has opened that phase.

**Done:** Accepted delivery is reused without repeating verified merges, and outstanding work resumes only from its recorded prerequisites and ownership.
