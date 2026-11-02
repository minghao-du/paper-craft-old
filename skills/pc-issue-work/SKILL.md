---
name: pc-issue-work
description: Read a GitHub issue and implement the work described in it
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Task
---

# /pc-issue-work

Read a GitHub issue and do the work described in it.

## Usage

```
/pc-issue-work 123
```

The argument `$ARGUMENTS` is the issue number.

## Project boundary

Keep code changes within the project targeted by the issue, including its task worktree. Resolve symlinks before checking this boundary; external dependencies and other projects remain outside it.

Unless the user has explicitly requested the specific external changes, **STOP the workflow before modifying code outside this boundary**. Explain which external files need changing, why, and the proposed changes; ask the user for confirmation and wait for explicit authorization before resuming. An issue or review requesting external changes does not substitute for user authorization.

## Workflow

### Step 1: Read the issue

```bash
gh issue view $ARGUMENTS
gh issue view $ARGUMENTS --comments
```

Read both the issue body and any comments for full context.

### Step 2: Input verification

Verify that all external prerequisite dependencies and requirements are satisfied before branching or writing any code.

#### Prerequisite input verification

Inspect the issue requirements for required external inputs — trained models, weights, data tables, or external files.
Read the project's `.paper-craft/compute.md` when present to resolve where each input will be consumed and its expected path; otherwise use the issue's environment and paths.
Verify that each prerequisite file exists and is readable in that environment, using the configured platform skill for remote checks.
Inputs verified there satisfy this prerequisite without additional authorization or a local copy.

When any prerequisite input is missing, inaccessible, or has an unresolved environment or path:
- **Halt immediately** before writing any code, modifying files, or creating a feature branch.
- Never guess missing values, fabricate mock data, or launch unapproved long-running recalculations.
- Emit the standardized 3-part interactive halt notification:

```markdown
Prerequisite input verification is blocked; the task cannot proceed:
- Input file, consuming environment, expected path, and blocker: `<file, environment, path, missing / inaccessible / unresolved mapping>`
- Dependent operation: `<evaluation script or verification step that requires this file>`
- Action needed: `<provide the file, restore access, or clarify the environment and path; describe the proposed substitute or regeneration plan and request authorization if needed>`
```

- Wait for explicit user direction before proceeding.

#### Clarifying questions

Raise any requirements ambiguities or architectural questions now.
If anything is unclear, **STOP and ask clarifying questions before writing any code**.

Completion criterion: every prerequisite input has passed the verification above (or the user has explicitly resolved the blocker with a substitute), and all requirements are clear.

### Step 3: Create a feature branch

If another live session works in this checkout (see [Checkout ownership and landing phases](../pc-orchestrator/managed-lifecycle.md)), don't move its `HEAD`: branch in a worktree outside it and do all remaining steps there. If you were started in this checkout to own it and the other process is exiting (a session whose window was just killed), wait until it is gone, then take the checkout path.

```bash
git fetch origin
git worktree add <path> -b $ARGUMENTS-<short-description> origin/main
```

Otherwise:

```bash
git pull origin main
git checkout -b $ARGUMENTS-<short-description>
```

Use the issue number as a branch prefix for traceability.

### Step 4: Implement

