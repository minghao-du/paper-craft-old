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

`pc demo --config <file> start <round> --confirm --budget-minutes 60` starts an independent Agy Orchestrator. No provider fallback or permission bypass is enabled. Reconnect using `status <round>`. Submit suspected problems with `report <round> <text> --evidence <reference>` and stop with `stop <round>`; proof is not required. Observations remain in `control.json` even after business completion. Stopping revokes scheduling authority before cancellation and preserves diagnostics.

A detached demo watchdog enforces the active budget after launcher disconnect. Human/permission waiting must be recorded at verified boundaries through the public control checkpoint; the watchdog does not infer waiting from missing output. Native stop cannot prove aggregate detached-helper/ownership release and therefore retains unknown occupancy; do not reuse or delete these resources based on a stop response. Missing release proof is a blocker, never a successful stop or demo pass. Generic runtime recovery remains outside this demo control boundary; do not invoke recovery/retry on a stopped demo Run. Usage is unavailable unless separately evidenced by the provider.

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
