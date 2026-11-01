---
name: pc-orchestrator
description: Coordinate Issue delivery or an EPIC's child deliveries through managed agents, verified acceptance, and resource release.
---

# /pc-orchestrator

The Run's active managed Orchestrator attempt schedules persistent work; durable files retain decisions and execution evidence.
Issue delivery is the shared workflow below; EPIC coordination adds planning and integrated acceptance around it.

## Intake

Require an explicit type (`Issue` or `EPIC`) and issue number.
Resolve the repository from the authoritative Fleet config and collect or reuse `provider` (`codex`, `agy`, or `claude`), config path and additional scope requirements.

```text
Type: Issue
Issue: #79
Provider: claude
Config: /absolute/path/.epic-config.json
Requirements: Keep changes within the requested scope
```

Read the GitHub issue, native parent/dependency metadata and native sub-Issues before starting.
Classify by a standalone `EPIC` marker anywhere in the title, case-insensitively (for example `[EPIC]` or `EPIC:`; `epicenter` does not match). Otherwise classify as Issue. Native sub-Issue count never determines type; an EPIC with no children can start planning.
Pass the explicit input as required CLI `--type issue|epic`. It must agree with the title classification; on mismatch stop before Run creation or dispatch and explain that the title or input must be corrected. Never override either automatically.
Issue mode authorizes only the specified Issue, retaining parent constraints without starting siblings or closing the parent.

Before any managed launch, read [the shared execution contract](managed-lifecycle.md), including its selected provider procedure.
For EPIC mode, also read [EPIC coordination](epic-workflow.md) before planning or child dispatch.

```bash
pc workflow orchestrator start 79 --type issue --provider claude --config /absolute/path/.epic-config.json
pc workflow orchestrator status --config /absolute/path/.epic-config.json
```

Retain the Run identity and assignment-bound requirements in its durable context; reconnect to existing ownership rather than allocating a second driver.
The startup, provider and ownership gates in the execution contract determine whether dispatch is available.

**Done:** Type, repository/number, authorized scope, provider, config and owning Run are resolved, and persisted assignment context includes every additional requirement.

## Shared Issue Delivery

Apply these steps to standalone Issues, EPIC children and finalization maintenance Issues.
For EPIC children, retain the parent's scope, dependency and professional acceptance context; the parent Run remains the scheduler and these steps do not create a new Run per child.

### 1. Establish readiness

Read the Issue's acceptance criteria and current implementation state, open dependencies and checkout ownership.
Use [child-only intake and overlapping Runs](managed-lifecycle.md#child-only-intake-and-overlapping-runs) to reconnect or reference existing delivery.
For EPIC children, the [EPIC scheduling rules](epic-workflow.md#child-scheduling) additionally determine readiness.

**Done:** Every prerequisite is resolved, the delivery has one owner, and the immutable assignment identifies its scope and acceptance evidence.

### 2. Implement and assess

Dispatch the Worker through the managed execution contract when implementation is required.
Collect the correlated result, independently assess its evidence against every acceptance criterion, and request scoped rework when it falls short.
Use `/pc-issue-lead` for an independent stopping-point assessment and `/pc-pr-check` plus `/pc-pr-review` for PR readiness and quality.
Record a reason and evidence for any stage that does not apply; missing implementation or review evidence is not completion.

**Done:** The scoped implementation is accepted with validation tied to its revision, or the evidence establishes that no implementation is required.

### 3. Review and land

For a PR, dispatch managed quality and PR-Land work through [current-head PR merge](managed-lifecycle.md#current-head-pr-merge).
Resolve defects and obtain current quality evidence plus any required EPIC professional confirmation before requesting merge.
When the head changes, reassess the changed revision through that protocol.

**Done:** GitHub merge and its evaluated revision are verified, or an evidence-backed no-PR disposition is retained.

### 4. Record, preserve and release

For merged work, follow [post-merge delivery](managed-lifecycle.md#post-merge-delivery) for Worker final records, preservation and PR-Land cleanup.
For work without a PR, retain the accepted outcome and follow the managed release contract for every reserved execution and checkout.

**Done:** Accepted scope, validation, final records and follow-up attribution are retained; required archive/bundle evidence and actual resource release are verified.
A merged PR alone does not complete delivery.
Standalone delivery ends here; an EPIC child returns its evidence to [integrated acceptance](epic-workflow.md#integrated-acceptance-and-closure).

## Failure and resume

Read the persisted Run and inspect status before scheduling after a reconnect.
Use [managed recovery](managed-lifecycle.md) for receipt reconciliation, bounded rework, termination verification and ownership release.

```bash
pc workflow orchestrator recover <run-id> --config /absolute/path/.epic-config.json
```

**Done:** Every reported result has an acceptance/rework disposition, and unresolved execution or ownership uncertainty remains a recorded blocker to dependent work.

## Task roles

Dispatch tasks through the owning Orchestrator's [managed lifecycle](managed-lifecycle.md).
Assign one of the seven workflow roles according to its responsibility; task specialization belongs in the brief.
