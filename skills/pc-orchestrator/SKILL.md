---
name: pc-orchestrator
description: Coordinate Issue delivery or an EPIC's child deliveries through managed agents, verified acceptance, and resource release.
---

# /pc-orchestrator

The Run's active managed Orchestrator attempt schedules persistent work; durable files retain decisions and execution evidence.
Issue delivery is the shared workflow below; EPIC coordination adds planning and integrated acceptance around it.

## Branch selection

For an explicit managed Run/Attempt assignment, read [agy procedure](agy-interactive.md) and the supplied immutable context. Validate every initialization field and context hash. Invalid or incomplete managed context stops with an error; it never enters Launcher intake. Write assignment-bound initialization and native readiness, then wait for status to show this exact Attempt as the active running Orchestrator before using Shared Issue Delivery. **Done:** committed activation is verified.

Without managed context, use Intake as Launcher. For agy, report the startup result and end this invocation; the independent Orchestrator schedules delivery. **Done:** report actual Run/Attempt state and available inspection commands.

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

Supply additional Requirements with `--requirements <text>` or `--requirements-file <file>` (UTF-8), never both. File contents are captured at intake, so later work does not depend on the source file. Requirements become immutable Run context inherited by every role, retry and replacement; child-specific assignments add scope without replacing those constraints. Repeated start may omit Requirements to reuse them or supply identical text; different text rejects. Retain the returned Run identity.
For agy, follow independent startup in [agy procedure](agy-interactive.md). Codex and Claude retain controlled startup.

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

Read the persisted Run and inspect status before scheduling after a reconnect. Follow the [shared output and Evidence rules](managed-lifecycle.md) when querying or expanding status.
Use [managed recovery](managed-lifecycle.md) for receipt reconciliation, bounded rework, termination verification and ownership release.

```bash
pc workflow orchestrator recover <run-id> --config /absolute/path/.epic-config.json
```

**Done:** Every reported result has an acceptance/rework disposition, and unresolved execution or ownership uncertainty remains a recorded blocker to dependent work.

## Task roles

Dispatch tasks through the owning Orchestrator's [managed lifecycle](managed-lifecycle.md).
Assign one of the seven workflow roles according to its responsibility; task specialization belongs in the brief.
