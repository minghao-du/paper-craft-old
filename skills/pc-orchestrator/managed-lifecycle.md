# Managed Run lifecycle

This is the shared execution contract for persistent Orchestrator, EPIC, Worker, PR-Land, Pipeline and Research-State roles in standalone Issue and EPIC Runs.
Business sequencing lives in [Shared Issue Delivery](SKILL.md#shared-issue-delivery) and [EPIC coordination](epic-workflow.md).
Read this contract before any managed dispatch, receipt acceptance, recovery or resource release.

Read the [agy interactive procedure](agy-interactive.md) before launch.

Use the core Run-driver operations as transition authority. Only the owning Orchestrator requests top-level stages with `dispatchStage`; the runtime verifies Run authority, fixed provider, immutable input revision and accepted prerequisites before reserving and launching through the managed adapter. Domain acceptance remains the EPIC or specialist's judgment, represented by the workflow's current-fact verifier. A role's recommendation is not a dispatch.

A Dispatch records Run, subject, role, stage, provider, input revision, immutable Brief reference and generation. Repeating identical inputs returns the same Dispatch. Changed inputs create a new generation only after prior occupancy is resolved. Retry with `retryStage` only after independently verified termination; each retry retains prior Attempts and creates a fresh Attempt identity. Unknown occupancy remains reserved.

Publish a result with `publishStageReceipt`: include all correlation fields, outcome and hashed evidence references. Publication writes an immutable Receipt before the durable reported event; a wakeup may follow publication but never substitutes for it. Correct a rejected claim with a new Receipt pointing to `corrects`; never edit prior evidence. Notifications may be lost, so inspect the registry for reported results.

Use `acceptStageReceipt` with current external facts and ownership evidence. Runtime checks identity, latest Attempt, provider, current input revision, evidence hashes and supersession, then records an independent acknowledgement. Reported, rejected and accepted are distinct. A completed claim alone cannot advance dependent work. The next dispatch requires accepted prerequisites; unrelated stages need not wait. Fact verification runs outside the registry lock and revision checking rejects a concurrent update before acceptance.

Inspect `pc workflow orchestrator status --config <authoritative-config>` for every current Run, Dispatch lifecycle, unhandled claims, Blockers, occupancy and Evidence references. The command outcome is separate from Run lifecycle and Attempt status. Status, Start and Recover default to concise JSON; add `--detailed` for the complete current structured result. Neither mode reads logs or transcripts. Follow the returned paths and verify original Evidence and hashes before Acceptance; summaries and diagnostic references do not replace that verification. Refresh status after Dispatch, Recovery or new results before the next scheduling judgment. Unknown occupancy retains ownership. Dashboard projects the same records read-only. A process exit or timeout never proves business acceptance or checkout release. Legacy records without correlation remain unknown.

Use the selected provider procedure to register or launch and activate the initial Orchestrator. Dispatch requires active authority and verified initialization.

Start reports the operation outcome separately from Run lifecycle and Attempt status, with context/Evidence references and current blockers. Start and Recover errors expose a concise cause and readable diagnostic references; follow those references when more detail is needed. A separate `diagnosticSaveError` means diagnostic storage failed: retain the reported business outcome, and do not repeat successful work to repair logging. Start reports `pending` while startup or activation input is unconfirmed; `running` alone does not prove continuation. A per-Run background helper reconciles late native readiness and role initialization for all managed providers and roles, including retries and replacements. It persists activation intent before sending a separate continuation message; uncertain delivery is checked against exact native input without blind replay. Repeated start reconnects the existing Run and repairs a stopped helper without relaunching execution. The helper keeps checking live or unknown executions without a time limit, ends after connection or verified termination, and does not restore sessions after reboot. Status reads business state without activating or sending input. Use `pc workflow orchestrator recover <run> --config <config>` explicitly for broader reconciliation of immutable Receipt files, reported events and accepted acknowledgements. Recovery activates the same Attempt only after native identity, live terminal, assignment-bound initialization and current authority checks all pass; otherwise retained evidence and occupancy remain blocked. An interrupted reservation may continue its first launch only when durable evidence establishes launch never began. Inspect `reconciliation` for blockers and accepted Dispatches awaiting scheduling; request the next stage with its original immutable inputs so replay has one effect. Recover reports its operation outcome separately from Run lifecycle and Attempt status, retaining Reconciliation, pending Dispatches, occupancy and Evidence references. Recovery does not fabricate domain acceptance or infer termination from elapsed time. Missing acknowledgement may be recovered only through the selected provider's evidence channel.

Use `--replace` only when the provider independently verifies the prior Orchestrator stopped. Runtime reserves the replacement and changes mutation authority before launch, retaining the prior identity. For agy, a replacement reuses a correctly marked Run session and creates a new window; a missing session is rebuilt only after verified termination of all historical Run executions. Unmarked or conflicting sessions remain untouched. Startup connection is complete when status reports running with the selected Attempt and delivered activation input; inspect cause, evidence directory and recover guidance otherwise. The Launcher need not remain available. Unknown occupancy stays blocked. Stage retries use the same termination requirement. Set repair limits through `setRemediationLimit`; rejected claims persist consecutive counts and actionable feedback. Exhaustion blocks that Dispatch, not unrelated work. Acceptance clears its consecutive count. Neither replaying rejected claims nor restarting resets the budget.

## Concurrent Run ownership

Use the Run-qualified Orchestrator identity and driver lock, never the legacy Fleet-wide orchestrator for a new Run. `dispatchStage` reserves the repository/Issue owner and physically canonical configured checkout before launch. A conflicting subject must use `referenceRunSubject` to record the consuming Run; that reference does not authorize another Worker. Distinct Fleets use the same atomic `.pc-execution-owner` marker in the physical checkout, so aliases cannot conceal another owner. Unknown or malformed ownership remains occupied.

Inspect `subjects` and `resources` in the authoritative registry/read-only projection. Only `releaseRunCheckout` may release a checkout after independently verified termination of its recorded executions; completed output or an elapsed timeout is not termination. Failed launch reservations stay held for reconciliation. The marker can precede registry publication after an interrupted write; preserve it until ownership is independently reconciled rather than deleting it to retry.

Select `agy` with `pc workflow orchestrator start <issue> --type <issue|epic> --provider agy --config <config>`. Each Run retains that provider. The adapter must explicitly declare a verified persistent interactive lifecycle before any reservation. The legacy print/exec adapters remain disabled for named roles until their complete provider conformance passes; a successful controlled adapter does not enable them. All task dispatch belongs to the owning Orchestrator. Roles are orchestrator, worker, epic, landing, pipeline-audit, pipeline-refactor and research-state; delivery stages enforce their assigned role. Custom roles are rejected when writing or reading records; resolve historical assignments from workflow evidence rather than task names.

The adapter receives the complete immutable brief and dispatch/attempt identity at startup. Startup requires exact conversation and terminal evidence plus shared role initialization verification. The Run supplies assignment-bound instructions once in the complete brief; write `initialization.json` in the existing Attempt directory only after initializing that exact role and immutable context. Runtime verifies its Run, registered authority, subject, Attempt, role and context reference. Worker initialization is verified solely via `initialization.json` in the attempt directory without requiring checkout `.epic-status.json` or `.epic-worklog.md`; Landing requires the actual checkout owner. EPIC scope is checked against Run ownership. Specialist context acknowledgement covers the existing immutable finalization brief, not scientific acceptance. After writing initialization and emitting the exact ready marker, end the initialization turn and await separate activation input; do not poll for activation inside that turn. Business results must correlate to the continuation turn, never the ready-only reply. Missing or stale role evidence retains native identity and startup remains pending; the helper rechecks files without resending initialization input. Use `sendStageMessage` for subsequent complete messages, with stable unique message IDs. Intent is persisted before delivery; uncertain delivery or a lost notification preserves identity and is never blindly replayed. Manual input may coexist with dispatch; neither terminal order nor latest output establishes attribution. Inspect the Dispatch's messages and the Attempt's timestamped observation. Waiting, idle, error, exited and unknown observations never accept a task.

Interactive `collectBusinessTurn` reads the adapter's durable result correlated to the Dispatch, without waiting for process exit. Publish and verify existing Stage Receipts before progression. Acceptance through `acceptStageReceipt`, `acceptValidatedBusinessTurns`, or validated `collectBusinessTurn` automatically invokes `stopAcceptedExecution` for persistent attempts when no assigned message remains outstanding. A delivered message still needs completion: its ID must appear in an accepted Receipt’s `messageIds`, bound to the same Attempt. Without that evidence, keep the execution and checkout occupied. Repeating an accepted receipt retries pending shutdown without accepting work twice. Execution shutdown retains checkout ownership for later PR stages and preservation. `releaseAcceptedExecution` requires an explicit cleanup callback; the post-merge workflow keeps using `releaseRunCheckout` after archive and bundle verification. The release gate verifies every execution before cleanup and releases ownership only after cleanup succeeds. Cancellation must yield verified termination. Unknown termination retains ownership. Recovery preserves the exact conversation on a restarted Orchestrator, creates a linked predecessor Attempt after verified termination, and submits a reconciliation instruction rather than replaying the original task. A surviving reconnect retains its Attempt.

## Child-only intake and overlapping Runs

A child request authorizes only that Issue. Read native open dependencies and retain parent context; unresolved metadata or open blockers stops dispatch, without starting siblings or closing the parent. The internal `driveEpicIssue` uses this scoped delivery path; the CLI `pc workflow orchestrator issue` is deprecated and does not dispatch.

Before allocating each EPIC child, reference its repository/Issue subject in the Fleet registry. Existing ownership wins in either intake order. A child request against EPIC-owned work reconnects to that owner; resume the owning Run rather than dispatching another child driver. Provider conflict blocks reconnect and never switches the active provider. An EPIC consuming standalone delivery must obtain its own explicit professional acceptance against its objective and scoped brief before counting that result. Pending or rejected referenced delivery blocks that dependency, without inheriting parent-finalization authorization.

## Current-head PR merge

Use the existing PR driver for automatic landing. It binds the quality result and EPIC professional confirmation to the live head, checks required GitHub results again, and uses expected-head compare-and-merge. Managed Runs reserve the checkout and record quality Dispatch/Attempt/Receipt acceptance before the driver requests merge. A moved head or failed gate requires current evidence rather than inheriting approval. Repository and closing-Issue attribution must match the delivery.

Inspect `pullRequests` alongside dispatches in the read-only registry projection. A lost merge response is reconciled against GitHub before another request; preserve the actual merge commit and evaluated head. `merged` is pending delivery: Worker final records, preservation and cleanup still follow through the existing completion driver. An unknown merge result or missing version is uncertainty to preserve, never evidence that cleanup is safe.

## Post-merge delivery

Resume through Managed Stage execution or `pc workflow orchestrator land` after verified merge. Worker final records are a distinct `final-records` Dispatch: include assessment, final worklog, follow-up attribution (an explicit empty list when none), and execution-release evidence. Independently verify prior and Worker termination before accepting records and dispatching `preservation-cleanup` to PR-Land. Unknown occupancy retains the checkout and leaves delivery pending.

PR-Land uses the existing verified archive and Git bundle checks before cleanup. The driver verifies all execution termination, retains checkout ownership through verified bundle validation and worktree removal, then releases the reservation and accepts cleanup. Inspect `deliveries` for records, archive, cleanup, and delivered status; the associated immutable stage Receipts retain evidence after removal. Issue closure and Issue-Run completion follow verified cleanup. An EPIC Run remains active for its own acceptance/finalization. Resume retained completion state after failure; never rerun a verified merge or discard accepted records to retry cleanup.

## Business turn validation

Managed business turns publish immutable result receipts before progression. Runtime requires accepted Worker implementation before PR quality, exact-head quality before merge, merge before records, and records before cleanup. Distinct executions sharing a checkout transfer only after verified termination; business acceptance alone leaves occupancy reserved. An interrupted report retains its candidate and writer lock. Use finalization retry only after verifying the specific recorded writer stopped; a lock belonging to another Run remains occupied.

Collection publishes a reported claim; domain acceptance follows caller validation. Managed Workers return scoped JSON with `status: completed`, matching `repository` and `issue`, and nonempty `evidence`; malformed or changes-needed results cannot authorize PR quality. Recovery reconciles a reserved merge Dispatch against the actual merged head and commit before accepting its receipt.

## EPIC closure and completion

For EPIC business sequencing, use [EPIC coordination](epic-workflow.md); specialist procedure lives in [post-closure finalization](finalization.md).

EPIC closure binds professional acceptance and explicit human confirmation to the delivery fingerprint (accepted integrated head, attributed changes, and completed child records). Recheck that fingerprint immediately before closure. Child-only Runs cannot initiate parent closure. Only verified EPIC closure opens `post_closure_finalization`; it does not complete the Run. Pipeline and Research-State operate after closure, retain accepted delivery versions separately from later observations, and preserve specialist occupancy and retry guards.

Managed EPIC completion requires a verified report after accepted Pipeline disposition.
The destination reservation spans Fleets and physical aliases. The report writer receives
only its candidate writing directory; failed validation retains the prior publication.
Registry report identity includes path, hash, revision, accepted and observed versions;
only successful publication completes the Run. Unknown writer ownership blocks reuse.

Run completion ends scheduling authority independently of execution exit. Resource release still requires verified termination of every execution occupying the checkout, including the independent Orchestrator.

**Completion is verified when** existing Issue delivery or EPIC finalization gates record `completed`, supported dispatch and recovery reject its authority, and inspection still exposes retained Attempts and unresolved execution/resource occupancy. For agy, retain the Orchestrator conversation and window for inspection. The Launcher has no cleanup or monitoring duty. Later work uses a new Run and independent Orchestrator; resolve existing resource conflicts through the normal verified release gates.

## CLI stage assignments

The active Orchestrator selects each assignment. Write a JSON file containing `subject`
(`owner/repo#number`), `role`, `stage`, `inputRevision` (current checkout Git HEAD),
`brief`, `prerequisites` (accepted Dispatch IDs), and optional `checkout`.
Run these commands with the authoritative config, Run and Orchestrator Attempt IDs:

```bash
pc workflow stage dispatch --config "$CONFIG" --run "$RUN" --authority "$ATTEMPT" --input assignment.json
pc workflow stage inspect --config "$CONFIG" --run "$RUN" --authority "$ATTEMPT" --dispatch "$DISPATCH"
pc workflow stage collect --config "$CONFIG" --run "$RUN" --authority "$ATTEMPT" --dispatch "$DISPATCH" --timeout-ms 1000
pc workflow stage accept --config "$CONFIG" --run "$RUN" --authority "$ATTEMPT" --receipt "$RECEIPT" --decision decision.md
```

For EPIC planning, use role `epic`, stage `planning`. Review the collected immutable
result against the assigned scope; write your acceptance rationale in `decision.md`.
Acceptance independently verifies current Git HEAD, checkout ownership, evidence
hashes and prerequisites. Delivery additionally verifies current PR facts and retained preservation/release evidence.
**Done:** inspection reports `accepted` and the matching Receipt acknowledgement;
startup or a reported result alone does not meet this criterion.

For scoped correction, write the correction text to a file and use `stage message`
with `--dispatch`, a stable `--message-id`, and `--brief <file>` plus the same common
options. Collect with the same `--message-id` to identify the correction covered by the result, then inspect it before accepting. Use `stage retry`
only after independent prior-execution termination; it retains the existing Dispatch
and prior Attempts. Unknown occupancy blocks replacement.

For an isolated model-free delivery regression, run `pnpm exec tsx scripts/demos/workflow-demo.ts`
after building. Retain the reported temporary evidence directory. This demonstrates
the controlled CLI/lifecycle chain, including duplicate-dispatch and missing-predecessor protection; it does
not establish native model execution or scientific validity.

For delivery, select `implementation` / `worker`, `pr-quality` / `landing`,
`pr-merge` / `landing`, `final-records` / `worker`, then
`preservation-cleanup` / `landing`. Bind quality and merge to the evaluated Git HEAD.
If implementation changes the bound revision, collect its evidence, reject the stale
receipt, stop that execution and issue a current-revision assignment before accepting.
Supply `--pr <number>` on delivery acceptance so current GitHub facts are verified.
After collecting a merge assignment, execute only its compare-and-merge effect:

```bash
pc workflow stage execute --config "$CONFIG" --run "$RUN" --authority "$ATTEMPT" --dispatch "$DISPATCH" --pr "$PR"
```

Use that same operation for the selected cleanup assignment after final records are
accepted and all checkout executions have independently terminated. It verifies the
merged PR, preserves actual records and a Git bundle, and releases the owned worktree.
Accept its receipt with `--pr` after inspecting the retained archive and release evidence.
**Done:** all delivery stages are accepted, the archive verifies, and the checkout is
released; a merge alone leaves final records and cleanup pending.

## Explicit EPIC finalization

After all child deliveries are recorded, preserved and released, dispatch an `epic`
assignment at stage `integrated-acceptance` against the integrated Git HEAD. Collect
and accept its JSON goal judgment (`satisfied`, nonempty `criteria`, `blockers`).

Normal Workflow closes the Parent EPIC via:
```sh
pc workflow orchestrator close-epic <issue> --config .epic-config.json --confirmation-file human-confirmation.json
```
(or `workflow stage close` for stage-level execution). Normal Workflow verifies single Run authority,
current professional acceptance, complete child deliveries, and matching human confirmation evidence before
performing the actual GitHub close. Registration that merely observes an already-closed Parent
is not used as a substitute for actual closure.
Supply the target-specific human confirmation JSON with `source:"human"`, evidence, and `deliveryVersion`:
`closureRequest.deliveryVersion` from `stage inspect --dispatch INTEGRATED`. Obtain fresh confirmation whenever this version changes.
Uncertain close results are reconciled and retained rather than blindly replayed, and verified closure opens
`post_closure_finalization`.

```sh
pc workflow orchestrator close-epic <issue> --config .epic-config.json --confirmation-file human-confirmation.json
pc workflow stage pipeline --config .epic-config.json --run RUN --authority ATTEMPT --dispatch PIPELINE
pc workflow stage publish --config .epic-config.json --run RUN --authority ATTEMPT --dispatch RESEARCH --decision coordinator.json
```

After verified closure, choose bounded `pipeline-audit` or `pipeline-refactor`
assignments using those stage names. Collect and accept the result, then commit
its validated PipelineDisposition with `stage pipeline`. Reporting stays blocked
until that disposition is accepted. These commands execute requested operations;
the Orchestrator chooses each assignment and its prerequisites.

Dispatch `research-state` at stage `research-report` with the accepted Pipeline
prerequisite. Its completed JSON result identifies `artifact` and its SHA-256
`artifactHash`. After collecting and accepting it, `stage publish` consumes
coordinator JSON containing `identity`, absolute `entry` and confirmed `brief`.
Publication verifies the unchanged artifact and uses the normal transactional
writer, required report sections and provenance receipt. Completion requires a
published report; inspect resource occupancy separately.

Run `pnpm exec tsx scripts/demos/workflow-demo.ts` for the isolated seven-role scripted
regression. It retains the temporary evidence directory and makes no model or
GitHub calls. This proves controlled CLI lifecycle behavior, not native execution
for every role or scientific validity.

## Safe Stop and Completed-Run Release

An operator or automated supervisor may halt an active Run or release a completed Run using public workflow services and CLI:

```bash
pc workflow orchestrator stop <run-id> --config <config>
pc workflow orchestrator release <run-id> --config <config>
```

- **Stop (`stopRun` / `pc workflow orchestrator stop <run>`)**:
  Revokes further scheduling authority and pending activation before requesting cancellation of owned executions.
  Accepted deliverables, receipts, acknowledgements and retained business evidence are never rewritten or erased.
  Cancellation acknowledgements alone do not establish release. Termination of every owned current/historical attempt and background startup helper must be independently verified; unknown or failed termination remains visible as a blocker and prevents resource reuse.
- **Completed-Run release (`releaseRun` / `pc workflow orchestrator release <run>`)**:
  A distinct completed-Run operation that terminates remaining executions and helpers without recording user interruption or changing completed business success into failure.
  Releasing checkouts and resources requires satisfying normal Workflow preservation and cleanup prerequisites; neither stop nor completed release may silently bypass them.
- **Idempotence and authority**:
  Repeated stop or release requests reconcile existing owned state without launching replacements, deleting scenes or claiming another Run's resources. The Run retains its single active managed Orchestrator authority, fixed provider and configured physical ownership boundaries; Fleet does not become a scheduling agent.

## Opt-in native scheduler demonstration

Run `pnpm exec tsx scripts/demos/workflow-live-demo.ts agy` explicitly to
replace only the toy scheduler with a real managed Orchestrator. The default
`pnpm exec tsx scripts/demos/workflow-demo.ts` remains model-free. The native demo
creates an isolated checkout and loopback command endpoint; the Orchestrator
reads `DEMO-TASKS.md` there and selects assignments and CLI operations itself.
Subordinates execute the same fixed toy scripts. Helpers prepare artifacts,
apply requested operations and check results; they do not choose stages.

Inspect the printed evidence directory, `native-cli-requests.jsonl`, native
startup receipts and `live-outcome.json`. Completion requires the same seven-role
outcome check as the scripted scenario. A provider prerequisite failure or deadline
is a blocked demonstration, never a substituted scripted success. The default
native observation deadline is ten minutes; `PC_LIVE_DEMO_TIMEOUT_MS` changes it.
Retained resources are reported separately from business completion. This demonstrates
native Orchestrator interface use only when completed; it does not establish native
execution of subordinate roles, scientific validity or a numerical token guarantee.
