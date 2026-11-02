# Portable workflow contract

Read this before fleet scheduling, task handoff, state preservation or reclaim.
The baseline requires Node.js, the installed `pc` CLI, Git and file access.
GitHub-specific checks additionally require authenticated `gh` access.
Use the same protocol from Codex, Claude Code, Antigravity or any other harness with these capabilities.

## Configuration and scope

Use the orchestrator's authoritative `.epic-config.json`, passing its absolute path with `--config` when working elsewhere.
Worker copies whose `main_checkout` points elsewhere are refused.
Relative paths resolve beside the config file; `~` expands to the home directory.

```json
{
  "main_checkout": "/path/to/project",
  "clone_root": "/path/to/pool",
  "clone_names": ["cedar", "pine"],
  "base_branch": "main",
  "local_worktrees": false
}
```

Both directories must already exist.
Clone slots come from `clone_names`; worktree slots are `issue-<N>` directories directly under `clone_root` when `local_worktrees` is true.
Research data remains in nexus; workflow state may live in this configured project and pool.
Read the output's `scope` before acting on fleet checks.

## Project instructions in every dispatch

Every dispatch brief must explicitly tell the recipient to read and follow the assigned project's root `AGENTS.md` before beginning work, plus applicable directory-specific instructions. This applies to all roles and task sizes, including Orchestrator, EPIC, Worker, PR review/repair/landing, issue-lead, specialists, helpers and read-only subagents; it also applies to resumed sessions and nested delegation. Inherited context or automatic instruction loading does not replace the reminder.

The sender resolves the actual assigned checkout or worktree root and includes the absolute `AGENTS.md` path in the brief. For a scratch working directory, identify the project checkout separately; for multiple projects, supply each root's instructions. If a root file is absent, record that fact rather than inventing instructions. The recipient reads the named files before task operations and reports unreadable required instructions as a blocker. Apply this contract when composing generated Runner briefs as well as manual prompts.

Use this wording with resolved paths in each brief: "Before beginning work, read and follow <absolute project-root AGENTS.md path> and any applicable directory-specific AGENTS.md instructions."

## Managed execution

Persistent role invocation and workflow progression belong to the Run's active managed Orchestrator attempt.
Ordinary conversations enter through [Orchestrator intake](../pc-orchestrator/SKILL.md#intake).
Read [the managed lifecycle](../pc-orchestrator/managed-lifecycle.md) for identity, receipts, checkout ownership, initialization, termination, recovery and verified release.
Read [Shared Issue Delivery](../pc-orchestrator/SKILL.md#shared-issue-delivery) for business sequencing.
Role skills supply the professional methods for their assigned tasks.
Unknown occupancy blocks reuse or deletion; absence of a pane or status file cannot prove vacancy.
Invoke skills by reading their text when the harness has no native skill tool.

## Installation

Run `scripts/setup/link-skills.sh` from this repository to install the default skill locations.
For another harness, use `scripts/setup/link-skills.sh --dest /path/to/its/skills` after identifying its actual skill directory.
This links each skill and the shared `lib/` references; conflicts are reported without deleting existing directories.
Install the repository dependencies with `pnpm install`, then expose the repository's `pc` launcher on PATH separately.
The launcher preserves the caller's working directory and can be reached through a symlink.
Verify a linked skill can read `../lib/workflow.md` and `pc workflow --help` succeeds in the harness environment.
