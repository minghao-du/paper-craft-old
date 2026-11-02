---
name: pc-research-state
description: Write research-state/ when research findings, agreed plans, or discussions need recording, when adopting an existing project's research state, or when another skill needs shared research records updated.
---

# /pc-research-state

Be the writer for the Project's shared research state. All writes inside
`research-state/` go through this skill, including initialization and migration.
The calling session owns scientific judgments and research direction; this skill
checks supporting materials and edits the record. It does not become the research
coordinator or authorize experiments. Use the project's language.

For Orchestrator-dispatched EPIC finalization, first read
[the finalization writing contract](finalization.md).

## 1. Resolve the writing brief

Read [the research-state convention](../../docs/guides/research-state.md).
Resolve the fixed entry from project agent/startup guidance and read it with the
records relevant to the update. Obtain the caller's findings or agreed plan,
evidence locations, limitations, and intended changes. Use accessible materials
to fill factual gaps; return missing scientific decisions to the caller.
If another session coordinates this Project, route proposed scientific changes
through it before writing; invoking this skill does not transfer coordination.

For initialization or migration, resolve one designated research home, apply the
convention's ignore and tracked-file handling, and establish its discovery pointer.
Ask for the home only when it cannot be resolved unambiguously. Read existing
materials before moving useful content; label reconstructed and unverified state.

**Done:** The unique destination, requested update, available sources and gaps are
explicit, and the caller is responsible for any required scientific decisions.

## 2. Check the material

Apply the convention's evidence and integration rules to each consequential claim.
Distinguish evidence inspected now from previously verified findings. Keep specific
run identities and evidence locations sufficient to distinguish the reported run;
remote evidence includes host and path. A successful workflow exit establishes
execution success, not a scientific conclusion.

When evidence conflicts with proposed wording or existing findings, inspect
conditions and comparability. Return the contradiction and supporting sources to
the caller for interpretation; keep the disputed conclusion unresolved. Record
independent supported updates without waiting on unrelated gaps. Inaccessible
evidence retains its stated verification status and an explicit access gap.

**Done:** Every proposed claim has an evidence status; contradictions and missing
scientific decisions are either resolved by the caller or explicitly pending.

## 3. Edit the shared state

Re-read affected records before editing. Apply the convention's directory reports
and navigation rules: establish the recursive folder mapping during initialization
or migration; for routine updates trace only the affected steps and consumers.
Update their reports in place and check parent summaries as changes propagate.
Use the [optional report examples](../../docs/guides/research-state-template.md)
when a starting structure helps. Keep raw evidence at its source.

Verify the caller's mapping to repositories, scripts, workflow rules, inputs,
outputs and specific runs in the affected reports. Preserve useful existing
records and repair inbound links when reorganizing them.

Preserve distinctions among plans, hypotheses, observations, interpretations and
conclusions. Incorporate the caller's judgments, useful negative findings, limits,
and unfinished questions. For an agreed route, preserve each stage's question,
method, expected output, dependencies and progression conditions. Update related
summaries and references; flag affected interpretations pending reassessment when
the caller has not resolved them. Keep live task status in its task system.

During migration, retire parallel scientific entries only after their useful
content has been integrated. Preserve unrelated operating instructions and local
files when removing tracked copies from Git.

**Done:** Each requested update is recorded or explicitly deferred with its reason;
affected steps have report locations, folder mappings and links are current, and
parent summaries and dependent reports agree or explicitly await verification.

## 4. Verify and return

Read the changed records, verify affected folder/code/evidence mappings, follow
local links and check the discovery pointer. Check dependent reports and parent
summaries within the impact scope for stale results.
Confirm that the entire workspace is ignored and no research-state files remain
tracked. Check that unsupported conclusions were not promoted and that unresolved
questions remain visible. Report inaccessible remote references as unchecked.

Return the entry and changed record paths, what was integrated, evidence checked,
and pending contradictions or decisions to the caller. Leave research direction
and any experiment execution with the caller.

**Done:** The written state matches the brief, navigation resolves or has reported
gaps, and every deferred update is accounted for.

For explicit managed dispatch, acceptance and finalization commands, follow
`managed-lifecycle.md` in the installed `/pc-orchestrator` skill directory. Use
accepted correlated results and the current integrated version before reporting
completion.
