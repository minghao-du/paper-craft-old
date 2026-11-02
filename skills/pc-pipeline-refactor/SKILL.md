---
name: pc-pipeline-refactor
description: Refactor existing workflow pipeline directory layouts, remove sequential number prefixes, modularize flat scripts into submodules, mirror results structures, and execute atomic dual-environment path migrations across local and remote HPC.
disable-model-invocation: true
---

# /pc-pipeline-refactor

Refactor existing scientific computing workflows from ad-hoc, flat, or sequentially numbered directory layouts into clean, modular, tiered architectures adhering to [pc-pipeline-snakemake](../pc-pipeline-snakemake/SKILL.md).
Synchronize all code, rules, configurations, and data assets across local workstations and remote HPC environments without interrupting reproducible execution or losing data.

## Post-closure audit invocation

When dispatched by an EPIC Orchestrator after verified closure, perform applicability
and bounded structural audit only, following [the shared finalization contract](../pc-orchestrator/finalization.md).
Return the inspected versions and classified findings required there; completion uses
that shared accepted-disposition contract.

## Core Leading Words

- **`ledger`**: The explicit source-to-target path mapping that gates every filesystem operation.
  Never move, rename, or delete files without an approved ledger.
- **`mirror`**: The strict structural symmetry between script submodules and results directories.
  Every analytical subfolder in `workflow/scripts/<stage>/` must be reflected 1:1 in `results/<stage>/`.
- **`atomic`**: Dual-environment execution where local repository changes and remote HPC data assets migrate in lockstep.
  Avoid half-migrated states where code expects new paths while compute clusters host old directories.
- **`native-executor`**: Direct cluster scheduling where Snakemake manages Slurm jobs through its executor profile (`--profile config/profiles/slurm`).
  Retire external `.sbatch` scripts, wrapper submission loops, and monolithic fat-node allocations into declarative rule resources and executor profiles.
- **`dry-run`**: Dependency planning via `snakemake -n`, without executing analysis jobs.
  Building the DAG still takes time and queries the filesystem; select checks by the migration risks in Phase 5.
- **`sanitize`**: Safe environment cleanup of merged Git worktrees, unpartitioned root logs, and obsolete intermediate artifacts.

---

## The 5-Phase Refactoring Protocol

```
Phase 1: Audit & Inventory  ──>  Phase 2: Migration Ledger  ──>  Phase 3: Code Rewiring
                                                                        │
Phase 5: Verification & Commit  <──  Phase 4: Atomic Migration & Sanitize  <─┘
```

### Phase 1: Audit & Inventory

Benchmark the target repository against the standard layout defined in [pc-pipeline-snakemake](../pc-pipeline-snakemake/SKILL.md).
Inspect both local repository structure and remote HPC working directories.

Audit for common structural debt:
1. **Sequential Number Prefixes**: Check for `01_`, `02_` stage prefixes in `workflow/rules/`, `workflow/scripts/`, `summary/`, and output roots.
2. **Flat Script Clutter**: Identify loose script files exposed directly in parent stage folders instead of cohesive submodules.
3. **Asymmetric Output Layouts**: Detect mismatches between script submodules and result directories.
4. **Data Hygiene Violations**: Check for unpartitioned datasets in `data/`, plural-versus-singular folder inconsistencies (e.g., `processed/embeddings/` vs `processed/embedding/`), or non-data scratch files in data directories.
5. **Log Smells**: Locate unpartitioned log files lingering in repository roots or parent `logs/` folders without rule-level and wildcard-level partitioning.
6. **Dangling Workspaces**: List merged Git worktrees, stale branches, or abandoned scratch directories on remote hosts.
7. **Cluster Orchestration Debt**: Locate standalone `.sbatch` scripts, shell submission loops, or monolithic allocations wrapping local `snakemake -j` execution instead of using native executor profiles.

**Completion Criterion**:
Every structural debt item across all tiers (`data/`, `processed/`, `results/`, `logs/`, `workflow/`, and cluster submission scripts) is cataloged with exact file paths.

---

### Phase 2: Migration Ledger Generation

Synthesize audit findings into an explicit migration contract before touching code or filesystem structures.
Populate the migration ledger following the template in [templates/migration-ledger.md](templates/migration-ledger.md).

The ledger must specify:
1. **Source-to-Target Mappings**: Full path pairs for every rule, script, directory, output artifact, and configuration reference.
2. **Action Specifications**: Mark each action as `Rename`, `Move`, `Symlink`, or `Delete`.
   Use `Symlink` whenever external pipelines or historical checkpoints rely on legacy paths.
3. **Dual-Environment Scope**: Indicate whether each path applies to Local, Remote HPC, or both.
4. **Code and Orchestration Rewiring Matrix**: Enumerate every configuration file (`config/*.yaml`), workflow definition (`Snakefile`, `workflow/rules/*.smk`), script import, test fixture, and legacy `.sbatch` script requiring migration to rule resources (`threads:`, `resources:`) or profile settings.
5. **Sanitization Plan**: Specify obsolete worktrees, dead directories, unpartitioned logs, and retired `.sbatch` scripts scheduled for removal.

