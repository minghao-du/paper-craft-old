---
name: pc-orchestrator
description: Fleet orchestrator cold-start dashboard — full scan of clones, tmux, and host state for EPIC-based multi-clone orchestration
---

# /pc-orchestrator

Read [the shared runtime and workflow contract](../lib/workflow.md) before using helper commands or runtime-specific tools.
Tmux is shared infrastructure; Claude-specific tool names and examples apply only when that runner provides them, with file-based delivery otherwise.

The orchestrator is the user's primary conversation and the top-level scheduler.
Managed Runs use [the managed lifecycle](managed-lifecycle.md) for role ownership, automatic guarded PR merge, and explicit final EPIC closure confirmation.
Legacy execution follows its recorded scheduling and approval policy.
Use this skill at cold start and every reconciliation to inventory clones, tmux and
hosts. Topic decomposition, readiness and confirmation belong to `/pc-epic`.

## Lightweight Run intake

Create file-based intake without launching an agent:
`pc run create --issue <number> --runner '<command>' [--instructions '<text>']`.
Repeat `--instructions` to preserve each conversational requirement. The runner is an
opaque shell command; intake never invokes it or selects a platform adapter.
Inspect with `pc run inspect <run-id>`. Both commands accept `--root <directory>`
(default current directory) and `--fleet <id>` (default `default`). State lives in
`<root>/.runtime/<fleet>/runs/<run-id>/run.json`; keep the returned Run identity
for downstream dispatches. The record contains `run_id`, `issue_id`, `runner_cmd`,
`custom_instructions` and `created_at`.

## Managed startup

