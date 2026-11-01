---
name: pc-helper
description: Route work requiring a durable helper to the owning managed Orchestrator; use temporary subagents for bounded task-local delegation.
---

# /pc-helper

## 1. Classify the assignment

For bounded work whose parent retains checkout ownership and integration responsibility, follow [temporary delegation](../pc-subagent/SKILL.md).
Temporary subagents return their result to that parent and do not acquire independent workflow ownership.

For work requiring independent ownership, cross-session progression or persistent role execution, prepare a request for the owning Run's Orchestrator.
Include the Issue, task scope, required role, project instruction paths, resource needs, evidence pointers and observable completion criteria.
If no Run owns the work, enter through [Orchestrator intake](../pc-orchestrator/SKILL.md#intake).
An EPIC specialist returns this request as an attributed recommendation; it does not allocate a helper.

**Done:** The work is either bounded temporary delegation or a concrete persistent-task request with an identified owning Run.

## 2. Follow managed execution

The Run's active managed Orchestrator attempt verifies readiness and ownership, assigns an existing workflow role and dispatches through [the managed lifecycle](../pc-orchestrator/managed-lifecycle.md).
Retain the actual Dispatch/Attempt/Receipt identities and immutable brief rather than a separate helper registry.
Use the existing provider adapters for startup, messaging, recovery and termination evidence.
A prepared request is pending until managed startup is verified.

**Done:** The assignment has correlated startup evidence or a recorded blocker; checkout reservation remains under the owning Run.

## 3. Collect and release

Return durable results through the assigned task contract for independent acceptance.
Route corrections, resume and termination requests to the owning Orchestrator.
The managed lifecycle owns verified termination, preservation and actual resource release; unknown occupancy retains reservations.

**Done:** The result has an acceptance or rework disposition, and resources are released only after the lifecycle's evidence gates pass.
