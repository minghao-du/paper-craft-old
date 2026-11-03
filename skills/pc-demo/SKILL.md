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

## Managed execution controls

`pc demo --config <file> start <round> --confirm --budget-minutes 60` starts an independent Agy Orchestrator. No provider fallback or permission bypass is enabled. Reconnect using `status <round>`. Submit suspected problems with `report <round> <text> --evidence <reference>` and stop with `stop <round>`; proof is not required. Observations remain in `control.json` even after business completion. Stopping revokes scheduling authority before cancellation and preserves diagnostics.

A detached demo watchdog enforces the active budget after launcher disconnect. Human/permission waiting must be recorded at verified boundaries through the public control checkpoint; the watchdog does not infer waiting from missing output. Native stop cannot prove aggregate detached-helper/ownership release and therefore retains unknown occupancy; do not reuse or delete these resources based on a stop response. Missing release proof is a blocker, never a successful stop or demo pass. Generic runtime recovery remains outside this demo control boundary; do not invoke recovery/retry on a stopped demo Run. Usage is unavailable unless separately evidenced by the provider.
