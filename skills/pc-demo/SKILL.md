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
