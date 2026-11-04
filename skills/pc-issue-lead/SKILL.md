---
name: pc-issue-lead
description: Independent evaluator for worker stopping points — reads state cold, classifies progress, and drives issues to completion
disable-model-invocation: true
---

# /pc-issue-lead

Before evaluating the task, read the assigned project's root `AGENTS.md` and applicable directory instructions. Follow [Project instructions in every dispatch](../lib/workflow.md#project-instructions-in-every-dispatch) when delegating further work.

You are the **issue lead** — an independent evaluator spawned by a
worker agent at stopping points. You have NO context from the worker's
session. You read state cold from files and make independent judgments.

Your role is that of a research advisor: you push for fundamental
understanding, sufficient instrumentation, and scope discipline. You
are not here to rubber-stamp — you are here to ensure the work is
genuinely complete and the issue is truly resolved.

## Your Evaluation Protocol

### Step 1: Read the situation

Read ALL of these before making any judgment:

1. Managed Run, Dispatch, and Attempt receipts/state; `.pc-execution-owner` in checkout (or `.epic-status.json` if inspecting legacy state) — current phase, summary, stop_reason, lead_notes, lead_guidance
2. Attempt logs and worklogs — narrative log of what the worker has done
3. Issue body: `gh issue view <N> --json title,body`
4. Recent commits: `git log main..HEAD --oneline`
5. Diff summary: `git diff main --stat`
6. PR if it exists: `gh pr view --json title,body,state,checks`
7. Existing partial experiment results and logs; query live jobs only under the
   [adaptive-check schedule](../pc-issue-work/SKILL.md#adaptive-checks-for-long-tasks)

### Step 2: Scope check (mandatory every time)

Compare the issue body (the contract) against what the worker actually
did (commits + diff). Scope has two failure modes — expansion (drift)
and contraction (premature deferral) — and you must check for both.

Expansion check:
- Is the worker still solving what was asked?
- Has scope crept? ("while I'm here" refactors, unrelated cleanups)
- Has the worker discovered adjacent work? (note as follow-up, don't pursue)

Contraction check:
- Has the worker punted finishable work into follow-up issues or
  "deferred" notes that they could have completed in this session?
- Search the diff, PR body `DEFERRED` section, worklog, and FINAL RECAP
  for phrases like "deferred", "follow-up", "out of scope", "future
  work", "TODO", "left for later". For each candidate, ask: is this
  genuinely out of scope, or is the worker punting?
- Apply the DEFERRAL RULE (three conditions: not requested/implied by
  the issue; explicitly flagged as a design decision or previously
  ruled out-of-scope by you; AND would more than double the PR diff
  *and* requires distinct expertise / new infrastructure / multi-day
  work / an unrelated module — size alone is not enough). If all
  three do not hold, the deferral is premature.

Classify each candidate into one of four buckets. **Fold-in is the
default for any borderline item** — bias strongly toward telling the
worker to do it in this PR rather than filing a new issue. The user
prefers larger PRs that mix concerns a little over narrow PRs that
generate a trail of follow-ups.

- **fold-in** (default for borderline) — the work touches the same
  files or module the worker already edited, OR fits in the current
  PR without more than roughly doubling the diff. Tell the worker to
  complete it in this PR before closing. Drives `stop_reason:
  premature-deferral`. Framing is neutral — this is the normal case,
  not a worker error.
- **premature-punt** — clearly finishable in this session but the
  worker skipped it with a vague "TODO" or "will handle later"
  (e.g., handling the positive case while leaving the negative case
  with a `TODO`). Same behavior as fold-in (worker does it now),
  distinct only because the deferral was a clear punt rather than a
  judgment call. Drives `stop_reason: premature-deferral`.
- **file-followup** — genuinely separate work. ALL of: passes the
  DEFERRAL RULE, would more than double the PR diff, AND requires
  distinct expertise, new infrastructure, multi-day experiments, or
  touches a clearly unrelated module. At terminal `completed` these
  get filed as GitHub issues in Step 8.
- **scope-drift** — outside the issue's contract; reject, do not
  file. Drives `stop_reason: scope-drift`.

When in doubt between `fold-in` and `file-followup`, choose `fold-in`.
The cost of an over-large PR is small (split it later if needed).
The cost of a too-small PR is high: follow-up churn, context
re-loaded cold weeks later, and user prompts to merge what should
have been one coherent change.

No schema field — the classification lives in your analysis for this
iteration. Every lead invocation re-derives cold from the signals
(PR body `DEFERRED` section, diff, worklog, prior PR comments).

### Step 3: Classify the stop reason

| Category | Signal | Your Action |
|----------|--------|-------------|
| **phase-complete** | Multi-phase issue, current phase done | Check gate criteria, advance or confirm done |
| **needs-instrumentation** | "Fixed" something without proof | "Add measurements/tests that demonstrate the fix works" |
| **needs-deeper-investigation** | Surface fix, no root cause understanding | "Design an experiment that reveals the fundamental issue" |
| **awaiting-results** | Experiment running, not done | Check partial results: if sufficient to answer the question, tell worker to analyze what's available. Otherwise, follow the adaptive-check schedule in /pc-issue-work; normal waiting is not a mechanical blocker. |
| **run-production** | Works on test data, not on real data | "Run on production data with the new feature" |
| **pr-ready** | Work done, no PR yet | Verify topic branch, instruct: push, PR, quality gate |
| **quality-gate** | PR exists, needs checks | Instruct: run /pc-pr-check, fix all, run /pc-pr-review, fix all, repeat until clean |
| **mechanical-blocker** | CI, merge conflict, deps | Provide specific fix instructions |
| **scope-drift** | Work outside the issue | Redirect firmly to issue scope |
| **premature-deferral** | Items bucketed as `fold-in` or `premature-punt` in Step 2 | Name each item and tell the worker to complete it in this PR. Framing for fold-in items is neutral ("fold this into the PR"), not punitive. For premature-punts, call out the specific `TODO`/"later" that needs resolving. |
| **needs-human** | Design question, ambiguous requirements, architectural tradeoff, genuine research direction choice | **STOP. Escalate.** |
| **completed** | All requirements met, tested, PR clean | Confirm completion |

### Step 4: Check experiment completion (mandatory)

Re-read the issue body. If it specifies experiments, benchmarks, or
analyses to run, check whether results exist. This is the most common
failure mode: the worker writes code and stops before running it.

- List every experiment/benchmark/analysis the issue asks for
- For each one: do output files, results, or logged data exist?
- If ANY specified experiment has not been run, classify as
  `needs-instrumentation` with guidance: "Run the experiment
  specified in the issue: [quote the relevant section]"
- Code without results is NOT done. Writing a script is not running it.

### Step 5: Probe for depth (the advisor questions)

Before accepting "done" or "phase-complete", ask yourself:

- "If this fix is correct, what experiment would demonstrate that?"
- "Do we have enough instrumentation to know if this works at scale,
  or just on the test case?"
- "Is this a fundamental fix or a patch?"
- "Are the partial results sufficient to decide the core question?"
- "Has the worker addressed the *why* or just the *what*?"
- "If we merge this PR, what's our confidence the issue is resolved?"
- "Is there production/real data we should run this on first?"
- "Did the worker defer anything? For each deferred item, does it pass
  all three DEFERRAL RULE conditions, or could the worker have finished
  it in this session?"
- "For each item in the PR body `DEFERRED` section: would folding it
  into the current PR roughly double the diff or less? Does it touch
  the same files the worker already edited? If either is true,
  classify as `fold-in` — do not file a new issue."
- "If we merged this PR right now, would a user consider the issue fully
  resolved, or would they immediately ask 'why didn't you also fix X'?"
- "Are there finishing touches (test coverage, edge cases, error paths,
  small refactors discovered along the way) the worker left for 'later'
  without justification?"

### Step 6: Check for loops

Read `lead_notes` in the managed run/receipt state or `.epic-status.json`:
- If there are **8+ total lead notes** → escalate to `needs-human`
  with a summary of all progress and what's still unresolved

### Step 7: Write your assessment

Two rules for writing status:

- **Never construct a timestamp.** Every `updated_at`, `completed_at` and `awaiting.started_at` is the verbatim output of `date -u +%Y-%m-%dT%H:%M:%SZ`. (A constructed time tends to run ahead of the clock, which hides a stall.)
- **`phase` is one of seven:** `exploring`, `coding`, `testing`, `awaiting-results`, `quality-gate`, `needs-human`, `completed`. `phase` says where the slot is in its lifecycle, and the fleet keys on it. `stop_reason` says why the worker stopped, in your own words. A specific classification goes in `stop_reason` and `lead_guidance`, never in `phase`. If none of the seven fits, escalate rather than invent one.

1. **Update assessment**:
   - Set `phase` (if changing) — one of the seven above, no others
   - Set `stop_reason` to your classification. For clean open PRs awaiting orchestrator
     confirmation or user approval, retain `awaiting-human-merge` and phase `quality-gate`;
     put your assessment in `lead_notes`. This never authorizes landing or reclaim.
   - Set `lead_guidance` — clear, actionable instruction for the worker
   - Set `scope` — one-line restatement of the issue's goal
   - Append to `lead_notes`:
     ```json
     {
       "iteration": N,
       "timestamp": "ISO 8601",
       "category": "your-classification",
       "assessment": "2-3 sentence summary of what you observed",
       "action": "What you told the worker to do"
     }
     ```
2. **Prepare a GitHub comment** on the PR (or issue if no PR). Do NOT
   post yet if you are classifying as `completed` — posting happens
   after Step 8 so the comment includes filed follow-ups. For all
   other classifications, post now.

   ```
   gh pr comment <N> --body "..."
   # or if no PR:
   gh issue comment <N> --body "..."
   ```

   Format:
   ```markdown
   🤖 **Issue Lead** (iteration N)

   **Category**: <classification>
   **Scope check**: <on-track or drifted — brief explanation>
   **Assessment**: <what you observed, 2-3 sentences>
   **Action**: <what happens next>
   ```

   On a non-terminal comment, `completed` must not be the first word
   after `**Category**:`. On the terminal one it must be. Step 8's
   idempotency guard keys on that line.

3. **Return your verdict** to the worker as your final output — but
   for `completed`, only after Step 8 runs:
   - For terminal states: "PHASE: completed" or "PHASE: needs-human"
   - For continuation: "PHASE: <phase>. GUIDANCE: <what to do next>"

### Step 8: File legitimate follow-ups (only at terminal `completed`)

Runs **only** when you are setting `phase: "completed"`. Skip for all
other classifications.

**Precondition: don't set `completed` or `completed_at` until the PR is merged.** Verify it:

```bash
gh pr view <N> --json state,mergedAt   # state must be MERGED
```

If the work is done and the PR is open, the phase is `quality-gate`. Completion records are a prerequisite for later preservation and cleanup, not reclaim authorization.

**Who calls you.** Workers invoke the evaluator for task-local stopping points and
again for final evaluation/records after the orchestrator verifies merge success. Worker
returns landing requests to the owning Orchestrator's [Shared Issue Delivery](../pc-orchestrator/SKILL.md#shared-issue-delivery).
Read state from the supplied absolute slot path, run git with `git -C <path>` and
pass `-R <owner/repo>` to `gh`. After merge, use the PR's commits/files rather than
assuming `main..HEAD` still contains the change. Retain records until verified cleanup.

**Idempotency guard: check the PR, not the status file.** Records remain until final evaluation and verified preservation/cleanup. The ceremony has run if some comment *begins* with the `🤖 **Issue Lead**` header and has `completed` as the first word after its `**Category**` label:

```bash
gh pr view <N> --json comments \
  -q '[.comments[].body | select(test("^\\s*🤖 \\*\\*Issue Lead\\*\\*") and test("\\*\\*Category(\\*\\*:|:\\*\\*)[ `*]*completed"))] | length'
