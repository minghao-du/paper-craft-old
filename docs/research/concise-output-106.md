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

On the frozen commit, run the fixture and baseline-capture test from #107 with `PC_CAPTURE_BASELINE=1 pnpm exec vitest run tests/workflow/concise-output.test.ts`. Do not overwrite baseline after implementation. The capture branch is retained solely to reproduce the original command calls. Byte comparisons measure bytes, not tokens. Later tickets should add their actual error fixtures before changing their audited error boundaries; this baseline establishes normal/blocked command calls, not proof of diagnostic correctness.

## Acceptance evidence

CLI assertions cover all Runs, 35 unhandled claims and Dispatches, path/hash references, occupancy and Blockers, no handled bodies, unchanged exit semantics and full detailed Registry. Growing handled history must not expose new historical bodies. Existing Run-driver, evidence and recovery regressions protect unchanged business behavior. Ordinary Agy acceptance and final consolidated observations belong to #110; fixtures alone cannot establish that acceptance.


## #107 observed validation

On the fixed command calls above, Status stdout changed from 354,200 to 32,974 bytes; stderr remained 0, so totals are respectively 354,200 and 32,974. Start remains 15,560 stdout / 0 stderr / 15,560 total, Recover remains 460 / 0 / 460 pending their own slices. No tokenizer was used.

The new CLI tests went red on missing concise outcome before implementation, then green with all 35 pending results, complete detailed results, handled history growth, unknown occupancy and failure exit checks. They exercise the registered command; controlled internal service returns follow existing start-type prior art and do not establish a real runtime integration. Existing Run-driver, Evidence, Recovery and Start regressions passed unchanged. The 34-test combined run, including all eight real help commands, completed its full process lifecycle in 11.946 seconds under an outer 120-second timeout (Vitest 10.99 seconds). Build, lint, typecheck, actual Status help and whole-corpus documentation checks passed. Help snapshots were refreshed for the public flag and description. These observed timings do not guarantee performance on another host.

Remaining acceptance is assigned to dependent tickets: diagnostic error capture and save failure (#108), Recover projection (#109), complete evidence inventory and ordinary Agy conversation (#110). No claim of real Agy acceptance is made here.
