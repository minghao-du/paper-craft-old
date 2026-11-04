---
name: pc-issue-work
description: Authoritative Managed Worker instructions: work in assigned checkout, follow immutable brief, and return correlated results
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Task
---

# /pc-issue-work

Authoritative instructions for Managed Workers delivering Issue work assignments under Managed Runs.

## Core Contract

When dispatched as a Worker in a Managed Run:
1. **Assigned checkout:** Work exclusively inside the assigned checkout reserved for this attempt (`.pc-execution-owner`). Never create another worktree, switch branches out of the assignment, or modify files outside the checkout.
2. **Immutable brief:** Respect the immutable task brief and `initialization.json` provided in your attempt directory. Never alter or disregard the assignment scope or requirements.
3. **Correlated results:** Return structured, verifiable evidence (including current Git HEAD and artifact paths) so the Orchestrator can collect and accept your stage receipt.
4. **Clean turn completion:** Complete your turn and release execution occupancy to the Orchestrator. Do not dispatch next-stage roles or trigger landing effects yourself.

## Workflow

### Step 1: Role initialization & assignment verification

Read `initialization.json` from your attempt directory:

```bash
cat initialization.json
```

Verify that:
- `role` is `'worker'`.
- `attempt` matches your active execution identity.
- `checkout` points to the directory you are operating in.
- `.pc-execution-owner` exists in the checkout and matches your `run` and `registry`.
- The task brief at the referenced path is read and its contents understood.

Read both the issue body and comments from GitHub for tracker context if needed:

```bash
gh issue view <issue>
gh issue view <issue> --comments
```

### Step 2: Input verification

Verify that all external prerequisite dependencies and requirements are satisfied before writing any code.

#### Prerequisite input verification

Inspect the issue requirements for required external inputs — trained models, weights, data tables, or external files.
Read the project's `.paper-craft/compute.md` when present to resolve where each input will be consumed and its expected path; otherwise use the issue's environment and paths.
Verify that each prerequisite file exists and is readable in that environment, using the configured platform skill for remote checks.
Inputs verified there satisfy this prerequisite without additional authorization or a local copy.

When any prerequisite input is missing, inaccessible, or has an unresolved environment or path:
- **Halt immediately** before modifying files.
- Never guess missing values, fabricate mock data, or launch unapproved long-running recalculations.
- Emit the standardized 3-part interactive halt notification:

```markdown
Prerequisite input verification is blocked; the task cannot proceed:
- Input file, consuming environment, expected path, and blocker: `<file, environment, path, missing / inaccessible / unresolved mapping>`
- Dependent operation: `<evaluation script or verification step that requires this file>`
- Action needed: `<provide the file, restore access, or clarify the environment and path; describe the proposed substitute or regeneration plan and request authorization if needed>`
```

- Wait for explicit user or Orchestrator direction before proceeding.

Completion criterion: every prerequisite input has passed the verification above (or the user has explicitly resolved the blocker with a substitute), and all requirements are clear.

### Step 3: Create a feature branch (assigned checkout)

Stay strictly inside the assigned checkout.
The branch and worktree are provisioned, owned, and tracked by the Managed Run:
- Do not create a separate worktree (`git worktree add`).
- Do not check out another branch (`git checkout <other>`).
- Keep all modifications within the checkout boundary.

### Step 4: Implement

- Implement the required changes strictly adhering to the immutable brief and project coding standards.
- Follow the TDD red-green loop: write failing tests first at public seams, then minimal implementation to pass.
- When Snakemake workflows are involved, follow incremental recovery before rerunning.
- Continue until implementation is complete and project checks pass (`pnpm run typecheck`, `pnpm run lint`, tests).

#### Adaptive checks for long tasks

Apply the shared protocol in [Adaptive checks for long tasks](../lib/adaptive-checks.md) to local and remote computation, training, experiments and long tests:
1. Launch through the configured platform/runtime and retain the exact job ID or PID, execution environment, logs and completion probe. Verify the probe returns nonzero while unfinished and zero only on verified success.
2. Estimate completion from comparable runs, input size or measured progress. Record the estimate, its basis and the next check time before waiting.
3. For SLURM, track submission, queue wait and actual execution separately.
4. Keep waiting responsive through completion events or a supported scheduled wake-up.

### Step 5: Selective staging and pre-commit cached diff audit

Stage changes explicitly per-file to maintain zero transient artifacts in git history.

#### Selective staging protocol

Stage modified or new files individually using per-file commands:

```bash
git add <file>
```

Target only source code, configuration files, and documentation.
Do not use indiscriminate staging commands (`git add .`, `git add -A`, or `git commit -a`).

#### Pre-commit cached diff audit

Before creating any commit, audit the staged cache to intercept transient cruft:

```bash
git diff --cached --name-only
```

Inspect all staged paths against forbidden transient patterns (`output/*`, `results/*`, `*.joblib`, `*.pt`, `*.tsv`, `*.csv`, `*.png`).
When any staged path matches a forbidden pattern, immediately unstage it (`git reset HEAD <file>`).
Commit only when `git diff --cached --name-only` contains exclusively legitimate source, configuration, and documentation files.

### Step 6: PR creation or update

Create or update the PR for the assigned branch:

```bash
gh pr create --title "<concise title>" --body "<body>"
```

- Include `Closes #<issue>` in the body to auto-close the issue on merge.
- Do NOT manually close the issue — GitHub and the landing lifecycle handle closure.
- Report key findings, test outcomes, benchmark tables, and reproduction commands in the PR body.
- When transient local outputs or benchmarks were produced, record in the PR body where the local outputs were placed (such as a preserved path or ephemeral directory) alongside their reproduction command, environment specifications, and reproduction duration or cost.

### Step 7: Return correlated results

Publish your completed implementation evidence:
1. Write a structured result JSON in your attempt directory (e.g. `implementation.json`):
   ```json
   {
     "status": "completed",
     "head": "<current git rev-parse HEAD>",
     "summary": "Concise summary of implementation",
     "evidence": ["<path-to-result-or-test-output>"]
   }
   ```
2. The Orchestrator will collect this result via `stage collect` and evaluate acceptance via `stage accept`.
3. If remediation feedback is returned due to rejection, review the feedback, retain all prior evidence, address the blocker in the same checkout, and commit the correction before the next collection turn.
4. Complete your turn and release execution occupancy.

### Step 8: Final records stage (when dispatched post-merge)

When the Orchestrator dispatches the `final-records` stage following verified PR merge:
1. Verify the merged state of the PR:
   ```bash
   gh pr view <pr> --json state,mergedAt,mergeCommit
   ```
2. Write final assessment, worklog, and follow-ups:
   - Provide complete final records with assessment summary, worklog, followups (empty list `[]` if none), and release evidence.
3. Release execution occupancy for independently verified preservation and cleanup.
   - Do NOT remove or delete the worktree checkout yourself; PR-Land performs bundle preservation and worktree removal.
   - End turn cleanly so the Orchestrator can accept final records and execute `preservation-cleanup`.
