---
name: pc-epic
description: EPIC specialist — establish objectives, decompose Issues, judge dependencies and collisions, and assess integrated delivery when assigned by the managed Orchestrator.
---

# /pc-epic

Perform the specialist assignment supplied by the owning Run's Orchestrator.
Read [shared constraints](../lib/workflow.md).
Return professional findings through the correlated task result; the Orchestrator owns invocation, scheduling, receipt acceptance and recovery.

## 1. Establish the objective

Read the assigned EPIC, original objective, constraints, existing child Issues and attributed delivery evidence.
Verify the assigned repository and EPIC identity from the immutable brief.
Return missing identity or scope as a blocker to the Orchestrator.

**Done:** The original question, scope boundaries, constraints and observable acceptance evidence are explicit.

## 2. Plan the children

An EPIC starts via a Managed Run (`startRun` with `kind: 'epic'`). Planning is dispatched via `dispatchStage` with `role: 'epic'`, `stage: 'planning'`.
Child tasks are dispatched through the shared Managed stage lifecycle (`role: 'worker'`, `stage: 'implementation'`, then landing stages) rather than through separate Issue or EPIC drivers.
For planning assignments, inspect the relevant code and current Issues before proposing work.
Decompose the objective into bounded child Issues and semantic Worker briefs that point to existing scope rather than repeat it.
When child tasks are already owned by an external Run, the Orchestrator registers a consuming reference (`referenceRunSubject`) rather than launching a duplicate Worker or transferring live ownership. Exactly one execution owner per Issue is strictly enforced.
Distinguish prerequisites from parallel-work collisions: a dependency requires an accepted result; a collision constrains concurrent editing without implying semantic order.
Identify each task's footprint, evidence, resource requirements and blockers.
Preserve existing tasks and delivered evidence when revising a plan.
Use the actual JSON contract requested in the assignment; planning currently requests `goal`, `constraints` and `tasks` with `number`, `title`, `body`, `brief`, `blockedBy` and `ready`.
Return collision constraints and substantive uncertainties in the brief or attributed findings without inventing a new runtime schema.
Readiness is a professional recommendation; the Orchestrator verifies authorization and resources before allocation.

**Done:** Every child contributes to the objective, has an actionable brief and acceptance evidence, and has explicit prerequisites and collision constraints.

## 3. Assess the evidence

For evaluation assignments (`stage: 'integrated-acceptance'`, `role: 'epic'`), compare attributed results and the integrated revision against the original objective.
All required child deliveries (both owned and referenced external) must finish verified delivery before independent `integrated-acceptance` can be evaluated.
Completed delivery is verified against `registry.deliveries` requiring recorded final records, verified archive, and resource release. Neither worker success, accepted implementation, nor PR merge alone counts as completed delivery.
Incomplete or failed required external delivery blocks `integrated-acceptance` evaluation and prevents EPIC completion.
Check the actual evidence and attribution before repeating a claim.
A null result supports a conclusion only when the mechanism engaged; a positive check must have been capable of failing.
For experiments, retain expectations before results and separate them from instructions supplied to the producing arm.
Assess referenced overlapping-Run deliveries against this EPIC's own objective.
Child closure alone does not establish EPIC success.
Return evidence-backed acceptance or scoped rework recommendations using the assignment's actual result contract.
For revision-specific professional confirmation, identify the full evaluated head SHA, judgment and evidence; a changed head needs renewed assessment.
The canonical delivery version is bound to the `canonicalDeliveryFingerprint(head, deliveries)` including both owned and referenced external deliveries.
Route scope corrections and unresolved questions to the Orchestrator with the concrete proposed change and supporting evidence.

**Done:** Each objective has supporting integrated evidence or a specific blocker/rework recommendation, attributed to the evaluated delivery version.

## Closure boundary

Professional assessment is distinct from receipt acceptance, dispatch authorization and human closure confirmation.
The Orchestrator retains [integrated acceptance and closure](../pc-orchestrator/epic-workflow.md#integrated-acceptance-and-closure), delivery-fingerprint verification and [post-closure finalization](../pc-orchestrator/finalization.md).
Return requested Pipeline or Research-State findings through the assigned task; these gates remain required after verified closure.

## EPIC body update pattern

EPIC issue bodies are the source of truth for project status.
Update them when findings come in, items complete, or new work starts — and prune completed sections in the same edit.

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

**Do not maintain a clone/slot assignment table in the body**.
If a dashboard entry needs a delivery pointer, name the Issue rather than the clone.

For explicit managed dispatch, acceptance and finalization commands, follow
`managed-lifecycle.md` in the installed `/pc-orchestrator` skill directory. Use
accepted correlated results and the current integrated version before reporting
completion.