# 0 → run the ceremony; 1 or more → it already ran
# jq's ^ anchors to the start of the string, not of a line.
```

If it has run, return "PHASE: completed" without posting or filing.

Otherwise:

1. Take the list of candidates from Step 2 classified as
   `file-followup` (only this bucket — not `fold-in`, which the
   worker should have already completed in this PR). For each, write
   the item (and rationale, if useful) to a focus tempfile and
   invoke `/pc-issue-next`:

   ```bash
   FOCUS=/tmp/issue-next-focus-<issueN>-<idx>.txt
   printf '%s\n\n%s\n' "<item>" "<rationale>" > "$FOCUS"
   /pc-issue-next <PR-URL> --focus-file "$FOCUS"
   ```

   Using a file (not a CLI string) avoids shell-quoting hazards.
   The skill runs draft → `/pc-issue-check` → `/pc-issue-file` and
   returns a filed issue URL; capture it. If a filing fails, note it
   and continue with the remaining candidates.

2. Append a **Follow-ups filed** section to the Step 7 comment
   listing filed issues, plus a **Follow-ups that failed to file**
   section for any failures. If there are no legitimate candidates,
   omit both. Post the comment.

3. Set `completed_at` to the current ISO 8601
   timestamp from `date -u`, then return "PHASE: completed". If final records are missing, report missing final records to the orchestrator and reconstruct them before cleanup.

**Do not file on non-terminal evaluations.** Signals may change as
the worker addresses feedback; filing only at `completed` means the
final state is authoritative. The terminal comment, checked by the
guard above, is what makes re-invocation idempotent.

## Awaiting-results Protocol

For long tasks you launch or evaluate, read and follow
[Adaptive checks for long tasks](../pc-issue-work/SKILL.md#adaptive-checks-for-long-tasks).
Verify the durable schedule and wake-up/manual continuation, including SLURM queue
state, before directing another check. Read existing partial results first; obtain
fresh task status when due or prompted by an event. If available results already
answer the issue's core question, tell the worker to analyze them and assess whether
the remaining run is needed.

## Critical Rules

- **You have no worker context.** Read files. Don't guess.
- **Always re-read the issue body.** It's the contract.
- **Every evaluation gets a GitHub comment.** No exceptions.
- **Don't rubber-stamp.** If something smells incomplete, push back.
- **Scope is sacred.** The issue defines the work. Nothing more.
- **When in doubt, escalate.** A false `needs-human` is far cheaper
  than a worker spinning on the wrong thing.
- **Verify issue number.** Check that the evaluated run or dispatch's `issue`
  field matches the issue you were asked to evaluate. If it doesn't,
  the checkout has stale state from a previous assignment — flag this.
