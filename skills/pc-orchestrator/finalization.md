# EPIC post-closure finalization

Reached from [EPIC acceptance and closure](epic-workflow.md#integrated-acceptance-and-closure).
Use [the managed execution contract](managed-lifecycle.md) for specialist dispatch, receipt acceptance and resource ownership.

Use after required children are delivered, PR merges and landing records are verified,
the EPIC Agent has accepted the original goal, and the human has explicitly confirmed
closure for that delivery version. Verify actual closure before specialist dispatch. This is part of EPIC completion;
standalone Issues do not acquire these steps.

## 1. Establish scope and ownership

Orchestrator supplies actual merged PRs, per-PR base/head and merge SHAs, changed paths,
Worker results and evidence. Bind each round to an integrated SHA and a safe detached
checkout. The EPIC Agent confirms the evidence-based applicability of each specialist;
uncertainty remains blocked. Infrastructure delivery alone is not research progress.
The designated Project coordinator supplies scientific judgments and the writing brief;
invoking a writer transfers neither scientific authority nor coordination.

**Done:** The planning opinions have reasons; research work has the unique
absolute research entry, named coordinator, confirmed judgments and evidence pointers.

## 2. Dispatch specialists sequentially

Include the reminder and resolved instruction paths required by [Project instructions in every dispatch](../lib/workflow.md#project-instructions-in-every-dispatch) in each specialist brief.

Use existing managed turns and attempts, attributed to the original EPIC, rather than
Worker intake (`pc-issue-work`). Each applicable specialist gets a fresh window in the
verified existing fleet tmux session and its own file brief. Research-only confirmed skips need no window; Pipeline applicability always gets a specialist window. The configured Runner owns input delivery and acknowledgement.

Every closed EPIC invokes `/pc-pipeline-refactor` for applicability and bounded structural
audit, even when the EPIC planning opinion says no Pipeline is affected. It audits only;
it does not implement through specialist subagents. Required changes become bounded
maintenance Issues delivered by Worker and PR-Land, with Migration Ledger approval
before covered mutation. Pass only an accepted Pipeline disposition to `/pc-research-state`. The Project coordinator serializes
writers across repositories and Fleets: wait for the previous writer's return before
starting another. Ambiguous coordination or handover blocks writing.

**Done:** Every applicable task has a distinct window, startup receipt and collected
result bound to the evaluated SHA. A window, process exit or missing error is insufficient.

## 3. Verify and recover

Managed completion retains context, applicability, results and turns in the Run registry;
Runner directories retain briefs, logs and result files. Structured
specialist receipts contain `head`, `status` (`completed` or `blocked`), `evidence`,
`blockers`, `scope`, `checks`, `artifacts`, and `limitations`. Explain checks not run.
Orchestrator records research-only confirmed skips with their reasons. Preserve old rounds and attempts.
Use `pc workflow orchestrator recover <run>` with the authoritative config to reconcile original receipts,
verify external outcomes, and resume unfinished post-closure stages without repeating closure, publication, or merge actions.

Post-closure stages run as Managed Dispatches:
- Dispatch `pipeline-audit` or `pipeline-refactor`, collect and accept the receipt, and commit with `pc workflow stage pipeline`.
- Dispatch `research-report` (`research-state`), collect and accept the receipt, and publish with `pc workflow stage publish`.
Failure in any post-closure stage leaves the Run incomplete in `phase: 'post_closure_finalization'`.
Recovery identifies unfinished post-closure dispatches and resumes them without re-calling GitHub close.

Timeout ends waiting, not execution. Unknown occupancy blocks replacement and closure.
Confirm termination and release of writing/checkout ownership before a new attempt;
otherwise retain the blocker and escalate. Never delete failed evidence to retry.
Artifacts belong outside the immutable source checkout, in the attempt directory or
an isolated validation root. Preserve snapshots until their evidence is no longer needed.

If integration advances, compare added changes against prior scope and evidence. The
EPIC Agent may confirm reuse with concrete unaffected-scope evidence; relevant repairs
require updated scope and checks. A new round retains the old results. Never apply a
human closure decision from a superseded baseline.

**Done:** Pipeline records `not_applicable` with inspection evidence,
`completed_no_changes` with actual audit checks, or `completed` with every required
finding linked to delivered maintenance and specialist-verified versions. `changes_needed`
stays pending; `acceptance_invalidated` requires human disposition. Unrelated defects
become linked follow-up Issues and report limitations. Generic skipped is never an
accepted Pipeline result. The canonical typed contract is `PipelineDisposition` and
`pipelineAccepted` in the public finalization module; retain inspected versions, finding
evidence and maintenance attribution in the Run registry. No unsupported scientific claims.

## 4. Retain finalization status

Verified closure opens `post_closure_finalization`; it does not complete the Run.
Retain acceptance, explicit human evidence, accepted versions and closure archive while
specialists run. Failures preserve the closed EPIC and keep finalization pending.
Do not reuse closure confirmation to accept a changed pre-closure delivery set.

**Done:** Pipeline disposition and final reporting have observable evidence; their
required completion gates determine Run completion without another EPIC close operation.


## Maintenance delivery

For `changes_needed`, identify a bounded Issue with marker `Pipeline maintenance EPIC #<epic> finding <id>` and originating Run attribution. Persist the finding-to-Issue link before dispatch. Worker implements through [Shared Issue Delivery](SKILL.md#shared-issue-delivery); Pipeline-Refactor only audits and verifies.

Covered moves/deletions require a finding `migrationLedger` identifying the exact approved ledger version. Obtain explicit human approval first. The host reads `<configured root>/.runtime/migration-approvals/<issue>.json` via the configured workflow state directory, with `source: "human"`, matching `ledger`, and nonempty approval `evidence`; never fabricate this file from model judgment. Missing or changed approval blocks Worker dispatch. Inspect `stateDirectory(config, '.runtime', 'migration-approvals')` for the actual configured state path.

After delivery, dispatch Pipeline-Refactor verification with merge versions, archive evidence and applicable local/remote checks. Every original required finding must remain attributed and verify its delivered version before `completed` unlocks reporting. Failed delivery/verification remains pending on the closed EPIC. Retry reuses recorded complete deliveries.
