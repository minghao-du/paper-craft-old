# Managed-only workflow cutover and retirement of legacy drivers

[简体中文](0004-managed-only-workflow-cutover.zh.md)

Decision for [spec #152](https://github.com/minghao-du/paper-craft/issues/152).

## Context

Prior versions had two competing execution architectures: Managed Workflow (centered around `RunRegistry`, `WorkflowRun`, and `StageDispatch`) and standalone unmanaged drivers (`issue-driver`, `epic-driver`, `epic-completion`, and `postmerge`). The legacy drivers used side records (`task.json`, `epic.json`, `completion.json`) and local checkout markers (`.epic-status.json`, `.epic-worklog.md`), duplicating lifecycle logic and causing fragmented execution state.

## Decision

1. **Sole Managed execution path**: Managed Workflow (`pc workflow orchestrator start`, `pc workflow stage`) is the sole supported Issue and EPIC execution architecture.
2. **Retire independent drivers**: Delete `issue-driver`, `epic-driver`, `epic-completion`, `postmerge`, `finalize-epic`, and standalone `drivePullRequest`. Pure subject reading (`readIssue`, `IssueInput`) lives in `run-subject`, and Pull Request provider abstractions remain in `pr-driver`.
3. **No backward-compatibility bridges**: Do not provide legacy driver shims, runtime read-compatibility, or deprecation aliases for deleted execution loops.
4. **Historical data protection**: Existing operator-owned historical data in `.runtime/` or working checkouts is protected; it is neither auto-adopted into Managed state nor deleted.

## Superseding effect

This decision supersedes prior standalone driver workflows and marks independent issue/EPIC driver execution obsolete across all documentation and ADRs.
