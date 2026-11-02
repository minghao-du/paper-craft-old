# Concise workflow output: frozen delivery and baseline

Scope frozen before behavior changes at `3092149de3563df5f4821b3989a557403b05fa0a` for #106 / #107.

## Audit and delivery list

| Boundary | Observed redundancy / necessary information | Authoritative evidence | Delivery |
| --- | --- | --- | --- |
| Orchestrator Status (`commands/workflow.ts`) | Spreads full Registry: subject bodies, Requirements, Attempt Briefs, prior Attempts, handled Receipts. Keep every Run, actionable Dispatch, unhandled claim, Blocker, unknown observation and owned resource. | Runtime registry, immutable Brief and Receipt path/hash, Attempt directories | #107: concise projection, detailed current result |
| Orchestrator Start (`commands/workflow.ts`) | Spreads full Run and inspection. Errors embed Attempt startup error. | Run brief path/hash, Attempt directory, native terminal identity | #108: concise operation/state and hidden diagnostic capture |
| Orchestrator Recover (`commands/workflow.ts`) | Current result is already narrower; inspection cause can embed startup terminal detail. | Attempt and reconciliation, immutable Receipts, persisted startup errors | #109: shared diagnostic behavior, operation/state contract |
| Agy launch (`runtime/agy-interactive.ts`) | Startup failure embeds last 2000 terminal characters; capability probe embeds stderr. Normal subprocess outputs are captured for parsing, not forwarded wholesale. | Attempt terminal.json, native transcript, startup error in registry where available | #108/#109 audit-backed error boundary; retain parser inputs |
| EPIC / Worker / PR Landing | Registered CLI finish/land invokes existing business drivers; immutable Receipt/acceptance evidence is required. No established full-transcript handoff leak. | Run stage receipts, result files, PR and delivery evidence | Audit only; no new changes required |
| Pipeline / Research-State | Managed stage business results use result collection, not full transcript handoff. User scripts remain outside output ownership. | Stage Briefs, immutable result hash references | Audit only; no new changes required |
| Agy handoff (`agy-interactive.ts` result) | Extracts completed model business response within exact task input boundary; no demonstrated transcript leak. | Native transcript and collected hashed business result | Preserve; #110 ordinary-conversation acceptance |

Frozen completion list: Status, Start with startup diagnostics, Recover, standalone Agy acceptance. No real EPIC, schema changes, provider branch, logging system or compression model.

## Reproduction

Fixed Registry input is `tests/workflow/fixtures/concise-output/registry.ts`; baseline calls and stdout/stderr/combined bytes are in sibling `baseline.json`. Capture used the registered Commander entry with controlled service results, matching the approved start-type seam. Inspection has no live terminal, so no host dependency. Start returns the first fixture Run; Recover returns the fixed occupancy blocker and pending Dispatch. Inputs include two Runs, 35 pending results, long Briefs/Requirements and handled prior Attempt history. Output includes a trailing newline and compact JSON. Zero stderr is observed, not assumed.

The harness did not exist at the frozen revision. Reproduce in a disposable checkout of the delivered integration branch, retaining its harness and fixtures while replacing only the command adapter. Never run capture flags in the delivery checkout: they overwrite that checkout's baseline files. From a clean delivery checkout, create the scratch worktree, install dependencies and build Core:

```sh
git worktree add --detach /tmp/pc106-reproduce HEAD
cd /tmp/pc106-reproduce
pnpm install --offline --frozen-lockfile
pnpm --filter @paper-craft/core build
git show 3092149:packages/cli/src/commands/workflow.ts > packages/cli/src/commands/workflow.ts
PC_CAPTURE_BASELINE=1 pnpm exec vitest run tests/workflow/concise-output.test.ts -t 'retains every current Run'
git show b2452f2:packages/cli/src/commands/workflow.ts > packages/cli/src/commands/workflow.ts
PC_CAPTURE_START_ERROR=1 pnpm exec vitest run tests/workflow/concise-output.test.ts -t 'keeps hidden startup diagnostics'
git show e5294eb:packages/cli/src/commands/workflow.ts > packages/cli/src/commands/workflow.ts
PC_CAPTURE_RECOVER_ERROR=1 pnpm exec vitest run tests/workflow/concise-output.test.ts -t 'keeps Recover diagnostic failures'
```

