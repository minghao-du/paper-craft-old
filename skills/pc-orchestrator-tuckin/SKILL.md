---
name: pc-orchestrator-tuckin
description: Persist managed Run decisions and execution evidence before context reset.
---

# /pc-orchestrator-tuckin

1. Verify the owning Run and active managed Orchestrator attempt against [the lifecycle contract](../pc-orchestrator/managed-lifecycle.md).
   Inspect durable status before writing; unknown occupancy remains a blocker.
2. Persist pending decisions, accepted results, blockers, retry counts and ownership transfers with their Dispatch/Attempt/Receipt and revision pointers.
   Preserve interrupted local operations and distinguish merge, final records and actual release.
3. Write the continuation artifact under [the continuation contract](../lib/continuation.md), including Run identity, authoritative config, provider and the next reconciliation action.
   Resume through `/pc-orchestrator` and managed recovery before scheduling.

**Done:** A fresh Orchestrator can reconstruct pending work from durable evidence without repeating verified dispatch or merge.
