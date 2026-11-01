---
name: pc-epic
description: EPIC topic strategy — GitHub issue/PR triage, EPIC body composition, dependency-direction and collision detection between issues
---

# /pc-epic

Read [the shared runtime and workflow contract](../lib/workflow.md) before using helper commands or runtime-specific tools.
Tmux is shared infrastructure; Claude-specific tool names and examples apply only when that runner provides them, with file-based delivery otherwise.

Topic-scoped strategy for EPIC-based multi-clone orchestration: program state, issue/PR triage, EPIC body composition, and the semantic judgment calls a topic-agnostic fleet scanner structurally cannot make (a model-semantics change landing mid-sweep, a deletion in one issue that a sibling issue's patch depends on).
Fleet mechanics — clone/tmux inventory, staleness checks, spawning, pruning of clone-side artifacts — belong to `/pc-orchestrator`.
The two roles coordinate over `SendMessage` and a shared `.spawn-prompts/` directory (see Step 6); they do not need to be the same session, though they may run side-by-side in one tmux host.

Use this at **session start** to establish topic context.
Keep this role active through the shared workflow's **Active role handoff and wake-up** contract;
finish every coordination turn by arming its native wake-up, or report manual continuation required.
For fleet state (which clones are free, what's running where, tmux/host occupancy), ask `/pc-orchestrator` instead — this skill does not scan clones or tmux itself.
It does *consume* a orchestrator-supplied occupancy table when the Step 2 handshake succeeds: Step 2 uses it to scope Group A's re-verification, and Step 6 uses it as a readiness filter.


## Managed automatic planning

Enter through [Orchestrator intake](../pc-orchestrator/SKILL.md#intake) with type `EPIC`, its number, provider and authoritative config.
After the intake checks, the owning Orchestrator creates or reconnects the Managed Run:

```sh
pc workflow orchestrator start <number> --type epic --provider <provider> --config /path/to/project/.epic-config.json
```

Follow [EPIC coordination](../pc-orchestrator/epic-workflow.md) for planning, child readiness and integrated acceptance.
Return the requested JSON plan with original goal, constraints, task scopes, Worker briefs, dependencies and readiness.
Keep existing tasks and delivery evidence in revised plans.
The owning Orchestrator schedules child delivery and returns attributed results for your next professional assessment.
A delivered plan is stage delivery, not acceptance or permission to close the EPIC.

## One EPIC at a time

This skill is scoped to exactly one EPIC per session. `/pc-epic 369` means EPIC #369 and nothing else. If the invocation does not name an EPIC number, **ask which one before doing anything else** — do not infer it from the repo, the most recently updated EPIC, or what the fleet is running.

- **A file collision is not EPIC membership.** Do not adopt an out-of-scope issue because it collides with an in-scope one; report the collision to the orchestrator and leave it.
- **Interesting is not in-scope.** A real defect belonging to another programme gets filed and parked, not pursued.
- If work already in flight turns out to be outside the boundary, say so and hand it back; preserving WIP to a branch beats both discarding it and finishing it out of scope.

## Role

The epic session does strategy, not fleet ops:
- Reads and interprets EPIC/issue/PR content on GitHub
- Composes and prunes EPIC bodies
- Flags dependency-direction conflicts and file-overlap collisions between open issues, before either gets spawned — by the time branches exist the cost of a collision is already sunk
- Decides an issue is ready and drafts the spawn brief, but does not spawn it — that goes to `/pc-orchestrator` as intent, not action
- Returns attributed planning, findings and substantive questions through the orchestrator,
  the primary user conversation. Preserve supporting evidence and professional judgment.
- Never writes code, creates branches, or spawns tmux windows for numbered issues itself

## Conventions

### Issue/PR naming
- `i281` = issue #281, `p275` = PR #275.
  Never bare `#N`.
- First mention in bullet lists: full URL inline.

Tmux window naming, reboot recovery, and the live-worker `SendMessage` mechanics are `/pc-orchestrator` concerns — see that skill's Conventions section.

### Message economy

Cross-session messages are nudges, not transcripts: lead with the decision or the ask, give the reasoning the receiver cannot reconstruct, and cite the EPIC body, the issue, or `.epic-decisions.md` for the rest instead of restating it. This never licenses a bare pointer where Step 7 requires substance: a drafted worker correction states the change itself, not "re-read the EPIC body." Send raw measurements rather than conclusions, and keep corrections to one line in either direction.

### The epic's own claims

- **Before writing that the EPIC's question is answered**, quote the EPIC's own question and state which measured quantity closes it, and by how much. If it is a fraction of one stage at one fixture, say that.
- **Run a skeptic subagent on your own artifacts**: before claiming a question answered, and before filing an issue you wrote yourself.
- **Before repeating who found something**, check the attribution against the log or the PR; it is the part of a claim nobody tests.
- **Before escalating a question to the user, ask whether its answers lead to different actions.** If they do not, do not escalate. If the options share a first step within the authorized scope, take that step now and ask only about the point where the actions diverge; keep work that depends on the answer pending.
  Return a specific question with evidence to the orchestrator, park only the dependent item, and keep independent planning moving.

## Configuration

Reads `.epic-config.json` from the repo root — the same file `/pc-orchestrator` uses, so the two roles never disagree about where things live.
The epic role only needs two fields out of it:
- **github_repo**: `org/repo` for `gh` commands
- **clone_root**: to locate the shared `$CLONE_ROOT/.spawn-prompts/` directory (see below)

**If the file does not exist**, don't create it here — run `/pc-orchestrator` first.
It owns the clone/worktree layout questions (clone mode vs. worktree mode, clone names, shared filesystem) that the rest of the file's fields are about.

## Workflow

### Step 1: Load config

```bash
git pull --ff-only origin main || echo "PULL FAILED — you are on a stale tree; fix this before reading anything"
cat .epic-config.json
```

Check that the pull succeeded and never suppress its stderr. In a pooled clone it commonly fails because an untracked leftover collides with a path a later PR landed as tracked; move the blocker aside (it may be unpreserved work), pull again, and confirm `git rev-list --count HEAD..origin/main` is `0`.
**Re-run the pull at the top of every fresh scan cycle**, not just at cold start: every `gh` read is correct regardless of the tree's age, so nothing else forces it, and a stale file written back is how an EPIC body or a skill acquires a reverted diff. `git fetch` alone does not update the working tree.

Read every **tracked** subdirectory `CLAUDE.md` or `AGENTS.md` — only the repo-root one is auto-loaded, and this role works from the root:

```sh
git ls-files | /usr/bin/grep -E '(CLAUDE|AGENTS)\.md$'
```

Use `git ls-files`, not `find`: vendored copies and stale nested clones also contain files named `CLAUDE.md`. Before claiming a measured number is new, grep the experiment's own README for it.

**Register this EPIC** using the shared workflow's **Multi-EPIC registration and scheduling** contract. Verify the assigned EPIC and refresh only `$CLONE_ROOT/.epic-sessions/<N>.json`; preserve other EPICs' records. Reconcile its active/paused state, pending findings and orchestrator decisions before planning. Finish with a verified registration or a specific identity/delivery blocker.

### Step 2: Fan out scanners

**Handshake with the orchestrator before dispatching Group A.**

- Resolve `CLONE_ROOT`, read `$CLONE_ROOT/.orchestrator-session` for the orchestrator's self-registered address, and `SendMessage` it a request for its current slot→issue occupancy table (with each slot's **phase**) and its negative list (decisions already taken against an action — see `/pc-orchestrator`'s Step 5).
- **Scope**: Group A may skip its per-item `gh issue view` confirmation only for items on a slot in an in-progress phase (`coding`, `exploring`, `testing`, `awaiting-results`, `quality-gate`). Always confirm `completed`/`needs-human` slots and anything the table doesn't cover — a slot can finish and its issue close before the slot is cleaned up.
- **Fallback**: if `.orchestrator-session` is absent or the send fails, dispatch Group A unscoped. Do not block waiting for a orchestrator that may never exist.
  Missing runtime messaging leaves occupancy unknown and blocks placement, not the independent issue analysis.

This narrows Group A's redundant re-verification, not its judgment: occupancy and dependency reasoning are different questions.

Dispatch the two scanner groups through supported independent agents when available; `Agent`/`general-purpose` is the Claude branch.
For another runner, preserve the same group scopes and checks through tmux/native helpers, or perform the read-only scans sequentially if delegation is unavailable.
Follow the dispatch pattern in `SUBAGENT-SCAN.md` (paper-craft repo root).
Scope the fan-out to **your** EPIC; confirm the number resolves, and do not enumerate the others:

```bash
gh issue view <your-epic-N> --json number,title,updatedAt
```

List every `EPIC in:title` issue only when presenting options to a user who has not named one.

**Group A: one subagent for your EPIC.**
Brief:

> Read EPIC `i<N>` and report its current state.
> Tasks:
> 1. `gh issue view <N> --json title,body,updatedAt`.
> 2. Parse the Status dashboard and Key findings.
>    (Older EPIC bodies may still carry a legacy clone-assignment table from before the fleet/topic split — that's fleet state that shouldn't have been authored here; note it as a `surprise` for cleanup, don't treat it as current truth.)
> 3. For each open item the dashboard lists, run `gh issue view <child-N> --json state,stateReason` to confirm it is still open — **except** items the orchestrator's occupancy table shows holding a slot in an **in-progress** phase (`coding`, `exploring`, `testing`, `awaiting-results`, `quality-gate`). Still confirm for `completed`/`needs-human` slots, and for anything the table doesn't cover.
>
> Return under 400 words:
> - `changes_since_baseline`: completed items, new findings, items newly opened
> - `active_items`: open work with brief status (which clone is running it is `/pc-orchestrator`'s dashboard, not this report)
> - `action_candidates`: items the EPIC marks ready but unassigned
> - `surprises`: contradictions, legacy clone-assignment tables found in the body, `RECOMMEND DEEPER LOOK` flags

**Group B: one recent-activity subagent.**
Brief:

> Report recent issue/PR activity for the epic.
> This is a recency feed, not backlog coverage.
> Tasks:
> 1. `gh issue list --search "sort:updated-desc" --limit 20 --json number,title,state,labels,body`.
> 2. `gh pr list --json number,title,headRefName,state`.
> 3. `gh pr list --search "is:pr is:merged sort:updated-desc" --limit 10 --json number,title,mergedAt`.
> 4. For each open issue, check its `depends_on` field and any blocking context.
>    An issue that depends on an unmerged PR or unfinished experiment is NOT ready — omit silently.
> 5. Verify state with `gh issue view <N> --json state` for any issue you plan to flag — never claim "open" without confirmation.
>
> Return under 400 words:
> - `changes_since_baseline`: PRs merged since last session
> - `active_items`: open PRs with state/CI status
> - `action_candidates`: open issues ready to spawn (unblocked, unassigned, dependencies satisfied), ordered by priority. Restrict these to issues this session's EPIC tracks; list an urgent out-of-EPIC item under `surprises`, never here.
> - `surprises`: closed/merged items the EPICs don't reflect yet, issues with unclear blocker state, `RECOMMEND DEEPER LOOK` flags

**Group B does not cover the backlog.** `--limit 20` reaches back only as far as the last 20 touched issues, a couple of days on an active repo. Coverage is Group A's job plus a periodic audit for issues no EPIC references (see `matsengrp/phyz`#2093); Group B only answers "what moved lately".

**Resolve observable status yourself.** This EPIC supplies internal order and constraints; the orchestrator schedules shared resources under the user's priorities. Return unresolved substantive judgments and proposed priority changes through the orchestrator under the shared scheduling contract.

### Step 3: Reconcile

Compose the reconciliation from the two reports — do not paste subagent prose verbatim.

- Never present an issue as "ready to spawn" or "needs action" without confirming it's still OPEN on GitHub
- Flag anything merged/closed that an EPIC body doesn't reflect yet
- If either group's report has zero `surprises` and zero `changes_since_baseline`, send a follow-up to that subagent with a narrower question before concluding "nothing changed there."

### Step 4a: Dependency-direction detection

**Before writing any gate, dependency, or scope claim into a brief or an EPIC body, read it in the issue's own text** — its Dependencies, Scope, Out-of-scope, and Success criteria sections; for an issue under ~200 lines, read it whole. A scanner's summary of a gate is not the gate. When a needed precondition is out of an issue's scope, file it as its own issue rather than amending the scope.

Run this before proposing any issue as ready to spawn, not after — once a branch exists the cost of a collision is sunk.

1. For every currently open, unassigned (or about-to-be-spawned) issue, read its body against every other such issue's body and ask: can both land as currently written, in either order?
   Or does one delete, rename, or restructure something the other's patch depends on — a dependency-direction conflict that no ordering fixes, because one issue has to change shape?
   (Concrete shape: one issue deletes a function a sibling issue is patching; one issue's test assertion contradicts a value a sibling issue is about to change.)
2. Record findings where a future spawn will see them: a note in the EPIC body's dashboard, and — if either issue is about to be handed off as spawn intent (Step 6) — the warning goes directly into that issue's brief.

**Completion criterion**: every pair of currently-open, about-to-be-spawned issues has been read against each other for dependency direction, not just for whether one references the other's issue number.

### Step 4b: File-overlap collision detection

A distinct analysis from 4a: extract file paths from issue bodies and build an overlap matrix.

1. From every currently open, unassigned (or about-to-be-spawned) issue body, extract mentioned file/module paths — code blocks, a "Files:" section, or explicit paths in prose. A path extracted this way is a candidate, not a location — resolve it before recording it.
2. Build an overlap matrix: any two open issues naming the same file or module are a candidate collision.
3. For each overlap, confirm whether the overlapping regions can coexist or whether one issue's edit invalidates the other's. Clearing a pair in 4a does not clear it here.
4. Record findings the same way as 4a: a dashboard note, and a brief warning for any issue about to be handed off (Step 6).

Resolve paths against the actual repo before recording an overlap or its absence — a filename with no directory component is unresolved, and per-experiment `scripts/` copies share filenames. When naming a file in a brief or message, include the directory.

**Scope:**
- **4b covers filed issues only.** A live worker's branch is usually unpushed and lives in its clone, so report the verdict as "collisions among the filed issues" and hand live-branch intersection to the orchestrator, which runs `pc fleet collisions`.
- **Once a branch exists, its diff supersedes the issue body:** `git diff --name-only origin/main...<branch>`.
- **Shared symbols:** an issue that edits a shared definition (a constant, a params list, a fixture path) has a footprint equal to its consumer set. Run `git grep -ln <SYMBOL> -- <subtree>`, report code hits and prose hits separately, with the commit, and tell the worker to re-run it at branch time. The grep does not see files that import the defining module without naming the symbol.
- **Meaning collisions have no detector.** For any issue that regenerates or replaces a committed artifact, ask: does anything cite this artifact as evidence, and is its value that it is current or that it is the historical record of what a landed result was computed from?
- **When two branches edit one machine-checked document**, a clean merge is not evidence; run its checker.

**Completion criterion**: every pair of currently-open, about-to-be-spawned issues naming an overlapping file/module has an explicit overlap verdict — "compatible" or "conflicts, because ___".

**Report a 4b finding in 4b's vocabulary.**
A collision governs *sequencing*: "these two cannot be in flight at once."
A dependency governs *eligibility*: "this one cannot start."
Never hand a 4b finding to the orchestrator, or write one into a brief, as "queues behind" or "blocked on"; that is 4a's phrasing and it reads as ineligibility.

### Step 5: Prune and update the EPIC body

Follow the **EPIC body update pattern** below.
Do this whenever findings come in, items complete, or new work starts — not on a fixed cadence.

**Prune on every write, not on a separate sweep.** Whenever you touch a body to add a finding or check a box, cut sections whose work is now fully complete in the same edit.

**Before writing a correction, a retraction, or a unification of two findings**, apply the checks in `EVIDENCE-DISCIPLINE.md` ("Before writing a correction or a unification").

**Identified work needs an issue number, or it is not tracked.**
Every mechanism downstream keys on issue numbers: Group A resolves dashboard items with `gh issue view <N>`, spawn intent files are named `<N>.md`, the orchestrator maps slots to issues.
File it, and if that has to wait, put it in the Open work checklist as an explicit `**UNFILED**` bullet.

**Type every collision claim as VERIFIED (resolved against a landed diff) or FORECAST (about where an unwritten edit will land) when you send it.** Same-file reasoning is a weak signal; the orchestrator can resolve it at spawn time.

**Re-derive any load-bearing number that arrived from a orchestrator, a worker, or your own earlier round, and quote the command.**

**Fleet state is derived, never authored — don't let it back into the body.**
Which clone holds which issue, which slots are free, which tmux windows are live: recompute this from `git`/`tmux`/`gh` (that's `/pc-orchestrator`'s Step 5 dashboard) whenever you need it, and never write it into an EPIC body or a continuation doc.
The rule is about the claim, not the artifact: a present-continuous claim about what a slot, host, PR, or target is doing *right now* is fleet state, whoever it is addressed to. Ask the orchestrator or run the command — including when you are only reporting the state, not acting on it.
Fleet *policy* (who lands PRs, whether CI exists, what a spawn prompt standardly instructs) is stable: ask the orchestrator once and keep it.
Handoff artifacts (spawn intent, unfiled drafts) are the opposite category: authored deliberately, to a durable path outside git.

**A user decision may be written into the EPIC body only against a `FINAL` shape.**
When the session talking to the user is the orchestrator, the decision arrives here as a relay — see `/pc-orchestrator`'s "Decision relays: PROVISIONAL and FINAL".
A `PROVISIONAL` relay is discussion in progress; write nothing into the body from it beyond noting that a decision is pending, and check `.epic-decisions.md` in the orchestrator cwd for the eventual `FINAL` entry.
Only a `FINAL` relay — or a decision reached directly in this session — authorizes the write, and the body should restate the decision's substance, not a paraphrase of the sentiment that led to it.
**An unmarked relay is not a decision, and not a cue to ask the user yourself** — reply asking the relaying session for the marked form.

### Step 6: Hand spawn intent to the orchestrator

For each issue judged ready — unblocked per Step 3, no unresolved conflict per Step 4a/4b, **and holding no live slot in the orchestrator's occupancy table** — draft the semantic brief and write it to:

```bash
CONFIG=/absolute/path/to/orchestrator/.epic-config.json
CLONE_ROOT=$(pc workflow root --config "$CONFIG" --path) || exit 2
# Write the brief to a file inside the configured project, then queue without overwriting intent.
pc workflow intent write <N> --prompt-file /absolute/path/to/project/brief.md --config "$CONFIG"
```

Use the absolute authoritative orchestrator config in every shell invocation; worker snapshots are refused.
`pc workflow root` expands configured tilde paths and validates the authoritative project/pool.

**Every brief opens with an `EPIC: <N>` line.** `/pc-orchestrator-spawn` requires it, and it is how the orchestrator counts live slots by EPIC.

**Intersect the candidate set with the occupancy table as a discrete step**, and write "checked against orchestrator table of HH:MM" in the handoff; re-ask if the table is older than a cycle. In clone mode no downstream guard refuses the same issue spawned into a second idle clone.

**Naming note**: an older convention names files `spawn-<N>.txt`. `/pc-orchestrator-spawn` checks for either; use `<N>.md` for new intent and don't rename existing files.

This directory lives outside every clone's git and is the handoff point to `/pc-orchestrator-spawn`, which reads it, checks it against live fleet state, appends the fleet facts only it can see, and launches through the selected runner after the applicable authorization and occupancy gates.
Without verified startup, report prepared and keep intent queued.

**What a brief contains:**

- The reminder and resolved instruction paths required by [Project instructions in every dispatch](../lib/workflow.md#project-instructions-in-every-dispatch). Apply the same contract to delegated scans and specialist tasks.
- **Scheduling constraints:** internal order, dependencies, readiness/holds and resource needs; the orchestrator combines these with user priorities under the shared scheduling contract.
- **Only what the issue does not say.** Point at the issue's scope sections rather than restating them — open the issue before writing a brief, every time.
- **Its own issue's footprint, and no parallel-safety verdict**: "this issue touches A, B, C; ask the orchestrator whether that intersects live work."
- **Collision constraints in 4b's vocabulary** ("cannot run concurrently with `iN`, because both edit X"). Never another issue's gate, hold, or queue status.
- **Only what has stopped moving.** If the motivation cites a result still in review, wait for the merge.
- **The host class for anything with real compute**: "run the sweep on an orca, not on `pax`."
- **Attributions you have checked yourself.** When briefing a subagent, separate a claim from its attribution; the subagent will re-emit your framing as a finding.

**Do not spawn or touch tmux/clones yourself** — that's the orchestrator's job.

**Check the orchestrator's self-registered address before announcing a handoff** — read
`$CLONE_ROOT/.orchestrator-session` and use the selected runtime's supported messaging API.

- **Orchestrator addressable**: always send the queued issue/EPIC and absolute brief path to its
  self-registered address. Report `queued; orchestrator handling unconfirmed` until its receipt
  or verified startup/consumption is observed. On wake, read the receipt and handle any topic
  blocker; acknowledgement alone needs no reply. Follow the shared wake-up contract before yielding.
- **No orchestrator addressable**: retain queued intent and report delivery pending with the orchestrator continuation instruction. Resume through the orchestrator after its registration is verified.

On subsequent wakes, retain the bound EPIC number and reconcile orchestrator receipts,
worker/PR transitions and the existing dashboard before filing follow-up issues. A timer
continues this scoped session; it is not a fresh invocation with an unspecified EPIC.

### Step 6b: The design question, asked of every arm including the null

The epic half of a landing gate is "could this experiment have said otherwise?" Ask it of every arm carrying a claim, including one that returned the boring answer. Two ways an arm cannot speak:
- **vacuous-positive** — the check could not have failed, given how the arms were constructed. Remedy: redesign the check.
- **no-power** — the pathway under test never engaged, so the comparison had nothing to resolve. Test: did the mechanism actually engage? Measure engagement before interpreting a null.

### Step 6c: Pre-register on your side of the wall

Write your expectation down before the data exists; do not send it to the arm that will produce the data. Send the scheme — categories, discriminators, decision rules, known-positive controls — and keep the prior. Hold adjacent confounded evidence against a release condition written before the data, and say the condition out loud.

### Step 7: Correcting a live worker — the judgment half

When a live worker's scope needs correcting *before* its next natural stopping point, the epic — not the orchestrator — makes the call: is this change durable (it changes what the worker will produce: scope, target, artifact, gate criterion) or transient (host load, a peer's timing, a dependency that just landed)?

- **Durable**: draft the one-line correction and ask the orchestrator to deliver it — the orchestrator `SendMessage`s the worker directly and appends a timestamped, attributed entry to `.epic-worklog.md` in the same step (never edits `lead_guidance` — see `/pc-orchestrator`'s Conventions section).
  Route it through the orchestrator even though `SendMessage` would reach the worker from here too: a single delivery path keeps the message and the worklog append from diverging.
- **Transient**: message-only is fine; still routes through the orchestrator.

A worker correction is often more time-sensitive than spawn intent. If the orchestrator is addressable, `SendMessage` it directly to request immediate delivery.

**Editing an issue a live worker holds is a Step 7 correction.** The worker read the issue once at spawn and will not re-read it, so the body edit is the record and the relayed delta is the delivery. Before editing an issue, ask the orchestrator whether a slot is live on it. If a worker reports something you already fixed, the relay did not happen: tell it, and check what else failed to reach it.

### Step 8: Confirm the PR head for the orchestrator

For every owned PR and every PR affecting this EPIC, including maintenance and docs, inspect scope and claims after
applicable worker completion and review findings. Post a `🤖`-prefixed PR comment
identifying this EPIC, full head SHA, judgment, evidence and any required revision.
State that this is EPIC confirmation, distinct from code review and user merge approval.
Notify the orchestrator with the comment pointer; it collects confirmations and asks the
user. A changed head requires renewed applicable confirmation under the shared contract.
Done when the current-head confirmation or specific blocker is durable and routed.

## EPIC body update pattern

EPIC issue bodies are the source of truth for project status.
Update them when findings come in, items complete, or new work starts — and prune completed sections in the same edit (Step 5 above).

**Local file convention**: Keep a persistent local copy as `ISSUE-EPIC-<N>.md` in the repo root (e.g. `ISSUE-EPIC-281.md`).
These files are gitignored via the `ISSUE-*.md` pattern.

```bash
# Pull current body and record the timestamp
gh issue view <number> --json body,updatedAt > /tmp/epic-<N>-pull.json
jq -r .body /tmp/epic-<N>-pull.json > ISSUE-EPIC-<N>.md
PULLED_AT=$(jq -r .updatedAt /tmp/epic-<N>-pull.json)
rm -f /tmp/epic-<N>-pull.json

# Edit the file (add findings, check boxes, cut finished sections)
# ...

# Before pushing: check if someone else edited since our pull.
# Both values MUST be non-empty: an unreadable timestamp compares "" to "" and passes.
CURRENT_AT=$(gh issue view <number> --json updatedAt -q .updatedAt)
if [ -z "$PULLED_AT" ] || [ -z "$CURRENT_AT" ]; then
  echo "ABORT: could not read updatedAt (network? auth?) — cannot establish safety, not pushing"
elif [ "$PULLED_AT" != "$CURRENT_AT" ]; then
  echo "CONFLICT: Issue was updated since pull ($PULLED_AT → $CURRENT_AT)"
  echo "Re-pull, merge changes, then try again."
  # Stop here — do NOT push
else
  gh issue edit <number> --body-file ISSUE-EPIC-<N>.md || echo "PUSH FAILED — the edit did not land"
fi
```

Whenever a check gates something destructive or outward-facing:
- **A diagnostic that does not set exit status is not a guard in a pipeline.** `print("MISS")` must be `sys.exit(1)`, or the `&&` chain is decorative.
- **Verify the mutation happened, not that the command ran.** After a scripted edit, grep for the new text; after a commit, `git diff <base> HEAD -- <file>` should be exactly what you intended.
- **Ask what the guard does when the thing it queries is unavailable.** If the answer is "the same as when everything is fine", it is not a guard.

**Size limits.** GitHub rejects an issue body over 2^18 = 262,144 **bytes** (`GraphQL: Body is too long`). Measure with `wc -c`, not a character count. Past ~250 KB, every addition needs a cut in the same edit; the cheapest cuts are expired caveats and prose figures that have a live command. Comments of 131,076 characters have been accepted and 264,058 rejected; GitHub's own error text misstates the limit. Measure a stored body with `gh api repos/<org>/<repo>/issues/<n>` and `len(body.encode())` — `gh ... -q .body | wc -c` counts one extra newline.

**Replacing a body while archiving the old one to a comment.** Posting the archive moves `updatedAt`, so run the conflict check *before* your own write, and let the verified archive — not a timestamp — authorise the replacement:

```bash
T0=$(gh issue view <N> --json updatedAt -q .updatedAt)          # at pull
# ... edit locally ...
T1=$(gh issue view <N> --json updatedAt -q .updatedAt)          # BEFORE your own write
[ -n "$T0" ] && [ -n "$T1" ] || { echo "ABORT: could not read updatedAt"; exit 1; }
[ "$T0" = "$T1" ] || { echo "CONFLICT: a real concurrent editor"; exit 1; }

CID=$(gh issue comment <N> --body-file archive.md | /usr/bin/grep -oE '[0-9]+$')
[ -n "$CID" ] || { echo "ABORT: the archive post failed"; exit 1; }

# Characters, matching gh's .body|length. Null-check: an empty value is 0 in arithmetic.
EXPECTED=$(jq -Rs 'length' < archive.md)
[ -n "$EXPECTED" ] && [ "$EXPECTED" -gt 0 ] || { echo "ABORT: could not measure archive.md"; exit 1; }

LEN=$(gh api repos/<org>/<repo>/issues/comments/"$CID" -q '.body|length')
[ -n "$LEN" ] || { echo "ABORT: could not read the archive back"; exit 1; }
[ "$LEN" -ge $((EXPECTED * 95 / 100)) ] || { echo "ABORT: archive short — $LEN of ~$EXPECTED"; exit 1; }

# Truncation removes the tail, so check a phrase from the archive's LAST section.
gh api repos/<org>/<repo>/issues/comments/"$CID" -q .body | tail -40 \
  | /usr/bin/grep -q '<a phrase from the archive'"'"'s final section>' \
  || { echo "ABORT: archive tail missing — truncated"; exit 1; }

gh issue edit <N> --body-file new-body.md   # authorised by the verified copy
```

Do not add a third timestamp read after your write: `updatedAt` can lag a few seconds.

Key sections to maintain:
- **Status dashboard**: Check/uncheck boxes, add new items, cut finished ones
- **Key findings**: Numbered list, append new findings
- **Related experiments**: Add new experiment rows

**Do not maintain a clone/slot assignment table in the body** — see "Fleet state is derived" in Step 5. If a dashboard entry needs a pointer to who's on it, name the issue, not the clone.

## Error handling

- **No EPIC issues found**: Report and offer to create one
- **gh not authenticated**: Suggest `gh auth login`
- **`.epic-config.json` missing**: Run `/pc-orchestrator` first — it owns setup

## Layout config (issue #149)

`.epic-config.json`'s `clone_root` / `clone_names` / `local_worktrees` keep working untouched.
Use the authoritative `.epic-config.json` for clone/worktree layout; this CLI does not implement the upstream global `layout:` launcher.
EPIC orchestration still reads `.epic-config.json` for now.

## Managed goal acceptance

The Managed Run started through `pc workflow orchestrator start` reuses [Shared Issue Delivery](../pc-orchestrator/SKILL.md#shared-issue-delivery) for its children and collects EPIC judgment against the original goal, acceptance evidence and blockers.
Child Issue closure alone is insufficient.
Orchestrator presents one EPIC closure request.
Keep the EPIC open on silence or refusal.
After the human explicitly
confirms the target, record their exact words with
`pc workflow orchestrator close-epic <number> --config <file> --repository <owner/name> --human-confirmation <text>`.
Only the human-facing Orchestrator may supply that flag from actual human input;
Worker, EPIC and Landing output never counts as human confirmation. Confirmation
continues closure and durable archival without further approval.

For integrated acceptance and human closure, follow [EPIC coordination](../pc-orchestrator/epic-workflow.md#integrated-acceptance-and-closure).
Only verified closure opens [post-closure finalization](../pc-orchestrator/finalization.md); follow its specialist applicability and completion gates then.