**Completion Criterion**:
The migration ledger is reviewed and confirmed with the user.
No file is moved, converted, or deleted until the ledger is settled.

---

### Phase 3: Code and Rule Rewiring

Update code, rules, configurations, and test suites to use the target paths specified in the ledger.
Keep code changes strictly scoped to path updates, preserving business logic and analytical parameters.

Execution steps:
1. **Configuration Anchors**: Update base directory paths and dataset paths in `config/config.yaml` and `config/schema.yaml`.
2. **Workflow Rules**: Update `include:` directives in `workflow/Snakefile` to point to unnumbered semantic rules.
   Update rule `input:`, `output:`, and `log:` directives in `workflow/rules/*.smk` to match the new submodule and mirror output hierarchy.
3. **Script Invocations**: Update script relative paths in rule `script:` directives (e.g., `script: "../scripts/<stage>/<submodule>/<script>.py"`).
4. **Internal Script References**: Update hardcoded directory defaults or relative output paths within standalone execution scripts.
5. **Test Fixtures**: Update mock paths and test assertions in `tests/` to reflect new directory structures.
6. **Cluster Scheduling Extraction**: Extract Slurm directives (`#SBATCH`) from legacy submission scripts into rule `threads:` and `resources:` (e.g., `mem_mb`, `runtime`). Scaffold or update `config/profiles/slurm/config.yaml`. Mark legacy `.sbatch` scripts for deletion in Phase 4.

**Completion Criterion**:
Zero references to legacy paths remain in `workflow/`, `config/`, and `tests/`.
A repository-wide text search confirms no stale paths persist.

---

### Phase 4: Atomic Dual-Environment Migration & Sanitization

Execute filesystem relocations across local and remote environments as specified in the migration ledger.
Ensure changes occur atomically so neither environment is left in a broken intermediate state.

Execution sequence:
1. **Local Filesystem Relocation**:
   - Use `git mv` for all tracked files (rules, scripts, configs, test suites, summary receipts) to preserve Git commit history.
   - Reorganize local intermediate or output test fixtures to match new mirror structures.
2. **Remote HPC Filesystem Relocation**:
   - Connect to remote compute host via SSH.
   - Create required target submodule directories (`mkdir -p`).
   - Move production datasets, intermediate processed features, and result directories into the new mirror hierarchy.
   - Create backward-compatible symbolic links where the ledger explicitly requires external compatibility.
3. **Environment Sanitization**:
   - Safely remove merged Git worktrees (`git worktree remove`) after verifying branch merges.
   - Purge unpartitioned root logs, dead scratch directories, and retired `.sbatch` submission scripts identified in the ledger.
   - Consolidate orphan log files into partitioned stage folders under `logs/<stage>/`.

**Completion Criterion**:
Both local and remote filesystems match the migration ledger exactly.
No orphan files, dangling directories, or broken symlinks remain.

---

### Phase 5: Verification & Commit

Verify the changed paths and dependencies through the execution environment and platform procedures defined in `.paper-craft/compute.md`.

Verification steps:
1. **Small-Data Tests**:
   - Use the project's small test configuration and representative fixtures to dry-run and execute affected targets. Cover changed imports, includes, input/output paths and dependency edges.
   - Run relevant unit and smoke tests; follow [Snakemake smoke validation](../pc-pipeline-snakemake/references/smoke.md) for fixtures, execution, and artifact checks.
   - Verify cluster DAG resolution via `uv run snakemake --profile config/profiles/slurm -n` and confirm zero standalone step `.sbatch` scripts remain.
2. **Production Path Checks**:
   - Verify the ledger's actual local and remote path mappings, input locations and compatibility symlinks; search active code and configuration for stale references.
3. **Risk-Based Expansion**:
   - Expand DAG checks only for a specific migration risk the fixtures and path checks cannot cover, such as production-only sample discovery or a changed production configuration branch. Record the risk, target and result in the ledger.
   - Check the affected target or a supported batch first; expand to the full production DAG when that risk requires it, rather than checking every stage by default.
   - If a check stops making progress, identify the bottleneck and remaining question, then narrow it where coverage permits. Continue necessary checks and report unfinished checks as incomplete.
4. **Git Tree Inspection & Commit**:
   - Inspect `git status` and `git diff --stat` to verify that only expected path migrations and rewiring changes are staged.
   - Commit changes with a descriptive message summarizing structural changes, unnumbered stages, script submodules, and mirror layouts.
   - Push changes to remote repository tracking branch.

**Completion Criterion**:
Affected-target small-data runs and relevant tests pass, zero standalone step sbatch scripts remain, and the ledger's real path mappings are verified.
Any production DAG checks required by an identified risk pass; record their results and any production behavior not covered by the verification.
Local Git working tree is clean and synchronized with upstream.

For explicit managed dispatch, acceptance and finalization commands, follow
`managed-lifecycle.md` in the installed `/pc-orchestrator` skill directory. Use
accepted correlated results and the current integrated version before reporting
completion.