Compare scratch `tests/workflow/fixtures/concise-output/*baseline.json` byte/exit fields with the delivery checkout's committed records; random diagnostic identities are not baseline inputs. Remove the disposable worktree after comparison. Each capture invocation should be bounded by a 120-second outer process timeout. The three adapter revisions reproduce the before-state of their respective slices; they do not claim the diagnostic fixtures existed at the original freeze. Byte comparisons measure bytes, not tokens.

## Acceptance evidence

CLI assertions cover all Runs, 35 unhandled claims and Dispatches, path/hash references, occupancy and Blockers, no handled bodies, unchanged exit semantics and full detailed Registry. Growing handled history must not expose new historical bodies. Existing Run-driver, evidence and recovery regressions protect unchanged business behavior. Ordinary Agy acceptance and final consolidated observations belong to #110; fixtures alone cannot establish that acceptance.


## #107 observed validation

On the fixed command calls above, Status stdout changed from 354,200 to 32,974 bytes; stderr remained 0, so totals are respectively 354,200 and 32,974. Start remains 15,560 stdout / 0 stderr / 15,560 total, Recover remains 460 / 0 / 460 pending their own slices. No tokenizer was used.

The new CLI tests went red on missing concise outcome before implementation, then green with all 35 pending results, complete detailed results, handled history growth, unknown occupancy and failure exit checks. They exercise the registered command; controlled internal service returns follow existing start-type prior art and do not establish a real runtime integration. Existing Run-driver, Evidence, Recovery and Start regressions passed unchanged. The 34-test combined run, including all eight real help commands, completed its full process lifecycle in 11.946 seconds under an outer 120-second timeout (Vitest 10.99 seconds). Build, lint, typecheck, actual Status help and whole-corpus documentation checks passed. Help snapshots were refreshed for the public flag and description. These observed timings do not guarantee performance on another host.

