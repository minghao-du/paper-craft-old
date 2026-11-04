---
name: pc-dashboard
description: Launch the read-only local Fleet Dashboard or inspect Fleet evidence as JSON.
---

Register an authoritative Orchestrator configuration with `pc dashboard serve --config /absolute/path/.epic-config.json`.
Registrations persist under `~/.config/pc/dashboard`; use `--data-dir` to select a separate Dashboard store.
Worker-local configuration snapshots are refused as authority and invalid registrations remain visible with diagnostics.

Open the startup link privately.
The access token stays in the URL fragment and browser session storage; requests require that token and matching Host/Origin.
The service binds to `127.0.0.1:4317` and collects until interrupted, even after closing the browser.
Use `--port` to change the port, `--no-open` to suppress browser launch, and `--interval` to configure local collection in milliseconds (default 15000).
For SSH access forward the same local port and open the startup link through that tunnel.

`pc dashboard status --config /absolute/path/.epic-config.json` prints the same file-evidence contract as JSON and exits.
Omit `--config` to inspect remembered registrations.
Build with `pnpm run build` before launch.

Managed execution projects authoritative Runs and stage dispatches from the RunRegistry.
Configured directories (`config.slots` or `config.worktrees`) without managed tasks show Git and terminal observations; legacy slot status does not establish an independent Worker execution identity or duplicate Managed tasks.
Old lightweight records do not produce extra execution rows.
All tasks and observations are derived strictly from RunRegistry without scanning for legacy `.epic-status.json` or `.epic-worklog.md` files. Invalid evidence still reports an error.

Expand each row for attributed sources, observation times, blockers and collection failures.
A recorded phase does not establish a live agent, completion or slot availability.
Refresh is bounded by the collection schedule; clients share cached observations.
The Dashboard writes only its own registration/cache data and exposes no workflow controls.

Expand “Git checkout constraints” for per-Fleet branch, changed files, cached-base relation, holds and collision evidence.
Checks cover checkouts from Managed Registry resources as well as configured slots.
Missing registered checkouts report probe failures (unknown), never inferred as released; releasing a checkout requires explicit resource table removal rather than run completion.
Git observations refresh independently every 60 seconds (configure with `--git-interval` in milliseconds), with bounded probes and per-Fleet failure backoff.
Failed collections retain attributed stale successes.
Reads never fetch Git refs; a clean checkout does not establish slot availability.

Runtime details show exact-directory tmux pane observations and the pane PID’s process name without reading process arguments.
An ordinary shell, dead pane, missing tmux or a recorded session cannot establish a live agent or free slot.
Runtime observations default to 15 seconds; use `--runtime-interval <milliseconds>` to change this independently.
Runtime failures retain marked stale successes with their last successful observation time and use bounded probes with per-task backoff.
No processes are launched or terminated by observation except the short-lived read-only probes themselves.

Pass multiple paths after `--config` to register multiple Fleets.
`--project <name>` optionally associates newly registered Fleets with a research Project; Fleets work without one.
The overview supports Fleet selection, search, phase filtering and evidenced attention items.
JSON clients can use `/api/snapshot?fleet=<id>&q=<text>&phase=<phase>&attention=true` with startup authentication.
Each task remains scoped to its Fleet even when Issue numbers match.

Intervention reasons cite the status source: recorded blockers, `needs-human`/legacy `blocked` phases and overdue saved checks.
For `awaiting-results`, a valid future `awaiting.next_check_at` means planned waiting, even with old file modification times.
Missing schedules and runtime evidence remain unknown.
File activity uses the latest attempt log or observation time; hand-written `updated_at`, quiet output and an open PR alone do not establish stalled work or a request for approval.

Expand a task’s Logs to read its attempt log or transcript file by default, switch to a currently verified terminal, refresh, copy or load the next segment.
Logs use complete-line segments of at most 16 KiB with a 1 MiB context-read ceiling; oversized lines are explicitly omitted and deeper offsets are refused; terminal capture is limited to 200 recent lines and 16 KiB.
Each response names the source and read time; absent files, unavailable capability and read errors remain distinct.
Terminal reads recheck exact physical directory and pane/PID association before and after capture, refusing ambiguous panes.
Runner transcripts remain unavailable without a safe verified identity/source contract.
Reads accept source choices and byte offsets, never arbitrary paths; out-of-scope paths are explicitly unavailable and registration does not expand filesystem permissions.
Sensitive credential lines and recognized private prompt blocks are omitted; logs are read on demand and never continuously archived.
Terminal redaction covers only the captured window; it cannot identify prompt context that began earlier in scrollback.
Use worklogs when terminal output may contain private prompts.

Expand “Associated remote compute tasks” for explicitly registered Slurm jobs.
In the authoritative `.epic-config.json`, optionally set `remote_hosts` to SSH host aliases and `remote_tasks` to objects such as `{"slot":"worker","host":"cluster","job_id":"12345"}`.
Only configured slots, allowlisted host aliases and numeric job IDs are supported; unsupported or incomplete associations remain unknown.
Hosts without associated tasks are never probed.
This setup is read locally; there is no HTTP registration or remote command endpoint.

Remote collection uses the existing SSH configuration with batch authentication and strict existing host-key verification, running only bounded `squeue` reads.
Resolve missing login/host-key/scheduler setup from a terminal.
Missing scheduler rows mean absence from the active queue, not proven completion.
Observations refresh every 5 minutes (`--remote-interval` milliseconds), sharing results across clients with per-task failure backoff and stale-success retention.
Remote observations never authorize local slot reclaim.

Expand GitHub delivery to inspect explicitly recorded Issue/PR status, CI checks and reviews.
Reads reuse `gh` authentication and the checkout's explicit github.com origin; mismatched PR repository links remain unknown.
Run `gh auth login` in a terminal when authentication is unavailable.
`/api/github` returns cached attributed evidence with observation/last-success times and stale errors.
GitHub refresh defaults to 180000 milliseconds; configure `--github-interval`.
Refresh respects rate/backoff bounds and never submits comments, approvals or merges.
An open PR is not an approval request.

## Recent observations

`/api/history` and the overview retain meaningful observed evidence changes for 30 days in Dashboard-owned `observations.jsonl`.
Entries identify Fleet, subject, source and observation time; private evidence values, prompts and logs are not archived.
Restarts mark a monitoring gap from the last saved observation.
These records cannot recover unseen events or distinguish otherwise unknown execution attempts.
Retention only prunes Dashboard observation records.

## Persistent execution evidence

Expand execution evidence on Run and managed dispatch rows to inspect recorded role, provider, conversation, attempt, predecessor and tmux address together.
Timestamped running, idle, waiting, error, exited and unknown observations remain separate from receipt acceptance.
Missing observations and observations older than five minutes are marked stale; neither implies completion or availability.
Receipt claims retain attempt attribution; missing or mismatched accepted receipts are conflicting evidence.
Resolved startup failures remain visible alongside current errors.
Configured directory observations without managed tasks retain unknown execution identity; a recorded phase does not establish a live agent, completion or slot availability.
Refresh reads existing durable evidence only and never launches, messages, recovers or terminates an execution.
Monitoring gaps and unobserved attempts remain unknown; the view is not a complete execution audit.
