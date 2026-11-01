# Dashboard design

The MVP design is described below and in the [companion specification](dashboard-spec.md). The repository includes a Hono service and React UI in [`packages/dashboard/`](../../packages/dashboard/), exposed through the [`pc dashboard` commands](../../packages/cli/src/commands/dashboard.ts). The scope and acceptance criteria below describe the design targets.

## Agreed scope

- Preserve broad useful observation coverage with minimal depth in the first release, rather than limiting it to an intervention inbox.
- Serve a single person initially, with local access and SSH tunneling for remote access; shared multi-user access is outside the initial scope.
- A read-only dashboard may be a complete delivery. Control actions are a possible later direction, not a committed milestone; do not require their infrastructure in the initial design.
- Initial features include overview and intervention items; Orchestrator, EPIC and Worker lists/details including tasks without an EPIC; checkout/Git/collision/hold evidence; terminal/runner/process evidence and collection diagnostics; GitHub Issue/PR/CI/review information; worklogs, search/filtering and changes observed after recording begins.
- Aggregate multiple Fleets without changing the existing one-EPIC-agent-per-Orchestrator relationship. Preserve Project's existing meaning as a research project grouping related repositories.
- Existing records may not distinguish execution attempts. Display this uncertainty; do not require new Worker identity records or reconstruct unsupported execution history. Collector observations are not execution identities.
- Include configured remote hosts and explicitly associated compute tasks. Do not discover task ownership by scanning arbitrary remote processes.
- Register Fleets explicitly by authoritative configuration path and remember them. Project association is optional; retain invalid registrations with actionable diagnostics.
- Persist meaningful observed changes, not every full snapshot, in pc's own local data directory with a default retention of 30 days. Record observation gaps; do not claim complete recovery of changes during downtime.
- Default log content is the worklog. Offer bounded, on-demand terminal output and existing Runner logs with segmented loading, manual refresh and copying. Show source and read time; report read failures. Do not continuously archive all terminal output or accept terminal input.
- Generate intervention items from explicit records or deterministic rules, with supporting evidence. An open PR alone is not a request for user approval. Staleness can request investigation but cannot prove exit or availability. Show unknown/conflicting evidence explicitly; do not call an LLM to interpret state.
- Start collection with an explicitly launched `pc dashboard serve` service. Collection continues after browser closure until the service stops; no default startup at boot.
- Collection, aggregation, history and refresh must not invoke models, start agents, or send observations into agent conversations. Minimize additional LLM token consumption; routine monitoring requires none.
- Refresh sources independently, share results across clients, isolate source timeouts, and retain last successful observations with stale/error indicators. Defaults: local state/terminal/process evidence every 15 seconds; Git every 60 seconds; GitHub every 3 minutes; associated remote tasks every 5 minutes. Do not poll remote hosts without associated tasks or overlap collection for the same source. Back off on failure. Manual refresh remains subject to limits and does not invoke agents or `git fetch`.
- Reuse existing local GitHub authentication and SSH configuration. Do not store passwords/private keys or handle interactive login in the dashboard. Remote collection must be noninteractive and time-bounded, with actionable connection diagnostics.
- Bind to loopback and require a startup access token plus request-origin validation. Use the same protection through SSH tunnels; exclude credentials from event/access logs. No user account system.
- Organize the UI around a global overview, Fleet filtering and drill-down details. The overview highlights active work, blockers, intervention items and collection failures. Search/filtering spans registered Fleets and identifies each result's Fleet. No graph editor initially.
- The first delivery is a simple MVP: preserve observation breadth with minimal depth. Use one overview and expandable details rather than six fully developed pages. Include Fleet registration/selection/aggregation, task tables, evidence and intervention items, Git/PR/CI/remote details, bounded logs, basic search/filtering and a recent-change list.
- Exclude DAGs, historical replay, trend charts, push notifications, browser configuration editing and scheduling actions. Retain the 30-day observed-change history as a simple list.
- Use React + Vite and a Hono local service. Share only the aggregation logic actually needed by CLI and Web, respecting the existing Core/host dependency direction. Use cached polling and local file-based change records. Do not add a database service, SSE, generic plugin framework, Command Gateway, OrchestratorBridge or control modules.

## MVP acceptance

- One locally launched service aggregates explicitly registered Fleets for one user; multiple browser clients reuse its collected data.
- The overview and details expose the agreed data sources without changing scheduling protocols or requiring new execution identity records.
- Missing, stale, conflicting and failed observations remain visible and attributable. They do not become assertions that a task finished, a slot is free or user approval is required.
- State refresh, intervention classification and history recording do not invoke models or agents.
- Bounded logs and a retained change list support investigation; monitoring gaps and unknown execution attempts are explicit.
- Loopback access, startup token and request validation protect the read-only service without user accounts. Remote observations reuse existing noninteractive credentials.
