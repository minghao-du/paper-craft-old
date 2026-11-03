---
name: pc-demo
description: Provision and inspect an explicitly requested disposable Agy EPIC demo environment.
---

# Disposable Agy demo

Only invoke provisioning when the operator explicitly requests a demo environment.
Create an operator-reviewed JSON config with `root` (an existing absolute physical
empty demo-only directory), `owner`, `prefix` (ending in `-`), `coordinator`
(identity), and `brief` (confirmed report requirements). Do not use research or
production directories. Each round gets its own absolute research entry in its
manifest; provisioning never writes a real project's research state.

1. Run `./pc demo --config <file> preflight`. It checks Agy, Python, Git and GitHub
   authentication and owner lookup without creating resources. Review the baseline
   identity, owner/prefix, local boundary, intended writes and eligible deletion.
   This cannot guarantee permission for future writes or deletion.
2. After explicit confirmation run `./pc demo --config <file> provision --confirm`.
   This creates one private repository and initial Parent EPIC from the built-in
   content-pinned baseline, isolated checkout/worktree pool, state and research
   directories. It does not start agents, create children or claim delivery success.
3. Reconnect using `./pc demo --config <file> status <round>`. Preserve failed
   provisioning scenes and their `round.json` error/identity evidence; do not retry
   a failed stage or adopt its resources into another round.

GitHub policy, permission and throttling failures block provisioning. Writes are
spaced and never automatically replayed; uncertain remote results are queried and
retained for diagnosis. No provider permission bypass is enabled. Controlled adapter
tests establish provisioning behavior only, never real GitHub/Agy acceptance.

Use `./pc demo --config <file> verify <round> --boundary <stage>` to inspect
independent GitHub metadata, merged Git objects and Runtime evidence. Supported
boundaries are `structure`, `delivery`, `closure`, `finalization`, and `final`
(the default). Diagnostics persist in `verification.jsonl`; an earlier confirmed
violation remains a finding after later outputs become correct. Business,
defect, execution/resource and cleanup results are separate. Missing chronology,
isolated re-execution, observation or termination evidence prevents a clean
verdict. A checker result alone does not authorize deletion or prove zero bugs.
Controlled checker samples never establish native Agy/GitHub acceptance.
## Managed execution controls

The operator starts execution using a two-command sequence:
1. `pc demo --config <file> arm <round> [--budget-minutes 60]` arms the provisioned round, immediately starting budget accounting and launching the detached watchdog. It creates no Run or agent and cannot rearm an already armed or stopped round. Pre-start idle and startup/activation time count against the budget.
2. `pc workflow orchestrator start <parent> --config <checkout>/.epic-config.json --provider agy --type epic` starts the independent Agy Orchestrator through normal Workflow intake. Normal intake uniquely and durably binds the armed round to one Run before execution, validates repository/parent/provider/configuration and armed state, and applies immutable Run constraints. Reconnecting uses the same normal Workflow command without creating duplicate Runs or Attempts.

Submit suspected problems with `report <round> <text> --evidence <reference>` and stop with `stop <round>`; proof is not required. Observations remain in `control.json` even after business completion. Stopping revokes scheduling authority before cancellation and preserves diagnostics.

A detached demo watchdog enforces the active budget after launcher disconnect and invokes the public Workflow stop boundary (`stopRun`) on expiry. Human/permission waiting must be recorded at verified boundaries through the public control checkpoint (`permission-wait <round> <evidence> --confirm` and `permission-resume <round> --confirm`); the watchdog does not infer waiting from missing output or silence. Planning proceeds under common controls, but Worker dispatches without matching Gate evidence are denied. Native stop requires verified historical attempt, detached-helper and ownership release; missing proof retains unknown occupancy; do not reuse or delete these resources based on a stop response. Generic runtime replacement is not authorized for demo-constrained Runs. Usage is unavailable unless separately evidenced by the provider. Business completion ends active budget accounting.

Run `./pc demo --config <file> dispose <round>` after final business completion.
It recollects independent evidence, terminates owned executions without changing
business completion, displays the result and removes only a fully verified clean
round's repository and local scene. Unknown execution, late observations, failed
checks and failed deletion retain diagnostic records. Do not use `stop` to mark a
clean completion: stop is a retained user interruption.

For a retained problem scene, validate the fix in a different fresh round with the
same baseline, then use `dispose <old-round> --validated-by <fresh-round>
--confirm-resolved` only after explicit operator confirmation that the findings
were resolved. A repair commit alone is insufficient. The fresh validation scene
must still be available for independent checking. Deletion does not erase Agy
native history, GitHub backups or external console/chat copies. Permission,
policy and throttling failures remain explicit cleanup failures; uncertain remote
deletions are queried before any further mutation. No automatic deletion retries.
## Sequential delivery and human Closure

From normal EPIC planning, the Orchestrator plans and Workflow creates exactly two native children with the second natively blocked by the first and no extra business tasks. Persisted task-1 and task-2 identities remain stable regardless of GitHub array order; both deliveries belong to the Parent Run.

The Demo-bound Orchestrator automatically invokes `./pc demo --config <file> gate <round> worker1` after planning and child creation and before the first Worker; the operator does not manually invoke it. Gate 1 independently verifies Parent identity, the exact child set and parentage, native dependency direction, absence of extra tasks, and the current armed/bound Round, retaining observed facts in `delivery-boundaries.jsonl`.

