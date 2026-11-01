---
name: pc-pr-land
description: Execute a orchestrator-dispatched PR merge or post-records preservation and cleanup.
---

# /pc-pr-land

Read [the shared workflow contract](../lib/workflow.md), including **Checkout ownership and landing phases**, before mutation.
The orchestrator dispatch names one phase: `merge` or `cleanup`, the repository/PR,
full evaluated head, checkout, authoritative config and durable evidence paths.
Workers remain available for remediation and final records while releasing checkout ownership.

Managed delivery enters through [Orchestrator intake](../pc-orchestrator/SKILL.md#intake) with explicit type `Issue` or `EPIC`, its number, provider and authoritative config.
After the intake checks, the owning Orchestrator creates or reconnects the Run:

```sh
pc workflow orchestrator start <number> --provider <provider> --config <file>
```

The Orchestrator schedules the shared delivery workflow's PR check/repair/merge stages; this Landing role executes only its assigned phase.
To resume Landing directly, use `pc workflow orchestrator land <issue> --config <file>`.
For EPIC tasks, supply `--confirmation-file <file>` with professional `{epic, head, evidence}` JSON.
This confirms scope at the live head; user confirmation is reserved for closing the EPIC.
The driver retains PR results and original execution receipts under configured runtime state.

## Merge phase

1. **Accept ownership.** Read the orchestrator's transfer record and worker release.
   Reconcile recorded ownership with supported runtime/process evidence, tmux pane paths
   and jobs using the directory. Unknown or overlapping ownership blocks mutation.
   Record acceptance in the coordination ledger and worker worklog.
   This step ends with one verified owner of the checkout.

2. **Verify the evaluated PR.** Read live GitHub state,
   evaluated SHA, applicable completion/review outcomes and every required EPIC confirmation.
   Use `gh pr view <N> --json url,state,headRefOid,baseRefName,closingIssuesReferences`.
   Match repository, PR, local HEAD and live head to that SHA. Inspect `git status --porcelain`.
   Dirty or untracked work requires worker accounting through the orchestrator; preserve it
   in place rather than committing, moving or stashing it during landing.
   Missing/stale evidence or a closed PR blocks merge; an already merged PR moves to
   outcome reconciliation, never another merge attempt.

3. **Update and check.** Fetch origin, then rebase onto `origin/<base>` if needed.
   A conflict stops the operation: report the precise blocker, preserve the worktree
   (including any rebase state), and release ownership before worker remediation.
   If a successful rebase changes HEAD, push with `--force-with-lease`, report the new
   SHA and release. The orchestrator repeats applicable checks, EPIC confirmations and
   professional confirmation before another merge dispatch.
   With unchanged HEAD, verify current-base ancestry and required checks using
   `gh pr checks <N> --required`; inspect installed `gh pr checks --help` for supported
   output fields. Pending checks remain pending; failures return to the orchestrator.
   No configured required checks is acceptable only with the applicable local findings.

4. **Merge the evaluated head.** Check GitHub's `closingIssuesReferences` against the
   intended issue set; correct a defective PR body through the worker. Re-read live
   head and fetch base immediately before merging. For the recorded evaluated SHA:

   ```sh
   test "$(git rev-parse HEAD)" = "<evaluated-sha>" &&
   test "$(gh pr view <N> --json headRefOid -q .headRefOid)" = "<evaluated-sha>" &&
   git fetch -q origin <base> &&
   git merge-base --is-ancestor origin/<base> <evaluated-sha> &&
   gh pr merge <N> --squash --match-head-commit <evaluated-sha> --body "closes #<issue>"
   ```

   Use an explicit squash body containing only intended closing references (or `--body ""`).
   The match-head guard rejects a moved head; it does not make the separate base check
   atomic. A moved head returns to checks and applicable EPIC confirmation. A moved base
   requires current-base revalidation and, if rebase changes head, fresh quality and professional confirmation.
   Never replace a failed guard with an unguarded merge.

5. **Report merge separately.** Verify `gh pr view <N> --json state,mergedAt,mergeCommit`.
   Record the actual merge outcome and commit, including an uncertain command result
   reconciled against GitHub. A queued or auto-merge request is still pending; retain
   the checkout and revalidate evidence before reporting success. Report `merged; final records pending; cleanup pending`
   on success. Keep status, worklog, branch and directory intact, record release, and
   return to the orchestrator. The worker next owns final evaluation and records.

## Cleanup phase

Read this phase only after the orchestrator verifies merge success, final worker records
and a new worker release. A merge result alone does not dispatch cleanup.

1. **Verify prerequisites.** Accept exclusive checkout ownership using the shared transfer
   contract. Verify merged PR, all linked issues closed, terminal issue-lead comment and
   final worklog/status evidence. Account for follow-ups, local changes, unmerged commits,
   pending input, background jobs, external readers and holds. Missing records return to
   the worker through the orchestrator; unknown occupancy leaves cleanup pending.
   Run `pc fleet reclaim-check --dir <slot> --config <authoritative-config>` for fleet slots.
   It currently returns `eligible: false`, exit 2; retain the slot while that check cannot
   establish eligibility. Do not treat portable read-only checks as deletion authority.

2. **Preserve before removal.** Run:

   ```sh
   pc workflow preserve --dir <checkout> --reason "after final records for PR <N>" --config <authoritative-config>
   ```

   Require successful exit, `status: preserved`, manifest/hashes and unchanged sources.
   Record the verified archive path in the ledger and on the PR before removal.
   Missing status or failed preservation leaves originals and cleanup pending.

3. **Clean only eligible resources.** Use actual `git worktree list --porcelain` and
   config to resolve the primary checkout. Verify its owners released it before updating
   it; otherwise report primary synchronization pending. For a clone, switch to base and
   pull with `--ff-only` only after the preceding gates. For a linked worktree, operate
   outside it and use ordinary `git worktree remove <path>` before local branch deletion.
   Use ordinary `git branch -d <branch>`; squash-merge ancestry may refuse deletion,
   which leaves branch cleanup pending for explicit accounting rather than forcing it.
   Delete a remaining remote branch only after the same work-accounting gates.
   GitHub branch deletion settings are not evidence that deletion occurred.

4. **Record actual results.** Verify retained/deleted paths, local/remote branch state,
   primary synchronization and final checkout status. Report preservation and cleanup
   independently from merge success. Release ownership and notify the orchestrator; only
   verified cleanup releases a fleet resource for another task.

Managed delivery and the `pc workflow orchestrator land` continuation follow [Shared Issue Delivery](../pc-orchestrator/SKILL.md#shared-issue-delivery) through final records, preservation and verified cleanup after merge.
Unknown execution occupancy or unaccounted checkout files retain the checkout.
A blocked completion resumes its persisted stages; inspect the original execution before retrying a missing receipt.
EPIC closure remains a separate user decision.

## Managed completion

For Run-owned work, use [the shared managed lifecycle](../pc-orchestrator/managed-lifecycle.md) for correlated results and acceptance. Receipt publication is not delivery acceptance and does not authorize another top-level dispatch or checkout reuse.

Post-merge completion follows the [shared lifecycle](../pc-orchestrator/managed-lifecycle.md#post-merge-delivery): accept Worker final records and independently verified termination before preservation/cleanup. A merged PR remains pending delivery until the archive and actual resource release are verified.