Remaining acceptance is assigned to dependent tickets: diagnostic error capture and save failure (#108), Recover projection (#109), complete evidence inventory and ordinary Agy conversation (#110). No claim of real Agy acceptance is made here.

## Start slice (#108)

Start now reports `outcome`, Run/Attempt identities, lifecycle, Attempt status, current Blockers and context/Evidence references. `--detailed` exposes the complete current structured Run and inspection without a second launch or automatic transcript/log loading. Exit meanings remain unchanged: a non-running Start returns 2, a running Start returns 0. Diagnostic-save errors never change that business result.

The shared adapter diagnostic helper recognizes the audited capability-probe detail and terminal suffix, preserving the actionable prefix. It first verifies readable matching current Registry/Runtime Attempt errors and returns their original path with Run/Attempt selectors. Status uses that read-only reference path, so its current Attempt/inspection no longer repeat terminal suffixes and queries do not create diagnostic snapshots. Unsaved startup errors are associated with a fresh invocation and available subject/Run/Attempt in an exclusive mode-0600 JSON record directly inside existing physically validated Runtime storage. Known labelled key/token/password/secret and Bearer values are redacted in newly saved diagnostics. Original authoritative records and subprocess/parser inputs are unchanged. `.runtime/` is ignored so local diagnostic records cannot enter Git through ordinary staging.

The frozen Start fixture totals 15,560 stdout bytes + 0 stderr before, versus 506 + 0 after. The audited preflight-error fixture totals 3,280 stdout bytes + 0 stderr before, versus 459 + 0 after, including its readable diagnostic reference. Byte totals include trailing newlines; no tokenizer was used. The exact fixed error and pre-change measured streams are in `tests/workflow/fixtures/concise-output/start-error-baseline.json`. It was captured through the registered CLI with the pre-change `workflow.ts` from `b2452f2` before replacing that boundary; reproduction uses this ticket's CLI harness with `PC_CAPTURE_START_ERROR=1` and the original command adapter. Do not overwrite this baseline when running the shipped adapter. `PC_MEASURE_START=1` with the shipped harness writes current measurements to `/tmp/pc-106-context/start-after.json` and `start-error-after.json` (create that local directory first). Random invocation IDs and fixed-length temporary directory names do not change these byte counts.

The new slices went red on missing concise Start outcome and then on the raw error boundary, before passing. CLI checks cover blocked/unknown and running states, full detail, no duplicate execution, readable invocation association, secret redaction, current Registry reuse without duplicate files, Status suffix isolation, and successful business work with actual storage failure or physical-root symlink rejection. Controlled service returns follow the approved CLI seam; they are not evidence of a real Agy session. Existing Run-driver, Recovery and Evidence regressions remain green. The six-suite run passed 36 checks, including eight actual CLI help commands, in 8.009 seconds for the complete process lifecycle under an outer 120-second process-group timeout (Vitest 7.43 seconds). Build, lint, typecheck, actual Start help and whole-corpus documentation checks passed. Recovery adoption of the shared diagnostic behavior and real ordinary Agy acceptance remain #109/#110.

## Recover slice (#109)

Recover now distinguishes `outcome` (`succeeded`, `blocked`, or `failed`) from the retained Run lifecycle and Attempt status. Default output includes the complete pending Dispatch list, concise Blockers, current inspection and existing guidance, Reconciliation, observed occupancy and startup Evidence references. `--detailed` exposes the complete current command result, including raw Blockers and inspection cause, without rerunning Recovery or reading logs/transcripts. Business recovery, replacement, termination, Receipt and Hash validation remain unchanged. Blockers or a thrown command error still return 2; successful Recovery returns 0.

Recover uses Start's existing diagnostic mechanism for current Attempt errors and otherwise unrecoverable hidden blocker diagnostics. It references matching readable current Registry/Runtime records when available, otherwise saves invocation-associated diagnostics under the validated Runtime home. Diagnostic-save failure is reported separately and cannot turn successful Recovery into failed business work. A thrown Recovery error refreshes inspection from persisted state without retrying the operation; command failure is not evidence of execution termination.

On the identical frozen normal/blocked fixture and call, Recover changes from 460 stdout bytes + 0 stderr (460 total) to 811 + 0 (811 total). The increase carries the previously absent explicit outcome, Reconciliation and occupancy information; this boundary did not contain historical redundancy. The audited error fixture changes from 3,461 + 0 (3,461 total) to 1,094 + 0 (1,094 total), including current execution state and its readable diagnostic reference. No tokenizer was used. `tests/workflow/fixtures/concise-output/recover-error-baseline.json` holds the exact fixed error and original output measurements, captured before replacing the Recover error boundary. Reproduce the old error measurement using the command adapter from `e5294eb` and this harness with `PC_CAPTURE_RECOVER_ERROR=1`; do not overwrite it using the shipped adapter. `PC_MEASURE_RECOVER=1` writes current normal/error measurements to `/tmp/pc-106-context/recover-after.json` and `recover-error-after.json` (create that directory first).

The two CLI regression slices went red on missing recovery outcome/current information and on the raw error boundary before passing. They protect successful/blocked/unknown states, complete detailed output, preserved replacement options and one Recovery per invocation, readable saved diagnostics with command/Run/Attempt attribution, current Registry reuse, hidden blocker diagnostics and successful business work despite actual filesystem save failure. Existing ownership, Evidence, Hash, independent replacement and Recovery checks passed unchanged. Seven suites passed 41 checks, including eight actual CLI help commands; complete process lifecycle was 9.894 seconds under an outer 120-second process-group timeout (Vitest 9.03 seconds). Build, lint, typecheck, actual Recover help and whole-corpus documentation checks passed. These controlled CLI fixtures do not establish ordinary Agy acceptance; that remains #110.

## Integrated acceptance (#110)

Validation host: macOS 14.5, x86_64, Node v24.22.1, pnpm 12.8.1. Final implementation includes review fix `7d06db2`: quoted JSON credentials are redacted, persisted Reconciliation blockers are referenced without creating duplicate diagnostics, pending message Brief bodies are omitted with message/Dispatch selectors retained, and Start failures refresh available reserved Run state without retrying startup. Regression assertions first failed on each defect, then passed. No authoritative schema or Runtime parsing changed.

| Frozen delivery item | Automated evidence | Result |
| --- | --- | --- |
| Status | `concise-output.test.ts`: two Runs, 35 pending claims, history growth, uncertain messages, all current resources/blockers/references, detailed result and read errors | Passed |
| Start and startup diagnostics | Same suite: running/blocked/error outcomes; reserved state on failure; one launch per invocation; readable invocation association; quoted/unquoted secret redaction; existing-record reuse; real write and physical-root failures | Passed |
| Recover | Same suite: success, blocked/unknown, command errors, detailed effects, current Evidence/Reconciliation, persisted blocker reuse, save failure independent of business success | Passed |
| Original Evidence and release safety | Existing `run-driver`, `run-ownership`, `evidence-discipline`, `recovery`, `independent-recovery`, `agy-interactive` suites | Passed unchanged |
| Public help and canonical guidance | Actual Status/Start/Recover `--help`, `help-contract.test.ts`, `skills/pc-orchestrator/managed-lifecycle.md` and its role pointer | Passed; shared rule remains canonical |
| Ordinary Agy conversation | Native interactive session described below; actual command output and referenced file inspected | Passed with limitations below |

Final fixed-input measurements include the trailing newline. No tokenizer was used; these are byte measurements only.

| Identical fixture/call | Before stdout | Before stderr | Before total | After stdout | After stderr | After total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Status | 354200 | 0 | 354200 | 32974 | 0 | 32974 |
| Start blocked | 15560 | 0 | 15560 | 506 | 0 | 506 |
| Startup probe error | 3280 | 0 | 3280 | 459 | 0 | 459 |
| Recover blocked | 460 | 0 | 460 | 811 | 0 | 811 |
| Recover diagnostic error | 3461 | 0 | 3461 | 1094 | 0 | 1094 |

The before-state adapters were rechecked in an isolated worktree with the delivered harness: all three committed baseline records matched their stdout/stderr/total/exit fields. Final after-state values were remeasured with `PC_MEASURE_STATUS=1 PC_MEASURE_START=1 PC_MEASURE_RECOVER=1 pnpm exec vitest run tests/workflow/concise-output.test.ts` (create `/tmp/pc-106-context` first). Recover's normal result grows because it now carries necessary explicit state; historical redundancy cases shrink. Legitimate Run/pending-work growth remains unbounded rather than truncated.

Required checks were `pnpm run build`, `pnpm run lint`, `pnpm run typecheck`, `pnpm docs:check`, and this integration test command:

```sh
pnpm exec vitest run tests/workflow/concise-output.test.ts tests/workflow/start-type.test.ts tests/workflow/run-driver.test.ts tests/workflow/run-ownership.test.ts tests/workflow/evidence-discipline.test.ts tests/workflow/recovery.test.ts tests/workflow/independent-recovery.test.ts tests/workflow/agy-interactive.test.ts tests/workflow/help-contract.test.ts
```

All 54 checks in nine suites passed. The complete integration-test subprocess, including fixture setup and teardown, took 11.916 seconds under Python `subprocess.run(..., timeout=120)`; Vitest reported 10.69 seconds. This bounds every changed test's complete execution within that run. Dependency installation and builds were separate. The isolated final measurement rerun passed all eight output-contract tests (Vitest 1.43 seconds). Earlier slice timings above are historical observations; this exact final command is the reproducible integration gate.

### Ordinary Agy observation and limits

Run `pnpm exec tsx tests/workflow/fixtures/concise-output/prepare-smoke.ts <isolated-temporary-directory>` to prepare the synthetic Fleet from the committed fixed fixture. It has two Runs, two pending Dispatches/claims, unknown occupancy, real local path/hash references and a persisted startup error. It creates no executions or resource ownership markers. Build the delivered CLI before invoking it.

In native Agy 1.4.12 with Gemini 3.8 Flash/high, ordinary conversation `2488403f-23d3-43cd-a195-f30110f44735` ran the delivered `pc workflow orchestrator status --config /tmp/pc-106-smoke/.epic-config.json`, then the same call with `--detailed`. The user handled native trust and command authorization. Expanded native terminal tool results were inspected directly, rather than inferring acceptance from fixture tests or the model's final summary. Concise output retained both Runs, `pending-0`/`pending-1`, blocked lifecycle, unknown current Attempt and the existing Registry diagnostic reference. Agy correctly declined resource reuse on unknown occupancy. Detailed output exposed the full fixture bodies. Its native file-reading tool followed the Registry reference and read the current `run-1` / `attempt-current` error successfully. One intermediate native ReadFile byte-offset error was followed by a successful narrower read; this provider read behavior was not modified.

This smoke establishes ordinary-conversation inspection, expansion and diagnostic follow-through. It does not establish real EPIC execution, live startup/replacement, every Provider, or all failure modes; those unchanged business guarantees rely on the automated evidence listed separately. The callback-advertised native transcript path was not readable on disk, so no transcript verification or archive is claimed. Native tool output was observed in the live terminal; no native transcript or runtime log is committed. Diagnostic references remain troubleshooting aids, never original Acceptance Evidence. No remaining approved-scope acceptance item is deferred.