Start a Run with `pc workflow orchestrator start <issue> --provider <codex|agy|claude> --config <authoritative-config>`.
Apply [Project instructions in every dispatch](../lib/workflow.md#project-instructions-in-every-dispatch) to every subsequent role or task dispatch, including EPIC and PR stages.
`pc workflow orchestrator status --config <authoritative-config>` reads Runs and their persisted identities.
Only Runner conversation and turn acknowledgements yield startup success (exit 0).
Exit 2 reports failure or unknown; retain the brief, attempt and occupancy under the configured
clone root's `.runtime/<fleet-id>/` and inspect the recorded logs. Do not remove the lock
or start a replacement merely because a pane disappeared. Status is durable startup evidence,
not a live execution probe. The automatic dispatch loop is supplied by the subsequent workflow stages.

## Intake and planning

1. Load the authoritative config and register this orchestrator's verified runtime address
   in `$CLONE_ROOT/.orchestrator-session`; unavailable messaging uses durable files.
2. Read the Issue's repository and EPIC parent. For standalone work, use
   `pc workflow orchestrator issue <number> --config <authoritative-config>` while the
   managed Orchestrator is available. This command automatically resumes Orchestrator,
   allocates a new configured local worktree, dispatches Worker stages and returns
   their results until Orchestrator reports those stages delivered. Keep it running
   to drive the turns. Existing checkouts retain unknown ownership and are refused.
   It preserves each brief, receipt, result and attempt under the configured state
   directory; repeated completed intake does not replay execution. Worker briefs
   require project AGENTS.md and applicable lower directory guidance. Task stages
   delivered here do not prove PR merge, final records or cleanup completed.
   For a child Issue, retain parent context and dependencies while delivering only that child.
   Reconnect to its registered execution owner under the shared managed lifecycle.

3. Obtain each active EPIC's scoped task briefs, order, dependencies, readiness and blockers.
   Record user priorities and apply the shared scheduling contract to the measured resource
   inventory below; dispatch eligible work with `/pc-orchestrator-spawn`.
   A worker may delegate helpers within that task; independent work returns as intent.
4. Collect completion and review findings and all required EPIC confirmations at the current PR head,
   then dispatch automatic guarded PR-Land merge under the shared managed lifecycle. Route
   revision requests to the worker, retaining retry counts and attributed evidence.
   Finish with accepted delivery evidence or a concrete blocker and next owner.
5. Reconcile queued intent and receiver receipts before yielding; arm the shared
   workflow's wake-up mechanism when available. A successful send is not handling.

Relay domain findings and decisions through this conversation with expert attribution
and supporting pointers. Route substantive conflicts to the owning EPIC and unresolved
user judgments to the user; mechanical placement remains the orchestrator's responsibility.

## EPIC finalization

After delivered children, bind final acceptance and explicit human closure confirmation to the accepted delivery versions.
Verify actual closure before scheduling Pipeline applicability, Worker maintenance and specialist verification, then Research-State reporting under [the managed lifecycle](managed-lifecycle.md).

## Conventions

Use full issue/PR URLs on first mention and `iN`/`pN` thereafter. Worker tmux windows
are named `NNN-slot`. The orchestrator stays on `main` and performs orchestration,
not implementation or completion assessment. Native messaging is optional: each role
self-registers its own verified address and missing delivery leaves a durable pending
handoff. Never guess a replacement session from a similar name.

Corrections that change worker scope or gates are appended to its worklog before
notification. Preserve sender attribution; the issue-lead's `lead_guidance` is its own.
Log decisions beside the authoritative config in append-only `.epic-decisions.md`.
When paging the user, consolidate pending decisions, notify once, and keep independent
work moving. For planned shutdown use `/pc-orchestrator-prepare-reboot` to verify pane identities and save immediately.
Use `/pc-orchestrator-recover` for periodic tmux saves and workspace/conversation restoration, loading only the relevant runner reference.
Apply recovery setup to every independently configured tmux server.

## Configuration

The orchestrator skill reads `.epic-config.json` from the repo root — the same file `/pc-epic` reads.
This file is gitignored and must exist before either skill can operate; the orchestrator owns creating it.

**Clone mode** (remote compute or pre-existing clones):
```json
{
  "clone_root": "~/re/myproject",
  "clone_names": ["alpha", "beta", "gamma"],
  "new_clone_names": ["delta", "epsilon", "zeta"],
  "github_repo": "org/repo",
  "orchestrator": "alpha",
  "max_lead_iterations": 8
}
```

**Worktree mode** (local parallel work only):
```json
{
  "clone_root": "~/re/myproject-workers",
  "local_worktrees": true,
  "github_repo": "org/repo",
  "max_lead_iterations": 8
}
```

**Validation**: If `local_worktrees: true` and `clone_names` are both present, **stop and report an error** — they are mutually exclusive.
`clone_names` is meaningless in worktree mode because slots are created on demand and named after the issue.

Fields:
- **clone_root**: Parent directory containing all clones or worktrees.
  Also where the shared `.spawn-prompts/` intent directory, `.preserved/`, and any unfiled `ISSUE-*.md` drafts live.
- **clone_names**: (clone mode only) Existing clone directory names. This is the pool's universe; other directories under `clone_root` (e.g. CI clones) are unmanaged.
- **new_clone_names**: (clone mode only) Names available for creating new clones
- **local_worktrees**: (worktree mode) If `true`, use `git worktree` for local slots named `issue-N`
- **github_repo**: `org/repo` for `gh` commands
- **orchestrator**: (clone mode only) Which clone is the orchestrator (stays on main)
- **max_lead_iterations**: Max issue-lead evaluations before escalating to `needs-human` (default: 8)
- **shared_filesystem**: (optional, default `false`) Set to `true` when the orchestrator and all compute nodes share an NFS filesystem. This describes file visibility; `.paper-craft/compute.md` and its selected platform skill determine transfer and execution procedures, passed to workers by `/pc-orchestrator-spawn`.
  Each machine sets this flag for itself.

## Workflow

### Step 1: Load config, or set it up

```bash
cat .epic-config.json
```

**If the file does not exist**, stop and ask the user:
1. Are you using local git worktrees or separate clones for parallel work?
2. Where should slots live?
   (e.g. `~/re/pz-workers` for worktrees, or `~/re/pz` for clones)
3. (Clone mode only) What are the clone directory names?
   Which is the orchestrator?
4. What is the GitHub repo (`org/repo`)?
5. Are compute nodes on a shared NFS filesystem?
   (sets `shared_filesystem`)

**Note (worktree mode)**: The skill is run from the main repo itself, which acts as the orchestrator.
There is no separate orchestrator clone — `clone_root` is just where worktrees are placed.

Then create `.epic-config.json` with their answers and proceed.

All subsequent steps use values from this config — never hardcode paths or clone names.

**Self-register for completion pushes**: resolve `CLONE_ROOT` and write this session's own `ListAgents` name (the "This session is ..." row) as the sole line of `$CLONE_ROOT/.orchestrator-session`.

**Read every tracked subdirectory `CLAUDE.md` or `AGENTS.md` in the project repo** — only the root one is auto-loaded, and the orchestrator reads artifacts by path from the root. Enumerate with `git ls-files | /usr/bin/grep -E '(CLAUDE|AGENTS)\.md$'`, not `find`.

### Step 2: Pull main

```bash
git pull --ff-only origin main
```

If this fails, report the problem and keep read-only observations labelled stale; placement and cleanup stay blocked until their checks succeed.

### Step 3: One-time unfiled-draft sweep

Cold start only.

`/pc-issue-file` moves a draft to `_ignore/` the moment it successfully files it, so anything still sitting loose as `ISSUE-*.md` directly in a clone root **is** unfiled (an `update` reuses the file in place, so a draft mid-revision on an existing issue is expected here too).

```bash
CONFIG=/absolute/path/to/orchestrator/.epic-config.json
CLONE_ROOT=$(pc workflow root --config "$CONFIG" --path) || exit 2
find "$CLONE_ROOT" -maxdepth 2 -name 'ISSUE-*.md' -not -path '*/_ignore/*'
```

Use the absolute authoritative orchestrator config in every shell invocation; worker snapshots are refused.

**Never auto-delete or auto-file these.** Flag what you found (path, clone, first line) so the user can decide.

The orchestrator clone sits outside `clone_root`, so its own drafts (and the epic's) are not swept, deliberately: the epic owns its draft list and tells the orchestrator, and the orchestrator reports what it is told. Do not widen the `find`.

### Step 4: Scan clones and tmux

No subagent: this is a handful of shell calls, run from the orchestrator clone.

```bash
CONFIG=/absolute/path/to/orchestrator/.epic-config.json
CLONE_ROOT=$(pc workflow root --config "$CONFIG" --path) || exit 2
pc fleet currency --config "$CONFIG" --fetch     # per slot: branch, dirty, relation, head
pc fleet collisions --config "$CONFIG" --fetch   # conservative Git/file overlap; occupancy is separate
tmux list-windows -a -F '#W'
find "$CLONE_ROOT/.spawn-prompts" -maxdepth 1 \( -name '*.md' -o -name 'spawn-*.txt' \)
find "$CLONE_ROOT" -mindepth 2 -maxdepth 2 -name .epic-status.json \
  -exec jq -c --arg f {} '{f: $f, issue, phase, summary, scope, stop_reason, lead_guidance}' {} \;
```

In worktree mode (`local_worktrees: true`), slots are the direct `issue-<N>` directories; both fleet checks support them.

Classify each slot:
- `occupied`: has a tmux window, whatever the agent's status (the user may be doing follow-up work).
- `held`: named in `$CLONE_ROOT/.holds/`. Don't spawn into it.
- `stale`: no visible tmux window, but has `.epic-status.json` or is on a non-main branch; investigate as a recovery candidate, not proof of vacancy.
  Use the reclaim checks in Step 6 and preserve the status file.
- `available`: on the configured base, clean and current, with explicit release by every directory owner and dependent job, no hold and no conflicting pane.
- `unknown`: occupancy could not be established; block reuse and cleanup.

Also note phase migrations (`blocked`/`pr-review`), missing status files, and contradictions.

**Hold a slot** when something outside it still depends on its contents: another live slot reads files inside the clone, or remote jobs run from it. Write the reason to `$CLONE_ROOT/.holds/<slot>` (`mkdir -p "$CLONE_ROOT/.holds" && echo "<reason>" > "$CLONE_ROOT/.holds/<slot>"`), and delete that file when the dependency ends. It lives outside the clone, so reclaim leaves it and a clean-tree check never sees it. While it exists, `pc fleet currency` reports `held: true` and spawn selection must skip it; a launcher cannot override the ownership requirement.

**Clean is not current.** Run `pc fleet currency` from the orchestrator clone before every spawn. Use `--fetch` to refresh base refs in the orchestrator and slots; read the JSON `scope`, per-slot `relation`, `dirty` and `held` fields.
Unmanaged directories are outside the configured denominator, and missing/unreadable slots remain unknown.
Fast-forward a behind slot only after confirming exclusive ownership.

A behind-count does not tell you whether a **finished result** is stale. For that, take the build commit recorded in the artifact and run the tree form: `git diff <build-commit> <tip> -- <source paths>`.

If work will run on remote hosts, also check `/pc-scout` for host occupancy (live builds, warm caches, other sessions' remote jobs) — the annotation step in `/pc-orchestrator-spawn` depends on it.

### Step 5: Build status display

The dashboard is **slot-centric** — the epic's dashboard is issue-centric; this one is about what's occupying the fleet.

| Slot | Classification | Issue | Phase | Notes |
|------|-----------------|-------|-------|-------|
| cedar | occupied (tmux `281-cedar`) | i281 | coding | — |
| pine | occupied (tmux `295-pine`) | i295 | awaiting-results | ~Tue |
| fir | stale (4d) | i589 | needs-human | check if experiment finished |
| hazel | available | — | — | — |

**Pending spawn intent**: list any `.spawn-prompts/` files found in Step 4 (either naming pattern), with the available slots that could run them.

**EPIC distribution**: count EPIC-owned live slots by their `EPIC:` header and list standalone Issue slots separately. Show each EPIC's active/paused state, user priority, eligible queue and resource blockers alongside its slots. Work with unresolved repository or Issue ownership needs intake reconciliation before dispatch.

```
EPIC #369: 5 slots    EPIC #402: 2 slots    unresolved legacy owner: 1 slot
```

**Negative list**: surface decisions already taken *against* an action, with reasons — sequencing already applied, an issue already stood down for a reason that would otherwise look resolved.
This is the one category of fleet fact nobody can re-derive from `git`/`tmux`/`gh`.
Read `.epic-decisions.md` for prior entries and append any new one in the same step you surface it.

**Not everything you know is a fleet fact.** Slot occupancy, host load, build state, file collisions, who landed what: fleet facts. A synthesis across arms, a prediction about what an arm will find, or a mechanism one arm inferred that another is independently testing: **never** goes in a prompt, a fleet-facts block, or a nudge. The epic decides what is embargoed; the orchestrator is the delivery path.

### Preflight, indexed by action

Check this by what you are about to **do**:

| about to… | check |
|---|---|
| **spawn** | `pc fleet currency` and `pc fleet collisions` (below); confirm the issue body has not changed since its brief was written; ask the epic what moves its EPIC's top line (Step 6) |
| **file an issue** | does a success criterion name a denominator, a population, or "a default run" without naming the dispatch path? |
| **deliver a correction to a worker** | append it to that slot's `.epic-worklog.md` first |
| **reclaim a slot** | `pc fleet reclaim-check` and all Step 6 gates; unknown means stop |
| **report a number you did not compute** | re-derive it, or relay the basis — *"it reports X"*, not *"X"* |
| **close or reopen an issue** | verify the criterion against `main`, not against the PR that claims it |
| **land a PR** | `/pc-pr-land`, never a hand-rolled `gh pr merge`. Never send a worker a runnable `gh pr merge` recipe either — it bypasses the skill's preservation and cleanup. Say *"`/pc-pr-land`"* |
| **request human EPIC closure confirmation** | accepted original objective and exact delivery versions remain current; follow the managed lifecycle |
| **cite an artifact by path** | preserve it outside a pooled slot before citing |

For a managed Run, dispatch automatic guarded landing through `/pc-pr-land` after accepted exact-head quality and applicable EPIC confirmation. Human confirmation applies to final EPIC closure and explicit Migration Ledger gates. Legacy workflows use their recorded approval policy.

#### Preserving an artifact you will cite

Before a path appears in anything durable, copy it to `$CLONE_ROOT/.preserved/<slug>/` with a `README.md`: the binary and its commit, the host, the argv per arm, and what the numbers do **not** establish. Check copies with `ls -la` (dotfiles). Never overwrite a larger preserved artifact with a smaller live one — keep both.
A README is a claim about what the data means: when a defect lands, `grep -rl` the preserved directories for artifacts produced before it and rewrite affected labels, leading with the current rule.

### Run `pc fleet collisions` before every spawn

```bash
pc fleet collisions --config /absolute/path/to/orchestrator/.epic-config.json --fetch   # exit 0 = clear, 1 = found, 2 = could not check
```

Both checks use the authoritative config and return JSON; read `scope` and the exit code directly, without a pipeline.
Exit 2 means unknown, never clear; an unknown slot cannot disappear behind a collision observed elsewhere.
The collision check covers every configured slot's committed, staged, unstaged and untracked paths, plus overlap with changes landed on base since the fork.
It does not classify missing/stale sessions: combine it with tmux, status files and the selected runner's occupancy evidence.

A collision naming N clones on one file means N-choose-2 pairs to trial-merge; derive the pairs from the report. When you hand a conflict to whoever resolves it, say what differs between the sides, not only that they conflict.

### Editing fleet tooling

Installed skill directories and the `pc` launcher may be symlinks into a live `paper-craft` checkout; resolve their actual targets before editing. **Any edit, `pull`, `checkout`, `rebase`, or `stash` in that worktree changes every live session's instructions immediately, with no event.** The root-level doctrine files are loaded by path from the same tree.
- Do fleet-tool work in a separate clone of `paper-craft`, and treat operations in the primary one as fleet-wide.
- Before committing in a clone another session can reach, run `git diff` (whose hunks), not just `git diff --stat` (which files). Don't leave edits staged in a clone you don't own.
- Run any long-lived shell script from an immutable copy (`cp watch.sh /tmp/watch.$$.sh && bash /tmp/watch.$$.sh`): bash reads scripts incrementally, so an in-place edit or a `git checkout` changes what a running script executes.

### Scheduled load no slot owns

Before spawning, and before telling a slot to run a full suite:

```bash
systemctl --user list-timers --all   # Linux/systemd hosts only; inspect the actual scheduler elsewhere
uptime
```

Use `list-timers` (it shows LAST and NEXT), not `is-active` on the service. On `matsengrp/phyz` the unit is `phyz-nightly-test.timer`: it fires 02:30–02:45 (`RandomizedDelaySec=15min`, re-randomized, so quote the window, not the NEXT timestamp) and runs the ~90-minute ReleaseSafe suite on `pax`. Tell affected slots that a build killed in that window is contention, not a defect in their branch.

### Step 6: Propose next action

First, do housekeeping automatically (no need to ask).

**Coordinate landing and reclaim** through [Checkout ownership and landing phases](../lib/workflow.md#checkout-ownership-and-landing-phases).
Verify the current evidence and release before dispatching each role:
- Approved live head → landing agent runs `/pc-pr-land` merge phase.
- Landing blocker → verify landing release, then resume the worker for remediation.
- Verified merge → resume the worker for final `/pc-issue-lead` evaluation and records.
- Final records complete and worker released → landing agent runs preservation/cleanup.
- Missing records, unknown occupancy, failed preservation or blocked reclaim → retain
  resources and report cleanup pending. A merged PR never makes its slot available.

The orchestrator verifies recorded outcomes and schedules the next role; independent
completion judgment stays with issue-lead. Inspect the landing skill for preservation
and reclaim prerequisites rather than duplicating its cleanup procedure here.

**A loop is live** only when its runner confirms the recorded session is running.
For Claude Code with Ralph, read [the runtime recovery checks](claude-code/recovery.md#ralph-liveness) before declaring its loop live.

*Worktree mode* has the same ownership, terminal and preservation gates; use `pc workflow preserve` before any separately authorized non-forced Git worktree removal.
A refusal leaves the worktree in place for investigation.

If a worklog seems lost:
- Before concluding a worklog is lost, look in the wrong place too: `<clone_root>/<clone>/.preserved/`.
- When the runner supplies a transcript, attempt reconstruction from it and label the result.
  For Claude Code, read [the transcript reconstruction procedure](claude-code/recovery.md#lost-worklog-reconstruction).

**After reclaiming**, spawn pending intent:

> "Pending intent: `i302` (retry logic) and `i315` (scoring refactor), 2 clones available. Spawning via `/pc-orchestrator-spawn`."

Keep it at that altitude: which intent is pending, which slots are free, any ordering constraint from the epic's Step 4b. If the user asks "why this one?", relay the owning EPIC's reasoning with attribution.

Run `/pc-orchestrator-spawn` for checked tmux placement and the selected runner's supported invocation; retain its preflight and startup checks. Scout, place, spawn, and report after — the proposal is a report, not a gate.
Deciding *which other* open issues should be spawned isn't this skill's call — that's `/pc-epic`.

- **Spawn ready, in-scope, unblocked briefs freely while capacity exists.** The gate is topic and objective, not count.
- **When a slot completes, re-assess and spawn in the same step** — verified cleanup released a slot, or a brief appeared is the trigger.
- Match worker count to the shape of the work: one issue whose result informs the others → spawn it alone; N independent ready issues → spawn N.
- **Before a spawn, and on every event that frees a slot, ask the epic: "what is the next thing that moves this EPIC's top line, and is this it?"** A brief's readiness was established when it was written. The epic answers; a stated hold is a complete answer.

If a live worker's scope needs correcting before its next stopping point: the epic decides whether it's durable and drafts the line, and the orchestrator delivers it (see "Correcting a live worker").

### Step 7: Observe slots and arm the next reconciliation

After the dashboard is built and spawns are confirmed, arrange observation of every slot's `.epic-status.json` and PR state.
The portable CLI does not yet supply `pc fleet watch`; do not report a monitor as started merely because this step was reached.
Until a supported monitor exists, re-run the scan and read status/worklog files at each reconciliation, recording observed transitions in `.epic-notifications.log` as timestamped JSONL.
If using an available external watcher, keep exactly one per orchestrator and track its returned process/pane identity; stop only that identity, not a process-name pattern.
For NFS/sshfs use polling rather than relying on local filesystem events.
The log survives watcher restarts and orchestrator compaction.

A supported watcher must emit one event per phase transition (default filter: `needs-human`, `completed`, `awaiting-results`, `quality-gate`). A transition into a phase that is not one of the seven legal values always emits, so any phase filter must list legal phases.

It is not liveness detection. It is silent when:
- a slot never transitions — only the staleness checks in the spec below catch that;
- a slot was already in its phase when the watcher first read it. Restarting the watcher re-baselines the whole fleet, so re-run `/pc-orchestrator` after a restart; a clone added to `clone_names` after launch is never enumerated;
- **a slot lands**: file-only observation may miss the final phase or a later removal.
  Independently check `gh pr list --state merged`; observing PR state is required even when a status file is absent.

If the harness offers an authorized Monitor capability, tail the event log and separately observe merged PRs, respecting its actual timeout limit and re-arming on expiry.
Otherwise use the shared workflow's native wake-up contract for reconciliation. Each wake
checks pending intent as well as slot/PR transitions, then runs Steps 4–6 as needed.
Record and send each brief's handling receipt as specified there; preserve deferred intent.

When a worker phase changes or its PR lands, react immediately: read current status and PR
evidence, record the transition, refresh `$CLONE_ROOT/.orchestrator-session`, then notify the
owning and relevant affected EPICs through keyed registrations with the issue, phase/PR
outcome and evidence path. Include `quality-gate`
and `awaiting-results`, not just terminal phases. Missing messaging leaves the durable
observation for the EPIC's next reconciliation; keep independent work moving.

Finish other tool work, then arm/reuse the role's single native wake-up and yield as the
shared contract requires. Report the verified observation mechanism and identity, or
`manual continuation required`; unchanged polling needs no user-facing status report.

**When several slots go quiet at once, ask what they share before investigating any one** — a host, a token or rate budget, a mount, a freshly landed commit. Never read push silence or a quiet log as "still running".

#### Process checks

When inspecting slot occupancy or liveness, read [the process inspection procedure](tmux/process-checks.md). Match recorded identities and working directories; never search process arguments for a worker name or task string.

## .epic-status.json specification

```json
{
  "issue": 281,
  "title": "Short title",
  "phase": "exploring | coding | testing | awaiting-results | quality-gate | needs-human | completed",
  "summary": "Human-readable one-liner",
  "updated_at": "2026-03-03T14:30:00Z",
  "blockers": [],
  "remote_run": null,
  "quality": null,
  "scope": "One-line restatement of issue goal from lead",
  "stop_reason": "phase-complete | needs-instrumentation | needs-deeper-investigation | awaiting-results | run-production | pr-ready | quality-gate | mechanical-blocker | scope-drift | needs-human | awaiting-human-merge | completed",
  "lead_guidance": "What the worker should do next",
  "lead_notes": [],
  "completed_at": null,
  "awaiting": null
}
```

- Must be `.gitignored`, along with `.epic-worklog.md`, `.epic-decisions.md`, and `.epic-notifications.log`. Any file this skill writes to the **orchestrator cwd** needs a `.gitignore` entry in the consuming repo; files at `$CLONE_ROOT` (`.epic-sessions/`, `.orchestrator-session`, `.spawn-prompts/`, `.preserved/`) do not, since that path is outside every clone's git tree.
- **Staleness checks:**
  - *No tmux window, status file older than 30 minutes* → suspected abandoned slot, a recovery candidate (Step 6); occupancy stays unknown until verified.
  - *Window blocked on a permission modal* → frozen and potentially unable to receive messages.
    Sweep on every reconciliation; for Claude Code, read [the permission-dialog procedure](claude-code/dialogs.md). Inspect other runners through their actual dialog interface before acting.
  - For `awaiting-results`, read the saved schedule under
    [Adaptive checks for long tasks](../pc-issue-work/SKILL.md#adaptive-checks-for-long-tasks).
    Before a valid `next_check_at`, old mtimes alone indicate planned waiting;
    reconcile overdue checks or known failures without independently polling the job.
  - *Window still open, status file older than ~45 minutes outside planned waiting* → possibly **stalled**. Surface it in Step 5's dashboard for a human; never clean it up.
  - Check file **mtimes** of both `.epic-status.json` and `.epic-worklog.md`, not the `updated_at` field, which workers sometimes hand-type.
  - The `phase` field is not evidence that work is done: check `gh pr view`.
  - A pane's scrollback is current; its statusline is re-rendered on Claude Code's own schedule and can be stale. Don't use it to verify anything.
- `remote_run` optional — set when work dispatched to remote server
- `quality` optional — set during `quality-gate` phase:
  ```json
  {"pr_check": "pass|fail", "pr_review": "pass|fail", "iterations": 2}
  ```
Workers loop `/pc-pr-check` and `/pc-pr-review` until both pass clean.
- `scope` — set by the issue lead each iteration (one-line restatement of the issue goal)
- `stop_reason` — categorized reason from the lead's decision framework
- `lead_guidance` — actionable instruction for the worker's next iteration
- `lead_notes` — append-only log of lead evaluations (max 8 before escalation)
- `completed_at` — ISO 8601 timestamp set by the lead after it finishes the terminal `completed` ceremony (files any legitimate follow-ups, posts the final PR comment).
  The terminal PR comment is the idempotency record; reconcile it before repeating the ceremony.
- `awaiting` — set during `awaiting-results` phase:
  ```json
  {
    "description": "What we're waiting for",
    "check_cmd": "command that exits 0 when done",
    "check_files": ["paths whose existence means done"],
    "started_at": "ISO 8601",
    "timeout_hours": 12,
    "estimated_completion_at": null,
    "next_check_at": "ISO 8601 UTC",
    "check_basis": "Latest observation and reason for the next check time"
  }
  ```

`estimated_completion_at` is a forecast (null when unknown); `next_check_at` is
an absolute UTC appointment computed from the current clock. `check_basis` explains
the latest adjustment. `started_at` and `timeout_hours` retain their total-wait
meaning; they do not measure SLURM execution time. Keep job identity, queue/start
observations and detailed evidence in the worklog. Workers and leads use
[Adaptive checks for long tasks](../pc-issue-work/SKILL.md#adaptive-checks-for-long-tasks)
to maintain this schedule. Older files without it need a schedule established on
continuation; their missing fields do not authorize repeated immediate probes.

### Phase migration

Legacy phases from older `.epic-status.json` files:
- `blocked` → treat as `needs-human`
- `pr-review` → treat as `quality-gate`

## Error handling

- **Not in tmux**: Warn — tmux required for spawning
- **gh not authenticated**: Suggest `gh auth login`

## Layout config (issue #149)

`.epic-config.json`'s `clone_root` / `clone_names` / `local_worktrees` keep working untouched.
Use the authoritative `.epic-config.json` for clone/worktree layout; this CLI does not implement the upstream global `layout:` launcher.
EPIC orchestration still reads `.epic-config.json` for now.

For managed execution, public runtime `waitAttempt` records bounded wait timeout separately from execution, `cancelAttempt` records capability and verified receipt or failure, and `reconcileAttempt` verifies terminal evidence without releasing role or checkout ownership. Codex cancellation is unsupported; keep resources reserved on timeout, failed cancellation or unknown execution. Collect the original attempt before considering a new execution.

## Subject-scoped Run intake

For a requested Issue/EPIC, use `pc workflow orchestrator start <issue> --provider <codex|agy|claude> --config <authoritative-config>`. Inspect with `pc workflow orchestrator status --config <authoritative-config>`. Intake is complete when the registry links the requested subject, fixed provider, immutable brief and acknowledged Orchestrator attempt. A reserved or blocked Run is pending, not a successful startup. Repeated intake reconnects it; never remove reservations to force a replacement. Each Run has its own Orchestrator reservation; unrelated Runs may progress concurrently. Shared physical checkout ownership remains exclusive. Existing `workflow orchestrator` operations remain available for legacy callers; missing legacy Run identity stays unknown. The shared launch/evidence contract is implemented by Managed Runtime; role procedures must not infer acceptance from tmux presence.

For stage dispatch, durable reporting and acceptance, follow [the shared managed lifecycle](managed-lifecycle.md). A reported result is pending until independently accepted; only accepted prerequisites permit dependent dispatch.

### Lightweight worker dispatch

After intake, use `pc worker spawn <issue-id> <role> --run <run-id>`.
Use `--runner <command>` only to override the Run's runner. `--root <directory>`
and `--fleet <id>` select the same runtime location used at intake. The default
runner receives the immutable `BRIEF.md` path as its final argument; use a wrapper
command when a runner expects prompt contents instead. Dispatch allocates a Git
worktree and launches the command in tmux. Each issue/role holds a directory lock;
never remove an occupied lock to force another launch. Read `dispatch.json` for
worktree, pane, and receipt paths. Workers publish `RECEIPT.md` atomically with
outcome, summary, tested revision, and validation evidence. Launch failures retain
state and locks for inspection rather than claiming the slot is free.

Wait with `pc worker wait <dispatch-id> [--root <directory>] [--fleet <id>]`.
It prints the published receipt to stdout. If the runner exits or its tmux pane
terminates without a receipt, it publishes an immutable `outcome: crashed`
receipt and exits nonzero. An unavailable liveness check reports an error and
retains the dispatch; it does not prove a crash. Waiting again returns the
existing receipt without replacing it. Review the outcome before accepting work.

### Recover an interrupted session

Run `pc worker status [run-id]` (or `pc status [run-id]`) with the intake
`--root` and `--fleet` to inspect attempts and full unhandled receipts.
Inspection never consumes receipts. After reviewing and acting on one, use
`pc worker status <run-id> --ack <dispatch-id>` to record consumption.
An `in-flight` attempt has no completion evidence yet; use `pc worker wait`
to establish liveness and synthesize crash evidence for terminated workers.