A successful Gate 1 check produces a durable authorization bound to Round, Run, first task Issue, stage, and evaluated inputs. Workflow rechecks this authorization at execution, claims it durably on disk before invoking the Runner, and prevents reuse for another launch. Missing, stale, wrong-identity, or previously used authorization cannot launch a Worker. An uncertain launch result is reconciled without respawning. A failed Gate or diagnostic violation stops the Round and retains evidence. Stage retries, replacement Attempts, corrective rework, and extra task PRs are prohibited for Demo.

Task 1 delivery reuses normal Worker, Quality, landing, receipt/acceptance, Final Records, preservation and release paths. Normal continuation needed for successful final records is permitted. The second task remains blocked until Gate 2 is satisfied.

Worker 2 waits for full PR 1 landing, final records, preservation, cleanup and verified handover before `gate <round> worker2`. A failed gate stops dispatch; retain the boundary evidence. The second gate requires the actual merged, accepted, Final Records completed, preserved and released first delivery. Worker 2 starts at a revision containing that merge. Keep exactly two task PRs and use real Agy roles for Quality, landing, Integrated Acceptance and later specialists.

After Integrated Acceptance, call `closure-request <round>` to present the exact
delivery fingerprint and exclude human waiting from the active budget. The human
reconnects with `confirm <round> <version> --confirm`. This only creates consent;
changed deliveries require a fresh request and fresh confirmation. The Orchestrator
then calls `close <round> --authority <attempt> --dispatch <id>` to recheck consent,
actually close GitHub Parent and run the existing authoritative closure gate.
Never write human-closure.json from agent output or invent human consent.

The native verifier reads retained gate snapshots and compares the Worker 2
Attempt creation times with the witnessed handover. Missing historical observations
remain inconclusive. Correct eventual artifacts cannot erase a failed gate.

After verified actual Parent closure, the Orchestrator dispatches a real Agy
`pipeline-audit` specialist through the existing Workflow CLI. Require actual
inspection evidence and delivered `inspectedVersions` for `not_applicable` or
`completed_no_changes`. Accept the result through
`./pc demo --config <file> pipeline <round> --authority <attempt> --dispatch <id>`.
Any required changes stop this diagnostic round; preserve findings without repair,
additional task Issues, or a third PR.

On the accepted no-change path dispatch the real `research-state` role. Its report
artifact must contain all nine sections required by `/pc-research-state`, actual
commands and results, Issue/PR references, four summary values, accepted and
observed versions, Pipeline conclusion and limitations. Keep content brief; no
scientific inference is justified by this infrastructure task. Accept its result,
then invoke `./pc demo --config <file> publish <round> --authority <attempt>
--dispatch <id>`. This uses the operator-configured Coordinator identity/brief and
only the isolated manifest entry; the existing transactional writer validates
sections and records provenance. A diagnostic report on a blocked round does not
count as this publication. Problem reporting and stop remain available during
both specialists; no automatic stage retry is permitted.

## Whole-round verification

The task programs use default relative paths: `python3 generate.py` writes
`data.tsv`; `python3 summarize.py` reads it and writes `summary.json`. The final
checker exports immutable merged Git source into a temporary validation directory,
runs `python3 -m unittest discover -s tests`, reruns both programs, then changes
the temporary TSV and checks recomputation. Accepted source is never modified.

Run `./pc demo --config <file> verify <round>` after business completion. Final
verification requests verified execution release, displays independent results,
and automatically disposes a clean scene. Earlier-stage inspection uses
`verify <round> --boundary structure|delivery|closure|finalization`; `delivery`
means both deliveries have completed. Findings and unknown occupancy retain the
scene. `dispose` supports the same final checks and retained-scene authorization.

For real acceptance, first review the config's owner/prefix, pinned baseline hash,
physical isolated roots, Coordinator identity/brief and derived absolute report
entry. Check Agy, Python, Git, GitHub authentication, repository creation/deletion
permissions and policy/rate limits. Review all intended writes and eligible
deletion, provision with explicit consent, then separately start with explicit
consent and an active budget (default 60 minutes). Follow status, report/stop and
version-bound human confirmation controls above; after publication perform final
verification. Never call a controlled test or an unperformed/blocked real run a
live pass. Stop and preserve environment failures and defects without repairs or
stage retries. Usage unavailable from the provider remains unavailable; human
waits do not consume active execution budget. Successful detection cannot prove
absence of all defects. Deletion excludes provider history and external copies.

Use `resolve-observation <round> <observation> <reason>` only to record a supported false alarm with its reason. An unresolved observation blocks clean disposal.

For an observed native Agy permission prompt, the operator runs
`./pc demo --config <file> permission-wait <round> <evidence> --confirm` and,
after resolving that prompt, `permission-resume <round> --confirm`.
These reconnectable controls exclude the recorded permission wait from active time;
they require operator observation and do not claim automatic native prompt detection.
They cannot resume a human closure pause.

When validating a fix for an old retained scene, use the fresh round's final command
`./pc demo --config <file> verify <fresh> --resolves <old> --confirm-resolved`.
It verifies and deletes the authorized old scene while fresh evidence still exists,
then performs normal fresh-round disposal. If old-scene disposal fails, both remaining
scenes are retained. Do this before plain final verification auto-deletes the fresh round.