- Use code from the issue as a starting point when provided
- Follow CLAUDE.md guidelines for the project
- If you start deviating significantly from the issue, **STOP and discuss**
- When a Snakemake run fails, follow [incremental recovery](../pc-pipeline-snakemake/SKILL.md#incremental-recovery) before rerunning: reuse valid completed outputs and execute only the affected dependency chain.
- Continue until the issue is done and all tests pass

#### Adaptive checks for long tasks

Apply this protocol to local and remote computation, training, experiments and long tests.

1. Launch through the configured platform/runtime and retain the exact job ID or PID,
   execution environment, logs and completion probe. Use the captured identity: a
   command-pattern search can match the worker's own session. Verify the probe returns
   nonzero while unfinished and zero only on verified success; preserve pipeline/SSH
   exit status rather than masking it with a successful print command. Remote output
   paths are checked in their consuming environment, not assumed local.
2. Estimate completion from comparable runs, input size or measured progress. Record
   the estimate, its basis and the next check time before waiting. For hours-long work,
   start with checks tens of minutes apart; shorten near expected completion. With no
   reliable estimate, start at five minutes and double unchanged intervals up to thirty
   minutes. Adjust these defaults to observed progress, deadlines and platform policy.
3. On continuation or context recovery, read the saved schedule first. Query the task
   when the next check is due or a completion/failure event arrives; an unrelated wake
   preserves the schedule. At each check, distinguish normal waiting, probe failure,
   stalled work and task failure. Progress updates the estimate; unchanged healthy work
   backs off; suspected stalls prompt diagnosis. Three consecutive probe errors warrant
   a mechanical-blocker/lead evaluation; normal unfinished results do not count.
   An exceeded estimate prompts diagnosis and a revised schedule, never cancellation
   or resubmission by itself. Verify exit status and required outputs before continuing.
4. For **SLURM**, track submission, queue wait and actual execution separately, using
   the exact job identity and the selected platform's status/accounting procedures:
   - **PENDING:** base checks on the pending reason and scheduler start estimate when
     available; otherwise use the unknown-estimate backoff above. Start predictions
     can move. Ordinary resource/priority waiting remains healthy; holds, failed
     dependencies and other actionable reasons need diagnosis.
   - **RUNNING:** estimate completion from actual start and progress, excluding queue
     wait from expected execution duration. Requeue returns to queue scheduling;
     suspension or restart requires revising the estimate from the observed state.
   - **Terminal or missing from queue:** inspect accounting/exit status and outputs.
     Queue disappearance alone proves neither success nor failure; delayed accounting
     remains unconfirmed. Distinguish terminal failure from automatic requeue before
     recovery. A requested wall-time limit is a limit, not a duration forecast.
5. Persist each check's result, estimate, next check time and rationale in
   `.epic-worklog.md` (or the standalone task's durable worklog). In fleet mode set
   `phase: awaiting-results` and populate `awaiting` using the
   [status fields](../pc-orchestrator/managed-lifecycle.md). Keep `started_at` as
   the wait's original timestamp; `timeout_hours` measures that total wait, including
   queue time; keep this overall waiting bound separate from runtime estimates.
   Diagnose expiry; ordinary queueing does not consume the expected execution duration.
6. Keep waiting responsive through completion events or a supported scheduled wake-up;
   follow [managed recovery](../pc-orchestrator/managed-lifecycle.md) when scheduling a worker
   continuation. Reuse one verified timer for the saved next check. Without that support,
   preserve the schedule and report `manual continuation required` with the resume command.
   Repeated empty continuation turns are not a waiting mechanism.

Completion criterion: the task has verified results or a diagnosed blocker, or its
durable next check and verified wake-up/manual continuation are recorded.

### Step 4b: Selective staging and pre-commit cached diff audit

Stage changes explicitly per-file to maintain zero transient artifacts in git history.

#### Selective staging protocol

Stage modified or new files individually using per-file commands:

```bash
git add <file>
```

Target only source code, configuration files, and documentation.
Do not use indiscriminate staging commands (`git add .`, `git add -A`, or `git commit -a`).
Stage each intended file explicitly by name instead.

#### Pre-commit cached diff audit

Before creating any commit, audit the staged cache to intercept transient cruft:

```bash
git diff --cached --name-only
```

Inspect all staged paths against forbidden transient patterns (`output/*`, `results/*`, `*.joblib`, `*.pt`, `*.tsv`, `*.csv`, `*.png`).
When any staged path matches a forbidden pattern, immediately unstage it:

```bash
git reset HEAD <file>
```

Keep reusable Snakemake data artifacts and `.snakemake/` metadata at their existing paths and gitignored so subsequent runs can resume. For other un-staged cruft, delete it, move it to `_ignore/`, or add it to `.gitignore`.
Commit only when `git diff --cached --name-only` contains exclusively legitimate source, configuration, and documentation files.

Completion criterion: every file in `git diff --cached --name-only` is verified to be legitimate source or documentation, zero transient cruft paths remain staged, and the commit clean gate passes.

### Step 5: Pre-merge check

```bash
ls PRE-MERGE-CHECKLIST.md 2>/dev/null
```

- **If `PRE-MERGE-CHECKLIST.md` exists**: read it **line by line** and verify every numbered item.
  For each item, either confirm it passes or explicitly state why it is not applicable (e.g. "item 4: parity — skipped, no alignment code changed").
  Do not rely on memory — re-read the file fresh each time.
  Issue-lead approval does **not** substitute for this: the lead evaluates issue scope; the checklist catches cross-cutting concerns (citations, formatting, README sync) that the issue body won't mention.
- **Otherwise**: run `/pc-pr-check` as the baseline quality gate.

### Step 6: Fix review findings

After the pre-merge check:

- **If the review found concrete issues** (stale comments, dead code, missing docs, etc.), fix them immediately and re-run affected checks.
- **If the review raised real design questions** (e.g., "should this be architected differently?"), **STOP and present the question to the user** before proceeding.

### Step 7: Create the PR

```bash
gh pr create --title "<concise title>" --body "<body>"
```

- Include `Closes #$ARGUMENTS` in the body to auto-close the issue on merge
- Do NOT manually close the issue — GitHub handles it when the PR merges

**Report findings in the PR body.**
If the work involved experiments or benchmarks, include key results (tables, numbers, conclusions) directly in the PR body.
Don't just point at branch files — the PR body is the permanent record.
When transient local outputs or benchmarks were produced, record in the PR body where the local outputs were placed (such as a preserved path or ephemeral directory) alongside their reproduction command, environment specifications, and reproduction duration or cost.

### Step 8: Report to the orchestrator

Before execution, verify the owning Run and immutable task brief; retain parent constraints when the Issue belongs to an EPIC.
After creating the PR, report the full head SHA and current completion/check evidence to the Orchestrator for exact-head EPIC confirmation and automatic guarded PR-Land merge. Retain status and worklog; workers release ownership only through the landing handoff. Independent follow-up work uses `/pc-orchestrator-handoff`.
Provide a concise summary that highlights things the user needs to **judge**:

- **Underlying bugs or tech debt** discovered during the work (even if worked around)
- **Structural concerns** — places where the fix is a workaround rather than a root-cause fix
- **Performance implications** of the approach taken

Record any deferred work in the PR body `DEFERRED` section (one line per item, with rationale per the DEFERRAL RULE).
In EPIC mode the issue-lead will scan these at terminal `completed` and file the legitimate ones as follow-up issues; standalone users can review the list and run `/pc-issue-next` for the ones worth filing.
Either way, do not list follow-ups in this summary — the PR body is the source of truth.

### Step 9: Landing handoff and final records

Follow [Checkout ownership and landing phases](../pc-orchestrator/managed-lifecycle.md)
when the orchestrator requests release. Stop edits, record explicit release and wait for
ownership to return before remediation or final records. After verified merge, invoke
`/pc-issue-lead` independently at the retained checkout for its full terminal protocol.
Record the final assessment, follow-up outcomes and terminal comment path in the worklog;
notify the orchestrator and release again for preservation/cleanup. Missing or failed
records remain pending and keep the checkout intact.

## Managed completion

When dispatched inside a Run, publish correlated results through [the shared managed lifecycle](../pc-orchestrator/managed-lifecycle.md). Include immutable evidence and input revision; wait for acceptance or explicit correction feedback. Do not dispatch the next top-level role yourself.

For child-only intake, retain parent constraints and verified open dependencies. Never start siblings or parent finalization. Follow the [shared overlap contract](../pc-orchestrator/managed-lifecycle.md#child-only-intake-and-overlapping-runs): reconnect to an existing execution owner and let consuming EPICs independently accept delivered evidence.

## CLI-dispatched implementation and final records

For an assigned stage, follow the [shared CLI lifecycle](../pc-orchestrator/managed-lifecycle.md#cli-stage-assignments).
Keep the assignment's immutable requirements, checkout and accepted EPIC plan bound
to your work. Publish implementation evidence at the current evaluated revision.
After verified merge, the Orchestrator dispatches `final-records` separately: retain
an attributed assessment in `.epic-status.json` and final work record in
`.epic-worklog.md`. Release execution occupancy for independently verified preservation
and cleanup; do not remove your checkout. Completion means accepted final records,
with cleanup reported separately by PR-Land.
